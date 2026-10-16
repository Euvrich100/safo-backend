const { query, pool } = require('../config/database')
const { leerAjustes, invalidarAjustes, POR_DEFECTO } = require('../services/plataforma')

const paginar = (page, limit, maxLimit = 100) => {
  const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), maxLimit)
  const p = Math.max(parseInt(page, 10) || 1, 1)
  return { limit: l, offset: (p - 1) * l }
}

const LIMA = "AT TIME ZONE 'UTC' AT TIME ZONE 'America/Lima'"

// ═══════════════════════════════════════════════════════════════════════
// ESTADÍSTICAS DEL TABLERO
// ═══════════════════════════════════════════════════════════════════════
// GET /api/admin/estadisticas?dias=7|30
const estadisticas = async (req, res) => {
  try {
    const dias = [7, 14, 30, 90].includes(parseInt(req.query.dias, 10)) ? parseInt(req.query.dias, 10) : 7

    const [actual, previo, estados, serie, ingresos, conductores, top, pendientes] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE estado = 'completado')::int AS completados,
                COUNT(*) FILTER (WHERE estado LIKE 'cancelado%' OR estado = 'no_show')::int AS cancelados
         FROM viajes WHERE solicitado_en >= NOW() - make_interval(days => $1)`, [dias]),
      query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE estado = 'completado')::int AS completados
         FROM viajes
         WHERE solicitado_en >= NOW() - make_interval(days => $1 * 2)
           AND solicitado_en <  NOW() - make_interval(days => $1)`, [dias]),
      query(
        `SELECT COUNT(*) FILTER (WHERE estado = 'solicitado')::int AS nuevos,
                COUNT(*) FILTER (WHERE estado IN ('aceptado','en_camino'))::int AS aceptados,
                COUNT(*) FILTER (WHERE estado = 'recogido')::int AS en_viaje,
                COUNT(*) FILTER (WHERE estado = 'completado')::int AS completados,
                COUNT(*) FILTER (WHERE estado LIKE 'cancelado%' OR estado = 'no_show')::int AS cancelados
         FROM viajes WHERE solicitado_en >= NOW() - make_interval(days => $1)`, [dias]),
      query(
        `WITH d AS (
           SELECT generate_series((NOW() ${LIMA})::date - ($1::int - 1), (NOW() ${LIMA})::date, interval '1 day')::date AS dia
         )
         SELECT to_char(d.dia, 'YYYY-MM-DD') AS dia,
                COUNT(v.id)::int AS reservas,
                COUNT(v.id) FILTER (WHERE v.estado = 'completado')::int AS completados
         FROM d LEFT JOIN viajes v ON (v.solicitado_en ${LIMA})::date = d.dia
         GROUP BY d.dia ORDER BY d.dia`, [dias]),
      query(
        `SELECT
           (SELECT COALESCE(SUM(monto_plataforma), 0) FROM pagos_viaje
              WHERE estado IN ('liberado_plataforma','compensado_conductor')
                AND actualizado_en >= NOW() - make_interval(days => $1)) AS garantias,
           (SELECT COALESCE(SUM(monto), 0) FROM suscripciones
              WHERE estado = 'pagado' AND pagado_en >= NOW() - make_interval(days => $1)) AS suscripciones,
           (SELECT COALESCE(SUM(monto_plataforma), 0) FROM pagos_viaje
              WHERE estado IN ('liberado_plataforma','compensado_conductor')
                AND actualizado_en >= NOW() - make_interval(days => $1 * 2)
                AND actualizado_en <  NOW() - make_interval(days => $1))
           + (SELECT COALESCE(SUM(monto), 0) FROM suscripciones
              WHERE estado = 'pagado'
                AND pagado_en >= NOW() - make_interval(days => $1 * 2)
                AND pagado_en <  NOW() - make_interval(days => $1)) AS previo`, [dias]),
      query(
        `SELECT COUNT(*) FILTER (WHERE c.disponible = TRUE AND u.estado = 'activo')::int AS disponibles,
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM viajes v WHERE v.conductor_id = c.id
                                               AND v.estado IN ('aceptado','en_camino','recogido')))::int AS en_viaje,
                COUNT(*) FILTER (WHERE c.estado_doc = 'aprobado' AND u.estado = 'activo')::int AS aprobados,
                COUNT(*)::int AS total
         FROM conductores c JOIN usuarios u ON u.id = c.usuario_id`),
      query(
        `SELECT u.nombre, c.placa, c.calificacion_prom,
                COUNT(v.id)::int AS viajes,
                COALESCE(SUM(v.tarifa_estimada), 0) AS tarifa_estimada
         FROM viajes v
         JOIN conductores c ON c.id = v.conductor_id
         JOIN usuarios u ON u.id = c.usuario_id
         WHERE v.estado = 'completado' AND v.completado_en >= NOW() - make_interval(days => $1)
         GROUP BY u.nombre, c.placa, c.calificacion_prom
         ORDER BY viajes DESC, tarifa_estimada DESC LIMIT 5`, [dias]),
      query(
        `SELECT
           (SELECT COUNT(*)::int FROM conductores WHERE estado_doc = 'pendiente') AS docs_pendientes,
           (SELECT COUNT(*)::int FROM sos_alertas WHERE estado = 'activa') AS sos_activas,
           (SELECT COUNT(*)::int FROM reclamos WHERE estado IN ('abierto','en_revision')) AS reclamos_abiertos,
           (SELECT COUNT(*)::int FROM suscripciones WHERE estado = 'pendiente') AS pagos_pendientes,
           (SELECT COUNT(*)::int FROM pasajeros) AS pasajeros`)
    ])

    const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : (a > 0 ? 100 : 0))
    const ing = ingresos.rows[0]
    const ingresoTotal = Number(ing.garantias) + Number(ing.suscripciones)

    res.json({
      dias,
      reservas: { total: actual.rows[0].total, cambio_pct: pct(actual.rows[0].total, previo.rows[0].total) },
      completados: { total: actual.rows[0].completados, cambio_pct: pct(actual.rows[0].completados, previo.rows[0].completados) },
      cancelados: actual.rows[0].cancelados,
      ingresos: {
        total: +ingresoTotal.toFixed(2),
        garantias: +Number(ing.garantias).toFixed(2),
        suscripciones: +Number(ing.suscripciones).toFixed(2),
        cambio_pct: pct(ingresoTotal, Number(ing.previo))
      },
      conductores: conductores.rows[0],
      estados: estados.rows[0],
      serie: serie.rows,
      top_conductores: top.rows,
      pendientes: pendientes.rows[0]
    })
  } catch (error) {
    console.error('Error estadisticas:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/admin/alertas — contadores livianos para la barra lateral (se consulta seguido)
const alertas = async (req, res) => {
  try {
    const r = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM sos_alertas WHERE estado = 'activa') AS sos_activas,
         (SELECT COUNT(*)::int FROM reclamos WHERE estado IN ('abierto','en_revision')) AS reclamos_abiertos,
         (SELECT COUNT(*)::int FROM conductores WHERE estado_doc = 'pendiente') AS docs_pendientes`
    )
    res.json(r.rows[0])
  } catch (error) {
    console.error('Error alertas:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAPA EN VIVO
// ═══════════════════════════════════════════════════════════════════════
// GET /api/admin/mapa-vivo
const mapaVivo = async (req, res) => {
  try {
    const [conductores, viajes, sos] = await Promise.all([
      query(
        `SELECT c.id, u.nombre, c.placa, c.tipo_vehiculo, c.vehiculo_marca, c.vehiculo_modelo, c.vehiculo_color,
                c.lat_actual AS lat, c.lng_actual AS lng, c.disponible, c.actualizado_en,
                EXISTS (SELECT 1 FROM viajes v WHERE v.conductor_id = c.id
                        AND v.estado IN ('aceptado','en_camino','recogido')) AS en_viaje
         FROM conductores c JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.lat_actual IS NOT NULL
           AND (c.disponible = TRUE OR EXISTS (SELECT 1 FROM viajes v WHERE v.conductor_id = c.id
                                               AND v.estado IN ('aceptado','en_camino','recogido')))`),
      query(
        `SELECT v.id, v.estado, v.servicio, v.lat_origen, v.lng_origen, v.lat_destino, v.lng_destino,
                v.direccion_origen, v.direccion_destino, v.tarifa_estimada, v.solicitado_en,
                uc.nombre AS conductor_nombre, up.nombre AS pasajero_nombre
         FROM viajes v
         JOIN conductores c ON c.id = v.conductor_id
         JOIN usuarios uc ON uc.id = c.usuario_id
         JOIN pasajeros p ON p.id = v.pasajero_id
         JOIN usuarios up ON up.id = p.usuario_id
         WHERE v.estado IN ('solicitado','aceptado','en_camino','recogido')
         ORDER BY v.solicitado_en DESC LIMIT 100`),
      query(
        `SELECT s.id, s.lat, s.lng, s.mensaje, s.creado_en, u.nombre, u.celular, u.rol
         FROM sos_alertas s JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.estado = 'activa' AND s.lat IS NOT NULL`)
    ])
    res.json({ conductores: conductores.rows, viajes: viajes.rows, sos: sos.rows })
  } catch (error) {
    console.error('Error mapaVivo:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TARIFAS Y COMISIONES
// ═══════════════════════════════════════════════════════════════════════
// Límites razonables para que un error de tipeo no deje tarifas absurdas
const LIMITES = {
  tarifa_base:            [0, 50],
  tarifa_km:              [0, 50],
  tarifa_minuto:          [0, 10],
  tarifa_minima:          [0, 100],
  garantia_viaje:         [0.5, 20],
  compensacion_conductor: [0, 20],
  radio_busqueda_km:      [0.5, 50],
  velocidad_max_kmh:      [15, 90],
  combustible_precio_galon: [3, 60],
  rendimiento_km_galon:   [8, 120],
  trafico_libre:          [0.8, 2],
  trafico_medio:          [1, 2.5],
  trafico_pico:           [1, 3],
  condicion_factor:       [1, 2.5],
  moto_tarifa_base:       [0, 50],
  moto_tarifa_km:         [0, 50],
  moto_tarifa_minuto:     [0, 10],
  moto_tarifa_minima:     [0, 100],
  moto_rendimiento_km_galon: [15, 250]
}

// GET /api/admin/configuracion
const obtenerConfiguracion = async (req, res) => {
  try {
    const r = await query('SELECT clave, valor, descripcion, actualizado_en FROM configuracion ORDER BY clave')
    const ajustes = await leerAjustes()
    res.json({ items: r.rows, vigentes: ajustes, limites: LIMITES })
  } catch (error) {
    console.error('Error obtenerConfiguracion:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/admin/configuracion   { valores: { tarifa_base: 3.5, ... } }
const guardarConfiguracion = async (req, res) => {
  const valores = req.body?.valores
  if (!valores || typeof valores !== 'object') {
    return res.status(400).json({ error: 'Envía los valores a guardar' })
  }
  const actuales = await leerAjustes()
  const nuevos = {}
  let textoCondicion
  for (const [clave, bruto] of Object.entries(valores)) {
    if (clave === 'condicion_texto') {
      textoCondicion = String(bruto ?? '').trim().slice(0, 40)
      continue
    }
    if (!(clave in LIMITES)) return res.status(400).json({ error: `Ajuste desconocido: ${clave}` })
    const n = Number(bruto)
    const [min, max] = LIMITES[clave]
    if (!Number.isFinite(n) || n < min || n > max) {
      return res.status(400).json({ error: `${clave} debe estar entre ${min} y ${max}` })
    }
    nuevos[clave] = Math.round(n * 100) / 100
  }
  // Si no hay condición especial (factor 1), el texto se borra para no confundir
  const factorCondicion = nuevos.condicion_factor ?? actuales.condicion_factor
  if (factorCondicion === 1) textoCondicion = ''
  const garantia = nuevos.garantia_viaje ?? actuales.garantia_viaje
  const compensacion = nuevos.compensacion_conductor ?? actuales.compensacion_conductor
  if (compensacion > garantia) {
    return res.status(400).json({ error: 'La compensación al conductor no puede ser mayor que la garantía' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const [clave, valor] of Object.entries(nuevos)) {
      await client.query(
        `INSERT INTO configuracion (clave, valor) VALUES ($1, $2)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [clave, String(valor)]
      )
    }
    if (textoCondicion !== undefined) {
      await client.query(
        `INSERT INTO configuracion (clave, valor) VALUES ('condicion_texto', $1)
         ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [textoCondicion]
      )
    }
    await client.query('COMMIT')
    invalidarAjustes()
    res.json({ mensaje: 'Tarifas y comisiones actualizadas', vigentes: await leerAjustes() })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Error guardarConfiguracion:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  } finally {
    client.release()
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ZONAS DE SERVICIO
// ═══════════════════════════════════════════════════════════════════════
// GET /api/zonas — cualquier usuario con sesión (la web las dibuja en el mapa)
const listarZonas = async (req, res) => {
  try {
    const r = await query('SELECT id, nombre, lat, lng, radio_km, activa FROM zonas_servicio ORDER BY creado_en')
    res.json(r.rows)
  } catch (error) {
    console.error('Error listarZonas:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

const validarZona = (b, parcial = false) => {
  const out = {}
  if (!parcial || b.nombre !== undefined) {
    const nombre = String(b.nombre || '').trim()
    if (nombre.length < 2 || nombre.length > 80) return { error: 'El nombre debe tener entre 2 y 80 caracteres' }
    out.nombre = nombre
  }
  if (!parcial || b.lat !== undefined) {
    const lat = Number(b.lat)
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'Latitud inválida' }
    out.lat = lat
  }
  if (!parcial || b.lng !== undefined) {
    const lng = Number(b.lng)
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: 'Longitud inválida' }
    out.lng = lng
  }
  if (!parcial || b.radio_km !== undefined) {
    const radio = Number(b.radio_km)
    if (!Number.isFinite(radio) || radio < 0.1 || radio > 100) return { error: 'El radio debe estar entre 0.1 y 100 km' }
    out.radio_km = radio
  }
  if (b.activa !== undefined) out.activa = !!b.activa
  return { valores: out }
}

// POST /api/admin/zonas
const crearZona = async (req, res) => {
  try {
    const { valores, error } = validarZona(req.body)
    if (error) return res.status(400).json({ error })
    const r = await query(
      `INSERT INTO zonas_servicio (nombre, lat, lng, radio_km, activa)
       VALUES ($1, $2, $3, $4, COALESCE($5, TRUE)) RETURNING id`,
      [valores.nombre, valores.lat, valores.lng, valores.radio_km, valores.activa]
    )
    res.status(201).json({ id: r.rows[0].id, mensaje: 'Zona creada' })
  } catch (error) {
    console.error('Error crearZona:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/admin/zonas/:id
const actualizarZona = async (req, res) => {
  try {
    const { valores, error } = validarZona(req.body, true)
    if (error) return res.status(400).json({ error })
    const campos = Object.keys(valores)
    if (campos.length === 0) return res.status(400).json({ error: 'Nada que actualizar' })
    const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ')
    const r = await query(
      `UPDATE zonas_servicio SET ${sets} WHERE id = $1 RETURNING id`,
      [req.params.id, ...campos.map(c => valores[c])]
    )
    if (r.rowCount === 0) return res.status(404).json({ error: 'Zona no encontrada' })
    res.json({ mensaje: 'Zona actualizada' })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Zona no encontrada' })
    console.error('Error actualizarZona:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// DELETE /api/admin/zonas/:id
const eliminarZona = async (req, res) => {
  try {
    const r = await query('DELETE FROM zonas_servicio WHERE id = $1', [req.params.id])
    if (r.rowCount === 0) return res.status(404).json({ error: 'Zona no encontrada' })
    res.json({ mensaje: 'Zona eliminada' })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Zona no encontrada' })
    console.error('Error eliminarZona:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RECLAMOS
// ═══════════════════════════════════════════════════════════════════════
const ESTADOS_RECLAMO = ['abierto', 'en_revision', 'resuelto', 'rechazado']

// GET /api/admin/reclamos?estado=
const listarReclamos = async (req, res) => {
  try {
    const { estado } = req.query
    const { limit, offset } = paginar(req.query.page, req.query.limit)
    const params = []
    let filtro = ''
    if (estado && ESTADOS_RECLAMO.includes(estado)) { params.push(estado); filtro = 'WHERE r.estado = $1' }
    params.push(limit, offset)
    const r = await query(
      `SELECT r.id, r.asunto, r.descripcion, r.estado, r.respuesta, r.creado_en, r.resuelto_en, r.viaje_id,
              u.nombre, u.celular, u.rol,
              v.direccion_origen, v.direccion_destino
       FROM reclamos r
       JOIN usuarios u ON u.id = r.usuario_id
       LEFT JOIN viajes v ON v.id = r.viaje_id
       ${filtro}
       ORDER BY (r.estado IN ('abierto','en_revision')) DESC, r.creado_en DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json(r.rows)
  } catch (error) {
    console.error('Error listarReclamos:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/admin/reclamos/:id   { estado, respuesta }
const resolverReclamo = async (req, res) => {
  try {
    const { estado } = req.body
    const respuesta = String(req.body.respuesta || '').trim().slice(0, 2000) || null
    if (!ESTADOS_RECLAMO.includes(estado)) return res.status(400).json({ error: 'Estado inválido' })
    if ((estado === 'resuelto' || estado === 'rechazado') && !respuesta) {
      return res.status(400).json({ error: 'Escribe una respuesta para el usuario' })
    }
    const cerrado = estado === 'resuelto' || estado === 'rechazado'
    const r = await query(
      `UPDATE reclamos SET estado = $2, respuesta = COALESCE($3, respuesta),
              resuelto_en = CASE WHEN $4 THEN NOW() ELSE NULL END,
              resuelto_por = CASE WHEN $4 THEN $5::uuid ELSE NULL END
       WHERE id = $1 RETURNING id`,
      [req.params.id, estado, respuesta, cerrado, req.usuario.id]
    )
    if (r.rowCount === 0) return res.status(404).json({ error: 'Reclamo no encontrado' })
    res.json({ mensaje: 'Reclamo actualizado' })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Reclamo no encontrado' })
    console.error('Error resolverReclamo:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SOS
// ═══════════════════════════════════════════════════════════════════════
// GET /api/admin/sos?estado=activa|atendida
const listarSOS = async (req, res) => {
  try {
    const { estado } = req.query
    const params = []
    let filtro = ''
    if (estado === 'activa' || estado === 'atendida') { params.push(estado); filtro = 'WHERE s.estado = $1' }
    const r = await query(
      `SELECT s.id, s.estado, s.lat, s.lng, s.mensaje, s.creado_en, s.atendida_en, s.nota_admin, s.viaje_id,
              u.nombre, u.celular, u.rol,
              v.direccion_origen, v.direccion_destino, v.estado AS viaje_estado,
              uc.nombre AS conductor_nombre, uc.celular AS conductor_celular, c.placa,
              up.nombre AS pasajero_nombre, up.celular AS pasajero_celular
       FROM sos_alertas s
       JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN viajes v ON v.id = s.viaje_id
       LEFT JOIN conductores c ON c.id = v.conductor_id
       LEFT JOIN usuarios uc ON uc.id = c.usuario_id
       LEFT JOIN pasajeros p ON p.id = v.pasajero_id
       LEFT JOIN usuarios up ON up.id = p.usuario_id
       ${filtro}
       ORDER BY (s.estado = 'activa') DESC, s.creado_en DESC LIMIT 100`,
      params
    )
    res.json(r.rows)
  } catch (error) {
    console.error('Error listarSOS:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/admin/sos/:id/atender   { nota }
const atenderSOS = async (req, res) => {
  try {
    const nota = String(req.body?.nota || '').trim().slice(0, 500) || null
    const r = await query(
      `UPDATE sos_alertas SET estado = 'atendida', atendida_en = NOW(), atendida_por = $2, nota_admin = $3
       WHERE id = $1 AND estado = 'activa' RETURNING id`,
      [req.params.id, req.usuario.id, nota]
    )
    if (r.rowCount === 0) return res.status(409).json({ error: 'La alerta no existe o ya fue atendida' })
    res.json({ mensaje: 'Alerta marcada como atendida' })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Alerta no encontrada' })
    console.error('Error atenderSOS:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AUDITORÍA
// ═══════════════════════════════════════════════════════════════════════
// GET /api/admin/auditoria?accion=&page=&limit=
const listarAuditoria = async (req, res) => {
  try {
    const { limit, offset } = paginar(req.query.page, req.query.limit, 200)
    const params = []
    let filtro = ''
    if (req.query.accion) { params.push(`%${String(req.query.accion).slice(0, 60)}%`); filtro = 'WHERE a.accion ILIKE $1' }
    params.push(limit, offset)
    const r = await query(
      `SELECT a.id, a.accion, a.entidad, a.entidad_id, a.detalle, a.ip, a.creado_en, u.nombre AS usuario_nombre
       FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
       ${filtro}
       ORDER BY a.creado_en DESC, a.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    res.json(r.rows)
  } catch (error) {
    console.error('Error listarAuditoria:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = {
  estadisticas, alertas, mapaVivo,
  obtenerConfiguracion, guardarConfiguracion,
  listarZonas, crearZona, actualizarZona, eliminarZona,
  listarReclamos, resolverReclamo,
  listarSOS, atenderSOS,
  listarAuditoria,
  POR_DEFECTO
}
