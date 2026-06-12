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

const normalizarTelefono = (telefono) => {
  if (!telefono) return null;
  let t = String(telefono).replace(/[\s\-\(\)\+\.]/g, '');
  if (t.startsWith('57') && t.length === 12) return t;
  if (t.length === 10 && t.startsWith('3')) return '57' + t;
  return t.length >= 10 ? t : null;
};

const ESTADOS = ['NUEVO', 'EN_GESTION', 'REPROGRAMADO', 'CONVERTIDO', 'DESCARTADO', 'SIN_CONTACTO'];

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
    const { nombre, empresa, telefono, sucursal, origen, asignadoA, notas } = req.body;

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
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    const asignadoA = req.body?.asignadoA || null;

    if (!filas.length) return res.status(400).json({ error: 'No se recibieron filas' });
    if (filas.length > 2000) return res.status(400).json({ error: 'Máximo 2000 filas por importación' });

    // Teléfonos ya existentes (prospectos del tenant) para no duplicar
    const existentesSnap = await db.collection('prospectos').where('adminId', '==', adminId).get();
    const telefonosExistentes = new Set(existentesSnap.docs.map(d => d.data().telefono));

    const resultado = { creados: 0, duplicados: 0, errores: [] };
    let batch = db.batch();
    let ops = 0;

    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const nombre = String(f.nombre || f.empresa || '').trim();
      const tel = normalizarTelefono(f.telefono);

      if (!nombre || !tel) { resultado.errores.push({ fila: i + 2, error: 'Falta nombre o teléfono válido' }); continue; }
      if (telefonosExistentes.has(tel)) { resultado.duplicados++; continue; }
      telefonosExistentes.add(tel);

      const ref = db.collection('prospectos').doc();
      batch.set(ref, {
        adminId, nombre,
        empresa: f.empresa || null,
        telefono: tel,
        sucursal: f.sucursal || null,
        origen: 'importacion',
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
// Prioridad: 1) reprogramados para hoy o atrasados (ordenados por hora)
//            2) en gestión con reintento para hoy   3) nuevos
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
      cola: { reprogramados, reintentos, nuevos },
      totalPendientes: reprogramados.length + reintentos.length + nuevos.length,
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
// POST /api/comercial/prospectos/:id/llamada — Registrar resultado de llamada
// Body: { resultado: 'acepta'|'reprogramar'|'no_contesto'|'no_interesa',
//         notas?, proximaLlamada?: { fecha, hora? },
//         motivoDescarte?,  // requerido si no_interesa
//         equiposCapturados?: [{ sucursal?, equipo, cantidad?, fechaUltimaRecarga? }] }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/prospectos/:id/llamada', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const uid = getUserId(req);
    const hoy = hoyColombia();
    const { resultado, notas, proximaLlamada, motivoDescarte, equiposCapturados } = req.body;

    if (!['acepta', 'reprogramar', 'no_contesto', 'no_interesa'].includes(resultado)) {
      return res.status(400).json({ error: 'Resultado inválido' });
    }

    const ref = db.collection('prospectos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const p = doc.data();
    if (p.adminId !== adminId) return res.status(403).json({ error: 'No autorizado' });

    const update = {
      totalLlamadas: (p.totalLlamadas || 0) + 1,
      ultimaLlamada: hoy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // ─── Captura de equipos/fechas (enriquecimiento de base) ───
    let vencimientosCreados = 0;
    if (Array.isArray(equiposCapturados) && equiposCapturados.length) {
      const limpios = equiposCapturados
        .filter(e => e && e.equipo)
        .map(e => ({
          sucursal: e.sucursal || null,
          equipo: String(e.equipo),
          cantidad: Number(e.cantidad) || 1,
          fechaUltimaRecarga: esFecha(e.fechaUltimaRecarga) ? e.fechaUltimaRecarga : null,
        }));

      if (p.clienteId) {
        // Ya es cliente → crear vencimientos directamente (origen 'llamada')
        const batch = db.batch();
        limpios.forEach(e => {
          if (!e.fechaUltimaRecarga) return;
          const refV = db.collection('vencimientos').doc();
          batch.set(refV, {
            adminId, clienteId: p.clienteId,
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
      } else {
        // Aún no es cliente → quedan en el prospecto; se vuelven
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
          update.proximaLlamada = { fecha: sumarDias(hoy, 1), hora: null }; // reintento mañana
        }
        break;
      }

      case 'no_interesa':
        if (!motivoDescarte) return res.status(400).json({ error: 'Indica el motivo del descarte' });
        update.estado = 'DESCARTADO';
        update.motivoDescarte = motivoDescarte;
        update.proximaLlamada = null;
        break;
    }

    await ref.update(update);

    // ─── Log plano para métricas (no requiere índices compuestos extra) ───
    await db.collection('comercial_llamadas').add({
      adminId,
      prospectoId: req.params.id,
      prospectoNombre: p.nombre,
      vendedoraId: uid,
      vendedoraNombre: req.user?.nombre || req.user?.email || null,
      resultado,
      notas: notas || null,
      fecha: hoy,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, nuevoEstado: update.estado, vencimientosCreados });
  } catch (err) {
    console.error('POST llamada:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/comercial/prospectos/:id/convertir — Prospecto → Cliente
// Crea el cliente en `clients`, migra equiposCapturados a `vencimientos`
// y deja trazabilidad de la conversión (R-COM-03)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/prospectos/:id/convertir', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const uid = getUserId(req);
    const hoy = hoyColombia();
    const { email, direccion, nit } = req.body || {};

    const ref = db.collection('prospectos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const p = doc.data();
    if (p.adminId !== adminId) return res.status(403).json({ error: 'No autorizado' });
    if (p.estado === 'CONVERTIDO') return res.status(409).json({ error: 'Este prospecto ya fue convertido', clienteId: p.clienteId });

    // ¿Ya existe un cliente con ese teléfono? → vincular, no duplicar
    let clienteId = p.clienteId;
    if (!clienteId) {
      const dup = await db.collection('clients')
        .where('adminId', '==', adminId)
        .where('telefono', '==', p.telefono)
        .limit(1).get();
      if (!dup.empty) clienteId = dup.docs[0].id;
    }

    if (!clienteId) {
      const refC = await db.collection('clients').add({
        adminId,
        nombre: p.nombre,
        empresa: p.empresa || null,
        telefono: p.telefono,
        email: email || null,
        direccion: direccion || null,
        nit: nit || null,
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
      datos: { prospectoId: req.params.id, clienteId, vencimientosCreados }
    });

    return res.json({ ok: true, clienteId, vencimientosCreados });
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

    const { nombre, empresa, sucursal, asignadoA, notas, estado } = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (nombre) update.nombre = String(nombre).trim();
    if (empresa !== undefined) update.empresa = empresa;
    if (sucursal !== undefined) update.sucursal = sucursal;
    if (notas !== undefined) update.notas = notas;
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
      };
      v.total++;
      if (l.resultado === 'no_contesto') v.noContestadas++; else v.contactadas++;
      if (l.resultado === 'no_interesa') v.descartes++;
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

module.exports = router;
