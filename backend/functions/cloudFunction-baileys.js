// ============================================================
// Control360 — Cloud Function: Baileys WhatsApp Listener
// Ubicación: firebase/functions/index.js
// ============================================================
// PRINCIPIOS:
// 1. Corre en Google Cloud Functions (24/7)
// 2. Usa Baileys para conectar a WhatsApp Web
// 3. Escucha mensajes entrantes en tiempo real
// 4. Dispara annyService.procesarMensajeEntrante()
// 5. Se reconecta automáticamente si cae
// ============================================================

const functions = require('firebase-functions');
const { db, admin } = require('./config');
const annyService = require('./services/annyService');

// Importar Baileys
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// ============================================================
// VARIABLES GLOBALES (por tenant)
// ============================================================
const socketsByAdmin = {}; // { adminId: waSocket }
const reconexionCounters = {}; // { adminId: intentos }

// ============================================================
// Función: Conectar Baileys a WhatsApp para un admin
// ============================================================
async function conectarBaileys(adminId) {
  try {
    // 1. Leer config del admin en Firestore
    const configSnap = await db.collection('annyConfig').doc(adminId).get();

    if (!configSnap.exists || !configSnap.data().activo) {
      console.log(`[BAILEYS] Anny inactivo para ${adminId}`);
      return null;
    }

    const config = configSnap.data();
    console.log(`[BAILEYS] Conectando ${adminId} con número ${config.whatsappNumber}`);

    // 2. Setup de autenticación (carpeta local por admin)
    const { state, saveCreds } = await useMultiFileAuthState(`./auth_sessions/${adminId}`);

    // 3. Crear socket de Baileys
    const waSocket = makeWASocket({
      auth: state,
      printQRInTerminal: false, // No imprime en terminal (se maneja en HTTP endpoint)
      logger: pino({ level: 'silent' }), // Silencio para logs
      browser: ['Chrome', 'Chrome', '121.0.0.0']
    });

    // 4. Event: Cambio de conexión
    waSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // QR generado: guardar en Firestore para que el admin lo escanee
        console.log(`[BAILEYS] QR generado para ${adminId}`);
        await db.collection('annyConfig').doc(adminId).update({
          qrCode: qr.toString('base64'), // Convertir a base64 para almacenar
          qrGeneradoEn: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      if (connection === 'open') {
        console.log(`[BAILEYS] ✅ CONECTADO: ${adminId}`);
        await db.collection('annyConfig').doc(adminId).update({
          conectado: true,
          ultimaConexion: admin.firestore.FieldValue.serverTimestamp(),
          qrCode: null // Limpiar QR
        });
        reconexionCounters[adminId] = 0; // Reset contador
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log(`[BAILEYS] Reconectando ${adminId}...`);
          reconexionCounters[adminId] = (reconexionCounters[adminId] || 0) + 1;

          // Reconexión exponencial (hasta 10 intentos)
          if (reconexionCounters[adminId] < 10) {
            const delay = Math.min(1000 * Math.pow(2, reconexionCounters[adminId]), 60000);
            setTimeout(() => conectarBaileys(adminId), delay);
          }
        } else {
          console.log(`[BAILEYS] Desconexión permanente para ${adminId}`);
          await db.collection('annyConfig').doc(adminId).update({
            conectado: false
          });
        }
      }
    });

    // 5. Event: Guardar credenciales cuando se actualicen
    waSocket.ev.on('creds.update', saveCreds);

    // 6. Event: MENSAJES ENTRANTES ← AQUÍ PROCESA ANNY
    waSocket.ev.on('messages.upsert', async (m) => {
      const { messages } = m;

      for (const msg of messages) {
        // Ignorar mensajes propios, del grupo, etc.
        if (msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) continue;

        const telefono = msg.key.remoteJid.replace('@s.whatsapp.net', '');
        const textoMensaje = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

        if (!textoMensaje) continue; // Sin texto, ignorar

        console.log(`[BAILEYS] Mensaje de ${telefono}: "${textoMensaje}"`);

        // Obtener nombre del cliente
        const contactSnap = await db.collection('clientes')
          .doc(adminId)
          .collection('contactos')
          .where('telefono', '==', telefono)
          .limit(1)
          .get();

        const nombreCliente = !contactSnap.empty
          ? contactSnap.docs[0].data().nombre
          : 'Cliente';

        // DISPARA ANNY (fire-and-forget, no espera respuesta)
        annyService.procesarMensajeEntrante({
          adminId,
          telefono,
          nombreCliente,
          mensajeTexto: textoMensaje
        }).catch(err => console.error('[ANNY] Error procesando:', err.message));

        // Si Anny generó respuesta automática, enviarla por Baileys
        // (nota: en esta versión, Baileys devuelve el messageId para tracking)
        // Implementación futura: integrar respuesta directamente
      }
    });

    socketsByAdmin[adminId] = waSocket;
    return waSocket;

  } catch (err) {
    console.error(`[BAILEYS] Error conectando ${adminId}:`, err.message);
    return null;
  }
}

// ============================================================
// HTTP Endpoint: GET QR (para mostrar en dashboard)
// Ruta: GET /api/anny/qr/:adminId
// ============================================================
exports.annyQrEndpoint = functions.https.onRequest(async (req, res) => {
  const { adminId } = req.params;

  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const configSnap = await db.collection('annyConfig').doc(adminId).get();

    if (!configSnap.exists) {
      return res.status(404).json({ error: 'Config no encontrada' });
    }

    const qrCode = configSnap.data().qrCode;

    if (!qrCode) {
      return res.json({ status: 'esperando_qr' });
    }

    // Devolver QR como imagen
    const qrBuffer = Buffer.from(qrCode, 'base64');
    res.set('Content-Type', 'image/png');
    res.send(qrBuffer);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Cron Function: Detectar vencimientos y enviar recordatorios
// Ejecutar: cada noche a las 01:00 AM (timezone: America/Bogota)
// ============================================================
exports.detectarYEnviarVencimientos = functions.pubsub
  .schedule('0 1 * * *') // 01:00 AM diario
  .timeZone('America/Bogota')
  .onRun(async (context) => {
    console.log('[CRON] Iniciando detección de vencimientos...');

    try {
      // Obtener todos los suscriptores activos
      const suscriptoresSnap = await db.collection('usuarios')
        .where('role', '==', 'admin')
        .where('activo', '==', true)
        .get();

      for (const susc of suscriptoresSnap.docs) {
        const adminId = susc.id;
        const config = await annyService.obtenerConfig(adminId);

        if (!config.activo) continue; // Anny inactivo para este admin

        const diasAntes = config.diasAntes || 30;

        // Buscar clientes con vencimiento en X días
        const fechaVencimiento = new Date();
        fechaVencimiento.setDate(fechaVencimiento.getDate() + diasAntes);

        // NOTA: Esta query depende de tu estructura de datos
        // Adaptar según cómo guardes vencimientos en Control360
        const clientesSnap = await db.collection('clientes')
          .where('adminId', '==', adminId)
          .where('fechaVencimiento', '<=', fechaVencimiento)
          .where('contactado_esta_semana', '!=', true)
          .get();

        for (const clienteDoc of clientesSnap.docs) {
          const cliente = clienteDoc.data();

          // Crear mensaje personalizado
          const mensaje = `Hola ${cliente.nombre}, tu servicio vence el ${cliente.fechaVencimiento}. ¿Necesitas renovar? Escribe PRECIO o COTIZACION`;

          // Enviar por Baileys (si está conectado)
          if (socketsByAdmin[adminId]) {
            try {
              await socketsByAdmin[adminId].sendMessage(
                `${cliente.telefono}@s.whatsapp.net`,
                { text: mensaje }
              );

              console.log(`[VENCIMIENTOS] Enviado a ${cliente.telefono}`);

              // Marcar como contactado
              await clienteDoc.ref.update({
                contactado_esta_semana: true,
                fechaUltimoContacto: admin.firestore.FieldValue.serverTimestamp()
              });
            } catch (err) {
              console.error(`[VENCIMIENTOS] Error enviando a ${cliente.telefono}:`, err.message);
            }
          }
        }
      }

      console.log('[CRON] Detección de vencimientos completada');
      return null;

    } catch (err) {
      console.error('[CRON] Error en cron:', err.message);
      return null;
    }
  });

// ============================================================
// Cron Function: Inicializar conexiones de Baileys (cada 6 horas)
// ============================================================
exports.inicializarBaileysPeriodicamente = functions.pubsub
  .schedule('0 */6 * * *') // Cada 6 horas
  .timeZone('America/Bogota')
  .onRun(async (context) => {
    console.log('[BAILEYS] Cron: Inicializando conexiones...');

    try {
      const configsSnap = await db.collection('annyConfig')
        .where('activo', '==', true)
        .get();

      for (const configDoc of configsSnap.docs) {
        const adminId = configDoc.id;

        // Si no está conectado, intentar conectar
        if (!socketsByAdmin[adminId]) {
          console.log(`[BAILEYS] Intentando conectar ${adminId}...`);
          await conectarBaileys(adminId);
        }
      }

      console.log('[BAILEYS] Inicialización completada');
      return null;

    } catch (err) {
      console.error('[BAILEYS] Error en cron:', err.message);
      return null;
    }
  });

// ============================================================
// Función: Exportar para iniciar en el arranque
// ============================================================
exports.initBaileysSockets = functions.https.onCall(async (data, context) => {
  if (!context.auth) return { error: 'No autenticado' };

  const { adminId } = data;

  try {
    const socket = await conectarBaileys(adminId);
    return { ok: !!socket };
  } catch (err) {
    return { error: err.message };
  }
});

module.exports = {
  conectarBaileys,
  socketsByAdmin
};
