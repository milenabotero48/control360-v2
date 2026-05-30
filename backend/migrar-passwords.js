/**
 * Control360 — Script de migración de contraseñas (Ola 1)
 * ─────────────────────────────────────────────────────────────────
 * Hashea con bcrypt las contraseñas que aún están en texto plano.
 *
 * CORRER UNA SOLA VEZ desde la carpeta del backend:
 *   node migrar-passwords.js
 *
 * El script es idempotente: si vuelves a correrlo, detecta que ya
 * están hasheadas y no hace nada.
 *
 * Detección de "ya hasheado": las contraseñas bcrypt empiezan por
 * "$2a$", "$2b$" o "$2y$" y miden ~60 caracteres.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('./config/firebase');

const SALT_ROUNDS = 10;

const yaHasheada = (valor) =>
  typeof valor === 'string' &&
  valor.length >= 50 &&
  /^\$2[aby]\$/.test(valor);

(async () => {
  console.log('\n🔐 Control360 — Migración de contraseñas a bcrypt\n');

  try {
    const snap = await db.collection('users').get();

    if (snap.empty) {
      console.log('⚠  No hay usuarios en la base. Nada que migrar.');
      process.exit(0);
    }

    let migrados = 0;
    let yaListos = 0;
    let sinPassword = 0;
    let errores = 0;

    for (const doc of snap.docs) {
      const u = doc.data();
      const passActual = u.password_hash;

      if (!passActual) {
        sinPassword++;
        console.log(`  ⊘ ${u.email || doc.id}: sin password_hash (se omite)`);
        continue;
      }

      if (yaHasheada(passActual)) {
        yaListos++;
        console.log(`  ✓ ${u.email}: ya estaba hasheada`);
        continue;
      }

      try {
        const hash = await bcrypt.hash(String(passActual), SALT_ROUNDS);
        await doc.ref.update({
          password_hash: hash,
          passwordMigradoAt: new Date().toISOString()
        });
        migrados++;
        console.log(`  ✔ ${u.email}: migrada correctamente`);
      } catch (e) {
        errores++;
        console.log(`  ✖ ${u.email}: error — ${e.message}`);
      }
    }

    console.log('\n─────────────────────────────────────────');
    console.log(`Migrados:      ${migrados}`);
    console.log(`Ya estaban:    ${yaListos}`);
    console.log(`Sin password:  ${sinPassword}`);
    console.log(`Errores:       ${errores}`);
    console.log('─────────────────────────────────────────\n');

    if (errores === 0) {
      console.log('✅ Migración completada sin errores.\n');
    } else {
      console.log('⚠  Migración terminó con errores. Revisa los logs.\n');
    }

    process.exit(0);
  } catch (e) {
    console.error('\n❌ Error fatal:', e);
    process.exit(1);
  }
})();
