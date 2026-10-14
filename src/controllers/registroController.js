const fs = require('fs')
const path = require('path')
const { query, pool } = require('../config/database')
const { UPLOADS_DIR } = require('../config/uploads')

// Borra los archivos que multer ya guardó cuando el registro se rechaza
// (validación o duplicado) para no dejar fotos huérfanas en disco.
const borrarSubidos = (files = {}) => {
  Object.values(files).flat().forEach(f => {
    fs.unlink(path.join(UPLOADS_DIR, f.filename), () => {})
  })
}

const soloDigitos = (v) => String(v || '').replace(/\D/g, '')

// POST /api/auth/registrar-conductor
// Registro público desde el portal web. La cuenta queda INACTIVA con los
// documentos en revisión hasta que un administrador la apruebe.
const registrarConductor = async (req, res) => {
  const files = req.files || {}
  const rechazar = (status, error) => {
    borrarSubidos(files)
    return res.status(status).json({ error })
  }

  try {
    const {
      nombre, licencia_numero, licencia_categoria, direccion,
      placa, vehiculo_marca, vehiculo_modelo, vehiculo_color
    } = req.body
    const celular = soloDigitos(req.body.celular)
    const dni = soloDigitos(req.body.dni)
    const vehiculo_anno = req.body.vehiculo_anno ? parseInt(req.body.vehiculo_anno, 10) : null
    const fecha_nacimiento = req.body.fecha_nacimiento || null

    if (!nombre || !celular || !dni || !licencia_numero || !placa) {
      return rechazar(400, 'Completa todos los campos obligatorios')
    }
    if (celular.length !== 9) return rechazar(400, 'El celular debe tener 9 dígitos')
    if (dni.length !== 8) return rechazar(400, 'El DNI debe tener 8 dígitos')
    if (vehiculo_anno !== null && (!Number.isInteger(vehiculo_anno) || vehiculo_anno < 1980 || vehiculo_anno > new Date().getFullYear() + 1)) {
      return rechazar(400, 'Año del vehículo inválido')
    }

    // Documentos mínimos para acreditar al conductor ante el pasajero
    const falta = ['foto_dni_frontal', 'foto_dni_trasera', 'foto_licencia', 'foto_vehiculo']
      .filter(campo => !files[campo]?.[0])
    if (falta.length > 0) {
      return rechazar(400, 'Sube las fotos del DNI (frontal y trasera), la licencia y el vehículo')
    }

    const placaNorm = String(placa).toUpperCase().replace(/\s+/g, '')

    const dup = await query(
      `SELECT
         EXISTS(SELECT 1 FROM usuarios WHERE celular = $1)                 AS celular,
         EXISTS(SELECT 1 FROM conductores WHERE dni = $2)                  AS dni,
         EXISTS(SELECT 1 FROM conductores WHERE UPPER(placa) = $3)         AS placa`,
      [celular, dni, placaNorm]
    )
    if (dup.rows[0].celular) return rechazar(409, 'Este número de celular ya está registrado')
    if (dup.rows[0].dni)     return rechazar(409, 'Este DNI ya tiene una solicitud registrada')
    if (dup.rows[0].placa)   return rechazar(409, 'Esta placa ya tiene una solicitud registrada')

    const nombreArchivo = (campo) => files[campo]?.[0]?.filename || null

    // Usuario + perfil de conductor en una transacción: o se crean los dos o ninguno
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const usuario = await client.query(
        `INSERT INTO usuarios (nombre, celular, rol, estado)
         VALUES ($1, $2, 'conductor', 'inactivo') RETURNING id`,
        [nombre.trim(), celular]
      )

      await client.query(
        `INSERT INTO conductores (
           usuario_id, dni, fecha_nacimiento, direccion,
           licencia_numero, licencia_categoria, placa,
           vehiculo_marca, vehiculo_modelo, vehiculo_color, vehiculo_anno,
           dni_foto_frontal_url, dni_foto_trasera_url,
           licencia_foto_url, vehiculo_foto_url, perfil_foto_url,
           estado_doc
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pendiente')`,
        [
          usuario.rows[0].id, dni, fecha_nacimiento, direccion || null,
          licencia_numero, licencia_categoria || null, placaNorm,
          vehiculo_marca || null, vehiculo_modelo || null, vehiculo_color || null, vehiculo_anno,
          nombreArchivo('foto_dni_frontal'), nombreArchivo('foto_dni_trasera'),
          nombreArchivo('foto_licencia'), nombreArchivo('foto_vehiculo'), nombreArchivo('foto_perfil')
        ]
      )

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    res.status(201).json({
      mensaje: '¡Registro exitoso! El administrador revisará tu solicitud en menos de 24 horas.',
      estado: 'pendiente'
    })
  } catch (error) {
    borrarSubidos(files)
    console.error('Error registrarConductor:', error)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El celular, DNI o placa ya está registrado' })
    }
    if (error.code === '22007' || error.code === '22008') {
      return res.status(400).json({ error: 'Fecha de nacimiento inválida' })
    }
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/auth/registrar-pasajero
const registrarPasajero = async (req, res) => {
  try {
    const { nombre } = req.body
    const celular = soloDigitos(req.body.celular)

    if (!nombre || !celular) {
      return res.status(400).json({ error: 'Nombre y celular son obligatorios' })
    }
    if (celular.length !== 9) {
      return res.status(400).json({ error: 'El celular debe tener 9 dígitos' })
    }

    const existe = await query('SELECT id FROM usuarios WHERE celular = $1', [celular])
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Este número ya está registrado' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const nuevoUsuario = await client.query(
        `INSERT INTO usuarios (nombre, celular, rol, estado)
         VALUES ($1, $2, 'pasajero', 'activo') RETURNING id`,
        [nombre.trim(), celular]
      )
      await client.query('INSERT INTO pasajeros (usuario_id) VALUES ($1)', [nuevoUsuario.rows[0].id])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    res.status(201).json({
      mensaje: '¡Registro exitoso! Ya puedes pedir tu taxi seguro.',
      estado: 'activo'
    })
  } catch (error) {
    console.error('Error registrarPasajero:', error)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Este número ya está registrado' })
    }
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { registrarConductor, registrarPasajero }
