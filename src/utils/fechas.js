// utils/fechas.js

/**
 * Calcula la fecha límite de rendición para la transferencia número `numero`
 * dividiendo el período (fechaInicio→fechaFin) en `total` partes iguales
 * y sumando 5 días de gracia al fin de la ventana.
 */
function calcularFechaLimite(fechaInicio, fechaFin, numero, total) {
  const fi    = new Date(fechaInicio)
  const ff    = new Date(fechaFin)
  const dias  = Math.round((ff - fi) / 86400000)
  const parte = Math.floor(dias / total)
  const limite = new Date(fi)
  limite.setDate(limite.getDate() + (parte * numero) + 5)
  return limite.toISOString().split('T')[0]
}

/**
 * Parsea una celda de fecha del Excel a string YYYY-MM-DD.
 * Soporta: Date nativo, número serial de Excel, string DD/MM/YYYY.
 */
function parseExcelDate(val) {
  if (!val) return null
  if (val instanceof Date) return val.toISOString().split('T')[0]
  if (typeof val === 'number') {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000))
    return d.toISOString().split('T')[0]
  }
  if (typeof val === 'string') {
    const parts = val.split('/')
    if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`
    return val
  }
  return null
}

module.exports = { calcularFechaLimite, parseExcelDate }