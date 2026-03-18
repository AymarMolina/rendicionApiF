const router = require('express').Router()
const ctrl   = require('../controllers/actas.controller')
const auth   = require('../middlewares/auth')

router.use(auth)
router.get('/',         ctrl.getAll)
router.post('/generar', ctrl.generarActa)

module.exports = router