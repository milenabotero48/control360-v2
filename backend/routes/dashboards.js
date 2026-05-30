const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// ═════════════════════════════════════════════════════════════════════════════
// Control360 v2 — Dashboards (Ola 2)
// ─────────────────────────────────────────────────────────────────────────────
// Endpoints agregados por rol. Cada uno hace TODAS las consultas necesarias
// para pintar el dashboard de ese rol en UNA sola llamada HTTP.
//
// Reglas:
//   - Todos los endpoints filtran por adminId (multi-tenant ready).
//   - Las fechas se resuelven en zona horaria Colombia (UTC-5) para no
//     perder registros del último día por diferencia de zona horaria.
//   - Si una consulta falla, el endpoint NO se rompe: devuelve ese KPI en 0
//     y agrega el error en `data.warnings[]`.
// ═════════════════════════════════════════════════════════════════════════════

// ─── HELPERS DE FECHA EN ZONA COLOMBIA ───────────────────────────────────────
// Devuelve { inicioISO, finISO } del día/mes "hoy" en Colombia, expresado
// como rango UTC. Resuelve el bug que tenías antes de filtros por fecha.
const rangoHoyCO = () => {
  const ahora = new Date();
  // Obtener YYYY-MM-DD en zona Colombia
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const hoyCO = fmt.format(ahora); // "2026-05-25"
  return {
    inicioISO: new Date(`${hoyCO}T00:00:00-05:00`).toISOString(),
    finISO:    new Date(`${hoyCO}T23:59:59.999-05:00`).toISOString(),
    fechaCO:   hoyCO
  };
};

const rangoMesCO = () => {
  const ahora = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const hoyCO = fmt.format(ahora);
  const [year, month] = hoyCO.split('-');
  const primerDia = `${year}-${month}-01`;
  const ultimoDia = new Date(Number(year), Number(month), 0).getDate();
  const ultimaFecha = `${year}-${month}-${String(ultimoDia).padStart(2, '0')}`;
  return {
    inicioISO: new Date(`${primerDia}T00:00:00-05:00`).toISOString(),
    finISO:    new Date(`${ultimaFecha}T23:59:59.999-05:00`).toISOString(),
    mesCO:     `${year}-${month}`,
    primerDia, ultimaFecha
  };
};

// Convierte cualquier formato de timestamp Firestore a Date
const aTime = (v) => {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') return new Date(v);
  if (v.toDate) return v.toDate();
  if (v._seconds) return new Date(v._seconds * 1000);
  if (v.seconds) return new Date(v.seconds * 1000);
  return null;
};

const dentroDeRango = (val, inicioISO, finISO) => {
  const t = aTime(val);
  if (!t) return false;
  const ms = t.getTime();
  return ms >= new Date(inicioISO).getTime() && ms <= new Date(finISO).getTime();
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/dashboards/admin
// ─────────────────────────────────────────────────────────────────────────────
// Devuelve 8 KPIs + panel multi-alerta consolidado.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/admin', async (req, res) => {
  const warnings = [];
  const adminId = req.adminId || req.user.uid || req.user.id;

  const hoy = rangoHoyCO();
  const mes = rangoMesCO();

  // ── 1) Órdenes (todo lo que necesitamos para 5 KPIs) ──────────────────────
  let ordenes = [];
  try {
    const snap = await db.collection('orders').where('adminId', '==', adminId).get();
    ordenes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { warnings.push('orders: ' + e.message); }

  // Filtrar órdenes hoy / mes
  const ordenesHoy = ordenes.filter(o => dentroDeRango(o.createdAt, hoy.inicioISO, hoy.finISO));
  const ordenesMes = ordenes.filter(o => dentroDeRango(o.createdAt, mes.inicioISO, mes.finISO));

  // Completadas (vendido)
  const completadasMes = ordenesMes.filter(o =>
    ['completada', 'cuadre_dinero', 'cxc'].includes(o.estado)
  );
  const ventasMes = completadasMes.reduce((s, o) => s + (Number(o.subtotal) || Number(o.total) || 0), 0);

  // Domicilios completados del mes
  const domiciliosMes = completadasMes.filter(o => o.lugarAtencion === 'domicilio').length;

  // Extintores (productos categoría taller) recargados del mes
  let extintoresMes = 0;
  completadasMes.forEach(o => {
    (o.items || []).forEach(it => {
      const cat = (it.categoria || '').toLowerCase();
      if (cat.includes('recarga') || cat.includes('mantenimiento') || cat.includes('hidrost')) {
        extintoresMes += Number(it.cantidad) || 0;
      }
    });
  });

  // En taller
  const enTaller = ordenes.filter(o => o.estado === 'en_taller').length;

  // ── 2) Caja (recaudo hoy y saldo total) ───────────────────────────────────
  let recaudoHoy = 0;
  let totalEnCajas = 0;
  try {
    // Saldo en cajas (filtrado por userId)
    const cajasSnap = await db.collection('cajas').where('userId', '==', adminId).get();
    cajasSnap.forEach(d => { totalEnCajas += Number(d.data().saldo) || 0; });

    // Recaudo de hoy desde movimientos (ingresos del día)
    const movsSnap = await db.collection('movimientos')
      .where('userId', '==', adminId)
      .where('tipo', '==', 'ingreso')
      .get();
    movsSnap.forEach(d => {
      const m = d.data();
      if (dentroDeRango(m.createdAt, hoy.inicioISO, hoy.finISO)) {
        recaudoHoy += Number(m.monto) || 0;
      }
    });
  } catch (e) { warnings.push('cajas: ' + e.message); }

  // ── 3) CxC pendiente ───────────────────────────────────────────────────────
  let cxcPendiente = 0;
  let clientesConMora = 0;
  try {
    const cxcSnap = await db.collection('orders').where('adminId', '==', adminId).get();
    const clientesMora = new Set();
    cxcSnap.forEach(d => {
      const o = d.data();
      const saldo = (Number(o.total) || 0) - (Number(o.montoPagado) || 0);
      if (saldo > 0 && ['completada', 'cuadre_dinero', 'cxc'].includes(o.estado) && o.estado !== 'anulada') {
        cxcPendiente += saldo;
        // Si la orden tiene más de 30 días, es mora (asumiendo política estándar)
        const t = aTime(o.fechaCompletada || o.completadaEn || o.createdAt);
        if (t && (Date.now() - t.getTime()) > 30 * 24 * 3600 * 1000) {
          clientesMora.add(o.clienteId || o.clienteNombre);
        }
      }
    });
    clientesConMora = clientesMora.size;
  } catch (e) { warnings.push('cxc: ' + e.message); }

  // ── 4) Egresos del mes (gastos operativos del mes) ────────────────────────
  let egresosMes = 0;
  let provisionalesPendientes = 0;
  try {
    const egSnap = await db.collection('egresos').where('userId', '==', adminId).get();
    egSnap.forEach(d => {
      const e = d.data();
      if (e.estado === 'PAGADO' && dentroDeRango(e.pagadoEn || e.createdAt, mes.inicioISO, mes.finISO)) {
        egresosMes += Number(e.totalPagar || e.monto) || 0;
      }
      if (e.tipo === 'provisional' && e.cuadrado === false) {
        provisionalesPendientes++;
      }
    });
  } catch (e) { warnings.push('egresos: ' + e.message); }

  // ── 5) Mensajeros activos hoy (con órdenes asignadas en curso) ────────────
  let mensajerosActivos = 0;
  try {
    const enRuta = ordenes.filter(o =>
      ['en_ruta_recogida', 'en_ruta_entrega', 'despacho'].includes(o.estado) && o.mensajeroId
    );
    mensajerosActivos = new Set(enRuta.map(o => o.mensajeroId)).size;
  } catch (e) { warnings.push('mensajeros: ' + e.message); }

  // ── 6) Stock crítico (productos por debajo del mínimo) ────────────────────
  let stockCritico = 0;
  let productosStockCritico = [];
  try {
    const prodSnap = await db.collection('products').where('adminId', '==', adminId).get();
    prodSnap.forEach(d => {
      const p = d.data();
      const min = Number(p.stockMinimo) || 0;
      const stock = Number(p.stock) || 0;
      if (min > 0 && stock <= min) {
        stockCritico++;
        productosStockCritico.push({ id: d.id, nombre: p.nombre, stock, stockMinimo: min });
      }
    });
  } catch (e) {
    // Si no hay adminId en products (BD vieja), fallback sin filtro
    try {
      const prodSnap = await db.collection('products').get();
      prodSnap.forEach(d => {
        const p = d.data();
        const min = Number(p.stockMinimo) || 0;
        const stock = Number(p.stock) || 0;
        if (min > 0 && stock <= min) {
          stockCritico++;
          productosStockCritico.push({ id: d.id, nombre: p.nombre, stock, stockMinimo: min });
        }
      });
    } catch (e2) { warnings.push('productos: ' + e2.message); }
  }
  productosStockCritico = productosStockCritico.slice(0, 5);

  // ── 7) Utilidad del mes (ventas − egresos del mes) ────────────────────────
  const utilidadMes = ventasMes - egresosMes;

  // ── 8) Alertas consolidadas ───────────────────────────────────────────────
  const alertas = [];
  if (clientesConMora > 0)         alertas.push({ tipo: 'cartera', nivel: 'critico', mensaje: `${clientesConMora} cliente(s) con mora > 30 días`, modulo: 'cxc' });
  if (provisionalesPendientes > 0) alertas.push({ tipo: 'provisional', nivel: 'advertencia', mensaje: `${provisionalesPendientes} egreso(s) provisional(es) sin cuadrar`, modulo: 'egresos' });
  if (stockCritico > 0)            alertas.push({ tipo: 'stock', nivel: 'advertencia', mensaje: `${stockCritico} producto(s) en stock crítico`, modulo: 'productos' });
  if (enTaller > 10)               alertas.push({ tipo: 'taller', nivel: 'info', mensaje: `${enTaller} órdenes en taller (revisar capacidad)`, modulo: 'taller' });

  // ── Órdenes recientes para la sección de actividad ────────────────────────
  const ordenesRecientes = ordenes
    .sort((a, b) => (aTime(b.createdAt)?.getTime() || 0) - (aTime(a.createdAt)?.getTime() || 0))
    .slice(0, 8)
    .map(o => ({
      id: o.id,
      numeroOrden: o.numeroOrden,
      clienteNombre: o.clienteNombre,
      estado: o.estado,
      lugarAtencion: o.lugarAtencion,
      total: o.total,
      createdAt: o.createdAt
    }));

  res.json({
    fechaCO: hoy.fechaCO,
    mesCO: mes.mesCO,
    kpis: {
      ordenesHoy:           ordenesHoy.length,
      recaudoHoy,
      totalEnCajas,
      enTaller,
      mensajerosActivos,
      stockCritico,
      cxcPendiente,
      egresosMes,
      ventasMes,
      domiciliosMes,
      extintoresMes,
      utilidadMes,
      clientesConMora,
      provisionalesPendientes
    },
    alertas,
    productosStockCritico,
    ordenesRecientes,
    warnings
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/dashboards/tesoreria
// ─────────────────────────────────────────────────────────────────────────────
router.get('/tesoreria', async (req, res) => {
  const warnings = [];
  const adminId = req.adminId || req.user.uid || req.user.id;
  const hoy = rangoHoyCO();
  const mes = rangoMesCO();

  // Saldo por caja
  let cajas = [];
  let totalEnCajas = 0;
  try {
    const snap = await db.collection('cajas').where('userId', '==', adminId).get();
    snap.forEach(d => {
      const c = { id: d.id, ...d.data() };
      cajas.push(c);
      totalEnCajas += Number(c.saldo) || 0;
    });
  } catch (e) { warnings.push('cajas: ' + e.message); }

  // Movimientos del mes (ingresos / egresos)
  let ingresosMes = 0, egresosMesMovs = 0;
  try {
    const snap = await db.collection('movimientos').where('userId', '==', adminId).get();
    snap.forEach(d => {
      const m = d.data();
      if (dentroDeRango(m.createdAt, mes.inicioISO, mes.finISO)) {
        if (m.tipo === 'ingreso') ingresosMes += Number(m.monto) || 0;
        if (m.tipo === 'egreso')  egresosMesMovs += Number(m.monto) || 0;
      }
    });
  } catch (e) { warnings.push('movimientos: ' + e.message); }
  const utilidadMes = ingresosMes - egresosMesMovs;

  // CxC pendiente (agrupado por cliente)
  let cxcPendiente = 0;
  let clientesConDeuda = 0;
  let topDeudores = [];
  try {
    const snap = await db.collection('orders').where('adminId', '==', adminId).get();
    const deudaPorCliente = {};
    snap.forEach(d => {
      const o = d.data();
      const saldo = (Number(o.total) || 0) - (Number(o.montoPagado) || 0);
      if (saldo > 0 && ['completada', 'cuadre_dinero', 'cxc'].includes(o.estado)) {
        cxcPendiente += saldo;
        const k = o.clienteNombre || 'Sin nombre';
        deudaPorCliente[k] = (deudaPorCliente[k] || 0) + saldo;
      }
    });
    clientesConDeuda = Object.keys(deudaPorCliente).length;
    topDeudores = Object.entries(deudaPorCliente)
      .map(([nombre, saldo]) => ({ nombre, saldo }))
      .sort((a, b) => b.saldo - a.saldo)
      .slice(0, 5);
  } catch (e) { warnings.push('cxc: ' + e.message); }

  // Egresos pendientes (por pagar)
  let egresosPorPagar = 0;
  let countEgresosPendientes = 0;
  let provisionalesPendientes = 0;
  try {
    const snap = await db.collection('egresos').where('userId', '==', adminId).get();
    snap.forEach(d => {
      const e = d.data();
      if (e.estado === 'PENDIENTE') {
        egresosPorPagar += Number(e.totalPagar || e.monto) || 0;
        countEgresosPendientes++;
      }
      if (e.tipo === 'provisional' && e.cuadrado === false) {
        provisionalesPendientes++;
      }
    });
  } catch (e) { warnings.push('egresos: ' + e.message); }

  // Órdenes pendientes de facturar (estado facturado, en cobranza, etc.)
  let pendientesFacturar = 0;
  let pagosElectronicosSinValidar = 0;
  try {
    const snap = await db.collection('orders').where('adminId', '==', adminId).get();
    snap.forEach(d => {
      const o = d.data();
      if (['facturado', 'entrega_cobranza'].includes(o.estado)) pendientesFacturar++;
      if (o.formaPago && o.formaPago !== 'Efectivo' && !o.pagoValidado &&
          (o.estado === 'cuadre_dinero' || o.estado === 'entrega_cobranza')) {
        pagosElectronicosSinValidar++;
      }
    });
  } catch (e) { warnings.push('orders: ' + e.message); }

  res.json({
    fechaCO: hoy.fechaCO,
    mesCO: mes.mesCO,
    kpis: {
      totalEnCajas, ingresosMes, egresosMes: egresosMesMovs, utilidadMes,
      cxcPendiente, clientesConDeuda,
      egresosPorPagar, countEgresosPendientes,
      pendientesFacturar, pagosElectronicosSinValidar,
      provisionalesPendientes
    },
    cajas,
    topDeudores,
    warnings
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/dashboards/mensajero/:mensajeroId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/mensajero/:mensajeroId', async (req, res) => {
  const warnings = [];
  const { mensajeroId } = req.params;
  const hoy = rangoHoyCO();
  const mes = rangoMesCO();

  let ordenes = [];
  try {
    const snap = await db.collection('orders').where('mensajeroId', '==', mensajeroId).get();
    ordenes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { warnings.push('orders: ' + e.message); }

  // Ruta de hoy (asignadas y no cerradas)
  const rutaHoy = ordenes.filter(o =>
    ['programada', 'en_ruta_recogida', 'despacho', 'en_ruta_entrega', 'entrega_cobranza'].includes(o.estado)
  );

  // Entregadas hoy
  const entregadasHoy = ordenes.filter(o => {
    const t = aTime(o.fechaCompletada || o.completadaEn);
    return t && dentroDeRango(o.fechaCompletada || o.completadaEn, hoy.inicioISO, hoy.finISO);
  });

  // Histórico del mes
  const entregadasMes = ordenes.filter(o => {
    const t = aTime(o.fechaCompletada || o.completadaEn);
    return t && dentroDeRango(o.fechaCompletada || o.completadaEn, mes.inicioISO, mes.finISO);
  });

  // Cobro pendiente del día (órdenes con saldo y asignadas)
  let cobroPendienteHoy = 0;
  rutaHoy.forEach(o => {
    const saldo = (Number(o.total) || 0) - (Number(o.montoPagado) || 0);
    if (saldo > 0) cobroPendienteHoy += saldo;
  });

  // Fotos pendientes (entregadas pero sin foto de evidencia)
  let fotosPendientes = 0;
  entregadasHoy.forEach(o => {
    if (!o.fotoEntrega) fotosPendientes++;
  });

  // Cuadres recientes (últimos 7 días)
  let cuadresRecientes = [];
  try {
    const cuadresSnap = await db.collection('cuadres_caja')
      .where('mensajeroId', '==', mensajeroId)
      .get();
    cuadresRecientes = cuadresSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (aTime(b.fecha)?.getTime() || 0) - (aTime(a.fecha)?.getTime() || 0))
      .slice(0, 5);
  } catch (e) { warnings.push('cuadres: ' + e.message); }

  res.json({
    fechaCO: hoy.fechaCO,
    kpis: {
      ordenesRutaHoy: rutaHoy.length,
      entregadasHoy: entregadasHoy.length,
      entregadasMes: entregadasMes.length,
      cobroPendienteHoy,
      fotosPendientes
    },
    rutaHoy: rutaHoy.map(o => ({
      id: o.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
      estado: o.estado, lugarAtencion: o.lugarAtencion, total: o.total,
      direccion: o.sucursalDireccion || o.clienteDireccion
    })),
    cuadresRecientes,
    warnings
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/dashboards/taller
// ─────────────────────────────────────────────────────────────────────────────
router.get('/taller', async (req, res) => {
  const warnings = [];
  const adminId = req.adminId || req.user.uid || req.user.id;
  const hoy = rangoHoyCO();

  let ordenes = [];
  try {
    const snap = await db.collection('orders').where('adminId', '==', adminId).get();
    ordenes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { warnings.push('orders: ' + e.message); }

  const enTaller = ordenes.filter(o => o.estado === 'en_taller');
  const completadasHoy = ordenes.filter(o => {
    const t = aTime(o.fechaCompletada || o.completadaEn);
    return t && o.estado !== 'anulada' && dentroDeRango(o.fechaCompletada || o.completadaEn, hoy.inicioISO, hoy.finISO);
  });

  // Equipos atendidos hoy (suma de cantidades de items de taller en completadas)
  let equiposHoy = 0;
  completadasHoy.forEach(o => {
    (o.items || []).forEach(it => {
      const cat = (it.categoria || '').toLowerCase();
      if (cat.includes('recarga') || cat.includes('mantenimiento') || cat.includes('hidrost')) {
        equiposHoy += Number(it.cantidad) || 0;
      }
    });
  });

  // Órdenes >48h en taller (críticas)
  const ahora = Date.now();
  const ordenesCriticas = enTaller.filter(o => {
    const t = aTime(o.fechaEnTaller || o.createdAt);
    if (!t) return false;
    return (ahora - t.getTime()) > 48 * 3600 * 1000;
  });

  // Insumos en stock crítico (workshop_insumos)
  let insumosCriticos = [];
  try {
    const snap = await db.collection('workshop_insumos').where('adminId', '==', adminId).get();
    snap.forEach(d => {
      const i = { id: d.id, ...d.data() };
      const stock = Number(i.stock) || 0;
      const min = Number(i.stockMinimo) || 0;
      if (min > 0 && stock <= min) insumosCriticos.push(i);
    });
  } catch (e) { warnings.push('insumos: ' + e.message); }

  // Configuración de meta diaria
  let metaDiaria = 0;
  try {
    const cfg = await db.collection('workshop_config').doc(adminId).get();
    if (cfg.exists) metaDiaria = Number(cfg.data().metaDiaria) || 0;
  } catch {}

  res.json({
    fechaCO: hoy.fechaCO,
    kpis: {
      enTaller: enTaller.length,
      completadasHoy: completadasHoy.length,
      equiposHoy,
      ordenesCriticas: ordenesCriticas.length,
      insumosCriticos: insumosCriticos.length,
      metaDiaria
    },
    colaTaller: enTaller.slice(0, 20).map(o => ({
      id: o.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
      fechaEnTaller: o.fechaEnTaller, items: (o.items || []).length
    })),
    ordenesCriticas: ordenesCriticas.map(o => ({
      id: o.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
      fechaEnTaller: o.fechaEnTaller
    })),
    insumosCriticos: insumosCriticos.slice(0, 10),
    warnings
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/dashboards/comercial/:comercialId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/comercial/:comercialId', async (req, res) => {
  const warnings = [];
  const { comercialId } = req.params;
  const adminId = req.adminId || req.user.uid || req.user.id;
  const mes = rangoMesCO();

  let ordenes = [];
  try {
    const snap = await db.collection('orders').where('adminId', '==', adminId).get();
    ordenes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(o => o.creadoPorId === comercialId || o.comercialId === comercialId);
  } catch (e) { warnings.push('orders: ' + e.message); }

  // Vendido mes (completadas)
  const completadasMes = ordenes.filter(o =>
    ['completada', 'cuadre_dinero', 'cxc'].includes(o.estado) &&
    dentroDeRango(o.fechaCompletada || o.completadaEn || o.createdAt, mes.inicioISO, mes.finISO)
  );
  const vendidoMes = completadasMes.reduce((s, o) => s + (Number(o.subtotal) || Number(o.total) || 0), 0);

  // Cotizaciones del mes
  let cotizacionesMes = [];
  let cotizadoMes = 0;
  let cotizacionesAprobadas = 0;
  try {
    const snap = await db.collection('cotizaciones').get();
    cotizacionesMes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(c => (c.creadoPorId === comercialId || c.comercialId === comercialId) &&
        dentroDeRango(c.createdAt, mes.inicioISO, mes.finISO));
    cotizadoMes = cotizacionesMes.reduce((s, c) => s + (Number(c.totales?.total) || 0), 0);
    cotizacionesAprobadas = cotizacionesMes.filter(c => c.estado === 'aprobada' || c.estado === 'convertida').length;
  } catch (e) { warnings.push('cotizaciones: ' + e.message); }

  // CxC propio (clientes que él vendió y tienen saldo)
  let cxcPropio = 0;
  ordenes.forEach(o => {
    const saldo = (Number(o.total) || 0) - (Number(o.montoPagado) || 0);
    if (saldo > 0 && ['completada', 'cuadre_dinero', 'cxc'].includes(o.estado)) {
      cxcPropio += saldo;
    }
  });

  // Tasa de conversión
  const tasaConversion = cotizacionesMes.length > 0
    ? (cotizacionesAprobadas / cotizacionesMes.length * 100).toFixed(1)
    : 0;

  res.json({
    mesCO: mes.mesCO,
    kpis: {
      vendidoMes,
      cotizadoMes,
      ordenesCreadas: ordenes.filter(o => dentroDeRango(o.createdAt, mes.inicioISO, mes.finISO)).length,
      cotizacionesCreadas: cotizacionesMes.length,
      cotizacionesAprobadas,
      tasaConversion: Number(tasaConversion),
      cxcPropio
    },
    warnings
  });
});

module.exports = router;
