const { getPool, sql } = require('../config/db')

async function validarPresupuesto(pool, transferenciaId, rubro, montoNuevo, gastoIdExcluir = null) {
  const presResult = await pool.request()
    .input('tid', sql.Int, transferenciaId)
    .query(`
      SELECT
        CASE @rubro
          WHEN 'alimentos'  THEN a.presup_alimentos
          WHEN 'transporte' THEN a.presup_transporte
          WHEN 'gas'        THEN a.presup_gas
          WHEN 'estipendio' THEN a.presup_estipendio
          WHEN 'limpieza'   THEN a.presup_limpieza
          WHEN 'otros'      THEN a.presup_otros
        END AS presupuesto
      FROM EQRENDICION.PAE_TRANSFERENCIAS t
      JOIN EQRENDICION.PAE_ASIGNACIONES a ON a.id = t.asignacion_id
      WHERE t.id = @tid
    `.replace('@rubro', `'${rubro}'`))

  const presupuesto = presResult.recordset[0]?.presupuesto ?? 0

  let gastadoQuery = `
    SELECT COALESCE(SUM(monto), 0) AS gastado
    FROM EQRENDICION.PAE_GASTOS
    WHERE transferencia_id = @tid AND rubro = @rubro
  `
  if (gastoIdExcluir) gastadoQuery += ` AND id <> @excluir`

  const gastadoReq = pool.request()
    .input('tid', sql.Int, transferenciaId)
    .input('rubro', sql.VarChar, rubro)
  if (gastoIdExcluir) gastadoReq.input('excluir', sql.Int, gastoIdExcluir)
  const gastadoResult = await gastadoReq.query(gastadoQuery)
  const gastado = gastadoResult.recordset[0]?.gastado ?? 0

  const saldoDisponible = presupuesto - gastado
  const porcentajeUsado = presupuesto > 0 ? ((gastado / presupuesto) * 100).toFixed(1) : 0

  return {
    presupuesto,
    gastado,
    saldoDisponible,
    porcentajeUsado,
    excede: montoNuevo > saldoDisponible,
    advertencia: saldoDisponible > 0 && (saldoDisponible - montoNuevo) < presupuesto * 0.1
  }
}

async function getByTransferencia(req, res) {
  const { transferencia_id } = req.query
  if (!transferencia_id) return res.status(400).json({ error: 'transferencia_id requerido' })

  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('tid', sql.Int, transferencia_id)
      .query(`
        SELECT g.*, u.nombres + ' ' + u.apellidos AS registrado_nombre,
               dj.nombre_proveedor, dj.dni_proveedor, dj.descripcion AS dj_descripcion,
               pm.punto_partida, pm.punto_llegada, pm.motivo AS mov_motivo
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_USUARIOS u ON u.id = g.registrado_por
        LEFT JOIN EQRENDICION.PAE_DECL_JURADAS dj ON dj.gasto_id = g.id
        LEFT JOIN EQRENDICION.PAE_PLAN_MOVILIDAD pm ON pm.gasto_id = g.id
        WHERE g.transferencia_id = @tid
        ORDER BY g.fecha_documento, g.id
      `)
    res.json(result.recordset)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al obtener gastos' })
  }
}

async function create(req, res) {
  const {
    transferencia_id, fecha_documento, concepto, rubro,
    tiene_ruc, tipo_comprobante, num_comprobante, monto,
    dj_nombre_proveedor, dj_dni_proveedor, dj_descripcion, dj_lugar,
    mov_punto_partida, mov_punto_llegada, mov_institucion_id, mov_motivo
  } = req.body

  const archivo_url = req.file ? `/uploads/${req.file.filename}` : null

  if (!transferencia_id || !fecha_documento || !concepto || !rubro || !tipo_comprobante || !monto) {
    return res.status(400).json({ error: 'Campos obligatorios incompletos' })
  }

  if (rubro === 'transporte' && (!mov_punto_partida || !mov_punto_llegada || !mov_institucion_id)) {
    return res.status(400).json({
      error: 'Para gastos de transporte debes completar la planilla de movilidad (partida, llegada, IIEE)'
    })
  }

  const tieneRuc = tiene_ruc === 'true' || tiene_ruc === true || tiene_ruc === 1
  if (!tieneRuc && (!dj_nombre_proveedor || !dj_descripcion)) {
    return res.status(400).json({
      error: 'Para gastos sin RUC debes completar la declaración jurada (nombre proveedor, descripción)'
    })
  }

  try {
    const pool = await getPool()

    const presup = await validarPresupuesto(pool, transferencia_id, rubro, parseFloat(monto))
    if (presup.excede) {
      return res.status(400).json({
        error: `Excede el presupuesto del rubro "${rubro}". Saldo disponible: S/ ${presup.saldoDisponible.toFixed(2)}`,
        presupuesto: presup
      })
    }

    const gastoResult = await pool.request()
      .input('tid',    sql.Int,       transferencia_id)
      .input('fecha',  sql.Date,      fecha_documento)
      .input('conc',   sql.VarChar,   concepto.toUpperCase())
      .input('rubro',  sql.VarChar,   rubro)
      .input('ruc',    sql.Bit,       tieneRuc ? 1 : 0)
      .input('tipo',   sql.VarChar,   tipo_comprobante)
      .input('ncomp',  sql.VarChar,   num_comprobante || null)
      .input('monto',  sql.Decimal(10,2), parseFloat(monto))
      .input('url',    sql.VarChar,   archivo_url)
      .input('uid',    sql.Int,       req.user.id)
      .query(`
        INSERT INTO EQRENDICION.PAE_GASTOS
          (transferencia_id, fecha_documento, concepto, rubro, tiene_ruc,
           tipo_comprobante, num_comprobante, monto, archivo_url, registrado_por)
        OUTPUT INSERTED.id
        VALUES (@tid, @fecha, @conc, @rubro, @ruc, @tipo, @ncomp, @monto, @url, @uid)
      `)

    const gastoId = gastoResult.recordset[0].id

    if (!tieneRuc) {
      await pool.request()
        .input('gid',       sql.Int,     gastoId)
        .input('nombre',    sql.VarChar, dj_nombre_proveedor)
        .input('dni',       sql.VarChar, dj_dni_proveedor || null)
        .input('desc',      sql.VarChar, dj_descripcion)
        .input('lugar',     sql.VarChar, dj_lugar || null)
        .input('uid',       sql.Int,     req.user.id)
        .query(`
          INSERT INTO EQRENDICION.PAE_DECL_JURADAS
            (gasto_id, nombre_proveedor, dni_proveedor, descripcion, lugar, declarado_por)
          VALUES (@gid, @nombre, @dni, @desc, @lugar, @uid)
        `)
    }

    if (rubro === 'transporte') {
      await pool.request()
        .input('gid',      sql.Int,     gastoId)
        .input('partida',  sql.VarChar, mov_punto_partida)
        .input('llegada',  sql.VarChar, mov_punto_llegada)
        .input('iid',      sql.Int,     mov_institucion_id)
        .input('motivo',   sql.VarChar, mov_motivo || null)
        .input('uid',      sql.Int,     req.user.id)
        .query(`
          INSERT INTO EQRENDICION.PAE_PLAN_MOVILIDAD
            (gasto_id, punto_partida, punto_llegada, institucion_id, motivo, registrado_por)
          VALUES (@gid, @partida, @llegada, @iid, @motivo, @uid)
        `)
    }

    res.status(201).json({
      message: 'Gasto registrado correctamente',
      gastoId,
      advertencia: presup.advertencia
        ? `Atención: solo te quedan S/ ${(presup.saldoDisponible - parseFloat(monto)).toFixed(2)} en el rubro "${rubro}"`
        : null
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al registrar gasto' })
  }
}

async function remove(req, res) {
  try {
    const pool = await getPool()

    const check = await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('uid', sql.Int, req.user.id)
      .query(`
        SELECT g.id, g.estado FROM EQRENDICION.PAE_GASTOS g
        WHERE g.id = @id AND g.registrado_por = @uid
      `)

    if (!check.recordset[0]) return res.status(404).json({ error: 'Gasto no encontrado' })
    if (check.recordset[0].estado === 'aprobado')
      return res.status(400).json({ error: 'No se puede eliminar un gasto aprobado' })

    await pool.request().input('id', sql.Int, req.params.id)
      .query(`DELETE FROM EQRENDICION.PAE_DECL_JURADAS WHERE gasto_id = @id`)
    await pool.request().input('id', sql.Int, req.params.id)
      .query(`DELETE FROM EQRENDICION.PAE_PLAN_MOVILIDAD WHERE gasto_id = @id`)
    await pool.request().input('id', sql.Int, req.params.id)
      .query(`DELETE FROM EQRENDICION.PAE_GASTOS WHERE id = @id`)

    res.json({ message: 'Gasto eliminado' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al eliminar gasto' })
  }
}

async function cambiarEstado(req, res) {
  const { estado, observacion } = req.body
  if (!['observado', 'aprobado', 'registrado'].includes(estado))
    return res.status(400).json({ error: 'Estado inválido' })

  try {
    const pool = await getPool()
    await pool.request()
      .input('id',    sql.Int,     req.params.id)
      .input('est',   sql.VarChar, estado)
      .input('obs',   sql.VarChar, observacion || null)
      .query(`
        UPDATE EQRENDICION.PAE_GASTOS
        SET estado = @est, observacion = @obs
        WHERE id = @id
      `)
    res.json({ message: 'Estado actualizado' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al actualizar estado' })
  }
}

async function checkPresupuesto(req, res) {
  const { rubro, monto, transferencia_id } = req.query
  if (!rubro || !monto || !transferencia_id)
    return res.status(400).json({ error: 'Parámetros incompletos' })

  try {
    const pool = await getPool()
    const resultado = await validarPresupuesto(pool, transferencia_id, rubro, parseFloat(monto))
    res.json(resultado)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al verificar presupuesto' })
  }
}
async function update(req, res) {
  const {
    fecha_documento, concepto, rubro, tiene_ruc,
    tipo_comprobante, num_comprobante, monto,
    dj_nombre_proveedor, dj_dni_proveedor, dj_descripcion, dj_lugar,
    mov_punto_partida, mov_punto_llegada, mov_institucion_id, mov_motivo
  } = req.body

  const archivo_url = req.file ? `/uploads/${req.file.filename}` : null

  try {
    const pool = await getPool()

    const check = await pool.request()
      .input('id',  sql.Int, req.params.id)
      .input('uid', sql.Int, req.user.id)
      .query(`
        SELECT id, estado, archivo_url
        FROM EQRENDICION.PAE_GASTOS
        WHERE id = @id AND registrado_por = @uid
      `)

    if (!check.recordset[0])
      return res.status(404).json({ error: 'Gasto no encontrado' })
    if (check.recordset[0].estado === 'aprobado')
      return res.status(400).json({ error: 'No se puede editar un gasto aprobado' })

    const tieneRuc = tiene_ruc === 'true' || tiene_ruc === true || tiene_ruc === 1

    const presup = await validarPresupuesto(pool, null, rubro, parseFloat(monto), parseInt(req.params.id))

    await pool.request()
      .input('id',    sql.Int,          req.params.id)
      .input('fecha', sql.Date,         fecha_documento)
      .input('conc',  sql.VarChar,      concepto.toUpperCase())
      .input('rubro', sql.VarChar,      rubro)
      .input('ruc',   sql.Bit,          tieneRuc ? 1 : 0)
      .input('tipo',  sql.VarChar,      tipo_comprobante)
      .input('ncomp', sql.VarChar,      num_comprobante || null)
      .input('monto', sql.Decimal(10,2), parseFloat(monto))
      .input('url',   sql.VarChar,      archivo_url ?? check.recordset[0].archivo_url)
      .query(`
        UPDATE EQRENDICION.PAE_GASTOS
        SET fecha_documento = @fecha, concepto = @conc, rubro = @rubro,
            tiene_ruc = @ruc, tipo_comprobante = @tipo, num_comprobante = @ncomp,
            monto = @monto, archivo_url = @url, estado = 'registrado'
        WHERE id = @id
      `)

    if (!tieneRuc && dj_nombre_proveedor) {
      const existeDJ = await pool.request()
        .input('id', sql.Int, req.params.id)
        .query(`SELECT id FROM EQRENDICION.PAE_DECL_JURADAS WHERE gasto_id = @id`)

      if (existeDJ.recordset[0]) {
        await pool.request()
          .input('id',     sql.Int,     req.params.id)
          .input('nombre', sql.VarChar, dj_nombre_proveedor)
          .input('dni',    sql.VarChar, dj_dni_proveedor || null)
          .input('desc',   sql.VarChar, dj_descripcion)
          .input('lugar',  sql.VarChar, dj_lugar || null)
          .query(`
            UPDATE EQRENDICION.PAE_DECL_JURADAS
            SET nombre_proveedor = @nombre, dni_proveedor = @dni,
                descripcion = @desc, lugar = @lugar
            WHERE gasto_id = @id
          `)
      } else {
        await pool.request()
          .input('gid',    sql.Int,     req.params.id)
          .input('nombre', sql.VarChar, dj_nombre_proveedor)
          .input('dni',    sql.VarChar, dj_dni_proveedor || null)
          .input('desc',   sql.VarChar, dj_descripcion)
          .input('lugar',  sql.VarChar, dj_lugar || null)
          .input('uid',    sql.Int,     req.user.id)
          .query(`
            INSERT INTO EQRENDICION.PAE_DECL_JURADAS
              (gasto_id, nombre_proveedor, dni_proveedor, descripcion, lugar, declarado_por)
            VALUES (@gid, @nombre, @dni, @desc, @lugar, @uid)
          `)
      }
    }

    if (rubro === 'transporte' && mov_punto_partida) {
      const existeMov = await pool.request()
        .input('id', sql.Int, req.params.id)
        .query(`SELECT id FROM EQRENDICION.PAE_PLAN_MOVILIDAD WHERE gasto_id = @id`)

      if (existeMov.recordset[0]) {
        await pool.request()
          .input('id',      sql.Int,     req.params.id)
          .input('partida', sql.VarChar, mov_punto_partida)
          .input('llegada', sql.VarChar, mov_punto_llegada)
          .input('iid',     sql.Int,     mov_institucion_id)
          .input('motivo',  sql.VarChar, mov_motivo || null)
          .query(`
            UPDATE EQRENDICION.PAE_PLAN_MOVILIDAD
            SET punto_partida = @partida, punto_llegada = @llegada,
                institucion_id = @iid, motivo = @motivo
            WHERE gasto_id = @id
          `)
      } else {
        await pool.request()
          .input('gid',     sql.Int,     req.params.id)
          .input('partida', sql.VarChar, mov_punto_partida)
          .input('llegada', sql.VarChar, mov_punto_llegada)
          .input('iid',     sql.Int,     mov_institucion_id)
          .input('motivo',  sql.VarChar, mov_motivo || null)
          .input('uid',     sql.Int,     req.user.id)
          .query(`
            INSERT INTO EQRENDICION.PAE_PLAN_MOVILIDAD
              (gasto_id, punto_partida, punto_llegada, institucion_id, motivo, registrado_por)
            VALUES (@gid, @partida, @llegada, @iid, @motivo, @uid)
          `)
      }
    }

    res.json({ message: 'Gasto actualizado correctamente' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al actualizar gasto' })
  }
}
module.exports = { getByTransferencia, create, update, remove, cambiarEstado, checkPresupuesto }
