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
    console.error('ERROR getAll transferencias:', err.message, err.stack)
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
const PDFDocument = require('pdfkit')

async function generarActa(req, res) {
  const { asignacion_id } = req.query

  if (!asignacion_id)
    return res.status(400).json({ error: 'asignacion_id requerido' })

  try {
    const pool = await getPool()

    const infoResult = await pool.request()
      .input('aid', sql.Int, asignacion_id)
      .query(`
        SELECT i.nombre AS institucion, i.distrito,
               c.nombre AS ciclo, c.mes, c.anio,
               a.monto_total, a.num_transferencias
        FROM EQRENDICION.PAE_ASIGNACIONES a
        JOIN EQRENDICION.PAE_INSTITUCIONES i ON i.id = a.institucion_id
        JOIN EQRENDICION.PAE_CICLOS c        ON c.id = a.ciclo_id
        WHERE a.id = @aid
      `)

    if (!infoResult.recordset[0])
      return res.status(404).json({ error: 'No se encontró la asignación' })

    const info = infoResult.recordset[0]

    const transfResult = await pool.request()
      .input('aid', sql.Int, asignacion_id)
      .query(`
        SELECT numero, monto, fecha_recepcion, estado
        FROM EQRENDICION.PAE_TRANSFERENCIAS
        WHERE asignacion_id = @aid
        ORDER BY numero ASC
      `)

    const transferencias = transfResult.recordset

    const rubrosResult = await pool.request()
      .input('aid', sql.Int, asignacion_id)
      .query(`
        SELECT v.rubro, 
               SUM(v.total_gastado)     AS total_gastado,
               MAX(v.presupuesto_rubro) AS presupuesto_rubro,
               MIN(v.saldo_rubro)       AS saldo_rubro
        FROM EQRENDICION.V_GASTO_X_RUBRO v
        JOIN EQRENDICION.PAE_TRANSFERENCIAS t ON t.id = v.transferencia_id
        WHERE t.asignacion_id = @aid
        GROUP BY v.rubro
        ORDER BY v.rubro
      `)

    const meses  = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
    const letras = ['a','b','c','d']
    const ordinal = ['Primera','Segunda','Tercera','Cuarta']
    const mesNombre = meses[(info.mes - 1)] ?? ''
    const distrito  = info.distrito ?? '........................................'

    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename=acta-${info.anio}-${String(info.mes).padStart(2,'0')}.pdf`)
    doc.pipe(res)

    const rowH  = 22
    const pageW = 495  

    const cell = (x, y, w, h, text, opts = {}) => {
      doc.rect(x, y, w, h).stroke()
      doc.fontSize(opts.fs ?? 9)
         .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
         .fillColor(opts.color ?? 'black')
         .text(String(text), x + 4, y + (h - (opts.fs ?? 9)) / 2 - 1, {
           width: w - 8,
           align: opts.align ?? 'left',
           lineBreak: false
         })
    }

    doc.fontSize(9).font('Helvetica-Bold')
       .text('FORMATO N°', { align: 'center' })
       .moveDown(0.4)

    const titleY = doc.y
    doc.rect(50, titleY, pageW, 28).fillAndStroke('#E07020', '#E07020')
    doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
       .text('ACTA DE ASAMBLEA DEL CGAE - RENDICIÓN DE CUENTAS', 50, titleY + 8, {
         width: pageW, align: 'center'
       })
    doc.moveDown(2.2)

    doc.fontSize(10).font('Helvetica').fillColor('black')
    doc.text(
      `En el distrito de ${distrito}, siendo las ........... horas del día .......... ` +
      `de ................. del ${info.anio}, los miembros del Comité de Gestión para ` +
      `la Alimentación Escolar (CGAE) presentan la rendición de cuentas ante el Comité ` +
      `de Alimentación Escolar, así como ante las madres y padres de familia (de ser el ` +
      `caso), presentes en la Institución Educativa N.°`,
      { align: 'justify' }
    )
    doc.text('.........................................................................', { align: 'left' })
    doc.moveDown(0.6)
    doc.text(
      `La rendición de cuentas para la gestión del servicio alimentario corresponde a la ` +
      `................................. correspondiente al mes de ${mesNombre} del ${info.anio}.`,
      { align: 'justify' }
    )
    doc.moveDown(1.2)

    const tX  = 100
    const c1  = 210   
    const c2  = 70   
    const c3  = 90  
    const tW  = c1 + c2 + c3
    let   tY  = doc.y

    doc.rect(tX, tY, tW, rowH).fillAndStroke('#E07020', '#E07020')
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
       .text('RENDICIÓN DE CUENTAS', tX, tY + 7, { width: tW, align: 'center' })
    tY += rowH

    cell(tX,        tY, c1 + c2, rowH, 'Monto total destinado por ciclo (mes)')
    cell(tX+c1+c2,  tY, c3,      rowH,
      `S/ ${Number(info.monto_total).toLocaleString('es-PE',{minimumFractionDigits:2})}`,
      { align: 'right' }
    )
    tY += rowH

    cell(tX,       tY, c1+c2, rowH, 'Número de transferencias')
    cell(tX+c1+c2, tY, c3,    rowH, String(info.num_transferencias), { align: 'right' })
    tY += rowH

    for (let i = 0; i < 4; i++) {
      const t   = transferencias[i]
      const lbl = `${letras[i]}.  ${ordinal[i]} Transferencia del ciclo`

      cell(tX,       tY, c1, rowH, lbl, { bold: true })
      cell(tX+c1,    tY, c2, rowH, 'Monto')
      cell(tX+c1+c2, tY, c3, rowH,
        t ? `S/ ${Number(t.monto).toLocaleString('es-PE',{minimumFractionDigits:2})}` : '-',
        { align: 'right' }
      )
      tY += rowH

      cell(tX,       tY, c1, rowH, '')
      cell(tX+c1,    tY, c2, rowH, 'Fecha')
      cell(tX+c1+c2, tY, c3, rowH,
        t?.fecha_recepcion
          ? new Date(t.fecha_recepcion).toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit',year:'numeric'})
          : '-',
        { align: 'right' }
      )
      tY += rowH
    }

    doc.y = tY + 16
    doc.end()

  } catch (err) {
    console.error(err)
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar el acta' })
  }
}

module.exports = { getAll, getOne, getRubros, cambiarEstado, generarActa  }
