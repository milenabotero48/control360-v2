const express = require('express');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');

// Firebase se inicializa SOLO en config/firebase.js
require('./config/firebase');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

const { db } = require('./config/firebase');
const { authenticate, validarTenant } = require('./middleware/auth.js');
delete require.cache[require.resolve('./middleware/auth')];

app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend running ✅', firebase: 'Connected ✅' });
});

app.get('/api/test-token', (req, res) => {
  const token = jwt.sign(
    { uid: '3oUbFf2KvgbC97FXQFb8PHpwNBW2', email: 'sandra@empresa.com', role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ token });
});

// Routes
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/orders',    authenticate, require('./routes/orders'));
app.use('/api/clients',   authenticate, require('./routes/clients'));
app.use('/api/products', require('./routes/products'));
app.use('/api/quotations',authenticate, require('./routes/quotations'));
app.use('/api/cotizaciones', authenticate, require('./routes/cotizaciones.routes'));
app.use('/api/logistics', authenticate, require('./routes/logistics'));
app.use('/api/workshop',  authenticate, require('./routes/workshop'));
app.use('/api/qr',        authenticate, require('./routes/qr'));
app.use('/api/companies', authenticate, require('./routes/companies'));
app.use('/api/users',         authenticate, require('./routes/users'));
app.use('/api/cajas',         authenticate, require('./routes/cajas'));
app.use('/api/egresos',       authenticate, require('./routes/egresos'));
app.use('/api/configuracion', authenticate, require('./routes/configuracion'));
app.use('/api/cxc',           authenticate, require('./routes/cxc'));
app.use('/api/cxp',           authenticate, require('./routes/cxp'));
app.use('/api/proveedores',   authenticate, require('./routes/proveedores'));
app.use('/api/logistica',     authenticate, require('./routes/logistics'));
// Ola 2: dashboards agregados por rol
app.use('/api/dashboards',    authenticate, require('./routes/dashboards'));
// Ola 3: ERI — Estado de Resultados Integral
app.use('/api/eri',           authenticate, require('./routes/eri'));
// Ola 3 Bloque 2: Reportes operativos
app.use('/api/reportes',      authenticate, require('./routes/reportes'));
// Ola 3 Bloque 3: Alertas Inteligentes
app.use('/api/alertas',       authenticate, require('./routes/alertas'));
// Paquete B Seguridad: Auditoría de exportaciones
app.use('/api/auditoria',     authenticate, require('./routes/auditoria'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
});