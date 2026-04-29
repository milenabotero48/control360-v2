const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getDocuments, createDocument, getDocument, updateDocument } = require('../services/firestore');

// GET /api/quotations - Listar todas las cotizaciones
router.get('/', authenticate, async (req, res) => {
  try {
    const quotations = await getDocuments('quotations');
    res.json(quotations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/quotations - Crear nueva cotización
router.post('/', authenticate, async (req, res) => {
  try {
    const { client_id, items, discount_percent, include_tax } = req.body;
    
    if (!client_id || !items) {
      return res.status(400).json({ error: 'client_id e items requeridos' });
    }
    
    // Calcular totales
    let subtotal = 0;
    items.forEach(item => {
      subtotal += item.price * item.quantity;
    });
    
    let tax = 0;
    if (include_tax) {
      tax = subtotal * 0.19;
    }
    
    let discount = 0;
    if (discount_percent) {
      discount = (subtotal + tax) * (discount_percent / 100);
    }
    
    const total = subtotal + tax - discount;
    
    const newQuotation = {
      quotation_number: `COT-${Date.now()}`,
      client_id,
      items,
      subtotal,
      tax,
      tax_percent: include_tax ? 19 : 0,
      discount_percent: discount_percent || 0,
      discount_amount: discount,
      total,
      status: 'PENDING_CLIENT',
      validity_days: 15,
      validity_until: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      created_by: req.user.uid,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const quotation = await createDocument('quotations', newQuotation);
    res.status(201).json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/quotations/:id - Ver detalle de cotización
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const quotation = await getDocument('quotations', id);
    
    if (!quotation) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    
    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/quotations/:id - Editar cotización
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { items, discount_percent, include_tax, status } = req.body;
    
    const updates = {
      updated_at: new Date()
    };
    
    if (items) updates.items = items;
    if (discount_percent !== undefined) updates.discount_percent = discount_percent;
    if (include_tax !== undefined) updates.include_tax = include_tax;
    if (status) updates.status = status;
    
    const quotation = await updateDocument('quotations', id, updates);
    res.json(quotation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/quotations/:id/approve - APROBAR COTIZACIÓN (crea orden automática)
router.post('/:id/approve', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Obtener cotización
    const quotation = await getDocument('quotations', id);
    if (!quotation) {
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }
    
    if (quotation.status !== 'PENDING_CLIENT') {
      return res.status(400).json({ error: 'Solo se pueden aprobar cotizaciones pendientes' });
    }
    
    // Crear orden automáticamente
    const newOrder = {
      order_number: `OS-${Date.now()}`,
      client_id: quotation.client_id,
      items: quotation.items,
      subtotal: quotation.subtotal,
      tax: quotation.tax,
      discount_amount: quotation.discount_amount,
      total: quotation.total,
      status: 'CREATED',
      from_quotation_id: id,
      created_by: req.user.uid,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const order = await createDocument('orders', newOrder);
    
    // Actualizar cotización a APPROVED
    await updateDocument('quotations', id, {
      status: 'APPROVED',
      converted_to_order_id: order.id,
      converted_at: new Date()
    });
    
    res.status(201).json({
      message: 'Cotización aprobada, orden creada automáticamente',
      quotation_id: id,
      order_id: order.id,
      order: order
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;