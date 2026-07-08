// ============================================================
// Control360 — Servicio WhatsApp IA Anny
// Ubicación: backend/services/annyService.js
// ============================================================
// PRINCIPIOS:
// 1. Procesa mensajes entrantes de WhatsApp (vía Baileys)
// 2. Consulta respuestas pre-configuradas
// 3. Usa Claude API para decisiones inteligentes
// 4. Registra conversaciones para aprendizaje
// 5. Escala casos complejos a admin
// 6. NUNCA bloquea el flujo principal (fire-and-forget)
// ============================================================

const { db, admin } = require('../config/firebase');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

// ============================================================
// Inicializar respuestas pre-configuradas (6 base)
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
// FIX ANNY-GATE-001: igual patrón que Lucy (llamadasIAService.js).
// El módulo 'anny_ia' SOLO se activa si el SuperAdmin lo agrega
// explícitamente al array `modulos` del documento del admin en
// la colección `users` (Panel Suscriptores → botón "Módulos").
// La convención modulos===[] ("ve todo") NO aplica a módulos
// premium — deben estar EXPLÍCITAMENTE en el array.
// Esto es la ÚNICA fuente de verdad de si Anny está activo.
// El suscriptor NUNCA puede activarlo por su cuenta.
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
// Buscar respuesta pre-configurada
// ============================================================
function buscarRespuestaConfigura(mensajeTexto) {
  const texto = mensajeTexto.toLowerCase();

  for (const [key, config] of Object.entries(RESPUESTAS_BASE)) {
    if (config.patrones.some(p => texto.includes(p))) {
      return {
        encontrada: true,
        respuesta: config.respuesta,
        tipo: config.tipo,
        key
      };
    }
  }

  return { encontrada: false };
}

// ============================================================
// Consultar Claude para decisiones inteligentes
// Retorna: { escalado, tipo, respuesta?, razon? }
// ============================================================
async function claudeDecide(adminId, clienteNombre, mensajeTexto, contexto = {}) {
  try {
    const prompt = `
Eres un asistente comercial para Extintores del Valle SAS (empresa de recarga y venta de extintores en Cali, Colombia).

Un cliente escribió: "${mensajeTexto}"

Contexto:
- Cliente: ${clienteNombre}
- Empresa de extintores (recargas, venta, certificación)
- Ubicada en Cali, domicilio en zona local

DECIDE:
1. ¿Esta pregunta REQUIERE intervención del admin (Milena)?
2. O ¿PUEDO responder automáticamente?

ESCALABLE A ADMIN si:
- Solicita descuento/promoción especial
- Pide cambio de fecha/horario
- Pregunta por producto NO en catálogo
- Requiere capacitación
- Tiene queja/problema
- Pregunta sobre facturación legal/documentos

RESPONDER AUTOMATICAMENTE si:
- Es pregunta simple (precio, horario, domicilio)
- Es solicitud de datos para cotización
- Es pregunta sobre ubicación

Responde SOLO en JSON (sin markdown):
{
  "escalado": boolean,
  "tipo": "PRECIO|SERVICIO|DATOS|NEGOCIACION|CAPACITACION|PROBLEMA|OTRO",
  "respuesta": "tu respuesta si NO escalado",
  "razon": "por qué escalas (si escalado)"
}
    `;

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
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
      respuesta: 'Gracias por tu mensaje. Milena te responderá pronto.',
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
    // FIX ANNY-GATE-001: el gate es el array `modulos` (control exclusivo
    // de Milena vía Panel Suscriptores), no un campo que el suscriptor
    // pudiera tocar desde su propia config.
    const activo = await tenantTieneAnnyActiva(adminId);
    if (!activo) {
      return { procesado: false, error: 'anny_inactivo' };
    }

    // PASO 2: Buscar respuesta pre-configurada
    const respuestaConfig = buscarRespuestaConfigura(mensajeTexto);

    if (respuestaConfig.encontrada) {
      // RESPONDER AUTOMÁTICO
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

    // PASO 3: Consultar Claude para decidir
    const decision = await claudeDecide(adminId, nombreCliente, mensajeTexto);

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
        respuestaAgente: '⚠️ Perfecto, Milena te contactará en breve ✓',
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
        respuesta: '⚠️ Perfecto, Milena te contactará en breve ✓',
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
// FIX ANNY-GATE-001: `activo` SIEMPRE viene del array `modulos`
// (fuente única de verdad, igual que Lucy). El documento annyConfig
// solo guarda datos operativos (número, horario, estado de conexión
// de Baileys) — nunca decide si el módulo está prendido o apagado.
// ============================================================
async function obtenerConfig(adminId) {
  try {
    const activo = await tenantTieneAnnyActiva(adminId);
    const doc = await db.collection('annyConfig').doc(adminId).get();
    const operativo = doc.exists ? doc.data() : {};

    // Nunca devolver campos internos de Baileys (qrCode) en bruto aquí;
    // el endpoint dedicado /qr/:adminId es quien lo expone como imagen.
    const { qrCode, ...resto } = operativo;

    return {
      ...resto,
      activo, // <- siempre pisa cualquier valor viejo que pudiera existir en el doc
    };
  } catch (err) {
    console.error('[ANNY] Error leyendo config:', err.message);
    return { error: err.message, activo: false };
  }
}

// ============================================================
// Crear/actualizar configuración OPERATIVA (número, horario, etc.)
// FIX ANNY-GATE-001: se descarta explícitamente cualquier intento
// de mandar `activo` desde este endpoint — ese campo solo lo cambia
// Milena desde Panel Suscriptores → Módulos (array `modulos` en
// la colección `users`), nunca el propio suscriptor.
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
  RESPUESTAS_BASE
};
