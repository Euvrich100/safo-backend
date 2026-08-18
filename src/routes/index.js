const express = require('express')
const router = express.Router()

const { verificarToken, soloAdmin, soloConductor, soloPasajero } = require('../middlewares/auth')

const authCtrl      = require('../controllers/authController')
const conductorCtrl = require('../controllers/conductorController')
const viajeCtrl     = require('../controllers/viajeController')
const adminCtrl     = require('../controllers/adminController')

// ══════════════════════════════════════════
// AUTH — público, no requiere token
// ══════════════════════════════════════════
router.post('/auth/registrar',      authCtrl.registrar)
router.post('/auth/solicitar-otp',  authCtrl.solicitarOTP)
router.post('/auth/verificar-otp',  authCtrl.verificarOTP)

// ══════════════════════════════════════════
// CONDUCTOR — requiere token de conductor
// ══════════════════════════════════════════
router.get ('/conductores/perfil',          verificarToken, soloConductor, conductorCtrl.obtenerPerfil)
router.put ('/conductores/perfil',          verificarToken, soloConductor, conductorCtrl.actualizarPerfil)
router.put ('/conductores/disponibilidad',  verificarToken, soloConductor, conductorCtrl.cambiarDisponibilidad)
router.put ('/conductores/ubicacion',       verificarToken, soloConductor, conductorCtrl.actualizarUbicacion)
router.get ('/conductores/suscripciones',   verificarToken, soloConductor, conductorCtrl.obtenerSuscripciones)
router.get ('/conductores/viajes',          verificarToken, soloConductor, conductorCtrl.obtenerViajes)

// ══════════════════════════════════════════
// VIAJES — pasajero solicita, conductor atiende
// ══════════════════════════════════════════
router.get ('/viajes/conductores-disponibles', verificarToken, viajeCtrl.conductoresDisponibles)
router.post('/viajes/solicitar',               verificarToken, soloPasajero,  viajeCtrl.solicitarViaje)
router.put ('/viajes/:id/aceptar',             verificarToken, soloConductor, viajeCtrl.aceptarViaje)
router.put ('/viajes/:id/completar',           verificarToken, soloConductor, viajeCtrl.completarViaje)
router.put ('/viajes/:id/cancelar',            verificarToken, soloPasajero,  viajeCtrl.cancelarViaje)
router.post('/viajes/:id/calificar',           verificarToken, soloPasajero,  viajeCtrl.calificarViaje)

// ══════════════════════════════════════════
// ADMIN — solo administradores
// ══════════════════════════════════════════
router.get ('/admin/dashboard',                     verificarToken, soloAdmin, adminCtrl.dashboard)
router.get ('/admin/conductores',                   verificarToken, soloAdmin, adminCtrl.listarConductores)
router.put ('/admin/conductores/:id/documentos',    verificarToken, soloAdmin, adminCtrl.revisarDocumentos)
router.post('/admin/suscripciones/confirmar',       verificarToken, soloAdmin, adminCtrl.confirmarSuscripcion)
router.get ('/admin/viajes',                        verificarToken, soloAdmin, adminCtrl.listarViajes)


const multer = require('multer')
const path = require('path')
const fs = require('fs')

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/'
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`)
  }
})

const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } })

router.post('/auth/registrar-conductor', upload.fields([
  { name: 'foto_dni_frontal' },
  { name: 'foto_dni_trasera' },
  { name: 'foto_licencia' },
  { name: 'foto_vehiculo' },
  { name: 'foto_perfil' },
]), require('../controllers/registroController').registrarConductor)

router.post('/auth/registrar-pasajero', require('../controllers/registroController').registrarPasajero)



module.exports = router
