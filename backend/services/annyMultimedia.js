// ════════════════════════════════════════════════════════════════════════════════
// annyMultimedia.js — ANNY-MEDIA-024
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA QUE RESUELVE
// `extraerTexto()` solo leía texto y captions. Una foto sin caption devolvía
// cadena vacía y el mensaje se descartaba con `if (!texto) return;`. Las notas
// de voz (audioMessage / pttMessage) ni siquiera estaban contempladas.
// Resultado: el cliente mandaba la foto del extintor o un audio explicando lo
// que necesitaba, y Anny seguía preguntando lo que ya le habían dicho.
//
// QUÉ HACE
//   · Imágenes → se descargan y se le pasan a Claude, que SÍ tiene visión.
//   · Audios   → se transcriben con ElevenLabs Scribe (la misma cuenta que ya
//                usa Lucy: ELEVEN_API_KEY ya existe en Railway, no hay
//                proveedor nuevo ni credencial nueva).
//
// PRINCIPIO: si no se pudo interpretar el medio, NO se responde a ciegas.
// Se devuelve un texto explícito para que Anny pida ayuda o escale. Inventar
// lo que decía un audio que no se entendió es peor que admitir que no se oyó.
// ════════════════════════════════════════════════════════════════════════════════

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY || '';

// Topes: protegen memoria y costo. Un audio de 3 min o una foto de 8 MB no
// aportan más que uno de 30 s o una de 2 MB, y sí pueden tumbar el proceso.
const MAX_BYTES_IMAGEN = 5 * 1024 * 1024;   // 5 MB
const MAX_BYTES_AUDIO  = 12 * 1024 * 1024;  // ~10 min de voz comprimida
const TIPOS_IMAGEN_OK  = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// ════════════════════════════════════════════════════════════════════════════
// ¿Qué tipo de medio trae este mensaje de WhatsApp?
// pttMessage = nota de voz (el botón del micrófono); audioMessage = archivo.
// ════════════════════════════════════════════════════════════════════════════
function detectarMedio(message) {
  if (!message) return null;
  if (message.imageMessage) return { tipo: 'imagen', mimetype: message.imageMessage.mimetype || 'image/jpeg' };
  if (message.audioMessage) return { tipo: 'audio', mimetype: message.audioMessage.mimetype || 'audio/ogg' };
  if (message.pttMessage)   return { tipo: 'audio', mimetype: message.pttMessage.mimetype || 'audio/ogg' };
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Transcribe una nota de voz con ElevenLabs Scribe.
// Devuelve null si falla — el llamador decide qué hacer, nunca se inventa.
// ════════════════════════════════════════════════════════════════════════════
async function transcribirAudio(buffer, mimetype) {
  if (!ELEVEN_API_KEY) {
    console.warn('[ANNY-MEDIA] Sin ELEVEN_API_KEY — no se puede transcribir audio');
    return null;
  }
  if (!buffer || buffer.length === 0) return null;
  if (buffer.length > MAX_BYTES_AUDIO) {
    console.warn(`[ANNY-MEDIA] Audio de ${Math.round(buffer.length / 1024)} KB supera el tope`);
    return null;
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimetype || 'audio/ogg' }), 'nota.ogg');
    form.append('model_id', 'scribe_v1');
    // Se fija el idioma: sube bastante la precisión frente a autodetección
    // en audios cortos y con ruido, que es el caso normal en WhatsApp.
    form.append('language_code', 'spa');

    const resp = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_API_KEY },
      body: form,
    });

    if (!resp.ok) {
      const detalle = await resp.text().catch(() => '');
      console.error(`[ANNY-MEDIA] Scribe HTTP ${resp.status}: ${detalle.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    const texto = String(data?.text || '').trim();
    return texto || null;
  } catch (e) {
    console.error('[ANNY-MEDIA] Error transcribiendo audio:', e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Prepara una imagen como bloque de contenido para Claude (que tiene visión).
// ════════════════════════════════════════════════════════════════════════════
function prepararImagen(buffer, mimetype) {
  if (!buffer || buffer.length === 0) return null;
  if (buffer.length > MAX_BYTES_IMAGEN) {
    console.warn(`[ANNY-MEDIA] Imagen de ${Math.round(buffer.length / 1024)} KB supera el tope`);
    return null;
  }
  const tipo = TIPOS_IMAGEN_OK.includes(mimetype) ? mimetype : 'image/jpeg';
  return { media_type: tipo, data: buffer.toString('base64') };
}

module.exports = {
  detectarMedio,
  transcribirAudio,
  prepararImagen,
  MAX_BYTES_IMAGEN,
  MAX_BYTES_AUDIO,
};
