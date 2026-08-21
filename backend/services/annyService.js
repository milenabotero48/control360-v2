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
//
// ════════════════════════════════════════════════════════════
// NUEVO EN v24 (correcciones de operación real — jul 2026):
// - ANNY-MISION-028 : en misiones sin venta el CATÁLOGO no entra
//                   al prompt y la identidad deja de ser "vendes
//                   bien". Causa raíz de que Anny ofreciera
//                   servicios respondiendo una cobranza.
// - ANNY-PROMESA-029: prohibido prometer acciones futuras
//                   ("permíteme revisar", "ya te confirmo").
//                   Aplica al modelo y al texto fijo de escalado.
// - ANNY-ENTRENA-030: la base de conocimiento (pestaña
//                   Entrenamiento) se declara fuente de verdad:
//                   el modelo debe responder DESDE la entrada que
//                   coincida, no parafrasearla ni ignorarla.
// - ANNY-FOTO-031 : foto que no se pudo descargar/analizar →
//                   respuesta determinística pidiendo el dato por
//                   texto. Antes el marcador entraba al modelo y
//                   salía un "permíteme revisar" sin salida.
// - ANNY-MEMORIA-032: historial 8 → 20 turnos. Evita re-preguntar
//                   lo que el cliente ya dijo (caso extintor rojo).
// - Escalado por foto fuera de catálogo: solo cuando el cliente
//                   confirma que quiere el producto, no al primer
//                   vistazo.
// ============================================================

const { db, admin } = require('../config/firebase');
const Anthropic = require('@anthropic-ai/sdk');
// ✅ TALLER-RESPUESTA-001: constancia de la respuesta del cliente sobre un
// defecto. Solo escribe un campo informativo — nunca autoriza ni mueve stock.
const tallerRespuestas = require('./tallerRespuestas');
// ✅ ANNY-CONSUMO-026: medición de consumo por suscriptor (para facturar)
const annyConsumo = require('./annyConsumo');

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
// ⛔ ANNY-FUGA-035 — BUG CRÍTICO MULTI-TENANT (corregido)
// ------------------------------------------------------------
// CAUSA RAÍZ de "Anny le da a mis clientes precios de otro
// suscriptor":
//
//   Estas RESPUESTAS_BASE tenían PRECIOS ($19.000 / $25.000),
//   DIRECCIÓN (Cali) y HORARIOS quemados en el código, y se
//   entregaban a cualquier tenant sin respuestas propias
//   (línea ~364) y, peor todavía, se COPIABAN dentro del
//   documento respuestasAnny/{adminId} la primera vez que un
//   suscriptor guardaba UNA entrada de entrenamiento
//   (routes/anny.js ~954). Desde ese momento la contaminación
//   quedaba persistida y ya no dependía del fallback.
//
//   Peor aún: el patrón 'precio' hace match con CUALQUIER
//   mensaje que contenga esa palabra, y el atajo pre-configurado
//   se resuelve ANTES del modelo y ANTES del catálogo real. Así,
//   un "¿cuánto vale una recarga?" en conversación fría devolvía
//   "Recarga ABC 5 lb: $19.000" sin mirar el catálogo del tenant.
//
// REGLA NUEVA (invariante del motor):
//   NINGÚN precio, dirección, horario ni dato comercial puede
//   vivir en el código. Los precios salen SOLO de `products` del
//   propio tenant (filtrado por creadoPor == adminId). Lo demás
//   sale de la pestaña Entrenamiento de cada suscriptor.
//
// Lo que queda aquí son ayudas de CRITERIO, sin ninguna cifra ni
// dato de una empresa concreta: sirven igual a cualquier tenant.
// ============================================================
const RESPUESTAS_BASE = {
  // ✅ ANNY-COLORES-027: en Colombia el color SÍ identifica el agente.
  // Dato aportado por Sandra (operación real). Se usa como hipótesis fuerte
  // que se CONFIRMA, no como certeza: hay equipos importados o antiguos que
  // se salen de la convención, y cotizar mal un CO2 como ABC sale caro.
  // No lleva precios: es criterio técnico, no tarifa.
  'extintor_por_color': {
    patrones: ['no se cual es', 'no se que extintor', 'es el rojo', 'el amarillo', 'es verde', 'el plateado', 'el blanco', 'no se el tipo'],
    respuesta: 'Por el color me oriento: amarillo es ABC, rojo suele ser CO2 o BC, verde es de agua, plateado es tipo K y blanco es Solkaflam. ¿De qué color es el tuyo? Si puedes, mándame una foto de la etiqueta y te confirmo.',
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

// ✅ ANNY-COTIZA-038: reglas de oficio del vertical extintores. Se declaran
// una sola vez y las usan tanto PERFIL_DEFAULT (tenants heredados, que son
// justamente de extintores) como la plantilla NICHOS.extintores. Antes esto
// no existía y por eso Anny interrogaba: sin casos típicos, la única salida
// que le dejaba el prompt era exigirle al cliente tipo y capacidad.
const REGLAS_EXTINTORES = [
  'El color del extintor orienta el agente: amarillo ABC, rojo CO2 o BC, verde agua, plateado tipo K, blanco Solkaflam. Confírmalo siempre, no lo des por hecho.',
  'CASOS TÍPICOS para cotizar sin interrogar al cliente (preséntalos como "por lo general", nunca como certeza, y pide confirmación):',
  '- del carro, camioneta, moto o taxi: casi siempre ABC de 5 lb (en camión, bus o tractomula suele ser de 10 o 20 lb)',
  '- casa o apartamento: ABC de 5 o 10 lb',
  '- almacén, local, bodega o empresa: normalmente ABC de 10 lb',
  '- oficina, consultorio, recepción o sala de juntas: CO2',
  '- cocina de restaurante, freidora o campana: tipo K',
  '- tablero eléctrico, servidores o equipos de cómputo: Solkaflam',
  'Si el cliente no sabe qué extintor tiene, pídele una foto de la etiqueta o del equipo completo: es más fácil que responderte con términos técnicos.',
  'Los extintores tienen fecha de vencimiento de recarga: si el cliente menciona que está vencido, prioriza agendar la recarga.',
  'Para una recarga lo que necesitas cerrar es CUÁNTOS equipos son y a qué dirección se recogen. El tipo y la capacidad se confirman al recoger si el cliente no los sabe: eso NO puede frenar la conversación.'
].join('\n');

const PERFIL_DEFAULT = {
  nombreAgente: 'Anny',
  empresa: 'la empresa',
  vertical: 'venta, recarga y mantenimiento de extintores y seguridad industrial en Colombia',
  queVende: 'recarga de extintores, venta de extintores nuevos, mantenimiento y elementos de seguridad industrial',
  fuentePrecios: 'products',
  // El perfil por defecto ES el de extintores (así se definió en ANNY-CFG-010
  // para no romper a los tenants heredados). Dejar las reglas vacías aquí
  // significaba que los tenants sin perfil configurado —la mayoría hoy— se
  // quedaban sin criterio para cotizar.
  reglasNegocio: REGLAS_EXTINTORES,
  notificarEscalamientoA: null
};

// ============================================================
// ✅ ANNY-NICHO-033: plantillas de perfil por actividad económica.
// Al activar Anny a un suscriptor, el SuperAdmin elige el nicho y
// el perfil se precarga con estos valores (luego se pueden afinar
// campo por campo). Un solo motor, cada tenant con su oficio.
// ============================================================
const NICHOS = {
  extintores: {
    etiqueta: 'Extintores y seguridad industrial',
    vertical: 'venta, recarga y mantenimiento de extintores y seguridad industrial en Colombia',
    queVende: 'recarga de extintores, venta de extintores nuevos, mantenimiento y elementos de seguridad industrial',
    fuentePrecios: 'products',
    // ✅ ANNY-COTIZA-038: los casos típicos viven en la plantilla del nicho,
    // no en el prompt del motor. El motor es multivertical: si estas reglas
    // estuvieran en el núcleo, un restaurante recibiría instrucciones sobre
    // agentes extintores. Cada suscriptor puede editarlas después.
    reglasNegocio: REGLAS_EXTINTORES
  },
  venta_online: {
    etiqueta: 'Venta en línea / tienda',
    vertical: 'venta de productos en línea con entrega a domicilio',
    queVende: 'productos del catálogo de la tienda, con envío o entrega a domicilio',
    fuentePrecios: 'products',
    reglasNegocio: 'Cuando confirmes una compra, informa los medios de pago y el paso a seguir para el envío. Pide comprobante de pago cuando el cliente diga que ya pagó, y avisa que el pedido se despacha al confirmarse el pago.'
  },
  servicios: {
    etiqueta: 'Servicios profesionales',
    vertical: 'prestación de servicios profesionales con cita o agendamiento',
    queVende: 'servicios que se cotizan y se agendan con fecha y hora',
    fuentePrecios: 'products',
    reglasNegocio: 'El objetivo comercial es AGENDAR: propón fecha y hora concretas. Si el servicio requiere valoración previa, dilo y ofrece la cita de valoración. No prometas resultados del servicio.'
  },
  restaurante: {
    etiqueta: 'Restaurante / comidas',
    vertical: 'restaurante con venta a domicilio y en local',
    queVende: 'platos del menú, con domicilio o recogida en local',
    fuentePrecios: 'products',
    reglasNegocio: 'Toma el pedido plato por plato y confirma el total antes de cerrar. Pregunta si es para domicilio o para recoger. Informa el tiempo estimado de entrega si está en la base de conocimiento; si no está, no lo inventes.'
  },
  repuestos: {
    etiqueta: 'Repuestos y autopartes',
    vertical: 'venta de repuestos y autopartes',
    queVende: 'repuestos y autopartes del catálogo',
    fuentePrecios: 'products',
    reglasNegocio: 'Para cotizar un repuesto necesitas marca, modelo/línea y año del vehículo (o foto de la pieza): pídelos antes de dar precio. Si la referencia exacta no está en el catálogo, NO improvises equivalencias: escala. Aclara si el repuesto es original o alterno cuando el catálogo lo indique.'
  }
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
      // ✅ ANNY-NICHO-033 / ANNY-VENTA-034
      nicho: p.nicho || null,
      mediosPago: p.mediosPago || '',
      avisarVentaCliente: p.avisarVentaCliente === true,
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
    // ✅ ANNY-VENTA-034: venta REACTIVA. Anny no ofrece nada durante un
    // cobro (eso fue el bug del viernes), pero si el CLIENTE pide comprar
    // o cotizar, lo atiende y puede cerrar el pedido — un cliente que debe
    // y aún así quiere comprar no se manda a esperar un asesor.
    ventaReactiva: true,
    permitePedido: true,
    maxChars: 280,
    reglas: 'NO ofrezcas productos por iniciativa propia: el tema es el saldo, el medio de pago y la fecha. Si el cliente DISCUTE el valor, ESCALA. Si dice que YA PAGÓ, NO escales: es un reporte de pago — llena "comprobantePago" y el sistema avisa a tesorería (ANNY-PAGO-050). Si el cliente pide comprar o cotizar algo, atiéndelo con el catálogo y recuérdale amablemente que también quede pendiente el saldo.'
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
  // ✅ ANNY-VENTA-034: la suscriptora registra una venta y Anny le confirma
  // al cliente por WhatsApp: qué compró, cuánto es y cómo pagar. La
  // respuesta del cliente ("¿a qué cuenta?", "ya pagué") se atiende bajo
  // esta misma misión.
  CONFIRMACION_VENTA: {
    objetivo: 'Confirmar al cliente la compra que acaba de registrarse, informarle los medios de pago y resolver sus dudas sobre el pago o la entrega.',
    permiteVenta: false,
    ventaReactiva: true,
    permitePedido: true,
    maxChars: 300,
    reglas: 'El pedido YA está registrado: NO lo vuelvas a tomar ni abras uno nuevo por lo mismo. Resuelve dudas de pago y entrega con la base de conocimiento. Si dice que ya pagó, es un reporte de pago: llena "comprobantePago" y NUNCA confirmes tú que el pago quedó registrado. Si discute el valor, ESCALA.'
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

    // ✅ ANNY-VERTICAL-025 → ✅ ANNY-FUGA-035 (endurecido).
    // El parche anterior dejaba pasar el caso más común: tenant SIN perfil
    // configurado seguía heredando la base de extintores con precios y
    // dirección quemados. Ahora RESPUESTAS_BASE ya no tiene cifras, y aun
    // así NO se hereda nunca de forma automática: cada suscriptor arranca
    // con su base vacía y la construye en Entrenamiento.
    //
    // Consecuencia deliberada: un tenant sin nada configurado ya no tiene
    // atajos y todo pasa por el modelo con SU catálogo real. Prefiero que
    // Anny pregunte a que Anny cotice con la tarifa de otra empresa.
    const data = doc.exists ? (doc.data() || {}) : {};

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
// ------------------------------------------------------------
// ✅ ANNY-FUGA-035 / ANNY-PRECIO-036 — dos candados nuevos:
//
// 1) EL ATAJO NUNCA COTIZA. Este camino se resuelve ANTES del
//    modelo y ANTES de leer el catálogo del tenant, así que una
//    entrada con precio guardada aquí gana siempre contra la
//    tarifa real de `products`. Toda entrada de tipo PRECIO —o
//    cuyo texto contenga una cifra de dinero— se DESCARTA y el
//    mensaje pasa al modelo, que sí cotiza con el catálogo del
//    suscriptor. Esto neutraliza la contaminación YA persistida
//    en los documentos respuestasAnny de tenants existentes, sin
//    tener que borrarles nada.
//
// 2) PATRONES CORTOS FUERA. 'precio' (6 letras) hacía match con
//    cualquier mensaje que mencionara la palabra. Se exige un
//    patrón de al menos 8 caracteres o de 2+ palabras: frases que
//    un cliente escribe de verdad, no comodines.
// ============================================================
const RE_DINERO = /\$\s?\d|\d{4,}\s*(pesos|cop\b)|\bcop\s?\$?\s?\d/i;

function patronUtilizable(p) {
  const s = String(p || '').trim();
  if (s.length < 5) return false;
  return s.length >= 8 || s.includes(' ');
}

function buscarRespuestaConfigura(mensajeTexto, respuestas) {
  const texto = String(mensajeTexto || '').toLowerCase();

  for (const [key, config] of Object.entries(respuestas || {})) {
    if (!config || !config.respuesta || !Array.isArray(config.patrones)) continue;

    // Candado 1: el atajo no cotiza jamás.
    if (String(config.tipo || '').toUpperCase() === 'PRECIO') continue;
    if (RE_DINERO.test(String(config.respuesta))) continue;

    // Candado 2: solo patrones específicos.
    const patrones = config.patrones.filter(patronUtilizable);
    if (!patrones.length) continue;

    if (patrones.some(p => texto.includes(String(p).toLowerCase()))) {
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
// \u2705 ANNY-MULETILLA-042: relleno de apertura que la delata como bot.
// ------------------------------------------------------------
// "Perfecto", "Entendido", "Con mucho gusto" ya estaban PROHIBIDOS en el
// prompt, pero una prohibici\u00f3n en el prompt es una sugerencia: el modelo
// las volv\u00eda a poner. Aqu\u00ed se quitan mec\u00e1nicamente, despu\u00e9s de generar, as\u00ed
// que da igual si el modelo obedece o no.
//
// OJO: solo se eliminan al INICIO del mensaje y solo si va seguido de m\u00e1s
// texto. "Con mucho gusto" como respuesta completa a un "gracias" es una
// frase leg\u00edtima, no relleno, y esa no se toca.
const MULETILLAS = [
  'perfecto', 'entendido', 'excelente', 'claro que si', 'claro que s\u00ed', 'claro',
  'con mucho gusto', 'con gusto', 'listo', 'de acuerdo', 'por supuesto',
  'buenisimo', 'buen\u00edsimo', 'genial', 'que bueno', 'qu\u00e9 bueno',
  'muchas gracias por escribirnos', 'gracias por escribirnos',
  'gracias por contactarnos', 'gracias por tu mensaje', 'entiendo',
  'comprendo', 'muy bien', 'vale', 'ok', 'okey'
];

function quitarMuletillas(texto) {
  let t = String(texto || '').trim();

  // Hasta dos pasadas: "Perfecto, claro que s\u00ed, te cuento..." lleva dos.
  for (let i = 0; i < 2; i++) {
    const sinTilde = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let cortado = false;

    for (const m of MULETILLAS) {
      const mn = m.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      // Debe ir seguida de coma, punto o "!" \u2014 es decir, ser una apertura
      // suelta, no el comienzo de una frase con contenido.
      const re = new RegExp(`^${mn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,.!:]+\\s*`);
      const match = sinTilde.match(re);
      if (!match) continue;

      const resto = t.slice(match[0].length).trim();
      // Nunca dejar el mensaje vac\u00edo ni casi vac\u00edo: si lo \u00fanico que hab\u00eda
      // era la cortes\u00eda, se conserva tal cual.
      if (resto.length < 12) continue;

      t = resto.charAt(0).toUpperCase() + resto.slice(1);
      cortado = true;
      break;
    }
    if (!cortado) break;
  }

  return t;
}

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

  // ✅ ANNY-MULETILLA-042: se limpia el relleno ANTES de medir el largo, para
  // que los caracteres disponibles se gasten en contenido y no en cortesía.
  t = quitarMuletillas(t);

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
      .limit(500)
      .get();

    const items = [];
    snap.forEach(d => {
      const p = d.data();
      const precio = Number(p.precioVenta) || 0;
      if (p.nombre && precio > 0) {
        // ✅ ANNY-CATALOGO-045: alias = cómo lo dice el CLIENTE.
        // El catálogo está escrito en lenguaje de inventario
        // ("ABC 5 LB"); el cliente escribe "extintor de 5 libras del
        // carro". Sin puente entre los dos, el modelo no encuentra el
        // ítem y escala una venta que tenía ganada.
        const alias = []
          .concat(Array.isArray(p.alias) ? p.alias : [])
          .concat(Array.isArray(p.palabrasClave) ? p.palabrasClave : [])
          .map(a => String(a).trim())
          .filter(Boolean)
          .slice(0, 6);
        items.push({
          id: d.id,
          nombre: String(p.nombre).trim(),
          precio,
          categoria: p.categoria ? String(p.categoria).trim() : '',
          alias
        });
      }
    });

    // ⛔ ANNY-CATALOGO-045 — BUG CRÍTICO (corregido)
    // ------------------------------------------------------------
    // Aquí había `items.slice(0, 80)` DESPUÉS de ordenar
    // alfabéticamente. En un tenant con ~188 productos, Anny solo
    // veía de la A hasta cerca de la E: todo lo que empieza por
    // "Recarga" o "Señalización" quedaba FUERA del prompt.
    // Y el prompt ordena: "si no está en el catálogo, ESCALA".
    // Resultado: el negocio principal del tenant era invisible y
    // toda pregunta de precio terminaba escalada.
    //
    // Se ordena por CATEGORÍA y luego por nombre (agrupado se lee
    // mejor y el modelo relaciona mejor), y el tope sube a 250:
    // ~250 líneas cortas son ~3K tokens de entrada, costo marginal
    // frente a perder la venta.
    items.sort((a, b) =>
      (a.categoria || 'zzz').localeCompare(b.categoria || 'zzz') ||
      a.nombre.localeCompare(b.nombre)
    );
    const data = items.slice(0, 250);
    if (items.length > 250) {
      console.warn(`[ANNY] Tenant ${adminId} tiene ${items.length} productos activos: el catálogo se recortó a 250. Desactiva los que no vendas.`);
    }

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
// ✅ ANNY-MEMORIA-032: 8 → 20 turnos. Con 8, lo que el cliente dijo hace
// media conversación ("mi extintor es rojo") se caía de la ventana y Anny
// volvía a preguntarlo — el cliente siente que no lo escuchan y pide humano.
// Haiku es barato: 12 turnos más de contexto cuestan centavos y ahorran
// escalados.
async function obtenerHistorialReciente(adminId, telefono, limite = 20) {
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
// ✅ ANNY-SALUDO-037: identidad del interlocutor
// ------------------------------------------------------------
// El número de WhatsApp NO identifica a la persona: escribe la
// secretaria, el conductor, el jefe de seguridad. `pushName` de
// Baileys es el alias del celular ("Juan", "Mi Amor", "Torre 3"),
// no sirve para una orden de servicio ni para una factura.
//
// Anny se presenta y pregunta con quién habla y de qué empresa
// UNA sola vez, y el dato queda guardado en el chat: en los
// mensajes siguientes ya no lo vuelve a pedir. Es lo mismo que
// hace una asesora humana y es lo que alimenta el CRM.
// ============================================================
async function obtenerContactoChat(adminId, telefono) {
  try {
    const doc = await refChat(adminId, telefono).get();
    if (!doc.exists) return { nombre: null, empresa: null, presentada: false };
    const d = doc.data() || {};
    return {
      nombre: d.contactoNombre || null,
      empresa: d.contactoEmpresa || null,
      presentada: d.annySePresento === true
    };
  } catch (err) {
    console.error('[ANNY] Error leyendo contacto del chat:', err.message);
    return { nombre: null, empresa: null, presentada: false };
  }
}

async function guardarContactoChat(adminId, telefono, contacto = {}) {
  try {
    const patch = {};
    // Solo se escribe lo que el modelo REALMENTE extrajo. Un string vacío o
    // un "no sé" no puede pisar un dato bueno guardado antes.
    const limpio = v => {
      const s = String(v || '').trim();
      if (s.length < 2 || s.length > 80) return null;
      if (/^(no|n\/a|na|ninguna|ninguno|nose|no se|null|undefined)$/i.test(s)) return null;
      return s;
    };
    const nombre = limpio(contacto.nombre);
    const empresa = limpio(contacto.empresa);
    if (nombre) patch.contactoNombre = nombre;
    if (empresa) patch.contactoEmpresa = empresa;
    if (contacto.presentada) patch.annySePresento = true;
    if (!Object.keys(patch).length) return;
    await refChat(adminId, telefono).set(patch, { merge: true });
  } catch (err) {
    // Nunca bloquea la conversación: es enriquecimiento del CRM.
    console.error('[ANNY] Error guardando contacto del chat:', err.message);
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
// ✅ ANNY-DICC-049 — DICCIONARIO DE PALABRAS CLAVE
// ------------------------------------------------------------
// PROBLEMA REAL: el catálogo está escrito en lenguaje de
// inventario ("RECARGA EXTINTOR ABC 5 LB") y el cliente escribe
// "cuanto vale recargar el del carro". Sin puente entre los dos,
// el modelo no encuentra el ítem, y el prompt le ordena escalar.
// Esa era la razón de fondo por la que Anny dejó de cotizar.
//
// POR QUÉ NO SE VUELVE A PONER EL PRECIO EN ENTRENAMIENTO:
// serían dos fuentes de verdad para el mismo número. El día que
// el suscriptor suba tarifas, Anny seguiría cotizando la vieja.
// Además el candado de buscarRespuestaConfigura (ANNY-FUGA-035)
// descarta toda entrada con cifras, así que ni siquiera se leería.
//
// SOLUCIÓN: el suscriptor mapea PALABRAS → PRODUCTO del catálogo.
// El precio se lee VIVO del catálogo en cada mensaje. Se cambia
// una tarifa en Inventario y Anny la usa en el siguiente mensaje,
// sin tocar el diccionario.
//
// Estructura: diccionarioAnny/{adminId} = {
//   [productoId]: { nombre, palabras: ['del carro', '5 libras'] }
// }
// ============================================================
const _cacheDiccionario = new Map();

async function obtenerDiccionarioTenant(adminId) {
  const cached = _cacheDiccionario.get(adminId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;
  try {
    const doc = await db.collection('diccionarioAnny').doc(adminId).get();
    const data = doc.exists ? (doc.data() || {}) : {};
    _cacheDiccionario.set(adminId, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error('[ANNY] Error leyendo diccionario:', err.message);
    return {};
  }
}

function invalidarCacheDiccionario(adminId) {
  _cacheDiccionario.delete(adminId);
}

// Sin tildes y sin puntuación: "recargá el del carró" ≡ "recarga el del carro"
function normalizarTextoBusqueda(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Una palabra clave de 1-2 caracteres haría match con cualquier cosa.
function palabraClaveUtil(p) {
  const n = normalizarTextoBusqueda(p);
  return n.length >= 4;
}

function resolverPorPalabrasClave(mensajeTexto, diccionario, catalogo) {
  const texto = normalizarTextoBusqueda(mensajeTexto);
  if (!texto || !diccionario) return [];

  const porId = new Map((catalogo || []).map(p => [p.id, p]));
  const encontrados = [];

  for (const [productoId, entrada] of Object.entries(diccionario)) {
    if (!entrada || !Array.isArray(entrada.palabras)) continue;

    const palabras = entrada.palabras.filter(palabraClaveUtil);
    if (!palabras.length) continue;

    // La palabra clave más LARGA que coincida gana: "extintor de carro
    // 10 libras" es más específico que "extintor" y debe mandar.
    let mejor = null;
    for (const p of palabras) {
      const n = normalizarTextoBusqueda(p);
      if (texto.includes(n) && (!mejor || n.length > mejor.length)) mejor = n;
    }
    if (!mejor) continue;

    const prod = porId.get(productoId);
    if (!prod) {
      // El producto se borró o se desactivó en Inventario. No se
      // inventa un precio: se avisa en log para depurar el diccionario.
      console.warn(`[ANNY-DICC] La palabra "${mejor}" apunta al producto ${productoId}, que ya no está activo en el catálogo`);
      continue;
    }

    encontrados.push({
      nombre: prod.nombre,
      precio: prod.precio,
      coincidio: mejor,
      especificidad: mejor.length
    });
  }

  return encontrados
    .sort((a, b) => b.especificidad - a.especificidad)
    .slice(0, 5);
}

function formatearResueltos(resueltos) {
  if (!resueltos || !resueltos.length) return '';
  return resueltos
    .map(r => `- El cliente dijo "${r.coincidio}" → ${r.nombre}: $${r.precio.toLocaleString('es-CO')}`)
    .join('\n');
}

// ============================================================
// ✅ ANNY-COMPROMISO-047 — plazo real en vez de promesa vaga.
// ------------------------------------------------------------
// Horario de atención por defecto (Colombia, UTC-5):
//   L-V 8:30-17:30 · Sáb 9:00-12:00 · Dom cerrado
// Dentro de horario compromete ~30 min; fuera de horario dice
// cuándo se retoma. Nunca promete inmediatez que no se cumple.
// ============================================================
function compromisoDeRespuesta(ahora = new Date()) {
  try {
    const co = new Date(ahora.getTime() - 5 * 3600 * 1000);
    const dia = co.getUTCDay(); // 0 dom … 6 sáb
    const min = co.getUTCHours() * 60 + co.getUTCMinutes();

    const esHabil = dia >= 1 && dia <= 5;
    const esSabado = dia === 6;
    const abre = esHabil ? 8 * 60 + 30 : (esSabado ? 9 * 60 : null);
    const cierra = esHabil ? 17 * 60 + 30 : (esSabado ? 12 * 60 : null);

    if (abre !== null && min >= abre && min <= cierra - 30) {
      const t = new Date(co.getTime() + 30 * 60 * 1000);
      let h = t.getUTCHours();
      const m = String(t.getUTCMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'p.m.' : 'a.m.';
      h = h % 12 || 12;
      return `Te escribe antes de las ${h}:${m} ${ampm}`; // 'a.m.'/'p.m.' ya trae el punto final
    }

    if (dia === 6 && min > cierra - 30) return 'Te escribe el lunes a primera hora.';
    if (dia === 0) return 'Te escribe el lunes a primera hora.';
    if (esHabil && min > cierra - 30) {
      return dia === 5
        ? 'Ya cerramos por hoy: te escribe mañana sábado en la mañana.'
        : 'Ya cerramos por hoy: te escribe mañana a primera hora.';
    }
    return 'Te escribe apenas abramos, a las 8:30 a.m.';
  } catch (err) {
    return 'Te escribe un asesor en el transcurso del día.';
  }
}

// ============================================================
// ✅ ANNY-ORDEN-046 — Anny no veía las ÓRDENES DE SERVICIO.
// ------------------------------------------------------------
// CAUSA RAÍZ del caso "La cita programada para hoy, ¿en qué
// horario quedó?" → escalado → cliente cancela.
//
// `obtenerEstadoPedidoHilo` solo mira `pedidosAnny`: los pedidos
// que tomó la propia Anny. Las órdenes que crea el equipo en
// Control360 viven en `orders` y Anny NUNCA las consultaba. Como
// el prompt ordena "si no consta en el sistema, ESCALA", una
// pregunta cuya respuesta el sistema TENÍA (fechaProgramada +
// horaProgramada) terminaba en un escalado.
//
// Solo lectura. No cambia estados, no crea nada, no toca taller
// ni logística: alimenta el prompt con hechos verificables.
// ============================================================
const ESTADOS_ORDEN_LEGIBLE = {
  programada: 'Programada',
  taller: 'En taller',
  despacho: 'En despacho',
  facturar: 'Por facturar',
  completada: 'Completada',
  cxc: 'Completada (con saldo pendiente)',
  anulada: 'Anulada'
};

async function obtenerOrdenesServicio(adminId, telefonoRaw) {
  try {
    const tel = normalizarTelefonoAnny(telefonoRaw);
    if (!tel || !adminId) return [];

    const variantes = [tel, `57${tel}`];
    const vistos = new Set();
    const ordenes = [];

    for (const v of variantes) {
      const snap = await db.collection('orders')
        .where('adminId', '==', adminId)
        .where('clienteCelular', '==', v)
        .limit(20)
        .get();

      snap.forEach(d => {
        if (vistos.has(d.id)) return;
        vistos.add(d.id);
        const o = d.data();
        if (o.estado === 'anulada') return;
        ordenes.push({
          numero: o.numeroOrden || '',
          estado: ESTADOS_ORDEN_LEGIBLE[o.estado] || o.estado || 'Sin estado',
          fechaProgramada: o.fechaProgramada || null,
          horaProgramada: o.horaProgramada || null,
          total: Number(o.total) || 0,
          saldo: Math.max(0, (Number(o.total) || 0) - (Number(o.montoPagado) || 0)),
          creadaMs: (o.createdAt?.seconds || 0) * 1000
        });
      });
    }

    ordenes.sort((a, b) => b.creadaMs - a.creadaMs);
    return ordenes.slice(0, 3);
  } catch (err) {
    console.error('[ANNY] Error leyendo órdenes de servicio:', err.message);
    return [];
  }
}

// ============================================================
// ✅ ANNY-PAGO-050 — constancia de pago reportado por el cliente.
// ------------------------------------------------------------
// ADITIVO Y NO DESTRUCTIVO, a propósito:
// - NO cambia el estado de la orden
// - NO mueve caja ni CxC
// - NO marca la orden como pagada
// Solo escribe el campo `pagoReportadoAnny` para que tesorería vea
// que hay un soporte esperando validación. Aplicar el pago sigue
// siendo un acto humano con un click, como debe ser.
// ============================================================
async function registrarPagoReportado(adminId, telefonoRaw, datos) {
  try {
    const tel = normalizarTelefonoAnny(telefonoRaw);
    if (!tel || !adminId) return null;

    const variantes = [tel, `57${tel}`];
    let candidatas = [];

    for (const v of variantes) {
      const snap = await db.collection('orders')
        .where('adminId', '==', adminId)
        .where('clienteCelular', '==', v)
        .limit(20)
        .get();
      snap.forEach(d => {
        const o = d.data();
        if (o.estado === 'anulada') return;
        const saldo = (Number(o.total) || 0) - (Number(o.montoPagado) || 0);
        candidatas.push({ ref: d.ref, numero: o.numeroOrden || d.id, saldo, creadaMs: (o.createdAt?.seconds || 0) * 1000 });
      });
    }

    if (!candidatas.length) return null;

    // Preferir la orden con saldo pendiente; si hay varias, la más reciente.
    candidatas.sort((a, b) => (b.saldo > 0) - (a.saldo > 0) || b.creadaMs - a.creadaMs);
    const elegida = candidatas[0];

    await elegida.ref.set({
      pagoReportadoAnny: {
        reportadoMs: Date.now(),
        monto: datos.monto || null,
        fecha: datos.fecha || null,
        banco: datos.banco || null,
        referencia: datos.referencia || null,
        telefono: tel,
        validado: false
      }
    }, { merge: true });

    return { numero: elegida.numero, saldo: elegida.saldo };
  } catch (err) {
    console.error('[ANNY] Error registrando pago reportado:', err.message);
    return null;
  }
}

function formatearOrdenes(ordenes) {
  if (!ordenes || !ordenes.length) {
    return '(este cliente no tiene órdenes de servicio registradas en Control360)';
  }
  return ordenes.map(o => {
    const cita = o.fechaProgramada
      ? `agendada para el ${o.fechaProgramada}${o.horaProgramada ? ` a las ${o.horaProgramada}` : ' (hora por confirmar con el mensajero)'}`
      : 'sin fecha agendada';
    const saldo = o.saldo > 0 ? ` · saldo pendiente $${o.saldo.toLocaleString('es-CO')}` : '';
    return `- Orden ${o.numero}: ${o.estado}, ${cita} · total $${o.total.toLocaleString('es-CO')}${saldo}`;
  }).join('\n');
}

// ============================================================
// FIX ANNY-CIERRE-007 + v22: Claude decide.
// Motor único: PERFIL (quién es) × MISIÓN (a qué vino).
// ============================================================
async function claudeDecide(adminId, clienteNombre, mensajeTexto, respuestas = {}, historial = [], fichaCliente = { existe: false }, catalogo = [], perfil = PERFIL_DEFAULT, misionNombre = 'ATENCION', estadoPedido = { existe: false }, defectoPendiente = null, imagenAdjunta = null, contactoChat = { nombre: null, empresa: null, presentada: false }, ordenesServicio = [], resueltos = []) {
  try {
    const mision = obtenerMision(misionNombre);

    // ✅ ANNY-SALUDO-037: primer contacto = no hay historial y Anny nunca se
    // ha presentado en este chat. Solo aplica en ATENCION: en una cobranza o
    // un aviso de taller la conversación la abrió ella, presentarse otra vez
    // sonaría a que no recuerda lo que acaba de escribir.
    const esPrimerContacto =
      misionNombre === 'ATENCION' &&
      (historial || []).length === 0 &&
      !contactoChat.presentada;

    // El saludo + la pregunta de identificación no caben en 220 caracteres
    // junto con la respuesta. Se amplía SOLO en ese primer mensaje.
    const maxChars = esPrimerContacto ? Math.max(mision.maxChars, 320) : mision.maxChars;

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

    // ✅ ANNY-REPETICION-043: el historial ya trae sus mensajes, pero mezclados
    // con los del cliente el modelo los "lee" y aun así repite. Aquí se le
    // ponen SUS PROPIAS frases aparte y en negativo: esto ya salió, no vuelve
    // a salir. Es la queja concreta de la dueña: Anny repite lo que ya dijo.
    const misMensajes = (historial || [])
      .filter(t => t.rol === 'anny' && t.texto)
      .slice(-5)
      .map(t => `· "${String(t.texto).slice(0, 140)}"`);

    const yaDicho = misMensajes.length ? `
LO QUE TÚ YA LE ESCRIBISTE A ESTE CLIENTE (PROHIBIDO REPETIRLO):
${misMensajes.join('\n')}
→ Ninguna de estas ideas puede volver a aparecer en tu mensaje: ni igual, ni reformulada, ni "recordándosela". Si ya lo dijiste, ese punto está cerrado. Tu mensaje debe APORTAR ALGO NUEVO — si no tienes nada nuevo que aportar, haz la única pregunta que falta para avanzar, y nada más.
` : '';

    // ANNY-CFG-010: catálogo solo si el perfil lo declara
    // ✅ ANNY-MISION-028: en misiones SIN venta (COBRANZA, TALLER, SAAS) el
    // catálogo NO entra al prompt. Tenerlo a la vista era la tentación:
    // el modelo respondía un cobro ofreciendo recargas. Sin catálogo no
    // hay nada que ofrecer.
    // ✅ ANNY-VENTA-034: el catálogo también entra en misiones con venta
    // reactiva (el cliente puede pedir comprar en medio de un cobro).
    // ✅ ANNY-DICC-049: solo tiene sentido donde Anny puede cotizar.
    const resueltosTxt = (mision.permiteVenta || mision.ventaReactiva)
      ? formatearResueltos(resueltos)
      : '';

    const catalogoTxt = (perfil.fuentePrecios === 'products' && (mision.permiteVenta || mision.ventaReactiva))
      ? (catalogo || []).map(p => {
          const ali = (p.alias && p.alias.length) ? ` (también: ${p.alias.join(', ')})` : '';
          const cat = p.categoria ? `[${p.categoria}] ` : '';
          return `- ${cat}${p.nombre}: $${p.precio.toLocaleString('es-CO')}${ali}`;
        }).join('\n')
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
EL CLIENTE ENVIÓ UNA FOTO (la estás viendo arriba). CLASIFÍCALA PRIMERO — hay tres casos y se responden distinto:

CASO A · LA FOTO TIENE QUE VER CON NUESTRO NEGOCIO (un equipo, una etiqueta, un extintor, un producto, un sitio que hay que señalizar, algo que quiere cotizar):
- Descríbele lo que identificas y PÍDELE QUE CONFIRME antes de usarlo. Ejemplo: "Veo [lo que sea que identifiques], ¿es correcto?".
- Si no se lee bien o dudas de algún dato, DILO y pide otra foto más cerca. NO adivines.
- Si ves varios artículos, di cuántos cuentas y pide confirmación.
- NUNCA cierres un pedido con datos que solo salieron de una foto sin que el cliente los haya confirmado por texto.
- Relaciona lo que ves con el CATÁLOGO de arriba. ESCALA (tipo PRECIO) solo cuando el cliente confirme que quiere ese producto/servicio y no tengas precio para dárselo.

CASO B · ES UN COMPROBANTE DE PAGO — ver la sección de pagos más abajo.

CASO C · LA FOTO NO TIENE NADA QUE VER CON NUESTRO NEGOCIO (ANNY-FOTO-053):
Publicidad de otro negocio, el menú de un restaurante, una promoción, una tarjeta de presentación, un volante, un saludo, una cadena, un meme, un sticker, una foto personal o familiar.
- Responde en UNA sola frase: agradece con cordialidad y cierra. Ejemplo: "¡Gracias por compartirlo! Cualquier cosa que necesites, aquí estoy."
- NO preguntes qué necesita con esa foto: es evidente que no necesita nada, solo la compartió.
- NO la relaciones con el catálogo ni ofrezcas productos. Nadie manda el menú de su restaurante para que le vendan un extintor.
- NO ESCALES. Esto no necesita un asesor, necesita educación. Escalar un menú del día por WhatsApp le hace perder el tiempo al equipo y le enseña a la gente a ignorar los avisos.
- Pon "escalado": false y "tipo": "INFO".

` : '';

    // ✅ ANNY-PAGO-050 (ampliado): el reporte de pago no siempre viene con
    // foto. "Ya te consigné", "hice la transferencia esta mañana" es
    // exactamente el mismo hecho de negocio y merece el mismo trato:
    // acuse honesto al cliente + aviso a tesorería, sin escalar.
    const bloquePago = `
CUANDO EL CLIENTE REPORTA UN PAGO (ANNY-PAGO-050) — con foto o sin ella:
Cuenta como reporte de pago un comprobante de transferencia, consignación, pantallazo de Nequi, Daviplata, Bancolombia, Davivienda o PSE, un recibo de caja, y también un mensaje de texto donde el cliente AFIRMA que ya pagó ("ya te consigné", "hice la transferencia", "ya quedó el pago", "te mandé la plata").
- Llena "comprobantePago" con lo que tengas: monto, fecha, banco o billetera, referencia. Lo que no sepas, va en null. NO adivines cifras ni fechas.
- Pon "escalado": false y deja "respuesta" vacía. El texto para el cliente lo pone el sistema, no tú: es la frase donde una palabra de más cuesta plata.
- NUNCA escribas que el pago quedó recibido, aplicado, confirmado, abonado o registrado. Tú no ves la cuenta bancaria de la empresa. Quien valida es tesorería.
- SOLO cuenta si el pago YA se hizo. "Mañana te pago", "voy a consignar" o "¿a qué cuenta te consigno?" NO son reportes de pago: eso se responde normal.
- Si dudas de si una foto es un comprobante, trátala como comprobante: es preferible que tesorería reciba un soporte de más a que se pierda uno.
`;

    // ✅ ANNY-SALUDO-037: presentación e identificación del interlocutor.
    const bloquePresentacion = esPrimerContacto ? `
PRIMER MENSAJE DE ESTA CONVERSACIÓN — PRESÉNTATE:
- Abre EXACTAMENTE con esta idea: "Hola, soy ${perfil.nombreAgente}, asistente virtual de ${perfil.empresa}." Puedes ajustar la redacción, pero tu nombre y el de la empresa van sí o sí.
- Enseguida responde lo que el cliente te preguntó (si preguntó algo). No lo dejes esperando por presentarte.
- Cierra pidiendo identificarse en UNA sola pregunta natural: con quién tienes el gusto y de qué empresa escribe. Ejemplo: "¿Con quién tengo el gusto y de qué empresa me escribes?".
- Si el cliente solo saludó, ese mensaje es completo así: preséntate, pregunta en qué le colaboras y con quién hablas.
${fichaCliente && fichaCliente.existe ? '- OJO: este cliente YA está registrado (ver ficha). Preséntate y salúdalo POR SU NOMBRE. NO le preguntes de qué empresa es: ya lo sabes.' : ''}
` : (contactoChat.nombre || contactoChat.empresa ? `
QUIÉN TE ESCRIBE (ya identificado, NO lo vuelvas a preguntar):
${contactoChat.nombre ? `- Persona: ${contactoChat.nombre}` : ''}
${contactoChat.empresa ? `- Empresa: ${contactoChat.empresa}` : ''}
` : `
IDENTIFICACIÓN PENDIENTE:
- Todavía no sabes con quién hablas. Si ya lo preguntaste una vez y no te respondieron, NO insistas: sigue atendiendo y pídelo al momento de cerrar el pedido.
`);

    // ✅ ANNY-COTIZA-038: cómo cotizar sin volverse un interrogatorio.
    // CAUSA DEL PROBLEMA: la regla "nunca inventes precios" empujaba al
    // modelo a exigir tipo + capacidad ANTES de decir nada. El cliente que
    // no sabe qué extintor tiene (la mayoría) quedaba atascado y se iba.
    // REGLA NUEVA: primero se da el precio del caso típico, señalado como
    // tal, y se pide confirmar el dato. Se informa sin comprometerse.
    const bloqueCotizacion = (mision.permiteVenta || mision.ventaReactiva) ? `
CÓMO COTIZAR (ANNY-COTIZA-038 — regla anti-interrogatorio):
- PROHIBIDO responder una pregunta de precio con puras preguntas. Es la queja número uno de los clientes.
- Cuando pregunten "¿cuánto vale?" y no tengas el detalle exacto, RESPONDE CON EL CASO TÍPICO Y PIDE CONFIRMACIÓN EN EL MISMO MENSAJE. Nunca lo dejes esperando por un dato técnico que probablemente no conoce.
- Deduce el producto a partir del USO o del sitio que el cliente menciona (mira las REGLAS PROPIAS DE ESTA EMPRESA, que traen los casos típicos del negocio). Preséntalo siempre como lo más común, jamás como un hecho: "por lo general es..., ¿me confirmas?".
- El precio dado sobre un supuesto es ESTIMADO y debes decirlo: "confirmando ese dato te doy el valor en firme".
- Si el cliente no sabe nada del producto, pídele UNA foto. Es más fácil para él que responder preguntas técnicas.
- Los precios salen ÚNICAMENTE del catálogo de arriba, textuales. Si el catálogo no tiene ese ítem, no lo inventes: ESCALA (tipo PRECIO).

QUÉ PREGUNTAR PRIMERO (orden correcto):
1. CUÁNTAS unidades son y para qué uso o en qué sitio. Eso es lo que define la venta.
2. Con eso ya das el estimado y pides confirmar el detalle técnico.
3. Los datos de facturación van AL FINAL, cuando el cliente ya dijo que sí.
- Nunca arranques pidiendo especificaciones técnicas. Eso espanta al cliente.
` : '';

    const prompt = `
Eres ${perfil.nombreAgente}, ASESORA COMERCIAL INTEGRAL de ${perfil.empresa}, empresa de ${perfil.vertical}. Atiendes por WhatsApp.

QUIÉN ERES (ANNY-PERFIL-041):
- Eres una ejecutiva senior, no una recepcionista ni un bot de preguntas frecuentes. Manejas el negocio completo: atiendes, asesoras, cotizas, cierras ventas, haces seguimiento y gestionas cartera.
- Escribes como una profesional con criterio y con poco tiempo: clara, directa, cálida, sin adornos. Vas al punto porque sabes la respuesta, no porque tengas afán.
- Tienes CRITERIO PROPIO: si el cliente no sabe qué necesita, tú se lo propones con base en lo que te cuenta. No le trasladas el trabajo de averiguarlo.
- Nunca suenas a máquina, a catálogo ni a call center. Suenas a la persona que resuelve.
${mision.permiteVenta ? 'En esta conversación vendes, pero primero ATIENDES: resuelves lo que el cliente pregunta.' : (mision.ventaReactiva ? 'En esta conversación viniste a un trámite puntual: te centras en él, y solo vendes si el cliente te lo pide.' : 'En esta conversación NO eres vendedora: viniste a un trámite puntual y te limitas a él.')}

QUÉ OFRECE LA EMPRESA: ${perfil.queVende}

MISIÓN DE ESTA CONVERSACIÓN: ${misionNombre}
Objetivo: ${mision.objetivo}
Reglas de la misión: ${mision.reglas}
${mision.permiteVenta ? '' : (mision.ventaReactiva ? `VENTA SOLO REACTIVA (ANNY-VENTA-034):
- NO ofrezcas productos ni servicios por iniciativa propia: viniste a un trámite (míralo en el historial) y la respuesta del cliente es sobre ESO. Continúa ese hilo.
- Si el cliente pregunta otra cosa puntual (horario, dirección), respóndela en una frase y vuelve al trámite pendiente.
- EXCEPCIÓN: si el CLIENTE pide comprar o cotizar algo, sí lo atiendes con el catálogo y puedes cerrar el pedido. Atendida la compra, recuérdale con amabilidad el tema pendiente.` : `EN ESTA MISIÓN NO VENDES (regla absoluta — ANNY-MISION-028):
- NO ofrezcas productos ni servicios, NO cites precios de catálogo, NO abras pedidos.
- CONTINÚA EL HILO con el que se abrió esta conversación (míralo en el historial). La respuesta del cliente es sobre ESO.
- Si el cliente pregunta otra cosa puntual (horario, dirección), respóndela en una frase y vuelve al trámite pendiente.
- Si el cliente por su propia iniciativa quiere comprar algo, dile que con gusto le ayudas apenas cierren este tema, y ESCALA (tipo VENTA) para que un asesor lo atienda.`)}

HISTORIAL RECIENTE DE LA CONVERSACIÓN (viejo → nuevo):
${hilo || '(primera interacción con este cliente)'}
${yaDicho}

NUEVO MENSAJE del cliente ${clienteNombre}: "${mensajeTexto}"

FICHA DEL CLIENTE:
${fichaTxt}

ESTADO REAL DEL PEDIDO (única fuente válida — el sistema, no tu memoria):
${estadoTxt}

ÓRDENES DE SERVICIO DE ESTE CLIENTE EN CONTROL360 (ANNY-ORDEN-046 — dato real del sistema):
${formatearOrdenes(ordenesServicio)}

${resueltosTxt ? `LO QUE EL CLIENTE ESTÁ PIDIENDO — YA RESUELTO (ANNY-DICC-049):
El suscriptor configuró estas palabras clave. El precio de abajo es el VIGENTE del catálogo, leído ahora mismo.
${resueltosTxt}
REGLA: si el ítem aparece aquí, YA TIENES EL PRECIO. Dalo directo y con naturalidad, sin rodeos y sin pedir especificaciones técnicas primero. NO escales por precio. NO cambies la cifra. Si hay varias opciones arriba, ofrece la más específica y menciona la alternativa en la misma frase.
` : ''}
${catalogoTxt ? `CATÁLOGO OFICIAL DE PRODUCTOS Y PRECIOS VIGENTES (única fuente válida de precios):\n${catalogoTxt}` : (mision.permiteVenta ? '(esta empresa NO maneja catálogo de productos físicos — no inventes productos ni precios)' : '(en esta misión NO tienes catálogo: no cites productos ni precios)')}

BASE DE CONOCIMIENTO DE LA EMPRESA (domicilio, horarios, medios de pago, políticas):
${conocimiento || '(sin datos configurados)'}
→ ✅ ANNY-ENTRENA-030: esta base la escribió la DUEÑA del negocio y es la fuente de verdad. Si el mensaje del cliente coincide con una entrada, tu respuesta debe salir de ESA entrada (adáptala al hilo, pero sin cambiarle datos, condiciones ni sentido). NO la parafrasees hasta perder la información ni respondas con tu criterio si aquí ya hay una respuesta definida.
${perfil.reglasNegocio ? `\nREGLAS PROPIAS DE ESTA EMPRESA:\n${perfil.reglasNegocio}` : ''}

${bloquePresentacion}
${bloqueCotizacion}
FORMA DE ESCRIBIR (obligatorio — ANNY-BREV-011):
- MÁXIMO ${maxChars} caracteres. UN solo mensaje. Si no cabe, prioriza y calla el resto.
- PROHIBIDO: listas, viñetas, guiones, símbolos ✓ ✅ •, títulos en MAYÚSCULA sostenida, y bloques tipo "VENTAJAS:" o "INVERSIÓN:". Escribe en prosa, como una persona por WhatsApp.
- ✅ ANNY-MULETILLA-042 — ARRANCA CON CONTENIDO, NUNCA CON CORTESÍA.
  PROHIBIDO abrir con: "Perfecto", "Entendido", "Excelente", "Claro que sí", "Con mucho gusto", "Listo", "Muy bien", "Entiendo", "Gracias por escribirnos".
  Tu primera palabra debe ser parte de la respuesta. Ejemplo de lo que NO se hace: "Perfecto, la recarga ABC de 10 lb está en $X". Así se hace: "La recarga ABC de 10 lb está en $X".
  (Estas aperturas se eliminan automáticamente después de que escribas, así que ponerlas solo te gasta caracteres.)
- PROHIBIDO repetir un resumen o confirmación que ya aparezca en el historial. Si ya lo dijiste, no lo repitas: avanza.
- Máximo UNA pregunta por mensaje.
- ✅ ANNY-PERFIL-041 — CADA MENSAJE TIENE QUE APORTAR ALGO NUEVO: un dato, un precio, una propuesta o la única pregunta que falta. Un mensaje que no aporta nada no se envía; en su lugar, avanza al siguiente paso.
- ✅ ANNY-REPETICION-023 — REGLA ANTI-LORA (crítica):
  Lee tus propios mensajes en el historial. Si YA hiciste esta misma pregunta (aunque con otras palabras), está PROHIBIDO volver a hacerla.
  · Si el cliente respondió algo corto o vago ("por favor", "sí", "listo"), NO repitas la pregunta: reformúlala de otra forma, más simple y concreta, o da la opción más común y pide que confirme.
  · Si ya la hiciste DOS veces y el cliente sigue sin darte el dato, deja de preguntar y ESCALA (tipo DATOS). Una persona no pregunta lo mismo tres veces: llama o pasa el caso.
  · Nunca abras con "Perfecto, entiendo que..." repitiendo lo que el cliente acaba de decir. Eso es lo que te delata como máquina.
- Sonar profesional NO es escribir largo: es saber la respuesta y darla directo.
- ✅ ANNY-PROMESA-029 — PROHIBIDO prometer acciones futuras que tú no puedes ejecutar: "permíteme revisar", "déjame verificar", "ya te confirmo", "dame un momento". Tú NO puedes revisar nada después de este mensaje. Lo que sabes, lo dices AHORA; lo que no sabes, lo admites y escalas. Un "permíteme revisar" tras el cual no pasa nada destruye la confianza del cliente.

REGLAS DE ATENCIÓN (prioridad máxima):
- Responde PRIMERO lo que el cliente pregunta en su último mensaje. Si cambió de tema, síguelo — NO insistas en vender.
- Si pregunta cómo pagar → medios de pago, confirma valor y CIERRA. No ofrezcas más productos.
- Si ya hay un pedido abierto, NO inicies otro: solo resuelve dudas de ese pedido.
- NUNCA pidas un dato que ya esté en el historial o en la ficha. Si está, confírmalo.
- Cada dato faltante se pide máximo UNA vez más en toda la conversación.
- NO saludes de nuevo en conversación en curso.

REGLA DE ESTADO (ANNY-ESTADO-013 + ANNY-ORDEN-046 — crítica):
- NUNCA afirmes que un pedido está listo, despachado, en camino o entregado. Tú NO ves el taller ni la logística.
- Si existe pedido, puedes mencionar únicamente el estado literal que aparece arriba. Nada más.
- Si el cliente pregunta por SU CITA, SU VISITA, SU ORDEN o "en qué horario quedó": mira el bloque ÓRDENES DE SERVICIO. Ahí está la respuesta y se la das textual (número de orden, estado, fecha y hora). NO escales algo que el sistema ya te está mostrando.
- Si la orden aparece SIN hora agendada, dilo tal cual: "quedó para el <fecha>, la hora la confirma el mensajero el mismo día". Eso es un dato honesto, no un motivo para escalar.
- Solo escalas (tipo SERVICIO) si el cliente pregunta por algo que NO aparece ni en el pedido ni en las órdenes de arriba.

CIERRE DE PEDIDO (regla anti-estancamiento):
- Mínimos REALES: producto/servicio + nombre + dirección de entrega. El teléfono ya lo tienes (este chat).
- Cédula/NIT, correo y fecha NO bloquean: si tras pedirlos una vez no los da, CONFIRMA igual y lístalos en "datosPendientes".
- Es mejor un pedido confirmado con datos pendientes que una venta perdida por preguntar de más.
- No estires la conversación: apenas tengas los mínimos, cierra.

ESCALAR A ADMIN si:
- El cliente pide hablar con una persona, asesor o humano, o se queja de la IA (ESCALA SIEMPRE, sin excepción)
- Solicita descuento/promoción especial
- Pide CAMBIAR la fecha/horario de un servicio ya agendado (consultarla NO se escala: está en ÓRDENES DE SERVICIO)
- Pregunta por precio o producto que NO está en el catálogo, ni en el bloque YA RESUELTO, ni en la base de conocimiento
- Requiere capacitación
- Tiene queja/problema
- Pregunta sobre facturación legal/documentos
- Pregunta por el estado de algo que no consta en el sistema

REGLA CRÍTICA: NUNCA inventes precios, direcciones, estados ni datos. Si el dato no está, escala.

PEDIDO CONFIRMADO: ${mision.permitePedido ? 'cuando el cliente confirme la compra Y tengas los mínimos, incluye el objeto "pedido". Si faltan los mínimos o falta confirmación, "pedido" debe ser null.' : 'en esta misión "pedido" SIEMPRE debe ser null.'}

${bloqueDefecto}
${bloqueImagen}
${bloquePago}

Responde SOLO en JSON (sin markdown):
{
  "escalado": boolean,
  "tipo": "PRECIO|SERVICIO|DATOS|PAGO|NEGOCIACION|CAPACITACION|PROBLEMA|VENTA|HUMANO|OTRO",
  "respuesta": "tu respuesta si NO escalado",
  "razon": "por qué escalas (si escalado)",
  "comprobantePago": null | { "monto": "valor o null", "fecha": "fecha o null", "banco": "banco o billetera o null", "referencia": "referencia o null" },${defectoPendiente ? '\n  "respuestaTaller": "APROBADO" | "RECHAZADO" | null,' : ''}
  "contacto": { "nombre": "nombre de la persona SI lo dijo en este mensaje, si no null", "empresa": "empresa que representa SI la dijo, si no null" },
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

    // ✅ ANNY-CONSUMO-026: consumo real de ESTE mensaje, por suscriptor.
    // Es lo que permite facturarle a cada uno según lo que gastó, en vez de
    // mirar un total agregado en la consola de Anthropic que no se puede
    // repartir. No se hace await: no debe demorar la respuesta al cliente.
    try {
      annyConsumo.registrarConsumo(adminId, {
        inputTokens: message.usage?.input_tokens || 0,
        outputTokens: message.usage?.output_tokens || 0,
        conImagen: !!imagenAdjunta,
      });
    } catch (e) { /* el contador nunca puede tumbar la conversación */ }

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
      decision.respuesta = recortarRespuesta(decision.respuesta, maxChars);
    }
    // ✅ ANNY-SALUDO-037: se marca para no volver a presentarse en este chat.
    decision._primerContacto = esPrimerContacto;
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
    // ✅ ANNY-FOTO-031: el cliente mandó una foto pero NO llegó al
    // modelo (no se pudo descargar, pesa >5MB, tope del mes o
    // análisis desactivado). Antes ese marcador entraba al modelo
    // sin imagen y Anny respondía "permíteme revisar" — y no
    // pasaba nada. Ahora se responde determinístico: se le pide
    // el dato por texto, sin prometer una revisión que no existe.
    // ══════════════════════════════════════════════════════════
    // ✅ ANNY-AUDIO-054: la nota de voz no se pudo transcribir. Antes el
    // marcador entraba al modelo y salía una respuesta inventada o un
    // "permíteme escucharlo" imposible. Ahora se admite y se pide por texto.
    // El log de abajo es el que dice POR QUÉ falló: buscar [ANNY-MEDIA] en
    // los logs del servidor (falta de credencial, tope, o error del proveedor).
    // Cubre los dos marcadores que produce baileysService: transcripción
    // fallida y medio no analizado por tope o por configuración.
    if (/^\[el cliente envió una nota de voz/i.test(String(mensajeTexto).trim())) {
      const porTope = /no se analizó/i.test(String(mensajeTexto));
      const respuestaAudio = 'No logré escuchar tu nota de voz. ¿Me lo escribes en un mensaje? Así te respondo de una.';
      console.error(`[ANNY-AUDIO-054] Nota de voz sin procesar (${porTope ? 'tope o análisis desactivado' : 'transcripción fallida'}) — tenant ${adminId}, chat ${telefono}. Revisa los logs [ANNY-MEDIA] para la causa.`);

      await registrarConversacion(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        respuestaAgente: respuestaAudio,
        respondidoPor: 'AGENTE_AUTOMATICO',
        tipo: 'AUDIO_NO_PROCESADO',
        escalado: false
      });

      return {
        procesado: true,
        tipo: 'AUDIO_NO_PROCESADO',
        accion: 'enviar_mensaje',
        respuesta: respuestaAudio
      };
    }

    if (!imagenAdjunta && /^\[el cliente envió una foto/i.test(String(mensajeTexto).trim())) {
      // Texto neutro entre verticales: no menciona extintores porque el
      // motor es multipropósito (ANNY-CFG-010).
      const respuestaFoto = 'No logré abrir la foto que enviaste. ¿Me la reenvías, o me escribes por texto lo que necesitas? Así te ayudo de una vez.';

      await registrarConversacion(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        respuestaAgente: respuestaFoto,
        respondidoPor: 'AGENTE_AUTOMATICO',
        tipo: 'FOTO_NO_PROCESADA',
        escalado: false,
        caseId: null
      });

      return {
        procesado: true,
        tipo: 'FOTO_NO_PROCESADA',
        accion: 'enviar_mensaje',
        respuesta: respuestaFoto
      };
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

      const respuesta = `Claro, ya le aviso a un asesor. ${compromisoDeRespuesta()}`;

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
    //         + órdenes de servicio (✅ ANNY-ORDEN-046)
    const [respuestas, historial, fichaCliente, catalogo, estadoPedido, defectoPendiente, contactoChat, ordenesServicio, diccionario] = await Promise.all([
      obtenerRespuestasTenant(adminId),
      obtenerHistorialReciente(adminId, telefono),
      buscarClienteEnBD(adminId, telefono),
      perfil.fuentePrecios === 'products' ? obtenerCatalogoProductos(adminId) : Promise.resolve([]),
      obtenerEstadoPedidoHilo(adminId, telefono),
      // ✅ TALLER-RESPUESTA-001: solo lectura. Si no hay defecto esperando
      // autorización devuelve null y todo el flujo sigue igual que antes.
      tallerRespuestas.buscarDefectoPendiente(adminId, telefono).catch(() => null),
      // ✅ ANNY-SALUDO-037: con quién habla y si ya se presentó en este chat.
      obtenerContactoChat(adminId, telefono),
      // ✅ ANNY-ORDEN-046: órdenes reales del cliente en Control360.
      // Solo lectura; ante error devuelve [] y el flujo sigue igual.
      obtenerOrdenesServicio(adminId, telefono).catch(() => []),
      // ✅ ANNY-DICC-049: palabras clave del suscriptor → producto.
      obtenerDiccionarioTenant(adminId).catch(() => ({}))
    ]);

    // FIX ANNY-CIERRE-007: ventana de hilo activo 24 h
    const ultimoTs = historial.length ? historial[historial.length - 1].ts : 0;
    const conversacionActiva = ultimoTs > 0 && (Date.now() - ultimoTs) < 24 * 60 * 60 * 1000;

    // ✅ ANNY-MEDIA-024: con imagen adjunta NO se usa la base de conocimiento.
    // El texto es un marcador ("[el cliente envió una foto]") y podría hacer
    // match con una entrada genérica, respondiendo un folleto a alguien que
    // acaba de mandar la foto de su extintor. La foto la interpreta Claude.
    // ✅ ANNY-SALUDO-037: en el PRIMER contacto el atajo se salta. El atajo
    // devuelve un texto fijo, sin saludo y sin preguntar con quién habla —
    // justo lo que hacía que Anny entrara respondiendo en seco a alguien que
    // apenas escribía por primera vez. Ese caso lo atiende el modelo, que sí
    // se presenta. El atajo sigue vigente para el resto de la conversación.
    const primerContactoAbsoluto = historial.length === 0 && !contactoChat.presentada;

    if (!conversacionActiva && misionNombre === 'ATENCION' && !imagenAdjunta && !primerContactoAbsoluto) {
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

    // ✅ ANNY-DICC-049: se resuelve ANTES del modelo, de forma
    // determinística. El modelo no tiene que "encontrar" el producto
    // entre 250 líneas: llega con el precio ya servido.
    const resueltos = resolverPorPalabrasClave(mensajeTexto, diccionario, catalogo);
    if (resueltos.length) {
      console.log(`[ANNY-DICC] ${telefono}: "${resueltos[0].coincidio}" → ${resueltos[0].nombre} $${resueltos[0].precio}`);
    }

    // PASO 3: Claude decide (perfil × misión × estado real)
    const decision = await claudeDecide(
      adminId, nombreCliente, mensajeTexto, respuestas, historial,
      fichaCliente, catalogo, perfil, misionNombre, estadoPedido, defectoPendiente,
      imagenAdjunta,  // ✅ ANNY-MEDIA-024
      contactoChat,    // ✅ ANNY-SALUDO-037
      ordenesServicio, // ✅ ANNY-ORDEN-046
      resueltos        // ✅ ANNY-DICC-049
    );

    // ✅ ANNY-SALUDO-037: se guarda quién es el interlocutor apenas lo dice y
    // se marca que Anny ya se presentó, para no repetir el saludo mañana.
    // Fire-and-forget: si falla, la conversación sigue igual.
    guardarContactoChat(adminId, telefono, {
      nombre: decision.contacto?.nombre,
      empresa: decision.contacto?.empresa,
      presentada: decision._primerContacto === true
    }).catch(() => {});

    // ══════════════════════════════════════════════════════════
    // ✅ ANNY-PAGO-050 — comprobante de pago.
    // Va ANTES del escalado a propósito: un soporte de pago no es
    // un problema, es una buena noticia. Escalarlo dejaba a Anny
    // muda y al cliente sin siquiera un "lo recibí".
    // ══════════════════════════════════════════════════════════
    if (decision.comprobantePago) {
      const cp = decision.comprobantePago;
      const orden = await registrarPagoReportado(adminId, telefono, cp);

      // Texto determinístico: el modelo NO redacta esto. Es la frase
      // donde más caro sale una palabra de más ("recibido" ≠ "aplicado").
      // Con foto se dice "comprobante"; sin foto, "aviso de pago". Decirle
      // comprobante a un mensaje de texto suena a que se recibió algo que no llegó.
      const queLlego = imagenAdjunta ? 'tu comprobante' : 'tu aviso de pago';
      const respuestaPago = orden
        ? `Recibí ${queLlego} y lo dejé asociado a la orden ${orden.numero}. Tesorería lo valida y te confirmamos. ¡Gracias!`
        : `Recibí ${queLlego} y ya lo pasé a tesorería para que lo validen. Apenas quede confirmado te avisamos. ¡Gracias!`;

      await registrarConversacion(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        respuestaAgente: respuestaPago,
        respondidoPor: 'AGENTE_AUTOMATICO',
        tipo: 'PAGO',
        escalado: false
      });

      await actualizarMetricas(adminId, 'respuestas_ia');

      const detalle = [
        cp.monto ? `Monto: ${cp.monto}` : null,
        cp.fecha ? `Fecha: ${cp.fecha}` : null,
        cp.banco ? `Medio: ${cp.banco}` : null,
        cp.referencia ? `Ref: ${cp.referencia}` : null
      ].filter(Boolean).join(' · ') || (imagenAdjunta
        ? 'No se pudo leer el detalle del comprobante — revisar la imagen'
        : 'El cliente no dio detalles del pago — confirmar antes de abonar');

      return {
        procesado: true,
        tipo: 'COMPROBANTE_PAGO',
        accion: 'enviar_mensaje',
        respuesta: respuestaPago,
        avisoPago:
          `💵 *${imagenAdjunta ? 'COMPROBANTE DE PAGO RECIBIDO' : 'EL CLIENTE AVISA QUE YA PAGÓ (sin soporte)'}*\n` +
          `${nombreCliente || 'Sin nombre'} — ${telefono}\n` +
          `${detalle}\n` +
          `${orden ? `Orden ${orden.numero}${orden.saldo > 0 ? ` · saldo $${orden.saldo.toLocaleString('es-CO')}` : ''}` : '⚠️ Sin orden asociada — verificar a qué corresponde'}\n` +
          `Pendiente de VALIDAR en Control360.`,
        imagenComprobante: imagenAdjunta,
        notificarA: perfil.notificarEscalamientoA,
        telefonoCliente: telefono
      };
    }

    if (decision.escalado) {
      const caseId = await registrarCasoEscalado(adminId, {
        telefono,
        nombreCliente,
        mensajeCliente: mensajeTexto,
        tipo: decision.tipo,
        razon: decision.razon,
        asignadoA: adminId
      });

      // ✅ ANNY-PROMESA-029: antes decía "lo reviso y te confirmo" — Anny no
      // revisa nada: queda muda hasta que la admin resuelva el caso. Ahora
      // fija la expectativa correcta: te contacta UNA PERSONA del equipo.
      // ✅ ANNY-TRANSFER-039: se dice explícitamente que la conversación se
      // TRANSFIERE. "Un asesor te escribe" dejaba al cliente sin saber si
      // debía seguir hablando con Anny o esperar.
      // ✅ ANNY-COMPROMISO-047: "te escribe por aquí mismo" es una promesa
      // sin plazo — y sin plazo el cliente no sabe si esperar 5 minutos o
      // todo el día. Un cliente canceló justamente ahí. Ahora el mensaje
      // compromete una FRANJA REAL calculada sobre el horario de atención,
      // y fuera de horario dice la verdad en vez de fingir inmediatez.
      const respuestaEsc = `Este caso prefiero pasarlo a un asesor para no darte un dato equivocado. ${compromisoDeRespuesta()}`;

      // ✅ ANNY-TRANSFER-039: si Anny acaba de decir que transfiere, no puede
      // seguir contestando. Antes solo se pausaba cuando el cliente PEDÍA un
      // humano (ANNY-HUMANO-012); en un escalado por criterio propio Anny
      // anunciaba al asesor y seguía respondiendo, pisando al humano que
      // entraba. 45 min: suficiente para que el equipo tome el chat, y cada
      // mensaje manual de la asesora refresca la pausa (ANNY-PAUSA-004).
      await pausarAnny(adminId, telefono, 45, `escalado_${decision.tipo || 'OTRO'}`);

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
      'fuentePrecios', 'reglasNegocio', 'notificarEscalamientoA',
      // ✅ ANNY-NICHO-033 / ANNY-VENTA-034
      'nicho', 'mediosPago', 'avisarVentaCliente'
    ];
    const limpio = {};

    // ✅ ANNY-NICHO-033: si llega un nicho válido, la plantilla precarga
    // vertical/queVende/reglas; lo que venga explícito en `perfil` la
    // sobreescribe (la plantilla es punto de partida, no camisa de fuerza).
    if (perfil && perfil.nicho && NICHOS[perfil.nicho]) {
      const n = NICHOS[perfil.nicho];
      limpio.nicho = perfil.nicho;
      limpio.vertical = n.vertical;
      limpio.queVende = n.queVende;
      limpio.fuentePrecios = n.fuentePrecios;
      limpio.reglasNegocio = n.reglasNegocio;
    }

    for (const k of permitidos) {
      if (perfil && perfil[k] !== undefined && perfil[k] !== null && perfil[k] !== '') limpio[k] = perfil[k];
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
  obtenerOrdenesServicio,
  compromisoDeRespuesta,
  obtenerDiccionarioTenant,     // ✅ ANNY-DICC-049
  invalidarCacheDiccionario,
  resolverPorPalabrasClave,
  registrarPagoReportado,       // ✅ ANNY-PAGO-050
  sugerirRespuestaEntrenamiento, // ✅ ANNY-KB-022
  RESPUESTAS_BASE,
  // ── v22 ──
  obtenerPerfilTenant,
  actualizarPerfilTenant,
  invalidarCachePerfil,
  listarChats,
  obtenerEstadoPedidoHilo,
  obtenerMisionActiva,
  // ✅ ANNY-SALUDO-037
  obtenerContactoChat,
  guardarContactoChat,
  recortarRespuesta,
  pidePersonaHumana,
  // ✅ ANNY-PRECIO-036: expuesta para poder verificar los candados del atajo
  // sin levantar Firestore.
  buscarRespuestaConfigura,
  MISIONES,
  PERFIL_DEFAULT,
  NICHOS // ✅ ANNY-NICHO-033
};
// FIN annyService.js (v23)
