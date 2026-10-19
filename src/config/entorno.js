// Revisa la configuración al arrancar. En producción, si falta algo importante el servidor NO
// arranca y dice exactamente qué falta (mejor eso que funcionar a medias y perder datos).
const PRODUCCION = process.env.NODE_ENV === 'production'

const validar = () => {
  const errores = []
  const avisos = []

  const secreto = process.env.JWT_SECRET || ''
  if (!secreto) errores.push('JWT_SECRET: falta. Genera una con: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"')
  else if (PRODUCCION && (secreto.length < 32 || /cambia_esto/i.test(secreto))) errores.push('JWT_SECRET: es muy corta o es la de ejemplo. Usa una aleatoria de 64 caracteres o más.')
  if (!process.env.JWT_EXPIRES_IN) errores.push('JWT_EXPIRES_IN: falta (por ejemplo 7d).')
  if (!process.env.DATABASE_URL) errores.push('DATABASE_URL: falta la cadena de conexión a PostgreSQL.')

  const storage = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  if (PRODUCCION && !storage && process.env.PERMITIR_DISCO_LOCAL !== '1') {
    errores.push('SUPABASE_URL y SUPABASE_SERVICE_KEY: faltan. Sin ellas los documentos de los conductores se guardarían en el disco de Render y se borrarían en cada reinicio.')
  }
  if (PRODUCCION && !process.env.CORS_ORIGINS) {
    avisos.push('CORS_ORIGINS: no está definida; solo se aceptará https://safo-admin.onrender.com. Si usas tu propio dominio, agrégalo.')
  }
  if (PRODUCCION && !(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER)) {
    avisos.push('Twilio sin configurar: el ingreso con código SMS queda desactivado (se puede entrar con contraseña).')
  }

  avisos.forEach(a => console.warn('⚠️  ' + a))
  if (errores.length) {
    console.error('\n❌ Configuración incompleta. El servidor no puede arrancar:\n')
    errores.forEach(e => console.error('   • ' + e))
    console.error('')
    process.exit(1)
  }
}

// Orígenes que pueden llamar a la API desde un navegador
const origenesPermitidos = () => {
  const propios = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
  const base = ['https://safo-admin.onrender.com', ...propios]
  return PRODUCCION ? base : [...base, 'http://localhost:3001', 'http://localhost:8081']
}

module.exports = { validar, origenesPermitidos, PRODUCCION }
