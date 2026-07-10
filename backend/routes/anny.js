// ============================================================
// Control360 — Rutas API Anny
// Ubicación: backend/routes/anny.js
// ============================================================
// MONTAJE en server.js (FIX ANNY-GATE-002):
//   app.use('/api/anny', require('./routes/anny'));
//
// FIX ANNY-QR-001: conexión WhatsApp (Baileys)
// FIX ANNY-LEARN-002: respuestas de entrenamiento
// FIX ANNY-UI-001: chats agrupados + hilo por cliente
// FIX ANNY-PEDIDOS-001: bandeja de pedidos cerrados por Anny
// FIX ANNY-VENC-001: ronda de vencimientos manual
// ============================================================

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
const annyService = require('../services/annyService');
const baileysService = require('../services/baileysService');
const annyNotificaciones = require('../services/annyNotificaciones');

// ============================================================
// FIX ANNY-GATE-001: gate del módulo 'anny_ia'
// ============================================================
async function requireAnnyActivo(req, res, next) {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const activo = await annyService.tenantTieneAnnyActiva(adminId);
    if (!activo) {
      return res.status(403).json({ error: 'anny_inactivo', mensaje: 'WhatsApp IA Anny no está activo para tu cuenta.' });
    }
    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Acciones sensibles — solo rol admin del tenant
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo admin puede realizar esta acción' });
  }
  next();
}

// ============================================================
// 1. GET /api/anny/config — SIN gate (incluye activo:true/false)
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
// 2. PUT /api/anny/config — Configuración operativa
// FIX ANNY-PEDIDOS-001 / ANNY-VENC-001: acepta notificarPedidosA,
// diasRondaVencimientos ("1,20") y topeDiarioRonda.
// ============================================================
router.put('/config', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const {
      whatsappNumber,
      diasAntes = 30,
      horaEnvio = '09:00',
      notificarPedidosA = '',
      diasRondaVencimientos = '',
      topeDiarioRonda = 60
    } = req.body;

    const resultado = await annyService.actualizarConfig(adminId, {
      whatsappNumber,
      diasAntes: Number(diasAntes),
      horaEnvio,
      notificarPedidosA: String(notificarPedidosA).replace(/\D/g, ''),
      diasRondaVencimientos: String(diasRondaVencimientos)
        .split(',')
        .map(s => parseInt(s.trim()))
        .filter(n => n >= 1 && n <= 31)
        .join(','),
      topeDiarioRonda: Math.min(Math.max(parseInt(topeDiarioRonda) || 60, 10), 150),
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
router.get('/metricas', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const metricas = await annyService.obtenerMetricasHoy(adminId);
    return res.json(metricas);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4. GET /api/anny/conversaciones — (legado; el panel usa /chats)
// ============================================================
router.get('/conversaciones', authenticate, requireAnnyActivo, async (req, res) => {
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
// FIX ANNY-UI-001 — Chats agrupados por número
// ============================================================

// 4b. GET /api/anny/chats — Lista de chats (uno por cliente)
router.get('/chats', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;

    const snap = await db.collection('conversacionesAnny')
      .doc(adminId)
      .collection('conversaciones')
      .limit(500)
      .get();

    const docs = snap.docs
      .map(d => d.data())
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    const chats = new Map();
    for (const c of docs) {
      if (!c.telefono) continue;
      if (!chats.has(c.telefono)) {
        chats.set(c.telefono, {
          telefono: c.telefono,
          nombreCliente: c.nombreCliente || null,
          ultimoTexto: c.mensajeCliente || c.respuestaAgente || '',
          ultimaFecha: c.createdAt || null,
          mensajes: 0,
          escalado: false
        });
      }
      const chat = chats.get(c.telefono);
      chat.mensajes += 1;
      if (!chat.nombreCliente && c.nombreCliente) chat.nombreCliente = c.nombreCliente;
      if (c.escalado) chat.escalado = true;
    }

    return res.json(Array.from(chats.values()));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 4c. GET /api/anny/chats/:telefono — Hilo completo de un cliente
router.get('/chats/:telefono', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { telefono } = req.params;

    const snap = await db.collection('conversacionesAnny')
      .doc(adminId)
      .collection('conversaciones')
      .where('telefono', '==', telefono)
      .limit(200)
      .get();

    const hilo = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));

    return res.json(hilo);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FIX ANNY-PEDIDOS-001 — Bandeja de pedidos cerrados por Anny
// ============================================================

// 4d. GET /api/anny/pedidos — Lista de pedidos (?estado=NUEVO|todos)
router.get('/pedidos', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const estado = req.query.estado || 'todos';

    let query = db.collection('pedidosAnny')
      .doc(adminId)
      .collection('pedidos');

    if (estado !== 'todos') {
      query = query.where('estado', '==', estado);
    }

    const snap = await query.limit(200).get();

    const pedidos = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    return res.json(pedidos);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 4e. PUT /api/anny/pedidos/:id — Actualizar estado del pedido
// Body: { estado: 'ORDEN_CREADA' | 'NUEVO' | 'DESCARTADO', notas? }
router.put('/pedidos/:id', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { id } = req.params;
    const { estado, notas } = req.body;

    const estadosValidos = ['NUEVO', 'ORDEN_CREADA', 'DESCARTADO'];
    if (!estadosValidos.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    await db.collection('pedidosAnny')
      .doc(adminId)
      .collection('pedidos')
      .doc(id)
      .update({
        estado,
        notas: notas || '',
        gestionadoPor: req.user.nombre || req.user.email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FIX ANNY-VENC-001 — Ronda de vencimientos manual
// ============================================================

// 4f. POST /api/anny/vencimientos/ronda — Disparar ronda AHORA
router.post('/vencimientos/ronda', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const resultado = await annyNotificaciones.ejecutarRondaVencimientos(adminId);
    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 5. GET /api/anny/casos-escalados — Casos pendientes
// ============================================================
router.get('/casos-escalados', authenticate, requireAnnyActivo, async (req, res) => {
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
// ============================================================
router.put('/casos/:caseId', authenticate, requireAnnyActivo, async (req, res) => {
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
// 7. GET /api/anny/respuestas — Respuestas del tenant (con caché)
// ============================================================
router.get('/respuestas', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const respuestas = await annyService.obtenerRespuestasTenant(adminId);
    return res.json(respuestas);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 8. PUT /api/anny/respuestas — Crear/actualizar respuesta
// ============================================================
router.put('/respuestas', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { key, patrones, respuesta, tipo } = req.body;

    if (!key || !respuesta) {
      return res.status(400).json({ error: 'Falta key o respuesta' });
    }

    const patronesLimpios = (Array.isArray(patrones) ? patrones : [])
      .map(p => String(p).toLowerCase().trim())
      .filter(p => p.length > 1);

    if (patronesLimpios.length === 0) {
      return res.status(400).json({ error: 'Agrega al menos un patrón (frase que escribe el cliente)' });
    }

    const doc = await db.collection('respuestasAnny').doc(adminId).get();
    const respuestas = doc.exists ? doc.data() : { ...annyService.RESPUESTAS_BASE };

    respuestas[key] = {
      patrones: patronesLimpios,
      respuesta,
      tipo: tipo || 'CUSTOM'
    };

    await db.collection('respuestasAnny').doc(adminId).set(respuestas);
    annyService.invalidarCacheRespuestas(adminId);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 8b. DELETE /api/anny/respuestas/:key — Eliminar respuesta
// ============================================================
router.delete('/respuestas/:key', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { key } = req.params;

    const docRef = db.collection('respuestasAnny').doc(adminId);
    const doc = await docRef.get();
    const respuestas = doc.exists ? doc.data() : { ...annyService.RESPUESTAS_BASE };

    if (!respuestas[key]) {
      return res.status(404).json({ error: 'Respuesta no encontrada' });
    }

    delete respuestas[key];
    await docRef.set(respuestas);
    annyService.invalidarCacheRespuestas(adminId);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 9. GET /api/anny/estadisticas — Estadísticas completas
// ============================================================
router.get('/estadisticas', authenticate, requireAnnyActivo, async (req, res) => {
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

    const datosPorDia = {};

    snap.docs.forEach(d => {
      const data = d.data();
      stats.total_respuestas_automaticas += data.respuestas_automaticas || 0;
      stats.total_respuestas_ia += data.respuestas_ia || 0;
      stats.total_casos_escalados += data.casos_escalados || 0;

      datosPorDia[data.fecha] = {
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
    stats.dias_activos = Object.keys(datosPorDia).length;
    stats.datos_diarios = Object.values(datosPorDia).sort((a, b) => a.fecha.localeCompare(b.fecha));

    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 10. POST /api/anny/test — Mensaje de prueba (solo admin)
// ============================================================
router.post('/test', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
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

// ============================================================
// FIX ANNY-QR-001 — Conexión WhatsApp (Baileys)
// ============================================================

// 11. POST /api/anny/conectar
router.post('/conectar', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const resultado = await baileysService.iniciarSesion(adminId);
    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 12. GET /api/anny/qr
router.get('/qr', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const resultado = baileysService.getQR(adminId);
    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 13. GET /api/anny/estado
router.get('/estado', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const resultado = await baileysService.getEstado(adminId);
    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 14. POST /api/anny/desconectar
router.post('/desconectar', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const resultado = await baileysService.desconectar(adminId);
    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// FIN anny.js
