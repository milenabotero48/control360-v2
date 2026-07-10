const express = require('express');
const cors    = require('cors');
require('dotenv').config();

// Firebase se inicializa SOLO en config/firebase.js
require('./config/firebase');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

const { db }                     = require('./config/firebase');
const { authenticate, validarTenant } = require('./middleware/auth.js');

// ═════════════════════════════════════════════════════════════════════════════
// RATE LIMITING — solo en el endpoint de login
// ─────────────────────────────────────────────────────────────────────────────
// Máximo 20 intentos por IP en una ventana de 15 minutos.
// Frena ataques de fuerza bruta automatizados ANTES de que lleguen
// a la lógica de Firestore. express-rate-limit ya está en el proyecto
// (se instaló en Ola 1 de seguridad). Si Railway reinicia el proceso,
// la ventana se resetea — para persistencia real usar Redis, pero para
// el volumen actual de Control360 es más que suficiente en memoria.
// ═════════════════════════════════════════════════════════════════════════════
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    error: 'Demasiados intentos de acceso desde esta dirección. Intenta de nuevo en 15 minutos.',
  },
  // Sin keyGenerator personalizado — express-rate-limit maneja IPv6 correctamente por defecto
});

// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend running ✅', firebase: 'Connected ✅' });
});

// Routes
// ⚠️ loginLimiter va SOLO en /api/auth — no afecta ninguna otra ruta
app.use('/api/auth',      loginLimiter, require('./routes/auth'));
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
app.use('/api/compras',   authenticate, require('./routes/compras'));

// WhatsApp: el webhook de Meta es público — el authenticate va POR RUTA
app.use('/api/whatsapp', require('./routes/whatsapp'));
// Motor de Vencimientos (Fase 2)
app.use('/api/vencimientos', authenticate, require('./routes/vencimientos'));
// Módulo Comercial — pipeline de telemercadeo (Fase 3)
app.use('/api/comercial', authenticate, require('./routes/comercial'));

// Llamadas IA (Lucy) — extensión de Vencimientos (Fase 2.5)
const { router: llamadasIARouter, routerPublico: llamadasIAPublico } = require('./routes/llamadasIA');
app.use('/api/llamadas-ia/publico', llamadasIAPublico);
app.use('/api/llamadas-ia', authenticate, llamadasIARouter);

// ═════════════════════════════════════════════════════════════════════════════
// FIX ANNY-GATE-002: montar rutas de WhatsApp IA Anny.
// El authenticate va POR RUTA dentro de routes/anny.js (mismo patrón
// que /api/whatsapp), y el gate requireAnnyActivo valida el módulo
// 'anny_ia' en users/{adminId}.modulos (solo lo activa el SuperAdmin).
// ═════════════════════════════════════════════════════════════════════════════
app.use('/api/anny', require('./routes/anny'));

// Panel de Suscriptores — solo superAdmin
app.use('/api/superadmin', require('./routes/superadmin'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend corriendo en http://localhost:${PORT}`);
  // Iniciar cron de recordatorios de suscripción (sin dependencias externas)
  const { iniciarCron, iniciarCronWhatsapp } = require('./services/suscripcionCron');
  iniciarCron();
  iniciarCronWhatsapp();
  const { iniciarCronLlamadasIA } = require('./services/llamadasIAService');
  iniciarCronLlamadasIA();

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX ANNY-QR-001: restaurar sesiones Baileys después de cada deploy.
  // Los tenants que estaban 'conectado' reconectan automáticamente usando
  // la sesión persistida en el Volume (BAILEYS_DIR) — sin re-escanear QR.
  // Fire-and-forget: si falla, el server sigue corriendo normal.
  // ═══════════════════════════════════════════════════════════════════════════
  const { restaurarSesiones } = require('./services/baileysService');
  restaurarSesiones();

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX ANNY-NOTIF-001: cron de cobranza CxC vía Anny.
  // Viernes 9:00 AM Colombia — órdenes en cartera con más de 10 días
  // de completadas reciben recordatorio de pago por WhatsApp.
  // ═══════════════════════════════════════════════════════════════════════════
  const { iniciarCronCobranzaAnny } = require('./services/annyNotificaciones');
  iniciarCronCobranzaAnny();
});
// FIN server.js
