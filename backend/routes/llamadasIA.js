// ============================================================
// Control360 — Rutas de Llamadas IA (Lucy / ElevenLabs)
// Ubicación: backend/routes/llamadasIA.js
// ------------------------------------------------------------
// ✅ FIX LUCY-ELEVEN-002 (2026-07-19):
//   a) Formato de Tools y webhook migrado de Vapi a ElevenLabs:
//      las Tools de ElevenLabs envían el body plano (sin wrapper
//      toolCalls) y esperan un JSON plano de respuesta.
//   b) Secreto compartido nuevo: header 'x-lucy-secret' contra
//      LUCY_WEBHOOK_SECRET (se acepta también ?secret= en la URL
//      porque el webhook post-llamada de ElevenLabs no permite
//      headers personalizados).
//   c) /ejecutar-motor AHORA ES SCOPED: ejecuta SOLO el tenant de
//      la sesión. SuperAdmin puede pasar un adminId explícito.
//      Nunca más una prueba manual dispara llamadas globales.
//   d) Nuevos endpoints (pedido de Sandra — mismo patrón que Anny):
//      POST /programar, GET /programadas, DELETE /programadas/:id,
//      POST /llamada-prueba.
//
// MONTAJE en server.js (sin cambios — mismas dos líneas):
//   app.use('/api/llamadas-ia/publico', llamadasIAPublico);
//   app.use('/api/llamadas-ia', authenticate, llamadasIARouter);
// ============================================================

const express = require('express');
const router = express.Router();          // autenticado
const routerPublico = express.Router();   // público (Tools + webhook ElevenLabs)
const { db, admin } = require('../config/firebase');
const {
  ejecutarMotorLlamadas,
  procesarResultadoLlamada,
  lanzarLlamadaPrueba,
  obtenerConfigTenant,
} = require('../services/llamadasIAService');

const LUCY_WEBHOOK_SECRET = process.env.LUCY_WEBHOOK_SECRET || process.env.VAPI_WEBHOOK_SECRET;

// ─── HELPER: resolver tenant (patrón estándar del proyecto) ──────────────────
const getAdminId = (req) => req.adminId || req.user?.uid || req.user?.id;

// ─── HELPER: auditoría ───────────────────────────────────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'llamadas_ia', descripcion,
      usuarioId, usuarioNombre, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

// ─── Seguridad rutas públicas — ✅ FIX LUCY-ELEVEN-002b ──────────────────────
// Tools: header 'x-lucy-secret'. Webhook post-llamada: ?secret= en la URL
// (ElevenLabs no permite headers personalizados en ese webhook).
const validarSecretoLucy = (req, res, next) => {
  const secreto = req.headers['x-lucy-secret'] || req.query.secret;
  if (!LUCY_WEBHOOK_SECRET || secreto !== LUCY_WEBHOOK_SECRET) {
    console.warn('[LLAMADAS-IA] Intento de acceso público sin secreto válido');
    return res.status(403).json({ error: 'No autorizado' });
  }
  next();
};
routerPublico.use(validarSecretoLucy);

// ═════════════════════════════════════════════════════════════════════════════
// ██████████████████████  RUTAS PÚBLICAS (ElevenLabs)  ████████████████████████
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/publico/consultar-precio
// Tool que Lucy invoca EN VIVO cuando el cliente pregunta el valor.
// Matching por PALABRAS CLAVE (no substring simple): "Recarga ABC 5 lbs" y
// "Extintor ABC 5 lbs" son productos DISTINTOS — confundirlos sería grave.
// Body (ElevenLabs webhook-tool, plano): { adminId, descripcionEquipo, esRecarga }
// ─────────────────────────────────────────────────────────────────────────────
routerPublico.post('/consultar-precio', async (req, res) => {
  try {
    // ✅ FIX LUCY-ELEVEN-002a: body plano de ElevenLabs; se tolera el formato
    // Vapi legado (message.toolCalls) por si queda alguna prueba vieja apuntando aquí.
    const args = req.body?.message?.toolCalls?.[0]?.function?.arguments || req.body || {};
    const { adminId, descripcionEquipo, esRecarga = true } = args;

    if (!adminId || !descripcionEquipo) {
      return res.json({ encontrado: false, mensaje: 'Faltan datos para consultar el precio' });
    }

    // products.js filtra por `creadoPor`, no por `adminId` — mismo patrón aquí
    const prodSnap = await db.collection('products')
      .where('creadoPor', '==', adminId)
      .where('activo', '==', true)
      .limit(500)
      .get();

    const tokens = String(descripcionEquipo).toUpperCase().match(/[A-ZÁÉÍÓÚÑ0-9]+/g) || [];
    const esRecargaBool = esRecarga === true || esRecarga === 'true';
    const palabraServicio = esRecargaBool ? 'RECARGA' : 'EXTINTOR';

    let mejorMatch = null;
    let mejorPuntaje = 0;

    prodSnap.docs.forEach(d => {
      const data = d.data();
      const nombreProd = (data.nombre || '').toUpperCase();
      if (!nombreProd.includes(palabraServicio)) return;

      let puntaje = 0;
      tokens.forEach(t => { if (nombreProd.includes(t)) puntaje++; });

      if (puntaje > mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejorMatch = data;
      }
    });

    if (mejorMatch && mejorPuntaje > 0) {
      return res.json({
        encontrado: true,
        precio: mejorMatch.precioVenta || 0,
        precioTexto: `${Number(mejorMatch.precioVenta || 0).toLocaleString('es-CO')} pesos`,
        nombreProducto: mejorMatch.nombre,
      });
    }

    return res.json({
      encontrado: false,
      mensaje: 'No se encontró un precio exacto — indica al cliente que un asesor confirma el valor',
    });
  } catch (err) {
    console.error('[LLAMADAS-IA] Error en consultar-precio:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/publico/registrar-cierre
// Tool que Lucy invoca SOLO si el cliente aceptó programar el servicio.
// Guarda los datos en `llamadas_ia.datosCierre` para que un humano cree la
// orden — Lucy NUNCA crea la orden directamente (riesgo de negocio).
// ─────────────────────────────────────────────────────────────────────────────
routerPublico.post('/registrar-cierre', async (req, res) => {
  try {
    const args = req.body?.message?.toolCalls?.[0]?.function?.arguments || req.body || {};
    const {
      registroId, nombreCompleto, empresa, nit, direccion, barrio,
      celular, email, horarioAtencion, tipoServicio, diaAcordado, franjaHoraria,
    } = args;

    if (!registroId) {
      return res.json({ ok: false, mensaje: 'Falta registroId' });
    }

    const ref = db.collection('llamadas_ia').doc(registroId);
    const doc = await ref.get();
    if (!doc.exists) {
      return res.json({ ok: false, mensaje: 'Registro no encontrado' });
    }

    // regData.clienteId YA EXISTE desde que el motor creó el registro — Lucy
    // nunca llama a alguien que no esté en `clients` (salvo llamadas de prueba).
    const datosCierre = {
      nombreCompleto: nombreCompleto || null,
      empresa: empresa || null,
      nit: nit || null,
      direccion: direccion || null,
      barrio: barrio || null,
      celular: celular || null,
      email: email || null,
      horarioAtencion: horarioAtencion || null,
      tipoServicio: tipoServicio || null, // 'oficina' | 'domicilio'
      diaAcordado: diaAcordado || null,
      franjaHoraria: franjaHoraria || null,
    };

    await ref.update({
      resultado: 'cerrada',
      estado: 'completada',
      datosCierre,
      fechaAgendada: diaAcordado || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const regData = doc.data();
    if (regData.vencimientoId) {
      await db.collection('vencimientos').doc(regData.vencimientoId).update({
        gestionado: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

    return res.json({ ok: true, mensaje: 'Cierre registrado correctamente' });
  } catch (err) {
    console.error('[LLAMADAS-IA] Error en registrar-cierre:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/publico/webhook
// Webhook post-llamada de ElevenLabs (post_call_transcription).
// URL a configurar en ElevenLabs:
//   https://<railway>/api/llamadas-ia/publico/webhook?secret=<LUCY_WEBHOOK_SECRET>
// ─────────────────────────────────────────────────────────────────────────────
routerPublico.post('/webhook', async (req, res) => {
  // Responder rápido primero — mismo patrón que el webhook de WhatsApp
  res.sendStatus(200);
  try {
    await procesarResultadoLlamada(req.body);
  } catch (e) {
    console.error('[LLAMADAS-IA] Error procesando webhook:', e.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ███████████████████  RUTAS AUTENTICADAS (panel Control360)  █████████████████
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/llamadas-ia — Listado para el suscriptor (sus propios registros)
// No expone costos internos del proveedor — solo visibles para SuperAdmin.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { mes, resultado } = req.query;

    const snap = await db.collection('llamadas_ia').where('adminId', '==', adminId).limit(1000).get();

    let lista = snap.docs.map(d => {
      const data = { id: d.id, ...d.data() };
      delete data.costoVapiUSD;         // legado Vapi
      delete data.costoCreditosEleven;  // costo interno ElevenLabs
      return data;
    });

    if (mes) lista = lista.filter(l => (l.mesVencimiento || '').startsWith(mes));
    if (resultado) lista = lista.filter(l => l.resultado === resultado);

    lista.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    return res.json(lista);
  } catch (err) {
    console.error('GET /llamadas-ia:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/llamadas-ia/resumen — Tarjetas del mes (suscriptor)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/resumen', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const snap = await db.collection('llamadas_ia').where('adminId', '==', adminId).limit(2000).get();

    const resumen = {
      total: 0, cerrada: 0, reagendada: 0, inactivo_cliente: 0,
      escalado_asesor: 0, no_interesado: 0, sin_respuesta: 0, en_curso: 0,
    };
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.esPrueba) return; // las pruebas no contaminan las métricas
      resumen.total++;
      const r = data.resultado || (data.estado === 'en_curso' ? 'en_curso' : null);
      if (r && resumen[r] !== undefined) resumen[r]++;
    });

    return res.json(resumen);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/llamadas-ia/superadmin/resumen — Vista global (solo Sandra)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/superadmin/resumen', async (req, res) => {
  try {
    if (!req.user?.superAdmin) {
      return res.status(403).json({ error: 'Solo SuperAdmin' });
    }
    const { mes } = req.query; // 'YYYY-MM'
    let snap = await db.collection('llamadas_ia').limit(5000).get();
    let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (mes) docs = docs.filter(l => (l.mesVencimiento || '').startsWith(mes));

    const porTenant = {};
    for (const l of docs) {
      if (!porTenant[l.adminId]) {
        porTenant[l.adminId] = {
          adminId: l.adminId, total: 0, cerradas: 0,
          costoCreditosEleven: 0, costoFacturadoCOP: 0,
        };
      }
      const t = porTenant[l.adminId];
      t.total++;
      if (l.resultado === 'cerrada') t.cerradas++;
      t.costoCreditosEleven += Number(l.costoCreditosEleven) || 0;
      t.costoFacturadoCOP += Number(l.costoFacturadoCOP) || 0;
    }

    const resultado = [];
    for (const t of Object.values(porTenant)) {
      const userDoc = await db.collection('users').doc(t.adminId).get();
      resultado.push({
        ...t,
        nombreEmpresa: userDoc.exists ? (userDoc.data().empresa || userDoc.data().nombre) : t.adminId,
      });
    }

    return res.json(resultado);
  } catch (err) {
    console.error('GET /llamadas-ia/superadmin/resumen:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/llamadas-ia/config — Activación + tope de minutos del tenant
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const userDoc = await db.collection('users').doc(adminId).get();
    const modulos = userDoc.exists ? (userDoc.data().modulos || []) : [];
    const activo = modulos.includes('llamadas_ia');
    const config = activo ? await obtenerConfigTenant(adminId) : null;
    return res.json({
      activo,
      topeMinutosMes: config?.topeMinutosMes ?? null,
      minutosConsumidosMes: config?.minutosConsumidosMes ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/ejecutar-motor — Disparo MANUAL "Lanzar llamadas ahora"
// ✅ FIX LUCY-ELEVEN-002c: SCOPED al tenant de la sesión. SuperAdmin puede
// pasar { adminId } en el body para correr otro tenant puntual. NUNCA global.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ejecutar-motor', async (req, res) => {
  try {
    if (req.user?.role !== 'admin' && !req.user?.superAdmin) {
      return res.status(403).json({ error: 'Solo el administrador puede lanzar llamadas manualmente' });
    }

    const adminIdSesion = getAdminId(req);
    const adminIdObjetivo = (req.user?.superAdmin && req.body?.adminId) ? req.body.adminId : adminIdSesion;

    await auditar({
      accion: 'lanzar_motor_manual',
      descripcion: `Lanzamiento manual de llamadas IA para tenant ${adminIdObjetivo}`,
      usuarioId: adminIdSesion,
      usuarioNombre: req.user?.nombre || '',
      datos: { adminIdObjetivo },
    });

    const resultado = await ejecutarMotorLlamadas({ soloAdminId: adminIdObjetivo, ignorarHorario: true });
    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/llamada-prueba — ✅ FIX LUCY-ELEVEN-002d
// Llamada de prueba a un número puntual (validar guion/voz sin clientes reales)
// Body: { telefono }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/llamada-prueba', async (req, res) => {
  try {
    if (req.user?.role !== 'admin' && !req.user?.superAdmin) {
      return res.status(403).json({ error: 'Solo el administrador puede lanzar llamadas de prueba' });
    }
    const adminId = getAdminId(req);
    const { telefono } = req.body || {};
    if (!telefono) return res.status(400).json({ error: 'Falta el teléfono' });

    const resultado = await lanzarLlamadaPrueba({ adminId, telefono });
    if (!resultado.ok) return res.status(400).json({ error: resultado.error });

    await auditar({
      accion: 'llamada_prueba',
      descripcion: `Llamada de prueba de Lucy a ${telefono}`,
      usuarioId: adminId,
      usuarioNombre: req.user?.nombre || '',
    });

    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/programar — ✅ FIX LUCY-ELEVEN-002d (igual que Anny)
// Programa una corrida del motor para el día y hora elegidos (hora Colombia).
// Body: { fecha: 'YYYY-MM-DD', hora: 'HH:mm' }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/programar', async (req, res) => {
  try {
    if (req.user?.role !== 'admin' && !req.user?.superAdmin) {
      return res.status(403).json({ error: 'Solo el administrador puede programar llamadas' });
    }
    const adminId = getAdminId(req);
    const { fecha, hora } = req.body || {};

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || !/^\d{2}:\d{2}$/.test(hora || '')) {
      return res.status(400).json({ error: 'Fecha u hora inválidas (formato AAAA-MM-DD y HH:mm)' });
    }

    const fechaHora = `${fecha}T${hora}`;
    const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 16);
    if (fechaHora <= ahoraCO) {
      return res.status(400).json({ error: 'La fecha y hora deben ser futuras' });
    }

    const ref = await db.collection('llamadas_ia_programadas').add({
      adminId,
      fechaHora,
      estado: 'pendiente',
      creadaPor: req.user?.nombre || adminId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await auditar({
      accion: 'programar_llamadas',
      descripcion: `Corrida de llamadas IA programada para ${fecha} ${hora}`,
      usuarioId: adminId,
      usuarioNombre: req.user?.nombre || '',
      datos: { fechaHora },
    });

    return res.json({ ok: true, id: ref.id, fechaHora });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/llamadas-ia/programadas — Corridas programadas del tenant
// ─────────────────────────────────────────────────────────────────────────────
router.get('/programadas', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const snap = await db.collection('llamadas_ia_programadas')
      .where('adminId', '==', adminId)
      .limit(100)
      .get();
    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lista.sort((a, b) => (a.fechaHora || '').localeCompare(b.fechaHora || ''));
    return res.json(lista);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/llamadas-ia/programadas/:id — Cancelar una corrida programada
// Valida ownership del tenant (regla multi-tenant del proyecto).
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/programadas/:id', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const ref = db.collection('llamadas_ia_programadas').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrada' });
    if (doc.data().adminId !== adminId) {
      return res.status(403).json({ error: 'No autorizado' }); // ownership multi-tenant
    }
    if (doc.data().estado !== 'pendiente') {
      return res.status(400).json({ error: 'Solo se pueden cancelar corridas pendientes' });
    }
    await ref.update({ estado: 'cancelada', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = { router, routerPublico };
