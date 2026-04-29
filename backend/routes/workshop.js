const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getDocuments, createDocument, getDocument, updateDocument } = require('../services/firestore');

// GET /api/workshop - Listar todos los trabajos de taller
router.get('/', authenticate, async (req, res) => {
  try {
    const workshop = await getDocuments('workshop');
    res.json(workshop);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workshop - Crear nuevo trabajo de taller
router.post('/', authenticate, async (req, res) => {
  try {
    const { order_id, extinguisher_id, status } = req.body;
    
    if (!order_id || !extinguisher_id) {
      return res.status(400).json({ error: 'order_id y extinguisher_id requeridos' });
    }
    
    const newWork = {
      order_id,
      extinguisher_id,
      status: status || 'PENDING_INSPECTION',
      inspection_checklist: {
        visual_check: false,
        cleaning: false,
        seal_replacement: false,
        recharge: false,
        pressure_test: false,
        labeling: false,
        qr_update: false
      },
      qr_history: [],
      photos: [],
      notes: '',
      technician_id: req.user.uid,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const work = await createDocument('workshop', newWork);
    res.status(201).json(work);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/workshop/:id - Ver detalle de trabajo
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const work = await getDocument('workshop', id);
    
    if (!work) {
      return res.status(404).json({ error: 'Trabajo no encontrado' });
    }
    
    res.json(work);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/workshop/:id - Actualizar trabajo
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, inspection_checklist, qr_history, photos, notes } = req.body;
    
    const updates = {
      updated_at: new Date()
    };
    
    if (status) updates.status = status;
    if (inspection_checklist) updates.inspection_checklist = inspection_checklist;
    if (qr_history) updates.qr_history = qr_history;
    if (photos) updates.photos = photos;
    if (notes) updates.notes = notes;
    
    const work = await updateDocument('workshop', id, updates);
    res.json(work);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;