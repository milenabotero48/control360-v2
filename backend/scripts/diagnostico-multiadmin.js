// ════════════════════════════════════════════════════════════════════════════════
// scripts/diagnostico-multiadmin.js — MULTIADMIN-001
// ─────────────────────────────────────────────────────────────────────────────
// SOLO LECTURA. No escribe absolutamente nada en Firestore.
//
// Muestra, para cada usuario, los campos que deciden a qué empresa entra:
//   esPropietario · adminId · creadoPor · role
//
// Y calcula a qué tenant lo mandaría el login NUEVO, para ver de una si el
// problema es de datos o de despliegue.
//
// USO:  cd backend && node scripts/diagnostico-multiadmin.js
// ═══════════════════════════════════════════════════════════════════════════════

const { db } = require('../config/firebase');

const linea = (c = '─') => console.log(c.repeat(100));
const corto = (v) => (v ? String(v).slice(0, 10) + '…' : '—');

// Réplica exacta del resolverTenant() de routes/auth.js
const resolverTenant = (user, uid) => {
  if (typeof user.esPropietario === 'boolean') {
    if (user.esPropietario === true) return { adminId: uid, via: 'esPropietario=true' };
    return { adminId: user.adminId || user.creadoPor || uid, via: 'esPropietario=false' };
  }
  if (user.role === 'admin') return { adminId: uid, via: '⚠️ LEGACY (rol admin)' };
  return { adminId: user.creadoPor || uid, via: 'LEGACY (creadoPor)' };
};

(async () => {
  linea('═');
  console.log('  DIAGNÓSTICO MULTIADMIN-001 — solo lectura');
  linea('═');

  const snap = await db.collection('users').get();

  const users = [];
  snap.forEach(d => users.push({ id: d.id, ...d.data() }));

  // Agrupar por el tenant al que los mandaría el login nuevo
  const porTenant = {};

  console.log(`\nTotal usuarios: ${users.length}\n`);
  linea();
  console.log(
    'NOMBRE'.padEnd(24) + 'ROL'.padEnd(12) + 'esProp'.padEnd(9) +
    'adminId'.padEnd(13) + 'creadoPor'.padEnd(13) + 'ENTRA A'.padEnd(13) + 'VÍA'
  );
  linea();

  users.forEach(u => {
    const r = resolverTenant(u, u.id);
    porTenant[r.adminId] = (porTenant[r.adminId] || 0) + 1;

    const esProp = typeof u.esPropietario === 'boolean' ? String(u.esPropietario) : 'SIN MARCA';

    console.log(
      String(u.nombre || u.email || u.id).slice(0, 23).padEnd(24) +
      String(u.role || '—').padEnd(12) +
      esProp.padEnd(9) +
      corto(u.adminId).padEnd(13) +
      corto(u.creadoPor).padEnd(13) +
      corto(r.adminId).padEnd(13) +
      r.via
    );
  });

  linea();

  // ── Resumen por tenant ─────────────────────────────────────────────────────
  console.log('\n📊 EMPRESAS QUE VERÍA CADA GRUPO:\n');
  for (const [tenantId, n] of Object.entries(porTenant)) {
    const dueno = users.find(u => u.id === tenantId);
    console.log(`   ${corto(tenantId).padEnd(13)} → ${n} usuario(s)   [${dueno ? (dueno.nombre || dueno.email) : 'documento no encontrado'}]`);
  }

  // ── Detección del síntoma ──────────────────────────────────────────────────
  const adminsSueltos = users.filter(u =>
    u.role === 'admin' &&
    typeof u.esPropietario !== 'boolean' &&
    u.creadoPor && u.creadoPor !== u.id
  );

  console.log('');
  linea();
  if (adminsSueltos.length) {
    console.log('🔴 CAUSA ENCONTRADA — administradores creados dentro de un tenant');
    console.log('   pero SIN la marca esPropietario. El login les aplica la regla');
    console.log('   legacy (rol admin → tenant propio) y aterrizan en empresa vacía:\n');
    adminsSueltos.forEach(u => {
      console.log(`   · ${u.nombre || u.email}  [${u.id}]`);
      console.log(`     debería entrar al tenant: ${u.adminId || u.creadoPor}`);
    });
    console.log('\n   → Se arregla marcando esPropietario=false en esos documentos.');
  } else {
    console.log('✅ No hay administradores sin marca colgando de un tenant.');
    console.log('   Si Maykol sigue viendo la empresa vacía, el problema es de');
    console.log('   DESPLIEGUE: Railway todavía está sirviendo el código anterior.');
  }
  linea();

  // ── ¿El código desplegado es el nuevo? ─────────────────────────────────────
  const marcados = users.filter(u => typeof u.esPropietario === 'boolean').length;
  console.log(`\nDocumentos con marca esPropietario: ${marcados} de ${users.length}`);
  if (marcados === 0) {
    console.log('⚠️  Ninguno tiene la marca. Como el login nuevo la estampa solo al');
    console.log('   entrar (autocuración), esto sugiere que el backend desplegado');
    console.log('   AÚN NO tiene el código nuevo. Revise el deploy en Railway.');
  }
  console.log('');

  process.exit(0);
})().catch(err => {
  console.error('\n❌ Error:', err);
  process.exit(1);
});
