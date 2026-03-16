const { getPool, sql } = require('../config/db')

async function getByTransferencia(req, res) {
  try {
    const pool = await getPool()

    const resumen = await pool.request()
      .input('tid', sql.Int, req.params.transferencia_id)
      .query(`
        SELECT 
          r.id                          AS rendicion_id,
          t.id                          AS transferencia_id,
          t.codigo                      AS codigo_transferencia,
          t.monto                       AS monto_transferencia,
          COALESCE(r.efectivo_en_caja, 0)  AS efectivo_en_caja,
          COALESCE(
            (SELECT SUM(g.monto) FROM EQRENDICION.PAE_GASTOS g WHERE g.transferencia_id = t.id),
            0
          )                             AS total_gastos_registrados,
          COALESCE(r.estado, 'borrador')   AS estado,
          r.enviada_en
        FROM EQRENDICION.PAE_TRANSFERENCIAS t
        LEFT JOIN EQRENDICION.PAE_RENDICIONES r ON r.transferencia_id = t.id
        WHERE t.id = @tid
      `)

    const gastos = await pool.request()
      .input('tid', sql.Int, req.params.transferencia_id)
      .query(`
        SELECT g.*, u.nombres + ' ' + u.apellidos AS registrado_nombre,
               dj.nombre_proveedor, dj.dni_proveedor,
               pm.punto_partida, pm.punto_llegada
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_USUARIOS u ON u.id = g.registrado_por
        LEFT JOIN EQRENDICION.PAE_DECL_JURADAS dj ON dj.gasto_id = g.id
        LEFT JOIN EQRENDICION.PAE_PLAN_MOVILIDAD pm ON pm.gasto_id = g.id
        WHERE g.transferencia_id = @tid
        ORDER BY g.fecha_documento, g.id
      `)

    const observaciones = await pool.request()
      .input('tid', sql.Int, req.params.transferencia_id)
      .query(`
        SELECT o.*, u.nombres + ' ' + u.apellidos AS autor, r2.nombre AS rol
        FROM EQRENDICION.PAE_REND_OBSERVACIONES o
        JOIN EQRENDICION.PAE_USUARIOS u ON u.id = o.usuario_id
        JOIN EQRENDICION.PAE_ROLES r2 ON r2.id = u.rol_id
        WHERE o.rendicion_id = (
          SELECT id FROM EQRENDICION.PAE_RENDICIONES WHERE transferencia_id = @tid
        )
        ORDER BY o.creado_en
      `)

    res.json({
      resumen: resumen.recordset[0] || null,
      gastos: gastos.recordset,
      observaciones: observaciones.recordset
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener rendición' })
  }
}

async function upsert(req, res) {
  const { transferencia_id, efectivo_en_caja, observaciones } = req.body
  if (!transferencia_id) return res.status(400).json({ error: 'transferencia_id requerido' })

  try {
    const pool = await getPool()

    const existing = await pool.request()
      .input('tid', sql.Int, transferencia_id)
      .query(`SELECT id, estado FROM EQRENDICION.PAE_RENDICIONES WHERE transferencia_id = @tid`)

    if (existing.recordset[0]) {
      const r = existing.recordset[0]
      if (r.estado === 'aprobada')
        return res.status(400).json({ error: 'La rendición ya está aprobada y no puede modificarse' })

      await pool.request()
        .input('id',    sql.Int,        r.id)
        .input('caja',  sql.Decimal(10,2), parseFloat(efectivo_en_caja) || 0)
        .input('obs',   sql.NVarChar,   observaciones || null)
        .query(`
          UPDATE EQRENDICION.PAE_RENDICIONES
          SET efectivo_en_caja = @caja, observaciones = @obs
          WHERE id = @id
        `)
      return res.json({ message: 'Rendición actualizada', rendicion_id: r.id })
    }

    const totResult = await pool.request()
      .input('tid', sql.Int, transferencia_id)
      .query(`
        SELECT t.monto,
               COALESCE((SELECT SUM(monto) FROM EQRENDICION.PAE_GASTOS WHERE transferencia_id = @tid), 0) AS gastado
        FROM EQRENDICION.PAE_TRANSFERENCIAS t WHERE t.id = @tid
      `)
    const { monto, gastado } = totResult.recordset[0]
    const saldoFinal = monto - gastado - (parseFloat(efectivo_en_caja) || 0)

    const insert = await pool.request()
      .input('tid',    sql.Int,         transferencia_id)
      .input('caja',   sql.Decimal(10,2), parseFloat(efectivo_en_caja) || 0)
      .input('saldo',  sql.Decimal(10,2), saldoFinal)
      .input('obs',    sql.NVarChar,    observaciones || null)
      .input('uid',    sql.Int,         req.user.id)
      .query(`
        INSERT INTO EQRENDICION.PAE_RENDICIONES
          (transferencia_id, efectivo_en_caja, saldo_final, observaciones, creado_por)
        OUTPUT INSERTED.id
        VALUES (@tid, @caja, @saldo, @obs, @uid)
      `)

    res.status(201).json({
      message: 'Rendición creada',
      rendicion_id: insert.recordset[0].id
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al guardar rendición' })
  }
}

async function enviar(req, res) {
  try {
    const pool = await getPool()
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        UPDATE EQRENDICION.PAE_RENDICIONES
        SET estado = 'enviada', enviada_en = GETDATE()
        WHERE id = @id AND estado IN ('borrador', 'observada')
      `)
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        UPDATE EQRENDICION.PAE_TRANSFERENCIAS
        SET estado = 'en_rendicion'
        WHERE id = (SELECT transferencia_id FROM EQRENDICION.PAE_RENDICIONES WHERE id = @id)
      `)
    res.json({ message: 'Rendición enviada al ATC' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al enviar rendición' })
  }
}

async function aprobar(req, res) {
  try {
    const pool = await getPool()
    await pool.request()
      .input('id',  sql.Int, req.params.id)
      .input('uid', sql.Int, req.user.id)
      .query(`
        UPDATE EQRENDICION.PAE_RENDICIONES
        SET estado = 'aprobada', aprobada_por = @uid, aprobada_en = GETDATE()
        WHERE id = @id AND estado = 'enviada'
      `)
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        UPDATE EQRENDICION.PAE_TRANSFERENCIAS SET estado = 'aprobada'
        WHERE id = (SELECT transferencia_id FROM EQRENDICION.PAE_RENDICIONES WHERE id = @id)
      `)
    res.json({ message: 'Rendición aprobada' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al aprobar rendición' })
  }
}

async function observar(req, res) {
  const { comentario } = req.body
  if (!comentario) return res.status(400).json({ error: 'Comentario requerido' })

  try {
    const pool = await getPool()
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`UPDATE EQRENDICION.PAE_RENDICIONES SET estado = 'observada' WHERE id = @id`)

    await pool.request()
      .input('rid', sql.Int, req.params.id)
      .input('uid', sql.Int, req.user.id)
      .input('com', sql.NVarChar, comentario)
      .query(`
        INSERT INTO EQRENDICION.PAE_REND_OBSERVACIONES (rendicion_id, usuario_id, comentario)
        VALUES (@rid, @uid, @com)
      `)
    res.json({ message: 'Rendición observada' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al observar rendición' })
  }
}

module.exports = { getByTransferencia, upsert, enviar, aprobar, observar }
