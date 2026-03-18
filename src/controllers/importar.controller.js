const { getPool, sql } = require('../config/db')
const XLSX             = require('xlsx')

const ENTREGAS_MESES = [5, 6, 7, 8, 9, 10]
const NOMBRES_MESES  = ['Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre']

function ultimoDia(anio, mes) {
  return new Date(anio, mes, 0).getDate()
}

async function importarTransferencias(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Se requiere el archivo Excel' })

  const pool    = await getPool()
  const anio    = new Date().getFullYear()
  const logs    = []
  const errores = []

  try {
    // ── 1. Parsear Excel en memoria ───────────────────────────────────────
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws   = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
    const dataRows = rows.slice(2).filter(r => r[0] != null && !isNaN(r[0]))

    logs.push(`Excel leído: ${dataRows.length} módulos`)

    // ── 2. Crear/obtener los 6 ciclos en batch ────────────────────────────
    const cicloIds = {}

    // Un solo query para obtener ciclos existentes
    const ciclosEx = await pool.request()
      .input('anio', sql.SmallInt, anio)
      .query(`SELECT id, mes FROM EQRENDICION.PAE_CICLOS WHERE anio = @anio AND mes BETWEEN 5 AND 10`)

    ciclosEx.recordset.forEach(c => {
      const idx = ENTREGAS_MESES.indexOf(c.mes)
      if (idx !== -1) cicloIds[idx] = c.id
    })

    // Crear solo los que faltan
    for (let i = 0; i < 6; i++) {
      if (cicloIds[i]) continue
      const mes    = ENTREGAS_MESES[i]
      const nombre = `Ciclo ${NOMBRES_MESES[i]} ${anio}`
      const fi     = `${anio}-${String(mes).padStart(2,'0')}-01`
      const ff     = `${anio}-${String(mes).padStart(2,'0')}-${String(ultimoDia(anio, mes)).padStart(2,'0')}`
      const ins = await pool.request()
        .input('nombre', sql.VarChar,  nombre)
        .input('anio',   sql.SmallInt, anio)
        .input('mes',    sql.TinyInt,  mes)
        .input('fi',     sql.Date,     fi)
        .input('ff',     sql.Date,     ff)
        .query(`
          INSERT INTO EQRENDICION.PAE_CICLOS (nombre,anio,mes,fecha_inicio,fecha_fin)
          OUTPUT INSERTED.id VALUES (@nombre,@anio,@mes,@fi,@ff)
        `)
      cicloIds[i] = ins.recordset[0].id
      logs.push(`  Ciclo ${nombre}: creado`)
    }

    // ── 3. Leer módulos existentes en BD de una sola vez ─────────────────
    const modsEx = await pool.request().query(`
      SELECT m.id, m.codigo_modular, m.institucion_id
      FROM EQRENDICION.PAE_MODULOS m
    `)
    const moduloMap = {}
    modsEx.recordset.forEach(m => { moduloMap[m.codigo_modular] = m.id })

    // Leer instituciones existentes
    const instEx = await pool.request().query(`
      SELECT id, codigo FROM EQRENDICION.PAE_INSTITUCIONES
    `)
    const instMap = {}
    instEx.recordset.forEach(i => { instMap[i.codigo] = i.id })

    // Leer asignaciones existentes
    const asigEx = await pool.request().query(`
      SELECT id, ciclo_id, modulo_id, num_transferencias_excel, monto_x_transf_excel
      FROM EQRENDICION.PAE_ASIGNACIONES
    `)
    const asigMap = {}
    asigEx.recordset.forEach(a => { asigMap[`${a.ciclo_id}_${a.modulo_id}`] = a.id })

    // ── 4. Procesar filas y acumular inserts/updates ──────────────────────
    const institucionesACrear = []  // { codigo, nombre }
    const modulosACrear       = []  // { codigo, nivelRaw, nombreIE, codInst }
    const asignacionesACrear  = []  // { cicloId, moduloCod, rubros..., nt, mxt }
    const asignacionesAActualizar = [] // { id, rubros..., nt, mxt }

    for (const row of dataRows) {
      const numFila    = row[0]
      const codModular = String(row[3] ?? '').trim()
      const nombreIE   = String(row[4] ?? '').trim()
      const nivelRaw   = String(row[5] ?? '').trim().toLowerCase()
      const nivel      = { inicial:'inicial', primaria:'primaria', secundaria:'secundaria' }[nivelRaw]

      if (!nivel || !codModular) {
        errores.push(`Fila ${numFila}: datos inválidos — omitida`)
        continue
      }

      // Registrar institución/módulo a crear si no existen
      if (!instMap[codModular] && !institucionesACrear.find(x => x.codigo === codModular)) {
        institucionesACrear.push({ codigo: codModular, nombre: nombreIE || codModular })
      }
      if (!moduloMap[codModular] && !modulosACrear.find(x => x.codigo === codModular)) {
        modulosACrear.push({ codigo: codModular, nivel, nombreIE, codInst: codModular })
      }

      // Por cada entrega
      for (let i = 0; i < 6; i++) {
        const pa  = Number(row[9  + i] ?? 0)
        const ptr = Number(row[15 + i] ?? 0)
        const pg  = Number(row[21 + i] ?? 0)
        const pe  = Number(row[27 + i] ?? 0)
        const pl  = Number(row[33 + i] ?? 0)
        const po  = Number(row[39 + i] ?? 0)
        const mt  = pa + ptr + pg + pe + pl + po

        const nt  = Number(row[45 + (i * 2)]     ?? 0)
        const mxt = Number(row[45 + (i * 2) + 1] ?? 0)

        if (nt === 0) continue

        const cicloId = cicloIds[i]
        const key     = `${cicloId}_${codModular}` // temporal, se resuelve después

        asignacionesACrear.push({
          cicloId, codModular, nivel,
          mt, pa, ptr, pg, pe, pl, po, nt, mxt
        })
      }
    }

    // ── 5. Crear instituciones faltantes en batch ─────────────────────────
    for (const inst of institucionesACrear) {
      const r = await pool.request()
        .input('cod',    sql.VarChar, inst.codigo)
        .input('nombre', sql.VarChar, inst.nombre)
        .query(`
          INSERT INTO EQRENDICION.PAE_INSTITUCIONES (codigo, nombre)
          OUTPUT INSERTED.id, INSERTED.codigo
          VALUES (@cod, @nombre)
        `)
      instMap[r.recordset[0].codigo] = r.recordset[0].id
    }

    // ── 6. Crear módulos faltantes en batch ───────────────────────────────
    for (const mod of modulosACrear) {
      const instId = instMap[mod.codInst]
      if (!instId) continue
      const r = await pool.request()
        .input('instId', sql.Int,     instId)
        .input('cod',    sql.VarChar, mod.codigo)
        .input('nivel',  sql.VarChar, mod.nivel)
        .input('nombre', sql.VarChar, `${mod.nombreIE} - ${mod.nivel.charAt(0).toUpperCase() + mod.nivel.slice(1)}`)
        .query(`
          INSERT INTO EQRENDICION.PAE_MODULOS (institucion_id, codigo_modular, nivel, nombre)
          OUTPUT INSERTED.id, INSERTED.codigo_modular
          VALUES (@instId, @cod, @nivel, @nombre)
        `)
      moduloMap[r.recordset[0].codigo_modular] = r.recordset[0].id
    }

    // ── 7. Crear/actualizar asignaciones con tabla temporal ───────────────
    // Agrupar asignaciones a crear vs actualizar
    const toInsert = []
    const toUpdate = []

    for (const a of asignacionesACrear) {
      const moduloId = moduloMap[a.codModular]
      if (!moduloId) continue
      const key = `${a.cicloId}_${moduloId}`
      if (asigMap[key]) {
        toUpdate.push({ id: asigMap[key], ...a, moduloId })
      } else {
        toInsert.push({ ...a, moduloId })
        asigMap[key] = -1 // marca para no duplicar
      }
    }

    // Bulk insert de asignaciones nuevas en lotes de 50 filas (sin tabla temporal)
    if (toInsert.length > 0) {
      const LOTE = 50
      for (let start = 0; start < toInsert.length; start += LOTE) {
        const lote = toInsert.slice(start, start + LOTE)
        const req2 = pool.request()
        const vals = lote.map((a, j) => {
          const k = start + j
          req2.input('c'   + k, sql.Int,           a.cicloId)
          req2.input('m'   + k, sql.Int,           a.moduloId)
          req2.input('mt'  + k, sql.Decimal(12,2), a.mt)
          req2.input('pa'  + k, sql.Decimal(10,2), a.pa)
          req2.input('ptr' + k, sql.Decimal(10,2), a.ptr)
          req2.input('pg'  + k, sql.Decimal(10,2), a.pg)
          req2.input('pe'  + k, sql.Decimal(10,2), a.pe)
          req2.input('pl'  + k, sql.Decimal(10,2), a.pl)
          req2.input('po'  + k, sql.Decimal(10,2), a.po)
          req2.input('nt'  + k, sql.TinyInt,       a.nt)
          req2.input('mxt' + k, sql.Decimal(12,2), a.mxt)
          req2.input('uid' + k, sql.Int,           req.user.id)
          return `(@c${k},@m${k},@mt${k},@pa${k},@ptr${k},@pg${k},@pe${k},@pl${k},@po${k},@nt${k},@mxt${k},@uid${k})`
        }).join(',')
        await req2.query(`
          INSERT INTO EQRENDICION.PAE_ASIGNACIONES
            (ciclo_id, modulo_id, monto_total,
             presup_alimentos, presup_transporte, presup_gas,
             presup_estipendio, presup_limpieza, presup_otros,
             num_transferencias_excel, monto_x_transf_excel, coordinador_id)
          VALUES ${vals}
        `)
      }
      logs.push(`  ${toInsert.length} asignaciones creadas`)
    }

    // Bulk update de asignaciones existentes en lotes de 50
    // Usa INSERT en tabla de valores + UPDATE con JOIN (más limpio que CASE WHEN)
    if (toUpdate.length > 0) {
      const LOTE = 50
      for (let start = 0; start < toUpdate.length; start += LOTE) {
        const lote = toUpdate.slice(start, start + LOTE)
        const req3 = pool.request()
        const vals = lote.map((a, j) => {
          const k = start + j
          req3.input('uid' + k, sql.Int,           a.id)
          req3.input('umt' + k, sql.Decimal(12,2), a.mt)
          req3.input('upa' + k, sql.Decimal(10,2), a.pa)
          req3.input('uptr'+ k, sql.Decimal(10,2), a.ptr)
          req3.input('upg' + k, sql.Decimal(10,2), a.pg)
          req3.input('upe' + k, sql.Decimal(10,2), a.pe)
          req3.input('upl' + k, sql.Decimal(10,2), a.pl)
          req3.input('upo' + k, sql.Decimal(10,2), a.po)
          req3.input('unt' + k, sql.TinyInt,       a.nt)
          req3.input('umx' + k, sql.Decimal(12,2), a.mxt)
          return `(@uid${k},@umt${k},@upa${k},@uptr${k},@upg${k},@upe${k},@upl${k},@upo${k},@unt${k},@umx${k})`
        }).join(',')

        await req3.query(`
          UPDATE t SET
            t.monto_total              = v.mt,
            t.presup_alimentos         = v.pa,
            t.presup_transporte        = v.ptr,
            t.presup_gas               = v.pg,
            t.presup_estipendio        = v.pe,
            t.presup_limpieza          = v.pl,
            t.presup_otros             = v.po,
            t.num_transferencias_excel = v.nt,
            t.monto_x_transf_excel     = v.mxt
          FROM EQRENDICION.PAE_ASIGNACIONES t
          JOIN (VALUES ${vals}) AS v(id,mt,pa,ptr,pg,pe,pl,po,nt,mxt)
            ON t.id = v.id
        `)
      }
      logs.push(`  ${toUpdate.length} asignaciones actualizadas`)
    }

    res.json({
      ok: true,
      resumen: {
        modulos_procesados:    dataRows.length - errores.length,
        modulos_omitidos:      errores.length,
        asignaciones_creadas:  toInsert.length,
        asignaciones_actualizadas: toUpdate.length,
      },
      logs,
      errores
    })

  } catch (err) {
    console.error('ERROR importarTransferencias:', err.message, err.stack)
    // Limpiar tabla temporal si quedó colgada
    // sin tabla temporal que limpiar
    res.status(500).json({ error: 'Error al importar: ' + err.message, logs, errores })
  }
}

async function listarCiclos(req, res) {
  try {
    const pool   = await getPool()
    const result = await pool.request().query(`
      SELECT
        c.id,
        c.nombre,
        c.anio,
        c.mes,
        c.fecha_inicio,
        c.fecha_fin,
        COUNT(DISTINCT a.id)                                      AS total_asignaciones,
        COUNT(DISTINCT t.id)                                      AS total_transferencias,
        COALESCE(SUM(DISTINCT a.monto_total), 0)                  AS monto_total,
        COUNT(DISTINCT CASE WHEN t.id IS NOT NULL THEN a.id END)  AS asignaciones_liberadas
      FROM EQRENDICION.PAE_CICLOS c
      LEFT JOIN EQRENDICION.PAE_ASIGNACIONES   a ON a.ciclo_id    = c.id
      LEFT JOIN EQRENDICION.PAE_TRANSFERENCIAS t ON t.asignacion_id = a.id
      GROUP BY c.id, c.nombre, c.anio, c.mes, c.fecha_inicio, c.fecha_fin
      ORDER BY c.anio, c.mes
    `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR listarCiclos:', err.message)
    res.status(500).json({ error: 'Error al listar ciclos' })
  }
}

async function modulosDeCiclo(req, res) {
  try {
    const pool    = await getPool()
    const cicloId = parseInt(req.params.ciclo_id)

    const result = await pool.request()
      .input('cid', sql.Int, cicloId)
      .query(`
        SELECT
          a.id                          AS asignacion_id,
          m.id                          AS modulo_id,
          m.codigo_modular,
          m.nivel,
          i.nombre                      AS nombre_ie,
          i.codigo                      AS codigo_ie,
          a.monto_total,
          a.presup_alimentos,
          a.presup_transporte,
          a.presup_gas,
          a.presup_estipendio,
          a.presup_limpieza,
          a.presup_otros,
          a.num_transferencias_excel    AS num_transferencias,
          a.monto_x_transf_excel        AS monto_x_transferencia,
          COUNT(t.id)                   AS transferencias_creadas
        FROM EQRENDICION.PAE_ASIGNACIONES   a
        JOIN EQRENDICION.PAE_MODULOS        m ON m.id = a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES  i ON i.id = m.institucion_id
        LEFT JOIN EQRENDICION.PAE_TRANSFERENCIAS t ON t.asignacion_id = a.id
        WHERE a.ciclo_id = @cid
        GROUP BY
          a.id, m.id, m.codigo_modular, m.nivel,
          i.nombre, i.codigo, a.monto_total,
          a.presup_alimentos, a.presup_transporte, a.presup_gas,
          a.presup_estipendio, a.presup_limpieza, a.presup_otros,
          a.num_transferencias_excel, a.monto_x_transf_excel
        ORDER BY i.nombre, m.nivel
      `)

    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR modulosDeCiclo:', err.message)
    res.status(500).json({ error: 'Error al obtener módulos' })
  }
}

async function liberarCiclo(req, res) {
  const cicloId            = parseInt(req.params.ciclo_id)
  const { fecha_envio, modulos } = req.body

  if (!fecha_envio)
    return res.status(400).json({ error: 'fecha_envio requerida' })
  if (!Array.isArray(modulos) || modulos.length === 0)
    return res.status(400).json({ error: 'Se requiere al menos un módulo' })

  const pool    = await getPool()
  const creadas = []
  const omitidos = []

  try {
    const cicloRes = await pool.request()
      .input('cid', sql.Int, cicloId)
      .query(`SELECT anio, mes FROM EQRENDICION.PAE_CICLOS WHERE id = @cid`)

    if (!cicloRes.recordset[0])
      return res.status(404).json({ error: 'Ciclo no encontrado' })

    const { anio, mes } = cicloRes.recordset[0]
    const mesPad = String(mes).padStart(2,'0')

    // Obtener códigos modulares de todas las asignaciones del ciclo de una vez
    const asigIds = modulos.map(m => m.asignacion_id).filter(Boolean)
    if (!asigIds.length) return res.status(400).json({ error: 'Sin asignaciones válidas' })

    const placeholders = asigIds.map((_, i) => `@id${i}`).join(',')
    const reqCods = pool.request()
    asigIds.forEach((id, i) => reqCods.input(`id${i}`, sql.Int, id))
    const codsRes = await reqCods.query(`
      SELECT a.id, m.codigo_modular
      FROM EQRENDICION.PAE_ASIGNACIONES a
      JOIN EQRENDICION.PAE_MODULOS m ON m.id = a.modulo_id
      WHERE a.id IN (${placeholders})
    `)
    const codMap = {}
    codsRes.recordset.forEach(r => { codMap[r.id] = r.codigo_modular })

    // Obtener transferencias ya existentes para estas asignaciones
    const reqEx = pool.request()
    asigIds.forEach((id, i) => reqEx.input(`id${i}`, sql.Int, id))
    const existRes = await reqEx.query(`
      SELECT asignacion_id, COUNT(*) AS cnt
      FROM EQRENDICION.PAE_TRANSFERENCIAS
      WHERE asignacion_id IN (${placeholders})
      GROUP BY asignacion_id
    `)
    const existMap = {}
    existRes.recordset.forEach(r => { existMap[r.asignacion_id] = r.cnt })

    // Procesar cada módulo
    for (const mod of modulos) {
      const { asignacion_id, num_transferencias, monto_x_transferencia,
              presup_alimentos, presup_transporte, presup_gas,
              presup_estipendio, presup_limpieza, presup_otros } = mod

      if (!asignacion_id || !num_transferencias || !monto_x_transferencia) {
        omitidos.push(`asignacion ${asignacion_id}: datos incompletos`)
        continue
      }

      // Actualizar presupuestos editados
      const montoTotal = Number(presup_alimentos||0) + Number(presup_transporte||0) +
                         Number(presup_gas||0)        + Number(presup_estipendio||0) +
                         Number(presup_limpieza||0)   + Number(presup_otros||0)

      await pool.request()
        .input('id',  sql.Int,           asignacion_id)
        .input('mt',  sql.Decimal(12,2),  montoTotal)
        .input('pa',  sql.Decimal(10,2),  Number(presup_alimentos  || 0))
        .input('ptr', sql.Decimal(10,2),  Number(presup_transporte || 0))
        .input('pg',  sql.Decimal(10,2),  Number(presup_gas        || 0))
        .input('pe',  sql.Decimal(10,2),  Number(presup_estipendio || 0))
        .input('pl',  sql.Decimal(10,2),  Number(presup_limpieza   || 0))
        .input('po',  sql.Decimal(10,2),  Number(presup_otros      || 0))
        .query(`
          UPDATE EQRENDICION.PAE_ASIGNACIONES
          SET monto_total=@mt, presup_alimentos=@pa, presup_transporte=@ptr,
              presup_gas=@pg, presup_estipendio=@pe, presup_limpieza=@pl, presup_otros=@po
          WHERE id=@id
        `)

      const codModular = codMap[asignacion_id] ?? asignacion_id
      const yaExisten  = existMap[asignacion_id] ?? 0

      // Crear transferencias faltantes
      for (let t = yaExisten + 1; t <= num_transferencias; t++) {
        const codigo = `TRF-${anio}-${mesPad}-${codModular}-T${t}`
        await pool.request()
          .input('aid',    sql.Int,          asignacion_id)
          .input('codigo', sql.VarChar,      codigo)
          .input('numero', sql.TinyInt,      t)
          .input('monto',  sql.Decimal(12,2), Number(monto_x_transferencia))
          .input('fe',     sql.Date,          fecha_envio)
          .query(`
            INSERT INTO EQRENDICION.PAE_TRANSFERENCIAS
              (asignacion_id, codigo, numero, monto, fecha_envio)
            VALUES (@aid, @codigo, @numero, @monto, @fe)
          `)
        creadas.push(codigo)
      }
    }

    res.json({
      ok: true,
      transferencias_creadas: creadas.length,
      omitidos,
      codigos: creadas
    })

  } catch (err) {
    console.error('ERROR liberarCiclo:', err.message, err.stack)
    res.status(500).json({ error: 'Error al liberar: ' + err.message })
  }
}

async function listarUsuariosTesoreros(req, res) {
  try {
    const pool   = await getPool()
    const result = await pool.request().query(`
      SELECT
        u.id,
        u.nombres,
        u.apellidos,
        u.email,
        COUNT(tm.id) AS modulos_asignados
      FROM EQRENDICION.PAE_USUARIOS u
      LEFT JOIN EQRENDICION.PAE_TESORERO_MODULO tm
        ON tm.usuario_id = u.id AND tm.activo = 1
      WHERE u.rol_id = (
        SELECT id FROM EQRENDICION.PAE_ROLES WHERE nombre = 'tesorero'
      )
      AND u.activo = 1
      GROUP BY u.id, u.nombres, u.apellidos, u.email
      ORDER BY u.apellidos, u.nombres
    `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR listarUsuariosTesoreros:', err.message)
    res.status(500).json({ error: 'Error al listar tesoreros' })
  }
}
 
async function asignarTesoreroManual(req, res) {
  const { modulo_id, usuario_id } = req.body
 
  if (!modulo_id || !usuario_id) {
    return res.status(400).json({ error: 'modulo_id y usuario_id son requeridos' })
  }
 
  try {
    const pool = await getPool()
 
    const usrRes = await pool.request()
      .input('uid', sql.Int, usuario_id)
      .query(`
        SELECT u.id, r.nombre AS rol
        FROM EQRENDICION.PAE_USUARIOS u
        JOIN EQRENDICION.PAE_ROLES r ON r.id = u.rol_id
        WHERE u.id = @uid AND u.activo = 1
      `)
 
    if (!usrRes.recordset[0])
      return res.status(404).json({ error: 'Usuario no encontrado' })
    if (usrRes.recordset[0].rol !== 'tesorero')
      return res.status(400).json({ error: 'El usuario no tiene rol tesorero' })
 
    const modRes = await pool.request()
      .input('mid', sql.Int, modulo_id)
      .query(`SELECT id FROM EQRENDICION.PAE_MODULOS WHERE id = @mid`)
 
    if (!modRes.recordset[0])
      return res.status(404).json({ error: 'Módulo no encontrado' })
 
    const yaAsig = await pool.request()
      .input('uid', sql.Int, usuario_id)
      .input('mid', sql.Int, modulo_id)
      .query(`
        SELECT id FROM EQRENDICION.PAE_TESORERO_MODULO
        WHERE usuario_id = @uid AND modulo_id = @mid AND activo = 1
      `)
 
    if (yaAsig.recordset[0]) {
      return res.json({ ok: true, mensaje: 'El tesorero ya estaba asignado a este módulo' })
    }
 
    await pool.request()
      .input('mid', sql.Int, modulo_id)
      .query(`
        UPDATE EQRENDICION.PAE_TESORERO_MODULO
        SET activo = 0, fecha_fin = CAST(GETDATE() AS DATE)
        WHERE modulo_id = @mid AND activo = 1
      `)
 
    await pool.request()
      .input('uid', sql.Int,  usuario_id)
      .input('mid', sql.Int,  modulo_id)
      .input('hoy', sql.Date, new Date().toISOString().split('T')[0])
      .query(`
        INSERT INTO EQRENDICION.PAE_TESORERO_MODULO
          (usuario_id, modulo_id, fecha_inicio, activo)
        VALUES (@uid, @mid, @hoy, 1)
      `)
 
    res.json({ ok: true, mensaje: 'Tesorero asignado correctamente' })
 
  } catch (err) {
    console.error('ERROR asignarTesoreroManual:', err.message, err.stack)
    res.status(500).json({ error: 'Error al asignar: ' + err.message })
  }
}
async function modulosDropdown(req, res) {
  try {
    const pool = await getPool()
    const result = await pool.request().query(`
      SELECT
        m.id          AS modulo_id,
        m.codigo_modular,
        m.nivel,
        i.nombre      AS nombre_institucion,
        u.nombres     AS tesorero_nombres,
        u.apellidos   AS tesorero_apellidos,
        u.email       AS tesorero_email,
        tm.fecha_inicio
      FROM EQRENDICION.PAE_MODULOS m
      JOIN EQRENDICION.PAE_INSTITUCIONES i
        ON i.id = m.institucion_id
      LEFT JOIN EQRENDICION.PAE_TESORERO_MODULO tm
        ON tm.modulo_id = m.id AND tm.activo = 1
      LEFT JOIN EQRENDICION.PAE_USUARIOS u
        ON u.id = tm.usuario_id
      WHERE m.activo = 1
      ORDER BY i.nombre, m.nivel
    `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR modulosDropdown:', err.message)
    res.status(500).json({ error: 'Error al obtener módulos' })
  }
}

module.exports = {
  importarTransferencias,
  listarCiclos,
  modulosDeCiclo,
  liberarCiclo,
  asignarTesoreroManual,
  modulosDropdown
}