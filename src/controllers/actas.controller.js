const { getPool, sql } = require('../config/db')
const PDFDocument = require('pdfkit')

async function getAll(req, res) {
  const { asignacion_id } = req.query
  if (!asignacion_id) return res.status(400).json({ error: 'asignacion_id requerido' })

  try {
    const pool = await getPool()
    const result = await pool.request()
      .input('aid', sql.Int, asignacion_id)
      .query(`
        SELECT a.id, a.asignacion_id, a.fecha_comite, a.pdf_nombre, a.creado_en,
               u.nombres + ' ' + u.apellidos AS generada_por_nombre
        FROM EQRENDICION.PAE_ACTAS a
        JOIN EQRENDICION.PAE_USUARIOS u ON u.id = a.generada_por
        WHERE a.asignacion_id = @aid
        ORDER BY a.creado_en DESC
      `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR getAll actas:', err.message)
    res.status(500).json({ error: 'Error al obtener actas' })
  }
}

async function generarActa(req, res) {
  const { asignacion_id, fecha_comite } = req.body
  const userId = req.user.id

  if (!asignacion_id || !fecha_comite)
    return res.status(400).json({ error: 'asignacion_id y fecha_comite son requeridos' })

  try {
    const pool = await getPool()

    const infoResult = await pool.request()
      .input('aid', sql.Int, asignacion_id)
      .query(`
        SELECT i.nombre  AS institucion,
               i.distrito,
               i.codigo  AS cod_ie,
               c.nombre  AS ciclo,
               c.mes, c.anio,
               a.monto_total,
               a.num_transferencias,
               a.presup_alimentos, a.presup_transporte, a.presup_gas,
               a.presup_estipendio, a.presup_limpieza, a.presup_otros,
               u.nombres + ' ' + u.apellidos AS tesorero_nombre,
               u.email   AS tesorero_email
        FROM EQRENDICION.PAE_ASIGNACIONES a
        JOIN EQRENDICION.PAE_INSTITUCIONES i ON i.id = a.institucion_id
        JOIN EQRENDICION.PAE_CICLOS        c ON c.id = a.ciclo_id
        JOIN EQRENDICION.PAE_USUARIOS      u ON u.id = i.tesorero_id
        WHERE a.id = @aid
      `)

    if (!infoResult.recordset[0])
      return res.status(404).json({ error: 'Asignación no encontrada' })

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

    const mesStr  = String(info.mes).padStart(2, '0')
    const pdfNombre = `acta-${info.anio}-${mesStr}-asig${asignacion_id}.pdf`

    await pool.request()
      .input('aid',    sql.Int,     asignacion_id)
      .input('fecha',  sql.Date,    fecha_comite)
      .input('userId', sql.Int,     userId)
      .input('nombre', sql.VarChar, pdfNombre)
      .query(`
        INSERT INTO EQRENDICION.PAE_ACTAS (asignacion_id, fecha_comite, generada_por, pdf_nombre)
        VALUES (@aid, @fecha, @userId, @nombre)
      `)

    const meses   = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                     'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
    const letras  = ['a','b','c','d']
    const ordinal = ['Primera','Segunda','Tercera','Cuarta']
    const mesNombre  = meses[(info.mes - 1)] ?? ''

    const dtComite = new Date(fecha_comite + 'T00:00:00')
    const diaComite  = dtComite.getDate()
    const mesComite  = meses[dtComite.getMonth()]
    const anioComite = dtComite.getFullYear()

    const doc   = new PDFDocument({ size: 'A4', margin: 50 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename=${pdfNombre}`)
    doc.pipe(res)

    const pageW = 495  

    const cell = (x, y, w, h, text, opts = {}) => {
      doc.rect(x, y, w, h).stroke()
      doc.fontSize(opts.fs ?? 9)
         .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
         .fillColor(opts.color ?? 'black')
         .text(String(text ?? ''), x + 4, y + (h - (opts.fs ?? 9)) / 2 - 1, {
           width: w - 8,
           align: opts.align ?? 'left',
           lineBreak: false
         })
    }

    doc.fontSize(9).font('Helvetica-Bold').fillColor('black')
       .text('FORMATO N°', { align: 'center' })
       .moveDown(0.4)

    const titleY = doc.y
    doc.rect(50, titleY, pageW, 28).fillAndStroke('#F1A983', '#F1A983')
    doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
       .text('ACTA DE ASAMBLEA DEL CGAE - RENDICIÓN DE CUENTAS',
             50, titleY + 8, { width: pageW, align: 'center' })
    doc.moveDown(2.2)

    doc.fontSize(10).font('Helvetica').fillColor('black')
    doc.text(
      `En el distrito de ${info.distrito ?? '........................................'}, ` +
      `siendo las ........... horas del día ${diaComite} de ${mesComite} del ${anioComite}, ` +
      `los miembros del Comité de Gestión para la Alimentación Escolar (CGAE) presentan ` +
      `la rendición de cuentas ante el Comité de Alimentación Escolar, así como ante las ` +
      `madres y padres de familia (de ser el caso), presentes en la Institución Educativa ` +
      `N.° ${info.cod_ie} - ${info.institucion}.`,
      { align: 'justify' }
    )
    doc.moveDown(0.6)
    doc.text(
      `La rendición de cuentas para la gestión del servicio alimentario corresponde a la ` +
      `subvención económica correspondiente al mes de ${mesNombre} del ${info.anio}.`,
      { align: 'justify' }
    )
    doc.moveDown(1.2)

    const tX = 50
    const c1 = 250
    const c2 = 110
    const c3 = 135
    const rowH = 22
    let tY = doc.y

    doc.rect(tX, tY, c1 + c2 + c3, rowH).fillAndStroke('#F1A983', '#F1A983')
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
       .text('RENDICIÓN DE CUENTAS', tX, tY + 7, { width: c1 + c2 + c3, align: 'center' })
    tY += rowH

    cell(tX,         tY, c1 + c2, rowH, 'Monto total destinado por ciclo (mes)', { bold: true })
    cell(tX+c1+c2,   tY, c3,      rowH,
      `S/ ${Number(info.monto_total).toLocaleString('es-PE', { minimumFractionDigits: 2 })}`,
      { align: 'right' }
    )
    tY += rowH

    cell(tX,       tY, c1 + c2, rowH, 'Número de transferencias del ciclo', { bold: true })
    cell(tX+c1+c2, tY, c3,      rowH, String(transferencias.length), { align: 'right' })
    tY += rowH

    transferencias.forEach((t, i) => {
      const lbl = `${letras[i]}.  ${ordinal[i]} Transferencia del ciclo`
      const fmt = (v) => v != null
        ? `S/ ${Number(v).toLocaleString('es-PE', { minimumFractionDigits: 2 })}`
        : '-'
      const fmtFecha = (f) => f
        ? new Date(f).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '-'

      cell(tX,         tY, c1,  rowH, lbl, { bold: true })
      cell(tX+c1,      tY, c2,  rowH, 'Monto recibido')
      cell(tX+c1+c2,   tY, c3,  rowH, fmt(t.monto), { align: 'right' })
      tY += rowH

      cell(tX,         tY, c1,  rowH, '')
      cell(tX+c1,      tY, c2,  rowH, 'Fecha de recepción')
      cell(tX+c1+c2,   tY, c3,  rowH, fmtFecha(t.fecha_recepcion), { align: 'right' })
      tY += rowH
    })

    tY += 16
    const rubros = [
      { label: 'Alimentos',   val: info.presup_alimentos  },
      { label: 'Transporte',  val: info.presup_transporte },
      { label: 'Gas',         val: info.presup_gas        },
      { label: 'Estipendio',  val: info.presup_estipendio },
      { label: 'Limpieza',    val: info.presup_limpieza   },
      { label: 'Otros',       val: info.presup_otros      },
    ].filter(r => r.val > 0)

    if (rubros.length) {
      doc.rect(tX, tY, c1 + c2 + c3, rowH).fillAndStroke('#1a2f6e', '#1a2f6e')
      doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
         .text('DISTRIBUCIÓN DEL PRESUPUESTO POR RUBRO', tX, tY + 7,
               { width: c1 + c2 + c3, align: 'center' })
      tY += rowH

      rubros.forEach(r => {
        cell(tX,       tY, c1 + c2, rowH, r.label.toUpperCase())
        cell(tX+c1+c2, tY, c3,      rowH,
          `S/ ${Number(r.val).toLocaleString('es-PE', { minimumFractionDigits: 2 })}`,
          { align: 'right' }
        )
        tY += rowH
      })
    }

    tY += 30
    doc.y = tY

    doc.moveTo(tX, tY + 40).lineTo(tX + 200, tY + 40).stroke()
    doc.fontSize(9).font('Helvetica-Bold').fillColor('black')
       .text(info.tesorero_nombre ?? '....................................',
             tX, tY + 44, { width: 200, align: 'center' })
    doc.fontSize(8).font('Helvetica').fillColor('#444')
       .text('Tesorero(a) del CGAE', tX, tY + 56, { width: 200, align: 'center' })
    doc.fontSize(8).font('Helvetica').fillColor('#444')
       .text(`IE N° ${info.cod_ie}`, tX, tY + 67, { width: 200, align: 'center' })

    doc.end()

  } catch (err) {
    console.error('ERROR generarActa:', err.message, err.stack)
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar el acta' })
  }
}

module.exports = { getAll, generarActa }