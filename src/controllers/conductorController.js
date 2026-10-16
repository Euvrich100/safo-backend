const { query } = require('../config/database')

// GET /api/conductores/perfil
// El conductor ve su propio perfil completo
const obtenerPerfil = async (req, res) => {
  try {
    const resultado = await query(
      `SELECT u.nombre, u.celular, u.estado,
              c.id as conductor_id, c.dni, c.licencia_numero, c.placa, c.tipo_vehiculo,
              c.vehiculo_marca, c.vehiculo_modelo, c.vehiculo_color, c.vehiculo_anno,
              c.estado_doc, c.rechazo_motivo, c.disponible,
              c.calificacion_prom, c.total_viajes, c.suscripcion_vence,
              c.licencia_foto_url, c.vehiculo_foto_url
       FROM usuarios u
       JOIN conductores c ON c.usuario_id = u.id
       WHERE u.id = $1`,
      [req.usuario.id]
    )

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil de conductor no encontrado' })
    }

    res.json(resultado.rows[0])
  } catch (error) {
    console.error('Error obtenerPerfil:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/conductores/perfil
// El conductor actualiza sus datos básicos
const actualizarPerfil = async (req, res) => {
  try {
    const { dni, licencia_numero, placa, vehiculo_marca, vehiculo_modelo, vehiculo_color, vehiculo_anno } = req.body

    await query(
      `UPDATE conductores SET
        dni = COALESCE($1, dni),
        licencia_numero = COALESCE($2, licencia_numero),
        placa = COALESCE($3, placa),
        vehiculo_marca = COALESCE($4, vehiculo_marca),
        vehiculo_modelo = COALESCE($5, vehiculo_modelo),
        vehiculo_color = COALESCE($6, vehiculo_color),
        vehiculo_anno = COALESCE($7, vehiculo_anno),
        actualizado_en = NOW()
       WHERE usuario_id = $8`,
      [dni, licencia_numero, placa, vehiculo_marca, vehiculo_modelo, vehiculo_color, vehiculo_anno, req.usuario.id]
    )

    res.json({ mensaje: 'Perfil actualizado correctamente' })
  } catch (error) {
    console.error('Error actualizarPerfil:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/conductores/disponibilidad
// El conductor activa o desactiva su disponibilidad
const cambiarDisponibilidad = async (req, res) => {
  try {
    const { disponible, lat, lng } = req.body

    // Solo conductores aprobados pueden activarse
    const perfil = await query(
      'SELECT estado_doc, suscripcion_vence FROM conductores WHERE usuario_id = $1',
      [req.usuario.id]
    )

    const conductor = perfil.rows[0]

    if (disponible) {
      if (conductor.estado_doc !== 'aprobado') {
        return res.status(403).json({ error: 'Tus documentos aún no han sido aprobados' })
      }
      if (!conductor.suscripcion_vence || new Date(conductor.suscripcion_vence) < new Date()) {
        return res.status(403).json({ error: 'Tu suscripción está vencida. Renueva por S/ 5.00 para activarte.' })
      }
    }

    await query(
      `UPDATE conductores SET
        disponible = $1,
        lat_actual = COALESCE($2, lat_actual),
        lng_actual = COALESCE($3, lng_actual),
        actualizado_en = NOW()
       WHERE usuario_id = $4`,
      [disponible, lat, lng, req.usuario.id]
    )

    res.json({
      mensaje: disponible ? '✅ Estás disponible para recibir pasajeros' : '⏸ Modo inactivo activado',
      disponible
    })
  } catch (error) {
    console.error('Error cambiarDisponibilidad:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/conductores/ubicacion
// Actualiza la ubicación GPS en tiempo real (llamado cada 10 seg desde la app)
const actualizarUbicacion = async (req, res) => {
  try {
    const { lat, lng } = req.body

    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) || lat === null || lng === null || lat === '' || lng === '') {
      return res.status(400).json({ error: 'Latitud y longitud requeridas' })
    }

    await query(
      'UPDATE conductores SET lat_actual = $1, lng_actual = $2, actualizado_en = NOW() WHERE usuario_id = $3',
      [lat, lng, req.usuario.id]
    )

    res.json({ ok: true })
  } catch (error) {
    console.error('Error actualizarUbicacion:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/conductores/suscripciones
// El conductor ve su historial de pagos mensuales
const obtenerSuscripciones = async (req, res) => {
  try {
    const conductor = await query(
      'SELECT id FROM conductores WHERE usuario_id = $1',
      [req.usuario.id]
    )

    const resultado = await query(
      `SELECT monto, estado, metodo_pago, periodo_mes, pagado_en
       FROM suscripciones
       WHERE conductor_id = $1
       ORDER BY periodo_mes DESC`,
      [conductor.rows[0].id]
    )

    res.json(resultado.rows)
  } catch (error) {
    console.error('Error obtenerSuscripciones:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/conductores/viajes
// Historial de viajes del conductor
const obtenerViajes = async (req, res) => {
  try {
    const conductor = await query(
      'SELECT id FROM conductores WHERE usuario_id = $1',
      [req.usuario.id]
    )

    const resultado = await query(
      `SELECT v.id, v.estado, v.direccion_origen, v.direccion_destino,
              v.solicitado_en, v.completado_en,
              v.distancia_km, v.duracion_min, v.tarifa_estimada, v.servicio,
              u.nombre as nombre_pasajero,
              pv.monto_total, pv.estado as estado_pago
       FROM viajes v
       JOIN pasajeros p ON p.id = v.pasajero_id
       JOIN usuarios u ON u.id = p.usuario_id
       LEFT JOIN pagos_viaje pv ON pv.viaje_id = v.id
       WHERE v.conductor_id = $1
       ORDER BY v.solicitado_en DESC
       LIMIT 50`,
      [conductor.rows[0].id]
    )

    res.json(resultado.rows)
  } catch (error) {
    console.error('Error obtenerViajes:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/conductores/ganancias
// Resumen de hoy / 7 días / 30 días. La tarifa se cobra en mano al pasajero, así
// que la ganancia es ESTIMADA (según la cotización del viaje); las compensaciones
// por cancelación sí las registra la plataforma.
const obtenerGanancias = async (req, res) => {
  try {
    const c = await query(
      `SELECT id, calificacion_prom, total_viajes, suscripcion_vence, disponible
       FROM conductores WHERE usuario_id = $1`, [req.usuario.id])
    if (c.rows.length === 0) return res.status(404).json({ error: 'Perfil de conductor no encontrado' })
    const conductor = c.rows[0]

    const LIMA = "AT TIME ZONE 'UTC' AT TIME ZONE 'America/Lima'"
    const ventana = (desde) => query(
      `SELECT
         COUNT(*) FILTER (WHERE v.estado = 'completado')::int AS viajes,
         COALESCE(SUM(v.tarifa_estimada) FILTER (WHERE v.estado = 'completado'), 0) AS tarifas,
         COALESCE(SUM(pv.monto_conductor) FILTER (WHERE pv.estado = 'compensado_conductor'), 0) AS compensaciones
       FROM viajes v LEFT JOIN pagos_viaje pv ON pv.viaje_id = v.id
       WHERE v.conductor_id = $1
         AND COALESCE(v.completado_en, v.cancelado_en) ${LIMA} >= ${desde}`,
      [conductor.id]
    )
    const [hoy, semana, mes, resenas] = await Promise.all([
      ventana("date_trunc('day', NOW() " + LIMA + ")"),
      ventana("date_trunc('day', NOW() " + LIMA + ") - interval '6 days'"),
      ventana("date_trunc('day', NOW() " + LIMA + ") - interval '29 days'"),
      query(
        `SELECT k.estrellas, k.comentario, k.creado_en
         FROM calificaciones k WHERE k.conductor_id = $1 ORDER BY k.creado_en DESC LIMIT 5`, [conductor.id])
    ])
    const fmt = (r) => {
      const x = r.rows[0]
      const tarifas = Number(x.tarifas), comp = Number(x.compensaciones)
      return { viajes: x.viajes, tarifas: +tarifas.toFixed(2), compensaciones: +comp.toFixed(2), total: +(tarifas + comp).toFixed(2) }
    }
    res.json({
      hoy: fmt(hoy), semana: fmt(semana), mes: fmt(mes),
      calificacion_prom: conductor.calificacion_prom,
      total_viajes: conductor.total_viajes,
      suscripcion_vence: conductor.suscripcion_vence,
      resenas: resenas.rows
    })
  } catch (error) {
    console.error('Error obtenerGanancias:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = {
  obtenerGanancias,
  obtenerPerfil,
  actualizarPerfil,
  cambiarDisponibilidad,
  actualizarUbicacion,
  obtenerSuscripciones,
  obtenerViajes
}
