// ============================================================
// Control360 — Anny · MOTOR v3 · horario.js
// Ubicación: backend/services/anny/horario.js
// ============================================================
// ANNY-V3-HORARIO: el compromiso de respuesta se calcula con el
// horario DEL TENANT (perfil.horarioAtencion), nunca con uno fijo.
// Antes (ANNY-COMPROMISO-047) el horario L-V 8:30-17:30 / sáb 9-12
// estaba quemado en el código y se le prometía a los clientes de
// cualquier suscriptor. Misma clase de fuga que ANNY-FUGA-035.
// ============================================================

const { HORARIO_DEFAULT } = require('./config');

const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
const NOMBRE_DIA = { dom: 'el domingo', lun: 'el lunes', mar: 'el martes', mie: 'el miércoles', jue: 'el jueves', vie: 'el viernes', sab: 'el sábado' };
const MARGEN_MIN = 30; // lo que se compromete dentro de horario

function aMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function fmtHora(min) {
  let h = Math.floor(min / 60) % 24;
  const m = String(min % 60).padStart(2, '0');
  const ampm = h >= 12 ? 'p.m.' : 'a.m.';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

// Hora Colombia (UTC-5) como { dia: 'lun', min: 510 }
function ahoraColombia(ahora = new Date()) {
  const co = new Date(ahora.getTime() - 5 * 3600 * 1000);
  return { dia: DIAS[co.getUTCDay()], idx: co.getUTCDay(), min: co.getUTCHours() * 60 + co.getUTCMinutes() };
}

function estaEnHorario(horario = HORARIO_DEFAULT, ahora = new Date()) {
  const { dia, min } = ahoraColombia(ahora);
  const franja = horario?.[dia];
  if (!franja) return false;
  return min >= aMin(franja[0]) && min <= aMin(franja[1]);
}

// Próxima apertura a partir de un día índice (exclusivo si `desdeManana`)
function proximaApertura(horario, idx) {
  for (let i = 1; i <= 7; i++) {
    const d = DIAS[(idx + i) % 7];
    const franja = horario?.[d];
    if (franja) return { dia: d, enDias: i, abre: aMin(franja[0]) };
  }
  return null;
}

// ------------------------------------------------------------
// compromisoDeRespuesta(perfil, ahora)
// Devuelve una frase honesta: dentro de horario compromete
// MARGEN_MIN; fuera, dice cuándo se retoma. Compatible con la
// firma vieja: si el primer argumento es Date, usa el horario
// por defecto (solo para callers heredados).
// ------------------------------------------------------------
function compromisoDeRespuesta(perfilOAhora, ahora = new Date()) {
  try {
    let horario = HORARIO_DEFAULT;
    let ref = ahora;
    if (perfilOAhora instanceof Date) ref = perfilOAhora;
    else if (perfilOAhora && perfilOAhora.horarioAtencion) horario = perfilOAhora.horarioAtencion;

    const { dia, idx, min } = ahoraColombia(ref);
    const franja = horario[dia];

    if (franja) {
      const abre = aMin(franja[0]);
      const cierra = aMin(franja[1]);
      if (min < abre) return `Te escribe apenas abramos, a las ${fmtHora(abre)}`;
      if (min <= cierra - MARGEN_MIN) return `Te escribe antes de las ${fmtHora(min + MARGEN_MIN)}`;
      // dentro del último tramo o ya cerrado hoy
    }

    const prox = proximaApertura(horario, idx);
    if (!prox) return 'Te escribe un asesor en el transcurso del día.';
    const cerradoHoy = !franja;
    if (prox.enDias === 1) return `${cerradoHoy ? 'Hoy no atendemos' : 'Ya cerramos por hoy'}: te escribe mañana a primera hora, a las ${fmtHora(prox.abre)}`;
    return `Te escribe ${NOMBRE_DIA[prox.dia]} a primera hora, a las ${fmtHora(prox.abre)}`;
  } catch (err) {
    return 'Te escribe un asesor en el transcurso del día.';
  }
}

// Texto legible del horario para el prompt ("lun a vie 8:00 a.m.–6:00 p.m.; sáb 9:00 a.m.–12:00 p.m.")
function describirHorario(horario = HORARIO_DEFAULT) {
  const partes = [];
  for (const d of ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom']) {
    const f = horario?.[d];
    if (f) partes.push(`${d} ${fmtHora(aMin(f[0]))}–${fmtHora(aMin(f[1]))}`);
  }
  return partes.length ? partes.join('; ') : 'sin horario configurado';
}

module.exports = { compromisoDeRespuesta, estaEnHorario, describirHorario };
