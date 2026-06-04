const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

// ─── HELPER: calcular fechas vencimiento ─────────────────────────────────────
const calcularFechas = (data) => {
  const hoy = new Date();
  const proxRecarga = data.proximaRecarga ? new Date(data.proximaRecarga) : null;
  const diasParaVencer = proxRecarga
    ? Math.ceil((proxRecarga - hoy) / (1000 * 60 * 60 * 24))
    : null;
  const vencido = diasParaVencer !== null && diasParaVencer < 0;
  const alertaVencimiento = !vencido && diasParaVencer !== null && diasParaVencer <= 30;
  return { vencido, diasParaVencer, alertaVencimiento };
};

// ─── HELPER: datos públicos de la empresa ────────────────────────────────────
const getEmpresaPublica = async (adminId, empresaId) => {
  try {
    if (empresaId) {
      const doc = await db.collection('companies').doc(empresaId).get();
      if (doc.exists) {
        const d = doc.data();
        return {
          nombre: d.name || '', nit: d.nit || '',
          logo: d.logo || null, phone: d.phone || '',
          cellphone: d.cellphone || '', email: d.email || '',
          address: d.address || '', web: d.web || '',
          whatsapp: d.whatsapp || d.cellphone || ''
        };
      }
    }
    // Fallback: buscar empresa del admin
    const snap = await db.collection('companies').where('adminId', '==', adminId).limit(1).get();
    if (!snap.empty) {
      const d = snap.docs[0].data();
      return {
        nombre: d.name || '', nit: d.nit || '',
        logo: d.logo || null, phone: d.phone || '',
        cellphone: d.cellphone || '', email: d.email || '',
        address: d.address || '', web: d.web || '',
        whatsapp: d.whatsapp || d.cellphone || ''
      };
    }
  } catch (e) { console.error('getEmpresaPublica:', e); }
  return {};
};

// GET /api/qr/public/:codigo — Info pública del equipo (SIN autenticación)
router.get('/:codigo', async (req, res) => {
  try {
    const codigo = req.params.codigo.toUpperCase().trim();
    const snap = await db.collection('qr_equipos')
      .where('codigoQR', '==', codigo)
      .limit(1).get();

    if (snap.empty) return res.status(404).json({ error: 'Equipo no encontrado' });

    const doc = snap.docs[0];
    const data = doc.data();
    const { vencido, diasParaVencer, alertaVencimiento } = calcularFechas(data);
    const empresa = await getEmpresaPublica(data.adminId, data.empresaId);

    const configDoc = await db.collection('qr_config').doc(data.adminId).get();
    const config = configDoc.exists ? configDoc.data() : {};

    res.json({
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
      config: {
        imagenPromo: config.imagenPromo || null,
        tiempoSplash: config.duracionPromo || 5
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/qr/public/cliente/:clienteId — Lista equipos del cliente (SIN autenticación)
router.get('/cliente/:clienteId', async (req, res) => {
  try {
    const { clienteId } = req.params;
    const { adminId } = req.query;

    let query = db.collection('qr_equipos').where('clienteId', '==', clienteId);
    if (adminId) query = query.where('adminId', '==', adminId);

    const snap = await query.get();
    const equipos = [];
    let equiposVencidos = 0;

    snap.forEach(doc => {
      const data = doc.data();
      const { vencido, diasParaVencer } = calcularFechas(data);
      if (vencido) equiposVencidos++;
      equipos.push({
        codigoQR: data.codigoQR,
        tipo: data.tipo || '',
        capacidad: data.capacidad || '',
        ubicacion: data.ubicacion || '',
        notas: data.notas || '',
        fechaUltimaRecarga: data.fechaUltimaRecarga || null,
        proximaRecarga: data.proximaRecarga || null,
        fechaPH: data.fechaPH || null,
        requierePH: data.requierePH || false,
        vencido, diasParaVencer
      });
    });

    // Empresa
    const empresa = adminId ? await getEmpresaPublica(adminId, null) : {};

    res.json({
      equipos,
      totalEquipos: equipos.length,
      equiposVencidos,
      empresa
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
