const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

// GET /api/cxp — Listar todas las CxP agrupadas
router.get('/', async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;

    // 1. Egresos pendientes con "Cuenta por Pagar"
    const snapEgresos = await db.collection('egresos')
      .where('userId', '==', userId)
      .where('estado', '==', 'PENDIENTE')
      .get();

    const proveedores = {};
    let totalIvaDescontable = 0;
    let totalRetefuente = 0;

    snapEgresos.forEach(doc => {
      const e = { id: doc.id, ...doc.data() };

      // CxP Proveedor
      if (e.formaPago === 'Cuenta por Pagar' || e.formaPago === 'CxP') {
        const key = e.proveedorId || e.proveedor || 'Sin proveedor';
        if (!proveedores[key]) {
          proveedores[key] = {
            proveedorId: e.proveedorId || '',
            proveedorNombre: e.proveedor || 'Sin proveedor',
            totalPendiente: 0,
            egresos: []
          };
        }
        const saldo = (e.totalPagar || e.monto || 0) - (e.montoPagado || 0);
        proveedores[key].totalPendiente += saldo;
        proveedores[key].egresos.push({
          id: e.id, numero: e.numero, concepto: e.concepto,
          fecha: e.fecha, total: e.totalPagar || e.monto || 0,
          saldo, formaPago: e.formaPago
        });
      }

      // IVA descontable
      if (e.ivaVal > 0) totalIvaDescontable += e.ivaVal;

      // Retefuente pendiente
      if (e.retenVal > 0 && e.categoria !== 'PAGADO') totalRetefuente += e.retenVal;
    });

    // 2. IVA generado en órdenes
    const snapOrdenes = await db.collection('orders')
      .where('estado', '==', 'completada')
      .get();
    let ivaGenerado = 0;
    snapOrdenes.forEach(doc => {
      ivaGenerado += doc.data().ivaValor || 0;
    });

    // 3. Retenciones de clientes (desde CxC pagadas con retención)
    const snapCxc = await db.collection('orders')
      .where('estado', '==', 'completada')
      .where('retencionPracticada', '>', 0)
      .get();
    let totalRenta = 0;
    const retencionesClientes = [];
    snapCxc.forEach(doc => {
      const o = doc.data();
      if (o.retencionPracticada > 0) {
        totalRenta += o.retencionPracticada;
        retencionesClientes.push({
          ordenId: doc.id, numeroOrden: o.numeroOrden,
          clienteNombre: o.clienteNombre, monto: o.retencionPracticada,
          fecha: o.fechaPago
        });
      }
    });

    const ivaNeto = ivaGenerado - totalIvaDescontable;

    res.json({
      proveedores: Object.values(proveedores),
      impuestos: {
        ivaGenerado, totalIvaDescontable, ivaNeto,
        ivaFavor: ivaNeto < 0,
        retefuente: totalRetefuente,
        renta: totalRenta,
        retencionesClientes
      },
      totales: {
        proveedores: Object.values(proveedores).reduce((s, p) => s + p.totalPendiente, 0),
        impuestos: Math.max(ivaNeto, 0) + totalRetefuente + totalRenta
      }
    });
  } catch (e) {
    console.error('GET CxP:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cxp/:egresoId/pagar — Registrar pago de CxP proveedor
router.post('/:egresoId/pagar', async (req, res) => {
  try {
    const { cajaId, formaPago, fechaPago } = req.body;
    if (!cajaId || !formaPago) return res.status(400).json({ error: 'cajaId y formaPago requeridos' });

    const egresoRef = db.collection('egresos').doc(req.params.egresoId);
    const egresoDoc = await egresoRef.get();
    if (!egresoDoc.exists) return res.status(404).json({ error: 'Egreso no encontrado' });

    const egreso = egresoDoc.data();
    const totalPagar = egreso.totalPagar || egreso.monto || 0;

    const batch = db.batch();
    batch.update(egresoRef, {
      estado: 'PAGADO', cajaId, formaPago,
      fechaPago: fechaPago || new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const cajaRef = db.collection('cajas').doc(cajaId);
    batch.update(cajaRef, {
      saldo: admin.firestore.FieldValue.increment(-totalPagar),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    await db.collection('movimientos').add({
      userId: req.adminId || req.user.uid, cajaId, tipo: 'egreso',
      concepto: `Pago CxP ${egreso.numero} — ${egreso.proveedor || ''}`,
      monto: totalPagar, formaPago,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
