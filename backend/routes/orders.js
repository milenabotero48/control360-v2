const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');

// GET /api/orders - Listar todas las órdenes
router.get('/', authenticate, async (req, res) => {
  try {
    const { db } = require('../config/firebase');
    const snapshot = await db.collection('orders').get();
    
    const orders = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/orders - Crear nueva orden
router.post('/', authenticate, async (req, res) => {
  try {
    const { db } = require('../config/firebase');
    const { client_id, items } = req.body;
    
    if (!client_id || !items) {
      return res.status(400).json({ error: 'client_id e items requeridos' });
    }
    
    const orderNumber = `OS-${Date.now()}`;
    
    const newOrder = {
      order_number: orderNumber,
      client_id,
      items,
      status: 'CREATED',
      created_by: req.user.uid,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const docRef = await db.collection('orders').add(newOrder);
    
    res.status(201).json({
      id: docRef.id,
      ...newOrder
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/:id - Ver detalle de orden
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { db } = require('../config/firebase');
    const { id } = req.params;
    
    const doc = await db.collection('orders').doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    
    res.json({
      id: doc.id,
      ...doc.data()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/orders/:id - Editar orden
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { db } = require('../config/firebase');
    const { id } = req.params;
    const { status, items } = req.body;
    
    const updates = {
      updated_at: new Date()
    };
    
    if (status) updates.status = status;
    if (items) updates.items = items;
    
    await db.collection('orders').doc(id).update(updates);
    
    const updatedDoc = await db.collection('orders').doc(id).get();
    
    res.json({
      id: updatedDoc.id,
      ...updatedDoc.data()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;