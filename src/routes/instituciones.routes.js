const router = require('express').Router()
const ctrl   = require('../controllers/instituciones.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')
 
const coord = [auth, roles('coordinador_administrativo')]
 
router.get('/',        ...coord, ctrl.listar)
router.get('/buscar',  ...coord, ctrl.buscar)
 
module.exports = router