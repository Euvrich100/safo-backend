const { query } = require('../config/database')

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
                c.vehiculo_color, c.calificacion_prom, c.total_viajes,
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
// El pasajero solicita un taxi (ya pagó S/ 1.50 previamente)
const solicitarViaje = async (req, res) => {
  try {
    const {
      conductor_id,
      lat_origen, lng_origen, direccion_origen,
      lat_destino, lng_destino, direccion_destino,
      referencia_pago, metodo_pago
    } = req.body

    // Obtener perfil del pasajero
    const pasajero = await query(
      'SELECT id FROM pasajeros WHERE usuario_id = $1',
      [req.usuario.id]
    )

    if (pasajero.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil de pasajero no encontrado' })
    }

    const pasajero_id = pasajero.rows[0].id

    // Reservar al conductor de forma atómica: el UPDATE solo prospera si sigue
    // disponible, así dos pasajeros no pueden pedir el mismo taxi a la vez.
    const conductor = await query(
      `UPDATE conductores c SET disponible = FALSE
       FROM usuarios u
       WHERE c.id = $1 AND u.id = c.usuario_id
         AND c.disponible = TRUE AND u.estado = 'activo'
         AND c.estado_doc = 'aprobado' AND c.suscripcion_vence >= CURRENT_DATE
       RETURNING c.lat_actual, c.lng_actual`,
      [conductor_id]
    )

    if (conductor.rows.length === 0) {
      return res.status(409).json({ error: 'El conductor ya no está disponible' })
    }

    // Crear el viaje
    const viaje = await query(
      `INSERT INTO viajes (
        conductor_id, pasajero_id, estado,
        lat_origen, lng_origen, direccion_origen,
        lat_destino, lng_destino, direccion_destino,
        lat_conductor_acepto, lng_conductor_acepto
       ) VALUES ($1, $2, 'solicitado', $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        conductor_id, pasajero_id,
        lat_origen, lng_origen, direccion_origen,
        lat_destino, lng_destino, direccion_destino,
        conductor.rows[0].lat_actual, conductor.rows[0].lng_actual
      ]
    )

    const viaje_id = viaje.rows[0].id

    // Registrar el pago de garantía S/ 1.50 como "retenido"
    await query(
      `INSERT INTO pagos_viaje (viaje_id, monto_total, metodo_pago, tipo, estado, referencia_pago)
       VALUES ($1, 1.50, $2, 'garantia', 'retenido', $3)`,
      [viaje_id, metodo_pago, referencia_pago]
    )

    res.status(201).json({
      mensaje: 'Taxi solicitado. Esperando confirmación del conductor.',
      viaje_id,
      estado: 'solicitado'
    })
  } catch (error) {
    console.error('Error solicitarViaje:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/viajes/:id/aceptar
// El conductor acepta el viaje
const aceptarViaje = async (req, res) => {
  try {
    const { id } = req.params

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

    // Liberar el S/ 1.50 a la plataforma
    await query(
      `UPDATE pagos_viaje SET
        estado = 'liberado_plataforma',
        monto_plataforma = 1.50,
        actualizado_en = NOW()
       WHERE viaje_id = $1`,
      [id]
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
      await query(
        `UPDATE pagos_viaje SET
          estado = 'compensado_conductor',
          monto_conductor = 1.00,
          monto_plataforma = 0.50,
          actualizado_en = NOW()
         WHERE viaje_id = $1`,
        [id]
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

      respuesta.mensaje = 'Viaje cancelado. El conductor ya estaba en camino, se retuvo el pago de S/ 1.50.'
      respuesta.reembolso = false
      respuesta.compensacion_conductor = 1.00

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
      respuesta.mensaje = 'Viaje cancelado. El S/ 1.50 será devuelto.'
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

module.exports = {
  conductoresDisponibles,
  solicitarViaje,
  aceptarViaje,
  completarViaje,
  cancelarViaje,
  calificarViaje
}
