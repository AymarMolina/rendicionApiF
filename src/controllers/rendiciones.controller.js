const { getPool, sql } = require('../config/db')
const PDFDocument      = require('pdfkit')
const archiver         = require('archiver')
const path             = require('path')
const fs               = require('fs')

const LOGO_MINISTERIO = path.join(__dirname, '..', 'images', 'logoMidis.png')
const LOGO_PAE        = path.join(__dirname, '..', 'images', 'logopae.png')

async function getByTransferencia(req, res) {
  try {
    const pool = await getPool()
    const tid  = parseInt(req.params.transferencia_id, 10)

    const resumen = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT
          r.id                              AS rendicion_id,
          t.id                              AS transferencia_id,
          t.codigo                          AS codigo_transferencia,
          t.monto                           AS monto_transferencia,
          t.numero,
          t.fecha_limite_rendicion,
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
             WHERE cp.transferencia_id = t.id),
            0
          )                                 AS total_gastos_registrados,
          COALESCE(r.estado, 'borrador')    AS estado,
          r.enviada_en,
          r.observaciones
        FROM EQRENDICION.PAE_TRANSFERENCIAS t
        JOIN EQRENDICION.PAE_ASIGNACIONES   a  ON a.id  = t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS        m  ON m.id  = a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES  i  ON i.id  = m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS         c  ON c.id  = a.ciclo_id
        LEFT JOIN EQRENDICION.PAE_RENDICIONES r ON r.transferencia_id = t.id
        WHERE t.id = @tid
      `)

    const gastos = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT
          g.id,
          g.comprobante_id,
          g.concepto,
          g.rubro,
          g.monto,
          g.estado,
          g.observacion,
          c.fecha_documento,
          c.tipo_comprobante,
          c.num_comprobante,
          c.tiene_ruc,
          c.archivo_url,
          dj.nombre_proveedor  AS dj_nombre_proveedor,
          dj.dni_proveedor,
          dj.descripcion       AS dj_descripcion,
          pm.punto_partida,
          pm.punto_llegada,
          pm.motivo            AS mov_motivo,
          u.nombres + ' ' + u.apellidos AS registrado_nombre
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES    c  ON c.id  = g.comprobante_id
        JOIN EQRENDICION.PAE_USUARIOS        u  ON u.id  = c.registrado_por
        LEFT JOIN EQRENDICION.PAE_DECL_JURADAS   dj ON dj.comprobante_id = c.id
        LEFT JOIN EQRENDICION.PAE_PLAN_MOVILIDAD pm ON pm.comprobante_id = c.id
        WHERE c.transferencia_id = @tid
        ORDER BY c.fecha_documento, c.id, g.id
      `)

    const observaciones = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT
          o.id, o.comentario, o.creado_en,
          u.nombres + ' ' + u.apellidos AS autor,
          r2.nombre AS rol
        FROM EQRENDICION.PAE_REND_OBSERVACIONES o
        JOIN EQRENDICION.PAE_USUARIOS u  ON u.id  = o.usuario_id
        JOIN EQRENDICION.PAE_ROLES    r2 ON r2.id = u.rol_id
        WHERE o.rendicion_id = (
          SELECT id FROM EQRENDICION.PAE_RENDICIONES WHERE transferencia_id = @tid
        )
        ORDER BY o.creado_en
      `)

    res.json({
      resumen:       resumen.recordset[0] ?? null,
      gastos:        gastos.recordset,
      observaciones: observaciones.recordset
    })
  } catch (err) {
    console.error('ERROR getByTransferencia:', err.message)
    res.status(500).json({ error: 'Error al obtener rendición' })
  }
}

async function upsert(req, res) {
  const {
    transferencia_id, efectivo_en_caja, observaciones,
    fecha_limite_rendicion  
  } = req.body
  if (!transferencia_id) return res.status(400).json({ error: 'transferencia_id requerido' })

  try {
    const pool = await getPool()

    if (fecha_limite_rendicion) {
      await pool.request()
        .input('tid',   sql.Int,  transferencia_id)
        .input('fecha', sql.Date, fecha_limite_rendicion)
        .query(`
          UPDATE EQRENDICION.PAE_TRANSFERENCIAS
          SET    fecha_limite_rendicion = @fecha
          WHERE  id = @tid
        `)
    }

    const existing = await pool.request()
      .input('tid', sql.Int, transferencia_id)
      .query(`SELECT id, estado FROM EQRENDICION.PAE_RENDICIONES WHERE transferencia_id = @tid`)

    if (existing.recordset[0]) {
      const r = existing.recordset[0]
      if (r.estado === 'aprobada')
        return res.status(400).json({ error: 'La rendición ya está aprobada y no puede modificarse' })

      await pool.request()
        .input('id',   sql.Int,          r.id)
        .input('caja', sql.Decimal(10,2), parseFloat(efectivo_en_caja) || 0)
        .input('obs',  sql.NVarChar,     observaciones || null)
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
        SELECT
          t.monto,
          COALESCE(
            (SELECT SUM(g.monto)
             FROM EQRENDICION.PAE_GASTOS g
             JOIN EQRENDICION.PAE_COMPROBANTES cp ON cp.id = g.comprobante_id
             WHERE cp.transferencia_id = @tid),
            0
          ) AS gastado
        FROM EQRENDICION.PAE_TRANSFERENCIAS t
        WHERE t.id = @tid
      `)

    const { monto, gastado } = totResult.recordset[0]
    const caja       = parseFloat(efectivo_en_caja) || 0
    const saldoFinal = monto - gastado - caja

    const insert = await pool.request()
      .input('tid',   sql.Int,          transferencia_id)
      .input('caja',  sql.Decimal(10,2), caja)
      .input('saldo', sql.Decimal(10,2), saldoFinal)
      .input('obs',   sql.NVarChar,     observaciones || null)
      .input('uid',   sql.Int,          req.user.id)
      .query(`
        INSERT INTO EQRENDICION.PAE_RENDICIONES
          (transferencia_id, efectivo_en_caja, saldo_final, observaciones, creado_por)
        OUTPUT INSERTED.id
        VALUES (@tid, @caja, @saldo, @obs, @uid)
      `)

    res.status(201).json({ message: 'Rendición creada', rendicion_id: insert.recordset[0].id })
  } catch (err) {
    console.error('ERROR upsert rendicion:', err.message)
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
    console.error('ERROR enviar rendicion:', err.message)
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
        UPDATE EQRENDICION.PAE_TRANSFERENCIAS
        SET estado = 'aprobada'
        WHERE id = (SELECT transferencia_id FROM EQRENDICION.PAE_RENDICIONES WHERE id = @id)
      `)
    res.json({ message: 'Rendición aprobada' })
  } catch (err) {
    console.error('ERROR aprobar rendicion:', err.message)
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
      .input('rid', sql.Int,      req.params.id)
      .input('uid', sql.Int,      req.user.id)
      .input('com', sql.NVarChar, comentario)
      .query(`
        INSERT INTO EQRENDICION.PAE_REND_OBSERVACIONES (rendicion_id, usuario_id, comentario)
        VALUES (@rid, @uid, @com)
      `)
    res.json({ message: 'Rendición observada' })
  } catch (err) {
    console.error('ERROR observar rendicion:', err.message)
    res.status(500).json({ error: 'Error al observar rendición' })
  }
}

async function generarAnexo3(req, res) {
  try {
    const pool = await getPool()
    const tid  = parseInt(req.params.transferencia_id, 10)

    const MESES    = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
    const fmtFecha = (f) => {
      if (!f) return ''
      const d = new Date(f)
      return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
    }
    const fmtMonto = (n) => Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })
    const TIPO_LABEL = {
      boleta_venta:      'BOLETA DE VENTA',
      recibo_gasto:      'RECIBO DE GASTO',
      factura:           'FACTURA',
      ticket:            'TICKET',
      declaracion_jurada:'DECLARACIÓN JURADA',
      planilla_movilidad:'PLANILLA MOVILIDAD'
    }

    const infoRes = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT
          t.monto, t.fecha_recepcion, t.codigo, t.numero,
          i.nombre   AS ie_nombre, i.codigo   AS ie_codigo,
          c.nombre   AS ciclo, c.mes, c.anio, c.fecha_inicio, c.fecha_fin,
          m.nivel, m.codigo_modular,
          u.nombres + ' ' + u.apellidos AS tesorero
        FROM EQRENDICION.PAE_TRANSFERENCIAS    t
        JOIN EQRENDICION.PAE_ASIGNACIONES      a  ON a.id  = t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS           m  ON m.id  = a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES     i  ON i.id  = m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS            c  ON c.id  = a.ciclo_id
        JOIN EQRENDICION.PAE_TESORERO_MODULO   tm ON tm.modulo_id = m.id AND tm.activo = 1
        JOIN EQRENDICION.PAE_USUARIOS          u  ON u.id  = tm.usuario_id
        WHERE t.id = @tid
      `)

    if (!infoRes.recordset[0]) return res.status(404).json({ error: 'Transferencia no encontrada' })
    const info = infoRes.recordset[0]

    const gastosRes = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT g.id, g.concepto, g.rubro, g.monto,
               c.tipo_comprobante, c.num_comprobante, c.fecha_documento, c.archivo_url
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES c ON c.id = g.comprobante_id
        WHERE c.transferencia_id = @tid
        ORDER BY c.fecha_documento, c.id, g.id
      `)
    const gastos = gastosRes.recordset

    const rendRes = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`SELECT COALESCE(efectivo_en_caja, 0) AS efectivo_en_caja FROM EQRENDICION.PAE_RENDICIONES WHERE transferencia_id = @tid`)
    const efectivoEnCaja  = Number(rendRes.recordset[0]?.efectivo_en_caja ?? 0)
    const montoTransf     = Number(info.monto)
    const totalGastado    = gastos.reduce((s, g) => s + Number(g.monto), 0)
    const saldoDisponible = montoTransf - totalGastado - efectivoEnCaja

    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 28 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename=${info.codigo.replace(/\//g,'-')}.pdf`)
    doc.pipe(res)

    const MARGIN = 28, PW = 539, ORNG = '#F1A983', LGRY = '#f0f2f8', GREY = '#cfd2da'

    doc.rect(MARGIN, 12, 100, 32).fill('#c00')
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('PERÚ', MARGIN + 6, 16)
    doc.fontSize(5.5).font('Helvetica').text('Ministerio de Desarrollo', MARGIN + 6, 25).text('e Inclusión Social', MARGIN + 6, 32)
    doc.rect(MARGIN + 104, 12, 44, 32).fill(ORNG)
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold').text('PAE', MARGIN + 112, 23)
    doc.rect(MARGIN + 152, 12, PW - 152, 32).fill(ORNG)
    doc.fillColor('white').fontSize(10.5).font('Helvetica-Bold').text('FORMATO DE BALANCE DE GASTOS', MARGIN + 152, 22, { width: PW - 152, align: 'center' })

    let y = 56
    const col1X = MARGIN, col2X = MARGIN + PW / 2 + 4, colW = PW / 2 - 4

    const infoBox = (label, value, x, w, yy) => {
      doc.rect(x, yy, w, 16).fillAndStroke(LGRY, '#d4dae8')
      doc.fillColor(ORNG).font('Helvetica-Bold').fontSize(7).text(label, x + 4, yy + 4, { lineBreak: false })
      const lw = doc.widthOfString(label) + 8
      doc.fillColor('#1a2340').font('Helvetica').fontSize(7).text(value || '', x + lw, yy + 4, { width: w - lw - 4, lineBreak: false })
    }

    infoBox('IE:', `${info.ie_nombre} (${info.nivel?.toUpperCase()})`, col1X, colW, y)
    infoBox('TESORERO:', info.tesorero, col2X, colW, y); y += 20
    infoBox('MES:', `${MESES[(info.mes - 1)] || ''} ${info.anio}`, col1X, colW, y)
    infoBox('PERIODO:', `${fmtFecha(info.fecha_inicio)} al ${fmtFecha(info.fecha_fin)}`, col2X, colW, y); y += 20
    infoBox('CÓDIGO MODULAR:', info.codigo_modular || '', col1X, colW, y)
    infoBox('TRANSFERENCIA:', `${info.codigo} (${info.numero}/${info.num_transferencias ?? '?'})`, col2X, colW, y); y += 24

    const cols = [PW - 90 - 30, 30, 90], rtH = 14
    const rtRow = (label, moneda, valor, bg) => {
      doc.rect(MARGIN, y, cols[0], rtH).fillAndStroke(bg || '#fff', '#d4dae8')
      doc.rect(MARGIN + cols[0], y, cols[1], rtH).fillAndStroke(bg || '#fff', '#d4dae8')
      doc.rect(MARGIN + cols[0] + cols[1], y, cols[2], rtH).fillAndStroke(bg || '#fff', '#d4dae8')
      doc.fillColor('#1a2340').font('Helvetica-Bold').fontSize(7.5).text(label, MARGIN + 4, y + 3, { lineBreak: false })
      doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text(moneda, MARGIN + cols[0] + 4, y + 3, { lineBreak: false })
      doc.fillColor('#1a2340').font('Helvetica-Bold').fontSize(7.5).text(valor, MARGIN + cols[0] + cols[1] + 3, y + 3, { width: cols[2] - 6, align: 'right', lineBreak: false })
      y += rtH
    }
    rtRow('Monto Transferido', 'S/', fmtMonto(montoTransf),    LGRY)
    rtRow('Total Gastado',     'S/', fmtMonto(totalGastado),   '#fef3c7')
    rtRow('Efectivo en Caja',  'S/', fmtMonto(efectivoEnCaja), LGRY)
    rtRow('Saldo Disponible',  'S/', fmtMonto(saldoDisponible), saldoDisponible < 0 ? '#fee2e2' : '#d1fae5')
    y += 10

    const cN=20, cDet=130, cTipo=90, cDoc=60, cFech=52, cRub=60
    const cMon = PW - cN - cDet - cTipo - cDoc - cFech - cRub
    const rowH = 15
    const headers = [
      { label: 'N°', w: cN }, { label: 'Detalle', w: cDet },
      { label: 'Tipo Documento', w: cTipo }, { label: 'N° Documento', w: cDoc },
      { label: 'Fecha', w: cFech }, { label: 'Rubro', w: cRub }, { label: 'Monto S/', w: cMon },
    ]
    const drawTableHeader = () => {
      let cx = MARGIN
      headers.forEach(({ label, w }) => {
        doc.rect(cx, y, w, rowH).fillAndStroke(ORNG, ORNG)
        doc.fillColor('white').font('Helvetica-Bold').fontSize(7).text(label, cx + 2, y + 4, { width: w - 4, align: 'center', lineBreak: false })
        cx += w
      })
      y += rowH
    }
    drawTableHeader()
    gastos.forEach((g, i) => {
      const bg = i % 2 === 0 ? '#fff' : '#f5f7ff'
      if (y > 760) { doc.addPage(); y = 28; drawTableHeader() }
      const cell = (x, w, text, align = 'left', bold = false) => {
        doc.rect(x, y, w, rowH).fill(bg)
        doc.rect(x, y, w, rowH).stroke('#d4dae8')
        if (text) doc.fillColor('#1a2340').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5)
           .text(String(text), x + 3, y + (rowH - 6.5) / 2, { width: w - 6, align, lineBreak: false })
      }
      let cx = MARGIN
      cell(cx, cN, String(i + 1), 'center'); cx += cN
      cell(cx, cDet, g.concepto ?? '', 'left', true); cx += cDet
      cell(cx, cTipo, TIPO_LABEL[g.tipo_comprobante] ?? '', 'left'); cx += cTipo
      cell(cx, cDoc, g.num_comprobante ?? '', 'center'); cx += cDoc
      cell(cx, cFech, fmtFecha(g.fecha_documento), 'center'); cx += cFech
      cell(cx, cRub, g.rubro ?? '', 'center'); cx += cRub
      cell(cx, cMon, fmtMonto(g.monto), 'right', true)
      y += rowH
    })
    if (y > 760) { doc.addPage(); y = 28 }
    let cx = MARGIN
    ;[cN, cDet, cTipo, cDoc, cFech, cRub].forEach(w => { doc.rect(cx, y, w, rowH).fillAndStroke(ORNG, ORNG); cx += w })
    doc.fillColor('white').font('Helvetica-Bold').fontSize(7.5).text('TOTAL', MARGIN + 3, y + 4, { width: cN + cDet + cTipo + cDoc + cFech + cRub - 6, align: 'right', lineBreak: false })
    doc.rect(cx, y, cMon, rowH).fillAndStroke(ORNG, ORNG)
    doc.fillColor('white').font('Helvetica-Bold').fontSize(7.5).text(fmtMonto(totalGastado), cx + 2, y + 4, { width: cMon - 4, align: 'right', lineBreak: false })
    y += rowH + 30
    const sigW = 200, sigX = MARGIN + (PW - sigW) / 2
    doc.moveTo(sigX, y + 28).lineTo(sigX + sigW, y + 28).stroke()
    doc.fillColor('black').font('Helvetica-Bold').fontSize(8).text(info.tesorero, sigX, y + 32, { width: sigW, align: 'center' })
    doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text('Tesorero(a) del CGAE', sigX, y + 43, { width: sigW, align: 'center' })
    doc.end()
  } catch (err) {
    console.error('ERROR generarAnexo3:', err.message, err.stack)
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar Anexo 3' })
  }
}

async function descargarComprobantesZip(req, res) {
  try {
    const pool = await getPool()
    const tid  = parseInt(req.params.transferencia_id, 10)
    const gastosRes = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT DISTINCT c.id, c.tipo_comprobante, c.num_comprobante, c.archivo_url, g.concepto, g.rubro
        FROM EQRENDICION.PAE_COMPROBANTES c
        JOIN EQRENDICION.PAE_GASTOS g ON g.comprobante_id = c.id
        WHERE c.transferencia_id = @tid AND c.archivo_url IS NOT NULL
        ORDER BY c.id
      `)
    const transRes = await pool.request().input('tid', sql.Int, tid)
      .query(`SELECT codigo FROM EQRENDICION.PAE_TRANSFERENCIAS WHERE id = @tid`)
    const codigo = transRes.recordset[0]?.codigo ?? `transf-${tid}`
    const comps  = gastosRes.recordset
    if (comps.length === 0) return res.status(404).json({ error: 'No hay comprobantes adjuntos' })
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename=comprobantes-${codigo.replace(/\//g,'-')}.zip`)
    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.pipe(res)
    const uploadsBase = path.join(__dirname, '..', '..', 'uploads')
    let adjuntados = 0
    for (const [idx, c] of comps.entries()) {
      const fileName = path.basename(c.archivo_url)
      const filePath = path.join(uploadsBase, fileName)
      if (fs.existsSync(filePath)) {
        const tipo     = c.tipo_comprobante.replace(/_/g,'-')
        const concepto = (c.concepto ?? '').substring(0, 30).replace(/[^a-zA-Z0-9 ]/g,'').trim()
        const ext      = path.extname(fileName)
        archive.file(filePath, { name: `${String(idx + 1).padStart(2,'0')}-${tipo}-${concepto}${ext}` })
        adjuntados++
      }
    }
    if (adjuntados === 0) { archive.abort(); return res.status(404).json({ error: 'Archivos no encontrados' }) }
    await archive.finalize()
  } catch (err) {
    console.error('ERROR comprobantesZip:', err.message)
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar ZIP' })
  }
}

async function generarDJPdf(req, res) {
  try {
    const pool = await getPool()
    const tid  = parseInt(req.params.transferencia_id, 10)
    const fmtFecha = (f) => { if (!f) return ''; const d = new Date(f); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}` }
    const fmtMonto = (n) => Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })
    const infoRes = await pool.request().input('tid', sql.Int, tid).query(`
      SELECT i.nombre AS ie_nombre, i.distrito, i.ugel, i.codigo AS ie_codigo,
             c.anio, c.fecha_inicio, c.fecha_fin, t.codigo AS t_codigo,
             m.nivel, m.codigo_modular, u.nombres + ' ' + u.apellidos AS tesorero
      FROM EQRENDICION.PAE_TRANSFERENCIAS    t
      JOIN EQRENDICION.PAE_ASIGNACIONES      a  ON a.id  = t.asignacion_id
      JOIN EQRENDICION.PAE_MODULOS           m  ON m.id  = a.modulo_id
      JOIN EQRENDICION.PAE_INSTITUCIONES     i  ON i.id  = m.institucion_id
      JOIN EQRENDICION.PAE_CICLOS            c  ON c.id  = a.ciclo_id
      JOIN EQRENDICION.PAE_TESORERO_MODULO   tm ON tm.modulo_id = m.id AND tm.activo = 1
      JOIN EQRENDICION.PAE_USUARIOS          u  ON u.id  = tm.usuario_id
      WHERE t.id = @tid
    `)
    if (!infoRes.recordset[0]) return res.status(404).json({ error: 'Transferencia no encontrada' })
    const info = infoRes.recordset[0]
    const djRes = await pool.request().input('tid', sql.Int, tid).query(`
      SELECT c.fecha_documento, g.concepto, g.monto, g.rubro,
             dj.descripcion AS dj_descripcion, dj.nombre_proveedor, dj.dni_proveedor, dj.lugar,
             i2.nombre AS inst_nombre, i2.distrito AS inst_distrito, i2.ugel AS inst_ugel
      FROM EQRENDICION.PAE_GASTOS          g
      JOIN EQRENDICION.PAE_COMPROBANTES    c  ON c.id  = g.comprobante_id
      JOIN EQRENDICION.PAE_DECL_JURADAS    dj ON dj.comprobante_id = c.id
      JOIN EQRENDICION.PAE_TRANSFERENCIAS  t2 ON t2.id = c.transferencia_id
      JOIN EQRENDICION.PAE_ASIGNACIONES    a2 ON a2.id = t2.asignacion_id
      JOIN EQRENDICION.PAE_MODULOS         m2 ON m2.id = a2.modulo_id
      JOIN EQRENDICION.PAE_INSTITUCIONES   i2 ON i2.id = m2.institucion_id
      WHERE c.transferencia_id = @tid AND c.tiene_ruc = 0
      ORDER BY c.fecha_documento, c.id, g.id
    `)
    const gastos  = djRes.recordset
    const totalDJ = gastos.reduce((s, g) => s + Number(g.monto), 0)
    const MARGIN = 28, PW = 539, ORNG = '#F1A983', LGRY = '#f0f2f8', GREY = '#b5bcd3', rowH = 16
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: MARGIN })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename=dj-${info.t_codigo.replace(/\//g,'-')}.pdf`)
    doc.pipe(res)
    doc.rect(MARGIN, 12, 100, 32).fill('#c00')
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('PERÚ', MARGIN + 6, 16)
    doc.fontSize(5.5).font('Helvetica').text('Ministerio de Desarrollo', MARGIN + 6, 25).text('e Inclusión Social', MARGIN + 6, 32)
    doc.rect(MARGIN + 104, 12, 44, 32).fill(ORNG)
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold').text('PAE', MARGIN + 112, 23)
    doc.rect(MARGIN + 152, 12, PW - 152, 32).fill(ORNG)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('FORMATO DE DECLARACIÓN JURADA DE GASTOS', MARGIN + 152, 25, { width: PW - 152, align: 'center' })
    doc.fontSize(6.5).text(`(RDE N° XXXXXX-${info.anio}-MIDIS/PAE-DE)`, MARGIN + 152, 36, { width: PW - 152, align: 'center' })
    let y = 56
    const col1X = MARGIN, col2X = MARGIN + PW / 2 + 4, colW = PW / 2 - 4
    const infoBox = (label, value, x, w, yy) => {
      doc.rect(x, yy, w, 16).fillAndStroke(LGRY, '#d4dae8')
      doc.fillColor(ORNG).font('Helvetica-Bold').fontSize(7).text(label, x + 4, yy + 4, { lineBreak: false })
      const lw = doc.widthOfString(label) + 8
      doc.fillColor('#1a2340').font('Helvetica').fontSize(7).text(value || '', x + lw, yy + 4, { width: w - lw - 4, lineBreak: false })
    }
    infoBox('IE:', `${info.ie_nombre} (${info.nivel?.toUpperCase()})`, col1X, colW, y)
    infoBox('UGEL:', info.ugel ?? '', col2X, colW, y); y += 20
    infoBox('TESORERO:', info.tesorero, col1X, colW, y)
    infoBox('AÑO:', String(info.anio), col2X, colW, y); y += 20
    infoBox('PERIODO:', `${fmtFecha(info.fecha_inicio)} al ${fmtFecha(info.fecha_fin)}`, col1X, PW, y); y += 22
    doc.rect(MARGIN, y, PW, 0.5).fill('#d4dae8'); y += 6
    doc.fillColor('#444').font('Helvetica-Oblique').fontSize(6.5)
       .text('"El presente formato tiene carácter de Declaración Jurada de acuerdo a los numerales 1.7 y 1.16 del Artículo IV del Título Preliminar de la Ley N° 27444 del Procedimiento Administrativo General."', MARGIN, y, { width: PW, align: 'justify' })
    y = doc.y + 6
    doc.fillColor('#1a2340').font('Helvetica').fontSize(8).text('Declaro ', MARGIN, y, { continued: true })
    doc.font('Helvetica-Bold').text('BAJO JURAMENTO', { continued: true })
    doc.font('Helvetica').text(', haber efectuado gastos de los que no me ha sido posible obtener comprobantes de pago, según detalle:')
    y = doc.y + 10
    const cFe=52, cDi=70, cIE=110, cMo=60, cMn=60, cDe = PW - cFe - cDi - cIE - cMo - cMn, tX = MARGIN
    const colsDJ = [{ label:'Fecha',w:cFe },{ label:'Distrito',w:cDi },{ label:'IIEE',w:cIE },{ label:'Modalidad',w:cMo },{ label:'Detalle Gasto',w:cDe },{ label:'Monto S/.',w:cMn }]
    const drawHeader = () => {
      let cx = tX
      colsDJ.forEach(({ label, w }) => {
        doc.rect(cx, y, w, rowH).fillAndStroke(ORNG, ORNG)
        doc.fillColor('white').font('Helvetica-Bold').fontSize(7).text(label, cx + 2, y + (rowH - 7) / 2, { width: w - 4, align: 'center', lineBreak: false })
        cx += w
      }); y += rowH
    }
    drawHeader()
    gastos.forEach((g, i) => {
      const bg = i % 2 === 0 ? '#fff' : '#f5f7ff'
      if (y > 760) { doc.addPage(); y = MARGIN; drawHeader() }
      const dc = (x, w, text, align = 'center', bold = false) => {
        doc.rect(x, y, w, rowH).fill(bg); doc.rect(x, y, w, rowH).stroke('#d4dae8')
        if (text) doc.fillColor('#1a2340').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5)
           .text(String(text), x + 3, y + (rowH - 6.5) / 2, { width: w - 6, align, lineBreak: false })
      }
      let cx = tX
      dc(cx, cFe, fmtFecha(g.fecha_documento)); cx += cFe
      dc(cx, cDi, g.inst_distrito ?? info.distrito ?? ''); cx += cDi
      dc(cx, cIE, g.inst_nombre   ?? info.ie_nombre ?? '', 'left'); cx += cIE
      dc(cx, cMo, g.rubro ? g.rubro.toUpperCase() : ''); cx += cMo
      dc(cx, cDe, g.dj_descripcion ?? g.concepto ?? '', 'left'); cx += cDe
      dc(cx, cMn, fmtMonto(g.monto), 'right', true)
      y += rowH
    })
    if (y > 760) { doc.addPage(); y = MARGIN }
    const wLabel = cFe + cDi + cIE + cMo + cDe
    doc.rect(tX, y, wLabel, rowH).fillAndStroke(ORNG, ORNG)
    doc.fillColor('white').font('Helvetica-Bold').fontSize(8).text('TOTAL', tX + 3, y + (rowH - 8) / 2, { width: wLabel - 6, align: 'right', lineBreak: false })
    doc.rect(tX + wLabel, y, cMn, rowH).fillAndStroke(ORNG, ORNG)
    doc.fillColor('white').font('Helvetica-Bold').fontSize(8).text(`S/ ${fmtMonto(totalDJ)}`, tX + wLabel + 2, y + (rowH - 8) / 2, { width: cMn - 4, align: 'right', lineBreak: false })
    y += rowH + 30
    const sW = 200, sX = MARGIN + (PW - sW) / 2
    doc.moveTo(sX, y + 28).lineTo(sX + sW, y + 28).stroke()
    doc.fillColor('#1a2340').font('Helvetica-Bold').fontSize(8).text(info.tesorero, sX, y + 32, { width: sW, align: 'center' })
    doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text('Tesorero(a) del CGAE', sX, y + 43, { width: sW, align: 'center' })
    doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text(`IE N° ${info.ie_codigo} · Cód. ${info.codigo_modular}`, sX, y + 54, { width: sW, align: 'center' })
    doc.end()
  } catch (err) {
    console.error('ERROR generarDJPdf:', err.message, err.stack)
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar DJ PDF' })
  }
}
async function generarMovilidadPdf(req, res) {
  try {
    const pool = await getPool()
    const tid  = parseInt(req.params.transferencia_id, 10)
 
    const fmtFecha = (f) => {
      if (!f) return ''
      const d = new Date(f)
      return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
    }
    const fmtMonto = (n) => Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })
 
    const infoRes = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT
          i.nombre   AS ie_nombre, i.codigo AS ie_codigo, i.distrito,
          c.anio, c.nombre AS ciclo, c.fecha_inicio, c.fecha_fin,
          t.codigo   AS t_codigo, t.numero,
          m.nivel, m.codigo_modular,
          u.nombres + ' ' + u.apellidos AS tesorero
        FROM EQRENDICION.PAE_TRANSFERENCIAS    t
        JOIN EQRENDICION.PAE_ASIGNACIONES      a  ON a.id  = t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS           m  ON m.id  = a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES     i  ON i.id  = m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS            c  ON c.id  = a.ciclo_id
        JOIN EQRENDICION.PAE_TESORERO_MODULO   tm ON tm.modulo_id = m.id AND tm.activo = 1
        JOIN EQRENDICION.PAE_USUARIOS          u  ON u.id  = tm.usuario_id
        WHERE t.id = @tid
      `)
 
    if (!infoRes.recordset[0])
      return res.status(404).json({ error: 'Transferencia no encontrada' })
    const info = infoRes.recordset[0]
 
    const movRes = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT
          c.fecha_documento,
          c.num_comprobante,
          g.concepto,
          g.monto,
          pm.punto_partida,
          pm.punto_llegada,
          pm.motivo,
          m2.codigo_modular  AS modulo_codigo,
          m2.nivel           AS modulo_nivel
        FROM EQRENDICION.PAE_GASTOS          g
        JOIN EQRENDICION.PAE_COMPROBANTES    c  ON c.id  = g.comprobante_id
        JOIN EQRENDICION.PAE_PLAN_MOVILIDAD  pm ON pm.comprobante_id = c.id
        LEFT JOIN EQRENDICION.PAE_MODULOS    m2 ON m2.id = pm.modulo_id
        WHERE c.transferencia_id = @tid
          AND g.rubro = 'transporte'
        ORDER BY c.fecha_documento, c.id
      `)
 
    const movs      = movRes.recordset
    const totalMov  = movs.reduce((s, m) => s + Number(m.monto), 0)
 
    const MARGIN = 28, PW = 539
    const ORNG = '#F1A983', LGRY = '#f0f2f8', rowH = 18
 
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: MARGIN })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition',
      `attachment; filename=movilidad-${info.t_codigo.replace(/\//g,'-')}.pdf`)
    doc.pipe(res)
 
    doc.rect(MARGIN, 12, 100, 32).fill('#c00')
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('PERÚ', MARGIN + 6, 16)
    doc.fontSize(5.5).font('Helvetica').text('Ministerio de Desarrollo', MARGIN + 6, 25).text('e Inclusión Social', MARGIN + 6, 32)
    doc.rect(MARGIN + 104, 12, 44, 32).fill(ORNG)
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold').text('PAE', MARGIN + 112, 23)
    doc.rect(MARGIN + 152, 12, PW - 152, 32).fill(ORNG)
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
       .text('PLANILLA DE MOVILIDAD', MARGIN + 152, 22, { width: PW - 152, align: 'center' })
 
    let y = 56
    const col1X = MARGIN, col2X = MARGIN + PW / 2 + 4, colW = PW / 2 - 4
 
    const infoBox = (label, value, x, w, yy) => {
      doc.rect(x, yy, w, 16).fillAndStroke(LGRY, '#d4dae8')
      doc.fillColor(ORNG).font('Helvetica-Bold').fontSize(7).text(label, x + 4, yy + 4, { lineBreak: false })
      const lw = doc.widthOfString(label) + 8
      doc.fillColor('#1a2340').font('Helvetica').fontSize(7).text(value || '', x + lw, yy + 4, { width: w - lw - 4, lineBreak: false })
    }
 
    infoBox('IE:', `${info.ie_nombre} (${info.nivel?.toUpperCase()})`, col1X, colW, y)
    infoBox('TRANSFERENCIA:', `${info.t_codigo} · N° ${info.numero}`, col2X, colW, y); y += 20
    infoBox('TESORERO:', info.tesorero, col1X, colW, y)
    infoBox('PERIODO:', `${fmtFecha(info.fecha_inicio)} al ${fmtFecha(info.fecha_fin)}`, col2X, colW, y); y += 20
    infoBox('CÓDIGO MODULAR:', info.codigo_modular, col1X, colW, y)
    infoBox('AÑO:', String(info.anio), col2X, colW, y); y += 24
 
    doc.rect(MARGIN, y, PW, 0.5).fill('#d4dae8'); y += 6
    doc.fillColor('#444').font('Helvetica-Oblique').fontSize(6.5)
       .text('"La presente planilla sustenta los gastos de transporte realizados para el servicio alimentario PAE, ' +
         'de acuerdo al Artículo IV de la Ley N° 27444."', MARGIN, y, { width: PW, align: 'justify' })
    y = doc.y + 10
 
    if (movs.length === 0) {
      doc.fillColor('#6b7597').font('Helvetica').fontSize(10)
         .text('No hay registros de movilidad para esta transferencia.', MARGIN, y, { width: PW, align: 'center' })
      doc.end()
      return
    }
 
    const cFe = 52, cPart = 120, cLleg = 120, cMod = 70, cMot = 100
    const cMon = PW - cFe - cPart - cLleg - cMod - cMot
    const tX   = MARGIN
 
    const colsMov = [
      { label: 'Fecha',   w: cFe   },
      { label: 'Partida', w: cPart },
      { label: 'Llegada', w: cLleg },
      { label: 'Módulo',  w: cMod  },
      { label: 'Motivo',  w: cMot  },
      { label: 'Monto S/', w: cMon  },
    ]
 
    const drawHeader = () => {
      let cx = tX
      colsMov.forEach(({ label, w }) => {
        doc.rect(cx, y, w, rowH).fillAndStroke(ORNG, ORNG)
        doc.fillColor('white').font('Helvetica-Bold').fontSize(7)
           .text(label, cx + 2, y + (rowH - 7) / 2, { width: w - 4, align: 'center', lineBreak: false })
        cx += w
      })
      y += rowH
    }
    drawHeader()
 
    movs.forEach((m, i) => {
      const bg = i % 2 === 0 ? '#fff' : '#f5f7ff'
      if (y > 760) { doc.addPage(); y = MARGIN; drawHeader() }
 
      const dc = (x, w, text, align = 'left') => {
        doc.rect(x, y, w, rowH).fill(bg)
        doc.rect(x, y, w, rowH).stroke('#d4dae8')
        if (text) doc.fillColor('#1a2340').font('Helvetica').fontSize(6.5)
           .text(String(text), x + 3, y + (rowH - 6.5) / 2, { width: w - 6, align, lineBreak: false })
      }
 
      let cx = tX
      dc(cx, cFe,   fmtFecha(m.fecha_documento), 'center'); cx += cFe
      dc(cx, cPart, m.punto_partida ?? '');                  cx += cPart
      dc(cx, cLleg, m.punto_llegada ?? '');                  cx += cLleg
      dc(cx, cMod,  m.modulo_codigo ?? '', 'center');        cx += cMod
      dc(cx, cMot,  m.motivo ?? m.concepto ?? '');           cx += cMot

      doc.rect(cx, y, cMon, rowH).fill(bg)
      doc.rect(cx, y, cMon, rowH).stroke('#d4dae8')
      doc.fillColor('#1a2340').font('Helvetica-Bold').fontSize(6.5)
         .text(fmtMonto(m.monto), cx + 2, y + (rowH - 6.5) / 2, { width: cMon - 4, align: 'right', lineBreak: false })
      y += rowH
    })
 
    if (y > 760) { doc.addPage(); y = MARGIN }
    const wLabel = cFe + cPart + cLleg + cMod + cMot
    doc.rect(tX, y, wLabel, rowH).fillAndStroke(ORNG, ORNG)
    doc.fillColor('white').font('Helvetica-Bold').fontSize(8)
       .text('TOTAL', tX + 3, y + (rowH - 8) / 2, { width: wLabel - 6, align: 'right', lineBreak: false })
    doc.rect(tX + wLabel, y, cMon, rowH).fillAndStroke(ORNG, ORNG)
    doc.fillColor('white').font('Helvetica-Bold').fontSize(8)
       .text(`S/ ${fmtMonto(totalMov)}`, tX + wLabel + 2, y + (rowH - 8) / 2, { width: cMon - 4, align: 'right', lineBreak: false })
    y += rowH + 30
 
    const sW = 200, sX = MARGIN + (PW - sW) / 2
    doc.moveTo(sX, y + 28).lineTo(sX + sW, y + 28).stroke()
    doc.fillColor('#1a2340').font('Helvetica-Bold').fontSize(8)
       .text(info.tesorero, sX, y + 32, { width: sW, align: 'center' })
    doc.fillColor('#b5bcd3').font('Helvetica').fontSize(7.5)
       .text('Tesorero(a) del CGAE', sX, y + 43, { width: sW, align: 'center' })
    doc.fillColor('#b5bcd3').font('Helvetica').fontSize(7.5)
       .text(`IE N° ${info.ie_codigo} · Cód. ${info.codigo_modular}`, sX, y + 54, { width: sW, align: 'center' })
 
    doc.end()
  } catch (err) {
    console.error('ERROR generarMovilidadPdf:', err.message, err.stack)
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar planilla de movilidad' })
  }
}
async function generarReciboEgreso(req, res) {
  try {
    const pool = await getPool()
    const tid  = parseInt(req.params.transferencia_id, 10)

    const fmtFecha = (f) => {
      if (!f) return ''
      const d = new Date(f)
      return {
        dia: String(d.getDate()).padStart(2,'0'),
        mes: String(d.getMonth() + 1).padStart(2,'0'),
        anio: String(d.getFullYear())
      }
    }
    const fmtMonto = (n) => Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })
    const montoLetras = (n) => {
      const entero = Math.floor(n)
      const decimales = Math.round((n - entero) * 100)
      return `SON: ${entero.toLocaleString('es-PE')} CON ${String(decimales).padStart(2,'0')}/100 SOLES`
    }

    const infoRes = await pool.request()
      .input('tid', sql.Int, tid)
      .query(`
        SELECT
          t.monto                               AS monto_transferencia,
          t.numero,
          t.codigo                              AS codigo_transferencia,
          t.fecha_recepcion,
          a.num_transferencias_excel            AS num_transferencias,
          a.monto_total,
          m.codigo_modular,
          m.nivel,
          i.nombre                              AS ie_nombre,
          i.ugel                                AS unidad_territorial,
          i.codigo                              AS ie_codigo,
          c.nombre                              AS ciclo,
          c.anio,
          c.mes,
          c.fecha_inicio,
          c.fecha_fin,
          -- Tesorero
          ut.nombres + ' ' + ut.apellidos       AS tesorero,
          -- ATC asignado a la institución
          ua.nombres + ' ' + ua.apellidos       AS atc,
          -- Rendición
          r.id                                  AS rendicion_id,
          r.efectivo_en_caja,
          r.saldo_final,
          -- Total gastado
          COALESCE(
            (SELECT SUM(g.monto)
             FROM EQRENDICION.PAE_GASTOS g
             JOIN EQRENDICION.PAE_COMPROBANTES cp ON cp.id = g.comprobante_id
             WHERE cp.transferencia_id = t.id), 0
          ) AS total_gastado
        FROM EQRENDICION.PAE_TRANSFERENCIAS    t
        JOIN EQRENDICION.PAE_ASIGNACIONES      a   ON a.id  = t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS           m   ON m.id  = a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES     i   ON i.id  = m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS            c   ON c.id  = a.ciclo_id
        -- Tesorero activo del módulo
        JOIN EQRENDICION.PAE_TESORERO_MODULO   tm  ON tm.modulo_id = m.id AND tm.activo = 1
        JOIN EQRENDICION.PAE_USUARIOS          ut  ON ut.id = tm.usuario_id
        -- ATC asignado a la institución
        LEFT JOIN EQRENDICION.PAE_ATC_INSTITUCION  ai  ON ai.institucion_id = i.id AND ai.activo = 1
        LEFT JOIN EQRENDICION.PAE_USUARIOS          ua  ON ua.id = ai.usuario_id
        -- Rendición
        LEFT JOIN EQRENDICION.PAE_RENDICIONES  r   ON r.transferencia_id = t.id
        WHERE t.id = @tid
      `)

    if (!infoRes.recordset[0])
      return res.status(404).json({ error: 'Transferencia no encontrada' })

    const d = infoRes.recordset[0]
    const efectivoEnCaja = Number(d.efectivo_en_caja || 0)
    const totalGastado   = Number(d.total_gastado || 0)
    const montoTransf    = Number(d.monto_transferencia || 0)
    const saldoDevolver  = montoTransf - totalGastado 
    const hoy           = fmtFecha(new Date().toISOString())
    const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

    const doc    = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 40 })
    const MARGIN = 40
    const PW     = 515   
    const ROJO   = '#CC0000'
    const AZUL   = '#003399'
    const NEGRO  = '#000000'
    const GRIS   = '#666666'
    

    
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition',
      `attachment; filename=recibo-egreso-${d.codigo_transferencia.replace(/\//g,'-')}.pdf`)
    doc.pipe(res)

      const HEADER_H = 56
      doc.rect(MARGIN, 30, PW, HEADER_H).fillAndStroke('#FFF0F0', ROJO)

      const logoH = 42
      const logoY = 33
      try {
        doc.image(LOGO_MINISTERIO, MARGIN + 6,  logoY, { height: logoH, fit: [80, logoH] })
        doc.image(LOGO_PAE,        MARGIN + 94, logoY, { height: logoH, fit: [60, logoH] })
      } catch (e) {
        console.warn('No se pudieron cargar los logos:', e.message)
      }

      const fx = MARGIN + PW - 110, fy = 33
      const celdaW = 34, celdaH = 18
      ;['DÍA','MES','AÑO'].forEach((lbl, i) => {
        doc.rect(fx + i * celdaW, fy, celdaW, celdaH).fillAndStroke('#003399','#003399')
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7.5)
          .text(lbl, fx + i * celdaW, fy + 5, { width: celdaW, align: 'center' })
      })
      ;[hoy.dia, hoy.mes, hoy.anio.slice(-2)].forEach((val, i) => {
        doc.rect(fx + i * celdaW, fy + celdaH, celdaW, celdaH).fillAndStroke('#FFF0F0', ROJO)
        doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(9)
          .text(val, fx + i * celdaW, fy + celdaH + 5, { width: celdaW, align: 'center' })
      })

      let y = 96

      doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(14)
        .text(`RECIBO DE EGRESO N° ${d.codigo_transferencia}`, MARGIN, y, 
              { width: PW, align: 'center' })
      y += 22

      doc.rect(MARGIN, y, PW, 1).fill('#d4dae8'); y += 6

    const campo = (etiqueta, valor, x, w, yy, color = AZUL) => {
      doc.fillColor(color).font('Helvetica-Bold').fontSize(9)
         .text(etiqueta, x, yy, { lineBreak: false })
      const lw = doc.widthOfString(etiqueta) + 6
      doc.fillColor(NEGRO).font('Helvetica').fontSize(9)
         .text(valor || '', x + lw, yy, { width: w - lw, lineBreak: false })
    }

    const lineaH = 18
    const col1 = MARGIN, col2 = MARGIN + PW / 2

    doc.rect(MARGIN, y, PW, 1).fill('#d4dae8'); y += 6

    campo('Unidad Territorial:', d.unidad_territorial ?? '', col1, PW / 2 - 4, y); y += lineaH
    campo('Código modular:',     d.codigo_modular ?? '',      col1, PW / 2 - 4, y)
    campo('Nivel:',              d.nivel ?? '',               col2, PW / 2,     y); y += lineaH
    campo('NOMBRE DE LA IE:',    d.ie_nombre ?? '',           col1, PW,         y); y += lineaH
    campo('Período:',
      `${MESES[(d.mes ?? 1) - 1]} ${d.anio} (${fmtFecha(d.fecha_inicio).dia}/${fmtFecha(d.fecha_inicio).mes}/${fmtFecha(d.fecha_inicio).anio} — ${fmtFecha(d.fecha_fin).dia}/${fmtFecha(d.fecha_fin).mes}/${fmtFecha(d.fecha_fin).anio})`,
      col1, PW, y); y += lineaH
    campo('NOMBRE DEL TESORERO:', d.tesorero ?? '', col1, PW, y); y += lineaH
    campo('NOMBRE DEL ATC:',      d.atc ?? '',      col1, PW, y); y += lineaH

    doc.rect(MARGIN, y, PW, 1).fill('#d4dae8'); y += 8

    const thH = 20
    doc.rect(MARGIN, y, PW - 80, thH).fillAndStroke('#003399','#003399')
    doc.rect(MARGIN + PW - 80, y, 80, thH).fillAndStroke('#003399','#003399')
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
       .text('CONCEPTO', MARGIN + 4, y + 6, { width: PW - 84, lineBreak: false })
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
       .text('TOTAL', MARGIN + PW - 80 + 4, y + 6, { width: 72, align: 'center', lineBreak: false })
    y += thH

    const filaConcepto = (concepto, monto, bg = '#fff') => {
      doc.rect(MARGIN, y, PW - 80, 22).fillAndStroke(bg, '#d4dae8')
      doc.rect(MARGIN + PW - 80, y, 80, 22).fillAndStroke(bg, '#d4dae8')
      doc.fillColor(NEGRO).font('Helvetica').fontSize(9)
         .text(concepto, MARGIN + 6, y + 6, { width: PW - 90, lineBreak: false })
      doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9)
         .text(`S/ ${fmtMonto(monto)}`, MARGIN + PW - 80 + 4, y + 6, { width: 72, align: 'right', lineBreak: false })
      y += 22
    }

    doc.rect(MARGIN, y, PW - 80, 22).fillAndStroke('#fff', '#d4dae8')
    doc.rect(MARGIN + PW - 80, y, 80, 22).fillAndStroke('#fff', '#d4dae8')
    doc.fillColor(GRIS).font('Helvetica').fontSize(8)
       .text('SIAF', MARGIN + PW - 170, y + 6, { lineBreak: false })
    doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(13)
       .text('XXX', MARGIN + PW - 140, y + 3, { lineBreak: false })
    y += 22

    doc.rect(MARGIN, y, PW - 80, 22).fillAndStroke('#fff', '#d4dae8')
    doc.rect(MARGIN + PW - 80, y, 80, 22).fillAndStroke('#fff', '#d4dae8')
    doc.fillColor(GRIS).font('Helvetica').fontSize(8)
       .text('PPTO', MARGIN + PW - 170, y + 6, { lineBreak: false })
    doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(13)
       .text('XXXX', MARGIN + PW - 135, y + 3, { lineBreak: false })
    y += 22 + 6

    const boxW = (PW - 12) / 2
    doc.rect(MARGIN, y, boxW, 44).fillAndStroke('#f7f8fc', '#d4dae8')
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(8)
       .text('ENTREGO', MARGIN + 6, y + 6, { lineBreak: false })
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9)
       .text('TESORERO', MARGIN + 60, y + 6, { lineBreak: false })
    doc.moveTo(MARGIN + 10, y + 36).lineTo(MARGIN + boxW - 10, y + 36).stroke('#999')
    doc.fillColor(GRIS).font('Helvetica').fontSize(7.5)
       .text(d.tesorero ?? '', MARGIN + 6, y + 38, { width: boxW - 12, align: 'center' })

    doc.rect(MARGIN + boxW + 12, y, boxW, 44).fillAndStroke('#f7f8fc', '#d4dae8')
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(8)
       .text('RECIBO', MARGIN + boxW + 18, y + 6, { lineBreak: false })
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9)
       .text('ATC', MARGIN + boxW + 66, y + 6, { lineBreak: false })
    doc.moveTo(MARGIN + boxW + 22, y + 36).lineTo(MARGIN + PW - 10, y + 36).stroke('#999')
    doc.fillColor(GRIS).font('Helvetica').fontSize(7.5)
       .text(d.atc ?? '', MARGIN + boxW + 14, y + 38, { width: boxW - 12, align: 'center' })
    y += 52

    doc.rect(MARGIN, y, PW, 1).fill('#d4dae8'); y += 8

    campo('el importe de:', `S/ ${fmtMonto(saldoDevolver)}`, col1, PW, y, AZUL); y += lineaH
    campo('Concepto:', 'Devolución de saldo no ejecutado', col1, PW, y, AZUL); y += lineaH

    doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(9)
       .text('Devolución de saldo no ejecutado', MARGIN + 20, y); y += 18

    campo('EXPEDIENTE SIAF:', 'XXXX', col1, PW / 2, y); y += lineaH + 4

    const resumenRow = (lbl, val, color = NEGRO) => {
      doc.rect(MARGIN, y, PW - 80, 16).fillAndStroke('#f7f8fc', '#e5e8f0')
      doc.rect(MARGIN + PW - 80, y, 80, 16).fillAndStroke('#f7f8fc', '#e5e8f0')
      doc.fillColor(GRIS).font('Helvetica').fontSize(8)
         .text(lbl, MARGIN + 6, y + 3, { lineBreak: false })
      doc.fillColor(color).font('Helvetica-Bold').fontSize(8.5)
         .text(`S/ ${fmtMonto(val)}`, MARGIN + PW - 76, y + 3, { width: 72, align: 'right', lineBreak: false })
      y += 16
    }

    resumenRow('Monto transferido',    montoTransf)
    resumenRow('(-) Total gastado',    totalGastado)
    resumenRow('(-) Saldo en Cuenta', saldoDevolver-efectivoEnCaja)
    resumenRow('(-) Efectivo en caja', efectivoEnCaja)
    resumenRow('= Saldo a devolver',   saldoDevolver)

    y += 8
    doc.rect(MARGIN, y, PW, 1).fill('#d4dae8'); y += 6

    doc.rect(MARGIN, y, PW - 80, 22).fillAndStroke('#f0f2f8', '#d4dae8')
    doc.rect(MARGIN + PW - 80, y, 80, 22).fillAndStroke('#f0f2f8', '#d4dae8')
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(8)
       .text('IMPORTE EN LETRAS', MARGIN + 6, y + 6, { lineBreak: false })
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9)
       .text(`S/ ${fmtMonto(saldoDevolver)}`, MARGIN + PW - 76, y + 6, { width: 72, align: 'right', lineBreak: false })
    y += 22

    doc.rect(MARGIN, y, PW, 20).fillAndStroke('#fff', '#d4dae8')
    doc.fillColor(GRIS).font('Helvetica-Oblique').fontSize(8)
       .text(montoLetras(saldoDevolver), MARGIN + 6, y + 5, { width: PW - 12 })

    doc.end()

  } catch (err) {
    console.error('ERROR generarReciboEgreso:', err.message, err.stack)
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar recibo' })
  }
}
module.exports = {
  getByTransferencia, upsert, enviar, aprobar, observar,
  generarAnexo3, descargarComprobantesZip, generarDJPdf, generarMovilidadPdf,generarReciboEgreso
}