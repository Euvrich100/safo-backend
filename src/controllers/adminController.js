const path = require('path')
const { query, pool } = require('../config/database')
const almacen = require('../services/almacenamiento')
const docs = require('../services/documentos')

// Consulta pública del SOAT por placa (APESEG). El admin la abre para cotejar el documento.
const URL_CONSULTA_SOAT = process.env.URL_CONSULTA_SOAT || 'https://www.apeseg.org.pe/consultas-soat/'

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
    const { estado_doc, estado_usuario, buscar, tipo_vehiculo, documentos } = req.query
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
    if (tipo_vehiculo) {
      filtros.push(`c.tipo_vehiculo = $${i++}`)
      params.push(tipo_vehiculo)
    }
    // documentos=vencidos: con algún documento vencido · renovaciones: con una renovación por revisar
    if (documentos === 'vencidos') filtros.push(`NOT ${docs.DOCS_AL_DIA_SQL}`)
    if (documentos === 'renovaciones') filtros.push(`EXISTS (SELECT 1 FROM jsonb_each(c.renovaciones) r WHERE r.value->>'estado' = 'pendiente')`)
    if (buscar) {
      filtros.push(`(u.nombre ILIKE $${i} OR u.celular LIKE $${i} OR c.dni LIKE $${i} OR c.placa ILIKE $${i})`)
      params.push(`%${buscar}%`)
      i++
    }

    const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : ''
    params.push(limit, offset)

    const resultado = await query(
      `SELECT u.nombre, u.celular, u.estado as estado_usuario,
              c.id, c.dni, c.placa, c.tipo_vehiculo, c.vehiculo_marca, c.vehiculo_modelo,
              c.vehiculo_color, c.estado_doc, c.rechazo_motivo, c.disponible,
              c.calificacion_prom, c.total_viajes, c.suscripcion_vence, c.creado_en,
              c.soat_tipo, c.permiso_municipal_url, ${docs.FECHAS_SQL},
              (SELECT COUNT(*)::int FROM jsonb_each(c.renovaciones) r WHERE r.value->>'estado' = 'pendiente') AS renovaciones_pendientes
       FROM conductores c
       JOIN usuarios u ON u.id = c.usuario_id
       ${where}
       ORDER BY c.creado_en DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    )

    res.json(resultado.rows.map(c => ({
      ...c,
      vencidos: docs.vencidos(c).map(v => v.etiqueta),
      por_vencer: docs.vigencias(c).filter(v => v.estado === 'por_vencer').map(v => v.etiqueta),
    })))
  } catch (error) {
    console.error('Error listarConductores:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/admin/conductores/:id
// Ficha completa de una solicitud, con los nombres de archivo de los
// documentos (se descargan con GET /api/admin/documentos/:archivo).
const SELECT_FICHA = `
  SELECT u.nombre, u.celular, u.estado as estado_usuario, u.creado_en as registrado_en,
         u.id as usuario_id, c.*, ${docs.FECHAS_SQL},
         to_char(c.fecha_nacimiento, 'YYYY-MM-DD') AS fecha_nacimiento
  FROM conductores c
  JOIN usuarios u ON u.id = c.usuario_id
  WHERE c.id = $1`

// Arma la ficha: datos + vigencias + lista de revisión + renovaciones por revisar
const armarFicha = (c) => {
  const { lat_actual, lng_actual, ...datos } = c
  return {
    ...datos,
    ...docs.resumen(c),
    checklist: docs.rubros(c),
    renovaciones: c.renovaciones || {},
    enlace_consulta_soat: URL_CONSULTA_SOAT,
  }
}

const detalleConductor = async (req, res) => {
  try {
    const resultado = await query(SELECT_FICHA, [req.params.id])
    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Conductor no encontrado' })
    }
    res.json(armarFicha(resultado.rows[0]))
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
const verDocumento = async (req, res) => {
  try {
    // leer() solo acepta los nombres que genera el servidor (evita path traversal: "../../.env")
    const doc = await almacen.leer(req.params.archivo)
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' })
    res.set('Cache-Control', 'private, max-age=300')
    res.set('X-Content-Type-Options', 'nosniff')
    res.type(doc.tipo).send(doc.buffer)
  } catch (error) {
    console.error('Error verDocumento:', error)
    res.status(500).json({ error: 'No se pudo leer el documento' })
  }
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

    // Para aprobar: solicitud completa, nada vencido y cada rubro revisado y en orden
    if (decision === 'aprobado') {
      const ficha = await client.query(SELECT_FICHA, [id])
      if (ficha.rows.length === 0) return res.status(404).json({ error: 'Conductor no encontrado' })
      const f = ficha.rows[0]
      const faltan = docs.faltantes(f)
      if (faltan.length > 0) {
        return res.status(400).json({ error: 'La solicitud está incompleta. Falta: ' + faltan.join(', '), faltantes: faltan })
      }
      const venc = docs.vencidos(f).map(v => v.etiqueta)
      if (venc.length > 0) {
        return res.status(400).json({ error: 'Hay documentos vencidos: ' + venc.join(', '), vencidos: venc })
      }
      const sinRevisar = docs.rubros(f).filter(r => r.obligatorio && r.estado !== 'ok').map(r => r.etiqueta)
      if (sinRevisar.length > 0) {
        return res.status(400).json({ error: 'Marca como correctos estos rubros antes de aprobar: ' + sinRevisar.join(', '), sin_revisar: sinRevisar })
      }
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


// PUT /api/admin/conductores/:id/verificacion
// El admin marca un rubro (identidad, licencia, SOAT…) como correcto u observado.
// body: { rubro, estado: 'ok' | 'observado' | null, nota }
const verificarRubro = async (req, res) => {
  try {
    const { rubro, estado, nota } = req.body
    if (!['ok', 'observado', null].includes(estado ?? null)) {
      return res.status(400).json({ error: 'Estado inválido' })
    }
    if (estado === 'observado' && !String(nota || '').trim()) {
      return res.status(400).json({ error: 'Explica qué se observa en este rubro' })
    }
    const ficha = await query(SELECT_FICHA, [req.params.id])
    if (ficha.rows.length === 0) return res.status(404).json({ error: 'Conductor no encontrado' })
    if (!docs.rubros(ficha.rows[0]).some(r => r.clave === rubro)) {
      return res.status(400).json({ error: 'Rubro inválido' })
    }

    if (!estado) {
      await query(`UPDATE conductores SET verificacion = verificacion - $1::text, actualizado_en = NOW() WHERE id = $2`, [rubro, req.params.id])
    } else {
      const valor = { estado, nota: String(nota || '').trim().slice(0, 300) || null, por: req.usuario.id, en: new Date().toISOString() }
      await query(
        `UPDATE conductores SET verificacion = jsonb_set(verificacion, ARRAY[$1::text], $2::jsonb, true), actualizado_en = NOW() WHERE id = $3`,
        [rubro, JSON.stringify(valor), req.params.id]
      )
    }
    const nueva = await query(SELECT_FICHA, [req.params.id])
    res.json(armarFicha(nueva.rows[0]))
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Conductor no encontrado' })
    console.error('Error verificarRubro:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/admin/conductores/:id/renovaciones/:tipo
// Aprueba o rechaza un documento renovado por el conductor (nuevo SOAT, licencia revalidada…).
// Mientras no se apruebe, el documento vencido sigue bloqueando al conductor.
const decidirRenovacion = async (req, res) => {
  const client = await pool.connect()
  try {
    const { id, tipo } = req.params
    const { decision, motivo } = req.body
    if (!Object.hasOwn(docs.RENOVABLES, tipo)) return res.status(400).json({ error: 'Documento inválido' })
    if (!['aprobado', 'rechazado'].includes(decision)) return res.status(400).json({ error: 'Decisión inválida' })
    if (decision === 'rechazado' && !String(motivo || '').trim()) return res.status(400).json({ error: 'Indica el motivo del rechazo' })

    await client.query('BEGIN')
    const fila = await client.query('SELECT renovaciones FROM conductores WHERE id = $1 FOR UPDATE', [id])
    if (fila.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Conductor no encontrado' }) }
    const r = fila.rows[0].renovaciones?.[tipo]
    if (!r || r.estado !== 'pendiente') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'No hay una renovación pendiente de este documento' }) }

    if (decision === 'rechazado') {
      const nuevo = { ...r, estado: 'rechazado', motivo: String(motivo).trim().slice(0, 300), revisado_en: new Date().toISOString() }
      await client.query(
        `UPDATE conductores SET renovaciones = jsonb_set(renovaciones, ARRAY[$1::text], $2::jsonb, true), actualizado_en = NOW() WHERE id = $3`,
        [tipo, JSON.stringify(nuevo), id]
      )
    } else {
      const campos = {
        soat: { soat_tipo: r.tipo, soat_numero: r.numero, soat_aseguradora: r.aseguradora, soat_vence: r.vence, soat_foto_url: r.archivo },
        licencia: { licencia_vence: r.vence, licencia_foto_url: r.archivo, ...(r.categoria ? { licencia_categoria: r.categoria } : {}), ...(r.archivo_reverso ? { licencia_foto_trasera_url: r.archivo_reverso } : {}) },
        revision: { revision_tecnica_vence: r.vence, revision_tecnica_foto_url: r.archivo },
        antecedentes: { antecedentes_fecha: r.fecha, antecedentes_url: r.archivo },
        permiso: { permiso_municipal_numero: r.numero, permiso_municipal_vence: r.vence, permiso_municipal_url: r.archivo },
      }[tipo]
      const cols = Object.keys(campos)
      const rubro = docs.RENOVABLES[tipo].rubro
      const valorOk = { estado: 'ok', nota: null, por: req.usuario.id, en: new Date().toISOString() }
      await client.query(
        `UPDATE conductores SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')},
           renovaciones = renovaciones - $1::text,
           verificacion = jsonb_set(verificacion, ARRAY['${rubro}'], $2::jsonb, true),
           actualizado_en = NOW()
         WHERE id = $${cols.length + 3}`,
        [tipo, JSON.stringify(valorOk), ...cols.map(c => campos[c]), id]
      )
    }
    await client.query('COMMIT')
    const nueva = await query(SELECT_FICHA, [id])
    res.json(armarFicha(nueva.rows[0]))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error.code === '22P02') return res.status(404).json({ error: 'Conductor no encontrado' })
    console.error('Error decidirRenovacion:', error)
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
              v.distancia_km, v.duracion_min, v.tarifa_estimada, v.servicio,
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
  revisarDocumentos, verificarRubro, decidirRenovacion, confirmarSuscripcion, listarViajes,
  listarPasajeros, cambiarEstadoUsuario
}
