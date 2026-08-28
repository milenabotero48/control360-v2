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

const RAIZ = path.resolve(__dirname, '..', '..');

// ✅ PAGO-VALIDACION-003: el script pasó de un solo motor a una LISTA. Cada
// regla de negocio que el frontend necesita aplicar en vivo se registra aquí y
// se genera sola. Agregar un motor nuevo = una entrada más en este arreglo.
const MODULOS = [
  {
    nombre:  'validacionEgresos.js',
    origen:  ['backend', 'services', 'validacionEgresos.js'],
    destino: ['frontend', 'src', 'utils', 'validacionEgresos.js'],
    marca:   '// ─── Severidades ──',
    exports: 'module.exports = { validarEgreso, auditarLote, norm, GRAVE, MEDIA, LEVE };',
    esm:     'export { validarEgreso, auditarLote, norm, GRAVE, MEDIA, LEVE };'
  },
  {
    nombre:  'validacionPagos.js',
    origen:  ['backend', 'services', 'validacionPagos.js'],
    destino: ['frontend', 'src', 'utils', 'validacionPagos.js'],
    marca:   '// ─── Normalizador ──',
    exports: `module.exports = {
  norm,
  esPagoVirtual,
  esFormaCredito,
  validaConSuPropioRegistro,
  camposValidacionAutomatica,
  pagoPendienteValidacion,
  ROLES_CON_ACCESO_BANCO
};`,
    esm: `export {
  norm,
  esPagoVirtual,
  esFormaCredito,
  validaConSuPropioRegistro,
  camposValidacionAutomatica,
  pagoPendienteValidacion,
  ROLES_CON_ACCESO_BANCO
};`
  }
];

const cabecera = (m) => `// ═══════════════════════════════════════════════════════════════════════════════
// ${m.nombre} (FRONTEND) — ⚠️ ARCHIVO ESPEJO · NO EDITAR A MANO
// ─────────────────────────────────────────────────────────────────────────────
// Copia exacta de ${m.origen.join('/')}, con la única
// diferencia del sistema de módulos (ESM en vez de CommonJS).
//
// POR QUÉ ESTÁ DUPLICADO
// El frontend aplica la regla MIENTRAS se usa la pantalla (feedback inmediato,
// sin ida y vuelta al servidor). El backend la aplica AL GUARDAR (nadie puede
// saltársela llamando la API directo). Las dos capas deben aplicar EXACTAMENTE
// las mismas reglas, si no el usuario ve una cosa y el sistema guarda otra.
//
// CÓMO ACTUALIZARLO
// Editá SIEMPRE ${m.origen.join('/')} y volvé a generar este:
//     node backend/scripts/sync-validaciones.js
// ═══════════════════════════════════════════════════════════════════════════════

`;

function generar(m) {
  const origen = path.join(RAIZ, ...m.origen);
  const src = fs.readFileSync(origen, 'utf8');
  const i = src.indexOf(m.marca);
  if (i === -1) {
    console.error(`✖ ${m.nombre}: no se encontró la marca "${m.marca}" en el origen.`);
    process.exit(1);
  }
  if (src.indexOf(m.exports) === -1) {
    console.error(`✖ ${m.nombre}: no se encontró el bloque de exports esperado.`);
    process.exit(1);
  }
  return cabecera(m) + src.slice(i).replace(m.exports, m.esm);
}

const soloVerificar = process.argv.includes('--check');
let desincronizados = 0;

for (const m of MODULOS) {
  const destino  = path.join(RAIZ, ...m.destino);
  const esperado = generar(m);

  if (soloVerificar) {
    const actual = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : '';
    if (actual === esperado) {
      console.log(`✓ ${m.nombre} sincronizado.`);
    } else {
      console.error(`✖ ${m.nombre} DESINCRONIZADO: el frontend no refleja las reglas del backend.`);
      desincronizados++;
    }
    continue;
  }

  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, esperado, 'utf8');
  console.log(`✓ Sincronizado → ${path.relative(RAIZ, destino)} (${esperado.split('\n').length} líneas)`);
}

if (soloVerificar && desincronizados > 0) {
  console.error('  Corregí con:  node backend/scripts/sync-validaciones.js');
  process.exit(1);
}
