// Estimación del tráfico en la ciudad SIN servicios de pago.
// Combina tres cosas:
//   1) Franjas horarias típicas (horas pico, medio día, noche, domingo) con factores que el
//      administrador puede cambiar en «Tarifas».
//   2) Lo que realmente tardaron los viajes completados de SafO (se aprende solo): si hay
//      suficientes viajes en una franja, su velocidad real corrige el factor.
//   3) Una condición manual del administrador (lluvia, feria, obras…) que multiplica todo.
// No es tráfico en vivo (eso requiere una API de pago como TomTom o HERE): es una estimación honesta.
const { query } = require('../config/database')

const ZONA_HORARIA = process.env.CIUDAD_TZ || 'America/Lima'
const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

const formato = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA_HORARIA, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23'
})

// Hora local de la ciudad (no la del servidor)
const horaLocal = (fecha = new Date()) => {
  const p = Object.fromEntries(formato.formatToParts(fecha).map((x) => [x.type, x.value]))
  return { minutos: Number(p.hour) * 60 + Number(p.minute), dia: DIAS[p.weekday] ?? 1 }
}

const dentro = (m, [desde, hasta]) => m >= desde && m < hasta
const h = (hh, mm = 0) => hh * 60 + mm
const PICOS = [[h(7), h(9, 15)], [h(12, 30), h(14, 30)], [h(17), h(20)]]
const MEDIOS = [[h(6), h(7)], [h(9, 15), h(12, 30)], [h(14, 30), h(17)], [h(20), h(21, 30)]]

// 'libre' | 'medio' | 'pico'
const nivelPorHorario = (fecha = new Date()) => {
  const { minutos, dia } = horaLocal(fecha)
  if (dia === 0) return dentro(minutos, [h(11), h(14)]) ? 'medio' : 'libre' // domingo: la ciudad se mueve menos
  if (PICOS.some((r) => dentro(minutos, r))) return 'pico'
  if (MEDIOS.some((r) => dentro(minutos, r))) return 'medio'
  return 'libre'
}

const ETIQUETAS = {
  libre: { nivel: 'fluido', texto: 'Tráfico fluido' },
  medio: { nivel: 'moderado', texto: 'Tráfico moderado' },
  pico: { nivel: 'intenso', texto: 'Hora pico: tráfico intenso' }
}

// Velocidad real (km/h) de los viajes completados en los últimos 60 días, por nivel de franja.
// Se guarda 15 minutos en memoria. Solo cuenta viajes con datos razonables.
let aprendido = null
let aprendidoHasta = 0
const velocidadesReales = async () => {
  if (aprendido && Date.now() < aprendidoHasta) return aprendido
  const res = { libre: [], medio: [], pico: [] }
  try {
    const r = await query(
      `SELECT recogido_en, distancia_km,
              EXTRACT(EPOCH FROM (completado_en - recogido_en)) / 3600.0 AS horas
       FROM viajes
       WHERE estado = 'completado' AND recogido_en IS NOT NULL AND completado_en IS NOT NULL
         AND distancia_km IS NOT NULL AND completado_en > NOW() - INTERVAL '60 days'
       ORDER BY completado_en DESC LIMIT 4000`
    )
    for (const f of r.rows) {
      const horas = Number(f.horas), km = Number(f.distancia_km)
      if (!(horas > 0.01) || !(km > 0.3)) continue
      const v = km / horas
      if (v < 4 || v > 70) continue // datos dudosos: viaje de prueba, olvido de finalizar, etc.
      // recogido_en se guarda en UTC (NOW() de la base)
      res[nivelPorHorario(new Date(f.recogido_en))].push(v)
    }
  } catch (e) {
    console.error('velocidadesReales:', e.message)
  }
  const prom = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
  aprendido = {
    libre: { n: res.libre.length, v: prom(res.libre) },
    medio: { n: res.medio.length, v: prom(res.medio) },
    pico: { n: res.pico.length, v: prom(res.pico) }
  }
  aprendidoHasta = Date.now() + 15 * 60 * 1000
  return aprendido
}

const MIN_VIAJES_PARA_APRENDER = 8
const limitar = (x, a, b) => Math.min(b, Math.max(a, x))

// Estado actual del tráfico: { nivel, texto, factor, factor_horario, condicion, fuente }
const estadoTrafico = async (ajustes, fecha = new Date()) => {
  const franja = nivelPorHorario(fecha)
  const base = { libre: ajustes.trafico_libre, medio: ajustes.trafico_medio, pico: ajustes.trafico_pico }[franja]
  let factor = base
  let fuente = 'horario'
  const ap = (await velocidadesReales())[franja]
  if (ap && ap.n >= MIN_VIAJES_PARA_APRENDER && ap.v) {
    // Velocidad media de referencia con la calle despejada: el 70 % del tope urbano (paradas, giros, semáforos)
    const referencia = ajustes.velocidad_max_kmh * 0.7
    const real = limitar(referencia / ap.v, 0.85, 2.2)
    factor = base * 0.4 + real * 0.6
    fuente = 'viajes reales'
  }
  const condicion = ajustes.condicion_factor
  const total = limitar(factor * condicion, 0.8, 3)
  const e = ETIQUETAS[franja]
  return {
    nivel: e.nivel,
    texto: e.texto,
    factor: +total.toFixed(2),
    factor_horario: +factor.toFixed(2),
    condicion: { factor: condicion, texto: ajustes.condicion_texto || '' },
    fuente
  }
}

const invalidarAprendizaje = () => { aprendido = null; aprendidoHasta = 0 }

module.exports = { estadoTrafico, nivelPorHorario, horaLocal, invalidarAprendizaje, ZONA_HORARIA }
