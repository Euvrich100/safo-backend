const fs = require('fs')
const path = require('path')
const { query } = require('../config/database')
const { UPLOADS_DIR } = require('../config/uploads')

// ═══════════════════════════════════════════════════════════════════════
// Credenciales del conductor: qué se pide, cuándo vence y cómo se revisa.
// Es la ÚNICA fuente de verdad: el registro, el panel del admin y el bloqueo
// por documento vencido leen de aquí.
// ═══════════════════════════════════════════════════════════════════════

// Archivos que se suben en el registro: campo del formulario → columna.
// `pdf: true` acepta también PDF (certificados que suelen descargarse en PDF).
const ARCHIVOS = {
  foto_dni_frontal:          { col: 'dni_foto_frontal_url' },
  foto_dni_trasera:          { col: 'dni_foto_trasera_url' },
  foto_selfie_dni:           { col: 'selfie_dni_url' },
  foto_perfil:               { col: 'perfil_foto_url' },
  foto_licencia:             { col: 'licencia_foto_url' },
  foto_licencia_trasera:     { col: 'licencia_foto_trasera_url' },
  foto_vehiculo:             { col: 'vehiculo_foto_url' },
  foto_vehiculo_trasera:     { col: 'vehiculo_foto_trasera_url' },
  foto_vehiculo_interior:    { col: 'vehiculo_foto_interior_url' },
  doc_tarjeta_propiedad:     { col: 'tarjeta_propiedad_url', pdf: true },
  doc_autorizacion_propietario: { col: 'autorizacion_propietario_url', pdf: true },
  doc_soat:                  { col: 'soat_foto_url', pdf: true },
  doc_revision_tecnica:      { col: 'revision_tecnica_foto_url', pdf: true },
  doc_antecedentes:          { col: 'antecedentes_url', pdf: true },
  doc_permiso_municipal:     { col: 'permiso_municipal_url', pdf: true },
}
// Subidas de renovación (el conductor ya registrado cambia un documento)
const ARCHIVOS_RENOVACION = {
  documento:         { pdf: true },
  documento_reverso: { pdf: false },
}

// Categorías de licencia que permiten cada vehículo (verificar con el MTC antes de operar)
const LICENCIAS = {
  taxi:        ['A-IIa', 'A-IIb', 'A-IIIa', 'A-IIIb', 'A-IIIc'],
  carro:       ['A-IIa', 'A-IIb', 'A-IIIa', 'A-IIIb', 'A-IIIc'],
  bajaj:       ['B-IIc'],
  moto_lineal: ['B-IIb'],
}
const ASEGURADORAS = ['Rímac', 'Pacífico', 'La Positiva', 'Mapfre', 'Interseguro', 'Protecta', 'Qualitas', 'AFOCAT', 'Otra']

// La moto lineal no pasa la misma revisión técnica que un auto de transporte
const exigeRevision = (tipo) => tipo !== 'moto_lineal'
const exigeInterior = (tipo) => tipo !== 'moto_lineal'

const DIAS_AVISO = 30 // desde cuándo se avisa «por vencer»

// ── Fechas (todo como texto AAAA-MM-DD, con el día de Perú) ──────────────
const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const REG_FECHA = /^\d{4}-\d{2}-\d{2}$/
const esFecha = (s) => {
  if (!REG_FECHA.test(String(s || ''))) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
const diasEntre = (desde, hasta) =>
  Math.round((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000)

// Estado de un vencimiento: vigente · por_vencer · vencido · sin_dato
const estadoVence = (vence) => {
  if (!vence) return { estado: 'sin_dato', dias: null }
  const dias = diasEntre(hoyLima(), vence)
  if (dias < 0) return { estado: 'vencido', dias }
  if (dias <= DIAS_AVISO) return { estado: 'por_vencer', dias }
  return { estado: 'vigente', dias }
}

// Columnas de fecha como texto (pg devolvería objetos Date con zona horaria)
const FECHAS_SQL = `
  to_char(c.licencia_vence, 'YYYY-MM-DD')           AS licencia_vence,
  to_char(c.soat_vence, 'YYYY-MM-DD')               AS soat_vence,
  to_char(c.revision_tecnica_vence, 'YYYY-MM-DD')   AS revision_tecnica_vence,
  to_char(c.permiso_municipal_vence, 'YYYY-MM-DD')  AS permiso_municipal_vence,
  to_char(c.antecedentes_fecha, 'YYYY-MM-DD')       AS antecedentes_fecha`

// Fragmento SQL: el conductor «c» no tiene ningún documento VENCIDO.
// Un dato vacío no bloquea (conductores antiguos): lo exige el registro y el admin al aprobar.
const HOY_SQL = "(NOW() AT TIME ZONE 'America/Lima')::date"
const DOCS_AL_DIA_SQL = `(
  (c.soat_vence IS NULL OR c.soat_vence >= ${HOY_SQL}) AND
  (c.licencia_vence IS NULL OR c.licencia_vence >= ${HOY_SQL}) AND
  (c.revision_tecnica_vence IS NULL OR c.revision_tecnica_vence >= ${HOY_SQL}) AND
  (c.permiso_municipal_vence IS NULL OR c.permiso_municipal_vence >= ${HOY_SQL})
)`

// Fragmento SQL equivalente a estaVerificado() para listados (el pasajero ve «Documentos verificados»).
// Debe mantenerse igual que los rubros obligatorios de rubros().
const VERIFICADO_SQL = `(
  c.verificacion->'identidad'->>'estado' = 'ok' AND c.verificacion->'licencia'->>'estado' = 'ok' AND
  c.verificacion->'vehiculo'->>'estado' = 'ok' AND c.verificacion->'propiedad'->>'estado' = 'ok' AND
  c.verificacion->'seguro'->>'estado' = 'ok' AND c.verificacion->'antecedentes'->>'estado' = 'ok' AND
  c.verificacion->'emergencia'->>'estado' = 'ok' AND
  (c.tipo_vehiculo = 'moto_lineal' AND c.revision_tecnica_foto_url IS NULL OR c.verificacion->'revision'->>'estado' = 'ok') AND
  (c.permiso_municipal_url IS NULL OR c.verificacion->'permiso'->>'estado' = 'ok') AND
  c.soat_vence IS NOT NULL
)`

// Documentos que el conductor puede renovar desde su panel → rubro de revisión
const RENOVABLES = {
  soat:         { rubro: 'seguro',       etiqueta: 'SOAT / CAT' },
  licencia:     { rubro: 'licencia',     etiqueta: 'Licencia de conducir' },
  revision:     { rubro: 'revision',     etiqueta: 'Revisión técnica' },
  antecedentes: { rubro: 'antecedentes', etiqueta: 'Antecedentes' },
  permiso:      { rubro: 'permiso',      etiqueta: 'Permiso municipal' },
}

// ── Vigencias (SOAT, licencia, revisión técnica, permiso) ────────────────
const vigencias = (c) => {
  const lista = [
    { clave: 'soat', etiqueta: c.soat_tipo === 'cat' ? 'CAT (AFOCAT)' : 'SOAT', vence: c.soat_vence },
    { clave: 'licencia', etiqueta: 'Licencia de conducir', vence: c.licencia_vence },
  ]
  if (exigeRevision(c.tipo_vehiculo) || c.revision_tecnica_vence) {
    lista.push({ clave: 'revision', etiqueta: 'Revisión técnica', vence: c.revision_tecnica_vence })
  }
  if (c.permiso_municipal_vence || c.permiso_municipal_url) {
    lista.push({ clave: 'permiso', etiqueta: 'Permiso municipal', vence: c.permiso_municipal_vence })
  }
  return lista.map(v => ({ ...v, ...estadoVence(v.vence) }))
}
const vencidos = (c) => vigencias(c).filter(v => v.estado === 'vencido')

// ── Lista de revisión del administrador ──────────────────────────────────
// Cada rubro tiene sus datos, sus archivos y lo que el admin debe comprobar.
const rubros = (c) => {
  const lista = [
    { clave: 'identidad', etiqueta: 'Identidad',
      archivos: ['dni_foto_frontal_url', 'dni_foto_trasera_url', 'selfie_dni_url', 'perfil_foto_url'],
      comprobar: 'El DNI es legible y vigente, y el rostro de la selfie y de la foto de perfil es el mismo del DNI.' },
    { clave: 'licencia', etiqueta: 'Licencia de conducir',
      archivos: ['licencia_foto_url', 'licencia_foto_trasera_url'],
      comprobar: 'Nombre y DNI coinciden, la categoría corresponde al vehículo y no está vencida ni con papeletas que la suspendan.' },
    { clave: 'vehiculo', etiqueta: 'Vehículo',
      archivos: ['vehiculo_foto_url', 'vehiculo_foto_trasera_url', 'vehiculo_foto_interior_url'],
      comprobar: 'La placa de las fotos coincide con la registrada y el vehículo está en buen estado.' },
    { clave: 'propiedad', etiqueta: 'Tarjeta de propiedad',
      archivos: ['tarjeta_propiedad_url', 'autorizacion_propietario_url'],
      comprobar: c.es_propietario === false
        ? 'La tarjeta es de la placa registrada y la autorización del propietario es válida.'
        : 'La tarjeta está a nombre del conductor y es de la placa registrada.' },
    { clave: 'seguro', etiqueta: c.soat_tipo === 'cat' ? 'CAT (AFOCAT)' : 'SOAT',
      archivos: ['soat_foto_url'],
      comprobar: 'Consulta la placa en la web de APESEG: debe figurar vigente y coincidir con el documento y la fecha.' },
  ]
  if (exigeRevision(c.tipo_vehiculo) || c.revision_tecnica_foto_url) {
    lista.push({ clave: 'revision', etiqueta: 'Revisión técnica',
      archivos: ['revision_tecnica_foto_url'],
      comprobar: 'El certificado es de la placa registrada y la fecha de vencimiento coincide.' })
  }
  lista.push({ clave: 'antecedentes', etiqueta: 'Antecedentes',
    archivos: ['antecedentes_url'],
    comprobar: 'El certificado es reciente, es del mismo DNI y no registra antecedentes que impidan transportar pasajeros.' })
  lista.push({ clave: 'emergencia', etiqueta: 'Contacto de emergencia',
    archivos: [],
    comprobar: 'Llama o escribe al contacto para confirmar que existe.' })
  if (c.permiso_municipal_url || c.permiso_municipal_numero) {
    lista.push({ clave: 'permiso', etiqueta: 'Permiso municipal',
      archivos: ['permiso_municipal_url'], opcional: true,
      comprobar: 'El permiso está vigente en la municipalidad.' })
  }
  return lista.map(r => {
    const v = (c.verificacion || {})[r.clave]
    return { ...r, obligatorio: !r.opcional, estado: v?.estado || null, nota: v?.nota || null, en: v?.en || null }
  })
}

// Datos obligatorios que faltan (para no aprobar solicitudes incompletas)
const faltantes = (c) => {
  const f = []
  const falta = (cond, texto) => { if (cond) f.push(texto) }
  falta(!c.dni_foto_frontal_url || !c.dni_foto_trasera_url, 'DNI (frente y reverso)')
  falta(!c.selfie_dni_url, 'selfie con DNI')
  falta(!c.perfil_foto_url, 'foto de rostro')
  falta(!c.licencia_foto_url || !c.licencia_foto_trasera_url, 'licencia (frente y reverso)')
  falta(!c.licencia_vence, 'vencimiento de la licencia')
  falta(!c.vehiculo_foto_url || !c.vehiculo_foto_trasera_url, 'fotos del vehículo')
  falta(!c.tarjeta_propiedad_url, 'tarjeta de propiedad')
  falta(c.es_propietario === false && !c.autorizacion_propietario_url, 'autorización del propietario')
  falta(!c.soat_foto_url || !c.soat_vence || !c.soat_numero, 'SOAT (documento, número y vencimiento)')
  falta(exigeRevision(c.tipo_vehiculo) && (!c.revision_tecnica_foto_url || !c.revision_tecnica_vence), 'revisión técnica')
  falta(!c.antecedentes_url, 'certificado de antecedentes')
  falta(!c.emergencia_celular || !c.emergencia_nombre, 'contacto de emergencia')
  return f
}

// ¿Todo lo obligatorio está revisado y en orden? (lo que ve el pasajero como «verificado»)
const estaVerificado = (c) =>
  faltantes(c).length === 0 &&
  vencidos(c).length === 0 &&
  rubros(c).filter(r => r.obligatorio).every(r => r.estado === 'ok')

// Resumen que ven el conductor y el admin
const resumen = (c) => ({
  vigencias: vigencias(c),
  vencidos: vencidos(c).map(v => v.etiqueta),
  faltantes: faltantes(c),
  verificado: estaVerificado(c),
})

// ── Archivos ─────────────────────────────────────────────────────────────
// Comprueba el CONTENIDO real (los primeros bytes), no solo lo que dice el navegador.
const FIRMAS = {
  '.jpg':  (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  '.png':  (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  '.webp': (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  '.pdf':  (b) => b.toString('latin1', 0, 5) === '%PDF-',
}
const contenidoValido = (archivo) => {
  try {
    const ext = path.extname(archivo.filename).toLowerCase()
    const fd = fs.openSync(path.join(UPLOADS_DIR, archivo.filename), 'r')
    const buf = Buffer.alloc(16)
    fs.readSync(fd, buf, 0, 16, 0)
    fs.closeSync(fd)
    return Boolean(FIRMAS[ext]?.(buf))
  } catch { return false }
}

const borrarArchivos = (files = {}) => {
  Object.values(files).flat().forEach(f => fs.unlink(path.join(UPLOADS_DIR, f.filename), () => {}))
}

// ── Bloqueo automático ───────────────────────────────────────────────────
// Desconecta a quien tenga un documento vencido (cada 10 minutos y al arrancar).
const desconectarVencidos = async () => {
  try {
    const r = await query(
      `UPDATE conductores c SET disponible = FALSE, actualizado_en = NOW()
       WHERE c.disponible = TRUE AND NOT ${DOCS_AL_DIA_SQL}
         AND NOT EXISTS (SELECT 1 FROM viajes v WHERE v.conductor_id = c.id
                         AND v.estado IN ('aceptado','en_camino','recogido'))
       RETURNING c.id`
    )
    if (r.rowCount > 0) console.log(`Documentos vencidos: ${r.rowCount} conductor(es) desconectado(s)`)
  } catch (e) {
    console.error('Error desconectarVencidos:', e.message)
  }
}

module.exports = {
  ARCHIVOS, ARCHIVOS_RENOVACION, LICENCIAS, ASEGURADORAS, DIAS_AVISO,
  exigeRevision, exigeInterior,
  hoyLima, esFecha, diasEntre, estadoVence,
  FECHAS_SQL, DOCS_AL_DIA_SQL, VERIFICADO_SQL, RENOVABLES,
  vigencias, vencidos, rubros, faltantes, estaVerificado, resumen,
  contenidoValido, borrarArchivos, desconectarVencidos,
}
