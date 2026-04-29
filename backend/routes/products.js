const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getDocuments, createDocument, getDocument, updateDocument } = require('../services/firestore');

// GET /api/products - Listar todos los productos
router.get('/', authenticate, async (req, res) => {
  try {
    const products = await getDocuments('products');
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products - Crear nuevo producto
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, sku, price_cost, price_sale, category, stock } = req.body;
    
    if (!name || !sku) {
      return res.status(400).json({ error: 'name y sku requeridos' });
    }
    
    const newProduct = {
      name,
      sku,
      price_cost: price_cost || 0,
      price_sale: price_sale || 0,
      category: category || 'General',
      stock: stock || 0,
      active: true,
      created_by: req.user.uid,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const product = await createDocument('products', newProduct);
    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/:id - Ver detalle de producto
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const product = await getDocument('products', id);
    
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/products/:id - Editar producto
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, sku, price_cost, price_sale, category, stock, active } = req.body;
    
    const updates = {
      updated_at: new Date()
    };
    
    if (name) updates.name = name;
    if (sku) updates.sku = sku;
    if (price_cost !== undefined) updates.price_cost = price_cost;
    if (price_sale !== undefined) updates.price_sale = price_sale;
    if (category) updates.category = category;
    if (stock !== undefined) updates.stock = stock;
    if (active !== undefined) updates.active = active;
    
    const product = await updateDocument('products', id, updates);
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;