// ============================================================
// Control360 — Cartera · servicio compartido
// Ubicación: backend/services/carteraService.js
// ✅ CARTERA-SHARED-001 (2026-10-09)
// ============================================================
// POR QUÉ EXISTE ESTE ARCHIVO
// ------------------------------------------------------------
// "Días vencidos" se estaba calculando en DOS lugares con reglas
// distintas:
//
//   · routes/cxc.js    → contaba desde la FACTURA (fechaFactura, y
//                        si no hay, la fecha de la orden). Una orden
//                        que requiere factura y todavía no la tiene
//                        NO cuenta para mora: su plazo no ha empezado.
//
//   · annyNotificaciones.js (cobranza) → contaba desde el historial
//                        de estados (completada/cxc). Resultado: el
//                        mensaje de WhatsApp decía "45 días" y el
//                        panel mostraba 30 para el mismo cliente.
//
// Además la cobranza solo miraba `estado == 'cxc'`, mientras el panel
// incluye también las órdenes a crédito y los saldos parciales
// (SALDO-UNICO-001). Había clientes con saldo a los que Anny nunca
// les cobró porque su orden estaba en otro estado.
//
// Este servicio es la ÚNICA verdad. Lo usan el panel de CxC y la
// cobranza de Anny. Si mañana cambia la regla contable, se cambia
// aquí y los dos quedan iguales por construcción.
//
// REGLAS DE NEGOCIO (confirmadas con Sandra Milena, contadora):
//   1. La mora se cuenta desde la FACTURA. Sin factura, desde la orden.
//   2. Una orden con `requiereFactura` y sin `numeroFactura` NO está
//      vencida: el plazo no ha empezado a correr.
//   3. Saldo = total − montoPagado. Saldo ≤ 0 no es cartera.
//   4. Las órdenes anuladas no son cartera.
//   5. El cliente queda BLOQUEADO cuando su orden más vieja supera
//      `configuracion/{adminId}.diasBloqueoCartera` (30 por defecto).
// ============================================================

const { db } = require('../config/firebase');

// Días a partir de los cuales Anny empieza a cobrar. Pedido de Sandra:
// por debajo de esto el servicio muchas veces ni se ha prestado todavía.
const DIAS_MINIMO_COBRANZA_DEFAULT = 15;
const DIAS_BLOQUEO_DEFAULT = 30;
const DIAS_ENTRE_AVISOS_DEFAULT = 7;

// ─── Fecha de Firestore (timestamp o ISO) → ISO legible ─────────────────────
// Firestore guarda { _seconds }. Mandarlo crudo al frontend se ve como
// "[object Object]". Misma función que tenía routes/cxc.js.
const fechaISO = (f) => {
  if (!f) return null;
  if (f._seconds) return new Date(f._seconds * 1000).toISOString();
  if (f.seconds) return new Date(f.seconds * 1000).toISOString();
  if (f.toDate) { try { return f.toDate().toISOString(); } catch { /* sigue */ } }
  const d = new Date(f);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// ✅ SALDO-UNICO-001: misma regla que orders.js y cxc.js.
const saldoRealDe = (o) => Math.max(0, Math.round(Number(o.total) || 0) - Math.round(Number(o.montoPagado) || 0));

// ─── Configuración de cartera del tenant ────────────────────────────────────
async function obtenerConfigCartera(adminId) {
  try {
    const doc = await db.collection('configuracion').doc(adminId).get();
    const d = doc.exists ? (doc.data() || {}) : {};
    return {
      diasBloqueoCartera: Number(d.diasBloqueoCartera) || DIAS_BLOQUEO_DEFAULT,
      // Días ENTRE avisos al mismo cliente (el campo ya existía en la pantalla
      // de Configuración de Cartera, pero no lo usaba nadie).
      diasAlertaCobranza: Number(d.diasAlertaCobranza) || DIAS_ENTRE_AVISOS_DEFAULT,
      // Desde cuántos días de mora Anny empieza a cobrar.
      diasMinimoCobranza: Number.isFinite(Number(d.diasMinimoCobranza)) && Number(d.diasMinimoCobranza) > 0
        ? Number(d.diasMinimoCobranza)
        : DIAS_MINIMO_COBRANZA_DEFAULT,
    };
  } catch (e) {
    console.error('[CARTERA] Error leyendo configuración:', e.message);
    return {
      diasBloqueoCartera: DIAS_BLOQUEO_DEFAULT,
      diasAlertaCobranza: DIAS_ENTRE_AVISOS_DEFAULT,
      diasMinimoCobranza: DIAS_MINIMO_COBRANZA_DEFAULT,
    };
  }
}

// ─── Todas las órdenes que son cartera de un tenant ─────────────────────────
// Cinco consultas, igual que el panel: estado cxc, las tres variantes de forma
// de pago a crédito, y los saldos parciales. Sin orderBy para no exigir índices.
async function _ordenesDeCartera(adminId) {
  const [snapEstado, snapFP1, snapFP2, snapFP3, snapParcial] = await Promise.all([
    db.collection('orders').where('adminId', '==', adminId).where('estado', '==', 'cxc').get(),
    db.collection('orders').where('adminId', '==', adminId).where('formaPago', '==', 'CXC').where('pagado', '==', false).get(),
    db.collection('orders').where('adminId', '==', adminId).where('formaPago', '==', 'A crédito (CxC)').where('pagado', '==', false).get(),
    db.collection('orders').where('adminId', '==', adminId).where('formaPago', '==', 'A crédito').where('pagado', '==', false).get(),
    db.collection('orders').where('adminId', '==', adminId).where('cxcEstado', '==', 'parcial').get(),
  ]);

  const vistos = new Set();
  const out = [];
  [...snapEstado.docs, ...snapFP1.docs, ...snapFP2.docs, ...snapFP3.docs, ...snapParcial.docs].forEach(doc => {
    if (vistos.has(doc.id)) return;
    vistos.add(doc.id);
    out.push({ id: doc.id, ref: doc.ref, ...doc.data() });
  });
  return out;
}

// ============================================================
// carteraPorCliente(adminId) → { clientes, config }
// ------------------------------------------------------------
// Cada cliente trae:
//   clienteId, clienteNombre, clienteNit, clienteCelular,
//   ordenes[], totalPendiente, diasVencido, fechaMasAntigua,
//   bloqueado, tieneFacturasPendientes,
//   ultimaCobranzaAnny  ← la más reciente de sus órdenes
//
// Cada orden trae, además de lo del panel:
//   referencia  → número de FACTURA, y si no la tiene, el de la ORDEN.
//                 Es lo que Anny le dice al cliente: pedido de Sandra,
//                 porque el cliente paga contra la factura.
// ============================================================
async function carteraPorCliente(adminId) {
  const config = await obtenerConfigCartera(adminId);
  const ordenes = await _ordenesDeCartera(adminId);
  const hoy = new Date();
  const mapa = {};

  for (const o of ordenes) {
    if (o.estado === 'anulada') continue;          // regla 4
    const saldoPendiente = saldoRealDe(o);
    if (saldoPendiente <= 0) continue;             // regla 3

    const clienteId = o.clienteId;
    if (!clienteId) continue;

    if (!mapa[clienteId]) {
      mapa[clienteId] = {
        clienteId,
        clienteNombre: o.clienteNombre,
        clienteNit: o.clienteNit || '',
        clienteCelular: o.clienteCelular || '',
        ordenes: [],
        totalPendiente: 0,
        fechaMasAntigua: o.createdAt,
        diasVencido: 0,
        bloqueado: false,
        tieneFacturasPendientes: false,
        ultimaCobranzaAnny: null,
      };
    }
    const cliente = mapa[clienteId];

    // regla 2: sin factura emitida, el plazo no ha empezado
    const facturaPendiente = !!o.requiereFactura && !o.numeroFactura;

    const fCreacion = fechaISO(o.createdAt);
    const fFactura = fechaISO(o.fechaFactura);
    const fechaBase = fFactura || fCreacion;       // regla 1

    cliente.ordenes.push({
      id: o.id,
      numeroOrden: o.numeroOrden,
      numeroFactura: o.numeroFactura || '',
      // Lo que Anny le nombra al cliente.
      referencia: o.numeroFactura ? `factura ${o.numeroFactura}` : `orden ${o.numeroOrden || ''}`.trim(),
      requiereFactura: !!o.requiereFactura,
      facturaPendiente,
      total: o.total || 0,
      montoPagado: o.montoPagado || 0,
      saldoPendiente,
      formaPago: o.formaPago,
      fechaCreacion: fCreacion,
      fechaFactura: fFactura,
      fechaConciliacion: fechaBase,
      empresaNombre: o.empresaNombre || '',
      ref: o.ref,                                   // para marcar la cobranza
      ultimaCobranzaAnny: o.ultimaCobranzaAnny || null,
    });

    cliente.totalPendiente += saldoPendiente;
    if (facturaPendiente) cliente.tieneFacturasPendientes = true;

    if (o.ultimaCobranzaAnny && (!cliente.ultimaCobranzaAnny || o.ultimaCobranzaAnny > cliente.ultimaCobranzaAnny)) {
      cliente.ultimaCobranzaAnny = o.ultimaCobranzaAnny;
    }

    const fechaRef = fechaBase ? new Date(fechaBase) : hoy;
    const dias = Math.floor((hoy - fechaRef) / 86400000);
    if (dias > cliente.diasVencido) {
      cliente.diasVencido = dias;
      cliente.fechaMasAntigua = fechaBase;
    }
    // regla 5 — una orden sin factura todavía no bloquea
    if (dias >= config.diasBloqueoCartera && !facturaPendiente) cliente.bloqueado = true;
  }

  const clientes = Object.values(mapa).sort((a, b) => b.diasVencido - a.diasVencido);
  return { clientes, config };
}

// ============================================================
// candidatosCobranza(adminId, { hoyStr }) → { candidatos, config, motivos }
// ------------------------------------------------------------
// Quién debe recibir mensaje de cobranza HOY. Filtra, en este orden:
//   · sin celular válido
//   · mora por debajo de `diasMinimoCobranza` (15 por defecto)
//   · ya se le escribió hace menos de `diasAlertaCobranza` días
//
// Las órdenes con factura pendiente se EXCLUYEN del detalle: no se le
// puede cobrar a alguien una factura que todavía no se le ha emitido.
// ============================================================
async function candidatosCobranza(adminId, opciones = {}) {
  const hoyStr = opciones.hoyStr || new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const { clientes, config } = await carteraPorCliente(adminId);

  const motivos = { sin_celular: 0, mora_corta: 0, avisado_reciente: 0, sin_ordenes_exigibles: 0 };
  const candidatos = [];

  for (const c of clientes) {
    const celular = String(c.clienteCelular || '').replace(/\D/g, '');
    if (celular.length < 10) { motivos.sin_celular++; continue; }

    if (c.diasVencido < config.diasMinimoCobranza) { motivos.mora_corta++; continue; }

    // Solo lo exigible: una factura no emitida no se cobra.
    const exigibles = c.ordenes
      .filter(o => !o.facturaPendiente)
      .sort((a, b) => String(a.fechaConciliacion || '').localeCompare(String(b.fechaConciliacion || '')));
    if (!exigibles.length) { motivos.sin_ordenes_exigibles++; continue; }

    if (c.ultimaCobranzaAnny) {
      const dias = Math.floor((new Date(hoyStr) - new Date(c.ultimaCobranzaAnny)) / 86400000);
      if (dias < config.diasAlertaCobranza) { motivos.avisado_reciente++; continue; }
    }

    const saldoExigible = exigibles.reduce((a, o) => a + o.saldoPendiente, 0);
    if (saldoExigible <= 0) { motivos.sin_ordenes_exigibles++; continue; }

    candidatos.push({
      ...c,
      celular,
      ordenesExigibles: exigibles,
      saldoExigible,
    });
  }

  return { candidatos, config, motivos };
}

module.exports = {
  fechaISO,
  saldoRealDe,
  obtenerConfigCartera,
  carteraPorCliente,
  candidatosCobranza,
  DIAS_MINIMO_COBRANZA_DEFAULT,
  DIAS_BLOQUEO_DEFAULT,
  DIAS_ENTRE_AVISOS_DEFAULT,
};
