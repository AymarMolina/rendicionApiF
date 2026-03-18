const router = require('express').Router()
const ctrl   = require('../controllers/atc.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')

router.get('/instituciones', auth, roles('atc'), ctrl.getInstituciones)
router.get('/rendiciones',   auth, roles('atc'), ctrl.getRendiciones)

const coord = [auth, roles('coordinador_administrativo')]

router.get('/instituciones', ctrl.getInstituciones)
router.get('/rendiciones',   ctrl.getRendiciones)
router.get('/lista',                      ...coord, ctrl.listarATCs)
router.get('/asignaciones',               ...coord, ctrl.listarAsignaciones)
router.get('/instituciones/:institucion_id', ...coord, ctrl.atcDeInstitucion)
router.post('/asignar',                   ...coord, ctrl.asignarATC)
router.post('/desvincular',               ...coord, ctrl.desvincularATC)

module.exports = router