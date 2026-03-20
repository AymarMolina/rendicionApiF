const router = require('express').Router()
const ctrl   = require('../controllers/actas.controller')
const auth   = require('../middlewares/auth')

router.use(auth)

router.get('/', ctrl.getAll)

router.post('/generar', requireRol('tesorero'), ctrl.generarActa)

router.get('/:id/descargar', requireRol('atc', 'tesorero'), ctrl.descargarActa)

module.exports = router

function requireRol(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' })
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({
        error: `Acción no permitida para el rol "${req.user.rol}"`
      })
    }
    next()
  }
}