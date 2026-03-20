const router = require('express').Router()
const ctrl   = require('../controllers/rendiciones.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')

router.use(auth)

router.post('/',                              roles('tesorero'), ctrl.upsert)

router.get('/:transferencia_id/anexo3',           ctrl.generarAnexo3)
router.get('/:transferencia_id/comprobantes-zip', ctrl.descargarComprobantesZip)
router.get('/:transferencia_id/dj-pdf',           ctrl.generarDJPdf)

router.patch('/:id/enviar',   roles('tesorero'), ctrl.enviar)
router.patch('/:id/aprobar',  roles('atc'),      ctrl.aprobar)
router.patch('/:id/observar', roles('atc'),      ctrl.observar)
router.get('/:transferencia_id/movilidad-pdf', ctrl.generarMovilidadPdf)
router.get('/:transferencia_id', ctrl.getByTransferencia)
router.get('/:transferencia_id/recibo-egreso', ctrl.generarReciboEgreso)

module.exports = router