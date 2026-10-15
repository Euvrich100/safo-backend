const crypto = require('crypto')
const { query } = require('../config/database')
const { cotizar, zonaDe, leerAjustes } = require('../services/plataforma')

const ESTADOS_ACTIVOS = ['solicitado', 'aceptado', 'en_camino', 'recogido']
const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v))

// ── Cotización ───────────────────────────────────────────────────────────────
// GET /api/viajes/cotizar?lat_origen&lng_origen&lat_destino&lng_destino[&distancia_km&duracion_min]
const cotizarViaje = async (req, res) => {
  try {
    const latO = num(req.query.lat_origen), lngO = num(req.query.lng_origen)
    const latD = num(req.query.lat_destino), lngD = num(req.query.lng_destino)
    if (![latO, lngO, latD, lngD].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Indica el origen y el destino para cotizar' })
    }
    const [cot, { restringido, zona }] = await Promise.all([
      cotizar({
        latO, lngO, latD, lngD,
        distancia_km: req.query.distancia_km, duracion_min: req.query.duracion_min
      }),
      zonaDe(latO, lngO)
    ])
    res.json({
      ...cot,
      en_zona: !restringido || !!zona,
      zona: zona ? zona.nombre : null
    })
  } catch (error) {
    console.error('Error cotizarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/ajustes-publicos — lo que el pasajero y el conductor necesitan saber
// (garantía y reparto si se cancela con el taxi en camino, radio de búsqueda)
const ajustesPublicos = async (req, res) => {
  try {
    const a = await leerAjustes()
    res.json({
      garantia: a.garantia_viaje,
      compensacion_conductor: a.compensacion_conductor,
      compensacion_plataforma: Math.round((a.garantia_viaje - a.compensacion_conductor) * 100) / 100,
      radio_busqueda_km: a.radio_busqueda_km
    })
  } catch (error) {
    console.error('Error ajustesPublicos:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// ── Compartir viaje ──────────────────────────────────────────────────────────
// POST /api/viajes/:id/compartir — el pasajero genera un enlace de seguimiento
const compartirViaje = async (req, res) => {
  try {
    const { id } = req.params
    const r = await query(
      `SELECT v.id, v.estado, v.token_compartir
       FROM viajes v JOIN pasajeros p ON p.id = v.pasajero_id
       WHERE v.id = $1 AND p.usuario_id = $2`,
      [id, req.usuario.id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Viaje no encontrado' })
    const v = r.rows[0]
    if (!ESTADOS_ACTIVOS.includes(v.estado)) {
      return res.status(409).json({ error: 'Solo puedes compartir un viaje en curso' })
    }
    let token = v.token_compartir
    if (!token) {
      token = crypto.randomBytes(18).toString('base64url')
      await query('UPDATE viajes SET token_compartir = $1 WHERE id = $2', [token, id])
    }
    res.json({ token })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Viaje no encontrado' })
    console.error('Error compartirViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/publico/viaje/:token — sin sesión: lo abre quien recibe el enlace.
// Solo expone lo necesario para seguir el viaje (nada de teléfonos ni cuentas).
const seguimientoPublico = async (req, res) => {
  try {
    const token = String(req.params.token || '')
    if (token.length < 16 || token.length > 64) return res.status(404).json({ error: 'Enlace no válido' })

    const r = await query(
      `SELECT v.estado, v.direccion_origen, v.direccion_destino,
              v.lat_origen, v.lng_origen, v.lat_destino, v.lng_destino,
              v.solicitado_en, v.completado_en, v.cancelado_en,
              split_part(u.nombre, ' ', 1) AS conductor_nombre,
              c.placa, c.vehiculo_marca, c.vehiculo_modelo, c.vehiculo_color,
              c.calificacion_prom, c.lat_actual, c.lng_actual,
              split_part(up.nombre, ' ', 1) AS pasajero_nombre
       FROM viajes v
       JOIN conductores c ON c.id = v.conductor_id
       JOIN usuarios u    ON u.id = c.usuario_id
       JOIN pasajeros p   ON p.id = v.pasajero_id
       JOIN usuarios up   ON up.id = p.usuario_id
       WHERE v.token_compartir = $1`,
      [token]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Enlace no válido' })

    const v = r.rows[0]
    const activo = ESTADOS_ACTIVOS.includes(v.estado)
    const fin = v.completado_en || v.cancelado_en
    // El enlace deja de mostrar la ubicación 2 horas después de terminar
    if (!activo && fin && Date.now() - new Date(fin).getTime() > 2 * 60 * 60 * 1000) {
      return res.status(410).json({ error: 'Este viaje ya terminó y el enlace caducó' })
    }
    if (!activo) { v.lat_actual = null; v.lng_actual = null }

    res.set('Cache-Control', 'no-store')
    res.json(v)
  } catch (error) {
    console.error('Error seguimientoPublico:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// ── SOS ──────────────────────────────────────────────────────────────────────
// POST /api/sos — pasajero o conductor pide ayuda durante un viaje
const viajeActivoDe = async (usuario) => {
  const r = await query(
    usuario.rol === 'conductor'
      ? `SELECT v.id FROM viajes v JOIN conductores c ON c.id = v.conductor_id
         WHERE c.usuario_id = $1 AND v.estado = ANY($2) ORDER BY v.solicitado_en DESC LIMIT 1`
      : `SELECT v.id FROM viajes v JOIN pasajeros p ON p.id = v.pasajero_id
         WHERE p.usuario_id = $1 AND v.estado = ANY($2) ORDER BY v.solicitado_en DESC LIMIT 1`,
    [usuario.id, ESTADOS_ACTIVOS]
  )
  return r.rows[0]?.id || null
}

const crearSOS = async (req, res) => {
  try {
    if (req.usuario.rol === 'admin') return res.status(403).json({ error: 'El SOS es para pasajeros y conductores' })
    const lat = num(req.body.lat), lng = num(req.body.lng)
    const mensaje = String(req.body.mensaje || '').trim().slice(0, 300) || null

    // Si ya hay una alerta activa de este usuario hace menos de 2 min, no se duplica
    const reciente = await query(
      `SELECT id FROM sos_alertas
       WHERE usuario_id = $1 AND estado = 'activa' AND creado_en > NOW() - INTERVAL '2 minutes'
       ORDER BY creado_en DESC LIMIT 1`,
      [req.usuario.id]
    )
    if (reciente.rows.length > 0) {
      return res.json({ id: reciente.rows[0].id, mensaje: 'Tu alerta ya fue enviada. Mantén la calma, el equipo de SafO fue avisado.' })
    }

    const viaje_id = await viajeActivoDe(req.usuario)
    const r = await query(
      `INSERT INTO sos_alertas (usuario_id, viaje_id, lat, lng, mensaje)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.usuario.id, viaje_id, Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, mensaje]
    )
    console.warn(`🚨 SOS ${r.rows[0].id} de ${req.usuario.rol} ${req.usuario.nombre} (${req.usuario.celular}) viaje=${viaje_id || '-'} pos=${lat},${lng}`)
    res.status(201).json({
      id: r.rows[0].id,
      mensaje: 'Alerta enviada. El equipo de SafO fue avisado. Si estás en peligro llama al 105 (Policía).'
    })
  } catch (error) {
    console.error('Error crearSOS:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// ── Reclamos ─────────────────────────────────────────────────────────────────
// POST /api/reclamos
const crearReclamo = async (req, res) => {
  try {
    if (req.usuario.rol === 'admin') return res.status(403).json({ error: 'Los reclamos son de pasajeros y conductores' })
    const asunto = String(req.body.asunto || '').trim()
    const descripcion = String(req.body.descripcion || '').trim()
    if (asunto.length < 4 || asunto.length > 120) {
      return res.status(400).json({ error: 'El asunto debe tener entre 4 y 120 caracteres' })
    }
    if (descripcion.length < 10 || descripcion.length > 2000) {
      return res.status(400).json({ error: 'Cuéntanos qué pasó (mínimo 10 caracteres)' })
    }

    const abiertos = await query(
      `SELECT COUNT(*)::int AS n FROM reclamos WHERE usuario_id = $1 AND estado IN ('abierto','en_revision')`,
      [req.usuario.id]
    )
    if (abiertos.rows[0].n >= 5) {
      return res.status(429).json({ error: 'Ya tienes 5 reclamos abiertos. Espera a que se resuelvan.' })
    }

    // Si indica un viaje, debe ser uno en el que participó
    let viaje_id = req.body.viaje_id || null
    if (viaje_id) {
      const propio = await query(
        req.usuario.rol === 'conductor'
          ? `SELECT v.id FROM viajes v JOIN conductores c ON c.id = v.conductor_id WHERE v.id = $1 AND c.usuario_id = $2`
          : `SELECT v.id FROM viajes v JOIN pasajeros p ON p.id = v.pasajero_id WHERE v.id = $1 AND p.usuario_id = $2`,
        [viaje_id, req.usuario.id]
      )
      if (propio.rows.length === 0) return res.status(404).json({ error: 'Ese viaje no es tuyo' })
    }

    const r = await query(
      `INSERT INTO reclamos (usuario_id, viaje_id, asunto, descripcion)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.usuario.id, viaje_id, asunto, descripcion]
    )
    res.status(201).json({ id: r.rows[0].id, mensaje: 'Recibimos tu reclamo. Te responderemos pronto.' })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Viaje no encontrado' })
    console.error('Error crearReclamo:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/reclamos/mios
const misReclamos = async (req, res) => {
  try {
    const r = await query(
      `SELECT id, viaje_id, asunto, descripcion, estado, respuesta, creado_en, resuelto_en
       FROM reclamos WHERE usuario_id = $1 ORDER BY creado_en DESC LIMIT 30`,
      [req.usuario.id]
    )
    res.json(r.rows)
  } catch (error) {
    console.error('Error misReclamos:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { ajustesPublicos, cotizarViaje, compartirViaje, seguimientoPublico, crearSOS, crearReclamo, misReclamos }
