const { getPool, sql } = require('../config/db')

async function validarPresupuesto(pool, transferenciaId, rubro, montoNuevo, comprobanteIdExcluir = null) {
  const presResult = await pool.request()
    .input('tid', sql.Int, transferenciaId)
    .query(`
      SELECT
        CASE '${rubro}'
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
    `)

  const presupuesto = presResult.recordset[0]?.presupuesto ?? 0

  let gastadoQuery = `
    SELECT COALESCE(SUM(g.monto), 0) AS gastado
    FROM EQRENDICION.PAE_GASTOS g
    JOIN EQRENDICION.PAE_COMPROBANTES c ON c.id = g.comprobante_id
    WHERE c.transferencia_id = @tid AND g.rubro = @rubro
  `
  if (comprobanteIdExcluir) gastadoQuery += ` AND c.id <> @excluir`

  let djQuery = `
    SELECT COALESCE(SUM(g.monto), 0) AS gastado_dj
    FROM EQRENDICION.PAE_GASTOS g
    JOIN EQRENDICION.PAE_COMPROBANTES c ON c.id = g.comprobante_id
    WHERE c.transferencia_id = @tid
      AND g.rubro = @rubro
      AND c.tiene_ruc = 0
  `
  if (comprobanteIdExcluir) djQuery += ` AND c.id <> @excluir`

  const gastadoReq = pool.request()
    .input('tid',   sql.Int,     transferenciaId)
    .input('rubro', sql.VarChar, rubro)
  if (comprobanteIdExcluir) gastadoReq.input('excluir', sql.Int, comprobanteIdExcluir)

  const djReq = pool.request()
    .input('tid',   sql.Int,     transferenciaId)
    .input('rubro', sql.VarChar, rubro)
  if (comprobanteIdExcluir) djReq.input('excluir', sql.Int, comprobanteIdExcluir)

  const [gastadoResult, djResult] = await Promise.all([
    gastadoReq.query(gastadoQuery),
    djReq.query(djQuery)
  ])

  const gastado      = gastadoResult.recordset[0]?.gastado    ?? 0
  const gastadoDJ    = djResult.recordset[0]?.gastado_dj      ?? 0
  const limiteDJ     = presupuesto * 0.10
  const saldoDisponible = presupuesto - gastado
  const limiteDP = presupuesto * 0.10

  return {
    presupuesto,
    gastado,
    saldoDisponible,
    porcentajeUsado:    presupuesto > 0 ? +((gastado   / presupuesto) * 100).toFixed(1) : 0,
    gastadoDJ,
    limiteDP,
    saldoDJ:            limiteDP - gastadoDJ,
    porcentajeDJUsado:  limiteDP  > 0 ? +((gastadoDJ / limiteDP)    * 100).toFixed(1) : 0,
    excede:             montoNuevo > saldoDisponible,
    advertencia:        saldoDisponible > 0 && (saldoDisponible - montoNuevo) < presupuesto * 0.1,
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
        SELECT
          g.id,
          g.comprobante_id,
          g.concepto,
          g.rubro,
          g.monto,
          g.estado,
          g.observacion,
          g.creado_en,
          -- Comprobante (cabecera)
          c.transferencia_id,
          c.fecha_documento,
          c.tipo_comprobante,
          c.num_comprobante,
          c.tiene_ruc,
          c.ruc_proveedor,
          c.nombre_proveedor,
          c.monto_total       AS comprobante_monto_total,
          c.archivo_url,
          c.estado            AS comprobante_estado,
          c.observacion       AS comprobante_observacion,
          -- Transferencia (para mostrar en tabla)
          t.codigo            AS codigo_transferencia,
          t.numero            AS transf_numero,
          a.num_transferencias,
          -- Módulo / nivel (para el filtro de nivel en el front)
          m.nivel,
          m.codigo_modular,
          -- DJ
          dj.nombre_proveedor AS dj_nombre_proveedor,
          dj.dni_proveedor,
          dj.descripcion      AS dj_descripcion,
          dj.lugar            AS dj_lugar,
          -- Movilidad
          pm.punto_partida,
          pm.punto_llegada,
          pm.motivo           AS mov_motivo
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES      c  ON c.id  = g.comprobante_id
        JOIN EQRENDICION.PAE_TRANSFERENCIAS    t  ON t.id  = c.transferencia_id
        JOIN EQRENDICION.PAE_ASIGNACIONES      a  ON a.id  = t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS           m  ON m.id  = a.modulo_id
        LEFT JOIN EQRENDICION.PAE_DECL_JURADAS   dj ON dj.comprobante_id = c.id
        LEFT JOIN EQRENDICION.PAE_PLAN_MOVILIDAD pm ON pm.comprobante_id = c.id
        WHERE c.transferencia_id = @tid
        ORDER BY c.fecha_documento, c.id, g.id
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
    mov_punto_partida, mov_punto_llegada, mov_institucion_id, mov_motivo,
    items
  } = req.body

  const archivo_url = req.file ? `/uploads/${req.file.filename}` : null
  const tieneRuc    = tiene_ruc === 'true' || tiene_ruc === true || tiene_ruc === 1

  if (!transferencia_id || !fecha_documento || !tipo_comprobante)
    return res.status(400).json({ error: 'Campos obligatorios incompletos' })

  let lineas = []
  if (items) {
    try { lineas = JSON.parse(items) } catch { return res.status(400).json({ error: 'items JSON inválido' }) }
  } else {
    if (!concepto || !rubro || !monto) return res.status(400).json({ error: 'Campos obligatorios incompletos' })
    lineas = [{ concepto, rubro, monto: parseFloat(monto) }]
  }

  if (!items && lineas[0]?.rubro === 'transporte' && (!mov_punto_partida || !mov_punto_llegada || !mov_institucion_id))
    return res.status(400).json({ error: 'Para transporte debes completar la planilla de movilidad' })

  if (!tieneRuc && (!dj_nombre_proveedor || !dj_descripcion))
    return res.status(400).json({ error: 'Para gastos sin RUC debes completar la declaración jurada' })

  try {
    const pool = await getPool()

    for (const linea of lineas) {
      const presup = await validarPresupuesto(pool, transferencia_id, linea.rubro, linea.monto)

      if (presup.excede)
        return res.status(400).json({
          error: `Excede el presupuesto del rubro "${linea.rubro}". Saldo disponible: S/ ${presup.saldoDisponible.toFixed(2)}`,
          presupuesto: presup
        })

      if (!tieneRuc && (presup.gastadoDJ + linea.monto) > presup.limiteDP)
        return res.status(400).json({
          error: `Las Declaraciones Juradas del rubro "${linea.rubro}" no pueden superar el 10% del presupuesto (límite: S/ ${presup.limiteDP.toFixed(2)}, ya usado: S/ ${presup.gastadoDJ.toFixed(2)})`,
          presupuesto: presup,
          tipo: 'limite_dj'
        })
    }

    const montoTotal = lineas.reduce((s, l) => s + parseFloat(l.monto), 0)

    const compResult = await pool.request()
      .input('tid',   sql.Int,          transferencia_id)
      .input('fecha', sql.Date,         fecha_documento)
      .input('tipo',  sql.VarChar,      tipo_comprobante)
      .input('ncomp', sql.VarChar,      num_comprobante || null)
      .input('ruc',   sql.Bit,          tieneRuc ? 1 : 0)
      .input('ruc_n', sql.VarChar,      req.body.ruc_proveedor || null)
      .input('prov',  sql.VarChar,      req.body.nombre_proveedor || null)
      .input('total', sql.Decimal(12,2), montoTotal)
      .input('url',   sql.VarChar,      archivo_url)
      .input('uid',   sql.Int,          req.user.id)
      .query(`
        INSERT INTO EQRENDICION.PAE_COMPROBANTES
          (transferencia_id, fecha_documento, tipo_comprobante, num_comprobante,
           tiene_ruc, ruc_proveedor, nombre_proveedor, monto_total, archivo_url, registrado_por)
        OUTPUT INSERTED.id
        VALUES (@tid, @fecha, @tipo, @ncomp, @ruc, @ruc_n, @prov, @total, @url, @uid)
      `)

    const comprobanteId = compResult.recordset[0].id

    for (const linea of lineas) {
      await pool.request()
        .input('cid',   sql.Int,          comprobanteId)
        .input('conc',  sql.VarChar,      String(linea.concepto).toUpperCase())
        .input('rubro', sql.VarChar,      linea.rubro)
        .input('monto', sql.Decimal(10,2), parseFloat(linea.monto))
        .query(`
          INSERT INTO EQRENDICION.PAE_GASTOS (comprobante_id, concepto, rubro, monto)
          VALUES (@cid, @conc, @rubro, @monto)
        `)
    }

    if (!tieneRuc) {
      await pool.request()
        .input('cid',    sql.Int,     comprobanteId)
        .input('nombre', sql.VarChar, dj_nombre_proveedor)
        .input('dni',    sql.VarChar, dj_dni_proveedor || null)
        .input('desc',   sql.VarChar, dj_descripcion)
        .input('lugar',  sql.VarChar, dj_lugar || null)
        .input('uid',    sql.Int,     req.user.id)
        .query(`
          INSERT INTO EQRENDICION.PAE_DECL_JURADAS
            (comprobante_id, nombre_proveedor, dni_proveedor, descripcion, lugar, declarado_por)
          VALUES (@cid, @nombre, @dni, @desc, @lugar, @uid)
        `)
    }

    if (!items && lineas[0]?.rubro === 'transporte') {
      await pool.request()
        .input('cid',     sql.Int,     comprobanteId)
        .input('partida', sql.VarChar, mov_punto_partida)
        .input('llegada', sql.VarChar, mov_punto_llegada)
        .input('iid',     sql.Int,     mov_institucion_id)
        .input('motivo',  sql.VarChar, mov_motivo || null)
        .input('uid',     sql.Int,     req.user.id)
        .query(`
          INSERT INTO EQRENDICION.PAE_PLAN_MOVILIDAD
            (comprobante_id, punto_partida, punto_llegada, modulo_id, motivo, registrado_por)
          VALUES (@cid, @partida, @llegada, @iid, @motivo, @uid)
        `)
    }

    const presup = await validarPresupuesto(pool, transferencia_id, lineas[0].rubro, 0)

    res.status(201).json({
      message:       'Gasto registrado correctamente',
      comprobanteId,
      lineasCreadas: lineas.length,
      advertencia:   presup.advertencia ? `Atención: saldo bajo en rubro "${lineas[0].rubro}"` : null
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al registrar gasto' })
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
    const pool  = await getPool()
    const check = await pool.request()
      .input('id',  sql.Int, req.params.id)
      .input('uid', sql.Int, req.user.id)
      .query(`
        SELECT g.id, g.estado, g.comprobante_id, c.archivo_url, c.transferencia_id
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES c ON c.id = g.comprobante_id
        WHERE g.id = @id AND c.registrado_por = @uid
      `)

    if (!check.recordset[0])
      return res.status(404).json({ error: 'Gasto no encontrado' })
    if (check.recordset[0].estado === 'aprobado')
      return res.status(400).json({ error: 'No se puede editar un gasto aprobado' })

    const comprobanteId   = check.recordset[0].comprobante_id
    const transferenciaId = check.recordset[0].transferencia_id
    const tieneRuc        = tiene_ruc === 'true' || tiene_ruc === true || tiene_ruc === 1

    const presup = await validarPresupuesto(pool, transferenciaId, rubro, parseFloat(monto), comprobanteId)
    if (presup.excede)
      return res.status(400).json({
        error: `Excede el presupuesto del rubro "${rubro}". Saldo disponible: S/ ${presup.saldoDisponible.toFixed(2)}`
      })

    await pool.request()
      .input('id',    sql.Int,           req.params.id)
      .input('conc',  sql.VarChar,       String(concepto).toUpperCase())
      .input('rubro', sql.VarChar,       rubro)
      .input('monto', sql.Decimal(10,2), parseFloat(monto))
      .query(`UPDATE EQRENDICION.PAE_GASTOS SET concepto=@conc, rubro=@rubro, monto=@monto, estado='registrado' WHERE id=@id`)

    await pool.request()
      .input('cid',   sql.Int,     comprobanteId)
      .input('fecha', sql.Date,    fecha_documento)
      .input('tipo',  sql.VarChar, tipo_comprobante)
      .input('ncomp', sql.VarChar, num_comprobante || null)
      .input('ruc',   sql.Bit,     tieneRuc ? 1 : 0)
      .input('url',   sql.VarChar, archivo_url ?? check.recordset[0].archivo_url)
      .query(`
        UPDATE EQRENDICION.PAE_COMPROBANTES
        SET fecha_documento=@fecha, tipo_comprobante=@tipo, num_comprobante=@ncomp,
            tiene_ruc=@ruc, archivo_url=COALESCE(@url, archivo_url), estado='registrado'
        WHERE id=@cid
      `)

    if (!tieneRuc && dj_nombre_proveedor) {
      const ex = await pool.request().input('cid', sql.Int, comprobanteId)
        .query(`SELECT id FROM EQRENDICION.PAE_DECL_JURADAS WHERE comprobante_id=@cid`)
      if (ex.recordset[0]) {
        await pool.request()
          .input('cid', sql.Int, comprobanteId).input('nombre', sql.VarChar, dj_nombre_proveedor)
          .input('dni', sql.VarChar, dj_dni_proveedor || null).input('desc', sql.VarChar, dj_descripcion)
          .input('lugar', sql.VarChar, dj_lugar || null)
          .query(`UPDATE EQRENDICION.PAE_DECL_JURADAS SET nombre_proveedor=@nombre, dni_proveedor=@dni, descripcion=@desc, lugar=@lugar WHERE comprobante_id=@cid`)
      } else {
        await pool.request()
          .input('cid', sql.Int, comprobanteId).input('nombre', sql.VarChar, dj_nombre_proveedor)
          .input('dni', sql.VarChar, dj_dni_proveedor || null).input('desc', sql.VarChar, dj_descripcion)
          .input('lugar', sql.VarChar, dj_lugar || null).input('uid', sql.Int, req.user.id)
          .query(`INSERT INTO EQRENDICION.PAE_DECL_JURADAS (comprobante_id,nombre_proveedor,dni_proveedor,descripcion,lugar,declarado_por) VALUES (@cid,@nombre,@dni,@desc,@lugar,@uid)`)
      }
    }

    if (rubro === 'transporte' && mov_punto_partida) {
      const ex = await pool.request().input('cid', sql.Int, comprobanteId)
        .query(`SELECT id FROM EQRENDICION.PAE_PLAN_MOVILIDAD WHERE comprobante_id=@cid`)
      if (ex.recordset[0]) {
        await pool.request()
          .input('cid', sql.Int, comprobanteId).input('partida', sql.VarChar, mov_punto_partida)
          .input('llegada', sql.VarChar, mov_punto_llegada).input('iid', sql.Int, mov_institucion_id)
          .input('motivo', sql.VarChar, mov_motivo || null)
          .query(`UPDATE EQRENDICION.PAE_PLAN_MOVILIDAD SET punto_partida=@partida, punto_llegada=@llegada, modulo_id=@iid, motivo=@motivo WHERE comprobante_id=@cid`)
      } else {
        await pool.request()
          .input('cid', sql.Int, comprobanteId).input('partida', sql.VarChar, mov_punto_partida)
          .input('llegada', sql.VarChar, mov_punto_llegada).input('iid', sql.Int, mov_institucion_id)
          .input('motivo', sql.VarChar, mov_motivo || null).input('uid', sql.Int, req.user.id)
          .query(`INSERT INTO EQRENDICION.PAE_PLAN_MOVILIDAD (comprobante_id,punto_partida,punto_llegada,modulo_id,motivo,registrado_por) VALUES (@cid,@partida,@llegada,@iid,@motivo,@uid)`)
      }
    }

    res.json({ message: 'Gasto actualizado correctamente' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al actualizar gasto' })
  }
}

async function remove(req, res) {
  try {
    const pool  = await getPool()
    const check = await pool.request()
      .input('id',  sql.Int, req.params.id)
      .input('uid', sql.Int, req.user.id)
      .query(`
        SELECT g.id, g.estado, g.comprobante_id
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES c ON c.id = g.comprobante_id
        WHERE g.id = @id AND c.registrado_por = @uid
      `)

    if (!check.recordset[0])
      return res.status(404).json({ error: 'Gasto no encontrado' })
    if (check.recordset[0].estado === 'aprobado')
      return res.status(400).json({ error: 'No se puede eliminar un gasto aprobado' })

    const comprobanteId = check.recordset[0].comprobante_id

    await pool.request().input('id', sql.Int, req.params.id)
      .query(`DELETE FROM EQRENDICION.PAE_GASTOS WHERE id=@id`)

    const restantes = await pool.request().input('cid', sql.Int, comprobanteId)
      .query(`SELECT COUNT(*) AS n FROM EQRENDICION.PAE_GASTOS WHERE comprobante_id=@cid`)

    if (restantes.recordset[0].n === 0) {
      await pool.request().input('cid', sql.Int, comprobanteId).query(`DELETE FROM EQRENDICION.PAE_DECL_JURADAS  WHERE comprobante_id=@cid`)
      await pool.request().input('cid', sql.Int, comprobanteId).query(`DELETE FROM EQRENDICION.PAE_PLAN_MOVILIDAD WHERE comprobante_id=@cid`)
      await pool.request().input('cid', sql.Int, comprobanteId).query(`DELETE FROM EQRENDICION.PAE_COMPROBANTES   WHERE id=@cid`)
    }

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
      .input('id',  sql.Int,     req.params.id)
      .input('est', sql.VarChar, estado)
      .input('obs', sql.VarChar, observacion || null)
      .query(`UPDATE EQRENDICION.PAE_GASTOS SET estado=@est, observacion=@obs WHERE id=@id`)
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
    const pool   = await getPool()
    const result = await validarPresupuesto(pool, transferencia_id, rubro, parseFloat(monto))
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Error al verificar presupuesto' })
  }
}

module.exports = { getByTransferencia, create, update, remove, cambiarEstado, checkPresupuesto }