const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')
const { getPool, sql } = require('../config/db')

async function login(req, res) {
  const { email, password } = req.body
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos' })

  try {
    const pool = await getPool()

    const result = await pool.request()
      .input('email', sql.VarChar, email)
      .query(`
        SELECT u.id, u.nombres, u.apellidos, u.email, u.password_hash,
               u.activo, r.nombre AS rol
        FROM EQRENDICION.PAE_USUARIOS u
        JOIN EQRENDICION.PAE_ROLES r ON r.id = u.rol_id
        WHERE u.email = @email
      `)

    const user = result.recordset[0]
    if (!user)        return res.status(401).json({ error: 'Credenciales inválidas' })
    if (!user.activo) return res.status(403).json({ error: 'Usuario inactivo' })

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' })

    let modulos = []
    if (user.rol === 'tesorero') {
      const modResult = await pool.request()
        .input('usuario_id', sql.Int, user.id)
        .query(`
          SELECT
            m.id              AS modulo_id,
            m.codigo_modular,
            m.nivel,
            m.nombre          AS nombre_modulo,
            i.id              AS institucion_id,
            i.nombre          AS nombre_institucion,
            i.codigo          AS codigo_ie,
            i.ugel,
            i.distrito
          FROM EQRENDICION.PAE_TESORERO_MODULO tm
          JOIN EQRENDICION.PAE_MODULOS       m ON m.id = tm.modulo_id
          JOIN EQRENDICION.PAE_INSTITUCIONES i ON i.id = m.institucion_id
          WHERE tm.usuario_id = @usuario_id
            AND tm.activo = 1
          ORDER BY
            CASE m.nivel
              WHEN 'inicial'    THEN 1
              WHEN 'primaria'   THEN 2
              WHEN 'secundaria' THEN 3
            END
        `)
      modulos = modResult.recordset
    }

    const tokenPayload = {
      id:        user.id,
      nombres:   user.nombres,
      apellidos: user.apellidos,
      rol:       user.rol,
      ...(user.rol === 'tesorero' && {
        modulo_ids:     modulos.map(m => m.modulo_id),
        institucion_id: modulos[0]?.institucion_id ?? null
      })
    }

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || '8h' }
    )

    const userResponse = {
      id:        user.id,
      nombres:   user.nombres,
      apellidos: user.apellidos,
      rol:       user.rol,
      ...(user.rol === 'tesorero' && {
        modulos,
        institucion_id:     modulos[0]?.institucion_id     ?? null,
        nombre_institucion: modulos[0]?.nombre_institucion ?? '',
        codigo_ie:          modulos[0]?.codigo_ie          ?? '',
        ugel:               modulos[0]?.ugel               ?? '',
        distrito:           modulos[0]?.distrito           ?? '',
      })
    }

    res.json({ token, user: userResponse })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
}

async function register(req, res) {
  const { nombres, apellidos, email, password, rol_id } = req.body
  if (!nombres || !apellidos || !email || !password || !rol_id)
    return res.status(400).json({ error: 'Todos los campos son obligatorios' })

  try {
    const pool   = await getPool()
    const existe = await pool.request()
      .input('email', sql.VarChar, email)
      .query(`SELECT id FROM EQRENDICION.PAE_USUARIOS WHERE email = @email`)

    if (existe.recordset[0])
      return res.status(409).json({ error: 'El email ya está registrado' })

    const hash   = await bcrypt.hash(password, 10)
    const result = await pool.request()
      .input('rol_id',    sql.TinyInt, parseInt(rol_id))
      .input('nombres',   sql.VarChar, nombres)
      .input('apellidos', sql.VarChar, apellidos)
      .input('email',     sql.VarChar, email)
      .input('hash',      sql.VarChar, hash)
      .query(`
        INSERT INTO EQRENDICION.PAE_USUARIOS
          (rol_id, nombres, apellidos, email, password_hash)
        OUTPUT INSERTED.id, INSERTED.nombres, INSERTED.apellidos, INSERTED.email
        VALUES (@rol_id, @nombres, @apellidos, @email, @hash)
      `)

    res.status(201).json({ message: 'Usuario creado correctamente', user: result.recordset[0] })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al crear usuario' })
  }
}

async function me(req, res) {
  res.json({ user: req.user })
}

module.exports = { login, me, register }