const router  = require('express').Router()
const { getPool, sql } = require('../config/db')
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
 
const coord = [auth, roles('coordinador_administrativo')]
 
router.get('/tesoreros', ...coord, async (req, res) => {
  try {
    const pool   = await getPool()
    const result = await pool.request().query(`
      SELECT
        u.id,
        u.nombres,
        u.apellidos,
        u.email,
        COUNT(tm.id) AS modulos_asignados
      FROM EQRENDICION.PAE_USUARIOS u
      LEFT JOIN EQRENDICION.PAE_TESORERO_MODULO tm
        ON tm.usuario_id = u.id AND tm.activo = 1
      WHERE u.rol_id = (
        SELECT id FROM EQRENDICION.PAE_ROLES WHERE nombre = 'tesorero'
      )
      AND u.activo = 1
      GROUP BY u.id, u.nombres, u.apellidos, u.email
      ORDER BY u.apellidos, u.nombres
    `)
    res.json(result.recordset)
  } catch (err) {
    res.status(500).json({ error: 'Error al listar tesoreros' })
  }
})
 
module.exports = router