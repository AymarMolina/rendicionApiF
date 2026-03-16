const router = require('express').Router()
const ctrl   = require('../controllers/asignaciones.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')

router.use(auth)
router.get('/',  ctrl.getAll)
router.post('/', roles('coordinador_administrativo'), ctrl.create)

module.exports = router
