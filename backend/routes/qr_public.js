const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

// ─── CHECKLIST NTC 2885 ──────────────────────────────────────────────────────
const CHECKLIST_ITEMS = [
  { id: 'ubicacion',    label: 'Ubicacion e instalacion',    desc: 'El extintor esta en su lugar asignado, visible, senalizado y sin obstaculos frente a el' },
  { id: 'manometro',    label: 'Manometro / Presion',         desc: 'La aguja esta en la zona verde. Si no tiene manometro, el sello plastico esta intacto' },
  { id: 'seguro',       label: 'Seguro y sello plastico',     desc: 'El pasador de seguridad esta puesto y el sello plastico no ha sido roto ni manipulado' },
  { id: 'cilindro',     label: 'Cilindro',                    desc: 'Sin golpes visibles, sin corrosion, sin oxido, pintura en buen estado' },
  { id: 'valvula',      label: 'Valvula',                     desc: 'Sin danos, sin fugas visibles, sin corrosion en la palanca o cuello' },
  { id: 'manguera',     label: 'Manguera / Boquilla / Corneta', desc: 'Sin fisuras, sin bloqueos, bien conectada, sin dano fisico visible' },
  { id: 'etiqueta',     label: 'Etiqueta de servicio',        desc: 'La etiqueta del ultimo mantenimiento esta visible y legible con fecha de proxima recarga' },
  { id: 'senalizacion', label: 'Senalizacion',                desc: 'La senal del extintor en la pared esta visible y en buen estado' },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const calcularFechas = (data) => {
  const hoy = new Date();
  const proxRecarga = data.proximaRecarga ? new Date(data.proximaRecarga) : null;
  const diasParaVencer = proxRecarga ? Math.ceil((proxRecarga - hoy) / (1000 * 60 * 60 * 24)) : null;
  const vencido = diasParaVencer !== null && diasParaVencer < 0;
  const alertaVencimiento = !vencido && diasParaVencer !== null && diasParaVencer <= 30;
  return { vencido, diasParaVencer, alertaVencimiento };
};

const getEmpresaPublica = async (adminId, empresaId) => {
  try {
    if (empresaId) {
      const doc = await db.collection('companies').doc(empresaId).get();
      if (doc.exists) {
        const d = doc.data();
        return { nombre: d.name || '', nit: d.nit || '', logo: d.logo || null, phone: d.phone || '', cellphone: d.cellphone || '', email: d.email || '', address: d.address || '', web: d.web || '', whatsapp: d.whatsapp || d.cellphone || '' };
      }
    }
    const snap = await db.collection('companies').where('adminId', '==', adminId).limit(1).get();
    if (!snap.empty) {
      const d = snap.docs[0].data();
      return { nombre: d.name || '', nit: d.nit || '', logo: d.logo || null, phone: d.phone || '', cellphone: d.cellphone || '', email: d.email || '', address: d.address || '', web: d.web || '', whatsapp: d.whatsapp || d.cellphone || '' };
    }
  } catch (e) { console.error('getEmpresaPublica:', e); }
  return {};
};

const calcularResultado = (checklist) => {
  const vals = Object.values(checklist);
  if (vals.some(v => v === 'mal')) return 'requiere_atencion';
  if (vals.some(v => v === 'novedad')) return 'con_novedad';
  return 'aprobado';
};

// ─── HELPER: crear alerta interna al suscriptor ───────────────────────────────
const crearAlertaSuscriptor = async (adminId, equipo, inspeccion, novedades) => {
  try {
    await db.collection('alertas').add({
      adminId,
      tipo: 'inspeccion_novedad',
      titulo: `Novedad en inspeccion: ${equipo.codigoQR}`,
      mensaje: `El equipo ${equipo.codigoQR} (${equipo.tipo || 'Extintor'}) del cliente ${equipo.propietario || ''} tiene novedades en la inspeccion del ${new Date().toLocaleDateString('es-CO')}: ${novedades.join(', ')}. Inspector: ${inspeccion.inspectorNombre}.`,
      equipoId: equipo.id,
      codigoQR: equipo.codigoQR,
      clienteId: equipo.clienteId || null,
      inspeccionId: inspeccion.id || null,
      leida: false,
      prioridad: 'alta',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Error creando alerta:', e); }
};

// ─── GET /:codigo — Info publica del equipo ───────────────────────────────────
router.get('/:codigo', async (req, res) => {
  try {
    const codigo = req.params.codigo.toUpperCase().trim();
    const tenantId = req.query.t || null;

    let snap;
    if (tenantId) {
      snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo).where('adminId', '==', tenantId).limit(1).get();
    } else {
      snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo).limit(1).get();
    }

    if (snap.empty) return res.status(404).json({ error: 'Equipo no encontrado' });

    const doc = snap.docs[0];
    const data = doc.data();
    const { vencido, diasParaVencer, alertaVencimiento } = calcularFechas(data);
    const empresa = await getEmpresaPublica(data.adminId, data.empresaId);
    const configDoc = await db.collection('qr_config').doc(data.adminId).get();
    const config = configDoc.exists ? configDoc.data() : {};

    // Ultima inspeccion
    let ultimaInspeccion = null;
    try {
      const inspSnap = await db.collection('qr_inspecciones')
        .where('equipoId', '==', doc.id)
        .orderBy('createdAt', 'desc')
        .limit(1).get();
      if (!inspSnap.empty) {
        const id = inspSnap.docs[0];
        const d = id.data();
        ultimaInspeccion = {
          id: id.id,
          fecha: d.fecha || null,
          hora: d.hora || null,
          inspectorNombre: d.inspectorNombre || '',
          resultado: d.resultado || 'aprobado',
          createdAt: d.createdAt || null
        };
      }
    } catch (e) { /* indice aun no listo, ignorar */ }

    res.json({
      id: doc.id,
      codigoQR: data.codigoQR,
      tipo: data.tipo || '',
      capacidad: data.capacidad || '',
      propietario: data.propietario || null,
      ubicacion: data.ubicacion || '',
      notas: data.notas || '',
      fechaUltimaRecarga: data.fechaUltimaRecarga || null,
      proximaRecarga: data.proximaRecarga || null,
      proximoMantenimiento: data.proximoMantenimiento || null,
      fechaPH: data.fechaPH || null,
      requierePH: data.requierePH || false,
      vencido, diasParaVencer, alertaVencimiento,
      clienteId: data.clienteId || null,
      adminId: data.adminId,
      empresa,
      ultimaInspeccion,
      checklistItems: CHECKLIST_ITEMS,
      config: { imagenPromo: config.imagenPromo || null, tiempoSplash: config.duracionPromo || 5 }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /cliente/:clienteId — Lista equipos del cliente ──────────────────────
router.get('/cliente/:clienteId', async (req, res) => {
  try {
    const { clienteId } = req.params;
    const { adminId } = req.query;

    let query = db.collection('qr_equipos').where('clienteId', '==', clienteId);
    if (adminId) query = query.where('adminId', '==', adminId);

    const snap = await query.get();
    const equipos = [];
    let equiposVencidos = 0;

    // Para cada equipo traer su ultima inspeccion
    const promesas = snap.docs.map(async (doc) => {
      const data = doc.data();
      const { vencido, diasParaVencer } = calcularFechas(data);
      if (vencido) equiposVencidos++;

      let ultimaInspeccion = null;
      try {
        const inspSnap = await db.collection('qr_inspecciones')
          .where('equipoId', '==', doc.id)
          .orderBy('createdAt', 'desc')
          .limit(1).get();
        if (!inspSnap.empty) {
          const d = inspSnap.docs[0].data();
          ultimaInspeccion = { fecha: d.fecha || null, resultado: d.resultado || 'aprobado', inspectorNombre: d.inspectorNombre || '' };
        }
      } catch (e) { /* ignorar si no hay indice */ }

      equipos.push({
        id: doc.id,
        codigoQR: data.codigoQR,
        tipo: data.tipo || '',
        capacidad: data.capacidad || '',
        ubicacion: data.ubicacion || '',
        notas: data.notas || '',
        fechaUltimaRecarga: data.fechaUltimaRecarga || null,
        proximaRecarga: data.proximaRecarga || null,
        fechaPH: data.fechaPH || null,
        requierePH: data.requierePH || false,
        vencido, diasParaVencer,
        ultimaInspeccion
      });
    });

    await Promise.all(promesas);
    equipos.sort((a, b) => (a.codigoQR || '').localeCompare(b.codigoQR || ''));

    const empresa = adminId ? await getEmpresaPublica(adminId, null) : {};
    res.json({ equipos, totalEquipos: equipos.length, equiposVencidos, empresa });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /:codigo/inspecciones — Historial paginado (SIN auth) ────────────────
router.get('/:codigo/inspecciones', async (req, res) => {
  try {
    const codigo = req.params.codigo.toUpperCase().trim();
    const tenantId = req.query.t || null;
    const limite = Math.min(parseInt(req.query.limite) || 6, 20);
    const pagina = parseInt(req.query.pagina) || 1;

    // Buscar equipo
    let snap;
    if (tenantId) {
      snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo).where('adminId', '==', tenantId).limit(1).get();
    } else {
      snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo).limit(1).get();
    }
    if (snap.empty) return res.status(404).json({ error: 'Equipo no encontrado' });
    const equipoId = snap.docs[0].id;

    // Traer inspecciones paginadas
    const inspSnap = await db.collection('qr_inspecciones')
      .where('equipoId', '==', equipoId)
      .orderBy('createdAt', 'desc')
      .limit(limite * pagina)
      .get();

    const todas = inspSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const inicio = (pagina - 1) * limite;
    const inspecciones = todas.slice(inicio, inicio + limite);
    const hayMas = todas.length >= limite * pagina;

    res.json({ inspecciones, hayMas, total: todas.length, pagina, limite });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /:codigo/inspeccion — Registrar inspeccion (SIN auth) ───────────────
router.post('/:codigo/inspeccion', async (req, res) => {
  try {
    const codigo = req.params.codigo.toUpperCase().trim();
    const tenantId = req.query.t || req.body.tenantId || null;
    const { inspectorNombre, inspectorApellido, checklist, observaciones, gps } = req.body;

    // Validaciones
    if (!inspectorNombre || !inspectorNombre.trim()) return res.status(400).json({ error: 'Nombre del inspector requerido' });
    if (!inspectorApellido || !inspectorApellido.trim()) return res.status(400).json({ error: 'Apellido del inspector requerido' });
    if (!checklist || Object.keys(checklist).length === 0) return res.status(400).json({ error: 'El checklist no puede estar vacio' });

    // Buscar equipo
    let snap;
    if (tenantId) {
      snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo).where('adminId', '==', tenantId).limit(1).get();
    } else {
      snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo).limit(1).get();
    }
    if (snap.empty) return res.status(404).json({ error: 'Equipo no encontrado' });

    const equipoDoc = snap.docs[0];
    const equipo = { id: equipoDoc.id, ...equipoDoc.data() };

    // Rate limiting simple: no permitir mas de 1 inspeccion en los ultimos 10 minutos del mismo inspector
    const diezMinAtras = new Date(Date.now() - 10 * 60 * 1000);
    const reciente = await db.collection('qr_inspecciones')
      .where('equipoId', '==', equipoDoc.id)
      .where('inspectorNombre', '==', inspectorNombre.trim())
      .orderBy('createdAt', 'desc')
      .limit(1).get();
    if (!reciente.empty) {
      const ultima = reciente.docs[0].data();
      if (ultima.createdAt?.toDate && ultima.createdAt.toDate() > diezMinAtras) {
        return res.status(429).json({ error: 'Ya registraste una inspeccion para este equipo hace menos de 10 minutos' });
      }
    }

    const ahora = new Date();
    const resultado = calcularResultado(checklist);

    // Identificar puntos con novedad o mal
    const novedades = CHECKLIST_ITEMS
      .filter(item => checklist[item.id] === 'mal' || checklist[item.id] === 'novedad')
      .map(item => `${item.label} (${checklist[item.id] === 'mal' ? 'Requiere atencion' : 'Novedad'})`);

    const nuevaInspeccion = {
      equipoId: equipoDoc.id,
      adminId: equipo.adminId,
      clienteId: equipo.clienteId || null,
      codigoQR: codigo,
      inspectorNombre: inspectorNombre.trim(),
      inspectorApellido: inspectorApellido.trim(),
      inspectorCompleto: `${inspectorNombre.trim()} ${inspectorApellido.trim()}`,
      checklist,
      observaciones: observaciones || '',
      resultado,
      novedades,
      gps: gps || null,
      fecha: ahora.toISOString().slice(0, 10),
      hora: ahora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('qr_inspecciones').add(nuevaInspeccion);

    // Si hay novedades → crear alerta para el suscriptor
    if (novedades.length > 0) {
      await crearAlertaSuscriptor(equipo.adminId, equipo, { ...nuevaInspeccion, id: ref.id }, novedades);
    }

    res.status(201).json({
      ok: true,
      id: ref.id,
      resultado,
      novedades,
      mensaje: resultado === 'aprobado'
        ? 'Inspeccion registrada correctamente. Equipo en buen estado.'
        : `Inspeccion registrada. Se ha notificado al servicio tecnico sobre las novedades encontradas.`
    });
  } catch (error) {
    console.error('POST inspeccion:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /:codigo/novedad-ubicacion — Reportar cambio de ubicacion ───────────
router.post('/:codigo/novedad-ubicacion', async (req, res) => {
  try {
    const codigo = req.params.codigo.toUpperCase().trim();
    const tenantId = req.query.t || req.body.tenantId || null;
    const { reportadorNombre, reportadorApellido, nuevaUbicacion, descripcion, gps } = req.body;

    if (!reportadorNombre?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    if (!nuevaUbicacion?.trim()) return res.status(400).json({ error: 'Nueva ubicacion requerida' });

    let snap;
    if (tenantId) {
      snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo).where('adminId', '==', tenantId).limit(1).get();
    } else {
      snap = await db.collection('qr_equipos').where('codigoQR', '==', codigo).limit(1).get();
    }
    if (snap.empty) return res.status(404).json({ error: 'Equipo no encontrado' });

    const equipoDoc = snap.docs[0];
    const equipo = equipoDoc.data();

    await db.collection('qr_novedades_ubicacion').add({
      equipoId: equipoDoc.id,
      adminId: equipo.adminId,
      clienteId: equipo.clienteId || null,
      codigoQR: codigo,
      reportadorNombre: reportadorNombre.trim(),
      reportadorApellido: reportadorApellido?.trim() || '',
      nuevaUbicacion: nuevaUbicacion.trim(),
      ubicacionAnterior: equipo.ubicacion || '',
      descripcion: descripcion || '',
      gps: gps || null,
      estado: 'pendiente', // pendiente | aprobada | rechazada
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Alerta al suscriptor
    await db.collection('alertas').add({
      adminId: equipo.adminId,
      tipo: 'novedad_ubicacion',
      titulo: `Reporte cambio de ubicacion: ${codigo}`,
      mensaje: `${reportadorNombre.trim()} reporta que el equipo ${codigo} fue movido a: "${nuevaUbicacion.trim()}". Ubicacion anterior: "${equipo.ubicacion || 'No registrada'}". Pendiente de aprobacion.`,
      codigoQR: codigo,
      clienteId: equipo.clienteId || null,
      leida: false,
      prioridad: 'media',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json({ ok: true, mensaje: 'Novedad de ubicacion reportada. El equipo tecnico la revisara pronto.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
