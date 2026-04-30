const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getDocuments, createDocument, getDocument } = require('../services/firestore');

// POST /api/auth/register - Registrar usuario
router.post('/register', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    // Crear usuario en Firestore
    const newUser = {
      email,
      password_hash: Buffer.from(password).toString('base64'),
      role: role || 'comercial',
      active: true,
      created_at: new Date()
    };

    const user = await createDocument('users', newUser);

    // Generar JWT
    const token = jwt.sign(
      { uid: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/login - Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    // Buscar usuario en Firestore
    const users = await getDocuments('users');
    const user = users.find(u => u.email === email);

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Verificar contraseña (base64 simple para desarrollo)
    const passwordHash = Buffer.from(password).toString('base64');
    if (user.password_hash !== passwordHash) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Generar JWT
    const token = jwt.sign(
      { uid: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;