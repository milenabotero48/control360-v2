// ============================================================
// Control360 — Diagnóstico PAGO-CUADRE-005 (SOLO LECTURA)
// ============================================================
// Revisa los últimos 2 meses en TODOS los tenants buscando:
//   A) Órdenes con pago virtual pendiente de validar (dinero que
//      el sistema ya sabe que existe pero aún no entra a caja).
//   B) Órdenes marcadas como pagadas/dinero en caja (dineroEnCaja
//      === true) que NO tienen un movimiento de caja con ese
//      ordenId — es decir, el dinero "se perdió" en el camino.
//   C) Movimientos de caja con cajaId 'sin_asignar' — dinero que
//      entró pero no se sabe a qué caja pertenece.
//
// No escribe nada en la base de datos. Solo lee y arma un reporte.
//
// Uso:
//   cd C:\Users\milen\control360-v2\backend
//   node scripts/diagnostico-cuadre-005.js > ../diagnostico-cuadre-reporte.json
// ============================================================

const { db } = require('../config/firebase');

const DIAS_ATRAS = 62; // ~2 meses
const desde = new Date(Date.now() - DIAS_ATRAS * 86400000);

function msDe(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

async function main() {
  const reporte = {
    generadoEn: new Date().toISOString(),
    rangoDesde: desde.toISOString(),
    tenants: []
  };

  // 1. Traer todos los tenants (admins/propietarios) desde 'suscripciones'
  //    (fallback: si no hay doc de suscripción, igual puede haber datos en
  //    'orders'/'movimientos' con ese userId — los recogemos aparte).
  const suscSnap = await db.collection('suscripciones').get();
  const tenantIds = new Set(suscSnap.docs.map(d => d.id));

  // También recoger adminIds que aparezcan en órdenes recientes, por si
  // hay tenants sin doc de suscripción (viejos, sin backfill).
  const ordersSnap = await db.collection('orders').limit(20000).get();
  const ordersPorTenant = new Map(); // adminId -> [orden]
  ordersSnap.docs.forEach(doc => {
    const o = doc.data();
    const t = o.adminId || o.userId;
    if (!t) return;
    tenantIds.add(t);
    if (!ordersPorTenant.has(t)) ordersPorTenant.set(t, []);
    ordersPorTenant.get(t).push({ id: doc.id, ...o });
  });

  const movsSnap = await db.collection('movimientos').limit(30000).get();
  const movsPorTenant = new Map();
  const movsPorOrden = new Map(); // ordenId -> [mov]
  movsSnap.docs.forEach(doc => {
    const m = doc.data();
    const t = m.userId;
    if (t) {
      if (!movsPorTenant.has(t)) movsPorTenant.set(t, []);
      movsPorTenant.get(t).push({ id: doc.id, ...m });
    }
    if (m.ordenId) {
      if (!movsPorOrden.has(m.ordenId)) movsPorOrden.set(m.ordenId, []);
      movsPorOrden.get(m.ordenId).push({ id: doc.id, ...m });
    }
  });

  for (const tenantId of tenantIds) {
    const ordenes = (ordersPorTenant.get(tenantId) || []).filter(o => {
      const ms = msDe(o.fechaCompletada) || msDe(o.fechaPago) || msDe(o.createdAt) || msDe(o.fechaCreacion);
      return ms && ms >= desde.getTime();
    });
    const movs = (movsPorTenant.get(tenantId) || []).filter(m => {
      const ms = msDe(m.createdAt) || msDe(m.fecha);
      return ms && ms >= desde.getTime();
    });

    const pendientesValidar = ordenes.filter(o => o.pagoVirtualPendienteValidar === true);

    const marcadasPagadasSinMovimiento = ordenes.filter(o => {
      const marcada = o.dineroEnCaja === true || (o.pagado === true && o.pagoVirtualPendienteValidar !== true);
      if (!marcada) return false;
      const movsDeEsta = movsPorOrden.get(o.id) || [];
      return movsDeEsta.length === 0;
    });

    const sinAsignar = movs.filter(m => m.cajaId === 'sin_asignar');

    if (pendientesValidar.length === 0 && marcadasPagadasSinMovimiento.length === 0 && sinAsignar.length === 0) {
      continue; // tenant sin novedades, no lo listamos para no llenar el reporte de ruido
    }

    reporte.tenants.push({
      tenantId,
      pendientesValidar: pendientesValidar.map(o => ({
        ordenId: o.id, numeroOrden: o.numeroOrden, cliente: o.clienteNombre,
        monto: o.total, formaPago: o.formaPago, fecha: o.fechaCompletada || o.fechaPago || null
      })),
      totalPendientesValidar: pendientesValidar.reduce((a, o) => a + (Number(o.total) || 0), 0),

      marcadasPagadasSinMovimiento: marcadasPagadasSinMovimiento.map(o => ({
        ordenId: o.id, numeroOrden: o.numeroOrden, cliente: o.clienteNombre,
        monto: o.total, formaPago: o.formaPago,
        fecha: o.fechaCompletada || o.fechaPago || null,
        dineroEnCaja: o.dineroEnCaja === true, pagado: o.pagado === true
      })),
      totalMarcadasPagadasSinMovimiento: marcadasPagadasSinMovimiento.reduce((a, o) => a + (Number(o.total) || 0), 0),

      sinAsignar: sinAsignar.map(m => ({
        movimientoId: m.id, ordenId: m.ordenId || null, concepto: m.concepto,
        monto: m.monto, formaPago: m.formaPago,
        fecha: m.createdAt ? new Date(msDe(m.createdAt)).toISOString() : null
      })),
      totalSinAsignar: sinAsignar.reduce((a, m) => a + (Number(m.monto) || 0), 0)
    });
  }

  reporte.resumen = {
    tenantsConNovedad: reporte.tenants.length,
    totalPendientesValidar: reporte.tenants.reduce((a, t) => a + t.totalPendientesValidar, 0),
    totalMarcadasPagadasSinMovimiento: reporte.tenants.reduce((a, t) => a + t.totalMarcadasPagadasSinMovimiento, 0),
    totalSinAsignar: reporte.tenants.reduce((a, t) => a + t.totalSinAsignar, 0)
  };

  console.log(JSON.stringify(reporte, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }));
  process.exit(1);
});
