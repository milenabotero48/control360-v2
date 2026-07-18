// ============================================================
// Control360 — Servicio WhatsApp IA Anny
// Ubicación: backend/services/annyService.js
// ============================================================
// PRINCIPIOS:
// 1. Procesa mensajes entrantes de WhatsApp (vía Baileys)
// 2. Consulta respuestas pre-configuradas (solo conversación fría)
// 3. Usa Claude API para decisiones inteligentes con memoria
// 4. Registra conversaciones para aprendizaje
// 5. Pedidos confirmados → bandeja pedidosAnny + aviso a la admin
// 6. NUNCA bloquea el flujo principal (fire-and-forget)
//
// FIXES DE ESTA VERSIÓN (Anny v2 — pulida, no reescrita):
// - FIX ANNY-PAUSA-004: pausa de 30 min cuando la admin escribe
//   manualmente en un chat (Baileys detecta y llama pausarAnny;
//   aquí se verifica la pausa antes de responder).
// - FIX ANNY-CLIENTE-005: lookup del cliente en la colección
//   `clients` del tenant (campo tenant: adminId) por teléfono
//   normalizado DUP-002 — Anny saluda por nombre, NO pide datos
//   que ya están en la ficha y pregunta la sede si hay varias.
// - FIX ANNY-PRECIOS-006: catálogo de precios en vivo desde
//   `products` del tenant. OJO: el campo tenant de products es
//   `creadoPor` (NO adminId) — verificado contra products.js.
// - FIX ANNY-CIERRE-007: prompt v2 — rol ventas + atención al
//   cliente, máx 1 re-pregunta por dato, mínimos reales para
//   confirmar pedido (producto+nombre+dirección), datos faltantes
//   → pedido igual se confirma con `datosPendientes` para que
//   tesorería los complete al facturar. Ventana de hilo activo
//   sube de 10 min a 24 h (el regex ya no rompe hilos).
// - FIX ANNY-DEDUP-008: anti-duplicado de pedidos — si ya existe
//   un pedido NUEVO del mismo teléfono en las últimas 24 h, se
//   ACTUALIZA ese pedido en vez de crear otro (caso Ricardo x3).
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
    console.error('[ANNY] Error leyendo respuestas tenant:', err.message);
    return RESPUESTAS_BASE;
  }
}

function invalidarCacheRespuestas(adminId) {
  _cacheRespuestas.delete(adminId);
}

// ============================================================
// Buscar respuesta pre-configurada (solo conversación fría)
// ============================================================
function buscarRespuestaConfigura(mensajeTexto, respuestas) {
  const texto = mensajeTexto.toLowerCase();

  for (const [key, config] of Object.entries(respuestas || {})) {
    if (!config || !config.respuesta || !Array.isArray(config.patrones)) continue;
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
// FIX ANNY-PAUSA-004: pausa por intervención humana
// ------------------------------------------------------------
// Cuando la admin escribe manualmente en un chat, Baileys llama
// pausarAnny(adminId, telefono, 30). Cada mensaje manual REFRESCA
// la pausa (30 min desde el último mensaje humano). Mientras la
// pausa esté vigente, Anny registra los mensajes del cliente en
// el historial (no pierde contexto) pero NO responde.
// Colección: annyPausas — doc id: `${adminId}_${telefono}`
// ============================================================
async function pausarAnny(adminId, telefono, minutos = 30, motivo = 'intervencion_manual') {
  try {
    const hasta = Date.now() + (Number(minutos) || 30) * 60 * 1000;
    await db.collection('annyPausas').doc(`${adminId}_${telefono}`).set({
      adminId,
      telefono,
      pausadoHasta: hasta,
      motivo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true, pausadoHasta: hasta };
  } catch (err) {
    console.error('[ANNY] Error pausando Anny:', err.message);
    return { ok: false };
  }
}

async function annyEstaPausada(adminId, telefono) {
  try {
    const doc = await db.collection('annyPausas').doc(`${adminId}_${telefono}`).get();
    if (!doc.exists) return false;
    const hasta = doc.data().pausadoHasta || 0;
    return Date.now() < hasta;
  } catch (err) {
    console.error('[ANNY] Error consultando pausa:', err.message);
    return false; // ante error, Anny sigue operando (fail-open)
  }
}

async function reactivarAnny(adminId, telefono) {
  try {
    await db.collection('annyPausas').doc(`${adminId}_${telefono}`).set({
      adminId,
      telefono,
      pausadoHasta: 0,
      motivo: 'reactivada_manual',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true };
  } catch (err) {
    console.error('[ANNY] Error reactivando Anny:', err.message);
    return { ok: false };
  }
}

// ============================================================
// FIX ANNY-CLIENTE-005: normalización DUP-002 + lookup en clients
// ------------------------------------------------------------
// Misma regla que vencimientos.js / comercial.js:
// - solo dígitos, quitar prefijo 57 (12 → 10 dígitos)
// - celular CO válido = 10 dígitos empezando en 3
// AISLAMIENTO: la búsqueda SIEMPRE filtra por adminId — cada
// suscriptor solo ve SUS clientes. Solo lectura (nunca escribe).
// ============================================================
function normalizarTelefonoAnny(telefono) {
  if (!telefono) return null;
  let t = String(telefono).replace(/[\s\-().+]/g, '').replace(/\D/g, '');
  if (t.length === 12 && t.startsWith('57')) t = t.slice(2);
  return t || null;
}

async function buscarClienteEnBD(adminId, telefonoRaw) {
  try {
    const tel = normalizarTelefonoAnny(telefonoRaw);
    if (!tel || !adminId) return { existe: false };

    // clients usa campo tenant `adminId` (verificado en clients.js)
    // Se busca primero por celular, luego por telefono (DUP-002:
    // ambos campos se guardan normalizados a 10 dígitos).
    let snap = await db.collection('clients')
      .where('adminId', '==', adminId)
      .where('celular', '==', tel)
      .limit(1)
      .get();

    if (snap.empty) {
      snap = await db.collection('clients')
        .where('adminId', '==', adminId)
        .where('telefono', '==', tel)
        .limit(1)
        .get();
    }

    if (snap.empty) return { existe: false };

    const doc = snap.docs[0];
    const c = doc.data();

    const sucursales = Array.isArray(c.sucursales)
      ? c.sucursales.map(s => ({
          nombre: s.nombre || s.descripcion || '',
          direccion: s.direccion || ''
        })).filter(s => s.nombre || s.direccion)
      : [];

    return {
      existe: true,
      id: doc.id,
      nombre: c.nombre || '',
      nit: c.nit || '',
      tipoDocumento: c.tipoDocumento || '',
      correo: c.emailLegal || '',
      direccion: c.direccionPrincipal || '',
      ciudad: c.ciudad || '',
      empresaNombre: c.empresaNombre || '',
      sucursales
    };
  } catch (err) {
    console.error('[ANNY] Error buscando cliente en BD:', err.message);
    return { existe: false };
  }
}

// ============================================================
// FIX ANNY-PRECIOS-006: catálogo de productos del tenant (caché)
// ------------------------------------------------------------
// ⚠️ OJO: products usa campo tenant `creadoPor` (NO adminId) —
// verificado contra products.js (router.get('/') línea ~203).
// Solo productos activos, solo nombre + precioVenta (nunca costo).
// Máx 80 ítems para no inflar el prompt. Caché 5 min.
// ============================================================
const _cacheCatalogo = new Map(); // adminId -> { data, ts }

async function obtenerCatalogoProductos(adminId) {
  const cached = _cacheCatalogo.get(adminId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const snap = await db.collection('products')
      .where('creadoPor', '==', adminId)
      .where('activo', '==', true)
      .limit(200)
      .get();

    const items = [];
    snap.forEach(d => {
      const p = d.data();
      const precio = Number(p.precioVenta) || 0;
      if (p.nombre && precio > 0) {
        items.push({ nombre: String(p.nombre).trim(), precio });
      }
    });

    // Orden alfabético y tope de 80 para el prompt
    items.sort((a, b) => a.nombre.localeCompare(b.nombre));
    const data = items.slice(0, 80);

    _cacheCatalogo.set(adminId, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error('[ANNY] Error leyendo catálogo de productos:', err.message);
    return [];
  }
}

function invalidarCacheCatalogo(adminId) {
  _cacheCatalogo.delete(adminId);
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
// FIX ANNY-CIERRE-007: Claude decide — asesora dual con memoria,
// ficha del cliente, catálogo vivo y cierre sin insistencia
// ============================================================
async function claudeDecide(adminId, clienteNombre, mensajeTexto, respuestas = {}, historial = [], fichaCliente = { existe: false }, catalogo = []) {
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

    const catalogoTxt = (catalogo || [])
      .map(p => `- ${p.nombre}: $${p.precio.toLocaleString('es-CO')}`)
      .join('\n');

    // FIX ANNY-CLIENTE-005: bloque de ficha — si el cliente existe,
    // Anny confirma en vez de preguntar.
    let fichaTxt = '(cliente NO registrado en el sistema — habrá que capturar sus datos)';
    if (fichaCliente && fichaCliente.existe) {
      const sedes = (fichaCliente.sucursales || []);
      fichaTxt =
        `CLIENTE YA REGISTRADO EN NUESTRO SISTEMA — usa estos datos, NO los vuelvas a pedir, solo confírmalos si hace falta:\n` +
        `- Nombre: ${fichaCliente.nombre || '(sin dato)'}\n` +
        `- ${fichaCliente.tipoDocumento || 'NIT'}: ${fichaCliente.nit || '(sin dato)'}\n` +
        `- Correo: ${fichaCliente.correo || '(sin dato)'}\n` +
        `- Dirección principal: ${fichaCliente.direccion || '(sin dato)'}${fichaCliente.ciudad ? ', ' + fichaCliente.ciudad : ''}\n` +
        (sedes.length > 1
          ? `- Tiene ${sedes.length} sedes registradas: ${sedes.map(s => `${s.nombre}${s.direccion ? ' (' + s.direccion + ')' : ''}`).join(' | ')}\n  → PREGUNTA a cuál sede se envía el servicio.`
          : (sedes.length === 1 ? `- Sede: ${sedes[0].nombre}${sedes[0].direccion ? ' (' + sedes[0].direccion + ')' : ''}` : ''));
    }

    const prompt = `
Eres Anny, asesora de VENTAS y ATENCIÓN AL CLIENTE por WhatsApp de una empresa de venta, recarga y mantenimiento de extintores y seguridad industrial en Colombia. Vendes bien, pero primero ATIENDES: resuelves lo que el cliente pregunta.

HISTORIAL RECIENTE DE LA CONVERSACIÓN (viejo → nuevo):
${hilo || '(primera interacción con este cliente)'}

NUEVO MENSAJE del cliente ${clienteNombre}: "${mensajeTexto}"

FICHA DEL CLIENTE:
${fichaTxt}

CATÁLOGO OFICIAL DE PRODUCTOS Y PRECIOS VIGENTES (única fuente válida de precios de productos):
${catalogoTxt || '(catálogo vacío — usa solo la base de conocimiento)'}

BASE DE CONOCIMIENTO DE LA EMPRESA (domicilio, horarios, medios de pago, políticas):
${conocimiento || '(sin datos configurados)'}

REGLAS DE ATENCIÓN (prioridad máxima):
- Responde PRIMERO lo que el cliente pregunta o necesita en su último mensaje (pago, entrega, ubicación, estado, queja). Solo después retoma la venta si aplica. Si el cliente cambió de tema, síguelo — NO insistas en vender.
- Si el cliente pregunta cómo pagar → dale los medios de pago de la base de conocimiento, confirma el valor y CIERRA. No ofrezcas más productos.
- Si ya hay un pedido confirmado en este hilo, NO inicies otro pedido: solo resuelve dudas de pago/entrega del pedido existente.
- NUNCA pidas un dato que ya aparezca en el historial o en la ficha del cliente. Si está en la ficha, confírmalo: "te lo enviamos a [dirección], ¿cierto?"
- Cada dato faltante se pide máximo UNA vez adicional en toda la conversación. Si el cliente no lo da, sigue adelante sin él.
- Pide datos de a UNO o DOS por mensaje, nunca formularios completos.
- CONTINÚA el hilo: interpreta respuestas cortas según el contexto. NO saludes de nuevo en conversación en curso.
- Sé breve, cálida y natural (español colombiano, tono WhatsApp).

CIERRE DE PEDIDO (regla anti-estancamiento):
- Mínimos REALES para confirmar un pedido: producto/servicio + nombre + dirección de entrega. El teléfono YA lo tienes (es este chat: ${clienteNombre}).
- Cédula/NIT, correo y fecha son deseables pero NO bloquean: si tras pedirlos una vez el cliente no los da, CONFIRMA el pedido igual y lista lo que faltó en "datosPendientes" — el equipo los confirmará antes de facturar.
- Es mejor un pedido confirmado con datos pendientes que una venta perdida por preguntar de más.

DECIDE si respondes automáticamente o escalas:

ESCALAR A ADMIN si:
- Solicita descuento/promoción especial
- Pide cambio de fecha/horario de un servicio ya agendado
- Pregunta por precio o producto que NO está en el catálogo ni en la base de conocimiento
- Requiere capacitación
- Tiene queja/problema
- Pregunta sobre facturación legal/documentos

REGLA CRÍTICA: NUNCA inventes precios, direcciones ni datos. Precios de productos SOLO del catálogo; domicilio/horarios/pagos SOLO de la base de conocimiento. Si el dato no está, escala.

PEDIDO CONFIRMADO: cuando el cliente confirme la compra Y tengas los mínimos (producto + nombre + dirección), incluye el objeto "pedido". Datos deseables faltantes van en "datosPendientes". Si faltan los mínimos o falta confirmación del cliente, "pedido" debe ser null.

Responde SOLO en JSON (sin markdown):
{
  "escalado": boolean,
  "tipo": "PRECIO|SERVICIO|DATOS|PAGO|NEGOCIACION|CAPACITACION|PROBLEMA|VENTA|OTRO",
  "respuesta": "tu respuesta si NO escalado",
  "razon": "por qué escalas (si escalado)",
  "pedido": null | {
    "producto": "descripción del producto/servicio",
    "cantidad": número,
    "total": "valor total con domicilio si aplica",
    "nombreCliente": "nombre completo",
    "cedulaNit": "cédula o NIT (o 'PENDIENTE')",
    "correo": "email (o 'PENDIENTE')",
    "direccion": "dirección completa",
    "barrio": "barrio",
    "sucursal": "sede de entrega si el cliente tiene varias (o '')",
    "telefonoContacto": "teléfono",
    "fecha": "fecha/franja acordada (o 'PENDIENTE')",
    "datosPendientes": ["correo", "cedulaNit", "fecha"] 
  }
}
    `;

    const message = await getClaudeClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const respuestaTexto = message.content[0].text;

    // FIX ANNY-JSON-001: el modelo a veces agrega texto antes o
    // después del JSON ("Unexpected non-whitespace character after
    // JSON") → se extrae SOLO el bloque entre la primera '{' y la
    // última '}' antes de parsear. Sin esto, el parse fallaba y el
    // cliente recibía el mensaje genérico de fallback.
    let jsonLimpio = respuestaTexto.replace(/```json|```/g, '').trim();
    const ini = jsonLimpio.indexOf('{');
    const fin = jsonLimpio.lastIndexOf('}');
    if (ini !== -1 && fin > ini) {
      jsonLimpio = jsonLimpio.slice(ini, fin + 1);
    }

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
// FIX ANNY-PEDIDOS-001 + FIX ANNY-DEDUP-008: registrar pedido
// ------------------------------------------------------------
// Anti-duplicado: si ya existe un pedido en estado NUEVO del
// mismo teléfono en las últimas 24 h, se ACTUALIZA ese pedido
// (merge de los datos nuevos) en vez de crear otro. Evita el
// caso real de 3 pedidos idénticos por re-confirmaciones del
// cliente en el mismo hilo.
// Solo 2 filtros de igualdad (telefono + estado) → NO requiere
// índice compuesto; el filtro de 24 h se hace en memoria.
// ============================================================
async function registrarPedido(adminId, telefono, pedido) {
  try {
    const coleccion = db.collection('pedidosAnny')
      .doc(adminId)
      .collection('pedidos');

    // FIX ANNY-DEDUP-008: buscar pedido NUEVO reciente del mismo teléfono
    const snap = await coleccion
      .where('telefono', '==', telefono)
      .where('estado', '==', 'NUEVO')
      .limit(10)
      .get();

    const hace24h = Date.now() - 24 * 60 * 60 * 1000;
    const existente = snap.docs.find(d => {
      const ts = (d.data().createdAt?.seconds || 0) * 1000;
      return ts >= hace24h || ts === 0; // ts===0: recién creado, serverTimestamp aún no resuelto
    });

    if (existente) {
      // Actualizar el pedido existente con los datos más recientes
      const limpio = Object.fromEntries(
        Object.entries(pedido || {}).filter(([, v]) => v !== undefined)
      );
      await existente.ref.set({
        ...limpio,
        telefono,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { id: existente.id, esDuplicado: true };
    }

    const ref = await coleccion.add({
      ...pedido,
      telefono,
      estado: 'NUEVO', // NUEVO → ORDEN_CREADA
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { id: ref.id, esDuplicado: false };
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

    // PASO 1.5 — FIX ANNY-PAUSA-004: si la admin está atendiendo
    // este chat manualmente, Anny guarda el mensaje del cliente en
    // el historial (para no perder contexto) pero NO responde.
    const pausada = await annyEstaPausada(adminId, telefono);
    if (pausada) {
      await registrarConversacion(adminId, {
        telefono,
        nombreCliente: nombreCliente || telefono,
        mensajeCliente: mensajeTexto,
        respuestaAgente: null,
        respondidoPor: 'PAUSA_ADMIN',
        escalado: false,
        caseId: null
      });
      return { procesado: true, tipo: 'PAUSADA_POR_ADMIN', accion: null };
    }

    // PASO 2: respuestas del tenant + historial + ficha + catálogo
    // FIX ANNY-CLIENTE-005 / FIX ANNY-PRECIOS-006: todo aislado por
    // adminId (clients: adminId | products: creadoPor) — cada
    // suscriptor solo ve SUS datos.
    const [respuestas, historial, fichaCliente, catalogo] = await Promise.all([
      obtenerRespuestasTenant(adminId),
      obtenerHistorialReciente(adminId, telefono),
      buscarClienteEnBD(adminId, telefono),
      obtenerCatalogoProductos(adminId)
    ]);

    // FIX ANNY-CIERRE-007: la ventana de "hilo activo" sube de 10 min
    // a 24 h — un cliente que responde 2 horas después sigue en el
    // mismo hilo y el regex NO le dispara formularios repetidos.
    const ultimoTs = historial.length ? historial[historial.length - 1].ts : 0;
    const conversacionActiva = ultimoTs > 0 && (Date.now() - ultimoTs) < 24 * 60 * 60 * 1000;

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

    // PASO 3: Claude decide (conocimiento + memoria + ficha + catálogo)
    const decision = await claudeDecide(adminId, nombreCliente, mensajeTexto, respuestas, historial, fichaCliente, catalogo);

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

    // FIX ANNY-PEDIDOS-001 + FIX ANNY-DEDUP-008: pedido confirmado →
    // bandeja + aviso a la admin SOLO si es pedido nuevo (los
    // duplicados actualizan el existente y no re-notifican).
    let notificarA = null;
    let pedidoParaAviso = null;
    if (decision.pedido && typeof decision.pedido === 'object') {
      const resultadoPedido = await registrarPedido(adminId, telefono, decision.pedido);

      if (resultadoPedido && !resultadoPedido.esDuplicado) {
        await actualizarMetricas(adminId, 'pedidos');
        pedidoParaAviso = decision.pedido;

        try {
          const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
          notificarA = cfgDoc.exists ? (cfgDoc.data().notificarPedidosA || null) : null;
        } catch (e) {
          notificarA = null;
        }
      }
    }

    return {
      procesado: true,
      tipo: decision.pedido ? 'PEDIDO_CONFIRMADO' : 'RESPUESTA_IA',
      accion: 'enviar_mensaje',
      respuesta: decision.respuesta,
      pedido: pedidoParaAviso,
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
  invalidarCacheCatalogo,
  pausarAnny,
  annyEstaPausada,
  reactivarAnny,
  buscarClienteEnBD,
  obtenerCatalogoProductos,
  RESPUESTAS_BASE
};
// FIN annyService.js
