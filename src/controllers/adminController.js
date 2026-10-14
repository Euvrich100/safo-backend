const path = require('path')
const fs = require('fs')
const { query, pool } = require('../config/database')
const { UPLOADS_DIR } = require('../config/uploads')

// Paginación segura: números enteros acotados (evita LIMIT/OFFSET inválidos)
const paginar = (page, limit, maxLimit = 100) => {
  const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), maxLimit)
  const p = Math.max(parseInt(page, 10) || 1, 1)
  return { limit: l, offset: (p - 1) * l }
}

// GET /api/admin/dashboard
// Estadísticas generales para el panel web
const dashboard = async (req, res) => {
  try {
    const [conductores, viajes, ingresos, pendientes, pasajeros] = await Promise.all([
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

      query(`SELECT COUNT(*) as total FROM conductores WHERE estado_doc = 'pendiente'`),

      query(`SELECT COUNT(*) as total FROM pasajeros`)
    ])

    res.json({
      conductores: conductores.rows[0],
      viajes_hoy: viajes.rows[0],
      ingresos_mes: ingresos.rows[0],
      documentos_pendientes: pendientes.rows[0].total,
      total_pasajeros: pasajeros.rows[0].total
    })
  } catch (error) {
    console.error('Error dashboard:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/admin/conductores
// Lista conductores con filtros. Con ?estado_doc=pendiente es la bandeja de
// solicitudes de registro por revisar.
const listarConductores = async (req, res) => {
  try {
    const { estado_doc, estado_usuario, buscar } = req.query
    const { limit, offset } = paginar(req.query.page, req.query.limit)

    const filtros = []
    const params = []
    let i = 1

    if (estado_doc) {
      filtros.push(`c.estado_doc = $${i++}`)
      params.push(estado_doc)
    }
    if (estado_usuario) {
      filtros.push(`u.estado = $${i++}`)
      params.push(estado_usuario)
    }
    if (buscar) {
      filtros.push(`(u.nombre ILIKE $${i} OR u.celular LIKE $${i} OR c.dni LIKE $${i} OR c.placa ILIKE $${i})`)
      params.push(`%${buscar}%`)
      i++
    }

    const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : ''
    params.push(limit, offset)

    const resultado = await query(
      `SELECT u.nombre, u.celular, u.estado as estado_usuario,
              c.id, c.dni, c.placa, c.vehiculo_marca, c.vehiculo_modelo,
              c.vehiculo_color, c.estado_doc, c.rechazo_motivo, c.disponible,
              c.calificacion_prom, c.total_viajes, c.suscripcion_vence, c.creado_en
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

// GET /api/admin/conductores/:id
// Ficha completa de una solicitud, con los nombres de archivo de los
// documentos (se descargan con GET /api/admin/documentos/:archivo).
const detalleConductor = async (req, res) => {
  try {
    const resultado = await query(
      `SELECT u.nombre, u.celular, u.estado as estado_usuario, u.creado_en as registrado_en,
              c.id, c.dni, c.fecha_nacimiento, c.direccion,
              c.licencia_numero, c.licencia_categoria, c.placa,
              c.vehiculo_marca, c.vehiculo_modelo, c.vehiculo_color, c.vehiculo_anno,
              c.dni_foto_frontal_url, c.dni_foto_trasera_url, c.licencia_foto_url,
              c.vehiculo_foto_url, c.perfil_foto_url,
              c.estado_doc, c.rechazo_motivo, c.suscripcion_vence,
              c.calificacion_prom, c.total_viajes
       FROM conductores c
       JOIN usuarios u ON u.id = c.usuario_id
       WHERE c.id = $1`,
      [req.params.id]
    )
    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Conductor no encontrado' })
    }
    res.json(resultado.rows[0])
  } catch (error) {
    // 22P02 = id con formato de UUID inválido
    if (error.code === '22P02') return res.status(404).json({ error: 'Conductor no encontrado' })
    console.error('Error detalleConductor:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/admin/documentos/:archivo
// Sirve una foto de documento SOLO a administradores (DNI y licencia son datos
// personales: no deben ser públicos como una carpeta estática).
const verDocumento = (req, res) => {
  // basename evita path traversal ("../../.env")
  const archivo = path.basename(req.params.archivo)
  const ruta = path.join(UPLOADS_DIR, archivo)
  if (!fs.existsSync(ruta)) {
    return res.status(404).json({ error: 'Documento no encontrado' })
  }
  res.set('Cache-Control', 'private, max-age=300')
  res.sendFile(ruta)
}

// PUT /api/admin/conductores/:id/documentos
// Aprobar o rechazar la solicitud del conductor
const revisarDocumentos = async (req, res) => {
  const client = await pool.connect()
  try {
    const { id } = req.params
    const { decision, motivo } = req.body  // decision: 'aprobado' | 'rechazado'

    if (!['aprobado', 'rechazado'].includes(decision)) {
      return res.status(400).json({ error: 'Decisión inválida' })
    }
    if (decision === 'rechazado' && !motivo?.trim()) {
      return res.status(400).json({ error: 'Indica el motivo del rechazo' })
    }

    await client.query('BEGIN')

    const actualizado = await client.query(
      `UPDATE conductores SET
        estado_doc = $1,
        rechazo_motivo = $2,
        actualizado_en = NOW()
       WHERE id = $3
       RETURNING usuario_id`,
      [decision, decision === 'rechazado' ? motivo.trim() : null, id]
    )

    if (actualizado.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Conductor no encontrado' })
    }

    const usuarioId = actualizado.rows[0].usuario_id

    if (decision === 'aprobado') {
      // Activar cuenta y crear la suscripción del mes en curso como pendiente
      await client.query("UPDATE usuarios SET estado = 'activo' WHERE id = $1", [usuarioId])
      await client.query(
        `INSERT INTO suscripciones (conductor_id, periodo_mes, estado)
         VALUES ($1, DATE_TRUNC('month', CURRENT_DATE)::date, 'pendiente')
         ON CONFLICT (conductor_id, periodo_mes) DO NOTHING`,
        [id]
      )
    } else {
      // Un rechazo no deja al conductor operando ni disponible
      await client.query("UPDATE usuarios SET estado = 'inactivo' WHERE id = $1 AND estado = 'activo'", [usuarioId])
      await client.query('UPDATE conductores SET disponible = FALSE WHERE id = $1', [id])
    }

    await client.query('COMMIT')

    res.json({
      mensaje: decision === 'aprobado'
        ? '✅ Conductor aprobado y activado'
        : '❌ Solicitud rechazada'
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error.code === '22P02') return res.status(404).json({ error: 'Conductor no encontrado' })
    console.error('Error revisarDocumentos:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  } finally {
    client.release()
  }
}

// POST /api/admin/suscripciones/confirmar
// El admin confirma el pago de S/ 5 de un conductor (Yape/Plin manual)
const confirmarSuscripcion = async (req, res) => {
  try {
    const { conductor_id, metodo_pago, comprobante_url } = req.body

    if (!conductor_id) {
      return res.status(400).json({ error: 'conductor_id requerido' })
    }

    // Marca como pagada la suscripción del mes y calcula el vencimiento:
    // 1 mes desde hoy, o desde el vencimiento actual si todavía no venció
    // (así pagar por adelantado no hace perder días).
    const resultado = await query(
      `WITH pago AS (
         UPDATE suscripciones SET
           estado = 'pagado',
           metodo_pago = $1,
           comprobante_url = $2,
           pagado_en = NOW(),
           confirmado_por = $3
         WHERE conductor_id = $4
           AND periodo_mes = DATE_TRUNC('month', CURRENT_DATE)::date
           AND estado = 'pendiente'
         RETURNING conductor_id
       )
       UPDATE conductores c SET
         suscripcion_vence = (GREATEST(COALESCE(c.suscripcion_vence, CURRENT_DATE), CURRENT_DATE) + INTERVAL '1 month')::date,
         actualizado_en = NOW()
       FROM pago WHERE c.id = pago.conductor_id
       RETURNING c.suscripcion_vence`,
      [metodo_pago || null, comprobante_url || null, req.usuario.id, conductor_id]
    )

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'No hay una suscripción pendiente este mes para ese conductor' })
    }

    const vence = new Date(resultado.rows[0].suscripcion_vence)
    res.json({ mensaje: '✅ Suscripción confirmada. Conductor activo hasta ' + vence.toLocaleDateString('es-PE', { timeZone: 'UTC' }) })
  } catch (error) {
    if (error.code === '22P02' || error.code === '23514') {
      return res.status(400).json({ error: 'Datos de pago inválidos' })
    }
    console.error('Error confirmarSuscripcion:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/admin/viajes
// Lista todos los viajes con filtros
const listarViajes = async (req, res) => {
  try {
    const { estado, fecha } = req.query
    const { limit, offset } = paginar(req.query.page, req.query.limit, 100)

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

// GET /api/admin/pasajeros
const listarPasajeros = async (req, res) => {
  try {
    const { estado, buscar } = req.query
    const { limit, offset } = paginar(req.query.page, req.query.limit)

    const filtros = []
    const params = []
    let i = 1
    if (estado) { filtros.push(`u.estado = $${i++}`); params.push(estado) }
    if (buscar) {
      filtros.push(`(u.nombre ILIKE $${i} OR u.celular LIKE $${i})`)
      params.push(`%${buscar}%`)
      i++
    }
    const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : ''
    params.push(limit, offset)

    const resultado = await query(
      `SELECT u.id as usuario_id, p.id, u.nombre, u.celular, u.email,
              u.estado as estado_usuario, p.cancelaciones_mes, u.creado_en,
              (SELECT COUNT(*) FROM viajes v WHERE v.pasajero_id = p.id) as total_viajes
       FROM pasajeros p
       JOIN usuarios u ON u.id = p.usuario_id
       ${where}
       ORDER BY u.creado_en DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    )
    res.json(resultado.rows)
  } catch (error) {
    console.error('Error listarPasajeros:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/admin/usuarios/:id/estado
// Suspender / reactivar una cuenta de pasajero o conductor
const cambiarEstadoUsuario = async (req, res) => {
  try {
    const { estado } = req.body
    if (!['activo', 'suspendido'].includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' })
    }

    // Un administrador no puede suspenderse a sí mismo ni a otro admin
    const resultado = await query(
      `UPDATE usuarios SET estado = $1, actualizado_en = NOW()
       WHERE id = $2 AND rol <> 'admin'
         AND (rol <> 'conductor' OR $1 = 'suspendido' OR EXISTS (
               SELECT 1 FROM conductores c WHERE c.usuario_id = usuarios.id AND c.estado_doc = 'aprobado'))
       RETURNING id, rol`,
      [estado, req.params.id]
    )
    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado, es administrador o su solicitud aún no fue aprobada' })
    }

    if (estado === 'suspendido' && resultado.rows[0].rol === 'conductor') {
      await query('UPDATE conductores SET disponible = FALSE WHERE usuario_id = $1', [req.params.id])
    }

    res.json({ mensaje: estado === 'activo' ? '✅ Cuenta reactivada' : '⛔ Cuenta suspendida' })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Usuario no encontrado' })
    console.error('Error cambiarEstadoUsuario:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = {
  dashboard, listarConductores, detalleConductor, verDocumento,
  revisarDocumentos, confirmarSuscripcion, listarViajes,
  listarPasajeros, cambiarEstadoUsuario
}
