const express = require('express');
const router = express.Router();
const axios = require('axios');

const FIRESTORE_API = `https://firestore.googleapis.com/v1/projects/control360-v2/databases/(default)/documents`;
const token = process.env.JWT_SECRET;

// Validaciones
const validarNIT = (nit) => /^\d{8,}$/.test(nit);
const validarTelefono = (tel) => /^\d{7,}$/.test(tel);
const validarCelular = (cel) => /^\d{10}$/.test(cel);
const validarEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validarIVA = (iva) => {
  const num = parseInt(iva);
  return !isNaN(num) && num >= 0 && num <= 100;
};

// GET todas las empresas del usuario
router.get('/', async (req, res) => {
  try {
    const userId = req.user.uid;
    const query = `structuredQuery={filter:{fieldFilter:{field:{fieldPath:"user_id"},value:{stringValue:"${userId}"}}}}`;
    
    const response = await axios.get(
      `${FIRESTORE_API}/companies?${query}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const companies = response.data.documents || [];
    const data = companies.map(doc => ({
      id: doc.name.split('/').pop(),
      ...doc.fields
    }));

    res.json(data);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error fetching companies' });
  }
});

// GET una empresa
router.get('/:id', async (req, res) => {
  try {
    const response = await axios.get(
      `${FIRESTORE_API}/companies/${req.params.id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const doc = response.data;
    res.json({
      id: doc.name.split('/').pop(),
      ...doc.fields
    });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching company' });
  }
});

// POST crear empresa
router.post('/', async (req, res) => {
  try {
    const { name, nit, address, phone, cellphone, email, iva } = req.body;
    const userId = req.user.uid;

    // Validaciones
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    if (!validarNIT(nit)) return res.status(400).json({ error: 'NIT inválido (mínimo 8 dígitos)' });
    if (!validarTelefono(phone)) return res.status(400).json({ error: 'Teléfono inválido' });
    if (!validarCelular(cellphone)) return res.status(400).json({ error: 'Celular debe tener 10 dígitos' });
    if (!validarEmail(email)) return res.status(400).json({ error: 'Email inválido' });
    if (!validarIVA(iva)) return res.status(400).json({ error: 'IVA debe ser número entre 0-100' });

    const newCompany = {
      fields: {
        user_id: { stringValue: userId },
        name: { stringValue: name },
        nit: { stringValue: nit },
        address: { stringValue: address },
        phone: { stringValue: phone },
        cellphone: { stringValue: cellphone },
        email: { stringValue: email },
        iva: { integerValue: parseInt(iva) },
        created_at: { timestampValue: new Date().toISOString() },
        updated_at: { timestampValue: new Date().toISOString() }
      }
    };

    const response = await axios.post(
      `${FIRESTORE_API}/companies`,
      newCompany,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.status(201).json({
      id: response.data.name.split('/').pop(),
      ...response.data.fields
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error creating company' });
  }
});

// PUT actualizar empresa
router.put('/:id', async (req, res) => {
  try {
    const { name, nit, address, phone, cellphone, email, iva } = req.body;

    // Validaciones
    if (nit && !validarNIT(nit)) return res.status(400).json({ error: 'NIT inválido' });
    if (phone && !validarTelefono(phone)) return res.status(400).json({ error: 'Teléfono inválido' });
    if (cellphone && !validarCelular(cellphone)) return res.status(400).json({ error: 'Celular inválido' });
    if (email && !validarEmail(email)) return res.status(400).json({ error: 'Email inválido' });
    if (iva && !validarIVA(iva)) return res.status(400).json({ error: 'IVA inválido' });

    const updateData = {
      fields: {}
    };

    if (name) updateData.fields.name = { stringValue: name };
    if (nit) updateData.fields.nit = { stringValue: nit };
    if (address) updateData.fields.address = { stringValue: address };
    if (phone) updateData.fields.phone = { stringValue: phone };
    if (cellphone) updateData.fields.cellphone = { stringValue: cellphone };
    if (email) updateData.fields.email = { stringValue: email };
    if (iva) updateData.fields.iva = { integerValue: parseInt(iva) };
    
    updateData.fields.updated_at = { timestampValue: new Date().toISOString() };

    const response = await axios.patch(
      `${FIRESTORE_API}/companies/${req.params.id}`,
      updateData,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({
      id: response.data.name.split('/').pop(),
      ...response.data.fields
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error updating company' });
  }
});

// DELETE empresa
router.delete('/:id', async (req, res) => {
  try {
    await axios.delete(
      `${FIRESTORE_API}/companies/${req.params.id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ message: 'Company deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting company' });
  }
});

module.exports = router;