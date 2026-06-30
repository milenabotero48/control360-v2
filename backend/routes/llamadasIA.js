// ============================================================
// Control360 — Rutas de Llamadas IA (Lucy / Vapi)
// Ubicación: backend/routes/llamadasIA.js
// ------------------------------------------------------------
// MONTAJE en server.js (DOS líneas — distinto patrón porque las
// Tools y el webhook deben ser PÚBLICOS, igual que qr_public y
// el webhook de WhatsApp; el resto de rutas sí van autenticadas):
//
//   // Públicas (Vapi las llama directamente — sin JWT de usuario)
//   app.use('/api/llamadas-ia/publico', require('./routes/llamadasIAPublico'));
//   // Autenticadas (panel del suscriptor / SuperAdmin)
//   app.use('/api/llamadas-ia', authenticate, require('./routes/llamadasIA'));
//
// Por eso ESTE archivo se divide en dos exports: router (autenticado)
// y routerPublico (sin authenticate, protegido con secreto compartido).
//
// SEGURIDAD: las rutas públicas validan un header
// 'x-vapi-secret' contra process.env.VAPI_WEBHOOK_SECRET —
// mismo patrón de "secreto compartido" que ya usas en otros
// endpoints públicos del proyecto.
// ============================================================

const express = require('express');
const router = express.Router();          // autenticado
const routerPublico = express.Router();   // público (Tools + webhook de Vapi)
const { db, admin } = require('../config/firebase');
const {
  ejecutarMotorLlamadas,
  procesarResultadoLlamada,
} = require('../services/llamadasIAService');

const VAPI_WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET;

// ─── HELPER: resolver tenant (patrón estándar del proyecto) ──────────────────
const getAdminId = (req) => req.adminId || req.user?.uid || req.user?.id;

// ─── HELPER: auditoría (mismo patrón del resto de módulos) ───────────────────
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

// ─── Middleware de seguridad para rutas públicas (Vapi) ───────────────────────
const validarSecretoVapi = (req, res, next) => {
  const secreto = req.headers['x-vapi-secret'];
  if (!VAPI_WEBHOOK_SECRET || secreto !== VAPI_WEBHOOK_SECRET) {
    console.warn('[LLAMADAS-IA] Intento de acceso público sin secreto válido');
    return res.status(403).json({ error: 'No autorizado' });
  }
  next();
};
routerPublico.use(validarSecretoVapi);

// ═════════════════════════════════════════════════════════════════════════════
// ████████████████████████  RUTAS PÚBLICAS (Vapi)  ████████████████████████████
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/publico/consultar-precio
// Tool que Lucy invoca EN VIVO durante la llamada cuando el cliente pregunta
// el valor. Recibe el adminId + descripción del equipo y hace un matching
// por PALABRAS CLAVE (no por substring simple) contra `products`, porque
// "Recarga ABC 5 lbs" y "Extintor ABC 5 lbs" son productos DISTINTOS con
// reglas de negocio distintas — confundirlos sería grave.
//
// Body esperado (formato Vapi function-call):
// { message: { toolCalls: [{ id, function: { arguments: { adminId, descripcionEquipo, esRecarga } } }] } }
// ─────────────────────────────────────────────────────────────────────────────
routerPublico.post('/consultar-precio', async (req, res) => {
  try {
    const llamada = req.body?.message?.toolCalls?.[0];
    const args = llamada?.function?.arguments || req.body; // tolera invocación directa en pruebas
    const { adminId, descripcionEquipo, esRecarga = true } = args;

    if (!adminId || !descripcionEquipo) {
      return res.json(respuestaTool(llamada?.id, { encontrado: false, mensaje: 'Faltan datos para consultar el precio' }));
    }

    // products.js filtra por `creadoPor`, no por `adminId` — mismo patrón aquí
    const prodSnap = await db.collection('products')
      .where('creadoPor', '==', adminId)
      .where('activo', '==', true)
      .limit(500)
      .get();

    // Tokeniza la descripción del equipo: "ABC 5 lbs" → ['ABC', '5', 'LBS']
    const tokens = String(descripcionEquipo).toUpperCase().match(/[A-ZÁÉÍÓÚÑ0-9]+/g) || [];
    const palabraServicio = esRecarga ? 'RECARGA' : 'EXTINTOR'; // distingue recarga de equipo nuevo

    let mejorMatch = null;
    let mejorPuntaje = 0;

    prodSnap.docs.forEach(d => {
      const data = d.data();
      const nombreProd = (data.nombre || '').toUpperCase();
      if (!nombreProd.includes(palabraServicio)) return; // descarta categoría equivocada (recarga vs nuevo)

      let puntaje = 0;
      tokens.forEach(t => { if (nombreProd.includes(t)) puntaje++; });

      if (puntaje > mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejorMatch = data;
      }
    });

    if (mejorMatch && mejorPuntaje > 0) {
      return res.json(respuestaTool(llamada?.id, {
        encontrado: true,
        precio: mejorMatch.precioVenta || 0,
        precioTexto: `$${Number(mejorMatch.precioVenta || 0).toLocaleString('es-CO')}`,
        nombreProducto: mejorMatch.nombre,
      }));
    }

    return res.json(respuestaTool(llamada?.id, {
      encontrado: false,
      mensaje: 'No se encontró un precio exacto — Lucy debe indicar que un asesor confirma el valor',
    }));
  } catch (err) {
    console.error('[LLAMADAS-IA] Error en consultar-precio:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/publico/registrar-cierre
// Tool que Lucy invoca al final, SOLO si el cliente aceptó programar el
// servicio. Guarda los datos recolectados en `llamadas_ia.datosCierre` para
// que un humano revise y cree la orden — Lucy NUNCA crea la orden directamente
// (ver justificación en llamadasIAService.js).
// ─────────────────────────────────────────────────────────────────────────────
routerPublico.post('/registrar-cierre', async (req, res) => {
  try {
    const llamada = req.body?.message?.toolCalls?.[0];
    const args = llamada?.function?.arguments || req.body;
    const {
      registroId, nombreCompleto, empresa, nit, direccion, barrio,
      celular, email, horarioAtencion, tipoServicio, diaAcordado, franjaHoraria,
    } = args;

    if (!registroId) {
      return res.json(respuestaTool(llamada?.id, { ok: false, mensaje: 'Falta registroId' }));
    }

    const ref = db.collection('llamadas_ia').doc(registroId);
    const doc = await ref.get();
    if (!doc.exists) {
      return res.json(respuestaTool(llamada?.id, { ok: false, mensaje: 'Registro no encontrado' }));
    }

    // NOTA: regData.clienteId YA EXISTE desde que se creó este registro —
    // el motor (ejecutarMotorLlamadas en llamadasIAService.js) solo lanza
    // llamadas a clientes que ya están en `clients` (llegan vía un
    // vencimiento existente). Lucy nunca llama a alguien nuevo, así que
    // aquí no hace falta buscar/crear cliente — el puente a NuevaOrden.js
    // en el frontend usa ese mismo clienteId que ya viene del registro.
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

    // Marca el vencimiento como gestionado — no vuelve a sonar el próximo mes
    const regData = doc.data();
    if (regData.vencimientoId) {
      await db.collection('vencimientos').doc(regData.vencimientoId).update({
        gestionado: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

    return res.json(respuestaTool(llamada?.id, { ok: true, mensaje: 'Cierre registrado correctamente' }));
  } catch (err) {
    console.error('[LLAMADAS-IA] Error en registrar-cierre:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/publico/webhook
// Webhook de fin de llamada (end-of-call-report) — Vapi lo dispara siempre,
// haya cerrado o no. Aquí se guarda transcripción, duración y costo real.
// ─────────────────────────────────────────────────────────────────────────────
routerPublico.post('/webhook', async (req, res) => {
  // Responder rápido primero — mismo patrón que el webhook de WhatsApp,
  // para que Vapi no reintente por timeout mientras procesamos.
  res.sendStatus(200);
  try {
    await procesarResultadoLlamada(req.body);
  } catch (e) {
    console.error('[LLAMADAS-IA] Error procesando webhook:', e.message);
  }
});

// ─── Helper: formato de respuesta que Vapi espera de una Tool ────────────────
function respuestaTool(toolCallId, resultado) {
  return {
    results: [
      { toolCallId: toolCallId || 'manual', result: JSON.stringify(resultado) }
    ]
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ███████████████████  RUTAS AUTENTICADAS (panel Control360)  █████████████████
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/llamadas-ia — Listado para el SUSCRIPTOR (sus propios clientes)
// No expone costoVapiUSD — eso es solo visible para SuperAdmin.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { mes, resultado } = req.query;

    let query = db.collection('llamadas_ia').where('adminId', '==', adminId);
    const snap = await query.limit(1000).get();

    let lista = snap.docs.map(d => {
      const data = { id: d.id, ...d.data() };
      delete data.costoVapiUSD; // el suscriptor no ve costos internos de Vapi
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
// GET /api/llamadas-ia/resumen — Tarjetas de resumen del mes (suscriptor)
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
// Conteo por tenant + costos reales de Vapi, para facturación mensual.
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
          adminId: l.adminId, total: 0, cerradas: 0, costoVapiUSD: 0, costoFacturadoCOP: 0,
        };
      }
      const t = porTenant[l.adminId];
      t.total++;
      if (l.resultado === 'cerrada') t.cerradas++;
      t.costoVapiUSD += Number(l.costoVapiUSD) || 0;
      t.costoFacturadoCOP += Number(l.costoFacturadoCOP) || 0;
    }

    // Enriquecer con nombre de empresa de cada tenant
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
// GET /api/llamadas-ia/config — Estado de activación del tenant actual
// MISMO PATRÓN QUE 'qr': se lee del array `modulos` del documento de usuario,
// no de una colección aparte. El frontend (LlamadasIA.js) usa esto para
// decidir si muestra el panel completo o el aviso "módulo no activo".
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const userDoc = await db.collection('users').doc(adminId).get();
    const modulos = userDoc.exists ? (userDoc.data().modulos || []) : [];
    return res.json({ activo: modulos.includes('llamadas_ia') });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/llamadas-ia/ejecutar-motor — Disparo MANUAL (solo admin/SuperAdmin)
// Para pruebas, sin esperar al cron de los primeros días hábiles del mes.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ejecutar-motor', async (req, res) => {
  try {
    if (req.user?.role !== 'admin' && !req.user?.superAdmin) {
      return res.status(403).json({ error: 'Solo el administrador puede ejecutar el motor manualmente' });
    }
    const resultado = await ejecutarMotorLlamadas();
    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = { router, routerPublico };
