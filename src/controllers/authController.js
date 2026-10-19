const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { OAuth2Client } = require('google-auth-library')
const { query } = require('../config/database')

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

// Genera un código OTP de 6 dígitos
const generarOTP = () => crypto.randomInt(100000, 1000000).toString()

// El código NO se guarda en claro: en la base queda su hash (atado al celular y al secreto del servidor)
const hashOTP = (celular, codigo) =>
  crypto.createHash('sha256').update(`${celular}:${codigo}:${process.env.JWT_SECRET}`).digest('hex')
const codigoCoincide = (guardado, celular, codigo) => {
  if (!guardado || typeof codigo !== 'string') return false
  const a = Buffer.from(guardado), b = Buffer.from(hashOTP(celular, codigo))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '')
const PRODUCCION = process.env.NODE_ENV === 'production'
const ESPERA_REENVIO_MS = 60 * 1000
const ultimoEnvio = new Map() // celular -> momento del último SMS (evita que alguien llene de SMS a una persona)
setInterval(() => {
  const limite = Date.now() - ESPERA_REENVIO_MS
  for (const [cel, t] of ultimoEnvio) if (t < limite) { ultimoEnvio.delete(cel); intentosOTP.delete(cel) }
}, 10 * 60 * 1000).unref()

// Límite de intentos de verificación por celular, para evitar fuerza bruta
// sobre el código de 6 dígitos. Se resetea al pedir un OTP nuevo.
const MAX_INTENTOS_OTP = 5
const intentosOTP = new Map() // celular -> intentos restantes

// ¿Está configurado el envío de SMS (Twilio)?
const smsConfigurado = () => {
  const sid = process.env.TWILIO_ACCOUNT_SID
  return Boolean(sid && sid !== 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER)
}

// Envía el código por SMS con Twilio.
// En DESARROLLO sin Twilio se imprime en la consola del servidor para poder probar.
// En PRODUCCIÓN el código jamás se escribe en los logs.
const enviarSMS = async (celular, codigo) => {
  if (smsConfigurado()) {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    await twilio.messages.create({
      body: `Tu código SafO es: ${codigo}. Válido por 5 minutos. No lo compartas con nadie.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+51${celular}`
    })
    return true
  }
  if (PRODUCCION) throw Object.assign(new Error('SMS no configurado'), { codigo: 'SMS_NO_CONFIGURADO' })
  console.log(`📱 [solo desarrollo] OTP para ${celular}: ${codigo}`)
  return true
}

// POST /api/auth/solicitar-otp
// El usuario ingresa su celular y recibe un SMS con el código
const solicitarOTP = async (req, res) => {
  try {
    const celular = soloDigitos(req.body?.celular)

    if (celular.length !== 9) {
      return res.status(400).json({ error: 'Ingresa tu celular de 9 dígitos' })
    }
    if (PRODUCCION && !smsConfigurado()) {
      return res.status(503).json({ error: 'El código por SMS no está disponible por ahora. Ingresa con tu contraseña.' })
    }
    const espera = (ultimoEnvio.get(celular) || 0) + ESPERA_REENVIO_MS - Date.now()
    if (espera > 0) {
      return res.status(429).json({ error: `Espera ${Math.ceil(espera / 1000)} segundos para pedir otro código.` })
    }

    // Buscar si el usuario ya existe
    const existe = await query('SELECT id FROM usuarios WHERE celular = $1', [celular])
    if (existe.rows.length === 0) {
      return res.status(404).json({
        error: 'Número no registrado. Descarga SafO y regístrate primero.'
      })
    }

    const codigo = generarOTP()
    const expira = new Date(Date.now() + 5 * 60 * 1000) // 5 minutos

    await query(
      'UPDATE usuarios SET otp_codigo = $1, otp_expira_en = $2 WHERE celular = $3',
      [hashOTP(celular, codigo), expira, celular]
    )

    await enviarSMS(celular, codigo)
    ultimoEnvio.set(celular, Date.now())
    intentosOTP.set(celular, MAX_INTENTOS_OTP)

    res.json({ mensaje: 'Código enviado al celular', expira_en: expira })
  } catch (error) {
    console.error('Error solicitarOTP:', error.codigo === 'SMS_NO_CONFIGURADO' ? error.message : error)
    res.status(500).json({ error: 'No pudimos enviar el código. Intenta de nuevo o ingresa con tu contraseña.' })
  }
}

// POST /api/auth/verificar-otp
// El usuario ingresa el código recibido y obtiene su JWT
const verificarOTP = async (req, res) => {
  try {
    const celular = soloDigitos(req.body?.celular)
    const codigo = typeof req.body?.codigo === 'string' ? req.body.codigo.trim() : ''
    if (celular.length !== 9 || !/^\d{6}$/.test(codigo)) {
      return res.status(400).json({ error: 'Ingresa tu celular y el código de 6 dígitos' })
    }

    const resultado = await query(
      `SELECT id, nombre, celular, rol, estado, otp_codigo, otp_expira_en
       FROM usuarios WHERE celular = $1`,
      [celular]
    )

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' })
    }

    const usuario = resultado.rows[0]

    // Verificar límite de intentos (evita fuerza bruta sobre el código de 6 dígitos)
    // (si el servidor se reinició, el contador vuelve al máximo: nunca queda sin límite)
    const intentosRestantes = intentosOTP.get(celular) ?? MAX_INTENTOS_OTP
    if (intentosRestantes <= 0) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Solicita un código nuevo.' })
    }

    // Verificar código
    if (!codigoCoincide(usuario.otp_codigo, celular, codigo)) {
      intentosOTP.set(celular, intentosRestantes - 1)
      return res.status(401).json({ error: 'Código incorrecto' })
    }

    // Verificar expiración
    if (new Date() > new Date(usuario.otp_expira_en)) {
      return res.status(401).json({ error: 'Código expirado. Solicita uno nuevo.' })
    }

    // Verificar estado
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

    // Limpiar OTP usado y resetear contador de intentos
    await query(
      'UPDATE usuarios SET otp_codigo = NULL, otp_expira_en = NULL WHERE id = $1',
      [usuario.id]
    )
    intentosOTP.delete(celular)

    // Generar JWT
    const token = jwt.sign(
      { id: usuario.id, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.json({
      token,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        celular: usuario.celular,
        rol: usuario.rol
      }
    })
  } catch (error) {
    console.error('Error verificarOTP:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/auth/registrar
// Registro de nuevo usuario (conductor o pasajero)
const registrar = async (req, res) => {
  try {
    const { nombre, celular, rol } = req.body

    if (!nombre || !celular || !rol) {
      return res.status(400).json({ error: 'Nombre, celular y rol son requeridos' })
    }

    if (!['conductor', 'pasajero'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' })
    }

    // Verificar celular único
    const existe = await query('SELECT id FROM usuarios WHERE celular = $1', [celular])
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Este número ya está registrado' })
    }

    // Crear usuario
    const nuevoUsuario = await query(
      `INSERT INTO usuarios (nombre, celular, rol)
       VALUES ($1, $2, $3) RETURNING id, nombre, celular, rol`,
      [nombre, celular, rol]
    )

    const usuario = nuevoUsuario.rows[0]

    // Si es conductor, crear perfil vacío pendiente
    if (rol === 'conductor') {
      await query(
        `INSERT INTO conductores (usuario_id, dni, licencia_numero, placa)
         VALUES ($1, '', '', '')`,
        [usuario.id]
      )
    }

    // Si es pasajero, crear perfil
    if (rol === 'pasajero') {
      await query(
        'INSERT INTO pasajeros (usuario_id) VALUES ($1)',
        [usuario.id]
      )
    }

    res.status(201).json({
      mensaje: 'Registro exitoso. Ya puedes iniciar sesión.',
      usuario
    })
  } catch (error) {
    console.error('Error registrar:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// Verifica un idToken de Google y devuelve su payload, o null si es inválido.
const verificarTokenGoogle = async (credential) => {
  if (!process.env.GOOGLE_CLIENT_ID || !credential) return null
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    const payload = ticket.getPayload()
    return payload?.email_verified ? payload : null
  } catch (err) {
    return null
  }
}

const firmarToken = (usuario) => jwt.sign(
  { id: usuario.id, rol: usuario.rol },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN }
)

// POST /api/auth/google
// Login con Google para administradores (ya deben existir, asignados por
// otro admin vía SQL — nadie se auto-otorga rol admin) y pasajeros.
// Si el correo no está registrado y viene de la app de pasajeros, no crea
// la cuenta todavía: responde `nuevo: true` para que el cliente pida el
// celular y complete el registro en /auth/google/completar-pasajero.
const loginGoogle = async (req, res) => {
  try {
    const { credential } = req.body
    if (!credential) {
      return res.status(400).json({ error: 'Falta el token de Google' })
    }

    const payload = await verificarTokenGoogle(credential)
    if (!payload) {
      return res.status(401).json({ error: 'Token de Google inválido o expirado' })
    }

    const resultado = await query(
      `SELECT id, nombre, celular, rol, estado, google_id
       FROM usuarios WHERE email = $1 OR google_id = $2`,
      [payload.email, payload.sub]
    )

    if (resultado.rows.length === 0) {
      return res.json({ nuevo: true, nombre: payload.name || '', email: payload.email })
    }

    const usuario = resultado.rows[0]

    if (usuario.rol !== 'admin' && usuario.rol !== 'pasajero') {
      return res.status(403).json({ error: 'Esta cuenta no puede entrar con Google. Usa tu celular para iniciar sesión.' })
    }

    if (usuario.estado === 'suspendido') {
      return res.status(403).json({ error: 'Cuenta suspendida. Contacta al administrador.' })
    }

    // Vincular el google_id la primera vez que inicia sesión así
    if (!usuario.google_id) {
      await query('UPDATE usuarios SET google_id = $1 WHERE id = $2', [payload.sub, usuario.id])
    }

    res.json({
      token: firmarToken(usuario),
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        celular: usuario.celular,
        rol: usuario.rol
      }
    })
  } catch (error) {
    console.error('Error loginGoogle:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/auth/google/completar-pasajero
// Segundo paso cuando /auth/google respondió `nuevo: true`: crea la cuenta
// de pasajero con el celular que acaba de ingresar. No hace falta OTP —
// Google ya verificó el correo, así que entra directo sin esperar el SMS.
const completarGoogle = async (req, res) => {
  try {
    const { credential, celular } = req.body
    if (!celular || celular.length < 9) {
      return res.status(400).json({ error: 'Número de celular inválido' })
    }

    const payload = await verificarTokenGoogle(credential)
    if (!payload) {
      return res.status(401).json({ error: 'Token de Google inválido o expirado' })
    }

    const existeEmail = await query('SELECT id FROM usuarios WHERE email = $1 OR google_id = $2', [payload.email, payload.sub])
    if (existeEmail.rows.length > 0) {
      return res.status(409).json({ error: 'Esta cuenta de Google ya está registrada. Intenta iniciar sesión de nuevo.' })
    }

    const existeCelular = await query('SELECT id FROM usuarios WHERE celular = $1', [celular])
    if (existeCelular.rows.length > 0) {
      return res.status(409).json({ error: 'Ese número de celular ya está registrado. Inicia sesión con tu celular.' })
    }

    const nuevoUsuario = await query(
      `INSERT INTO usuarios (nombre, celular, rol, estado, email, google_id)
       VALUES ($1, $2, 'pasajero', 'activo', $3, $4) RETURNING id, nombre, celular, rol`,
      [payload.name || 'Pasajero SafO', celular, payload.email, payload.sub]
    )

    const usuario = nuevoUsuario.rows[0]
    await query('INSERT INTO pasajeros (usuario_id) VALUES ($1)', [usuario.id])

    res.status(201).json({ token: firmarToken(usuario), usuario })
  } catch (error) {
    console.error('Error completarGoogle:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { solicitarOTP, verificarOTP, registrar, loginGoogle, completarGoogle }
