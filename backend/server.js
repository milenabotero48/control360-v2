const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { db, auth } = require('./config/firebase');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'Backend running ✅',
    timestamp: new Date().toISOString(),
    firebase: 'Connected ✅'
  });
});

// Test endpoint - Crear usuario
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y password requeridos' });
    }
    
    // Crear en Firebase Auth
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: full_name
    });
    
    // Crear documento en Firestore
    await db.collection('users').doc(userRecord.uid).set({
      email,
      full_name,
      role: 'comercial',
      active: true,
      created_at: new Date()
    });
    
    res.status(201).json({
      message: 'Usuario creado exitosamente',
      uid: userRecord.uid
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  console.log(`✅ Firebase connected`);
});
