const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Firebase se inicializa SOLO en config/firebase.js
require('./config/firebase');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

const { db } = require('./config/firebase');
const { authenticate, validarTenant } = require('./middleware/auth.js');

app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend running ✅', firebase: 'Connected ✅' });
});

// Routes
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/orders',    authenticate, require('./routes/orders'));
app.use('/api/clients',   authenticate, require('./routes/clients'));
app.use('/api/products',  require('./routes/products'));
app.use('/api/quotations',authenticate, require('./routes/quotations'));
app.use('/api/cotizaciones', authenticate, require('./routes/cotizaciones.routes'));
app.use('/api/logistics', authenticate, require('./routes/logistics'));
app.use('/api/workshop',  authenticate, require('./routes/workshop'));
// Rutas QR públicas (sin autenticación) deben ir ANTES
app.use('/api/qr/public', require('./routes/qr_public'));
// Rutas QR privadas (con autenticación)
app.use('/api/qr',        authenticate, require('./routes/qr'));
app.use('/api/companies', authenticate, require('./routes/companies'));
app.use('/api/users',     authenticate, require('./routes/users'));
app.use('/api/cajas',     authenticate, require('./routes/cajas'));
app.use('/api/egresos',   authenticate, require('./routes/egresos'));
app.use('/api/configuracion', authenticate, require('./routes/configuracion'));
app.use('/api/cxc',       authenticate, require('./routes/cxc'));
app.use('/api/cxp',       authenticate, require('./routes/cxp'));
app.use('/api/proveedores', authenticate, require('./routes/proveedores'));
app.use('/api/logistica', authenticate, require('./routes/logistics'));
app.use('/api/dashboards', authenticate, require('./routes/dashboards'));
app.use('/api/eri',       authenticate, require('./routes/eri'));
app.use('/api/reportes',  authenticate, require('./routes/reportes'));
app.use('/api/alertas',   authenticate, require('./routes/alertas'));
app.use('/api/auditoria', authenticate, require('./routes/auditoria'));
app.use('/api/compras',  authenticate, require('./routes/compras'));

// Panel Maestro de Suscriptores — SIN authenticate global a propósito:
// la ruta tiene su propio authenticate + verificación superAdmin que se
// valida contra Firestore en cada petición (no contra el JWT).
app.use('/api/superadmin', require('./routes/superadmin'));

// WhatsApp: el webhook de Meta es público — el authenticate va POR RUTA
// dentro del archivo (config, envío de prueba y log sí están protegidos)
app.use('/api/whatsapp', require('./routes/whatsapp'));
// Motor de Vencimientos (Fase 2)
app.use('/api/vencimientos', authenticate, require('./routes/vencimientos'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
});
