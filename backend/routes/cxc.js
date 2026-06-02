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
    // AISLAMIENTO SAAS: filtrar por adminId (sin orderBy para evitar índice compuesto)
const [snapEstado, snapFormaPago] = await Promise.all([
  db.collection('orders').where('adminId', '==', userId).where('estado', '==', 'cxc').get(),
  db.collection('orders').where('adminId', '==', userId).where('formaPago', '==', 'CXC').where('pagado', '==', false).get(),
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
// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/cxc/cobrar — Cobranza Ola 2.5 Bloque 3 (ampliado)
// ─────────────────────────────────────────────────────────────────────────────
// Ahora soporta los 4 escenarios completos de cobranza:
//   A. Cliente paga TODO (montoAbonado = saldoPendiente)
//   B. Cliente paga SOLO ALGUNAS (frontend filtra ordenesCobradas)
//   C. ABONO PARCIAL (montoAbonado < saldoPendiente)
//   D. Con RETENCIÓN por orden (tipoRetencion + porcentaje + valor calculado)
//
// Body esperado:
// {
//   clienteId, metodoPago, cambio,
//   cajaId,                      ← AHORA viene del request (no de orden.cajaId)
//   ordenesCobradas: [{
//     ordenId, numeroOrden,
//     monto,                     ← cuánto efectivo recibió el mensajero
//     retenciones: [{            ← NUEVO: una o varias retenciones por orden
//       tipoId, etiqueta, porcentaje, base, valor
//     }],
//     retencionTotal             ← suma de las retenciones para esta orden
//   }]
// }
//
// La regla: el SALDO de la orden baja por (monto + retencionTotal).
// El efectivo en caja sube solo por `monto`. La retención se registra como
// egreso categoría "Retefuente" (cuenta por pagar a la DIAN).
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/cobrar', authenticate, validarTenant('clients'), async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;
    const { clienteId, ordenesCobradas = [], dineroTotal, metodoPago, cambio, cajaId } = req.body;

    if (!clienteId) return res.status(400).json({ error: 'clienteId requerido' });
    if (!ordenesCobradas || ordenesCobradas.length === 0) {
      return res.status(400).json({ error: 'Selecciona al menos una factura' });
    }
    if (dineroTotal === undefined || dineroTotal === null) {
      return res.status(400).json({ error: 'dineroTotal requerido' });
    }
    if (!cajaId) return res.status(400).json({ error: 'cajaId requerido' });
    if (!metodoPago) return res.status(400).json({ error: 'metodoPago requerido' });

    // Validar existencia de la caja
    const cajaRef = db.collection('cajas').doc(cajaId);
    const cajaDoc = await cajaRef.get();
    if (!cajaDoc.exists) return res.status(404).json({ error: 'Caja no encontrada' });

    // ── Validaciones por orden ────────────────────────────────────────────────
    for (const oc of ordenesCobradas) {
      const ordenDoc = await db.collection('orders').doc(oc.ordenId).get();
      if (!ordenDoc.exists) {
        return res.status(404).json({ error: `Orden ${oc.numeroOrden || oc.ordenId} no encontrada` });
      }

      const orden = ordenDoc.data();
      const saldo = (orden.cxcSaldo !== undefined ? orden.cxcSaldo : (orden.total - (orden.montoPagado || 0))) || 0;
      if (saldo <= 0) {
        return res.status(400).json({ error: `Orden ${oc.numeroOrden} ya está pagada` });
      }

      const montoEfectivo = Number(oc.monto) || 0;
      const retencionTotal = Number(oc.retencionTotal) || 0;
      const aplicadoTotal = montoEfectivo + retencionTotal;

      if (aplicadoTotal <= 0) {
        return res.status(400).json({ error: `Monto inválido para ${oc.numeroOrden}` });
      }
      if (aplicadoTotal > saldo + 1) { // tolerancia $1 por redondeo
        return res.status(400).json({
          error: `Para ${oc.numeroOrden}: monto + retención ($${aplicadoTotal.toLocaleString('es-CO')}) excede saldo ($${saldo.toLocaleString('es-CO')})`
        });
      }
    }

    // ── Registrar cobranza maestra ────────────────────────────────────────────
    const cobroRef = await db.collection('cxc_cobros').add({
      adminId: userId,
      clienteId,
      dineroTotal,
      metodoPago,
      cambio: cambio || 0,
      cajaId,
      ordenesCobradas,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      fecha: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ── Procesar cada orden ──────────────────────────────────────────────────
    let saldoTotalPendiente = 0;
    let efectivoIngresadoCaja = 0;
    const retencionesGeneradas = [];

    for (const oc of ordenesCobradas) {
      const ordenRef = db.collection('orders').doc(oc.ordenId);
      const ordenDoc = await ordenRef.get();
      const orden = ordenDoc.data();

      const saldoAnterior = (orden.cxcSaldo !== undefined ? orden.cxcSaldo : (orden.total - (orden.montoPagado || 0))) || 0;
      const montoEfectivo = Number(oc.monto) || 0;
      const retencionTotal = Number(oc.retencionTotal) || 0;
      const aplicado = montoEfectivo + retencionTotal;
      const nuevoSaldo = Math.max(0, saldoAnterior - aplicado);

      // Determinar estado nuevo
      const yaPagada = nuevoSaldo === 0;
      const ordenUpdate = {
        cxcSaldo: nuevoSaldo,
        cxcEstado: yaPagada ? 'pagada' : 'parcial',
        montoPagado: admin.firestore.FieldValue.increment(montoEfectivo),
        cxcHistorial: admin.firestore.FieldValue.arrayUnion({
          tipo: yaPagada ? 'pago_total' : 'abono_parcial',
          monto: montoEfectivo,
          retencionTotal,
          retenciones: oc.retenciones || [],
          metodoPago,
          cobroId: cobroRef.id,
          fecha: new Date().toISOString(),
          saldoAnterior, saldoNuevo: nuevoSaldo
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      // Si quedó completamente pagada, marcar completada
      if (yaPagada) {
        ordenUpdate.estado = 'completada';
        ordenUpdate.pagado = true;
        ordenUpdate.fechaPago = new Date().toISOString();
        ordenUpdate.dineroEnCaja = true;
        ordenUpdate.dineroEnCajaFecha = new Date().toISOString();
        ordenUpdate.dineroEnCajaPor = req.user.email;
        ordenUpdate.retencionPracticada = (orden.retencionPracticada || 0) + retencionTotal;
        ordenUpdate.historialEstados = admin.firestore.FieldValue.arrayUnion({
          estado: 'completada',
          fecha: new Date().toISOString(),
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.nombre || req.user.email,
          nota: `Pago CxC final — efectivo $${montoEfectivo.toLocaleString('es-CO')}${retencionTotal > 0 ? ` + retención $${retencionTotal.toLocaleString('es-CO')}` : ''}`
        });
      }

      await ordenRef.update(ordenUpdate);

      saldoTotalPendiente += nuevoSaldo;
      efectivoIngresadoCaja += montoEfectivo;

      // Registrar las retenciones de esta orden como egresos (cuenta por pagar a DIAN)
      for (const r of (oc.retenciones || [])) {
        const valor = Number(r.valor) || 0;
        if (valor <= 0) continue;
        const egresoRef = await db.collection('egresos').add({
          userId,
          numero: 'RET-' + new Date().getTime() + '-' + Math.floor(Math.random() * 100),
          concepto: `${r.etiqueta || 'Retención'} (${r.porcentaje}%) practicada por ${orden.clienteNombre} — ${orden.numeroOrden}`,
          categoria: 'Retefuente',
          tipo: 'retencion',
          subtipo: r.tipoId || '',
          monto: valor,
          base: r.base || 0,
          porcentaje: r.porcentaje || 0,
          estado: 'PENDIENTE',
          clienteId,
          ordenOrigen: oc.ordenId,
          numeroOrdenOrigen: orden.numeroOrden,
          cobroId: cobroRef.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        retencionesGeneradas.push({ id: egresoRef.id, ...r, ordenId: oc.ordenId });
      }
    }

    // ── Una sola operación de caja por todo el cobro ─────────────────────────
    if (efectivoIngresadoCaja > 0) {
      await cajaRef.update({
        saldo: admin.firestore.FieldValue.increment(efectivoIngresadoCaja),
        ultimoIngreso: new Date().toISOString(),
        historialMovimientos: admin.firestore.FieldValue.arrayUnion({
          tipo: 'ingreso_cobranza',
          monto: efectivoIngresadoCaja,
          formaPago: metodoPago,
          cobroId: cobroRef.id,
          clienteId,
          cantidadOrdenes: ordenesCobradas.length,
          fecha: new Date().toISOString(),
          usuarioNombre: req.user.nombre || req.user.email
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Movimiento independiente para reportes
      await db.collection('movimientos').add({
        userId, cajaId,
        tipo: 'ingreso',
        concepto: `Cobranza CxC — Cliente ${clienteId} — ${ordenesCobradas.length} factura(s)`,
        monto: efectivoIngresadoCaja,
        referencia: cobroRef.id,
        formaPago: metodoPago,
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // ── Actualizar CxC cliente ───────────────────────────────────────────────
    const cxcRef = db.collection('cxc_clientes').doc(clienteId);
    const cxcDoc = await cxcRef.get();
    const cxcAnterior = cxcDoc.exists ? cxcDoc.data() : { ordenes: [] };

    const nuevasOrdenes = (cxcAnterior.ordenes || []).map(o => {
      const ordenCobrada = ordenesCobradas.find(oc => oc.ordenId === o.ordenId);
      if (!ordenCobrada) return o;
      const aplicado = (Number(ordenCobrada.monto) || 0) + (Number(ordenCobrada.retencionTotal) || 0);
      const nuevoSaldo = Math.max(0, (o.saldoPendiente || 0) - aplicado);
      return { ...o, saldoPendiente: nuevoSaldo, cxcEstado: nuevoSaldo === 0 ? 'pagada' : 'parcial' };
    });

    await cxcRef.set({
      adminId: userId,
      ordenes: nuevasOrdenes,
      totalPendiente: saldoTotalPendiente,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await auditar({
      accion: 'CXC_COBRO',
      descripcion: `Cobranza: ${ordenesCobradas.length} factura(s), efectivo $${efectivoIngresadoCaja.toLocaleString('es-CO')}, retención $${retencionesGeneradas.reduce((s, r) => s + (Number(r.valor) || 0), 0).toLocaleString('es-CO')}. Saldo restante cliente: $${saldoTotalPendiente.toLocaleString('es-CO')}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioEmail: req.user.email,
      datos: { clienteId, dineroTotal, efectivoIngresadoCaja, ordenesCobradas, retenciones: retencionesGeneradas, saldoNuevo: saldoTotalPendiente }
    });

    res.json({
      success: true,
      cobroId: cobroRef.id,
      efectivoIngresadoCaja,
      retencionesGeneradas,
      saldoNuevo: saldoTotalPendiente,
      ordenesCobradas: nuevasOrdenes
    });
  } catch (error) {
    console.error('Error en cobranza:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/cxc/retenciones-config — Catálogo de tipos de retención del admin
// ─────────────────────────────────────────────────────────────────────────────
// Ola 2.5 Bloque 3: devuelve el catálogo de tipos de retención configurado por
// el admin (4% Renta, 6% Servicios, 15% ReteIVA, etc). Si no hay catálogo,
// devuelve los defaults estándar Colombia.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/retenciones-config', authenticate, async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;
    const doc = await db.collection('configuracion').doc(userId).get();

    const DEFAULTS = [
      { id: 'rte_compras_4',    etiqueta: 'Retención Renta Compras',   porcentaje: 4,    tipo: 'renta',  activo: true },
      { id: 'rte_servicios_6',  etiqueta: 'Retención Renta Servicios', porcentaje: 6,    tipo: 'renta',  activo: true },
      { id: 'rte_iva_15',       etiqueta: 'ReteIVA',                    porcentaje: 15,   tipo: 'iva',    activo: true },
      { id: 'rte_ica_com_07',   etiqueta: 'ReteICA Comercial',          porcentaje: 0.7,  tipo: 'ica',    activo: true },
      { id: 'rte_ica_srv_10',   etiqueta: 'ReteICA Servicios',          porcentaje: 1.0,  tipo: 'ica',    activo: true },
      { id: 'rte_personalizado',etiqueta: 'Personalizado (digitar %)',  porcentaje: null, tipo: 'custom', activo: true },
    ];

    if (!doc.exists) return res.json({ retenciones: DEFAULTS });

    const data = doc.data();
    const retenciones = Array.isArray(data.retenciones) && data.retenciones.length > 0
      ? data.retenciones
      : DEFAULTS;

    res.json({ retenciones });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;