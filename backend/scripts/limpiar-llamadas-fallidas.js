// ============================================================
// Control360 — Limpieza de llamadas IA fallidas
// Ubicación: backend/scripts/limpiar-llamadas-fallidas.js
// ------------------------------------------------------------
// ✅ FIX LUCY-ELEVEN-003 (2026-07-19)
// Elimina los registros de `llamadas_ia` que quedaron en estado
// 'fallida' (la llamada NUNCA se realizó: error de lanzamiento de
// Vapi por número US/CA, créditos, o el bug de registroRef). Esos
// registros quemaban el intento #1 de clientes que jamás
// recibieron una llamada real — hay que liberarlos antes del
// próximo ciclo del motor.
//
// SEGURIDAD: dry-run POR DEFECTO (solo muestra qué borraría).
// Para aplicar de verdad:  node scripts/limpiar-llamadas-fallidas.js --aplicar
// Filtrar un mes puntual:  node scripts/limpiar-llamadas-fallidas.js --mes=2026-07 --aplicar
//
// EJECUCIÓN: consola de Railway (mismo patrón que migrar-telefonos.js):
//   node scripts/limpiar-llamadas-fallidas.js --mes=2026-07
//   (revisar salida) → node scripts/limpiar-llamadas-fallidas.js --mes=2026-07 --aplicar
//
// NOTA: se BORRAN (no se anulan) porque no son registros
// financieros — son intentos técnicos fallidos sin llamada real.
// La regla de anulación aplica a dinero, no a esto.
// ============================================================

const { db } = require('../config/firebase');

const APLICAR = process.argv.includes('--aplicar');
const argMes = process.argv.find(a => a.startsWith('--mes='));
const MES = argMes ? argMes.split('=')[1] : null; // 'YYYY-MM' o null = todos

const main = async () => {
  console.log('════════════════════════════════════════════════════');
  console.log('  Limpieza de llamadas IA fallidas (FIX LUCY-ELEVEN-003)');
  console.log(`  Modo: ${APLICAR ? '⚠️  APLICAR (borra de verdad)' : '🔍 DRY-RUN (solo muestra)'}`);
  console.log(`  Mes:  ${MES || 'todos'}`);
  console.log('════════════════════════════════════════════════════');

  const snap = await db.collection('llamadas_ia')
    .where('estado', '==', 'fallida')
    .get();

  let candidatos = snap.docs.filter(d => {
    const data = d.data();
    if (data.resultado) return false;                                 // ya tiene resultado real — no tocar
    if (MES && !(data.mesVencimiento || '').startsWith(MES)) return false;
    return true;
  });

  if (candidatos.length === 0) {
    console.log('✅ No hay registros fallidos que limpiar.');
    process.exit(0);
  }

  console.log(`\nEncontrados ${candidatos.length} registro(s) fallido(s):\n`);
  const porTenant = {};
  candidatos.forEach(d => {
    const data = d.data();
    porTenant[data.adminId] = (porTenant[data.adminId] || 0) + 1;
    console.log(`  · ${d.id} — tenant ${data.adminId} — cliente ${data.clienteId} — mes ${data.mesVencimiento} — intento ${data.intento} — error: ${(data.errorLanzamiento || 'n/a').slice(0, 60)}`);
  });

  console.log('\nResumen por tenant:');
  Object.entries(porTenant).forEach(([t, n]) => console.log(`  · ${t}: ${n} registro(s)`));

  if (!APLICAR) {
    console.log('\n🔍 DRY-RUN: no se borró nada. Ejecuta con --aplicar para confirmar.');
    process.exit(0);
  }

  // Borrado en lotes atómicos de 400 (límite de batch de Firestore es 500)
  let borrados = 0;
  while (candidatos.length > 0) {
    const lote = candidatos.splice(0, 400);
    const batch = db.batch();
    lote.forEach(d => batch.delete(d.ref));
    await batch.commit();
    borrados += lote.length;
    console.log(`  ... ${borrados} borrado(s)`);
  }

  console.log(`\n✅ Limpieza completada: ${borrados} registro(s) eliminados. Esos clientes recuperan su intento #1.`);
  process.exit(0);
};

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
