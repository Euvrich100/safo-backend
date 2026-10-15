const { query } = require('../config/database')

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
  radio_busqueda_km: 5
}

let cache = null
let cacheHasta = 0

const invalidarAjustes = () => { cache = null; cacheHasta = 0 }

const leerAjustes = async () => {
  if (cache && Date.now() < cacheHasta) return cache
  const ajustes = { ...POR_DEFECTO }
  try {
    const r = await query('SELECT clave, valor FROM configuracion')
    for (const { clave, valor } of r.rows) {
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

// Cotización estimada: base + km + minutos, con tarifa mínima.
// distancia_km / duracion_min pueden venir de la ruta real que calculó la web;
// se acotan respecto a la línea recta para que nadie fije una tarifa absurda.
// Sin ruta se estima en línea recta ×1.3 a 25 km/h (calles de Huánuco).
const cotizar = async ({ latO, lngO, latD, lngD, distancia_km, duracion_min }) => {
  const a = await leerAjustes()
  const recta = haversineKm(latO, lngO, latD, lngD)
  let km = Number(distancia_km)
  if (!Number.isFinite(km) || km <= 0) km = recta * 1.3
  km = Math.min(Math.max(km, recta * 0.9), Math.max(recta * 3, 0.5))
  let min = Number(duracion_min)
  if (!Number.isFinite(min) || min <= 0) min = (km / 25) * 60
  min = Math.min(Math.max(min, 1), 600)

  const subtotal = a.tarifa_base + km * a.tarifa_km + min * a.tarifa_minuto
  const tarifa = Math.max(a.tarifa_minima, subtotal)
  return {
    distancia_km: redondear(km),
    duracion_min: Math.max(1, Math.round(min)),
    tarifa: redondear(tarifa),
    desglose: {
      base: a.tarifa_base,
      por_km: redondear(km * a.tarifa_km),
      por_tiempo: redondear(min * a.tarifa_minuto),
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

module.exports = { leerAjustes, invalidarAjustes, cotizar, zonaDe, haversineKm, redondear, POR_DEFECTO }
