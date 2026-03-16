const router = require('express').Router()
const ctrl   = require('../controllers/transferencias.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')

router.use(auth)
router.get('/',            ctrl.getAll)
router.get('/acta', auth, ctrl.generarActa)
router.get('/:id',         ctrl.getOne)
router.get('/:id/rubros',  ctrl.getRubros)
router.patch('/:id/estado', roles('atc', 'coordinador_administrativo'), ctrl.cambiarEstado)


module.exports = router
