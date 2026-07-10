// ============================================================
// Control360 — Servicio Baileys (WhatsApp Web) para Anny
// Ubicación: backend/services/baileysService.js
// FIX ANNY-QR-001 + ANNY-QR-003 + ANNY-QR-004 + ANNY-PEDIDOS-001
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
// 9. FIX ANNY-PEDIDOS-001: pedido cerrado → aviso al WhatsApp de
//    la admin (annyConfig.notificarPedidosA)
// ============================================================

const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { db, admin } = require('../config/firebase');
const annyService = require('./annyService');

// ============================================================
// FIX ANNY-QR-003: Baileys es ESM-only — carga con import()
// dinámico y perezoso, compatible con v6 y v7.
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
    fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion || raiz.fetchLatestBaileysVersion
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
// de cifrado (sin esto el cliente ve "Esperando el mensaje...")
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
// Extraer texto de un mensaje de WhatsApp (tipos comunes)
// ============================================================
function extraerTexto(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  ).trim();
}

// ============================================================
// Anti-colisión: ¿hay caso escalado PENDIENTE de este teléfono?
// ============================================================
async function hayCasoPendiente(adminId, telefono) {
  try {
    const snap = await db.collection('casosEscaladosAnny')
      .doc(adminId)
      .collection('casos')
      .where('telefono', '==', telefono)
      .where('estado', '==', 'PENDIENTE')
      .limit(1)
      .get();
    return !snap.empty;
  } catch (err) {
    console.error('[BAILEYS] Error consultando casos pendientes:', err.message);
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

  const texto = extraerTexto(msg.message);
  if (!texto) return;

  const telefono = jid.split('@')[0];

  // Respuesta manual de la admin → historial (aprendizaje)
  if (msg.key.fromMe) {
    await annyService.registrarConversacion(adminId, {
      telefono,
      nombreCliente: null,
      mensajeCliente: null,
      respuestaAgente: texto,
      respondidoPor: 'ADMIN_MANUAL',
      escalado: false,
      caseId: null
    });
    return;
  }

  // Caso escalado pendiente = la admin está atendiendo → silencio
  const enManosDeAdmin = await hayCasoPendiente(adminId, telefono);
  if (enManosDeAdmin) {
    await annyService.registrarConversacion(adminId, {
      telefono,
      nombreCliente: msg.pushName || telefono,
      mensajeCliente: texto,
      respuestaAgente: null,
      respondidoPor: 'EN_MANOS_DE_ADMIN',
      escalado: true,
      caseId: null
    });
    return;
  }

  const resultado = await annyService.procesarMensajeEntrante({
    adminId,
    telefono,
    nombreCliente: msg.pushName || telefono,
    mensajeTexto: texto
  });

  if (resultado?.accion === 'enviar_mensaje' && resultado.respuesta) {
    await enviarMensaje(adminId, jid, resultado.respuesta);
  }

  // ============================================================
  // FIX ANNY-PEDIDOS-001: Anny cerró una venta → avisar a la admin
  // en el número configurado (annyConfig.notificarPedidosA)
  // ============================================================
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
    // FIX ANNY-QR-004: responder solicitudes de reenvío/reintento
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
  restaurarSesiones
};
// FIN baileysService.js
