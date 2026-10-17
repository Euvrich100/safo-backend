const express = require('express')
const router = express.Router()

const { verificarToken, soloAdmin, soloConductor, soloPasajero } = require('../middlewares/auth')

const authCtrl      = require('../controllers/authController')
const socialCtrl    = require('../controllers/socialController')
const conductorCtrl = require('../controllers/conductorController')
const viajeCtrl     = require('../controllers/viajeController')
const adminCtrl     = require('../controllers/adminController')
const registroCtrl  = require('../controllers/registroController')
const cuentaCtrl    = require('../controllers/cuentaController')
const segCtrl       = require('../controllers/seguridadController')
const platCtrl      = require('../controllers/plataformaController')
const auxCtrl       = require('../controllers/auxilioController')
const { auditar }   = require('../services/auditoria')
const { documentosConductor, renovacionConductor } = require('../middlewares/upload')

// ══════════════════════════════════════════
// AUTH — público, no requiere token
// ══════════════════════════════════════════
router.post('/auth/registrar',      authCtrl.registrar)
router.post('/auth/solicitar-otp',  authCtrl.solicitarOTP)
router.post('/auth/verificar-otp',  authCtrl.verificarOTP)
router.post('/auth/login',          cuentaCtrl.login)
router.get ('/auth/social/proveedores',       socialCtrl.proveedores)
router.post('/auth/social',                   socialCtrl.loginSocial)
router.post('/auth/social/completar',         socialCtrl.completarSocial)
router.post('/auth/google',                    authCtrl.loginGoogle)
router.post('/auth/google/completar-pasajero', authCtrl.completarGoogle)

// ══════════════════════════════════════════
// CONDUCTOR — requiere token de conductor
// ══════════════════════════════════════════
router.get ('/conductores/perfil',          verificarToken, soloConductor, conductorCtrl.obtenerPerfil)
router.put ('/conductores/perfil',          verificarToken, soloConductor, conductorCtrl.actualizarPerfil)
router.put ('/conductores/disponibilidad',  verificarToken, soloConductor, conductorCtrl.cambiarDisponibilidad)
router.get ('/conductores/documentos',      verificarToken, soloConductor, conductorCtrl.misDocumentos)
router.put ('/conductores/documentos/:tipo', verificarToken, soloConductor, renovacionConductor, conductorCtrl.renovarDocumento)
router.put ('/conductores/emergencia',      verificarToken, soloConductor, conductorCtrl.actualizarEmergencia)
router.get ('/conductores/:id/foto',         verificarToken, soloPasajero,  conductorCtrl.fotoConductor)
router.put ('/conductores/ubicacion',       verificarToken, soloConductor, conductorCtrl.actualizarUbicacion)
router.get ('/conductores/suscripciones',   verificarToken, soloConductor, conductorCtrl.obtenerSuscripciones)
router.get ('/conductores/viajes',          verificarToken, soloConductor, conductorCtrl.obtenerViajes)
router.get ('/conductores/viaje-activo',    verificarToken, soloConductor, viajeCtrl.viajeActivoConductor)
router.get ('/conductores/ganancias',       verificarToken, soloConductor, conductorCtrl.obtenerGanancias)

// ══════════════════════════════════════════
// CUENTA — cualquier usuario con sesión
// ══════════════════════════════════════════
router.put ('/cuenta/clave',                verificarToken, cuentaCtrl.cambiarClave)
router.put ('/cuenta/perfil',               verificarToken, cuentaCtrl.actualizarPerfilCuenta)

// ══════════════════════════════════════════
// VIAJES — pasajero solicita, conductor atiende
// ══════════════════════════════════════════
router.get ('/viajes/conductores-disponibles', verificarToken, viajeCtrl.conductoresDisponibles)
router.get ('/ajustes-publicos',            verificarToken, segCtrl.ajustesPublicos)
router.get ('/viajes/cotizar',                 verificarToken, segCtrl.cotizarViaje)
router.post('/viajes/:id/compartir',           verificarToken, soloPasajero,  segCtrl.compartirViaje)
router.post('/viajes/solicitar',               verificarToken, soloPasajero,  viajeCtrl.solicitarViaje)
router.get ('/viajes/mi-viaje',                  verificarToken, soloPasajero,  viajeCtrl.miViaje)
router.get ('/viajes/mis-viajes',                 verificarToken, soloPasajero,  viajeCtrl.misViajes)
router.put ('/viajes/:id/aceptar',             verificarToken, soloConductor, viajeCtrl.aceptarViaje)
router.put ('/viajes/:id/rechazar',            verificarToken, soloConductor, viajeCtrl.rechazarViaje)
router.put ('/viajes/:id/iniciar',             verificarToken, soloConductor, viajeCtrl.iniciarViaje)
router.put ('/viajes/:id/completar',           verificarToken, soloConductor, viajeCtrl.completarViaje)
router.put ('/viajes/:id/cancelar',            verificarToken, soloPasajero,  viajeCtrl.cancelarViaje)
router.post('/viajes/:id/calificar',           verificarToken, soloPasajero,  viajeCtrl.calificarViaje)

// ══════════════════════════════════════════
// ADMIN — solo administradores
// ══════════════════════════════════════════
router.get ('/admin/dashboard',                     verificarToken, soloAdmin, adminCtrl.dashboard)
router.get ('/admin/conductores',                   verificarToken, soloAdmin, adminCtrl.listarConductores)
router.get ('/admin/conductores/:id',               verificarToken, soloAdmin, adminCtrl.detalleConductor)
router.put ('/admin/conductores/:id/documentos',    verificarToken, soloAdmin, auditar('conductor.revisar_documentos', 'conductor'), adminCtrl.revisarDocumentos)
router.put ('/admin/conductores/:id/verificacion',  verificarToken, soloAdmin, auditar('conductor.verificar_rubro', 'conductor'), adminCtrl.verificarRubro)
router.put ('/admin/conductores/:id/renovaciones/:tipo', verificarToken, soloAdmin, auditar('conductor.decidir_renovacion', 'conductor'), adminCtrl.decidirRenovacion)
router.post('/admin/suscripciones/confirmar',       verificarToken, soloAdmin, auditar('suscripcion.confirmar', 'suscripcion'), adminCtrl.confirmarSuscripcion)
router.get ('/admin/viajes',                        verificarToken, soloAdmin, adminCtrl.listarViajes)
router.get ('/admin/pasajeros',                     verificarToken, soloAdmin, adminCtrl.listarPasajeros)
router.put ('/admin/usuarios/:id/estado',           verificarToken, soloAdmin, auditar('usuario.cambiar_estado', 'usuario'), adminCtrl.cambiarEstadoUsuario)
router.post('/admin/usuarios/:id/restablecer-clave', verificarToken, soloAdmin, auditar('usuario.restablecer_clave', 'usuario'), cuentaCtrl.restablecerClave)
router.get ('/admin/documentos/:archivo',           verificarToken, soloAdmin, adminCtrl.verDocumento)


// ══════════════════════════════════════════
// SEGURIDAD Y ATENCIÓN — SOS, reclamos, zonas, seguimiento público
// ══════════════════════════════════════════
router.post('/sos',                  verificarToken, segCtrl.crearSOS)
router.post('/reclamos',             verificarToken, segCtrl.crearReclamo)
router.get ('/reclamos/mios',        verificarToken, segCtrl.misReclamos)
router.get ('/zonas',                verificarToken, platCtrl.listarZonas)
router.get ('/publico/viaje/:token', segCtrl.seguimientoPublico)

// ══════════════════════════════════════════
// ADMIN — tablero, mapa, tarifas, zonas, reclamos, SOS y auditoría
// ══════════════════════════════════════════
router.get   ('/admin/estadisticas',     verificarToken, soloAdmin, platCtrl.estadisticas)
router.get   ('/admin/alertas',          verificarToken, soloAdmin, platCtrl.alertas)
router.get   ('/admin/mapa-vivo',        verificarToken, soloAdmin, platCtrl.mapaVivo)
router.get   ('/admin/configuracion',    verificarToken, soloAdmin, platCtrl.obtenerConfiguracion)
router.put   ('/admin/configuracion',    verificarToken, soloAdmin, auditar('configuracion.guardar', 'configuracion'), platCtrl.guardarConfiguracion)
router.post  ('/admin/zonas',            verificarToken, soloAdmin, auditar('zona.crear', 'zona'), platCtrl.crearZona)
router.put   ('/admin/zonas/:id',        verificarToken, soloAdmin, auditar('zona.actualizar', 'zona'), platCtrl.actualizarZona)
router.delete('/admin/zonas/:id',        verificarToken, soloAdmin, auditar('zona.eliminar', 'zona'), platCtrl.eliminarZona)
router.get   ('/admin/reclamos',         verificarToken, soloAdmin, platCtrl.listarReclamos)
router.put   ('/admin/reclamos/:id',     verificarToken, soloAdmin, auditar('reclamo.resolver', 'reclamo'), platCtrl.resolverReclamo)
router.get   ('/admin/sos',              verificarToken, soloAdmin, platCtrl.listarSOS)
router.put   ('/admin/sos/:id/atender',  verificarToken, soloAdmin, auditar('sos.atender', 'sos'), platCtrl.atenderSOS)
router.get   ('/admin/auditoria',        verificarToken, soloAdmin, platCtrl.listarAuditoria)

// ══════════════════════════════════════════
// AUXILIO MECÁNICO — solo conductores
// ══════════════════════════════════════════
router.post  ('/auxilio/acceso',          auxCtrl.acceso)
router.get   ('/auxilio/mecanicos',       verificarToken, soloConductor, auxCtrl.listarParaConductor)
router.get   ('/admin/mecanicos',         verificarToken, soloAdmin, auxCtrl.listarAdmin)
router.post  ('/admin/mecanicos',         verificarToken, soloAdmin, auditar('mecanico.crear', 'mecanico'), auxCtrl.crear)
router.put   ('/admin/mecanicos/:id',     verificarToken, soloAdmin, auditar('mecanico.actualizar', 'mecanico'), auxCtrl.actualizar)
router.delete('/admin/mecanicos/:id',     verificarToken, soloAdmin, auditar('mecanico.eliminar', 'mecanico'), auxCtrl.eliminar)

// ══════════════════════════════════════════
// REGISTRO PÚBLICO (portal web)
// ══════════════════════════════════════════
router.post('/auth/registrar-conductor', documentosConductor, registroCtrl.registrarConductor)
router.post('/auth/registrar-pasajero',  registroCtrl.registrarPasajero)

module.exports = router
