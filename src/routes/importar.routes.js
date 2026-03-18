const router = require('express').Router()
const multer = require('multer')
const ctrl   = require('../controllers/importar.controller')
const auth   = require('../middlewares/auth')
const roles  = require('../middlewares/roles')

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.includes('spreadsheet') ||
        file.mimetype.includes('excel') ||
        file.originalname.endsWith('.xlsx')) cb(null, true)
    else cb(new Error('Solo se aceptan archivos .xlsx'))
  }
})

const coord = [auth, roles('coordinador_administrativo')]

router.post('/transferencias',              ...coord, upload.single('archivo'), ctrl.importarTransferencias)
router.get('/ciclos',                       ...coord, ctrl.listarCiclos)
router.get('/ciclos/:ciclo_id/modulos',     ...coord, ctrl.modulosDeCiclo)
router.post('/ciclos/:ciclo_id/liberar',    ...coord, ctrl.liberarCiclo)
router.post('/tesoreros/asignar', ...coord, ctrl.asignarTesoreroManual)
router.get('/modulos/dropdown', ...coord, ctrl.modulosDropdown)
module.exports = router