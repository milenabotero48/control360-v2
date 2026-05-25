const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const jwt = require('jsonwebtoken');

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const userQuery = await db.collection('users').where('email', '==', email).get();
    if (userQuery.empty) return res.status(401).json({ error: 'Usuario no encontrado' });
    const user = userQuery.docs[0].data();
    const passwordMatch = password === user.password_hash; // En producción usar bcrypt
    if (!passwordMatch) return res.status(401).json({ error: 'Contraseña incorrecta' });
    const token = jwt.sign({ uid: userQuery.docs[0].id, email: user.email, role: user.role, adminId: user.creadoPor || userQuery.docs[0].id }, process.env.JWT_SECRET || 'control360secret', { expiresIn: '24h' });
    res.json({ token, user: { id: userQuery.docs[0].id, email: user.email, nombre: user.nombre, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;