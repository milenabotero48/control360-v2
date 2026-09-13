// ============================================================
// Control360 — Anny · MOTOR v3 · contexto.js
// Ubicación: backend/services/anny/contexto.js
// ============================================================
// ANNY-V3-CONTEXTO: hechos verificables del sistema que se le dan
// al modelo. SOLO LECTURA salvo `registrarPagoReportado` (aditivo).
//   - ficha del cliente (clients) + vencimientos + cartera
//   - órdenes de servicio (orders)
//   - pedido abierto del hilo (pedidosAnny)
//   - pago reportado (campo informativo en la orden)
// Todo filtrado por adminId. Ante error devuelve vacío: el
// contexto enriquece, nunca bloquea.
// ============================================================

const { db } = require('../../config/firebase');
const { normalizarTelefono } = require('./texto');

// ============================================================
// Ficha del cliente (ANNY-CLIENTE-005 + ANNY-CONTEXTO-019)
// ============================================================
async function buscarClienteEnBD(adminId, telefonoRaw) {
  try {
    const tel = normalizarTelefono(telefonoRaw);
    if (!tel || !adminId) return { existe: false };

    let snap = await db.collection('clients').where('adminId', '==', adminId).where('celular', '==', tel).limit(1).get();
    if (snap.empty) snap = await db.collection('clients').where('adminId', '==', adminId).where('telefono', '==', tel).limit(1).get();
    if (snap.empty) return { existe: false };

    const doc = snap.docs[0];
    const c = doc.data();
    const [vencimientos, saldoCxC] = await Promise.all([
      obtenerVencimientosCliente(adminId, doc.id),
      obtenerSaldoCxC(adminId, doc.id)
    ]);
    const sucursales = Array.isArray(c.sucursales)
      ? c.sucursales.map(s => ({ nombre: s.nombre || s.descripcion || '', direccion: s.direccion || '' })).filter(s => s.nombre || s.direccion)
      : [];

    return {
      existe: true,
      id: doc.id,
      nombre: c.nombre || '',
      nit: c.nit || '',
      tipoDocumento: c.tipoDocumento || '',
      correo: c.emailLegal || '',
      direccion: c.direccionPrincipal || '',
      ciudad: c.ciudad || '',
      empresaNombre: c.empresaNombre || '',
      sucursales,
      vencimientos,
      saldoCxC
    };
  } catch (err) {
    console.error('[ANNY] Error buscando cliente:', err.message);
    return { existe: false };
  }
}

async function obtenerVencimientosCliente(adminId, clienteId) {
  const vacio = { total: 0, vencidos: 0, proximos: 0, detalle: [] };
  try {
    if (!adminId || !clienteId) return vacio;
    const snap = await db.collection('vencimientos').where('adminId', '==', adminId).where('clienteId', '==', clienteId).limit(200).get();
    const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    const finDeMes = hoy.slice(0, 7) + '-31';
    let vencidos = 0, proximos = 0, total = 0;
    const detalle = [];
    snap.forEach(d => {
      const v = d.data();
      if (v.gestionado || !v.fechaVencimiento) return;
      const cant = Number(v.cantidad) || 1;
      total += cant;
      if (v.fechaVencimiento < hoy) vencidos += cant;
      else if (v.fechaVencimiento <= finDeMes) proximos += cant;
      if (detalle.length < 12) detalle.push({ equipo: v.descripcionEquipo || 'Equipo', cantidad: cant, fecha: v.fechaVencimiento, sucursal: v.sucursal || null });
    });
    return { total, vencidos, proximos, detalle };
  } catch (err) {
    console.error('[ANNY] Error leyendo vencimientos:', err.message);
    return vacio;
  }
}

// Misma lógica que cxc.js: cartera calculada desde orders.
async function obtenerSaldoCxC(adminId, clienteId) {
  try {
    if (!adminId || !clienteId) return { saldo: 0, facturas: 0 };
    const snap = await db.collection('orders').where('adminId', '==', adminId).where('clienteId', '==', clienteId).limit(300).get();
    const FORMAS_CREDITO = ['CXC', 'A crédito (CxC)', 'A crédito'];
    let saldo = 0, facturas = 0;
    snap.forEach(d => {
      const o = d.data();
      if (o.estado === 'anulada') return;
      const esCredito = o.estado === 'cxc' || o.cxcEstado === 'parcial' || (FORMAS_CREDITO.includes(o.formaPago) && !o.pagado);
      if (!esCredito) return;
      const s = (Number(o.total) || 0) - (Number(o.montoPagado) || 0);
      if (s <= 0) return;
      saldo += s; facturas += 1;
    });
    return { saldo, facturas };
  } catch (err) {
    console.error('[ANNY] Error leyendo cartera:', err.message);
    return { saldo: 0, facturas: 0 };
  }
}

// ============================================================
// Órdenes de servicio (ANNY-ORDEN-046)
// ============================================================
const ESTADOS_ORDEN_LEGIBLE = {
  programada: 'Programada', taller: 'En taller', despacho: 'En despacho', facturar: 'Por facturar',
  completada: 'Completada', cxc: 'Completada (con saldo pendiente)', anulada: 'Anulada', descartada: 'Descartada'
};

async function _ordenesPorCelular(adminId, tel) {
  const vistos = new Set();
  const out = [];
  for (const v of [tel, `57${tel}`]) {
    const snap = await db.collection('orders').where('adminId', '==', adminId).where('clienteCelular', '==', v).limit(20).get();
    snap.forEach(d => {
      if (vistos.has(d.id)) return;
      vistos.add(d.id);
      out.push({ id: d.id, ref: d.ref, ...d.data() });
    });
  }
  return out;
}

async function obtenerOrdenesServicio(adminId, telefonoRaw) {
  try {
    const tel = normalizarTelefono(telefonoRaw);
    if (!tel || !adminId) return [];
    const ordenes = (await _ordenesPorCelular(adminId, tel))
      .filter(o => o.estado !== 'anulada')
      .map(o => ({
        numero: o.numeroOrden || '',
        estado: ESTADOS_ORDEN_LEGIBLE[o.estado] || o.estado || 'Sin estado',
        fechaProgramada: o.fechaProgramada || null,
        horaProgramada: o.horaProgramada || null,
        total: Number(o.total) || 0,
        saldo: Math.max(0, (Number(o.total) || 0) - (Number(o.montoPagado) || 0)),
        creadaMs: (o.createdAt?.seconds || 0) * 1000
      }))
      .sort((a, b) => b.creadaMs - a.creadaMs);
    return ordenes.slice(0, 3);
  } catch (err) {
    console.error('[ANNY] Error leyendo órdenes:', err.message);
    return [];
  }
}

// ============================================================
// Pago reportado (ANNY-PAGO-050) — aditivo, no mueve caja ni CxC
// ============================================================
async function registrarPagoReportado(adminId, telefonoRaw, datos) {
  try {
    const tel = normalizarTelefono(telefonoRaw);
    if (!tel || !adminId) return null;
    const candidatas = (await _ordenesPorCelular(adminId, tel))
      .filter(o => o.estado !== 'anulada')
      .map(o => ({ ref: o.ref, numero: o.numeroOrden || o.id, saldo: (Number(o.total) || 0) - (Number(o.montoPagado) || 0), creadaMs: (o.createdAt?.seconds || 0) * 1000 }));
    if (!candidatas.length) return null;
    candidatas.sort((a, b) => (b.saldo > 0) - (a.saldo > 0) || b.creadaMs - a.creadaMs);
    const elegida = candidatas[0];
    await elegida.ref.set({
      pagoReportadoAnny: {
        reportadoMs: Date.now(),
        monto: datos?.monto || null,
        fecha: datos?.fecha || null,
        banco: datos?.banco || null,
        referencia: datos?.referencia || null,
        telefono: tel,
        validado: false
      }
    }, { merge: true });
    return { numero: elegida.numero, saldo: elegida.saldo };
  } catch (err) {
    console.error('[ANNY] Error registrando pago reportado:', err.message);
    return null;
  }
}

// ============================================================
// Pedido abierto del hilo (pedidosAnny) — ANNY-ESTADO-013
// ============================================================
const ESTADOS_PEDIDO_ABIERTO = ['NUEVO', 'BORRADOR', 'EN_REVISION'];

async function obtenerEstadoPedidoHilo(adminId, telefono) {
  try {
    const snap = await db.collection('pedidosAnny').doc(adminId).collection('pedidos').where('telefono', '==', telefono).limit(20).get();
    if (snap.empty) return { existe: false };
    const pedidos = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    const abierto = pedidos.find(p => ESTADOS_PEDIDO_ABIERTO.includes(p.estado));
    const p = abierto || pedidos[0];
    return {
      existe: true,
      id: p.id,
      estado: p.estado || 'NUEVO',
      producto: p.producto || '',
      total: p.total || '',
      datosPendientes: Array.isArray(p.datosPendientes) ? p.datosPendientes : [],
      abierto: !!abierto,
      creadoMs: (p.createdAt?.seconds || 0) * 1000
    };
  } catch (err) {
    console.error('[ANNY] Error leyendo estado de pedido:', err.message);
    return { existe: false };
  }
}

module.exports = {
  buscarClienteEnBD,
  obtenerVencimientosCliente,
  obtenerSaldoCxC,
  obtenerOrdenesServicio,
  registrarPagoReportado,
  obtenerEstadoPedidoHilo,
  ESTADOS_PEDIDO_ABIERTO
};
