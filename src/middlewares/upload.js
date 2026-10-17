const multer = require('multer')
const { v4: uuidv4 } = require('uuid')
const { UPLOADS_DIR } = require('../config/uploads')
const { ARCHIVOS, ARCHIVOS_RENOVACION } = require('../services/documentos')

// Solo se aceptan imágenes (y PDF en los certificados) — evita que se suban
// ejecutables u otros archivos disfrazados de documento. Además, el contenido
// real se comprueba después (services/documentos.js › contenidoValido).
const IMAGENES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}
const TIPOS_PERMITIDOS = { ...IMAGENES, 'application/pdf': '.pdf' }

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    // Nombre generado por el servidor — nunca se usa el originalname del
    // cliente para evitar path traversal o inyección en el nombre de archivo
    cb(null, `${Date.now()}-${uuidv4()}${TIPOS_PERMITIDOS[file.mimetype]}`)
  }
})

const filtroPara = (campos) => (req, file, cb) => {
  const regla = campos[file.fieldname]
  if (!regla) return cb(new Error('Archivo no esperado'))
  const permitidos = regla.pdf ? TIPOS_PERMITIDOS : IMAGENES
  if (!permitidos[file.mimetype]) {
    return cb(new Error(regla.pdf
      ? 'Solo se permiten imágenes JPG, PNG o WEBP, o archivos PDF'
      : 'Solo se permiten imágenes JPG, PNG o WEBP'))
  }
  cb(null, true)
}

const maxMB = Number(process.env.UPLOAD_MAX_SIZE_MB) || 8
const limits = { fileSize: maxMB * 1024 * 1024, files: 20 }

// Foto suelta (uso general)
const upload = multer({ storage, fileFilter: filtroPara({ foto: {} }), limits })

// Todos los documentos del registro de conductor
const documentosConductor = multer({ storage, fileFilter: filtroPara(ARCHIVOS), limits })
  .fields(Object.keys(ARCHIVOS).map(name => ({ name, maxCount: 1 })))

// Renovación de un documento (SOAT, licencia, revisión técnica…) por un conductor ya registrado
const renovacionConductor = multer({ storage, fileFilter: filtroPara(ARCHIVOS_RENOVACION), limits })
  .fields(Object.keys(ARCHIVOS_RENOVACION).map(name => ({ name, maxCount: 1 })))

module.exports = { upload, documentosConductor, renovacionConductor, maxMB }
