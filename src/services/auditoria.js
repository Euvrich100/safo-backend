const { query } = require('../config/database')

// Campos que nunca deben quedar en la bitácora
const SENSIBLE = /clave|password|token|otp|codigo/i

const limpiar = (valor, profundidad = 0) => {
  if (valor === null || valor === undefined) return valor
  if (typeof valor === 'string') return valor.length > 200 ? valor.slice(0, 200) + '…' : valor
  if (typeof valor !== 'object' || profundidad > 2) return valor
  if (Array.isArray(valor)) return valor.slice(0, 20).map(v => limpiar(v, profundidad + 1))
  const salida = {}
  for (const [k, v] of Object.entries(valor)) {
    salida[k] = SENSIBLE.test(k) ? '***' : limpiar(v, profundidad + 1)
  }
  return salida
}

const ipDe = (req) =>
  String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64)

// Registra una acción manualmente (cuando hace falta más detalle que el middleware)
const registrarAuditoria = async (req, accion, entidad, entidadId, detalle) => {
  try {
    await query(
      `INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.usuario?.id || null, accion, entidad || null, entidadId ? String(entidadId) : null,
        detalle ? JSON.stringify(limpiar(detalle)) : null, ipDe(req)]
    )
  } catch (e) {
    console.error('registrarAuditoria:', e.message)
  }
}

// Middleware: anota en la bitácora toda acción del admin que terminó bien.
// Uso: router.put('/ruta', verificarToken, soloAdmin, auditar('conductor.revisar', 'conductor'), ctrl)
const auditar = (accion, entidad) => (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400) return
    registrarAuditoria(req, accion, entidad, req.params?.id, {
      params: req.params, cuerpo: req.body, estado_http: res.statusCode
    })
  })
  next()
}

module.exports = { auditar, registrarAuditoria }
