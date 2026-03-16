require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const path    = require('path')

const app = express()

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'] }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')))

app.use('/api/auth',           require('./routes/auth.routes'))
app.use('/api/transferencias', require('./routes/transferencias.routes'))
app.use('/api/gastos',         require('./routes/gastos.routes'))
app.use('/api/rendiciones',    require('./routes/rendiciones.routes'))
app.use('/api/asignaciones',   require('./routes/asignaciones.routes'))

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

app.use((req, res) => {
  res.status(404).json({ error: `Ruta ${req.method} ${req.path} no encontrada` })
})

app.use((err, req, res, next) => {
  console.error('Error no controlado:', err)
  res.status(500).json({ error: err.message || 'Error interno del servidor' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`)
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`)
})
