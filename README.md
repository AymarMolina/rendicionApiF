# PAE Backend — API REST Qaliwarma

Backend Express + SQL Server para el sistema de rendición de cuentas PAE.

## Requisitos
- Node.js 18+
- Acceso a SQL Server (site4now)

## Instalación

```bash
npm install
```

El archivo `.env` ya está configurado con las credenciales de la BD.

## Correr en desarrollo

```bash
npm run dev
```

## Correr en producción

```bash
npm start
```

El servidor inicia en `http://localhost:3000`

---

## Endpoints de la API

### Auth
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/login` | Login — devuelve JWT |
| GET  | `/api/auth/me` | Datos del usuario logueado |

**Body login:**
```json
{ "email": "rhuanca@ie20124.edu.pe", "password": "Pae2026@" }
```

---

### Transferencias
| Método | Ruta | Roles | Descripción |
|--------|------|-------|-------------|
| GET | `/api/transferencias` | todos | Lista (tesorero ve solo las suyas) |
| GET | `/api/transferencias/:id` | todos | Detalle de una |
| GET | `/api/transferencias/:id/rubros` | todos | Presupuesto vs gastado por rubro |
| PATCH | `/api/transferencias/:id/estado` | atc, coordinador | Cambiar estado |

---

### Gastos
| Método | Ruta | Roles | Descripción |
|--------|------|-------|-------------|
| GET | `/api/gastos?transferencia_id=X` | todos | Gastos de una transferencia |
| GET | `/api/gastos/check-presupuesto?transferencia_id=X&rubro=Y&monto=Z` | todos | Validar presupuesto en tiempo real |
| POST | `/api/gastos` | todos | Registrar gasto (multipart/form-data) |
| DELETE | `/api/gastos/:id` | tesorero | Eliminar gasto |
| PATCH | `/api/gastos/:id/estado` | atc | Aprobar/observar gasto |

**Campos POST /api/gastos (form-data):**
```
transferencia_id    (número)
fecha_documento     (YYYY-MM-DD)
concepto            (texto)
rubro               alimentos | transporte | gas | estipendio | limpieza | otros
tiene_ruc           true | false
tipo_comprobante    boleta_venta | recibo_gasto | factura | ticket | declaracion_jurada | planilla_movilidad
num_comprobante     (opcional)
monto               (número decimal)
archivo             (archivo — imagen o PDF, max 5MB)

-- Si tiene_ruc = false (campos obligatorios):
dj_nombre_proveedor
dj_dni_proveedor    (opcional)
dj_descripcion
dj_lugar            (opcional)

-- Si rubro = transporte (campos obligatorios):
mov_punto_partida
mov_punto_llegada
mov_institucion_id
mov_motivo          (opcional)
```

---

### Rendiciones
| Método | Ruta | Roles | Descripción |
|--------|------|-------|-------------|
| GET | `/api/rendiciones/:transferencia_id` | todos | Resumen + gastos + observaciones |
| POST | `/api/rendiciones` | tesorero | Crear o actualizar borrador |
| PATCH | `/api/rendiciones/:id/enviar` | tesorero | Enviar al ATC |
| PATCH | `/api/rendiciones/:id/aprobar` | atc | Aprobar rendición |
| PATCH | `/api/rendiciones/:id/observar` | atc | Observar con comentario |

---

### Asignaciones (Coordinador)
| Método | Ruta | Roles | Descripción |
|--------|------|-------|-------------|
| GET | `/api/asignaciones` | todos | Listar asignaciones |
| POST | `/api/asignaciones` | coordinador | Crear asignación + genera transferencias automáticamente |

---

## Lógica de negocio implementada

### Regla de transferencias por monto
Al crear una asignación, el sistema genera automáticamente:
- `monto < 20,000` → **1 transferencia**
- `20,000 ≤ monto < 50,000` → **2 transferencias**
- `monto ≥ 50,000` → **4 transferencias**

### Validación de presupuesto por rubro
Antes de guardar un gasto, el sistema verifica:
- Si el monto **excede** el saldo del rubro → rechaza con error 400
- Si el monto deja el saldo del rubro **por debajo del 10%** → guarda pero devuelve `advertencia`

### Reglas de documentos
- `tiene_ruc = false` → genera registro en `PAE_DECL_JURADAS` automáticamente
- `rubro = transporte` → genera registro en `PAE_PLAN_MOVILIDAD` automáticamente (obligatorio)

### Cálculo de rendición
La vista `V_RENDICION_RESUMEN` calcula automáticamente:
- `total_gastos_registrados` = suma de todos los gastos de la transferencia
- `saldo_calculado` = monto_transferencia − total_gastos_registrados

---

## Usuarios de prueba

| Email | Contraseña | Rol |
|-------|-----------|-----|
| cmendoza@ugel.gob.pe | Pae2026@ | coordinador_administrativo |
| lparedes@ugel.gob.pe | Pae2026@ | atc |
| rhuanca@ie20124.edu.pe | Pae2026@ | tesorero |

---

## Estructura del proyecto

```
pae-backend/
├── src/
│   ├── config/
│   │   ├── db.js          ← conexión SQL Server
│   │   └── multer.js      ← config subida de archivos
│   ├── middlewares/
│   │   ├── auth.js        ← verificar JWT
│   │   └── roles.js       ← guard por rol
│   ├── routes/            ← definición de rutas
│   ├── controllers/       ← lógica de cada endpoint
│   └── app.js             ← entry point
├── uploads/               ← archivos de comprobantes
├── .env                   ← credenciales (no subir a git)
└── package.json
```
PORT=3000

# SQL Server - site4now
DB_SERVER=sql8012.site4now.net
DB_DATABASE=db_a8316a_qaliwarma
DB_USER=db_a8316a_qaliwarma_admin
DB_PASSWORD=Pae2026@
DB_PORT=1433
DB_ENCRYPT=true
DB_TRUST_CERT=false

# JWT
JWT_SECRET=pae_qaliwarma_secret_2026
JWT_EXPIRES=8h