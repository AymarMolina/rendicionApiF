const router = require('express').Router()
const ctrl   = require('../controllers/rendiciones.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')

router.use(auth)
router.get('/:transferencia_id',         ctrl.getByTransferencia)
router.post('/',                         roles('tesorero'), ctrl.upsert)
router.patch('/:id/enviar',              roles('tesorero'), ctrl.enviar)
router.patch('/:id/aprobar',             roles('atc'), ctrl.aprobar)
router.patch('/:id/observar',            roles('atc'), ctrl.observar)

module.exports = router
