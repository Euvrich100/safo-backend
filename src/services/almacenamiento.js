const fs = require('fs')
const path = require('path')
const { UPLOADS_DIR } = require('../config/uploads')

// ═══════════════════════════════════════════════════════════════════════
// Almacenamiento de los documentos de conductores (DNI, licencia, SOAT…).
//
//  · PRODUCCIÓN: Supabase Storage, en un bucket PRIVADO. Render borra el disco del servidor en
//    cada deploy o reinicio, por eso los archivos NO pueden quedarse en la carpeta uploads/.
//  · DESARROLLO (sin variables SUPABASE_*): se usa la carpeta uploads/ del proyecto.
//
// multer recibe cada archivo en uploads/ (carpeta de paso). Cuando el registro ya está validado,
// subir() lo pasa al almacenamiento permanente y borra la copia local.
// ═══════════════════════════════════════════════════════════════════════

const URL_BASE = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const CLAVE = process.env.SUPABASE_SERVICE_KEY || ''
const BUCKET = process.env.SUPABASE_BUCKET || 'documentos'

const remoto = () => Boolean(URL_BASE && CLAVE)

const TIPOS = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' }
// Nombres que genera el servidor (middlewares/upload.js). Cualquier otra cosa se rechaza:
// el nombre acaba dentro de una URL y de una ruta de disco.
const NOMBRE_VALIDO = /^\d+-[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/

const cabeceras = (extra = {}) => ({ apikey: CLAVE, Authorization: `Bearer ${CLAVE}`, ...extra })
const urlObjeto = (nombre) => `${URL_BASE}/storage/v1/object/${BUCKET}/${nombre}`

// Crea el bucket privado si no existe (se llama al arrancar el servidor)
const asegurarBucket = async () => {
  if (!remoto()) return 'local'
  const r = await fetch(`${URL_BASE}/storage/v1/bucket`, {
    method: 'POST',
    headers: cabeceras({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  })
  if (r.ok) return 'creado'
  const cuerpo = await r.text().catch(() => '')
  if (r.status === 409 || /already exists|duplicate/i.test(cuerpo)) return 'existente'
  throw new Error(`Supabase Storage respondió ${r.status}: ${cuerpo.slice(0, 200)}`)
}

// Sube a Supabase los archivos recién recibidos (objeto de multer: { campo: [archivo] }).
// Si alguno falla, lanza el error: el registro NO debe guardarse apuntando a archivos que no existen.
const subir = async (files = {}) => {
  if (!remoto()) return
  const lista = Object.values(files).flat()
  for (const f of lista) {
    if (!NOMBRE_VALIDO.test(f.filename)) throw new Error('Nombre de archivo no válido')
    const local = path.join(UPLOADS_DIR, f.filename)
    const buffer = await fs.promises.readFile(local)
    const r = await fetch(urlObjeto(f.filename), {
      method: 'POST',
      headers: cabeceras({ 'Content-Type': TIPOS[path.extname(f.filename).toLowerCase()], 'x-upsert': 'false' }),
      body: buffer,
    })
    if (!r.ok) throw new Error(`No se pudo subir ${f.filename} a Supabase Storage (${r.status})`)
    await fs.promises.unlink(local).catch(() => {})
  }
}

// Borra archivos por nombre, en el disco y en Supabase (sin fallar si ya no existen)
const borrar = (nombres = []) => {
  const validos = nombres.filter(n => typeof n === 'string' && NOMBRE_VALIDO.test(n))
  for (const n of validos) fs.unlink(path.join(UPLOADS_DIR, n), () => {})
  if (remoto() && validos.length) {
    fetch(`${URL_BASE}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: cabeceras({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: validos }),
    }).catch(e => console.error('No se pudo borrar de Supabase Storage:', e.message))
  }
}

// Devuelve { buffer, tipo } o null si no existe
const leer = async (nombre) => {
  const base = path.basename(String(nombre || ''))
  if (!NOMBRE_VALIDO.test(base)) return null
  const tipo = TIPOS[path.extname(base).toLowerCase()]
  const local = path.join(UPLOADS_DIR, base)
  if (fs.existsSync(local)) return { buffer: await fs.promises.readFile(local), tipo }
  if (!remoto()) return null
  const r = await fetch(`${URL_BASE}/storage/v1/object/authenticated/${BUCKET}/${base}`, { headers: cabeceras() })
  if (r.status === 404 || r.status === 400) return null
  if (!r.ok) throw new Error(`Supabase Storage respondió ${r.status} al leer ${base}`)
  return { buffer: Buffer.from(await r.arrayBuffer()), tipo }
}

module.exports = { remoto, asegurarBucket, subir, borrar, leer, NOMBRE_VALIDO }
