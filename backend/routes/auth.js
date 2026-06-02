const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
// Cambios Ola 1:
//   1) Verificación con bcrypt.compare (antes: comparación de texto plano).
//   2) Mensajes de error genéricos: "Credenciales inválidas" para no revelar
//      si el email existe o no (defensa básica contra enumeración).
//   3) Bloquea login de usuarios desactivados (activo === false).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son obligatorios' });
    }

    const userQuery = await db.collection('users')
      .where('email', '==', String(email).trim().toLowerCase())
      .limit(1)
      .get();

    if (userQuery.empty) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const userDoc  = userQuery.docs[0];
    const user     = userDoc.data();
    const passHash = user.password_hash;

    if (!passHash) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (user.activo === false) {
      return res.status(403).json({ error: 'Usuario desactivado. Contacta al administrador.' });
    }

    // bcrypt.compare maneja correctamente hashes válidos.
    // Si por alguna razón llegara un valor sin hashear, compare retorna false
    // y el script migrar-passwords.js debe correrse antes del primer login.
    let ok = false;
    try {
      ok = await bcrypt.compare(String(password), String(passHash));
    } catch {
      ok = false;
    }

    if (!ok) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const esAdmin = user.role === 'admin';
    const adminId = esAdmin ? userDoc.id : (user.creadoPor || userDoc.id);

    const token = jwt.sign(
      {
        uid: userDoc.id,
        email: user.email,
        role: user.role,
        nombre: user.nombre || user.email,
        adminId
      },
      process.env.JWT_SECRET || 'control360secret',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: userDoc.id,
        email: user.email,
        nombre: user.nombre,
        role: user.role,
        modulos: user.modulos || [],
        codigo: user.codigo || '',
        adminId
      }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

module.exports = router;
