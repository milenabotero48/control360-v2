// ════════════════════════════════════════════════════════════════════════════════
// scripts/reparar-subadmin.js — MULTIADMIN-001-b
// ─────────────────────────────────────────────────────────────────────────────
// Repara los usuarios de UN tenant que quedaron apuntando a una empresa
// equivocada: les fija esPropietario=false y adminId = el tenant real.
//
// POR QUÉ EXISTE
// Un administrador secundario creado con el código anterior nace sin la marca
// `esPropietario`. Al entrar, la regla legacy lo declara dueño de su propio
// tenant y aterriza en una empresa vacía. La autocuración de la primera versión
// llegó a grabar ese veredicto, sobrescribiendo su `adminId` correcto — pero
// `creadoPor` conserva el tenant real, así que el dato es 100% recuperable.
//
// POR QUÉ NO SE USA migrar-propietarios.js PARA ESTO
// Aquel script clasifica por ROL (role==='admin' → propietario), que es
// justamente la regla equivocada que estamos eliminando. Sobre esta base de
// datos marcaría a los administradores secundarios como dueños de tenants
// fantasma y dejaría el daño fijo. NO EJECUTAR aquel script.
//
// QUÉ NO TOCA
//   · El documento del propio tenant (el dueño).
//   · Cualquier usuario de otro tenant.
//   · Usuarios que ya tengan esPropietario=false y el adminId correcto.
//
// USO
//   node scripts/reparar-subadmin.js <TENANT_ID>              → simulación
//   node scripts/reparar-subadmin.js <TENANT_ID> --aplicar    → escribe
//
// EJEMPLO (Extintores del Valle SAS)
//   node scripts/reparar-subadmin.js 6h2gpIJ1vAZaUwBA5SLXTRONShp1
// ═══════════════════════════════════════════════════════════════════════════════

const { db, admin } = require('../config/firebase');

const TENANT_ID = process.argv[2];
const APLICAR   = process.argv.includes('--aplicar');

const linea = (c = '─') => console.log(c.repeat(84));

if (!TENANT_ID || TENANT_ID.startsWith('--')) {
  console.error('\n❌ Falta el id del tenant.\n');
  console.error('   Uso:  node scripts/reparar-subadmin.js <TENANT_ID> [--aplicar]');
  console.error('   El id sale de la columna "creadoPor" en diagnostico-multiadmin.js\n');
  process.exit(1);
}

(async () => {
  linea('═');
  console.log('  REPARACIÓN MULTIADMIN-001-b — usuarios apuntando a empresa equivocada');
  console.log(`  Tenant: ${TENANT_ID}`);
  console.log(`  Modo:   ${APLICAR ? '⚠️  APLICAR (escribe en Firestore)' : '🔍 SIMULACIÓN (no escribe)'}`);
  linea('═');

  // ── 1. Verificar que el tenant existe y ES un dueño ────────────────────────
  const tenantDoc = await db.collection('users').doc(TENANT_ID).get();
  if (!tenantDoc.exists) {
    console.error(`\n❌ No existe ningún usuario con id ${TENANT_ID}. Verifique el id.\n`);
    process.exit(1);
  }
  const tenant = tenantDoc.data();
  const tenantEsDueno = (tenant.adminId || TENANT_ID) === TENANT_ID;
  if (!tenantEsDueno) {
    console.error(`\n❌ ${tenant.nombre || TENANT_ID} no es el dueño de un tenant:`);
    console.error(`   su adminId apunta a ${tenant.adminId}. Use ESE id.\n`);
    process.exit(1);
  }
  console.log(`\n🏢 Empresa: ${tenant.nombre || tenant.email}`);
  console.log(`   Propietario actual: ${tenant.esPropietario === true ? '✅ marcado' : '⚠️ sin marca'}\n`);

  // ── 2. Buscar su gente ─────────────────────────────────────────────────────
  // Se busca por creadoPor porque es el campo que NO se corrompió: la
  // autocuración solo llegó a sobrescribir adminId.
  const snap = await db.collection('users').where('creadoPor', '==', TENANT_ID).get();

  const aReparar = [];
  const yaBien   = [];

  snap.forEach(d => {
    if (d.id === TENANT_ID) return; // nunca tocar al dueño
    const u = d.data();

    const necesitaMarca  = u.esPropietario !== false;
    const necesitaAdmin  = u.adminId !== TENANT_ID;

    const registro = {
      id: d.id,
      nombre: u.nombre || u.email || d.id,
      role: u.role || '—',
      esPropietarioActual: typeof u.esPropietario === 'boolean' ? u.esPropietario : 'SIN MARCA',
      adminIdActual: u.adminId || '—',
    };

    if (necesitaMarca || necesitaAdmin) aReparar.push(registro);
    else yaBien.push(registro);
  });

  // ── 3. Reporte ─────────────────────────────────────────────────────────────
  if (yaBien.length) {
    console.log(`✅ Ya correctos (se omiten): ${yaBien.length}`);
    yaBien.forEach(u => console.log(`   · ${u.nombre} (${u.role})`));
    console.log('');
  }

  if (!aReparar.length) {
    linea();
    console.log('✅ No hay nada que reparar en este tenant.');
    linea();
    process.exit(0);
  }

  console.log(`🔧 A REPARAR: ${aReparar.length}\n`);
  aReparar.forEach(u => {
    console.log(`   · ${u.nombre}  (${u.role})   [${u.id}]`);
    console.log(`       esPropietario : ${u.esPropietarioActual}  →  false`);
    console.log(`       adminId       : ${u.adminIdActual}`);
    console.log(`                       →  ${TENANT_ID}`);
    if (u.role === 'admin') {
      console.log('       ↳ Administrador: tras la reparación verá la empresa completa,');
      console.log('         con permisos totales sobre la operación pero sin poder tocar');
      console.log('         la suscripción ni la cuenta del propietario.');
    }
    console.log('');
  });

  if (!APLICAR) {
    linea();
    console.log('🔍 Simulación terminada. No se escribió nada.');
    console.log('   Si el reporte se ve correcto, ejecute:');
    console.log(`   node scripts/reparar-subadmin.js ${TENANT_ID} --aplicar`);
    linea();
    process.exit(0);
  }

  // ── 4. Escritura ───────────────────────────────────────────────────────────
  linea();
  console.log('✍️  Aplicando...');

  const batch = db.batch();
  aReparar.forEach(u => {
    batch.update(db.collection('users').doc(u.id), {
      esPropietario: false,
      adminId: TENANT_ID,
      // Invalida la sesión activa: al volver a entrar recibe un token con el
      // tenant correcto. Sin esto seguiría viendo la empresa vacía hasta que
      // el token expire.
      sessionToken: admin.firestore.FieldValue.delete(),
      reparadoMultiadmin: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();

  // El dueño también queda marcado explícitamente, si aún no lo estaba.
  if (tenant.esPropietario !== true) {
    await tenantDoc.ref.update({ esPropietario: true, adminId: TENANT_ID });
    console.log('   · propietario marcado ✓');
  }

  await db.collection('audit_logs').add({
    accion:        'REPARACION_MULTIADMIN',
    modulo:        'usuarios',
    descripcion:   `Reparados ${aReparar.length} usuario(s) del tenant ${tenant.nombre || TENANT_ID}`,
    usuarioId:     'sistema',
    usuarioNombre: 'Script de reparación',
    adminId:       TENANT_ID,
    datos: { tenant: TENANT_ID, reparados: aReparar.map(u => ({ id: u.id, nombre: u.nombre, role: u.role })) },
    fecha:     new Date().toISOString(),
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  linea();
  console.log(`✅ Listo: ${aReparar.length} usuario(s) reparado(s).`);
  console.log('   Deben cerrar sesión y volver a entrar.');
  linea();
  process.exit(0);
})().catch(err => {
  console.error('\n❌ Error en la reparación:', err);
  process.exit(1);
});
