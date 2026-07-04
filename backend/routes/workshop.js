const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

// Reutilizar LA MISMA máquina de estados de orders.js (una sola fuente de
// verdad del flujo). El taller no recalcula el flujo: lo consume.
const ordersRouter = require('./orders');
const construirFlujo = ordersRouter.construirFlujo;

// Servicio central de vencimientos (trigger por categoría)
const { crearVencimientosDeOrden } = require('../services/vencimientosService');

// Filtro de taller: SOLO recarga, mantenimiento y prueba hidrostática cuentan
// como equipo procesado. Un botiquín, chaleco o domicilio NO cuentan aunque
// estén en la orden (son venta, no servicio de taller). Lista blanca.
const CATEGORIAS_TALLER = [
  'recarga', 'mantenimiento', 'prueba hidrostatica', 'prueba hidrostática',
  'hidrostatica', 'hidrostática', 'extintor', 'extintores'
];
const esItemTaller = (item = {}) => {
  const cat = (item.categoria || '').toLowerCase();
  return CATEGORIAS_TALLER.some(c => cat.includes(c));
};

const { authenticate, validarTenant } = require('../middleware/auth');

// ─── HELPER: obtener adminId ──────────────────────────────────────────────────
const getAdminId = (req) => req.adminId || req.user?.uid || req.user?.id;

// ─── HELPER: auditoría ────────────────────────────────────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'taller', descripcion,
      usuarioId, usuarioNombre, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría taller error:', e); }
};

// ─── HELPER: verificar si empresa tiene módulo QR activo ─────────────────────
const empresaTieneQR = async (empresaId) => {
  try {
    if (!empresaId) return false;
    const doc = await db.collection('companies').doc(empresaId).get();
    if (!doc.exists) return false;
    return doc.data().moduloQR === true;
  } catch { return false; }
};

// ─── HELPER: descontar insumo del stock ──────────────────────────────────────
const descontarInsumo = async (adminId, insumoId, cantidad) => {
  try {
    const ref = db.collection('taller_insumos').doc(insumoId);
    const doc = await ref.get();
    if (!doc.exists) return;
    const data = doc.data();
    if (data.adminId !== adminId) return;

    const stockActual = data.stock || 0;
    const stockNuevo = Math.max(0, stockActual - cantidad);
    const stockMinimo = data.stockMinimo || 0;

    await ref.update({
      stock: stockNuevo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Generar alerta si stock cae bajo mínimo
    if (stockNuevo <= stockMinimo) {
      await db.collection('taller_alertas').add({
        adminId,
        tipo: 'insumo_bajo',
        insumoId,
        insumoNombre: data.nombre,
        stockActual: stockNuevo,
        stockMinimo,
        mensaje: `⚠️ Insumo "${data.nombre}" está bajo el stock mínimo (${stockNuevo} ${data.unidad} restantes)`,
        leida: false,
        fecha: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (e) { console.error('Error descontando insumo:', e); }
};

// ══════════════════════════════════════════════════════════════════════════════
// PROCESOS CONFIGURABLES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/workshop/procesos — Listar procesos de la empresa
router.get('/procesos', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const snap = await db.collection('taller_procesos')
  .where('adminId', '==', adminId)
  .get();
    const procesos = [];
    snap.forEach(doc => procesos.push({ id: doc.id, ...doc.data() }));
    res.json(procesos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workshop/procesos — Crear proceso
router.post('/procesos', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const adminId = getAdminId(req);
    const { nombre, descripcion, pasos = [], modoRapido = false } = req.body;

    if (!nombre) return res.status(400).json({ error: 'El nombre del proceso es obligatorio' });
    if (pasos.length === 0) return res.status(400).json({ error: 'El proceso debe tener al menos un paso' });

    // pasos = [{ nombre, orden, requiereFoto, insumos: [{ insumoId, insumoNombre, cantidadPorEquipo, unidad }] }]
    const nuevoProceso = {
      adminId,
      nombre: nombre.trim(),
      descripcion: descripcion || '',
      modoRapido, // true = solo marca completado, false = checklist completo
      pasos: pasos.map((p, i) => ({
        id: `paso_${Date.now()}_${i}`,
        nombre: p.nombre,
        orden: p.orden || i + 1,
        requiereFoto: p.requiereFoto || false,
        insumos: p.insumos || [] // [{ insumoId, insumoNombre, cantidadPorEquipo, unidad }]
      })),
      activo: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('taller_procesos').add(nuevoProceso);
    await auditar({
      accion: 'CREAR_PROCESO',
      descripcion: `Admin creó proceso de taller: ${nombre}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { nombre, pasos: pasos.length }
    });

    res.status(201).json({ id: ref.id, ...nuevoProceso });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/workshop/procesos/:id — Editar proceso
router.put('/procesos/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const adminId = getAdminId(req);
    const { nombre, descripcion, pasos, modoRapido, activo } = req.body;

    const ref = db.collection('taller_procesos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Proceso no encontrado' });
    if (doc.data().adminId !== adminId) return res.status(403).json({ error: 'Sin permisos' });

    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (nombre) cambios.nombre = nombre.trim();
    if (descripcion !== undefined) cambios.descripcion = descripcion;
    if (modoRapido !== undefined) cambios.modoRapido = modoRapido;
    if (activo !== undefined) cambios.activo = activo;
    if (pasos) {
      cambios.pasos = pasos.map((p, i) => ({
        id: p.id || `paso_${Date.now()}_${i}`,
        nombre: p.nombre,
        orden: p.orden || i + 1,
        requiereFoto: p.requiereFoto || false,
        insumos: p.insumos || []
      }));
    }

    await ref.update(cambios);
    res.json({ id: req.params.id, ...cambios });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/workshop/procesos/:id — Eliminar proceso
router.delete('/procesos/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const adminId = getAdminId(req);
    const ref = db.collection('taller_procesos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Proceso no encontrado' });
    if (doc.data().adminId !== adminId) return res.status(403).json({ error: 'Sin permisos' });
    await ref.delete();
    res.json({ message: 'Proceso eliminado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INSUMOS DEL TALLER
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/workshop/insumos — Listar insumos
router.get('/insumos', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const snap = await db.collection('taller_insumos')
  .where('adminId', '==', adminId)
  .get();
    const insumos = [];
    snap.forEach(doc => {
      const data = doc.data();
      insumos.push({
        id: doc.id,
        ...data,
        alerta: (data.stock || 0) <= (data.stockMinimo || 0)
      });
    });
    res.json(insumos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workshop/insumos — Crear insumo
router.post('/insumos', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const adminId = getAdminId(req);
    const { nombre, unidad, stock = 0, stockMinimo = 0, descripcion } = req.body;

    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!unidad) return res.status(400).json({ error: 'La unidad es obligatoria (Ej: L, kg, unidades)' });

    const nuevoInsumo = {
      adminId,
      nombre: nombre.trim(),
      unidad, // L, kg, unidades, metros, etc
      stock: parseFloat(stock) || 0,
      stockMinimo: parseFloat(stockMinimo) || 0,
      descripcion: descripcion || '',
      activo: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('taller_insumos').add(nuevoInsumo);
    res.status(201).json({ id: ref.id, ...nuevoInsumo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/workshop/insumos/:id — Actualizar insumo (stock, config)
router.put('/insumos/:id', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { nombre, unidad, stock, stockMinimo, descripcion, activo } = req.body;

    const ref = db.collection('taller_insumos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Insumo no encontrado' });
    if (doc.data().adminId !== adminId) return res.status(403).json({ error: 'Sin permisos' });

    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (nombre) cambios.nombre = nombre.trim();
    if (unidad) cambios.unidad = unidad;
    if (stock !== undefined) cambios.stock = parseFloat(stock);
    if (stockMinimo !== undefined) cambios.stockMinimo = parseFloat(stockMinimo);
    if (descripcion !== undefined) cambios.descripcion = descripcion;
    if (activo !== undefined) cambios.activo = activo;

    await ref.update(cambios);

    await auditar({
      accion: 'ACTUALIZAR_INSUMO',
      descripcion: `${req.user.nombre || req.user.email} actualizó insumo ${doc.data().nombre}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { id: req.params.id, cambios }
    });

    res.json({ id: req.params.id, ...cambios });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/workshop/insumos/alertas — Insumos bajo stock mínimo
router.get('/insumos/alertas', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const snap = await db.collection('taller_insumos')
  .where('adminId', '==', adminId)
  .get();

    const alertas = [];
    snap.forEach(doc => {
      const data = doc.data();
      if ((data.stock || 0) <= (data.stockMinimo || 0)) {
        alertas.push({
          id: doc.id,
          nombre: data.nombre,
          stock: data.stock || 0,
          stockMinimo: data.stockMinimo || 0,
          unidad: data.unidad,
          mensaje: `⚠️ "${data.nombre}" bajo stock mínimo: ${data.stock} ${data.unidad} (mínimo: ${data.stockMinimo})`
        });
      }
    });

    res.json(alertas);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ÓRDENES EN TALLER
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/workshop/ordenes — Órdenes en estado en_taller
router.get('/ordenes', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    // AISLAMIENTO SAAS: filtrar por adminId en Firestore (no en forEach)
    // El bug anterior filtraba en forEach pero solo para no-admin,
    // dejando que todos los admins vieran órdenes de cualquier tenant.
    const snap = await db.collection('orders')
      .where('adminId', '==', adminId)
      .where('estado', '==', 'en_taller')
      .get();

    const ahora = new Date();
    const ordenes = [];

    snap.forEach(doc => {
      const data = doc.data();
      // adminId ya filtrado en el query — no necesitamos filtrar aquí

      // ✅ TALLER-REGRESO-001: red de seguridad. Una orden con el taller ya
      // completado NUNCA debe reaparecer en la lista de taller, aunque por una
      // inconsistencia de datos su estado siga en 'en_taller'. Esto evita que
      // una orden ya facturada/pagada se re-procese o re-cobre por error.
      if (data.tallerCompletado === true) return;

      // ✅ NUEVO: Filtrar items SOLO de taller (recarga, mantenimiento, prueba hidrostática)
      // ✅ FIX ORDEN-CAMBIO-003 (2026-07-01): un item marcado como CAMBIO se
      // entrega listo — NO se procesa en taller. En órdenes mixtas (ej: 2
      // recargas con cambio + 1 sin cambio) Pedro solo debe ver el equipo
      // que realmente se queda a trabajar.
      const itemsTaller = (data.items || []).filter(item => esItemTaller(item) && !item.esCambio);
      
      // ✅ NUEVO: Si no hay items de taller, NO incluir la orden
      if (itemsTaller.length === 0) return;

      // Calcular horas en taller
      const entroTaller = data.historialEstados?.find(h => h.estado === 'en_taller')?.fecha;
      const horasEnTaller = entroTaller
        ? Math.floor((ahora - new Date(entroTaller)) / (1000 * 60 * 60))
        : 0;

      // ✅ NUEVO: Devolver orden con items filtrados + info adicional
      ordenes.push({
        id: doc.id,
        ...data,
        items: itemsTaller,  // ✅ SOLO items de taller
        itemsTotal: data.items?.length || 0,  // Info: total items en orden
        // ✅ FIX ORDEN-CAMBIO-003: "otros" = lo que NO se trabaja en taller
        // (ventas + recargas marcadas como cambio, que se entregan listas)
        itemsOtros: (data.items || []).filter(item => !esItemTaller(item) || item.esCambio).length,
        horasEnTaller,
        alertaTiempo: horasEnTaller >= 48 // Alerta si lleva más de 48h
      });
    });

    res.json(ordenes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workshop/ordenes/:ordenId/recibir — Pedro valida recepción de equipos
router.post('/ordenes/:ordenId/recibir', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { ordenId } = req.params;
    const { equiposRecibidos = [], observaciones = '', completo = true } = req.body;
    // equiposRecibidos = [{ nombre, cantidad, cantidadEsperada }]

    const ordenRef = db.collection('orders').doc(ordenId);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();

    // Crear registro de recepción en taller
    const recepcion = {
      adminId,
      ordenId,
      numeroOrden: orden.numeroOrden,
      clienteNombre: orden.clienteNombre,
      equiposRecibidos,
      completo,
      observaciones,
      tecnicoId: req.user.uid || req.user.id,
      tecnicoNombre: req.user.nombre || req.user.email,
      fecha: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('taller_recepciones').add(recepcion);

    // Si incompleto, registrar alerta
    if (!completo) {
      await db.collection('taller_alertas').add({
        adminId,
        tipo: 'recepcion_incompleta',
        ordenId,
        numeroOrden: orden.numeroOrden,
        mensaje: `⚠️ Recepción incompleta en orden ${orden.numeroOrden}: ${observaciones}`,
        leida: false,
        fecha: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Actualizar orden con datos de recepción taller
    await ordenRef.update({
      tallerRecepcion: recepcion,
      tallerRecepcionCompleta: completo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await auditar({
      accion: 'TALLER_RECEPCION',
      descripcion: `Técnico ${req.user.nombre || req.user.email} recibió equipos orden ${orden.numeroOrden} — Completo: ${completo}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { ordenId, completo, equiposRecibidos }
    });

    res.json({ message: 'Recepción registrada', completo, recepcion });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workshop/ordenes/:ordenId/paso — Marcar paso completado
router.post('/ordenes/:ordenId/paso', authenticate, validarTenant('orders'), async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { ordenId } = req.params;
    const { pasoId, pasoNombre, insumosUsados = [], observaciones = '', foto = null } = req.body;
    // insumosUsados = [{ insumoId, insumoNombre, cantidad }]

    const ordenRef = db.collection('orders').doc(ordenId);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const registro = {
      pasoId,
      pasoNombre,
      insumosUsados,
      observaciones,
      foto: foto || null,
      tecnicoId: req.user.uid || req.user.id,
      tecnicoNombre: req.user.nombre || req.user.email,
      fecha: new Date().toISOString()
    };

    // Agregar paso al historial de la orden
    await ordenRef.update({
      tallerPasos: admin.firestore.FieldValue.arrayUnion(registro),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Descontar insumos usados del stock
    for (const insumo of insumosUsados) {
      if (insumo.insumoId && insumo.cantidad > 0) {
        await descontarInsumo(adminId, insumo.insumoId, insumo.cantidad);
      }
    }

    res.json({ message: 'Paso registrado', registro });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workshop/ordenes/:ordenId/defecto — Registrar defecto en equipo
router.post('/ordenes/:ordenId/defecto', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { ordenId } = req.params;
    const {
      descripcion,
      foto = null,
      costoReparacion = 0,
      itemIndex = 0 // índice del equipo en la orden
    } = req.body;

    const ordenRef = db.collection('orders').doc(ordenId);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();

    // ✅ TALLER-REPUESTOS-001: aislamiento multi-tenant (faltaba)
    if (orden.adminId && orden.adminId !== adminId) {
      return res.status(403).json({ error: 'No tienes acceso a esta orden' });
    }

    // ✅ TALLER-REPUESTOS-001: el técnico selecciona los repuestos del catálogo
    // al registrar el defecto (se acabó la lista de precios impresa). Se validan
    // en estructura aquí; stock e inventario se procesan al AUTORIZAR, que es
    // cuando realmente entran a la orden vía la rutina compartida de orders.js.
    const { repuestos = [] } = req.body;
    const repuestosLimpios = [];
    for (const r of (Array.isArray(repuestos) ? repuestos : [])) {
      if (!r.productoId || !r.nombre) {
        return res.status(400).json({ error: 'Cada repuesto requiere productoId y nombre' });
      }
      const cant = Number(r.cantidad);
      const precio = Number(r.precioUnitario);
      if (!cant || cant <= 0) return res.status(400).json({ error: `Cantidad inválida para ${r.nombre}` });
      if (isNaN(precio) || precio < 0) return res.status(400).json({ error: `Precio inválido para ${r.nombre}` });
      repuestosLimpios.push({
        productoId: r.productoId,
        nombre: r.nombre,
        categoria: r.categoria || '',
        cantidad: cant,
        precioUnitario: precio,
        descuento: Number(r.descuento) || 0,
        notas: r.notas || ''
      });
    }

    // Cotización del defecto con la MISMA fórmula de totales de la orden
    const subtotalRep = repuestosLimpios.reduce((s, x) =>
      s + (x.precioUnitario * x.cantidad * (1 - x.descuento / 100)), 0);
    const ivaPct = Number(orden.ivaPct) || 0;
    const ivaRep = subtotalRep * (ivaPct / 100);
    const totalRep = Math.round(subtotalRep + ivaRep);
    const costoFinal = repuestosLimpios.length > 0 ? totalRep : (Number(costoReparacion) || 0);

    const defecto = {
      descripcion,
      foto,
      costoReparacion: costoFinal,
      repuestos: repuestosLimpios, // ✅ TALLER-REPUESTOS-001
      itemIndex,
      estado: 'pendiente_autorizacion', // pendiente_autorizacion | autorizado | rechazado
      tecnicoId: req.user.uid || req.user.id,
      tecnicoNombre: req.user.nombre || req.user.email,
      fecha: new Date().toISOString()
    };

    // Guardar defecto en la orden
    await ordenRef.update({
      tallerDefectos: admin.firestore.FieldValue.arrayUnion(defecto),
      tieneDefectosPendientes: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Notificación WhatsApp al cliente (preparar mensaje)
    const celular = orden.clienteCelular?.replace(/\D/g, '');
    let whatsappUrl = null;
    if (celular) {
      // ✅ TALLER-REPUESTOS-001: mensaje desglosado repuesto por repuesto
      let detalle = '';
      if (repuestosLimpios.length > 0) {
        detalle = '\n\nRepuestos necesarios:\n' + repuestosLimpios.map(r =>
          `• ${r.cantidad} x ${r.nombre} — $${Math.round(r.precioUnitario * r.cantidad * (1 - r.descuento / 100)).toLocaleString('es-CO')}`
        ).join('\n');
        if (ivaPct > 0) detalle += `\n\nSubtotal: $${Math.round(subtotalRep).toLocaleString('es-CO')}\nIVA (${ivaPct}%): $${Math.round(ivaRep).toLocaleString('es-CO')}`;
      }
      const msg = `Hola ${orden.clienteNombre}, le informamos que durante la revisión de su extintor en la orden ${orden.numeroOrden} encontramos el siguiente defecto:\n\n🔧 ${descripcion}${detalle}\n\n💰 Costo total de la reparación: $${costoFinal.toLocaleString('es-CO')}\n\n¿Autoriza la reparación? Responda SÍ o NO.\n\nGracias.`;
      whatsappUrl = `https://wa.me/57${celular}?text=${encodeURIComponent(msg)}`;
    }

    await auditar({
      accion: 'TALLER_DEFECTO',
      descripcion: `Técnico registró defecto en orden ${orden.numeroOrden}: ${descripcion}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { ordenId, descripcion, costoReparacion: costoFinal, repuestos: repuestosLimpios.map(r => ({ nombre: r.nombre, cantidad: r.cantidad, precio: r.precioUnitario })) }
    });

    res.json({ message: 'Defecto registrado', defecto, whatsappUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/workshop/ordenes/:ordenId/defecto/autorizar — Autorizar o rechazar reparación
router.put('/ordenes/:ordenId/defecto/autorizar', async (req, res) => {
  try {
    // ✅ TALLER-REPUESTOS-001: reescritura completa del endpoint.
    // Cambios respecto a la versión anterior:
    //   1. Aislamiento multi-tenant (faltaba por completo).
    //   2. Roles permitidos: admin, taller, comercial y tesorería — el cliente
    //      aprueba llamando a quien le conteste, no solo al taller.
    //   3. Los repuestos entran a la orden vía la rutina compartida
    //      agregarItemsAOrden de orders.js (recálculo con IVA, stock,
    //      inventario, historial y auditoría — una sola fuente de verdad).
    //   4. La orden PERMANECE en_taller: ya no se cambia a reparacion_proceso,
    //      que la hacía desaparecer de la lista del taller sin poder completarse.
    //   5. Doble aprobación bloqueada: un defecto ya respondido no se reprocesa
    //      (evita duplicar repuestos y descontar inventario dos veces).
    const adminId = getAdminId(req);
    const { ordenId } = req.params;
    const { defectoIndex, autorizado, repuestos: repuestosOverride } = req.body;

    const rolesPermitidos = ['admin', 'taller', 'comercial', 'tesoreria'];
    if (!rolesPermitidos.includes(req.user.role)) {
      return res.status(403).json({ error: 'Tu rol no puede responder autorizaciones de reparación' });
    }

    const ordenRef = db.collection('orders').doc(ordenId);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();
    if (orden.adminId && orden.adminId !== adminId) {
      return res.status(403).json({ error: 'No tienes acceso a esta orden' });
    }

    const defectos = orden.tallerDefectos || [];
    if (defectoIndex === undefined || !defectos[defectoIndex]) {
      return res.status(400).json({ error: 'Defecto no encontrado' });
    }

    const defecto = defectos[defectoIndex];
    if (defecto.estado !== 'pendiente_autorizacion') {
      return res.status(400).json({ error: 'Este defecto ya fue respondido' });
    }

    const usuarioId = req.user.uid || req.user.id;
    const usuarioNombre = req.user.nombre || req.user.email;

    defectos[defectoIndex].estado = autorizado ? 'autorizado' : 'rechazado';
    defectos[defectoIndex].fechaRespuesta = new Date().toISOString();
    defectos[defectoIndex].respondidoPorId = usuarioId;
    defectos[defectoIndex].respondidoPorNombre = usuarioNombre;

    const pendientes = defectos.filter(d => d.estado === 'pendiente_autorizacion');
    const flagsDefectos = {
      tallerDefectos: defectos,
      ...(pendientes.length === 0 ? { tieneDefectosPendientes: false } : {})
    };

    // Repuestos a agregar: los guardados al registrar el defecto
    // (opcionalmente ajustados desde el frontend al momento de aprobar)
    const repuestosAgregar = Array.isArray(repuestosOverride) && repuestosOverride.length > 0
      ? repuestosOverride
      : (defecto.repuestos || []);

    let totales = null;

    if (autorizado && repuestosAgregar.length > 0) {
      // La rutina compartida hace UN SOLO update atómico que incluye items,
      // totales, historial Y el estado del defecto (vía flagsOrden).
      const resultado = await ordersRouter.agregarItemsAOrden({
        ordenRef, orden, ordenId,
        itemsNuevos: repuestosAgregar,
        usuarioId, usuarioNombre,
        marcaItems:  { agregadoEnTaller: true, origenDefecto: defecto.descripcion || '' },
        flagsOrden:  flagsDefectos,
        accionHistorial:   'REPUESTOS_DEFECTO_AUTORIZADOS',
        accionAuditoria:   'TALLER_DEFECTO_AUTORIZADO',
        etiquetaHistorial: 'Taller',
        sufijoHistorial:   ' por defecto autorizado por el cliente',
        sufijoAuditoria:   ' — repuestos de defecto autorizado por el cliente'
      });
      totales = { subtotal: resultado.subtotal, ivaValor: resultado.ivaValor, total: resultado.total };
    } else {
      // Autorizado sin repuestos, o rechazado: solo actualizar el defecto
      await ordenRef.update({
        ...flagsDefectos,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await auditar({
        accion: autorizado ? 'TALLER_DEFECTO_AUTORIZADO' : 'TALLER_DEFECTO_RECHAZADO',
        descripcion: `${usuarioNombre} registró que el cliente ${autorizado ? 'AUTORIZÓ' : 'RECHAZÓ'} la reparación del defecto en orden ${orden.numeroOrden}: ${defecto.descripcion || ''}`,
        usuarioId, usuarioNombre,
        datos: { ordenId, defectoIndex, autorizado }
      });
    }

    res.json({
      message: autorizado ? 'Reparación autorizada — repuestos agregados a la orden' : 'Reparación rechazada',
      autorizado: !!autorizado,
      estado: orden.estado, // la orden no cambia de estado
      totales
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /api/workshop/ordenes/:ordenId/completar — Pedro marca orden lista → pasa a facturado
router.post('/ordenes/:ordenId/completar', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { ordenId } = req.params;
    const { observacionesFinal = '', procesosCompletados = [] } = req.body;

    const ordenRef = db.collection('orders').doc(ordenId);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();

    // Verificar que no haya defectos pendientes
    const defectosPendientes = (orden.tallerDefectos || []).filter(
      d => d.estado === 'pendiente_autorizacion'
    );
    if (defectosPendientes.length > 0) {
      return res.status(400).json({
        error: 'Hay defectos pendientes de autorización del cliente antes de completar'
      });
    }

    const ahora = new Date().toISOString();

    // Calcular tiempo en taller
    const entroTaller = orden.historialEstados?.find(h => h.estado === 'en_taller')?.fecha;
    const tiempoEnTaller = entroTaller
      ? Math.floor((new Date() - new Date(entroTaller)) / (1000 * 60 * 60))
      : 0;

    // ── Avanzar usando la MÁQUINA DE ESTADOS ÚNICA ───────────────────────────
    // El taller no decide el estado: la máquina decide según el flujo.
    // Taller sin factura → listo_entregar. Con factura → facturado.
    // Domicilio → sale a entrega. Producción → completada.
    let nuevoEstado = 'facturado';
    let estadoCursor = orden.estado;
    const historialExtra = [];
    if (typeof construirFlujo === 'function') {
      const tieneTaller = typeof orden.tieneEquipoTaller === 'boolean'
        ? orden.tieneEquipoTaller
        // ✅ FIX ORDEN-CAMBIO-003: mismo criterio que la creación en orders.js
        // (un item de CAMBIO no cuenta como equipo de taller)
        : (orden.items || []).some(it => {
            const c = (it.categoria || '').toLowerCase();
            const esTaller = ['recarga','mantenimiento','hidrostatica','hidrostática'].some(k => c.includes(k));
            return esTaller && !it.esCambio;
          });
      const flujo = construirFlujo(orden.lugarAtencion, orden.requiereFactura, tieneTaller);
      const paso = flujo[orden.estado];
      if (paso && paso.siguiente) {
        estadoCursor = paso.siguiente;
        historialExtra.push({
          estado: estadoCursor, fecha: ahora,
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.nombre || req.user.email,
          notas: `Taller completado. Tiempo: ${tiempoEnTaller}h`
        });
        // Encadenar pasos automáticos (ej: facturado→listo_entregar si ya hay factura)
        let guardia = 0;
        while (guardia++ < 10) {
          const f2 = construirFlujo(orden.lugarAtencion, orden.requiereFactura, tieneTaller);
          const p2 = f2[estadoCursor];
          if (!p2 || !p2.auto) break;
          if (p2.requiereFacturaAntes && !orden.numeroFactura) break;
          estadoCursor = p2.siguiente;
          historialExtra.push({
            estado: estadoCursor, fecha: ahora,
            usuarioId: req.user.uid || req.user.id,
            usuarioNombre: req.user.nombre || req.user.email,
            notas: 'Avance automático del sistema'
          });
        }
        nuevoEstado = estadoCursor;
      }
    }

    // ✅ TALLER-REGRESO-001: garantía anti-atasco. Si el flujo no encontró un
    // paso válido (orden mixta, lugarAtencion inesperado), nuevoEstado podría
    // seguir en 'en_taller' — dejando la orden marcada como completada pero
    // atascada en taller (el bug de NEURUM). Nunca permitir esa combinación:
    // si el taller se completó, la orden DEBE avanzar como mínimo a facturado.
    if (nuevoEstado === 'en_taller' || nuevoEstado === orden.estado) {
      nuevoEstado = 'facturado';
      historialExtra.push({
        estado: nuevoEstado, fecha: ahora,
        usuarioId: req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        notas: 'Avance de seguridad: taller completado sin paso de flujo válido'
      });
    }

    await ordenRef.update({
      estado: nuevoEstado,
      tallerCompletado: true,
      tallerCompletadoEn: ahora,
      tallerTiempoHoras: tiempoEnTaller,
      tallerObservacionesFinal: observacionesFinal,
      tallerProcesosCompletados: procesosCompletados,
      qrPendiente: false,
      historialEstados: admin.firestore.FieldValue.arrayUnion(
        ...historialExtra.length ? historialExtra : [{
          estado: nuevoEstado,
          fecha: ahora,
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.nombre || req.user.email,
          notas: `Taller completado. Tiempo: ${tiempoEnTaller}h`
        }]
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

   if (req.body.insumosUsados && req.body.insumosUsados.length > 0) {
  for (const insumo of req.body.insumosUsados) {
    if (insumo.insumoId && insumo.cantidad > 0) {
      await descontarInsumo(adminId, insumo.insumoId, insumo.cantidad);
    }
  }
}

// Si empresa tiene QR activo, actualizar QR de equipos
const tieneQR = await empresaTieneQR(orden.empresaId);
if (tieneQR) {
      // Registrar intervención en qr_equipos para cada item de la orden
      const items = orden.items || [];
      for (const item of items) {
        if (item.codigoQR) {
          const qrRef = db.collection('qr_equipos').doc(item.codigoQR);
          const qrDoc = await qrRef.get();
          if (qrDoc.exists) {
            await qrRef.update({
              ultimaIntervencion: {
                ordenId,
                numeroOrden: orden.numeroOrden,
                fecha: ahora,
                tipo: item.categoria || '',
                tecnico: req.user.nombre || req.user.email,
                pasos: procesosCompletados,
                observaciones: observacionesFinal
              },
              fechaUltimaRecarga: ahora,
              proximaRecarga: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString(),
              historial: admin.firestore.FieldValue.arrayUnion({
                fecha: ahora,
                ordenId,
                numeroOrden: orden.numeroOrden,
                tipo: item.categoria || 'Mantenimiento',
                tecnico: req.user.nombre || req.user.email,
                observaciones: observacionesFinal
              }),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
    }

    // Notificación a tesorería (alerta en sistema)
    await db.collection('taller_alertas').add({
      adminId,
      tipo: 'listo_facturar',
      ordenId,
      numeroOrden: orden.numeroOrden,
      clienteNombre: orden.clienteNombre,
      mensaje: `✅ Orden ${orden.numeroOrden} (${orden.clienteNombre}) lista para facturar`,
      leida: false,
      fecha: ahora,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await auditar({
      accion: 'TALLER_COMPLETADO',
      descripcion: `Técnico completó trabajo en orden ${orden.numeroOrden} — ${tiempoEnTaller}h en taller`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { ordenId, tiempoEnTaller, tieneQR }
    });

    // ── Hook vencimientos: categorías RECARGA Y MANTENIMIENTO / EXTINTORES ────
    if (nuevoEstado === 'completada') {
      const adminId = req.adminId || req.user?.adminId || req.user?.uid;
      crearVencimientosDeOrden(adminId, { ...orden, id: ordenId }).catch(() => {});
    }

    res.json({
      message: `Orden ${orden.numeroOrden} completada en taller`,
      nuevoEstado,
      tiempoEnTallerHoras: tiempoEnTaller,
      qrActualizado: tieneQR
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD TALLER
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/workshop/dashboard — KPIs para Pedro y Admin
router.get('/dashboard', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const hoy = new Date();
    const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).toISOString();
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString();

    // ✅ FIX PERF-DASH-002: antes se ejecutaba DOS VECES la misma query
    // (snapHoy y snapMes eran idénticas: todo el histórico de completadas,
    // con documentos completos). Ahora es UNA sola lectura con .select()
    // y el filtro por fecha se hace en memoria — mitad de lecturas y
    // payload mínimo (sin historialEstados ni fotos).
    const snapCompletadas = await db.collection('orders')
      .where('adminId', '==', adminId)
      .where('tallerCompletado', '==', true)
      .select('tallerCompletadoEn', 'items')
      .get();

    // Órdenes actualmente en taller (solo campos necesarios)
    const snapEnTaller = await db.collection('orders')
      .where('adminId', '==', adminId)
      .where('estado', '==', 'en_taller')
      .select('numeroOrden', 'clienteNombre', 'historialEstados')
      .get();

    // ✅ FIX PERF-DASH-002 (bug de datos): ordenesCompletadas de hoy/mes usaba
    // snapHoy.size / snapMes.size, que contaban TODO el histórico del tenant.
    // Ahora se cuentan solo las órdenes dentro del rango real.
    let equiposHoy = 0;
    let equiposMes = 0;
    let ordenesCompletadasHoy = 0;
    let ordenesCompletadasMes = 0;
    const porCapacidad = {}; // { '5 LBS': 12, '10 LBS': 8 }

    snapCompletadas.forEach(doc => {
      const data = doc.data();
      if (!data.tallerCompletadoEn || data.tallerCompletadoEn < inicioMes) return;
      // ✅ FIX ORDEN-CAMBIO-003: los cambios NO se recargaron en esta orden
      // (salieron listos de producción) — no inflan la meta diaria de Pedro
      const items = (data.items || []).filter(it => esItemTaller(it) && !it.esCambio);

      // Acumular MES
      ordenesCompletadasMes++;
      items.forEach(item => {
        equiposMes += item.cantidad || 1;
        const tipo = item.nombre || 'Sin tipo';
        porCapacidad[tipo] = (porCapacidad[tipo] || 0) + (item.cantidad || 1);
      });

      // Acumular HOY (subconjunto del mes)
      if (data.tallerCompletadoEn >= inicioHoy) {
        ordenesCompletadasHoy++;
        equiposHoy += items.reduce((sum, item) => sum + (item.cantidad || 1), 0);
      }
    });

    // Órdenes con alerta de tiempo (>48h en taller)
    const ordenesConAlerta = [];
    snapEnTaller.forEach(doc => {
      const data = doc.data();
      const entroTaller = data.historialEstados?.find(h => h.estado === 'en_taller')?.fecha;
      if (entroTaller) {
        const horas = Math.floor((hoy - new Date(entroTaller)) / (1000 * 60 * 60));
        if (horas >= 48) {
          ordenesConAlerta.push({
            id: doc.id,
            numeroOrden: data.numeroOrden,
            clienteNombre: data.clienteNombre,
            horasEnTaller: horas,
            mensaje: `🚨 Orden ${data.numeroOrden} lleva ${horas}h en taller`
          });
        }
      }
    });

    // Insumos bajo stock mínimo
    const snapInsumos = await db.collection('taller_insumos')
      .where('adminId', '==', adminId)
      .where('activo', '==', true)
      .get();

    const insumosAlerta = [];
    snapInsumos.forEach(doc => {
      const data = doc.data();
      if ((data.stock || 0) <= (data.stockMinimo || 0)) {
        insumosAlerta.push({
          id: doc.id,
          nombre: data.nombre,
          stock: data.stock || 0,
          stockMinimo: data.stockMinimo || 0,
          unidad: data.unidad
        });
      }
    });

    // Meta diaria (configurable por admin)
    const configDoc = await db.collection('taller_config').doc(adminId).get();
    const metaDiaria = configDoc.exists ? (configDoc.data().metaDiaria || 60) : 60;

    res.json({
      hoy: {
        equiposCompletados: equiposHoy,
        metaDiaria,
        porcentajeMeta: Math.min(100, Math.round((equiposHoy / metaDiaria) * 100)),
        // ✅ FIX PERF-DASH-002: antes reportaba snapHoy.size (histórico completo)
        ordenesCompletadas: ordenesCompletadasHoy
      },
      mes: {
        equiposCompletados: equiposMes,
        // ✅ FIX PERF-DASH-002: antes reportaba snapMes.size (histórico completo)
        ordenesCompletadas: ordenesCompletadasMes,
        porCapacidad // { 'RECARGA 5 LBS': 12, 'RECARGA CO2 10 LBS': 8 }
      },
      enTaller: {
        total: snapEnTaller.size,
        ordenesConAlerta // órdenes >48h
      },
      alertas: {
        tiempo: ordenesConAlerta,
        insumos: insumosAlerta
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ALERTAS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/workshop/alertas — Todas las alertas del taller
router.get('/alertas', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { soloNoLeidas } = req.query;

    let query = db.collection('taller_alertas')
  .where('adminId', '==', adminId)
  .orderBy('createdAt', 'desc')
  .limit(50);

if (soloNoLeidas === 'true') {
  query = db.collection('taller_alertas')
    .where('adminId', '==', adminId)
    .where('leida', '==', false);
}

    const snap = await query.get();
    const alertas = [];
    snap.forEach(doc => alertas.push({ id: doc.id, ...doc.data() }));
    res.json(alertas);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/workshop/alertas/:id/leer — Marcar alerta como leída
router.put('/alertas/:id/leer', async (req, res) => {
  try {
    await db.collection('taller_alertas').doc(req.params.id).update({
      leida: true,
      leidaEn: new Date().toISOString()
    });
    res.json({ message: 'Alerta marcada como leída' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN TALLER (meta diaria, etc)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/workshop/config — Obtener configuración del taller
router.get('/config', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const doc = await db.collection('taller_config').doc(adminId).get();
    if (!doc.exists) return res.json({ metaDiaria: 60, alertaTiempoHoras: 48 });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/workshop/config — Guardar configuración del taller
router.put('/config', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const adminId = getAdminId(req);
    const { metaDiaria, alertaTiempoHoras } = req.body;

    const config = {
      adminId,
      metaDiaria: parseInt(metaDiaria) || 60,
      alertaTiempoHoras: parseInt(alertaTiempoHoras) || 48,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('taller_config').doc(adminId).set(config, { merge: true });
    res.json({ message: 'Configuración guardada', config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
