const router = require('express').Router()
const coord  = require('../controllers/coordinador.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')

const esCoord = [auth, roles('coordinador_administrativo')]

// Lista de todas las transferencias del sistema
router.get('/instituciones',                            ...esCoord, coord.getInstituciones)
router.get('/transferencias',                          ...esCoord, coord.getTransferencias)

// ZIP de todos los documentos de una institución
router.get('/instituciones/:institucion_id/zip',       ...esCoord, coord.zipInstitucion)

// Alternativa con query param (para llamar desde el frontend con fetch)
// GET /api/coordinador/zip-institucion?institucion_id=3&ciclo=Ciclo+Enero+2025
router.get('/zip-institucion',                         ...esCoord, coord.zipInstitucionQuery)

module.exports = router