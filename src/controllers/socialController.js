const jwt = require('jsonwebtoken')
const { query, pool } = require('../config/database')
const { PROVEEDORES, proveedoresActivos, verificar } = require('../services/social')

const COLUMNA = { google: 'google_id', apple: 'apple_id', facebook: 'facebook_id' }
const NOMBRE = { google: 'Google', apple: 'Apple', facebook: 'Facebook' }

const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN })
const publico = (u) => ({ id: u.id, nombre: u.nombre, celular: u.celular, rol: u.rol })

// GET /api/auth/social/proveedores — qué métodos de acceso están activos
const proveedores = (req, res) => res.json(proveedoresActivos())

// Valida proveedor + credencial y devuelve la identidad verificada
const identidad = async (req, res) => {
  const { proveedor, credential, nombre } = req.body || {}
  if (!PROVEEDORES.includes(proveedor)) { res.status(400).json({ error: 'Método de acceso no válido' }); return null }
  if (!proveedoresActivos()[proveedor]) {
    res.status(503).json({ error: `El acceso con ${NOMBRE[proveedor]} aún no está activado. Usa tu celular.`, codigo: 'PROVEEDOR_NO_CONFIGURADO' })
    return null
  }
  const id = await verificar(proveedor, credential, nombre)
  if (!id) { res.status(401).json({ error: `No pudimos verificar tu cuenta de ${NOMBRE[proveedor]}. Inténtalo de nuevo.` }); return null }
  return { proveedor, ...id }
}

const buscarUsuario = async (proveedor, id, email) => {
  const col = COLUMNA[proveedor]
  const r = await query(
    `SELECT id, nombre, celular, rol, estado, ${col} AS vinculo FROM usuarios WHERE ${col} = $1 OR ($2::text IS NOT NULL AND email = $2) ORDER BY (${col} = $1) DESC NULLS LAST LIMIT 1`,
    [id, email]
  )
  return r.rows[0] || null
}

// POST /api/auth/social { proveedor, credential, nombre? }
// Si la cuenta ya existe (por id del proveedor o por correo verificado) inicia
// sesión; si no, responde nuevo:true para pedir el celular y crear la cuenta.
const loginSocial = async (req, res) => {
  try {
    const quien = await identidad(req, res)
    if (!quien) return
    const u = await buscarUsuario(quien.proveedor, quien.id, quien.email)
    if (!u) return res.json({ nuevo: true, proveedor: quien.proveedor, nombre: quien.nombre, email: quien.email })
    if (u.estado === 'suspendido') return res.status(403).json({ error: 'Cuenta suspendida. Contacta al administrador.' })
    if (u.rol === 'conductor' && u.estado === 'inactivo') {
      return res.status(403).json({ error: 'Tu registro como conductor aún está en revisión.' })
    }
    // Un administrador no se vincula solo por coincidir el correo de Facebook
    if (!u.vinculo && u.rol === 'admin' && quien.proveedor === 'facebook') {
      return res.status(403).json({ error: 'Los administradores entran con Google o con su celular.' })
    }
    // Primera vez con este proveedor: se vincula a la cuenta existente
    if (!u.vinculo) {
      try { await query(`UPDATE usuarios SET ${COLUMNA[quien.proveedor]} = $1 WHERE id = $2`, [quien.id, u.id]) } catch (e) { if (e.code !== '23505') throw e }
    }
    res.json({ token: firmar(u), usuario: publico(u) })
  } catch (error) {
    console.error('Error loginSocial:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/auth/social/completar { proveedor, credential, celular, nombre? }
// Crea la cuenta de pasajero con la identidad ya verificada + su celular.
const completarSocial = async (req, res) => {
  try {
    const celular = String(req.body?.celular || '').replace(/\D/g, '')
    if (celular.length !== 9) return res.status(400).json({ error: 'El celular debe tener 9 dígitos' })
    const quien = await identidad(req, res)
    if (!quien) return

    if (await buscarUsuario(quien.proveedor, quien.id, quien.email)) {
      return res.status(409).json({ error: `Esta cuenta de ${NOMBRE[quien.proveedor]} ya está registrada. Inicia sesión.` })
    }
    if ((await query('SELECT 1 FROM usuarios WHERE celular = $1', [celular])).rows.length > 0) {
      return res.status(409).json({ error: 'Ese número de celular ya está registrado. Inicia sesión con tu celular.' })
    }

    const nombre = (quien.nombre || String(req.body?.nombre_manual || '')).trim().slice(0, 100) || 'Pasajero SafO'
    const client = await pool.connect()
    let usuario
    try {
      await client.query('BEGIN')
      const r = await client.query(
        `INSERT INTO usuarios (nombre, celular, rol, estado, email, ${COLUMNA[quien.proveedor]})
         VALUES ($1, $2, 'pasajero', 'activo', $3, $4) RETURNING id, nombre, celular, rol`,
        [nombre, celular, quien.email, quien.id]
      )
      usuario = r.rows[0]
      await client.query('INSERT INTO pasajeros (usuario_id) VALUES ($1)', [usuario.id])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    res.status(201).json({ token: firmar(usuario), usuario: publico(usuario) })
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Esa cuenta o ese celular ya están registrados. Inicia sesión.' })
    console.error('Error completarSocial:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { proveedores, loginSocial, completarSocial }
