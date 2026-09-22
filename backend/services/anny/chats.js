// ============================================================
// Control360 — Anny · MOTOR v3 · chats.js
// Ubicación: backend/services/anny/chats.js
// ============================================================
// ANNY-V3-CHATS: persistencia de la conversación.
//   chatsAnny/{adminId}/chats/{telefono}            ← resumen + estado
//   chatsAnny/{adminId}/chats/{telefono}/mensajes   ← historial
//   conversacionesAnny/{adminId}/conversaciones     ← legado (no se toca)
//   annyPausas · casosEscaladosAnny · pedidosAnny · metricsAnny
//
// NUEVO EN v3:
//   - estado de conversación (etapa + slots + preguntasHechas) en el
//     documento resumen del chat: campo `estado`.
//   - historial devuelto como TURNOS con rol (cliente/anny/admin/sistema)
//     y, en el prompt, como mensajes user/assistant reales.
//   - score de calidad: repeticiones y turnos por chat.
//
// ✅ ANNY-ESCALADO-059: una sola verdad para "escalado".
//   El panel pinta la marca roja con chatsAnny/.../{tel}.escalado,
//   pero esa marca solo se prendía y nunca se apagaba: ni con la
//   respuesta del asesor, ni con Resolver, ni con Devolver a Anny,
//   ni al vencer. Ahora la marca se deriva de los casos: si el
//   chat no tiene casos PENDIENTE, la marca se apaga.
//     cerrarCasosDeChat · sincronizarEscaladoChat ·
//     repararMarcasEscalado (autocuración del histórico)
// ✅ ANNY-INTERNO-064: numerosDelEquipo / esNumeroDelEquipo —
//   los celulares de los usuarios del tenant (mensajeros,
//   comerciales, taller…) no se atienden como clientes.
// ============================================================

const { db, admin } = require('../../config/firebase');
const { MISIONES } = require('./config');
const { similitud, normalizarTelefono } = require('./texto');
const { ESTADOS_PEDIDO_ABIERTO } = require('./contexto');

function colChats(adminId) { return db.collection('chatsAnny').doc(adminId).collection('chats'); }
function refChat(adminId, telefono) { return colChats(adminId).doc(String(telefono)); }

// ============================================================
// Registro de conversación — escritura dual (legado + v22)
// ============================================================
async function registrarConversacion(adminId, data) {
  try {
    await db.collection('conversacionesAnny').doc(adminId).collection('conversaciones')
      .add({ ...data, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  } catch (err) {
    console.error('[ANNY] Error registrando conversación (legado):', err.message);
  }
  try {
    if (data && data.telefono) {
      await refChat(adminId, data.telefono).collection('mensajes')
        .add({ ...data, fechaMs: Date.now(), createdAt: admin.firestore.FieldValue.serverTimestamp() });
      await actualizarResumenChat(adminId, data);
    }
  } catch (err) {
    console.error('[ANNY] Error registrando conversación (v22):', err.message);
  }
}

async function actualizarResumenChat(adminId, data) {
  try {
    const { telefono, nombreCliente, mensajeCliente, respuestaAgente, escalado } = data;
    if (!adminId || !telefono) return;
    const resumen = {
      adminId,
      telefono: String(telefono),
      ultimoTexto: String(respuestaAgente || mensajeCliente || '').slice(0, 300),
      ultimaFechaMs: Date.now(),
      totalMensajes: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (nombreCliente) resumen.nombreCliente = nombreCliente;
    if (escalado) resumen.escalado = true;
    await refChat(adminId, telefono).set(resumen, { merge: true });
  } catch (err) {
    console.error('[ANNY] Error actualizando resumen:', err.message);
  }
}

async function listarChats(adminId, opciones = {}) {
  try {
    const limite = Math.min(Number(opciones.limit) || 25, 100);
    let query = colChats(adminId).orderBy('ultimaFechaMs', 'desc');
    if (opciones.desdeMs) query = query.startAfter(Number(opciones.desdeMs));
    const snap = await query.limit(limite).get();
    const chats = snap.docs.map(d => ({ telefono: d.id, ...d.data() }));
    return { chats, cursor: chats.length === limite ? chats[chats.length - 1].ultimaFechaMs : null, migrado: true };
  } catch (err) {
    console.error('[ANNY] Error listando chats:', err.message);
    return { chats: [], cursor: null, migrado: false, error: err.message };
  }
}

// ============================================================
// Historial reciente como turnos { rol, texto, ts }
// rol: 'cliente' | 'anny' | 'admin' | 'sistema'
// ============================================================
function _aTurnos(docs) {
  const turnos = [];
  for (const c of docs) {
    const ts = c.fechaMs || (c.createdAt?.seconds || 0) * 1000 || 0;
    if (c.mensajeCliente) turnos.push({ rol: 'cliente', texto: c.mensajeCliente, ts });
    if (c.respuestaAgente) {
      const rol = c.respondidoPor === 'ADMIN_MANUAL' ? 'admin'
        : (c.respondidoPor === 'NOTIFICACION_SISTEMA' ? 'sistema' : 'anny');
      turnos.push({ rol, texto: c.respuestaAgente, ts });
    }
  }
  return turnos;
}

async function obtenerHistorialReciente(adminId, telefono, limite = 20) {
  try {
    const snap = await refChat(adminId, telefono).collection('mensajes').orderBy('fechaMs', 'desc').limit(limite).get();
    if (!snap.empty) return _aTurnos(snap.docs.map(d => d.data()).reverse());
  } catch (err) {
    console.error('[ANNY] Historial v22 falló, uso legado:', err.message);
  }
  try {
    const snap = await db.collection('conversacionesAnny').doc(adminId).collection('conversaciones')
      .where('telefono', '==', telefono).limit(40).get();
    const docs = snap.docs.map(d => d.data())
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      .slice(0, limite).reverse();
    return _aTurnos(docs);
  } catch (err) {
    console.error('[ANNY] Error leyendo historial:', err.message);
    return [];
  }
}

// ============================================================
// Documento del chat: misión activa, contacto y ESTADO en una lectura
// ============================================================
const ESTADO_VACIO = () => ({
  etapa: 'INICIO',
  slots: {},
  preguntasHechas: {},
  clienteConfirmo: false,
  actualizadoMs: 0
});

async function obtenerDocChat(adminId, telefono) {
  try {
    const doc = await refChat(adminId, telefono).get();
    const d = doc.exists ? (doc.data() || {}) : {};
    let mision = 'ATENCION';
    if (d.misionActiva && MISIONES[d.misionActiva] && !(d.misionHasta && Date.now() > Number(d.misionHasta))) {
      mision = d.misionActiva;
    }
    const estado = (d.estado && typeof d.estado === 'object') ? { ...ESTADO_VACIO(), ...d.estado } : ESTADO_VACIO();
    return {
      misionActiva: mision,
      contacto: { nombre: d.contactoNombre || null, empresa: d.contactoEmpresa || null, presentada: d.annySePresento === true },
      estado,
      ultimaFechaMs: Number(d.ultimaFechaMs) || 0,
      calidad: d.calidad || {}
    };
  } catch (err) {
    console.error('[ANNY] Error leyendo doc de chat:', err.message);
    return { misionActiva: 'ATENCION', contacto: { nombre: null, empresa: null, presentada: false }, estado: ESTADO_VACIO(), ultimaFechaMs: 0, calidad: {} };
  }
}

async function obtenerMisionActiva(adminId, telefono) {
  return (await obtenerDocChat(adminId, telefono)).misionActiva;
}

async function obtenerContactoChat(adminId, telefono) {
  return (await obtenerDocChat(adminId, telefono)).contacto;
}

async function guardarContactoChat(adminId, telefono, contacto = {}) {
  try {
    const limpio = v => {
      const s = String(v || '').trim();
      if (s.length < 2 || s.length > 80) return null;
      if (/^(no|n\/a|na|ninguna|ninguno|nose|no se|null|undefined|cliente|cliente test)$/i.test(s)) return null;
      return s;
    };
    const patch = {};
    const nombre = limpio(contacto.nombre);
    const empresa = limpio(contacto.empresa);
    if (nombre) patch.contactoNombre = nombre;
    if (empresa) patch.contactoEmpresa = empresa;
    if (contacto.presentada) patch.annySePresento = true;
    if (!Object.keys(patch).length) return;
    await refChat(adminId, telefono).set(patch, { merge: true });
  } catch (err) {
    console.error('[ANNY] Error guardando contacto:', err.message);
  }
}

// Estado de conversación (etapa + slots). Se guarda completo (set merge
// del campo `estado`), no se acumula basura.
async function guardarEstadoChat(adminId, telefono, estado) {
  try {
    await refChat(adminId, telefono).set({
      estado: { ...estado, actualizadoMs: Date.now() },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error('[ANNY] Error guardando estado del chat:', err.message);
  }
}

// ANNY-LID-055: mapa LID → número real, guardado en el chat del número.
async function guardarLidChat(adminId, telefono, lid) {
  try {
    if (!lid) return;
    await refChat(adminId, telefono).set({ lid: String(lid) }, { merge: true });
    await db.collection('annyLids').doc(`${adminId}_${lid}`).set({ adminId, lid: String(lid), telefono: String(telefono), updatedMs: Date.now() }, { merge: true });
  } catch (err) { /* no bloquea */ }
}

async function buscarTelefonoPorLid(adminId, lid) {
  try {
    const doc = await db.collection('annyLids').doc(`${adminId}_${lid}`).get();
    return doc.exists ? (doc.data().telefono || null) : null;
  } catch (err) { return null; }
}

// ============================================================
// Score de calidad (v3): repeticiones y turnos de Anny por chat.
// Se calcula sobre lo que YA está en historial (barato, sin modelo).
// ============================================================
async function registrarCalidad(adminId, telefono, respuestaNueva, historial, calidadPrevia = {}) {
  try {
    const previas = (historial || []).filter(t => t.rol === 'anny').slice(-3).map(t => t.texto);
    const repite = previas.some(p => similitud(p, respuestaNueva) >= 0.8);
    const patch = {
      calidad: {
        turnosAnny: admin.firestore.FieldValue.increment(1),
        repeticiones: admin.firestore.FieldValue.increment(repite ? 1 : 0),
        ultimoLargo: String(respuestaNueva || '').length
      }
    };
    if (repite) console.warn(`[ANNY-CALIDAD] Respuesta repetida en chat ${telefono} (tenant ${adminId})`);
    await refChat(adminId, telefono).set(patch, { merge: true });
    return { repite };
  } catch (err) { return { repite: false }; }
}

// ============================================================
// Pausas (ANNY-PAUSA-004)
// ============================================================
async function pausarAnny(adminId, telefono, minutos = 30, motivo = 'intervencion_manual') {
  try {
    const hasta = Date.now() + (Number(minutos) || 30) * 60 * 1000;
    await db.collection('annyPausas').doc(`${adminId}_${telefono}`).set({
      adminId, telefono, pausadoHasta: hasta, motivo, updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true, pausadoHasta: hasta };
  } catch (err) {
    console.error('[ANNY] Error pausando:', err.message);
    return { ok: false };
  }
}

async function annyEstaPausada(adminId, telefono) {
  try {
    const doc = await db.collection('annyPausas').doc(`${adminId}_${telefono}`).get();
    return doc.exists && Date.now() < (doc.data().pausadoHasta || 0);
  } catch (err) { return false; }
}

async function reactivarAnny(adminId, telefono) {
  try {
    await db.collection('annyPausas').doc(`${adminId}_${telefono}`).set({
      adminId, telefono, pausadoHasta: 0, motivo: 'reactivada_manual', updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true };
  } catch (err) { return { ok: false }; }
}

// ============================================================
// Casos escalados
// ============================================================
async function registrarCasoEscalado(adminId, data) {
  try {
    const ref = await db.collection('casosEscaladosAnny').doc(adminId).collection('casos')
      .add({ ...data, estado: 'PENDIENTE', createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return ref.id;
  } catch (err) {
    console.error('[ANNY] Error registrando caso:', err.message);
    return null;
  }
}

// ============================================================
// ✅ ANNY-ESCALADO-059 — ciclo de vida del escalado
// ============================================================
function colCasos(adminId) { return db.collection('casosEscaladosAnny').doc(adminId).collection('casos'); }

async function _casosPendientesDe(adminId, telefono) {
  const snap = await colCasos(adminId)
    .where('telefono', '==', String(telefono))
    .where('estado', '==', 'PENDIENTE')
    .limit(10)
    .get();
  return snap.docs;
}

// Apaga la marca roja del chat si ya no le queda ningún caso PENDIENTE.
// Nunca la prende: prenderla es trabajo del motor al escalar.
async function sincronizarEscaladoChat(adminId, telefono) {
  try {
    if (!adminId || !telefono) return { escalado: null };
    const pendientes = await _casosPendientesDe(adminId, telefono);
    if (pendientes.length > 0) return { escalado: true };
    await refChat(adminId, telefono).set({ escalado: false, escaladoCerradoMs: Date.now() }, { merge: true });
    return { escalado: false };
  } catch (err) {
    console.error('[ANNY-ESCALADO-059] Error sincronizando marca de escalado:', err.message);
    return { escalado: null };
  }
}

// Cierra todos los casos PENDIENTE de un chat y apaga la marca.
// resueltoPor: 'respuesta_manual' | 'devuelto_a_anny' | 'orden_creada' | 'numero_interno' | ...
async function cerrarCasosDeChat(adminId, telefono, resueltoPor, notas = '') {
  try {
    if (!adminId || !telefono) return 0;
    const docs = await _casosPendientesDe(adminId, telefono);
    if (docs.length) {
      const lote = db.batch();
      docs.forEach(d => lote.update(d.ref, {
        estado: 'RESUELTO',
        resueltoPor: resueltoPor || 'sistema',
        resueltoMs: Date.now(),
        notas: notas || 'Cerrado automáticamente.',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }));
      await lote.commit();
      console.log(`[ANNY-ESCALADO-059] ${docs.length} caso(s) de ${telefono} cerrados (${resueltoPor}) — tenant ${adminId}`);
    }
    await sincronizarEscaladoChat(adminId, telefono);
    return docs.length;
  } catch (err) {
    console.error('[ANNY-ESCALADO-059] Error cerrando casos del chat:', err.message);
    return 0;
  }
}

// Autocuración: apaga la marca de los chats que la tienen prendida
// sin ningún caso PENDIENTE (el histórico acumulado antes de este fix).
// Lo llama el vigilante SLA en cada ronda, con tope para no gastar lecturas.
async function repararMarcasEscalado(adminId, limite = 50) {
  try {
    const snap = await colChats(adminId).where('escalado', '==', true).limit(limite).get();
    let apagadas = 0;
    for (const d of snap.docs) {
      const r = await sincronizarEscaladoChat(adminId, d.id);
      if (r.escalado === false) apagadas += 1;
    }
    if (apagadas) console.log(`[ANNY-ESCALADO-059] ${apagadas} marca(s) de escalado sin casos abiertos apagadas — tenant ${adminId}`);
    return apagadas;
  } catch (err) {
    console.error('[ANNY-ESCALADO-059] Error reparando marcas:', err.message);
    return 0;
  }
}

// ============================================================
// ✅ ANNY-INTERNO-064 — números del equipo del tenant
// ------------------------------------------------------------
// Sub-usuarios del tenant (users.creadoPor == adminId). A propósito
// NO incluye el documento del dueño: así la admin puede seguir
// probando a Anny desde su propio celular.
// ============================================================
const _cacheEquipo = new Map(); // adminId → { set, exp }
const EQUIPO_CACHE_MS = 10 * 60 * 1000;

async function numerosDelEquipo(adminId) {
  const c = _cacheEquipo.get(adminId);
  if (c && Date.now() < c.exp) return c.set;
  const set = new Set();
  try {
    const snap = await db.collection('users').where('creadoPor', '==', adminId).get();
    snap.forEach(d => {
      const u = d.data() || {};
      if (u.activo === false) return;
      for (const campo of [u.celular, u.phone, u.telefono]) {
        const n = normalizarTelefono(campo);
        if (n && n.length >= 10) set.add(n);
      }
    });
  } catch (err) {
    console.error('[ANNY-INTERNO-064] Error leyendo números del equipo:', err.message);
  }
  _cacheEquipo.set(adminId, { set, exp: Date.now() + EQUIPO_CACHE_MS });
  return set;
}

async function esNumeroDelEquipo(adminId, telefono) {
  try {
    const n = normalizarTelefono(telefono);
    if (!n) return false;
    return (await numerosDelEquipo(adminId)).has(n);
  } catch (err) { return false; }
}

// ============================================================
// Pedidos (ANNY-IDEM-016: máximo un pedido abierto por hilo)
// ============================================================
async function registrarPedido(adminId, telefono, pedido) {
  try {
    const coleccion = db.collection('pedidosAnny').doc(adminId).collection('pedidos');
    const snap = await coleccion.where('telefono', '==', telefono).limit(20).get();
    const hace24h = Date.now() - 24 * 60 * 60 * 1000;
    const existente = snap.docs.find(d => {
      const p = d.data();
      if (!ESTADOS_PEDIDO_ABIERTO.includes(p.estado)) return false;
      const ts = (p.createdAt?.seconds || 0) * 1000;
      return ts >= hace24h || ts === 0;
    });
    const limpio = Object.fromEntries(Object.entries(pedido || {}).filter(([, v]) => v !== undefined));
    if (existente) {
      await existente.ref.set({ ...limpio, telefono, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { id: existente.id, esDuplicado: true };
    }
    const ref = await coleccion.add({ ...limpio, telefono, estado: 'NUEVO', createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return { id: ref.id, esDuplicado: false };
  } catch (err) {
    console.error('[ANNY] Error registrando pedido:', err.message);
    return null;
  }
}

// ============================================================
// Métricas del día
// ============================================================
async function actualizarMetricas(adminId, tipo) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    await db.collection('metricsAnny').doc(`${adminId}_${hoy}`).set({
      adminId, fecha: hoy, [tipo]: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) { /* no bloquea */ }
}

async function obtenerMetricasHoy(adminId) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const doc = await db.collection('metricsAnny').doc(`${adminId}_${hoy}`).get();
    const d = doc.exists ? doc.data() : {};
    const ra = d.respuestas_automaticas || 0, ri = d.respuestas_ia || 0, ce = d.casos_escalados || 0;
    return { respuestas_automaticas: ra, respuestas_ia: ri, casos_escalados: ce, pedidos: d.pedidos || 0, total: ra + ri + ce };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  colChats,
  refChat,
  registrarConversacion,
  actualizarResumenChat,
  listarChats,
  obtenerHistorialReciente,
  obtenerDocChat,
  obtenerMisionActiva,
  obtenerContactoChat,
  guardarContactoChat,
  guardarEstadoChat,
  guardarLidChat,
  buscarTelefonoPorLid,
  registrarCalidad,
  pausarAnny,
  annyEstaPausada,
  reactivarAnny,
  registrarCasoEscalado,
  cerrarCasosDeChat,          // ✅ ANNY-ESCALADO-059
  sincronizarEscaladoChat,    // ✅ ANNY-ESCALADO-059
  repararMarcasEscalado,      // ✅ ANNY-ESCALADO-059
  numerosDelEquipo,           // ✅ ANNY-INTERNO-064
  esNumeroDelEquipo,          // ✅ ANNY-INTERNO-064
  registrarPedido,
  actualizarMetricas,
  obtenerMetricasHoy,
  ESTADO_VACIO
};
