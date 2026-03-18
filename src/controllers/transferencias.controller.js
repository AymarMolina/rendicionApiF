const { getPool, sql } = require('../config/db')

async function listar(req, res) {
  try {
    const pool = await getPool()

    const moduloIds = req.user.modulo_ids ?? []
    if (!moduloIds.length) return res.json([])

    const placeholders = moduloIds.map((_, i) => `@mid${i}`).join(',')
    const request = pool.request()
    moduloIds.forEach((id, i) => request.input(`mid${i}`, sql.Int, id))

    const result = await request.query(`
      SELECT
        t.id,
        t.asignacion_id,
        t.codigo,
        t.numero,                        -- Nro de esta transferencia (1, 2, 3, 4)
        a.num_transferencias,            -- Total de transferencias de la asignación
        t.monto,
        t.fecha_envio,
        t.fecha_recepcion,
        t.estado,
        -- Ciclo
        c.nombre            AS ciclo,
        c.anio,
        c.mes,
        -- Módulo / nivel — cada transferencia es de UN nivel
        m.id                AS modulo_id,
        m.codigo_modular,
        m.nivel,
        m.nombre            AS nombre_modulo,
        -- Institución
        i.id                AS institucion_id,
        i.nombre            AS institucion,
        i.codigo            AS codigo_ie,
        i.ugel,
        i.distrito,
        -- Presupuestos de la asignación (por rubro, para ese nivel)
        a.monto_total,
        a.presup_alimentos,
        a.presup_transporte,
        a.presup_gas,
        a.presup_estipendio,
        a.presup_limpieza,
        a.presup_otros,
        -- Total gastado en esta transferencia
        COALESCE(SUM(g.monto), 0) AS total_gastado
      FROM EQRENDICION.PAE_TRANSFERENCIAS t
      JOIN EQRENDICION.PAE_ASIGNACIONES   a  ON a.id  = t.asignacion_id
      JOIN EQRENDICION.PAE_CICLOS         c  ON c.id  = a.ciclo_id
      JOIN EQRENDICION.PAE_MODULOS        m  ON m.id  = a.modulo_id
      JOIN EQRENDICION.PAE_INSTITUCIONES  i  ON i.id  = m.institucion_id
      LEFT JOIN EQRENDICION.PAE_COMPROBANTES cp ON cp.transferencia_id = t.id
      LEFT JOIN EQRENDICION.PAE_GASTOS       g  ON g.comprobante_id   = cp.id
      WHERE a.modulo_id IN (${placeholders})
      GROUP BY
        t.id, t.asignacion_id, t.codigo, t.numero, a.num_transferencias,
        t.monto, t.fecha_envio, t.fecha_recepcion, t.estado,
        c.nombre, c.anio, c.mes,
        m.id, m.codigo_modular, m.nivel, m.nombre,
        i.id, i.nombre, i.codigo, i.ugel, i.distrito,
        a.monto_total, a.presup_alimentos, a.presup_transporte, a.presup_gas,
        a.presup_estipendio, a.presup_limpieza, a.presup_otros
      ORDER BY t.id DESC
    `)

    const rows = result.recordset.map(t => ({
      ...t,
      saldo: t.monto - t.total_gastado,
      rubros: {
        alimentos:  t.presup_alimentos,
        transporte: t.presup_transporte,
        gas:        t.presup_gas,
        estipendio: t.presup_estipendio,
        limpieza:   t.presup_limpieza,
        otros:      t.presup_otros,
      }
    }))

    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener transferencias' })
  }
}

async function rubros(req, res) {
  const { id } = req.params
  try {
    const pool   = await getPool()
    const result = await pool.request()
      .input('transf_id', sql.Int, parseInt(id))
      .query(`
        SELECT
          g.rubro,
          SUM(g.monto) AS total_gastado,
          CASE g.rubro
            WHEN 'alimentos'  THEN a.presup_alimentos
            WHEN 'transporte' THEN a.presup_transporte
            WHEN 'gas'        THEN a.presup_gas
            WHEN 'estipendio' THEN a.presup_estipendio
            WHEN 'limpieza'   THEN a.presup_limpieza
            WHEN 'otros'      THEN a.presup_otros
          END AS presupuesto_rubro,
          CASE g.rubro
            WHEN 'alimentos'  THEN a.presup_alimentos
            WHEN 'transporte' THEN a.presup_transporte
            WHEN 'gas'        THEN a.presup_gas
            WHEN 'estipendio' THEN a.presup_estipendio
            WHEN 'limpieza'   THEN a.presup_limpieza
            WHEN 'otros'      THEN a.presup_otros
          END - SUM(g.monto) AS saldo_rubro
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES   cp ON cp.id = g.comprobante_id
        JOIN EQRENDICION.PAE_TRANSFERENCIAS t  ON t.id  = cp.transferencia_id
        JOIN EQRENDICION.PAE_ASIGNACIONES   a  ON a.id  = t.asignacion_id
        WHERE cp.transferencia_id = @transf_id
        GROUP BY g.rubro,
          a.presup_alimentos, a.presup_transporte, a.presup_gas,
          a.presup_estipendio, a.presup_limpieza, a.presup_otros
        ORDER BY
          CASE g.rubro
            WHEN 'alimentos'  THEN 1
            WHEN 'transporte' THEN 2
            WHEN 'gas'        THEN 3
            WHEN 'estipendio' THEN 4
            WHEN 'limpieza'   THEN 5
            ELSE 6
          END
      `)
    res.json(result.recordset)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener rubros' })
  }
}

module.exports = { listar, rubros }