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
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const annyConsumo = require('../annyConsumo');
const { MODELOS } = require('./config');
const { TOOL_RESPONDER } = require('./prompt');
const { recortarRespuesta } = require('./texto');

let _client = null;
function getClaudeClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

const DECISION_SEGURA = () => ({
  respuesta: '',
  extraidos: {},
  clienteConfirma: false,
  cambioDeTema: false,
  escalar: null,
  comprobantePago: null,
  respuestaTaller: null,
  _error: true
});

// ------------------------------------------------------------
// decidir({ adminId, modelo, system, messages, maxChars })
// ------------------------------------------------------------
async function decidir({ adminId, modelo = 'haiku', system, messages, conImagen = false }) {
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

    const bloque = (message.content || []).find(b => b.type === 'tool_use' && b.name === 'responder');
    if (!bloque || !bloque.input) {
      console.error('[ANNY] El modelo no usó la herramienta responder');
      return DECISION_SEGURA();
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
    console.error('[ANNY] Error en Claude:', err.message);
    return DECISION_SEGURA();
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

module.exports = { decidir, sugerirRespuestaEntrenamiento, getClaudeClient };
