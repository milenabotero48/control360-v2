const express = require('express');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');

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

// TEST: Generar token válido
app.get('/api/test-token', (req, res) => {
  const token = jwt.sign(
    { uid: '3oUbFf2KvgbC97FXQFb8PHpwNBW2', email: 'sandra@empresa.com', role: 'comercial' },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ token });
});

// Routes
const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);

const ordersRouter = require('./routes/orders');
app.use('/api/orders', ordersRouter);

const clientsRouter = require('./routes/clients');
app.use('/api/clients', clientsRouter);

const productsRouter = require('./routes/products');
app.use('/api/products', productsRouter);

const quotationsRouter = require('./routes/quotations');
app.use('/api/quotations', quotationsRouter);

const logisticsRouter = require('./routes/logistics');
app.use('/api/logistics', logisticsRouter);

const workshopRouter = require('./routes/workshop');
app.use('/api/workshop', workshopRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  console.log(`✅ Firebase connected`);
});