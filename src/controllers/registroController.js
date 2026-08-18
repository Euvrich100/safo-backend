const { query } = require('../config/database')
const path = require('path')

// POST /api/auth/registrar-conductor
const registrarConductor = async (req, res) => {
  try {
    const {
      nombre, celular, dni, fecha_nacimiento,
      direccion, licencia_numero, licencia_categoria,
      placa, vehiculo_marca, vehiculo_modelo,
      vehiculo_color, vehiculo_anno
    } = req.body

    if (!nombre || !celular || !dni || !licencia_numero || !placa) {
      return res.status(400).json({ error: 'Completa todos los campos obligatorios' })
    }

    // Verificar celular único
    const existe = await query('SELECT id FROM usuarios WHERE celular = $1', [celular])
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Este número de celular ya está registrado' })
    }

    // Obtener URLs de archivos subidos
    const files = req.files || {}
    const foto_dni_frontal = files.foto_dni_frontal?.[0]?.filename || null
    const foto_dni_trasera = files.foto_dni_trasera?.[0]?.filename || null
    const foto_licencia = files.foto_licencia?.[0]?.filename || null
    const foto_vehiculo = files.foto_vehiculo?.[0]?.filename || null
    const foto_perfil = files.foto_perfil?.[0]?.filename || null

    // Crear usuario
    const nuevoUsuario = await query(
      `INSERT INTO usuarios (nombre, celular, rol, estado)
       VALUES ($1, $2, 'conductor', 'activo') RETURNING id`,
      [nombre, celular]
    )

    const usuario_id = nuevoUsuario.rows[0].id

    // Crear perfil conductor
    await query(
      `INSERT INTO conductores (
        usuario_id, dni, licencia_numero, placa,
        vehiculo_marca, vehiculo_modelo, vehiculo_color, vehiculo_anno,
        licencia_foto_url, vehiculo_foto_url, estado_doc
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendiente')`,
      [
        usuario_id, dni, licencia_numero, placa,
        vehiculo_marca, vehiculo_modelo, vehiculo_color, vehiculo_anno,
        foto_licencia, foto_vehiculo
      ]
    )

    res.status(201).json({
      mensaje: '¡Registro exitoso! El administrador revisará tu solicitud en menos de 24 horas.',
      estado: 'pendiente'
    })
  } catch (error) {
    console.error('Error registrarConductor:', error)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El DNI o placa ya está registrado' })
    }
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/auth/registrar-pasajero
const registrarPasajero = async (req, res) => {
  try {
    const { nombre, celular, dni } = req.body

    if (!nombre || !celular) {
      return res.status(400).json({ error: 'Nombre y celular son obligatorios' })
    }

    const existe = await query('SELECT id FROM usuarios WHERE celular = $1', [celular])
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Este número ya está registrado' })
    }

    const nuevoUsuario = await query(
      `INSERT INTO usuarios (nombre, celular, rol, estado)
       VALUES ($1, $2, 'pasajero', 'activo') RETURNING id`,
      [nombre, celular]
    )

    await query(
      'INSERT INTO pasajeros (usuario_id) VALUES ($1)',
      [nuevoUsuario.rows[0].id]
    )

    res.status(201).json({
      mensaje: '¡Registro exitoso! Ya puedes pedir tu taxi seguro.',
      estado: 'activo'
    })
  } catch (error) {
    console.error('Error registrarPasajero:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { registrarConductor, registrarPasajero }