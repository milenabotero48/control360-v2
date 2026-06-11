// ============================================================
// Control360 — Servicio WhatsApp Cloud API (Meta)
// Ubicación: backend/services/whatsappService.js
// ------------------------------------------------------------
// PRINCIPIOS:
// 1. Multi-tenant: cada suscriptor tiene su propia config
//    (colección whatsapp_config, docId = adminId del tenant).
// 2. NO BLOQUEANTE: ninguna función lanza excepciones hacia
//    arriba. Si WhatsApp falla, la operación del sistema
//    continúa y el error queda registrado en wa_mensajes.
// 3. Todo envío queda auditado en la colección wa_mensajes.
// ============================================================

const { db, admin } = require('../config/firebase');

const GRAPH_VERSION = 'v21.0';

// ------------------------------------------------------------
// Mapa estado de orden → nombre de plantilla (piloto: 4 plantillas)
// Los nombres deben coincidir EXACTAMENTE con los aprobados en Meta.
// ------------------------------------------------------------
const ESTADO_PLANTILLA = {
  'Programada':       'os_creada',
  'En Ruta Recogida': 'mensajero_camino_recogida',
  'En Ruta Entrega':  'mensajero_camino_entrega',
  // 'novedad_taller' se dispara desde el módulo Taller, no por estado
};

// ------------------------------------------------------------
// Obtener configuración WhatsApp del tenant.
// Fallback a variables de entorno para el tenant piloto
// (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID en Railway).
// ------------------------------------------------------------
async function getConfigTenant(adminId) {
  try {
    const doc = await db.collection('whatsapp_config').doc(adminId).get();

    if (doc.exists && doc.data().activo) {
      const data = doc.data();
      return {
        activo: true,
        phoneNumberId: data.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
        token: data.token || process.env.WHATSAPP_TOKEN,
        plantillas: data.plantillas || {},
      };
    }

    // Sin config en Firestore: módulo inactivo para este tenant
    return { activo: false };
  } catch (err) {
    console.error('[WA] Error leyendo whatsapp_config:', err.message);
    return { activo: false };
  }
}

// ------------------------------------------------------------
// Normalizar teléfono colombiano → formato E.164 sin '+'
// "310 123 4567" → "573101234567"
// ------------------------------------------------------------
function normalizarTelefono(telefono) {
  if (!telefono) return null;
  let t = String(telefono).replace(/[\s\-\(\)\+\.]/g, '');
  if (t.startsWith('57') && t.length === 12) return t;
  if (t.length === 10 && t.startsWith('3')) return '57' + t;
  if (t.length === 7) return null; // fijo sin indicativo: no enviable
  return t.length >= 11 ? t : null;
}

// ------------------------------------------------------------
// Registrar resultado del envío en wa_mensajes (auditoría + base
// para facturación de consumo por tenant en el futuro)
// ------------------------------------------------------------
async function logMensaje(registro) {
  try {
    await db.collection('wa_mensajes').add({
      ...registro,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[WA] Error guardando log wa_mensajes:', err.message);
  }
}

// ------------------------------------------------------------
// FUNCIÓN CENTRAL: enviar plantilla aprobada por Meta.
// variables = array de strings en el orden de los {{1}}, {{2}}...
// Retorna { ok, messageId?, error? } — NUNCA lanza excepción.
// ------------------------------------------------------------
async function enviarPlantilla({ adminId, telefono, plantilla, variables = [], ordenId = null, contexto = null, idioma = null }) {
  // hello_world (plantilla de prueba de Meta) solo existe en inglés
  if (!idioma) idioma = plantilla === 'hello_world' ? 'en_US' : 'es';
  const base = { adminId, plantilla, ordenId, contexto, telefonoOriginal: telefono };

  try {
    const config = await getConfigTenant(adminId);
    if (!config.activo) {
      // Módulo no activo para este tenant: salida silenciosa (no es error)
      return { ok: false, error: 'modulo_inactivo' };
    }
    if (!config.phoneNumberId || !config.token) {
      await logMensaje({ ...base, estado: 'fallido', error: 'config_incompleta' });
      return { ok: false, error: 'config_incompleta' };
    }

    const to = normalizarTelefono(telefono);
    if (!to) {
      await logMensaje({ ...base, estado: 'fallido', error: 'telefono_invalido' });
      return { ok: false, error: 'telefono_invalido' };
    }

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: plantilla,
        language: { code: idioma },
        components: variables.length
          ? [{
              type: 'body',
              parameters: variables.map(v => ({ type: 'text', text: String(v ?? '') })),
            }]
          : [],
      },
    };

    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const data = await resp.json();

    if (resp.ok && data.messages && data.messages[0]) {
      const messageId = data.messages[0].id;
      await logMensaje({ ...base, telefono: to, estado: 'enviado', messageId });
      return { ok: true, messageId };
    }

    const errorMeta = data.error ? `${data.error.code}: ${data.error.message}` : 'respuesta_desconocida';
    await logMensaje({ ...base, telefono: to, estado: 'fallido', error: errorMeta });
    console.error('[WA] Meta rechazó envío:', errorMeta);
    return { ok: false, error: errorMeta };

  } catch (err) {
    await logMensaje({ ...base, estado: 'fallido', error: err.message });
    console.error('[WA] Error de red enviando plantilla:', err.message);
    return { ok: false, error: err.message };
  }
}

// ------------------------------------------------------------
// HOOK para el flujo de órdenes (se conectará en orders.js /
// logistics.js en la siguiente iteración). Fire-and-forget:
// se llama SIN await para no demorar la respuesta al usuario.
// ------------------------------------------------------------
function notificarCambioEstado(adminId, orden, nuevoEstado) {
  const plantilla = ESTADO_PLANTILLA[nuevoEstado];
  if (!plantilla) return; // estado sin notificación: salir en silencio

  const telefono = orden?.cliente?.telefono || orden?.telefonoCliente;
  if (!telefono) return;

  const variables = construirVariables(plantilla, orden);

  enviarPlantilla({
    adminId,
    telefono,
    plantilla,
    variables,
    ordenId: orden.id || null,
    contexto: `estado:${nuevoEstado}`,
  }).catch(() => {}); // doble blindaje: jamás afecta el flujo principal
}

// ------------------------------------------------------------
// Variables por plantilla (deben coincidir con los {{n}} de Meta)
// ------------------------------------------------------------
function construirVariables(plantilla, orden) {
  const nombre   = orden?.cliente?.nombre || orden?.nombreCliente || 'Cliente';
  const numeroOS = orden?.numero || orden?.numeroOrden || '';
  const servicio = orden?.tipoServicio || orden?.descripcionServicio || 'Servicio';
  const total    = orden?.total != null ? `$${Number(orden.total).toLocaleString('es-CO')}` : '';
  const mensajero = orden?.mensajeroNombre || orden?.mensajero || 'nuestro mensajero';

  switch (plantilla) {
    case 'os_creada':
      return [nombre, numeroOS, servicio, total];
    case 'mensajero_camino_recogida':
      return [nombre, mensajero, numeroOS];
    case 'mensajero_camino_entrega':
      return [nombre, mensajero, numeroOS];
    case 'novedad_taller':
      // [nombre, idExtintor, falla, costo, nuevoTotal] — la arma el módulo Taller
      return [nombre];
    default:
      return [];
  }
}

module.exports = {
  enviarPlantilla,
  notificarCambioEstado,
  normalizarTelefono,
  getConfigTenant,
  ESTADO_PLANTILLA,
};
