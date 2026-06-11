// ============================================================
// Control360 — Rutas WhatsApp
// Ubicación: backend/routes/whatsapp.js
// ------------------------------------------------------------
// MONTAJE en server.js (UNA sola línea, junto a las demás rutas):
//   app.use('/api/whatsapp', require('./routes/whatsapp'));
//
// IMPORTANTE: el webhook (GET/POST /webhook) es PÚBLICO porque
// Meta lo llama directamente — por eso el authenticate se aplica
// por ruta, igual que el patrón usado en qr_public.
//
// Variables de entorno requeridas en Railway:
//   WHATSAPP_VERIFY_TOKEN   → string secreto que tú inventas
//                             (se pega igual en el panel de Meta)
//   WHATSAPP_TOKEN          → token permanente (system user) [tenant piloto]
//   WHATSAPP_PHONE_NUMBER_ID→ ID del número [tenant piloto]
// ============================================================

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
const waService = require('../services/whatsappService');

// ============================================================
// 1. WEBHOOK — Verificación inicial (Meta hace GET una sola vez)
// ============================================================
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[WA] Webhook verificado por Meta ✅');
    return res.status(200).send(challenge);
  }
  console.warn('[WA] Intento de verificación de webhook rechazado');
  return res.sendStatus(403);
});

// ============================================================
// 2. WEBHOOK — Eventos de Meta (estados de entrega + mensajes
//    entrantes). SIEMPRE responder 200 rápido: si Meta recibe
//    errores repetidos, desactiva el webhook.
// ============================================================
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder primero, procesar después

  try {
    const entries = req.body?.entry || [];

    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const phoneNumberId = value?.metadata?.phone_number_id || null;

        // --- a) Estados de entrega (sent / delivered / read / failed) ---
        for (const status of (value.statuses || [])) {
          await actualizarEstadoMensaje(status);
        }

        // --- b) Mensajes entrantes (base para el agente IA — Fase 3) ---
        for (const msg of (value.messages || [])) {
          await guardarMensajeEntrante(msg, phoneNumberId, value.contacts);
        }
      }
    }
  } catch (err) {
    console.error('[WA] Error procesando webhook:', err.message);
  }
});

// Actualiza el estado en wa_mensajes usando el messageId de Meta
async function actualizarEstadoMensaje(status) {
  try {
    const snap = await db.collection('wa_mensajes')
      .where('messageId', '==', status.id)
      .limit(1)
      .get();

    if (!snap.empty) {
      const update = { estado: status.status }; // delivered | read | failed
      if (status.status === 'failed' && status.errors?.[0]) {
        update.error = `${status.errors[0].code}: ${status.errors[0].title || ''}`;
      }
      await snap.docs[0].ref.update(update);
    }
  } catch (err) {
    console.error('[WA] Error actualizando estado:', err.message);
  }
}

// Guarda mensajes entrantes en wa_conversaciones, resolviendo el
// tenant por phoneNumberId (cada suscriptor tiene número propio)
async function guardarMensajeEntrante(msg, phoneNumberId, contacts) {
  try {
    let adminId = null;
    if (phoneNumberId) {
      const cfg = await db.collection('whatsapp_config')
        .where('phoneNumberId', '==', phoneNumberId)
        .limit(1)
        .get();
      if (!cfg.empty) adminId = cfg.docs[0].id;
    }

    await db.collection('wa_conversaciones').add({
      adminId,                                   // aislamiento multi-tenant
      telefono: msg.from,
      nombrePerfil: contacts?.[0]?.profile?.name || null,
      tipo: msg.type,                            // text | button | image...
      texto: msg.text?.body || msg.button?.text || null,
      messageId: msg.id,
      direccion: 'entrante',
      procesadoIA: false,                        // flag para Fase 3 (agente)
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[WA] Error guardando mensaje entrante:', err.message);
  }
}

// ============================================================
// 3. CONFIG del tenant (solo admin)
// ============================================================
router.get('/config', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede ver esta configuración' });
    }
    const adminId = req.user.adminId || req.user.uid;
    const doc = await db.collection('whatsapp_config').doc(adminId).get();

    if (!doc.exists) return res.json({ activo: false, configurado: false });

    const data = doc.data();
    // Nunca devolver el token completo al frontend
    return res.json({
      activo: data.activo || false,
      configurado: true,
      phoneNumberId: data.phoneNumberId || null,
      tokenConfigurado: !!(data.token || process.env.WHATSAPP_TOKEN),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/config', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede modificar esta configuración' });
    }
    const adminId = req.user.adminId || req.user.uid;
    const { activo, phoneNumberId, token } = req.body;

    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (typeof activo === 'boolean') update.activo = activo;
    if (phoneNumberId) update.phoneNumberId = phoneNumberId;
    if (token) update.token = token; // token permanente del system user del tenant

    await db.collection('whatsapp_config').doc(adminId).set(update, { merge: true });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4. ENVÍO DE PRUEBA (solo admin) — para validar con el número
//    de test de Meta ANTES de conectar el flujo de órdenes.
//    Body: { telefono, plantilla?, variables? }
//    Si no se indica plantilla usa 'hello_world' (la de prueba
//    que Meta trae preaprobada en toda cuenta nueva).
// ============================================================
router.post('/enviar-prueba', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede enviar pruebas' });
    }
    const adminId = req.user.adminId || req.user.uid;
    const { telefono, plantilla = 'hello_world', variables = [] } = req.body;

    if (!telefono) return res.status(400).json({ error: 'Falta el teléfono de destino' });

    const resultado = await waService.enviarPlantilla({
      adminId,
      telefono,
      plantilla,
      variables,
      contexto: 'prueba_manual',
    });

    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 5. LOG de mensajes del tenant (auditoría / consumo)
//    Sin orderBy en Firestore: orden en memoria (regla del proyecto
//    para evitar índices compuestos).
// ============================================================
router.get('/mensajes', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const limite = Math.min(parseInt(req.query.limit) || 100, 300);

    const snap = await db.collection('wa_mensajes')
      .where('adminId', '==', adminId)
      .limit(500)
      .get();

    const mensajes = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      .slice(0, limite);

    return res.json(mensajes);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
