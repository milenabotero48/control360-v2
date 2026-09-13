// ═════════════════════════════════════════════════════════════════════════════
// suscripcionEstado.js — Fuente ÚNICA de verdad del bloqueo por suscripción
// ─────────────────────────────────────────────────────────────────────────────
// SUSCRIPCION-BLOQUEO-001
//
// Regla de negocio (decidida por la dueña, sep 2026):
//   · Vencimiento + DÍAS DE GRACIA (5 por defecto) → la cuenta se SUSPENDE
//     sola: todas las peticiones del tenant reciben 402 y la app muestra la
//     pantalla de pago. Bloqueo total (no solo lectura).
//   · `estado: 'suspendido'` puesto a mano por el SuperAdmin bloquea de
//     inmediato, sin esperar la gracia.
//   · `graciaHasta: 'YYYY-MM-DD'` extiende la gracia a una fecha concreta
//     ("mañana pago"): mientras no pase esa fecha, no se bloquea.
//   · Un tenant SIN documento de suscripción NO se bloquea (suscriptores
//     antiguos sin backfill): se marca `sin_suscripcion` para que el panel
//     lo muestre, pero nunca se le cierra la app por un dato que falta.
//   · El SuperAdmin nunca se bloquea (lo decide el middleware, no este módulo).
//
// El estado se CALCULA de la fecha en cada consulta (no depende de que un
// cron corra) y se cachea 60 s por tenant para no gastar lecturas.
// ═════════════════════════════════════════════════════════════════════════════

const { db } = require('../config/firebase');

const DIAS_GRACIA_DEFAULT = 5;
const CACHE_MS = 60 * 1000;
const _cache = new Map(); // adminId → { data, exp }

const hoyCO = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

// Días restantes hasta el vencimiento (negativo = vencido hace N días).
const diasRestantes = (fechaVencimiento) => {
  if (!fechaVencimiento) return null;
  const fin = new Date(`${String(fechaVencimiento).slice(0, 10)}T23:59:59.999-05:00`);
  return Math.ceil((fin.getTime() - Date.now()) / 86400000);
};

// Días calendario transcurridos desde el vencimiento (0 = vence hoy).
const diasCalendarioVencida = (fechaVencimiento) => {
  const [y1, m1, d1] = String(fechaVencimiento).slice(0, 10).split('-').map(Number);
  const [y2, m2, d2] = hoyCO().split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};

// ─── Evaluación pura (testeable sin Firestore) ───────────────────────────────
function evaluarSuscripcion(sus) {
  if (!sus) {
    return { estado: 'sin_suscripcion', bloqueada: false, dias: null, diasGracia: DIAS_GRACIA_DEFAULT, plan: null, fechaVencimiento: null, motivo: null };
  }
  const diasGracia = Number.isFinite(Number(sus.diasGracia)) ? Math.max(0, Number(sus.diasGracia)) : DIAS_GRACIA_DEFAULT;
  const dias = diasRestantes(sus.fechaVencimiento);
  const base = { plan: sus.plan || null, fechaVencimiento: sus.fechaVencimiento || null, diasGracia, dias, graciaHasta: sus.graciaHasta || null };

  if (sus.estado === 'suspendido') {
    return { ...base, estado: 'suspendido', bloqueada: true, motivo: sus.motivoSuspension || 'Suspendida por el administrador de la plataforma' };
  }
  if (dias === null) {
    return { ...base, estado: sus.estado || 'activo', bloqueada: false, motivo: null };
  }
  if (dias >= 0) {
    return { ...base, estado: sus.estado || 'activo', bloqueada: false, motivo: null };
  }
  // Vencida: ¿sigue en gracia? Se cuenta en DÍAS CALENDARIO (fecha contra
  // fecha, hora Colombia), no en horas: vencida el 8 con 5 días de gracia →
  // el 13 aún entra, el 14 queda bloqueada, a cualquier hora del día.
  const diasVencida = diasCalendarioVencida(sus.fechaVencimiento);
  const graciaExtendida = sus.graciaHasta && String(sus.graciaHasta).slice(0, 10) >= hoyCO();
  const enGracia = diasVencida <= diasGracia || graciaExtendida;
  if (enGracia) {
    return { ...base, estado: 'gracia', bloqueada: false, motivo: null };
  }
  return { ...base, estado: 'suspendido', bloqueada: true, motivo: 'Suscripción vencida sin pago', automatica: true };
}

// ─── Lectura con caché ───────────────────────────────────────────────────────
async function obtenerEstadoTenant(adminId) {
  if (!adminId) return evaluarSuscripcion(null);
  const c = _cache.get(adminId);
  if (c && Date.now() < c.exp) return c.data;
  let data;
  try {
    const doc = await db.collection('suscripciones').doc(adminId).get();
    data = evaluarSuscripcion(doc.exists ? doc.data() : null);
  } catch (err) {
    // Fail-open: un error de Firestore nunca bloquea a un suscriptor.
    console.error('[SUSCRIPCION] Error leyendo estado:', err.message);
    data = { ...evaluarSuscripcion(null), error: true };
  }
  _cache.set(adminId, { data, exp: Date.now() + CACHE_MS });
  return data;
}

function invalidarCacheSuscripcion(adminId) {
  if (adminId) _cache.delete(adminId); else _cache.clear();
}

// Texto público para el frontend (sin datos internos)
function resumenPublico(ev) {
  return {
    estado: ev.estado,
    bloqueada: ev.bloqueada === true,
    dias: ev.dias,
    diasGracia: ev.diasGracia,
    plan: ev.plan,
    fechaVencimiento: ev.fechaVencimiento,
    graciaHasta: ev.graciaHasta || null,
    motivo: ev.bloqueada ? ev.motivo : null
  };
}

module.exports = {
  DIAS_GRACIA_DEFAULT,
  diasRestantes,
  diasCalendarioVencida,
  hoyCO,
  evaluarSuscripcion,
  obtenerEstadoTenant,
  invalidarCacheSuscripcion,
  resumenPublico
};
