require('dotenv').config()
const { getPool } = require('./src/config/db')

async function test() {
  try {
    console.log('Intentando conectar a:', process.env.DB_SERVER)
    const pool = await getPool()
    const result = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM EQRENDICION.PAE_USUARIOS)      AS usuarios,
        (SELECT COUNT(*) FROM EQRENDICION.PAE_TRANSFERENCIAS) AS transferencias,
        (SELECT COUNT(*) FROM EQRENDICION.PAE_GASTOS)         AS gastos,
        (SELECT COUNT(*) FROM EQRENDICION.PAE_RENDICIONES)    AS rendiciones
    `)
    console.log('Conexion exitosa. Registros en BD:')
    console.table(result.recordset)
    process.exit(0)
  } catch (err) {
    console.error('Error de conexion:', err.message)
    process.exit(1)
  }
}
test()
