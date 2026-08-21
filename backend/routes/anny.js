// ============================================================
// Control360 — Rutas API Anny  (v22)
// Ubicación: backend/routes/anny.js
// ============================================================
// FIX ANNY-QR-001: conexión WhatsApp (Baileys)
// FIX ANNY-LEARN-002: respuestas de entrenamiento
// FIX ANNY-UI-001: chats agrupados + hilo por cliente
// FIX ANNY-PEDIDOS-001: bandeja de pedidos
// FIX ANNY-VENC-001: ronda de vencimientos manual
// FIX ANNY-CASO-002: PUT /casos fallaba por undefined (botón Resuelto)
// FIX ANNY-SILENCIO-001: silenciar Anny por chat
//
// ════════════════════════════════════════════════════════════
// NUEVO EN v22:
// - ANNY-ESCALA-017: GET /chats deja de barrer TODOS los mensajes
//   con .limit(500) sin orderBy (devolvía 500 docs ARBITRARIOS por
//   orden de ID y hacía DESAPARECER chats al superar ese techo).
//   Ahora lee resúmenes desnormalizados con paginación real.
//   Compatibilidad: si el tenant aún no tiene resúmenes (histórico
//   previo a v22), cae automáticamente al método legado.
// - ANNY-CFG-010: perfil de negocio de Anny — SOLO SuperAdmin.
//   Mismo patrón de permisos que superadmin.js (users.superAdmin).
// - ANNY-BORRADOR-015: los pedidos de Anny pasan por BORRADOR y
//   validación humana antes de convertirse en orden de servicio.
//   Anny NUNCA escribe directo en `orders`: entrega un payload
//   pre-llenado y la orden la crea el flujo oficial. La máquina de
//   estados y la lógica financiera quedan intactas.
// - ANNY-IDEM-016: al validar/promover se respeta un único
//   pedido abierto por teléfono.
// - ANNY-MISION-014: /test acepta `mision` para probar cobranza,
//   taller o renovación sin esperar al cron.
// ============================================================

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
const annyService = require('../services/annyService');
const baileysService = require('../services/baileysService');
const annyNotificaciones = require('../services/annyNotificaciones');
// ✅ ANNY-CONSUMO-026: medición de consumo por suscriptor
const annyConsumo = require('../services/annyConsumo');

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

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo admin puede realizar esta acción' });
  }
  next();
}

// ============================================================
// FIX ANNY-CFG-010: portero de SuperAdmin.
// Mismo criterio que superadmin.js: users/{uid}.superAdmin === true.
// Se lee de Firestore en cada petición a propósito (no se cachea
// un permiso de este nivel).
// ============================================================
async function soloSuperAdmin(req, res, next) {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists || doc.data().superAdmin !== true) {
      return res.status(403).json({ error: 'Acceso restringido' });
    }
    next();
  } catch (err) {
    console.error('soloSuperAdmin (anny):', err);
    return res.status(500).json({ error: 'Error verificando permisos' });
  }
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
// 2. PUT /api/anny/config — Configuración OPERATIVA del suscriptor
// (el perfil de negocio NO se toca aquí: ver 2b)
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
      topeDiarioRonda = 60,
      notificarGrupoJid // ✅ ANNY-GRUPO-051 (undefined = no tocar)
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
      // ✅ ANNY-GRUPO-051: '' limpia el grupo; undefined lo deja como está.
      ...(notificarGrupoJid !== undefined
        ? { notificarGrupoJid: String(notificarGrupoJid).endsWith('@g.us') ? String(notificarGrupoJid) : '' }
        : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json(resultado);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FIX ANNY-CFG-010 — PERFIL DE NEGOCIO (solo SuperAdmin)
// ------------------------------------------------------------
// Es lo que hace a Anny polifacética: la misma agente atiende un
// tenant de extintores y uno de software sin cruzar contextos.
// Se configura por tenant desde el Panel de Suscriptores, igual
// que los módulos. El suscriptor NO puede editarlo.
// ============================================================

// 2b. GET /api/anny/perfil/:adminId — leer perfil de un tenant
router.get('/perfil/:adminId', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const perfil = await annyService.obtenerPerfilTenant(req.params.adminId);
    return res.json({
      adminId: req.params.adminId,
      perfil,
      fuentesPrecios: ['products', 'planes', 'ninguna'],
      misionesDisponibles: Object.keys(annyService.MISIONES),
      // ✅ ANNY-NICHO-033: plantillas por actividad económica para el selector
      nichos: Object.entries(annyService.NICHOS).map(([id, n]) => ({ id, etiqueta: n.etiqueta })),
      porDefecto: annyService.PERFIL_DEFAULT
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 2c. PUT /api/anny/perfil/:adminId — guardar perfil de un tenant
router.put('/perfil/:adminId', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const {
      nombreAgente, empresa, vertical, queVende,
      fuentePrecios, reglasNegocio, notificarEscalamientoA,
      // ✅ ANNY-NICHO-033 / ANNY-VENTA-034
      nicho, mediosPago, avisarVentaCliente
    } = req.body || {};

    if (fuentePrecios && !['products', 'planes', 'ninguna'].includes(fuentePrecios)) {
      return res.status(400).json({ error: 'fuentePrecios inválida' });
    }
    if (nicho && !annyService.NICHOS[nicho]) {
      return res.status(400).json({ error: 'nicho inválido' });
    }

    // ✅ ANNY-PERFIL-055: `empresa` y `nombreAgente` son NOMBRES, no frases.
    // Guardar ahí "Hola soy Anny, asistente virtual de Extintores del Valle"
    // rompía dos cosas a la vez: el mensaje de Telemercadeo salía como
    // "Le escribimos de Hola soy Anny, asistente virtual de..." y la
    // identidad de Anny en su propio prompt quedaba igual de rota
    // ("Eres Anny, asesora comercial de Hola soy Anny, asistente...").
    // Se valida al guardar: es el único punto donde se puede evitar.
    const pareceFrase = (v) => /\b(hola|buenas|soy|asistente|virtual|escribimos|buenos días)\b/i.test(String(v));

    if (empresa !== undefined) {
      const e = String(empresa).trim();
      if (e.length > 70 || pareceFrase(e)) {
        return res.status(400).json({
          error: 'El campo "empresa" debe ser SOLO el nombre comercial (ej: "Extintores del Valle"), no un saludo ni una frase. Anny arma la presentación por su cuenta.'
        });
      }
    }

    if (nombreAgente !== undefined) {
      const n = String(nombreAgente).trim();
      if (n.length > 30 || n.split(/\s+/).length > 3) {
        return res.status(400).json({
          error: 'El campo "nombreAgente" debe ser SOLO el nombre de la agente (ej: "Anny").'
        });
      }
    }

    const resultado = await annyService.actualizarPerfilTenant(adminId, {
      nombreAgente, empresa, vertical, queVende, fuentePrecios, reglasNegocio,
      nicho,
      mediosPago,
      avisarVentaCliente: avisarVentaCliente !== undefined ? avisarVentaCliente === true : undefined,
      notificarEscalamientoA: notificarEscalamientoA !== undefined
        ? String(notificarEscalamientoA).replace(/\D/g, '')
        : undefined
    });

    if (resultado.error) return res.status(500).json(resultado);

    // Auditoría (mismo formato audit_logs del sistema)
    try {
      await db.collection('audit_logs').add({
        accion: 'ANNY_PERFIL_ACTUALIZADO',
        modulo: 'anny',
        descripcion: `Perfil de Anny actualizado para el tenant ${adminId}`,
        usuarioId: req.user.uid,
        usuarioNombre: req.user.nombre || req.user.email || 'SuperAdmin',
        datos: resultado.perfil,
        fecha: new Date().toISOString(),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { console.error('Auditoría perfil Anny:', e.message); }

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
// 4b. GET /api/anny/chats — Lista de chats PAGINADA
// FIX ANNY-ESCALA-017
// ------------------------------------------------------------
// Query params: ?limit=25&desdeMs=<cursor>&filtro=escalados|todos
// Respuesta: { chats, cursor, migrado }
//   · cursor  → pásalo como desdeMs para la página siguiente.
//               null = no hay más.
//   · migrado → false significa que este tenant todavía se está
//               leyendo por el método legado (sin resúmenes aún).
//
// COMPATIBILIDAD: el panel viejo espera un ARRAY plano. Si llega
// ?formato=array se responde el array para no romper nada
// mientras se actualiza el frontend (archivo 4 de la ronda).
// ============================================================
router.get('/chats', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const limite = Math.min(parseInt(req.query.limit) || 25, 100);
    const desdeMs = req.query.desdeMs ? Number(req.query.desdeMs) : null;
    const filtro = req.query.filtro || 'todos';

    const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
    const silenciados = (cfgDoc.exists && cfgDoc.data().chatsSilenciados) || {};

    // ── Ruta nueva: resúmenes desnormalizados ──
    const resultado = await annyService.listarChats(adminId, { limit: limite, desdeMs });

    let chats = resultado.chats.map(c => ({
      telefono: c.telefono,
      nombreCliente: c.nombreCliente || null,
      ultimoTexto: c.ultimoTexto || '',
      ultimaFechaMs: c.ultimaFechaMs || 0,
      mensajes: c.totalMensajes || 0,
      escalado: c.escalado === true,
      silenciado: silenciados[c.telefono] === true
    }));

    let migrado = true;

    // ── Fallback legado: tenant sin resúmenes todavía ──
    // Solo en la PRIMERA página (sin cursor). Se conserva el
    // comportamiento anterior para no dejar a nadie sin lista.
    if (chats.length === 0 && !desdeMs) {
      migrado = false;
      const snap = await db.collection('conversacionesAnny')
        .doc(adminId)
        .collection('conversaciones')
        .limit(500)
        .get();

      const docs = snap.docs
        .map(d => d.data())
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

      const mapa = new Map();
      for (const c of docs) {
        if (!c.telefono) continue;
        if (!mapa.has(c.telefono)) {
          mapa.set(c.telefono, {
            telefono: c.telefono,
            nombreCliente: c.nombreCliente || null,
            ultimoTexto: c.mensajeCliente || c.respuestaAgente || '',
            ultimaFechaMs: (c.createdAt?.seconds || 0) * 1000,
            mensajes: 0,
            escalado: false,
            silenciado: silenciados[c.telefono] === true
          });
        }
        const chat = mapa.get(c.telefono);
        chat.mensajes += 1;
        if (!chat.nombreCliente && c.nombreCliente) chat.nombreCliente = c.nombreCliente;
        if (c.escalado) chat.escalado = true;
      }
      chats = Array.from(mapa.values());
    }

    if (filtro === 'escalados') chats = chats.filter(c => c.escalado);

    // Compatibilidad con el panel actual (array plano)
    if (req.query.formato === 'array') return res.json(chats);

    return res.json({
      chats,
      cursor: migrado ? resultado.cursor : null,
      migrado
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4c. GET /api/anny/chats/:telefono — Hilo completo de un cliente
// FIX ANNY-ESCALA-017: antes .limit(200) SIN orderBy devolvía 200
// mensajes ARBITRARIOS del hilo. Ahora se ordena en la consulta.
// ============================================================
router.get('/chats/:telefono', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { telefono } = req.params;
    const limite = Math.min(parseInt(req.query.limit) || 100, 300);

    // ── Ruta nueva: subcolección por chat, orderBy directo
    //    (índice de campo único, sin índices compuestos) ──
    try {
      const snap = await db.collection('chatsAnny')
        .doc(adminId)
        .collection('chats')
        .doc(String(telefono))
        .collection('mensajes')
        .orderBy('fechaMs', 'desc')
        .limit(limite)
        .get();

      if (!snap.empty) {
        const hilo = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
        return res.json(hilo);
      }
    } catch (e) {
      console.error('[ANNY] Hilo v22 falló, uso legado:', e.message);
    }

    // ── Ruta legada (histórico anterior a v22) ──
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
// 4c2. PUT /api/anny/chats/:telefono/silencio — ANNY-SILENCIO-001
// ============================================================
router.put('/chats/:telefono/silencio', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const telefono = String(req.params.telefono).replace(/\D/g, '');
    const { silenciado } = req.body;

    if (!telefono) return res.status(400).json({ error: 'Teléfono inválido' });

    const campo = `chatsSilenciados.${telefono}`;
    await db.collection('annyConfig').doc(adminId).set({}, { merge: true });
    await db.collection('annyConfig').doc(adminId).update({
      [campo]: silenciado === true ? true : admin.firestore.FieldValue.delete()
    });

    baileysService.invalidarCacheSilencio(adminId);

    return res.json({ ok: true, telefono, silenciado: silenciado === true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4c3. PUT /api/anny/chats/:telefono/pausa — ANNY-HUMANO-012
// ------------------------------------------------------------
// Cuando entra un asesor a atender un escalamiento, puede
// extender o levantar la pausa desde el panel.
// Body: { pausar: true|false, minutos?: number }
// ============================================================
router.put('/chats/:telefono/pausa', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const telefono = String(req.params.telefono).replace(/\D/g, '');
    const { pausar, minutos } = req.body || {};

    if (!telefono) return res.status(400).json({ error: 'Teléfono inválido' });

    const resultado = pausar === false
      ? await annyService.reactivarAnny(adminId, telefono)
      : await annyService.pausarAnny(adminId, telefono, Number(minutos) || 30, 'pausa_manual_panel');

    return res.json({ ...resultado, telefono, pausada: pausar !== false });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4d. GET /api/anny/pedidos — Bandeja de pedidos
// ============================================================
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

// ============================================================
// FIX ANNY-BORRADOR-015: ciclo de vida del pedido de Anny
// ------------------------------------------------------------
//   NUEVO  → lo detectó Anny, sin revisar
//   BORRADOR → alguien lo abrió para completarlo
//   EN_REVISION → datos completos, esperando aprobación
//   ORDEN_CREADA → ya se generó la orden de servicio real
//   DESCARTADO → no procede
//
// DECISIÓN DE ARQUITECTURA (importante):
// Anny NO escribe en la colección `orders`. Si lo hiciera, saltaría
// las validaciones, la máquina de 8 estados y la lógica financiera
// de orders.js. En su lugar entrega un PAYLOAD PRE-LLENADO y la
// orden la crea el flujo oficial. Un agente nunca debe poder crear
// registros con impacto en caja sin pasar por el dominio.
// ============================================================
const ESTADOS_PEDIDO = ['NUEVO', 'BORRADOR', 'EN_REVISION', 'ORDEN_CREADA', 'DESCARTADO'];

// 4e. PUT /api/anny/pedidos/:id — Actualizar estado / completar datos
router.put('/pedidos/:id', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { id } = req.params;
    const { estado, notas, datos } = req.body;

    if (estado && !ESTADOS_PEDIDO.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const ref = db.collection('pedidosAnny').doc(adminId).collection('pedidos').doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Pedido no encontrado' });

    const update = {
      gestionadoPor: req.user.nombre || req.user.email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (estado) update.estado = estado;
    if (notas !== undefined) update.notas = notas || '';

    // Completar los datos que Anny dejó como PENDIENTE
    if (datos && typeof datos === 'object') {
      const editables = ['nombreCliente', 'cedulaNit', 'correo', 'direccion', 'barrio', 'sucursal', 'fecha', 'producto', 'cantidad', 'total'];
      const pendientes = new Set(doc.data().datosPendientes || []);
      for (const k of editables) {
        if (datos[k] !== undefined && datos[k] !== null && datos[k] !== '') {
          update[k] = datos[k];
          pendientes.delete(k);
        }
      }
      update.datosPendientes = Array.from(pendientes);
    }

    await ref.update(update);
    return res.json({ ok: true, datosPendientes: update.datosPendientes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// 4e2. GET /api/anny/pedidos/:id/prellenado — ANNY-BORRADOR-015
// Devuelve el pedido normalizado para pre-llenar Nueva Orden.
// No crea nada: solo prepara. Avisa qué falta antes de facturar.
// ------------------------------------------------------------
router.get('/pedidos/:id/prellenado', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const doc = await db.collection('pedidosAnny').doc(adminId).collection('pedidos').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Pedido no encontrado' });

    const p = doc.data();

    // Si el teléfono ya corresponde a un cliente del tenant, se
    // vincula para no crear duplicados (misma regla que comercial).
    const ficha = await annyService.buscarClienteEnBD(adminId, p.telefono);

    const faltantes = [];
    if (!p.nombreCliente || p.nombreCliente === 'PENDIENTE') faltantes.push('nombreCliente');
    if (!p.direccion || p.direccion === 'PENDIENTE') faltantes.push('direccion');
    if (!p.producto) faltantes.push('producto');

    // ✅ ANNY-PREFILL-021: coincidencia del texto del pedido con el catálogo.
    // `p.producto` es TEXTO LIBRE que escribió una IA ("Recarga Extintor ABC 10
    // libras + Domicilio"), no un producto del sistema. Se buscan coincidencias
    // por nombre para pre-cargar los ítems con el PRECIO OFICIAL del catálogo,
    // nunca con el que Anny le dijo al cliente.
    // Si no hay coincidencia, se devuelve vacío y la orden se llena a mano:
    // es preferible eso a colar un precio adivinado en una orden real.
    let itemsSugeridos = [];
    let coincidenciaParcial = false;
    try {
      // Se consulta `products` directamente (y NO obtenerCatalogoProductos,
      // que solo devuelve nombre+precio) porque la orden necesita el
      // productoId real: sin él no hay kardex ni descuento de inventario.
      // ⚠️ products usa `creadoPor` como campo de tenant, NO adminId.
      const prodSnap = await db.collection('products')
        .where('creadoPor', '==', adminId)
        .where('activo', '==', true)
        .limit(300)
        .get();
      const catalogo = prodSnap.docs.map(d => ({
        id: d.id,
        nombre: d.data().nombre || '',
        codigo: d.data().codigo || '',
        categoria: d.data().categoria || '',
        precio: Number(d.data().precioVenta) || 0,
      })).filter(p => p.nombre);

      const norm = (s) => String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const textoPedido = norm(p.producto);
      if (textoPedido) {
        // Se prefiere el nombre más largo que aparezca dentro del texto: evita
        // que "Extintor" gane sobre "Extintor ABC 10 libras".
        const encontrados = (catalogo || [])
          .filter(prod => {
            const n = norm(prod.nombre);
            return n.length >= 4 && textoPedido.includes(n);
          })
          .sort((a, b) => norm(b.nombre).length - norm(a.nombre).length);

        // Se descartan los que son subcadena de otro ya elegido (Extintor vs
        // Extintor ABC 10 libras): quedaría el producto duplicado en la orden.
        const elegidos = [];
        for (const prod of encontrados) {
          const n = norm(prod.nombre);
          if (elegidos.some(e => norm(e.nombre).includes(n))) continue;
          elegidos.push(prod);
        }

        // Se devuelve el producto COMPLETO para que el frontend lo agregue con
        // la misma función que el flujo manual (agregarProducto), y no con un
        // ítem armado a mano que se saltaría las reglas de esCambio/categoría.
        itemsSugeridos = elegidos.slice(0, 6).map(prod => ({
          id: prod.id,
          nombre: prod.nombre,
          codigo: prod.codigo,
          categoria: prod.categoria,
          precioVenta: prod.precio,
        }));

        // Si el total que Anny acordó no coincide con el catálogo, se avisa:
        // puede haber domicilio, descuento o un precio mal informado.
        const totalPedido = Number(String(p.total || '').replace(/[^\d]/g, '')) || 0;
        const cant = Number(p.cantidad) || 1;
        const sumaItems = itemsSugeridos.reduce((a, i) => a + i.precioVenta * cant, 0);
        coincidenciaParcial = itemsSugeridos.length > 0 && totalPedido > 0 && sumaItems !== totalPedido;
      }
    } catch (e) {
      console.warn('[ANNY-PREFILL-021] coincidencia de catálogo falló:', e.message);
      itemsSugeridos = [];
    }

    return res.json({
      pedidoId: doc.id,
      estado: p.estado || 'NUEVO',
      clienteExistente: ficha.existe ? { id: ficha.id, nombre: ficha.nombre, nit: ficha.nit } : null,
      prellenado: {
        clienteId: ficha.existe ? ficha.id : null,
        nombreCliente: p.nombreCliente || ficha.nombre || '',
        cedulaNit: p.cedulaNit && p.cedulaNit !== 'PENDIENTE' ? p.cedulaNit : (ficha.nit || ''),
        correo: p.correo && p.correo !== 'PENDIENTE' ? p.correo : (ficha.correo || ''),
        telefono: p.telefono || '',
        direccion: p.direccion || ficha.direccion || '',
        barrio: p.barrio || '',
        sucursal: p.sucursal || '',
        producto: p.producto || '',
        cantidad: Number(p.cantidad) || 1,
        total: p.total || '',
        fecha: p.fecha && p.fecha !== 'PENDIENTE' ? p.fecha : '',
        origen: 'ANNY',
        // ✅ ANNY-PREFILL-021
        empresaId: ficha.existe ? (ficha.empresaId || '') : '',
        itemsSugeridos,
        coincidenciaParcial,
      },
      datosPendientes: p.datosPendientes || [],
      bloqueantes: faltantes,
      listoParaOrden: faltantes.length === 0
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// 4e3. POST /api/anny/pedidos/:id/vincular-orden — ANNY-BORRADOR-015
// Se llama DESPUÉS de que el flujo oficial creó la orden, para
// cerrar el pedido y dejar trazabilidad. Body: { ordenId }
// ------------------------------------------------------------
router.post('/pedidos/:id/vincular-orden', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { ordenId } = req.body || {};
    if (!ordenId) return res.status(400).json({ error: 'Falta ordenId' });

    // ANNY-IDEM-016: propiedad verificada antes de escribir
    const ordenDoc = await db.collection('orders').doc(String(ordenId)).get();
    if (!ordenDoc.exists || ordenDoc.data().adminId !== adminId) {
      return res.status(403).json({ error: 'La orden no pertenece a tu cuenta' });
    }

    const ref = db.collection('pedidosAnny').doc(adminId).collection('pedidos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (doc.data().estado === 'ORDEN_CREADA') {
      return res.json({ ok: true, yaVinculado: true, ordenId: doc.data().ordenId });
    }

    await ref.update({
      estado: 'ORDEN_CREADA',
      ordenId: String(ordenId),
      gestionadoPor: req.user.nombre || req.user.email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, ordenId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4f. POST /api/anny/vencimientos/ronda — Disparar ronda AHORA
// ============================================================
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
// FIX ANNY-CASO-002
// ============================================================
router.put('/casos/:caseId', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { caseId } = req.params;
    const { estado, respuestaAdmin, notas } = req.body;

    const update = {
      estado: estado || 'RESUELTO',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (respuestaAdmin !== undefined) update.respuestaAdmin = respuestaAdmin;
    if (notas !== undefined) update.notas = notas;

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
// FIX ANNY-BREV-011: se avisa (sin bloquear) cuando la entrada
// trae formato de folleto o precios. Los precios deben vivir en
// el catálogo, no en la base de conocimiento: dos fuentes de
// verdad garantizan contradicciones al actualizar tarifas.
// ============================================================
// ------------------------------------------------------------
// ✅ ANNY-CONSUMO-026: GET /api/anny/consumo
// Cuánto ha consumido ESTE suscriptor en el mes: mensajes atendidos,
// fotos, audios y costo real. Es la base para facturarle el módulo.
// ------------------------------------------------------------
router.get('/consumo', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const [consumo, limites] = await Promise.all([
      annyConsumo.obtenerConsumo(adminId, req.query.periodo),
      annyConsumo.obtenerLimites(adminId),
    ]);
    return res.json({
      ...consumo,
      limites,
      // Costo por mensaje: sirve para fijar la tarifa con criterio
      costoPorMensajeUSD: consumo.mensajes > 0
        ? Number((consumo.costoUSD / consumo.mensajes).toFixed(6))
        : 0,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// ✅ ANNY-CONSUMO-026: GET /api/anny/superadmin/consumo/:adminIdDestino
// El consumo de CUALQUIER suscriptor — es lo que Sandra necesita para
// facturarles. Mismo patrón que /llamadas-ia/superadmin/config/:adminId.
// NO lleva requireAnnyActivo: el SuperAdmin debe poder consultarlo
// aunque su propio tenant no tenga el módulo.
// ------------------------------------------------------------
router.get('/superadmin/consumo/:adminIdDestino', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid || req.user.id;
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists || !userDoc.data().superAdmin) {
      return res.status(403).json({ error: 'Solo el SuperAdmin' });
    }

    const destino = req.params.adminIdDestino;
    const periodo = req.query.periodo || annyConsumo.periodoActual();

    // Mes actual + los 5 anteriores: sirve para ver la tendencia antes de
    // fijarle una tarifa al suscriptor.
    const periodos = [];
    const [y, m] = periodo.split('-').map(Number);
    for (let i = 0; i < 6; i++) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      periodos.push(d.toISOString().slice(0, 7));
    }

    const [historial, limites] = await Promise.all([
      Promise.all(periodos.map(p => annyConsumo.obtenerConsumo(destino, p))),
      annyConsumo.obtenerLimites(destino),
    ]);

    const actual = historial[0];
    return res.json({
      adminId: destino,
      actual,
      historial,
      limites,
      costoPorMensajeUSD: actual.mensajes > 0
        ? Number((actual.costoUSD / actual.mensajes).toFixed(6))
        : 0,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// ✅ ANNY-CONSUMO-026: PUT /api/anny/limites — SOLO SuperAdmin
// Los topes son comerciales (definen el plan que Sandra vende), así
// que el suscriptor NO puede subírselos a sí mismo.
// ------------------------------------------------------------
router.put('/limites/:adminIdDestino', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid || req.user.id;
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists || !userDoc.data().superAdmin) {
      return res.status(403).json({ error: 'Solo el SuperAdmin puede cambiar los topes' });
    }

    const { mensajesMes, imagenesMes, audiosMes, analizarImagenes, analizarAudios } = req.body || {};
    const limites = {};
    if (mensajesMes !== undefined) limites.mensajesMes = Math.max(0, Number(mensajesMes) || 0);
    if (imagenesMes !== undefined) limites.imagenesMes = Math.max(0, Number(imagenesMes) || 0);
    if (audiosMes !== undefined)   limites.audiosMes   = Math.max(0, Number(audiosMes) || 0);
    if (analizarImagenes !== undefined) limites.analizarImagenes = !!analizarImagenes;
    if (analizarAudios !== undefined)   limites.analizarAudios   = !!analizarAudios;

    await db.collection('annyConfig').doc(req.params.adminIdDestino)
      .set({ limites }, { merge: true });

    return res.json({ ok: true, limites });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// ✅ ANNY-KB-022: POST /api/anny/respuestas/sugerir
// Devuelve una versión reescrita de la entrada. NO guarda nada:
// la suscriptora lee la propuesta, la edita si quiere y decide.
// El auditor dice qué está mal; esto dice cómo se escribe bien.
// ------------------------------------------------------------
router.post('/respuestas/sugerir', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { key, patrones, respuesta } = req.body || {};
    if (!respuesta || String(respuesta).trim().length < 10) {
      return res.status(400).json({ error: 'Escribe primero la respuesta que quieres mejorar' });
    }
    const sugerencia = await annyService.sugerirRespuestaEntrenamiento(adminId, {
      key: key || '',
      patrones: Array.isArray(patrones) ? patrones : [],
      respuesta: String(respuesta),
    });
    return res.json(sugerencia);
  } catch (err) {
    console.error('[ANNY-KB-022] sugerencia falló:', err.message);
    return res.status(500).json({ error: 'No se pudo generar la sugerencia. Intenta de nuevo.' });
  }
});

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

    const avisos = [];
    if (/\$\s?\d|\d{4,}\s?(pesos|cop)/i.test(respuesta)) {
      avisos.push('Esta respuesta contiene precios. Los precios deberían salir del catálogo de productos, no de aquí: si suben las tarifas, esta entrada quedará desactualizada sin que nadie lo note.');
    }
    if (/[✓✅•·]|^\s*[-*]\s/m.test(respuesta) || /^[A-ZÁÉÍÓÚÑ ]{4,}:/m.test(respuesta)) {
      avisos.push('Esta respuesta tiene formato de folleto (viñetas o títulos en mayúscula). Anny la va a convertir a prosa al enviarla; mejor escríbela directamente en 2 o 3 líneas.');
    }
    if (patronesLimpios.some(p => p.length <= 3)) {
      avisos.push('Hay palabras clave muy cortas: hacen match con casi cualquier mensaje y se cruzan con otras entradas. Usa frases completas.');
    }

    // ✅ ANNY-FUGA-035: aquí estaba la contaminación PERSISTENTE. Al guardar
    // su PRIMERA entrada de entrenamiento, el suscriptor se llevaba copiadas
    // a su propio documento las RESPUESTAS_BASE del código — con precios y
    // dirección de otra empresa. Nunca más: se arranca de un objeto vacío.
    const doc = await db.collection('respuestasAnny').doc(adminId).get();
    const respuestas = doc.exists ? (doc.data() || {}) : {};

    respuestas[key] = {
      patrones: patronesLimpios,
      respuesta,
      tipo: tipo || 'CUSTOM'
    };

    await db.collection('respuestasAnny').doc(adminId).set(respuestas);
    annyService.invalidarCacheRespuestas(adminId);

    return res.json({ ok: true, avisos });
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
    // ✅ ANNY-FUGA-035: idem — borrar una entrada no puede sembrar la base
    // de otra empresa en el documento del suscriptor.
    const respuestas = doc.exists ? (doc.data() || {}) : {};

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
// FIX ANNY-MISION-014: permite probar cualquier misión sin
// esperar al cron (COBRANZA, NOTIFICACION_TALLER, etc.)
// ============================================================
router.post('/test', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { telefono, mensaje, nombreCliente = 'Cliente Test', mision = 'ATENCION' } = req.body;

    if (!telefono || !mensaje) {
      return res.status(400).json({ error: 'Falta telefono o mensaje' });
    }
    if (!Object.keys(annyService.MISIONES).includes(String(mision).toUpperCase())) {
      return res.status(400).json({ error: 'Misión inválida', disponibles: Object.keys(annyService.MISIONES) });
    }

    const resultado = await annyService.procesarMensajeEntrante({
      adminId,
      telefono,
      nombreCliente,
      mensajeTexto: mensaje,
      mision: String(mision).toUpperCase()
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

// ============================================================
// ✅ ANNY-GRUPO-051 — GET /api/anny/grupos
// Lista los grupos de WhatsApp donde está el número conectado,
// para elegir el grupo de avisos desde el panel sin copiar jids.
// ============================================================
router.get('/grupos', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const grupos = await baileysService.listarGrupos(adminId);
    return res.json({ grupos });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ✅ ANNY-DICC-049 — DICCIONARIO DE PALABRAS CLAVE
// ------------------------------------------------------------
// Mapea cómo habla el CLIENTE con lo que dice el CATÁLOGO.
// Guarda solo la referencia al producto, NUNCA el precio: el
// precio se lee vivo del catálogo en cada mensaje. Así una
// actualización de tarifas no obliga a tocar el diccionario.
// ============================================================

// GET — diccionario + catálogo activo para poblar el selector
router.get('/diccionario', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const [diccionario, catalogo] = await Promise.all([
      annyService.obtenerDiccionarioTenant(adminId),
      annyService.obtenerCatalogoProductos(adminId)
    ]);

    // Marca las entradas cuyo producto ya no está activo: son las
    // que harían que Anny no encuentre precio y termine escalando.
    const idsActivos = new Set(catalogo.map(p => p.id));
    const entradas = Object.entries(diccionario || {}).map(([productoId, e]) => ({
      productoId,
      nombre: e.nombre || '(producto sin nombre)',
      palabras: Array.isArray(e.palabras) ? e.palabras : [],
      huerfana: !idsActivos.has(productoId)
    })).sort((a, b) => a.nombre.localeCompare(b.nombre));

    return res.json({ entradas, catalogo });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT — crear o reemplazar las palabras de UN producto
router.put('/diccionario/:productoId', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { productoId } = req.params;
    const { palabras } = req.body || {};

    if (!Array.isArray(palabras)) {
      return res.status(400).json({ error: 'palabras debe ser un arreglo' });
    }

    // El producto debe existir y estar activo en el catálogo del
    // PROPIO tenant: así el diccionario no puede apuntar a nada ajeno.
    const catalogo = await annyService.obtenerCatalogoProductos(adminId);
    const prod = catalogo.find(p => p.id === productoId);
    if (!prod) {
      return res.status(404).json({ error: 'El producto no existe o no está activo en tu catálogo' });
    }

    const avisos = [];
    const limpias = [...new Set(
      palabras
        .map(p => String(p || '').trim().toLowerCase())
        .filter(Boolean)
    )];

    const utiles = limpias.filter(p => p.length >= 4);
    limpias.filter(p => p.length < 4).forEach(p =>
      avisos.push(`"${p}" es demasiado corta: haría match con casi cualquier mensaje. Se descartó.`)
    );

    if (!utiles.length) {
      return res.status(400).json({ error: 'Ninguna palabra clave es utilizable (mínimo 4 caracteres)', avisos });
    }

    const docRef = db.collection('diccionarioAnny').doc(adminId);
    const doc = await docRef.get();
    const dicc = doc.exists ? (doc.data() || {}) : {};

    // Aviso de colisión: la misma palabra en dos productos hace que
    // Anny tenga que elegir. Gana la más específica, pero conviene saberlo.
    for (const [otroId, otra] of Object.entries(dicc)) {
      if (otroId === productoId || !otra || !Array.isArray(otra.palabras)) continue;
      const repetidas = utiles.filter(p => otra.palabras.includes(p));
      if (repetidas.length) {
        avisos.push(`"${repetidas.join('", "')}" ya está en "${otra.nombre}". Anny elegirá la palabra clave más específica.`);
      }
    }

    dicc[productoId] = { nombre: prod.nombre, palabras: utiles.slice(0, 20) };
    await docRef.set(dicc);
    annyService.invalidarCacheDiccionario(adminId);

    return res.json({ ok: true, productoId, nombre: prod.nombre, palabras: dicc[productoId].palabras, avisos });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE — quitar un producto del diccionario
router.delete('/diccionario/:productoId', authenticate, requireAnnyActivo, requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const docRef = db.collection('diccionarioAnny').doc(adminId);
    const doc = await docRef.get();
    const dicc = doc.exists ? (doc.data() || {}) : {};

    if (!dicc[req.params.productoId]) {
      return res.status(404).json({ error: 'Esa entrada no existe en el diccionario' });
    }

    delete dicc[req.params.productoId];
    await docRef.set(dicc);
    annyService.invalidarCacheDiccionario(adminId);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /diccionario/probar — banco de pruebas: escribe una frase de
// cliente y mira qué resolvería Anny. Evita cargar el diccionario a ciegas.
router.post('/diccionario/probar', authenticate, requireAnnyActivo, async (req, res) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    const { frase } = req.body || {};
    if (!frase) return res.status(400).json({ error: 'Escribe una frase de prueba' });

    const [diccionario, catalogo] = await Promise.all([
      annyService.obtenerDiccionarioTenant(adminId),
      annyService.obtenerCatalogoProductos(adminId)
    ]);

    const resueltos = annyService.resolverPorPalabrasClave(frase, diccionario, catalogo);
    return res.json({ frase, resueltos, encontrado: resueltos.length > 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// FIN anny.js (v22)
