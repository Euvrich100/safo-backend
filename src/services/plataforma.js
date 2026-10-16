const { query } = require('../config/database')
const { estadoTrafico } = require('./transito')

// Ajustes de la plataforma (tarifas, garantía, comisiones). Viven en la tabla
// `configuracion` para que el administrador los cambie desde el panel sin tocar
// código. Se guardan 20 segundos en memoria para no consultar la BD en cada pedido.
const POR_DEFECTO = {
  tarifa_base: 3.0,
  tarifa_km: 1.2,
  tarifa_minuto: 0.15,
  tarifa_minima: 4.0,
  garantia_viaje: 1.5,
  compensacion_conductor: 1.0,
  radio_busqueda_km: 5,
  // Movimiento del auto en la ciudad
  velocidad_max_kmh: 40,           // tope urbano: ningún tramo se calcula más rápido
  // Combustible: el costo por km se calcula solo (precio ÷ rendimiento)
  combustible_precio_galon: 16.5,  // S/ por galón (gasolina)
  rendimiento_km_galon: 34,        // km que recorre el taxi con un galón en ciudad
  // Tráfico: cuánto más tarda un viaje según la franja horaria (1 = sin demora)
  trafico_libre: 1.0,
  trafico_medio: 1.2,
  trafico_pico: 1.45,
  // Condición del día fijada por el administrador (lluvia, feria, obras…)
  condicion_factor: 1.0,
  // Servicio de moto lineal (el taxi usa los valores de arriba; bajaj y carro también cuentan como taxi)
  moto_tarifa_base: 2.0,
  moto_tarifa_km: 0.5,
  moto_tarifa_minuto: 0.1,
  moto_tarifa_minima: 3.0,
  moto_rendimiento_km_galon: 100
}

// Servicios que puede pedir el pasajero y qué tipos de vehículo los atienden.
// «Taxi» incluye taxi, carro y bajaj; «Moto» es solo moto lineal.
const SERVICIOS = {
  taxi: ['taxi', 'carro', 'bajaj'],
  moto: ['moto_lineal']
}
const servicioValido = (s) => (Object.hasOwn(SERVICIOS, s) ? s : 'taxi')
const servicioDeVehiculo = (tipo) => (tipo === 'moto_lineal' ? 'moto' : 'taxi')

// Ajustes de texto (no numéricos)
const TEXTOS = { condicion_texto: '' }

let cache = null
let cacheHasta = 0

const invalidarAjustes = () => { cache = null; cacheHasta = 0 }

const leerAjustes = async () => {
  if (cache && Date.now() < cacheHasta) return cache
  const ajustes = { ...POR_DEFECTO, ...TEXTOS }
  try {
    const r = await query('SELECT clave, valor FROM configuracion')
    for (const { clave, valor } of r.rows) {
      if (clave in TEXTOS) { ajustes[clave] = String(valor).slice(0, 60); continue }
      const n = Number(valor)
      if (clave in ajustes && Number.isFinite(n)) ajustes[clave] = n
    }
  } catch (e) {
    // Si la tabla aún no existe (migración pendiente) se usan los valores por defecto
    console.error('leerAjustes:', e.message)
  }
  // La compensación nunca puede superar la garantía
  ajustes.compensacion_conductor = Math.min(ajustes.compensacion_conductor, ajustes.garantia_viaje)
  ajustes.compensacion_plataforma = +(ajustes.garantia_viaje - ajustes.compensacion_conductor).toFixed(2)
  // Costo de combustible por kilómetro (precio del galón ÷ km por galón)
  ajustes.combustible_km = ajustes.rendimiento_km_galon > 0
    ? +(ajustes.combustible_precio_galon / ajustes.rendimiento_km_galon).toFixed(3) : 0
  ajustes.combustible_km_moto = ajustes.moto_rendimiento_km_galon > 0
    ? +(ajustes.combustible_precio_galon / ajustes.moto_rendimiento_km_galon).toFixed(3) : 0
  cache = ajustes
  cacheHasta = Date.now() + 20 * 1000
  return ajustes
}

const haversineKm = (lat1, lng1, lat2, lng2) => {
  const rad = (g) => (g * Math.PI) / 180
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const redondear = (n, d = 2) => +Number(n).toFixed(d)

// Precios que aplican a cada servicio (el combustible por km se calcula con su propio rendimiento)
const tarifasDe = (a, servicio) => (servicio === 'moto'
  ? { base: a.moto_tarifa_base, km: a.moto_tarifa_km, minuto: a.moto_tarifa_minuto, minima: a.moto_tarifa_minima, combustible_km: a.combustible_km_moto }
  : { base: a.tarifa_base, km: a.tarifa_km, minuto: a.tarifa_minuto, minima: a.tarifa_minima, combustible_km: a.combustible_km })

// Cotización estimada del viaje.
//   tarifa = base + km × (tarifa_km + combustible por km) + minutos × tarifa_minuto, con mínima.
// El tiempo se estima así: la web calcula la ruta por calles y suma cada tramo SIN pasar del tope
// urbano (40 km/h por defecto) más los giros; aquí se multiplica por el tráfico del momento
// (horario + viajes reales + condición del día). Si la web no manda la ruta, se estima en línea
// recta ×1.3 a un 70 % del tope. Todo se acota respecto a la línea recta para evitar tarifas absurdas.
const cotizar = async ({ latO, lngO, latD, lngD, distancia_km, duracion_min, servicio = 'taxi', cuando = new Date() }) => {
  const a = await leerAjustes()
  servicio = servicioValido(servicio)
  const t = tarifasDe(a, servicio)
  const vmax = Math.max(10, a.velocidad_max_kmh)
  const recta = haversineKm(latO, lngO, latD, lngD)
  let km = Number(distancia_km)
  if (!Number.isFinite(km) || km <= 0) km = recta * 1.3
  km = Math.min(Math.max(km, recta * 0.9), Math.max(recta * 3, 0.5))

  // Tiempo con la calle despejada: nunca menos de lo que permite el tope de velocidad
  const minimoFisico = (km / vmax) * 60
  let libre = Number(duracion_min)
  libre = Number.isFinite(libre) && libre > 0 ? Math.max(libre, minimoFisico) : (km / (vmax * 0.7)) * 60
  libre = Math.min(libre, 600)

  const trafico = await estadoTrafico(a, cuando)
  const min = Math.min(Math.max(libre * trafico.factor, 1), 600)

  const porKm = km * t.km
  const combustible = km * t.combustible_km
  const porTiempo = min * t.minuto
  const subtotal = t.base + porKm + combustible + porTiempo
  const tarifa = Math.max(t.minima, subtotal)
  return {
    servicio,
    distancia_km: redondear(km),
    duracion_min: Math.max(1, Math.round(min)),
    duracion_rango: [Math.max(1, Math.round(min * 0.88)), Math.max(2, Math.round(min * 1.15))],
    tarifa: redondear(tarifa),
    trafico: {
      nivel: trafico.nivel,
      texto: trafico.texto,
      factor: trafico.factor,
      condicion: trafico.condicion.factor !== 1 ? trafico.condicion.texto || 'Condición especial' : null,
      fuente: trafico.fuente
    },
    desglose: {
      base: t.base,
      por_km: redondear(porKm),
      combustible: redondear(combustible),
      por_tiempo: redondear(porTiempo),
      minima_aplicada: tarifa > subtotal
    },
    garantia: a.garantia_viaje
  }
}

// ¿El punto cae dentro de alguna zona de servicio activa? Si el administrador
// no definió ninguna zona activa, no se restringe nada.
const zonaDe = async (lat, lng) => {
  const r = await query('SELECT id, nombre, lat, lng, radio_km FROM zonas_servicio WHERE activa = TRUE')
  if (r.rows.length === 0) return { restringido: false, zona: null }
  const dentro = r.rows.find(z => haversineKm(lat, lng, Number(z.lat), Number(z.lng)) <= Number(z.radio_km))
  return { restringido: true, zona: dentro || null }
}

module.exports = { leerAjustes, invalidarAjustes, cotizar, zonaDe, haversineKm, redondear, tarifasDe, SERVICIOS, servicioValido, servicioDeVehiculo, POR_DEFECTO }
