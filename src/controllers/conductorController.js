const path = require('path')
const fs = require('fs')
const { query } = require('../config/database')
const { UPLOADS_DIR } = require('../config/uploads')
const docs = require('../services/documentos')

// GET /api/conductores/perfil
// El conductor ve su propio perfil completo
const SELECT_PROPIO = `
  SELECT u.nombre, u.celular, u.estado, c.*, ${docs.FECHAS_SQL}
  FROM usuarios u
  JOIN conductores c ON c.usuario_id = u.id
  WHERE u.id = $1`

const obtenerPerfil = async (req, res) => {
  try {
    const resultado = await query(SELECT_PROPIO, [req.usuario.id])

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil de conductor no encontrado' })
    }

    const c = resultado.rows[0]
    const resumen = docs.resumen(c)

    // Con un documento vencido no se puede seguir conectado
    let disponible = c.disponible
    if (disponible && resumen.vencidos.length > 0) {
      const enViaje = await query(
        `SELECT 1 FROM viajes WHERE conductor_id = $1 AND estado IN ('aceptado','en_camino','recogido') LIMIT 1`, [c.id])
      if (enViaje.rows.length === 0) {
        await query('UPDATE conductores SET disponible = FALSE, actualizado_en = NOW() WHERE id = $1', [c.id])
        disponible = false
      }
    }

    res.json({
      nombre: c.nombre, celular: c.celular, estado: c.estado,
      conductor_id: c.id, dni: c.dni, licencia_numero: c.licencia_numero, placa: c.placa,
      tipo_vehiculo: c.tipo_vehiculo, vehiculo_marca: c.vehiculo_marca, vehiculo_modelo: c.vehiculo_modelo,
      vehiculo_color: c.vehiculo_color, vehiculo_anno: c.vehiculo_anno,
      estado_doc: c.estado_doc, rechazo_motivo: c.rechazo_motivo, disponible,
      calificacion_prom: c.calificacion_prom, total_viajes: c.total_viajes, suscripcion_vence: c.suscripcion_vence,
      licencia_foto_url: c.licencia_foto_url, vehiculo_foto_url: c.vehiculo_foto_url,
      documentos: {
        vigencias: resumen.vigencias, vencidos: resumen.vencidos, verificado: resumen.verificado,
        renovaciones_pendientes: Object.values(c.renovaciones || {}).filter(r => r.estado === 'pendiente').length,
      }
    })
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
      `SELECT c.estado_doc, c.suscripcion_vence, c.tipo_vehiculo, c.soat_tipo, c.permiso_municipal_url, ${docs.FECHAS_SQL}
       FROM conductores c WHERE c.usuario_id = $1`,
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
      const vencidos = docs.vencidos(conductor).map(v => v.etiqueta)
      if (vencidos.length > 0) {
        return res.status(403).json({
          error: `No puedes conectarte: tienes vencido ${vencidos.join(', ')}. Renuévalo en «Mis documentos» para volver a trabajar.`,
          vencidos
        })
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

// ═══════════════════════════════════════════════════════════════════════
// MIS DOCUMENTOS — vigencias y renovaciones del conductor
// ═══════════════════════════════════════════════════════════════════════
const soloDigitos = (v) => String(v || '').replace(/\D/g, '')
const texto = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)

// GET /api/conductores/documentos
const misDocumentos = async (req, res) => {
  try {
    const r = await query(SELECT_PROPIO, [req.usuario.id])
    if (r.rows.length === 0) return res.status(404).json({ error: 'Perfil de conductor no encontrado' })
    const c = r.rows[0]
    const resumen = docs.resumen(c)
    res.json({
      ...resumen,
      rubros: docs.rubros(c).map(({ clave, etiqueta, estado, nota, obligatorio }) => ({ clave, etiqueta, estado, nota, obligatorio })),
      renovaciones: Object.fromEntries(Object.entries(c.renovaciones || {}).map(([k, v]) =>
        [k, { estado: v.estado, motivo: v.motivo || null, vence: v.vence || v.fecha || null, subido_en: v.subido_en }])),
      datos: {
        soat_tipo: c.soat_tipo, soat_numero: c.soat_numero, soat_aseguradora: c.soat_aseguradora,
        licencia_numero: c.licencia_numero, licencia_categoria: c.licencia_categoria,
        antecedentes_fecha: c.antecedentes_fecha,
        permiso_municipal_numero: c.permiso_municipal_numero,
        emergencia_nombre: c.emergencia_nombre, emergencia_celular: c.emergencia_celular, emergencia_parentesco: c.emergencia_parentesco,
        tipo_vehiculo: c.tipo_vehiculo,
      },
      categorias_licencia: docs.LICENCIAS[c.tipo_vehiculo] || [],
      aseguradoras: docs.ASEGURADORAS,
      exige_revision: docs.exigeRevision(c.tipo_vehiculo),
    })
  } catch (error) {
    console.error('Error misDocumentos:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/conductores/documentos/:tipo   (multipart: documento [+ documento_reverso en licencia])
// El conductor sube la renovación; queda EN REVISIÓN hasta que un administrador la apruebe.
const renovarDocumento = async (req, res) => {
  const files = req.files || {}
  const rechazar = (status, error) => { docs.borrarArchivos(files); return res.status(status).json({ error }) }
  try {
    const { tipo } = req.params
    if (!Object.hasOwn(docs.RENOVABLES, tipo)) return rechazar(400, 'Documento inválido')
    const b = req.body
    const hoy = docs.hoyLima()
    const archivo = files.documento?.[0]
    if (!archivo) return rechazar(400, 'Sube el documento (foto o PDF)')
    if (Object.values(files).flat().some(f => !docs.contenidoValido(f))) {
      return rechazar(400, 'El archivo no es una imagen o PDF válido. Súbelo de nuevo.')
    }

    const c = (await query('SELECT id, tipo_vehiculo, renovaciones FROM conductores WHERE usuario_id = $1', [req.usuario.id])).rows[0]
    if (!c) return rechazar(404, 'Perfil de conductor no encontrado')

    const venceValido = (campo, nombre) => {
      if (!docs.esFecha(b[campo])) return `Indica la fecha de vencimiento de ${nombre}`
      if (b[campo] < hoy) return `La fecha de vencimiento de ${nombre} ya pasó`
      if (docs.diasEntre(hoy, b[campo]) > 365 * 12) return 'La fecha de vencimiento es demasiado lejana'
      return null
    }
    let entrada, err
    if (tipo === 'soat') {
      const soat_tipo = String(b.soat_tipo || 'soat').toLowerCase()
      if (!['soat', 'cat'].includes(soat_tipo)) return rechazar(400, 'Elige SOAT o CAT')
      if (!texto(b.soat_numero, 40)) return rechazar(400, 'Escribe el número de póliza')
      if (!texto(b.soat_aseguradora, 60)) return rechazar(400, 'Indica la aseguradora')
      err = venceValido('vence', 'tu seguro'); if (err) return rechazar(400, err)
      entrada = { tipo: soat_tipo, numero: texto(b.soat_numero, 40).toUpperCase(), aseguradora: texto(b.soat_aseguradora, 60), vence: b.vence }
    } else if (tipo === 'licencia') {
      err = venceValido('vence', 'tu licencia'); if (err) return rechazar(400, err)
      const categoria = texto(b.licencia_categoria, 10)
      if (categoria && !docs.LICENCIAS[c.tipo_vehiculo].includes(categoria)) {
        return rechazar(400, `Para este vehículo la licencia debe ser categoría ${docs.LICENCIAS[c.tipo_vehiculo].join(', ')}`)
      }
      entrada = { vence: b.vence, categoria: categoria || null, archivo_reverso: files.documento_reverso?.[0]?.filename || null }
    } else if (tipo === 'revision') {
      err = venceValido('vence', 'tu revisión técnica'); if (err) return rechazar(400, err)
      entrada = { vence: b.vence }
    } else if (tipo === 'antecedentes') {
      if (!docs.esFecha(b.fecha) || b.fecha > hoy) return rechazar(400, 'Indica la fecha de emisión del certificado')
      if (docs.diasEntre(b.fecha, hoy) > 90) return rechazar(400, 'El certificado tiene más de 90 días. Saca uno reciente')
      entrada = { fecha: b.fecha }
    } else { // permiso
      if (!texto(b.numero, 40)) return rechazar(400, 'Escribe el número del permiso')
      err = venceValido('vence', 'tu permiso'); if (err) return rechazar(400, err)
      entrada = { numero: texto(b.numero, 40), vence: b.vence }
    }

    // Si ya había una renovación sin revisar, su archivo anterior se descarta
    const previa = c.renovaciones?.[tipo]
    if (previa?.archivo) fs.unlink(path.join(UPLOADS_DIR, previa.archivo), () => {})
    if (previa?.archivo_reverso) fs.unlink(path.join(UPLOADS_DIR, previa.archivo_reverso), () => {})

    const valor = { ...entrada, archivo: archivo.filename, estado: 'pendiente', subido_en: new Date().toISOString() }
    await query(
      `UPDATE conductores SET renovaciones = jsonb_set(renovaciones, ARRAY[$1::text], $2::jsonb, true), actualizado_en = NOW() WHERE id = $3`,
      [tipo, JSON.stringify(valor), c.id]
    )
    res.json({ mensaje: 'Documento enviado. Un administrador lo revisará en menos de 24 horas.', estado: 'pendiente' })
  } catch (error) {
    docs.borrarArchivos(files)
    console.error('Error renovarDocumento:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/conductores/emergencia — cambia el contacto de emergencia (se vuelve a verificar)
const actualizarEmergencia = async (req, res) => {
  try {
    const nombre = texto(req.body.nombre, 100), parentesco = texto(req.body.parentesco, 30), celular = soloDigitos(req.body.celular)
    if (!nombre || !parentesco) return res.status(400).json({ error: 'Indica el nombre y el parentesco' })
    if (celular.length !== 9) return res.status(400).json({ error: 'El celular debe tener 9 dígitos' })
    if (celular === req.usuario.celular) return res.status(400).json({ error: 'Debe ser otra persona, con otro celular' })
    await query(
      `UPDATE conductores SET emergencia_nombre = $1, emergencia_parentesco = $2, emergencia_celular = $3,
         verificacion = verificacion - 'emergencia', actualizado_en = NOW()
       WHERE usuario_id = $4`,
      [nombre, parentesco, celular, req.usuario.id]
    )
    res.json({ mensaje: 'Contacto de emergencia actualizado' })
  } catch (error) {
    console.error('Error actualizarEmergencia:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/conductores/:id/foto — el pasajero ve el rostro del conductor que lo va a llevar.
// Solo se sirve la foto de perfil de conductores aprobados (no los demás documentos).
const fotoConductor = async (req, res) => {
  try {
    const r = await query(
      `SELECT perfil_foto_url FROM conductores WHERE id = $1 AND estado_doc = 'aprobado' AND perfil_foto_url IS NOT NULL`,
      [req.params.id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Sin foto' })
    const ruta = path.join(UPLOADS_DIR, path.basename(r.rows[0].perfil_foto_url))
    if (!fs.existsSync(ruta)) return res.status(404).json({ error: 'Sin foto' })
    res.set('Cache-Control', 'private, max-age=300')
    res.set('X-Content-Type-Options', 'nosniff')
    res.sendFile(ruta)
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Sin foto' })
    console.error('Error fotoConductor:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = {
  misDocumentos,
  renovarDocumento,
  actualizarEmergencia,
  fotoConductor,
  obtenerGanancias,
  obtenerPerfil,
  actualizarPerfil,
  cambiarDisponibilidad,
  actualizarUbicacion,
  obtenerSuscripciones,
  obtenerViajes
}
