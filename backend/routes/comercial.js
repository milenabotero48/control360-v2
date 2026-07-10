// ============================================================
// Control360 — Módulo Comercial (Fase 3) — Pipeline de telemercadeo
// Ubicación: backend/routes/comercial.js
// ------------------------------------------------------------
// MONTAJE en server.js (UNA línea junto a las demás rutas):
//   app.use('/api/comercial', authenticate, require('./routes/comercial'));
//
// REGLAS DEL DOCUMENTO ARQ-COMERCIAL-V1.1 implementadas:
//   R-COM-03  Prospectos separados de clientes; conversión crea el cliente
//   R-COM-08  Meta diaria por vendedora con progreso en vivo
//   + Reprogramación con fecha y HORA opcional
//   + Captura de equipos/fechas en llamada (enriquecimiento de base)
//   + 3 intentos fallidos → SIN_CONTACTO automático
//
// ✅ TELEVENC (2026-07-06): los VENCIDOS del mes son trabajo medible de
// telemercadeo — nueva cola prioritaria en Mi Día, llamadas que cuentan
// en la meta, y sincronización de las 3 fuentes (vencimientos, prospectos,
// clientes) con la regla única de identidad teléfono → NIT → nombre.
//
// Colecciones: prospectos · comercial_llamadas (log plano para métricas)
// Patrón del proyecto: adminId en todo, sin orderBy (orden en memoria),
// fechas como 'YYYY-MM-DD' (Railway UTC / Colombia UTC-5), auditoría.
// ============================================================

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

// ─── Helpers (patrón estándar del proyecto) ─────────────────────────────────
const getAdminId = (req) => req.adminId || req.user?.uid || req.user?.id;
const getUserId  = (req) => req.user?.uid || req.user?.id;

const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'comercial', descripcion,
      usuarioId, usuarioNombre, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

const hoyColombia = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

// ✅ COMERCIAL-BASE-001: período (mes) de la base a la que pertenece un prospecto.
// Evita que las bases de meses distintos se mezclen indistinguibles en Mi Día.
const periodoActualCO = () => hoyColombia().slice(0, 7); // 'YYYY-MM'
const validarPeriodo = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p || '');
// Prospectos anteriores al campo basePeriodo: se deriva del mes de creación
// (createdAt en zona Colombia) — las bases existentes quedan etiquetadas
// correctamente sin migración de datos.
const periodoDeProspecto = (p) => {
  if (p.basePeriodo) return p.basePeriodo;
  const c = p.createdAt;
  const d = c?.toDate ? c.toDate() : (c?._seconds ? new Date(c._seconds * 1000) : null);
  if (!d) return null;
  return new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
};
const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const esHora  = (s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);

const sumarMeses = (fechaStr, meses) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + meses, d)).toISOString().slice(0, 10);
};

const sumarDias = (fechaStr, dias) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
};

// Devuelve el próximo día hábil (lunes–viernes) a partir de la fecha dada.
// Si la fecha base ya es hábil la retorna igual; si no, avanza hasta el lunes.
const proximoDiaHabil = (fechaStr) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  // 0=Dom, 6=Sáb
  while (base.getUTCDay() === 0 || base.getUTCDay() === 6) {
    base.setUTCDate(base.getUTCDate() + 1);
  }
  return base.toISOString().slice(0, 10);
};

// Próximo día hábil después de hoy (para reintentos de no_contesto)
const siguienteDiaHabil = (fechaStr) => {
  return proximoDiaHabil(sumarDias(fechaStr, 1));
};

// ✅ DUP-002: normalización telefónica UNIFICADA — fuente única de verdad para
// todo el dominio comercial (importación, conversión, gestión). Regla:
//   - Celular colombiano válido = exactamente 10 dígitos empezando en 3.
//   - Se ELIMINA el prefijo 57 (antes se AGREGABA, causando que el mismo
//     cliente quedara como 3105... en clientes y 573105... en prospectos,
//     y los duplicados nunca casaran).
//   - Devuelve { tel, valido }: tel siempre a 10 dígitos limpios cuando se
//     puede; valido=false marca teléfonos dudosos (para la bandera "por
//     verificar" en importación, en vez de guardar basura o perder el dato).
const normalizarTelefonoInfo = (telefono) => {
  if (!telefono) return { tel: null, valido: false };
  let t = String(telefono).replace(/[\s\-().+]/g, '').replace(/\D/g, '');
  // Quitar prefijo país si viene (57 + 10 dígitos = 12)
  if (t.length === 12 && t.startsWith('57')) t = t.slice(2);
  const valido = /^3\d{9}$/.test(t); // celular CO: 10 dígitos, empieza en 3
  // Si no es válido pero hay algo, se conserva el dato crudo (recortado) para
  // que la comercial lo pueda ver y corregir — nunca se pierde el prospecto.
  return { tel: t || null, valido };
};

// Compatibilidad: las llamadas existentes esperan un string (o null).
// Devuelve el teléfono a 10 dígitos si es válido; si no, el dato crudo.
const normalizarTelefono = (telefono) => {
  const { tel } = normalizarTelefonoInfo(telefono);
  return tel;
};

// ✅ TELEVENC-003: nuevo estado A_VENCIMIENTOS — el prospecto informó su fecha
// de recarga en una llamada: sus equipos ya viven en `vencimientos` y el
// cliente en `clients`. Sale de la cola de prospectos; cuando llegue su mes
// entrará SOLO a la cola de Vencidos. Nunca más "sigue saliendo".
const ESTADOS = ['NUEVO', 'EN_GESTION', 'REPROGRAMADO', 'CONVERTIDO', 'DESCARTADO', 'SIN_CONTACTO', 'NUMERO_ERRADO', 'A_VENCIMIENTOS'];

// ✅ TELEVENC-003: regla ÚNICA de identidad para resolver un cliente existente
// (teléfono → NIT → nombre normalizado). La usan la captura de fecha en
// llamada y la conversión — misma lógica CLIENTES-DUP-001 del importador.
// Devuelve { clienteId, tipo, cliente } o { clienteId: null }.
const buscarClientePorIdentidad = async (adminId, { telefono, nit, nombre }) => {
  const tel = normalizarTelefono(telefono);
  if (tel) {
    const [dupCel, dupTel] = await Promise.all([
      db.collection('clients').where('adminId', '==', adminId).where('celular', '==', tel).limit(1).get(),
      db.collection('clients').where('adminId', '==', adminId).where('telefono', '==', tel).limit(1).get(),
    ]);
    const d = !dupCel.empty ? dupCel.docs[0] : (!dupTel.empty ? dupTel.docs[0] : null);
    if (d) return { clienteId: d.id, tipo: 'telefono', cliente: { id: d.id, ...d.data() } };
  }
  const nitLimpio = String(nit || '').replace(/\D/g, '');
  if (nitLimpio) {
    try {
      const dupNit = await db.collection('clients')
        .where('adminId', '==', adminId).where('nit', '==', nitLimpio).limit(1).get();
      if (!dupNit.empty) return { clienteId: dupNit.docs[0].id, tipo: 'nit', cliente: { id: dupNit.docs[0].id, ...dupNit.docs[0].data() } };
    } catch (e) { console.warn('identidad nit:', e.message); }
  }
  const nombreNorm = String(nombre || '').toUpperCase().trim().replace(/\s+/g, ' ');
  if (nombreNorm) {
    try {
      const dupNom = await db.collection('clients')
        .where('adminId', '==', adminId).where('nombre', '==', nombreNorm).limit(1).get();
      if (!dupNom.empty) return { clienteId: dupNom.docs[0].id, tipo: 'nombre', cliente: { id: dupNom.docs[0].id, ...dupNom.docs[0].data() } };
    } catch (e) { console.warn('identidad nombre:', e.message); }
  }
  return { clienteId: null, tipo: null, cliente: null };
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/comercial/prospectos — Lista con filtros (admin ve todo;
// vendedora ve los suyos + sin asignar)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/prospectos', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { estado, asignadoA } = req.query;

    const snap = await db.collection('prospectos')
      .where('adminId', '==', adminId)
      .limit(3000)
      .get();

    let lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (estado) lista = lista.filter(p => p.estado === estado);
    if (asignadoA) lista = lista.filter(p => p.asignadoA === asignadoA);

    // Si no es admin: solo los suyos o sin asignar
    if (req.user?.role !== 'admin') {
      const uid = getUserId(req);
      lista = lista.filter(p => !p.asignadoA || p.asignadoA === uid);
    }

    lista.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    return res.json(lista);
  } catch (err) {
    console.error('GET /comercial/prospectos:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/comercial/prospectos — Crear prospecto manual
// ═════════════════════════════════════════════════════════════════════════════
router.post('/prospectos', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { nombre, empresa, telefono, sucursal, origen, notas } = req.body;
    // Ola 3: el comercial puede crear prospectos — quedan asignados a él.
    // Solo el admin puede asignar a otra persona.
    const asignadoA = req.user?.role === 'admin'
      ? (req.body.asignadoA || null)
      : getUserId(req);

    const tel = normalizarTelefono(telefono);
    if (!nombre || !tel) return res.status(400).json({ error: 'Nombre y teléfono válido son requeridos' });

    // Anti-duplicado dentro del tenant (por teléfono)
    const dup = await db.collection('prospectos')
      .where('adminId', '==', adminId)
      .where('telefono', '==', tel)
      .limit(1).get();
    if (!dup.empty) return res.status(409).json({ error: 'Ya existe un prospecto con ese teléfono', prospectoId: dup.docs[0].id });

    const nuevo = {
      adminId,
      basePeriodo: periodoActualCO(), // ✅ COMERCIAL-BASE-001
      nombre: String(nombre).trim(),
      empresa: empresa || null,
      telefono: tel,
      sucursal: sucursal || null,
      origen: origen || 'manual',
      estado: 'NUEVO',
      asignadoA: asignadoA || null,
      proximaLlamada: null,          // { fecha:'YYYY-MM-DD', hora:'HH:mm'|null }
      intentosFallidos: 0,
      totalLlamadas: 0,
      equiposCapturados: [],
      clienteId: null,
      motivoDescarte: null,
      notas: notas || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('prospectos').add(nuevo);
    return res.status(201).json({ id: ref.id, ...nuevo });
  } catch (err) {
    console.error('POST /comercial/prospectos:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/comercial/prospectos/importar — Carga masiva (Excel → JSON)
// Body: { filas: [{ nombre, empresa?, telefono, sucursal? }], asignadoA? }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/prospectos/importar', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede importar' });
    const adminId = getAdminId(req);
    // ✅ COMERCIAL-BASE-001: mes de la base que se está importando
    const basePeriodo = validarPeriodo(req.body?.basePeriodo) ? req.body.basePeriodo : periodoActualCO();
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    const asignadoA = req.body?.asignadoA || null;

    if (!filas.length) return res.status(400).json({ error: 'No se recibieron filas' });
    if (filas.length > 2000) return res.status(400).json({ error: 'Máximo 2000 filas por importación' });

    // Teléfonos ya existentes (prospectos del tenant) para no duplicar
    const existentesSnap = await db.collection('prospectos').where('adminId', '==', adminId).get();
    const telefonosExistentes = new Set(existentesSnap.docs.map(d => d.data().telefono));

    const resultado = { creados: 0, duplicados: 0, porVerificar: 0, errores: [] };
    let batch = db.batch();
    let ops = 0;

    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const nombre = String(f.nombre || f.empresa || '').trim();
      // ✅ DUP-002 (opción b): un teléfono inválido (>10 díg, sin 3 inicial, etc.)
      // NO descarta el prospecto — es una oportunidad de venta. Entra con el
      // dato crudo y la bandera telefonoPorVerificar para que la comercial lo
      // corrija en la primera gestión. Solo se rechaza si NO hay nombre.
      const { tel, valido } = normalizarTelefonoInfo(f.telefono);

      if (!nombre) { resultado.errores.push({ fila: i + 2, error: 'Falta el nombre' }); continue; }
      if (!tel) { resultado.errores.push({ fila: i + 2, error: 'Falta el teléfono' }); continue; }
      if (telefonosExistentes.has(tel)) { resultado.duplicados++; continue; }
      telefonosExistentes.add(tel);

      const ref = db.collection('prospectos').doc();
      batch.set(ref, {
        adminId, nombre,
        empresa: f.empresa || null,
        telefono: tel,
        telefonoPorVerificar: !valido, // ✅ DUP-002: bandera ☎️ por verificar
        sucursal: f.sucursal || null,
        origen: 'importacion',
        basePeriodo, // ✅ COMERCIAL-BASE-001
        estado: 'NUEVO',
        asignadoA,
        proximaLlamada: null,
        intentosFallidos: 0,
        totalLlamadas: 0,
        equiposCapturados: [],
        clienteId: null,
        motivoDescarte: null,
        notas: f.notas || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      ops++; resultado.creados++;
      if (!valido) resultado.porVerificar++; // ✅ DUP-002
      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops > 0) await batch.commit();

    await auditar({
      accion: 'importar', descripcion: `Importación prospectos: ${resultado.creados} creados, ${resultado.duplicados} duplicados omitidos`,
      usuarioId: adminId, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { totalFilas: filas.length }
    });

    return res.json(resultado);
  } catch (err) {
    console.error('POST /comercial/prospectos/importar:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/comercial/mi-dia — Cola de llamadas priorizada + progreso de meta
// Prioridad: 1) reprogramados para hoy o atrasados (respetan hora acordada)
//            2) 🔥 VENCIDOS del mes (retención — plata casi segura)
//            3) en gestión con reintento para hoy   4) nuevos
// ═════════════════════════════════════════════════════════════════════════════
router.get('/mi-dia', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const uid = getUserId(req);
    const hoy = hoyColombia();

    const snap = await db.collection('prospectos')
      .where('adminId', '==', adminId)
      .limit(3000)
      .get();

    let prospectos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // La vendedora ve los suyos o sin asignar; el admin ve todos
    if (req.user?.role !== 'admin') {
      prospectos = prospectos.filter(p => !p.asignadoA || p.asignadoA === uid);
    }

    // ✅ COMERCIAL-BASE-001: cada prospecto lleva su período de base visible
    prospectos = prospectos.map(p => ({ ...p, basePeriodo: periodoDeProspecto(p) }));

    const conFechaHoy = (p) => p.proximaLlamada?.fecha && p.proximaLlamada.fecha <= hoy;

    const reprogramados = prospectos
      .filter(p => p.estado === 'REPROGRAMADO' && conFechaHoy(p))
      .sort((a, b) => (a.proximaLlamada?.hora || '99:99').localeCompare(b.proximaLlamada?.hora || '99:99'));

    const reintentos = prospectos
      .filter(p => p.estado === 'EN_GESTION' && conFechaHoy(p))
      .sort((a, b) => (a.proximaLlamada?.hora || '99:99').localeCompare(b.proximaLlamada?.hora || '99:99'));

    const nuevos = prospectos
      .filter(p => p.estado === 'NUEVO')
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

    // ═══ ✅ TELEVENC-001: cola de VENCIDOS del mes ═══════════════════════════
    // Los vencimientos son la fuente de verdad — NO se duplican en prospectos.
    // Handshake con Lucy: si el tenant tiene 'llamadas_ia' activo, solo entran
    // los que Lucy escaló (escaladoTelemercadeo) tras agotar sus 2 intentos —
    // la cola humana arranca ~día 4. Sin Lucy, todos los vencidos entran ya.
    let vencidos = [];
    try {
      let lucyActiva = false;
      try {
        const adminDoc = await db.collection('users').doc(adminId).get();
        const modulos = adminDoc.exists ? (adminDoc.data().modulos || []) : [];
        lucyActiva = modulos.includes('llamadas_ia'); // mismo patrón que llamadasIA.js /config
      } catch (e) { /* sin doc → sin Lucy */ }

      const vencSnap = await db.collection('vencimientos')
        .where('adminId', '==', adminId)
        .limit(2000)
        .get();

      const candidatos = vencSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(v => !v.gestionado && v.fechaVencimiento && v.fechaVencimiento < hoy)
        .filter(v => !lucyActiva || v.escaladoTelemercadeo === true)
        // Seguimiento de telemercadeo sobre el vencimiento (TELEVENC-002):
        // reprogramado a futuro o agotado (3 intentos) → fuera de la cola de HOY.
        .filter(v => {
          const t = v.telemercadeo || {};
          if (t.sinContacto) return false;
          if (t.proximaLlamada?.fecha && t.proximaLlamada.fecha > hoy) return false;
          return true;
        });

      // Agrupar por CLIENTE (una tarjeta = un cliente con todos sus equipos)
      const porCliente = new Map();
      candidatos.forEach(v => {
        if (!v.clienteId) return;
        const g = porCliente.get(v.clienteId) || {
          clienteId: v.clienteId, equipos: [], fechaMasAntigua: '9999-99-99',
          totalLlamadas: 0, notasUltimaLlamada: null, escaladoPorLucy: false,
        };
        g.equipos.push({
          id: v.id,
          descripcionEquipo: v.descripcionEquipo || 'Extintor',
          cantidad: Number(v.cantidad) || 1,
          sucursal: v.sucursal || null,
          fechaVencimiento: v.fechaVencimiento,
        });
        if (v.fechaVencimiento < g.fechaMasAntigua) g.fechaMasAntigua = v.fechaVencimiento;
        if (v.escaladoTelemercadeo) g.escaladoPorLucy = true;
        const t = v.telemercadeo || {};
        if ((t.totalLlamadas || 0) > g.totalLlamadas) g.totalLlamadas = t.totalLlamadas;
        if (t.notas) g.notasUltimaLlamada = t.notas;
        porCliente.set(v.clienteId, g);
      });

      // Resolver nombre/teléfono con getAll por lotes (patrón VENC-NOMBRE-001)
      // Defensa multi-tenant: si el cliente no es del tenant, se descarta.
      const ids = [...porCliente.keys()];
      for (let i = 0; i < ids.length; i += 300) {
        const refs = ids.slice(i, i + 300).map(id => db.collection('clients').doc(id));
        if (!refs.length) break;
        const docs = await db.getAll(...refs);
        docs.forEach(d => {
          if (!d.exists || d.data().adminId !== adminId) { porCliente.delete(d.id); return; }
          const c = d.data();
          // ✅ FIX TELEVENC-NOINT-001: cliente marcado "no interesa" →
          // fuera de la cola de vencidos hasta la fecha límite
          if (c.telemercadeoNoInteresa?.hasta && c.telemercadeoNoInteresa.hasta >= hoy) { porCliente.delete(d.id); return; }
          const g = porCliente.get(d.id);
          if (!g) return;
          g.nombre = c.nombre || c.empresa || 'Sin nombre';
          g.telefono = c.celular || c.telefono || '';
          g.telefonoPorVerificar = !!c.telefonoPorVerificar;
          g.nit = c.nit || '';
          g.empresaId = c.empresaId || '';
          g.empresaNombre = c.empresaNombre || '';
          g.contacto = c.contacto || '';
        });
      }

      vencidos = [...porCliente.values()]
        .map(g => ({
          ...g,
          id: 'venc-' + g.clienteId, // clave estable para el frontend
          origen: 'vencimiento',
          basePeriodo: (g.fechaMasAntigua || '').slice(0, 7),
          totalEquipos: g.equipos.reduce((a, e) => a + (e.cantidad || 1), 0),
        }))
        // Prioridad interna: el vencimiento más antiguo primero (más urgente)
        .sort((a, b) => a.fechaMasAntigua.localeCompare(b.fechaMasAntigua));

      // ✅ TELEVENC-006: alerta "ya tuvo servicios ESTE MES" con detalle de
      // equipos — Michelle compara antes de llamar si son los mismos equipos.
      if (vencidos.length) {
        const idsSet = new Set(vencidos.map(v => v.clienteId));
        const mesAct = hoy.slice(0, 7);
        const ordsSnap = await db.collection('orders')
          .where('adminId', '==', adminId).limit(3000).get();
        const porClienteOrd = new Map();
        ordsSnap.docs.forEach(d => {
          const o = d.data();
          if (o.estado === 'anulada' || !o.clienteId || !idsSet.has(o.clienteId)) return;
          const s = o.createdAt?._seconds || o.createdAt?.seconds;
          const f = s
            ? new Date(s * 1000 - 5 * 3600 * 1000).toISOString().slice(0, 10)
            : String(o.createdAt || '').slice(0, 10);
          if (!f.startsWith(mesAct)) return;
          const resumenItems = (o.items || []).slice(0, 3)
            .map(it => `${it.cantidad || 1}x ${it.nombre || it.descripcion || 'ítem'}`)
            .join(' · ');
          const arr = porClienteOrd.get(o.clienteId) || [];
          arr.push({ numeroOrden: o.numeroOrden || '', fecha: f, resumenItems });
          porClienteOrd.set(o.clienteId, arr);
        });
        vencidos.forEach(v => { v.serviciosMes = porClienteOrd.get(v.clienteId) || []; });
      }
    } catch (eV) {
      // La cola de vencidos NUNCA tumba Mi Día — si falla, se registra y sigue
      console.warn('TELEVENC-001 cola vencidos:', eV.message);
      vencidos = [];
    }

    // ─── Progreso de meta diaria (R-COM-08) ───
    const llamadasSnap = await db.collection('comercial_llamadas')
      .where('adminId', '==', adminId)
      .where('vendedoraId', '==', uid)
      .where('fecha', '==', hoy)
      .get();
    const llamadasHoy = llamadasSnap.size;

    // Meta configurada en el documento del usuario (users.metaLlamadasDiarias)
    let metaDiaria = 0;
    try {
      const userDoc = await db.collection('users').doc(uid).get();
      if (userDoc.exists) metaDiaria = Number(userDoc.data().metaLlamadasDiarias) || 0;
    } catch (e) { /* sin meta configurada */ }

    return res.json({
      fecha: hoy,
      // ✅ TELEVENC-001: vencidos entra a la cola con prioridad sobre
      // reintentos y nuevos (los reprogramados con hora acordada van primero)
      cola: { reprogramados, vencidos, reintentos, nuevos },
      // Ola 3: ventana al futuro — llamadas agendadas para después de hoy.
      // Solo consulta: no contamina la cola del día.
      agendaProxima: prospectos
        .filter(p => p.proximaLlamada?.fecha && p.proximaLlamada.fecha > hoy && !['CONVERTIDO', 'DESCARTADO', 'A_VENCIMIENTOS'].includes(p.estado))
        .sort((a, b) => (a.proximaLlamada.fecha + (a.proximaLlamada.hora || '')).localeCompare(b.proximaLlamada.fecha + (b.proximaLlamada.hora || '')))
        .slice(0, 50)
        .map(p => ({ id: p.id, nombre: p.nombre, telefono: p.telefono, fecha: p.proximaLlamada.fecha, hora: p.proximaLlamada.hora || '', notas: p.notasUltimaLlamada || '' })),
      // Ola 3: lo convertido HOY por este asesor — su labor visible.
      ventasHoy: prospectos
        .filter(p => p.estado === 'CONVERTIDO' && p.fechaConversion === hoy && (req.user?.role === 'admin' || p.convertidoPor === uid))
        .map(p => ({ id: p.id, nombre: p.nombre, telefono: p.telefono, clienteId: p.clienteId || null })),
      totalPendientes: reprogramados.length + vencidos.length + reintentos.length + nuevos.length,
      meta: {
        objetivo: metaDiaria,
        realizadas: llamadasHoy,
        porcentaje: metaDiaria > 0 ? Math.round((llamadasHoy / metaDiaria) * 100) : null,
      },
    });
  } catch (err) {
    console.error('GET /comercial/mi-dia:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ✅ TELEVENC-002: POST /api/comercial/vencidos/:clienteId/llamada
// Registrar llamada de RETENCIÓN a un cliente con equipos vencidos.
// ─────────────────────────────────────────────────────────────────────────────
// Hace DOS cosas atómicas:
//   1. Escribe en comercial_llamadas con origen 'vencimiento' → la meta diaria
//      y las métricas la cuentan de inmediato, sin cambiar su lógica.
//   2. Actualiza los vencimientos del cliente según el resultado:
//      · acepta      → gestionado:true (canalGestion 'telemercadeo')
//      · reprogramar → telemercadeo.proximaLlamada (sale de la cola hasta la fecha)
//      · no_contesto → intento++; al 3.º → telemercadeo.sinContacto (sale de cola,
//                      pero el vencimiento sigue VENCIDO en su módulo)
//      · no_interesa → gestionado:true + motivoNoInteresa (no molesta más este ciclo)
// Body: { resultado, notas?, proximaLlamada?: {fecha,hora?}, motivoDescarte?,
//         vencimientoIds?: [] (si no vienen, aplica a todos los del cliente) }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/vencidos/:clienteId/llamada', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const uid = getUserId(req);
    const hoy = hoyColombia();
    const { resultado, notas, proximaLlamada, motivoDescarte, vencimientoIds } = req.body || {};

    // ✅ FIX TELEVENC-YAREC-001: nuevo resultado 'ya_recargo' — el cliente
    // ya hizo la recarga (con nosotros o con otro): equipos gestionados,
    // sin motivo obligatorio y SIN contar como conversión.
    if (!['acepta', 'reprogramar', 'no_contesto', 'no_interesa', 'ya_recargo'].includes(resultado)) {
      return res.status(400).json({ error: 'Resultado inválido' });
    }
    if (resultado === 'reprogramar' && !esFecha(proximaLlamada?.fecha)) {
      return res.status(400).json({ error: 'Reprogramar requiere fecha (YYYY-MM-DD)' });
    }
    if (resultado === 'no_interesa' && !motivoDescarte) {
      return res.status(400).json({ error: 'Indica el motivo del descarte' });
    }

    // ✅ TENANT-ADMINID-002: el clienteId llega del cliente HTTP — se valida
    // propiedad para que nadie gestione vencimientos de otro tenant.
    const cliDoc = await db.collection('clients').doc(req.params.clienteId).get();
    if (!cliDoc.exists || cliDoc.data().adminId !== adminId) {
      return res.status(403).json({ error: 'El cliente no pertenece a tu cuenta' });
    }
    const cliente = cliDoc.data();

    // Vencimientos objetivo: no gestionados del cliente (o los ids indicados)
    const vencSnap = await db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .where('clienteId', '==', req.params.clienteId)
      .get();
    let objetivo = vencSnap.docs.filter(d => !d.data().gestionado);
    if (Array.isArray(vencimientoIds) && vencimientoIds.length) {
      const setIds = new Set(vencimientoIds);
      objetivo = objetivo.filter(d => setIds.has(d.id));
    }
    objetivo = objetivo.slice(0, 450); // guardia límite de batch Firestore

    const ts = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();

    objetivo.forEach(d => {
      const prev = d.data().telemercadeo || {};
      const seguimiento = {
        totalLlamadas: (prev.totalLlamadas || 0) + 1,
        ultimaLlamada: hoy,
        notas: notas || prev.notas || null,
        intentosFallidos: prev.intentosFallidos || 0,
        proximaLlamada: null,
        sinContacto: false,
      };
      const update = { telemercadeo: seguimiento, updatedAt: ts };

      if (resultado === 'acepta') {
        update.gestionado = true;
        update.canalGestion = 'telemercadeo';
        update.gestionadoPor = uid;
        update.gestionadoPorNombre = req.user?.nombre || req.user?.email || null;
        update.fechaGestion = hoy;
      } else if (resultado === 'reprogramar') {
        seguimiento.proximaLlamada = {
          fecha: proximaLlamada.fecha,
          hora: esHora(proximaLlamada.hora) ? proximaLlamada.hora : null,
        };
        seguimiento.intentosFallidos = 0;
      } else if (resultado === 'no_contesto') {
        seguimiento.intentosFallidos = (prev.intentosFallidos || 0) + 1;
        if (seguimiento.intentosFallidos >= 3) {
          seguimiento.sinContacto = true; // agotado: sale de la cola, sigue VENCIDO
        } else {
          seguimiento.proximaLlamada = { fecha: siguienteDiaHabil(hoy), hora: null };
        }
      } else if (resultado === 'no_interesa') {
        update.gestionado = true;
        update.canalGestion = 'telemercadeo';
        update.motivoNoInteresa = motivoDescarte;
        update.gestionadoPor = uid;
        update.gestionadoPorNombre = req.user?.nombre || req.user?.email || null;
        update.fechaGestion = hoy;
      } else if (resultado === 'ya_recargo') {
        // ✅ FIX TELEVENC-YAREC-001: al día — sale de la cola sin ser venta
        update.gestionado = true;
        update.canalGestion = 'telemercadeo';
        update.yaRecargo = true;
        update.gestionadoPor = uid;
        update.gestionadoPorNombre = req.user?.nombre || req.user?.email || null;
        update.fechaGestion = hoy;
      }

      batch.update(d.ref, update);
    });

    if (objetivo.length) await batch.commit();

    // ✅ FIX TELEVENC-NOINT-001: recordar en el CLIENTE que no está
    // interesado (6 meses). Sin esto, cualquier vencimiento nuevo del
    // mismo cliente (renovación, re-importación, equipo no seleccionado)
    // lo devolvía a la cola de llamadas.
    if (resultado === 'no_interesa') {
      try {
        const base = new Date(hoy + 'T12:00:00');
        base.setMonth(base.getMonth() + 6);
        await db.collection('clients').doc(req.params.clienteId).update({
          telemercadeoNoInteresa: { motivo: motivoDescarte, fecha: hoy, hasta: base.toISOString().slice(0, 10) }
        });
      } catch (eNI) { console.warn('TELEVENC-NOINT-001:', eNI.message); }
    }

    // Log plano para métricas y META DIARIA — origen 'vencimiento' separa
    // retención (recompra) de captación (prospectos) en los reportes.
    await db.collection('comercial_llamadas').add({
      adminId,
      prospectoId: null,
      clienteId: req.params.clienteId,
      prospectoNombre: cliente.nombre || cliente.empresa || '',
      origen: 'vencimiento', // ✅ TELEVENC-002
      vendedoraId: uid,
      vendedoraNombre: req.user?.nombre || req.user?.email || null,
      resultado,
      notas: notas || null,
      motivoDescarte: resultado === 'no_interesa' ? motivoDescarte : null,
      fecha: hoy,
      createdAt: ts,
    });

    await auditar({
      accion: 'llamada_vencido',
      descripcion: `Llamada de retención a "${cliente.nombre || ''}": ${resultado} (${objetivo.length} equipos)`,
      usuarioId: uid, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { clienteId: req.params.clienteId, resultado, equipos: objetivo.length },
    });

    return res.json({
      ok: true,
      actualizados: objetivo.length,
      // Datos listos para "Crear orden ahora" (prefill de NuevaOrden)
      cliente: {
        id: req.params.clienteId,
        nombre: cliente.nombre || '',
        nit: cliente.nit || '',
        celular: cliente.celular || cliente.telefono || '',
        empresaId: cliente.empresaId || '',
        empresaNombre: cliente.empresaNombre || '',
      },
    });
  } catch (err) {
    console.error('POST /comercial/vencidos/llamada:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/comercial/prospectos/:id/llamada — Registrar resultado de llamada
// Body: { resultado: 'acepta'|'reprogramar'|'no_contesto'|'no_interesa',
//         notas?, proximaLlamada?: { fecha, hora? },
//         motivoDescarte?,  // requerido si no_interesa
//         equiposCapturados?: [{ sucursal?, equipo, cantidad?, fechaUltimaRecarga? }],
//         empresaId?, empresaNombre? } // ✅ TELEVENC-003: para crear el cliente
//                                      // cuando la llamada captura FECHAS
// ═════════════════════════════════════════════════════════════════════════════
router.post('/prospectos/:id/llamada', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const uid = getUserId(req);
    const hoy = hoyColombia();
    const { resultado, notas, proximaLlamada, motivoDescarte, equiposCapturados, telefonoCorregido,
            empresaId, empresaNombre } = req.body;

    if (!['acepta', 'reprogramar', 'no_contesto', 'no_interesa', 'numero_errado'].includes(resultado)) {
      return res.status(400).json({ error: 'Resultado inválido' });
    }

    const ref = db.collection('prospectos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const p = doc.data();
    if (p.adminId !== adminId) return res.status(403).json({ error: 'No autorizado' });

    const update = {
      // ✅ FIX TELEVENC-NOTAS-001: una llamada SIN notas ya NO borra la
      // nota de la llamada anterior (antes escribía null y se perdían)
      notasUltimaLlamada: notas || p.notasUltimaLlamada || null,
      totalLlamadas: (p.totalLlamadas || 0) + 1,
      ultimaLlamada: hoy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // ─── Captura de equipos/fechas (enriquecimiento de base) ───
    let vencimientosCreados = 0;
    let clienteVinculadoId = p.clienteId || null;
    if (Array.isArray(equiposCapturados) && equiposCapturados.length) {
      const limpios = equiposCapturados
        .filter(e => e && e.equipo)
        .map(e => ({
          sucursal: e.sucursal || null,
          equipo: String(e.equipo),
          cantidad: Number(e.cantidad) || 1,
          fechaUltimaRecarga: esFecha(e.fechaUltimaRecarga) ? e.fechaUltimaRecarga : null,
        }));
      const conFecha = limpios.filter(e => e.fechaUltimaRecarga);
      const sinFecha = limpios.filter(e => !e.fechaUltimaRecarga);

      // ✅ TELEVENC-003: si el prospecto informó FECHAS pero aún no es cliente,
      // se resuelve/crea el cliente AQUÍ (regla única de identidad: teléfono →
      // NIT → nombre) para que los equipos entren a `vencimientos` de una vez
      // y el prospecto salga de la cola. Requiere empresaId (facturadora) solo
      // si toca CREAR cliente nuevo; si no llega, se mantiene el flujo previo
      // (los equipos quedan en el prospecto hasta la conversión).
      if (conFecha.length && !clienteVinculadoId) {
        try {
          const hallazgo = await buscarClientePorIdentidad(adminId, {
            telefono: p.telefono, nit: p.nit, nombre: p.nombre,
          });
          if (hallazgo.clienteId) {
            clienteVinculadoId = hallazgo.clienteId; // vincular, nunca duplicar
          } else if (empresaId) {
            const telInfo = normalizarTelefonoInfo(p.telefono);
            const refC = await db.collection('clients').add({
              adminId,
              nombre: String(p.nombre || '').toUpperCase().trim(),
              tipoDocumento: 'NIT',
              nit: String(p.nit || '').replace(/\D/g, '') || null,
              celular: telInfo.tel,
              telefono: telInfo.tel,
              telefonoPorVerificar: !telInfo.valido,
              emailLegal: null,
              emailsAdicionales: [],
              direccionPrincipal: null,
              ciudad: null,
              contacto: null,
              empresaId,
              empresaNombre: empresaNombre || '',
              sucursales: [],
              notas: p.empresa && p.empresa !== p.nombre ? `Empresa reportada en llamada: ${p.empresa}` : '',
              origen: 'telemercadeo_fecha', // ✅ TELEVENC-003
              activo: true,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            clienteVinculadoId = refC.id;
          }
        } catch (eC) { console.warn('TELEVENC-003 resolver cliente:', eC.message); }
      }

      if (clienteVinculadoId && conFecha.length) {
        // Cliente resuelto → los equipos CON fecha nacen como vencimientos
        const batch = db.batch();
        conFecha.forEach(e => {
          const refV = db.collection('vencimientos').doc();
          batch.set(refV, {
            adminId, clienteId: clienteVinculadoId,
            sucursal: e.sucursal,
            descripcionEquipo: e.equipo,
            cantidad: e.cantidad,
            fechaUltimaRecarga: e.fechaUltimaRecarga,
            fechaVencimiento: sumarMeses(e.fechaUltimaRecarga, 12),
            gestionado: false,
            origenDato: 'llamada',
            ordenId: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          vencimientosCreados++;
        });
        if (vencimientosCreados) await batch.commit();
        if (!p.clienteId) update.clienteId = clienteVinculadoId;
        // Los equipos SIN fecha se conservan en el prospecto para completarlos
        if (sinFecha.length) update.equiposCapturados = [...(p.equiposCapturados || []), ...sinFecha];
      } else {
        // Sin cliente resuelto → quedan en el prospecto; se vuelven
        // vencimientos automáticamente al convertir
        update.equiposCapturados = [...(p.equiposCapturados || []), ...limpios];
      }
    }

    // ─── Transición de estado según resultado ───
    switch (resultado) {
      case 'acepta':
        // El frontend llama después a /convertir — aquí solo se registra
        update.estado = 'EN_GESTION';
        update.proximaLlamada = null;
        break;

      case 'reprogramar':
        if (!proximaLlamada?.fecha || !esFecha(proximaLlamada.fecha)) {
          return res.status(400).json({ error: 'Reprogramar requiere fecha (YYYY-MM-DD)' });
        }
        update.estado = 'REPROGRAMADO';
        update.proximaLlamada = {
          fecha: proximaLlamada.fecha,
          hora: esHora(proximaLlamada.hora) ? proximaLlamada.hora : null,
        };
        update.intentosFallidos = 0;
        break;

      case 'no_contesto': {
        const intentos = (p.intentosFallidos || 0) + 1;
        update.intentosFallidos = intentos;
        if (intentos >= 3) {
          update.estado = 'SIN_CONTACTO';
          update.proximaLlamada = null;
        } else {
          update.estado = 'EN_GESTION';
          // Reintento en el próximo DÍA HÁBIL (no fin de semana)
          update.proximaLlamada = { fecha: siguienteDiaHabil(hoy), hora: null };
        }
        break;
      }

      case 'no_interesa':
        if (!motivoDescarte) return res.status(400).json({ error: 'Indica el motivo del descarte' });
        update.estado = 'DESCARTADO';
        update.motivoDescarte = motivoDescarte;
        update.proximaLlamada = null;
        break;

      case 'numero_errado':
        update.estado = 'NUMERO_ERRADO';
        update.proximaLlamada = null;
        update.intentosFallidos = 0;
        // Si la comercial ya consiguió el número correcto, se actualiza en el acto
        if (telefonoCorregido) {
          const telNorm = normalizarTelefono(telefonoCorregido);
          if (telNorm) {
            // Verificar que no exista otro prospecto con ese teléfono
            const dup = await db.collection('prospectos')
              .where('adminId', '==', p.adminId)
              .where('telefono', '==', telNorm)
              .limit(1).get();
            if (!dup.empty && dup.docs[0].id !== req.params.id) {
              return res.status(409).json({ error: 'Ya existe un prospecto con ese número. Revisa la lista.' });
            }
            update.telefono = telNorm;
            update.estado = 'NUEVO'; // con número correcto vuelve a la cola
          }
        }
        break;
    }

    // ✅ TELEVENC-003: si la llamada CREÓ vencimientos (informaron la fecha) y
    // el resultado no cierra el ciclo (acepta/no_interesa/numero_errado), el
    // prospecto pasa a A_VENCIMIENTOS: deja de salir en las colas de prospectos
    // y su cliente entrará SOLO a la cola de Vencidos cuando llegue su mes.
    let pasoAVencimientos = false;
    if (vencimientosCreados > 0 && !['acepta', 'no_interesa', 'numero_errado'].includes(resultado)) {
      update.estado = 'A_VENCIMIENTOS';
      update.proximaLlamada = null;
      pasoAVencimientos = true;
    }

    await ref.update(update);

    // ─── Log plano para métricas (no requiere índices compuestos extra) ───
    await db.collection('comercial_llamadas').add({
      adminId,
      prospectoId: req.params.id,
      prospectoNombre: p.nombre,
      origen: 'prospecto', // ✅ TELEVENC-002: separa captación de retención
      vendedoraId: uid,
      vendedoraNombre: req.user?.nombre || req.user?.email || null,
      resultado,
      notas: notas || null,
      fecha: hoy,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, nuevoEstado: update.estado, vencimientosCreados, pasoAVencimientos });
  } catch (err) {
    console.error('POST llamada:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/comercial/prospectos/:id/convertir — Prospecto → Cliente
// Crea el cliente en `clients`, migra equiposCapturados a `vencimientos`
// y deja trazabilidad de la conversión (R-COM-03)
//
// ✅ TELEVENC-004: anti-duplicado INTERACTIVO — si existe un cliente con el
// mismo teléfono, NIT o nombre, ya NO se vincula/crea en silencio: se
// responde 409 { requiereDecision } para que la comercial decida en el modal:
//   · decisionDuplicado: 'usar_existente' (+ clienteExistenteId) → vincular
//   · decisionDuplicado: 'crear_nuevo' → es otra sede / cliente multiempresa
// (Si el prospecto YA venía vinculado por importación — p.clienteId — se
//  respeta ese vínculo sin preguntar.)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/prospectos/:id/convertir', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const uid = getUserId(req);
    const hoy = hoyColombia();
    // Ola 3: la conversión recibe los datos COMPLETOS verificados en el modal
    // y crea el cliente con el ESQUEMA OFICIAL del módulo Clientes (antes
    // creaba un "cliente huérfano" con campos de prospecto que no aparecía
    // en la lista ni se podía editar).
    const { email, direccion, nit, nombre: nombreBody, celular,
            empresaId, empresaNombre, ciudad, contacto,
            decisionDuplicado, clienteExistenteId } = req.body || {};
    const nombreFinal = String(nombreBody || '').toUpperCase().trim();
    const nitFinal = (nit || '').toString().replace(/\D/g, '') || null;

    const ref = db.collection('prospectos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const p = doc.data();
    if (p.adminId !== adminId) return res.status(403).json({ error: 'No autorizado' });
    if (p.estado === 'CONVERTIDO') return res.status(409).json({ error: 'Este prospecto ya fue convertido', clienteId: p.clienteId });

    let clienteId = p.clienteId;

    // ✅ TELEVENC-004: decisión explícita del modal
    if (!clienteId && decisionDuplicado === 'usar_existente') {
      if (!clienteExistenteId) return res.status(400).json({ error: 'Falta clienteExistenteId' });
      const exDoc = await db.collection('clients').doc(clienteExistenteId).get();
      if (!exDoc.exists || exDoc.data().adminId !== adminId) {
        return res.status(403).json({ error: 'El cliente indicado no pertenece a tu cuenta' });
      }
      clienteId = clienteExistenteId;
    }

    // Búsqueda por identidad (teléfono → NIT → nombre) — CLIENTES-DUP-001
    if (!clienteId && decisionDuplicado !== 'crear_nuevo') {
      const hallazgo = await buscarClientePorIdentidad(adminId, {
        telefono: p.telefono, nit: nitFinal, nombre: nombreFinal || p.nombre,
      });
      if (hallazgo.clienteId) {
        // ✅ TELEVENC-004: coincidencia encontrada → decisión humana informada
        const c = hallazgo.cliente || {};
        return res.status(409).json({
          requiereDecision: true,
          coincidencia: {
            tipo: hallazgo.tipo, // 'telefono' | 'nit' | 'nombre'
            cliente: {
              id: hallazgo.clienteId,
              nombre: c.nombre || '',
              nit: c.nit || '',
              celular: c.celular || c.telefono || '',
              empresaId: c.empresaId || '',
              empresaNombre: c.empresaNombre || '',
              direccion: c.direccionPrincipal || '',
            },
          },
        });
      }
    }

    if (!clienteId) {
      if (!empresaId) {
        return res.status(400).json({ error: 'Selecciona la empresa que factura (igual que al crear un cliente)' });
      }
      const telInfo = normalizarTelefonoInfo(p.telefono);
      const refC = await db.collection('clients').add({
        adminId,
        nombre: nombreFinal || String(p.nombre || '').toUpperCase().trim(),
        tipoDocumento: 'NIT',
        nit: nitFinal,
        // ✅ DUP-002: normalizar al convertir — un prospecto viejo pudo quedar
        // guardado con 57; el cliente debe nacer con 10 dígitos limpios para
        // que coincida con la regla de identidad y no genere un falso duplicado.
        celular: telInfo.tel,
        telefono: telInfo.tel,
        telefonoPorVerificar: !telInfo.valido, // ✅ TELEFONO-UNIF-001
        emailLegal: email || null,
        emailsAdicionales: [],
        direccionPrincipal: direccion || null,
        ciudad: ciudad || null,
        contacto: contacto || null,
        empresaId,
        empresaNombre: empresaNombre || '',
        sucursales: [],
        notas: p.empresa && p.empresa !== p.nombre ? `Empresa reportada en llamada: ${p.empresa}` : '',
        origen: 'telemercadeo',
        activo: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      clienteId = refC.id;
    }

    // Migrar equipos capturados en llamadas → vencimientos (origen 'llamada')
    let vencimientosCreados = 0;
    if (Array.isArray(p.equiposCapturados) && p.equiposCapturados.length) {
      const batch = db.batch();
      p.equiposCapturados.forEach(e => {
        if (!e.fechaUltimaRecarga) return;
        const refV = db.collection('vencimientos').doc();
        batch.set(refV, {
          adminId, clienteId,
          sucursal: e.sucursal || null,
          descripcionEquipo: e.equipo,
          cantidad: e.cantidad || 1,
          fechaUltimaRecarga: e.fechaUltimaRecarga,
          fechaVencimiento: sumarMeses(e.fechaUltimaRecarga, 12),
          gestionado: false,
          origenDato: 'llamada',
          ordenId: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        vencimientosCreados++;
      });
      if (vencimientosCreados) await batch.commit();
    }

    await ref.update({
      estado: 'CONVERTIDO',
      clienteId,
      convertidoPor: uid,
      convertidoPorNombre: req.user?.nombre || req.user?.email || null,
      fechaConversion: hoy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await auditar({
      accion: 'convertir', descripcion: `Prospecto "${p.nombre}" convertido a cliente`,
      usuarioId: uid, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { prospectoId: req.params.id, clienteId, vencimientosCreados, decisionDuplicado: decisionDuplicado || null }
    });

    return res.json({
      ok: true, clienteId, vencimientosCreados,
      cliente: { id: clienteId, nombre: nombreFinal || String(p.nombre || '').toUpperCase().trim(), nit: nitFinal || '', celular: normalizarTelefono(p.telefono) || p.telefono, empresaId: empresaId || '', empresaNombre: empresaNombre || '' }
    });
  } catch (err) {
    console.error('POST convertir:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/comercial/prospectos/:id — Editar / asignar vendedora (admin)
// ═════════════════════════════════════════════════════════════════════════════
router.put('/prospectos/:id', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const ref = db.collection('prospectos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Prospecto no encontrado' });
    if (doc.data().adminId !== adminId) return res.status(403).json({ error: 'No autorizado' });

    const { nombre, empresa, sucursal, asignadoA, notas, estado, telefono } = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (nombre) update.nombre = String(nombre).trim();
    if (empresa !== undefined) update.empresa = empresa;
    if (sucursal !== undefined) update.sucursal = sucursal;
    if (notas !== undefined) update.notas = notas;

    // Corrección de teléfono (disponible para vendedora cuando estado es NUMERO_ERRADO)
    if (telefono !== undefined) {
      const esNumeroErrado = doc.data().estado === 'NUMERO_ERRADO';
      const puedeEditarTel = req.user?.role === 'admin' || esNumeroErrado;
      if (!puedeEditarTel) return res.status(403).json({ error: 'Solo puedes editar el teléfono cuando el número está marcado como errado' });
      const telNorm = normalizarTelefono(telefono);
      if (!telNorm) return res.status(400).json({ error: 'Teléfono inválido' });
      // Anti-duplicado
      const dup = await db.collection('prospectos')
        .where('adminId', '==', adminId)
        .where('telefono', '==', telNorm)
        .limit(1).get();
      if (!dup.empty && dup.docs[0].id !== req.params.id) {
        return res.status(409).json({ error: 'Ya existe un prospecto con ese número' });
      }
      update.telefono = telNorm;
      // Si tenía número errado y ahora lo corrige → vuelve a NUEVO
      if (esNumeroErrado) update.estado = 'NUEVO';
    }

    if (asignadoA !== undefined) {
      if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo el admin asigna prospectos' });
      update.asignadoA = asignadoA;
    }
    if (estado) {
      if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo el admin cambia estados manualmente' });
      if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
      update.estado = estado;
    }

    await ref.update(update);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/comercial/meta/:vendedoraId — Configurar meta diaria (admin, R-COM-08)
// Body: { metaLlamadasDiarias: 200 }
// ═════════════════════════════════════════════════════════════════════════════
router.put('/meta/:vendedoraId', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador configura metas' });
    const meta = Number(req.body?.metaLlamadasDiarias);
    if (!meta || meta < 1) return res.status(400).json({ error: 'Meta inválida' });

    await db.collection('users').doc(req.params.vendedoraId).update({ metaLlamadasDiarias: meta });

    await auditar({
      accion: 'configurar_meta', descripcion: `Meta diaria de ${meta} llamadas asignada`,
      usuarioId: getAdminId(req), usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { vendedoraId: req.params.vendedoraId, meta }
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/comercial/metricas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD — Panel admin
// Por vendedora: llamadas, tasa de contacto, conversiones, cumplimiento de meta
// ✅ TELEVENC-002: incluye desglose retención vs captación (origen de llamada)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/metricas', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador ve métricas' });
    const adminId = getAdminId(req);
    const hoy = hoyColombia();
    const desde = esFecha(req.query.desde) ? req.query.desde : hoy.slice(0, 8) + '01'; // mes actual
    const hasta = esFecha(req.query.hasta) ? req.query.hasta : hoy;

    const snap = await db.collection('comercial_llamadas')
      .where('adminId', '==', adminId)
      .limit(10000)
      .get();

    const llamadas = snap.docs.map(d => d.data())
      .filter(l => l.fecha >= desde && l.fecha <= hasta);

    // Conversiones del periodo
    const prosSnap = await db.collection('prospectos')
      .where('adminId', '==', adminId)
      .where('estado', '==', 'CONVERTIDO')
      .get();
    const conversiones = prosSnap.docs.map(d => d.data())
      .filter(p => p.fechaConversion >= desde && p.fechaConversion <= hasta);

    // Metas configuradas
    const usersSnap = await db.collection('users').where('creadoPor', '==', adminId).get();
    const metas = {};
    usersSnap.docs.forEach(d => { metas[d.id] = Number(d.data().metaLlamadasDiarias) || 0; });

    // Agrupar por vendedora
    const porVendedora = {};
    llamadas.forEach(l => {
      const v = porVendedora[l.vendedoraId] = porVendedora[l.vendedoraId] || {
        vendedoraId: l.vendedoraId,
        nombre: l.vendedoraNombre || l.vendedoraId,
        total: 0, contactadas: 0, noContestadas: 0, descartes: 0,
        conversiones: 0, diasActivos: new Set(), metaDiaria: metas[l.vendedoraId] || 0,
        llamadasRetencion: 0, llamadasCaptacion: 0, // ✅ TELEVENC-002
      };
      v.total++;
      if (l.origen === 'vencimiento') v.llamadasRetencion++; else v.llamadasCaptacion++;
      if (l.resultado === 'no_contesto') v.noContestadas++; else v.contactadas++;
      if (l.resultado === 'no_interesa') v.descartes++;
      // ✅ FIX TELEVENC-CONV-001: la venta de RETENCIÓN (vencido que acepta)
      // también es conversión — antes solo contaban prospectos convertidos
      if (l.origen === 'vencimiento' && l.resultado === 'acepta') v.conversiones++;
      v.diasActivos.add(l.fecha);
    });
    conversiones.forEach(c => {
      if (c.convertidoPor && porVendedora[c.convertidoPor]) porVendedora[c.convertidoPor].conversiones++;
    });

    const resultado = Object.values(porVendedora).map(v => {
      const dias = v.diasActivos.size || 1;
      return {
        vendedoraId: v.vendedoraId,
        nombre: v.nombre,
        totalLlamadas: v.total,
        promedioDiario: Math.round(v.total / dias),
        tasaContacto: v.total ? Math.round((v.contactadas / v.total) * 100) : 0,
        conversiones: v.conversiones,
        tasaConversion: v.contactadas ? Math.round((v.conversiones / v.contactadas) * 100) : 0,
        llamadasRetencion: v.llamadasRetencion, // ✅ TELEVENC-002
        llamadasCaptacion: v.llamadasCaptacion, // ✅ TELEVENC-002
        metaDiaria: v.metaDiaria,
        cumplimientoMeta: v.metaDiaria ? Math.round(((v.total / dias) / v.metaDiaria) * 100) : null,
        diasActivos: dias,
      };
    });

    // Motivos de descarte (inteligencia de mercado)
    const motivos = {};
    const descartadosSnap = await db.collection('prospectos')
      .where('adminId', '==', adminId)
      .where('estado', '==', 'DESCARTADO')
      .get();
    descartadosSnap.docs.forEach(d => {
      const m = d.data().motivoDescarte || 'sin_motivo';
      motivos[m] = (motivos[m] || 0) + 1;
    });

    return res.json({ desde, hasta, vendedoras: resultado, motivosDescarte: motivos });
  } catch (err) {
    console.error('GET /comercial/metricas:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/comercial/reporte-telemercadeo — Reporte completo para Reportes
// ─────────────────────────────────────────────────────────────────────────────
// Extiende /metricas con: ventas en COP, embudo completo, convertidos con
// su orden, e inteligencia de motivos en el período (no solo los descartados
// globales). Accesible por admin.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/reporte-telemercadeo', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador ve este reporte' });
    const adminId = getAdminId(req);
    const hoy = hoyColombia();
    const desde = esFecha(req.query.desde) ? req.query.desde : hoy.slice(0, 8) + '01';
    const hasta = esFecha(req.query.hasta) ? req.query.hasta : hoy;

    // ── 1. Llamadas del período ───────────────────────────────────────────────
    const snapLlamadas = await db.collection('comercial_llamadas')
      .where('adminId', '==', adminId).limit(10000).get();
    const llamadas = snapLlamadas.docs.map(d => d.data())
      .filter(l => l.fecha >= desde && l.fecha <= hasta);

    // ── 2. Prospectos del tenant (base del embudo) ────────────────────────────
    const snapProspectos = await db.collection('prospectos')
      .where('adminId', '==', adminId).limit(5000).get();
    const todosProspectos = snapProspectos.docs.map(d => ({ id: d.id, ...d.data() }));

    // Prospectos activos en el período: creados o actualizados dentro del rango
    const prospectosEnPeriodo = todosProspectos.filter(p => {
      const creado = (p.createdAt?.toDate ? p.createdAt.toDate().toISOString() : String(p.createdAt || '')).slice(0, 10);
      return creado >= desde && creado <= hasta;
    });

    // Convertidos en el período (fuente de verdad: fecha de conversión)
    const convertidosPeriodo = todosProspectos.filter(p =>
      p.estado === 'CONVERTIDO' && p.fechaConversion >= desde && p.fechaConversion <= hasta
    );

    // ── 3. Órdenes generadas desde telemercadeo en el período ─────────────────
    // (las que tienen clienteId de algún convertido → ventas en COP)
    const idsClientesConv = new Set(convertidosPeriodo.map(p => p.clienteId).filter(Boolean));
    let ordenesTelemercadeo = [];
    if (idsClientesConv.size > 0) {
      const snapOrds = await db.collection('orders')
        .where('adminId', '==', adminId).limit(3000).get();
      const ini = new Date(`${desde}T05:00:00.000Z`).getTime();
      const fin = new Date(`${hasta}T05:00:00.000Z`).getTime() + 86400000;
      ordenesTelemercadeo = snapOrds.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => {
        if (!idsClientesConv.has(o.clienteId)) return false;
        const s = o.createdAt?._seconds || o.createdAt?.seconds;
        const ms = s ? s * 1000 : Date.parse(o.createdAt || 0);
        return ms >= ini && ms < fin && o.estado !== 'anulada';
      });
    }

    // ── 4. Metas y usuarios ────────────────────────────────────────────────────
    const usersSnap = await db.collection('users').where('creadoPor', '==', adminId).get();
    const metas = {};
    const nombreUsuario = {};
    usersSnap.docs.forEach(d => {
      metas[d.id] = Number(d.data().metaLlamadasDiarias) || 0;
      nombreUsuario[d.id] = d.data().nombre || d.data().email || d.id;
    });

    // ── 5. KPIs por asesora ───────────────────────────────────────────────────
    const porAsesora = {};
    llamadas.forEach(l => {
      const v = porAsesora[l.vendedoraId] = porAsesora[l.vendedoraId] || {
        id: l.vendedoraId,
        nombre: l.vendedoraNombre || nombreUsuario[l.vendedoraId] || l.vendedoraId,
        totalLlamadas: 0, contactadas: 0, noContestadas: 0, reprogramadas: 0,
        conversiones: 0, descartadas: 0,
        llamadasRetencion: 0, llamadasCaptacion: 0, // ✅ TELEVENC-002
        diasActivos: new Set(), metaDiaria: metas[l.vendedoraId] || 0,
        ventasCOP: 0,
      };
      v.totalLlamadas++;
      if (l.origen === 'vencimiento') v.llamadasRetencion++; else v.llamadasCaptacion++;
      if (l.resultado === 'no_contesto') v.noContestadas++;
      else if (l.resultado === 'reprogramar') v.reprogramadas++;
      else if (l.resultado === 'no_interesa') { v.descartadas++; v.contactadas++; }
      else v.contactadas++;
      // ✅ FIX TELEVENC-CONV-001: retención (vencido acepta) suma conversión
      if (l.origen === 'vencimiento' && l.resultado === 'acepta') v.conversiones++;
      v.diasActivos.add(l.fecha);
    });

    convertidosPeriodo.forEach(p => {
      if (p.convertidoPor) {
        const v = porAsesora[p.convertidoPor];
        if (v) v.conversiones++;
      }
    });

    ordenesTelemercadeo.forEach(o => {
      // Buscar la asesora que convirtió este cliente
      const pConv = convertidosPeriodo.find(p => p.clienteId === o.clienteId);
      if (pConv?.convertidoPor && porAsesora[pConv.convertidoPor]) {
        porAsesora[pConv.convertidoPor].ventasCOP += Number(o.total) || 0;
      }
    });

    const asesoras = Object.values(porAsesora).map(v => {
      const dias = v.diasActivos.size || 1;
      const promedioDiario = Math.round(v.totalLlamadas / dias);
      return {
        id: v.id, nombre: v.nombre,
        totalLlamadas: v.totalLlamadas,
        promedioDiario,
        diasActivos: dias,
        contactadas: v.contactadas,
        noContestadas: v.noContestadas,
        reprogramadas: v.reprogramadas,
        descartadas: v.descartadas,
        conversiones: v.conversiones,
        llamadasRetencion: v.llamadasRetencion, // ✅ TELEVENC-002
        llamadasCaptacion: v.llamadasCaptacion, // ✅ TELEVENC-002
        tasaContacto: v.totalLlamadas ? Math.round((v.contactadas / v.totalLlamadas) * 100) : 0,
        tasaConversion: v.contactadas ? Math.round((v.conversiones / v.contactadas) * 100) : 0,
        ventasCOP: v.ventasCOP,
        ticketPromedio: v.conversiones > 0 ? Math.round(v.ventasCOP / v.conversiones) : 0,
        metaDiaria: v.metaDiaria,
        cumplimientoMeta: v.metaDiaria ? Math.round((promedioDiario / v.metaDiaria) * 100) : null,
      };
    }).sort((a, b) => b.conversiones - a.conversiones);

    // ── 6. Embudo del período ─────────────────────────────────────────────────
    const totalAsignados = prospectosEnPeriodo.length;
    const totalContactados = new Set(llamadas.map(l => l.prospectoId)).size;
    const totalReprogramados = todosProspectos.filter(p =>
      p.estado === 'REPROGRAMADO' &&
      p.proximaLlamada?.fecha >= desde && p.proximaLlamada?.fecha <= hasta
    ).length;
    const embudo = {
      asignados: totalAsignados,
      contactados: totalContactados,
      reprogramados: totalReprogramados,
      convertidos: convertidosPeriodo.length,
      descartados: todosProspectos.filter(p =>
        p.estado === 'DESCARTADO' &&
        (p.updatedAt?.toDate ? p.updatedAt.toDate().toISOString() : '').slice(0, 10) >= desde
      ).length,
      pctContacto: totalAsignados ? Math.round((totalContactados / totalAsignados) * 100) : 0,
      pctConversion: totalContactados ? Math.round((convertidosPeriodo.length / totalContactados) * 100) : 0,
    };

    // ── 7. Motivos de descarte del período ────────────────────────────────────
    const motivosSnap = await db.collection('comercial_llamadas')
      .where('adminId', '==', adminId).where('resultado', '==', 'no_interesa').limit(5000).get();
    const motivosCont = {};
    motivosSnap.docs.map(d => d.data())
      .filter(l => l.fecha >= desde && l.fecha <= hasta)
      .forEach(l => {
        const m = l.motivoDescarte || l.notas || 'Sin especificar';
        motivosCont[m] = (motivosCont[m] || 0) + 1;
      });
    const motivos = Object.entries(motivosCont)
      .map(([motivo, cantidad]) => ({ motivo, cantidad }))
      .sort((a, b) => b.cantidad - a.cantidad);

    // ── 8. Convertidos con estado de orden ────────────────────────────────────
    const clientesConOrden = new Set(ordenesTelemercadeo.map(o => o.clienteId));
    const convertidosDetalle = convertidosPeriodo.map(p => ({
      id: p.id,
      nombre: p.nombre,
      telefono: p.telefono,
      fechaConversion: p.fechaConversion,
      convertidoPorNombre: p.convertidoPorNombre || nombreUsuario[p.convertidoPor] || '—',
      clienteId: p.clienteId,
      tieneOrden: clientesConOrden.has(p.clienteId),
      totalOrden: ordenesTelemercadeo.filter(o => o.clienteId === p.clienteId).reduce((a, o) => a + (Number(o.total) || 0), 0),
    })).sort((a, b) => (b.fechaConversion || '').localeCompare(a.fechaConversion || ''));

    // ── 9. Totales globales ───────────────────────────────────────────────────
    const totales = {
      llamadas: llamadas.length,
      llamadasRetencion: llamadas.filter(l => l.origen === 'vencimiento').length, // ✅ TELEVENC-002
      llamadasCaptacion: llamadas.filter(l => l.origen !== 'vencimiento').length, // ✅ TELEVENC-002
      conversiones: convertidosPeriodo.length,
      ventasCOP: ordenesTelemercadeo.reduce((a, o) => a + (Number(o.total) || 0), 0),
      ordenesGeneradas: ordenesTelemercadeo.length,
      sinOrden: convertidosPeriodo.filter(p => !clientesConOrden.has(p.clienteId)).length,
    };

    return res.json({ desde, hasta, asesoras, embudo, motivos, convertidos: convertidosDetalle, totales });
  } catch (err) {
    console.error('GET /comercial/reporte-telemercadeo:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
