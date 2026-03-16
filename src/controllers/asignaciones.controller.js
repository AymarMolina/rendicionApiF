const { getPool, sql } = require('../config/db')

async function getAll(req, res) {
  try {
    const pool = await getPool()
    const result = await pool.request().query(`
      SELECT a.*, c.nombre AS ciclo, c.anio, c.mes,
             i.nombre AS institucion, i.codigo AS cod_ie,
             u.nombres + ' ' + u.apellidos AS coordinador
      FROM EQRENDICION.PAE_ASIGNACIONES a
      JOIN EQRENDICION.PAE_CICLOS        c ON c.id = a.ciclo_id
      JOIN EQRENDICION.PAE_INSTITUCIONES i ON i.id = a.institucion_id
      JOIN EQRENDICION.PAE_USUARIOS      u ON u.id = a.coordinador_id
      ORDER BY a.id DESC
    `)
    res.json(result.recordset)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener asignaciones' })
  }
}

async function create(req, res) {
  const {
    ciclo_id, institucion_id, monto_total,
    presup_alimentos, presup_transporte, presup_gas,
    presup_estipendio, presup_limpieza, presup_otros
  } = req.body

  if (!ciclo_id || !institucion_id || !monto_total)
    return res.status(400).json({ error: 'Faltan campos requeridos' })

  const sumaRubros = [presup_alimentos, presup_transporte, presup_gas,
                      presup_estipendio, presup_limpieza, presup_otros]
    .reduce((acc, v) => acc + (parseFloat(v) || 0), 0)

  if (sumaRubros > parseFloat(monto_total))
    return res.status(400).json({ error: 'La suma de rubros excede el monto total' })

  try {
    const pool = await getPool()

    const insert = await pool.request()
      .input('cid',  sql.Int,         ciclo_id)
      .input('iid',  sql.Int,         institucion_id)
      .input('tot',  sql.Decimal(12,2), parseFloat(monto_total))
      .input('ali',  sql.Decimal(10,2), parseFloat(presup_alimentos) || 0)
      .input('tra',  sql.Decimal(10,2), parseFloat(presup_transporte) || 0)
      .input('gas',  sql.Decimal(10,2), parseFloat(presup_gas) || 0)
      .input('est',  sql.Decimal(10,2), parseFloat(presup_estipendio) || 0)
      .input('lim',  sql.Decimal(10,2), parseFloat(presup_limpieza) || 0)
      .input('otr',  sql.Decimal(10,2), parseFloat(presup_otros) || 0)
      .input('uid',  sql.Int,          req.user.id)
      .query(`
        INSERT INTO EQRENDICION.PAE_ASIGNACIONES
          (ciclo_id, institucion_id, monto_total, presup_alimentos, presup_transporte,
           presup_gas, presup_estipendio, presup_limpieza, presup_otros, coordinador_id)
        OUTPUT INSERTED.id, INSERTED.num_transferencias
        VALUES (@cid, @iid, @tot, @ali, @tra, @gas, @est, @lim, @otr, @uid)
      `)

    const { id: asignacionId, num_transferencias } = insert.recordset[0]

    const montoPorTransf = parseFloat(monto_total) / num_transferencias
    for (let i = 1; i <= num_transferencias; i++) {
      const year = new Date().getFullYear()
      const codigo = `TRF-${year}-${String(asignacionId).padStart(3,'0')}${String(i).padStart(2,'0')}`
      await pool.request()
        .input('aid',    sql.Int,           asignacionId)
        .input('codigo', sql.VarChar,       codigo)
        .input('num',    sql.TinyInt,       i)
        .input('monto',  sql.Decimal(12,2), montoPorTransf)
        .query(`
          INSERT INTO EQRENDICION.PAE_TRANSFERENCIAS (asignacion_id, codigo, numero, monto)
          VALUES (@aid, @codigo, @num, @monto)
        `)
    }

    res.status(201).json({
      message: `Asignación creada con ${num_transferencias} transferencia(s)`,
      asignacionId,
      num_transferencias
    })
  } catch (err) {
    if (err.number === 2627) 
      return res.status(409).json({ error: 'Ya existe una asignación para este ciclo e institución' })
    console.error(err)
    res.status(500).json({ error: 'Error al crear asignación' })
  }
}

module.exports = { getAll, create }
