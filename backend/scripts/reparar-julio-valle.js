// ============================================================
// Control360 — Reparación puntual: 9 órdenes de julio (Extintores del Valle)
// ============================================================
// Estas 9 órdenes quedaron con pagado:true, dineroEnCaja:true pero
// SIN movimiento en caja ni ingresadoCaja (confirmado con
// diagnostico-julio-valle.js) — probablemente por una interrupción
// del servidor durante un deploy a mediados de julio 2026, entre el
// paso que marca la orden y el paso que crea el movimiento.
//
// Como ingresadoCaja nunca quedó fijado, el candado de duplicados
// (CANDADO-MONTO-001) NO va a rechazar el reintento — es seguro
// volver a llamar a registrarIngresoEnCaja() para cada una.
//
// Modos:
//   node scripts/reparar-julio-valle.js            → DRY-RUN (solo lectura)
//   node scripts/reparar-julio-valle.js --aplicar   → escribe los movimientos
// ============================================================

const { db } = require('../config/firebase');
const { registrarIngresoEnCaja } = require('../routes/orders');

const TENANT_ID = '6h2gpIJ1vAZaUwBA5SLXTRONShp1';
const ORDENES = [
  { id: '2e29ueTxUAJpmvYbJ51N', numeroOrden: 'OS-0254' },
  { id: 'B2HbE4HEuv1lJVWrTuo2', numeroOrden: 'OS-0197' },
  { id: 'GtFYM0ox0iZaS4KaXtte', numeroOrden: 'OS-0183' },
  { id: 'RcPMGTwbxLDPIBUdcJdq', numeroOrden: 'OS-0220' },
  { id: 'S3YLp5mI9XOqWxxZEqlt', numeroOrden: 'OS-0232' },
  { id: 'ZZBl0wbHrXjxqz92429Z', numeroOrden: 'OS-0091' },
  { id: 'n1nVGrPKJaxg0ZeYvqrZ', numeroOrden: 'OS-0186' },
  { id: 'oCoGf2L48euRPraOQA9w', numeroOrden: 'OS-0246' },
  { id: 't5to0gJ46m83zhq4BWQX', numeroOrden: 'OS-0247' }
];

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  console.log(`\n═══ Reparación julio Extintores del Valle — modo ${APLICAR ? 'APLICAR (escribe)' : 'DRY-RUN (solo lectura)'} ═══\n`);

  let total = 0, ok = 0, fallos = 0;

  for (const { id, numeroOrden } of ORDENES) {
    const doc = await db.collection('orders').doc(id).get();
    if (!doc.exists) { console.log(`⚠️  ${numeroOrden}: orden no existe, se omite.`); continue; }
    const o = doc.data();

    // Re-verifica en el momento (por si algo cambió desde el diagnóstico)
    const yaTieneMov = (await db.collection('movimientos').where('ordenId', '==', id).limit(1).get()).size > 0;
    if (yaTieneMov) { console.log(`⚠️  ${numeroOrden}: ya tiene movimiento, se omite (evita duplicado).`); continue; }

    const fechaContable = o.fechaCompletada || o.fechaPago || null;
    console.log(`· ${numeroOrden}  monto=$${o.total.toLocaleString('es-CO')}  formaPago="${o.formaPago}"  fechaContable=${fechaContable}`);
    total += o.total;

    if (APLICAR) {
      try {
        await registrarIngresoEnCaja({
          userId: TENANT_ID, ordenId: id, numeroOrden: o.numeroOrden,
          clienteNombre: o.clienteNombre, monto: o.total, formaPago: o.formaPago,
          usuarioEmail: 'reparacion-cuadre@sistema', numeroFactura: o.numeroFactura || '',
          fechaContable
        });
        console.log(`  ✅ movimiento creado`);
        ok++;
      } catch (e) {
        console.log(`  ❌ error: ${e.message}`);
        fallos++;
      }
    }
  }

  console.log(`\nTOTAL A REPONER: $${total.toLocaleString('es-CO')} (${ORDENES.length} órdenes)`);
  if (APLICAR) {
    console.log(`Reparadas: ${ok}  ·  Fallidas: ${fallos}`);
  } else {
    console.log('Modo DRY-RUN: no se escribió nada. Para aplicar: node scripts/reparar-julio-valle.js --aplicar');
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
