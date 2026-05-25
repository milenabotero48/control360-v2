const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

// Configuración por defecto para nuevos suscriptores
const FORMAS_PAGO_DEFAULT = [
  { nombre: 'Efectivo',         tipo: 'fisico',       activa: true, orden: 1 },
  { nombre: 'Transferencia',    tipo: 'digital',      activa: true, orden: 2 },
  { nombre: 'Nequi',            tipo: 'digital',      activa: true, orden: 3 },
  { nombre: 'Daviplata',        tipo: 'digital',      activa: true, orden: 4 },
  { nombre: 'Datafono',         tipo: 'fisico',       activa: true, orden: 5 },
  { nombre: 'Cheque',           tipo: 'fisico',       activa: false, orden: 6 },
  { nombre: 'A crédito (CxC)',  tipo: 'credito',      activa: true, orden: 7 },
];

const CATEGORIAS_DEFAULT = [
  { nombre: 'Insumos taller',           tipoERI: 'costo_operativo',  activa: true, orden: 1 },
  { nombre: 'Transporte / Combustible', tipoERI: 'gasto_operativo',  activa: true, orden: 2 },
  { nombre: 'Arriendo',                 tipoERI: 'gasto_fijo',       activa: true, orden: 3 },
  { nombre: 'Servicios públicos',       tipoERI: 'gasto_fijo',       activa: true, orden: 4 },
  { nombre: 'Papelería',                tipoERI: 'gasto_operativo',  activa: true, orden: 5 },
  { nombre: 'Mantenimiento',            tipoERI: 'gasto_operativo',  activa: true, orden: 6 },
  { nombre: 'Nómina',                   tipoERI: 'gasto_personal',   activa: true, orden: 7 },
  { nombre: 'Marketing',                tipoERI: 'gasto_operativo',  activa: false, orden: 8 },
  { nombre: 'Impuestos',                tipoERI: 'gasto_fiscal',     activa: true, orden: 9 },
  { nombre: 'Otros',                    tipoERI: 'gasto_operativo',  activa: true, orden: 10 },
];

// Helper: obtener o crear doc de configuración del usuario
const getConfigRef = (userId) => db.collection('configuracion').doc(userId);

const inicializarConfigSiNoExiste = async (userId) => {
  const ref = getConfigRef(userId);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({
      userId,
      formasPago: FORMAS_PAGO_DEFAULT,
      categoriasEgresos: CATEGORIAS_DEFAULT,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { formasPago: FORMAS_PAGO_DEFAULT, categoriasEgresos: CATEGORIAS_DEFAULT };
  }
  return doc.data();
};

// ─── GET /api/configuracion ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const config = await inicializarConfigSiNoExiste(req.adminId || req.user.uid);
    res.json(config);
  } catch (e) {
    console.error('GET configuracion:', e);
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// ─── PUT /api/configuracion/formas-pago ───────────────────────────────────────
router.put('/formas-pago', async (req, res) => {
  try {
    const { formasPago } = req.body;
    if (!Array.isArray(formasPago)) return res.status(400).json({ error: 'formasPago debe ser un array' });

    // Validar que cada forma tenga nombre
    for (const fp of formasPago) {
      if (!fp.nombre?.trim()) return res.status(400).json({ error: 'Cada forma de pago debe tener nombre' });
    }

    const ref = getConfigRef(req.adminId || req.user.uid);
    await ref.set({
      userId: req.adminId || req.user.uid,
      formasPago,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'FORMAS_PAGO_ACTUALIZADAS', modulo: 'configuracion',
      descripcion: `Formas de pago actualizadas (${formasPago.length} registros)`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, formasPago });
  } catch (e) {
    console.error('PUT formas-pago:', e);
    res.status(500).json({ error: 'Error al guardar formas de pago' });
  }
});

// ─── PUT /api/configuracion/categorias ───────────────────────────────────────
router.put('/categorias', async (req, res) => {
  try {
    const { categoriasEgresos } = req.body;
    if (!Array.isArray(categoriasEgresos)) return res.status(400).json({ error: 'categoriasEgresos debe ser un array' });

    for (const c of categoriasEgresos) {
      if (!c.nombre?.trim()) return res.status(400).json({ error: 'Cada categoría debe tener nombre' });
    }

    const ref = getConfigRef(req.adminId || req.user.uid);
    await ref.set({
      userId: req.adminId || req.user.uid,
      categoriasEgresos,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'CATEGORIAS_ACTUALIZADAS', modulo: 'configuracion',
      descripcion: `Categorías de egresos actualizadas (${categoriasEgresos.length} registros)`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, categoriasEgresos });
  } catch (e) {
    console.error('PUT categorias:', e);
    res.status(500).json({ error: 'Error al guardar categorías' });
  }
});

// ─── PUT /api/configuracion/mapeo-cajas ──────────────────────────────────────
// Asocia cada forma de pago a una caja destino
router.put('/mapeo-cajas', async (req, res) => {
  try {
    const { mapeoCajas } = req.body;
    // { "Efectivo": "cajaId1", "Transferencia": "cajaId2", ... }
    if (typeof mapeoCajas !== 'object') return res.status(400).json({ error: 'mapeoCajas debe ser un objeto' });

    const ref = getConfigRef(req.adminId || req.user.uid);
    await ref.set({
      userId: req.adminId || req.user.uid,
      mapeoCajas,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true, mapeoCajas });
  } catch (e) {
    console.error('PUT mapeo-cajas:', e);
    res.status(500).json({ error: 'Error al guardar mapeo de cajas' });
  }
});

module.exports = router;
