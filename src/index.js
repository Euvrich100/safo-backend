require('dotenv').config()
const { validar, origenesPermitidos } = require('./config/entorno')
validar() // antes de abrir nada: si falta configuración importante, el servidor no arranca
const express = require('express')
const cors    = require('cors')
const helmet  = require('helmet')
const limites = require('./middlewares/limites')
const path    = require('path')
const multer  = require('multer')
const routes  = require('./routes')

const app  = express()
const PORT = process.env.PORT || 3000

// Render pone un proxy delante: así req.ip es la IP real del cliente (necesario para los límites)
app.set('trust proxy', 1)

// ══════════════════════════════════════════
// MIDDLEWARES GLOBALES
// ══════════════════════════════════════════

// CORS — permite peticiones desde la app y la web
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({
  origin: origenesPermitidos(),
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

// Parsear JSON en el body de las peticiones (los archivos van aparte, por multer)
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

// Los documentos de conductores (DNI, licencia…) NO se sirven como carpeta
// pública: el administrador los consulta en GET /api/admin/documentos/:archivo

// ══════════════════════════════════════════
// RUTAS
// ══════════════════════════════════════════
app.use('/api', limites.general, routes)

// Ruta de salud — para verificar que el servidor está vivo
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'SafO Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  })
})

// Ruta no encontrada
app.use((req, res) => {
  res.status(404).json({ error: `Ruta ${req.method} ${req.path} no existe` })
})

// Manejador global de errores
app.use((err, req, res, next) => {
  // Errores de subida de archivos (tipo inválido, tamaño excedido, etc.)
  if (err instanceof multer.MulterError || /solo se permiten im[aá]genes|archivo no esperado/i.test(err.message || '')) {
    return res.status(400).json({ error: err.message })
  }
  console.error('Error no manejado:', err)
  res.status(500).json({ error: 'Error interno del servidor' })
})

// ══════════════════════════════════════════
// INICIAR SERVIDOR
// ══════════════════════════════════════════
// Cancela las solicitudes que el conductor no respondió a tiempo
const { expirarSolicitudes } = require('./controllers/viajeController')
setInterval(expirarSolicitudes, 30 * 1000).unref()

// Desconecta a los conductores con SOAT, licencia o revisión técnica vencidos
const { desconectarVencidos } = require('./services/documentos')
setInterval(desconectarVencidos, 10 * 60 * 1000).unref()
desconectarVencidos()

// Bucket privado de Supabase Storage para los documentos (si ya existe, no pasa nada)
const almacen = require('./services/almacenamiento')
almacen.asegurarBucket()
  .then(m => console.log(almacen.remoto() ? `📁 Documentos en Supabase Storage (bucket ${m})` : '📁 Documentos en la carpeta local uploads/ (solo desarrollo)'))
  .catch(e => console.error('❌ No se pudo preparar Supabase Storage:', e.message))

app.listen(PORT, () => {
  console.log(``)
  console.log(`  🚖  SafO API corriendo en http://localhost:${PORT}`)
  console.log(`  📋  Documentación: http://localhost:${PORT}/api`)
  console.log(`  💚  Health check:  http://localhost:${PORT}/health`)
  console.log(`  🌍  Entorno: ${process.env.NODE_ENV || 'development'}`)
  console.log(``)
})

module.exports = app
