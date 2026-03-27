const { getPool, sql } = require('../config/db')
const PDFDocument      = require('pdfkit')
const archiver         = require('archiver')
const path             = require('path')
const fs               = require('fs')

const MESES    = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const fmtFecha = (f) => {
  if (!f) return ''
  const d = new Date(f)
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
}
const fmtMonto = (n) => Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })
const TIPO_LABEL = {
  boleta_venta:       'BOLETA DE VENTA',
  recibo_gasto:       'RECIBO DE GASTO',
  factura:            'FACTURA',
  ticket:             'TICKET',
  declaracion_jurada: 'DECLARACIÓN JURADA',
  planilla_movilidad: 'PLANILLA MOVILIDAD'
}

async function getTransferencias(req, res) {
  try {
    const pool = await getPool()

    const result = await pool.request().query(`
      SELECT
        r.id                                  AS rendicion_id,
        t.id                                  AS transferencia_id,
        t.asignacion_id,
        t.codigo                              AS codigo_transferencia,
        t.monto                               AS monto_transferencia,
        t.numero,
        t.fecha_limite_rendicion,
        a.num_transferencias,
        m.nivel,
        m.codigo_modular,
        i.id                                  AS institucion_id,
        i.nombre                              AS nombre_institucion,
        i.codigo                              AS codigo_ie,
        i.ugel,
        i.distrito,
        c.nombre                              AS ciclo,
        c.anio,
        c.mes,
        c.fecha_inicio,
        c.fecha_fin,
        COALESCE(r.efectivo_en_caja, 0)       AS efectivo_en_caja,
        COALESCE(
          (SELECT SUM(g.monto)
           FROM EQRENDICION.PAE_GASTOS g
           JOIN EQRENDICION.PAE_COMPROBANTES cp ON cp.id = g.comprobante_id
           WHERE cp.transferencia_id = t.id), 0
        )                                     AS total_gastos_registrados,
        t.monto - COALESCE(
          (SELECT SUM(g.monto)
           FROM EQRENDICION.PAE_GASTOS g
           JOIN EQRENDICION.PAE_COMPROBANTES cp ON cp.id = g.comprobante_id
           WHERE cp.transferencia_id = t.id), 0
        ) - COALESCE(r.efectivo_en_caja, 0)   AS saldo,
        COALESCE(r.estado, 'sin_rendicion')   AS estado,
        r.enviada_en,
        r.aprobada_en,
        ut.nombres + ' ' + ut.apellidos       AS tesorero,
        ua.nombres + ' ' + ua.apellidos       AS atc
      FROM EQRENDICION.PAE_TRANSFERENCIAS       t
      JOIN EQRENDICION.PAE_ASIGNACIONES         a   ON a.id  = t.asignacion_id
      JOIN EQRENDICION.PAE_MODULOS              m   ON m.id  = a.modulo_id
      JOIN EQRENDICION.PAE_INSTITUCIONES        i   ON i.id  = m.institucion_id
      JOIN EQRENDICION.PAE_CICLOS               c   ON c.id  = a.ciclo_id
      LEFT JOIN EQRENDICION.PAE_RENDICIONES     r   ON r.transferencia_id = t.id
      LEFT JOIN EQRENDICION.PAE_TESORERO_MODULO tm  ON tm.modulo_id = m.id AND tm.activo = 1
      LEFT JOIN EQRENDICION.PAE_USUARIOS        ut  ON ut.id  = tm.usuario_id
      LEFT JOIN EQRENDICION.PAE_ATC_INSTITUCION ai  ON ai.institucion_id = i.id AND ai.activo = 1
      LEFT JOIN EQRENDICION.PAE_USUARIOS        ua  ON ua.id  = ai.usuario_id
      ORDER BY
        i.nombre,
        c.anio DESC, c.mes DESC,
        m.nivel,
        t.numero
    `)

    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR getTransferencias coordinador:', err.message)
    res.status(500).json({ error: 'Error al obtener transferencias' })
  }
}


async function zipInstitucion(req, res) {
  const instId = parseInt(req.params.institucion_id, 10)

  try {
    const pool = await getPool()

    const instRes = await pool.request()
      .input('id', sql.Int, instId)
      .query(`SELECT id, nombre, codigo FROM EQRENDICION.PAE_INSTITUCIONES WHERE id = @id`)

    if (!instRes.recordset[0])
      return res.status(404).json({ error: 'Institución no encontrada' })
    const inst = instRes.recordset[0]

    const transfRes = await pool.request()
      .input('instId', sql.Int, instId)
      .query(`
        SELECT
          t.id    AS tid,
          t.codigo,
          t.numero,
          a.num_transferencias,
          m.nivel,
          m.codigo_modular,
          c.nombre AS ciclo,
          r.id     AS rendicion_id,
          ut.nombres + ' ' + ut.apellidos AS tesorero,
          a.id     AS asignacion_id
        FROM EQRENDICION.PAE_TRANSFERENCIAS       t
        JOIN EQRENDICION.PAE_ASIGNACIONES         a  ON a.id  = t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS              m  ON m.id  = a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES        i  ON i.id  = m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS               c  ON c.id  = a.ciclo_id
        LEFT JOIN EQRENDICION.PAE_RENDICIONES     r  ON r.transferencia_id = t.id
        LEFT JOIN EQRENDICION.PAE_TESORERO_MODULO tm ON tm.modulo_id = m.id AND tm.activo = 1
        LEFT JOIN EQRENDICION.PAE_USUARIOS        ut ON ut.id = tm.usuario_id
        WHERE i.id = @instId
        ORDER BY c.anio DESC, c.mes DESC, m.nivel, t.numero
      `)

    const transferencias = transfRes.recordset
    if (transferencias.length === 0)
      return res.status(404).json({ error: 'No hay transferencias para esta institución' })

    const instSlug = `${inst.codigo}-${inst.nombre.substring(0, 40).replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-')}`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename=${instSlug}.zip`)

    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.pipe(res)
    archive.on('error', err => { console.error('archiver error:', err); })

    const uploadsBase = path.join(__dirname, '..', '..', 'uploads')

    for (const t of transferencias) {
      const carpeta = `${inst.codigo}/${t.codigo}_${t.ciclo}_${t.nivel}`

      if (t.rendicion_id) {
        try {
          const pdfBalance = await generarAnexo3Buffer(pool, t.tid)
          if (pdfBalance) archive.append(pdfBalance, { name: `${carpeta}/balance-gastos.pdf` })
        } catch (e) { console.error('balance error:', e.message) }

        try {
          const pdfDJ = await generarDJBuffer(pool, t.tid)
          if (pdfDJ) archive.append(pdfDJ, { name: `${carpeta}/declaraciones-juradas.pdf` })
        } catch (e) { console.error('dj error:', e.message) }

        try {
          const pdfMov = await generarMovilidadBuffer(pool, t.tid)
          if (pdfMov) archive.append(pdfMov, { name: `${carpeta}/planilla-movilidad.pdf` })
        } catch (e) { console.error('movilidad error:', e.message) }

        try {
          const pdfRecibo = await generarReciboBuffer(pool, t.tid)
          if (pdfRecibo) archive.append(pdfRecibo, { name: `${carpeta}/recibo-egreso.pdf` })
        } catch (e) { console.error('recibo error:', e.message) }
      }

      try {
        const actaRes = await pool.request()
          .input('aid', sql.Int, t.asignacion_id)
          .query(`SELECT TOP 1 pdf_nombre FROM EQRENDICION.PAE_ACTAS WHERE asignacion_id = @aid ORDER BY creado_en DESC`)
        if (actaRes.recordset[0]?.pdf_nombre) {
          const actaPath = path.join(uploadsBase, actaRes.recordset[0].pdf_nombre)
          if (fs.existsSync(actaPath))
            archive.file(actaPath, { name: `${carpeta}/acta-comite.pdf` })
        }
      } catch (e) { console.error('acta error:', e.message) }

      try {
        const compRes = await pool.request()
          .input('tid', sql.Int, t.tid)
          .query(`
            SELECT DISTINCT c.id, c.tipo_comprobante, c.num_comprobante, c.archivo_url, g.concepto
            FROM EQRENDICION.PAE_COMPROBANTES c
            JOIN EQRENDICION.PAE_GASTOS g ON g.comprobante_id = c.id
            WHERE c.transferencia_id = @tid AND c.archivo_url IS NOT NULL
            ORDER BY c.id
          `)
        compRes.recordset.forEach((c, idx) => {
          const fileName = path.basename(c.archivo_url)
          const filePath = path.join(uploadsBase, fileName)
          if (fs.existsSync(filePath)) {
            const tipo    = (c.tipo_comprobante ?? '').replace(/_/g, '-')
            const concepto = (c.concepto ?? '').substring(0, 25).replace(/[^a-zA-Z0-9 ]/g, '').trim()
            const ext     = path.extname(fileName)
            archive.file(filePath, {
              name: `${carpeta}/comprobantes/${String(idx + 1).padStart(2, '0')}-${tipo}-${concepto}${ext}`
            })
          }
        })
      } catch (e) { console.error('comprobantes error:', e.message) }
    }

    await archive.finalize()

  } catch (err) {
    console.error('ERROR zipInstitucion:', err.message, err.stack)
    if (!res.headersSent) res.status(500).json({ error: 'Error al generar ZIP' })
  }
}

function generarAnexo3Buffer(pool, tid) {
  return new Promise(async (resolve, reject) => {
    try {
      const ORNG = '#F1A983', LGRY = '#f0f2f8', GREY = '#cfd2da'
      const MARGIN = 28, PW = 539

      const infoRes = await pool.request().input('tid', sql.Int, tid).query(`
        SELECT t.monto, t.fecha_recepcion, t.codigo, t.numero,
               i.nombre AS ie_nombre, i.codigo AS ie_codigo,
               c.nombre AS ciclo, c.mes, c.anio, c.fecha_inicio, c.fecha_fin,
               m.nivel, m.codigo_modular,
               a.num_transferencias,
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
      if (!infoRes.recordset[0]) return resolve(null)
      const info = infoRes.recordset[0]

      const gastosRes = await pool.request().input('tid', sql.Int, tid).query(`
        SELECT g.id, g.concepto, g.rubro, g.monto,
               c.tipo_comprobante, c.num_comprobante, c.fecha_documento
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES c ON c.id = g.comprobante_id
        WHERE c.transferencia_id = @tid
        ORDER BY c.fecha_documento, c.id, g.id
      `)
      const gastos = gastosRes.recordset

      const rendRes = await pool.request().input('tid', sql.Int, tid)
        .query(`SELECT COALESCE(efectivo_en_caja, 0) AS efectivo_en_caja FROM EQRENDICION.PAE_RENDICIONES WHERE transferencia_id = @tid`)
      const efectivoEnCaja  = Number(rendRes.recordset[0]?.efectivo_en_caja ?? 0)
      const montoTransf     = Number(info.monto)
      const totalGastado    = gastos.reduce((s, g) => s + Number(g.monto), 0)
      const saldoDisponible = montoTransf - totalGastado - efectivoEnCaja

      const chunks = []
      const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: MARGIN })
      doc.on('data', c => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

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
      rtRow('Monto Transferido', 'S/', fmtMonto(montoTransf), LGRY)
      rtRow('Total Gastado',     'S/', fmtMonto(totalGastado), '#fef3c7')
      rtRow('Efectivo en Caja',  'S/', fmtMonto(efectivoEnCaja), LGRY)
      rtRow('Saldo Disponible',  'S/', fmtMonto(saldoDisponible), saldoDisponible < 0 ? '#fee2e2' : '#d1fae5')
      y += 10

      const cN=20,cDet=130,cTipo=90,cDoc=60,cFech=52,cRub=60
      const cMon = PW - cN - cDet - cTipo - cDoc - cFech - cRub, rowH = 15
      const headers = [
        { label:'N°',w:cN },{ label:'Detalle',w:cDet },{ label:'Tipo Documento',w:cTipo },
        { label:'N° Documento',w:cDoc },{ label:'Fecha',w:cFech },{ label:'Rubro',w:cRub },{ label:'Monto S/',w:cMon }
      ]
      const drawHeader = () => {
        let cx = MARGIN
        headers.forEach(({ label, w }) => {
          doc.rect(cx, y, w, rowH).fillAndStroke(ORNG, ORNG)
          doc.fillColor('white').font('Helvetica-Bold').fontSize(7).text(label, cx + 2, y + 4, { width: w - 4, align: 'center', lineBreak: false })
          cx += w
        }); y += rowH
      }
      drawHeader()
      gastos.forEach((g, i) => {
        const bg = i % 2 === 0 ? '#fff' : '#f5f7ff'
        if (y > 760) { doc.addPage(); y = 28; drawHeader() }
        const cell = (x, w, text, align = 'left', bold = false) => {
          doc.rect(x, y, w, rowH).fill(bg); doc.rect(x, y, w, rowH).stroke('#d4dae8')
          if (text) doc.fillColor('#1a2340').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5)
             .text(String(text), x + 3, y + (rowH - 6.5) / 2, { width: w - 6, align, lineBreak: false })
        }
        let cx = MARGIN
        cell(cx,cN,String(i+1),'center'); cx+=cN
        cell(cx,cDet,g.concepto??'','left',true); cx+=cDet
        cell(cx,cTipo,TIPO_LABEL[g.tipo_comprobante]??'','left'); cx+=cTipo
        cell(cx,cDoc,g.num_comprobante??'','center'); cx+=cDoc
        cell(cx,cFech,fmtFecha(g.fecha_documento),'center'); cx+=cFech
        cell(cx,cRub,g.rubro??'','center'); cx+=cRub
        cell(cx,cMon,fmtMonto(g.monto),'right',true)
        y += rowH
      })

      let cx = MARGIN
      ;[cN,cDet,cTipo,cDoc,cFech,cRub].forEach(w => { doc.rect(cx,y,w,rowH).fillAndStroke(ORNG,ORNG); cx+=w })
      doc.fillColor('white').font('Helvetica-Bold').fontSize(7.5).text('TOTAL',MARGIN+3,y+4,{width:cN+cDet+cTipo+cDoc+cFech+cRub-6,align:'right',lineBreak:false})
      doc.rect(cx,y,cMon,rowH).fillAndStroke(ORNG,ORNG)
      doc.fillColor('white').font('Helvetica-Bold').fontSize(7.5).text(fmtMonto(totalGastado),cx+2,y+4,{width:cMon-4,align:'right',lineBreak:false})
      y+=rowH+30

      const sigW=200, sigX=MARGIN+(PW-sigW)/2
      doc.moveTo(sigX,y+28).lineTo(sigX+sigW,y+28).stroke()
      doc.fillColor('black').font('Helvetica-Bold').fontSize(8).text(info.tesorero,sigX,y+32,{width:sigW,align:'center'})
      doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text('Tesorero(a) del CGAE',sigX,y+43,{width:sigW,align:'center'})
      doc.end()
    } catch(e) { reject(e) }
  })
}

function generarDJBuffer(pool, tid) {
  return new Promise(async (resolve, reject) => {
    try {
      const ORNG='#F1A983',LGRY='#f0f2f8',GREY='#b5bcd3',rowH=16,MARGIN=28,PW=539
      const infoRes = await pool.request().input('tid',sql.Int,tid).query(`
        SELECT i.nombre AS ie_nombre, i.codigo AS ie_codigo, i.ugel,
               c.anio, c.fecha_inicio, c.fecha_fin, t.codigo AS t_codigo,
               m.nivel, m.codigo_modular, u.nombres+' '+u.apellidos AS tesorero
        FROM EQRENDICION.PAE_TRANSFERENCIAS t
        JOIN EQRENDICION.PAE_ASIGNACIONES a ON a.id=t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS m ON m.id=a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES i ON i.id=m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS c ON c.id=a.ciclo_id
        JOIN EQRENDICION.PAE_TESORERO_MODULO tm ON tm.modulo_id=m.id AND tm.activo=1
        JOIN EQRENDICION.PAE_USUARIOS u ON u.id=tm.usuario_id
        WHERE t.id=@tid`)
      if (!infoRes.recordset[0]) return resolve(null)
      const info = infoRes.recordset[0]

      const djRes = await pool.request().input('tid',sql.Int,tid).query(`
        SELECT c.fecha_documento,g.concepto,g.monto,g.rubro,
               dj.descripcion AS dj_descripcion,dj.nombre_proveedor,dj.dni_proveedor,dj.lugar,
               i2.nombre AS inst_nombre,i2.distrito AS inst_distrito,i2.ugel AS inst_ugel
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES c ON c.id=g.comprobante_id
        JOIN EQRENDICION.PAE_DECL_JURADAS dj ON dj.comprobante_id=c.id
        JOIN EQRENDICION.PAE_TRANSFERENCIAS t2 ON t2.id=c.transferencia_id
        JOIN EQRENDICION.PAE_ASIGNACIONES a2 ON a2.id=t2.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS m2 ON m2.id=a2.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES i2 ON i2.id=m2.institucion_id
        WHERE c.transferencia_id=@tid AND c.tiene_ruc=0
        ORDER BY c.fecha_documento,c.id,g.id`)

      const gastos = djRes.recordset
      if (gastos.length === 0) return resolve(null) 

      const totalDJ = gastos.reduce((s,g)=>s+Number(g.monto),0)
      const chunks = []
      const doc = new PDFDocument({ size:'A4', layout:'portrait', margin:MARGIN })
      doc.on('data',c=>chunks.push(c)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject)

      doc.rect(MARGIN,12,100,32).fill('#c00')
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('PERÚ',MARGIN+6,16)
      doc.fontSize(5.5).font('Helvetica').text('Ministerio de Desarrollo',MARGIN+6,25).text('e Inclusión Social',MARGIN+6,32)
      doc.rect(MARGIN+104,12,44,32).fill(ORNG)
      doc.fillColor('white').fontSize(9).font('Helvetica-Bold').text('PAE',MARGIN+112,23)
      doc.rect(MARGIN+152,12,PW-152,32).fill(ORNG)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('FORMATO DE DECLARACIÓN JURADA DE GASTOS',MARGIN+152,25,{width:PW-152,align:'center'})

      let y=56
      const col1X=MARGIN,col2X=MARGIN+PW/2+4,colW=PW/2-4
      const infoBox=(label,value,x,w,yy)=>{
        doc.rect(x,yy,w,16).fillAndStroke(LGRY,'#d4dae8')
        doc.fillColor(ORNG).font('Helvetica-Bold').fontSize(7).text(label,x+4,yy+4,{lineBreak:false})
        const lw=doc.widthOfString(label)+8
        doc.fillColor('#1a2340').font('Helvetica').fontSize(7).text(value||'',x+lw,yy+4,{width:w-lw-4,lineBreak:false})
      }
      infoBox('IE:',`${info.ie_nombre} (${info.nivel?.toUpperCase()})`,col1X,colW,y)
      infoBox('UGEL:',info.ugel??'',col2X,colW,y); y+=20
      infoBox('TESORERO:',info.tesorero,col1X,colW,y)
      infoBox('AÑO:',String(info.anio),col2X,colW,y); y+=20
      infoBox('PERIODO:',`${fmtFecha(info.fecha_inicio)} al ${fmtFecha(info.fecha_fin)}`,col1X,PW,y); y+=24

      const cFe=52,cDi=70,cIE=110,cMo=60,cMn=60,cDe=PW-cFe-cDi-cIE-cMo-cMn
      const colsDJ=[{label:'Fecha',w:cFe},{label:'Distrito',w:cDi},{label:'IIEE',w:cIE},{label:'Modalidad',w:cMo},{label:'Detalle Gasto',w:cDe},{label:'Monto S/.',w:cMn}]
      const drawHeader=()=>{
        let cx=MARGIN
        colsDJ.forEach(({label,w})=>{
          doc.rect(cx,y,w,rowH).fillAndStroke(ORNG,ORNG)
          doc.fillColor('white').font('Helvetica-Bold').fontSize(7).text(label,cx+2,y+(rowH-7)/2,{width:w-4,align:'center',lineBreak:false})
          cx+=w
        }); y+=rowH
      }
      drawHeader()
      gastos.forEach((g,i)=>{
        const bg=i%2===0?'#fff':'#f5f7ff'
        if(y>760){doc.addPage();y=MARGIN;drawHeader()}
        const dc=(x,w,text,align='center',bold=false)=>{
          doc.rect(x,y,w,rowH).fill(bg); doc.rect(x,y,w,rowH).stroke('#d4dae8')
          if(text) doc.fillColor('#1a2340').font(bold?'Helvetica-Bold':'Helvetica').fontSize(6.5)
             .text(String(text),x+3,y+(rowH-6.5)/2,{width:w-6,align,lineBreak:false})
        }
        let cx=MARGIN
        dc(cx,cFe,fmtFecha(g.fecha_documento)); cx+=cFe
        dc(cx,cDi,g.inst_distrito??info.distrito??''); cx+=cDi
        dc(cx,cIE,g.inst_nombre??info.ie_nombre??'','left'); cx+=cIE
        dc(cx,cMo,g.rubro?g.rubro.toUpperCase():''); cx+=cMo
        dc(cx,cDe,g.dj_descripcion??g.concepto??'','left'); cx+=cDe
        dc(cx,cMn,fmtMonto(g.monto),'right',true)
        y+=rowH
      })
      const wLabel=cFe+cDi+cIE+cMo+cDe
      doc.rect(MARGIN,y,wLabel,rowH).fillAndStroke(ORNG,ORNG)
      doc.fillColor('white').font('Helvetica-Bold').fontSize(8).text('TOTAL',MARGIN+3,y+(rowH-8)/2,{width:wLabel-6,align:'right',lineBreak:false})
      doc.rect(MARGIN+wLabel,y,cMn,rowH).fillAndStroke(ORNG,ORNG)
      doc.fillColor('white').font('Helvetica-Bold').fontSize(8).text(`S/ ${fmtMonto(totalDJ)}`,MARGIN+wLabel+2,y+(rowH-8)/2,{width:cMn-4,align:'right',lineBreak:false})
      y+=rowH+30
      const sW=200,sX=MARGIN+(PW-sW)/2
      doc.moveTo(sX,y+28).lineTo(sX+sW,y+28).stroke()
      doc.fillColor('#1a2340').font('Helvetica-Bold').fontSize(8).text(info.tesorero,sX,y+32,{width:sW,align:'center'})
      doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text('Tesorero(a) del CGAE',sX,y+43,{width:sW,align:'center'})
      doc.end()
    } catch(e){ reject(e) }
  })
}

function generarMovilidadBuffer(pool, tid) {
  return new Promise(async (resolve, reject) => {
    try {
      const ORNG='#F1A983',LGRY='#f0f2f8',rowH=18,MARGIN=28,PW=539
      const infoRes = await pool.request().input('tid',sql.Int,tid).query(`
        SELECT i.nombre AS ie_nombre,i.codigo AS ie_codigo,
               c.anio,c.nombre AS ciclo,c.fecha_inicio,c.fecha_fin,
               t.codigo AS t_codigo,t.numero,m.nivel,m.codigo_modular,
               u.nombres+' '+u.apellidos AS tesorero
        FROM EQRENDICION.PAE_TRANSFERENCIAS t
        JOIN EQRENDICION.PAE_ASIGNACIONES a ON a.id=t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS m ON m.id=a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES i ON i.id=m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS c ON c.id=a.ciclo_id
        JOIN EQRENDICION.PAE_TESORERO_MODULO tm ON tm.modulo_id=m.id AND tm.activo=1
        JOIN EQRENDICION.PAE_USUARIOS u ON u.id=tm.usuario_id
        WHERE t.id=@tid`)
      if (!infoRes.recordset[0]) return resolve(null)
      const info = infoRes.recordset[0]

      const movRes = await pool.request().input('tid',sql.Int,tid).query(`
        SELECT c.fecha_documento,g.monto,pm.punto_partida,pm.punto_llegada,pm.motivo,
               m2.codigo_modular AS modulo_codigo
        FROM EQRENDICION.PAE_GASTOS g
        JOIN EQRENDICION.PAE_COMPROBANTES c ON c.id=g.comprobante_id
        JOIN EQRENDICION.PAE_PLAN_MOVILIDAD pm ON pm.comprobante_id=c.id
        LEFT JOIN EQRENDICION.PAE_MODULOS m2 ON m2.id=pm.modulo_id
        WHERE c.transferencia_id=@tid AND g.rubro='transporte'
        ORDER BY c.fecha_documento,c.id`)
      const movs = movRes.recordset
      if (movs.length === 0) return resolve(null)

      const totalMov = movs.reduce((s,m)=>s+Number(m.monto),0)
      const chunks = []
      const doc = new PDFDocument({size:'A4',layout:'portrait',margin:MARGIN})
      doc.on('data',c=>chunks.push(c)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject)

      doc.rect(MARGIN,12,100,32).fill('#c00')
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('PERÚ',MARGIN+6,16)
      doc.fontSize(5.5).font('Helvetica').text('Ministerio de Desarrollo',MARGIN+6,25).text('e Inclusión Social',MARGIN+6,32)
      doc.rect(MARGIN+104,12,44,32).fill(ORNG)
      doc.fillColor('white').fontSize(9).font('Helvetica-Bold').text('PAE',MARGIN+112,23)
      doc.rect(MARGIN+152,12,PW-152,32).fill(ORNG)
      doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text('PLANILLA DE MOVILIDAD',MARGIN+152,22,{width:PW-152,align:'center'})

      let y=56
      const col1X=MARGIN,col2X=MARGIN+PW/2+4,colW=PW/2-4
      const infoBox=(label,value,x,w,yy)=>{
        doc.rect(x,yy,w,16).fillAndStroke('#f0f2f8','#d4dae8')
        doc.fillColor(ORNG).font('Helvetica-Bold').fontSize(7).text(label,x+4,yy+4,{lineBreak:false})
        const lw=doc.widthOfString(label)+8
        doc.fillColor('#1a2340').font('Helvetica').fontSize(7).text(value||'',x+lw,yy+4,{width:w-lw-4,lineBreak:false})
      }
      infoBox('IE:',`${info.ie_nombre} (${info.nivel?.toUpperCase()})`,col1X,colW,y)
      infoBox('TRANSFERENCIA:',`${info.t_codigo} · N° ${info.numero}`,col2X,colW,y); y+=20
      infoBox('TESORERO:',info.tesorero,col1X,colW,y)
      infoBox('PERIODO:',`${fmtFecha(info.fecha_inicio)} al ${fmtFecha(info.fecha_fin)}`,col2X,colW,y); y+=24

      const cFe=52,cPart=120,cLleg=120,cMod=70,cMot=100,cMon=PW-cFe-cPart-cLleg-cMod-cMot
      const cols=[{label:'Fecha',w:cFe},{label:'Partida',w:cPart},{label:'Llegada',w:cLleg},{label:'Módulo',w:cMod},{label:'Motivo',w:cMot},{label:'Monto S/',w:cMon}]
      const drawHeader=()=>{
        let cx=MARGIN
        cols.forEach(({label,w})=>{
          doc.rect(cx,y,w,rowH).fillAndStroke(ORNG,ORNG)
          doc.fillColor('white').font('Helvetica-Bold').fontSize(7).text(label,cx+2,y+(rowH-7)/2,{width:w-4,align:'center',lineBreak:false})
          cx+=w
        }); y+=rowH
      }
      drawHeader()
      movs.forEach((m,i)=>{
        const bg=i%2===0?'#fff':'#f5f7ff'
        if(y>760){doc.addPage();y=MARGIN;drawHeader()}
        const dc=(x,w,text,align='left')=>{
          doc.rect(x,y,w,rowH).fill(bg); doc.rect(x,y,w,rowH).stroke('#d4dae8')
          if(text) doc.fillColor('#1a2340').font('Helvetica').fontSize(6.5).text(String(text),x+3,y+(rowH-6.5)/2,{width:w-6,align,lineBreak:false})
        }
        let cx=MARGIN
        dc(cx,cFe,fmtFecha(m.fecha_documento),'center'); cx+=cFe
        dc(cx,cPart,m.punto_partida??''); cx+=cPart
        dc(cx,cLleg,m.punto_llegada??''); cx+=cLleg
        dc(cx,cMod,m.modulo_codigo??'','center'); cx+=cMod
        dc(cx,cMot,m.motivo??''); cx+=cMot
        doc.rect(cx,y,cMon,rowH).fill(bg); doc.rect(cx,y,cMon,rowH).stroke('#d4dae8')
        doc.fillColor('#1a2340').font('Helvetica-Bold').fontSize(6.5).text(fmtMonto(m.monto),cx+2,y+(rowH-6.5)/2,{width:cMon-4,align:'right',lineBreak:false})
        y+=rowH
      })
      const wL=cFe+cPart+cLleg+cMod+cMot
      doc.rect(MARGIN,y,wL,rowH).fillAndStroke(ORNG,ORNG)
      doc.fillColor('white').font('Helvetica-Bold').fontSize(8).text('TOTAL',MARGIN+3,y+(rowH-8)/2,{width:wL-6,align:'right',lineBreak:false})
      doc.rect(MARGIN+wL,y,cMon,rowH).fillAndStroke(ORNG,ORNG)
      doc.fillColor('white').font('Helvetica-Bold').fontSize(8).text(`S/ ${fmtMonto(totalMov)}`,MARGIN+wL+2,y+(rowH-8)/2,{width:cMon-4,align:'right',lineBreak:false})
      y+=rowH+30
      const sW=200,sX=MARGIN+(PW-sW)/2
      doc.moveTo(sX,y+28).lineTo(sX+sW,y+28).stroke()
      doc.fillColor('#1a2340').font('Helvetica-Bold').fontSize(8).text(info.tesorero,sX,y+32,{width:sW,align:'center'})
      doc.end()
    } catch(e){ reject(e) }
  })
}

function generarReciboBuffer(pool, tid) {
  return new Promise(async (resolve, reject) => {
    try {
      const MARGIN=40,PW=515,ROJO='#CC0000',AZUL='#003399',NEGRO='#000000',GRIS='#666666'
      const infoRes = await pool.request().input('tid',sql.Int,tid).query(`
        SELECT t.monto AS monto_transferencia,t.numero,t.codigo AS codigo_transferencia,
               m.codigo_modular,m.nivel,i.nombre AS ie_nombre,i.ugel AS unidad_territorial,i.codigo AS ie_codigo,
               c.nombre AS ciclo,c.anio,c.mes,c.fecha_inicio,c.fecha_fin,
               ut.nombres+' '+ut.apellidos AS tesorero,
               ua.nombres+' '+ua.apellidos AS atc,
               r.id AS rendicion_id,r.efectivo_en_caja,
               COALESCE((SELECT SUM(g.monto) FROM EQRENDICION.PAE_GASTOS g
                         JOIN EQRENDICION.PAE_COMPROBANTES cp ON cp.id=g.comprobante_id
                         WHERE cp.transferencia_id=t.id),0) AS total_gastado
        FROM EQRENDICION.PAE_TRANSFERENCIAS t
        JOIN EQRENDICION.PAE_ASIGNACIONES a ON a.id=t.asignacion_id
        JOIN EQRENDICION.PAE_MODULOS m ON m.id=a.modulo_id
        JOIN EQRENDICION.PAE_INSTITUCIONES i ON i.id=m.institucion_id
        JOIN EQRENDICION.PAE_CICLOS c ON c.id=a.ciclo_id
        JOIN EQRENDICION.PAE_TESORERO_MODULO tm ON tm.modulo_id=m.id AND tm.activo=1
        JOIN EQRENDICION.PAE_USUARIOS ut ON ut.id=tm.usuario_id
        LEFT JOIN EQRENDICION.PAE_ATC_INSTITUCION ai ON ai.institucion_id=i.id AND ai.activo=1
        LEFT JOIN EQRENDICION.PAE_USUARIOS ua ON ua.id=ai.usuario_id
        LEFT JOIN EQRENDICION.PAE_RENDICIONES r ON r.transferencia_id=t.id
        WHERE t.id=@tid`)
      if (!infoRes.recordset[0]) return resolve(null)
      const d = infoRes.recordset[0]
      const montoTransf   = Number(d.monto_transferencia||0)
      const totalGastado  = Number(d.total_gastado||0)
      const saldoDevolver = montoTransf - totalGastado

      const chunks = []
      const doc = new PDFDocument({size:'A4',layout:'portrait',margin:MARGIN})
      doc.on('data',c=>chunks.push(c)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject)

      doc.rect(MARGIN,30,PW,36).fillAndStroke('#FFF0F0',ROJO)
      doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(16).text(`RECIBO DE EGRESO N° ${d.codigo_transferencia}`,MARGIN,42,{width:PW-120,align:'center'})
      let y=82
      const lineaH=18,col1=MARGIN
      const campo=(etiqueta,valor,x,w,yy,color=AZUL)=>{
        doc.fillColor(color).font('Helvetica-Bold').fontSize(9).text(etiqueta,x,yy,{lineBreak:false})
        const lw=doc.widthOfString(etiqueta)+6
        doc.fillColor(NEGRO).font('Helvetica').fontSize(9).text(valor||'',x+lw,yy,{width:w-lw,lineBreak:false})
      }
      doc.rect(MARGIN,y,PW,1).fill('#d4dae8'); y+=6
      campo('Unidad Territorial:',d.unidad_territorial??'',col1,PW,y); y+=lineaH
      campo('NOMBRE DE LA IE:',d.ie_nombre??'',col1,PW,y); y+=lineaH
      campo('NOMBRE DEL TESORERO:',d.tesorero??'',col1,PW,y); y+=lineaH
      campo('NOMBRE DEL ATC:',d.atc??'',col1,PW,y); y+=lineaH
      doc.rect(MARGIN,y,PW,1).fill('#d4dae8'); y+=8
      const thH=20
      doc.rect(MARGIN,y,PW-80,thH).fillAndStroke('#003399','#003399')
      doc.rect(MARGIN+PW-80,y,80,thH).fillAndStroke('#003399','#003399')
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text('CONCEPTO',MARGIN+4,y+6,{width:PW-84,lineBreak:false})
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text('TOTAL',MARGIN+PW-80+4,y+6,{width:72,align:'center',lineBreak:false})
      y+=thH
      const filaC=(concepto,monto,bg='#fff')=>{
        doc.rect(MARGIN,y,PW-80,22).fillAndStroke(bg,'#d4dae8')
        doc.rect(MARGIN+PW-80,y,80,22).fillAndStroke(bg,'#d4dae8')
        doc.fillColor(NEGRO).font('Helvetica').fontSize(9).text(concepto,MARGIN+6,y+6,{width:PW-90,lineBreak:false})
        doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9).text(`S/ ${fmtMonto(monto)}`,MARGIN+PW-80+4,y+6,{width:72,align:'right',lineBreak:false})
        y+=22
      }
      filaC('Monto transferido',montoTransf)
      filaC('(-) Total gastado',totalGastado,'#fef3c7')
      filaC('= Saldo a devolver',saldoDevolver,saldoDevolver<=0?'#d1fae5':'#fee2e2')
      y+=16
      doc.rect(MARGIN,y,PW,20).fillAndStroke('#f0f2f8','#d4dae8')
      doc.fillColor(GRIS).font('Helvetica-Oblique').fontSize(8).text(`SON: ${Math.floor(saldoDevolver).toLocaleString('es-PE')} CON ${String(Math.round((saldoDevolver%1)*100)).padStart(2,'0')}/100 SOLES`,MARGIN+6,y+5,{width:PW-12})
      doc.end()
    } catch(e){ reject(e) }
  })
}
async function zipInstitucionQuery(req, res) {
  req.params.institucion_id = req.query.institucion_id
  return zipInstitucion(req, res)
}
async function getInstituciones(req, res) {
  try {
    const pool = await getPool()
    const result = await pool.request().query(`
      SELECT
        i.id,
        i.codigo,
        i.nombre,
        i.ugel,
        i.distrito,
        COUNT(DISTINCT m.id)                                          AS total_modulos,
        COUNT(DISTINCT t.id)                                          AS total_transferencias,
        SUM(CASE WHEN COALESCE(r.estado,'sin_rendicion')='enviada'
                 THEN 1 ELSE 0 END)                                   AS pendientes_revision,
        SUM(CASE WHEN COALESCE(r.estado,'sin_rendicion')='aprobada'
                 THEN 1 ELSE 0 END)                                   AS aprobadas,
        ua.nombres + ' ' + ua.apellidos                               AS atc
      FROM EQRENDICION.PAE_INSTITUCIONES       i
      LEFT JOIN EQRENDICION.PAE_MODULOS        m   ON m.institucion_id = i.id
      LEFT JOIN EQRENDICION.PAE_ASIGNACIONES   a   ON a.modulo_id = m.id
      LEFT JOIN EQRENDICION.PAE_TRANSFERENCIAS t   ON t.asignacion_id = a.id
      LEFT JOIN EQRENDICION.PAE_RENDICIONES    r   ON r.transferencia_id = t.id
      LEFT JOIN EQRENDICION.PAE_ATC_INSTITUCION ai ON ai.institucion_id = i.id AND ai.activo = 1
      LEFT JOIN EQRENDICION.PAE_USUARIOS       ua  ON ua.id = ai.usuario_id
      GROUP BY i.id, i.codigo, i.nombre, i.ugel, i.distrito,
               ua.nombres, ua.apellidos
      ORDER BY i.nombre
    `)
    res.json(result.recordset)
  } catch (err) {
    console.error('ERROR getInstituciones coordinador:', err.message)
    res.status(500).json({ error: 'Error al obtener instituciones' })
  }
}
 
async function zipInstitucionQuery(req, res) {
  req.params.institucion_id = req.query.institucion_id
  return zipInstitucion(req, res)
}
module.exports = { getTransferencias, getInstituciones, zipInstitucion, zipInstitucionQuery }