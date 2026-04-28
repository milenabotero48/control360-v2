const express = require('express');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { db, auth } = require('./config/firebase');

const app = express();

app.use(cors());
app.use(express.json());

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token no proporcionado' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'Backend running ✅', firebase: 'Connected ✅' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' });
    
    const userRecord = await auth.createUser({ email, password, displayName: full_name });
    
    await db.collection('users').doc(userRecord.uid).set({
      email, full_name, role: 'comercial', active: true,
      created_at: new Date(), last_login: null
    });
    
    res.status(201).json({ message: 'Usuario creado', uid: userRecord.uid, email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });
    
    const snapshot = await db.collection('users').where('email', '==', email).get();
    if (snapshot.empty) return res.status(401).json({ error: 'Usuario no encontrado' });
    
    const userDoc = snapshot.docs[0];
    const user = userDoc.data();
    
    const token = jwt.sign(
      { uid: userDoc.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ token, user: { uid: userDoc.id, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/logout', authenticate, (req, res) => {
  res.json({ message: 'Logout exitoso' });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ uid: userDoc.id, ...userDoc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  console.log(`✅ Firebase connected`);
});