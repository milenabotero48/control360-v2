// ════════════════════════════════════════════════════════════════════════════════
// scripts/migrar-propietarios.js — RETIRADO (2026-08-21)
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ ESTE SCRIPT YA NO DEBE EJECUTARSE. Se deja como archivo inerte a propósito,
// para que nadie lo recupere del historial de git y lo corra sin contexto.
//
// POR QUÉ SE RETIRÓ
// Clasificaba la propiedad del tenant por ROL:
//       role === 'admin'  →  esPropietario = true
// Se escribió asumiendo que ningún suscriptor tenía todavía administradores
// secundarios. El diagnóstico del 2026-08-21 mostró que sí los hay (MAYKOL
// SUAREZ en Extintores del Valle SAS, y Gabriel en el tenant de Gabriel Samuel
// Duvan Gómez). Sobre esta base de datos el script los habría marcado como
// dueños de tenants fantasma, fijando el error de forma permanente.
//
// Dicho de otro modo: aplicaba justamente la regla que este cambio vino a
// eliminar — que el rol decida la empresa.
//
// QUÉ USAR EN SU LUGAR
//   1. node scripts/diagnostico-multiadmin.js
//        Solo lectura. Muestra a qué empresa entra cada usuario y por qué.
//
//   2. node scripts/reparar-subadmin.js <TENANT_ID>
//        Repara los usuarios de UN tenant, con simulación previa.
//        Clasifica por `creadoPor` (el campo confiable), nunca por rol.
//
// Además, el login ya se autocura: marca esPropietario=false a quien tenga un
// `adminId` que apunte a otro tenant. Nunca declara propietario a nadie por
// inferencia — esa decisión es del registro o de una revisión manual.
// ═══════════════════════════════════════════════════════════════════════════════

console.error(`
════════════════════════════════════════════════════════════════════
  ⛔ SCRIPT RETIRADO — no se ejecutó nada.
════════════════════════════════════════════════════════════════════

  migrar-propietarios.js clasificaba la propiedad del tenant por ROL,
  que es exactamente la regla equivocada que MULTIADMIN-001 eliminó.
  Sobre la base de datos actual marcaría a los administradores
  secundarios como dueños de empresas fantasma.

  Use en su lugar:

    node scripts/diagnostico-multiadmin.js
        → solo lectura, muestra el estado real

    node scripts/reparar-subadmin.js <TENANT_ID>
        → repara un tenant, con simulación previa

  Detalle completo en los comentarios de este archivo.

════════════════════════════════════════════════════════════════════
`);

process.exit(1);
