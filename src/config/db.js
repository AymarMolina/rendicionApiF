const sql = require('mssql')
require('dotenv').config()

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT) || 1433,
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_CERT === 'true',
    enableArithAbort: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
}

let pool = null

async function getPool() {
  if (!pool) {
    pool = await new sql.ConnectionPool(config).connect()
    console.log('Conectado a SQL Server:', process.env.DB_SERVER)
  }
  return pool
}

module.exports = { getPool, sql }
