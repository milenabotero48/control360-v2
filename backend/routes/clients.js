const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getDocuments, createDocument, getDocument, updateDocument } = require('../services/firestore');

// GET /api/clients - Listar todos los clientes
router.get('/', authenticate, async (req, res) => {
  try {
    const clients = await getDocuments('clients');
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/clients - Crear nuevo cliente
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, email, phone, address, city } = req.body;
    
    if (!name || !email) {
      return res.status(400).json({ error: 'name y email requeridos' });
    }
    
    const newClient = {
      name,
      email,
      phone: phone || '',
      address: address || '',
      city: city || '',
      active: true,
      created_by: req.user.uid,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const client = await createDocument('clients', newClient);
    res.status(201).json(client);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/clients/:id - Ver detalle de cliente
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const client = await getDocument('clients', id);
    
    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    
    res.json(client);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/clients/:id - Editar cliente
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, address, city, active } = req.body;
    
    const updates = {
      updated_at: new Date()
    };
    
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (phone) updates.phone = phone;
    if (address) updates.address = address;
    if (city) updates.city = city;
    if (active !== undefined) updates.active = active;
    
    const client = await updateDocument('clients', id, updates);
    res.json(client);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;