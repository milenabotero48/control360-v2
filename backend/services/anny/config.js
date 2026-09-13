// ============================================================
// Control360 — Anny · MOTOR v3 · config.js
// Ubicación: backend/services/anny/config.js
// ============================================================
// ANNY-V3-CONFIG: perfil por tenant, nichos, misiones y cachés.
//
// Capas de configuración (de menos a más específica):
//   MOTOR  → este archivo (principios genéricos, sin datos de empresa)
//   NICHO  → NICHOS[...]: playbook del vertical (etapas, casos típicos,
//            ejemplos de diálogo). Extintores es UN nicho, no el núcleo.
//   TENANT → annyConfig/{adminId}.perfil: identidad, tono, horario,
//            medios de pago, presentación, modelo.
//   MISIÓN → MISIONES[...]: a qué vino esta conversación.
//
// INVARIANTE (ANNY-FUGA-035, ampliada en v3 — ANNY-LID/HORARIO):
//   Ningún precio, dirección, HORARIO ni dato comercial de una
//   empresa concreta vive en el código. Todo sale del tenant.
// ============================================================

const { db } = require('../../config/firebase');

const CACHE_TTL_MS = 5 * 60 * 1000;

// ------------------------------------------------------------
// Modelos disponibles. El SuperAdmin elige por tenant con
// perfil.modelo = 'haiku' | 'sonnet'. Por defecto haiku.
// ------------------------------------------------------------
const MODELOS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-5-20250929'
};

// ------------------------------------------------------------
// Horario por defecto: SOLO se usa si el tenant no configuró el
// suyo. Es deliberadamente genérico (lunes a viernes de oficina);
// no es el horario de ninguna empresa en particular.
// Formato: { lun:['08:00','18:00'], ..., dom:null }
// ------------------------------------------------------------
const HORARIO_DEFAULT = {
  lun: ['08:00', '18:00'],
  mar: ['08:00', '18:00'],
  mie: ['08:00', '18:00'],
  jue: ['08:00', '18:00'],
  vie: ['08:00', '18:00'],
  sab: null,
  dom: null
};

const TONO_DEFAULT = {
  tratamiento: 'tu',      // 'tu' | 'usted'
  emojis: false,
  calidez: 'directa'      // 'directa' | 'cercana'
};

// ============================================================
// NICHOS — playbook por vertical
// ------------------------------------------------------------
// Cada nicho declara:
//   etiqueta, vertical, queVende, fuentePrecios
//   reglasNegocio        → criterio de oficio (casos típicos)
//   familiasIntencion    → palabras que separan familias de producto
//                          (en extintores: recarga vs equipo nuevo).
//                          Se usan para FILTRAR el catálogo, nunca
//                          para inventar productos.
//   slotsMinimos         → qué hace falta para cerrar un pedido
//   identificarAlInicio  → si pide nombre/empresa en el saludo
//   ejemplos             → diálogos cortos de referencia. El modelo
//                          imita ejemplos mucho mejor que obedece
//                          prohibiciones.
//   conocimientoBase     → criterio técnico sin cifras (opcional)
// ============================================================
const REGLAS_EXTINTORES = [
  'El color del extintor orienta el agente: amarillo ABC, rojo CO2 o BC, verde agua, plateado tipo K, blanco Solkaflam. Confírmalo, no lo des por hecho.',
  'Casos típicos para orientar sin interrogar (dilos como "por lo general" y pide confirmar):',
  '- carro, camioneta, moto o taxi: ABC de 5 lb (camión, bus o tractomula: 10 o 20 lb)',
  '- casa o apartamento: ABC de 5 o 10 lb',
  '- almacén, local, bodega o empresa: ABC de 10 lb',
  '- oficina, consultorio, recepción: CO2',
  '- cocina de restaurante, freidora o campana: tipo K',
  '- tablero eléctrico, servidores o cómputo: Solkaflam',
  'Si el cliente no sabe qué extintor tiene, pídele una foto de la etiqueta.',
  'Recarga y equipo nuevo son productos DISTINTOS con precios distintos. Si no está claro cuál quiere, pregúntalo antes de dar una cifra.',
  'Para una recarga lo que necesitas es CUÁNTOS equipos y a qué dirección se recogen. Tipo y capacidad se confirman al recoger si el cliente no los sabe.'
].join('\n');

const NICHOS = {
  extintores: {
    etiqueta: 'Extintores y seguridad industrial',
    vertical: 'venta, recarga y mantenimiento de extintores y seguridad industrial en Colombia',
    queVende: 'recarga de extintores, venta de extintores nuevos, mantenimiento y elementos de seguridad industrial',
    fuentePrecios: 'products',
    reglasNegocio: REGLAS_EXTINTORES,
    familiasIntencion: {
      recarga: ['recarga', 'recargar', 'recargue', 'mantenimiento', 'vencido', 'vencio', 'vence', 'revision', 'prueba hidrostatica', 'servicio'],
      nuevo: ['nuevo', 'nuevos', 'comprar', 'compra', 'vender', 'venden', 'adquirir', 'cotizar un extintor', 'necesito un extintor']
    },
    slotsMinimos: ['items', 'contactoNombre', 'direccion'],
    slotsOpcionales: ['cedulaNit', 'correo', 'fecha'],
    identificarAlInicio: true,
    conocimientoBase: 'Por el color me oriento: amarillo es ABC, rojo suele ser CO2 o BC, verde es de agua, plateado es tipo K y blanco es Solkaflam.',
    ejemplos: [
      [
        ['cliente', 'buenas, cuanto vale recargar el extintor del carro'],
        ['agente', 'Hola, soy {agente} de {empresa}. La recarga del extintor de carro, que por lo general es ABC de 5 lb, está en {precio}. ¿Con quién tengo el gusto?'],
        ['cliente', 'carlos, y como hago'],
        ['agente', 'Carlos, lo recogemos, lo recargamos y te lo devolvemos. ¿A qué dirección lo recogemos?']
      ],
      [
        ['cliente', 'necesito 3 extintores para una bodega'],
        ['agente', '¿Son para recargar los que ya tienes o necesitas 3 nuevos?'],
        ['cliente', 'nuevos'],
        ['agente', 'Para bodega lo usual es ABC de 10 lb, a {precio} cada uno. ¿Te sirven de esa capacidad o prefieres de 20 lb?']
      ]
    ]
  },
  venta_online: {
    etiqueta: 'Venta en línea / tienda',
    vertical: 'venta de productos en línea con entrega a domicilio',
    queVende: 'productos del catálogo de la tienda, con envío o entrega a domicilio',
    fuentePrecios: 'products',
    reglasNegocio: 'Cuando confirmes una compra, informa los medios de pago y el paso a seguir para el envío. Pide comprobante cuando el cliente diga que ya pagó y avisa que el pedido se despacha al confirmarse el pago.',
    familiasIntencion: {},
    slotsMinimos: ['items', 'contactoNombre', 'direccion'],
    slotsOpcionales: ['cedulaNit', 'correo'],
    identificarAlInicio: false,
    ejemplos: [
      [
        ['cliente', 'tienen la camiseta azul en talla M?'],
        ['agente', 'Sí, la camiseta azul en M está en {precio}. ¿Te la envío a domicilio o la recoges?']
      ]
    ]
  },
  servicios: {
    etiqueta: 'Servicios profesionales',
    vertical: 'prestación de servicios profesionales con cita o agendamiento',
    queVende: 'servicios que se cotizan y se agendan con fecha y hora',
    fuentePrecios: 'products',
    reglasNegocio: 'El objetivo es AGENDAR: propón fecha y hora concretas. Si el servicio requiere valoración previa, dilo y ofrece la cita de valoración. No prometas resultados.',
    familiasIntencion: {},
    slotsMinimos: ['items', 'contactoNombre', 'fecha'],
    slotsOpcionales: ['direccion', 'correo'],
    identificarAlInicio: true,
    ejemplos: [
      [
        ['cliente', 'cuanto cuesta la limpieza facial'],
        ['agente', 'La limpieza facial está en {precio} y dura una hora. ¿Qué día te queda bien?']
      ]
    ]
  },
  restaurante: {
    etiqueta: 'Restaurante / comidas',
    vertical: 'restaurante con venta a domicilio y en local',
    queVende: 'platos del menú, con domicilio o recogida en local',
    fuentePrecios: 'products',
    reglasNegocio: 'Toma el pedido plato por plato y confirma el total antes de cerrar. Pregunta si es para domicilio o para recoger. El tiempo de entrega solo si está en la base de conocimiento.',
    familiasIntencion: {},
    slotsMinimos: ['items', 'direccion'],
    slotsOpcionales: ['contactoNombre'],
    identificarAlInicio: false,
    ejemplos: [
      [
        ['cliente', 'me manda dos bandejas paisas'],
        ['agente', 'Dos bandejas paisas, {precio} en total. ¿A qué dirección las llevamos?']
      ]
    ]
  },
  repuestos: {
    etiqueta: 'Repuestos y autopartes',
    vertical: 'venta de repuestos y autopartes',
    queVende: 'repuestos y autopartes del catálogo',
    fuentePrecios: 'products',
    reglasNegocio: 'Para cotizar un repuesto necesitas marca, modelo/línea y año del vehículo (o foto de la pieza). Si la referencia exacta no está en el catálogo, NO improvises equivalencias: escala. Aclara si es original o alterno cuando el catálogo lo indique.',
    familiasIntencion: {},
    slotsMinimos: ['items', 'contactoNombre', 'direccion'],
    slotsOpcionales: ['cedulaNit', 'correo'],
    identificarAlInicio: false,
    ejemplos: [
      [
        ['cliente', 'tienen pastillas de freno para spark'],
        ['agente', '¿De qué año es el Spark y es GT o el clásico? Con eso te doy la referencia y el precio exacto.']
      ]
    ]
  }
};

// PERFIL_DEFAULT = nicho extintores (tenants heredados). Un tenant sin
// perfil configurado se comporta igual que antes de v3.
const PERFIL_DEFAULT = {
  nombreAgente: 'Anny',
  empresa: 'la empresa',
  nicho: 'extintores',
  vertical: NICHOS.extintores.vertical,
  queVende: NICHOS.extintores.queVende,
  fuentePrecios: 'products',
  reglasNegocio: REGLAS_EXTINTORES,
  notificarEscalamientoA: null,
  mediosPago: '',
  avisarVentaCliente: false,
  horarioAtencion: HORARIO_DEFAULT,
  tono: TONO_DEFAULT,
  presentacion: '',
  modelo: 'haiku',
  ventanaRafagaMs: 5000,
  identificarAlInicio: true
};

// ============================================================
// MISIONES — a qué vino esta conversación
// ============================================================
const MISIONES = {
  ATENCION: {
    objetivo: 'Atender al cliente que escribe: resolver su duda y, si aplica, cerrar la venta.',
    permiteVenta: true,
    permitePedido: true,
    usaEtapas: true,
    maxChars: 240,
    reglas: 'Responde primero lo que pregunta. Avanza un paso por mensaje. Cierra cuando tengas los mínimos.'
  },
  COBRANZA: {
    objetivo: 'Recordar de forma amable un saldo pendiente y acordar cómo y cuándo paga.',
    permiteVenta: false,
    ventaReactiva: true,
    permitePedido: true,
    usaEtapas: false,
    maxChars: 280,
    reglas: 'No ofrezcas productos por iniciativa propia: el tema es el saldo, el medio de pago y la fecha. Si el cliente discute el valor, escala. Si dice que ya pagó, es un reporte de pago (no escales). Si pide comprar algo, atiéndelo con el catálogo y recuérdale con amabilidad el saldo.'
  },
  NOTIFICACION_TALLER: {
    objetivo: 'Informar una novedad del taller y obtener autorización SÍ/NO.',
    permiteVenta: false,
    permitePedido: false,
    usaEtapas: false,
    maxChars: 260,
    reglas: 'Ultrabreve. Informa la novedad y su valor y pide autorización. No negocies precio. Cuando responda, agradece y di que lo pasas al taller para confirmar: nunca afirmes que ya quedó autorizado.'
  },
  RENOVACION_SAAS: {
    objetivo: 'Informar la cuenta de cobro de la suscripción y acordar el pago.',
    permiteVenta: false,
    permitePedido: false,
    usaEtapas: false,
    maxChars: 300,
    reglas: 'Hablas de la suscripción al software, nunca de productos físicos. Si pide cambio de plan o descuento, escala.'
  },
  CONFIRMACION_VENTA: {
    objetivo: 'Confirmar al cliente la compra registrada, informar medios de pago y resolver dudas de pago o entrega.',
    permiteVenta: false,
    ventaReactiva: true,
    permitePedido: true,
    usaEtapas: false,
    maxChars: 300,
    reglas: 'El pedido YA está registrado: no abras otro. Resuelve dudas de pago y entrega con la base de conocimiento. Si dice que ya pagó, es un reporte de pago. Si discute el valor, escala.'
  },
  REACTIVACION: {
    objetivo: 'Reactivar a un cliente con servicio vencido o inactivo e invitarlo a agendar.',
    permiteVenta: true,
    permitePedido: true,
    usaEtapas: true,
    maxChars: 300,
    reglas: 'Cálida y directa. Si no muestra interés, agradece y cierra: no insistas.'
  }
};

function obtenerMision(nombre) {
  return MISIONES[String(nombre || 'ATENCION').toUpperCase()] || MISIONES.ATENCION;
}

function obtenerNicho(nombre) {
  return NICHOS[nombre] || NICHOS.extintores;
}

// ============================================================
// Cachés por tenant (una por tipo de dato)
// ============================================================
const _cache = {
  perfil: new Map(),
  respuestas: new Map()
};

function _leerCache(mapa, adminId) {
  const c = mapa.get(adminId);
  return (c && (Date.now() - c.ts) < CACHE_TTL_MS) ? c.data : null;
}
function _escribirCache(mapa, adminId, data) {
  mapa.set(adminId, { data, ts: Date.now() });
  return data;
}

// ------------------------------------------------------------
// Normaliza el horario guardado. Acepta el formato v3 y, por
// compatibilidad, nada (→ default).
// ------------------------------------------------------------
const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
const RE_HORA = /^([01]?\d|2[0-3]):[0-5]\d$/;

function normalizarHorario(h) {
  if (!h || typeof h !== 'object') return HORARIO_DEFAULT;
  const out = {};
  let alguno = false;
  for (const d of DIAS) {
    const v = h[d];
    if (Array.isArray(v) && v.length === 2 && RE_HORA.test(v[0]) && RE_HORA.test(v[1]) && v[0] < v[1]) {
      out[d] = [v[0], v[1]];
      alguno = true;
    } else {
      out[d] = null;
    }
  }
  return alguno ? out : HORARIO_DEFAULT;
}

function normalizarTono(t) {
  const x = (t && typeof t === 'object') ? t : {};
  return {
    tratamiento: x.tratamiento === 'usted' ? 'usted' : 'tu',
    emojis: x.emojis === true,
    calidez: x.calidez === 'cercana' ? 'cercana' : 'directa'
  };
}

// ============================================================
// Perfil del tenant
// ============================================================
async function obtenerPerfilTenant(adminId) {
  const c = _leerCache(_cache.perfil, adminId);
  if (c) return c;
  try {
    const doc = await db.collection('annyConfig').doc(adminId).get();
    const cfg = doc.exists ? (doc.data() || {}) : {};
    const p = cfg.perfil || {};
    const nicho = NICHOS[p.nicho] ? p.nicho : (p.nicho ? 'extintores' : PERFIL_DEFAULT.nicho);
    const plantilla = NICHOS[nicho];

    const data = {
      nombreAgente: p.nombreAgente || PERFIL_DEFAULT.nombreAgente,
      empresa: p.empresa || PERFIL_DEFAULT.empresa,
      nicho,
      vertical: p.vertical || plantilla.vertical,
      queVende: p.queVende || plantilla.queVende,
      fuentePrecios: p.fuentePrecios || plantilla.fuentePrecios,
      reglasNegocio: p.reglasNegocio || plantilla.reglasNegocio || '',
      notificarEscalamientoA: p.notificarEscalamientoA || cfg.notificarPedidosA || null,
      mediosPago: p.mediosPago || '',
      avisarVentaCliente: p.avisarVentaCliente === true,
      // ✅ ANNY-V3 — campos nuevos del tenant
      horarioAtencion: normalizarHorario(p.horarioAtencion),
      tono: normalizarTono(p.tono),
      presentacion: String(p.presentacion || '').trim().slice(0, 160),
      modelo: MODELOS[p.modelo] ? p.modelo : 'haiku',
      ventanaRafagaMs: Math.min(Math.max(Number(p.ventanaRafagaMs) || 5000, 2000), 12000),
      identificarAlInicio: typeof p.identificarAlInicio === 'boolean' ? p.identificarAlInicio : plantilla.identificarAlInicio,
      configurado: !!cfg.perfil
    };
    return _escribirCache(_cache.perfil, adminId, data);
  } catch (err) {
    console.error('[ANNY] Error leyendo perfil tenant:', err.message);
    return { ...PERFIL_DEFAULT, configurado: false };
  }
}

function invalidarCachePerfil(adminId) { _cache.perfil.delete(adminId); }

async function actualizarPerfilTenant(adminId, perfil) {
  try {
    const permitidos = [
      'nombreAgente', 'empresa', 'vertical', 'queVende',
      'fuentePrecios', 'reglasNegocio', 'notificarEscalamientoA',
      'nicho', 'mediosPago', 'avisarVentaCliente',
      // ✅ ANNY-V3
      'horarioAtencion', 'tono', 'presentacion', 'modelo', 'ventanaRafagaMs', 'identificarAlInicio'
    ];
    const limpio = {};

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
    if (limpio.horarioAtencion) limpio.horarioAtencion = normalizarHorario(limpio.horarioAtencion);
    if (limpio.tono) limpio.tono = normalizarTono(limpio.tono);
    if (limpio.modelo && !MODELOS[limpio.modelo]) delete limpio.modelo;

    await db.collection('annyConfig').doc(adminId).set({ perfil: limpio }, { merge: true });
    invalidarCachePerfil(adminId);
    return { ok: true, perfil: limpio };
  } catch (err) {
    console.error('[ANNY] Error actualizando perfil:', err.message);
    return { error: err.message };
  }
}

// ============================================================
// Config operativa (la del suscriptor). `perfil` y `activo` no
// se tocan por aquí (ANNY-CFG-010).
// ============================================================
async function tenantTieneAnnyActiva(adminId) {
  try {
    const userDoc = await db.collection('users').doc(adminId).get();
    if (!userDoc.exists) return false;
    const modulos = userDoc.data().modulos || [];
    if (modulos.length === 0) return true; // INVARIANTE: vacío = todos
    return modulos.includes('anny_ia');
  } catch (err) {
    console.error('[ANNY] Error verificando módulo anny_ia:', err.message);
    return false;
  }
}

async function obtenerConfig(adminId) {
  try {
    const activo = await tenantTieneAnnyActiva(adminId);
    const doc = await db.collection('annyConfig').doc(adminId).get();
    const operativo = doc.exists ? doc.data() : {};
    const { qrCode, ...resto } = operativo;
    return { ...resto, activo };
  } catch (err) {
    console.error('[ANNY] Error leyendo config:', err.message);
    return { error: err.message, activo: false };
  }
}

async function actualizarConfig(adminId, datos) {
  try {
    const { activo, perfil, ...datosPermitidos } = datos;
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
// Base de conocimiento (pestaña Entrenamiento) por tenant.
// Nunca se hereda de otro tenant ni del código (ANNY-FUGA-035).
// ============================================================
async function obtenerRespuestasTenant(adminId) {
  const c = _leerCache(_cache.respuestas, adminId);
  if (c) return c;
  try {
    const doc = await db.collection('respuestasAnny').doc(adminId).get();
    return _escribirCache(_cache.respuestas, adminId, doc.exists ? (doc.data() || {}) : {});
  } catch (err) {
    console.error('[ANNY] Error leyendo respuestas tenant:', err.message);
    return {};
  }
}

function invalidarCacheRespuestas(adminId) { _cache.respuestas.delete(adminId); }

module.exports = {
  CACHE_TTL_MS,
  MODELOS,
  HORARIO_DEFAULT,
  TONO_DEFAULT,
  NICHOS,
  PERFIL_DEFAULT,
  MISIONES,
  obtenerMision,
  obtenerNicho,
  obtenerPerfilTenant,
  invalidarCachePerfil,
  actualizarPerfilTenant,
  tenantTieneAnnyActiva,
  obtenerConfig,
  actualizarConfig,
  obtenerRespuestasTenant,
  invalidarCacheRespuestas,
  normalizarHorario,
  normalizarTono
};
