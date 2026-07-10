// ============================================================
// Control360 — Servicio WhatsApp IA Anny
// Ubicación: backend/services/annyService.js
// FIX ANNY-BOOT-001 + FIX ANNY-LEARN-002 + FIX ANNY-CTX-001
// ============================================================
// PRINCIPIOS:
// 1. Procesa mensajes entrantes de WhatsApp (vía Baileys)
// 2. Consulta respuestas configuradas POR EMPRESA (Firestore)
// 3. Usa Claude API con la base de conocimiento del tenant
//    Y el historial reciente de la conversación (memoria)
// 4. Registra conversaciones para aprendizaje
// 5. Escala casos complejos a admin
// 6. NUNCA bloquea el flujo principal (fire-and-forget)
// ============================================================

const { db, admin } = require('../config/firebase');
const Anthropic = require('@anthropic-ai/sdk');

// ============================================================
// FIX ANNY-BOOT-001: cliente Anthropic perezoso
// ============================================================
let _client = null;
function getClaudeClient() {
  if (!_client) {
    _client = new Anthropic(); // lee ANTHROPIC_API_KEY del entorno
  }
  return _client;
}

// ============================================================
// Respuestas base (semilla para tenants sin configuración propia)
// ============================================================
const RESPUESTAS_BASE = {
  'precio_abc_5lb': {
    patrones: ['precio', 'cuanto cuesta', 'abc 5', 'recarga 5'],
    respuesta: 'Recarga ABC 5 lb: $19.000',
    tipo: 'PRECIO'
  },
  'precio_abc_10lb': {
    patrones: ['precio abc 10', 'recarga 10 libras', 'abc 10'],
    respuesta: 'Recarga ABC 10 lb: $25.000',
    tipo: 'PRECIO'
  },
  'domicilio': {
    patrones: ['domicilio', 'envio', 'hacen entrega', 'costo envio'],
    respuesta: 'Sí, hacemos domicilio. Cali: $8.000. Otros sectores: se valida con logística. ¿A qué sector?',
    tipo: 'SERVICIO'
  },
  'horario': {
    patrones: ['horario', 'cuando abren', 'que horas', 'estan abiertos'],
    respuesta: 'Martes-Viernes: 8am-5pm\nSábado: 8am-12pm\nDomingo-Lunes: Cerrado',
    tipo: 'INFO'
  },
  'datos_cotizacion': {
    patrones: ['cotizacion', 'presupuesto', 'cuanto me cuesta', 'cotizar'],
    respuesta: 'Perfecto, envíame estos datos:\n✅ Nombre:\n✅ Empresa:\n✅ NIT:\n✅ Dirección:\n✅ Barrio:\n✅ Celular:',
    tipo: 'SOLICITUD_DATOS'
  },
  'ubicacion': {
    patrones: ['donde estan', 'direccion', 'como llego', 'ubicacion'],
    respuesta: 'Estamos en: Cl. 22 Nte. #5bn28, San Vicente, Cali, Valle del Cauca\nMaps: https://maps.google.com/maps/search/extintores+del+valle+sas',
    tipo: 'INFO'
  }
};

// ============================================================
// FIX ANNY-LEARN-002: respuestas configuradas POR TENANT con caché
// ============================================================
const _cacheRespuestas = new Map(); // adminId -> { data, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;

async function obtenerRespuestasTenant(adminId) {
  const cached = _cacheRespuestas.get(adminId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const doc = await db.collection('respuestasAnny').doc(adminId).get();
    const data = doc.exists ? doc.data() : RESPUESTAS_BASE;
    _cacheRespuestas.set(adminId, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error('[ANNY] Error leyendo respuestas del tenant:', err.message);
    return RESPUESTAS_BASE;
  }
}

function invalidarCacheRespuestas(adminId) {
  _cacheRespuestas.delete(adminId);
}

// ============================================================
// Buscar respuesta configurada del tenant
// ============================================================
function buscarRespuestaConfigura(mensajeTexto, respuestas) {
  const texto = mensajeTexto.toLowerCase();

  for (const [key, config] of Object.entries(respuestas || {})) {
    if (!config || !Array.isArray(config.patrones)) continue;
    if (config.patrones.some(p => p && texto.includes(String(p).toLowerCase()))) {
      return {
        encontrada: true,
        respuesta: config.respuesta,
        tipo: config.tipo || 'CUSTOM',
        key
      };
    }
  }

  return { encontrada: false };
}

// ============================================================
// FIX ANNY-CTX-001: historial reciente de un teléfono (memoria).
// Query solo con igualdad (sin índice compuesto); orden en memoria.
// Devuelve turnos cronológicos: [{rol, texto, ts}]
// ============================================================
async function obtenerHistorialReciente(adminId, telefono, limite = 8) {
  try {
    const snap = await db.collection('conversacionesAnny')
      .doc(adminId)
      .collection('conversaciones')
      .where('telefono', '==', telefono)
      .limit(40)
      .get();

    const docs = snap.docs
      .map(d => d.data())
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      .slice(0, limite)
      .reverse(); // cronológico: viejo → nuevo

    const turnos = [];
    for (const c of docs) {
      const ts = (c.createdAt?.seconds || 0) * 1000;
      if (c.mensajeCliente) turnos.push({ rol: 'cliente', texto: c.mensajeCliente, ts });
      if (c.respuestaAgente) {
        turnos.push({
          rol: c.respondidoPor === 'ADMIN_MANUAL' ? 'admin' : 'anny',
          texto: c.respuestaAgente,
          ts
        });
      }
    }
    return turnos;
  } catch (err) {
    console.error('[ANNY] Error leyendo historial:', err.message);
    return [];
  }
}

// ============================================================
// Consultar Claude para decisiones inteligentes
// FIX ANNY-LEARN-002: con base de conocimiento del tenant
// FIX ANNY-CTX-001: con historial de la conversación (memoria)
// ============================================================
async function claudeDecide(adminId, clienteNombre, mensajeTexto, respuestas = {}, historial = []) {
  try {
    const conocimiento = Object.entries(respuestas || {})
      .filter(([, c]) => c && c.respuesta)
      .map(([key, c]) => `- [${key}] ${(c.patrones || []).join(', ')}: ${c.respuesta}`)
      .join('\n');

    const hilo = (historial || [])
      .map(t => {
        const quien = t.rol === 'cliente' ? 'Cliente' : (t.rol === 'admin' ? 'Asesora (humana)' : 'Anny (tú)');
        return `${quien}: ${t.texto}`;
      })
      .join('\n');

    const prompt = `
Eres Anny, asistente comercial por WhatsApp de una empresa de venta, recarga y mantenimiento de extintores y seguridad industrial en Colombia.

HISTORIAL RECIENTE DE LA CONVERSACIÓN (viejo → nuevo):
${hilo || '(primera interacción con este cliente)'}

NUEVO MENSAJE del cliente ${clienteNombre}: "${mensajeTexto}"

BASE DE CONOCIMIENTO DE LA EMPRESA (única fuente válida de precios y datos):
${conocimiento || '(sin datos configurados)'}

REGLAS DE CONVERSACIÓN:
- CONTINÚA el hilo: si el historial muestra que le preguntaste algo (ej: "¿a qué sector?"), interpreta la respuesta corta del cliente en ese contexto.
- NO saludes de nuevo si la conversación ya está en curso.
- Sé breve, cálida y natural (español colombiano, tono WhatsApp).

DECIDE:
1. ¿Esta pregunta REQUIERE intervención del admin?
2. O ¿PUEDO responder automáticamente?

RESPONDER AUTOMATICAMENTE si:
- La respuesta está en la BASE DE CONOCIMIENTO (usa los datos EXACTOS)
- Es continuación natural del hilo (confirmar sector, capacidad del extintor, agendar recogida con los datos de la base)
- Es solicitud de datos para cotización

ESCALAR A ADMIN si:
- Solicita descuento/promoción especial
- Pide cambio de fecha/horario de un servicio ya agendado
- Pregunta por precio o producto que NO está en la base de conocimiento
- Requiere capacitación
- Tiene queja/problema
- Pregunta sobre facturación legal/documentos

REGLA CRÍTICA: NUNCA inventes precios, direcciones ni datos que no estén en la base de conocimiento. Si el dato no está, escala.

Responde SOLO en JSON (sin markdown):
{
  "escalado": boolean,
  "tipo": "PRECIO|SERVICIO|DATOS|NEGOCIACION|CAPACITACION|PROBLEMA|OTRO",
  "respuesta": "tu respuesta si NO escalado",
  "razon": "por qué escalas (si escalado)"
}
    `;

    const message = await getClaudeClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const respuestaTexto = message.content[0].text;

    // Limpiar markdown si viene envuelto
    let jsonLimpio = respuestaTexto.replace(/```json|```/g, '').trim();

    const decision = JSON.parse(jsonLimpio);
    return decision;

  } catch (err) {
    console.error('[ANNY] Error en Claude:', err.message);
    // Fallback seguro: no escalamos si falla Claude
    return {
      escalado: false,
      tipo: 'ERROR',
      respuesta: 'Gracias por tu mensaje. Te responderemos pronto.',
      razon: 'error_claude'
    };
  }
}

// ============================================================
// Registrar conversación en Firestore
// ============================================================
async function registrarConversacion(adminId, data) {
  try {
    await db.collection('conversacionesAnny')
      .doc(adminId)
      .collection('conversaciones')
      .add({
        ...data,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
  } catch (err) {
    console.error('[ANNY] Error registrando conversación:', err.message);
  }
}

// ============================================================
// Registrar caso escalado
// ============================================================
async function registrarCasoEscalado(adminId, data) {
  try {
    const caseId = await db.collection('casosEscaladosAnny')
      .doc(adminId)
      .collection('casos')
      .add({
        ...data,
        estado: 'PENDIENTE',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    return caseId.id;
  } catch (err) {
    console.error('[ANNY] Error registrando caso escalado:', err.message);
    return null;
  }
}

// ============================================================
// Actualizar métricas del día
// ============================================================
async function actualizarMetricas(adminId, tipo) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const docRef = db.collection('metricsAnny').doc(`${adminId}_${hoy}`);

    await docRef.set({
      adminId,
      fecha: hoy,
      [tipo]: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error('[ANNY] Error actualizando métricas:', err.message);
  }
}

// ============================================================
// FUNCIÓN PRINCIPAL: Procesar mensaje entrante
// Retorna { procesado, tipo, accion } — NUNCA lanza excepción
// ============================================================
async function procesarMensajeEntrante(props) {
  const { adminId, telefono, nombreCliente, mensajeTexto } = props;

  // Guard: validaciones básicas
  if (!adminId || !telefono || !mensajeTexto) {
    console.warn('[ANNY] Datos incompletos:', { adminId, telefono, mensajeTexto });
    return { procesado: false, error: 'datos_incompletos' };
  }

  try {
    // PASO 1: Verificar que Anny está activo para este admin
    const activo = await tenantTieneAnnyActiva(adminId);
    if (!activo) {
      return { procesado: false, error: 'anny_inactivo' };
    }

    // PASO 2: Cargar respuestas del tenant + historial del cliente
    const [respuestas, historial] = await Promise.all([
      obtenerRespuestasTenant(adminId),
      obtenerHistorialReciente(adminId, telefono)
    ]);

    // FIX ANNY-CTX-001: si la conversación está ACTIVA (último turno
    // hace <10 min), NO usar atajos de patrones — un "si necesito
    // domicilio" en medio de un hilo no debe disparar la respuesta
    // genérica de domicilio. En hilo activo decide la IA con memoria.
    const ultimoTs = historial.length ? historial[historial.length - 1].ts : 0;
    const conversacionActiva = ultimoTs > 0 && (Date.now() - ultimoTs) < 10 * 60 * 1000;

    if (!conversacionActiva) {
      const respuestaConfig = buscarRespuestaConfigura(mensajeTexto, respuestas);

      if (respuestaConfig.encontrada) {
        // RESPONDER AUTOMÁTICO (primer contacto / conversación fría)
        await registrarConversacion(adminId, {
          telefono,
          nombreCliente,
          mensajeCliente: mensajeTexto,
          respuestaAgente: respuestaConfig.respuesta,
          respondidoPor: 'AGENTE_AUTOMATICO',
          tipo: respuestaConfig.tipo,
          escalado: false,
          caseId: null
        });

        await actualizarMetricas(adminId, 'respuestas_automaticas');

        return {
          procesado: true,
          tipo: 'RESPUESTA_AUTOMATICA',
          accion: 'enviar_mensaje',
          respuesta: respuestaConfig.respuesta
        };
      }
    }

    // PASO 3: Claude decide, con conocimiento del tenant + memoria
    const decision = await claudeDecide(adminId, nombreCliente, mensajeTexto, respuestas, historial);

    if (decision.escalado) {
      // ESCALAR A ADMIN
      const caseId = await registrarCasoEscalado(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        tipo: decision.tipo,
        razon: decision.razon,
        asignadoA: adminId
      });

      await registrarConversacion(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        respuestaAgente: '⚠️ Perfecto, en breve te contactamos personalmente ✓',
        respondidoPor: 'ESCALADO_A_ADMIN',
        tipo: decision.tipo,
        escalado: true,
        caseId
      });

      await actualizarMetricas(adminId, 'casos_escalados');

      return {
        procesado: true,
        tipo: 'CASO_ESCALADO',
        accion: 'enviar_mensaje',
        respuesta: '⚠️ Perfecto, en breve te contactamos personalmente ✓',
        caseId
      };
    }

    // RESPONDER CON CLAUDE
    await registrarConversacion(adminId, {
      telefono,
      nombreCliente,
      mensajeCliente: mensajeTexto,
      respuestaAgente: decision.respuesta,
      respondidoPor: 'AGENTE_IA',
      tipo: decision.tipo,
      escalado: false,
      confianza: decision.confianza || 0.85
    });

    await actualizarMetricas(adminId, 'respuestas_ia');

    return {
      procesado: true,
      tipo: 'RESPUESTA_IA',
      accion: 'enviar_mensaje',
      respuesta: decision.respuesta
    };

  } catch (err) {
    console.error('[ANNY] Error procesando mensaje:', err.message);
    return { procesado: false, error: err.message };
  }
}

// ============================================================
// FIX ANNY-GATE-001: gate del módulo — única fuente de verdad es
// el array `modulos` del admin (solo lo edita el SuperAdmin).
// ============================================================
async function tenantTieneAnnyActiva(adminId) {
  try {
    const userDoc = await db.collection('users').doc(adminId).get();
    if (!userDoc.exists) return false;
    const modulos = userDoc.data().modulos || [];
    return modulos.includes('anny_ia');
  } catch (err) {
    console.error('[ANNY] Error verificando módulo anny_ia:', err.message);
    return false;
  }
}

// ============================================================
// Obtener métricas del día
// ============================================================
async function obtenerMetricasHoy(adminId) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const doc = await db.collection('metricsAnny').doc(`${adminId}_${hoy}`).get();

    if (!doc.exists) {
      return {
        respuestas_automaticas: 0,
        respuestas_ia: 0,
        casos_escalados: 0,
        total: 0
      };
    }

    const data = doc.data();
    return {
      respuestas_automaticas: data.respuestas_automaticas || 0,
      respuestas_ia: data.respuestas_ia || 0,
      casos_escalados: data.casos_escalados || 0,
      total: (data.respuestas_automaticas || 0) + (data.respuestas_ia || 0) + (data.casos_escalados || 0)
    };
  } catch (err) {
    console.error('[ANNY] Error leyendo métricas:', err.message);
    return { error: err.message };
  }
}

// ============================================================
// Obtener configuración de Anny para admin
// ============================================================
async function obtenerConfig(adminId) {
  try {
    const activo = await tenantTieneAnnyActiva(adminId);
    const doc = await db.collection('annyConfig').doc(adminId).get();
    const operativo = doc.exists ? doc.data() : {};

    const { qrCode, ...resto } = operativo;

    return {
      ...resto,
      activo,
    };
  } catch (err) {
    console.error('[ANNY] Error leyendo config:', err.message);
    return { error: err.message, activo: false };
  }
}

// ============================================================
// Crear/actualizar configuración OPERATIVA
// ============================================================
async function actualizarConfig(adminId, datos) {
  try {
    const { activo, ...datosPermitidos } = datos; // activo se ignora siempre
    await db.collection('annyConfig').doc(adminId).set(datosPermitidos, { merge: true });
    return { ok: true };
  } catch (err) {
    console.error('[ANNY] Error actualizando config:', err.message);
    return { error: err.message };
  }
}

module.exports = {
  procesarMensajeEntrante,
  obtenerMetricasHoy,
  obtenerConfig,
  actualizarConfig,
  registrarConversacion,
  registrarCasoEscalado,
  tenantTieneAnnyActiva,
  obtenerRespuestasTenant,
  obtenerHistorialReciente,
  invalidarCacheRespuestas,
  RESPUESTAS_BASE
};
// FIN annyService.js
