const router = require('express').Router()
const ctrl   = require('../controllers/gastos.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')
const upload = require('../config/multer')

router.use(auth)

router.get('/check-presupuesto',            ctrl.checkPresupuesto)
router.get('/',                             ctrl.getByTransferencia)
router.post('/',   upload.single('archivo'), ctrl.create)
router.patch('/:id', upload.single('archivo'), ctrl.update)
router.patch('/:id/estado',                 roles('atc'), ctrl.cambiarEstado)
router.delete('/:id',                       roles('tesorero'), ctrl.remove)

module.exports = router