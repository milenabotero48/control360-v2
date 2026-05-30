/**
 * Control360 — Reparar usuario admin existente
 * ─────────────────────────────────────────────────────────────────
 * Tu usuario admin original se creó fuera del módulo de Gestión de Usuarios
 * y por eso le faltan campos. Este script:
 *   1. Lo encuentra por email
 *   2. Completa los campos faltantes con valores correctos
 *   3. Le asigna el PIN
 *
 * CORRER UNA SOLA VEZ desde la carpeta del backend:
 *   node reparar-admin.js
 *
 * Es idempotente: si ya tiene los campos no los pisa, solo agrega los
 * que faltan. Si vuelves a correrlo, no hace daño.
 *
 * Para cambiar el email o el PIN, edita las constantes de abajo.
 */

require('dotenv').config();
const { db, admin } = require('./config/firebase');

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────
const ADMIN_EMAIL = 'sandra@empresa.com';
const ADMIN_NOMBRE = 'Sandra Botero';
const ADMIN_CODIGO = '3999';
const ADMIN_PIN    = '3999';
// ─────────────────────────────────────────────────────────────────────────────

const MODULOS_ADMIN = [
  'dashboard', 'usuarios', 'empresas', 'ordenes', 'cotizaciones', 'clientes',
  'productos', 'proveedores', 'logistica', 'taller', 'qr', 'egresos', 'caja',
  'cxc', 'cxp', 'reportes', 'auditoria'
];

(async () => {
  console.log('\n🔧 Control360 — Reparar usuario admin\n');

  try {
    // 1. Buscar el admin por email
    const snap = await db.collection('users')
      .where('email', '==', ADMIN_EMAIL)
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`✖ No se encontró ningún usuario con email ${ADMIN_EMAIL}`);
      console.log('  Revisa el email en este script y vuelve a correrlo.\n');
      process.exit(1);
    }

    const doc = ADMIN_EMAIL ? snap.docs[0] : null;
    const datos = doc.data();
    const id = doc.id;

    console.log(`✓ Admin encontrado: ${ADMIN_EMAIL} (id: ${id})`);
    console.log('  Campos actuales:', Object.keys(datos).join(', '));

    // 2. Calcular qué campos faltan o están con nombre incorrecto
    const cambios = {};
    const ahora = new Date().toISOString();

    if (!datos.uid)            cambios.uid = id;
    if (!datos.nombre)         cambios.nombre = ADMIN_NOMBRE;
    if (!datos.codigo)         cambios.codigo = ADMIN_CODIGO;
    if (!datos.pin)            cambios.pin = ADMIN_PIN;
    if (!datos.modulos || !Array.isArray(datos.modulos) || datos.modulos.length === 0) {
      cambios.modulos = MODULOS_ADMIN;
    }

    // Compatibilidad: el original tenía "active" (en inglés), el sistema usa "activo"
    if (datos.activo === undefined) {
      cambios.activo = datos.active !== false; // si tiene "active:true" lo mantenemos
    }

    if (!datos.creadoPor)      cambios.creadoPor = id; // el admin es su propio creador
    if (!datos.creadoPorNombre) cambios.creadoPorNombre = ADMIN_NOMBRE;

    // createdAt: si no existe, lo creamos con la fecha actual o created_at vieja
    if (!datos.createdAt) {
      cambios.createdAt = datos.created_at
        ? datos.created_at
        : admin.firestore.FieldValue.serverTimestamp();
    }

    cambios.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    if (Object.keys(cambios).length === 1) {
      // Solo updatedAt — ya estaba todo bien
      console.log('\n✓ El admin ya tenía todos los campos. No se cambió nada.\n');
      process.exit(0);
    }

    // 3. Aplicar los cambios
    await doc.ref.update(cambios);

    console.log('\n✓ Campos agregados/corregidos:');
    Object.keys(cambios).forEach(k => {
      if (k === 'pin') {
        console.log(`    ${k}: **** (oculto)`);
      } else if (k === 'updatedAt' || k === 'createdAt') {
        console.log(`    ${k}: (timestamp del servidor)`);
      } else {
        const val = cambios[k];
        const display = Array.isArray(val) ? `[${val.length} items]` : val;
        console.log(`    ${k}: ${display}`);
      }
    });

    console.log('\n─────────────────────────────────────────');
    console.log('✅ Admin reparado correctamente.');
    console.log('   Cierra sesión y vuelve a entrar.');
    console.log('   Tu usuario debe aparecer ahora en "Gestión de Usuarios".');
    console.log('   Tu PIN configurado es: ' + ADMIN_PIN);
    console.log('─────────────────────────────────────────\n');

    process.exit(0);
  } catch (e) {
    console.error('\n❌ Error:', e.message);
    process.exit(1);
  }
})();
