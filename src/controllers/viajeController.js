const crypto = require('crypto')
const { query, pool } = require('../config/database')
const { leerAjustes, cotizar, zonaDe } = require('../services/plataforma')

// Minutos que tiene el conductor para responder una solicitud. Si no responde,
// se cancela sola y se devuelve la garantía al pasajero (si no, ambos quedarían
// bloqueados para siempre). El conductor que no responde queda NO disponible:
// debe volver a conectarse, para no seguir recibiendo pedidos si dejó el celular.
const SOLICITUD_TIMEOUT_MIN = Math.max(1, parseInt(process.env.SOLICITUD_TIMEOUT_MIN, 10) || 3)

const expirarSolicitudes = async () => {
  try {
    await query(
      `WITH vencidos AS (
         UPDATE viajes SET estado = 'cancelado_conductor', cancelado_en = NOW(),
                cancelacion_motivo = 'Sin respuesta del conductor', actualizado_en = NOW()
         WHERE estado = 'solicitado'
           AND solicitado_en < NOW() - make_interval(mins => ${SOLICITUD_TIMEOUT_MIN})
         RETURNING id
       )
       UPDATE pagos_viaje SET estado = 'devuelto', actualizado_en = NOW()
       WHERE viaje_id IN (SELECT id FROM vencidos)`
    )
  } catch (error) {
    console.error('Error expirarSolicitudes:', error.message)
  }
}

// GET /api/viajes/conductores-disponibles
// El pasajero ve los conductores activos cerca de su ubicación
const conductoresDisponibles = async (req, res) => {
  try {
    const { lat, lng, radio_km = 5 } = req.query

    if (!lat || !lng) {
      return res.status(400).json({ error: 'Ubicación requerida' })
    }

    const latN = parseFloat(lat), lngN = parseFloat(lng)
    const radio = Math.min(Math.max(parseFloat(radio_km) || 5, 0.1), 50)
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
      return res.status(400).json({ error: 'Ubicación inválida' })
    }

    // Haversine en una subconsulta: PostgreSQL no permite HAVING sin GROUP BY
    // ni usar el alias de SELECT dentro de WHERE. LEAST(1, ...) evita que el
    // acos reciba 1.0000000002 por redondeo y devuelva NaN.
    const resultado = await query(
      `SELECT * FROM (
         SELECT c.id, u.nombre, c.placa, c.vehiculo_marca, c.vehiculo_modelo,
                c.vehiculo_color, c.vehiculo_anno, c.calificacion_prom, c.total_viajes,
                c.lat_actual, c.lng_actual,
                ROUND((6371 * acos(LEAST(1, GREATEST(-1,
                  cos(radians($1::float)) * cos(radians(c.lat_actual)) *
                  cos(radians(c.lng_actual) - radians($2::float)) +
                  sin(radians($1::float)) * sin(radians(c.lat_actual))
                ))))::numeric, 2) AS distancia_km
         FROM conductores c
         JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.disponible = TRUE
           AND c.estado_doc = 'aprobado'
           AND u.estado = 'activo'
           AND c.suscripcion_vence >= CURRENT_DATE
           AND c.lat_actual IS NOT NULL
           AND c.lng_actual IS NOT NULL
           AND c.actualizado_en > NOW() - INTERVAL '15 minutes'
       ) cercanos
       WHERE distancia_km <= $3::float
       ORDER BY distancia_km ASC
       LIMIT 20`,
      [latN, lngN, radio]
    )

    res.json(resultado.rows)
  } catch (error) {
    console.error('Error conductoresDisponibles:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/viajes/solicitar
// El pasajero solicita un taxi y deja la garantía de S/ 1.50 (Yape o Plin)
const METODOS_PAGO = ['yape', 'plin']
const ESTADOS_ACTIVOS = ['solicitado', 'aceptado', 'en_camino', 'recogido']
const numeroOnull = (v) => (v === undefined || v === null || v === '' ? null : Number(v))

const solicitarViaje = async (req, res) => {
  const {
    conductor_id,
    lat_origen, lng_origen, direccion_origen,
    lat_destino, lng_destino, direccion_destino,
    referencia_pago
  } = req.body
  const metodo_pago = String(req.body.metodo_pago || '').toLowerCase()

  // Todo se valida ANTES de reservar al conductor: antes un método de pago
  // inválido dejaba al conductor reservado y sin viaje.
  if (!conductor_id) {
    return res.status(400).json({ error: 'Elige un conductor' })
  }
  if (!METODOS_PAGO.includes(metodo_pago)) {
    return res.status(400).json({ error: 'Elige Yape o Plin para la garantía' })
  }
  const ref = String(referencia_pago || '').trim()
  if (ref.length < 4 || ref.length > 100) {
    return res.status(400).json({ error: 'Ingresa el código de operación de tu pago' })
  }
  const latO = numeroOnull(lat_origen), lngO = numeroOnull(lng_origen)
  if (!Number.isFinite(latO) || !Number.isFinite(lngO)) {
    return res.status(400).json({ error: 'Ubicación de recojo inválida' })
  }
  const latD = numeroOnull(lat_destino), lngD = numeroOnull(lng_destino)
  if ((latD !== null && !Number.isFinite(latD)) || (lngD !== null && !Number.isFinite(lngD))) {
    return res.status(400).json({ error: 'Ubicación de destino inválida' })
  }

  let client
  try {
    // Zona de servicio: solo se pide taxi dentro de las zonas activas del admin
    const { restringido, zona } = await zonaDe(latO, lngO)
    if (restringido && !zona) {
      return res.status(422).json({ error: 'Tu ubicación está fuera de las zonas de servicio de SafO', codigo: 'FUERA_DE_ZONA' })
    }
    const ajustes = await leerAjustes()
    let cot = null
    if (latD !== null && lngD !== null) {
      cot = await cotizar({
        latO, lngO, latD, lngD,
        distancia_km: req.body.distancia_km, duracion_min: req.body.duracion_min
      })
    }

    const pasajero = await query('SELECT id FROM pasajeros WHERE usuario_id = $1', [req.usuario.id])
    if (pasajero.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil de pasajero no encontrado' })
    }
    const pasajero_id = pasajero.rows[0].id

    await expirarSolicitudes()
    const enCurso = await query(
      'SELECT 1 FROM viajes WHERE pasajero_id = $1 AND estado = ANY($2) LIMIT 1',
      [pasajero_id, ESTADOS_ACTIVOS]
    )
    if (enCurso.rows.length > 0) {
      return res.status(409).json({ error: 'Ya tienes un viaje en curso' })
    }

    client = await pool.connect()
    await client.query('BEGIN')

    // Reservar al conductor de forma atómica: el UPDATE solo prospera si sigue
    // disponible, así dos pasajeros no pueden pedir el mismo taxi a la vez.
    const conductor = await client.query(
      `UPDATE conductores c SET disponible = FALSE
       FROM usuarios u
       WHERE c.id = $1 AND u.id = c.usuario_id
         AND c.disponible = TRUE AND u.estado = 'activo'
         AND c.estado_doc = 'aprobado' AND c.suscripcion_vence >= CURRENT_DATE
       RETURNING c.lat_actual, c.lng_actual`,
      [conductor_id]
    )
    if (conductor.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'El conductor ya no está disponible' })
    }

    const viaje = await client.query(
      `INSERT INTO viajes (
        conductor_id, pasajero_id, estado,
        lat_origen, lng_origen, direccion_origen,
        lat_destino, lng_destino, direccion_destino,
        lat_conductor_acepto, lng_conductor_acepto,
        distancia_km, duracion_min, tarifa_estimada
       ) VALUES ($1, $2, 'solicitado', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        conductor_id, pasajero_id,
        latO, lngO, direccion_origen || null,
        latD, lngD, direccion_destino || null,
        conductor.rows[0].lat_actual, conductor.rows[0].lng_actual,
        cot?.distancia_km ?? null, cot?.duracion_min ?? null, cot?.tarifa ?? null
      ]
    )
    const viaje_id = viaje.rows[0].id

    // Garantía S/ 1.50 "retenida" hasta que el viaje termine o se cancele
    await client.query(
      `INSERT INTO pagos_viaje (viaje_id, monto_total, metodo_pago, tipo, estado, referencia_pago)
       VALUES ($1, $4, $2, 'garantia', 'retenido', $3)`,
      [viaje_id, metodo_pago, ref, ajustes.garantia_viaje]
    )

    await client.query('COMMIT')

    res.status(201).json({
      mensaje: 'Taxi solicitado. Esperando confirmación del conductor.',
      viaje_id,
      estado: 'solicitado',
      tarifa_estimada: cot?.tarifa ?? null
    })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('Error solicitarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  } finally {
    if (client) client.release()
  }
}

// GET /api/viajes/mi-viaje
// Viaje en curso del pasajero (con los datos del conductor) y, si acaba de
// terminar uno sin calificar, ese viaje para pedir la calificación.
const SELECT_VIAJE_PASAJERO = `
  SELECT v.id, v.estado, v.direccion_origen, v.direccion_destino,
         v.lat_origen, v.lng_origen, v.lat_destino, v.lng_destino,
         v.solicitado_en, v.aceptado_en, v.completado_en, v.cancelacion_motivo,
         v.distancia_km, v.duracion_min, v.tarifa_estimada, v.token_compartir,
         GREATEST(0, EXTRACT(EPOCH FROM (v.solicitado_en + make_interval(mins => ${SOLICITUD_TIMEOUT_MIN}) - NOW())))::int AS segundos_restantes,
         u.nombre AS conductor_nombre,
         CASE WHEN v.estado <> 'solicitado' THEN u.celular END AS conductor_celular,
         c.placa, c.vehiculo_marca, c.vehiculo_modelo, c.vehiculo_color, c.vehiculo_anno,
         c.calificacion_prom, c.total_viajes, c.lat_actual, c.lng_actual,
         pv.metodo_pago, pv.estado AS pago_estado, pv.monto_total, pv.referencia_pago
  FROM viajes v
  JOIN pasajeros p    ON p.id = v.pasajero_id
  JOIN conductores c  ON c.id = v.conductor_id
  JOIN usuarios u     ON u.id = c.usuario_id
  LEFT JOIN pagos_viaje pv ON pv.viaje_id = v.id
  WHERE p.usuario_id = $1`

const miViaje = async (req, res) => {
  try {
    await expirarSolicitudes()
    const activo = await query(
      `${SELECT_VIAJE_PASAJERO} AND v.estado = ANY($2)
       ORDER BY v.solicitado_en DESC LIMIT 1`,
      [req.usuario.id, ESTADOS_ACTIVOS]
    )
    const porCalificar = await query(
      `${SELECT_VIAJE_PASAJERO} AND v.estado = 'completado'
         AND NOT EXISTS (SELECT 1 FROM calificaciones k WHERE k.viaje_id = v.id)
         AND v.completado_en > NOW() - INTERVAL '1 day'
       ORDER BY v.completado_en DESC LIMIT 1`,
      [req.usuario.id]
    )
    res.json({ activo: activo.rows[0] || null, por_calificar: porCalificar.rows[0] || null })
  } catch (error) {
    console.error('Error miViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/viajes/mis-viajes — últimos 20 viajes del pasajero
const misViajes = async (req, res) => {
  try {
    const r = await query(
      `${SELECT_VIAJE_PASAJERO} ORDER BY v.solicitado_en DESC LIMIT 20`,
      [req.usuario.id]
    )
    res.json(r.rows)
  } catch (error) {
    console.error('Error misViajes:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/viajes/:id/aceptar
// El conductor acepta el viaje
const aceptarViaje = async (req, res) => {
  try {
    const { id } = req.params
    await expirarSolicitudes()

    const conductor = await query(
      'SELECT id FROM conductores WHERE usuario_id = $1',
      [req.usuario.id]
    )

    const aceptado = await query(
      `UPDATE viajes SET estado = 'aceptado', aceptado_en = NOW()
       WHERE id = $1 AND conductor_id = $2 AND estado = 'solicitado'`,
      [id, conductor.rows[0].id]
    )

    if (aceptado.rowCount === 0) {
      return res.status(409).json({ error: 'Este viaje ya no está disponible para aceptar' })
    }

    res.json({ mensaje: 'Viaje aceptado. Ve al punto de recojo.', estado: 'aceptado' })
  } catch (error) {
    console.error('Error aceptarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/viajes/:id/completar
// El conductor marca el viaje como completado
const completarViaje = async (req, res) => {
  try {
    const { id } = req.params

    const conductor = await query(
      'SELECT id FROM conductores WHERE usuario_id = $1',
      [req.usuario.id]
    )

    // Solo se completa un viaje en curso: antes se podía "completar" uno
    // cancelado y liberar igual la garantía a la plataforma.
    const completado = await query(
      `UPDATE viajes SET estado = 'completado', completado_en = NOW()
       WHERE id = $1 AND conductor_id = $2 AND estado IN ('aceptado','en_camino','recogido')`,
      [id, conductor.rows[0].id]
    )

    if (completado.rowCount === 0) {
      return res.status(409).json({ error: 'Este viaje no está en curso' })
    }

    // Liberar la garantía a la plataforma
    const ajustesC = await leerAjustes()
    await query(
      `UPDATE pagos_viaje SET
        estado = 'liberado_plataforma',
        monto_plataforma = $2,
        actualizado_en = NOW()
       WHERE viaje_id = $1`,
      [id, ajustesC.garantia_viaje]
    )

    // El conductor vuelve a estar disponible y suma un viaje realizado
    await query(
      'UPDATE conductores SET disponible = TRUE, total_viajes = total_viajes + 1 WHERE id = $1',
      [conductor.rows[0].id]
    )

    res.json({ mensaje: '✅ Viaje completado', estado: 'completado' })
  } catch (error) {
    console.error('Error completarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/viajes/:id/cancelar
// El pasajero cancela el viaje — aplica política de retención
const cancelarViaje = async (req, res) => {
  try {
    const { id } = req.params
    const { motivo } = req.body

    // Solo el pasajero dueño del viaje puede cancelarlo (antes cualquier
    // pasajero con el id podía cancelar viajes ajenos)
    const viaje = await query(
      `SELECT v.*, pv.id as pago_id
       FROM viajes v
       JOIN pasajeros p ON p.id = v.pasajero_id
       LEFT JOIN pagos_viaje pv ON pv.viaje_id = v.id
       WHERE v.id = $1 AND p.usuario_id = $2`,
      [id, req.usuario.id]
    )

    if (viaje.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' })
    }

    const v = viaje.rows[0]

    if (!['solicitado', 'aceptado', 'en_camino'].includes(v.estado)) {
      return res.status(409).json({ error: 'Este viaje ya no se puede cancelar' })
    }
    const fueDepachado = ['aceptado', 'en_camino'].includes(v.estado)

    // Actualizar estado del viaje
    await query(
      `UPDATE viajes SET
        estado = 'cancelado_pasajero',
        cancelado_en = NOW(),
        cancelacion_motivo = $1,
        conductor_fue_despachado = $2
       WHERE id = $3`,
      [motivo, fueDepachado, id]
    )

    let respuesta = {}

    if (fueDepachado) {
      // Conductor ya fue despachado — retener S/ 1.50
      // S/ 1.00 para el conductor, S/ 0.50 para la plataforma
      const ajustesX = await leerAjustes()
      await query(
        `UPDATE pagos_viaje SET
          estado = 'compensado_conductor',
          monto_conductor = $2,
          monto_plataforma = $3,
          actualizado_en = NOW()
         WHERE viaje_id = $1`,
        [id, ajustesX.compensacion_conductor, ajustesX.compensacion_plataforma]
      )

      // Incrementar contador de cancelaciones del pasajero
      await query(
        `UPDATE pasajeros SET cancelaciones_mes = cancelaciones_mes + 1
         WHERE usuario_id = $1`,
        [req.usuario.id]
      )

      // Verificar si supera el límite de 3 cancelaciones
      const pasajero = await query(
        'SELECT cancelaciones_mes FROM pasajeros WHERE usuario_id = $1',
        [req.usuario.id]
      )

      if (pasajero.rows[0].cancelaciones_mes >= 3) {
        await query(
          "UPDATE usuarios SET estado = 'suspendido' WHERE id = $1",
          [req.usuario.id]
        )
        respuesta.advertencia = 'Tu cuenta ha sido suspendida por exceder el límite de cancelaciones.'
      }

      respuesta.mensaje = `Viaje cancelado. El conductor ya estaba en camino, se retuvo la garantía de S/ ${ajustesX.garantia_viaje.toFixed(2)}.`
      respuesta.reembolso = false
      respuesta.compensacion_conductor = ajustesX.compensacion_conductor

      // Devolver disponibilidad al conductor
      await query(
        'UPDATE conductores SET disponible = TRUE WHERE id = $1',
        [v.conductor_id]
      )
    } else {
      // Conductor no fue despachado — devolver S/ 1.50
      await query(
        `UPDATE pagos_viaje SET estado = 'devuelto', actualizado_en = NOW()
         WHERE viaje_id = $1`,
        [id]
      )
      respuesta.mensaje = 'Viaje cancelado. Tu garantía será devuelta.'
      respuesta.reembolso = true

      // El conductor había sido reservado al solicitar: queda libre otra vez
      if (v.conductor_id) {
        await query('UPDATE conductores SET disponible = TRUE WHERE id = $1', [v.conductor_id])
      }
    }

    res.json(respuesta)
  } catch (error) {
    console.error('Error cancelarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/viajes/:id/calificar
// El pasajero califica al conductor al finalizar
const calificarViaje = async (req, res) => {
  try {
    const { id } = req.params
    const { estrellas, comentario } = req.body

    if (!Number.isInteger(Number(estrellas)) || estrellas < 1 || estrellas > 5) {
      return res.status(400).json({ error: 'Calificación debe ser entre 1 y 5 estrellas' })
    }

    const viaje = await query(
      `SELECT v.conductor_id, v.pasajero_id, v.estado
       FROM viajes v
       JOIN pasajeros p ON p.id = v.pasajero_id
       WHERE v.id = $1 AND p.usuario_id = $2`,
      [id, req.usuario.id]
    )

    if (viaje.rows.length === 0) {
      return res.status(404).json({ error: 'Viaje no encontrado' })
    }

    if (viaje.rows[0].estado !== 'completado') {
      return res.status(400).json({ error: 'Solo puedes calificar viajes completados' })
    }

    await query(
      `INSERT INTO calificaciones (viaje_id, conductor_id, pasajero_id, estrellas, comentario)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, viaje.rows[0].conductor_id, viaje.rows[0].pasajero_id, estrellas, comentario]
    )

    res.json({ mensaje: '⭐ Calificación registrada. ¡Gracias por tu opinión!' })
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ya calificaste este viaje' })
    }
    console.error('Error calificarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/conductores/viaje-activo
// Solicitud entrante o viaje en curso del conductor, con los datos del pasajero
const viajeActivoConductor = async (req, res) => {
  try {
    await expirarSolicitudes()
    const r = await query(
      `SELECT v.id, v.estado, v.direccion_origen, v.direccion_destino,
              v.lat_origen, v.lng_origen, v.lat_destino, v.lng_destino, v.solicitado_en,
              v.distancia_km, v.duracion_min, v.tarifa_estimada,
              GREATEST(0, EXTRACT(EPOCH FROM (v.solicitado_en + make_interval(mins => ${SOLICITUD_TIMEOUT_MIN}) - NOW())))::int AS segundos_restantes,
              up.nombre AS pasajero_nombre,
              CASE WHEN v.estado <> 'solicitado' THEN up.celular END AS pasajero_celular,
              pv.metodo_pago, pv.estado AS pago_estado, pv.monto_total, pv.referencia_pago
       FROM viajes v
       JOIN conductores c ON c.id = v.conductor_id
       JOIN pasajeros p   ON p.id = v.pasajero_id
       JOIN usuarios up   ON up.id = p.usuario_id
       LEFT JOIN pagos_viaje pv ON pv.viaje_id = v.id
       WHERE c.usuario_id = $1 AND v.estado = ANY($2)
       ORDER BY v.solicitado_en DESC LIMIT 1`,
      [req.usuario.id, ESTADOS_ACTIVOS]
    )
    res.json({ viaje: r.rows[0] || null })
  } catch (error) {
    console.error('Error viajeActivoConductor:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/viajes/:id/rechazar
// El conductor rechaza la solicitud (o cancela antes de recoger): se devuelve
// la garantía completa al pasajero y el conductor queda libre.
const rechazarViaje = async (req, res) => {
  try {
    const { id } = req.params
    const conductor = await query('SELECT id FROM conductores WHERE usuario_id = $1', [req.usuario.id])
    if (conductor.rows.length === 0) return res.status(404).json({ error: 'Perfil de conductor no encontrado' })

    const r = await query(
      `UPDATE viajes SET estado = 'cancelado_conductor', cancelado_en = NOW(),
              cancelacion_motivo = $3, actualizado_en = NOW(),
              conductor_fue_despachado = (estado <> 'solicitado')
       WHERE id = $1 AND conductor_id = $2 AND estado IN ('solicitado','aceptado','en_camino')
       RETURNING id`,
      [id, conductor.rows[0].id, req.body?.motivo || 'Rechazado por el conductor']
    )
    if (r.rowCount === 0) {
      return res.status(409).json({ error: 'Este viaje ya no se puede rechazar' })
    }

    await query(
      "UPDATE pagos_viaje SET estado = 'devuelto', actualizado_en = NOW() WHERE viaje_id = $1",
      [id]
    )
    await query('UPDATE conductores SET disponible = TRUE WHERE id = $1', [conductor.rows[0].id])

    res.json({ mensaje: 'Solicitud rechazada. Se devolvió la garantía al pasajero.', estado: 'cancelado_conductor' })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Viaje no encontrado' })
    console.error('Error rechazarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/viajes/:id/iniciar
// El conductor recogió al pasajero: el viaje pasa a "en curso"
const iniciarViaje = async (req, res) => {
  try {
    const { id } = req.params
    const conductor = await query('SELECT id FROM conductores WHERE usuario_id = $1', [req.usuario.id])
    if (conductor.rows.length === 0) return res.status(404).json({ error: 'Perfil de conductor no encontrado' })

    const r = await query(
      `UPDATE viajes SET estado = 'recogido', recogido_en = NOW(), actualizado_en = NOW()
       WHERE id = $1 AND conductor_id = $2 AND estado IN ('aceptado','en_camino')`,
      [id, conductor.rows[0].id]
    )
    if (r.rowCount === 0) {
      return res.status(409).json({ error: 'Este viaje no está esperando al pasajero' })
    }
    res.json({ mensaje: 'Viaje iniciado. ¡Buen camino!', estado: 'recogido' })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Viaje no encontrado' })
    console.error('Error iniciarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = {
  expirarSolicitudes,
  viajeActivoConductor,
  rechazarViaje,
  iniciarViaje,
  conductoresDisponibles,
  solicitarViaje,
  miViaje,
  misViajes,
  aceptarViaje,
  completarViaje,
  cancelarViaje,
  calificarViaje
}
