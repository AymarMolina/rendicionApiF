const router = require('express').Router()
const { login, me, register } = require('../controllers/auth.controller')
const auth  = require('../middlewares/auth')
const roles = require('../middlewares/roles')

router.post('/login',    login)
router.get('/me',        auth, me)
router.post('/register', auth, roles('coordinador_administrativo'), register)
router.post('/debug-login', async (req, res) => {
  const bcrypt = require('bcryptjs')
  const { getPool, sql } = require('../config/db')
  const { email, password } = req.body

  const pool = await getPool()
  const result = await pool.request()
    .input('email', sql.VarChar, email)
    .query(`SELECT email, password_hash FROM EQRENDICION.PAE_USUARIOS WHERE email = @email`)

  const user = result.recordset[0]
  if (!user) return res.json({ error: 'Usuario no encontrado en BD' })

  const match = await bcrypt.compare(password, user.password_hash)
  res.json({
    email: user.email,
    hash_en_bd: user.password_hash,
    password_ingresado: password,
    bcrypt_match: match
  })
})
router.post('/crear-usuarios-prueba', async (req, res) => {
  const bcrypt = require('bcryptjs')
  const { getPool, sql } = require('../config/db')

  const hash = await bcrypt.hash('Pae2026@', 10)
  const pool = await getPool()

  await pool.request()
    .input('hash', sql.VarChar, hash)
    .query(`
      UPDATE EQRENDICION.PAE_USUARIOS
      SET password_hash = @hash
      WHERE id IN (1, 2, 3, 4, 5, 6)
    `)

  res.json({ message: 'Passwords actualizados', password: 'Pae2026@', hash })
})
module.exports = router