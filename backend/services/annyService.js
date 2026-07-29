// ============================================================
// Control360 — Servicio WhatsApp IA Anny  (MOTOR v23)
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
// FIXES HEREDADOS (se conservan intactos):
// - ANNY-PAUSA-004, ANNY-CLIENTE-005, ANNY-PRECIOS-006,
//   ANNY-CIERRE-007, ANNY-DEDUP-008, ANNY-JSON-001,
//   ANNY-GATE-001, ANNY-CFG-002, ANNY-BOOT-001, ANNY-CTX-001
//
// ════════════════════════════════════════════════════════════
// NUEVO EN v22 — Anny deja de ser "el bot de extintores" y pasa
// a ser un MOTOR multipropósito (perfil × misión):
//
// - ANNY-CFG-010  : PERFIL DE NEGOCIO por tenant en
//                   annyConfig/{adminId}.perfil. La identidad ya
//                   NO está hardcodeada al vertical extintores.
//                   Si el tenant no tiene perfil → cae al perfil
//                   por defecto = comportamiento actual (fallback
//                   seguro, permite activar tenant por tenant).
// - ANNY-MISION-014: MISIONES (ATENCION, COBRANZA,
//                   NOTIFICACION_TALLER, RENOVACION_SAAS,
//                   REACTIVACION). La misión cambia objetivo,
//                   tono, si puede vender y el largo máximo.
// - ANNY-BREV-011 : brevedad REAL. max_tokens 600→300 + reglas
//                   duras + saneador determinístico que elimina
//                   viñetas/✓/títulos en mayúscula y recorta.
//                   Antes "sé breve" era una sugerencia; ahora
//                   es un límite que el modelo no puede violar.
// - ANNY-HUMANO-012: si el cliente pide un asesor/persona, se
//                   escala SIN pasar por el modelo y Anny SE
//                   PAUSA en ese chat (caso "No me gusta tu IA").
//                   Notifica a perfil.notificarEscalamientoA y,
//                   si está vacío, al WhatsApp de avisos ya
//                   configurado (notificarPedidosA).
// - ANNY-ESTADO-013: bloque ESTADO DEL PEDIDO leído de
//                   pedidosAnny. Anny ya NO puede afirmar
//                   "tu servicio está listo" si no hay pedido:
//                   si no consta en el sistema, escala.
// - ANNY-IDEM-016 : el hilo genera MÁXIMO un pedido abierto.
//                   Ampliado a estados NUEVO/BORRADOR/EN_REVISION
//                   (antes solo NUEVO) → 3 aprobaciones del mismo
//                   cliente ya no generan 3 pedidos.
// - ANNY-MISION-014b (v23): el motor LEE la misión activa que
//                   annyNotificaciones dejó marcada en el chat.
//                   Sin esto, el cliente que responde a un cobro
//                   era atendido como consulta comercial nueva y
//                   Anny le ofrecía productos en medio del cobro.
//                   Cubre además el hueco de la ventana de 24h:
//                   la misión dura 48h, así que una cobranza del
//                   viernes sigue siendo cobranza el domingo.
// - ANNY-ESCALA-017: la lista de chats ya NO se reconstruye
//                   leyendo TODOS los mensajes con .limit(500)
//                   sin orderBy (que devolvía 500 documentos
//                   ARBITRARIOS por orden de ID y hacía
//                   DESAPARECER chats al pasar ese techo).
//                   Se desnormaliza en chatsAnny/{adminId}/chats
//                   con paginación por ultimaFechaMs. Escritura
//                   dual: el histórico legado NO se toca.
// ============================================================

const { db, admin } = require('../config/firebase');
const Anthropic = require('@anthropic-ai/sdk');
// ✅ TALLER-RESPUESTA-001: constancia de la respuesta del cliente sobre un
// defecto. Solo escribe un campo informativo — nunca autoriza ni mueve stock.
const tallerRespuestas = require('./tallerRespuestas');

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
// FIX ANNY-CFG-010: PERFIL DE NEGOCIO por tenant
// ------------------------------------------------------------
// La identidad de Anny sale del código y pasa a Firestore:
//   annyConfig/{adminId}.perfil = {
//     nombreAgente, empresa, vertical, queVende,
//     fuentePrecios: 'products' | 'planes' | 'ninguna',
//     reglasNegocio, notificarEscalamientoA
//   }
// PERFIL_DEFAULT reproduce EXACTAMENTE el comportamiento previo,
// así que un tenant sin perfil configurado no cambia en nada.
// Esto es lo que permite activar el motor nuevo tenant por
// tenant con un solo deploy.
// ============================================================
// Declarado aquí (y no más abajo) para evitar la Temporal Dead Zone:
// obtenerPerfilTenant lo usa antes de la sección de respuestas.
const CACHE_TTL_MS = 5 * 60 * 1000;

const PERFIL_DEFAULT = {
  nombreAgente: 'Anny',
  empresa: 'la empresa',
  vertical: 'venta, recarga y mantenimiento de extintores y seguridad industrial en Colombia',
  queVende: 'recarga de extintores, venta de extintores nuevos, mantenimiento y elementos de seguridad industrial',
  fuentePrecios: 'products',
  reglasNegocio: '',
  notificarEscalamientoA: null
};

const _cachePerfil = new Map(); // adminId -> { data, ts }

async function obtenerPerfilTenant(adminId) {
  const cached = _cachePerfil.get(adminId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;
  try {
    const doc = await db.collection('annyConfig').doc(adminId).get();
    const cfg = doc.exists ? (doc.data() || {}) : {};
    const p = cfg.perfil || {};
    const data = {
      nombreAgente: p.nombreAgente || PERFIL_DEFAULT.nombreAgente,
      empresa: p.empresa || PERFIL_DEFAULT.empresa,
      vertical: p.vertical || PERFIL_DEFAULT.vertical,
      queVende: p.queVende || PERFIL_DEFAULT.queVende,
      fuentePrecios: p.fuentePrecios || PERFIL_DEFAULT.fuentePrecios,
      reglasNegocio: p.reglasNegocio || '',
      // ANNY-HUMANO-012: si no hay canal propio de escalamiento,
      // cae al WhatsApp de avisos que la suscriptora YA configuró.
      notificarEscalamientoA: p.notificarEscalamientoA || cfg.notificarPedidosA || null,
      configurado: !!cfg.perfil
    };
    _cachePerfil.set(adminId, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error('[ANNY] Error leyendo perfil tenant:', err.message);
    return { ...PERFIL_DEFAULT, configurado: false };
  }
}

function invalidarCachePerfil(adminId) {
  _cachePerfil.delete(adminId);
}

// ============================================================
// FIX ANNY-MISION-014: catálogo de MISIONES
// ------------------------------------------------------------
// Anny no hace un solo trabajo. Cada misión define objetivo,
// si puede vender, y el largo máximo de su respuesta.
// El núcleo es el mismo; lo que cambia son las reglas.
// ============================================================
const MISIONES = {
  ATENCION: {
    objetivo: 'Atender al cliente que escribe: resolver su duda y, si aplica, cerrar la venta.',
    permiteVenta: true,
    permitePedido: true,
    // ✅ FIX ANNY-BREV-018: 350 → 220. 350 caracteres unidos en un solo
    // párrafo (recortarRespuesta une todo en prosa) se leen como un
    // muro de texto en WhatsApp. 220 obliga a la frase corta de asesora.
    maxChars: 220,
    reglas: 'Responde primero lo que pregunta. Cierra cuando tengas los mínimos.'
  },
  COBRANZA: {
    objetivo: 'Recordar de forma amable un saldo pendiente y acordar cómo y cuándo paga.',
    permiteVenta: false,
    permitePedido: false,
    maxChars: 280,
    reglas: 'NO ofrezcas productos ni catálogo. NO vendas. Solo saldo, medio de pago y fecha. Si el cliente discute el valor o dice que ya pagó, ESCALA.'
  },
  NOTIFICACION_TALLER: {
    objetivo: 'Informar un cambio de repuesto o novedad del taller y obtener autorización SÍ/NO.',
    permiteVenta: false,
    permitePedido: false,
    maxChars: 260,
    // ✅ TALLER-RESPUESTA-001: Anny recoge la respuesta pero NO autoriza nada.
    // Prometer que "ya quedó autorizada" sería mentir: la decisión la aplica
    // el taller con un click. Debe decir que lo pasa al taller y se confirma.
    reglas: 'Ultrabreve. Informa la novedad y su valor, y pide autorización. NO negocies precio: si pide descuento o cambio, ESCALA. Cuando el cliente responda, agradece y dile que lo pasas al taller para confirmarle: NUNCA afirmes que la reparación ya quedó autorizada, aprobada o programada.'
  },
  RENOVACION_SAAS: {
    objetivo: 'Informar la cuenta de cobro de la suscripción y acordar el pago.',
    permiteVenta: false,
    permitePedido: false,
    maxChars: 300,
    reglas: 'Hablas de la SUSCRIPCIÓN AL SOFTWARE, nunca de productos físicos. NO menciones catálogo de productos. Si pide cambio de plan o descuento, ESCALA.'
  },
  REACTIVACION: {
    objetivo: 'Reactivar a un cliente con servicio vencido o inactivo e invitarlo a agendar.',
    permiteVenta: true,
    permitePedido: true,
    maxChars: 300,
    reglas: 'Un solo mensaje, cálido y directo. Si no muestra interés, agradece y cierra: NO insistas.'
  }
};

function obtenerMision(nombre) {
  return MISIONES[String(nombre || 'ATENCION').toUpperCase()] || MISIONES.ATENCION;
}

// ============================================================
// FIX ANNY-LEARN-002: respuestas por tenant con caché
// ============================================================
const _cacheRespuestas = new Map(); // adminId -> { data, ts }

async function obtenerRespuestasTenant(adminId) {
  const cached = _cacheRespuestas.get(adminId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const doc = await db.collection('respuestasAnny').doc(adminId).get();

    // ✅ ANNY-VERTICAL-025: BUG MULTI-TENANT.
    // Un suscriptor SIN respuestas propias heredaba RESPUESTAS_BASE, que son
    // las de extintores: dirección de Cali, precios de recarga, horarios del
    // taller. Un tenant de venta en línea habría respondido "Estamos en Cl. 22
    // Nte., San Vicente, Cali" a sus propios clientes.
    // Regla: el fallback de extintores SOLO aplica a tenants sin perfil
    // configurado (los heredados, que efectivamente son de extintores). En
    // cuanto el suscriptor define su perfil, arranca con la base vacía y
    // construye la suya en Entrenamiento.
    let data;
    if (doc.exists) {
      data = doc.data();
    } else {
      const perfil = await obtenerPerfilTenant(adminId);
      data = perfil.configurado ? {} : RESPUESTAS_BASE;
    }

    _cacheRespuestas.set(adminId, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error('[ANNY] Error leyendo respuestas tenant:', err.message);
    return {};
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
// FIX ANNY-HUMANO-012: detección determinística de "quiero un
// asesor". NO depende del criterio del modelo: es la única
// petición que jamás se puede ignorar. Al detectarla, Anny
// escala Y SE PAUSA en ese chat para dejar de escribir.
// ============================================================
const PATRONES_PIDE_HUMANO = [
  'un asesor', 'una asesora', 'con un asesor', 'con una asesora',
  'hablar con alguien', 'hablar con una persona', 'hablar con un humano',
  'persona real', 'atencion humana', 'atención humana',
  'no quiero ia', 'no me gusta tu ia', 'no me gusta la ia',
  'eres un bot', 'eres una maquina', 'eres una máquina', 'sos un bot',
  'quiero un humano', 'comuniqueme con', 'comuníqueme con',
  'pasame con', 'páame con', 'pásame con', 'me pasas con',
  'atiendame una persona', 'atiéndame una persona'
];

function pidePersonaHumana(mensajeTexto) {
  const t = String(mensajeTexto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // sin tildes
  return PATRONES_PIDE_HUMANO.some(p => {
    const pn = p.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return t.includes(pn);
  });
}

// ============================================================
// FIX ANNY-BREV-011: saneador determinístico de respuestas.
// ------------------------------------------------------------
// El formato de folleto (✓, viñetas, TÍTULOS EN MAYÚSCULA,
// "💰 INVERSIÓN:") es lo que hacía ver a Anny como catálogo y
// no como asesora. Aquí se elimina SIEMPRE, aunque el modelo
// lo genere y aunque venga heredado de la base de conocimiento.
// No se toca el contenido: solo el formato y el largo.
// ============================================================
function recortarRespuesta(texto, maxChars = 350) {
  if (!texto) return texto;

  const MARCADORES = /^[\s\u2022\u00b7\-*\u2192\u25aa\u25cf\u2713\u2705\u2611\ufe0f\u2611\ud83d\udcb0\ud83d\udd25\ud83d\ude97\u2b50\u2705]+\s*/;

  const partes = [];
  for (let linea of String(texto).split(/\r?\n/)) {
    // 1. Quitar marcadores de lista y emojis decorativos del inicio
    linea = linea.replace(MARCADORES, '');
    linea = linea.replace(/^[^\p{L}\p{N}¿¡"']+/u, '').trim();
    if (!linea) continue;

    // 2. Descartar títulos en mayúscula sostenida ("VENTAJAS:", "INVERSIÓN:")
    if (/^[A-ZÁÉÍÓÚÑ0-9 ()\/]{4,}:?$/.test(linea)) continue;

    // 3. Si la línea es un encabezado con dos puntos y nada más, se descarta
    partes.push(linea);
  }

  // 4. Unir en prosa: cada fragmento termina en signo de puntuación
  let t = partes
    .map(x => (/[.!?:,]$/.test(x) ? x : x + '.'))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/([.!?])\.+/g, '$1')
    .trim();

  // 5. Recorte duro respetando el final de la última frase completa
  if (t.length > maxChars) {
    const corte = t.slice(0, maxChars);
    const ultimo = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('? '), corte.lastIndexOf('! '));
    t = ultimo > maxChars * 0.5 ? corte.slice(0, ultimo + 1) : corte.trim();
  }

  return t.trim();
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

    // ✅ ANNY-CONTEXTO-019: hasta aquí la ficha solo traía datos de identidad,
    // así que Anny sabía CÓMO se llama el cliente pero no CUÁNTOS equipos tiene
    // ni qué se le vence — y terminaba preguntando lo que el sistema ya sabe.
    // Ambas consultas van en paralelo y solo para clientes YA registrados.
    const [vencimientos, saldoCxC] = await Promise.all([
      obtenerVencimientosCliente(adminId, doc.id),
      obtenerSaldoCxC(adminId, doc.id)
    ]);

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
      sucursales,
      // ✅ ANNY-CONTEXTO-019
      vencimientos,
      saldoCxC
    };
  } catch (err) {
    console.error('[ANNY] Error buscando cliente en BD:', err.message);
    return { existe: false };
  }
}

// ============================================================
// ✅ ANNY-CONTEXTO-019: equipos por vencer / vencidos del cliente
// ------------------------------------------------------------
// Solo lectura, siempre filtrado por adminId. Se usa para que Anny
// pueda decir "se le vencen 4 extintores este mes" en vez de
// preguntarle al cliente qué equipos tiene.
// Si la consulta falla, devuelve vacío: la conversación NUNCA se cae
// por falta de este contexto (es enriquecimiento, no requisito).
// ============================================================
async function obtenerVencimientosCliente(adminId, clienteId) {
  try {
    if (!adminId || !clienteId) return { total: 0, vencidos: 0, proximos: 0, detalle: [] };

    const snap = await db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .where('clienteId', '==', clienteId)
      .limit(200)
      .get();

    // Fecha Colombia (UTC-5) — mismo criterio que comercial.js
    const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    const finDeMes = hoy.slice(0, 7) + '-31';

    let vencidos = 0, proximos = 0, total = 0;
    const detalle = [];

    snap.forEach(d => {
      const v = d.data();
      if (v.gestionado || !v.fechaVencimiento) return;
      const cant = Number(v.cantidad) || 1;
      total += cant;
      if (v.fechaVencimiento < hoy) vencidos += cant;
      else if (v.fechaVencimiento <= finDeMes) proximos += cant;
      if (detalle.length < 12) {
        detalle.push({
          equipo: v.descripcionEquipo || 'Extintor',
          cantidad: cant,
          fecha: v.fechaVencimiento,
          sucursal: v.sucursal || null
        });
      }
    });

    return { total, vencidos, proximos, detalle };
  } catch (err) {
    console.error('[ANNY] Error leyendo vencimientos del cliente:', err.message);
    return { total: 0, vencidos: 0, proximos: 0, detalle: [] };
  }
}

// ============================================================
// ✅ ANNY-CONTEXTO-019: saldo pendiente en cartera (solo lectura)
// ------------------------------------------------------------
// ⚠️ El saldo se le da a Anny para que NO cierre una venta nueva
// ignorando una deuda vieja, y para la misión COBRANZA. NUNCA para
// negociar: si el cliente discute el valor o dice que ya pagó, la
// misión COBRANZA ya obliga a escalar.
// ============================================================
async function obtenerSaldoCxC(adminId, clienteId) {
  try {
    if (!adminId || !clienteId) return { saldo: 0, facturas: 0 };

    // ⚠️ OJO: NO se consulta la colección `cxc`. Ese registro paralelo usa
    // `userId` como campo de tenant (no `adminId`) y no es la fuente de
    // verdad: el módulo CxC calcula la cartera desde `orders` (ver cxc.js
    // GET /, líneas ~72-76). Se replica ESA misma lógica para que Anny y el
    // módulo nunca muestren cifras distintas.
    const snap = await db.collection('orders')
      .where('adminId', '==', adminId)
      .where('clienteId', '==', clienteId)
      .limit(300)
      .get();

    const FORMAS_CREDITO = ['CXC', 'A crédito (CxC)', 'A crédito'];
    let saldo = 0, facturas = 0;

    snap.forEach(d => {
      const o = d.data();
      if (o.estado === 'anulada') return;

      const esCredito =
        o.estado === 'cxc' ||
        o.cxcEstado === 'parcial' ||
        (FORMAS_CREDITO.includes(o.formaPago) && !o.pagado);
      if (!esCredito) return;

      // Mismo cálculo de saldo real que cxc.js: total menos abonos.
      const saldoReal = (Number(o.total) || 0) - (Number(o.montoPagado) || 0);
      if (saldoReal <= 0) return;

      saldo += saldoReal;
      facturas += 1;
    });

    return { saldo, facturas };
  } catch (err) {
    console.error('[ANNY] Error leyendo cartera del cliente:', err.message);
    return { saldo: 0, facturas: 0 };
  }
}

// ============================================================
// FIX ANNY-PRECIOS-006: catálogo de productos del tenant (caché)
// ------------------------------------------------------------
// ⚠️ OJO: products usa campo tenant `creadoPor` (NO adminId) —
// verificado contra products.js (router.get('/') línea ~203).
// Solo productos activos, solo nombre + precioVenta (nunca costo).
// Máx 80 ítems para no inflar el prompt. Caché 5 min.
//
// ANNY-CFG-010: si el perfil declara fuentePrecios !== 'products'
// (p. ej. un tenant de software), NO se carga catálogo físico.
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
// FIX ANNY-ESCALA-017: resumen de chat desnormalizado
// ------------------------------------------------------------
// PROBLEMA QUE RESUELVE: la lista de chats se armaba leyendo
// TODOS los mensajes con .limit(500) SIN orderBy. Sin orderBy,
// Firestore devuelve documentos en orden de ID (aleatorio en IDs
// automáticos), así que al superar 500 mensajes había chats que
// simplemente NO APARECÍAN — sin error visible. Con 105 chats y
// hasta 26 mensajes cada uno, ese techo ya estaba encima.
//
// SOLUCIÓN: un documento resumen por chat, actualizado en cada
// mensaje. La lista pasa a leer N chats ordenados, no N mensajes.
// El costo deja de crecer con el volumen histórico.
//
// `ultimaFechaMs` es numérico (no serverTimestamp) a propósito:
// permite orderBy + startAfter con índice de campo único —
// sin índices compuestos.
// ============================================================
function colChats(adminId) {
  return db.collection('chatsAnny').doc(adminId).collection('chats');
}

function refChat(adminId, telefono) {
  return colChats(adminId).doc(String(telefono));
}

async function actualizarResumenChat(adminId, data) {
  try {
    const { telefono, nombreCliente, mensajeCliente, respuestaAgente, escalado } = data;
    if (!adminId || !telefono) return;

    const ultimoTexto = respuestaAgente || mensajeCliente || '';
    const resumen = {
      adminId,
      telefono: String(telefono),
      ultimoTexto: String(ultimoTexto).slice(0, 300),
      ultimaFechaMs: Date.now(),
      totalMensajes: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (nombreCliente) resumen.nombreCliente = nombreCliente;
    if (escalado) resumen.escalado = true;

    await refChat(adminId, telefono).set(resumen, { merge: true });
  } catch (err) {
    console.error('[ANNY] Error actualizando resumen de chat:', err.message);
  }
}

// ------------------------------------------------------------
// ANNY-ESCALA-017: lista paginada de chats. Reemplaza el barrido
// de mensajes que hace hoy GET /api/anny/chats.
// Devuelve { chats, cursor } — el cursor es ultimaFechaMs del
// último elemento; se pasa como `desdeMs` para la página siguiente.
// ------------------------------------------------------------
async function listarChats(adminId, opciones = {}) {
  try {
    const limite = Math.min(Number(opciones.limit) || 25, 100);
    let query = colChats(adminId).orderBy('ultimaFechaMs', 'desc');

    if (opciones.desdeMs) query = query.startAfter(Number(opciones.desdeMs));

    const snap = await query.limit(limite).get();
    const chats = snap.docs.map(d => ({ telefono: d.id, ...d.data() }));

    return {
      chats,
      cursor: chats.length === limite ? chats[chats.length - 1].ultimaFechaMs : null,
      migrado: true
    };
  } catch (err) {
    console.error('[ANNY] Error listando chats:', err.message);
    return { chats: [], cursor: null, migrado: false, error: err.message };
  }
}

// ============================================================
// FIX ANNY-CTX-001 (+ ANNY-ESCALA-017): historial reciente
// ------------------------------------------------------------
// Lee primero la subcolección nueva por chat (orderBy directo,
// sin índice compuesto). Si el chat aún no tiene mensajes ahí
// (histórico anterior a v22), cae a la colección legada — que
// NO se modifica ni se migra.
// ============================================================
async function obtenerHistorialReciente(adminId, telefono, limite = 8) {
  // — Ruta nueva —
  try {
    const snap = await refChat(adminId, telefono)
      .collection('mensajes')
      .orderBy('fechaMs', 'desc')
      .limit(limite)
      .get();

    if (!snap.empty) {
      const docs = snap.docs.map(d => d.data()).reverse(); // cronológico
      const turnos = [];
      for (const c of docs) {
        const ts = c.fechaMs || 0;
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
    }
  } catch (err) {
    console.error('[ANNY] Historial nuevo falló, uso legado:', err.message);
  }

  // — Ruta legada (compatibilidad, sin migración) —
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
      .reverse();

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
// FIX ANNY-MISION-014b: leer la misión activa del chat
// ------------------------------------------------------------
// annyNotificaciones marca `misionActiva` + `misionHasta` cuando
// Anny abre una conversación con un propósito (cobrar, pedir
// autorización de taller, renovar suscripción). Aquí se lee para
// que la RESPUESTA del cliente se atienda bajo ese mismo
// propósito. Vencido el plazo, vuelve a ATENCION normal.
// ============================================================
async function obtenerMisionActiva(adminId, telefono) {
  try {
    const doc = await refChat(adminId, telefono).get();
    if (!doc.exists) return 'ATENCION';
    const d = doc.data() || {};
    if (!d.misionActiva) return 'ATENCION';
    if (d.misionHasta && Date.now() > Number(d.misionHasta)) return 'ATENCION';
    return MISIONES[d.misionActiva] ? d.misionActiva : 'ATENCION';
  } catch (err) {
    console.error('[ANNY] Error leyendo misión activa:', err.message);
    return 'ATENCION';
  }
}

// ============================================================
// FIX ANNY-ESTADO-013: estado REAL del pedido en este hilo
// ------------------------------------------------------------
// Anny no tenía forma de saber si existía un pedido, así que
// cuando el cliente preguntó "¿ya está listo?" respondió que sí
// SIN que existiera la orden. Esto le da el estado verdadero, y
// el prompt le prohíbe afirmar nada que no salga de aquí.
// ============================================================
const ESTADOS_PEDIDO_ABIERTO = ['NUEVO', 'BORRADOR', 'EN_REVISION'];

async function obtenerEstadoPedidoHilo(adminId, telefono) {
  try {
    const snap = await db.collection('pedidosAnny')
      .doc(adminId)
      .collection('pedidos')
      .where('telefono', '==', telefono)
      .limit(20)
      .get();

    if (snap.empty) return { existe: false };

    const pedidos = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    const abierto = pedidos.find(p => ESTADOS_PEDIDO_ABIERTO.includes(p.estado));
    const p = abierto || pedidos[0];

    return {
      existe: true,
      id: p.id,
      estado: p.estado || 'NUEVO',
      producto: p.producto || '',
      total: p.total || '',
      datosPendientes: Array.isArray(p.datosPendientes) ? p.datosPendientes : [],
      abierto: !!abierto
    };
  } catch (err) {
    console.error('[ANNY] Error leyendo estado de pedido:', err.message);
    return { existe: false };
  }
}

// ============================================================
// FIX ANNY-CIERRE-007 + v22: Claude decide.
// Motor único: PERFIL (quién es) × MISIÓN (a qué vino).
// ============================================================
async function claudeDecide(adminId, clienteNombre, mensajeTexto, respuestas = {}, historial = [], fichaCliente = { existe: false }, catalogo = [], perfil = PERFIL_DEFAULT, misionNombre = 'ATENCION', estadoPedido = { existe: false }, defectoPendiente = null, imagenAdjunta = null) {
  try {
    const mision = obtenerMision(misionNombre);

    const conocimiento = Object.entries(respuestas || {})
      .filter(([, c]) => c && c.respuesta)
      .map(([key, c]) => `- [${key}] ${(c.patrones || []).join(', ')}: ${c.respuesta}`)
      .join('\n');

    const hilo = (historial || [])
      .map(t => {
        const quien = t.rol === 'cliente' ? 'Cliente' : (t.rol === 'admin' ? 'Asesora (humana)' : `${perfil.nombreAgente} (tú)`);
        return `${quien}: ${t.texto}`;
      })
      .join('\n');

    // ANNY-CFG-010: catálogo solo si el perfil lo declara
    const catalogoTxt = perfil.fuentePrecios === 'products'
      ? (catalogo || []).map(p => `- ${p.nombre}: $${p.precio.toLocaleString('es-CO')}`).join('\n')
      : '';

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

      // ✅ ANNY-CONTEXTO-019: equipos y cartera. Esto es lo que evita que
      // Anny pregunte "¿qué equipo tiene?" a un cliente cuyos 6 extintores
      // están registrados en el sistema desde hace dos años.
      const ven = fichaCliente.vencimientos;
      if (ven && ven.total > 0) {
        const partes = [];
        if (ven.vencidos > 0) partes.push(`${ven.vencidos} YA VENCIDO(S)`);
        if (ven.proximos > 0) partes.push(`${ven.proximos} vence(n) este mes`);
        fichaTxt += `\n- EQUIPOS REGISTRADOS: ${ven.total} pendiente(s) de recarga${partes.length ? ` — ${partes.join(', ')}` : ''}`;
        if (ven.detalle.length) {
          fichaTxt += `\n  ${ven.detalle.map(e => `${e.cantidad}x ${e.equipo} (vence ${e.fecha})${e.sucursal ? ` — sede ${e.sucursal}` : ''}`).join('\n  ')}`;
        }
        fichaTxt += `\n  → NO le preguntes qué equipos tiene ni cuántos: ya lo sabes. Confírmalo si hace falta.`;
      }

      const cxc = fichaCliente.saldoCxC;
      if (cxc && cxc.saldo > 0) {
        fichaTxt += `\n- CARTERA: tiene $${Math.round(cxc.saldo).toLocaleString('es-CO')} pendiente(s) en ${cxc.facturas} orden(es).`;
        fichaTxt += `\n  → Dato interno de contexto. NO se lo cobres si él no sacó el tema y la misión no es COBRANZA. Si discute el valor o dice que ya pagó, ESCALA.`;
      }
    }

    // ANNY-ESTADO-013: bloque de estado real
    let estadoTxt;
    if (!estadoPedido.existe) {
      estadoTxt = 'NO existe ningún pedido registrado para este cliente en el sistema.';
    } else {
      estadoTxt =
        `Pedido registrado #${estadoPedido.id} — estado: ${estadoPedido.estado}\n` +
        `- Producto/servicio: ${estadoPedido.producto || '(sin detalle)'}\n` +
        `- Total: ${estadoPedido.total || '(sin detalle)'}\n` +
        `- Datos aún pendientes: ${estadoPedido.datosPendientes.length ? estadoPedido.datosPendientes.join(', ') : 'ninguno'}\n` +
        `- Ya le confirmaste el resumen de este pedido: SÍ → NO se lo repitas.`;
    }

    // ✅ TALLER-RESPUESTA-001: si este cliente tiene un defecto esperando
    // autorización, Anny debe CLASIFICAR su respuesta — no ejecutarla.
    // El umbral es deliberadamente alto: ante cualquier duda, null.
    const bloqueDefecto = defectoPendiente ? `
AUTORIZACIÓN DE REPARACIÓN PENDIENTE (orden ${defectoPendiente.numeroOrden}):
Se le informó este defecto: "${defectoPendiente.descripcion}" por $${Math.round(defectoPendiente.costoReparacion).toLocaleString('es-CO')}, y se le pidió que autorice.

Además de responderle, CLASIFICA su mensaje en el campo "respuestaTaller":
- "APROBADO" solo si autoriza de forma INEQUÍVOCA ("sí", "sí autorizo", "hágale", "de una", "proceda").
- "RECHAZADO" solo si niega de forma INEQUÍVOCA ("no", "no autorizo", "así déjelo", "no lo arreglen").
- null en CUALQUIER otro caso: dudas, condiciones, preguntas de precio, "déjeme pensarlo", "sí pero...", "cuánto vale", o si el mensaje no habla de esta autorización.
- Si es null Y el cliente sí está hablando del defecto sin definirse, ESCALA (tipo SERVICIO).
- Tú NO autorizas nada: solo clasificas. El taller confirma. No le digas que ya quedó autorizado.
` : '';

    // ✅ ANNY-MEDIA-024: reglas para cuando el cliente manda una foto.
    // Anny CONFIRMA lo que ve, nunca lo da por hecho: una etiqueta borrosa
    // metida al pedido como certeza termina en una recarga equivocada.
    const bloqueImagen = imagenAdjunta ? `
EL CLIENTE ENVIÓ UNA FOTO (la estás viendo arriba):
- Descríbele lo que identificas y PÍDELE QUE CONFIRME antes de usarlo. Ejemplo: "Veo [lo que sea que identifiques], ¿es correcto?".
- Si no se lee bien o dudas de algún dato, DILO y pide otra foto más cerca. NO adivines.
- Si ves varios artículos, di cuántos cuentas y pide confirmación.
- NUNCA cierres un pedido con datos que solo salieron de una foto sin que el cliente los haya confirmado por texto.
- Relaciona lo que ves con el CATÁLOGO de arriba; si no corresponde a nada del catálogo, dilo y ESCALA.
` : '';

    const prompt = `
Eres ${perfil.nombreAgente}, asesora por WhatsApp de ${perfil.empresa}, empresa de ${perfil.vertical}. Vendes bien, pero primero ATIENDES: resuelves lo que el cliente pregunta.

QUÉ OFRECE LA EMPRESA: ${perfil.queVende}

MISIÓN DE ESTA CONVERSACIÓN: ${misionNombre}
Objetivo: ${mision.objetivo}
Reglas de la misión: ${mision.reglas}
${mision.permiteVenta ? '' : 'EN ESTA MISIÓN NO VENDES: no ofrezcas productos, no cites catálogo, no abras pedidos.'}

HISTORIAL RECIENTE DE LA CONVERSACIÓN (viejo → nuevo):
${hilo || '(primera interacción con este cliente)'}

NUEVO MENSAJE del cliente ${clienteNombre}: "${mensajeTexto}"

FICHA DEL CLIENTE:
${fichaTxt}

ESTADO REAL DEL PEDIDO (única fuente válida — el sistema, no tu memoria):
${estadoTxt}

${catalogoTxt ? `CATÁLOGO OFICIAL DE PRODUCTOS Y PRECIOS VIGENTES (única fuente válida de precios):\n${catalogoTxt}` : '(esta empresa NO maneja catálogo de productos físicos — no inventes productos ni precios)'}

BASE DE CONOCIMIENTO DE LA EMPRESA (domicilio, horarios, medios de pago, políticas):
${conocimiento || '(sin datos configurados)'}
${perfil.reglasNegocio ? `\nREGLAS PROPIAS DE ESTA EMPRESA:\n${perfil.reglasNegocio}` : ''}

FORMA DE ESCRIBIR (obligatorio — ANNY-BREV-011):
- MÁXIMO ${mision.maxChars} caracteres. UN solo mensaje. Si no cabe, prioriza y calla el resto.
- PROHIBIDO: listas, viñetas, guiones, símbolos ✓ ✅ •, títulos en MAYÚSCULA sostenida, y bloques tipo "VENTAJAS:" o "INVERSIÓN:". Escribe en prosa, como una persona por WhatsApp.
- PROHIBIDO abrir con muletillas: "Perfecto", "Entendido", "Claro que sí", "Excelente". Entra directo al punto.
- PROHIBIDO repetir un resumen o confirmación que ya aparezca en el historial. Si ya lo dijiste, no lo repitas: avanza.
- Máximo UNA pregunta por mensaje.
- ✅ ANNY-REPETICION-023 — REGLA ANTI-LORA (crítica):
  Lee tus propios mensajes en el historial. Si YA hiciste esta misma pregunta (aunque con otras palabras), está PROHIBIDO volver a hacerla.
  · Si el cliente respondió algo corto o vago ("por favor", "sí", "listo"), NO repitas la pregunta: reformúlala de otra forma, más simple y concreta, o da la opción más común y pide que confirme.
  · Si ya la hiciste DOS veces y el cliente sigue sin darte el dato, deja de preguntar y ESCALA (tipo DATOS). Una persona no pregunta lo mismo tres veces: llama o pasa el caso.
  · Nunca abras con "Perfecto, entiendo que..." repitiendo lo que el cliente acaba de decir. Eso es lo que te delata como máquina.
- Sonar profesional NO es escribir largo: es saber la respuesta y darla directo.

REGLAS DE ATENCIÓN (prioridad máxima):
- Responde PRIMERO lo que el cliente pregunta en su último mensaje. Si cambió de tema, síguelo — NO insistas en vender.
- Si pregunta cómo pagar → medios de pago, confirma valor y CIERRA. No ofrezcas más productos.
- Si ya hay un pedido abierto, NO inicies otro: solo resuelve dudas de ese pedido.
- NUNCA pidas un dato que ya esté en el historial o en la ficha. Si está, confírmalo.
- Cada dato faltante se pide máximo UNA vez más en toda la conversación.
- NO saludes de nuevo en conversación en curso.

REGLA DE ESTADO (ANNY-ESTADO-013 — crítica):
- NUNCA afirmes que un pedido está listo, despachado, en camino o entregado. Tú NO ves el taller ni la logística.
- Si el cliente pregunta por el estado y arriba dice que NO existe pedido registrado → NO inventes: ESCALA (tipo SERVICIO).
- Si existe pedido, puedes mencionar únicamente el estado literal que aparece arriba. Nada más.

CIERRE DE PEDIDO (regla anti-estancamiento):
- Mínimos REALES: producto/servicio + nombre + dirección de entrega. El teléfono ya lo tienes (este chat).
- Cédula/NIT, correo y fecha NO bloquean: si tras pedirlos una vez no los da, CONFIRMA igual y lístalos en "datosPendientes".
- Es mejor un pedido confirmado con datos pendientes que una venta perdida por preguntar de más.
- No estires la conversación: apenas tengas los mínimos, cierra.

ESCALAR A ADMIN si:
- El cliente pide hablar con una persona, asesor o humano, o se queja de la IA (ESCALA SIEMPRE, sin excepción)
- Solicita descuento/promoción especial
- Pide cambio de fecha/horario de un servicio ya agendado
- Pregunta por precio o producto que NO está en el catálogo ni en la base de conocimiento
- Requiere capacitación
- Tiene queja/problema
- Pregunta sobre facturación legal/documentos
- Pregunta por el estado de algo que no consta en el sistema

REGLA CRÍTICA: NUNCA inventes precios, direcciones, estados ni datos. Si el dato no está, escala.

PEDIDO CONFIRMADO: ${mision.permitePedido ? 'cuando el cliente confirme la compra Y tengas los mínimos, incluye el objeto "pedido". Si faltan los mínimos o falta confirmación, "pedido" debe ser null.' : 'en esta misión "pedido" SIEMPRE debe ser null.'}

${bloqueDefecto}
${bloqueImagen}

Responde SOLO en JSON (sin markdown):
{
  "escalado": boolean,
  "tipo": "PRECIO|SERVICIO|DATOS|PAGO|NEGOCIACION|CAPACITACION|PROBLEMA|VENTA|HUMANO|OTRO",
  "respuesta": "tu respuesta si NO escalado",
  "razon": "por qué escalas (si escalado)",${defectoPendiente ? '\n  "respuestaTaller": "APROBADO" | "RECHAZADO" | null,' : ''}
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

    // ✅ ANNY-MEDIA-024: si el cliente mandó una foto, va como bloque de
    // imagen ANTES del prompt. Claude Haiku tiene visión: puede leer el
    // tipo y la capacidad en la etiqueta del extintor.
    const contenido = imagenAdjunta
      ? [
          { type: 'image', source: { type: 'base64', media_type: imagenAdjunta.media_type, data: imagenAdjunta.data } },
          { type: 'text', text: prompt }
        ]
      : prompt;

    const message = await getClaudeClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      // FIX ANNY-BREV-011: 600 → 300. Palanca mecánica contra la
      // verbosidad: aunque el prompt fallara, no cabe un folleto.
      max_tokens: 300,
      messages: [
        { role: 'user', content: contenido }
      ]
    });

    const respuestaTexto = message.content[0].text;

    // FIX ANNY-JSON-001: se extrae SOLO el bloque entre la primera
    // '{' y la última '}' antes de parsear.
    let jsonLimpio = respuestaTexto.replace(/```json|```/g, '').trim();
    const ini = jsonLimpio.indexOf('{');
    const fin = jsonLimpio.lastIndexOf('}');
    if (ini !== -1 && fin > ini) {
      jsonLimpio = jsonLimpio.slice(ini, fin + 1);
    }

    const decision = JSON.parse(jsonLimpio);

    // FIX ANNY-BREV-011: saneado determinístico — el formato de
    // folleto se elimina aunque el modelo lo haya generado.
    if (decision.respuesta) {
      decision.respuesta = recortarRespuesta(decision.respuesta, mision.maxChars);
    }
    // FIX ANNY-MISION-014: en misiones sin venta, ningún pedido.
    if (!mision.permitePedido) decision.pedido = null;

    // ✅ TALLER-RESPUESTA-001: saneo duro. Solo se aceptan los dos valores
    // exactos y solo si hay defecto pendiente. Cualquier otra cosa que
    // devuelva el modelo (texto libre, "SI", true, "quizás") vale null.
    if (!defectoPendiente ||
        (decision.respuestaTaller !== 'APROBADO' && decision.respuestaTaller !== 'RECHAZADO')) {
      decision.respuestaTaller = null;
    }

    return decision;

  } catch (err) {
    console.error('[ANNY] Error en Claude:', err.message);
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
// FIX ANNY-ESCALA-017: escritura DUAL — el histórico legado se
// mantiene intacto (cero migración, cero riesgo) y además se
// escribe el resumen + el mensaje en la estructura nueva.
// ============================================================
async function registrarConversacion(adminId, data) {
  // 1. Legado — NO se toca
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

  // 2. Estructura nueva (no debe romper el flujo si falla)
  try {
    if (data && data.telefono) {
      await refChat(adminId, data.telefono)
        .collection('mensajes')
        .add({
          ...data,
          fechaMs: Date.now(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      await actualizarResumenChat(adminId, data);
    }
  } catch (err) {
    console.error('[ANNY] Error en registro v22 (no bloqueante):', err.message);
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
// FIX ANNY-PEDIDOS-001 + ANNY-DEDUP-008 + ANNY-IDEM-016
// ------------------------------------------------------------
// Un hilo genera MÁXIMO un pedido abierto. Antes el anti-duplicado
// solo miraba estado 'NUEVO': si el pedido ya había pasado a
// BORRADOR o EN_REVISION, una nueva aprobación del cliente creaba
// otro pedido (caso real: 3 aprobaciones = 3 pedidos).
// Ahora cubre NUEVO / BORRADOR / EN_REVISION.
// Solo filtros de igualdad → no requiere índice compuesto.
// ============================================================
async function registrarPedido(adminId, telefono, pedido) {
  try {
    const coleccion = db.collection('pedidosAnny')
      .doc(adminId)
      .collection('pedidos');

    const snap = await coleccion
      .where('telefono', '==', telefono)
      .limit(20)
      .get();

    const hace24h = Date.now() - 24 * 60 * 60 * 1000;
    const existente = snap.docs.find(d => {
      const p = d.data();
      if (!ESTADOS_PEDIDO_ABIERTO.includes(p.estado)) return false;
      const ts = (p.createdAt?.seconds || 0) * 1000;
      return ts >= hace24h || ts === 0;
    });

    if (existente) {
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
      estado: 'NUEVO', // NUEVO → BORRADOR → ORDEN_CREADA
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
// props: { adminId, telefono, nombreCliente, mensajeTexto, mision?, imagenAdjunta? }
// ============================================================
async function procesarMensajeEntrante(props) {
  // ✅ ANNY-MEDIA-024: imagenAdjunta = { media_type, data(base64) } o null
  const { adminId, telefono, nombreCliente, mensajeTexto, imagenAdjunta = null } = props;
  // FIX ANNY-MISION-014b: se resuelve más abajo, tras validar el gate.
  let misionNombre = props.mision || null;

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

    // PASO 1.5 — FIX ANNY-PAUSA-004
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

    const perfil = await obtenerPerfilTenant(adminId);

    // FIX ANNY-MISION-014b: si nadie pasó misión explícita, se
    // hereda la que dejó marcada la salida que abrió este hilo.
    if (!misionNombre) {
      misionNombre = await obtenerMisionActiva(adminId, telefono);
    }

    // ══════════════════════════════════════════════════════════
    // PASO 1.6 — FIX ANNY-HUMANO-012: el cliente pide un humano.
    // Se resuelve ANTES del modelo: es determinístico y no puede
    // fallar. Anny escala, avisa y SE CALLA en ese chat.
    // ══════════════════════════════════════════════════════════
    if (pidePersonaHumana(mensajeTexto)) {
      const caseId = await registrarCasoEscalado(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        tipo: 'HUMANO',
        razon: 'El cliente pidió atención de una persona',
        prioridad: 'ALTA',
        asignadoA: adminId
      });

      const respuesta = 'Claro, ya le aviso a un asesor para que te escriba en seguida.';

      // Anny se pausa 60 min: deja de responder mientras entra el humano
      await pausarAnny(adminId, telefono, 60, 'cliente_pidio_asesor');

      await registrarConversacion(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        respuestaAgente: respuesta,
        respondidoPor: 'ESCALADO_A_ADMIN',
        tipo: 'HUMANO',
        escalado: true,
        caseId
      });

      await actualizarMetricas(adminId, 'casos_escalados');

      return {
        procesado: true,
        tipo: 'ESCALADO_HUMANO',
        accion: 'enviar_mensaje',
        respuesta,
        caseId,
        notificarA: perfil.notificarEscalamientoA,
        avisoEscalamiento: `🚨 CLIENTE PIDE ASESOR\n${nombreCliente || 'Sin nombre'} — ${telefono}\n"${String(mensajeTexto).slice(0, 120)}"\nAnny quedó pausada 60 min en este chat.`,
        telefonoCliente: telefono
      };
    }

    // PASO 2: conocimiento + historial + ficha + catálogo + estado + defecto
    const [respuestas, historial, fichaCliente, catalogo, estadoPedido, defectoPendiente] = await Promise.all([
      obtenerRespuestasTenant(adminId),
      obtenerHistorialReciente(adminId, telefono),
      buscarClienteEnBD(adminId, telefono),
      perfil.fuentePrecios === 'products' ? obtenerCatalogoProductos(adminId) : Promise.resolve([]),
      obtenerEstadoPedidoHilo(adminId, telefono),
      // ✅ TALLER-RESPUESTA-001: solo lectura. Si no hay defecto esperando
      // autorización devuelve null y todo el flujo sigue igual que antes.
      tallerRespuestas.buscarDefectoPendiente(adminId, telefono).catch(() => null)
    ]);

    // FIX ANNY-CIERRE-007: ventana de hilo activo 24 h
    const ultimoTs = historial.length ? historial[historial.length - 1].ts : 0;
    const conversacionActiva = ultimoTs > 0 && (Date.now() - ultimoTs) < 24 * 60 * 60 * 1000;

    // ✅ ANNY-MEDIA-024: con imagen adjunta NO se usa la base de conocimiento.
    // El texto es un marcador ("[el cliente envió una foto]") y podría hacer
    // match con una entrada genérica, respondiendo un folleto a alguien que
    // acaba de mandar la foto de su extintor. La foto la interpreta Claude.
    if (!conversacionActiva && misionNombre === 'ATENCION' && !imagenAdjunta) {
      const respuestaConfig = buscarRespuestaConfigura(mensajeTexto, respuestas);

      if (respuestaConfig.encontrada) {
        // FIX ANNY-BREV-011: también se sanea el formato de las
        // respuestas entrenadas (de ahí salían los bloques con ✓).
        // ✅ FIX ANNY-BREV-018: el 400 estaba HARDCODEADO e ignoraba el
        // límite de la misión (ATENCION 220, TALLER 260, COBRANZA 280).
        // Por esa puerta se colaban las respuestas largas: el modelo
        // respetaba su límite, pero la base de conocimiento no.
        // OJO: `mision` (objeto) sólo existe dentro de claudeDecide; aquí
        // hay que resolverlo desde misionNombre con obtenerMision().
        const textoSaneado = recortarRespuesta(respuestaConfig.respuesta, obtenerMision(misionNombre).maxChars);

        await registrarConversacion(adminId, {
          telefono,
          nombreCliente,
          mensajeCliente: mensajeTexto,
          respuestaAgente: textoSaneado,
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
          respuesta: textoSaneado
        };
      }
    }

    // PASO 3: Claude decide (perfil × misión × estado real)
    const decision = await claudeDecide(
      adminId, nombreCliente, mensajeTexto, respuestas, historial,
      fichaCliente, catalogo, perfil, misionNombre, estadoPedido, defectoPendiente,
      imagenAdjunta // ✅ ANNY-MEDIA-024
    );

    if (decision.escalado) {
      const caseId = await registrarCasoEscalado(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        tipo: decision.tipo,
        razon: decision.razon,
        asignadoA: adminId
      });

      const respuestaEsc = 'Dame un momento, lo reviso con el equipo y te confirmo.';

      await registrarConversacion(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        respuestaAgente: respuestaEsc,
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
        respuesta: respuestaEsc,
        caseId,
        notificarA: perfil.notificarEscalamientoA,
        avisoEscalamiento: `⚠️ CASO ESCALADO (${decision.tipo})\n${nombreCliente || 'Sin nombre'} — ${telefono}\n${decision.razon || ''}`,
        telefonoCliente: telefono
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

    // ════════════════════════════════════════════════════════════════════
    // ✅ TALLER-RESPUESTA-001: el cliente respondió la autorización.
    // Se deja CONSTANCIA en el defecto y se avisa. NO se autoriza, no se
    // cambia estado, no se mueve inventario: eso lo hace el taller con un
    // click desde GestionTaller. Ver cabecera de services/tallerRespuestas.js
    // ════════════════════════════════════════════════════════════════════
    let avisoTaller = null;
    let telefonoAvisoTaller = null;
    if (decision.respuestaTaller && defectoPendiente) {
      const reg = await tallerRespuestas.registrarRespuestaCliente(
        adminId, telefono, decision.respuestaTaller, mensajeTexto
      );
      if (reg) {
        const aprobo = reg.valor === 'APROBADO';
        avisoTaller =
          `${aprobo ? '✅ EL CLIENTE APROBÓ' : '❌ EL CLIENTE NO APROBÓ'} EL CAMBIO DE REPUESTO\n` +
          `Orden ${reg.numeroOrden} — ${reg.clienteNombre || nombreCliente || telefono}\n` +
          `${reg.descripcion} · $${Math.round(reg.costoReparacion).toLocaleString('es-CO')}\n` +
          `Respondió: "${String(mensajeTexto).slice(0, 120)}"\n\n` +
          `⚠️ Falta confirmarlo en Taller para que se aplique.`;
        try {
          const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
          telefonoAvisoTaller = cfgDoc.exists
            ? (cfgDoc.data().notificarTallerA || cfgDoc.data().notificarEscalamientoA || null)
            : null;
        } catch (e) { telefonoAvisoTaller = null; }
      }
    }

    // Pedido confirmado → bandeja + aviso solo si es nuevo
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
      // ✅ TALLER-RESPUESTA-001: el canal Baileys envía este aviso al admin
      // igual que ya hace con avisoEscalamiento.
      avisoTaller,
      notificarTallerA: telefonoAvisoTaller,
      telefonoCliente: telefono
    };

  } catch (err) {
    console.error('[ANNY] Error procesando mensaje:', err.message);
    return { procesado: false, error: err.message };
  }
}

// ============================================================
// ✅ ANNY-KB-022: reescribe una entrada de entrenamiento.
// ------------------------------------------------------------
// El auditor (ANNY-KB-021) señalaba los problemas pero dejaba a la
// suscriptora sola frente al texto: sabía QUÉ estaba mal, no CÓMO
// escribirlo. Aquí se devuelve una propuesta concreta que ella lee,
// edita si quiere y acepta — nunca se guarda sola.
//
// Regla dura: la sugerencia NO puede contener precios. Los precios
// viven en el catálogo de productos; repetirlos aquí crea una segunda
// fuente de verdad que se desactualiza en silencio al subir tarifas.
// ============================================================
async function sugerirRespuestaEntrenamiento(adminId, { key, patrones = [], respuesta = '' }) {
  const perfil = await obtenerPerfilTenant(adminId);

  const prompt = `Eres editora de mensajes de WhatsApp para ${perfil.empresa}, empresa de ${perfil.vertical}.

Te paso una respuesta guardada en la base de conocimiento de la agente ${perfil.nombreAgente}. Está mal escrita para WhatsApp. Reescríbela.

ENTRADA: "${key}"
PALABRAS CLAVE ACTUALES: ${patrones.join(', ') || '(ninguna)'}
TEXTO ACTUAL:
"""
${respuesta}
"""

REGLAS DE LA REESCRITURA:
1. MÁXIMO 220 caracteres. Dos o tres líneas, como escribe una persona.
2. Prosa corrida. PROHIBIDO: viñetas, guiones, ✓ ✅ •, TÍTULOS EN MAYÚSCULA, bloques tipo "VENTAJAS:" o "INVERSIÓN:".
3. SIN PRECIOS NI CIFRAS DE DINERO. Si el texto original los tiene, quítalos: los precios salen del catálogo de productos. Si hace falta, di que se confirma el valor según el equipo.
4. UNA SOLA intención. Si el texto mezcla dos negocios distintos (por ejemplo recarga y servicio de cambio), quédate con el que corresponde al nombre de la entrada y descarta el otro.
5. Tono de asesora colombiana: cálido, directo, sin muletillas ("Perfecto", "Claro que sí", "Excelente"). Nada de sonar a folleto ni a robot.
6. Termina con UNA pregunta corta que haga avanzar la conversación, solo si tiene sentido.
7. Las palabras clave deben ser frases de 2+ palabras que un cliente escribiría de verdad. Nada de palabras de 4 letras o menos que hagan match con todo.

Responde SOLO en JSON, sin markdown:
{"respuesta": "el texto reescrito", "patrones": ["frase 1", "frase 2", "frase 3"], "queCambie": "una frase explicando el cambio principal"}`;

  const message = await getClaudeClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  let limpio = message.content[0].text.replace(/```json|```/g, '').trim();
  const ini = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (ini !== -1 && fin > ini) limpio = limpio.slice(ini, fin + 1);

  const out = JSON.parse(limpio);

  // Red de seguridad: se aplica el mismo saneador que a las respuestas en
  // vivo, por si el modelo devolvió viñetas o se pasó de largo.
  return {
    respuesta: recortarRespuesta(String(out.respuesta || ''), 220),
    patrones: Array.isArray(out.patrones)
      ? out.patrones.map(p => String(p).trim()).filter(p => p.length > 4).slice(0, 6)
      : [],
    queCambie: String(out.queCambie || '')
  };
}

// ============================================================
// FIX ANNY-GATE-001: gate del módulo 'anny_ia'
// ============================================================
async function tenantTieneAnnyActiva(adminId) {
  try {
    const userDoc = await db.collection('users').doc(adminId).get();
    if (!userDoc.exists) return false;
    const modulos = userDoc.data().modulos || [];
    // INVARIANTE DEL SISTEMA: modulos vacío = todos habilitados
    if (modulos.length === 0) return true;
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
// Crear/actualizar configuración OPERATIVA (la del suscriptor)
// FIX ANNY-CFG-002: se eliminan claves undefined antes de escribir.
// FIX ANNY-CFG-010: el suscriptor NO puede tocar `perfil` ni
// `activo` — el perfil de negocio lo configura solo la SuperAdmin.
// ============================================================
async function actualizarConfig(adminId, datos) {
  try {
    const { activo, perfil, ...datosPermitidos } = datos; // activo y perfil se ignoran
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

// ============================================================
// FIX ANNY-CFG-010: perfil de negocio — solo SuperAdmin.
// El control de acceso vive en la ruta; aquí solo se persiste.
// ============================================================
async function actualizarPerfilTenant(adminId, perfil) {
  try {
    const permitidos = [
      'nombreAgente', 'empresa', 'vertical', 'queVende',
      'fuentePrecios', 'reglasNegocio', 'notificarEscalamientoA'
    ];
    const limpio = {};
    for (const k of permitidos) {
      if (perfil && perfil[k] !== undefined && perfil[k] !== null) limpio[k] = perfil[k];
    }
    await db.collection('annyConfig').doc(adminId).set({ perfil: limpio }, { merge: true });
    invalidarCachePerfil(adminId);
    return { ok: true, perfil: limpio };
  } catch (err) {
    console.error('[ANNY] Error actualizando perfil:', err.message);
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
  sugerirRespuestaEntrenamiento, // ✅ ANNY-KB-022
  RESPUESTAS_BASE,
  // ── v22 ──
  obtenerPerfilTenant,
  actualizarPerfilTenant,
  invalidarCachePerfil,
  listarChats,
  obtenerEstadoPedidoHilo,
  obtenerMisionActiva,
  recortarRespuesta,
  pidePersonaHumana,
  MISIONES,
  PERFIL_DEFAULT
};
// FIN annyService.js (v23)
