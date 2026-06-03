const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const jwt = require('jsonwebtoken');
const { authenticate, validarTenant } = require('../middleware/auth');

// ─── HELPER: auditoría ────────────────────────────────────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'productos', descripcion,
      usuarioId, usuarioNombre, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

// ─── HELPER: generar código automático ───────────────────────────────────────
// ✅ FIX: filtra por adminId para que el consecutivo sea por tenant
const generarCodigo = async (prefijo, adminId) => {
  const snap = await db.collection('products')
    .where('creadoPor', '==', adminId)
    .where('codigo', '>=', prefijo + '-')
    .where('codigo', '<=', prefijo + '-\uf8ff')
    .get();
  const numeros = [];
  snap.forEach(doc => {
    const cod = doc.data().codigo || '';
    const num = parseInt(cod.split('-')[1]);
    if (!isNaN(num)) numeros.push(num);
  });
  const siguiente = numeros.length > 0 ? Math.max(...numeros) + 1 : 1;
  return `${prefijo}-${String(siguiente).padStart(3, '0')}`;
};

// ─── HELPER: redondeo inteligente ────────────────────────────────────────────
const redondearPrecio = (precio) => {
  if (precio < 10000) return Math.round(precio / 500) * 500;
  if (precio < 100000) return Math.round(precio / 1000) * 1000;
  return Math.round(precio / 5000) * 5000;
};

// ─── HELPER: recalcular compuestos afectados por cambio de componente ────────
const recalcularCompuestosAfectados = async (productoId, nuevoCosto) => {
  try {
    const snap = await db.collection('products')
      .where('tipo', '==', 'compuesto')
      .where('activo', '==', true)
      .get();

    const afectados = [];
    snap.forEach(doc => {
      const data = doc.data();
      const componentes = data.componentes || [];
      const usaProducto = componentes.find(c => c.productoId === productoId);
      if (usaProducto) {
        const componentesActualizados = componentes.map(c =>
          c.productoId === productoId ? { ...c, costo: nuevoCosto } : c
        );
        const nuevoCostoTotal = componentesActualizados.reduce((sum, c) => sum + (c.costo * c.cantidad), 0);
        const margenActual = data.precioVenta > 0
          ? parseFloat(((data.precioVenta - nuevoCostoTotal) / data.precioVenta * 100).toFixed(1))
          : 0;
        const margenAnterior = data.margen || 0;

        afectados.push({
          id: doc.id,
          nombre: data.nombre,
          codigo: data.codigo,
          costoAnterior: data.precioCosto,
          costoNuevo: nuevoCostoTotal,
          precioVenta: data.precioVenta,
          margenAnterior,
          margenNuevo: margenActual,
          componentesActualizados
        });

        db.collection('products').doc(doc.id).update({
          precioCosto: nuevoCostoTotal,
          margen: margenActual,
          componentes: componentesActualizados,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    return afectados;
  } catch (e) {
    console.error('Error recalculando compuestos:', e);
    return [];
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// CATEGORÍAS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/products/categorias/lista
router.get('/categorias/lista', authenticate, async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    const snap = await db.collection('product_categories')
      .where('adminId', '==', adminId)
      .get();
    const categorias = [];
    snap.forEach(doc => categorias.push({ id: doc.id, ...doc.data() }));
    categorias.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    res.json(categorias);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products/categorias
router.post('/categorias', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    const { nombre, prefijo, descripcion } = req.body;
    if (!nombre || !prefijo) return res.status(400).json({ error: 'Nombre y prefijo requeridos' });

    const existe = await db.collection('product_categories')
      .where('adminId', '==', adminId)
      .where('prefijo', '==', prefijo.toUpperCase()).get();
    if (!existe.empty) return res.status(400).json({ error: 'Ya existe una categoría con ese prefijo' });

    const nueva = {
      nombre: nombre.toUpperCase().trim(),
      prefijo: prefijo.toUpperCase().trim(),
      descripcion: descripcion || '',
      activo: true,
      adminId,
      creadoPor: adminId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const ref = await db.collection('product_categories').add(nueva);
    res.status(201).json({ id: ref.id, ...nueva });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/products/categorias/:id
router.put('/categorias/:id', authenticate, validarTenant('product_categories'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const { nombre, descripcion, activo } = req.body;
    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (nombre) cambios.nombre = nombre.toUpperCase().trim();
    if (descripcion !== undefined) cambios.descripcion = descripcion;
    if (activo !== undefined) cambios.activo = activo;
    await db.collection('product_categories').doc(req.params.id).update(cambios);
    res.json({ id: req.params.id, ...cambios });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/products/categorias/:id
router.delete('/categorias/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const productos = await db.collection('products').where('categoriaId', '==', req.params.id).get();
    if (!productos.empty) return res.status(400).json({ error: `No se puede eliminar — tiene ${productos.size} productos asociados` });
    await db.collection('product_categories').doc(req.params.id).delete();
    res.json({ message: 'Categoría eliminada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCTOS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/products — Listar productos
router.get('/', authenticate, async (req, res) => {
  try {
    const { categoriaId, tipo, buscar, activo, soloStock } = req.query;
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    let query = db.collection('products').where('creadoPor', '==', adminId);

    if (categoriaId) query = query.where('categoriaId', '==', categoriaId);
    if (tipo) query = query.where('tipo', '==', tipo);
    if (activo !== undefined) query = query.where('activo', '==', activo === 'true');

    const snap = await query.get();

    let productos = [];
    snap.forEach(doc => {
      const data = doc.data();
      const producto = { id: doc.id, ...data };
      if (req.user.role !== 'admin') {
        delete producto.precioCosto;
        delete producto.margen;
      }
      productos.push(producto);
    });

    if (buscar) {
      const term = buscar.toUpperCase();
      productos = productos.filter(p =>
        p.nombre?.toUpperCase().includes(term) ||
        p.codigo?.toUpperCase().includes(term) ||
        p.categoria?.toUpperCase().includes(term)
      );
    }
    if (soloStock === 'true') {
      productos = productos.filter(p => p.tieneStock);
    }

    res.json(productos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/:id — Detalle producto
router.get('/:id', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('products').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Producto no encontrado' });
    const data = { id: doc.id, ...doc.data() };
    if (req.user.role !== 'admin') { delete data.precioCosto; delete data.margen; }
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products — Crear producto
router.post('/', authenticate, async (req, res) => {
  try {
    if (!['admin', 'comercial'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Sin permisos para crear productos' });
    }

    const {
      nombre, categoriaId, categoriaNombre, categoriaPrefijo,
      tipo,
      precioCosto, precioVenta,
      tieneStock, stock, stockMinimo,
      componentes,
      descripcion, codigo, activo = true
    } = req.body;

    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!categoriaId) return res.status(400).json({ error: 'La categoría es obligatoria' });
    if (!tipo) return res.status(400).json({ error: 'El tipo es obligatorio' });

    const adminId = req.adminId || req.user.uid || req.user.id;

    // ✅ FIX: pasar adminId para que el consecutivo sea por tenant
    const codigoFinal = (codigo || await generarCodigo(categoriaPrefijo || 'PRD', adminId)).toUpperCase().trim();

    const codigoExiste = await db.collection('products')
      .where('creadoPor', '==', adminId)
      .where('codigo', '==', codigoFinal).get();
    if (!codigoExiste.empty) {
      return res.status(400).json({ error: `El código ${codigoFinal} ya existe. Usa uno diferente.` });
    }

    let costoFinal = precioCosto || 0;
    if (tipo === 'compuesto' && componentes?.length > 0) {
      costoFinal = componentes.reduce((sum, c) => sum + (c.costo * c.cantidad), 0);
    }

    const margen = precioVenta > 0 ? ((precioVenta - costoFinal) / precioVenta * 100).toFixed(1) : 0;

    const nuevoProducto = {
      nombre: nombre.toUpperCase().trim(),
      codigo: codigoFinal,
      categoriaId,
      categoria: categoriaNombre || '',
      tipo,
      precioCosto: costoFinal,
      precioVenta: precioVenta || 0,
      margen: parseFloat(margen),
      tieneStock: tipo !== 'servicio',
      stock: tipo !== 'servicio' ? (stock || 0) : 0,
      stockMinimo: stockMinimo || 0,
      componentes: tipo === 'compuesto' ? (componentes || []) : [],
      descripcion: descripcion || '',
      requiereQR: false,
      requiereCertificado: false,
      activo,
      adminId,           // ✅ campo requerido por validarTenant
      creadoPor: adminId,
      creadoPorNombre: req.user.nombre || req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('products').add(nuevoProducto);

    await auditar({
      accion: 'CREAR_PRODUCTO',
      descripcion: `${req.user.nombre || req.user.email} creó producto ${nombre} (${codigoFinal})`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { nombre, codigo: codigoFinal, tipo, precioVenta: precioVenta || 0 }
    });

    res.status(201).json({ id: ref.id, ...nuevoProducto });
  } catch (error) {
    console.error('Error creando producto:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/products/:id — Editar producto
router.put('/:id', authenticate, validarTenant('products'), async (req, res) => {
  try {
    if (!['admin', 'comercial'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Sin permisos' });
    }

    const { id } = req.params;
    const productoRef = db.collection('products').doc(id);
    const productoDoc = await productoRef.get();
    if (!productoDoc.exists) return res.status(404).json({ error: 'Producto no encontrado' });

    const actual = productoDoc.data();
    const {
      nombre, categoriaId, categoriaNombre,
      tipo, precioCosto, precioVenta,
      stock, stockMinimo, componentes,
      descripcion, activo,
      requiereQR, requiereCertificado
    } = req.body;

    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (nombre) cambios.nombre = nombre.toUpperCase().trim();
    if (categoriaId) { cambios.categoriaId = categoriaId; cambios.categoria = categoriaNombre || ''; }
    if (tipo) cambios.tipo = tipo;
    if (precioVenta !== undefined) cambios.precioVenta = precioVenta;
    if (stock !== undefined) cambios.stock = stock;
    if (stockMinimo !== undefined) cambios.stockMinimo = stockMinimo;
    if (descripcion !== undefined) cambios.descripcion = descripcion;
    if (activo !== undefined) cambios.activo = activo;
    if (requiereQR !== undefined) cambios.requiereQR = requiereQR;
    if (requiereCertificado !== undefined) cambios.requiereCertificado = requiereCertificado;

    const { codigo } = req.body;
    if (codigo && codigo.toUpperCase().trim() !== actual.codigo) {
      const codigoExiste = await db.collection('products').where('codigo', '==', codigo.toUpperCase().trim()).get();
      if (!codigoExiste.empty) {
        return res.status(400).json({ error: `El código ${codigo.toUpperCase()} ya existe. Usa uno diferente.` });
      }
      cambios.codigo = codigo.toUpperCase().trim();
    }

    if (precioCosto !== undefined && req.user.role === 'admin') {
      cambios.precioCosto = precioCosto;
    }

    if (componentes !== undefined) {
      cambios.componentes = componentes;
      if (actual.tipo === 'compuesto' || tipo === 'compuesto') {
        cambios.precioCosto = componentes.reduce((sum, c) => sum + (c.costo * c.cantidad), 0);
      }
    }

    const costoActual = cambios.precioCosto ?? actual.precioCosto ?? 0;
    const ventaActual = cambios.precioVenta ?? actual.precioVenta ?? 0;
    cambios.margen = ventaActual > 0 ? parseFloat(((ventaActual - costoActual) / ventaActual * 100).toFixed(1)) : 0;

    await productoRef.update(cambios);

    let compuestosAfectados = [];
    const costoParaCascada = cambios.precioCosto ?? actual.precioCosto ?? 0;
    if (precioCosto !== undefined && req.user.role === 'admin' && costoParaCascada >= 0) {
      compuestosAfectados = await recalcularCompuestosAfectados(id, costoParaCascada);
    }

    await auditar({
      accion: 'EDITAR_PRODUCTO',
      descripcion: `${req.user.nombre || req.user.email} editó producto ${actual.nombre}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { id, cambios: Object.keys(cambios) }
    });

    res.json({
      id,
      ...cambios,
      compuestosAfectados: compuestosAfectados.length > 0 ? compuestosAfectados : undefined
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AJUSTE MASIVO DE PRECIOS
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/products/ajuste-masivo/preview
router.post('/ajuste-masivo/preview', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const { porcentaje, categoriaId, tipo } = req.body;
    if (!porcentaje || porcentaje <= 0) return res.status(400).json({ error: 'Porcentaje inválido' });

    const adminId = req.adminId || req.user?.uid || req.user?.id;
    let query = db.collection('products')
      .where('creadoPor', '==', adminId)
      .where('activo', '==', true);
    if (categoriaId) query = query.where('categoriaId', '==', categoriaId);
    if (tipo) query = query.where('tipo', '==', tipo);

    const snap = await query.get();
    const preview = [];

    snap.forEach(doc => {
      const data = doc.data();
      if (data.tipo === 'compuesto') return;
      const precioActual = data.precioVenta || 0;
      const precioNuevo = redondearPrecio(precioActual * (1 + porcentaje / 100));
      preview.push({
        id: doc.id,
        nombre: data.nombre,
        codigo: data.codigo,
        precioActual,
        precioNuevo,
        diferencia: precioNuevo - precioActual
      });
    });

    res.json({ preview, total: preview.length, porcentaje });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products/ajuste-masivo/aplicar
router.post('/ajuste-masivo/aplicar', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const { productos, porcentaje } = req.body;
    if (!productos?.length) return res.status(400).json({ error: 'Sin productos para ajustar' });

    const batch = db.batch();
    productos.forEach(p => {
      const ref = db.collection('products').doc(p.id);
      batch.update(ref, {
        precioVenta: p.precioNuevo,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();

    await auditar({
      accion: 'AJUSTE_MASIVO_PRECIOS',
      descripcion: `Admin aplicó ajuste de ${porcentaje}% a ${productos.length} productos`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { porcentaje, totalProductos: productos.length }
    });

    res.json({ message: `Precios actualizados: ${productos.length} productos`, porcentaje });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// IMPORTAR / EXPORTAR
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/products/exportar/excel
router.get('/exportar/excel', authenticate, async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    const snap = await db.collection('products')
      .where('creadoPor', '==', adminId)
      .where('activo', '==', true).get();
    const productos = [];
    snap.forEach(doc => {
      const d = doc.data();
      productos.push({
        Codigo: d.codigo || '',
        Nombre: d.nombre || '',
        Categoria: d.categoria || '',
        Tipo: d.tipo || '',
        PrecioCosto: req.user.role === 'admin' ? (d.precioCosto || 0) : '***',
        PrecioVenta: d.precioVenta || 0,
        Stock: d.stock || 0,
        StockMinimo: d.stockMinimo || 0,
        Activo: d.activo ? 'SI' : 'NO'
      });
    });
    res.json({ productos, total: productos.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products/importar — Importar desde CSV
router.post('/importar', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const { productos } = req.body;
    if (!productos?.length) return res.status(400).json({ error: 'Sin productos para importar' });

    const adminId = req.adminId || req.user.uid || req.user.id;

    let creados = 0, errores = [];
    const batch = db.batch();

    for (const p of productos) {
      // ✅ FIX: limpiar espacios de encabezados del CSV
      const nombreProducto = (p.Nombre || p['Nombre '] || '').trim();
      const categoriaCSV = (p.Categoria || p['Categoria '] || '').toUpperCase().trim();
      const tipoCSV = (p.Tipo || p['Tipo '] || 'simple').trim().toLowerCase();

      if (!nombreProducto || !categoriaCSV) {
        errores.push(`Fila sin nombre o categoría`);
        continue;
      }

      // Buscar categoría del tenant
      let catSnap = await db.collection('product_categories')
        .where('adminId', '==', adminId)
        .where('nombre', '==', categoriaCSV).get();

      // Fallback: buscar sin adminId (categorías antiguas)
      if (catSnap.empty) {
        catSnap = await db.collection('product_categories')
          .where('nombre', '==', categoriaCSV).get();
      }

      let categoriaId = '', categoriaNombre = categoriaCSV, prefijo = 'PRD';
      if (!catSnap.empty) {
        categoriaId = catSnap.docs[0].id;
        prefijo = catSnap.docs[0].data().prefijo || 'PRD';
        categoriaNombre = catSnap.docs[0].data().nombre || categoriaCSV;
      } else {
        errores.push(`Categoría "${categoriaCSV}" no encontrada — "${nombreProducto}" asignado a PRD`);
      }

      // ✅ FIX: pasar adminId a generarCodigo para consecutivo por tenant
      const codigoCSV = (p.Codigo || p['Codigo '] || '').trim().toUpperCase();
      const codigoFinal = codigoCSV || await generarCodigo(prefijo, adminId);

      // Verificar duplicado en el mismo tenant
      const codigoExiste = await db.collection('products')
        .where('creadoPor', '==', adminId)
        .where('codigo', '==', codigoFinal).get();
      if (!codigoExiste.empty) {
        errores.push(`Código ${codigoFinal} ya existe — omitido`);
        continue;
      }

      const ref = db.collection('products').doc();
      batch.set(ref, {
        nombre: nombreProducto.toUpperCase(),
        codigo: codigoFinal,
        categoriaId,
        categoria: categoriaNombre,
        tipo: tipoCSV,
        precioCosto: parseFloat(p.PrecioCosto || p['PrecioCosto '] || 0) || 0,
        precioVenta: parseFloat(p.PrecioVenta || p['PrecioVenta '] || 0) || 0,
        stock: parseInt(p.Stock || p['Stock '] || 0) || 0,
        stockMinimo: parseInt(p.StockMinimo || p['StockMinimo '] || 0) || 0,
        tieneStock: tipoCSV !== 'servicio',
        componentes: [],
        requiereQR: false,
        requiereCertificado: false,
        activo: true,
        adminId,           // ✅ campo requerido por validarTenant
        creadoPor: adminId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      creados++;
    }

    await batch.commit();

    await auditar({
      accion: 'IMPORTAR_PRODUCTOS',
      descripcion: `Admin importó ${creados} productos`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { creados, errores: errores.length }
    });

    res.json({ message: `${creados} productos importados`, creados, errores });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/products/:id — Eliminar o desactivar según historial
// ══════════════════════════════════════════════════════════════════════════════
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });

    const prodRef = db.collection('products').doc(req.params.id);
    const prodDoc = await prodRef.get();
    if (!prodDoc.exists) return res.status(404).json({ error: 'Producto no encontrado' });

    const prod = prodDoc.data();

    const todasOrdenes = await db.collection('orders').limit(100).get();
    let tieneOrdenes = false;
    todasOrdenes.forEach(doc => {
      const items = doc.data().items || [];
      if (items.some(i => i.productoId === req.params.id)) tieneOrdenes = true;
    });

    if (tieneOrdenes) {
      await prodRef.update({
        activo: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await auditar({
        accion: 'DESACTIVAR_PRODUCTO',
        descripcion: `Admin desactivó producto ${prod.nombre} (tiene historial de ventas)`,
        usuarioId: req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        datos: { id: req.params.id, nombre: prod.nombre }
      });
      res.json({ accion: 'desactivado', mensaje: `"${prod.nombre}" fue desactivado. Permanece en el historial de órdenes.` });
    } else {
      await prodRef.delete();
      await auditar({
        accion: 'ELIMINAR_PRODUCTO',
        descripcion: `Admin eliminó producto ${prod.nombre} (sin historial)`,
        usuarioId: req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        datos: { id: req.params.id, nombre: prod.nombre }
      });
      res.json({ accion: 'eliminado', mensaje: `"${prod.nombre}" fue eliminado permanentemente.` });
    }
  } catch (error) {
    console.error('Error eliminando producto:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
