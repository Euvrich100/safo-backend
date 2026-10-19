const jwt = require('jsonwebtoken')
const { query, pool } = require('../config/database')
const {
  ARCHIVOS, LICENCIAS, exigeRevision, exigeInterior, hoyLima, esFecha, diasEntre,
  contenidoValido, borrarArchivos
} = require('../services/documentos')
const { hashClave, claveValida, CLAVE_MIN, CLAVE_MAX } = require('./cuentaController')
const almacen = require('../services/almacenamiento')

const soloDigitos = (v) => String(v || '').replace(/\D/g, '')
const texto = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)

// Vehículos con los que se puede conducir. Taxi, carro y bajaj atienden el servicio «Taxi»;
// la moto lineal atiende el servicio «Moto».
const TIPOS_VEHICULO = ['taxi', 'carro', 'bajaj', 'moto_lineal']

// POST /api/auth/registrar-conductor
// Registro público desde el portal web. La cuenta queda INACTIVA con los
// documentos en revisión hasta que un administrador la apruebe.
const registrarConductor = async (req, res) => {
  const files = req.files || {}
  const rechazar = (status, error) => {
    borrarArchivos(files)
    return res.status(status).json({ error })
  }

  try {
    const b = req.body
    const nombre = texto(b.nombre, 100)
    const celular = soloDigitos(b.celular)
    const dni = soloDigitos(b.dni)
    // Formularios anteriores no mandaban el tipo: se asume taxi
    const tipo_vehiculo = String(b.tipo_vehiculo || 'taxi').toLowerCase()
    const vehiculo_anno = b.vehiculo_anno ? parseInt(b.vehiculo_anno, 10) : null
    const hoy = hoyLima()

    if (!nombre || !celular || !dni) return rechazar(400, 'Completa tu nombre, celular y DNI')
    if (!TIPOS_VEHICULO.includes(tipo_vehiculo)) return rechazar(400, 'Elige el tipo de vehículo: taxi, carro, bajaj o moto lineal')
    if (celular.length !== 9) return rechazar(400, 'El celular debe tener 9 dígitos')
    if (dni.length !== 8) return rechazar(400, 'El DNI debe tener 8 dígitos')
    if (!claveValida(b.password)) {
      return rechazar(400, `Crea una contraseña de ${CLAVE_MIN} a ${CLAVE_MAX} caracteres`)
    }
    const fecha_nacimiento = b.fecha_nacimiento || null
    if (fecha_nacimiento) {
      if (!esFecha(fecha_nacimiento)) return rechazar(400, 'Fecha de nacimiento inválida')
      const edad = diasEntre(fecha_nacimiento, hoy) / 365.25
      if (edad < 18) return rechazar(400, 'Debes ser mayor de edad para conducir')
      if (edad > 90) return rechazar(400, 'Fecha de nacimiento inválida')
    }

    // ── Licencia ──
    const licencia_numero = texto(b.licencia_numero, 30).toUpperCase()
    const licencia_categoria = texto(b.licencia_categoria, 10)
    const licencia_vence = b.licencia_vence
    if (!licencia_numero) return rechazar(400, 'Escribe el número de tu licencia')
    if (!LICENCIAS[tipo_vehiculo].includes(licencia_categoria)) {
      return rechazar(400, `Para este vehículo la licencia debe ser categoría ${LICENCIAS[tipo_vehiculo].join(', ')}`)
    }
    if (!esFecha(licencia_vence)) return rechazar(400, 'Indica la fecha de vencimiento de tu licencia')
    if (licencia_vence < hoy) return rechazar(400, 'Tu licencia está vencida. Revalídala para poder registrarte')

    // ── Vehículo ──
    const placaNorm = String(b.placa || '').toUpperCase().replace(/[\s-]+/g, '')
    if (!/^[A-Z0-9]{5,7}$/.test(placaNorm)) return rechazar(400, 'Placa inválida. Ejemplo: ABC-123')
    const marca = texto(b.vehiculo_marca, 50), modelo = texto(b.vehiculo_modelo, 50), color = texto(b.vehiculo_color, 30)
    if (!marca || !modelo || !color) return rechazar(400, 'Indica la marca, el modelo y el color del vehículo')
    if (!Number.isInteger(vehiculo_anno) || vehiculo_anno < 1980 || vehiculo_anno > new Date().getFullYear() + 1) {
      return rechazar(400, 'Año del vehículo inválido')
    }
    const vehiculo_serie = texto(b.vehiculo_serie, 30).toUpperCase() || null

    // ── Propiedad ──
    const es_propietario = String(b.es_propietario) !== 'false' && String(b.es_propietario) !== 'no'
    const propietario_nombre = texto(b.propietario_nombre, 120) || null
    if (!es_propietario && !propietario_nombre) return rechazar(400, 'Escribe el nombre del propietario del vehículo')

    // ── Seguro (SOAT o CAT) ──
    const soat_tipo = String(b.soat_tipo || 'soat').toLowerCase()
    if (!['soat', 'cat'].includes(soat_tipo)) return rechazar(400, 'Elige SOAT o CAT')
    const soat_numero = texto(b.soat_numero, 40).toUpperCase()
    const soat_aseguradora = texto(b.soat_aseguradora, 60)
    const nombreSeguro = soat_tipo === 'cat' ? 'CAT' : 'SOAT'
    if (!soat_numero) return rechazar(400, `Escribe el número de póliza de tu ${nombreSeguro}`)
    if (!soat_aseguradora) return rechazar(400, `Indica la aseguradora de tu ${nombreSeguro}`)
    if (!esFecha(b.soat_vence)) return rechazar(400, `Indica la fecha de vencimiento de tu ${nombreSeguro}`)
    if (b.soat_vence < hoy) return rechazar(400, `Tu ${nombreSeguro} está vencido. Renuévalo para poder registrarte`)

    // ── Revisión técnica ──
    let revision_vence = null
    if (exigeRevision(tipo_vehiculo) || b.revision_tecnica_vence) {
      if (!esFecha(b.revision_tecnica_vence)) return rechazar(400, 'Indica la fecha de vencimiento de tu revisión técnica')
      if (b.revision_tecnica_vence < hoy) return rechazar(400, 'Tu revisión técnica está vencida. Renuévala para poder registrarte')
      revision_vence = b.revision_tecnica_vence
    }

    // ── Antecedentes ──
    if (!esFecha(b.antecedentes_fecha)) return rechazar(400, 'Indica la fecha de emisión de tu certificado de antecedentes')
    if (b.antecedentes_fecha > hoy) return rechazar(400, 'La fecha del certificado de antecedentes es inválida')
    if (diasEntre(b.antecedentes_fecha, hoy) > 90) return rechazar(400, 'Tu certificado de antecedentes tiene más de 90 días. Saca uno reciente')

    // ── Permiso municipal (opcional, pero completo si se llena) ──
    const permiso_numero = texto(b.permiso_municipal_numero, 40) || null
    const permiso_vence = b.permiso_municipal_vence || null
    const hayPermiso = permiso_numero || permiso_vence || files.doc_permiso_municipal?.[0]
    if (hayPermiso) {
      if (!permiso_numero || !files.doc_permiso_municipal?.[0]) return rechazar(400, 'Para el permiso municipal indica el número y sube el documento (o déjalo todo vacío)')
      if (!esFecha(permiso_vence) || permiso_vence < hoy) return rechazar(400, 'El permiso municipal está vencido o sin fecha de vencimiento')
    }

    // ── Contacto de emergencia ──
    const emergencia_nombre = texto(b.emergencia_nombre, 100)
    const emergencia_celular = soloDigitos(b.emergencia_celular)
    const emergencia_parentesco = texto(b.emergencia_parentesco, 30)
    if (!emergencia_nombre || !emergencia_parentesco) return rechazar(400, 'Indica el nombre y el parentesco de tu contacto de emergencia')
    if (emergencia_celular.length !== 9) return rechazar(400, 'El celular del contacto de emergencia debe tener 9 dígitos')
    if (emergencia_celular === celular) return rechazar(400, 'El contacto de emergencia debe ser otra persona, con otro celular')

    // ── Consentimiento ──
    if (String(b.acepta_terminos) !== 'true') return rechazar(400, 'Debes aceptar los términos y el tratamiento de tus datos personales')

    // ── Archivos obligatorios ──
    const obligatorios = [
      ['foto_dni_frontal', 'DNI (frente)'], ['foto_dni_trasera', 'DNI (reverso)'],
      ['foto_selfie_dni', 'selfie con tu DNI'], ['foto_perfil', 'foto de tu rostro'],
      ['foto_licencia', 'licencia (frente)'], ['foto_licencia_trasera', 'licencia (reverso)'],
      ['foto_vehiculo', 'foto del vehículo (frente)'], ['foto_vehiculo_trasera', 'foto del vehículo (atrás)'],
      ['doc_tarjeta_propiedad', 'tarjeta de propiedad'], ['doc_soat', nombreSeguro],
      ['doc_antecedentes', 'certificado de antecedentes'],
    ]
    if (exigeInterior(tipo_vehiculo)) obligatorios.push(['foto_vehiculo_interior', 'foto del interior del vehículo'])
    if (exigeRevision(tipo_vehiculo)) obligatorios.push(['doc_revision_tecnica', 'revisión técnica'])
    if (!es_propietario) obligatorios.push(['doc_autorizacion_propietario', 'autorización del propietario'])
    const falta = obligatorios.filter(([campo]) => !files[campo]?.[0]).map(([, etiqueta]) => etiqueta)
    if (falta.length > 0) return rechazar(400, 'Falta subir: ' + falta.join(', '))

    // El contenido debe ser realmente una imagen o un PDF
    const falsos = Object.values(files).flat().filter(f => !contenidoValido(f))
    if (falsos.length > 0) return rechazar(400, 'Uno de los archivos no es una imagen o PDF válido. Súbelo de nuevo.')

    const dup = await query(
      `SELECT
         EXISTS(SELECT 1 FROM usuarios WHERE celular = $1)                 AS celular,
         EXISTS(SELECT 1 FROM conductores WHERE dni = $2)                  AS dni,
         EXISTS(SELECT 1 FROM conductores WHERE UPPER(REPLACE(placa, '-', '')) = $3) AS placa,
         EXISTS(SELECT 1 FROM conductores WHERE UPPER(licencia_numero) = $4) AS licencia`,
      [celular, dni, placaNorm, licencia_numero]
    )
    if (dup.rows[0].celular)  return rechazar(409, 'Este número de celular ya está registrado')
    if (dup.rows[0].dni)      return rechazar(409, 'Este DNI ya tiene una solicitud registrada')
    if (dup.rows[0].placa)    return rechazar(409, 'Esta placa ya tiene una solicitud registrada')
    if (dup.rows[0].licencia) return rechazar(409, 'Esta licencia ya tiene una solicitud registrada')

    // Los documentos pasan a almacenamiento permanente ANTES de guardar el registro
    await almacen.subir(files)

    // Columnas de archivo ← nombre guardado por multer
    const cols = {}
    for (const [campo, { col }] of Object.entries(ARCHIVOS)) cols[col] = files[campo]?.[0]?.filename || null

    const datos = {
      dni, fecha_nacimiento, direccion: texto(b.direccion, 200) || null,
      licencia_numero, licencia_categoria, licencia_vence,
      placa: placaNorm.length === 6 ? `${placaNorm.slice(0, 3)}-${placaNorm.slice(3)}` : placaNorm, tipo_vehiculo,
      vehiculo_marca: marca, vehiculo_modelo: modelo, vehiculo_color: color, vehiculo_anno, vehiculo_serie,
      es_propietario, propietario_nombre: es_propietario ? null : propietario_nombre,
      soat_tipo, soat_numero, soat_aseguradora, soat_vence: b.soat_vence,
      revision_tecnica_vence: revision_vence, antecedentes_fecha: b.antecedentes_fecha,
      permiso_municipal_numero: hayPermiso ? permiso_numero : null,
      permiso_municipal_vence: hayPermiso ? permiso_vence : null,
      emergencia_nombre, emergencia_celular, emergencia_parentesco,
      ...cols,
    }
    const columnas = Object.keys(datos)

    // Usuario + perfil de conductor en una transacción: o se crean los dos o ninguno
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const usuario = await client.query(
        `INSERT INTO usuarios (nombre, celular, rol, estado, password_hash, password_cambiada_en)
         VALUES ($1, $2, 'conductor', 'inactivo', $3, NOW()) RETURNING id`,
        [nombre, celular, await hashClave(b.password)]
      )

      await client.query(
        `INSERT INTO conductores (usuario_id, ${columnas.join(', ')}, acepta_terminos_en, estado_doc)
         VALUES ($1, ${columnas.map((_, i) => `$${i + 2}`).join(', ')}, NOW(), 'pendiente')`,
        [usuario.rows[0].id, ...columnas.map(c => datos[c])]
      )

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    res.status(201).json({
      mensaje: '¡Registro exitoso! El administrador revisará tu solicitud en menos de 24 horas.',
      estado: 'pendiente'
    })
  } catch (error) {
    borrarArchivos(files)
    console.error('Error registrarConductor:', error)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El celular, DNI o placa ya está registrado' })
    }
    if (error.code === '22007' || error.code === '22008') {
      return res.status(400).json({ error: 'Una de las fechas es inválida' })
    }
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

// POST /api/auth/registrar-pasajero
const registrarPasajero = async (req, res) => {
  try {
    const { nombre } = req.body
    const celular = soloDigitos(req.body.celular)

    if (!nombre || !celular) {
      return res.status(400).json({ error: 'Nombre y celular son obligatorios' })
    }
    if (celular.length !== 9) {
      return res.status(400).json({ error: 'El celular debe tener 9 dígitos' })
    }
    if (!claveValida(req.body.password)) {
      return res.status(400).json({ error: `Crea una contraseña de ${CLAVE_MIN} a ${CLAVE_MAX} caracteres` })
    }

    const existe = await query('SELECT id FROM usuarios WHERE celular = $1', [celular])
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Este número ya está registrado' })
    }

    let idUsuario
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const nuevoUsuario = await client.query(
        `INSERT INTO usuarios (nombre, celular, rol, estado, password_hash, password_cambiada_en)
         VALUES ($1, $2, 'pasajero', 'activo', $3, NOW()) RETURNING id`,
        [nombre.trim(), celular, await hashClave(req.body.password)]
      )
      idUsuario = nuevoUsuario.rows[0].id
      await client.query('INSERT INTO pasajeros (usuario_id) VALUES ($1)', [idUsuario])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    // La cuenta nace activa y entra directo a su panel (el celular aún no se
    // verifica por SMS; la contraseña protege el acceso posterior).
    const usuario = { id: idUsuario, nombre: nombre.trim(), celular, rol: 'pasajero' }
    const token = jwt.sign(
      { id: usuario.id, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.status(201).json({
      mensaje: '¡Registro exitoso! Ya puedes pedir tu taxi seguro.',
      estado: 'activo',
      token,
      usuario
    })
  } catch (error) {
    console.error('Error registrarPasajero:', error)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Este número ya está registrado' })
    }
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

module.exports = { registrarConductor, registrarPasajero }
