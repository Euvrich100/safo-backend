require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

// Corre las migraciones de migrations/*.sql que todavía no se hayan
// aplicado a esta base de datos, en orden y cada una en su propia
// transacción. Seguro de correr varias veces — lo ya aplicado se salta.
//
// Uso: npm run migrate

const MIGRATIONS_DIR = path.join(__dirname, '../migrations')

const migrar = async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        nombre      VARCHAR(255) PRIMARY KEY,
        aplicada_en TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `)

    const archivos = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort()

    const { rows } = await client.query('SELECT nombre FROM schema_migrations')
    const aplicadas = new Set(rows.map(r => r.nombre))

    let pendientes = 0

    for (const archivo of archivos) {
      if (aplicadas.has(archivo)) {
        console.log(`⏭  ${archivo} (ya aplicada)`)
        continue
      }

      pendientes++
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, archivo), 'utf8')
      console.log(`▶  Aplicando ${archivo}...`)

      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (nombre) VALUES ($1)', [archivo])
        await client.query('COMMIT')
        console.log(`✅ ${archivo}`)
      } catch (error) {
        await client.query('ROLLBACK')
        console.error(`❌ Error en ${archivo}:`, error.message)
        process.exitCode = 1
        return
      }
    }

    console.log(pendientes === 0 ? '\n🎉 Ya estaba todo al día' : `\n🎉 ${pendientes} migración(es) aplicada(s)`)
  } finally {
    client.release()
    await pool.end()
  }
}

migrar()
