const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { authenticate, validarTenant } = require('../middleware/auth');

const registrarAuditoria = async (datos) => {
  try {
    await db.collection('audit_logs').add({
      ...datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// VISIBILIDAD DE SALDOS BANCARIOS (Ola 3 — regla de negocio)
// ───────────────────────────────────────────────────────────────────────────────
// Los saldos de cuentas bancarias son información sensible: SOLO el admin los
// ve. Los demás usuarios con módulo Caja siguen viendo y usando las cuentas
// de banco en selectores (pueden digitar egresos pagados con banco), pero el
// saldo viaja en null desde el backend — no es un ocultamiento de pantalla.
// El efectivo sí es visible para quien tenga el módulo Caja.
// ═══════════════════════════════════════════════════════════════════════════════
const ROLES_VEN_SALDO_BANCO = ['admin'];

const esCajaBanco = (caja) => (caja?.tipo || '').toLowerCase().includes('banco');

const ocultarSaldosBancarios = (cajas, role) => {
  if (ROLES_VEN_SALDO_BANCO.includes(role)) return cajas;
  return cajas.map(c => esCajaBanco(c)
    ? { ...c, saldo: null, saldoReservado: true }
    : c);
};

// ─── GET /api/cajas ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection('cajas')
      .where('userId', '==', req.adminId || req.user.uid)
      .get();
    const cajas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    cajas.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    res.json(cajas);
  } catch (e) {
    console.error('GET cajas:', e);
    res.status(500).json({ error: 'Error al obtener cajas', detalle: e.message });
  }
});

// ─── POST /api/cajas ──────────────────────────────────────────────────────────
router.post('/', authenticate, validarTenant('cajas'), async (req, res) => {
  try {
    const { nombre, tipo, saldo, responsable, banco, numeroCuenta, notas } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'Nombre requerido' });

    const nueva = {
      userId: req.adminId || req.user.uid,
      nombre: nombre.trim(),
      tipo: tipo || 'Efectivo',
      saldo: Number(saldo) || 0,
      responsable: responsable || '',
      banco: banco || '',
      numeroCuenta: numeroCuenta || '',
      notas: notas || '',
      activa: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('cajas').add(nueva);

    if (Number(saldo) > 0) {
      await db.collection('movimientos').add({
        userId: req.adminId || req.user.uid,
        cajaId: ref.id,
        tipo: 'ingreso',
        concepto: 'Saldo inicial',
        monto: Number(saldo),
        referencia: 'APERTURA',
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await registrarAuditoria({
      accion: 'CAJA_CREADA', modulo: 'cajas',
      descripcion: `Caja "${nombre}" creada con saldo inicial ${saldo}`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email
    });

    res.status(201).json({ id: ref.id, ...nueva });
  } catch (e) {
    console.error('POST cajas:', e);
    res.status(500).json({ error: 'Error al crear caja' });
  }
});

// ─── PUT /api/cajas/:id ───────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const ref = db.collection('cajas').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Caja no encontrada' });

    const update = { ...req.body, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (update.saldo !== undefined) update.saldo = Number(update.saldo);
    delete update.userId;

    await ref.update(update);

    await registrarAuditoria({
      accion: 'CAJA_EDITADA', modulo: 'cajas',
      descripcion: `Caja "${doc.data().nombre}" editada`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      datos: update
    });

    res.json({ id: req.params.id, ...doc.data(), ...update });
  } catch (e) {
    console.error('PUT cajas:', e);
    res.status(500).json({ error: 'Error al actualizar caja' });
  }
});

// ─── DELETE /api/cajas/:id ────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const ref = db.collection('cajas').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Caja no encontrada' });

    const caja = doc.data();

    if (Number(caja.saldo) > 0) {
      return res.status(400).json({
        error: `Esta caja tiene ${caja.saldo} en saldo. Traslada el dinero antes de desactivarla.`
      });
    }

    const movSnap = await db.collection('movimientos')
      .where('cajaId', '==', req.params.id)
      .limit(1).get();

    if (!movSnap.empty) {
      await ref.update({ activa: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await registrarAuditoria({
        accion: 'CAJA_DESACTIVADA', modulo: 'cajas',
        descripcion: `Caja "${caja.nombre}" desactivada (tiene movimientos)`,
        usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email
      });
      return res.json({ ok: true, accion: 'desactivada', mensaje: 'Caja desactivada. Historial conservado.' });
    }

    await ref.delete();
    await registrarAuditoria({
      accion: 'CAJA_ELIMINADA', modulo: 'cajas',
      descripcion: `Caja "${caja.nombre}" eliminada físicamente (sin movimientos)`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email
    });
    res.json({ ok: true, accion: 'eliminada', mensaje: 'Caja eliminada correctamente.' });
  } catch (e) {
    console.error('DELETE cajas:', e);
    res.status(500).json({ error: 'Error al eliminar caja' });
  }
});

// ─── POST /api/cajas/traslado ─────────────────────────────────────────────────
router.post('/traslado', async (req, res) => {
  try {
    const { cajaOrigenId, cajaDestinoId, monto, concepto } = req.body;
    if (!cajaOrigenId || !cajaDestinoId) return res.status(400).json({ error: 'Origen y destino requeridos' });
    if (!monto || Number(monto) <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (cajaOrigenId === cajaDestinoId) return res.status(400).json({ error: 'Origen y destino iguales' });

    const [origenDoc, destinoDoc] = await Promise.all([
      db.collection('cajas').doc(cajaOrigenId).get(),
      db.collection('cajas').doc(cajaDestinoId).get()
    ]);

    if (!origenDoc.exists || !destinoDoc.exists) return res.status(404).json({ error: 'Caja no encontrada' });

    const origen = origenDoc.data();
    const destino = destinoDoc.data();
    const montoNum = Number(monto);

    if (Number(origen.saldo) < montoNum) {
      return res.status(400).json({ error: `Saldo insuficiente. Disponible: ${origen.saldo}` });
    }

    const batch = db.batch();
    batch.update(db.collection('cajas').doc(cajaOrigenId), {
      saldo: Number(origen.saldo) - montoNum,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    batch.update(db.collection('cajas').doc(cajaDestinoId), {
      saldo: Number(destino.saldo) + montoNum,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await batch.commit();

    const grupoId = `TRL-${Date.now()}`;
    const ts = admin.firestore.FieldValue.serverTimestamp();
    const base = { userId: req.adminId || req.user.uid, monto: montoNum, concepto: concepto || `Traslado ${origen.nombre} → ${destino.nombre}`, grupoTraslado: grupoId, creadoPor: req.user.email, createdAt: ts };

    await Promise.all([
      db.collection('movimientos').add({ ...base, tipo: 'traslado_salida', cajaId: cajaOrigenId, cajaDestinoId }),
      db.collection('movimientos').add({ ...base, tipo: 'traslado_entrada', cajaId: cajaDestinoId, cajaOrigenId })
    ]);

    await registrarAuditoria({
      accion: 'TRASLADO_CAJAS', modulo: 'cajas',
      descripcion: `Traslado $${montoNum} de "${origen.nombre}" a "${destino.nombre}"`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      datos: { cajaOrigenId, cajaDestinoId, monto: montoNum, concepto }
    });

    res.json({ ok: true, grupoId, saldoOrigen: Number(origen.saldo) - montoNum, saldoDestino: Number(destino.saldo) + montoNum });
  } catch (e) {
    console.error('POST traslado:', e);
    res.status(500).json({ error: 'Error en traslado' });
  }
});

// ─── GET /api/cajas/movimientos/todos ─────────────────────────────────────────
router.get('/movimientos/todos', async (req, res) => {
  try {
    const snap = await db.collection('movimientos')
      .where('userId', '==', req.adminId || req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) {
    console.error('GET movimientos:', e);
    try {
      const snap2 = await db.collection('movimientos')
        .where('userId', '==', req.adminId || req.user.uid)
        .limit(200)
        .get();
      const docs = snap2.docs.map(d => ({ id: d.id, ...d.data() }));
      docs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      res.json(docs);
    } catch (e2) {
      res.status(500).json({ error: 'Error al obtener movimientos' });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/cajas/cierre-diario?fecha=YYYY-MM-DD  (Ola 3 — Cuadre diario)
// ───────────────────────────────────────────────────────────────────────────────
// Consolidado COMBINADO de todas las cajas del suscriptor para un día
// (horario Colombia). La continuidad de saldos es matemática, no un dato
// suelto: saldoFinalDía = saldoActual − movimientosPosteriores, y
// saldoInicialDía = saldoFinalDía − netoDelDía. Así el saldo inicial de hoy
// SIEMPRE es exactamente el saldo final de ayer.
// Acceso: admin y tesorería. Si no es admin, los saldos de cuentas de banco
// viajan reservados (regla: saldos bancarios solo admin) aunque los
// movimientos del día sí se reportan.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/cierre-diario', async (req, res) => {
  try {
    const role = req.user?.role;
    // Ola 3 (ajuste): el cuadre lo genera cualquier usuario con acceso al
    // módulo Caja (regla de negocio: quien opera la caja cierra su día).
    // La protección de lo sensible no está aquí sino abajo: los saldos de
    // cuentas bancarias SOLO viajan para el admin — para todos los demás
    // salen reservados, en pantalla y en el documento impreso.
    const userId = req.adminId || req.user.uid;
    const fecha = (req.query.fecha || '').trim() || new Date(Date.now() - 5 * 3600000).toISOString().split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ error: 'Fecha inválida. Formato: YYYY-MM-DD' });
    }
    // Ventana del día en horario Colombia (UTC-5)
    const iniDia = Date.parse(`${fecha}T05:00:00.000Z`);
    const finDia = iniDia + 24 * 3600000;

    const msDe = (x) => {
      if (!x) return 0;
      if (typeof x.toMillis === 'function') return x.toMillis();
      if (x.seconds) return x.seconds * 1000;
      const t = Date.parse(x);
      return isNaN(t) ? 0 : t;
    };
    const horaCO = (ms) => new Date(ms).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
    const esEntrada = (t) => ['ingreso', 'traslado_entrada'].includes(t);

    // ── Cargar datos del tenant (filtros de fecha EN MEMORIA — regla del
    //    proyecto: sin índices compuestos) ──────────────────────────────────
    const [snapCajas, snapMovs, snapOrders, snapEgresos] = await Promise.all([
      db.collection('cajas').where('userId', '==', userId).get(),
      db.collection('movimientos').where('userId', '==', userId).limit(5000).get(),
      db.collection('orders').where('adminId', '==', userId).limit(4000).get(),
      db.collection('egresos').where('userId', '==', userId).limit(3000).get(),
    ]);

    const cajas = snapCajas.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.activa !== false);
    const movs = snapMovs.docs.map(d => ({ id: d.id, ...d.data(), _ms: 0 }))
      .map(m => ({ ...m, _ms: msDe(m.createdAt) || msDe(m.fecha) }));

    // ── Saldos por caja con continuidad matemática ────────────────────────
    const cajasReporte = cajas.map(c => {
      const movsCaja = movs.filter(m => m.cajaId === c.id);
      const neto = (lista) => lista.reduce((a, m) => a + (esEntrada(m.tipo) ? 1 : -1) * (Number(m.monto) || 0), 0);

      const movsDia = movsCaja.filter(m => m._ms >= iniDia && m._ms < finDia);
      const movsPosteriores = movsCaja.filter(m => m._ms >= finDia);

      const saldoFinalDia = (Number(c.saldo) || 0) - neto(movsPosteriores);
      const netoDia = neto(movsDia);
      const saldoInicialDia = saldoFinalDia - netoDia; // = saldo final del día anterior

      const suma = (tipos) => movsDia.filter(m => tipos.includes(m.tipo)).reduce((a, m) => a + (Number(m.monto) || 0), 0);

      return {
        id: c.id, nombre: c.nombre, tipo: c.tipo || 'Efectivo',
        responsable: c.responsable || '',
        esBanco: esCajaBanco(c),
        saldoInicial: saldoInicialDia,
        ingresos: suma(['ingreso']),
        egresos: suma(['egreso']),
        trasladosEntrada: suma(['traslado_entrada']),
        trasladosSalida: suma(['traslado_salida']),
        saldoFinal: saldoFinalDia,
        movimientosDia: movsDia.length,
      };
    });

    // ── Detalle de movimientos del día (todas las cajas) ──────────────────
    const nombreCaja = (id) => (cajas.find(c => c.id === id)?.nombre) || '—';
    const movimientosDia = movs
      .filter(m => m._ms >= iniDia && m._ms < finDia)
      .sort((a, b) => a._ms - b._ms)
      .map(m => ({
        hora: horaCO(m._ms), caja: nombreCaja(m.cajaId), tipo: m.tipo,
        concepto: m.concepto || '', referencia: m.referencia || '',
        creadoPor: m.creadoPor || '', monto: Number(m.monto) || 0,
        entrada: esEntrada(m.tipo),
      }));

    // ── CxC del día ───────────────────────────────────────────────────────
    const ordersData = snapOrders.docs.map(d => ({ id: d.id, ...d.data() }));
    const pasoACxCHoy = (o) => (o.historialEstados || []).some(h => h.estado === 'cxc' && msDe(h.fecha) >= iniDia && msDe(h.fecha) < finDia);
    const cxcNuevas = ordersData.filter(pasoACxCHoy).map(o => ({
      numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre || '',
      monto: (Number(o.total) || 0) - (Number(o.montoPagado) || 0) || (Number(o.total) || 0),
    }));
    const tuvoCxC = (o) => (o.historialEstados || []).some(h => h.estado === 'cxc');
    const cxcCobradas = ordersData
      .filter(o => tuvoCxC(o) && o.pagado && msDe(o.fechaPago) >= iniDia && msDe(o.fechaPago) < finDia)
      .map(o => ({ numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre || '', monto: Number(o.montoPagado) || Number(o.total) || 0 }));

    // ── CxP / Egresos del día ─────────────────────────────────────────────
    const egresosData = snapEgresos.docs.map(d => ({ id: d.id, ...d.data() }));
    const totalEgreso = (e) => Number(e.totalPagar) || Number(e.monto) || 0;
    const cxpNuevas = egresosData
      .filter(e => e.estado === 'PENDIENTE' && msDe(e.fecha || e.createdAt) >= iniDia && msDe(e.fecha || e.createdAt) < finDia)
      .map(e => ({ numero: e.numero || e.id, proveedor: e.proveedor || '', concepto: e.concepto || e.categoria || '', monto: totalEgreso(e) }));
    const egresosPagadosHoy = egresosData
      .filter(e => e.estado === 'PAGADO' && msDe(e.fechaPago || e.fecha) >= iniDia && msDe(e.fechaPago || e.fecha) < finDia)
      .map(e => ({ numero: e.numero || e.id, proveedor: e.proveedor || '', concepto: e.concepto || e.categoria || '', formaPago: e.formaPago || '', monto: totalEgreso(e) }));

    // ── Reserva de saldos bancarios para no-admin ─────────────────────────
    const esAdminRol = ROLES_VEN_SALDO_BANCO.includes(role);
    const cajasFinal = cajasReporte.map(c => (!esAdminRol && c.esBanco)
      ? { ...c, saldoInicial: null, saldoFinal: null, saldoReservado: true }
      : c);

    const sumar = (arr, k) => arr.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const cajasVisibles = cajasFinal.filter(c => c.saldoInicial !== null);

    res.json({
      fecha,
      generadoPor: req.user.nombre || req.user.email,
      generadoEn: new Date().toISOString(),
      rol: role,
      cajas: cajasFinal,
      totales: {
        saldoInicial: sumar(cajasVisibles, 'saldoInicial'),
        ingresos: sumar(cajasFinal, 'ingresos'),
        egresos: sumar(cajasFinal, 'egresos'),
        saldoFinal: sumar(cajasVisibles, 'saldoFinal'),
        saldosReservados: cajasFinal.some(c => c.saldoReservado),
      },
      movimientosDia,
      cxc: { nuevas: cxcNuevas, totalNuevas: sumar(cxcNuevas, 'monto'), cobradas: cxcCobradas, totalCobradas: sumar(cxcCobradas, 'monto') },
      cxp: { nuevas: cxpNuevas, totalNuevas: sumar(cxpNuevas, 'monto'), pagadasHoy: egresosPagadosHoy, totalPagadasHoy: sumar(egresosPagadosHoy, 'monto') },
    });
  } catch (e) {
    console.error('GET cierre-diario:', e);
    res.status(500).json({ error: 'Error generando el cuadre diario', detalle: e.message });
  }
});

// ─── GET /api/cajas/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection('cajas').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Caja no encontrada' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener caja' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/cajas/ingresos — CTRL-005
// CRÍTICO: Cuando ingresa dinero, marca orden como PAGADA
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/ingresos', authenticate, validarTenant('cajas'), async (req, res) => {
  try {
    const { cajaId, concepto, monto, metodoPago, ordenIds = [], mensajeroId, comprobante } = req.body;
    
    if (!cajaId) return res.status(400).json({ error: 'Caja requerida' });
    if (!monto || Number(monto) <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!metodoPago) return res.status(400).json({ error: 'Método de pago requerido' });
    
    const cajaDoc = await db.collection('cajas').doc(cajaId).get();
    if (!cajaDoc.exists) return res.status(404).json({ error: 'Caja no encontrada' });
    
    const montoNum = Number(monto);
    
    let ordenesActualizadas = [];
    if (ordenIds && ordenIds.length > 0) {
      const batch = db.batch();
      
      for (const ordenId of ordenIds) {
        const ordenDoc = await db.collection('orders').doc(ordenId).get();
        if (!ordenDoc.exists) continue;
        
        const orden = ordenDoc.data();
        
        if (orden.adminId !== (req.adminId || req.user.uid)) {
          return res.status(403).json({ error: 'No tienes acceso a esa orden' });
        }
        
        let estadoPago = 'PAGADA';
        let comprobantePago = null;
        
        if (metodoPago === 'TRANSFERENCIA') {
          estadoPago = 'PAGADA_PENDIENTE_VERIFICACION';
          comprobantePago = comprobante || null;
        }
        
        batch.update(db.collection('orders').doc(ordenId), {
          cxcSaldo: 0,
          cxcEstado: estadoPago,
          fechaPago: admin.firestore.FieldValue.serverTimestamp(),
          metodoPago,
          comprobantePago,
          pagadoPor: req.user.email,
          pagadoPorId: req.adminId || req.user.uid
        });
        
        ordenesActualizadas.push({
          ordenId,
          numero: orden.numero || orden.numeroOrden,
          estado: estadoPago
        });
      }
      
      await batch.commit();
    }
    
    const referencia = ordenIds?.length > 0 
      ? `RECAUDO-${ordenIds.join(',')}\n${metodoPago}`
      : concepto;
    
    const movimiento = {
      userId: req.adminId || req.user.uid,
      adminId: req.adminId || req.user.uid,
      cajaId,
      tipo: 'ingreso',
      concepto: concepto || 'Ingreso cliente',
      monto: montoNum,
      metodoPago,
      referencia,
      ordenIds: ordenIds || [],
      mensajeroId: mensajeroId || null,
      comprobante: comprobante || null,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const movRef = await db.collection('movimientos').add(movimiento);
    
    const nuevoSaldo = Number(cajaDoc.data().saldo) + montoNum;
    await db.collection('cajas').doc(cajaId).update({
      saldo: nuevoSaldo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await registrarAuditoria({
      accion: 'INGRESO_CAJA',
      modulo: 'cajas',
      descripcion: `Ingreso $${montoNum} (${metodoPago}) - ${ordenesActualizadas.length} órdenes pagadas`,
      usuarioId: req.adminId || req.user.uid,
      usuarioNombre: req.user.email,
      datos: { cajaId, monto: montoNum, metodoPago, ordenesActualizadas, mensajeroId }
    });
    
    res.status(201).json({
      ok: true,
      movimientoId: movRef.id,
      nuevoSaldo,
      ordenesActualizadas,
      mensaje: `Ingreso registrado. ${ordenesActualizadas.length} órdenes marcadas como pagadas`
    });
    
  } catch (e) {
    console.error('POST ingresos error:', e);
    res.status(500).json({ error: 'Error al registrar ingreso', detalle: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/cajas/movimientos/exportar — CTRL-005
// Exporta SOLO las fechas seleccionadas (no 3 años de histórico)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/movimientos/exportar', authenticate, async (req, res) => {
  try {
    const { fechaDesde, fechaHasta, cajaId } = req.query;
    
    if (!fechaDesde || !fechaHasta) {
      return res.status(400).json({ error: 'fechaDesde y fechaHasta requeridas' });
    }
    
    const desde = new Date(fechaDesde);
    const hasta = new Date(fechaHasta);
    hasta.setHours(23, 59, 59, 999);
    
    if (desde > hasta) {
      return res.status(400).json({ error: 'fechaDesde no puede ser mayor a fechaHasta' });
    }
    
    let query = db.collection('movimientos')
      .where('userId', '==', req.adminId || req.user.uid);
    
    if (cajaId) {
      query = query.where('cajaId', '==', cajaId);
    }
    
    const snap = await query.get();
    
    const movimientos = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(m => {
        const fecha = m.createdAt?.toDate?.() || new Date(m.createdAt);
        return fecha >= desde && fecha <= hasta;
      })
      .sort((a, b) => {
        const fechaA = a.createdAt?.toDate?.() || new Date(a.createdAt);
        const fechaB = b.createdAt?.toDate?.() || new Date(b.createdAt);
        return fechaB - fechaA;
      });
    
    if (movimientos.length === 0) {
      return res.json({
        ok: true,
        movimientos: [],
        totalRegistros: 0,
        totalMonto: 0,
        periodo: `${fechaDesde} a ${fechaHasta}`
      });
    }
    
    const totalMonto = movimientos.reduce((sum, m) => {
      const cantidad = Number(m.monto) || 0;
      return m.tipo === 'ingreso' ? sum + cantidad : sum - cantidad;
    }, 0);
    
    const datosExportar = movimientos.map(m => ({
      FECHA: m.createdAt?.toDate?.()?.toLocaleDateString() || new Date(m.createdAt).toLocaleDateString(),
      CONCEPTO: m.concepto,
      CAJA: m.cajaId,
      TIPO: m.tipo,
      MONTO: m.monto,
      REFERENCIA: m.referencia || '',
      'MÉTODO PAGO': m.metodoPago || '',
      'ORDEN IDS': m.ordenIds?.join(',') || '',
      'CREADO POR': m.creadoPor
    }));
    
    res.json({
      ok: true,
      movimientos: datosExportar,
      totalRegistros: movimientos.length,
      totalMonto,
      periodo: `${fechaDesde} a ${fechaHasta}`,
      descargaDisponible: true
    });
    
  } catch (e) {
    console.error('GET exportar error:', e);
    res.status(500).json({ error: 'Error al exportar', detalle: e.message });
  }
});

module.exports = router;