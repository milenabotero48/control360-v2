// backend/routes/cotizaciones.routes.js
// Control360 v2 | Módulo Cotizaciones

const express = require('express');
const router  = express.Router();
const { db }  = require('../config/firebase');
const jwt     = require('jsonwebtoken');

// ─── MIDDLEWARE AUTH (igual que en clients.js) ────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'control360secret');
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

const COL = 'cotizaciones';

// ─── GET /api/cotizaciones ────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const snap = await db.collection(COL).orderBy('createdAt', 'desc').get();
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(data);
  } catch (e) {
    console.error('GET cotizaciones:', e);
    res.status(500).json({ error: 'Error obteniendo cotizaciones' });
  }
});

// ─── GET /api/cotizaciones/:id ────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const doc = await db.collection(COL).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrada' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo cotización' });
  }
});

// ─── POST /api/cotizaciones ───────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const payload = {
      ...req.body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      creadoPorId: req.user?.uid || '',
    };
    const ref = await db.collection(COL).add(payload);

    await db.collection('audit_logs').add({
      accion:    'COTIZACION_CREADA',
      entidad:   'cotizacion',
      entidadId: ref.id,
      numero:    payload.numero,
      usuario:   req.user?.email || '',
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    res.status(201).json({ id: ref.id, ...payload });
  } catch (e) {
    console.error('POST cotizacion:', e);
    res.status(500).json({ error: 'Error creando cotización' });
  }
});

// ─── PUT /api/cotizaciones/:id ────────────────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection(COL).doc(id);
    const prev   = await docRef.get();
    if (!prev.exists) return res.status(404).json({ error: 'No encontrada' });

    const payload = { ...req.body, updatedAt: new Date().toISOString() };
    await docRef.update(payload);

    const prevData = prev.data();
    await db.collection('audit_logs').add({
      accion:      prevData.estado !== payload.estado ? 'COTIZACION_ESTADO_CAMBIADO' : 'COTIZACION_EDITADA',
      entidad:     'cotizacion',
      entidadId:   id,
      numero:      payload.numero,
      estadoPrev:  prevData.estado,
      estadoNuevo: payload.estado,
      usuario:     req.user?.email || '',
      timestamp:   new Date().toISOString(),
    }).catch(() => {});

    res.json({ id, ...payload });
  } catch (e) {
    console.error('PUT cotizacion:', e);
    res.status(500).json({ error: 'Error actualizando cotización' });
  }
});

// ─── DELETE /api/cotizaciones/:id ─────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
    await db.collection(COL).doc(req.params.id).delete();
    await db.collection('audit_logs').add({
      accion:    'COTIZACION_ELIMINADA',
      entidad:   'cotizacion',
      entidadId: req.params.id,
      usuario:   req.user?.email || '',
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando' });
  }
});

module.exports = router;
