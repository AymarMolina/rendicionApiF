const router = require('express').Router()
const { listar, rubros } = require('../controllers/transferencias.controller')
const auth  = require('../middlewares/auth')
const roles = require('../middlewares/roles')

router.get('/',          auth, roles('tesorero'), listar)
router.get('/:id/rubros', auth, roles('tesorero'), rubros)

module.exports = router