require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const path    = require('path')
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

// Archivos subidos (documentos de conductores)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

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
  console.error('Error no manejado:', err)
  res.status(500).json({ error: 'Error interno del servidor' })
})

// ══════════════════════════════════════════
// INICIAR SERVIDOR
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(``)
  console.log(`  🚖  SafO API corriendo en http://localhost:${PORT}`)
  console.log(`  📋  Documentación: http://localhost:${PORT}/api`)
  console.log(`  💚  Health check:  http://localhost:${PORT}/health`)
  console.log(`  🌍  Entorno: ${process.env.NODE_ENV || 'development'}`)
  console.log(``)
})

module.exports = app
