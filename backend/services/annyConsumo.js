// ════════════════════════════════════════════════════════════════════════════════
// annyConsumo.js — ANNY-CONSUMO-026
// ─────────────────────────────────────────────────────────────────────────────
// PARA QUÉ
// `metricsAnny` cuenta conversaciones, no consumo. Con un solo tenant bastaba
// mirar la consola de Anthropic; con varios suscriptores eso ya no sirve para
// facturar: no hay forma de saber cuánto gastó cada uno.
//
// Aquí se acumula, por SUSCRIPTOR y por MES:
//   · mensajes atendidos por la IA   (la unidad con la que se fija la tarifa)
//   · tokens de entrada y salida     (el costo real en Anthropic)
//   · imágenes analizadas            (caras: una foto pesa como muchos mensajes)
//   · audios transcritos             (se pagan aparte, en créditos ElevenLabs)
//
// Colección: annyConsumo/{adminId}_{YYYY-MM}
//
// ⚠️ SOBRE LAS TARIFAS
// Los valores por defecto son una referencia, NO una fuente de verdad: los
// precios de los modelos cambian. Cada tenant puede sobreescribirlos en
// annyConfig.tarifas, y lo correcto es que Sandra los confirme contra la
// consola de Anthropic antes de usar estas cifras para facturar.
// ════════════════════════════════════════════════════════════════════════════════

const { db, admin } = require('../config/firebase');

// USD por millón de tokens. Ajustables por tenant en annyConfig.tarifas.
const TARIFA_INPUT_POR_MTOK  = Number(process.env.ANNY_USD_INPUT_MTOK)  || 1;
const TARIFA_OUTPUT_POR_MTOK = Number(process.env.ANNY_USD_OUTPUT_MTOK) || 5;

// Límites por defecto. 0 = sin límite.
const LIMITES_DEFAULT = {
  mensajesMes: 0,      // no se corta el servicio: se marca el excedente y se factura
  imagenesMes: 300,    // el gasto que preocupa — al llegar aquí, la foto escala
  audiosMes: 300,      // se pagan en créditos ElevenLabs, aparte de Anthropic
  analizarImagenes: true,
  analizarAudios: true,
};

const periodoActual = () =>
  new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 7); // 'YYYY-MM' Colombia

const docId = (adminId, periodo) => `${adminId}_${periodo || periodoActual()}`;

// ════════════════════════════════════════════════════════════════════════════
// Límites del tenant (para el freno) — annyConfig.limites
// ════════════════════════════════════════════════════════════════════════════
async function obtenerLimites(adminId) {
  try {
    const doc = await db.collection('annyConfig').doc(adminId).get();
    const l = doc.exists ? (doc.data().limites || {}) : {};
    return {
      mensajesMes: Number.isFinite(Number(l.mensajesMes)) ? Number(l.mensajesMes) : LIMITES_DEFAULT.mensajesMes,
      imagenesMes: Number.isFinite(Number(l.imagenesMes)) ? Number(l.imagenesMes) : LIMITES_DEFAULT.imagenesMes,
      audiosMes:   Number.isFinite(Number(l.audiosMes))   ? Number(l.audiosMes)   : LIMITES_DEFAULT.audiosMes,
      analizarImagenes: l.analizarImagenes !== false,
      analizarAudios:   l.analizarAudios !== false,
    };
  } catch (e) {
    console.error('[ANNY-CONSUMO] Error leyendo límites:', e.message);
    return { ...LIMITES_DEFAULT };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Consumo del mes en curso (o del período indicado)
// ════════════════════════════════════════════════════════════════════════════
async function obtenerConsumo(adminId, periodo) {
  try {
    const doc = await db.collection('annyConsumo').doc(docId(adminId, periodo)).get();
    const d = doc.exists ? doc.data() : {};
    return {
      periodo: periodo || periodoActual(),
      mensajes: Number(d.mensajes) || 0,
      imagenes: Number(d.imagenes) || 0,
      audios: Number(d.audios) || 0,
      tokensEntrada: Number(d.tokensEntrada) || 0,
      tokensSalida: Number(d.tokensSalida) || 0,
      costoUSD: Number(d.costoUSD) || 0,
    };
  } catch (e) {
    console.error('[ANNY-CONSUMO] Error leyendo consumo:', e.message);
    return { periodo: periodo || periodoActual(), mensajes: 0, imagenes: 0, audios: 0, tokensEntrada: 0, tokensSalida: 0, costoUSD: 0 };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ¿Se puede analizar una imagen / un audio ahora mismo?
// Es EL FRENO: si el suscriptor llegó a su tope del mes, el medio no se
// procesa y el mensaje escala a un asesor. Nunca se sigue gastando en silencio.
// ════════════════════════════════════════════════════════════════════════════
async function puedeAnalizarMedio(adminId, tipo) {
  const [limites, consumo] = await Promise.all([
    obtenerLimites(adminId),
    obtenerConsumo(adminId),
  ]);

  if (tipo === 'imagen') {
    if (!limites.analizarImagenes) return { permitido: false, motivo: 'desactivado' };
    if (limites.imagenesMes > 0 && consumo.imagenes >= limites.imagenesMes) {
      return { permitido: false, motivo: 'tope_mes' };
    }
  }
  if (tipo === 'audio') {
    if (!limites.analizarAudios) return { permitido: false, motivo: 'desactivado' };
    if (limites.audiosMes > 0 && consumo.audios >= limites.audiosMes) {
      return { permitido: false, motivo: 'tope_mes' };
    }
  }
  return { permitido: true };
}

// ════════════════════════════════════════════════════════════════════════════
// Registra lo consumido por UN mensaje. Nunca lanza: si falla el contador, la
// conversación con el cliente no se puede caer por eso.
// ════════════════════════════════════════════════════════════════════════════
async function registrarConsumo(adminId, { inputTokens = 0, outputTokens = 0, conImagen = false, conAudio = false } = {}) {
  try {
    if (!adminId) return;

    const costo =
      (Number(inputTokens) / 1e6) * TARIFA_INPUT_POR_MTOK +
      (Number(outputTokens) / 1e6) * TARIFA_OUTPUT_POR_MTOK;

    const inc = admin.firestore.FieldValue.increment;

    await db.collection('annyConsumo').doc(docId(adminId)).set({
      adminId,
      periodo: periodoActual(),
      mensajes: inc(1),
      tokensEntrada: inc(Number(inputTokens) || 0),
      tokensSalida: inc(Number(outputTokens) || 0),
      costoUSD: inc(Number(costo.toFixed(6))),
      imagenes: inc(conImagen ? 1 : 0),
      audios: inc(conAudio ? 1 : 0),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.error('[ANNY-CONSUMO] Error registrando consumo:', e.message);
  }
}

module.exports = {
  registrarConsumo,
  obtenerConsumo,
  obtenerLimites,
  puedeAnalizarMedio,
  periodoActual,
  LIMITES_DEFAULT,
  TARIFA_INPUT_POR_MTOK,
  TARIFA_OUTPUT_POR_MTOK,
};
