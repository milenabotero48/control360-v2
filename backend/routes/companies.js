const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const cloudinary = require('../config/cloudinary');

// ─────────────────────────────────────────────────────────────────────────────
// Cambios Ola 1 sobre el original:
//   1) Se elimina el guardado de `pinAutorizacion` en la empresa
//      (el PIN ahora vive en el usuario — ver users.js).
//   2) El endpoint POST /verificar-pin se conserva por compatibilidad pero
//      redirige al verificador centralizado de users.js: si tu frontend
//      todavía pega aquí, sigue funcionando. Lo ideal es migrar a
//      POST /api/users/verificar-pin (ver users.js).
//   3) El campo `pinAutorizacion` ya no se escribe ni se devuelve al frontend.
//      Si existe en docs antiguos, queda en la BD pero no se usa.
// ─────────────────────────────────────────────────────────────────────────────

const validarNIT      = (v) => /^\d{8,}$/.test(v);
const validarTelefono = (v) => /^\d{7,}$/.test(v);
const validarCelular  = (v) => /^\d{10}$/.test(v);
const validarEmail    = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const validarIVA      = (v) => { const n = parseInt(v); return !isNaN(n) && n >= 0 && n <= 100; };

const subirLogo = async (base64) => {
  if (!base64 || !base64.startsWith('data:image')) return null;
  const result = await cloudinary.uploader.upload(base64, {
    folder: 'control360/logos',
    transformation: [{ width: 300, height: 300, crop: 'limit' }]
  });
  return result.secure_url;
};

// ─── Helper: nunca exponer pinAutorizacion al frontend ───────────────────────
const limpiarEmpresa = (data) => {
  if (!data) return data;
  const { pinAutorizacion, ...resto } = data;
  return resto;
};

router.get('/', async (req, res) => {
  try {
    let userId = req.user.uid || req.user.id;

    if (req.user.role !== 'admin') {
      try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists && userDoc.data().adminId) {
          userId = userDoc.data().adminId;
        } else if (userDoc.exists && userDoc.data().creadoPor) {
          userId = userDoc.data().creadoPor;
        }
      } catch (e) { console.error('Error buscando adminId:', e.message); }
    }

    const snapshot = await db.collection('companies')
      .where('user_id', '==', userId)
      .get();

    if (snapshot.empty && req.user.role !== 'admin') {
      const allSnap = await db.collection('companies').get();
      const companies = allSnap.docs.map(doc => ({ id: doc.id, ...limpiarEmpresa(doc.data()) }));
      return res.json(companies);
    }

    const companies = snapshot.docs.map(doc => ({ id: doc.id, ...limpiarEmpresa(doc.data()) }));
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
    res.json({ id: doc.id, ...limpiarEmpresa(doc.data()) });
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
    // Aceptamos configCertificado pero IGNORAMOS pinAutorizacion (deprecado).
    const { name, nit, address, phone, cellphone, email, iva, logo, configCertificado } = req.body;

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
    if (configCertificado !== undefined) updateData.configCertificado = configCertificado;

    if (logo && logo.startsWith('data:image')) {
      updateData.logo = await subirLogo(logo);
    } else if (logo && logo.startsWith('http')) {
      updateData.logo = logo;
    }

    await db.collection('companies').doc(req.params.id).update(updateData);
    const updated = await db.collection('companies').doc(req.params.id).get();
    res.json({ id: updated.id, ...limpiarEmpresa(updated.data()) });
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /verificar-pin — DEPRECADO (compat con frontend viejo)
// ─────────────────────────────────────────────────────────────────────────────
// Reenvía la validación al PIN del USUARIO logueado (no al de empresa).
// El flujo correcto es POST /api/users/verificar-pin — ver users.js.
router.post('/verificar-pin', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ autorizado: false, error: 'PIN requerido' });

    const yo = req.user.uid || req.user.id;
    const doc = await db.collection('users').doc(yo).get();
    if (!doc.exists) return res.status(404).json({ autorizado: false, error: 'Usuario no encontrado' });

    const u = doc.data();
    if (u.role !== 'admin' && u.role !== 'tesoreria') {
      return res.status(403).json({ autorizado: false, error: 'Tu rol no puede autorizar esta acción' });
    }
    if (!u.pin) {
      return res.status(400).json({ autorizado: false, error: 'No tienes PIN configurado' });
    }

    const autorizado = String(u.pin) === String(pin);

    if (autorizado) {
      await db.collection('audit_logs').add({
        accion: 'DESBLOQUEO_CLIENTE_CARTERA',
        modulo: 'cxc',
        descripcion: `${u.nombre || u.email} autorizó orden para cliente bloqueado por cartera`,
        usuarioId: yo,
        usuarioNombre: u.nombre || u.email,
        fecha: new Date().toISOString()
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
