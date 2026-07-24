const jwt = require('jsonwebtoken')
const { query } = require('../config/database')

// Genera un código OTP de 6 dígitos
const generarOTP = () => Math.floor(100000 + Math.random() * 900000).toString()

// Envía SMS con OTP via Twilio
// En desarrollo imprime el código en consola en vez de enviarlo
const enviarSMS = async (celular, codigo) => {
  // Siempre mostrar en logs por ahora (hasta configurar Twilio)
  console.log(`📱 OTP para ${celular}: ${codigo}`)
  
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_ACCOUNT_SID !== 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    await twilio.messages.create({
      body: `Tu código SafO es: ${codigo}. Válido por 5 minutos.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+51${celular}`
    })
  }
  return true
}

// POST /api/auth/solicitar-otp
// El usuario ingresa su celular y recibe un SMS con el código
const solicitarOTP = async (req, res) => {
  try {
    const { celular } = req.body

    if (!celular || celular.length < 9) {
      return res.status(400).json({ error: 'Número de celular inválido' })
    }

    const codigo = generarOTP()
    const expira = new Date(Date.now() + 5 * 60 * 1000) // 5 minutos

    // Buscar si el usuario ya existe
    const existe = await query('SELECT id FROM usuarios WHERE celular = $1', [celular])

    if (existe.rows.length === 0) {
      return res.status(404).json({
        error: 'Número no registrado. Descarga SafO y regístrate primero.'
      })
    }

    // Guardar OTP en la BD
    await query(
      'UPDATE usuarios SET otp_codigo = $1, otp_expira_en = $2 WHERE celular = $3',
      [codigo, expira, celular]
    )

    await enviarSMS(celular, codigo)

    res.json({ mensaje: 'Código enviado al celular', expira_en: expira })
  } catch (error) {
    console.error('Error solicitarOTP:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/auth/verificar-otp
// El usuario ingresa el código recibido y obtiene su JWT
const verificarOTP = async (req, res) => {
  try {
    const { celular, codigo } = req.body

    const resultado = await query(
      `SELECT id, nombre, celular, rol, estado, otp_codigo, otp_expira_en
       FROM usuarios WHERE celular = $1`,
      [celular]
    )

    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' })
    }

    const usuario = resultado.rows[0]

    // Verificar código
    if (usuario.otp_codigo !== codigo) {
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

    // Limpiar OTP usado
    await query(
      'UPDATE usuarios SET otp_codigo = NULL, otp_expira_en = NULL WHERE id = $1',
      [usuario.id]
    )

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

module.exports = { solicitarOTP, verificarOTP, registrar }
