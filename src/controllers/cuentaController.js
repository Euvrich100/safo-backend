const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { query } = require('../config/database')

const CLAVE_MIN = 6
const CLAVE_MAX = 72 // bcrypt solo usa los primeros 72 bytes

const soloDigitos = (v) => String(v || '').replace(/\D/g, '')
const claveValida = (c) => typeof c === 'string' && c.length >= CLAVE_MIN && c.length <= CLAVE_MAX
const hashClave = (clave) => bcrypt.hash(clave, 10)

// Anti fuerza bruta: 5 intentos fallidos por celular → bloqueo de 15 minutos.
const MAX_FALLOS = 5
const BLOQUEO_MS = 15 * 60 * 1000
const fallos = new Map() // celular -> { n, hasta }
const bloqueado = (celular) => {
  const f = fallos.get(celular)
  if (!f) return false
  if (f.hasta && f.hasta > Date.now()) return true
  if (f.hasta) fallos.delete(celular) // el bloqueo ya venció
  return false
}
const registrarFallo = (celular) => {
  const f = fallos.get(celular) || { n: 0, hasta: 0 }
  f.n += 1
  if (f.n >= MAX_FALLOS) f.hasta = Date.now() + BLOQUEO_MS
  fallos.set(celular, f)
}

// Hash falso para igualar el tiempo de respuesta cuando el celular no existe
const HASH_FALSO = bcrypt.hashSync('safo-no-existe', 10)

// POST /api/auth/login  { celular, password }
const login = async (req, res) => {
  try {
    const celular = soloDigitos(req.body.celular)
    const password = req.body.password

    if (celular.length !== 9 || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Ingresa tu celular de 9 dígitos y tu contraseña' })
    }
    if (bloqueado(celular)) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos o ingresa con código.' })
    }

    const r = await query(
      'SELECT id, nombre, celular, rol, estado, password_hash FROM usuarios WHERE celular = $1',
      [celular]
    )
    const usuario = r.rows[0]

    if (usuario && !usuario.password_hash) {
      return res.status(401).json({
        codigo: 'SIN_CLAVE',
        error: 'Tu cuenta aún no tiene contraseña. Pide al administrador que te la restablezca.'
      })
    }

    const ok = await bcrypt.compare(password.slice(0, CLAVE_MAX), usuario ? usuario.password_hash : HASH_FALSO)
    if (!usuario || !ok) {
      registrarFallo(celular)
      return res.status(401).json({ error: 'Celular o contraseña incorrectos' })
    }
    fallos.delete(celular)

    if (usuario.estado === 'suspendido') {
      return res.status(403).json({ error: 'Cuenta suspendida. Contacta al administrador.' })
    }

    // Un conductor solo entra cuando el administrador aprobó su solicitud
    if (usuario.rol === 'conductor') {
      const doc = await query(
        'SELECT estado_doc, rechazo_motivo FROM conductores WHERE usuario_id = $1',
        [usuario.id]
      )
      const d = doc.rows[0]
      if (!d || d.estado_doc === 'pendiente') {
        return res.status(403).json({ error: 'Tu solicitud está en revisión. Te avisaremos cuando sea aprobada.' })
      }
      if (d.estado_doc === 'rechazado') {
        return res.status(403).json({ error: `Tu solicitud fue rechazada${d.rechazo_motivo ? ': ' + d.rechazo_motivo : ''}. Contacta al administrador.` })
      }
    }

    const token = jwt.sign(
      { id: usuario.id, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )
    res.json({
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, celular: usuario.celular, rol: usuario.rol }
    })
  } catch (error) {
    console.error('Error login:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/cuenta/clave  { actual, nueva }
const cambiarClave = async (req, res) => {
  try {
    const { actual, nueva } = req.body
    if (!claveValida(nueva)) {
      return res.status(400).json({ error: `La nueva contraseña debe tener entre ${CLAVE_MIN} y ${CLAVE_MAX} caracteres` })
    }

    const r = await query('SELECT password_hash FROM usuarios WHERE id = $1', [req.usuario.id])
    const hash = r.rows[0]?.password_hash
    if (hash) {
      if (typeof actual !== 'string' || !(await bcrypt.compare(actual.slice(0, CLAVE_MAX), hash))) {
        return res.status(401).json({ error: 'Tu contraseña actual no es correcta' })
      }
    }

    await query(
      'UPDATE usuarios SET password_hash = $1, password_cambiada_en = NOW(), actualizado_en = NOW() WHERE id = $2',
      [await hashClave(nueva), req.usuario.id]
    )
    res.json({ mensaje: 'Contraseña actualizada' })
  } catch (error) {
    console.error('Error cambiarClave:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/cuenta/perfil  { nombre }
const actualizarPerfilCuenta = async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim().replace(/\s+/g, ' ')
    if (nombre.length < 2 || nombre.length > 100) {
      return res.status(400).json({ error: 'Escribe tu nombre (entre 2 y 100 letras)' })
    }
    const r = await query(
      `UPDATE usuarios SET nombre = $1, actualizado_en = NOW() WHERE id = $2
       RETURNING id, nombre, celular, rol`,
      [nombre, req.usuario.id]
    )
    res.json({ usuario: r.rows[0] })
  } catch (error) {
    console.error('Error actualizarPerfilCuenta:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/admin/usuarios/:id/restablecer-clave
// Genera una contraseña temporal para que el administrador se la dé al usuario
// (la flota todavía no tiene SMS para recuperar la contraseña sola).
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // sin 0/O/1/I/L para no confundir
const claveTemporal = () => Array.from({ length: 8 }, () => ALFABETO[crypto.randomInt(ALFABETO.length)]).join('')

const restablecerClave = async (req, res) => {
  try {
    const temporal = claveTemporal()
    const r = await query(
      `UPDATE usuarios SET password_hash = $1, password_cambiada_en = NOW(), actualizado_en = NOW()
       WHERE id = $2 AND rol <> 'admin' RETURNING celular, nombre`,
      [await hashClave(temporal), req.params.id]
    )
    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado o es administrador' })
    }
    fallos.delete(r.rows[0].celular)
    res.json({ clave_temporal: temporal, celular: r.rows[0].celular, nombre: r.rows[0].nombre })
  } catch (error) {
    if (error.code === '22P02') return res.status(404).json({ error: 'Usuario no encontrado' })
    console.error('Error restablecerClave:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { login, cambiarClave, actualizarPerfilCuenta, restablecerClave, hashClave, claveValida, CLAVE_MIN, CLAVE_MAX }
