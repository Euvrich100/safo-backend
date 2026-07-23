const jwt = require('jsonwebtoken')
const { query } = require('../config/database')

// Verifica que el token JWT sea válido
// Uso: router.get('/ruta', verificarToken, controlador)
const verificarToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1] // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: 'Token requerido' })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    // Verificar que el usuario sigue activo en la BD
    const resultado = await query(
      'SELECT id, nombre, celular, rol, estado FROM usuarios WHERE id = $1',
      [decoded.id]
    )

    if (resultado.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' })
    }

    const usuario = resultado.rows[0]

    if (usuario.estado === 'suspendido') {
      return res.status(403).json({ error: 'Cuenta suspendida. Contacta al administrador.' })
    }

    req.usuario = usuario
    next()
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' })
    }
    return res.status(401).json({ error: 'Token inválido' })
  }
}

// Solo permite acceso a administradores
const soloAdmin = (req, res, next) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Acceso restringido a administradores' })
  }
  next()
}

// Solo permite acceso a conductores
const soloConductor = (req, res, next) => {
  if (req.usuario.rol !== 'conductor') {
    return res.status(403).json({ error: 'Acceso restringido a conductores' })
  }
  next()
}

// Solo permite acceso a pasajeros
const soloPasajero = (req, res, next) => {
  if (req.usuario.rol !== 'pasajero') {
    return res.status(403).json({ error: 'Acceso restringido a pasajeros' })
  }
  next()
}

module.exports = { verificarToken, soloAdmin, soloConductor, soloPasajero }
