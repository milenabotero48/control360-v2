// ════════════════════════════════════════════════════════════════════════════════
// scripts/migrar-propietarios.js — MULTIADMIN-001
// ─────────────────────────────────────────────────────────────────────────────
// PROPÓSITO
// Estampa en cada documento de `users` la marca explícita de PROPIEDAD del
// tenant, para que la resolución de empresa deje de depender del ROL.
//
//   esPropietario: true   → este usuario ES el tenant (el suscriptor / dueño).
//   esPropietario: false  → pertenece al tenant identificado por `adminId`.
//
// POR QUÉ ES NECESARIO
// Hoy el login resuelve el tenant así:
//     adminId = (role === 'admin') ? uid : (creadoPor || uid)
// Es decir, EL ROL DECIDE LA EMPRESA. Por eso, al crear un segundo usuario con
// rol Administrador, ese usuario aterriza en una empresa vacía nueva en vez de
// entrar a la empresa de quien lo creó.
//
// GARANTÍA DE NO REGRESIÓN
// Este script asigna esPropietario=true exactamente a los usuarios que HOY ya
// se comportan como dueños bajo la regla vieja (todos los role==='admin').
// Por lo tanto, después de migrar, el comportamiento de todas las cuentas
// existentes es IDÉNTICO al actual. No cambia ni un dato de negocio.
//
// SEGURIDAD
//   · Por defecto corre en SIMULACIÓN (no escribe nada). Revise el reporte.
//   · Solo escribe con la bandera --aplicar.
//   · Es idempotente: correrlo dos veces no hace daño.
//   · Nunca borra campos. Solo agrega esPropietario y, si falta, adminId.
//
// USO
//   node scripts/migrar-propietarios.js              → simulación (recomendado)
//   node scripts/migrar-propietarios.js --aplicar    → escribe en Firestore
//
// ORDEN DE DESPLIEGUE RECOMENDADO
//   1. Correr en simulación y revisar.
//   2. Correr con --aplicar.
//   3. Desplegar routes/auth.js y routes/users.js nuevos.
//   (El código nuevo trae regla legacy de compatibilidad, así que un orden
//    distinto tampoco rompe nada — pero este es el orden limpio.)
// ═══════════════════════════════════════════════════════════════════════════════

const { db, admin } = require('../config/firebase');

const APLICAR = process.argv.includes('--aplicar');

const linea = (c = '─') => console.log(c.repeat(78));

(async () => {
  linea('═');
  console.log('  MIGRACIÓN MULTIADMIN-001 — marca de propiedad de tenant');
  console.log(`  Modo: ${APLICAR ? '⚠️  APLICAR (escribe en Firestore)' : '🔍 SIMULACIÓN (no escribe)'}`);
  linea('═');

  const snap = await db.collection('users').get();

  const propietarios = [];   // role === 'admin' → dueños del tenant
  const subUsuarios  = [];   // pertenecen a un tenant
  const huerfanos    = [];   // no-admin sin adminId ni creadoPor → revisar a mano
  const yaMigrados   = [];

  snap.forEach(doc => {
    const u  = doc.data();
    const id = doc.id;
    const registro = {
      id,
      nombre: u.nombre || u.email || '(sin nombre)',
      email:  u.email || '—',
      role:   u.role  || '(sin rol)',
      adminIdActual: u.adminId || null,
      creadoPor:     u.creadoPor || null,
    };

    if (typeof u.esPropietario === 'boolean') {
      yaMigrados.push(registro);
      return;
    }

    // ── Regla de clasificación: replica EXACTAMENTE la lógica vieja del login.
    //    Vieja: adminId = (role === 'admin') ? uid : (creadoPor || uid)
    if (u.role === 'admin') {
      registro.adminIdNuevo = id;          // el dueño apunta a sí mismo
      propietarios.push(registro);
    } else {
      const tenant = u.adminId || u.creadoPor || null;
      if (!tenant) {
        huerfanos.push(registro);          // no se toca — requiere decisión humana
      } else {
        registro.adminIdNuevo = tenant;
        subUsuarios.push(registro);
      }
    }
  });

  // ── Reporte ────────────────────────────────────────────────────────────────
  console.log(`\n📊 Total de documentos en 'users': ${snap.size}\n`);

  console.log(`👑 PROPIETARIOS (suscriptores) — se marcarán esPropietario=true: ${propietarios.length}`);
  propietarios.forEach(p => console.log(`   · ${p.nombre.padEnd(28)} ${p.email.padEnd(32)} [${p.id}]`));

  console.log(`\n👥 SUB-USUARIOS — se marcarán esPropietario=false: ${subUsuarios.length}`);
  subUsuarios.forEach(p => console.log(`   · ${p.nombre.padEnd(28)} ${String(p.role).padEnd(12)} → tenant ${p.adminIdNuevo}`));

  if (yaMigrados.length) {
    console.log(`\n✅ YA MIGRADOS (se omiten): ${yaMigrados.length}`);
  }

  if (huerfanos.length) {
    console.log(`\n⚠️  HUÉRFANOS — NO se tocan, requieren revisión manual: ${huerfanos.length}`);
    huerfanos.forEach(p => console.log(`   · ${p.nombre.padEnd(28)} ${String(p.role).padEnd(12)} [${p.id}]`));
    console.log('   → Son usuarios sin rol admin y sin adminId ni creadoPor.');
    console.log('     Probablemente basura de pruebas. Revíselos antes de aplicar.');
  }

  // ── Aviso de riesgo: más de un propietario compartiendo email/empresa ──────
  const emails = {};
  propietarios.forEach(p => { emails[p.email] = (emails[p.email] || 0) + 1; });
  const repetidos = Object.entries(emails).filter(([, n]) => n > 1);
  if (repetidos.length) {
    console.log(`\n⚠️  Emails de propietario repetidos: ${repetidos.map(([e]) => e).join(', ')}`);
  }

  if (!APLICAR) {
    linea();
    console.log('🔍 Simulación terminada. No se escribió nada.');
    console.log('   Si el reporte se ve correcto, ejecute:');
    console.log('   node scripts/migrar-propietarios.js --aplicar');
    linea();
    process.exit(0);
  }

  // ── Escritura por lotes ────────────────────────────────────────────────────
  linea();
  console.log('✍️  Aplicando cambios...');

  const aEscribir = [
    ...propietarios.map(p => ({ id: p.id, datos: { esPropietario: true,  adminId: p.id } })),
    ...subUsuarios.map(p  => ({ id: p.id, datos: { esPropietario: false, adminId: p.adminIdNuevo } })),
  ];

  let escritos = 0;
  for (let i = 0; i < aEscribir.length; i += 400) {
    const lote  = aEscribir.slice(i, i + 400);
    const batch = db.batch();
    lote.forEach(({ id, datos }) => {
      batch.update(db.collection('users').doc(id), {
        ...datos,
        migradoMultiadmin: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    escritos += lote.length;
    console.log(`   lote ${Math.floor(i / 400) + 1}: ${lote.length} documentos ✓`);
  }

  // ── Registro en auditoría ──────────────────────────────────────────────────
  await db.collection('audit_logs').add({
    accion:        'MIGRACION_MULTIADMIN',
    modulo:        'usuarios',
    descripcion:   `Migración MULTIADMIN-001: ${propietarios.length} propietarios y ${subUsuarios.length} sub-usuarios marcados`,
    usuarioId:     'sistema',
    usuarioNombre: 'Script de migración',
    datos: {
      propietarios: propietarios.length,
      subUsuarios:  subUsuarios.length,
      huerfanos:    huerfanos.length,
    },
    fecha:     new Date().toISOString(),
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  linea();
  console.log(`✅ Migración completada: ${escritos} documentos actualizados.`);
  console.log('   Ya puede desplegar routes/auth.js y routes/users.js nuevos.');
  linea();
  process.exit(0);
})().catch(err => {
  console.error('\n❌ Error en la migración:', err);
  process.exit(1);
});
