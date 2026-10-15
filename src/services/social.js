const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { OAuth2Client } = require('google-auth-library')

// Verificación de identidad con proveedores externos. Cada función recibe lo que
// entrega el navegador y devuelve { id, email, nombre } ya verificado, o null.
// Nada de lo que manda el cliente se acepta sin comprobar la firma / el token
// directamente con el proveedor.

const PROVEEDORES = ['google', 'apple', 'facebook']

// Qué proveedores están configurados en el servidor (para no ofrecer los que no)
const proveedoresActivos = () => ({
  google: !!process.env.GOOGLE_CLIENT_ID,
  apple: !!process.env.APPLE_CLIENT_ID,
  facebook: !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET)
})

// ── Google ──
let googleClient = null
const verificarGoogle = async (credential) => {
  if (!process.env.GOOGLE_CLIENT_ID || !credential) return null
  try {
    googleClient = googleClient || new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID })
    const p = ticket.getPayload()
    if (!p?.sub || !p.email_verified) return null
    return { id: p.sub, email: p.email.toLowerCase(), nombre: p.name || '' }
  } catch {
    return null
  }
}

// ── Apple ("Iniciar sesión con Apple") ──
// El navegador entrega un id_token (JWT firmado por Apple). Se valida la firma
// con las llaves públicas de Apple, el emisor y que el token sea para SafO.
const APPLE_JWKS_URL = () => process.env.APPLE_JWKS_URL || 'https://appleid.apple.com/auth/keys'
let jwksCache = { llaves: null, hasta: 0 }
const llavesApple = async (forzar = false) => {
  if (!forzar && jwksCache.llaves && Date.now() < jwksCache.hasta) return jwksCache.llaves
  const r = await fetch(APPLE_JWKS_URL(), { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error('JWKS ' + r.status)
  const { keys } = await r.json()
  jwksCache = { llaves: keys, hasta: Date.now() + 60 * 60 * 1000 }
  return keys
}
const verificarApple = async (idToken, nombreCliente = '') => {
  if (!process.env.APPLE_CLIENT_ID || typeof idToken !== 'string') return null
  try {
    const decod = jwt.decode(idToken, { complete: true })
    if (!decod || decod.header.alg !== 'RS256') return null
    let llave = (await llavesApple()).find(k => k.kid === decod.header.kid)
    if (!llave) llave = (await llavesApple(true)).find(k => k.kid === decod.header.kid) // Apple rotó llaves
    if (!llave) return null
    const publica = crypto.createPublicKey({ key: llave, format: 'jwk' })
    const p = jwt.verify(idToken, publica, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: process.env.APPLE_CLIENT_ID
    })
    if (!p.sub) return null
    const verificado = p.email_verified === true || p.email_verified === 'true'
    return { id: p.sub, email: p.email && verificado ? String(p.email).toLowerCase() : null, nombre: String(nombreCliente || '').trim() }
  } catch {
    return null
  }
}

// ── Facebook ──
// El navegador entrega un access_token. Se confirma con Facebook (debug_token)
// que fue emitido para la app de SafO y luego se lee el perfil.
const GRAPH = () => (process.env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v19.0').replace(/\/$/, '')
const verificarFacebook = async (accessToken) => {
  const { FACEBOOK_APP_ID: appId, FACEBOOK_APP_SECRET: secreto } = process.env
  if (!appId || !secreto || typeof accessToken !== 'string' || accessToken.length < 10) return null
  try {
    const dbg = await fetch(`${GRAPH()}/debug_token?` + new URLSearchParams({ input_token: accessToken, access_token: `${appId}|${secreto}` }), { signal: AbortSignal.timeout(8000) })
    const d = (await dbg.json())?.data
    if (!d?.is_valid || String(d.app_id) !== String(appId) || !d.user_id) return null
    const me = await fetch(`${GRAPH()}/me?` + new URLSearchParams({ fields: 'id,name,email', access_token: accessToken }), { signal: AbortSignal.timeout(8000) })
    const p = await me.json()
    if (!p?.id || String(p.id) !== String(d.user_id)) return null
    return { id: String(p.id), email: p.email ? String(p.email).toLowerCase() : null, nombre: p.name || '' }
  } catch {
    return null
  }
}

const verificar = (proveedor, credential, nombreCliente) => {
  if (proveedor === 'google') return verificarGoogle(credential)
  if (proveedor === 'apple') return verificarApple(credential, nombreCliente)
  if (proveedor === 'facebook') return verificarFacebook(credential)
  return Promise.resolve(null)
}

module.exports = { PROVEEDORES, proveedoresActivos, verificar, verificarGoogle }
