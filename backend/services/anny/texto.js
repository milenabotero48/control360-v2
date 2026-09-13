// ============================================================
// Control360 — Anny · MOTOR v3 · texto.js
// Ubicación: backend/services/anny/texto.js
// ============================================================
// ANNY-V3-TEXTO: utilidades puras de texto. Sin Firestore, sin
// modelo. Todo lo de aquí es determinístico y testeable.
//   - normalización (sin tildes/puntuación)
//   - teléfono
//   - saneador de respuestas (formato + largo + muletillas)
//   - "pide humano" (nunca depende del modelo)
//   - intención de familia de producto (recarga vs nuevo, por nicho)
//   - similitud entre respuestas (score de repetición)
//   - atajo de base de conocimiento (con candados de precio)
// ============================================================

function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(t) {
  return normalizar(t).split(' ').filter(w => w.length >= 3);
}

// Solo dígitos; 12 dígitos con 57 → 10 dígitos (regla DUP-002)
function normalizarTelefono(telefono) {
  if (!telefono) return null;
  let t = String(telefono).replace(/\D/g, '');
  if (t.length === 12 && t.startsWith('57')) t = t.slice(2);
  return t || null;
}

// ============================================================
// Pide humano — determinístico (ANNY-HUMANO-012)
// ============================================================
const PATRONES_PIDE_HUMANO = [
  'un asesor', 'una asesora', 'con un asesor', 'con una asesora',
  'hablar con alguien', 'hablar con una persona', 'hablar con un humano',
  'persona real', 'atencion humana', 'no quiero ia', 'no me gusta tu ia',
  'no me gusta la ia', 'eres un bot', 'eres una maquina', 'sos un bot',
  'quiero un humano', 'comuniqueme con', 'pasame con', 'me pasas con',
  'atiendame una persona', 'quiero hablar con'
].map(normalizar);

function pidePersonaHumana(texto) {
  const t = normalizar(texto);
  return PATRONES_PIDE_HUMANO.some(p => t.includes(p));
}

// ============================================================
// Saneador (ANNY-BREV-011 + ANNY-MULETILLA-042, conservados)
// ============================================================
const MULETILLAS = [
  'perfecto', 'entendido', 'excelente', 'claro que si', 'claro',
  'con mucho gusto', 'con gusto', 'listo', 'de acuerdo', 'por supuesto',
  'buenisimo', 'genial', 'que bueno', 'muchas gracias por escribirnos',
  'gracias por escribirnos', 'gracias por contactarnos', 'gracias por tu mensaje',
  'entiendo', 'comprendo', 'muy bien', 'vale', 'ok', 'okey'
];

function quitarMuletillas(texto) {
  let t = String(texto || '').trim();
  for (let i = 0; i < 2; i++) {
    const sinTilde = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    let cortado = false;
    for (const m of MULETILLAS) {
      // Admite un nombre propio pegado a la muletilla: "Listo Carlos, ..." → "Carlos, ..."
      const re = new RegExp(`^${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s+[a-zñ]{2,20})?\\s*[,.!:]+\\s*`);
      const match = sinTilde.match(re);
      if (!match) continue;
      const nombre = match[1] ? t.slice(match[0].indexOf(match[1]) , match[0].indexOf(match[1]) + match[1].length).trim() : '';
      const resto = t.slice(match[0].length).trim();
      if (resto.length < 12) continue;
      t = nombre ? `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)}, ${resto}` : resto.charAt(0).toUpperCase() + resto.slice(1);
      cortado = true;
      break;
    }
    if (!cortado) break;
  }
  return t;
}

const MARCADORES = /^[\s•·\-*→▪●✓✅☑️💰🔥🚗⭐]+\s*/;

function recortarRespuesta(texto, maxChars = 240, permitirEmojis = false) {
  if (!texto) return texto;
  const partes = [];
  for (let linea of String(texto).split(/\r?\n/)) {
    linea = linea.replace(MARCADORES, '');
    if (!permitirEmojis) linea = linea.replace(/^[^\p{L}\p{N}¿¡"']+/u, '');
    linea = linea.trim();
    if (!linea) continue;
    if (/^[A-ZÁÉÍÓÚÑ0-9 ()\/]{4,}:?$/.test(linea)) continue; // título en mayúscula
    partes.push(linea);
  }
  let t = partes
    .map(x => x.charAt(0).toUpperCase() + x.slice(1))
    .map(x => (/[.!?:,]$/.test(x) ? x : x + '.'))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/([.!?])\.+/g, '$1')
    .replace(/\?\./g, '?')
    .trim();

  t = quitarMuletillas(t);

  if (t.length > maxChars) {
    const corte = t.slice(0, maxChars);
    const ultimo = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('? '), corte.lastIndexOf('! '));
    t = ultimo > maxChars * 0.5 ? corte.slice(0, ultimo + 1) : corte.trim();
  }
  return t.trim();
}

// ============================================================
// Intención de familia de producto (por nicho)
// Devuelve la clave de familia ('recarga' | 'nuevo' | ...) o null.
// Gana la familia con más coincidencias; empate → null (ambiguo).
// ============================================================
function detectarFamilia(texto, familias = {}) {
  const t = normalizar(texto);
  let mejor = null, mejorN = 0, empate = false;
  for (const [fam, palabras] of Object.entries(familias || {})) {
    const n = (palabras || []).filter(p => t.includes(normalizar(p))).length;
    if (n > mejorN) { mejor = fam; mejorN = n; empate = false; }
    else if (n === mejorN && n > 0) empate = true;
  }
  return (mejorN > 0 && !empate) ? mejor : null;
}

// ¿El mensaje pregunta por precio?
function preguntaPrecio(texto) {
  const t = normalizar(texto);
  return /\b(cuanto|vale|valor|precio|cuesta|cotiza|cotizacion|tarifa)\b/.test(t);
}

// ============================================================
// Similitud Jaccard entre dos textos (score de repetición)
// ============================================================
function similitud(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ============================================================
// Atajo de base de conocimiento (conversación fría)
// Candados ANNY-FUGA-035 / ANNY-PRECIO-036: nunca cotiza y solo
// patrones específicos (≥8 caracteres o 2+ palabras).
// ============================================================
const RE_DINERO = /\$\s?\d|\d{4,}\s*(pesos|cop\b)|\bcop\s?\$?\s?\d/i;

function patronUtilizable(p) {
  const s = String(p || '').trim();
  if (s.length < 5) return false;
  return s.length >= 8 || s.includes(' ');
}

function buscarRespuestaConfigura(mensajeTexto, respuestas) {
  const texto = normalizar(mensajeTexto);
  for (const [key, config] of Object.entries(respuestas || {})) {
    if (!config || !config.respuesta || !Array.isArray(config.patrones)) continue;
    if (String(config.tipo || '').toUpperCase() === 'PRECIO') continue;
    if (RE_DINERO.test(String(config.respuesta))) continue;
    const patrones = config.patrones.filter(patronUtilizable);
    if (!patrones.length) continue;
    if (patrones.some(p => texto.includes(normalizar(p)))) {
      return { encontrada: true, respuesta: config.respuesta, tipo: config.tipo || 'CUSTOM', key };
    }
  }
  return { encontrada: false };
}

// Entradas de conocimiento relevantes al mensaje (para el prompt).
// Devuelve [{ key, patrones, respuesta }] — las que coinciden, más
// las marcadas `siempre: true` por el suscriptor. Máx 8.
function conocimientoRelevante(mensajeTexto, respuestas, max = 8) {
  const texto = normalizar(mensajeTexto);
  const out = [];
  for (const [key, c] of Object.entries(respuestas || {})) {
    if (!c || !c.respuesta) continue;
    const pats = Array.isArray(c.patrones) ? c.patrones : [];
    const coincide = pats.some(p => normalizar(p).length >= 4 && texto.includes(normalizar(p)));
    const porClave = normalizar(key).split(' ').some(w => w.length >= 5 && texto.includes(w));
    if (c.siempre === true || coincide || porClave) {
      out.push({ key, patrones: pats.slice(0, 4), respuesta: String(c.respuesta).slice(0, 400), prioridad: coincide ? 2 : (c.siempre ? 1 : 0) });
    }
  }
  return out.sort((a, b) => b.prioridad - a.prioridad).slice(0, max);
}

module.exports = {
  normalizar,
  tokens,
  normalizarTelefono,
  pidePersonaHumana,
  quitarMuletillas,
  recortarRespuesta,
  detectarFamilia,
  preguntaPrecio,
  similitud,
  RE_DINERO,
  buscarRespuestaConfigura,
  conocimientoRelevante
};
