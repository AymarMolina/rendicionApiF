const { getPool, sql } = require('../config/db')

async function getAll(req, res) {
  try {
    const pool = await getPool()
    const { rol, id: userId } = req.user

    let query = `
      SELECT t.id, t.codigo, t.numero, t.monto, t.fecha_envio, t.fecha_recepcion,
             t.estado, t.asignacion_id,
             i.nombre AS institucion, i.codigo AS cod_ie,
             c.nombre AS ciclo, c.anio, c.mes,
             a.presup_alimentos, a.presup_transporte, a.presup_gas,
             a.presup_estipendio, a.presup_limpieza, a.presup_otros,
             COALESCE((
               SELECT SUM(g.monto) FROM EQRENDICION.PAE_GASTOS g
               WHERE g.transferencia_id = t.id
             ), 0) AS total_gastado
      FROM EQRENDICION.PAE_TRANSFERENCIAS t
      JOIN EQRENDICION.PAE_ASIGNACIONES a   ON a.id = t.asignacion_id
      JOIN EQRENDICION.PAE_INSTITUCIONES i  ON i.id = a.institucion_id
      JOIN EQRENDICION.PAE_CICLOS c         ON c.id = a.ciclo_id
    `

    if (rol === 'tesorero') {
      query += ` WHERE i.tesorero_id = @userId`
    }

    query += ` ORDER BY t.id DESC`

    const req2 = pool.request().input('userId', sql.Int, userId)
    const result = await req2.query(query)

    const rows = result.recordset.map(r => ({
      ...r,
      saldo: r.monto - r.total_gastado,
      rubros: {
        alimentos:  r.presup_alimentos,
        transporte: r.presup_transporte,
        gas:        r.presup_gas,
        estipendio: r.presup_estipendio,
        limpieza:   r.presup_limpieza,
        otros:      r.presup_otros,
      }
    }))

    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener transferencias' })
  }
}

async function getOne(req, res) {
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT t.*, i.nombre AS institucion, i.codigo AS cod_ie,
               c.nombre AS ciclo,
               a.presup_alimentos, a.presup_transporte, a.presup_gas,
               a.presup_estipendio, a.presup_limpieza, a.presup_otros
        FROM EQRENDICION.PAE_TRANSFERENCIAS t
        JOIN EQRENDICION.PAE_ASIGNACIONES a  ON a.id = t.asignacion_id
        JOIN EQRENDICION.PAE_INSTITUCIONES i ON i.id = a.institucion_id
        JOIN EQRENDICION.PAE_CICLOS c        ON c.id = a.ciclo_id
        WHERE t.id = @id
      `)
    if (!result.recordset[0]) return res.status(404).json({ error: 'No encontrada' })
    res.json(result.recordset[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener transferencia' })
  }
}

async function getRubros(req, res) {
  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT rubro, total_gastado, presupuesto_rubro, saldo_rubro
        FROM EQRENDICION.V_GASTO_X_RUBRO
        WHERE transferencia_id = @id
      `)
    res.json(result.recordset)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener rubros' })
  }
}

async function cambiarEstado(req, res) {
  const { estado } = req.body
  const validos = ['pendiente','enviada','recibida','en_rendicion','rendida','observada','aprobada']
  if (!validos.includes(estado))
    return res.status(400).json({ error: 'Estado inválido' })

  try {
    const pool = await getPool()
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('estado', sql.VarChar, estado)
      .query(`UPDATE EQRENDICION.PAE_TRANSFERENCIAS SET estado = @estado WHERE id = @id`)
    res.json({ message: 'Estado actualizado' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al actualizar estado' })
  }
}

module.exports = { getAll, getOne, getRubros, cambiarEstado }
