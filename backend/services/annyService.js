// ============================================================
// Control360 — Servicio WhatsApp IA Anny
// Ubicación: backend/services/annyService.js
// FIX ANNY-BOOT-001 + ANNY-LEARN-002 + ANNY-CTX-001 + ANNY-PEDIDOS-001
// + FIX ANNY-CFG-002 (guardado de config con undefined)
// ============================================================
// PRINCIPIOS:
// 1. Procesa mensajes entrantes de WhatsApp (vía Baileys)
// 2. Consulta respuestas configuradas POR EMPRESA (Firestore)
// 3. Usa Claude API con conocimiento del tenant + memoria del hilo
// 4. VENDEDORA: nunca suelta al cliente, pide datos, cierra ventas
// 5. Pedidos confirmados → bandeja pedidosAnny + aviso a la admin
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
    respuesta: 'Perfecto, envíame estos datos:\n✅ Nombre:\n✅ Cédula o NIT:\n✅ Correo:\n✅ Dirección y barrio:\n✅ Celular:',
    tipo: 'SOLICITUD_DATOS'
  },
  'ubicacion': {
    patrones: ['donde estan', 'direccion', 'como llego', 'ubicacion'],
    respuesta: 'Estamos en: Cl. 22 Nte. #5bn28, San Vicente, Cali, Valle del Cauca\nMaps: https://maps.google.com/maps/search/extintores+del+valle+sas',
    tipo: 'INFO'
  }
};

// ============================================================
// FIX ANNY-LEARN-002: respuestas por tenant con caché
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
// FIX ANNY-CTX-001: historial reciente (memoria del hilo)
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
// Consultar Claude — vendedora con memoria, conocimiento y cierre
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
Eres Anny, VENDEDORA por WhatsApp de una empresa de venta, recarga y mantenimiento de extintores y seguridad industrial en Colombia. Tu meta es CERRAR VENTAS sin dejar perder ningún cliente.

HISTORIAL RECIENTE DE LA CONVERSACIÓN (viejo → nuevo):
${hilo || '(primera interacción con este cliente)'}

NUEVO MENSAJE del cliente ${clienteNombre}: "${mensajeTexto}"

BASE DE CONOCIMIENTO DE LA EMPRESA (única fuente válida de precios y datos):
${conocimiento || '(sin datos configurados)'}

REGLAS DE VENTA (críticas):
- NUNCA dejes al cliente sin siguiente paso: cada respuesta tuya termina con una pregunta o acción concreta que avance hacia el cierre.
- Si el cliente muestra interés (necesita recarga, pide precio, pregunta por producto), tu misión es capturar sus datos y cerrar — no le mandes información y lo abandones.
- Pide los datos que falten de a UNO o DOS por mensaje (no bombardees con formularios).
- CONTINÚA el hilo: interpreta respuestas cortas según el contexto. NO saludes de nuevo en conversación en curso.
- Sé breve, cálida y natural (español colombiano, tono WhatsApp).

DATOS OBLIGATORIOS antes de confirmar un pedido:
1. Nombre completo
2. Cédula (o si es empresa: razón social y NIT)
3. Correo electrónico (para enviar la factura)
4. Dirección completa con barrio
5. Teléfono de contacto
6. Fecha/franja preferida
NO confirmes ningún pedido si falta alguno — pídelo primero.

DECIDE si respondes automáticamente o escalas:

ESCALAR A ADMIN si:
- Solicita descuento/promoción especial
- Pide cambio de fecha/horario de un servicio ya agendado
- Pregunta por precio o producto que NO está en la base de conocimiento
- Requiere capacitación
- Tiene queja/problema
- Pregunta sobre facturación legal/documentos

REGLA CRÍTICA: NUNCA inventes precios, direcciones ni datos que no estén en la base de conocimiento. Si el dato no está, escala.

PEDIDO CONFIRMADO: cuando el cliente haya confirmado la compra Y tengas TODOS los datos obligatorios, incluye el objeto "pedido" en tu respuesta JSON. Si aún falta algún dato o falta confirmación, "pedido" debe ser null.

Responde SOLO en JSON (sin markdown):
{
  "escalado": boolean,
  "tipo": "PRECIO|SERVICIO|DATOS|NEGOCIACION|CAPACITACION|PROBLEMA|VENTA|OTRO",
  "respuesta": "tu respuesta si NO escalado",
  "razon": "por qué escalas (si escalado)",
  "pedido": null | {
    "producto": "descripción del producto/servicio",
    "cantidad": número,
    "total": "valor total con domicilio si aplica",
    "nombreCliente": "nombre completo",
    "cedulaNit": "cédula o NIT",
    "correo": "email",
    "direccion": "dirección completa",
    "barrio": "barrio",
    "telefonoContacto": "teléfono",
    "fecha": "fecha/franja acordada"
  }
}
    `;

    const message = await getClaudeClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
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
      razon: 'error_claude',
      pedido: null
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
// FIX ANNY-PEDIDOS-001: registrar pedido confirmado en la bandeja
// ============================================================
async function registrarPedido(adminId, telefono, pedido) {
  try {
    const ref = await db.collection('pedidosAnny')
      .doc(adminId)
      .collection('pedidos')
      .add({
        ...pedido,
        telefono,
        estado: 'NUEVO', // NUEVO → ORDEN_CREADA
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    return ref.id;
  } catch (err) {
    console.error('[ANNY] Error registrando pedido:', err.message);
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
// ============================================================
async function procesarMensajeEntrante(props) {
  const { adminId, telefono, nombreCliente, mensajeTexto } = props;

  if (!adminId || !telefono || !mensajeTexto) {
    console.warn('[ANNY] Datos incompletos:', { adminId, telefono, mensajeTexto });
    return { procesado: false, error: 'datos_incompletos' };
  }

  try {
    // PASO 1: gate del módulo
    const activo = await tenantTieneAnnyActiva(adminId);
    if (!activo) {
      return { procesado: false, error: 'anny_inactivo' };
    }

    // PASO 2: respuestas del tenant + historial del cliente
    const [respuestas, historial] = await Promise.all([
      obtenerRespuestasTenant(adminId),
      obtenerHistorialReciente(adminId, telefono)
    ]);

    // FIX ANNY-CTX-001: en hilo activo (<10 min) decide la IA con memoria
    const ultimoTs = historial.length ? historial[historial.length - 1].ts : 0;
    const conversacionActiva = ultimoTs > 0 && (Date.now() - ultimoTs) < 10 * 60 * 1000;

    if (!conversacionActiva) {
      const respuestaConfig = buscarRespuestaConfigura(mensajeTexto, respuestas);

      if (respuestaConfig.encontrada) {
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

    // PASO 3: Claude decide (conocimiento + memoria + reglas de venta)
    const decision = await claudeDecide(adminId, nombreCliente, mensajeTexto, respuestas, historial);

    if (decision.escalado) {
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

    // FIX ANNY-PEDIDOS-001: pedido confirmado → bandeja + aviso a la admin
    let notificarA = null;
    if (decision.pedido && typeof decision.pedido === 'object') {
      await registrarPedido(adminId, telefono, decision.pedido);
      await actualizarMetricas(adminId, 'pedidos');

      try {
        const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
        notificarA = cfgDoc.exists ? (cfgDoc.data().notificarPedidosA || null) : null;
      } catch (e) {
        notificarA = null;
      }
    }

    return {
      procesado: true,
      tipo: decision.pedido ? 'PEDIDO_CONFIRMADO' : 'RESPUESTA_IA',
      accion: 'enviar_mensaje',
      respuesta: decision.respuesta,
      pedido: decision.pedido || null,
      notificarA,
      telefonoCliente: telefono
    };

  } catch (err) {
    console.error('[ANNY] Error procesando mensaje:', err.message);
    return { procesado: false, error: err.message };
  }
}

// ============================================================
// FIX ANNY-GATE-001: gate del módulo 'anny_ia'
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
        pedidos: 0,
        total: 0
      };
    }

    const data = doc.data();
    return {
      respuestas_automaticas: data.respuestas_automaticas || 0,
      respuestas_ia: data.respuestas_ia || 0,
      casos_escalados: data.casos_escalados || 0,
      pedidos: data.pedidos || 0,
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
// FIX ANNY-CFG-002: Firestore rechaza `undefined` como valor. El
// panel ya no envía whatsappNumber (lo escribe Baileys al conectar)
// y llegaba undefined — TODO el guardado de configuración fallaba.
// Se eliminan las claves undefined antes de escribir; con merge,
// cada quien guarda solo lo que envía sin pisar lo demás.
// ============================================================
async function actualizarConfig(adminId, datos) {
  try {
    const { activo, ...datosPermitidos } = datos; // activo se ignora siempre
    const datosLimpios = Object.fromEntries(
      Object.entries(datosPermitidos).filter(([, v]) => v !== undefined)
    );
    await db.collection('annyConfig').doc(adminId).set(datosLimpios, { merge: true });
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
  registrarPedido,
  tenantTieneAnnyActiva,
  obtenerRespuestasTenant,
  obtenerHistorialReciente,
  invalidarCacheRespuestas,
  RESPUESTAS_BASE
};
// FIN annyService.js
