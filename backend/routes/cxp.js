const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

// ─────────────────────────────────────────────────────────────────────────────
// Cambios Ola 1 sobre el original:
//   1) Aislamiento multi-tenant estricto: TODAS las queries de egresos y
//      órdenes filtran por adminId (antes leían toda la colección 'orders'
//      sin filtro, lo que era una fuga entre suscriptores cuando lleguemos
//      al SaaS).
//   2) Auditoría con `documento` cuando se paga una CxP.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/cxp — Listar todas las CxP agrupadas
router.get('/', async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;

    // 1. Egresos pendientes con "Cuenta por Pagar" (filtrados por userId)
    const snapEgresos = await db.collection('egresos')
      .where('userId', '==', userId)
      .where('estado', '==', 'PENDIENTE')
      .get();

    const proveedores = {};
    let totalIvaDescontable = 0;
    let totalRetefuente = 0;

    snapEgresos.forEach(doc => {
      const e = { id: doc.id, ...doc.data() };

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

      if (e.ivaVal > 0) totalIvaDescontable += e.ivaVal;
      if (e.retenVal > 0 && e.categoria !== 'PAGADO') totalRetefuente += e.retenVal;
    });

    // 2. IVA generado en órdenes — FILTRADO por adminId (corrección Ola 1)
    const snapOrdenes = await db.collection('orders')
      .where('adminId', '==', userId)
      .where('estado', '==', 'completada')
      .get();
    let ivaGenerado = 0;
    snapOrdenes.forEach(doc => {
      ivaGenerado += doc.data().ivaValor || 0;
    });

    // 3. Retenciones de clientes — también con filtro adminId
    // Nota: Firestore no permite combinar where '==' con where '>' sin un
    // índice compuesto. Filtramos retencionPracticada en memoria.
    const snapCxc = await db.collection('orders')
      .where('adminId', '==', userId)
      .where('estado', '==', 'completada')
      .get();
    let totalRenta = 0;
    const retencionesClientes = [];
    snapCxc.forEach(doc => {
      const o = doc.data();
      if ((o.retencionPracticada || 0) > 0) {
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

    // Aislamiento: solo el dueño (adminId) puede pagar el egreso
    const userId = req.adminId || req.user.uid || req.user.id;
    if (egreso.userId && egreso.userId !== userId) {
      return res.status(403).json({ error: 'No tienes acceso a este egreso' });
    }

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
      userId, cajaId, tipo: 'egreso',
      concepto: `Pago CxP ${egreso.numero} — ${egreso.proveedor || ''}`,
      monto: totalPagar,
      referencia: egreso.numero,
      formaPago,
      egresoId: req.params.egresoId,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Auditoría con documento (egreso.numero)
    try {
      await db.collection('audit_logs').add({
        accion: 'CXP_PAGADA',
        modulo: 'cxp',
        descripcion: `Pago CxP ${egreso.numero} — ${egreso.proveedor || ''} — ${fmt(totalPagar)}`,
        usuarioId: userId,
        usuarioNombre: req.user.email,
        documento: egreso.numero,
        fecha: new Date().toISOString(),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch {}

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
