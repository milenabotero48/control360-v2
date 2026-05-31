// ════════════════════════════════════════════════════════════════════════════════
// helpers.js — Utilidades compartidas Ola 3 Bloque 3 + Camino C
// ─────────────────────────────────────────────────────────────────────────────
// Tres helpers que centralizan lógica que estaba duplicada/inconsistente:
//
//   1. resolverAdminId(req) → uid del admin con cascada de fallbacks.
//   2. tz / fechas → zona Colombia (America/Bogota, UTC-5) consistente.
//   3. log → logger estructurado con módulo + nivel + timestamp.
//
// Backward-compatible: los módulos viejos no se rompen, solo los nuevos usan esto.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 1. Resolver adminId ─────────────────────────────────────────────────────
// El sistema tiene 3 campos para identificar al admin (deuda técnica que
// resolveremos del todo en Ola 5 multi-tenant). Este helper aplica cascada:
//   - req.adminId (puesto por middleware si el user es subordinado)
//   - req.user.uid (Firebase Auth)
//   - req.user.id  (JWT custom)
const resolverAdminId = (req) => {
  return req.adminId
    || req.user?.uid
    || req.user?.id
    || null;
};

// ─── 2. Helpers de fechas en zona Colombia (UTC-5) ──────────────────────────
// IMPORTANTE: toda fecha que se guarde en BD debe ser ISO UTC (toISOString()).
// Para comparar/agrupar usamos el día calendario en Colombia.

const TZ = 'America/Bogota';

// "Hoy" en zona Colombia como string YYYY-MM-DD
const hoyEnCO = () => {
  const ahora = new Date();
  return ahora.toLocaleDateString('en-CA', { timeZone: TZ }); // en-CA da YYYY-MM-DD
};

// Inicio y fin del día COLOMBIANO en UTC (para queries Firestore)
const rangoDiaCO = (yyyymmdd = null) => {
  const fecha = yyyymmdd || hoyEnCO();
  return {
    fechaCO: fecha,
    inicioISO: new Date(`${fecha}T00:00:00-05:00`).toISOString(),
    finISO:    new Date(`${fecha}T23:59:59.999-05:00`).toISOString()
  };
};

// Rango "últimas N horas" desde ahora
const rangoUltimasHoras = (n) => {
  const fin = new Date();
  const ini = new Date(fin.getTime() - (n * 60 * 60 * 1000));
  return { inicioISO: ini.toISOString(), finISO: fin.toISOString() };
};

// Parsea cualquier fecha (Timestamp Firestore, ISO string, Date, _seconds) → Date
const parseFecha = (raw) => {
  if (!raw) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === 'object' && raw._seconds) return new Date(raw._seconds * 1000);
  if (typeof raw === 'object' && typeof raw.toDate === 'function') return raw.toDate();
  if (typeof raw === 'string') return new Date(raw);
  if (typeof raw === 'number') return new Date(raw);
  return null;
};

// Diferencia en horas entre 2 fechas
const horasEntre = (d1, d2) => {
  const a = parseFecha(d1);
  const b = parseFecha(d2) || new Date();
  if (!a) return 0;
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
};

// Diferencia en días entre 2 fechas (redondeado)
const diasEntre = (d1, d2) => Math.floor(horasEntre(d1, d2) / 24);

// ¿Está la fecha dentro del rango ISO?
const dentroDeRango = (val, inicioISO, finISO) => {
  const d = parseFecha(val);
  if (!d) return false;
  const t = d.getTime();
  return t >= new Date(inicioISO).getTime() && t <= new Date(finISO).getTime();
};

// ─── 3. Logger estructurado ──────────────────────────────────────────────────
// Reemplaza el `console.error('xxx:', e)` disperso por un formato consistente.
// Cuando vendas el SaaS y tengas que debugear de lejos, lo agradecerás.
const log = {
  info: (modulo, mensaje, data = null) => {
    const t = new Date().toLocaleString('es-CO', { timeZone: TZ });
    console.log(`[${t}] [INFO]  [${modulo}] ${mensaje}`, data || '');
  },
  warn: (modulo, mensaje, data = null) => {
    const t = new Date().toLocaleString('es-CO', { timeZone: TZ });
    console.warn(`[${t}] [WARN]  [${modulo}] ${mensaje}`, data || '');
  },
  error: (modulo, mensaje, err = null) => {
    const t = new Date().toLocaleString('es-CO', { timeZone: TZ });
    console.error(`[${t}] [ERROR] [${modulo}] ${mensaje}`, err?.message || err || '');
    if (err?.stack && process.env.NODE_ENV !== 'production') console.error(err.stack);
  }
};

module.exports = {
  resolverAdminId,
  TZ,
  hoyEnCO,
  rangoDiaCO,
  rangoUltimasHoras,
  parseFecha,
  horasEntre,
  diasEntre,
  dentroDeRango,
  log
};
