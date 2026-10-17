const { query } = require('../config/database')
const { verificarCredencialesConductor } = require('./cuentaController')

// Auxilio mecánico: directorio de mecánicos de confianza, solo para conductores.

const ESPECIALIDADES = ['general', 'electricidad', 'llantas', 'grua', 'motos', 'planchado', 'combustible', 'cerrajeria']
const VEHICULOS = ['taxi', 'moto', 'ambos']

const soloDigitos = (v) => String(v || '').replace(/\D/g, '')
const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// Lo que ve el conductor (sin campos internos)
const CAMPOS_PUBLICOS = `id, nombre, especialidad, telefono, whatsapp, direccion, distrito, horario, atiende_24h, vehiculos, notas`

const listarActivos = async () => {
  const r = await query(
    `SELECT ${CAMPOS_PUBLICOS} FROM mecanicos WHERE activo = TRUE
     ORDER BY atiende_24h DESC, nombre ASC`
  )
  return r.rows
}

// POST /api/auxilio/acceso  { celular, password }   — público, pero solo abre para conductores aprobados.
// No crea sesión: cada consulta vuelve a verificar celular y contraseña.
const acceso = async (req, res) => {
  try {
    const v = await verificarCredencialesConductor(req.body?.celular, req.body?.password)
    if (v.error) return res.status(v.status).json({ error: v.error })
    res.json({ conductor: v.usuario.nombre, mecanicos: await listarActivos() })
  } catch (error) {
    console.error('Error acceso auxilio:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// GET /api/auxilio/mecanicos — conductor ya autenticado (panel del conductor)
const listarParaConductor = async (req, res) => {
  try {
    res.json({ mecanicos: await listarActivos() })
  } catch (error) {
    console.error('Error listando mecánicos:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// Valida y normaliza el cuerpo de crear/editar. Devuelve { datos } o { error }.
const validar = (b, parcial = false) => {
  const d = {}
  if (!parcial || b.nombre !== undefined) {
    d.nombre = texto(b.nombre, 120)
    if (d.nombre.length < 3) return { error: 'Escribe el nombre del taller o mecánico' }
  }
  if (!parcial || b.telefono !== undefined) {
    d.telefono = soloDigitos(b.telefono)
    if (d.telefono.length < 6 || d.telefono.length > 15) return { error: 'El teléfono debe tener entre 6 y 15 dígitos' }
  }
  if (b.whatsapp !== undefined) {
    const w = soloDigitos(b.whatsapp)
    if (w && (w.length < 9 || w.length > 15)) return { error: 'El WhatsApp debe tener entre 9 y 15 dígitos' }
    d.whatsapp = w || null
  }
  if (b.especialidad !== undefined) {
    if (!ESPECIALIDADES.includes(b.especialidad)) return { error: 'Especialidad no válida' }
    d.especialidad = b.especialidad
  }
  if (b.vehiculos !== undefined) {
    if (!VEHICULOS.includes(b.vehiculos)) return { error: 'Tipo de vehículo no válido' }
    d.vehiculos = b.vehiculos
  }
  for (const [k, max] of [['direccion', 200], ['distrito', 80], ['horario', 120], ['notas', 300]]) {
    if (b[k] !== undefined) d[k] = texto(b[k], max) || null
  }
  if (b.atiende_24h !== undefined) d.atiende_24h = b.atiende_24h === true || b.atiende_24h === 'true'
  if (b.activo !== undefined) d.activo = b.activo === true || b.activo === 'true'
  return { datos: d }
}

// GET /api/admin/mecanicos
const listarAdmin = async (req, res) => {
  try {
    const r = await query('SELECT * FROM mecanicos ORDER BY activo DESC, nombre ASC')
    res.json(r.rows)
  } catch (error) {
    console.error('Error listando mecánicos (admin):', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/admin/mecanicos
const crear = async (req, res) => {
  try {
    const { datos, error } = validar(req.body || {})
    if (error) return res.status(400).json({ error })
    const cols = Object.keys(datos)
    const r = await query(
      `INSERT INTO mecanicos (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`,
      cols.map(c => datos[c])
    )
    res.status(201).json(r.rows[0])
  } catch (error) {
    console.error('Error creando mecánico:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// PUT /api/admin/mecanicos/:id
const actualizar = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!id) return res.status(400).json({ error: 'Id no válido' })
    const { datos, error } = validar(req.body || {}, true)
    if (error) return res.status(400).json({ error })
    const cols = Object.keys(datos)
    if (!cols.length) return res.status(400).json({ error: 'No hay cambios que guardar' })
    const r = await query(
      `UPDATE mecanicos SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, actualizado_en = NOW()
       WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map(c => datos[c]), id]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'Mecánico no encontrado' })
    res.json(r.rows[0])
  } catch (error) {
    console.error('Error actualizando mecánico:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// DELETE /api/admin/mecanicos/:id
const eliminar = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!id) return res.status(400).json({ error: 'Id no válido' })
    const r = await query('DELETE FROM mecanicos WHERE id = $1 RETURNING id', [id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Mecánico no encontrado' })
    res.json({ ok: true })
  } catch (error) {
    console.error('Error eliminando mecánico:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { acceso, listarParaConductor, listarAdmin, crear, actualizar, eliminar }
