// ============================================================
// Control360 — Anny · MOTOR v3 · cola.js
// Ubicación: backend/services/anny/cola.js
// ============================================================
// ANNY-V3-COLA (ANNY-RAFAGA-058): cola por chat + agrupación de
// ráfagas. CAUSA RAÍZ de las respuestas repetidas: cada mensaje
// del cliente disparaba una llamada al modelo EN PARALELO, sin ver
// las respuestas de las otras. "hola / necesito recargar / son 3"
// eran tres respuestas casi iguales.
//
// Reglas:
//   - Un chat (adminId_telefono) se procesa EN SERIE, nunca en
//     paralelo.
//   - Los mensajes que llegan dentro de la ventana (perfil.
//     ventanaRafagaMs, 5 s por defecto) se unen en UN solo turno.
//     Un mensaje con foto cierra la ventana más rápido (2 s).
//   - Si llega algo mientras se está generando la respuesta, se
//     encola y se procesa después, ya con la respuesta anterior en
//     el historial.
//   - Mientras espera, se avisa "escribiendo…" (callback opcional).
//
// Sin Firestore, sin modelo: es pura coordinación en memoria del
// proceso (una sesión de Baileys vive en un solo proceso).
// ============================================================

const VENTANA_DEFAULT_MS = 5000;
const VENTANA_MEDIA_MS = 2000;
const MAX_TEXTO_AGRUPADO = 1500;

// clave -> { pendientes: [], timer, procesando: Promise|null, ventanaMs }
const colas = new Map();

function clave(adminId, telefono) { return `${adminId}_${telefono}`; }

// ------------------------------------------------------------
// encolar({ adminId, telefono, item, ventanaMs, alAgrupar, procesar })
//   item     → { texto, imagenAdjunta, nombreCliente, jid, meta }
//   procesar → async (itemAgrupado) => void   (una sola vez por ráfaga)
//   alAbrir  → () => void                      (opcional: "escribiendo…")
// ------------------------------------------------------------
function encolar({ adminId, telefono, item, ventanaMs, procesar, alAbrir }) {
  const k = clave(adminId, telefono);
  let q = colas.get(k);
  if (!q) {
    q = { pendientes: [], timer: null, procesando: null, ventanaMs: ventanaMs || VENTANA_DEFAULT_MS };
    colas.set(k, q);
  }
  if (ventanaMs) q.ventanaMs = ventanaMs;

  const abre = q.pendientes.length === 0 && !q.timer;
  q.pendientes.push(item);
  if (abre && typeof alAbrir === 'function') { try { alAbrir(); } catch (e) { /* no importa */ } }

  const espera = item.imagenAdjunta ? Math.min(q.ventanaMs, VENTANA_MEDIA_MS) : q.ventanaMs;
  if (q.timer) clearTimeout(q.timer);
  q.timer = setTimeout(() => {
    q.timer = null;
    _drenar(k, procesar);
  }, espera);
}

function _agrupar(items) {
  const textos = [];
  let imagen = null;
  let nombre = null;
  let jid = null;
  let meta = null;
  for (const it of items) {
    if (it.texto) textos.push(String(it.texto).trim());
    if (it.imagenAdjunta) imagen = it.imagenAdjunta; // la última foto manda
    if (it.nombreCliente) nombre = it.nombreCliente;
    if (it.jid) jid = it.jid;
    if (it.meta) meta = { ...(meta || {}), ...it.meta };
  }
  // Marcadores de foto sin caption se descartan si hay una foto real
  const limpios = imagen ? textos.filter(t => !/^\[el cliente envió una foto\]$/i.test(t)) : textos;
  let texto = limpios.join('\n').trim();
  if (imagen && !texto) texto = '[el cliente envió una foto]';
  if (texto.length > MAX_TEXTO_AGRUPADO) texto = texto.slice(-MAX_TEXTO_AGRUPADO);
  return { texto, imagenAdjunta: imagen, nombreCliente: nombre, jid, meta, cantidad: items.length };
}

function _drenar(k, procesar) {
  const q = colas.get(k);
  if (!q || !q.pendientes.length) return;
  if (q.procesando) {
    // Ya hay un turno en curso: al terminar, se drena de nuevo.
    q.procesando.then(() => _drenar(k, procesar)).catch(() => _drenar(k, procesar));
    return;
  }
  const lote = q.pendientes.splice(0, q.pendientes.length);
  const agrupado = _agrupar(lote);
  if (agrupado.cantidad > 1) console.log(`[ANNY-COLA] ${k}: ${agrupado.cantidad} mensajes agrupados en un turno`);

  q.procesando = Promise.resolve()
    .then(() => procesar(agrupado))
    .catch(err => console.error('[ANNY-COLA] Error procesando turno:', err.message))
    .finally(() => {
      q.procesando = null;
      if (q.pendientes.length) _drenar(k, procesar);
      else if (!q.timer) colas.delete(k);
    });
}

// Para pruebas / diagnóstico
function estadoColas() {
  const out = {};
  for (const [k, q] of colas) out[k] = { pendientes: q.pendientes.length, procesando: !!q.procesando };
  return out;
}

module.exports = { encolar, estadoColas, VENTANA_DEFAULT_MS };
