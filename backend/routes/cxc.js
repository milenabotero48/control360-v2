const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const jwt = require('jsonwebtoken');
const { authenticate, validarTenant } = require('../middleware/auth');

// ─── AUDITORÍA ────────────────────────────────────────────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioEmail, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'cxc', descripcion,
      usuarioId, usuarioEmail, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría CXC error:', e); }
};

// ─── HELPER: normalizar fecha (timestamp Firestore o ISO) → ISO legible ──────
// Firestore guarda fechas como { _seconds }. Si se manda crudo al frontend,
// se ve como "[object Object]" o "Invalid Date". Esto lo convierte siempre.
const fechaISO = (f) => {
  if (!f) return null;
  if (f._seconds) return new Date(f._seconds * 1000).toISOString();
  if (f.seconds) return new Date(f.seconds * 1000).toISOString();
  if (f.toDate) { try { return f.toDate().toISOString(); } catch { /* sigue */ } }
  const d = new Date(f);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/cxc — Listar todas las CXC agrupadas por cliente
// ══════════════════════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;
    console.log('CXC GET - userId:', userId, 'role:', req.user.role);

    // Leer config de bloqueo
    const configDoc = await db.collection('configuracion').doc(userId).get();
    const diasBloqueo = configDoc.exists ? (configDoc.data().diasBloqueoCartera ?? 30) : 30;
    console.log('CXC - configExists:', configDoc.exists, 'diasBloqueo:', diasBloqueo);

    // Traer órdenes en estado CXC o con forma de pago CxC no pagadas
const [snapEstado, snapFormaPago] = await Promise.all([
  db.collection('orders').where('estado', '==', 'cxc').orderBy('createdAt', 'asc').get(),
  db.collection('orders').where('formaPago', '==', 'CXC').where('pagado', '==', false).orderBy('createdAt', 'asc').get(),
]);

// Combinar sin duplicados
const docsVistos = new Set();
const snap = { forEach: (fn) => {
  [...snapEstado.docs, ...snapFormaPago.docs].forEach(doc => {
    if (!docsVistos.has(doc.id)) { docsVistos.add(doc.id); fn(doc); }
  });
}};

    const hoy = new Date();
    const mapaClientes = {};

    snap.forEach(doc => {
      const o = { id: doc.id, ...doc.data() };
      const clienteId = o.clienteId;
      if (!mapaClientes[clienteId]) {
        mapaClientes[clienteId] = {
          clienteId,
          clienteNombre: o.clienteNombre,
          clienteNit: o.clienteNit || '',
          clienteCelular: o.clienteCelular || '',
          ordenes: [],
          totalPendiente: 0,
          fechaMasAntigua: o.createdAt,
          diasVencido: 0,
          bloqueado: false,
        };
      }
      const cliente = mapaClientes[clienteId];
      const saldoPendiente = (o.total || 0) - (o.montoPagado || 0);
      const facturaPendiente = !!o.requiereFactura && !o.numeroFactura;

      // Fechas legibles (arregla el bug del timestamp crudo de Firestore).
      const fCreacion = fechaISO(o.createdAt);
      const fFactura = fechaISO(o.fechaFactura);
      // La cartera se cuenta desde la FACTURA. Si aún no hay factura, se usa
      // la fecha de la orden como referencia provisional.
      const fechaBase = fFactura || fCreacion;

      cliente.ordenes.push({
        id: o.id,
        numeroOrden: o.numeroOrden,
        numeroFactura: o.numeroFactura || '',
        requiereFactura: !!o.requiereFactura,
        facturaPendiente,
        total: o.total || 0,
        montoPagado: o.montoPagado || 0,
        saldoPendiente,
        formaPago: o.formaPago,
        fechaCreacion: fCreacion,        // fecha de la orden (legible)
        fechaFactura: fFactura,          // fecha de la factura (legible)
        fechaConciliacion: fechaBase,    // la que cuenta para la cartera
        empresaNombre: o.empresaNombre || '',
      });
      cliente.totalPendiente += saldoPendiente;
      if (facturaPendiente) cliente.tieneFacturasPendientes = true;

      // Días vencidos contados desde la FACTURA (no desde la orden).
      const fechaRef = fechaBase ? new Date(fechaBase) : hoy;
      const dias = Math.floor((hoy - fechaRef) / (1000 * 60 * 60 * 24));
      if (dias > cliente.diasVencido) {
        cliente.diasVencido = dias;
        cliente.fechaMasAntigua = fechaBase;
      }
      // Una orden sin factura todavía NO bloquea (su plazo no ha empezado).
      if (dias >= diasBloqueo && !facturaPendiente) cliente.bloqueado = true;
    });

    // Ordenar por días vencido descendente (más urgente primero)
    const lista = Object.values(mapaClientes).sort((a, b) => b.diasVencido - a.diasVencido);
    res.json({ clientes: lista, diasBloqueo });
  } catch (e) {
    console.error('GET CXC:', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/cxc/verificar/:clienteId — Verificar si cliente está bloqueado
// ══════════════════════════════════════════════════════════════════════════════
router.get('/verificar/:clienteId', authenticate, async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;
    const { clienteId } = req.params;

    const configDoc = await db.collection('configuracion').doc(userId).get();
    const diasBloqueo = configDoc.exists ? (configDoc.data().diasBloqueoCartera || 30) : 30;

    const snap = await db.collection('orders')
      .where('clienteId', '==', clienteId)
      .where('estado', '==', 'cxc')
      .get();

    if (snap.empty) return res.json({ bloqueado: false, diasVencido: 0, totalPendiente: 0 });

    const hoy = new Date();
    let diasVencido = 0;
    let totalPendiente = 0;
    let hayFacturaPendiente = false;

    snap.forEach(doc => {
      const o = doc.data();
      const facturaPendiente = !!o.requiereFactura && !o.numeroFactura;
      if (facturaPendiente) hayFacturaPendiente = true;
      // Contar desde la FACTURA (consistente con el estado de cuenta).
      const base = fechaISO(o.fechaFactura) || fechaISO(o.createdAt);
      const fechaRef = base ? new Date(base) : hoy;
      const dias = Math.floor((hoy - fechaRef) / (1000 * 60 * 60 * 24));
      // Una orden sin factura aún no cuenta para mora.
      if (!facturaPendiente && dias > diasVencido) diasVencido = dias;
      totalPendiente += (o.total || 0) - (o.montoPagado || 0);
    });

    res.json({
      bloqueado: diasVencido >= diasBloqueo,
      diasVencido,
      totalPendiente,
      hayFacturaPendiente,
      diasBloqueo
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/cxc/gestiones/todas — Todas las gestiones (para dashboard)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/gestiones/todas', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('gestiones_cobranza')
      .orderBy('createdAt', 'desc')
      .get();
    const gestiones = [];
    snap.forEach(doc => gestiones.push({ id: doc.id, ...doc.data() }));
    res.json(gestiones);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/cxc/gestiones/:clienteId — Historial de gestiones de cobranza
// ══════════════════════════════════════════════════════════════════════════════
router.get('/gestiones/:clienteId', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('gestiones_cobranza')
      .where('clienteId', '==', req.params.clienteId)
      .orderBy('createdAt', 'desc')
      .get();
    const gestiones = [];
    snap.forEach(doc => gestiones.push({ id: doc.id, ...doc.data() }));
    res.json(gestiones);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/cxc/gestiones — Registrar gestión de cobranza
// ══════════════════════════════════════════════════════════════════════════════
router.post('/gestiones', authenticate, async (req, res) => {
  try {
    const { clienteId, clienteNombre, nota, proximoSeguimiento } = req.body;
    if (!clienteId || !nota?.trim()) {
      return res.status(400).json({ error: 'clienteId y nota son requeridos' });
    }
    const gestion = {
      clienteId,
      clienteNombre: clienteNombre || '',
      nota: nota.trim(),
      proximoSeguimiento: proximoSeguimiento || null,
      realizadoPor: req.user.nombre || req.user.email,
      realizadoPorId: req.adminId || req.user.uid || req.user.id,
      fecha: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const ref = await db.collection('gestiones_cobranza').add(gestion);
    res.status(201).json({ id: ref.id, ...gestion });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/cxc/:ordenId/pago — Registrar pago de una orden CXC
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:ordenId/pago', authenticate, async (req, res) => {
  try {
    const { ordenId } = req.params;
    const { formaPago, cajaId, fechaPago, retencion = 0, numeroFactura } = req.body;

    if (!formaPago || !cajaId) {
      return res.status(400).json({ error: 'formaPago y cajaId son requeridos' });
    }

    const ordenRef = db.collection('orders').doc(ordenId);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();
    if (orden.estado !== 'cxc') {
      return res.status(400).json({ error: 'La orden no está en estado CXC' });
    }

    // Anti-doble-suma: si ya entró a caja, no se cobra de nuevo
    if (orden.dineroEnCaja === true) {
      return res.status(409).json({ error: 'Esta CxC ya fue pagada (no se duplicó).', yaPagada: true });
    }

    const montoRetencion = Number(retencion) || 0;
    const montoAPagar = (orden.total || 0) - montoRetencion;
    const facturaLimpia = numeroFactura ? numeroFactura.trim().toUpperCase() : (orden.numeroFactura || '');

    // 1. Actualizar saldo de caja
    const cajaRef = db.collection('cajas').doc(cajaId);
    const cajaDoc = await cajaRef.get();
    if (!cajaDoc.exists) return res.status(404).json({ error: 'Caja no encontrada' });

    const batch = db.batch();

    batch.update(cajaRef, {
      saldo: admin.firestore.FieldValue.increment(montoAPagar),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2. Cambiar estado de la orden a completada (con candado dineroEnCaja)
    batch.update(ordenRef, {
      estado: 'completada',
      pagado: true,
      montoPagado: orden.total,
      fechaPago: fechaPago || new Date().toISOString(),
      formaPago,
      cajaId,
      numeroFactura: facturaLimpia,
      dineroEnCaja: true,
      dineroEnCajaFecha: new Date().toISOString(),
      dineroEnCajaPor: req.user.email,
      retencionPracticada: montoRetencion,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      historialEstados: admin.firestore.FieldValue.arrayUnion({
        estado: 'completada',
        fecha: new Date().toISOString(),
        usuarioId: req.adminId || req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        nota: `Pago CXC registrado — ${formaPago}${montoRetencion > 0 ? ` — Retención: $${montoRetencion.toLocaleString('es-CO')}` : ''}`
      })
    });

    await batch.commit();

    // 3. Registrar movimiento en caja
    await db.collection('movimientos').add({
      userId: req.adminId || req.user.uid || req.user.id,
      cajaId,
      tipo: 'ingreso',
      concepto: `Pago CXC ${orden.numeroOrden} — ${orden.clienteNombre}`,
      monto: montoAPagar,
      referencia: orden.numeroOrden,
      ordenId,
      formaPago,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Si hay retención → registrar en egresos como CXP categoría Impuestos
    if (montoRetencion > 0) {
      await db.collection('egresos').add({
        userId: req.adminId || req.user.uid || req.user.id,
        concepto: `Retención practicada por ${orden.clienteNombre} — ${orden.numeroOrden}`,
        categoria: 'Retefuente',
        monto: montoRetencion,
        formaPago: 'CXP',
        estado: 'PENDIENTE',
        origen: 'retencion_cxc',
        ordenId,
        numeroOrden: orden.numeroOrden,
        clienteNombre: orden.clienteNombre,
        fecha: fechaPago || new Date().toISOString().split('T')[0],
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await auditar({
      accion: 'PAGO_CXC',
      descripcion: `Pago CXC registrado — ${orden.numeroOrden} — ${orden.clienteNombre} — $${montoAPagar.toLocaleString('es-CO')}`,
      usuarioId: req.adminId || req.user.uid || req.user.id,
      usuarioEmail: req.user.email,
      datos: { ordenId, formaPago, cajaId, montoAPagar, montoRetencion }
    });

    res.json({ ok: true, montoIngresado: montoAPagar, retencion: montoRetencion });
  } catch (e) {
    console.error('POST CXC pago:', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/cxc/config — Leer configuración de bloqueo y alertas
// ══════════════════════════════════════════════════════════════════════════════
router.get('/config', authenticate, async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;
    const doc = await db.collection('configuracion').doc(userId).get();
    const data = doc.exists ? doc.data() : {};
    res.json({
      diasBloqueoCartera: data.diasBloqueoCartera || 30,
      diasAlertaCobranza: data.diasAlertaCobranza || 7,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/cxc/config — Guardar configuración de bloqueo y alertas
// ══════════════════════════════════════════════════════════════════════════════
router.put('/config', authenticate, async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;
    const { diasBloqueoCartera, diasAlertaCobranza } = req.body;
    await db.collection('configuracion').doc(userId).set({
      diasBloqueoCartera: Number(diasBloqueoCartera) || 30,
      diasAlertaCobranza: Number(diasAlertaCobranza) || 7,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// POST /api/cxc/cobrar — Registrar cobranza parcial (CTRL-003)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/cobrar', authenticate, validarTenant('clients'), async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;
    const { clienteId, ordenesCobradas = [], dineroTotal, metodoPago, cambio } = req.body;

    if (!clienteId) return res.status(400).json({ error: 'clienteId requerido' });
    if (!ordenesCobradas || ordenesCobradas.length === 0) return res.status(400).json({ error: 'Selecciona al menos una factura' });
    if (!dineroTotal || dineroTotal <= 0) return res.status(400).json({ error: 'Monto debe ser mayor a 0' });

    // ✅ Validar que cada orden existe y tiene saldo pendiente
    for (const oc of ordenesCobradas) {
      const ordenDoc = await db.collection('orders').doc(oc.ordenId).get();
      if (!ordenDoc.exists) {
        return res.status(404).json({ error: `Orden ${oc.ordenId} no encontrada` });
      }

      const orden = ordenDoc.data();
      if (!orden.cxcSaldo || orden.cxcSaldo <= 0) {
        return res.status(400).json({ error: `Orden ${oc.numeroOrden} no está en CxC o ya está pagada` });
      }

      if (oc.monto > orden.cxcSaldo) {
        return res.status(400).json({ error: `Monto para ${oc.numeroOrden} excede saldo pendiente` });
      }
    }

    // ✅ Registrar cobranza
    const cobroRef = await db.collection('cxc_cobros').add({
      adminId: userId,
      clienteId,
      dineroTotal,
      metodoPago,
      cambio: cambio || 0,
      ordenesCobradas,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      fecha: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ✅ Actualizar CADA orden cobrada
    let saldoTotalPendiente = 0;
    for (const oc of ordenesCobradas) {
      const ordenRef = db.collection('orders').doc(oc.ordenId);
      const ordenDoc = await ordenRef.get();
      const orden = ordenDoc.data();

      const saldoAnterior = orden.cxcSaldo || 0;
      const nuevoSaldo = Math.max(0, saldoAnterior - oc.monto);

      await ordenRef.update({
        cxcSaldo: nuevoSaldo,
        cxcEstado: nuevoSaldo === 0 ? 'pagada' : 'parcial',
        cxcHistorial: admin.firestore.FieldValue.arrayUnion({
          tipo: 'pago',
          monto: oc.monto,
          metodoPago,
          cobroId: cobroRef.id,
          fecha: new Date().toISOString()
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      saldoTotalPendiente += nuevoSaldo;

      // ✅ Registrar dinero en caja
      const cajaRef = db.collection('cajas').doc(orden.cajaId);
      const cajaDoc = await cajaRef.get();
      if (cajaDoc.exists) {
        const caja = cajaDoc.data();
        const saldoNuevo = (caja.saldo || 0) + oc.monto;

        await cajaRef.update({
          saldo: saldoNuevo,
          ultimoIngreso: new Date().toISOString(),
          historialMovimientos: admin.firestore.FieldValue.arrayUnion({
            tipo: 'ingreso_cobranza',
            monto: oc.monto,
            formaPago: metodoPago,
            ordenId: oc.ordenId,
            numeroOrden: oc.numeroOrden,
            clienteId,
            fecha: new Date().toISOString(),
            usuarioNombre: req.user.nombre || req.user.email
          }),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    // ✅ Actualizar CxC cliente
    const cxcRef = db.collection('cxc_clientes').doc(clienteId);
    const cxcDoc = await cxcRef.get();
    const cxcAnterior = cxcDoc?.data() || { ordenes: [] };

    const nuevasOrdenes = cxcAnterior.ordenes.map(o => {
      const ordenCobrada = ordenesCobradas.find(oc => oc.ordenId === o.ordenId);
      if (!ordenCobrada) return o;

      const nuevoSaldo = Math.max(0, (o.saldoPendiente || 0) - ordenCobrada.monto);
      return {
        ...o,
        saldoPendiente: nuevoSaldo,
        cxcEstado: nuevoSaldo === 0 ? 'pagada' : 'parcial'
      };
    });

    await cxcRef.update({
      adminId: userId,
      ordenes: nuevasOrdenes,
      totalPendiente: saldoTotalPendiente,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ✅ Auditoría
    await auditar({
      accion: 'CXC_COBRO_PARCIAL',
      descripcion: `Cobranza: ${ordenesCobradas.length} facturas, total $${dineroTotal}. Saldo cliente: $${saldoTotalPendiente}. Cambio: $${cambio || 0}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioEmail: req.user.email,
      datos: { clienteId, dineroTotal, ordenesCobradas, saldoNuevo: saldoTotalPendiente }
    });

    res.json({
      success: true,
      cobroId: cobroRef.id,
      saldoNuevo: saldoTotalPendiente,
      ordenesCobradas: nuevasOrdenes
    });
  } catch (error) {
    console.error('Error en cobranza parcial:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;