// ============================================================
// Control360 — Verificación puntual: ¿Metro Quadrante duplicado?
// ============================================================
// SOLO LECTURA. Revisa las dos órdenes OS-0603 / OS-0601 (tenant
// 6h2gpIJ1vAZaUwBA5SLXTRONShp1): todos los movimientos de caja que
// las referencian, y el estado de la orden (dineroEnCaja,
// ingresadoCaja, pagado) para ver si ya quedó cubierta por otro lado.
// ============================================================

const { db } = require('../config/firebase');

const TENANT_ID = '6h2gpIJ1vAZaUwBA5SLXTRONShp1';
const ORDENES = [
  { id: 'siWcAVtrJYrNL74VxEOf', numeroOrden: 'OS-0603' },
  { id: 'tghoJTpl1C29ViXgm72i', numeroOrden: 'OS-0601' }
];

async function main() {
  const out = [];
  for (const { id, numeroOrden } of ORDENES) {
    const item = { ordenId: id, numeroOrden };
    try {
      const doc = await db.collection('orders').doc(id).get();
      if (doc.exists) {
        const o = doc.data();
        item.orden = {
          total: o.total, pagado: o.pagado, dineroEnCaja: o.dineroEnCaja,
          ingresadoCaja: o.ingresadoCaja, formaPago: o.formaPago,
          pagoValidado: o.pagoValidado, pagoVirtualPendienteValidar: o.pagoVirtualPendienteValidar
        };
      } else {
        item.orden = null;
      }
    } catch (e) { item.ordenError = e.message; }

    try {
      const movsSnap = await db.collection('movimientos').where('ordenId', '==', id).get();
      item.movimientos = movsSnap.docs.map(d => ({
        id: d.id, cajaId: d.data().cajaId, monto: d.data().monto,
        tipo: d.data().tipo, concepto: d.data().concepto,
        formaPago: d.data().formaPago, alerta: d.data().alerta || null,
        pendienteAsignar: d.data().pendienteAsignar || false
      }));
    } catch (e) { item.movsError = e.message; }

    out.push(item);
  }
  console.log(JSON.stringify({ tenantId: TENANT_ID, resultado: out }, null, 2));
}

main().catch(err => { console.error(JSON.stringify({ error: err.message })); process.exit(1); });
