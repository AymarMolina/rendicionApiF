const multer = require('multer')
const path = require('path')

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    const name = `gasto_${Date.now()}${ext}`
    cb(null, name)
  },
})

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  if (allowed.includes(file.mimetype)) cb(null, true)
  else cb(new Error('Solo se permiten imágenes o PDF'), false)
}

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } })

module.exports = upload
