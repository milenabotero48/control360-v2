/**
 * Control360 — ✅ MIGRA-TEL-001: Normalización de teléfonos guardados
 * ─────────────────────────────────────────────────────────────────
 * PROBLEMA: el importador de vencimientos guardaba teléfonos con prefijo
 * 57 (573105116567) mientras que telemercadeo y conversiones guardan
 * 10 dígitos limpios (3105116567). El mismo cliente existía con dos
 * formatos y los emparejamientos anti-duplicado nunca casaban.
 *
 * ESTE SCRIPT normaliza a la regla única DUP-002 en las colecciones:
 *   · clients     → campos `celular` y `telefono`
 *   · prospectos  → campo  `telefono`
 *   · vencimientos→ campo  `telefono` (algunos registros lo traen de Lucy)
 *
 * REGLA: solo dígitos; si son 12 y empiezan por 57 → se quita el 57.
 * Solo toca documentos donde el valor normalizado sea DISTINTO al guardado.
 * Aplica a TODOS los tenants (es corrección de formato de datos, no de
 * negocio) — cada cambio conserva su adminId intacto.
 *
 * CÓMO CORRERLO (desde la carpeta del backend, igual que reparar-admin.js):
 *
 *   1. SIMULACIÓN (no escribe nada, solo reporta):
 *        node migrar-telefonos.js
 *
 *   2. APLICAR (escribe los cambios):
 *        node migrar-telefonos.js --aplicar
 *
 * Es idempotente: si vuelves a correrlo, reporta 0 cambios.
 */

require('dotenv').config();
const { db } = require('./config/firebase');

const APLICAR = process.argv.includes('--aplicar');

// Misma regla que comercial.js / vencimientos.js (TELEFONO-UNIF-001)
const normalizar = (telefono) => {
  if (!telefono) return null;
  let t = String(telefono).replace(/[\s\-().+]/g, '').replace(/\D/g, '');
  if (t.length === 12 && t.startsWith('57')) t = t.slice(2);
  return t || null;
};

const migrarColeccion = async (coleccion, campos) => {
  const snap = await db.collection(coleccion).get();
  console.log(`\n📁 ${coleccion}: ${snap.size} documentos leídos`);

  let cambiosTotales = 0;
  const porTenant = {};
  let batch = db.batch();
  let ops = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const cambios = {};

    for (const campo of campos) {
      const actual = data[campo];
      if (!actual) continue;
      const norm = normalizar(actual);
      if (norm && norm !== String(actual)) {
        cambios[campo] = norm;
      }
    }

    if (Object.keys(cambios).length) {
      cambiosTotales++;
      const tenant = data.adminId || 'sin_adminId';
      porTenant[tenant] = (porTenant[tenant] || 0) + 1;

      if (APLICAR) {
        batch.update(doc.ref, cambios);
        ops++;
        if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
      } else if (cambiosTotales <= 10) {
        // Muestra de ejemplo en simulación (máx. 10 por colección)
        const detalle = Object.entries(cambios)
          .map(([k, v]) => `${k}: ${data[k]} → ${v}`).join(' · ');
        console.log(`   · ${doc.id}: ${detalle}`);
      }
    }
  }

  if (APLICAR && ops > 0) await batch.commit();

  console.log(`   ${APLICAR ? '✓ Normalizados' : '→ Se normalizarían'}: ${cambiosTotales}`);
  Object.entries(porTenant).forEach(([t, n]) => console.log(`     tenant ${t}: ${n}`));
  return cambiosTotales;
};

(async () => {
  console.log('\n🔧 Control360 — MIGRA-TEL-001: normalización de teléfonos');
  console.log(APLICAR
    ? '⚠️  MODO APLICAR: se escribirán los cambios en Firestore.\n'
    : '👀 MODO SIMULACIÓN: no se escribe nada. Corre con --aplicar para ejecutar.\n');

  try {
    const total =
      await migrarColeccion('clients', ['celular', 'telefono']) +
      await migrarColeccion('prospectos', ['telefono']) +
      await migrarColeccion('vencimientos', ['telefono']);

    console.log('\n─────────────────────────────────────────');
    if (total === 0) {
      console.log('✅ Todo ya estaba normalizado. No hay nada que cambiar.');
    } else if (APLICAR) {
      console.log(`✅ Migración aplicada: ${total} documentos normalizados.`);
    } else {
      console.log(`ℹ️  ${total} documentos pendientes. Ejecuta:  node migrar-telefonos.js --aplicar`);
    }
    console.log('─────────────────────────────────────────\n');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ Error:', e.message);
    process.exit(1);
  }
})();
