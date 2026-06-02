// ════════════════════════════════════════════════════════════════════════════════
// REPORTES OPERATIVOS — Ola 3 Bloque 2
// ─────────────────────────────────────────────────────────────────────────────
// 4 endpoints de agregación para evaluar al equipo y la operación:
//
//   GET /api/reportes/mensajero?desde=&hasta=&usuarioId=
//   GET /api/reportes/comercial?desde=&hasta=&usuarioId=
//   GET /api/reportes/taller?desde=&hasta=
//   GET /api/reportes/general?desde=&hasta=
//
// Todos los reportes leen `orders` con campo `adminId` (aprendido del fix ERI).
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();

// ── HELPERS ──────────────────────────────────────────────────────────────────
const parseFecha = (raw) => {
  if (!raw) return null;
  if (raw._seconds) return new Date(raw._seconds * 1000);
  if (raw.toDate)   return raw.toDate();
  return new Date(raw);
};

const fechaInicioCO = (yyyymmdd) => yyyymmdd ? new Date(`${yyyymmdd}T00:00:00.000-05:00`) : null;
const fechaFinCO    = (yyyymmdd) => yyyymmdd ? new Date(`${yyyymmdd}T23:59:59.999-05:00`) : null;

// Diferencia en HORAS entre 2 fechas
const horas = (d1, d2) => {
  if (!d1 || !d2) return 0;
  return (d2.getTime() - d1.getTime()) / (1000 * 60 * 60);
};

// Estado legible
const labelEstado = (e) => ({
  programada: 'Programada', en_ruta_recogida: 'En Ruta Recogida',
  en_taller: 'En Taller', taller_proceso: 'Taller en Proceso',
  facturado: 'Facturado', despacho: 'Despacho',
  en_ruta_entrega: 'En Ruta Entrega', entrega_cobranza: 'Entrega/Cobranza',
  cuadre_dinero: 'Cuadre Dinero', completada: 'Completada', anulada: 'Anulada'
}[e] || e);

// ─────────────────────────────────────────────────────────────────────────────
// CARGADOR COMÚN: trae órdenes del admin en rango
// ─────────────────────────────────────────────────────────────────────────────
const cargarOrdenes = async (adminId, desde, hasta, filtros = {}) => {
  let query = db.collection('orders').where('adminId', '==', adminId);
  if (filtros.empresaId) query = query.where('empresaId', '==', filtros.empresaId);
  const snap = await query.get();

  const desdeDate = fechaInicioCO(desde);
  const hastaDate = fechaFinCO(hasta);

  const ordenes = [];
  snap.forEach(d => {
    const o = { id: d.id, ...d.data() };
    // Ola 3 Bloque 2: cascada de fechas para considerar la orden en el rango.
    // - fechaCompletada: campo nuevo escrito al cerrar la orden (preferido)
    // - fechaPago: cuando se marcó pagada
    // - fechaFactura: cuando se facturó
    // - updatedAt: última modificación (fallback más robusto)
    // - createdAt: cuando se creó (último fallback)
    const fechaRef = parseFecha(o.fechaCompletada || o.fechaPago || o.fechaFactura || o.updatedAt || o.createdAt);
    if (!fechaRef) return;
    if (desdeDate && fechaRef < desdeDate) return;
    if (hastaDate && fechaRef > hastaDate) return;
    o._fechaRef = fechaRef;
    ordenes.push(o);
  });
  return ordenes;
};

// ─────────────────────────────────────────────────────────────────────────────
// REPORTE 1: MENSAJERO
// ─────────────────────────────────────────────────────────────────────────────
router.get('/mensajero', async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid;
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });

    const { desde, hasta, usuarioId = '', empresaId = '' } = req.query;

    // 1. Cargar mensajeros del admin
    // Ola 3 Bloque 2: los users se guardan con `creadoPor` (uid del admin), no `adminId`.
    let usersSnap = await db.collection('users')
      .where('creadoPor', '==', adminId)
      .where('role', '==', 'mensajero')
      .get();
    let mensajeros = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Sin fallback sin filtro — si no hay mensajeros con creadoPor,
    // simplemente no hay mensajeros para este admin (sistema aislado)
    if (mensajeros.length === 0) {
      return res.json({ mensajeros: [], resumen: {} });
    }

    // 2. Cargar órdenes en rango (excluir anuladas e internas)
    const ordenes = (await cargarOrdenes(adminId, desde, hasta, { empresaId }))
      .filter(o => o.estado !== 'anulada' && o.tipoOrden !== 'interna' && o.tipoOrden !== 'produccion');

    // 3. Cargar préstamos del admin
    const prestSnap = await db.collection('extintores_prestamo')
      .where('adminId', '==', adminId).get().catch(() => ({ docs: [] }));
    const prestamos = prestSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // 4. Cargar alertas de cuadre del admin
    const alertasSnap = await db.collection('alertas_tesoreria')
      .where('adminId', '==', adminId).get().catch(() => ({ docs: [] }));
    const alertas = alertasSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // 5. Para cada mensajero, calcular KPIs
    const reporte = mensajeros
      .filter(m => !usuarioId || m.id === usuarioId)
      .map(m => calcularKPIsMensajero(m, ordenes, prestamos, alertas));

    res.json({
      meta: { desde, hasta, totalMensajeros: mensajeros.length },
      mensajeros: reporte
    });
  } catch (e) {
    console.error('GET /reportes/mensajero:', e);
    res.status(500).json({ error: e.message });
  }
});

const calcularKPIsMensajero = (mensajero, ordenes, prestamos, alertas) => {
  const ordsDel = ordenes.filter(o => o.mensajeroId === mensajero.id || o.trabajadorAsignadoId === mensajero.id);
  const completadas = ordsDel.filter(o => o.estado === 'completada' || o.estado === 'cuadre_dinero');
  const totalAsig = ordsDel.length;

  // Tasa completitud
  const tasaCompletitud = totalAsig > 0 ? (completadas.length / totalAsig) * 100 : 0;

  // Tiempo total promedio (desde creación hasta completada)
  let totalHoras = 0; let cntTiempo = 0;
  completadas.forEach(o => {
    const ini = parseFecha(o.createdAt);
    const fin = parseFecha(o.fechaCompletada) || parseFecha(o.fechaPago) || parseFecha(o.completedAt) || parseFecha(o.updatedAt) || o._fechaRef;
    if (ini && fin) { totalHoras += horas(ini, fin); cntTiempo++; }
  });
  const tiempoPromedioHoras = cntTiempo > 0 ? totalHoras / cntTiempo : 0;

  // Tiempo por estado (analizar historialEstados)
  const tiempoPorEstado = {};   // estado → { sumaHoras, count }
  ordsDel.forEach(o => {
    const hist = o.historialEstados || [];
    for (let i = 0; i < hist.length - 1; i++) {
      const desde = parseFecha(hist[i].fecha);
      const hasta = parseFecha(hist[i + 1].fecha);
      if (!desde || !hasta) continue;
      const est = hist[i].estado;
      if (!tiempoPorEstado[est]) tiempoPorEstado[est] = { sumaHoras: 0, count: 0 };
      tiempoPorEstado[est].sumaHoras += horas(desde, hasta);
      tiempoPorEstado[est].count++;
    }
  });
  const tiempoEstados = Object.entries(tiempoPorEstado).map(([est, d]) => ({
    estado: est, label: labelEstado(est),
    promedioHoras: d.count > 0 ? d.sumaHoras / d.count : 0,
    cantidad: d.count
  })).sort((a, b) => b.promedioHoras - a.promedioHoras);

  // Calidad — fotos
  const conFotoRecogida = ordsDel.filter(o => o.fotoRecogida).length;
  const conFotoEntrega  = ordsDel.filter(o => o.fotoEntrega).length;
  const pagosVirtuales  = ordsDel.filter(o =>
    o.pagado && o.formaPago && !/efectivo|crédito|credito|cxc/i.test(o.formaPago)
  );
  const virtualesConFoto = pagosVirtuales.filter(o => o.fotoTransferencia).length;
  const sinFoto = ordsDel.filter(o =>
    (o.estado === 'completada' || o.estado === 'entrega_cobranza' || o.estado === 'cuadre_dinero')
    && !o.fotoEntrega
  );

  // Cuadre dinero
  let totalRecaudado = 0;
  ordsDel.forEach(o => {
    if (o.pagado && o.cobradoPorMensajero) totalRecaudado += Number(o.total) || 0;
  });
  const alertasMens = alertas.filter(a => a.mensajeroId === mensajero.id);
  const alertasAbiertas = alertasMens.filter(a => a.estado === 'abierta').length;
  const alertasCuadradas = alertasMens.filter(a => a.estado === 'cuadrada');
  const totalCuadrado = alertasCuadradas.reduce((s, a) => s + (a.montoCuadrado || 0), 0);
  const faltanteHistorico = alertasCuadradas.reduce((s, a) => s + (a.faltante || 0), 0);
  const sobranteHistorico = alertasCuadradas.reduce((s, a) => s + (a.sobrante || 0), 0);

  // Tiempo promedio cobro→cuadre
  let totalHorasCuadre = 0; let cntCuadre = 0;
  alertasCuadradas.forEach(a => {
    const ini = parseFecha(a.createdAt || a.fechaApertura);
    const fin = parseFecha(a.fechaCuadre);
    if (ini && fin) { totalHorasCuadre += horas(ini, fin); cntCuadre++; }
  });
  const horasPromedioCuadre = cntCuadre > 0 ? totalHorasCuadre / cntCuadre : 0;

  // Préstamos
  const prestsMens = prestamos.filter(p => p.mensajeroId === mensajero.id);
  const ahora = new Date();
  const prestPend30 = prestsMens.filter(p => {
    if (p.estado !== 'prestado') return false;
    const fSalida = parseFecha(p.fechaSalida);
    if (!fSalida) return false;
    return (ahora - fSalida) / (1000 * 60 * 60 * 24) > 30;
  });

  return {
    id: mensajero.id,
    nombre: mensajero.nombre || mensajero.email,
    eficiencia: {
      asignadas: totalAsig,
      completadas: completadas.length,
      tasaCompletitud,
      tiempoPromedioHoras,
      tiempoPorEstado: tiempoEstados
    },
    fotos: {
      ordenesTotal: ordsDel.length,
      pctRecogida: ordsDel.length > 0 ? (conFotoRecogida / ordsDel.length) * 100 : 0,
      pctEntrega:  ordsDel.length > 0 ? (conFotoEntrega  / ordsDel.length) * 100 : 0,
      pagosVirtuales: pagosVirtuales.length,
      virtualesConFoto,
      pctComprobante: pagosVirtuales.length > 0 ? (virtualesConFoto / pagosVirtuales.length) * 100 : 100,
      sinFotoCantidad: sinFoto.length,
      alertaSinFoto: sinFoto.length >= 3
    },
    dinero: {
      totalRecaudado,
      totalCuadrado,
      faltanteHistorico,
      sobranteHistorico,
      alertasAbiertas,
      horasPromedioCuadre
    },
    prestamos: {
      total: prestsMens.length,
      entregados: prestsMens.filter(p => p.estado === 'prestado').length,
      recogidos:  prestsMens.filter(p => p.estado === 'devuelto').length,
      pendientes30: prestPend30.length
    }
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// REPORTE 2: COMERCIAL
// ─────────────────────────────────────────────────────────────────────────────
router.get('/comercial', async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid;
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    const { desde, hasta, usuarioId = '', empresaId = '' } = req.query;

    // 1. Comerciales del admin (creadoPor con fallback)
    let usersSnap = await db.collection('users')
      .where('creadoPor', '==', adminId)
      .where('role', '==', 'comercial')
      .get();
    let comerciales = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Sin fallback sin filtro — sistema aislado por tenant
    if (comerciales.length === 0) {
      return res.json({ comerciales: [], ranking: [] });
    }

    // 2. Órdenes del rango
    const ordenes = (await cargarOrdenes(adminId, desde, hasta, { empresaId }))
      .filter(o => o.estado !== 'anulada' && o.tipoOrden !== 'interna' && o.tipoOrden !== 'produccion');

    // 3. Cotizaciones del rango
    const cotsSnap = await db.collection('quotations')
      .where('adminId', '==', adminId).get().catch(() => ({ docs: [] }));
    const cotizaciones = cotsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => {
      const f = parseFecha(c.createdAt || c.fecha);
      if (!f) return false;
      if (fechaInicioCO(desde) && f < fechaInicioCO(desde)) return false;
      if (fechaFinCO(hasta) && f > fechaFinCO(hasta)) return false;
      return true;
    });

    const reporte = comerciales
      .filter(c => !usuarioId || c.id === usuarioId)
      .map(c => calcularKPIsComercial(c, ordenes, cotizaciones));

    // Ranking ordenado por total facturado
    const ranking = [...reporte].sort((a, b) => b.totalFacturado - a.totalFacturado);

    res.json({
      meta: { desde, hasta, totalComerciales: comerciales.length },
      ranking, comerciales: reporte
    });
  } catch (e) {
    console.error('GET /reportes/comercial:', e);
    res.status(500).json({ error: e.message });
  }
});

const calcularKPIsComercial = (com, ordenes, cotizaciones) => {
  const misOrds = ordenes.filter(o => o.creadoPor === com.id);
  const misCots = cotizaciones.filter(c => (c.creadoPor === com.id) || (c.usuarioId === com.id));

  const cotsAprob = misCots.filter(c => c.estado === 'aprobada' || c.estado === 'convertida');
  const tasaConversion = misCots.length > 0 ? (cotsAprob.length / misCots.length) * 100 : 0;

  const totalFacturado = misOrds.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const ticketPromedio = misOrds.length > 0 ? totalFacturado / misOrds.length : 0;

  // Pagadas vs CxC eterno
  const pagadas = misOrds.filter(o => o.pagado).length;
  const pctPagadas = misOrds.length > 0 ? (pagadas / misOrds.length) * 100 : 0;

  // Top 5 clientes
  const porCliente = {};
  misOrds.forEach(o => {
    const k = o.clienteId || o.clienteNombre || 'sin_cliente';
    if (!porCliente[k]) porCliente[k] = { clienteId: o.clienteId, nombre: o.clienteNombre, ordenes: 0, total: 0 };
    porCliente[k].ordenes++;
    porCliente[k].total += Number(o.total) || 0;
  });
  const topClientes = Object.values(porCliente).sort((a, b) => b.total - a.total).slice(0, 5);

  return {
    id: com.id,
    nombre: com.nombre || com.email,
    cotizacionesCreadas: misCots.length,
    cotizacionesAprobadas: cotsAprob.length,
    tasaConversion,
    ordenesCreadas: misOrds.length,
    totalFacturado,
    ticketPromedio,
    ordenesPagadas: pagadas,
    pctPagadas,
    topClientes
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// REPORTE 3: TALLER (conectado con ERI para costo promedio)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/taller', async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid;
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    const { desde, hasta, empresaId = '' } = req.query;

    // 1. Órdenes que pasaron por taller en el rango
    const todas = await cargarOrdenes(adminId, desde, hasta, { empresaId });
    const pasaronTaller = todas.filter(o =>
      o.estado !== 'anulada' && o.tipoOrden !== 'interna'
      && (o.items || []).some(it => /recarga|mantenimiento|hidrost/i.test(it.categoria || it.nombre || ''))
    );

    // 2. QRs procesados (cuenta de equipos)
    // Ola 3 Bloque 2: la colección correcta es `qr_equipos` (no qr_codes).
    const qrsSnap = await db.collection('qr_equipos')
      .where('adminId', '==', adminId).get().catch(() => ({ docs: [] }));
    const qrs = qrsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(q => {
      const f = parseFecha(q.fechaUltimaRecarga || q.createdAt);
      if (!f) return false;
      if (fechaInicioCO(desde) && f < fechaInicioCO(desde)) return false;
      if (fechaFinCO(hasta) && f > fechaFinCO(hasta)) return false;
      return true;
    });

    // 3. Tiempo en taller
    let totalHorasTaller = 0; let cntT = 0;
    const atorados3d = [];
    const ahora = new Date();
    pasaronTaller.forEach(o => {
      const hist = o.historialEstados || [];
      const entradaTaller = hist.find(h => h.estado === 'en_taller');
      const salidaTaller = hist.find(h => h.estado === 'facturado' || h.estado === 'despacho');
      if (entradaTaller && salidaTaller) {
        const t = horas(parseFecha(entradaTaller.fecha), parseFecha(salidaTaller.fecha));
        if (t > 0) { totalHorasTaller += t; cntT++; }
      } else if (entradaTaller && (o.estado === 'en_taller' || o.estado === 'taller_proceso')) {
        // Sin salida → sigue atorada
        const t = horas(parseFecha(entradaTaller.fecha), ahora);
        if (t > 72) atorados3d.push({ id: o.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre, horas: t });
      }
    });

    // 4. Insumos consumidos (egresos categoria costo_servicio)
    const egSnap = await db.collection('egresos')
      .where('userId', '==', adminId).get().catch(() => ({ docs: [] }));
    // Filtrar PAGADOS en rango con costo_servicio
    const configDoc = await db.collection('configuracion').doc(adminId).get();
    const config = configDoc.exists ? configDoc.data() : {};
    const categsMap = {};
    (config.categoriasEgresos || []).forEach(c => { categsMap[c.nombre] = c; });

    const insumos = [];
    let totalCostoInsumos = 0;
    egSnap.docs.forEach(d => {
      const e = d.data();
      if (e.estado !== 'PAGADO') return;
      if (e.tipo === 'retencion') return;
      const f = parseFecha(e.fechaPago || e.fecha);
      if (!f) return;
      if (fechaInicioCO(desde) && f < fechaInicioCO(desde)) return;
      if (fechaFinCO(hasta) && f > fechaFinCO(hasta)) return;
      const cat = categsMap[e.categoria];
      if (cat && cat.tipoERI === 'costo_servicio') {
        insumos.push({ ...e, _fecha: f });
        totalCostoInsumos += Number(e.monto) || 0;
      }
    });

    // 5. Equipos por tipo de servicio
    const porTipoServicio = { recarga: 0, mantenimiento: 0, hidrostatica: 0, otros: 0 };
    qrs.forEach(q => {
      const t = (q.tipoIntervencion || '').toLowerCase();
      if (/recarga/.test(t)) porTipoServicio.recarga++;
      else if (/mantenim/.test(t)) porTipoServicio.mantenimiento++;
      else if (/hidrostat/.test(t)) porTipoServicio.hidrostatica++;
      else porTipoServicio.otros++;
    });

    res.json({
      meta: { desde, hasta },
      volumen: {
        ordenesEnTaller: pasaronTaller.length,
        equiposProcesados: qrs.length,
        porTipoServicio
      },
      eficiencia: {
        tiempoPromedioHoras: cntT > 0 ? totalHorasTaller / cntT : 0,
        tiempoPromedioDias: cntT > 0 ? (totalHorasTaller / cntT) / 24 : 0,
        ordenesAtoradas: atorados3d.length,
        atoradosDetalle: atorados3d
      },
      costos: {
        totalCostoInsumos,
        costoPromedioPorEquipo: qrs.length > 0 ? totalCostoInsumos / qrs.length : 0,
        cantidadInsumos: insumos.length
      }
    });
  } catch (e) {
    console.error('GET /reportes/taller:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORTE 4: OPERACIÓN GENERAL
// ─────────────────────────────────────────────────────────────────────────────
router.get('/general', async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid;
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    const { desde, hasta, empresaId = '' } = req.query;

    // 1. TODAS las órdenes del admin (sin rango — para embudo)
    let q = db.collection('orders').where('adminId', '==', adminId);
    if (empresaId) q = q.where('empresaId', '==', empresaId);
    const snap = await q.get();
    const todas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // 2. Embudo: cuántas en cada estado AHORA
    const embudo = {};
    todas.forEach(o => {
      if (o.tipoOrden === 'interna' || o.tipoOrden === 'produccion') return;
      const est = o.estado || 'sin_estado';
      embudo[est] = (embudo[est] || 0) + 1;
    });
    const embudoArr = Object.entries(embudo).map(([est, cnt]) => ({
      estado: est, label: labelEstado(est), cantidad: cnt
    })).sort((a, b) => b.cantidad - a.cantidad);

    // 3. Órdenes en rango (para tiempos por estado + anuladas + perdidas)
    const desdeDate = fechaInicioCO(desde);
    const hastaDate = fechaFinCO(hasta);
    const enRango = todas.filter(o => {
      const f = parseFecha(o.createdAt);
      if (!f) return false;
      if (desdeDate && f < desdeDate) return false;
      if (hastaDate && f > hastaDate) return false;
      return true;
    });

    // 4. Tiempos por estado (en rango)
    const tiempos = {};
    enRango.forEach(o => {
      if (o.tipoOrden === 'interna' || o.tipoOrden === 'produccion' || o.estado === 'anulada') return;
      const hist = o.historialEstados || [];
      for (let i = 0; i < hist.length - 1; i++) {
        const di = parseFecha(hist[i].fecha);
        const df = parseFecha(hist[i + 1].fecha);
        if (!di || !df) continue;
        const est = hist[i].estado;
        if (!tiempos[est]) tiempos[est] = { suma: 0, count: 0 };
        tiempos[est].suma += horas(di, df);
        tiempos[est].count++;
      }
    });
    const tiemposEstado = Object.entries(tiempos).map(([est, d]) => ({
      estado: est, label: labelEstado(est),
      promedioHoras: d.count > 0 ? d.suma / d.count : 0,
      cantidad: d.count
    })).sort((a, b) => b.promedioHoras - a.promedioHoras);

    // 5. Órdenes "perdidas" >7 días sin movimiento
    const ahora = new Date();
    const perdidas = todas.filter(o => {
      if (['completada', 'anulada', 'cuadre_dinero'].includes(o.estado)) return false;
      if (o.tipoOrden === 'interna' || o.tipoOrden === 'produccion') return false;
      const last = parseFecha(o.updatedAt) || parseFecha(o.createdAt);
      if (!last) return false;
      return (ahora - last) / (1000 * 60 * 60 * 24) > 7;
    }).map(o => ({
      id: o.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
      estado: o.estado, dias: Math.round((ahora - (parseFecha(o.updatedAt) || parseFecha(o.createdAt))) / (1000 * 60 * 60 * 24))
    })).sort((a, b) => b.dias - a.dias);

    // 6. Anuladas en rango
    const anuladas = enRango.filter(o => o.estado === 'anulada').map(o => ({
      id: o.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
      motivoAnulacion: o.motivoAnulacion || '—',
      fecha: parseFecha(o.fechaAnulacion || o.updatedAt)
    }));

    // 7. CxC en mora (todas, no solo rango — son saldos abiertos)
    const cxcSnap = await db.collection('cxc')
      .where('adminId', '==', adminId).get().catch(() => ({ docs: [] }));
    const cxcMora = cxcSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => {
      if (c.estado !== 'pendiente') return false;
      const venc = parseFecha(c.fechaVencimiento);
      if (!venc) return false;
      return venc < ahora;
    }).map(c => ({
      ...c, diasMora: Math.round((ahora - parseFecha(c.fechaVencimiento)) / (1000 * 60 * 60 * 24))
    })).sort((a, b) => b.diasMora - a.diasMora);

    // 8. Top clientes por ingreso (todas las órdenes pagadas del rango)
    const porCli = {};
    enRango.forEach(o => {
      if (o.tipoOrden === 'interna' || o.tipoOrden === 'produccion' || o.estado === 'anulada') return;
      const k = o.clienteId || o.clienteNombre || 'sin_cliente';
      if (!porCli[k]) porCli[k] = { id: k, nombre: o.clienteNombre, ordenes: 0, total: 0 };
      porCli[k].ordenes++;
      porCli[k].total += Number(o.total) || 0;
    });
    const topPorIngreso = Object.values(porCli).sort((a, b) => b.total - a.total).slice(0, 10);
    const topPorCantidad = Object.values(porCli).sort((a, b) => b.ordenes - a.ordenes).slice(0, 10);

    // 9. Clientes fugados >13 meses (servicio anual)
    const clientsSnap = await db.collection('clients')
      .where('adminId', '==', adminId).get().catch(() => ({ docs: [] }));
    const clientes = clientsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const limite13m = new Date(ahora.getTime() - (13 * 30 * 24 * 60 * 60 * 1000));
    const fugados = clientes.map(c => {
      // Última orden del cliente
      const susOrds = todas.filter(o => o.clienteId === c.id && o.estado !== 'anulada');
      if (susOrds.length === 0) return null;
      const ultima = susOrds.reduce((m, o) => {
        const f = parseFecha(o.createdAt);
        return (!m || f > m._fecha) ? { ...o, _fecha: f } : m;
      }, null);
      if (!ultima || !ultima._fecha) return null;
      if (ultima._fecha > limite13m) return null;
      const dias = Math.round((ahora - ultima._fecha) / (1000 * 60 * 60 * 24));
      return {
        id: c.id, nombre: c.nombre,
        celular: c.celular,
        ultimaCompraFecha: ultima._fecha.toISOString(),
        diasSinComprar: dias,
        meses: Math.round(dias / 30 * 10) / 10
      };
    }).filter(Boolean).sort((a, b) => b.diasSinComprar - a.diasSinComprar);

    res.json({
      meta: { desde, hasta },
      embudo: embudoArr,
      tiemposEstado,
      perdidas,
      anuladas,
      cxcMora,
      topPorIngreso,
      topPorCantidad,
      fugados
    });
  } catch (e) {
    console.error('GET /reportes/general:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
