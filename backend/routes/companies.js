const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const cloudinary = require('../config/cloudinary');

const validarNIT      = (v) => /^\d{8,}$/.test(v);
const validarTelefono = (v) => /^\d{7,}$/.test(v);
const validarCelular  = (v) => /^\d{10}$/.test(v);
const validarEmail    = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const validarIVA      = (v) => { const n = parseInt(v); return !isNaN(n) && n >= 0 && n <= 100; };

const subirLogo = async (base64) => {
  console.log('Logo recibido:', base64 ? base64.substring(0, 50) : 'VACÍO');
  if (!base64 || !base64.startsWith('data:image')) return null;
  const result = await cloudinary.uploader.upload(base64, {
    folder: 'control360/logos',
    transformation: [{ width: 300, height: 300, crop: 'limit' }]
  });
  return result.secure_url;
};

router.get('/', async (req, res) => {
  try {
    // Si es admin busca sus propias empresas
    // Si es otro rol, busca las empresas del admin (user_id del token puede ser el uid del admin)
    let userId = req.user.uid || req.user.id;

    // Para roles no admin, buscar el adminId guardado en su perfil de usuario
    if (req.user.role !== 'admin') {
      try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists && userDoc.data().adminId) {
          userId = userDoc.data().adminId;
        } else if (userDoc.exists && userDoc.data().uid) {
          // Intentar con el uid guardado en el usuario admin
          const adminSnap = await db.collection('users')
            .where('role', '==', 'admin')
            .limit(1).get();
          if (!adminSnap.empty) {
            userId = adminSnap.docs[0].data().uid || adminSnap.docs[0].id;
          }
        }
      } catch (e) { console.error('Error buscando adminId:', e.message); }
    }

    const snapshot = await db.collection('companies')
      .where('user_id', '==', userId)
      .get();

    // Si no encontró con ese userId, buscar todas las empresas activas
    if (snapshot.empty && req.user.role !== 'admin') {
      const allSnap = await db.collection('companies').get();
      const companies = allSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      return res.json(companies);
    }

    const companies = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(companies);
  } catch (error) {
    console.error('GET /companies error:', error);
    res.status(500).json({ error: 'Error al obtener empresas' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection('companies').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener empresa' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, nit, address, phone, cellphone, email, iva, logo } = req.body;

    if (!name)                      return res.status(400).json({ error: 'Nombre requerido' });
    if (!validarNIT(nit))           return res.status(400).json({ error: 'NIT inválido: mínimo 8 dígitos' });
    if (!validarTelefono(phone))    return res.status(400).json({ error: 'Teléfono inválido' });
    if (!validarCelular(cellphone)) return res.status(400).json({ error: 'Celular inválido: 10 dígitos' });
    if (!validarEmail(email))       return res.status(400).json({ error: 'Email inválido' });
    if (!validarIVA(iva))           return res.status(400).json({ error: 'IVA inválido: entre 0 y 100' });

    let logoUrl = '';
    if (logo && logo.startsWith('data:image')) {
      logoUrl = await subirLogo(logo);
    }

    const newCompany = {
      user_id:    req.user.uid,
      name,
      nit,
      address:    address || '',
      phone,
      cellphone,
      email,
      iva:        parseInt(iva),
      logo:       logoUrl || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const docRef = await db.collection('companies').add(newCompany);
    res.status(201).json({ id: docRef.id, ...newCompany });
  } catch (error) {
    console.error('POST /companies error:', error);
    res.status(500).json({ error: 'Error al crear empresa' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, nit, address, phone, cellphone, email, iva, logo, pinAutorizacion, configCertificado } = req.body;

    if (nit       && !validarNIT(nit))           return res.status(400).json({ error: 'NIT inválido' });
    if (phone     && !validarTelefono(phone))     return res.status(400).json({ error: 'Teléfono inválido' });
    if (cellphone && !validarCelular(cellphone))  return res.status(400).json({ error: 'Celular inválido' });
    if (email     && !validarEmail(email))        return res.status(400).json({ error: 'Email inválido' });
    if (iva       && !validarIVA(iva))            return res.status(400).json({ error: 'IVA inválido' });

    const updateData = { updated_at: new Date().toISOString() };

    if (name)      updateData.name      = name;
    if (nit)       updateData.nit       = nit;
    if (address)   updateData.address   = address;
    if (phone)     updateData.phone     = phone;
    if (cellphone) updateData.cellphone = cellphone;
    if (email)     updateData.email     = email;
    if (iva)       updateData.iva       = parseInt(iva);
    if (pinAutorizacion !== undefined) updateData.pinAutorizacion = pinAutorizacion;
    if (configCertificado !== undefined) updateData.configCertificado = configCertificado;

    if (logo && logo.startsWith('data:image')) {
      updateData.logo = await subirLogo(logo);
    } else if (logo && logo.startsWith('http')) {
      updateData.logo = logo;
    }

    await db.collection('companies').doc(req.params.id).update(updateData);
    const updated = await db.collection('companies').doc(req.params.id).get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (error) {
    console.error('PUT /companies error:', error);
    res.status(500).json({ error: 'Error al actualizar empresa' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.collection('companies').doc(req.params.id).delete();
    res.json({ message: 'Empresa eliminada correctamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar empresa' });
  }
});

// ─── Verificar PIN de autorización ───────────────────────────────────────────
router.post('/verificar-pin', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || pin.length !== 4) return res.status(400).json({ autorizado: false, error: 'PIN inválido' });
    const snap = await db.collection('companies').where('user_id', '==', req.user.uid).get();
    if (snap.empty) return res.status(404).json({ autorizado: false, error: 'Sin empresas configuradas' });
    // Verificar contra cualquiera de las empresas del usuario
    const autorizado = snap.docs.some(doc => doc.data().pinAutorizacion === pin);
    if (autorizado) {
      // Registrar en auditoría
      await db.collection('audit_logs').add({
        accion: 'DESBLOQUEO_CLIENTE_CARTERA',
        modulo: 'ordenes',
        descripcion: 'Admin autorizó orden para cliente bloqueado por cartera',
        usuarioId: req.user.uid,
        usuarioEmail: req.user.email,
        fecha: new Date().toISOString(),
      });
    }
    res.json({ autorizado });
  } catch (error) {
    res.status(500).json({ autorizado: false, error: error.message });
  }
});

// GET /api/companies/certificados/config — Config global de certificados
router.get('/certificados/config', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid || req.user.id;
    const doc = await db.collection('certificados_config').doc(adminId).get();
    if (!doc.exists) {
      return res.json({
        categorias: [
          {
            id: 'cat_1',
            nombreDocumento: 'Certificado de Mantenimiento',
            categoriaProducto: 'recarga y mantenimiento',
            norma: 'NTC 2885',
            texto: 'Por medio del presente documento certificamos que se realizaron los servicios de mantenimiento a los extintores portátiles contra incendio relacionados a continuación, en cumplimiento de la Norma Técnica Colombiana NTC 2885.',
            contenido: 'Inspección visual interna y externa • Limpieza de válvulas y mecanismos\nCambio de empaques y sellos • Recarga del agente extintor e impulsor\nPrueba de hermeticidad • Rotulado según NTC 2885',
            activo: true
          }
        ]
      });
    }
    res.json(doc.data());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/companies/certificados/config — Guardar config global
router.put('/certificados/config', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const adminId = req.adminId || req.user.uid || req.user.id;
    const { categorias } = req.body;
    await db.collection('certificados_config').doc(adminId).set({
      adminId,
      categorias: categorias || [],
      updatedAt: new Date().toISOString()
    }, { merge: true });
    res.json({ message: 'Configuración guardada', categorias });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
module.exports = router;