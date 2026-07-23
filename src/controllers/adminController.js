const { query } = require('../config/database')

// GET /api/admin/dashboard
// Estadísticas generales para el panel web
const dashboard = async (req, res) => {
  try {
    const [conductores, viajes, ingresos, pendientes] = await Promise.all([
      query(`SELECT
               COUNT(*) FILTER (WHERE u.estado = 'activo' AND c.estado_doc = 'aprobado') as activos,
               COUNT(*) FILTER (WHERE c.estado_doc = 'pendiente') as pendientes_doc,
               COUNT(*) FILTER (WHERE u.estado = 'suspendido') as suspendidos,
               COUNT(*) as total
             FROM conductores c JOIN usuarios u ON u.id = c.usuario_id`),

      query(`SELECT
               COUNT(*) FILTER (WHERE estado = 'completado') as completados,
               COUNT(*) FILTER (WHERE estado LIKE 'cancelado%') as cancelados,
               COUNT(*) FILTER (WHERE estado IN ('solicitado','aceptado','en_camino')) as en_curso
             FROM viajes WHERE DATE(solicitado_en) = CURRENT_DATE`),

      query(`SELECT
               COALESCE(SUM(monto), 0) as suscripciones_mes
             FROM suscripciones
             WHERE estado = 'pagado'
               AND DATE_TRUNC('month', pagado_en) = DATE_TRUNC('month', NOW())`),

      query(`SELECT COUNT(*) as total FROM conductores WHERE estado_doc = 'pendiente'`)
    ])

    res.json({
      conductores: conductores.rows[0],
      viajes_hoy: viajes.rows[0],
      ingresos_mes: ingresos.rows[0],
      documentos_pendientes: pendientes.rows[0].total
    })
  } catch (error) {
    console.error('Error dashboard:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/admin/conductores
// Lista todos los conductores con filtros
const listarConductores = async (req, res) => {
  try {
    const { estado_doc, estado_usuario, page = 1, limit = 20 } = req.query
    const offset = (page - 1) * limit

    let filtros = []
    let params = []
    let i = 1

    if (estado_doc) {
      filtros.push(`c.estado_doc = $${i++}`)
      params.push(estado_doc)
    }
    if (estado_usuario) {
      filtros.push(`u.estado = $${i++}`)
      params.push(estado_usuario)
    }

    const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : ''

    params.push(limit, offset)

    const resultado = await query(
      `SELECT u.nombre, u.celular, u.estado as estado_usuario,
              c.id, c.dni, c.placa, c.vehiculo_marca, c.vehiculo_modelo,
              c.estado_doc, c.disponible, c.calificacion_prom,
              c.total_viajes, c.suscripcion_vence, c.creado_en
       FROM conductores c
       JOIN usuarios u ON u.id = c.usuario_id
       ${where}
       ORDER BY c.creado_en DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    )

    res.json(resultado.rows)
  } catch (error) {
    console.error('Error listarConductores:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/admin/conductores/:id/documentos
// Aprobar o rechazar documentos del conductor
const revisarDocumentos = async (req, res) => {
  try {
    const { id } = req.params
    const { decision, motivo } = req.body  // decision: 'aprobado' | 'rechazado'

    if (!['aprobado', 'rechazado'].includes(decision)) {
      return res.status(400).json({ error: 'Decisión inválida' })
    }

    await query(
      `UPDATE conductores SET
        estado_doc = $1,
        rechazo_motivo = $2,
        actualizado_en = NOW()
       WHERE id = $3`,
      [decision, motivo || null, id]
    )

    // Si se aprueba, activar cuenta y dar suscripción del mes actual
    if (decision === 'aprobado') {
      const conductor = await query('SELECT usuario_id FROM conductores WHERE id = $1', [id])
      await query(
        "UPDATE usuarios SET estado = 'activo' WHERE id = $1",
        [conductor.rows[0].usuario_id]
      )
      // Crear suscripción del mes en curso como pendiente
      await query(
        `INSERT INTO suscripciones (conductor_id, periodo_mes, estado)
         VALUES ($1, DATE_TRUNC('month', NOW()), 'pendiente')
         ON CONFLICT DO NOTHING`,
        [id]
      )
    }

    res.json({
      mensaje: decision === 'aprobado'
        ? '✅ Conductor aprobado y activado'
        : '❌ Documentos rechazados — el conductor fue notificado'
    })
  } catch (error) {
    console.error('Error revisarDocumentos:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/admin/suscripciones/confirmar
// El admin confirma el pago de S/ 5 de un conductor (Yape/Plin manual)
const confirmarSuscripcion = async (req, res) => {
  try {
    const { conductor_id, metodo_pago, comprobante_url } = req.body

    const fechaVence = new Date()
    fechaVence.setMonth(fechaVence.getMonth() + 1)

    // Actualizar suscripción pendiente del mes
    await query(
      `UPDATE suscripciones SET
        estado = 'pagado',
        metodo_pago = $1,
        comprobante_url = $2,
        pagado_en = NOW(),
        confirmado_por = $3
       WHERE conductor_id = $4
         AND DATE_TRUNC('month', periodo_mes) = DATE_TRUNC('month', NOW())
         AND estado = 'pendiente'`,
      [metodo_pago, comprobante_url, req.usuario.id, conductor_id]
    )

    // Actualizar fecha de vencimiento del conductor
    await query(
      'UPDATE conductores SET suscripcion_vence = $1 WHERE id = $2',
      [fechaVences, conductor_id]
    )

    res.json({ mensaje: '✅ Suscripción confirmada. Conductor activo hasta ' + fechaVence.toLocaleDateString('es-PE') })
  } catch (error) {
    console.error('Error confirmarSuscripcion:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/admin/viajes
// Lista todos los viajes con filtros
const listarViajes = async (req, res) => {
  try {
    const { estado, fecha, page = 1, limit = 30 } = req.query
    const offset = (page - 1) * limit

    let filtros = []
    let params = []
    let i = 1

    if (estado) { filtros.push(`v.estado = $${i++}`); params.push(estado) }
    if (fecha)  { filtros.push(`DATE(v.solicitado_en) = $${i++}`); params.push(fecha) }

    const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : ''
    params.push(limit, offset)

    const resultado = await query(
      `SELECT v.id, v.estado, v.direccion_origen, v.direccion_destino,
              v.solicitado_en, v.completado_en, v.cancelado_en,
              v.conductor_fue_despachado, v.cancelacion_motivo,
              uc.nombre as conductor, up.nombre as pasajero,
              pv.monto_total, pv.estado as estado_pago,
              pv.monto_conductor, pv.monto_plataforma
       FROM viajes v
       LEFT JOIN conductores c ON c.id = v.conductor_id
       LEFT JOIN usuarios uc ON uc.id = c.usuario_id
       JOIN pasajeros p ON p.id = v.pasajero_id
       JOIN usuarios up ON up.id = p.usuario_id
       LEFT JOIN pagos_viaje pv ON pv.viaje_id = v.id
       ${where}
       ORDER BY v.solicitado_en DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    )

    res.json(resultado.rows)
  } catch (error) {
    console.error('Error listarViajes:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { dashboard, listarConductores, revisarDocumentos, confirmarSuscripcion, listarViajes }
