// ============================================================
// Control360 — Limpieza: semilla contaminada de Anny (ANNY-FUGA-035)
// Ubicación: backend/scripts/limpiar-semilla-anny.js
// ------------------------------------------------------------
// EJECUTAR:
//   node backend/scripts/limpiar-semilla-anny.js            → SIMULACIÓN
//   node backend/scripts/limpiar-semilla-anny.js --aplicar  → aplica
//
// QUÉ PROBLEMA LIMPIA
// -------------------
// Hasta este fix, `annyService.RESPUESTAS_BASE` traía quemados en el
// código los PRECIOS, la DIRECCIÓN y los HORARIOS de una empresa
// concreta. Esa base:
//   1. se entregaba a cualquier tenant que no tuviera respuestas propias, y
//   2. se COPIABA dentro de `respuestasAnny/{adminId}` la primera vez que
//      un suscriptor guardaba UNA entrada en la pestaña Entrenamiento
//      (routes/anny.js).
//
// Por (2) la contaminación quedó PERSISTIDA en la base de datos de
// suscriptores reales. El código ya no la sirve (el atajo descarta toda
// entrada con precio), pero esas entradas siguen visibles en la pestaña
// Entrenamiento de cada suscriptor y confunden a quien la administra.
// Este script las retira.
//
// SEGURIDAD
// ---------
// · Solo borra una entrada si su TEXTO COINCIDE EXACTAMENTE con el de la
//   semilla original. Si el suscriptor la editó (aunque sea una coma), se
//   considera SUYA y NO se toca.
// · No borra ninguna entrada creada por el suscriptor.
// · Corre en simulación por defecto: sin --aplicar no escribe nada.
// · Guarda un respaldo JSON del documento completo antes de modificarlo.
// ============================================================

require('dotenv').config();
require('../config/firebase');

const fs = require('fs');
const path = require('path');
const { db } = require('../config/firebase');

const APLICAR = process.argv.includes('--aplicar');

// Texto EXACTO de la semilla que se retiró del código en ANNY-FUGA-035.
// Solo se borra lo que coincida carácter por carácter con esto.
const SEMILLA_CONTAMINADA = {
  precio_abc_5lb: 'Recarga ABC 5 lb: $19.000',
  precio_abc_10lb: 'Recarga ABC 10 lb: $25.000',
  domicilio: 'Sí, hacemos domicilio. Cali: $8.000. Otros sectores: se valida con logística. ¿A qué sector?',
  horario: 'Martes-Viernes: 8am-5pm\nSábado: 8am-12pm\nDomingo-Lunes: Cerrado',
  datos_cotizacion: 'Perfecto, envíame estos datos:\n✅ Nombre:\n✅ Cédula o NIT:\n✅ Correo:\n✅ Dirección y barrio:\n✅ Celular:',
  ubicacion: 'Estamos en: Cl. 22 Nte. #5bn28, San Vicente, Cali, Valle del Cauca\nMaps: https://maps.google.com/maps/search/extintores+del+valle+sas'
};

(async () => {
  console.log(APLICAR ? '⚙️  MODO APLICAR — se escribirá en Firestore\n' : '🔍 SIMULACIÓN — no se escribe nada. Usa --aplicar para ejecutar.\n');

  const snap = await db.collection('respuestasAnny').get();
  const reporte = [];
  let docsAfectados = 0;
  let entradasRetiradas = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const aBorrar = [];

    for (const [key, textoSemilla] of Object.entries(SEMILLA_CONTAMINADA)) {
      const entrada = data[key];
      if (!entrada || typeof entrada !== 'object') continue;
      // Coincidencia exacta = el suscriptor nunca la tocó → es semilla heredada.
      if (String(entrada.respuesta) === textoSemilla) aBorrar.push(key);
    }

    if (!aBorrar.length) continue;

    docsAfectados += 1;
    entradasRetiradas += aBorrar.length;
    reporte.push({ adminId: doc.id, retiradas: aBorrar, documentoOriginal: data });

    console.log(`· tenant ${doc.id} → retirar: ${aBorrar.join(', ')}`);

    if (APLICAR) {
      const limpio = { ...data };
      for (const k of aBorrar) delete limpio[k];
      await doc.ref.set(limpio);
    }
  }

  console.log(`\nTenants afectados: ${docsAfectados}`);
  console.log(`Entradas de semilla retiradas: ${entradasRetiradas}`);

  if (reporte.length) {
    const archivo = path.join(__dirname, '..', `respaldo-semilla-anny-${Date.now()}.json`);
    fs.writeFileSync(archivo, JSON.stringify(reporte, null, 2), 'utf8');
    console.log(`Respaldo guardado en: ${archivo}`);
  }

  if (!APLICAR && docsAfectados) {
    console.log('\n→ Revisa el respaldo y vuelve a correr con --aplicar.');
  }

  console.log('\n⚠️  Después de aplicar, cada suscriptor debe revisar su pestaña');
  console.log('   Entrenamiento y cargar SUS horarios, dirección y domicilio.');
  console.log('   Los PRECIOS ya no van ahí: salen del módulo de Productos.');

  process.exit(0);
})().catch(err => {
  console.error('Error en la limpieza:', err);
  process.exit(1);
});
