// ════════════════════════════════════════════════════════════════════════════════
// routes/alertas.js — Alertas Inteligentes (transporte HTTP)
// ─────────────────────────────────────────────────────────────────────────────
// ✅ ALERTAS-001: la lógica de detección se movió a services/alertasService.js.
// Este archivo ahora solo hace lo que le corresponde a una ruta: autenticar,
// filtrar por rol, descartar resueltas y responder.
//
// Tipos de alerta (la lógica vive en el servicio):
//
//   🔴 DEFECTO_RESPONDIDO (crítica)    - el cliente contestó sobre un repuesto
//   🔴 FOTOS_FALTANTES    (crítica)    - mensajero con ≥3 órdenes sin foto
//   🔴 TALLER_ATORADO     (crítica)    - órdenes >3 días en taller sin avance
//   🟡 PAGO_PENDIENTE     (importante) - pago virtual sin validar >24h
//   🟡 PRESTAMO_VIEJO     (importante) - extintor prestado >30 días
//   🟡 CXC_VENCIDO        (importante) - cartera en mora >15 días
//   🟢 CLIENTE_FUGANDOSE  (informativa)- cliente 11+ meses sin comprar
//
// Endpoints (contrato SIN cambios — el frontend no se toca):
//   GET  /api/alertas           — alertas activas, filtradas por rol
//   POST /api/alertas/resolver  — marcar como resuelta
//   POST /api/alertas/reabrir   — reabrir una resuelta (solo admin)
// ════════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();
const { resolverAdminId, log } = require('./_helpers');
const alertasService = require('../services/alertasService');

const invalidarCache = (adminId) => alertasService.invalidarCache(adminId);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/alertas — devuelve todas las alertas activas filtradas por rol
// ────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    const rol = req.user?.role || 'admin';

    // El servicio decide qué recalcular según la cadencia de cada tipo.
    let todas = await alertasService.obtenerAlertas(adminId);

    // Filtrar por rol del usuario
    if (rol !== 'admin') {
      todas = todas.filter(a => a.rolesDestino.includes(rol));
    }

    // Descartar las que ya fueron resueltas
    const resueltasSnap = await db.collection('alertas_resueltas')
      .where('adminId', '==', adminId).get().catch(() => ({ docs: [] }));
    const claveResuelta = new Set();
    resueltasSnap.docs.forEach(d => {
      const r = d.data();
      claveResuelta.add(`${r.tipo}_${r.referenciaId}`);
    });
    todas = todas.filter(a => !claveResuelta.has(`${a.tipo}_${a.referenciaId}`));

    // Ordenar: críticas primero, luego importantes, luego informativas
    const ordenPrioridad = { critica: 0, importante: 1, informativa: 2 };
    todas.sort((a, b) => ordenPrioridad[a.prioridad] - ordenPrioridad[b.prioridad]);

    // Resumen por tipo. `casos` cuenta los problemas reales detrás de las
    // alertas agrupadas: 1 alerta puede representar 12 órdenes atoradas.
    const resumen = {
      total: todas.length,
      criticas: todas.filter(a => a.prioridad === 'critica').length,
      importantes: todas.filter(a => a.prioridad === 'importante').length,
      informativas: todas.filter(a => a.prioridad === 'informativa').length,
      casos: todas.reduce((n, a) => n + (a.cantidad || 1), 0),
      porTipo: {},
    };
    todas.forEach(a => {
      resumen.porTipo[a.tipo] = (resumen.porTipo[a.tipo] || 0) + 1;
    });

    res.json({ resumen, alertas: todas });
  } catch (e) {
    log.error('alertas.list', 'falló', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/alertas/resolver — marcar una alerta como resuelta ─────────────
router.post('/resolver', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    const { tipo, referenciaId, nota = '' } = req.body;
    if (!tipo || !referenciaId) return res.status(400).json({ error: 'tipo y referenciaId requeridos' });

    await db.collection('alertas_resueltas').add({
      adminId, tipo, referenciaId, nota,
      resueltaPor: req.user?.email || req.user?.nombre || 'admin',
      resueltaPorId: req.user?.uid || req.user?.id || '',
      fechaResolucion: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    invalidarCache(adminId);
    log.info('alertas', `${tipo}/${referenciaId} resuelta por ${req.user?.email}`);
    res.json({ ok: true });
  } catch (e) {
    log.error('alertas.resolver', 'falló', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/alertas/reabrir — reabrir una alerta cerrada (admin) ───────────
router.post('/reabrir', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const { tipo, referenciaId } = req.body;
    if (!tipo || !referenciaId) return res.status(400).json({ error: 'tipo y referenciaId requeridos' });

    const snap = await db.collection('alertas_resueltas')
      .where('adminId', '==', adminId)
      .where('tipo', '==', tipo)
      .where('referenciaId', '==', referenciaId).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();

    invalidarCache(adminId);
    res.json({ ok: true });
  } catch (e) {
    log.error('alertas.reabrir', 'falló', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ✅ TALLER-RESPUESTA-001: se expone el invalidador de cache como propiedad
// del router (no cambia el export por defecto — server.js sigue montando
// `require('./routes/alertas')` como middleware sin ninguna modificación).
// Lo usa services/tallerRespuestas.js para que la alerta del cliente aparezca
// al instante y no dentro del TTL de la cadencia.
module.exports.invalidarCacheAlertas = invalidarCache;
