const router = require('express').Router()
const bcrypt = require('bcryptjs')
const { getPool, sql } = require('../config/db')
const { login, me, register } = require('../controllers/auth.controller')
const auth  = require('../middlewares/auth')
const roles = require('../middlewares/roles')

router.post('/login',    login)
router.get('/me',        auth, me)
router.post('/register', auth, roles('coordinador_administrativo'), register)

router.post('/debug-login', async (req, res) => {
  const { email, password } = req.body
  const pool   = await getPool()
  const result = await pool.request()
    .input('email', sql.VarChar, email)
    .query(`SELECT email, password_hash FROM EQRENDICION.PAE_USUARIOS WHERE email = @email`)

  const user = result.recordset[0]
  if (!user) return res.json({ error: 'Usuario no encontrado en BD' })

  const match = await bcrypt.compare(password, user.password_hash)
  res.json({
    email:              user.email,
    hash_en_bd:         user.password_hash,
    password_ingresado: password,
    bcrypt_match:       match
  })
})

router.post('/crear-usuarios-prueba', async (req, res) => {
  const hash = await bcrypt.hash('Pae2026@', 10)
  const pool = await getPool()
  await pool.request()
    .input('hash', sql.VarChar, hash)
    .query(`
      UPDATE EQRENDICION.PAE_USUARIOS
      SET password_hash = @hash
      WHERE id IN (1, 2, 3, 4, 5, 6, 7)
    `)
  res.json({ message: 'Passwords actualizados', password: 'Pae2026@', hash })
})

router.post('/crear-usuario-directo', async (req, res) => {
  const { nombres, apellidos, email, password, rol_id } = req.body
  if (!nombres || !apellidos || !email || !password || !rol_id)
    return res.status(400).json({ error: 'Todos los campos son obligatorios' })

  const rolIdNum = parseInt(rol_id)
  if (![1, 2, 3].includes(rolIdNum))
    return res.status(400).json({
      error: 'rol_id inválido',
      valores_permitidos: { 1: 'coordinador_administrativo', 2: 'atc', 3: 'tesorero' }
    })

  try {
    const pool   = await getPool()
    const existe = await pool.request()
      .input('email', sql.VarChar, email)
      .query(`SELECT id FROM EQRENDICION.PAE_USUARIOS WHERE email = @email`)

    if (existe.recordset[0])
      return res.status(409).json({ error: 'El email ya está registrado' })

    const hash   = await bcrypt.hash(password, 10)
    const result = await pool.request()
      .input('rol_id',    sql.TinyInt, rolIdNum)
      .input('nombres',   sql.VarChar, nombres)
      .input('apellidos', sql.VarChar, apellidos)
      .input('email',     sql.VarChar, email)
      .input('hash',      sql.VarChar, hash)
      .query(`
        INSERT INTO EQRENDICION.PAE_USUARIOS
          (rol_id, nombres, apellidos, email, password_hash)
        OUTPUT INSERTED.id, INSERTED.nombres, INSERTED.apellidos,
               INSERTED.email, INSERTED.rol_id
        VALUES (@rol_id, @nombres, @apellidos, @email, @hash)
      `)

    res.status(201).json({
      message: 'Usuario creado',
      user:    result.recordset[0],
      nota:    rol_id == 3
        ? 'Tesorero creado. Asigna sus módulos en PAE_TESORERO_MODULO para que aparezcan en la app.'
        : 'Usuario creado correctamente.'
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear usuario' })
  }
})
router.post('/dev/reset-passwords', async (req, res) => {
  const bcrypt = require('bcryptjs')
  const { getPool, sql } = require('../config/db')
  const hash = await bcrypt.hash(req.body.password, 10)
  const pool = await getPool()
  const r    = await pool.request()
    .input('hash', sql.VarChar, hash)
    .query(`UPDATE EQRENDICION.PAE_USUARIOS SET password_hash = @hash WHERE activo = 1`)
  res.json({ ok: true, actualizados: r.rowsAffected[0] })
})
module.exports = router