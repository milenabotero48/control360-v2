// ============================================================
// Control360 — Rutas API Anny
// Ubicación: backend/routes/anny.js
// ============================================================
// MONTAJE en server.js:
//   app.use('/api/anny', require('./routes/anny'));
//
// Prefijo: /api/anny/*
// Todas las rutas requieren autenticación
// ============================================================

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
const annyService = require('../services/annyService');

// ============================================================
// 1. GET /api/anny/config — Obtener configuración
// ============================================================
router.get('/config', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const config = await annyService.obtenerConfig(adminId);
    return res.json(config);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 2. PUT /api/anny/config — Actualizar configuración
// Body: { activo, whatsappNumber, diasAntes, horaEnvio }
// ============================================================
router.put('/config', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { activo, whatsappNumber, diasAntes = 30, horaEnvio = '09:00' } = req.body;

    const resultado = await annyService.actualizarConfig(adminId, {
      activo: Boolean(activo),
      whatsappNumber,
      diasAntes: Number(diasAntes),
      horaEnvio,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 3. GET /api/anny/metricas — Métricas del día
// ============================================================
router.get('/metricas', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const metricas = await annyService.obtenerMetricasHoy(adminId);
    return res.json(metricas);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4. GET /api/anny/conversaciones — Últimas conversaciones
// Query: ?limit=50&estado=escalado|automatico|ia|todas
// ============================================================
router.get('/conversaciones', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const limite = Math.min(parseInt(req.query.limit) || 50, 200);
    const estado = req.query.estado || 'todas';

    let query = db.collection('conversacionesAnny')
      .doc(adminId)
      .collection('conversaciones');

    if (estado === 'escalado') {
      query = query.where('escalado', '==', true);
    } else if (estado === 'automatico') {
      query = query.where('respondidoPor', '==', 'AGENTE_AUTOMATICO');
    } else if (estado === 'ia') {
      query = query.where('respondidoPor', '==', 'AGENTE_IA');
    }

    const snap = await query.limit(500).get();

    const conversaciones = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      .slice(0, limite);

    return res.json(conversaciones);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 5. GET /api/anny/casos-escalados — Casos pendientes
// Query: ?estado=pendiente|resuelto|todos
// ============================================================
router.get('/casos-escalados', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const estado = req.query.estado || 'pendiente';

    let query = db.collection('casosEscaladosAnny')
      .doc(adminId)
      .collection('casos');

    if (estado === 'pendiente') {
      query = query.where('estado', '==', 'PENDIENTE');
    } else if (estado === 'resuelto') {
      query = query.where('estado', '==', 'RESUELTO');
    }

    const snap = await query.limit(100).get();

    const casos = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    return res.json(casos);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 6. PUT /api/anny/casos/:caseId — Actualizar estado caso
// Body: { estado, respuestaAdmin, notas }
// ============================================================
router.put('/casos/:caseId', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { caseId } = req.params;
    const { estado, respuestaAdmin, notas } = req.body;

    const update = {
      estado: estado || 'RESUELTO',
      respuestaAdmin,
      notas,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('casosEscaladosAnny')
      .doc(adminId)
      .collection('casos')
      .doc(caseId)
      .update(update);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 7. GET /api/anny/respuestas — Obtener respuestas pre-configuradas
// ============================================================
router.get('/respuestas', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;

    const doc = await db.collection('respuestasAnny').doc(adminId).get();

    if (!doc.exists) {
      // Devolver las 6 base como fallback
      return res.json(annyService.RESPUESTAS_BASE);
    }

    return res.json(doc.data());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 8. PUT /api/anny/respuestas — Actualizar respuesta configurada
// Body: { key, patrones[], respuesta, tipo }
// ============================================================
router.put('/respuestas', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { key, patrones, respuesta, tipo } = req.body;

    if (!key || !respuesta) {
      return res.status(400).json({ error: 'Falta key o respuesta' });
    }

    const doc = await db.collection('respuestasAnny').doc(adminId).get();
    const respuestas = doc.exists ? doc.data() : annyService.RESPUESTAS_BASE;

    respuestas[key] = {
      patrones: patrones || [],
      respuesta,
      tipo: tipo || 'CUSTOM'
    };

    await db.collection('respuestasAnny').doc(adminId).set(respuestas);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 9. GET /api/anny/estadisticas — Estadísticas completas
// Query: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// ============================================================
router.get('/estadisticas', authenticate, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const desde = req.query.desde || new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    const hasta = req.query.hasta || new Date().toISOString().split('T')[0];

    const snap = await db.collection('metricsAnny')
      .where('adminId', '==', adminId)
      .where('fecha', '>=', desde)
      .where('fecha', '<=', hasta)
      .get();

    const stats = {
      periodo: { desde, hasta },
      total_respuestas_automaticas: 0,
      total_respuestas_ia: 0,
      total_casos_escalados: 0,
      promedio_respuestas_dia: 0,
      porcentaje_automatico: 0,
      dias_activos: 0,
      datos_diarios: []
    };

    const datospordía = {};

    snap.docs.forEach(d => {
      const data = d.data();
      stats.total_respuestas_automaticas += data.respuestas_automaticas || 0;
      stats.total_respuestas_ia += data.respuestas_ia || 0;
      stats.total_casos_escalados += data.casos_escalados || 0;

      datospordía[data.fecha] = {
        fecha: data.fecha,
        automaticas: data.respuestas_automaticas || 0,
        ia: data.respuestas_ia || 0,
        escalados: data.casos_escalados || 0,
        total: (data.respuestas_automaticas || 0) + (data.respuestas_ia || 0) + (data.casos_escalados || 0)
      };
    });

    const total = stats.total_respuestas_automaticas + stats.total_respuestas_ia + stats.total_casos_escalados;

    stats.promedio_respuestas_dia = stats.total_respuestas_automaticas + stats.total_respuestas_ia + stats.total_casos_escalados;
    stats.porcentaje_automatico = total > 0 ? Math.round((stats.total_respuestas_automaticas / total) * 100) : 0;
    stats.dias_activos = Object.keys(datospordía).length;
    stats.datos_diarios = Object.values(datospordía).sort((a, b) => a.fecha.localeCompare(b.fecha));

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 10. POST /api/anny/test — Enviar mensaje de prueba
// Body: { telefono, mensaje } (solo para testing)
// ============================================================
router.post('/test', authenticate, async (req, res) => {
  try {
    // Solo admin puede hacer pruebas
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo admin' });
    }

    const adminId = req.user.adminId || req.user.uid;
    const { telefono, mensaje, nombreCliente = 'Cliente Test' } = req.body;

    if (!telefono || !mensaje) {
      return res.status(400).json({ error: 'Falta telefono o mensaje' });
    }

    const resultado = await annyService.procesarMensajeEntrante({
      adminId,
      telefono,
      nombreCliente,
      mensajeTexto: mensaje
    });

    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
