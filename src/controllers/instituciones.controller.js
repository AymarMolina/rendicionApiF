const { getPool, sql } = require('../config/db')
 
async function listar(req, res) {
  try {
    const pool   = await getPool()
    const result = await pool.request().query(`
      SELECT id, codigo, nombre, ugel, distrito
      FROM EQRENDICION.PAE_INSTITUCIONES
      ORDER BY nombre
    `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR listarInstituciones:', err.message)
    res.status(500).json({ error: 'Error al listar instituciones' })
  }
}
 
async function buscar(req, res) {
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.json([])
  try {
    const pool   = await getPool()
    const result = await pool.request()
      .input('term', sql.VarChar, `%${q}%`)
      .query(`
        SELECT TOP 15 id, codigo, nombre, ugel, distrito
        FROM EQRENDICION.PAE_INSTITUCIONES
        WHERE codigo LIKE @term OR nombre LIKE @term
        ORDER BY nombre
      `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR buscarInstituciones:', err.message)
    res.status(500).json({ error: 'Error en búsqueda' })
  }
}
 
module.exports = { listar, buscar }