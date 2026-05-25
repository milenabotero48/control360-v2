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

const calcularEstadoInicial = (lugarAtencion, requiereFactura, tieneEquipoTaller = true) => {
  const lugar = normalizarLugar(lugarAtencion);
  const T = tieneEquipoTaller !== false;
  if (lugar === 'oficina')    return requiereFactura ? 'facturado' : 'completada';
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
const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, ordenId, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'ordenes', descripcion,
      usuarioId, usuarioNombre, ordenId: ordenId || null, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

// ─── HELPER: generar número de orden ─────────────────────────────────────────
const generarNumeroOrden = async (tipo = 'servicio') => {
  const prefijo = tipo === 'interna' ? 'OI'
    : tipo === 'produccion' ? 'OP'
    : tipo === 'cxc' ? 'OCX' : 'OS';

  const snap = await db.collection('orders')
    .where('tipoOrden', '==', tipo)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  let siguiente = 1;
  if (!snap.empty) {
    const ultimo = snap.docs[0].data().numeroOrden || '';
    const num = parseInt(ultimo.replace(/\D/g, '').slice(-4));
    if (!isNaN(num)) siguiente = num + 1;
  }
  return `${prefijo}-${String(siguiente).padStart(4, '0')}`;
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

    let query = db.collection('orders').orderBy('createdAt', 'desc').limit(parseInt(limite));

    if (estado) query = db.collection('orders').where('estado', '==', estado).orderBy('createdAt', 'desc');
    if (tipoOrden) query = db.collection('orders').where('tipoOrden', '==', tipoOrden).orderBy('createdAt', 'desc');
    if (empresaId) query = db.collection('orders').where('empresaId', '==', empresaId).orderBy('createdAt', 'desc');

    if (req.user.role === 'mensajero') {
      query = db.collection('orders').where('mensajeroId', '==', req.adminId || req.user.uid).orderBy('createdAt', 'desc');
    }
    if (req.user.role === 'taller') {
      query = db.collection('orders').where('estado', 'in', ['en_taller']).orderBy('createdAt', 'desc');
    }

    const snap = await query.get();
    let ordenes = [];
    snap.forEach(doc => ordenes.push({ id: doc.id, ...doc.data() }));

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
      subtipoInterna
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

    const tipoFinal = esProduccion ? 'produccion' : (esInterna ? 'interna' : tipoOrden);
    const numeroOrden = await generarNumeroOrden(tipoFinal);

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

    const estadoInicial = esProduccion ? 'programada'
      : esCxc ? 'cxc'
      : calcularEstadoInicial(lugarAtencion, requiereFacturaFinal, tieneEquipoTaller);

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
      pagado: pagadoAlCrear,
      montoPagado: pagadoAlCrear ? Math.round(total) : 0,
      fechaPago: pagadoAlCrear ? new Date().toISOString() : null,
      dineroEnCaja: false,
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

    if (pagadoAlCrear) {
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
    const { nuevoEstado, notas, numeroFactura } = req.body;

    const ordenRef = db.collection('orders').doc(id);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const actual = ordenDoc.data();
    const historial = actual.historialEstados || [];
    const usuarioId = req.adminId || req.user.uid || req.user.id;
    const usuarioNombre = req.user.nombre || req.user.email;
    const ahora = () => new Date().toISOString();

    // ── ANULACIÓN ─────────────────────────────────────────────────────────────
    if (nuevoEstado === 'anulada') {
      if (actual.estado === 'anulada') return res.status(400).json({ error: 'La orden ya está anulada' });
      await devolverInventario(actual.items || []);
      historial.push({ estado: 'anulada', fecha: ahora(), usuarioId, usuarioNombre, notas: notas || '' });
      await ordenRef.update({ estado: 'anulada', historialEstados: historial, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await auditar({
        accion: 'CAMBIO_ESTADO_ORDEN',
        descripcion: `${usuarioNombre} anuló orden ${actual.numeroOrden}`,
        usuarioId, usuarioNombre, ordenId: id,
        datos: { estadoAnterior: actual.estado, estadoNuevo: 'anulada', notas }
      });
      return res.json({ id, estado: 'anulada', historialEstados: historial });
    }

    if (!ESTADOS.includes(nuevoEstado)) {
      return res.status(400).json({ error: `Estado inválido. Válidos: ${ESTADOS.join(', ')}` });
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

    if ((estadoCursor === 'cuadre_dinero' || estadoCursor === 'completada')
        && actual.generaCertificado && !actual.certificadoGenerado) {
      cambios.certificadoGenerado = true;
      cambios.certificadoFecha = ahora();
      const proximoAño = new Date();
      proximoAño.setFullYear(proximoAño.getFullYear() + 1);
      cambios.alertaRenovacion = proximoAño.toISOString();
    }

    await ordenRef.update(cambios);

    await auditar({
      accion: 'CAMBIO_ESTADO_ORDEN',
      descripcion: `${usuarioNombre} avanzó ${actual.numeroOrden}: ${ESTADO_LABELS[actual.estado] || actual.estado} → ${ESTADO_LABELS[estadoCursor] || estadoCursor}`,
      usuarioId, usuarioNombre, ordenId: id,
      datos: { estadoAnterior: actual.estado, estadoNuevo: estadoCursor, numeroFactura: facturaLimpia, notas }
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
    if (esCxC) updateOrden.estado = 'cxc';
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

    // ── AVANCE AUTOMÁTICO TRAS EL PAGO ────────────────────────────────────────
    let estadoFinal = esCxC ? 'cxc' : actual.estado;
    if (!esCxC) {
      const historial = actual.historialEstados || [];
      let cursor = actual.estado;
      let guardia = 0;
      const tallerPago = ordenTieneTaller(actual);
      while (guardia++ < 12) {
        const flujo = construirFlujo(actual.lugarAtencion, actual.requiereFactura, tallerPago);
        const paso = flujo[cursor];
        if (!paso || !paso.auto) break;
        if (paso.requiereFacturaAntes && !facturaLimpia) break;
        cursor = paso.siguiente;
        historial.push({
          estado: cursor, fecha: new Date().toISOString(),
          usuarioId, usuarioNombre,
          notas: `Avance automático tras pago${facturaLimpia ? ` (factura ${facturaLimpia})` : ''}`
        });
      }
      if (cursor !== actual.estado) {
        const cierre = { estado: cursor, historialEstados: historial };
        if ((cursor === 'completada' || cursor === 'cuadre_dinero')
            && actual.generaCertificado && !actual.certificadoGenerado) {
          cierre.certificadoGenerado = true;
          cierre.certificadoFecha = new Date().toISOString();
        }
        await ordenRef.update(cierre);
        estadoFinal = cursor;
      }
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
// GET /api/orders/:id/certificado — Datos para certificado
// ══════════════════════════════════════════════════════════════════════════════
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

// Exportar la máquina de estados para que logistics.js use LA MISMA lógica.
router.construirFlujo = construirFlujo;
router.pasoSiguiente = pasoSiguiente;
router.calcularEstadoInicial = calcularEstadoInicial;
router.normalizarLugar = normalizarLugar;
router.esItemTaller = esItemTaller;
router.contarEquiposTaller = contarEquiposTaller;
router.registrarIngresoEnCaja = registrarIngresoEnCaja;

module.exports = router;
