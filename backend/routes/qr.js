const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const jwt = require('jsonwebtoken');

// ─── MIDDLEWARE AUTH ──────────────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'control360secret');
    req.user = decoded;
    req.adminId = decoded.uid || decoded.id;
    if (decoded.role !== 'admin') {
      try {
        const userDoc = await db.collection('users').doc(req.adminId).get();
        if (userDoc.exists) req.adminId = userDoc.data().creadoPor || req.adminId;
      } catch (e) {}
    }
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
};

// ─── HELPER: generar código único QR ─────────────────────────────────────────
// Usa el conteo total + el máximo encontrado para evitar números repetidos
// aunque se generen varios QR seguidos.
const generarCodigoQR = async (adminId) => {
  const snap = await db.collection('qr_equipos')
    .where('adminId', '==', adminId)
    .get();
  let maximo = 0;
  snap.forEach(d => {
    const num = parseInt((d.data().codigoQR || '').replace(/\D/g, ''));
    if (!isNaN(num) && num > maximo) maximo = num;
  });
  return `EXT-${String(maximo + 1).padStart(6, '0')}`;
};

// ─── HELPER: buscar QR por código ────────────────────────────────────────────
const buscarQRPorCodigo = async (adminId, codigo) => {
  if (!codigo) return null;
  const snap = await db.collection('qr_equipos')
    .where('codigoQR', '==', codigo.toUpperCase())
    .where('adminId', '==', adminId)
    .limit(1).get();
  return snap.empty ? null : snap.docs[0];
};

// ─── HELPER: info empresa pública ─────────────────────────────────────────────
const getEmpresaPublica = async (adminId, empresaId) => {
  try {
    if (empresaId) {
      const doc = await db.collection('companies').doc(empresaId).get();
      if (doc.exists) {
        const d = doc.data();
        return { nombre: d.name || '', logo: d.logo || '', web: d.website || d.web || '', whatsapp: d.whatsapp || d.celular || d.cellphone || '' };
      }
    }
    const snap = await db.collection('companies').where('adminId', '==', adminId).limit(1).get();
    if (!snap.empty) {
      const d = snap.docs[0].data();
      return { nombre: d.name || '', logo: d.logo || '', web: d.website || d.web || '', whatsapp: d.whatsapp || d.celular || d.cellphone || '' };
    }
  } catch (e) {}
  return null;
};

// ─── HELPER: calcular fechas ──────────────────────────────────────────────────
const calcularFechas = (data) => {
  const ahora = new Date();
  const proximaRecarga = data.proximaRecarga ? new Date(data.proximaRecarga) : null;
  const vencido = proximaRecarga ? ahora > proximaRecarga : false;
  const diasParaVencer = proximaRecarga ? Math.floor((proximaRecarga - ahora) / (1000 * 60 * 60 * 24)) : null;
  const alertaVencimiento = !vencido && diasParaVencer !== null && diasParaVencer <= 30;
  return { vencido, diasParaVencer, alertaVencimiento };
};

// ══════════════════════════════════════════════════════════════════════════════
// RUTAS PÚBLICAS — Sin login
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/qr/public/:codigo — Info pública
router.get('/public/:codigo', async (req, res) => {
  try {
    const snap = await db.collection('qr_equipos').where('codigoQR', '==', req.params.codigo.toUpperCase()).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Equipo no encontrado' });
    const doc = snap.docs[0];
    const data = doc.data();
    const { vencido, diasParaVencer, alertaVencimiento } = calcularFechas(data);
    const empresa = await getEmpresaPublica(data.adminId, data.empresaId);
    const configDoc = await db.collection('qr_config').doc(data.adminId).get();
    const config = configDoc.exists ? configDoc.data() : {};
    res.json({
      codigoQR: data.codigoQR, tipo: data.tipo || '', capacidad: data.capacidad || '',
      propietario: data.propietario || null, ubicacion: data.ubicacion || '', notas: data.notas || '',
      fechaUltimaRecarga: data.fechaUltimaRecarga || null, proximaRecarga: data.proximaRecarga || null,
      proximoMantenimiento: data.proximoMantenimiento || null, fechaPH: data.fechaPH || null,
      requierePH: data.requierePH || false,
      ph: data.requierePH ? (data.ph || null) : undefined,
      presion: data.requierePH ? (data.presion || null) : undefined,
      vencido, diasParaVencer, alertaVencimiento,
      clienteId: data.clienteId || null, adminId: data.adminId,
      empresa, imagenPromo: config.imagenPromo || null, duracionPromo: config.duracionPromo || 4,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/qr/public/cliente/:clienteId — Lista equipos del cliente
router.get('/public/cliente/:clienteId', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (!adminId) return res.status(400).json({ error: 'adminId requerido' });
    const snap = await db.collection('qr_equipos')
      .where('adminId', '==', adminId).where('clienteId', '==', req.params.clienteId).where('activo', '==', true).get();
    const equipos = [];
    snap.forEach(doc => {
      const data = doc.data();
      const { vencido, diasParaVencer } = calcularFechas(data);
      equipos.push({
        codigoQR: data.codigoQR, tipo: data.tipo || '', capacidad: data.capacidad || '',
        ubicacion: data.ubicacion || '', notas: data.notas || '', numeroOrden: data.numeroOrden || '',
        fechaUltimaRecarga: data.fechaUltimaRecarga || null, proximaRecarga: data.proximaRecarga || null,
        fechaPH: data.fechaPH || null, proximoMantenimiento: data.proximoMantenimiento || null,
        requierePH: data.requierePH || false, vencido, diasParaVencer,
      });
    });
    equipos.sort((a, b) => (a.ubicacion || '').localeCompare(b.ubicacion || ''));
    const empresa = await getEmpresaPublica(adminId, null);
    const propietario = snap.empty ? null : snap.docs[0].data().propietario;
    res.json({ clienteId: req.params.clienteId, propietario, totalEquipos: equipos.length, equiposVencidos: equipos.filter(e => e.vencido).length, equipos, empresa });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// RUTAS PRIVADAS — Con login
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/qr — Listar QR
router.get('/', authenticate, async (req, res) => {
  try {
    const { clienteId, sinDueno, buscar, soloNoImpreso } = req.query;
    const snap = await db.collection('qr_equipos').where('adminId', '==', req.adminId).orderBy('createdAt', 'desc').get();
    let equipos = [];
    snap.forEach(doc => equipos.push({ id: doc.id, ...doc.data() }));
    if (clienteId) equipos = equipos.filter(e => e.clienteId === clienteId);
    if (sinDueno === 'true') equipos = equipos.filter(e => !e.clienteId);
    if (soloNoImpreso === 'true') equipos = equipos.filter(e => !e.qrImpreso);
    if (buscar) {
      const term = buscar.toUpperCase();
      equipos = equipos.filter(e => e.codigoQR?.toUpperCase().includes(term) || e.propietario?.toUpperCase().includes(term) || e.tipo?.toUpperCase().includes(term) || e.numeroOrden?.toUpperCase().includes(term));
    }
    equipos = equipos.map(e => { const f = calcularFechas(e); return { ...e, ...f }; });
    res.json(equipos);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/qr/detail/:codigo — Detalle completo con historial
router.get('/detail/:codigo', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('qr_equipos').where('codigoQR', '==', req.params.codigo.toUpperCase()).where('adminId', '==', req.adminId).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Equipo no encontrado' });
    const doc = snap.docs[0];
    const data = doc.data();
    const f = calcularFechas(data);
    res.json({ id: doc.id, ...data, ...f });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/qr — Crear QR manualmente
router.post('/', authenticate, async (req, res) => {
  try {
    if (!['admin', 'taller'].includes(req.user.role)) return res.status(403).json({ error: 'Solo admin o taller' });
    const { tipo, capacidad, clienteId, clienteNombre, ubicacion, requierePH, empresaId, ordenId, numeroOrden, notas } = req.body;
    if (!tipo) return res.status(400).json({ error: 'Tipo es obligatorio' });
    if (!capacidad) return res.status(400).json({ error: 'Capacidad es obligatoria' });
    const codigoQR = await generarCodigoQR(req.adminId);
    const ahora = new Date();
    const proximaRecarga = new Date(ahora); proximaRecarga.setFullYear(proximaRecarga.getFullYear() + 1);
    const nuevoQR = {
      adminId: req.adminId, codigoQR, tipo: tipo.toUpperCase(), capacidad,
      clienteId: clienteId || null, propietario: clienteNombre || null,
      ubicacion: ubicacion || '', notas: notas || '', empresaId: empresaId || null,
      requierePH: requierePH || false, ph: null, presion: null, fechaPH: null,
      fechaUltimaRecarga: ahora.toISOString(), proximaRecarga: proximaRecarga.toISOString(),
      proximoMantenimiento: requierePH ? proximaRecarga.toISOString() : null,
      ordenId: ordenId || null, numeroOrden: numeroOrden || null, qrImpreso: false,
      historial: [{ fecha: ahora.toISOString(), tipo: 'Creación QR', ordenId: ordenId || null, numeroOrden: numeroOrden || null, tecnico: req.user.nombre || req.user.email, observaciones: 'QR generado' }],
      activo: true, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const ref = await db.collection('qr_equipos').add(nuevoQR);
    res.status(201).json({ id: ref.id, codigoQR, ...nuevoQR, urlPublica: `/qr-public.html?c=${codigoQR}&t=${adminId}` });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// PUT /api/qr/:codigo — Actualizar QR
router.put('/:codigo', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('qr_equipos').where('codigoQR', '==', req.params.codigo.toUpperCase()).where('adminId', '==', req.adminId).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Equipo no encontrado' });
    const doc = snap.docs[0];
    const dataActual = doc.data();
    const { clienteId, clienteNombre, ubicacion, notas, ph, presion, fechaPH, fechaUltimaRecarga, proximaRecarga, proximoMantenimiento, ordenId, numeroOrden, tipoIntervencion, observaciones, pasos, tipo, capacidad } = req.body;
    const ahora = new Date().toISOString();
    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (tipo) cambios.tipo = tipo.toUpperCase();
    if (capacidad) cambios.capacidad = capacidad;
    if (ubicacion !== undefined) cambios.ubicacion = ubicacion;
    if (notas !== undefined) cambios.notas = notas;
    if (ph !== undefined) cambios.ph = ph;
    if (presion !== undefined) cambios.presion = presion;
    if (fechaPH !== undefined) cambios.fechaPH = fechaPH;
    if (fechaUltimaRecarga) cambios.fechaUltimaRecarga = fechaUltimaRecarga;
    if (proximaRecarga) cambios.proximaRecarga = proximaRecarga;
    if (proximoMantenimiento) cambios.proximoMantenimiento = proximoMantenimiento;
    let cambioPropietario = false;
    if (clienteId !== undefined && clienteId !== dataActual.clienteId) {
      cambios.clienteId = clienteId || null; cambios.propietario = clienteNombre || null; cambioPropietario = true;
    }
    const nuevaIntervencion = {
      fecha: ahora,
      tipo: tipoIntervencion || 'Actualización',
      ordenId: ordenId || null,
      numeroOrden: numeroOrden || null,
      tecnico: req.user.nombre || req.user.email,
      observaciones: observaciones || '',
      pasos: pasos || [],
      ph: ph || null,
      presion: presion || null,
      cambioPropietario,
      propietarioAnterior: cambioPropietario ? (dataActual.propietario || null) : null,
      propietarioNuevo: cambioPropietario ? (clienteNombre || null) : null
    };
    cambios.historial = admin.firestore.FieldValue.arrayUnion(nuevaIntervencion);
    cambios.ultimaIntervencion = nuevaIntervencion;
    await doc.ref.update(cambios);
    res.json({ message: 'QR actualizado', codigoQR: req.params.codigo.toUpperCase(), cambioPropietario, intervencion: nuevaIntervencion });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/qr/imprimir — Marcar QR como impresos (máx 9)
router.post('/imprimir', authenticate, async (req, res) => {
  try {
    const { codigos = [] } = req.body;
    if (codigos.length === 0) return res.status(400).json({ error: 'Sin códigos' });
    if (codigos.length > 9) return res.status(400).json({ error: 'Máximo 9 QR por impresión' });
    const batch = db.batch();
    const equipos = [];
    for (const codigo of codigos) {
      const snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo.toUpperCase()).where('adminId', '==', req.adminId).limit(1).get();
      if (!snap.empty) {
        batch.update(snap.docs[0].ref, { qrImpreso: true, fechaImpresion: new Date().toISOString(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        equipos.push({ id: snap.docs[0].id, ...snap.docs[0].data() });
      }
    }
    await batch.commit();
    res.json({ message: `${equipos.length} QR marcados como impresos`, equipos });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/qr/cliente/:clienteId — Equipos de un cliente (admin)
router.get('/cliente/:clienteId', authenticate, async (req, res) => {
  try {
    const snap = await db.collection('qr_equipos').where('adminId', '==', req.adminId).where('clienteId', '==', req.params.clienteId).get();
    const equipos = [];
    snap.forEach(doc => { const data = doc.data(); const f = calcularFechas(data); equipos.push({ id: doc.id, ...data, ...f }); });
    res.json({ clienteId: req.params.clienteId, totalEquipos: equipos.length, equiposVencidos: equipos.filter(e => e.vencido).length, equipos });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN QR
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/qr/config/get
router.get('/config/get', authenticate, async (req, res) => {
  try {
    const doc = await db.collection('qr_config').doc(req.adminId).get();
    if (!doc.exists) return res.json({ categoriasQR: ['recargas y mantenimiento', 'recargas'], imagenPromo: null, duracionPromo: 4, activo: true });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// PUT /api/qr/config/save
router.put('/config/save', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const { categoriasQR, imagenPromo, duracionPromo } = req.body;
    const config = { adminId: req.adminId, categoriasQR: categoriasQR || [], imagenPromo: imagenPromo || null, duracionPromo: parseInt(duracionPromo) || 4, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    await db.collection('qr_config').doc(req.adminId).set(config, { merge: true });
    res.json({ message: 'Configuración guardada', config });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-GENERACIÓN desde orden
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/qr/resolver — EL TALLER DECIDE: generar nuevo o escanear existente
// ──────────────────────────────────────────────────────────────────────────────
// Esta es la corrección del problema del QR duplicado. El equipo entra a taller
// y Pedro decide según lo que ve físicamente:
//   modo='escanear' + codigoQR → el equipo YA tiene QR (vuelve a recarga):
//        se le AGREGA la intervención al historial. Mismo QR de por vida.
//   modo='generar' → equipo nuevo (primera vez): se crea un QR nuevo.
// Así el histórico del equipo NUNCA se pierde y no se duplican QR cada año.
// ══════════════════════════════════════════════════════════════════════════════
router.post('/resolver', authenticate, async (req, res) => {
  try {
    const {
      modo, codigoQR, ordenId, numeroOrden, empresaId,
      clienteId, clienteNombre, ubicacion, notas,
      tipo, capacidad, requierePH, ph, presion,
      observaciones, pasos, tipoIntervencion
    } = req.body;

    const ahora = new Date();
    const proximaRecarga = new Date(ahora);
    proximaRecarga.setFullYear(proximaRecarga.getFullYear() + 1);

    // ── MODO SIN QR: el equipo no necesita etiqueta ───────────────────────────
    if (modo === 'sin_qr') {
      // Solo limpia la señal qrPendiente de la orden y marca el slot como resuelto
      if (ordenId) {
        await db.collection('orders').doc(ordenId)
          .update({ qrPendiente: false }).catch(() => {});
      }
      return res.json({
        message: 'Equipo marcado como sin QR (no necesita etiqueta)',
        modo: 'sin_qr',
        codigoQR: null
      });
    }

    // ── MODO ESCANEAR: equipo que ya tiene QR (vuelve a recarga) ─────────────
    if (modo === 'escanear') {
      if (!codigoQR) return res.status(400).json({ error: 'Debes escanear o digitar el código QR del equipo' });
      const doc = await buscarQRPorCodigo(req.adminId, codigoQR);
      if (!doc) return res.status(404).json({ error: `No existe un equipo con QR ${codigoQR}. ¿Es un equipo nuevo? Usa "Generar QR".` });

      const dataActual = doc.data();
      const cambioPropietario = clienteId && clienteId !== dataActual.clienteId;

      const intervencion = {
        fecha: ahora.toISOString(),
        tipo: tipoIntervencion || 'Recarga / Mantenimiento',
        ordenId: ordenId || null,
        numeroOrden: numeroOrden || null,
        tecnico: req.user.nombre || req.user.email,
        observaciones: observaciones || '',
        pasos: pasos || [],
        ph: ph || null,
        presion: presion || null,
        cambioPropietario: !!cambioPropietario,
        propietarioAnterior: cambioPropietario ? (dataActual.propietario || null) : null,
        propietarioNuevo: cambioPropietario ? (clienteNombre || null) : null
      };

      const cambios = {
        fechaUltimaRecarga: ahora.toISOString(),
        proximaRecarga: proximaRecarga.toISOString(),
        ultimaIntervencion: intervencion,
        historial: admin.firestore.FieldValue.arrayUnion(intervencion),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (ubicacion !== undefined) cambios.ubicacion = ubicacion;
      if (notas !== undefined) cambios.notas = notas;
      if (ph !== undefined) cambios.ph = ph;
      if (presion !== undefined) cambios.presion = presion;
      if (requierePH) cambios.proximoMantenimiento = proximaRecarga.toISOString();
      if (cambioPropietario) {
        cambios.clienteId = clienteId || null;
        cambios.propietario = clienteNombre || null;
      }
      await doc.ref.update(cambios);

      // Limpiar la señal de QR pendiente en la orden
      if (ordenId) {
        await db.collection('orders').doc(ordenId)
          .update({ qrPendiente: false }).catch(() => {});
      }
      return res.json({
        message: 'Servicio agregado al historial del equipo (mismo QR)',
        modo: 'escanear', codigoQR: codigoQR.toUpperCase(),
        intervencion
      });
    }

    // ── MODO GENERAR: equipo nuevo (primera vez) ────────────────────────────
    const nuevoCodigo = await generarCodigoQR(req.adminId);
    const requierePHfinal = requierePH
      || (tipo || '').toUpperCase() === 'CO2'
      || (capacidad || '').toUpperCase().includes('CO2');

    const nuevoQR = {
      adminId: req.adminId,
      codigoQR: nuevoCodigo,
      tipo: (tipo || 'ABC').toUpperCase(),
      capacidad: capacidad || '',
      clienteId: clienteId || null,
      propietario: clienteNombre || null,
      ubicacion: ubicacion || '',
      notas: notas || '',
      empresaId: empresaId || null,
      requierePH: requierePHfinal,
      ph: ph || null, presion: presion || null, fechaPH: null,
      fechaUltimaRecarga: ahora.toISOString(),
      proximaRecarga: proximaRecarga.toISOString(),
      proximoMantenimiento: requierePHfinal ? proximaRecarga.toISOString() : null,
      ordenId: ordenId || null,
      numeroOrden: numeroOrden || null,
      qrImpreso: false,
      historial: [{
        fecha: ahora.toISOString(),
        tipo: tipoIntervencion || 'Creación QR (equipo nuevo)',
        ordenId: ordenId || null,
        numeroOrden: numeroOrden || null,
        tecnico: req.user.nombre || req.user.email,
        observaciones: observaciones || 'QR generado para equipo nuevo'
      }],
      activo: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const ref = await db.collection('qr_equipos').add(nuevoQR);

    if (ordenId) {
      await db.collection('orders').doc(ordenId)
        .update({ qrPendiente: false }).catch(() => {});
    }

    res.status(201).json({
      message: 'QR nuevo generado',
      modo: 'generar',
      id: ref.id,
      codigoQR: nuevoCodigo,
      urlPublica: `/qr-public.html?c=${nuevoCodigo}&t=${req.adminId}`
    });
  } catch (error) {
    console.error('POST /qr/resolver:', error);
    res.status(500).json({ error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/qr/produccion — Generar lote de QR "sin dueño" para stock de cambio
// ──────────────────────────────────────────────────────────────────────────────
// Lo usa la orden de PRODUCCIÓN INTERNA. Pedro carga N equipos de cambio; cada
// uno obtiene su QR pegado pero SIN cliente (propietario=null). Cuando se
// entregue a un cliente en una orden, ahí se le asigna el dueño.
// ══════════════════════════════════════════════════════════════════════════════
router.post('/produccion', authenticate, async (req, res) => {
  try {
    const { ordenId, numeroOrden, items = [], empresaId } = req.body;
    if (items.length === 0) return res.json({ message: 'Sin equipos a producir', generados: 0 });

    const ahora = new Date();
    const proximaRecarga = new Date(ahora);
    proximaRecarga.setFullYear(proximaRecarga.getFullYear() + 1);

    const generados = [];
    for (const item of items) {
      for (let i = 0; i < (item.cantidad || 1); i++) {
        const codigoQR = await generarCodigoQR(req.adminId);
        const requierePH = (item.nombre || '').toUpperCase().includes('CO2');
        const ref = await db.collection('qr_equipos').add({
          adminId: req.adminId,
          codigoQR,
          tipo: requierePH ? 'CO2' : 'ABC',
          capacidad: item.nombre || '',
          clienteId: null,            // SIN DUEÑO (stock de cambio)
          propietario: null,
          esStockCambio: true,
          ubicacion: 'BODEGA / STOCK CAMBIO',
          notas: 'Equipo de cambio listo para entregar',
          empresaId: empresaId || null,
          requierePH, ph: null, presion: null, fechaPH: null,
          fechaUltimaRecarga: ahora.toISOString(),
          proximaRecarga: proximaRecarga.toISOString(),
          proximoMantenimiento: requierePH ? proximaRecarga.toISOString() : null,
          ordenId: ordenId || null,
          numeroOrden: numeroOrden || null,
          qrImpreso: false,
          historial: [{
            fecha: ahora.toISOString(),
            tipo: 'Producción stock de cambio',
            ordenId: ordenId || null,
            numeroOrden: numeroOrden || null,
            tecnico: req.user.nombre || req.user.email,
            observaciones: `Equipo de cambio producido en orden ${numeroOrden || ''}`
          }],
          activo: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        generados.push({ id: ref.id, codigoQR });
      }
    }

    if (ordenId) {
      await db.collection('orders').doc(ordenId)
        .update({ qrPendiente: false }).catch(() => {});
    }

    res.json({ message: `${generados.length} equipos de cambio producidos`, generados: generados.length, qrs: generados });
  } catch (error) {
    console.error('POST /qr/produccion:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/qr/:id — Eliminar QR creado por error
// ─────────────────────────────────────────────────
// Solo Admin puede eliminar. Solo se permite si el equipo NO tiene
// propietario asignado (no está en manos de un cliente).
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el Admin puede eliminar QR' });
    }
    const { id } = req.params;
    const doc = await db.collection('qr_equipos').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'QR no encontrado' });

    const data = doc.data();
    // Verificar que pertenece al mismo tenant
    if (data.adminId !== req.adminId) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar este QR' });
    }
    // Solo se puede eliminar si no tiene propietario (no está asignado a un cliente)
    if (data.propietario || data.clienteId) {
      return res.status(400).json({ error: 'No se puede eliminar un QR que tiene propietario asignado. Primero desasigna el cliente.' });
    }

    await db.collection('qr_equipos').doc(id).delete();
    res.json({ message: `QR ${data.codigoQR} eliminado correctamente` });
  } catch (error) {
    console.error('DELETE /qr/:id:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/qr/auto-generar — COMPATIBILIDAD: ya NO crea duplicados.
// Si un equipo de la orden ya tiene QR ligado, no hace nada (el taller
// resolverá con /resolver). Se mantiene para no romper llamadas existentes.
router.post('/auto-generar', authenticate, async (req, res) => {
  try {
    const { ordenId } = req.body;
    // Marcar la orden como QR pendiente para que el taller lo resuelva.
    if (ordenId) {
      await db.collection('orders').doc(ordenId)
        .update({ qrPendiente: true }).catch(() => {});
    }
    res.json({
      message: 'QR pendiente: el taller decidirá generar o escanear (no se crean duplicados)',
      generados: 0,
      qrPendiente: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
