const path = require('path')
const fs = require('fs')

// Carpeta absoluta de documentos subidos (DNI, licencia, vehículo, perfil).
// Se resuelve respecto al proyecto, no al directorio desde donde se arranque
// el servidor, para que multer y el endpoint de lectura apunten al mismo sitio.
const UPLOADS_DIR = path.join(__dirname, '../../uploads')

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

module.exports = { UPLOADS_DIR }
