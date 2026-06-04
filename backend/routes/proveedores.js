const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');

// GET /api/proveedores
router.get('/', authenticate, async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const snap = await db.collection('proveedores').where('adminId', '==', adminId).get();
    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lista.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/proveedores
router.post('/', authenticate, async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const { nombre, nit, telefono, email, direccion, notas } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const nuevo = {
      adminId,
      creadoPor: req.user.uid,
      nombre: nombre.toUpperCase().trim(),
      nit: (nit || '').replace(/\D/g, ''),
      telefono: (telefono || '').replace(/\D/g, ''),
      email: email || '',
      direccion: direccion || '',
      notas: notas || '',
      activo: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('proveedores').add(nuevo);
    res.status(201).json({ id: ref.id, ...nuevo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/proveedores/:id
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { nombre, nit, telefono, email, direccion, notas } = req.body;
    const update = {
      nombre: nombre?.toUpperCase().trim() || '',
      nit: (nit || '').replace(/\D/g, ''),
      telefono: (telefono || '').replace(/\D/g, ''),
      email: email || '', direccion: direccion || '', notas: notas || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection('proveedores').doc(req.params.id).update(update);
    res.json({ id: req.params.id, ...update });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/proveedores/:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await db.collection('proveedores').doc(req.params.id).update({ activo: false });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
