const multer = require('multer')
const { v4: uuidv4 } = require('uuid')
const { UPLOADS_DIR } = require('../config/uploads')

// Solo se aceptan imágenes — evita que se suban ejecutables u otros archivos
// disfrazados de "foto" de DNI/licencia/vehículo
const TIPOS_PERMITIDOS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    // Nombre generado por el servidor — nunca se usa el originalname del
    // cliente para evitar path traversal o inyección en el nombre de archivo
    cb(null, `${Date.now()}-${uuidv4()}${TIPOS_PERMITIDOS[file.mimetype]}`)
  }
})

const fileFilter = (req, file, cb) => {
  if (!TIPOS_PERMITIDOS[file.mimetype]) {
    return cb(new Error('Solo se permiten imágenes JPG, PNG o WEBP'))
  }
  cb(null, true)
}

const maxMB = Number(process.env.UPLOAD_MAX_SIZE_MB) || 5

const upload = multer({ storage, fileFilter, limits: { fileSize: maxMB * 1024 * 1024 } })

// Los 5 documentos del registro de conductor
const documentosConductor = upload.fields([
  { name: 'foto_dni_frontal', maxCount: 1 },
  { name: 'foto_dni_trasera', maxCount: 1 },
  { name: 'foto_licencia',    maxCount: 1 },
  { name: 'foto_vehiculo',    maxCount: 1 },
  { name: 'foto_perfil',      maxCount: 1 },
])

module.exports = { upload, documentosConductor }
