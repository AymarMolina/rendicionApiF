const { getPool, sql } = require('../config/db')

async function getRendiciones(req, res) {
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('uid', sql.Int, req.user.id)
      .query(`
        SELECT
          r.id                              AS rendicion_id,
          t.id                              AS transferencia_id,
          t.asignacion_id,                  -- ← necesario para cargar actas
          t.codigo                          AS codigo_transferencia,
          t.monto                           AS monto_transferencia,
          t.numero,
          a.num_transferencias,
          m.nivel,
          m.codigo_modular,
          i.nombre                          AS nombre_institucion,
          c.nombre                          AS ciclo,
          COALESCE(r.efectivo_en_caja, 0)   AS efectivo_en_caja,
          COALESCE(
            (SELECT SUM(g.monto)
             FROM EQRENDICION.PAE_GASTOS g
             JOIN EQRENDICION.PAE_COMPROBANTES cp ON cp.id = g.comprobante_id
             WHERE cp.transferencia_id = t.id), 0
          )                                 AS total_gastos_registrados,
          t.monto - COALESCE(
            (SELECT SUM(g.monto)
             FROM EQRENDICION.PAE_GASTOS g
             JOIN EQRENDICION.PAE_COMPROBANTES cp ON cp.id = g.comprobante_id
             WHERE cp.transferencia_id = t.id), 0
          ) - COALESCE(r.efectivo_en_caja, 0) AS saldo,
          COALESCE(r.estado, 'sin_rendicion') AS estado,
          r.enviada_en,
          r.aprobada_en,
          ut.nombres + ' ' + ut.apellidos   AS tesorero
        FROM EQRENDICION.PAE_TRANSFERENCIAS    t
        JOIN EQRENDICION.PAE_ASIGNACIONES      a  ON a.id  = t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS           m  ON m.id  = a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES     i  ON i.id  = m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS            c  ON c.id  = a.ciclo_id
        JOIN EQRENDICION.PAE_ATC_INSTITUCION   ai ON ai.institucion_id = i.id
                                                  AND ai.usuario_id = @uid
                                                  AND ai.activo = 1
        LEFT JOIN EQRENDICION.PAE_RENDICIONES  r  ON r.transferencia_id = t.id
        LEFT JOIN EQRENDICION.PAE_TESORERO_MODULO tm ON tm.modulo_id = m.id AND tm.activo = 1
        LEFT JOIN EQRENDICION.PAE_USUARIOS     ut ON ut.id = tm.usuario_id
        ORDER BY
          CASE COALESCE(r.estado, 'sin_rendicion')
            WHEN 'enviada'       THEN 1
            WHEN 'observada'     THEN 2
            WHEN 'borrador'      THEN 3
            WHEN 'sin_rendicion' THEN 4
            WHEN 'aprobada'      THEN 5
          END,
          r.enviada_en DESC
      `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR getRendiciones ATC:', err.message)
    res.status(500).json({ error: 'Error al obtener rendiciones' })
  }
}

async function getInstituciones(req, res) {
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('uid', sql.Int, req.user.id)
      .query(`
        SELECT
          i.id, i.codigo, i.nombre, i.ugel, i.distrito,
          COUNT(DISTINCT m.id) AS total_modulos,
          COUNT(DISTINCT t.id) AS total_transferencias,
          COUNT(DISTINCT r.id) AS total_rendiciones,
          SUM(CASE WHEN r.estado = 'enviada'  THEN 1 ELSE 0 END) AS pendientes_revision,
          SUM(CASE WHEN r.estado = 'aprobada' THEN 1 ELSE 0 END) AS aprobadas
        FROM EQRENDICION.PAE_ATC_INSTITUCION   ai
        JOIN EQRENDICION.PAE_INSTITUCIONES     i  ON i.id  = ai.institucion_id
        LEFT JOIN EQRENDICION.PAE_MODULOS m ON m.institucion_id = i.id
        LEFT JOIN EQRENDICION.PAE_ASIGNACIONES a  ON a.modulo_id = m.id
        LEFT JOIN EQRENDICION.PAE_TRANSFERENCIAS t ON t.asignacion_id = a.id
        LEFT JOIN EQRENDICION.PAE_RENDICIONES  r  ON r.transferencia_id = t.id
        WHERE ai.usuario_id = @uid AND ai.activo = 1
        GROUP BY i.id, i.codigo, i.nombre, i.ugel, i.distrito
      `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR getInstituciones ATC:', err.message)
    res.status(500).json({ error: 'Error al obtener instituciones' })
  }
}
async function listarATCs(req, res) {
  try {
    const pool   = await getPool()
    const result = await pool.request().query(`
      SELECT
        u.id,
        u.nombres,
        u.apellidos,
        u.email,
        COUNT(ai.id) AS instituciones_asignadas
      FROM EQRENDICION.PAE_USUARIOS u
      LEFT JOIN EQRENDICION.PAE_ATC_INSTITUCION ai
        ON ai.usuario_id = u.id AND ai.activo = 1
      WHERE u.rol_id = (
        SELECT id FROM EQRENDICION.PAE_ROLES WHERE nombre = 'atc'
      )
      AND u.activo = 1
      GROUP BY u.id, u.nombres, u.apellidos, u.email
      ORDER BY u.apellidos, u.nombres
    `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR listarATCs:', err.message)
    res.status(500).json({ error: 'Error al listar ATCs' })
  }
}
 
async function listarAsignaciones(req, res) {
  try {
    const pool   = await getPool()
    const result = await pool.request().query(`
      SELECT
        ai.id,
        ai.usuario_id,
        ai.institucion_id,
        ai.fecha_inicio,
        u.nombres    AS atc_nombres,
        u.apellidos  AS atc_apellidos,
        u.email      AS atc_email,
        i.nombre     AS nombre_institucion,
        i.codigo     AS codigo_ie,
        i.ugel,
        i.distrito
      FROM EQRENDICION.PAE_ATC_INSTITUCION ai
      JOIN EQRENDICION.PAE_USUARIOS        u ON u.id = ai.usuario_id
      JOIN EQRENDICION.PAE_INSTITUCIONES   i ON i.id = ai.institucion_id
      WHERE ai.activo = 1
      ORDER BY i.nombre
    `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR listarAsignaciones:', err.message)
    res.status(500).json({ error: 'Error al listar asignaciones' })
  }
}
async function atcDeInstitucion(req, res) {
  try {
    const pool   = await getPool()
    const instId = parseInt(req.params.institucion_id)
 
    const result = await pool.request()
      .input('instId', sql.Int, instId)
      .query(`
        SELECT
          ai.id,
          ai.usuario_id,
          ai.fecha_inicio,
          u.nombres    AS nombres,
          u.apellidos  AS apellidos,
          u.email
        FROM EQRENDICION.PAE_ATC_INSTITUCION ai
        JOIN EQRENDICION.PAE_USUARIOS u ON u.id = ai.usuario_id
        WHERE ai.institucion_id = @instId
          AND ai.activo = 1
      `)
 
    if (result.recordset.length === 0) {
      return res.status(404).json({ mensaje: 'Sin ATC asignado' })
    }
    res.json(result.recordset[0])
  } catch (err) {
    console.error('ERROR atcDeInstitucion:', err.message)
    res.status(500).json({ error: 'Error al consultar ATC de la institución' })
  }
}
 
async function asignarATC(req, res) {
  const { usuario_id, institucion_id, fecha_inicio, nota } = req.body
 
  if (!usuario_id || !institucion_id || !fecha_inicio) {
    return res.status(400).json({ error: 'usuario_id, institucion_id y fecha_inicio son requeridos' })
  }
 
  const pool = await getPool()
 
  try {
    const rolRes = await pool.request()
      .input('uid', sql.Int, usuario_id)
      .query(`
        SELECT u.id, r.nombre AS rol
        FROM EQRENDICION.PAE_USUARIOS u
        JOIN EQRENDICION.PAE_ROLES r ON r.id = u.rol_id
        WHERE u.id = @uid AND u.activo = 1
      `)
 
    if (!rolRes.recordset[0]) {
      return res.status(404).json({ error: 'Usuario no encontrado' })
    }
    if (rolRes.recordset[0].rol !== 'atc') {
      return res.status(400).json({ error: 'El usuario no tiene rol ATC' })
    }
 
    const instRes = await pool.request()
      .input('iid', sql.Int, institucion_id)
      .query(`SELECT id FROM EQRENDICION.PAE_INSTITUCIONES WHERE id = @iid`)
 
    if (!instRes.recordset[0]) {
      return res.status(404).json({ error: 'Institución no encontrada' })
    }
 
    await pool.request()
      .input('iid', sql.Int, institucion_id)
      .query(`
        UPDATE EQRENDICION.PAE_ATC_INSTITUCION
        SET activo = 0, fecha_fin = CAST(GETDATE() AS DATE)
        WHERE institucion_id = @iid AND activo = 1
      `)
 
    await pool.request()
      .input('uid',     sql.Int,     usuario_id)
      .input('iid',     sql.Int,     institucion_id)
      .input('fi',      sql.Date,    fecha_inicio)
      .query(`
        INSERT INTO EQRENDICION.PAE_ATC_INSTITUCION
          (usuario_id, institucion_id, fecha_inicio, activo)
        VALUES (@uid, @iid, @fi, 1)
      `)
 
    res.json({ ok: true, mensaje: 'ATC asignado correctamente' })
  } catch (err) {
    console.error('ERROR asignarATC:', err.message, err.stack)
    res.status(500).json({ error: 'Error al asignar ATC: ' + err.message })
  }
}
 
async function desvincularATC(req, res) {
  const { usuario_id, institucion_id } = req.body
 
  if (!usuario_id || !institucion_id) {
    return res.status(400).json({ error: 'usuario_id e institucion_id son requeridos' })
  }
 
  try {
    const pool   = await getPool()
    const result = await pool.request()
      .input('uid', sql.Int, usuario_id)
      .input('iid', sql.Int, institucion_id)
      .query(`
        UPDATE EQRENDICION.PAE_ATC_INSTITUCION
        SET activo = 0, fecha_fin = CAST(GETDATE() AS DATE)
        WHERE usuario_id = @uid
          AND institucion_id = @iid
          AND activo = 1
      `)
 
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Asignación no encontrada o ya inactiva' })
    }
 
    res.json({ ok: true, mensaje: 'ATC desvinculado correctamente' })
  } catch (err) {
    console.error('ERROR desvincularATC:', err.message)
    res.status(500).json({ error: 'Error al desvincular ATC' })
  }
}
module.exports = { getRendiciones, getInstituciones , listarATCs,
  listarAsignaciones,
  atcDeInstitucion,
  asignarATC,
  desvincularATC}