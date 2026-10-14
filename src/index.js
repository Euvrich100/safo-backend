require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const path    = require('path')
const multer  = require('multer')
const routes  = require('./routes')

const app  = express()
const PORT = process.env.PORT || 3000

// ══════════════════════════════════════════
// MIDDLEWARES GLOBALES
// ══════════════════════════════════════════

// CORS — permite peticiones desde la app y la web
app.use(cors({
  origin: [
    'http://localhost:3001',
    'http://localhost:8081',
    'https://safo-admin.onrender.com',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

// Parsear JSON en el body de las peticiones
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Los documentos de conductores (DNI, licencia…) NO se sirven como carpeta
// pública: el administrador los consulta en GET /api/admin/documentos/:archivo

// ══════════════════════════════════════════
// RUTAS
// ══════════════════════════════════════════
app.use('/api', routes)

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
  if (err instanceof multer.MulterError || /solo se permiten im[aá]genes/i.test(err.message || '')) {
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

app.listen(PORT, () => {
  console.log(``)
  console.log(`  🚖  SafO API corriendo en http://localhost:${PORT}`)
  console.log(`  📋  Documentación: http://localhost:${PORT}/api`)
  console.log(`  💚  Health check:  http://localhost:${PORT}/health`)
  console.log(`  🌍  Entorno: ${process.env.NODE_ENV || 'development'}`)
  console.log(``)
})

module.exports = app
