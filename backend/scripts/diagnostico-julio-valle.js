// ============================================================
// Control360 — Diagnóstico puntual: 9 órdenes de julio (Extintores del Valle)
// ============================================================
// SOLO LECTURA. Confirma el estado exacto de ingresadoCaja/dineroEnCaja
// en las 9 órdenes de efectivo sin movimiento, para decidir cómo repararlas.
// ============================================================

const { db } = require('../config/firebase');

const NUMEROS = ['OS-0254','OS-0197','OS-0183','OS-0220','OS-0232','OS-0091','OS-0186','OS-0246','OS-0247'];
const TENANT_ID = '6h2gpIJ1vAZaUwBA5SLXTRONShp1';

async function main() {
  const snap = await db.collection('orders').where('adminId', '==', TENANT_ID).where('numeroOrden', 'in', NUMEROS.slice(0,10)).get();
  const out = [];
  // 'in' soporta hasta 10 valores, tenemos 9 — OK en un solo query.
  snap.docs.forEach(doc => {
    const o = doc.data();
    out.push({
      id: doc.id, numeroOrden: o.numeroOrden, total: o.total,
      pagado: o.pagado, dineroEnCaja: o.dineroEnCaja, ingresadoCaja: o.ingresadoCaja,
      formaPago: o.formaPago, fecha: o.fechaCompletada || o.fechaPago || null
    });
  });
  console.log(JSON.stringify({ tenantId: TENANT_ID, ordenes: out }, null, 2));
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
