// ============================================================
// Control360 — Anny · MOTOR v3 · modelo.js
// Ubicación: backend/services/anny/modelo.js
// ============================================================
// ANNY-V3-MODELO: única puerta hacia la API de Anthropic.
//   - system en capas con prompt caching
//   - salida estructurada por tool_use (tool_choice forzado)
//   - consumo por suscriptor (ANNY-CONSUMO-026), incluye tokens
//     leídos de caché para que la factura refleje el ahorro
//   - ante cualquier fallo devuelve una decisión segura
//
// ✅ ANNY-INCIDENTE-061: el error ya no es genérico.
//   Se clasifica la causa (sin saldo, autenticación, límite,
//   sobrecarga, API caída, conexión, solicitud, sin herramienta).
//   Las causas de PLATAFORMA afectan a todos los tenants a la vez:
//   abren un incidente único (memoria + annyIncidentes/plataforma).
//   Mientras el incidente es de saldo o autenticación, se hace
//   corto circuito (no se llama a la API) y solo cada 2 minutos se
//   deja pasar una llamada de prueba. La primera respuesta buena
//   cierra el incidente.
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../../config/firebase');
const annyConsumo = require('../annyConsumo');
const { MODELOS } = require('./config');
const { TOOL_RESPONDER } = require('./prompt');
const { recortarRespuesta } = require('./texto');

let _client = null;
function getClaudeClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

const DECISION_SEGURA = (errorTipo = 'DESCONOCIDO', extra = {}) => ({
  respuesta: '',
  extraidos: {},
  clienteConfirma: false,
  cambioDeTema: false,
  escalar: null,
  comprobantePago: null,
  respuestaTaller: null,
  _error: true,
  _errorTipo: errorTipo,                                 // ANNY-INCIDENTE-061
  _incidente: TIPOS_PLATAFORMA.includes(errorTipo),      // ANNY-INCIDENTE-061
  ...extra
});

// ============================================================
// ✅ ANNY-INCIDENTE-061 — clasificación e incidente de plataforma
// ============================================================
const TIPOS_PLATAFORMA = ['SIN_SALDO', 'AUTENTICACION', 'LIMITE', 'SOBRECARGA', 'API_CAIDA', 'CONEXION'];
const TIPOS_CORTOCIRCUITO = ['SIN_SALDO', 'AUTENTICACION'];
const PRUEBA_CADA_MS = 2 * 60 * 1000;

const ETIQUETA_INCIDENTE = {
  SIN_SALDO: 'Sin saldo en la consola de Anthropic',
  AUTENTICACION: 'API key inválida o sin permisos',
  LIMITE: 'Límite de uso de la API alcanzado',
  SOBRECARGA: 'API de Anthropic sobrecargada',
  API_CAIDA: 'API de Anthropic con fallas',
  CONEXION: 'Sin conexión con la API de Anthropic'
};

function clasificarError(err) {
  const status = Number(err?.status) || 0;
  const msg = String(err?.message || '') + ' ' + String(err?.error?.error?.message || '');
  const nombre = String(err?.name || err?.constructor?.name || '');
  if (/credit balance|insufficient credit|billing/i.test(msg)) return 'SIN_SALDO';
  if (status === 401 || status === 403) return 'AUTENTICACION';
  if (status === 429) return 'LIMITE';
  if (status === 529 || /overloaded/i.test(msg)) return 'SOBRECARGA';
  if (status >= 500) return 'API_CAIDA';
  if (!status && /connection|timeout|ECONN|ENOTFOUND|fetch failed/i.test(nombre + ' ' + msg)) return 'CONEXION';
  if (status === 400) return 'SOLICITUD';
  return 'DESCONOCIDO';
}

const _incidente = {
  activo: false,
  tipo: null,
  desdeMs: 0,
  ultimoFalloMs: 0,
  ultimoIntentoMs: 0,
  mensaje: '',
  resueltoMs: 0,
  avisoAperturaMs: 0,   // lo marca el vigilante SLA al avisar a SuperAdmin
  avisoCierrePendiente: false
};

function _persistirIncidente() {
  db.collection('annyIncidentes').doc('plataforma').set({
    activo: _incidente.activo,
    tipo: _incidente.tipo,
    etiqueta: ETIQUETA_INCIDENTE[_incidente.tipo] || null,
    desdeMs: _incidente.desdeMs,
    ultimoFalloMs: _incidente.ultimoFalloMs,
    resueltoMs: _incidente.resueltoMs,
    mensaje: String(_incidente.mensaje || '').slice(0, 300),
    updatedMs: Date.now()
  }, { merge: true }).catch(() => {});
}

function _abrirOActualizarIncidente(tipo, mensaje) {
  const ahora = Date.now();
  if (!_incidente.activo) {
    Object.assign(_incidente, {
      activo: true, tipo, desdeMs: ahora, ultimoFalloMs: ahora, ultimoIntentoMs: ahora,
      mensaje, resueltoMs: 0, avisoAperturaMs: 0, avisoCierrePendiente: false
    });
    console.error(`[ANNY-INCIDENTE-061] Incidente ABIERTO: ${tipo} — ${mensaje}`);
    _persistirIncidente();
    return;
  }
  _incidente.tipo = tipo;
  _incidente.ultimoFalloMs = ahora;
  _incidente.ultimoIntentoMs = ahora;
  _incidente.mensaje = mensaje;
}

function _cerrarIncidente() {
  if (!_incidente.activo) return;
  const duracionMin = Math.round((Date.now() - _incidente.desdeMs) / 60000);
  console.log(`[ANNY-INCIDENTE-061] Incidente CERRADO (${_incidente.tipo}) tras ${duracionMin} min`);
  _incidente.activo = false;
  _incidente.resueltoMs = Date.now();
  // Solo se avisa el cierre si antes se avisó la apertura.
  _incidente.avisoCierrePendiente = _incidente.avisoAperturaMs > 0;
  _persistirIncidente();
}

// Estado para el vigilante SLA y para el panel (copia, no referencia).
function estadoIncidente() {
  return { ..._incidente, etiqueta: ETIQUETA_INCIDENTE[_incidente.tipo] || null };
}

function marcarAvisoIncidente(tipoAviso) {
  if (tipoAviso === 'apertura') _incidente.avisoAperturaMs = Date.now();
  if (tipoAviso === 'cierre') { _incidente.avisoCierrePendiente = false; _incidente.avisoAperturaMs = 0; }
}

// ------------------------------------------------------------
// decidir({ adminId, modelo, system, messages, maxChars })
// ------------------------------------------------------------
async function decidir(args) {
  // ✅ ANNY-INCIDENTE-061: corto circuito mientras no hay saldo / key.
  if (_incidente.activo && TIPOS_CORTOCIRCUITO.includes(_incidente.tipo)
      && (Date.now() - _incidente.ultimoIntentoMs) < PRUEBA_CADA_MS) {
    return DECISION_SEGURA(_incidente.tipo, { _cortocircuito: true });
  }
  if (_incidente.activo) _incidente.ultimoIntentoMs = Date.now();

  const primera = await _decidirUnaVez(args);
  // Un solo reintento cuando el modelo respondió sin usar la herramienta
  // (fallo puntual). Los errores de red/429/5xx ya los reintenta el SDK.
  if (primera._error && primera._errorTipo === 'SIN_HERRAMIENTA') {
    return _decidirUnaVez(args);
  }
  return primera;
}

async function _decidirUnaVez({ adminId, modelo = 'haiku', system, messages, conImagen = false }) {
  try {
    const message = await getClaudeClient().messages.create({
      model: MODELOS[modelo] || MODELOS.haiku,
      max_tokens: 500,
      system,
      tools: [TOOL_RESPONDER],
      tool_choice: { type: 'tool', name: 'responder' },
      messages
    });

    try {
      const u = message.usage || {};
      annyConsumo.registrarConsumo(adminId, {
        inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens || 0,
        conImagen
      });
      if (process.env.ANNY_DEBUG_TOKENS === '1') {
        console.log(`[ANNY-TOKENS] ${adminId} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} out=${u.output_tokens}`);
      }
    } catch (e) { /* el contador nunca tumba la conversación */ }

    // La API respondió: si había incidente, se cierra.
    _cerrarIncidente();

    const bloque = (message.content || []).find(b => b.type === 'tool_use' && b.name === 'responder');
    if (!bloque || !bloque.input) {
      console.error('[ANNY] El modelo no usó la herramienta responder');
      return DECISION_SEGURA('SIN_HERRAMIENTA');
    }
    const d = bloque.input;
    return {
      respuesta: typeof d.respuesta === 'string' ? d.respuesta : '',
      extraidos: (d.extraidos && typeof d.extraidos === 'object') ? d.extraidos : {},
      clienteConfirma: d.clienteConfirma === true,
      cambioDeTema: d.cambioDeTema === true,
      escalar: (d.escalar && typeof d.escalar === 'object' && d.escalar.tipo) ? { tipo: String(d.escalar.tipo).toUpperCase(), razon: String(d.escalar.razon || '').slice(0, 120) } : null,
      comprobantePago: (d.comprobantePago && typeof d.comprobantePago === 'object') ? d.comprobantePago : null,
      respuestaTaller: (d.respuestaTaller === 'APROBADO' || d.respuestaTaller === 'RECHAZADO') ? d.respuestaTaller : null,
      _error: false
    };
  } catch (err) {
    const tipo = clasificarError(err);
    console.error(`[ANNY] Error en Claude (${tipo}):`, err.message);
    if (TIPOS_PLATAFORMA.includes(tipo)) _abrirOActualizarIncidente(tipo, err.message);
    return DECISION_SEGURA(tipo);
  }
}

// ------------------------------------------------------------
// ANNY-KB-022: reescritura de una entrada de Entrenamiento.
// Sin cambios de contrato: { respuesta, patrones, queCambie }.
// ------------------------------------------------------------
async function sugerirRespuestaEntrenamiento(perfil, { key, patrones = [], respuesta = '' }) {
  const prompt = `Eres editora de mensajes de WhatsApp para ${perfil.empresa}, empresa de ${perfil.vertical}.

Te paso una respuesta guardada en la base de conocimiento de la agente ${perfil.nombreAgente}. Está mal escrita para WhatsApp. Reescríbela.

ENTRADA: "${key}"
PALABRAS CLAVE ACTUALES: ${patrones.join(', ') || '(ninguna)'}
TEXTO ACTUAL:
"""
${respuesta}
"""

REGLAS:
1. Máximo 220 caracteres, prosa, como escribe una persona.
2. Sin viñetas, guiones, símbolos ni títulos en mayúscula.
3. Sin precios ni cifras de dinero: los precios salen del catálogo.
4. Una sola intención.
5. Tono de asesora colombiana, ${perfil.tono?.tratamiento === 'usted' ? 'de usted' : 'tuteando'}, sin muletillas.
6. Termina con una pregunta corta solo si tiene sentido.
7. Palabras clave: frases de 2+ palabras que un cliente escribiría de verdad.

Responde SOLO en JSON, sin markdown:
{"respuesta": "el texto reescrito", "patrones": ["frase 1", "frase 2", "frase 3"], "queCambie": "una frase"}`;

  const message = await getClaudeClient().messages.create({
    model: MODELOS.haiku,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  let limpio = message.content[0].text.replace(/```json|```/g, '').trim();
  const ini = limpio.indexOf('{'), fin = limpio.lastIndexOf('}');
  if (ini !== -1 && fin > ini) limpio = limpio.slice(ini, fin + 1);
  const out = JSON.parse(limpio);
  return {
    respuesta: recortarRespuesta(String(out.respuesta || ''), 220),
    patrones: Array.isArray(out.patrones) ? out.patrones.map(p => String(p).trim()).filter(p => p.length > 4).slice(0, 6) : [],
    queCambie: String(out.queCambie || '')
  };
}

module.exports = {
  decidir,
  sugerirRespuestaEntrenamiento,
  getClaudeClient,
  estadoIncidente,        // ✅ ANNY-INCIDENTE-061
  marcarAvisoIncidente,   // ✅ ANNY-INCIDENTE-061
  clasificarError,        // ✅ ANNY-INCIDENTE-061
  TIPOS_PLATAFORMA        // ✅ ANNY-INCIDENTE-061
};
