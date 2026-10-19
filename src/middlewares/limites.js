const rateLimit = require('express-rate-limit')

// Límites de peticiones por IP. Protegen el saldo de SMS, el registro de cuentas falsas y el
// login contra intentos masivos. (El login además bloquea cada celular tras 5 intentos fallidos.)
// Muchos celulares comparten una misma IP en las redes móviles, por eso los límites son holgados
// para el uso normal y estrictos solo donde un abuso cuesta dinero.
//
// En pruebas automáticas (NODE_ENV=test) los límites se desactivan.
const crear = (minutos, max, mensaje) => rateLimit({
  windowMs: minutos * 60 * 1000,
  limit: max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: mensaje },
})

module.exports = {
  // Todo /api: frena inundaciones (el GPS de un conductor envía ~90 posiciones cada 15 min)
  general: crear(15, 3000, 'Demasiadas peticiones. Espera unos minutos e intenta de nuevo.'),
  // Inicio de sesión (con contraseña, social y auxilio mecánico)
  acceso: crear(15, 40, 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.'),
  // Pedir el código SMS: cada SMS cuesta dinero
  pedirSMS: crear(60, 10, 'Pediste demasiados códigos. Intenta de nuevo en una hora.'),
  verificarSMS: crear(15, 30, 'Demasiados intentos con el código. Espera 15 minutos.'),
  // Crear cuentas
  registro: crear(60, 10, 'Demasiados registros desde esta conexión. Intenta de nuevo en una hora.'),
}
