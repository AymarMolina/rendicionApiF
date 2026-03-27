const router = require('express').Router()
const coord  = require('../controllers/coordinador.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')

const esCoord = [auth, roles('coordinador_administrativo')]

router.get('/instituciones',                            ...esCoord, coord.getInstituciones)
router.get('/transferencias',                          ...esCoord, coord.getTransferencias)

router.get('/instituciones/:institucion_id/zip',       ...esCoord, coord.zipInstitucion)

router.get('/zip-institucion',                         ...esCoord, coord.zipInstitucionQuery)

module.exports = router