const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getDocuments, createDocument, getDocument, updateDocument } = require('../services/firestore');

// GET /api/orders - Listar todas las órdenes
router.get('/', authenticate, async (req, res) => {
  try {
    const orders = await getDocuments('orders');
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/orders - Crear nueva orden
router.post('/', authenticate, async (req, res) => {
  try {
    const { client_id, items } = req.body;
    
    if (!client_id || !items) {
      return res.status(400).json({ error: 'client_id e items requeridos' });
    }
    
    const newOrder = {
      order_number: `OS-${Date.now()}`,
      client_id,
      items,
      status: 'CREATED',
      created_by: req.user.uid,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const order = await createDocument('orders', newOrder);
    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/:id - Ver detalle de orden
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await getDocument('orders', id);
    
    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }
    
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/orders/:id - Editar orden
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, items } = req.body;
    
    const updates = {
      updated_at: new Date()
    };
    
    if (status) updates.status = status;
    if (items) updates.items = items;
    
    const order = await updateDocument('orders', id, updates);
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;