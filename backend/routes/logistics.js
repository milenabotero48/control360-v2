const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getDocuments, createDocument, getDocument, updateDocument } = require('../services/firestore');

// GET /api/logistics - Listar todos los registros de logística
router.get('/', authenticate, async (req, res) => {
  try {
    const logistics = await getDocuments('logistics');
    res.json(logistics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/logistics - Crear nuevo registro de logística (asignar orden a mensajero)
router.post('/', authenticate, async (req, res) => {
  try {
    const { order_id, messenger_id, pickup_address, delivery_address, status } = req.body;
    
    if (!order_id || !messenger_id) {
      return res.status(400).json({ error: 'order_id y messenger_id requeridos' });
    }
    
    const newLogistic = {
      order_id,
      messenger_id,
      pickup_address: pickup_address || '',
      delivery_address: delivery_address || '',
      status: status || 'PENDING_PICKUP',
      pickup_time: null,
      delivery_time: null,
      gps_pickup: null,
      gps_delivery: null,
      notes: '',
      created_by: req.user.uid,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const logistic = await createDocument('logistics', newLogistic);
    res.status(201).json(logistic);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/logistics/:id - Ver detalle de registro logístico
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const logistic = await getDocument('logistics', id);
    
    if (!logistic) {
      return res.status(404).json({ error: 'Registro logístico no encontrado' });
    }
    
    res.json(logistic);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/logistics/:id - Actualizar estado logístico
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, pickup_time, delivery_time, gps_pickup, gps_delivery, notes } = req.body;
    
    const updates = {
      updated_at: new Date()
    };
    
    if (status) updates.status = status;
    if (pickup_time) updates.pickup_time = pickup_time;
    if (delivery_time) updates.delivery_time = delivery_time;
    if (gps_pickup) updates.gps_pickup = gps_pickup;
    if (gps_delivery) updates.gps_delivery = gps_delivery;
    if (notes) updates.notes = notes;
    
    const logistic = await updateDocument('logistics', id, updates);
    res.json(logistic);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;