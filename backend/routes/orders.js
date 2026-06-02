const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const jwt = require('jsonwebtoken');
const { authenticate, validarTenant } = require('../middleware/auth');

// ─── ESTADOS VÁLIDOS ──────────────────────────────────────────────────────────
const ESTADOS = [
  'programada', 'en_ruta_recogida', 'en_taller', 'listo_entregar', 'facturado',
  'despacho', 'en_ruta_entrega', 'entrega_cobranza', 'cuadre_dinero',
  'reparacion_proceso', 'completada', 'cxc', 'anulada'
];

const ESTADO_LABELS = {
  programada: 'Programada', en_ruta_recogida: 'En Ruta Recogida',
  en_taller: 'En Taller', listo_entregar: 'Listo para Entregar',
  facturado: 'Facturado', despacho: 'Despacho',
  en_ruta_entrega: 'En Ruta Entrega', entrega_cobranza: 'Entrega Cobranza',
  reparacion_proceso: 'Reparación en Proceso', cuadre_dinero: 'Completada',
  completada: 'Completada', cxc: 'Cuenta por Cobrar', anulada: 'Anulada'
};

// Categorías que SÍ son trabajo de taller (lista blanca, no lista negra).
// Solo recarga, mantenimiento y prueba hidrostática cuentan como equipo
// procesado. Un botiquín, chaleco o domicilio NO cuentan aunque estén en
// la orden (son venta, no servicio de taller).
const CATEGORIAS_TALLER = [
  'recarga', 'mantenimiento', 'prueba hidrostatica', 'prueba hidrostática',
  'hidrostatica', 'hidrostática'
];
const CATEGORIAS_CERTIFICADO = [
  'recargas y mantenimiento', 'recarga y mantenimiento', 'recargas',
  'mantenimiento', 'prueba hidrostatica', 'prueba hidrostática', 'ph', 'recarga'
];

// ─── HELPER: ¿este item es trabajo de taller? ────────────────────────────────
const esItemTaller = (item = {}) => {
  const cat = (item.categoria || '').toLowerCase();
  return CATEGORIAS_TALLER.some(c => cat.includes(c));
};
const contarEquiposTaller = (items = []) =>
  (items || []).filter(esItemTaller).reduce((s, it) => s + (it.cantidad || 1), 0);

// ══════════════════════════════════════════════════════════════════════════════
// MÁQUINA DE ESTADOS ÚNICA — FUENTE DE VERDAD DEL FLUJO EN TODO EL SISTEMA
// ──────────────────────────────────────────────────────────────────────────────
// logistics.js y el frontend NO recalculan el flujo: consumen esto.
//   - siguiente: estado al que avanza
//   - auto: true = el sistema avanza solo · false = requiere acción humana
//   - requiereFacturaAntes: true = no avanza sin N° factura
//   - accion: etiqueta de la acción humana esperada
// ══════════════════════════════════════════════════════════════════════════════
const normalizarLugar = (lugar) => {
  const l = (lugar || 'domicilio').toLowerCase();
  if (l === 'oficina_rapida') return 'oficina';
  if (l === 'oficina_taller') return 'taller';
  return l;
};

// tieneEquipoTaller: ¿la orden lleva extintores de recarga/mantenimiento/PH?
//   true  → flujo de SERVICIO (recoge, va a taller, entrega)
//   false → flujo de VENTA (botiquín, chaleco, extintor nuevo): NO recoge,
//           NO va a taller. Solo se entrega y se cobra. Esto resuelve el
//           "recoger un botiquín no tiene lógica".
const construirFlujo = (lugarAtencion, requiereFactura, tieneEquipoTaller = true) => {
  const lugar = normalizarLugar(lugarAtencion);
  const F = !!requiereFactura;
  const T = tieneEquipoTaller !== false; // por defecto true (compatibilidad)

  const flujos = {
    // FLUJO 1 — OFICINA: cliente presente. Sin factura: nace 'completada'.
    // Con factura: espera N° y se completa SOLA al digitarlo.
    oficina: F ? {
      facturado: { siguiente: 'completada', auto: true, requiereFacturaAntes: true }
    } : {},

    // FLUJO 2 — TALLER: entra equipo, se trabaja, queda listo para que el
    // cliente lo recoja (a veces se va y vuelve después).
    taller: F ? {
      en_taller:      { siguiente: 'facturado',      auto: false, accion: 'taller' },
      facturado:      { siguiente: 'listo_entregar', auto: true,  requiereFacturaAntes: true },
      listo_entregar: { siguiente: 'completada',     auto: false, accion: 'entregar_oficina' }
    } : {
      en_taller:      { siguiente: 'listo_entregar', auto: false, accion: 'taller' },
      listo_entregar: { siguiente: 'completada',     auto: false, accion: 'entregar_oficina' }
    },

    // FLUJO 3 — DESPACHO:
    //   Sin equipo de taller (venta lista): sale a entregar y cobrar.
    //   Con equipo de taller (el cliente trajo recarga o se marcó despacho
    //   por error): pasa por taller y luego sale a entregar. Evita que la
    //   orden quede atascada en 'facturado'.
    despacho: T ? (F ? {
      en_taller:        { siguiente: 'facturado',        auto: false, accion: 'taller' },
      facturado:        { siguiente: 'en_ruta_entrega',  auto: true,  requiereFacturaAntes: true },
      en_ruta_entrega:  { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    } : {
      en_taller:        { siguiente: 'en_ruta_entrega',  auto: false, accion: 'taller' },
      en_ruta_entrega:  { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    }) : (F ? {
      despacho:         { siguiente: 'facturado',        auto: true,  requiereFacturaAntes: true },
      facturado:        { siguiente: 'en_ruta_entrega',  auto: true },
      en_ruta_entrega:  { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    } : {
      despacho:         { siguiente: 'en_ruta_entrega',  auto: true },
      en_ruta_entrega:  { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    }),

    // FLUJO 4 — DOMICILIO:
    //   CON equipo de taller (servicio): recoge → taller → entrega → cobra.
    //   SIN equipo de taller (venta a domicilio): NO recoge, NO va a taller.
    //   Solo se asigna mensajero, entrega y cobra. Aquí está la corrección
    //   del "recoger un botiquín no tiene lógica".
    domicilio: T ? (F ? {
      programada:       { siguiente: 'en_ruta_recogida', auto: false, accion: 'asignar' },
      en_ruta_recogida: { siguiente: 'en_taller',        auto: false, accion: 'recogida' },
      en_taller:        { siguiente: 'facturado',        auto: false, accion: 'taller' },
      facturado:        { siguiente: 'en_ruta_entrega',  auto: true,  requiereFacturaAntes: true },
      en_ruta_entrega:  { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    } : {
      programada:       { siguiente: 'en_ruta_recogida', auto: false, accion: 'asignar' },
      en_ruta_recogida: { siguiente: 'en_taller',        auto: false, accion: 'recogida' },
      en_taller:        { siguiente: 'en_ruta_entrega',  auto: false, accion: 'taller' },
      en_ruta_entrega:  { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    }) : (F ? {
      // VENTA a domicilio con factura: asignar → entregar → cobrar.
      programada:       { siguiente: 'en_ruta_entrega',  auto: false, accion: 'asignar' },
      en_ruta_entrega:  { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    } : {
      // VENTA a domicilio sin factura: asignar → entregar → cobrar.
      programada:       { siguiente: 'en_ruta_entrega',  auto: false, accion: 'asignar' },
      en_ruta_entrega:  { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    }),

    // COBRANZA: solo se va a cobrar cartera en calle.
    cobranza: {
      programada:       { siguiente: 'en_ruta_recogida', auto: false, accion: 'asignar' },
      en_ruta_recogida: { siguiente: 'entrega_cobranza', auto: false, accion: 'entrega' },
      entrega_cobranza: { siguiente: 'cuadre_dinero',    auto: false, accion: 'cuadre' }
    },

    // INTERNA: tarea operativa (vueltas, compras). Sin factura ni cobro.
    interna: {
      programada: { siguiente: 'completada', auto: false, accion: 'cerrar_interna' }
    },

    // PRODUCCIÓN: stock de equipos de cambio. Pedro los carga, salen con QR
    // "sin dueño". No factura, no CxC. Es interna de inventario.
    produccion: {
      programada: { siguiente: 'en_taller',  auto: true },
      en_taller:  { siguiente: 'completada', auto: false, accion: 'producir' }
    }
  };

  return flujos[lugar] || flujos.domicilio;
};

const pasoSiguiente = (orden) => {
  const tieneTaller = (orden.items || []).some(esItemTaller);
  const flujo = construirFlujo(orden.lugarAtencion, orden.requiereFactura, tieneTaller);
  return flujo[orden.estado] || null;
};

// Obtiene el flag de equipo-taller de una orden ya guardada. Si la orden es
// vieja y no tiene el campo, lo calcula de sus items (compatibilidad).
const ordenTieneTaller = (orden) => {
  if (typeof orden.tieneEquipoTaller === 'boolean') return orden.tieneEquipoTaller;
  return (orden.items || []).some(esItemTaller);
};

const calcularEstadoInicial = (lugarAtencion, requiereFactura, tieneEquipoTaller = true, items = []) => {
  const lugar = normalizarLugar(lugarAtencion);
  const T = tieneEquipoTaller !== false;

  if (lugar === 'oficina') {
    // Ola 2.5 Bloque 1: Oficina con equipo de taller (recarga/mant sin Cambio)
    // pasa a TALLER en lugar de completarse al instante. Antes se completaba
    // y el extintor nunca llegaba a Pedro.
    if (T) return 'en_taller';
    return requiereFactura ? 'facturado' : 'completada';
  }
  if (lugar === 'taller')     return 'en_taller';
  // Si una orden tiene equipo de taller (recarga/mant sin cambio), ese equipo
  // SÍ o SÍ pasa por taller, aunque la marcaran despacho por error o porque
  // el cliente lo trajo. Evita que quede atascada en 'facturado'.
  if (lugar === 'despacho')   return T ? 'en_taller' : 'despacho';
  if (lugar === 'domicilio')  return 'programada';
  if (lugar === 'cobranza')   return 'programada';
  if (lugar === 'interna')    return 'programada';
  if (lugar === 'produccion') return 'programada';
  return 'programada';
};

// ─── HELPER: auditoría ────────────────────────────────────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, ordenId, documento, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'ordenes', descripcion,
      usuarioId, usuarioNombre, ordenId: ordenId || null,
      documento: documento || null,
      datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

// ─── HELPER: verificar PIN del usuario logueado ──────────────────────────────
// Devuelve { ok: bool, error?: string }.
// Solo Admin y Tesorería pueden tener PIN válido para acciones sensibles.
// Esto sustituye al PIN global de empresa (que ya no se usa en Ola 1).
const verificarPinUsuario = async (uid, pin) => {
  if (!pin) return { ok: false, error: 'PIN requerido' };
  if (!uid) return { ok: false, error: 'Sesión inválida' };

  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) return { ok: false, error: 'Usuario no encontrado' };

  const u = doc.data();
  if (u.role !== 'admin' && u.role !== 'tesoreria') {
    return { ok: false, error: 'Tu rol no puede autorizar esta acción' };
  }
  if (!u.pin) {
    return { ok: false, error: 'No tienes PIN configurado. Pídele al administrador que te lo asigne.' };
  }
  if (String(u.pin) !== String(pin)) {
    return { ok: false, error: 'PIN incorrecto' };
  }
  return { ok: true };
};

// ─── HELPER: generar número de orden (ATÓMICO con transacción) ──────────────
// Ola 2: protege contra colisiones cuando varios usuarios crean órdenes
// simultáneamente. Usa un documento contador por (adminId, tipo) que se
// incrementa dentro de una transacción Firestore — si dos transacciones chocan,
// Firestore reintenta automáticamente. Resultado: nunca se generan números
// duplicados, sin importar la concurrencia.
//
// Estructura del contador:
//   counters/{adminId}_orders_{tipo} → { value: N, updatedAt: ... }
//
// Migración automática: si el contador no existe (sistema viejo), se inicializa
// leyendo el máximo actual de la colección 'orders' filtrando por tipo Y adminId.
const generarNumeroOrden = async (tipo, adminId) => {
  if (!adminId) throw new Error('generarNumeroOrden requiere adminId');

  const prefijo = tipo === 'interna' ? 'OI'
    : tipo === 'produccion' ? 'OP'
    : tipo === 'cxc' ? 'OCX' : 'OS';

  const counterRef = db.collection('counters').doc(`${adminId}_orders_${tipo}`);

  const siguiente = await db.runTransaction(async (tx) => {
    const counterDoc = await tx.get(counterRef);

    let valorActual;
    if (counterDoc.exists) {
      valorActual = Number(counterDoc.data().value) || 0;
    } else {
      // Primera vez: calcular el máximo histórico de ese tipo+admin
      // (fuera de la transacción no — Firestore obliga a leer todo dentro,
      // pero collection().get() no se puede dentro de tx. Por eso esta
      // inicialización corre solo una vez por tipo, y aceptamos esa lectura
      // previa fuera del lock — es segura porque solo pasa cuando el contador
      // no existe aún).
      valorActual = 0;
      // Nota: la inicialización real con max() se hace abajo, fuera de la tx,
      // en la primera llamada. Si llegamos aquí significa que ya se inicializó.
    }

    const nuevo = valorActual + 1;
    tx.set(counterRef, {
      value: nuevo,
      tipo,
      adminId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return nuevo;
  });

  return `${prefijo}-${String(siguiente).padStart(4, '0')}`;
};

// ─── HELPER: inicializar contador desde el máximo histórico (1 sola vez) ────
// Se invoca antes de la primera creación si el contador aún no existe en la BD.
const asegurarContadorInicializado = async (tipo, adminId) => {
  const counterRef = db.collection('counters').doc(`${adminId}_orders_${tipo}`);
  const counterDoc = await counterRef.get();
  if (counterDoc.exists) return; // ya está

  // Calcular el máximo histórico desde la colección 'orders'
  const snap = await db.collection('orders')
    .where('adminId', '==', adminId)
    .where('tipoOrden', '==', tipo)
    .get();

  let maximo = 0;
  snap.forEach(doc => {
    const num = parseInt((doc.data().numeroOrden || '').replace(/\D/g, '').slice(-4));
    if (!isNaN(num) && num > maximo) maximo = num;
  });

  // Guardar el máximo como valor inicial. La próxima transacción incrementará.
  await counterRef.set({
    value: maximo,
    tipo,
    adminId,
    inicializado: true,
    inicializadoEn: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
};

// ─── HELPER: verificar si genera certificado ─────────────────────────────────
const requiereCertificado = (items = []) => {
  return items.some(item => {
    const cat = (item.categoria || '').toLowerCase();
    return CATEGORIAS_CERTIFICADO.some(c => cat.includes(c));
  });
};

// ─── HELPER: descontar inventario ────────────────────────────────────────────
const descontarInventario = async (items, ordenId) => {
  for (const item of items) {
    if (!item.productoId) continue;
    try {
      const prodRef = db.collection('products').doc(item.productoId);
      const prodDoc = await prodRef.get();
      if (!prodDoc.exists) continue;
      const prod = prodDoc.data();
      if (prod.tipo === 'compuesto' && prod.componentes?.length > 0) {
        for (const comp of prod.componentes) {
          if (!comp.productoId) continue;
          try {
            const compRef = db.collection('products').doc(comp.productoId);
            const compDoc = await compRef.get();
            if (!compDoc.exists) continue;
            await compRef.update({
              stock: admin.firestore.FieldValue.increment(-(comp.cantidad * item.cantidad)),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } catch (e) { console.warn('Componente no encontrado:', comp.productoId); }
        }
      } else if (prod.tieneStock) {
        await prodRef.update({
          stock: admin.firestore.FieldValue.increment(-item.cantidad),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    } catch (e) { console.warn('Producto no encontrado:', item.productoId); }
  }
};

// ─── HELPER: devolver inventario al anular ────────────────────────────────────
const devolverInventario = async (items) => {
  for (const item of items) {
    if (!item.productoId) continue;
    try {
      const prodRef = db.collection('products').doc(item.productoId);
      const prodDoc = await prodRef.get();
      if (!prodDoc.exists) continue;
      const prod = prodDoc.data();
      if (prod.tipo === 'compuesto' && prod.componentes?.length > 0) {
        for (const comp of prod.componentes) {
          if (!comp.productoId) continue;
          try {
            const compRef = db.collection('products').doc(comp.productoId);
            const compDoc = await compRef.get();
            if (!compDoc.exists) continue;
            await compRef.update({
              stock: admin.firestore.FieldValue.increment(comp.cantidad * item.cantidad),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } catch (e) { console.warn('Componente no encontrado al devolver:', comp.productoId); }
        }
      } else if (prod.tieneStock) {
        await prodRef.update({
          stock: admin.firestore.FieldValue.increment(item.cantidad),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    } catch (e) { console.warn('Producto no encontrado al devolver:', item.productoId); }
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// REGISTRAR INGRESO EN CAJA — FUENTE ÚNICA DE VERDAD DEL DINERO
// Marca la orden con dineroEnCaja=true en transacción atómica. Cualquier
// segundo intento se rechaza al ver el flag → ELIMINA la doble suma de raíz.
// ══════════════════════════════════════════════════════════════════════════════
const registrarIngresoEnCaja = async ({ userId, ordenId, numeroOrden, clienteNombre, monto, formaPago, usuarioEmail, numeroFactura }) => {
  try {
    const esCxC = formaPago === 'A crédito (CxC)' || formaPago === 'A crédito'
      || formaPago === 'credito' || formaPago === 'CXC';

    if (esCxC) {
      if (ordenId) {
        const yaCxc = await db.collection('cxc').where('ordenId', '==', ordenId).limit(1).get();
        if (!yaCxc.empty) return { tipo: 'cxc', mensaje: 'CxC ya registrada (no se duplicó)' };
      }
      await db.collection('cxc').add({
        userId, ordenId, numeroOrden,
        numeroFactura: numeroFactura || '',
        clienteNombre, monto, formaPago,
        estado: 'pendiente',
        fechaCreacion: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { tipo: 'cxc', mensaje: 'Registrado en CxC' };
    }

    // ── CANDADO ANTI-DOBLE-SUMA (transacción atómica) ─────────────────────────
    if (ordenId) {
      const ordenRef = db.collection('orders').doc(ordenId);
      const yaRegistrado = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ordenRef);
        if (snap.exists && snap.data().dineroEnCaja === true) return true;
        if (snap.exists) {
          tx.update(ordenRef, {
            dineroEnCaja: true,
            dineroEnCajaFecha: new Date().toISOString(),
            dineroEnCajaPor: usuarioEmail || userId
          });
        }
        return false;
      });
      if (yaRegistrado) {
        return { tipo: 'duplicado', mensaje: 'El dinero de esta orden ya estaba en caja (no se duplicó)' };
      }
    }

    const configDoc = await db.collection('configuracion').doc(userId).get();
    let cajaId = null;
    if (configDoc.exists) {
      const config = configDoc.data();
      const formaConfig = (config.formasPago || []).find(f =>
        f.nombre?.toLowerCase() === formaPago?.toLowerCase() && f.activa
      );
      if (formaConfig?.cajaId) cajaId = formaConfig.cajaId;
      if (!cajaId && config.mapeoCajas?.[formaPago]) cajaId = config.mapeoCajas[formaPago];
    }

    if (!cajaId) {
      console.warn(`Sin caja mapeada para forma de pago: ${formaPago}`);
      await db.collection('movimientos').add({
        userId, cajaId: 'sin_asignar', tipo: 'ingreso',
        concepto: `Pago ${numeroOrden} — ${clienteNombre}`,
        monto, referencia: numeroOrden, ordenId, formaPago,
        alerta: 'sin_caja_mapeada', creadoPor: usuarioEmail,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { tipo: 'sin_caja', mensaje: 'Movimiento sin caja asignada — configura el mapeo en Mi Empresa' };
    }

    const cajaRef = db.collection('cajas').doc(cajaId);
    const cajaDoc = await cajaRef.get();
    if (!cajaDoc.exists) return { tipo: 'error', mensaje: 'Caja no encontrada' };

    const saldoActual = Number(cajaDoc.data().saldo) || 0;
    await cajaRef.update({
      saldo: saldoActual + monto,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('movimientos').add({
      userId, cajaId, tipo: 'ingreso',
      concepto: `Pago ${numeroOrden} — ${clienteNombre}`,
      monto, referencia: numeroOrden, ordenId, formaPago,
      creadoPor: usuarioEmail,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { tipo: 'caja', cajaId, nuevoSaldo: saldoActual + monto };
  } catch (e) {
    console.error('Error registrando ingreso en caja:', e);
    return { tipo: 'error', mensaje: e.message };
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders — Listar órdenes
// ══════════════════════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res) => {
  try {
    const { estado, clienteId, mensajeroId, tipoOrden, empresaId, buscar, limite = 50 } = req.query;
    const adminId = req.adminId || req.user?.uid || req.user?.id;

    let query = db.collection('orders').where('adminId', '==', adminId);

    if (req.user.role === 'mensajero') {
      query = db.collection('orders')
        .where('adminId', '==', adminId)
        .where('mensajeroId', '==', req.adminId || req.user.uid);
    }
    if (req.user.role === 'taller') {
      query = db.collection('orders')
        .where('adminId', '==', adminId)
        .where('estado', 'in', ['en_taller']);
    }

    const snap = await query.get();
    let ordenes = [];
    snap.forEach(doc => ordenes.push({ id: doc.id, ...doc.data() }));

    // Ordenar en memoria (evita índices compuestos de Firestore)
    ordenes.sort((a, b) => {
      const fa = a.createdAt?._seconds || new Date(a.createdAt || 0).getTime() / 1000;
      const fb = b.createdAt?._seconds || new Date(b.createdAt || 0).getTime() / 1000;
      return fb - fa;
    });
    ordenes = ordenes.slice(0, parseInt(limite));

    if (buscar) {
      const term = buscar.toUpperCase();
      ordenes = ordenes.filter(o =>
        o.numeroOrden?.toUpperCase().includes(term) ||
        o.clienteNombre?.toUpperCase().includes(term)
      );
    }
    if (clienteId) ordenes = ordenes.filter(o => o.clienteId === clienteId);
    if (mensajeroId) ordenes = ordenes.filter(o => o.mensajeroId === mensajeroId);

    res.json(ordenes);
  } catch (error) {
    console.error('Error listando órdenes:', error);
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/:id — Detalle orden
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:id', authenticate, validarTenant('orders'), async (req, res) => {
  try {
    const doc = await db.collection('orders').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Orden no encontrada' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/orders — Crear orden
// ══════════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      tipoOrden = 'servicio',
      clienteId, clienteNombre, clienteNit, clienteCelular,
      sucursalId, sucursalNombre, sucursalDireccion,
      empresaId, empresaNombre,
      items = [],
      fechaProgramada, horaProgramada,
      prioridad = 'normal',
      mensajeroId, mensajeroNombre,
      notasOrden,
      lugarAtencion = 'domicilio',
      formaPago = '',
      requiereFactura = false,
      numeroFactura = '',
      extintorPrestamo = '',
      facturaReferencia, montoCobrar,
      trabajadorAsignadoId, trabajadorAsignadoNombre, trabajadorAsignadoRol,
      subtipoInterna,
      // Ola 2.5: pago adelantado al crear (cliente envió comprobante por anticipado)
      fotoTransferenciaUrl = '',
      pagoAdelantado = false
    } = req.body;

    const esProduccion = tipoOrden === 'produccion' || normalizarLugar(lugarAtencion) === 'produccion';
    const esInterna = tipoOrden === 'interna' || normalizarLugar(lugarAtencion) === 'interna';
    // Interna y producción son operativas: no tienen cliente ni van a ventas.
    const sinCliente = esProduccion || esInterna;

    if (!sinCliente && !clienteId) return res.status(400).json({ error: 'El cliente es obligatorio' });
    if (tipoOrden === 'servicio' && items.length === 0) {
      return res.status(400).json({ error: 'La orden debe tener al menos un producto' });
    }
    if (esProduccion && items.length === 0) {
      return res.status(400).json({ error: 'La orden de producción debe tener al menos un equipo a cargar' });
    }
    if (esInterna && items.length === 0) {
      return res.status(400).json({ error: 'La orden interna debe tener al menos una tarea o ítem' });
    }

    // ─── Ola 2.5 Bloque 1: validación de Domicilio ─────────────────────────
    // Una orden de Domicilio existe porque el cliente tiene equipos a RECARGAR
    // o someter a MANTENIMIENTO. Si todos los ítems son ventas (extintores
    // nuevos, señalización) o todos son "Cambio" (equipos listos), entonces
    // NO debería ser un Domicilio — debería ser Despacho.
    if (normalizarLugar(lugarAtencion) === 'domicilio') {
      const itemsParaRecogerProcesar = (items || []).filter(it => esItemTaller(it) && !it.esCambio);
      if (itemsParaRecogerProcesar.length === 0) {
        return res.status(400).json({
          error: 'Una orden de DOMICILIO debe tener al menos un equipo a recargar o mantener (sin marcar "Cambio"). Si solo vas a entregar productos, usa el tipo DESPACHO.'
        });
      }
    }

    const tipoFinal = esProduccion ? 'produccion' : (esInterna ? 'interna' : tipoOrden);
    const adminId = req.adminId || req.user.uid || req.user.id;

    // Asegurar que el contador atómico esté inicializado para este tipo+admin
    // (solo hace algo la primera vez; después no agrega latencia significativa).
    await asegurarContadorInicializado(tipoFinal, adminId);

    const numeroOrden = await generarNumeroOrden(tipoFinal, adminId);

    const subtotal = items.reduce((sum, item) => {
      const precio = item.precioUnitario || 0;
      const cant = item.cantidad || 1;
      const desc = item.descuento || 0;
      return sum + (precio * cant * (1 - desc / 100));
    }, 0);

    // IVA por empresa: si la empresa tiene IVA > 0 → factura OBLIGATORIA auto.
    // Interna y producción NUNCA tienen IVA ni factura (no son ventas).
    const ivaInfo = empresaId ? await db.collection('companies').doc(empresaId).get().catch(() => null) : null;
    const ivaPct = (esProduccion || esInterna) ? 0 : (ivaInfo?.exists ? (ivaInfo.data().iva || 0) : 0);
    const empresaTieneIva = ivaPct > 0;
    const requiereFacturaFinal = (esProduccion || esInterna) ? false : (empresaTieneIva ? true : !!requiereFactura);
    const ivaValor = Math.round(subtotal * ivaPct / 100);
    const total = subtotal + ivaValor;

    const generaCertificado = tipoFinal === 'servicio' && requiereCertificado(items);
    const esCxc = formaPago === 'A crédito (CxC)' || formaPago === 'CXC' || formaPago === 'A crédito';

    // ¿La orden lleva equipos que DEBEN ir a taller? Solo cuenta recarga/
    // mant/PH que NO estén marcados como "cambio". Un equipo de cambio se
    // entrega listo (no se recoge ni se procesa). Si todos los de recarga
    // son cambio → es venta/entrega, no servicio de taller.
    const tieneEquipoTaller = (items || []).some(it => esItemTaller(it) && !it.esCambio);

    // ── ESTADO INICIAL — Ola 2.5 Bloque 1: bug raíz corregido ───────────────
    // ANTES: si era CxC saltaba directo a 'cxc' (línea 611 anterior). Esto rompía
    // Despacho y Domicilio porque esos estados no aparecen en logística.
    // AHORA: el estado inicial se calcula SOLO por tipo de servicio. El "cxc"
    // se asigna SOLO al completar el flujo si la orden quedó sin cobrar.
    const estadoInicial = esProduccion ? 'programada'
      : calcularEstadoInicial(lugarAtencion, requiereFacturaFinal, tieneEquipoTaller, items);

    // ── PAGO AL CREAR — entra a caja cuando el cliente paga en el momento ─────
    // El cliente está presente y entrega el dinero (oficina o taller con pago
    // inmediato). NO aplica a lo que va por ruta del mensajero (domicilio,
    // despacho, cobranza) ni a CxC. Antes solo miraba 'oficina' y por eso un
    // cliente que recarga su extintor en taller pagando en efectivo NO
    // registraba el dinero en caja → la plata se perdía.
    const lugarNorm = normalizarLugar(lugarAtencion);
    const clientePresentePaga = lugarNorm === 'oficina' || lugarNorm === 'taller';
    const pagadoAlCrear = !esProduccion && clientePresentePaga
      && !esCxc && !!formaPago && formaPago !== '';

    // Ola 2.5: si el cliente ya pagó por adelantado (cliente envió comprobante),
    // marcamos pagado pero NO entra a caja todavía. Queda pendiente de validar
    // por Admin/Tesorería (igual que pasaría con un pago virtual del mensajero).
    const esPagoVirtual = formaPago && formaPago !== 'Efectivo' && !esCxc;
    const marcarPagoAdelantado = pagoAdelantado === true && esPagoVirtual && !!fotoTransferenciaUrl;

    // ── Mini-Ola 2.6: calcular sectorId de la orden ────────────────────────
    // Regla: si hay sucursal → toma sucursal.sectorId (fallback cliente.sectorId).
    // Si NO hay sucursal → toma cliente.sectorId.
    // Si ninguno tiene → null (queda "Sin Asignar" en logística).
    let sectorIdOrden = null;
    if (clienteId) {
      try {
        const clienteDoc = await db.collection('clients').doc(clienteId).get();
        if (clienteDoc.exists) {
          const cli = clienteDoc.data();
          if (sucursalId) {
            const suc = (cli.sucursales || []).find(s => s.id === sucursalId);
            sectorIdOrden = (suc && suc.sectorId) || cli.sectorId || null;
          } else {
            sectorIdOrden = cli.sectorId || null;
          }
        }
      } catch { /* sin sector, queda null */ }
    }

    const nuevaOrden = {
      numeroOrden,
      tipoOrden: tipoFinal,
      estado: estadoInicial,
      historialEstados: [{
        estado: estadoInicial,
        fecha: new Date().toISOString(),
        usuarioId: req.adminId || req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email
      }],
      clienteId: clienteId || null,
      clienteNombre: clienteNombre
        || (esProduccion ? 'PRODUCCIÓN INTERNA' : (esInterna ? 'TAREA INTERNA' : '')),
      clienteNit: clienteNit || '',
      clienteCelular: clienteCelular || '',
      trabajadorAsignadoId: trabajadorAsignadoId || mensajeroId || null,
      trabajadorAsignadoNombre: trabajadorAsignadoNombre || mensajeroNombre || '',
      trabajadorAsignadoRol: trabajadorAsignadoRol || '',
      subtipoInterna: esInterna ? (subtipoInterna || 'tarea') : null,
      clienteDireccionPrincipal: req.body.clienteDireccionPrincipal || '',
      sucursalId: sucursalId || null,
      sucursalNombre: sucursalNombre || '',
      sucursalDireccion: sucursalDireccion || '',
      sectorId: sectorIdOrden,        // Mini-Ola 2.6: sector resuelto para logística
      empresaId: empresaId || '',
      empresaNombre: empresaNombre || '',
      ivaPct,
      items: items.map(item => ({
        productoId: item.productoId || '',
        nombre: item.nombre || '',
        categoria: item.categoria || '',
        cantidad: item.cantidad || 1,
        precioUnitario: item.precioUnitario || 0,
        descuento: item.descuento || 0,
        notas: item.notas || '',
        esCambio: !!item.esCambio,
        codigoQR: item.codigoQR || '',
        subtotalItem: Math.round((item.precioUnitario || 0) * (item.cantidad || 1) * (1 - (item.descuento || 0) / 100))
      })),
      subtotal: Math.round(subtotal),
      ivaValor,
      total: Math.round(total),
      fechaProgramada: fechaProgramada || null,
      horaProgramada: horaProgramada || null,
      prioridad,
      mensajeroId: mensajeroId || null,
      mensajeroNombre: mensajeroNombre || '',
      notasOrden: notasOrden || '',
      facturaReferencia: facturaReferencia || null,
      montoCobrar: montoCobrar || 0,
      generaCertificado,
      certificadoGenerado: false,
      certificadoUrl: null,
      lugarAtencion: esProduccion ? 'produccion' : (lugarAtencion || 'domicilio'),
      formaPago: formaPago || '',
      numeroFactura: numeroFactura || '',
      fechaFactura: numeroFactura ? new Date().toISOString() : null,
      extintorPrestamo: extintorPrestamo || '',
      requiereFactura: requiereFacturaFinal,
      // Señal para taller/QR: equipo necesita resolver QR (generar/escanear).
      // NO se crea QR automático aquí (causaba duplicados cada año).
      qrPendiente: !esProduccion && requiereCertificado(items),
      tieneEquipoTaller,
      pagado: pagadoAlCrear || marcarPagoAdelantado,
      montoPagado: (pagadoAlCrear || marcarPagoAdelantado) ? Math.round(total) : 0,
      fechaPago: (pagadoAlCrear || marcarPagoAdelantado) ? new Date().toISOString() : null,
      // Ola 2.5: pago adelantado va a caja DESPUÉS de validación
      dineroEnCaja: pagadoAlCrear && !marcarPagoAdelantado && formaPago === 'Efectivo' ? false : false,
      // Marca pendiente de validación si fue pago electrónico anticipado
      pagoVirtualPendienteValidar: marcarPagoAdelantado,
      pagoValidado: marcarPagoAdelantado ? false : null,
      fotoTransferenciaUrl: fotoTransferenciaUrl || null,
      cobradoPorMensajero: false,
      creadoPor: req.user.uid || req.user.id,
      creadoPorEmail: req.user.email,
      creadoPorNombre: req.user.nombre || req.user.email,
      adminId: req.adminId || req.user.uid || req.user.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('orders').add(nuevaOrden);

    if (tipoFinal !== 'interna' && tipoFinal !== 'produccion') {
      await descontarInventario(items, ref.id);
    }

    if (pagadoAlCrear && !marcarPagoAdelantado) {
      // Solo entra a caja efectivo en oficina. Pago virtual adelantado espera validación.
      await registrarIngresoEnCaja({
        userId: req.adminId || req.user.uid,
        ordenId: ref.id, numeroOrden, clienteNombre,
        monto: Math.round(total), formaPago,
        usuarioEmail: req.user.email, numeroFactura
      });
    }

    // ── CxC AUTOMÁTICA al crear orden a crédito (cualquier flujo) ─────────────
    if (esCxc && !esProduccion) {
      const yaCxc = await db.collection('cxc').where('ordenId', '==', ref.id).limit(1).get();
      if (yaCxc.empty) {
        await db.collection('cxc').add({
          userId: req.adminId || req.user.uid,
          ordenId: ref.id, numeroOrden,
          numeroFactura: numeroFactura || '',
          clienteNombre, clienteId: clienteId || null,
          monto: Math.round(total), formaPago,
          estado: 'pendiente',
          fechaCreacion: new Date().toISOString(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    // ── QR de cambio: el equipo ya existe (vino de producción). Solo se liga
    // al cliente. NO se genera QR automático (eso ahora lo decide el taller).
    try {
      for (const item of items) {
        if (item.esCambio && item.codigoQR) {
          const qrSnap = await db.collection('qr_equipos')
            .where('codigoQR', '==', item.codigoQR.toUpperCase())
            .limit(1).get();
          if (!qrSnap.empty) {
            await qrSnap.docs[0].ref.update({
              clienteId: clienteId || null,
              propietario: clienteNombre || null,
              ubicacion: sucursalNombre || sucursalDireccion || '',
              empresaId: empresaId || null,
              historial: admin.firestore.FieldValue.arrayUnion({
                fecha: new Date().toISOString(),
                tipo: 'Asignación propietario (cambio)',
                ordenId: ref.id, numeroOrden,
                observaciones: `Equipo de cambio asignado a ${clienteNombre} en orden ${numeroOrden}`
              }),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
    } catch (eQR) { console.warn('Error ligando QR de cambio:', eQR.message); }

    if (requiereFacturaFinal && !numeroFactura) {
      await db.collection('notificaciones').add({
        tipo: 'FACTURA_PENDIENTE',
        ordenId: ref.id, numeroOrden, clienteNombre,
        total: Math.round(total), empresaId,
        mensaje: `Orden ${numeroOrden} requiere factura DIAN — ${clienteNombre} — $${Math.round(total).toLocaleString('es-CO')}`,
        leida: false,
        creadoEn: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await auditar({
      accion: 'CREAR_ORDEN',
      descripcion: `${req.user.nombre || req.user.email} creó ${tipoFinal === 'produccion' ? 'orden de producción' : 'orden'} ${numeroOrden} — ${clienteNombre || 'Producción'} — $${total.toLocaleString()}`,
      usuarioId: req.adminId || req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      ordenId: ref.id,
      datos: { numeroOrden, clienteNombre, total, tipoOrden: tipoFinal, pagadoAlCrear, esCxc }
    });

    res.status(201).json({ id: ref.id, ...nuevaOrden });
  } catch (error) {
    console.error('Error creando orden:', error);
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/orders/:id — Editar orden
// ══════════════════════════════════════════════════════════════════════════════
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const ordenRef = db.collection('orders').doc(id);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const actual = ordenDoc.data();
    const {
      items, fechaProgramada, horaProgramada, prioridad,
      mensajeroId, mensajeroNombre, notasOrden,
      sucursalId, sucursalNombre, sucursalDireccion
    } = req.body;

    const estadosEditables = ['programada', 'en_ruta_recogida'];
    if (!estadosEditables.includes(actual.estado) && req.user.role !== 'admin') {
      return res.status(400).json({ error: `No se puede editar una orden en estado "${ESTADO_LABELS[actual.estado]}"` });
    }

    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (items) {
      const subtotal = items.reduce((sum, item) => {
        return sum + ((item.precioUnitario || 0) * (item.cantidad || 1) * (1 - (item.descuento || 0) / 100));
      }, 0);
      const ivaValor = Math.round(subtotal * (actual.ivaPct || 0) / 100);
      cambios.items = items.map(item => ({
        productoId: item.productoId || '',
        nombre: item.nombre || '',
        categoria: item.categoria || '',
        cantidad: item.cantidad || 1,
        precioUnitario: item.precioUnitario || 0,
        descuento: item.descuento || 0,
        notas: item.notas || '',
        esCambio: !!item.esCambio,
        codigoQR: item.codigoQR || '',
        subtotalItem: Math.round((item.precioUnitario || 0) * (item.cantidad || 1) * (1 - (item.descuento || 0) / 100))
      }));
      cambios.subtotal = Math.round(subtotal);
      cambios.ivaValor = ivaValor;
      cambios.total = Math.round(subtotal + ivaValor);
      cambios.generaCertificado = requiereCertificado(items);
      cambios.qrPendiente = requiereCertificado(items);
    }

    if (fechaProgramada !== undefined) cambios.fechaProgramada = fechaProgramada;
    if (horaProgramada !== undefined) cambios.horaProgramada = horaProgramada;
    if (prioridad) cambios.prioridad = prioridad;
    if (mensajeroId !== undefined) { cambios.mensajeroId = mensajeroId; cambios.mensajeroNombre = mensajeroNombre || ''; }
    if (notasOrden !== undefined) cambios.notasOrden = notasOrden;
    if (sucursalId !== undefined) {
      cambios.sucursalId = sucursalId;
      cambios.sucursalNombre = sucursalNombre || '';
      cambios.sucursalDireccion = sucursalDireccion || '';
    }

    await ordenRef.update(cambios);

    await auditar({
      accion: 'EDITAR_ORDEN',
      descripcion: `${req.user.nombre || req.user.email} editó orden ${actual.numeroOrden}`,
      usuarioId: req.adminId || req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      ordenId: id,
      datos: { campos: Object.keys(cambios) }
    });

    res.json({ id, ...cambios });
  } catch (error) {
    console.error('Error editando orden:', error);
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/orders/:id/estado — Cambiar estado (AVANCE AUTOMÁTICO EN CASCADA)
// ══════════════════════════════════════════════════════════════════════════════
router.put('/:id/estado', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { nuevoEstado, notas, numeroFactura, pin } = req.body;

    const ordenRef = db.collection('orders').doc(id);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const actual = ordenDoc.data();
    const historial = actual.historialEstados || [];
    const usuarioId = req.adminId || req.user.uid || req.user.id;
    const usuarioNombre = req.user.nombre || req.user.email;
    const ahora = () => new Date().toISOString();

    // ── ANULACIÓN ─────────────────────────────────────────────────────────────
    // R-02-03: solo Admin/Tesorería con PIN válido pueden anular.
    if (nuevoEstado === 'anulada') {
      if (actual.estado === 'anulada') return res.status(400).json({ error: 'La orden ya está anulada' });

      // Solo Admin puede anular (spec dice "solo Admin"). Tesorería NO.
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Solo el administrador puede anular órdenes' });
      }

      // Validar PIN del usuario logueado
      const verificacion = await verificarPinUsuario(req.user.uid || req.user.id, pin);
      if (!verificacion.ok) {
        // Registrar intento fallido en auditoría
        await auditar({
          accion: 'ANULACION_PIN_FALLIDO',
          descripcion: `${usuarioNombre} intentó anular ${actual.numeroOrden} con PIN incorrecto`,
          usuarioId, usuarioNombre, ordenId: id,
          documento: actual.numeroOrden,
          datos: { motivo: notas || '', error: verificacion.error }
        });
        return res.status(403).json({ error: verificacion.error });
      }

      if (!notas || !String(notas).trim()) {
        return res.status(400).json({ error: 'Debes indicar el motivo de la anulación' });
      }

      await devolverInventario(actual.items || []);
      historial.push({ estado: 'anulada', fecha: ahora(), usuarioId, usuarioNombre, notas: notas || '' });
      await ordenRef.update({
        estado: 'anulada',
        historialEstados: historial,
        anuladaPor: usuarioNombre,
        anuladaEn: ahora(),
        motivoAnulacion: String(notas).trim(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await auditar({
        accion: 'ANULAR_ORDEN',
        descripcion: `${usuarioNombre} anuló orden ${actual.numeroOrden} — Motivo: ${notas}`,
        usuarioId, usuarioNombre, ordenId: id,
        documento: actual.numeroOrden,
        datos: { estadoAnterior: actual.estado, motivo: notas }
      });
      return res.json({ id, estado: 'anulada', historialEstados: historial });
    }

    if (!ESTADOS.includes(nuevoEstado)) {
      return res.status(400).json({ error: `Estado inválido. Válidos: ${ESTADOS.join(', ')}` });
    }

    // ── BLOQUEO: Orden Interna no se completa sin egreso definitivo ─────────
    // R-02-05: una OI no puede cerrarse hasta que tenga un egreso (no provisional)
    // asociado por número de orden.
    if (nuevoEstado === 'completada' && actual.tipoOrden === 'interna') {
      const snapEgr = await db.collection('egresos')
        .where('numeroOrdenInterna', '==', actual.numeroOrden)
        .get();
      const tieneDefinitivo = snapEgr.docs.some(d => {
        const e = d.data();
        return e.tipo !== 'provisional' && e.estado === 'PAGADO';
      });
      if (!tieneDefinitivo) {
        return res.status(400).json({
          error: 'No puedes cerrar esta orden interna sin el egreso definitivo (factura del proveedor + cuadre del vuelto).'
        });
      }
    }

    // ── BLOQUEO: Orden con extintor de préstamo no devuelto ─────────────────
    // Ola 2.5 Bloque 1: si la orden tiene un extintor de préstamo asignado al
    // cliente y NO se ha registrado su devolución, no se puede completar.
    // El extintor se quedaría perdido en el cliente.
    if ((nuevoEstado === 'completada' || nuevoEstado === 'cuadre_dinero') &&
        actual.extintorPrestamo && !actual.prestamoDevuelto) {
      return res.status(400).json({
        error: `No puedes cerrar esta orden sin recoger el extintor de préstamo (${actual.extintorPrestamo}). Marca la devolución desde Logística o la orden quedará en deuda con el cliente.`,
        prestamoPendiente: true,
        codigoPrestamo: actual.extintorPrestamo
      });
    }

    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    const facturaLimpia = numeroFactura ? numeroFactura.trim().toUpperCase()
                                        : (actual.numeroFactura || '');
    if (facturaLimpia) {
      cambios.numeroFactura = facturaLimpia;
      // La fecha de la factura = el día que se digita el N° por primera vez.
      // No se sobrescribe si la orden ya tenía factura.
      if (!actual.fechaFactura) cambios.fechaFactura = new Date().toISOString();
    }

    // ── VALIDACIÓN FACTURA DIAN — integral, cualquier flujo ──────────────────
    // Si la orden REQUIERE factura y no tiene N°, no puede avanzar a un estado
    // que la cierre o la mande a cartera. Esto incluye CxC con empresa con IVA
    // (una CxC con IVA igual necesita su factura DIAN — Error 4 corregido).
    const tallerActual = ordenTieneTaller(actual);
    const flujoOrden = construirFlujo(actual.lugarAtencion, actual.requiereFactura, tallerActual);
    const pasoDesdeActual = flujoOrden[actual.estado];

    // Estados donde la orden ya no debería seguir sin factura si la requiere.
    const estadosQueExigenFactura = [
      'facturado', 'completada', 'cxc', 'en_ruta_entrega',
      'entrega_cobranza', 'cuadre_dinero', 'listo_entregar'
    ];
    const cruzaFacturacion =
      nuevoEstado === 'facturado' ||
      actual.estado === 'facturado' ||
      estadosQueExigenFactura.includes(nuevoEstado) ||
      (pasoDesdeActual && pasoDesdeActual.requiereFacturaAntes);

    if (actual.requiereFactura && !facturaLimpia && cruzaFacturacion) {
      return res.status(400).json({
        error: 'Esta orden requiere número de factura DIAN antes de continuar.',
        requiereFactura: true,
        estadoActual: actual.estado
      });
    }

    // ── AVANCE AUTOMÁTICO EN CASCADA ──────────────────────────────────────────
    let estadoCursor = nuevoEstado;
    if (estadoCursor !== actual.estado) {
      historial.push({ estado: estadoCursor, fecha: ahora(), usuarioId, usuarioNombre, notas: notas || '' });
    }

    let guardia = 0;
    while (guardia++ < 12) {
      const flujo = construirFlujo(actual.lugarAtencion, actual.requiereFactura, tallerActual);
      const paso = flujo[estadoCursor];
      if (!paso) break;
      if (!paso.auto) break;
      if (paso.requiereFacturaAntes && !facturaLimpia) break;
      estadoCursor = paso.siguiente;
      historial.push({
        estado: estadoCursor, fecha: ahora(), usuarioId, usuarioNombre,
        notas: facturaLimpia ? `Avance automático (N° factura ${facturaLimpia})` : 'Avance automático del sistema'
      });
    }

    cambios.estado = estadoCursor;
    cambios.historialEstados = historial;

    // ── FIX Bug 3+4: ADMIN SIN MENSAJERO ──────────────────────────────────────
    // Si el flujo terminó en 'cuadre_dinero' pero NO hay mensajero asignado,
    // significa que admin/tesorería avanzó la orden directamente sin que un
    // mensajero la operara. En ese caso no hay a quién cuadrar con PIN, así que:
    //   - Saltamos a 'completada' directamente
    //   - Si era efectivo y está pagada, registramos el movimiento en caja
    //     'Efectivo' (no requiere PIN porque no hay mensajero)
    //   - Si era virtual, simplemente cerramos (la validación quedó pendiente
    //     por separado o ya se hizo en /api/orders/:id/pago)
    if (estadoCursor === 'cuadre_dinero' && !actual.mensajeroId && !actual.trabajadorAsignadoId) {
      // Saltar a completada
      estadoCursor = 'completada';
      cambios.estado = 'completada';
      historial.push({
        estado: 'completada', fecha: ahora(), usuarioId, usuarioNombre,
        notas: 'Cierre automático (sin mensajero — no requiere cuadre)'
      });
      cambios.historialEstados = historial;
      cambios.fechaCompletada = ahora();

      // Si fue pagada en efectivo, registrar movimiento en caja "Efectivo"
      const esEfectivoPagado = actual.pagado === true
        && /efectivo/i.test(actual.formaPago || '');

      if (esEfectivoPagado) {
        try {
          // Buscar caja "Efectivo" del admin (case insensitive)
          const cajasSnap = await db.collection('cajas')
            .where('userId', '==', usuarioId).get();
          const cajaEfectivo = cajasSnap.docs.find(d => {
            const c = d.data();
            return /efectivo/i.test(c.nombre || '') && c.activa !== false;
          });

          if (cajaEfectivo) {
            const cajaId = cajaEfectivo.id;
            const cajaData = cajaEfectivo.data();
            const monto = Number(actual.total) || 0;

            // Registrar movimiento de ingreso
            await db.collection('movimientos').add({
              userId: usuarioId,
              cajaId,
              cajaNombre: cajaData.nombre,
              tipo: 'ingreso',
              monto,
              concepto: `Pago ${actual.numeroOrden} — ${actual.clienteNombre || ''}`,
              referencia: actual.numeroOrden,
              ordenId: id,
              fecha: ahora(),
              registradoPor: usuarioNombre,
              registradoPorId: usuarioId,
              tipoMovimiento: 'pago_orden_sin_mensajero',
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            // Actualizar saldo de la caja
            await db.collection('cajas').doc(cajaId).update({
              saldo: admin.firestore.FieldValue.increment(monto),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`[orders] Cierre admin sin mensajero: $${monto} a caja "${cajaData.nombre}" para ${actual.numeroOrden}`);
          } else {
            console.warn(`[orders] No se encontró caja "Efectivo" activa para registrar pago de ${actual.numeroOrden}. El admin debe registrarlo manualmente.`);
          }
        } catch (errCaja) {
          console.error(`[orders] Error registrando movimiento en caja para ${actual.numeroOrden}:`, errCaja.message);
          // No bloqueamos la finalización por esto. Solo logueamos.
        }
      }
    }

    if ((estadoCursor === 'cuadre_dinero' || estadoCursor === 'completada')
        && actual.generaCertificado && !actual.certificadoGenerado) {
      cambios.certificadoGenerado = true;
      cambios.certificadoFecha = ahora();
      const proximoAño = new Date();
      proximoAño.setFullYear(proximoAño.getFullYear() + 1);
      cambios.alertaRenovacion = proximoAño.toISOString();
    }

    // ── Ola 2.5 Bloque 2: cuando una OP se completa ─────────────────────────
    // 1) Suma cada producto terminado al stock (composición inversa).
    //    Antes solo se descontaban los componentes pero el terminado nunca
    //    aparecía en bodega.
    // 2) Genera un QR por cada unidad producida (queda "sin asignar" hasta
    //    que se venda).
    let qrGenerados = 0;
    if (actual.tipoOrden === 'produccion' &&
        (estadoCursor === 'completada' || estadoCursor === 'cuadre_dinero') &&
        actual.estado !== 'completada' && actual.estado !== 'cuadre_dinero') {

      // 1) Sumar stock del producto terminado
      for (const item of (actual.items || [])) {
        if (!item.productoId) continue;
        const cant = Number(item.cantidad) || 0;
        if (cant <= 0) continue;
        try {
          await db.collection('products').doc(item.productoId).update({
            stock: admin.firestore.FieldValue.increment(cant)
          });
        } catch (e) {
          console.error(`Error sumando stock de ${item.productoId}:`, e.message);
        }
      }

      // 2) Generar un QR por cada unidad producida (sin propietario)
      const adminIdQR = req.adminId || userId;
      for (const item of (actual.items || [])) {
        if (!item.productoId) continue;
        const cant = Number(item.cantidad) || 0;
        for (let i = 0; i < cant; i++) {
          try {
            // Código QR consecutivo por admin: QR-PRO-XXXX
            const counterRef = db.collection('counters').doc(`${adminIdQR}_qr_produccion`);
            const num = await db.runTransaction(async tx => {
              const doc = await tx.get(counterRef);
              const v = doc.exists ? (Number(doc.data().value) || 0) : 0;
              const nuevo = v + 1;
              tx.set(counterRef, { value: nuevo, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
              return nuevo;
            });
            const codigoQR = `QR-PRO-${String(num).padStart(4, '0')}`;

            await db.collection('qr_equipos').add({
              codigoQR,
              productoId: item.productoId,
              productoNombre: item.nombre,
              estado: 'sin_asignar',
              origen: 'produccion',
              ordenProduccionId: id,
              ordenProduccionNumero: actual.numeroOrden,
              adminId: adminIdQR,
              fechaProduccion: ahora(),
              propietario: null,
              clienteId: null,
              historial: [{
                fecha: ahora(),
                evento: 'Producido',
                ordenId: id,
                ordenNumero: actual.numeroOrden,
                usuarioId, usuarioNombre
              }],
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            qrGenerados++;
          } catch (e) {
            console.error('Error generando QR auto:', e.message);
          }
        }
      }

      cambios.qrGenerados = qrGenerados;
      cambios.produccionCompletadaEn = ahora();
    }

    await ordenRef.update(cambios);

    await auditar({
      accion: 'CAMBIO_ESTADO_ORDEN',
      descripcion: `${usuarioNombre} avanzó ${actual.numeroOrden}: ${ESTADO_LABELS[actual.estado] || actual.estado} → ${ESTADO_LABELS[estadoCursor] || estadoCursor}`,
      usuarioId, usuarioNombre, ordenId: id,
      datos: { estadoAnterior: actual.estado, estadoNuevo: estadoCursor, numeroFactura: facturaLimpia, notas, qrGenerados }
    });

    res.json({ id, estado: estadoCursor, historialEstados: historial });
  } catch (error) {
    console.error('Error cambiando estado:', error);
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/orders/:id/pago — Registrar pago (anti-recobro + avance auto)
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:id/pago', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { montoPagado, formaPago, notas, numeroFactura } = req.body;

    const ordenRef = db.collection('orders').doc(id);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const actual = ordenDoc.data();
    const usuarioId = req.adminId || req.user.uid || req.user.id;
    const usuarioNombre = req.user.nombre || req.user.email;

    const esCxC = formaPago === 'A crédito (CxC)' || formaPago === 'A crédito'
      || formaPago === 'credito' || formaPago === 'CXC';

    // ── BLOQUEO ANTI-RECOBRO ──────────────────────────────────────────────────
    if (!esCxC && (actual.pagado === true || actual.dineroEnCaja === true)) {
      return res.status(409).json({
        error: 'Esta orden ya está pagada. No se puede cobrar de nuevo.',
        yaPagada: true, pagado: true
      });
    }

    // ── BLOQUEO: orden que va por ruta del mensajero ──────────────────────────
    const lugar = normalizarLugar(actual.lugarAtencion);
    const vaPorRuta = (lugar === 'domicilio' || lugar === 'despacho' || lugar === 'cobranza')
      && actual.mensajeroId
      && !['cuadre_dinero', 'completada'].includes(actual.estado);
    if (!esCxC && vaPorRuta && req.user.role !== 'admin') {
      return res.status(409).json({
        error: 'Esta orden se cobra en el cuadre del mensajero, no desde aquí.',
        cobroPorMensajero: true
      });
    }

    const montoFinal = parseFloat(montoPagado) || actual.total;
    if (montoFinal < actual.total * 0.5 && req.user.role !== 'admin') {
      return res.status(400).json({ error: 'El monto es muy bajo. Requiere autorización del administrador.' });
    }

    const facturaLimpia = numeroFactura ? numeroFactura.trim().toUpperCase()
                                        : (actual.numeroFactura || '');

    const updateOrden = {
      pagado: !esCxC,
      montoPagado: esCxC ? 0 : montoFinal,
      formaPago,
      notasPago: notas || '',
      fechaPago: esCxC ? null : new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (facturaLimpia) {
      updateOrden.numeroFactura = facturaLimpia;
      if (!actual.fechaFactura) updateOrden.fechaFactura = new Date().toISOString();
    }
    // Ola 2.5 — NO cambiamos estado aquí. El estado solo se mueve por flujo.
    await ordenRef.update(updateOrden);

    const resultadoCaja = await registrarIngresoEnCaja({
      userId: usuarioId,
      ordenId: id,
      numeroOrden: actual.numeroOrden,
      clienteNombre: actual.clienteNombre,
      monto: montoFinal,
      formaPago,
      usuarioEmail: req.user.email,
      numeroFactura: facturaLimpia
    });

    // ── Ola 2.5 REGLA RAÍZ: el pago NO mueve el estado del servicio ─────────
    // Pago y servicio son dos dimensiones separadas. El pago solo marca la
    // orden como pagada; el estado solo avanza con el flujo operativo.
    //
    // ÚNICA excepción: si la orden ya está en 'entrega_cobranza' (mensajero
    // entregó y pidió el dinero), y el pago confirma esa cobranza, entonces
    // sí se completa porque el ciclo operativo terminó.
    let estadoFinal = actual.estado;
    if (esCxC) {
      // CxC explícita: marca el flag pero NO cambia estado.
      // (El estado seguirá moviéndose por el flujo del mensajero.)
      estadoFinal = actual.estado;
    } else if (actual.estado === 'entrega_cobranza') {
      // La orden estaba justo en cobranza: el pago la cierra.
      await ordenRef.update({
        estado: 'completada',
        historialEstados: admin.firestore.FieldValue.arrayUnion({
          estado: 'completada', fecha: new Date().toISOString(),
          usuarioId, usuarioNombre,
          notas: `Pago registrado en cobranza — ${formaPago}`
        }),
        ...(actual.generaCertificado && !actual.certificadoGenerado ? {
          certificadoGenerado: true,
          certificadoFecha: new Date().toISOString()
        } : {})
      });
      estadoFinal = 'completada';
    }

    await auditar({
      accion: 'REGISTRAR_PAGO',
      descripcion: `${usuarioNombre} registró pago $${montoFinal?.toLocaleString()} en ${actual.numeroOrden} — ${formaPago}`,
      usuarioId, usuarioNombre, ordenId: id,
      datos: { montoPagado: montoFinal, formaPago, totalOrden: actual.total, resultadoCaja, estadoFinal }
    });

    res.json({
      message: 'Pago registrado',
      montoPagado: montoFinal,
      formaPago,
      estado: estadoFinal,
      caja: resultadoCaja
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/orders/:id/validar-pago — Admin/Tesorería valida pago electrónico
// ─────────────────────────────────────────────────────────────────────────────
// Ola 2.5 Bloque 1: cuando el mensajero recibe un pago electrónico (transferencia,
// Nequi, datafono), sube la foto del comprobante. Admin/Tesorería verifica en
// el banco y aquí aprueba o rechaza:
//   - APROBADO  → suma a la caja, queda pagado, orden COMPLETADA.
//   - RECHAZADO → la orden pasa a CxC (el cliente debe ese dinero).
//
// Requiere PIN del usuario validador.
//
// Body: { aprobado: bool, motivo: string, pin: string }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:id/validar-pago', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { aprobado, motivo = '', pin } = req.body;

    // Solo Admin o Tesorería
    if (!['admin', 'tesoreria'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Solo Admin o Tesorería pueden validar pagos electrónicos' });
    }

    // Verificar PIN
    const userId = req.user.uid || req.user.id;
    const pinCheck = await verificarPinUsuario(userId, pin);
    if (!pinCheck.ok) return res.status(403).json({ error: pinCheck.error });

    const ordenRef = db.collection('orders').doc(id);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();

    // Aislamiento multi-tenant
    const adminId = req.adminId || userId;
    if (orden.adminId && orden.adminId !== adminId) {
      return res.status(403).json({ error: 'No tienes acceso a esta orden' });
    }

    // Validar que la orden tenga un pago electrónico pendiente
    if (orden.pagoValidado === true) {
      return res.status(400).json({ error: 'Este pago ya fue validado anteriormente' });
    }
    if (!orden.formaPago || orden.formaPago === 'Efectivo' || orden.formaPago === 'A crédito (CxC)') {
      return res.status(400).json({ error: 'Esta orden no requiere validación de pago electrónico' });
    }

    const usuarioNombre = req.user.nombre || req.user.email;
    const ahora = new Date().toISOString();

    if (aprobado) {
      // ── APROBAR ─────────────────────────────────────────────────────────────
      // Ola 2.5 REGLA: el pago se confirma → dinero entra a caja → marca pagado.
      // PERO el estado del servicio solo se completa si la orden YA estaba
      // en entrega_cobranza. Si todavía está en recogida/taller/entrega, el
      // estado sigue su curso normal.
      const cerrarPorCobranza = orden.estado === 'entrega_cobranza';

      const updateAprobar = {
        pagoValidado: true,
        pagoValidadoPor: userId,
        pagoValidadoPorNombre: usuarioNombre,
        pagoValidadoEn: ahora,
        pagoValidacionMotivo: motivo || '',
        pagoVirtualPendienteValidar: false,    // Ola 2.5 FIX: quitar bandera
        pagado: true,
        montoPagado: orden.total || 0,
        fechaPago: ahora,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (cerrarPorCobranza) {
        updateAprobar.estado = 'completada';
        updateAprobar.historialEstados = admin.firestore.FieldValue.arrayUnion({
          estado: 'completada',
          fecha: ahora,
          usuarioId: userId,
          usuarioNombre,
          accion: 'PAGO_VALIDADO_APROBADO_CIERRA_COBRANZA'
        });
      } else {
        // Solo registrar la aprobación en historial, sin cambiar estado.
        updateAprobar.historialEstados = admin.firestore.FieldValue.arrayUnion({
          estado: orden.estado,  // mismo estado
          fecha: ahora,
          usuarioId: userId,
          usuarioNombre,
          accion: 'PAGO_VALIDADO_APROBADO',
          nota: 'El pago fue aprobado. El servicio sigue su flujo.'
        });
      }
      await ordenRef.update(updateAprobar);

      // FIX Ola 2.5: ahora el dinero SÍ entra a caja en este momento.
      // Antes el flag dineroEnCaja podía estar en true de forma incorrecta
      // (cuando el mensajero avanzaba con pago virtual). Con los fixes en
      // logistics.js esa bandera ya no se pone en virtual, así que aquí
      // siempre se llama a registrarIngresoEnCaja para la entrada real.
      let caja = null;
      caja = await registrarIngresoEnCaja({
        userId: adminId,
        ordenId: id,
        numeroOrden: orden.numeroOrden,
        clienteNombre: orden.clienteNombre,
        monto: orden.total || 0,
        formaPago: orden.formaPago,
        usuarioEmail: req.user.email,
        numeroFactura: orden.numeroFactura || ''
      }).catch((e) => { console.error('Caja virtual:', e); return null; });

      await auditar({
        accion: 'PAGO_ELECTRONICO_APROBADO',
        descripcion: `${usuarioNombre} aprobó el pago electrónico de ${orden.numeroOrden} (${orden.formaPago})`,
        usuarioId: userId, usuarioNombre, ordenId: id,
        documento: orden.numeroOrden,
        datos: { motivo, monto: orden.total, formaPago: orden.formaPago }
      });

      return res.json({ ok: true, aprobado: true, estado: cerrarPorCobranza ? 'completada' : orden.estado, caja });

    } else {
      // ── RECHAZAR ────────────────────────────────────────────────────────────
      // El comprobante no fue válido (no llegó al banco, monto incorrecto, etc).
      // La orden pasa a CxC: el cliente queda debiendo este dinero.
      if (!motivo || motivo.trim().length < 5) {
        return res.status(400).json({ error: 'El motivo de rechazo es obligatorio (mínimo 5 caracteres)' });
      }

      await ordenRef.update({
        pagoValidado: false,
        pagoRechazado: true,
        pagoValidadoPor: userId,
        pagoValidadoPorNombre: usuarioNombre,
        pagoValidadoEn: ahora,
        pagoValidacionMotivo: motivo.trim(),
        pagado: false,
        montoPagado: 0,
        fechaPago: null,
        estado: 'cxc',
        historialEstados: admin.firestore.FieldValue.arrayUnion({
          estado: 'cxc',
          fecha: ahora,
          usuarioId: userId,
          usuarioNombre,
          accion: 'PAGO_VALIDADO_RECHAZADO',
          notas: motivo.trim()
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await auditar({
        accion: 'PAGO_ELECTRONICO_RECHAZADO',
        descripcion: `${usuarioNombre} rechazó el pago electrónico de ${orden.numeroOrden}: ${motivo}`,
        usuarioId: userId, usuarioNombre, ordenId: id,
        documento: orden.numeroOrden,
        datos: { motivo, monto: orden.total, formaPago: orden.formaPago }
      });

      return res.json({ ok: true, aprobado: false, estado: 'cxc', motivo });
    }
  } catch (error) {
    console.error('Error validando pago:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/certificado', authenticate, async (req, res) => {
  try {
    const ordenDoc = await db.collection('orders').doc(req.params.id).get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = { id: ordenDoc.id, ...ordenDoc.data() };
    if (!orden.generaCertificado) {
      return res.status(400).json({ error: 'Esta orden no genera certificado' });
    }

    let empresa = {};
    if (orden.empresaId) {
      const empDoc = await db.collection('companies').doc(orden.empresaId).get();
      if (empDoc.exists) empresa = empDoc.data();
    }

    const itemsRecarga = orden.items.filter(i => {
      const cat = (i.categoria || '').toLowerCase();
      return cat.includes('recarga') || cat.includes('mantenimiento');
    });
    const itemsPH = orden.items.filter(i => {
      const cat = (i.categoria || '').toLowerCase();
      return cat.includes('prueba') || cat.includes('hidrost') || cat.includes(' ph');
    });

    res.json({ orden, empresa, itemsRecarga, itemsPH, fechaGeneracion: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/:id/certificado/html — HTML imprimible del certificado
// ─────────────────────────────────────────────────────────────────────────────
// Ola 2: Reemplaza la generación de certificado, que antes solo marcaba el flag
// `certificadoGenerado: true`. Ahora devuelve un HTML completo, profesional,
// listo para imprimir desde el navegador (Ctrl+P) o exportar como PDF.
//
// Reglas:
//   - Solo órdenes con generaCertificado: true.
//   - El admin puede haber configurado N categorías distintas; este endpoint
//     genera UN certificado por cada categoría que tenga ítems en la orden.
//   - Si la orden tiene recarga + PH, devuelve 2 certificados en la misma página.
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:id/certificado/html', authenticate, async (req, res) => {
  try {
    const ordenDoc = await db.collection('orders').doc(req.params.id).get();
    if (!ordenDoc.exists) {
      return res.status(404).type('html').send('<h1>Orden no encontrada</h1>');
    }

    const orden = { id: ordenDoc.id, ...ordenDoc.data() };
    if (!orden.generaCertificado) {
      return res.status(400).type('html').send('<h1>Esta orden no genera certificado</h1>');
    }

    // ── Cargar empresa
    let empresa = {};
    if (orden.empresaId) {
      const empDoc = await db.collection('companies').doc(orden.empresaId).get();
      if (empDoc.exists) empresa = empDoc.data();
    }

    // ── Cargar configuración de certificados del admin
    const adminId = req.adminId || req.user.uid || req.user.id;
    const configDoc = await db.collection('certificados_config').doc(adminId).get();
    const categoriasConfig = (configDoc.exists ? (configDoc.data().categorias || []) : [])
      .filter(c => c.activo !== false);

    // ── Para cada categoría configurada, agrupar los ítems de la orden
    // que coincidan con esa categoria (matching parcial, case-insensitive)
    const certificados = categoriasConfig.map(cat => {
      const items = (orden.items || []).filter(item => {
        const catItem = (item.categoria || '').toLowerCase();
        const catCfg = (cat.categoriaProducto || '').toLowerCase();
        return catItem && catCfg && catItem.includes(catCfg.split(' ')[0]);
      });
      return { config: cat, items };
    }).filter(c => c.items.length > 0);

    // Si no hay coincidencias con la config del admin, no hay certificado.
    if (certificados.length === 0) {
      return res.status(400).type('html').send(
        '<h1>No hay categorías configuradas que coincidan con los items de esta orden.</h1>' +
        '<p>Configura las categorías de certificado en Mi Empresa → Certificados.</p>'
      );
    }

    // ── Marcar generado (idempotente)
    if (!orden.certificadoGenerado) {
      await db.collection('orders').doc(req.params.id).update({
        certificadoGenerado: true,
        certificadoFecha: new Date().toISOString()
      });
    }

    const fechaCol = new Date(orden.fechaCompletada || orden.completadaEn || new Date())
      .toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Bogota' });

    // ── Escapar HTML para evitar XSS (clientes pueden tener nombres con < o &)
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

    // ── Generar un bloque por certificado
    const bloques = certificados.map((cert, idx) => {
      const filasItems = cert.items.map((it, i) => `
        <tr>
          <td style="border:1px solid #999; padding:6px; text-align:center;">${i + 1}</td>
          <td style="border:1px solid #999; padding:6px;">${esc(it.nombre)}</td>
          <td style="border:1px solid #999; padding:6px; text-align:center;">${esc(it.cantidad)}</td>
          <td style="border:1px solid #999; padding:6px;">${esc(it.serial || it.notas || '—')}</td>
        </tr>
      `).join('');

      const contenidoHTML = esc(cert.config.contenido || '').replace(/\n/g, '<br>');

      return `
        <section style="page-break-after: ${idx < certificados.length - 1 ? 'always' : 'auto'};
                        padding: 30px 40px; font-family: 'Georgia', 'Times New Roman', serif; color: #1a1a1a;">

          <!-- Cabecera empresa -->
          <header style="display:flex; gap:20px; align-items:center; border-bottom: 3px solid #7c3aed; padding-bottom:14px; margin-bottom:24px;">
            ${empresa.logo ? `<img src="${esc(empresa.logo)}" alt="logo" style="max-height:70px; max-width:140px; object-fit:contain;">` : ''}
            <div style="flex:1;">
              <h2 style="margin:0; font-size:20px; color:#7c3aed; letter-spacing:0.5px;">${esc(empresa.name || 'Empresa')}</h2>
              <p style="margin:4px 0 0; font-size:11px; color:#555; line-height:1.5;">
                NIT ${esc(empresa.nit || '')} &nbsp;·&nbsp; ${esc(empresa.address || '')}<br>
                Tel ${esc(empresa.phone || '')} &nbsp;·&nbsp; ${esc(empresa.email || '')}
              </p>
            </div>
            <div style="text-align:right; font-size:11px; color:#666;">
              <div style="font-weight:bold; color:#7c3aed; font-size:13px;">${esc(orden.numeroOrden)}</div>
              <div>${fechaCol}</div>
            </div>
          </header>

          <!-- Título del certificado -->
          <h1 style="text-align:center; font-size:24px; margin:30px 0 6px; letter-spacing:1px; color:#1a1a1a;">
            ${esc(cert.config.nombreDocumento || 'Certificado')}
          </h1>
          ${cert.config.norma ? `<p style="text-align:center; font-size:12px; color:#666; margin:0 0 30px;">Norma técnica de referencia: <strong>${esc(cert.config.norma)}</strong></p>` : ''}

          <!-- Datos del cliente -->
          <div style="background:#f9f5ff; border-left:4px solid #7c3aed; padding:14px 18px; margin-bottom:24px; font-size:13px;">
            <div style="margin-bottom:6px;"><strong>Cliente:</strong> ${esc(orden.clienteNombre || '—')}</div>
            <div style="margin-bottom:6px;"><strong>NIT / C.C.:</strong> ${esc(orden.clienteNit || '—')}</div>
            ${orden.sucursalNombre ? `<div style="margin-bottom:6px;"><strong>Sucursal:</strong> ${esc(orden.sucursalNombre)}</div>` : ''}
            ${orden.sucursalDireccion ? `<div><strong>Dirección de instalación:</strong> ${esc(orden.sucursalDireccion)}</div>` : ''}
          </div>

          <!-- Texto legal -->
          <p style="text-align:justify; line-height:1.7; font-size:13px; margin-bottom:24px;">
            ${esc(cert.config.texto || '')}
          </p>

          <!-- Tabla de ítems -->
          <table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:24px;">
            <thead>
              <tr style="background:#7c3aed; color:white;">
                <th style="border:1px solid #7c3aed; padding:8px; width:50px;">#</th>
                <th style="border:1px solid #7c3aed; padding:8px; text-align:left;">Descripción del servicio / equipo</th>
                <th style="border:1px solid #7c3aed; padding:8px; width:80px;">Cantidad</th>
                <th style="border:1px solid #7c3aed; padding:8px; width:160px;">Serial / Observación</th>
              </tr>
            </thead>
            <tbody>${filasItems}</tbody>
          </table>

          <!-- Procedimientos aplicados -->
          ${contenidoHTML ? `
            <div style="background:#f5f5f5; border-radius:6px; padding:14px 18px; margin-bottom:30px; font-size:12px; line-height:1.7;">
              <strong style="display:block; margin-bottom:6px; color:#7c3aed;">Procedimientos aplicados:</strong>
              ${contenidoHTML}
            </div>
          ` : ''}

          <!-- Firmas -->
          <div style="display:flex; justify-content:space-between; gap:60px; margin-top:60px; font-size:12px;">
            <div style="flex:1; text-align:center; border-top:1px solid #333; padding-top:8px;">
              <strong>Técnico responsable</strong><br>
              <span style="color:#666;">${esc(orden.tecnicoNombre || 'Pedro García')}</span>
            </div>
            <div style="flex:1; text-align:center; border-top:1px solid #333; padding-top:8px;">
              <strong>Supervisor técnico</strong><br>
              <span style="color:#666;">Milena Botero</span>
            </div>
          </div>

          <!-- Pie -->
          <p style="text-align:center; font-size:10px; color:#999; margin-top:40px;">
            Documento generado el ${fechaCol} · ${esc(empresa.name || '')} · ${esc(orden.numeroOrden)}
          </p>
        </section>
      `;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Certificado ${esc(orden.numeroOrden)} — ${esc(orden.clienteNombre || '')}</title>
  <style>
    @page { size: A4; margin: 0; }
    body { margin: 0; background: #f5f5f5; }
    @media print {
      body { background: #fff; }
      .no-print { display: none !important; }
    }
    .toolbar {
      position: sticky; top: 0; background: #1f2937; color: white;
      padding: 12px 24px; display: flex; gap: 12px; align-items: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); z-index: 100;
    }
    .toolbar button {
      padding: 8px 18px; background: #7c3aed; color: white; border: none;
      border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px;
    }
    .toolbar button:hover { background: #6d28d9; }
    .toolbar .info { margin-left: auto; font-size: 12px; opacity: 0.75; }
    .page {
      max-width: 210mm; margin: 20px auto; background: white;
      box-shadow: 0 2px 12px rgba(0,0,0,0.1);
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <button onclick="window.print()">🖨 Imprimir / Guardar PDF</button>
    <button onclick="window.close()" style="background:#6b7280;">Cerrar</button>
    <span class="info">Certificado ${esc(orden.numeroOrden)} · ${esc(orden.clienteNombre || '')}</span>
  </div>
  <div class="page">
    ${bloques}
  </div>
</body>
</html>`;

    res.type('html').send(html);
  } catch (error) {
    console.error('Error generando HTML certificado:', error);
    res.status(500).type('html').send(`<h1>Error</h1><pre>${String(error.message)}</pre>`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/stats/resumen — Dashboard
// ══════════════════════════════════════════════════════════════════════════════
router.get('/stats/resumen', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('orders').get();
    const stats = { total: 0, programadas: 0, enTaller: 0, facturadas: 0, completadas: 0, totalIngresos: 0 };
    snap.forEach(doc => {
      const d = doc.data();
      stats.total++;
      if (d.estado === 'programada') stats.programadas++;
      if (d.estado === 'en_taller') stats.enTaller++;
      if (d.estado === 'facturado') stats.facturadas++;
      if (d.estado === 'cuadre_dinero' || d.estado === 'completada') {
        stats.completadas++;
        stats.totalIngresos += d.total || 0;
      }
    });
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/orders/:id/agregar-items
// ─────────────────────────────────────────────────────────────────────────────
// Ola 2 — Frente 3: el mensajero está donde el cliente y este le pide cosas
// adicionales (más extintores, señalización, botiquines). En lugar de llamar a
// Sandra/Carlos para que editen la orden, el mensajero los agrega él mismo.
//
// Validaciones de seguridad:
//   1. Aislamiento multi-tenant: solo el adminId dueño de la orden puede.
//   2. Solo el mensajero asignado a la orden, o admin/tesoreria, pueden agregar.
//   3. Solo se permite en estados intermedios (orden ya en manos del mensajero).
//      No se permite en programada/en_taller/anulada/completada/cuadre_dinero.
//   4. NO se aceptan items de categoría taller (recarga/mantenimiento/PH) — eso
//      sería "llevarse el equipo del cliente", flujo distinto que requiere
//      replanificación de la OS. Mensajero solo vende productos terminados.
//   5. Cada item debe tener productoId + cantidad > 0 + precioUnitario >= 0.
//   6. Si el producto tiene stockMinimo definido y la cantidad lo agotaría
//      bajo 0, se rechaza con error claro.
//
// Efectos al ejecutarse:
//   - Recalcula subtotal / iva / total de la orden con los nuevos items.
//   - Descuenta inventario inmediato.
//   - Registra en historialEstados un evento "ITEMS_AGREGADOS".
//   - Audita con documento = numeroOrden y lista de items agregados.
//
// Body esperado:
//   { items: [ { productoId, nombre, categoria, cantidad, precioUnitario,
//                descuento?, notas?, serial? } ] }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:id/agregar-items', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { items: itemsNuevos } = req.body;

    if (!Array.isArray(itemsNuevos) || itemsNuevos.length === 0) {
      return res.status(400).json({ error: 'Debes enviar al menos un item' });
    }

    const ordenRef = db.collection('orders').doc(id);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();
    const userId       = req.user.uid || req.user.id;
    const userAdminId  = req.adminId || req.user.uid || req.user.id;
    const userRole     = req.user.role;
    const userNombre   = req.user.nombre || req.user.email;

    // ── Validación 1: aislamiento multi-tenant ───────────────────────────────
    if (orden.adminId && orden.adminId !== userAdminId) {
      return res.status(403).json({ error: 'No tienes acceso a esta orden' });
    }

    // ── Validación 2: permisos (mensajero asignado o admin/tesoreria) ────────
    const esMensajeroAsignado = orden.mensajeroId === userId;
    const esStaffAutorizado   = ['admin', 'tesoreria'].includes(userRole);
    if (!esMensajeroAsignado && !esStaffAutorizado) {
      return res.status(403).json({
        error: 'Solo el mensajero asignado o el administrador pueden agregar items'
      });
    }

    // ── Validación 3: estado de la orden ─────────────────────────────────────
    const ESTADOS_NO_PERMITIDOS = [
      'programada',         // todavía no salió del CRM
      'en_taller',          // está en taller, no en manos del mensajero
      'reparacion_proceso', // pausada por defecto
      'cuadre_dinero',      // ya cerrada
      'completada',         // ya cerrada
      'cxc',                // ya cerrada
      'anulada'             // anulada
    ];
    if (ESTADOS_NO_PERMITIDOS.includes(orden.estado)) {
      return res.status(400).json({
        error: `No puedes agregar items: la orden está en estado "${ESTADO_LABELS[orden.estado] || orden.estado}".`
      });
    }

    // ── Validación 4: nada de categoría taller ───────────────────────────────
    // No se aceptan recargas/mantenimiento porque eso significaría tener que
    // recoger el equipo del cliente y mandarlo a taller — flujo distinto.
    const itemsTaller = itemsNuevos.filter(esItemTaller);
    if (itemsTaller.length > 0) {
      return res.status(400).json({
        error: 'No puedes agregar items de taller (recarga, mantenimiento, prueba hidrostática) en sitio. Crea una orden nueva o coordina con la oficina.'
      });
    }

    // ── Validación 5: estructura de cada item + sanitizado ───────────────────
    const itemsSanitizados = [];
    for (const it of itemsNuevos) {
      if (!it.productoId || !it.nombre) {
        return res.status(400).json({ error: 'Cada item requiere productoId y nombre' });
      }
      const cant = Number(it.cantidad);
      const precio = Number(it.precioUnitario);
      if (!cant || cant <= 0) {
        return res.status(400).json({ error: `Cantidad inválida para ${it.nombre}` });
      }
      if (isNaN(precio) || precio < 0) {
        return res.status(400).json({ error: `Precio inválido para ${it.nombre}` });
      }

      // Validación 6: verificar stock real del producto
      try {
        const prodDoc = await db.collection('products').doc(it.productoId).get();
        if (prodDoc.exists) {
          const prod = prodDoc.data();
          if (prod.tieneStock && Number(prod.stock || 0) < cant) {
            return res.status(400).json({
              error: `Stock insuficiente para ${it.nombre}. Disponible: ${prod.stock || 0}, solicitado: ${cant}.`
            });
          }
        }
      } catch { /* si falla la lectura no bloqueamos — solo validación preventiva */ }

      itemsSanitizados.push({
        productoId:     it.productoId,
        nombre:         it.nombre,
        categoria:      it.categoria || '',
        cantidad:       cant,
        precioUnitario: precio,
        descuento:      Number(it.descuento) || 0,
        notas:          it.notas || '',
        serial:         it.serial || '',
        agregadoEnSitio:    true,
        agregadoPorId:      userId,
        agregadoPorNombre:  userNombre,
        agregadoEn:         new Date().toISOString()
      });
    }

    // ── Recalcular totales ───────────────────────────────────────────────────
    const itemsCompletos = [...(orden.items || []), ...itemsSanitizados];

    const calcSubtotal = (lista) => lista.reduce((s, x) => {
      const p = Number(x.precioUnitario) || 0;
      const c = Number(x.cantidad)       || 1;
      const d = Number(x.descuento)      || 0;
      return s + (p * c * (1 - d / 100));
    }, 0);

    const subtotal = calcSubtotal(itemsCompletos);

    // IVA: si la orden ya lo tenía calculado, usamos el mismo %
    const ivaPct = Number(orden.ivaPct) || 0;
    const ivaValor = subtotal * (ivaPct / 100);
    const total = subtotal + ivaValor;

    // ── Descontar inventario solo de los nuevos ──────────────────────────────
    await descontarInventario(itemsSanitizados, id);

    // ── Actualizar la orden ──────────────────────────────────────────────────
    const historial = orden.historialEstados || [];
    historial.push({
      estado: orden.estado, // se queda en el mismo estado
      fecha: new Date().toISOString(),
      usuarioId: userId,
      usuarioNombre: userNombre,
      accion: 'ITEMS_AGREGADOS_EN_SITIO',
      notas: `Mensajero agregó ${itemsSanitizados.length} item(s) en sitio. Subtotal: ${subtotal.toFixed(0)}`
    });

    await ordenRef.update({
      items: itemsCompletos,
      subtotal, ivaValor, total,
      historialEstados: historial,
      itemsAgregadosEnSitio: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ── Auditoría ────────────────────────────────────────────────────────────
    await auditar({
      accion: 'AGREGAR_ITEMS_EN_SITIO',
      descripcion: `${userNombre} agregó ${itemsSanitizados.length} item(s) a la orden ${orden.numeroOrden} en sitio (subtotal anterior ${(orden.subtotal || 0).toFixed(0)} → nuevo ${subtotal.toFixed(0)})`,
      usuarioId: userId, usuarioNombre: userNombre, ordenId: id,
      documento: orden.numeroOrden,
      datos: {
        itemsAgregados: itemsSanitizados.map(x => ({
          productoId: x.productoId, nombre: x.nombre, cantidad: x.cantidad, precio: x.precioUnitario
        })),
        subtotalAnterior: orden.subtotal || 0,
        subtotalNuevo: subtotal,
        totalAnterior: orden.total || 0,
        totalNuevo: total
      }
    });

    res.json({
      ok: true,
      id,
      items: itemsCompletos,
      itemsAgregados: itemsSanitizados,
      subtotal, ivaValor, total
    });
  } catch (error) {
    console.error('Error agregando items en sitio:', error);
    res.status(500).json({ error: error.message });
  }
});

// Exportar la máquina de estados para que logistics.js use LA MISMA lógica.
router.construirFlujo = construirFlujo;
router.pasoSiguiente = pasoSiguiente;
router.calcularEstadoInicial = calcularEstadoInicial;
router.normalizarLugar = normalizarLugar;
router.esItemTaller = esItemTaller;
router.contarEquiposTaller = contarEquiposTaller;
router.registrarIngresoEnCaja = registrarIngresoEnCaja;
router.verificarPinUsuario = verificarPinUsuario;

module.exports = router;
