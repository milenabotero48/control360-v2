// ═════════════════════════════════════════════════════════════════════════════
// _autorizacion.js — FUENTE ÚNICA DE VERDAD para autorización por PIN
// ─────────────────────────────────────────────────────────────────────────────
// FIX PIN-UNICO-001
//
// Problema que resuelve:
//   Antes existían TRES caminos distintos para "autorizar una acción sensible":
//     1) egresos.js         → helper local verificarPinUsuario (PIN del logueado)
//     2) orders.js          → helper local IDÉNTICO pero, en cartera vencida,
//                             validaba el PIN del ADMIN DEL TENANT, no el del
//                             usuario logueado → el frontend validaba una cosa
//                             y el backend otra.
//     3) GestionEgresos.js  → /users/verificar-password (CONTRASEÑA de login),
//                             mientras el backend exigía `pin` → flujo roto.
//   Resultado operativo: "no sé cuál es el PIN de cada cosa".
//
// Regla desde ahora — UNA SOLA:
//   El PIN es SIEMPRE el del USUARIO LOGUEADO (colección `users`, campo `pin`,
//   4 dígitos). Lo que cambia por acción NO es el PIN, sino QUÉ ROLES pueden
//   ejecutar esa acción. Eso vive en MATRIZ_ACCIONES, aquí abajo, y en ningún
//   otro archivo.
//
// Para cambiar quién puede hacer qué: se edita SOLO este archivo.
// ═════════════════════════════════════════════════════════════════════════════

const { db } = require('../config/firebase');

// Roles que pueden tener PIN operativo. Otros roles pueden tener el campo
// guardado, pero nunca autorizan nada.
const ROLES_CON_PIN = ['admin', 'tesoreria'];

// ─────────────────────────────────────────────────────────────────────────────
// MATRIZ DE ACCIONES — quién puede autorizar cada acción sensible.
// `null` en roles = cualquier rol con PIN (admin + tesorería).
// ─────────────────────────────────────────────────────────────────────────────
const MATRIZ_ACCIONES = {
  // ── Egresos ───────────────────────────────────────────────────────────────
  cuadrar_egreso:       { roles: ['admin', 'tesoreria'], etiqueta: 'Cuadrar egreso provisional' },
  editar_egreso_pagado: { roles: ['admin'],              etiqueta: 'Editar egreso ya pagado'   },
  anular_egreso:        { roles: ['admin'],              etiqueta: 'Anular egreso pagado'      },

  // ── Órdenes ───────────────────────────────────────────────────────────────
  anular_orden:         { roles: ['admin'],              etiqueta: 'Anular orden de servicio'  },
  validar_pago:         { roles: ['admin', 'tesoreria'], etiqueta: 'Validar pago electrónico'  },

  // ── Cartera ───────────────────────────────────────────────────────────────
  // ⚠️ DECISIÓN DE NEGOCIO (cambiar aquí si se quiere más restrictivo):
  //    hoy Tesorería TAMBIÉN puede autorizar una venta a cliente bloqueado.
  //    Para dejarlo solo en manos del admin: roles: ['admin'].
  autorizar_cartera:    { roles: ['admin', 'tesoreria'], etiqueta: 'Autorizar cliente bloqueado por cartera' },

  // ── Vencimientos ──────────────────────────────────────────────────────────
  // ✅ VENC-EDICION-001: el vencimiento es el activo comercial del negocio —
  // de él salen las llamadas de Lucy, las alertas y la proyección de venta.
  // Editarlo cambia CUÁNDO se le vuelve a vender a ese cliente; borrarlo lo
  // saca del radar para siempre. Por eso pasan por PIN igual que un egreso.
  editar_vencimiento:   { roles: ['admin'], etiqueta: 'Editar vencimiento'  },
  borrar_vencimiento:   { roles: ['admin'], etiqueta: 'Borrar vencimiento'  },

  // Revertir una importación borra en bloque TODO lo que ese archivo creó.
  // Es la acción más destructiva del módulo: solo admin, y con motivo escrito.
  revertir_importacion: { roles: ['admin'], etiqueta: 'Revertir importación completa' },
};

// Códigos de error estables para que el frontend pueda reaccionar distinto
// (p. ej. ofrecer "configurar mi PIN") sin comparar textos.
const CODIGOS = {
  PIN_REQUERIDO:     'PIN_REQUERIDO',
  SESION_INVALIDA:   'SESION_INVALIDA',
  USUARIO_NO_EXISTE: 'USUARIO_NO_EXISTE',
  ROL_NO_AUTORIZADO: 'ROL_NO_AUTORIZADO',
  SIN_PIN:           'SIN_PIN',
  PIN_INCORRECTO:    'PIN_INCORRECTO',
};

/**
 * Verifica el PIN del usuario logueado contra la matriz de acciones.
 *
 * @param {string} uid    - req.user.uid || req.user.id (SIEMPRE el logueado)
 * @param {string} pin    - PIN de 4 dígitos enviado en el body
 * @param {string} accion - clave de MATRIZ_ACCIONES (opcional; si no se pasa,
 *                          se aplica la regla base: admin + tesorería)
 * @returns {{ ok: boolean, error?: string, codigo?: string, usuario?: object }}
 */
const verificarPin = async (uid, pin, accion = null) => {
  if (!pin)  return { ok: false, codigo: CODIGOS.PIN_REQUERIDO,   error: 'PIN requerido' };
  if (!uid)  return { ok: false, codigo: CODIGOS.SESION_INVALIDA, error: 'Sesión inválida' };

  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) {
    return { ok: false, codigo: CODIGOS.USUARIO_NO_EXISTE, error: 'Usuario no encontrado' };
  }

  const u = doc.data();

  // 1) Regla base: el rol debe poder tener PIN operativo.
  if (!ROLES_CON_PIN.includes(u.role)) {
    return { ok: false, codigo: CODIGOS.ROL_NO_AUTORIZADO, error: 'Tu rol no puede autorizar esta acción' };
  }

  // 2) Regla por acción (si la acción está declarada en la matriz).
  const regla = accion ? MATRIZ_ACCIONES[accion] : null;
  if (regla && Array.isArray(regla.roles) && !regla.roles.includes(u.role)) {
    return {
      ok: false,
      codigo: CODIGOS.ROL_NO_AUTORIZADO,
      error: `Tu rol no está autorizado para: ${regla.etiqueta}`,
    };
  }

  // 3) PIN configurado.
  if (!u.pin) {
    return {
      ok: false,
      codigo: CODIGOS.SIN_PIN,
      error: 'No tienes PIN configurado. Pídele al administrador que te lo asigne en Gestión de Usuarios.',
    };
  }

  // 4) PIN correcto.
  if (String(u.pin) !== String(pin)) {
    return { ok: false, codigo: CODIGOS.PIN_INCORRECTO, error: 'PIN incorrecto' };
  }

  return {
    ok: true,
    usuario: { id: uid, nombre: u.nombre || u.email, email: u.email, role: u.role },
  };
};

module.exports = { verificarPin, MATRIZ_ACCIONES, ROLES_CON_PIN, CODIGOS };
