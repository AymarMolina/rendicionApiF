const router = require('express').Router()
const ctrl   = require('../controllers/gastos.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')
const upload = require('../config/multer')

router.use(auth)
router.get('/',                        ctrl.getByTransferencia)
router.get('/check-presupuesto',       ctrl.checkPresupuesto)
router.post('/', upload.single('archivo'), ctrl.create)
router.delete('/:id',                  roles('tesorero'), ctrl.remove)
router.patch('/:id/estado',            roles('atc'), ctrl.cambiarEstado)
router.patch('/:id', upload.single('archivo'), ctrl.update)

module.exports = router
