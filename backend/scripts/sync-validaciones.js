#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// sync-validaciones.js — Mantiene sincronizado el motor de reglas de egresos
// ─────────────────────────────────────────────────────────────────────────────
// EGRESO-INTELIGENTE-001
//
// El motor de validación vive en dos lugares porque cumple dos funciones:
//   · backend/services/validacionEgresos.js  → valida AL GUARDAR (autoridad)
//   · frontend/src/utils/validacionEgresos.js → valida MIENTRAS SE DIGITA (UX)
//
// Si las dos copias se desincronizan, el usuario ve una advertencia que el
// servidor no aplica (o al revés), que es peor que no tener validación.
//
// Este script regenera la copia del frontend a partir del backend. La fuente
// de verdad es SIEMPRE el backend.
//
//   Uso:  node backend/scripts/sync-validaciones.js
//         node backend/scripts/sync-validaciones.js --check   (solo verifica)
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const RAIZ     = path.resolve(__dirname, '..', '..');
const ORIGEN   = path.join(RAIZ, 'backend', 'services', 'validacionEgresos.js');
const DESTINO  = path.join(RAIZ, 'frontend', 'src', 'utils', 'validacionEgresos.js');
const MARCA    = '// ─── Severidades ──';

const CABECERA = `// ═══════════════════════════════════════════════════════════════════════════════
// validacionEgresos.js (FRONTEND) — ⚠️ ARCHIVO ESPEJO · NO EDITAR A MANO
// ─────────────────────────────────────────────────────────────────────────────
// Copia exacta de backend/services/validacionEgresos.js, con la única
// diferencia del sistema de módulos (ESM en vez de CommonJS).
//
// POR QUÉ ESTÁ DUPLICADO
// El frontend valida MIENTRAS se digita (feedback inmediato, sin ida y vuelta
// al servidor). El backend valida AL GUARDAR (nadie puede saltarse la regla
// llamando la API directo). Las dos capas deben aplicar EXACTAMENTE las mismas
// reglas, si no el usuario ve una cosa y el sistema guarda otra.
//
// CÓMO ACTUALIZARLO
// Editá SIEMPRE backend/services/validacionEgresos.js y volvé a generar este:
//     node backend/scripts/sync-validaciones.js
// ═══════════════════════════════════════════════════════════════════════════════

`;

function generar() {
  const src = fs.readFileSync(ORIGEN, 'utf8');
  const i = src.indexOf(MARCA);
  if (i === -1) {
    console.error(`✖ No se encontró la marca "${MARCA}" en el origen.`);
    process.exit(1);
  }
  const cuerpo = src.slice(i).replace(
    'module.exports = { validarEgreso, auditarLote, norm, GRAVE, MEDIA, LEVE };',
    'export { validarEgreso, auditarLote, norm, GRAVE, MEDIA, LEVE };'
  );
  return CABECERA + cuerpo;
}

const esperado = generar();
const soloVerificar = process.argv.includes('--check');

if (soloVerificar) {
  const actual = fs.existsSync(DESTINO) ? fs.readFileSync(DESTINO, 'utf8') : '';
  if (actual === esperado) {
    console.log('✓ El motor de validaciones está sincronizado.');
    process.exit(0);
  }
  console.error('✖ DESINCRONIZADO: el frontend no refleja las reglas del backend.');
  console.error('  Corregí con:  node backend/scripts/sync-validaciones.js');
  process.exit(1);
}

fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
fs.writeFileSync(DESTINO, esperado, 'utf8');
console.log(`✓ Sincronizado → ${path.relative(RAIZ, DESTINO)} (${esperado.split('\n').length} líneas)`);
