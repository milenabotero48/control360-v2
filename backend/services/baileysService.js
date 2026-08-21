// ============================================================
// Control360 — Servicio Baileys (WhatsApp Web) para Anny
// Ubicación: backend/services/baileysService.js
// FIX ANNY-QR-001 + ANNY-QR-003 + ANNY-QR-004 + ANNY-PEDIDOS-001
// + FIX ANNY-SILENCIO-001 (chats silenciados / internos)
// + FIX ANNY-ECO-001 + FIX ANNY-PAUSA-004 (esta versión)
// ============================================================
// PRINCIPIOS:
// 1. Una sesión de WhatsApp por tenant (adminId) — multi-tenant
// 2. Sesión persistida en disco (BAILEYS_DIR → Volume de Railway)
// 3. QR solo en memoria — nunca se guarda en Firestore
// 4. Mensajes entrantes → annyService.procesarMensajeEntrante()
// 5. Anti-colisión: caso escalado PENDIENTE = Anny guarda silencio
// 6. Respuestas manuales de la admin (fromMe) → ADMIN_MANUAL
// 7. Reconexión automática con tope de reintentos
// 8. getMessage + almacén de enviados (reintentos de cifrado)
// 9. Pedido cerrado → aviso al WhatsApp de la admin
// 10. FIX ANNY-SILENCIO-001: chats marcados como silenciados
//     (annyConfig.chatsSilenciados) se IGNORAN por completo:
//     ni respuesta, ni registro, ni gasto de IA — para
//     conversaciones internas del equipo.
// 11. FIX ANNY-ECO-001: los mensajes que la PROPIA Anny envía
//     hacen eco en messages.upsert con fromMe=true. Antes se
//     registraban como ADMIN_MANUAL — el historial le atribuía
//     a la "asesora humana" los textos de Anny y contaminaba la
//     memoria del hilo. Ahora se detectan con el almacén
//     mensajesEnviados (que ya existía para reintentos) y se
//     ignoran por completo.
// 12. FIX ANNY-PAUSA-004: un fromMe que NO es eco = la admin
//     escribió manualmente desde el teléfono/WhatsApp Web →
//     se registra ADMIN_MANUAL y se PAUSA Anny 30 minutos en
//     ese chat. Cada mensaje manual refresca la pausa. Anny
//     verifica la pausa en annyService antes de responder.
// ============================================================

const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { db, admin } = require('../config/firebase');
const annyService = require('./annyService');
// ✅ ANNY-MEDIA-024: visión para fotos y transcripción para notas de voz
const annyMultimedia = require('./annyMultimedia');
// ✅ ANNY-CONSUMO-026: freno por tope de consumo del suscriptor
const annyConsumo = require('./annyConsumo');

// ============================================================
// FIX ANNY-QR-003: Baileys es ESM-only — import() dinámico
// ============================================================
let _baileys = null;
async function cargarBaileys() {
  if (_baileys) return _baileys;

  const mod = await import('@whiskeysockets/baileys');
  const raiz = (mod.default && typeof mod.default === 'object') ? mod.default : mod;

  _baileys = {
    makeWASocket:
      (typeof mod.default === 'function' && mod.default) ||
      mod.makeWASocket ||
      raiz.makeWASocket,
    useMultiFileAuthState: mod.useMultiFileAuthState || raiz.useMultiFileAuthState,
    DisconnectReason: mod.DisconnectReason || raiz.DisconnectReason,
    fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion || raiz.fetchLatestBaileysVersion,
    // ✅ ANNY-MEDIA-024: descarga de fotos y notas de voz
    downloadMediaMessage: mod.downloadMediaMessage || raiz.downloadMediaMessage
  };

  if (typeof _baileys.makeWASocket !== 'function') {
    _baileys = null;
    throw new Error('No se pudo resolver makeWASocket en @whiskeysockets/baileys');
  }

  return _baileys;
}

// En Railway: Volume montado en /data y env var BAILEYS_DIR=/data/baileys
const BAILEYS_DIR = process.env.BAILEYS_DIR || path.join(__dirname, '..', 'baileys_sessions');

// ============================================================
// FIX ANNY-QR-004: almacén de mensajes enviados para reintentos
// ============================================================
const mensajesEnviados = new Map(); // msgId -> contenido del mensaje
const MAX_MENSAJES_STORE = 1000;

function guardarMensajeEnviado(id, message) {
  if (!id || !message) return;
  mensajesEnviados.set(id, message);
  if (mensajesEnviados.size > MAX_MENSAJES_STORE) {
    const primero = mensajesEnviados.keys().next().value;
    mensajesEnviados.delete(primero);
  }
}

// ============================================================
// FIX ANNY-SILENCIO-001: caché de chats silenciados (TTL 60s)
// ============================================================
const _cacheSilencio = new Map(); // adminId -> { data, ts }
const SILENCIO_TTL_MS = 60 * 1000;

async function estaSilenciado(adminId, telefono) {
  try {
    let entry = _cacheSilencio.get(adminId);
    if (!entry || (Date.now() - entry.ts) > SILENCIO_TTL_MS) {
      const doc = await db.collection('annyConfig').doc(adminId).get();
      entry = { data: (doc.exists && doc.data().chatsSilenciados) || {}, ts: Date.now() };
      _cacheSilencio.set(adminId, entry);
    }
    return entry.data[telefono] === true;
  } catch (err) {
    return false;
  }
}

function invalidarCacheSilencio(adminId) {
  _cacheSilencio.delete(adminId);
}

// adminId -> { sock, estado, qr, numero, reintentos }
const sesiones = new Map();

const MAX_REINTENTOS = 10;

// ============================================================
// Enviar mensaje registrándolo en el almacén de reintentos
// ============================================================
async function enviarMensaje(adminId, jid, texto) {
  const ses = sesiones.get(adminId);
  if (!ses?.sock) return null;
  const enviado = await ses.sock.sendMessage(jid, { text: texto });
  if (enviado?.key?.id && enviado.message) {
    guardarMensajeEnviado(enviado.key.id, enviado.message);
  }
  return enviado;
}

// ============================================================
// ✅ ANNY-PAGO-050: reenviar una imagen (comprobante de pago) al
// grupo interno. Se manda la foto tal cual la envió el cliente,
// con el pie de contexto: quien valida necesita VER el soporte,
// no una descripción de él.
// ============================================================
async function enviarImagen(adminId, jid, base64, mimetype, caption) {
  const ses = sesiones.get(adminId);
  if (!ses?.sock || !base64) return null;
  try {
    const enviado = await ses.sock.sendMessage(jid, {
      image: Buffer.from(base64, 'base64'),
      mimetype: mimetype || 'image/jpeg',
      caption: caption || ''
    });
    if (enviado?.key?.id && enviado.message) {
      guardarMensajeEnviado(enviado.key.id, enviado.message);
    }
    return enviado;
  } catch (err) {
    console.error('[BAILEYS] Error enviando imagen:', err.message);
    return null;
  }
}

// ============================================================
// ✅ ANNY-GRUPO-051: listar los grupos donde está el número
// conectado, para que la suscriptora elija el grupo de avisos
// desde el panel sin tener que copiar un jid a mano.
// ============================================================
async function listarGrupos(adminId) {
  const ses = sesiones.get(adminId);
  if (!ses?.sock) return [];
  try {
    const grupos = await ses.sock.groupFetchAllParticipating();
    return Object.values(grupos || {})
      .map(g => ({
        jid: g.id,
        nombre: g.subject || '(sin nombre)',
        participantes: Array.isArray(g.participants) ? g.participants.length : 0
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  } catch (err) {
    console.error('[BAILEYS] Error listando grupos:', err.message);
    return [];
  }
}

// ============================================================
// Guardar estado de conexión en annyConfig
// ============================================================
async function guardarEstado(adminId, conexionEstado, numero = null) {
  try {
    const data = {
      conexionEstado,
      conexionActualizada: admin.firestore.FieldValue.serverTimestamp()
    };
    if (numero) data.whatsappNumber = numero;
    await db.collection('annyConfig').doc(adminId).set(data, { merge: true });
  } catch (err) {
    console.error('[BAILEYS] Error guardando estado:', err.message);
  }
}

// ============================================================
// ✅ ANNY-FOTO-040 — CAUSA DE "Anny no responde ninguna foto"
// ------------------------------------------------------------
// WhatsApp NO siempre entrega el contenido en la raíz de
// `msg.message`. Lo ENVUELVE en un sobre según cómo se envió:
//
//   · viewOnceMessageV2 / viewOnceMessage  → foto "ver una vez"
//   · ephemeralMessage                     → chat con mensajes temporales
//   · documentWithCaptionMessage           → archivo con descripción
//
// El motor leía SOLO la raíz. Con cualquiera de esos sobres,
// `message.imageMessage` era undefined → detectarMedio devolvía
// null → extraerTexto devolvía '' → el mensaje moría en el
// `if (!texto) return;` SIN dejar rastro. Ni respuesta, ni
// registro, ni error en el log: para Anny esa foto no existió.
//
// Enviar fotos como "ver una vez" es lo normal en WhatsApp desde
// el móvil, y muchas empresas tienen los mensajes temporales
// activados por defecto. Por eso fallaban TODAS.
//
// Aquí se abre el sobre antes de mirar nada. Es recursivo porque
// los sobres se anidan (ephemeral que contiene un viewOnce).
// ============================================================
const SOBRES_MENSAJE = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

function desenvolverMensaje(message, profundidad = 0) {
  if (!message || profundidad > 5) return message || null;
  for (const sobre of SOBRES_MENSAJE) {
    const dentro = message[sobre]?.message;
    if (dentro) return desenvolverMensaje(dentro, profundidad + 1);
  }
  return message;
}

// ============================================================
// Extraer texto de un mensaje de WhatsApp (tipos comunes)
// ============================================================
function extraerTexto(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    // ✅ ANNY-FOTO-040: foto enviada como archivo/documento (galería →
    // "documento", o desde WhatsApp Web arrastrando el archivo).
    message.documentMessage?.caption ||
    ''
  ).trim();
}

// ============================================================
// ✅ ANNY-MEDIA-024: descarga el contenido binario de un mensaje
// (foto o nota de voz) usando el descifrado de Baileys.
// Devuelve null ante cualquier fallo: el llamador nunca asume.
// ============================================================
async function descargarMedia(msg) {
  try {
    const { downloadMediaMessage } = await cargarBaileys();
    if (typeof downloadMediaMessage !== 'function') {
      console.warn('[ANNY-MEDIA] downloadMediaMessage no disponible en esta versión de Baileys');
      return null;
    }
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return Buffer.isBuffer(buffer) ? buffer : null;
  } catch (err) {
    console.error('[ANNY-MEDIA] Error descargando medio:', err.message);
    return null;
  }
}

// ============================================================
// Anti-colisión: ¿hay caso escalado PENDIENTE de este teléfono?
// ============================================================
// ============================================================
// ✅ ANNY-MUDA-043 — BUG CRÍTICO: el escalamiento dejaba a Anny
// muda PARA SIEMPRE en ese chat.
// ------------------------------------------------------------
// CAUSA RAÍZ de "25 escalados sin atender y ningún cliente
// respondido": esta función devolvía true mientras existiera un
// caso en estado PENDIENTE, sin límite de tiempo. Como el aviso
// interno nunca salía (ver ANNY-AVISO-041), nadie entraba al
// panel a cerrar el caso, y el cliente quedaba en silencio
// permanente. Un cliente escribió "Cancelamos servicio" y no
// recibió respuesta porque el sistema lo tenía mudo.
//
// REGLA NUEVA: el caso pendiente silencia a Anny durante una
// VENTANA acotada (VENTANA_SILENCIO_MIN). Pasada la ventana sin
// que un humano haya entrado, Anny retoma el chat: es preferible
// que responda a que el cliente se vaya sin respuesta.
// Devuelve el caso para poder RE-AVISAR (ANNY-REAVISO-044).
// ============================================================
const VENTANA_SILENCIO_MIN = 45;
const REAVISO_MIN = 10; // no re-avisar el mismo caso más seguido que esto

function msDe(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v.seconds) return v.seconds * 1000;
  return 0;
}

async function casoPendienteDe(adminId, telefono) {
  try {
    const snap = await db.collection('casosEscaladosAnny')
      .doc(adminId)
      .collection('casos')
      .where('telefono', '==', telefono)
      .where('estado', '==', 'PENDIENTE')
      .limit(5)
      .get();

    if (snap.empty) return null;

    // el más reciente
    const docs = snap.docs
      .map(d => ({ ref: d.ref, id: d.id, ...d.data() }))
      .sort((a, b) => msDe(b.createdAt) - msDe(a.createdAt));

    const c = docs[0];
    const creadoMs = msDe(c.createdAt) || Date.now();
    const edadMin = (Date.now() - creadoMs) / 60000;

    return {
      ref: c.ref,
      id: c.id,
      tipo: c.tipo || 'OTRO',
      razon: c.razon || '',
      nombreCliente: c.nombreCliente || '',
      edadMin,
      dentroDeVentana: edadMin < VENTANA_SILENCIO_MIN,
      ultimoAvisoMs: Number(c.ultimoAvisoMs) || creadoMs
    };
  } catch (err) {
    console.error('[BAILEYS] Error consultando casos pendientes:', err.message);
    return null; // fail-open: ante error Anny responde, no se queda muda
  }
}

// ============================================================
// ✅ ANNY-AVISO-041 — BUG CRÍTICO: el aviso interno de
// escalamiento se armaba y se tiraba a la basura.
// ------------------------------------------------------------
// annyService devolvía `avisoEscalamiento` + `notificarA`, pero
// el único bloque que enviaba avisos exigía `resultado.pedido`.
// En un escalamiento no hay pedido → la condición daba falso y
// el aviso nunca salía. `enviarAvisoInterno()` estaba declarada
// y exportada en annyNotificaciones, pero nadie la llamaba.
//
// REGLA NUEVA: el aviso SIEMPRE encuentra destino. Orden:
//   1. perfil.notificarEscalamientoA (o notificarPedidosA)
//   2. el propio número conectado de la sesión → "chat contigo
//      misma", como una nota interna. Nunca se pierde un caso.
// El eco de este envío lo filtra ANNY-ECO-001 (mensajesEnviados),
// así que no hay bucle: Anny no se lee a sí misma.
// ============================================================
// ✅ ANNY-GRUPO-051: el destino puede ser un número O un grupo de
// WhatsApp (jid terminado en @g.us). Un grupo es mejor destino que un
// número: lo ven varias personas y el caso no depende de que una
// sola esté mirando el celular.
function aJidCo(destinoRaw) {
  const raw = String(destinoRaw || '').trim();
  if (!raw) return null;
  if (raw.endsWith('@g.us') || raw.endsWith('@s.whatsapp.net')) return raw;
  const n = raw.replace(/\D/g, '');
  if (n.length < 10) return null;
  return `${n.startsWith('57') ? n : '57' + n}@s.whatsapp.net`;
}

// ✅ ANNY-GRUPO-051: orden de destino — grupo interno configurado →
// destino preferido → propio número (nota interna). Nunca se pierde.
async function destinoAvisos(adminId, destinoPreferido) {
  try {
    const doc = await db.collection('annyConfig').doc(adminId).get();
    const grupo = doc.exists ? doc.data().notificarGrupoJid : null;
    if (grupo) return aJidCo(grupo);
  } catch (err) {
    console.error('[BAILEYS] Error leyendo grupo de avisos:', err.message);
  }
  return aJidCo(destinoPreferido);
}

async function enviarAvisoEscalamiento(adminId, texto, destinoPreferido, telefonoCliente) {
  try {
    let jid = await destinoAvisos(adminId, destinoPreferido);
    let viaFallback = false;

    if (!jid) {
      // Fallback: nota interna al propio número conectado
      const ses = sesiones.get(adminId);
      jid = aJidCo(ses?.numero);
      viaFallback = true;
    }

    if (!jid) {
      console.warn(`[BAILEYS] Escalamiento sin destino de aviso (tenant ${adminId})`);
      return false;
    }

    const link = telefonoCliente
      ? `\n\nAbrir chat: https://wa.me/${String(telefonoCliente).replace(/\D/g, '')}`
      : '';
    const pie = '\nGestiónalo en Control360 → Anny → Escalados';

    await enviarMensaje(adminId, jid, `${texto}${link}${pie}`);
    if (viaFallback) {
      console.log(`[BAILEYS] Aviso de escalamiento enviado al propio número (tenant ${adminId}) — configura notificarEscalamientoA para dirigirlo al asesor`);
    }
    return true;
  } catch (err) {
    console.error('[BAILEYS] Error enviando aviso de escalamiento:', err.message);
    return false;
  }
}

// ============================================================
// Procesar un mensaje entrante o saliente-manual
// ============================================================
async function procesarMensaje(adminId, msg) {
  if (!msg.message) return;

  const jid = msg.key.remoteJid || '';
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;

  // ✅ ANNY-FOTO-040: se abre el sobre (ver-una-vez / temporal / documento
  // con descripción) ANTES de leer nada. Sin esto, las fotos enviadas de la
  // forma más común en WhatsApp se descartaban en silencio.
  const contenido = desenvolverMensaje(msg.message);

  let texto = extraerTexto(contenido);

  // ✅ ANNY-MEDIA-024: foto o nota de voz. Antes se descartaban en silencio
  // con `if (!texto) return;` — el cliente mandaba la foto del extintor y
  // para Anny ese mensaje nunca existió.
  let imagenAdjunta = null;
  const medio = annyMultimedia.detectarMedio(contenido);

  // ✅ ANNY-FOTO-040: traza de diagnóstico. Si una foto vuelve a perderse,
  // el log dice exactamente en qué paso se cayó, en vez de no decir nada.
  if (!msg.key.fromMe && !texto && !medio) {
    console.warn('[ANNY-MEDIA] Mensaje sin texto ni medio reconocido. Claves:',
      Object.keys(contenido || {}).join(', ') || '(vacío)');
  }

  if (medio && !msg.key.fromMe) {
    // ✅ ANNY-CONSUMO-026 (FRENO): antes de gastar, se consulta el tope del
    // suscriptor. Si llegó a su límite del mes —o si desactivó el análisis—
    // el medio NO se procesa y el mensaje escala a un asesor. Nunca se sigue
    // gastando en silencio por encima de lo que el plan cubre.
    const permiso = await annyConsumo.puedeAnalizarMedio(adminId, medio.tipo)
      .catch(() => ({ permitido: true }));

    if (!permiso.permitido) {
      const queEs = medio.tipo === 'imagen' ? 'una foto' : 'una nota de voz';
      texto = `[el cliente envió ${queEs} — no se analizó (${permiso.motivo === 'tope_mes' ? 'tope del mes alcanzado' : 'análisis desactivado'})]`;
      console.log(`[ANNY-CONSUMO] Medio ${medio.tipo} NO analizado para ${adminId}: ${permiso.motivo}`);
    } else {
      const buffer = await descargarMedia(msg).catch(() => null);

      if (medio.tipo === 'imagen') {
        imagenAdjunta = buffer ? annyMultimedia.prepararImagen(buffer, medio.mimetype) : null;
        // El caption (si lo hay) se conserva: suele traer el contexto
        // ("estos son los que necesito recargar").
        if (!texto) texto = imagenAdjunta ? '[el cliente envió una foto]' : '[el cliente envió una foto que no se pudo abrir]';
      }

      if (medio.tipo === 'audio') {
        const transcrito = buffer ? await annyMultimedia.transcribirAudio(buffer, medio.mimetype) : null;
        // Si no se pudo transcribir NO se responde a ciegas: se deja constancia
        // para que Anny lo admita y pida que le escriban o escale.
        texto = transcrito
          ? `[nota de voz del cliente] ${transcrito}`
          : '[el cliente envió una nota de voz que no se pudo escuchar]';
        // El audio se paga en créditos ElevenLabs, aparte de Anthropic:
        // se cuenta aunque la transcripción haya fallado (el intento se cobra).
        if (transcrito) annyConsumo.registrarConsumo(adminId, { conAudio: true }).catch(() => {});
      }
    }
  }

  if (!texto) return;

  const telefono = jid.split('@')[0];

  // FIX ANNY-SILENCIO-001: chat silenciado → Anny lo ignora por
  // completo (ni responde, ni registra, ni gasta IA). Para
  // conversaciones internas del equipo.
  if (await estaSilenciado(adminId, telefono)) return;

  if (msg.key.fromMe) {
    // FIX ANNY-ECO-001: eco de un mensaje enviado por la propia
    // Anny (está en el almacén de enviados) → ignorar por completo.
    // Sin este filtro, los textos de Anny se registraban como
    // ADMIN_MANUAL y el historial se los atribuía a la humana.
    if (msg.key.id && mensajesEnviados.has(msg.key.id)) {
      return;
    }

    // FIX ANNY-PAUSA-004: mensaje manual REAL de la admin →
    // registrar en historial (aprendizaje) + pausar Anny 30 min
    // en este chat. Cada mensaje manual refresca la pausa, así
    // Anny no interrumpe mientras la admin atiende al cliente.
    await annyService.registrarConversacion(adminId, {
      telefono,
      nombreCliente: null,
      mensajeCliente: null,
      respuestaAgente: texto,
      respondidoPor: 'ADMIN_MANUAL',
      escalado: false,
      caseId: null
    });

    await annyService.pausarAnny(adminId, telefono, 30, 'intervencion_manual');
    return;
  }

  // Caso escalado pendiente = la admin está atendiendo → silencio
  // ✅ ANNY-MUDA-043 + ANNY-REAVISO-044
  // Caso escalado pendiente = el humano debería estar atendiendo.
  // Anny calla, pero SOLO durante la ventana. Y cada mensaje del
  // cliente dentro de la ventana dispara un RE-AVISO: que el
  // cliente insista es la señal más fuerte de que nadie entró.
  const casoPend = await casoPendienteDe(adminId, telefono);
  if (casoPend && casoPend.dentroDeVentana) {
    await annyService.registrarConversacion(adminId, {
      telefono,
      nombreCliente: msg.pushName || telefono,
      mensajeCliente: texto,
      respuestaAgente: null,
      respondidoPor: 'EN_MANOS_DE_ADMIN',
      escalado: true,
      caseId: casoPend.id
    });

    if (Date.now() - casoPend.ultimoAvisoMs > REAVISO_MIN * 60 * 1000) {
      try {
        const perfil = await annyService.obtenerPerfilTenant(adminId);
        await enviarAvisoEscalamiento(
          adminId,
          `⏰ *EL CLIENTE INSISTE* — caso sin atender hace ${Math.round(casoPend.edadMin)} min\n` +
          `${casoPend.nombreCliente || msg.pushName || 'Sin nombre'} — ${telefono}\n` +
          `Escribió: "${String(texto).slice(0, 120)}"`,
          perfil?.notificarEscalamientoA,
          telefono
        );
        await casoPend.ref.set({ ultimoAvisoMs: Date.now() }, { merge: true });
      } catch (eRe) {
        console.error('[BAILEYS] Error en re-aviso de escalado:', eRe.message);
      }
    }
    return;
  }

  // Ventana vencida y el caso sigue PENDIENTE: nadie entró. Anny
  // retoma — mejor una respuesta imperfecta que un cliente mudo.
  if (casoPend && !casoPend.dentroDeVentana) {
    console.log(`[BAILEYS] Caso ${casoPend.id} pendiente hace ${Math.round(casoPend.edadMin)} min sin atender — Anny retoma el chat ${telefono}`);
  }

  const resultado = await annyService.procesarMensajeEntrante({
    adminId,
    telefono,
    nombreCliente: msg.pushName || telefono,
    mensajeTexto: texto,
    imagenAdjunta // ✅ ANNY-MEDIA-024
  });

  if (resultado?.accion === 'enviar_mensaje' && resultado.respuesta) {
    await enviarMensaje(adminId, jid, resultado.respuesta);
  }

  // ✅ ANNY-PAGO-050: el cliente mandó un comprobante de pago.
  // Se reenvía LA FOTO al grupo interno con el contexto. Anny ya le
  // acusó recibo al cliente sin afirmar que el pago quedó aplicado:
  // validar es trabajo de tesorería, no del agente.
  if (resultado?.avisoPago) {
    try {
      const jidAviso = await destinoAvisos(adminId, resultado.notificarA);
      if (jidAviso) {
        const img = resultado.imagenComprobante;
        if (img?.data) {
          await enviarImagen(adminId, jidAviso, img.data, img.media_type, resultado.avisoPago);
        } else {
          await enviarMensaje(adminId, jidAviso, resultado.avisoPago);
        }
      } else {
        console.warn(`[BAILEYS] Comprobante de pago sin destino de aviso (tenant ${adminId})`);
      }
    } catch (ePago) {
      console.error('[BAILEYS] Error reenviando comprobante de pago:', ePago.message);
    }
  }

  // ✅ ANNY-AVISO-041: caso escalado → aviso interno AHORA.
  // Este bloque es el que faltaba: sin él el escalamiento era un
  // callejón sin salida (el cliente esperando, nadie enterado).
  if (resultado?.avisoEscalamiento) {
    await enviarAvisoEscalamiento(
      adminId,
      resultado.avisoEscalamiento,
      resultado.notificarA,
      resultado.telefonoCliente || telefono
    );
    if (resultado.caseId) {
      db.collection('casosEscaladosAnny').doc(adminId)
        .collection('casos').doc(resultado.caseId)
        .set({ ultimoAvisoMs: Date.now() }, { merge: true })
        .catch(() => {});
    }
  }

  // FIX ANNY-PEDIDOS-001: Anny cerró una venta → avisar a la admin
  if (resultado?.pedido && resultado?.notificarA) {
    try {
      const numAdmin = String(resultado.notificarA).replace(/\D/g, '');
      if (numAdmin.length >= 10) {
        const jidAdmin = `${numAdmin.startsWith('57') ? numAdmin : '57' + numAdmin}@s.whatsapp.net`;
        const p = resultado.pedido;
        const aviso = `🛒 *Nuevo pedido cerrado por Anny*\n\n` +
          `✅ ${p.producto || ''}${p.cantidad ? ` x${p.cantidad}` : ''}\n` +
          `💰 Total: ${p.total || 'por confirmar'}\n` +
          `👤 ${p.nombreCliente || ''} — ${resultado.telefonoCliente || telefono}\n` +
          `🪪 ${p.cedulaNit || ''}\n` +
          `📧 ${p.correo || ''}\n` +
          `📍 ${p.direccion || ''}${p.barrio ? ', ' + p.barrio : ''}\n` +
          `📅 ${p.fecha || ''}\n\n` +
          `Gestiónalo en Control360 → Anny → 🛒 Pedidos`;
        await enviarMensaje(adminId, jidAdmin, aviso);
      }
    } catch (eAviso) {
      console.error('[BAILEYS] Error avisando pedido a la admin:', eAviso.message);
    }
  }

  // ✅ TALLER-RESPUESTA-001: el cliente contestó la autorización de un
  // repuesto. Se avisa a la admin para que el equipo no quede parado en
  // taller esperando que alguien lea el chat. La alerta también sale en el
  // panel (tipo DEFECTO_RESPONDIDO, roles admin + taller).
  // OJO: esto es SOLO un aviso — la autorización real la aplica el taller.
  if (resultado?.avisoTaller && resultado?.notificarTallerA) {
    try {
      const numTaller = String(resultado.notificarTallerA).replace(/\D/g, '');
      if (numTaller.length >= 10) {
        const jidTaller = `${numTaller.startsWith('57') ? numTaller : '57' + numTaller}@s.whatsapp.net`;
        await enviarMensaje(adminId, jidTaller, resultado.avisoTaller);
      }
    } catch (eTaller) {
      console.error('[BAILEYS] Error avisando respuesta de taller:', eTaller.message);
    }
  }
}

// ============================================================
// Iniciar (o reiniciar) la sesión de WhatsApp de un tenant
// ============================================================
async function iniciarSesion(adminId) {
  const existente = sesiones.get(adminId);
  if (existente && ['conectado', 'esperando_qr', 'conectando'].includes(existente.estado)) {
    return { estado: existente.estado };
  }

  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await cargarBaileys();

  const dir = path.join(BAILEYS_DIR, adminId);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    browser: ['Control360', 'Chrome', '1.0'],
    getMessage: async (key) => {
      return mensajesEnviados.get(key?.id) || undefined;
    }
  });

  const ses = {
    sock,
    estado: 'conectando',
    qr: null,
    numero: null,
    reintentos: existente?.reintentos || 0
  };
  sesiones.set(adminId, ses);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    try {
      if (qr) {
        ses.qr = await qrcode.toDataURL(qr);
        ses.estado = 'esperando_qr';
        await guardarEstado(adminId, 'esperando_qr');
      }

      if (connection === 'open') {
        ses.estado = 'conectado';
        ses.qr = null;
        ses.reintentos = 0;
        ses.numero = (sock.user?.id || '').split(':')[0].split('@')[0];
        await guardarEstado(adminId, 'conectado', ses.numero);
        console.log(`[BAILEYS] ✅ Conectado tenant ${adminId} — número ${ses.numero}`);
      }

      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;

        if (codigo === DisconnectReason.loggedOut) {
          sesiones.delete(adminId);
          fs.rmSync(dir, { recursive: true, force: true });
          await guardarEstado(adminId, 'desconectado');
          console.log(`[BAILEYS] Sesión cerrada (logout) tenant ${adminId}`);
        } else {
          ses.estado = 'reconectando';
          ses.reintentos += 1;
          if (ses.reintentos <= MAX_REINTENTOS) {
            console.log(`[BAILEYS] Reconectando tenant ${adminId} (intento ${ses.reintentos})...`);
            setTimeout(() => {
              iniciarSesion(adminId).catch(err =>
                console.error('[BAILEYS] Error reconectando:', err.message)
              );
            }, 5000);
          } else {
            sesiones.delete(adminId);
            await guardarEstado(adminId, 'desconectado');
            console.error(`[BAILEYS] Tenant ${adminId} superó ${MAX_REINTENTOS} reintentos — desconectado`);
          }
        }
      }
    } catch (err) {
      console.error('[BAILEYS] Error en connection.update:', err.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      procesarMensaje(adminId, msg).catch(err =>
        console.error('[BAILEYS] Error procesando mensaje:', err.message)
      );
    }
  });

  return { estado: ses.estado };
}

// ============================================================
// Desconectar y borrar la sesión de un tenant
// ============================================================
async function desconectar(adminId) {
  const ses = sesiones.get(adminId);
  try {
    if (ses?.sock) await ses.sock.logout();
  } catch (err) {
    // logout puede fallar si ya está desconectado — no es crítico
  }
  sesiones.delete(adminId);
  const dir = path.join(BAILEYS_DIR, adminId);
  fs.rmSync(dir, { recursive: true, force: true });
  await guardarEstado(adminId, 'desconectado');
  return { estado: 'desconectado' };
}

// ============================================================
// Estado y QR (para los endpoints del panel)
// ============================================================
async function getEstado(adminId) {
  const ses = sesiones.get(adminId);
  if (ses) return { estado: ses.estado, numero: ses.numero };

  try {
    const doc = await db.collection('annyConfig').doc(adminId).get();
    const data = doc.exists ? doc.data() : {};
    const estado = data.conexionEstado === 'conectado' ? 'desconectado' : (data.conexionEstado || 'desconectado');
    return { estado, numero: data.whatsappNumber || null };
  } catch (err) {
    return { estado: 'desconectado', numero: null };
  }
}

function getQR(adminId) {
  const ses = sesiones.get(adminId);
  return { qr: ses?.qr || null, estado: ses?.estado || 'desconectado' };
}

// ============================================================
// Restaurar sesiones al arrancar el server (post-deploy)
// ============================================================
async function restaurarSesiones() {
  try {
    const snap = await db.collection('annyConfig')
      .where('conexionEstado', '==', 'conectado')
      .get();

    if (snap.empty) {
      console.log('[BAILEYS] Sin sesiones para restaurar');
      return;
    }

    for (const doc of snap.docs) {
      console.log(`[BAILEYS] Restaurando sesión tenant ${doc.id}...`);
      iniciarSesion(doc.id).catch(err =>
        console.error(`[BAILEYS] Error restaurando ${doc.id}:`, err.message)
      );
    }
  } catch (err) {
    console.error('[BAILEYS] Error restaurando sesiones:', err.message);
  }
}

module.exports = {
  iniciarSesion,
  desconectar,
  getEstado,
  getQR,
  enviarMensaje,
  enviarImagen,      // ✅ ANNY-PAGO-050
  listarGrupos,      // ✅ ANNY-GRUPO-051
  invalidarCacheSilencio,
  restaurarSesiones
};
// FIN baileysService.js
