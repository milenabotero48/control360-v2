// ════════════════════════════════════════════════════════════════════════════════
// alertas.js — Ola 3 Bloque 3: Alertas Inteligentes
// ─────────────────────────────────────────────────────────────────────────────
// Detecta automáticamente 6 tipos de problemas operacionales y los expone como
// "alertas" que el admin, tesorería, etc. ven en su dashboard según rol.
//
// Tipos de alerta:
//
//   🔴 FOTOS_FALTANTES   (crítica)  - mensajero con ≥3 órdenes sin foto
//   🔴 TALLER_ATORADO    (crítica)  - orden >3 días en taller sin avance
//   🟡 PAGO_PENDIENTE    (importante) - pago virtual sin validar >24h
//   🟡 PRESTAMO_VIEJO    (importante) - extintor préstamo >30 días en cliente
//   🟡 CXC_VENCIDO       (importante) - factura en mora >15 días
//   🟢 CLIENTE_FUGANDOSE (informativa) - cliente 11+ meses sin comprar (antes de los 13)
//
// Endpoints:
//   GET  /api/alertas          — todas las alertas activas (filtradas por rol)
//   POST /api/alertas/:id/leer — marcar una alerta como leída
//   POST /api/alertas/:id/resolver — marcar como resuelta (oculta de la lista)
// ════════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();
const {
  resolverAdminId, hoyEnCO, parseFecha,
  horasEntre, diasEntre, log
} = require('./_helpers');

// ─── CONFIG: umbrales (después estos van a configuracion para personalizar) ──
const UMBRALES = {
  FOTOS_FALTANTES_MIN: 3,         // ≥3 órdenes sin foto = bandera roja
  TALLER_ATORADO_DIAS: 3,          // >3 días en taller sin movimiento
  PAGO_PENDIENTE_HORAS: 24,        // >24h sin validar pago virtual
  PRESTAMO_DIAS: 30,               // >30 días sin devolver préstamo
  CXC_DIAS_MORA: 15,               // >15 días vencido
  CLIENTE_FUGANDOSE_MESES: 11,     // 11 meses sin comprar (ciclo anual es 13)
  CLIENTE_FUGADO_MESES: 13,        // ya pasados 13 meses = fugado (no entra a alertas, va a reportes)
};

// ── PRIORIDAD POR TIPO (para ordenar) ──
const PRIORIDAD = {
  FOTOS_FALTANTES: 'critica',
  TALLER_ATORADO:  'critica',
  PAGO_PENDIENTE:  'importante',
  PRESTAMO_VIEJO:  'importante',
  CXC_VENCIDO:     'importante',
  CLIENTE_FUGANDOSE: 'informativa'
};

// ── ROLES QUE VEN CADA TIPO ──
const ROLES_DESTINO = {
  FOTOS_FALTANTES: ['admin'],
  TALLER_ATORADO:  ['admin', 'taller'],
  PAGO_PENDIENTE:  ['admin', 'tesoreria'],
  PRESTAMO_VIEJO:  ['admin'],
  CXC_VENCIDO:     ['admin', 'tesoreria'],
  CLIENTE_FUGANDOSE: ['admin', 'comercial']
};

// ────────────────────────────────────────────────────────────────────────────
// DETECTORES — cada uno devuelve array de alertas detectadas (sin guardar)
// ────────────────────────────────────────────────────────────────────────────

// 🔴 FOTOS_FALTANTES — mensajeros con ≥3 órdenes sin foto de entrega
const detectarFotosFaltantes = async (adminId) => {
  const alertas = [];
  try {
    // Buscar órdenes completadas SIN foto de entrega
    const snap = await db.collection('orders').where('adminId', '==', adminId).get();
    const sinFoto = {};   // mensajeroId → [ordenes]
    snap.forEach(d => {
      const o = d.data();
      if (o.estado !== 'completada' && o.estado !== 'cuadre_dinero') return;
      if (o.estado === 'anulada') return;
      if (o.fotoEntrega) return;
      if (!o.mensajeroId) return;
      if (!sinFoto[o.mensajeroId]) sinFoto[o.mensajeroId] = [];
      sinFoto[o.mensajeroId].push({ id: d.id, ...o });
    });

    for (const [mensajeroId, ords] of Object.entries(sinFoto)) {
      if (ords.length >= UMBRALES.FOTOS_FALTANTES_MIN) {
        alertas.push({
          tipo: 'FOTOS_FALTANTES',
          prioridad: PRIORIDAD.FOTOS_FALTANTES,
          rolesDestino: ROLES_DESTINO.FOTOS_FALTANTES,
          referenciaId: mensajeroId,
          titulo: `${ords[0].mensajeroNombre || 'Mensajero'} con ${ords.length} órdenes sin foto`,
          descripcion: `Posibles descargos formales. Verifica las últimas entregas.`,
          datos: {
            mensajeroId,
            mensajeroNombre: ords[0].mensajeroNombre || '',
            cantidadOrdenes: ords.length,
            ordenesEjemplo: ords.slice(0, 5).map(o => ({
              id: o.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre
            }))
          }
        });
      }
    }
  } catch (e) { log.error('alertas.fotos', 'detección falló', e); }
  return alertas;
};

// 🔴 TALLER_ATORADO — órdenes en taller >3 días sin avance
const detectarTallerAtorado = async (adminId) => {
  const alertas = [];
  try {
    const snap = await db.collection('orders').where('adminId', '==', adminId).get();
    const ahora = new Date();
    snap.forEach(d => {
      const o = d.data();
      if (o.estado !== 'en_taller' && o.estado !== 'taller_proceso') return;
      const fechaEnTaller = parseFecha(o.fechaEnTaller)
        || parseFecha((o.historialEstados || []).find(h => h.estado === 'en_taller')?.fecha)
        || parseFecha(o.updatedAt);
      if (!fechaEnTaller) return;
      const dias = diasEntre(fechaEnTaller, ahora);
      if (dias >= UMBRALES.TALLER_ATORADO_DIAS) {
        alertas.push({
          tipo: 'TALLER_ATORADO',
          prioridad: PRIORIDAD.TALLER_ATORADO,
          rolesDestino: ROLES_DESTINO.TALLER_ATORADO,
          referenciaId: d.id,
          titulo: `Orden ${o.numeroOrden} atorada en taller hace ${dias} días`,
          descripcion: `Cliente: ${o.clienteNombre}. Revisa qué está bloqueando el avance.`,
          datos: {
            ordenId: d.id, numeroOrden: o.numeroOrden,
            clienteNombre: o.clienteNombre,
            fechaEnTaller: fechaEnTaller.toISOString(),
            dias
          }
        });
      }
    });
  } catch (e) { log.error('alertas.taller', 'detección falló', e); }
  return alertas;
};

// 🟡 PAGO_PENDIENTE — pagos virtuales sin validar >24h
const detectarPagoPendiente = async (adminId) => {
  const alertas = [];
  try {
    const snap = await db.collection('orders').where('adminId', '==', adminId).get();
    const ahora = new Date();
    snap.forEach(d => {
      const o = d.data();
      if (!o.pagoVirtualPendienteValidar) return;
      const fechaCobro = parseFecha(o.fechaCobro) || parseFecha(o.fechaPago) || parseFecha(o.updatedAt);
      if (!fechaCobro) return;
      const h = horasEntre(fechaCobro, ahora);
      if (h >= UMBRALES.PAGO_PENDIENTE_HORAS) {
        alertas.push({
          tipo: 'PAGO_PENDIENTE',
          prioridad: PRIORIDAD.PAGO_PENDIENTE,
          rolesDestino: ROLES_DESTINO.PAGO_PENDIENTE,
          referenciaId: d.id,
          titulo: `Pago virtual sin validar hace ${Math.round(h)}h: ${o.numeroOrden}`,
          descripcion: `Cliente: ${o.clienteNombre}. ${o.formaPago || 'Pago virtual'}. Valida el comprobante.`,
          datos: {
            ordenId: d.id, numeroOrden: o.numeroOrden,
            clienteNombre: o.clienteNombre,
            formaPago: o.formaPago, total: o.total,
            fechaCobro: fechaCobro.toISOString(),
            horas: Math.round(h)
          }
        });
      }
    });
  } catch (e) { log.error('alertas.pago', 'detección falló', e); }
  return alertas;
};

// 🟡 PRESTAMO_VIEJO — extintores prestamo >30 días en cliente
const detectarPrestamosViejos = async (adminId) => {
  const alertas = [];
  try {
    const snap = await db.collection('extintores_prestamo').where('adminId', '==', adminId).get();
    const ahora = new Date();
    snap.forEach(d => {
      const p = d.data();
      if (p.estado !== 'prestado') return;
      const fSalida = parseFecha(p.fechaSalida);
      if (!fSalida) return;
      const dias = diasEntre(fSalida, ahora);
      if (dias >= UMBRALES.PRESTAMO_DIAS) {
        alertas.push({
          tipo: 'PRESTAMO_VIEJO',
          prioridad: PRIORIDAD.PRESTAMO_VIEJO,
          rolesDestino: ROLES_DESTINO.PRESTAMO_VIEJO,
          referenciaId: d.id,
          titulo: `Extintor ${p.numeroExtintor} en cliente hace ${dias} días`,
          descripcion: `Cliente: ${p.clienteNombre}. Posible riesgo de pérdida.`,
          datos: {
            prestamoId: d.id,
            numeroExtintor: p.numeroExtintor,
            clienteNombre: p.clienteNombre,
            clienteId: p.clienteId,
            fechaSalida: fSalida.toISOString(),
            dias
          }
        });
      }
    });
  } catch (e) { log.error('alertas.prestamos', 'detección falló', e); }
  return alertas;
};

// 🟡 CXC_VENCIDO — facturas en mora >15 días
const detectarCxCVencido = async (adminId) => {
  const alertas = [];
  try {
    const snap = await db.collection('cxc').where('adminId', '==', adminId).get();
    const ahora = new Date();
    snap.forEach(d => {
      const c = d.data();
      if (c.estado !== 'pendiente') return;
      const fVenc = parseFecha(c.fechaVencimiento);
      if (!fVenc) return;
      const dias = diasEntre(fVenc, ahora);
      if (dias >= UMBRALES.CXC_DIAS_MORA) {
        alertas.push({
          tipo: 'CXC_VENCIDO',
          prioridad: PRIORIDAD.CXC_VENCIDO,
          rolesDestino: ROLES_DESTINO.CXC_VENCIDO,
          referenciaId: d.id,
          titulo: `CxC ${c.numeroOrden || ''} en mora hace ${dias} días`,
          descripcion: `Cliente: ${c.clienteNombre}. Saldo: $${(c.saldoPendiente || c.monto || 0).toLocaleString('es-CO')}`,
          datos: {
            cxcId: d.id, numeroOrden: c.numeroOrden,
            clienteNombre: c.clienteNombre,
            saldoPendiente: c.saldoPendiente || c.monto,
            fechaVencimiento: fVenc.toISOString(),
            diasMora: dias
          }
        });
      }
    });
  } catch (e) { log.error('alertas.cxc', 'detección falló', e); }
  return alertas;
};

// 🟢 CLIENTE_FUGANDOSE — 11+ meses sin comprar (antes de los 13 que ya son fugados)
const detectarClientesFugandose = async (adminId) => {
  const alertas = [];
  try {
    const [clientsSnap, ordsSnap] = await Promise.all([
      db.collection('clients').where('adminId', '==', adminId).get(),
      db.collection('orders').where('adminId', '==', adminId).get()
    ]);

    // Última orden por cliente
    const ultimaPorCliente = {};
    ordsSnap.forEach(d => {
      const o = d.data();
      if (o.estado === 'anulada' || !o.clienteId) return;
      const f = parseFecha(o.createdAt);
      if (!f) return;
      const cur = ultimaPorCliente[o.clienteId];
      if (!cur || f > cur) ultimaPorCliente[o.clienteId] = f;
    });

    const ahora = new Date();
    clientsSnap.forEach(d => {
      const c = d.data();
      const ultima = ultimaPorCliente[d.id];
      if (!ultima) return; // nunca compró → no es "fugándose"
      const dias = diasEntre(ultima, ahora);
      const meses = dias / 30;
      // Entre 11 y 13 meses: zona de alerta (antes era "fugando", ahora "fugado")
      if (meses >= UMBRALES.CLIENTE_FUGANDOSE_MESES && meses < UMBRALES.CLIENTE_FUGADO_MESES) {
        alertas.push({
          tipo: 'CLIENTE_FUGANDOSE',
          prioridad: PRIORIDAD.CLIENTE_FUGANDOSE,
          rolesDestino: ROLES_DESTINO.CLIENTE_FUGANDOSE,
          referenciaId: d.id,
          titulo: `${c.nombre} sin comprar hace ${Math.round(meses * 10) / 10} meses`,
          descripcion: `Antes de los 13 meses, ¡contáctalo! Su ciclo anual está por vencer.`,
          datos: {
            clienteId: d.id,
            clienteNombre: c.nombre,
            celular: c.celular,
            ultimaCompraISO: ultima.toISOString(),
            meses: Math.round(meses * 10) / 10
          }
        });
      }
    });
  } catch (e) { log.error('alertas.fugandose', 'detección falló', e); }
  return alertas;
};

// ════════════════════════════════════════════════════════════════════════════
// ── OPTIMIZACIÓN OLA 3.5: Cache en memoria ──
// Reduce dramáticamente las lecturas a Firestore. En vez de leer 6 colecciones
// en cada GET, leemos UNA vez cada 5 minutos y guardamos el resultado en RAM.
// Cache por adminId para que cada cuenta tenga su propia copia.
// El cache se invalida automáticamente cuando se resuelve/reabre una alerta.
// ════════════════════════════════════════════════════════════════════════════
const cache = new Map(); // adminId → { data: alertas[], expiraEn: timestamp }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

const obtenerCache = (adminId) => {
  const entrada = cache.get(adminId);
  if (!entrada) return null;
  if (Date.now() > entrada.expiraEn) {
    cache.delete(adminId);
    return null;
  }
  return entrada.data;
};

const guardarCache = (adminId, data) => {
  cache.set(adminId, { data, expiraEn: Date.now() + CACHE_TTL_MS });
};

const invalidarCache = (adminId) => cache.delete(adminId);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/alertas — devuelve todas las alertas activas filtradas por rol
// ────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    const rol = req.user?.role || 'admin';

    // ── OPTIMIZACIÓN OLA 3.5: revisar cache primero ──
    let todasSinFiltro = obtenerCache(adminId);

    if (!todasSinFiltro) {
      // Cache vacío o expirado → leer de Firestore (las 6 colecciones)
      const [a1, a2, a3, a4, a5, a6] = await Promise.all([
        detectarFotosFaltantes(adminId),
        detectarTallerAtorado(adminId),
        detectarPagoPendiente(adminId),
        detectarPrestamosViejos(adminId),
        detectarCxCVencido(adminId),
        detectarClientesFugandose(adminId),
      ]);
      todasSinFiltro = [...a1, ...a2, ...a3, ...a4, ...a5, ...a6];
      guardarCache(adminId, todasSinFiltro);
      log.info('alertas', `cache regenerado para admin ${adminId} (${todasSinFiltro.length} alertas)`);
    }

    let todas = [...todasSinFiltro]; // copia para no mutar el cache

    // Filtrar por rol del usuario
    if (rol !== 'admin') {
      todas = todas.filter(a => a.rolesDestino.includes(rol));
    }

    // Cargar alertas resueltas (para no mostrarlas)
    const resueltasSnap = await db.collection('alertas_resueltas')
      .where('adminId', '==', adminId).get().catch(() => ({ docs: [] }));
    const claveResuelta = new Set();
    resueltasSnap.docs.forEach(d => {
      const r = d.data();
      claveResuelta.add(`${r.tipo}_${r.referenciaId}`);
    });
    todas = todas.filter(a => !claveResuelta.has(`${a.tipo}_${a.referenciaId}`));

    // Ordenar: críticas primero, luego importantes, luego informativas
    const ordenPrioridad = { critica: 0, importante: 1, informativa: 2 };
    todas.sort((a, b) => ordenPrioridad[a.prioridad] - ordenPrioridad[b.prioridad]);

    // Resumen por tipo
    const resumen = {
      total: todas.length,
      criticas: todas.filter(a => a.prioridad === 'critica').length,
      importantes: todas.filter(a => a.prioridad === 'importante').length,
      informativas: todas.filter(a => a.prioridad === 'informativa').length,
      porTipo: {}
    };
    todas.forEach(a => {
      resumen.porTipo[a.tipo] = (resumen.porTipo[a.tipo] || 0) + 1;
    });

    res.json({ resumen, alertas: todas });
  } catch (e) {
    log.error('alertas.list', 'falló', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/alertas/resolver — marcar una alerta como resuelta ─────────────
router.post('/resolver', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    const { tipo, referenciaId, nota = '' } = req.body;
    if (!tipo || !referenciaId) return res.status(400).json({ error: 'tipo y referenciaId requeridos' });

    await db.collection('alertas_resueltas').add({
      adminId, tipo, referenciaId, nota,
      resueltaPor: req.user?.email || req.user?.nombre || 'admin',
      resueltaPorId: req.user?.uid || req.user?.id || '',
      fechaResolucion: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    invalidarCache(adminId); // ── OPTIMIZACIÓN OLA 3.5: refrescar cache al resolver ──
    log.info('alertas', `${tipo}/${referenciaId} resuelta por ${req.user?.email}`);
    res.json({ ok: true });
  } catch (e) {
    log.error('alertas.resolver', 'falló', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/alertas/reabrir — reabrir una alerta cerrada (admin) ───────────
router.post('/reabrir', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const { tipo, referenciaId } = req.body;
    if (!tipo || !referenciaId) return res.status(400).json({ error: 'tipo y referenciaId requeridos' });

    const snap = await db.collection('alertas_resueltas')
      .where('adminId', '==', adminId)
      .where('tipo', '==', tipo)
      .where('referenciaId', '==', referenciaId).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();

    invalidarCache(adminId); // ── OPTIMIZACIÓN OLA 3.5: refrescar cache al reabrir ──
    res.json({ ok: true });
  } catch (e) {
    log.error('alertas.reabrir', 'falló', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
