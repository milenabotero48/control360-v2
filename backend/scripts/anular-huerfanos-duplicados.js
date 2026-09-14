// ============================================================
// Control360 — Anular movimientos huérfanos duplicados (Metro Quadrante)
// ============================================================
// Estos 2 movimientos con cajaId:'sin_asignar' son registros
// fantasma: el pago YA tiene su movimiento correcto en una caja
// real (confirmado con check-metro-quadrante.js). No suman a
// ningún saldo (los 'sin_asignar' no se cuentan en ninguna caja),
// así que esto NO corrige dinero — solo limpia la alerta para que
// deje de mostrarlos como pendientes.
//
// Soft delete (no se borra el documento, se marca anulado) —
// convención del proyecto.
//
// Uso: node scripts/anular-huerfanos-duplicados.js
// ============================================================

const { db, admin } = require('../config/firebase');

const MOVIMIENTOS_A_ANULAR = [
  { id: 'cYxTfveMh9jhvtI7zWSC', motivo: 'Duplicado de OS-0603 — ya registrado en caja real por la admin' },
  { id: 'rTpimdDm0Vf9R5J4CKIN', motivo: 'Duplicado de OS-0601 — ya registrado en caja real por la admin' }
];

async function main() {
  for (const { id, motivo } of MOVIMIENTOS_A_ANULAR) {
    const ref = db.collection('movimientos').doc(id);
    const doc = await ref.get();
    if (!doc.exists) { console.log(`⚠️  ${id}: no existe, se omite.`); continue; }
    const d = doc.data();
    if (d.cajaId !== 'sin_asignar') {
      console.log(`⚠️  ${id}: cajaId ya no es 'sin_asignar' (es '${d.cajaId}') — se omite por seguridad.`);
      continue;
    }
    await ref.update({
      anulado: true,
      anuladoMotivo: motivo,
      anuladoEn: admin.firestore.FieldValue.serverTimestamp(),
      pendienteAsignar: false
    });
    console.log(`✅ ${id}: anulado (${motivo})`);
  }
  console.log('Listo.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
