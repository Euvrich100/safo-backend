const { Pool } = require('pg')
require('dotenv').config()

// Pool de conexiones a PostgreSQL
// Reutiliza conexiones en vez de abrir una nueva por cada petición
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,               // máximo 10 conexiones simultáneas
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

// Verificar conexión al iniciar
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message)
  } else {
    console.log('✅ Conectado a PostgreSQL — base de datos SafO')
    release()
  }
})

// Función helper para ejecutar queries
// Uso: const result = await query('SELECT * FROM usuarios WHERE id = $1', [id])
const query = (text, params) => pool.query(text, params)

module.exports = { query, pool }
