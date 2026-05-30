// backend/routes/cotizaciones.routes.js
// Control360 v2 | Módulo Cotizaciones
//
// ─────────────────────────────────────────────────────────────────────────────
// Cambios Ola 2:
//   1) Número de cotización generado en BACKEND con transacción atómica.
//      Antes el frontend calculaba el número leyendo `cotizaciones.reduce(...)`
//      y lo enviaba en el payload — vulnerable a duplicados si dos comerciales
//      creaban cotizaciones simultáneamente.
//   2) Se IGNORA cualquier `numero` que venga del frontend en el POST.
//      Solo el backend asigna el consecutivo (COT-XXXX).
//   3) Endpoint `GET /siguiente-numero` para que el frontend muestre un PREVIEW
//      del número en el formulario (no es vinculante; el real se asigna al POST).
//   4) Aislamiento por adminId en counters (preparación SaaS multi-tenant).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { db, admin }  = require('../config/firebase');
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

// ─── HELPER: generar número de cotización ATÓMICO ────────────────────────────
const generarNumeroCotizacion = async (adminId) => {
  if (!adminId) throw new Error('generarNumeroCotizacion requiere adminId');

  const counterRef = db.collection('counters').doc(`${adminId}_cotizaciones`);

  // Inicializar si es la primera vez
  const counterDoc = await counterRef.get();
  if (!counterDoc.exists) {
    const snap = await db.collection(COL).get();
    let maximo = 0;
    snap.forEach(d => {
      const num = parseInt((d.data().numero || '').replace(/\D/g, '').slice(-4));
      if (!isNaN(num) && num > maximo) maximo = num;
    });
    await counterRef.set({
      value: maximo,
      tipo: 'cotizaciones',
      adminId,
      inicializado: true,
      inicializadoEn: new Date().toISOString()
    });
  }

  const siguiente = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const actual = doc.exists ? (Number(doc.data().value) || 0) : 0;
    const nuevo = actual + 1;
    tx.set(counterRef, {
      value: nuevo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return nuevo;
  });

  return `COT-${String(siguiente).padStart(4, '0')}`;
};

// ─── HELPER: solo PEEK del siguiente número (sin incrementar) ───────────────
const peekSiguienteNumero = async (adminId) => {
  const counterRef = db.collection('counters').doc(`${adminId}_cotizaciones`);
  const doc = await counterRef.get();
  let actual = 0;
  if (doc.exists) {
    actual = Number(doc.data().value) || 0;
  } else {
    // Aún no inicializado — calcular desde la colección
    const snap = await db.collection(COL).get();
    snap.forEach(d => {
      const num = parseInt((d.data().numero || '').replace(/\D/g, '').slice(-4));
      if (!isNaN(num) && num > actual) actual = num;
    });
  }
  return `COT-${String(actual + 1).padStart(4, '0')}`;
};

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

// ─── GET /api/cotizaciones/siguiente-numero ──────────────────────────────────
// Devuelve el número que SE ASIGNARÍA si crearas ahora. No reserva, no
// incrementa — solo preview para mostrar en el formulario.
router.get('/siguiente-numero', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid || req.user.id;
    const numero = await peekSiguienteNumero(adminId);
    res.json({ numero });
  } catch (e) {
    console.error('peek número cotización:', e);
    res.status(500).json({ error: 'Error obteniendo siguiente número' });
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
// Ola 2: el `numero` del payload se IGNORA — el backend lo genera atómicamente.
router.post('/', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid || req.user.id;

    // Generar número atómicamente. El payload.numero (si viene) se descarta.
    const numero = await generarNumeroCotizacion(adminId);

    const { numero: _numeroIgnorado, ...resto } = req.body;
    const payload = {
      ...resto,
      numero, // ← solo el backend lo asigna
      adminId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      creadoPorId: req.user?.uid || '',
      creadoPorEmail: req.user?.email || '',
    };

    const ref = await db.collection(COL).add(payload);

    await db.collection('audit_logs').add({
      accion:        'COTIZACION_CREADA',
      modulo:        'cotizaciones',
      descripcion:   `Cotización ${numero} creada`,
      documento:     numero,
      usuarioId:     req.user?.uid || '',
      usuarioNombre: req.user?.email || '',
      fecha:         new Date().toISOString(),
      timestamp:     admin.firestore.FieldValue.serverTimestamp(),
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

    // El número NO se puede editar (consecutivo inmutable).
    const { numero: _numeroIgnorado, createdAt: _ca, adminId: _aid, ...resto } = req.body;
    const payload = { ...resto, updatedAt: new Date().toISOString() };
    await docRef.update(payload);

    const prevData = prev.data();
    await db.collection('audit_logs').add({
      accion:        prevData.estado !== payload.estado ? 'COTIZACION_ESTADO_CAMBIADO' : 'COTIZACION_EDITADA',
      modulo:        'cotizaciones',
      descripcion:   `Cotización ${prevData.numero} ${prevData.estado !== payload.estado ? 'cambió estado a ' + payload.estado : 'editada'}`,
      documento:     prevData.numero,
      estadoPrev:    prevData.estado,
      estadoNuevo:   payload.estado,
      usuarioId:     req.user?.uid || '',
      usuarioNombre: req.user?.email || '',
      fecha:         new Date().toISOString(),
      timestamp:     admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    res.json({ id, ...prevData, ...payload });
  } catch (e) {
    console.error('PUT cotizacion:', e);
    res.status(500).json({ error: 'Error actualizando cotización' });
  }
});

// ─── DELETE /api/cotizaciones/:id ─────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
    const docRef = db.collection(COL).doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrada' });

    const numero = doc.data().numero || '';
    await docRef.delete();

    await db.collection('audit_logs').add({
      accion:        'COTIZACION_ELIMINADA',
      modulo:        'cotizaciones',
      descripcion:   `Cotización ${numero} eliminada`,
      documento:     numero,
      usuarioId:     req.user?.uid || '',
      usuarioNombre: req.user?.email || '',
      fecha:         new Date().toISOString(),
      timestamp:     admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando' });
  }
});

module.exports = router;
