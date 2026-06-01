// ════════════════════════════════════════════════════════════════════════════════
// auditoria.js — Paquete B Seguridad
// ─────────────────────────────────────────────────────────────────────────────
// Endpoint genérico para registrar cualquier exportación (Excel, CSV, PDF) que
// hace un usuario desde el frontend. Permite auditar quién descargó qué y cuándo.
//
// POST /api/auditoria/exportacion
//   body: { modulo, formato, cantidad, filtros, descripcion }
//
// Adicionalmente registra intentos NO autorizados: si un usuario sin permisos
// intenta exportar (validación cruzada con la matriz de roles), se registra
// como intento bloqueado.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();
const { resolverAdminId, log } = require('./_helpers');

// ── MATRIZ DE PERMISOS DE EXPORTACIÓN ──
// Define qué roles pueden exportar qué módulo. Se valida también del lado
// frontend (para ocultar botones), pero es CRUCIAL validar también aquí
// porque alguien con conocimiento técnico podría llamar el endpoint directo.
const PERMISOS_EXPORTACION = {
  ordenes:        ['admin'],
  clientes:       ['admin'],
  historial_cliente: ['admin'],
  productos:      ['admin'],
  egresos:        ['admin'],
  cajas:          ['admin', 'tesoreria'],
  cxc:            ['admin', 'tesoreria'],
  cxp:            ['admin', 'tesoreria'],
  eri:            ['admin'],
  reportes:       ['admin'],
  qr:             ['admin'],
  cotizaciones:   ['admin'],
};

// POST /api/auditoria/exportacion
router.post('/exportacion', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });

    const { modulo, formato = 'excel', cantidad = 0, filtros = {}, descripcion = '' } = req.body;

    if (!modulo) {
      return res.status(400).json({ error: 'Falta el módulo a auditar' });
    }

    const usuarioRol = req.user?.role || 'desconocido';
    const usuarioEmail = req.user?.email || req.user?.nombre || 'desconocido';
    const usuarioId = req.user?.uid || req.user?.id || '';

    // Validar permisos: si el rol no está en la matriz, registrar como INTENTO_BLOQUEADO
    const rolesPermitidos = PERMISOS_EXPORTACION[modulo] || ['admin'];
    const autorizado = rolesPermitidos.includes(usuarioRol);

    // Registrar SIEMPRE en audit_logs (autorizado o no)
    const auditDoc = {
      adminId,
      tipo: autorizado ? 'EXPORTACION' : 'EXPORTACION_BLOQUEADA',
      modulo,
      formato,
      cantidad: Number(cantidad) || 0,
      filtros: filtros || {},
      descripcion,
      usuarioId,
      usuarioEmail,
      usuarioRol,
      autorizado,
      ip: req.ip || req.connection?.remoteAddress || '',
      userAgent: req.get('user-agent') || '',
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('audit_logs').add(auditDoc);

    if (autorizado) {
      log.info('auditoria', `${usuarioEmail} (${usuarioRol}) exportó ${modulo} — ${cantidad} registros`);
      return res.json({ ok: true, autorizado: true });
    } else {
      log.warn('auditoria', `BLOQUEADO: ${usuarioEmail} (${usuarioRol}) intentó exportar ${modulo}`);
      return res.status(403).json({
        error: 'No tienes permisos para exportar este módulo',
        autorizado: false,
        rolRequerido: rolesPermitidos
      });
    }
  } catch (e) {
    log.error('auditoria.exportacion', 'falló', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auditoria/exportaciones — listar todas (solo admin)
router.get('/exportaciones', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });

    const { desde, hasta, modulo, soloBloqueadas } = req.query;

    let q = db.collection('audit_logs').where('adminId', '==', adminId);
    if (modulo) q = q.where('modulo', '==', modulo);
    if (soloBloqueadas === 'true') {
      q = q.where('tipo', '==', 'EXPORTACION_BLOQUEADA');
    } else {
      q = q.where('tipo', 'in', ['EXPORTACION', 'EXPORTACION_BLOQUEADA']);
    }

    const snap = await q.get();
    let logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Filtros de fecha (en memoria — Firestore no permite combinaciones complejas)
    if (desde) logs = logs.filter(l => l.fecha >= desde);
    if (hasta) logs = logs.filter(l => l.fecha <= hasta + 'T23:59:59');

    // Ordenar más reciente primero
    logs.sort((a, b) => b.fecha.localeCompare(a.fecha));

    res.json({ logs, total: logs.length });
  } catch (e) {
    log.error('auditoria.list', 'falló', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
