const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

// ─────────────────────────────────────────────────────────────────────────────
// PANEL MAESTRO DE SUSCRIPTORES — solo super-admin (Milena)
//
// Bloque C · Iteración 1: ver y administrar suscriptores. Sin bloqueo de
// acceso todavía (eso es la iteración 2, cuando este panel esté probado).
//
// Seguridad:
//   - La marca `superAdmin: true` vive SOLO en el documento Firestore del
//     usuario de Milena (colección `users`). NO viaja en el JWT.
//   - El middleware `soloSuperAdmin` lee Firestore en cada petición, por lo
//     que este módulo es seguro sin modificar auth.js. Quitar la marca en
//     Firestore revoca el acceso de inmediato.
//
// Nueva colección: `suscripciones` — un doc por suscriptor, ID = adminId.
//   { plan, estado, fechaInicio, fechaVencimiento, notas,
//     actualizadoEn, actualizadoPor }
//
// Convención existente que se respeta SIEMPRE:
//   users.modulos === []  →  el usuario ve TODOS los módulos.
// ─────────────────────────────────────────────────────────────────────────────

// ─── CATÁLOGO DE PLANES (precios COP/mes) ────────────────────────────────────
const PLANES = {
  punto_venta:   { nombre: 'Punto de Venta', precio: 50000 },
  independiente: { nombre: 'Independiente',  precio: 75000 },
  empresa:       { nombre: 'Empresa',        precio: 100000 },
  super_pro:     { nombre: 'Super Pro',      precio: 200000 } // Solo por invitación — nunca aparece en la landing
};

// ─── MÓDULOS POR PLAN (tabla validada Jun 2026) ───────────────────────────────
const MODULOS_POR_PLAN = {
  punto_venta: [
    'dashboard','clientes','ordenes','cotizaciones','productos',
    'caja','egresos','proveedores','mi_empresa'
  ],
  independiente: [
    'dashboard','clientes','ordenes','cotizaciones','productos',
    'caja','egresos','proveedores','mi_empresa',
    'cxc','cxp','usuarios'
  ],
  empresa: [
    'dashboard','clientes','ordenes','cotizaciones','productos',
    'caja','egresos','proveedores','mi_empresa',
    'cxc','cxp','usuarios','reportes',
    'logistica','taller','compras','eri',
    'comercial','vencimientos'
  ],
  super_pro: [] // [] = todos los módulos incluido qr, whatsapp, ia_whatsapp
};

// ✅ FIX CAPACIDAD-TENANT-001: al cambiar los módulos de un suscriptor hay que
// invalidar su caché de capacidades para que el nuevo flujo aplique de
// inmediato y no haya que esperar el TTL de 60s.
const { invalidarCapacidades } = require('../services/capacidadesTenant');

const ESTADOS = ['trial', 'activo', 'suspendido'];
// ✅ SUSCRIPCION-BLOQUEO-001
const suscripcionEstado = require('../services/suscripcionEstado');

// ─── MIDDLEWARE: verificar token (mismo patrón del resto del sistema) ────────
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'control360secret');
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// ─── MIDDLEWARE: solo super-admin (lee la marca en Firestore, no en el JWT) ──
const soloSuperAdmin = async (req, res, next) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists || doc.data().superAdmin !== true) {
      return res.status(403).json({ error: 'Acceso restringido' });
    }
    req.superAdminNombre = doc.data().nombre || doc.data().email || 'SuperAdmin';
    next();
  } catch (err) {
    console.error('soloSuperAdmin:', err);
    res.status(500).json({ error: 'Error verificando permisos' });
  }
};

// ─── HELPER: auditoría (mismo formato de audit_logs del sistema) ─────────────
const registrarAuditoria = async ({ accion, descripcion, usuarioId, usuarioNombre, documento = null, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion,
      modulo: 'panel_suscriptores',
      descripcion,
      usuarioId,
      usuarioNombre,
      documento,
      datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error auditoría superadmin:', err);
  }
};

// ─── HELPER: días restantes hasta el vencimiento (hora Colombia) ─────────────
const diasRestantes = (fechaVencimiento) => {
  if (!fechaVencimiento) return null;
  // El vencimiento es inclusivo: vence al final del día en Colombia (UTC-5).
  const fin = new Date(`${String(fechaVencimiento).slice(0, 10)}T23:59:59.999-05:00`);
  return Math.ceil((fin - new Date()) / (1000 * 60 * 60 * 24));
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/verificar — ¿el usuario logueado es super-admin?
// El frontend lo usa como portero del panel. Responde 403 si no lo es.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/verificar', authenticate, soloSuperAdmin, (req, res) => {
  res.json({ superAdmin: true, nombre: req.superAdminNombre, planes: PLANES });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/suscriptores — Lista completa de suscriptores
//
// Un suscriptor = todo usuario con role 'admin'. Se cruza con la colección
// `suscripciones` (puede no existir aún para los antiguos → plan "sin asignar")
// y se cuentan sus sub-usuarios (creadoPor == adminId).
//
// Nota: se lee la colección users completa UNA vez y se agrupa en memoria —
// evita índices compuestos y N consultas; el volumen actual lo permite de sobra.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/suscriptores', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const [usersSnap, susSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('suscripciones').get()
    ]);

    // Mapa de suscripciones por adminId
    const suscripciones = {};
    susSnap.forEach(d => { suscripciones[d.id] = d.data(); });

    // ✅ SUSCRIPTORES-LISTA-002: un suscriptor es el PROPIETARIO de su tenant.
    // Un segundo administrador creado por un suscriptor (MULTIADMIN-001) tiene
    // role 'admin' pero pertenece a otro tenant: no paga, no se lista aquí.
    // Discriminante (ver MULTIADMIN-001-b): esPropietario === false, o adminId
    // apuntando a otro id → sub-usuario. Los eliminados tampoco se listan.
    const esPropietario = (id, u) => {
      if (u.eliminado === true) return false;
      if (u.esPropietario === true) return true;
      if (u.esPropietario === false) return false;
      return !u.adminId || u.adminId === id; // regla legacy para docs sin marca
    };

    // Conteo de sub-usuarios por tenant real (adminId manda sobre creadoPor)
    const subUsuarios = {};
    usersSnap.forEach(d => {
      const u = d.data();
      if (u.eliminado === true) return;
      const tenant = (u.adminId && u.adminId !== d.id) ? u.adminId : (u.esPropietario === false ? u.creadoPor : null);
      if (tenant) subUsuarios[tenant] = (subUsuarios[tenant] || 0) + 1;
    });

    const lista = [];
    usersSnap.forEach(d => {
      const u = d.data();
      if (u.role !== 'admin') return;
      if (!esPropietario(d.id, u)) return;

      const sus = suscripciones[d.id] || null;
      lista.push({
        adminId: d.id,
        nombre: u.nombre || '',
        email: u.email || '',
        empresa: u.empresa || u.nombreEmpresa || '',
        activo: u.activo !== false,
        superAdmin: u.superAdmin === true,
        modulos: u.modulos || [],          // [] = todos los módulos
        subUsuarios: subUsuarios[d.id] || 0,
        // Datos de suscripción (null si nunca se le ha asignado plan)
        plan: sus?.plan || null,
        planNombre: sus?.plan ? (PLANES[sus.plan]?.nombre || sus.plan) : null,
        estado: sus?.estado || null,
        // ✅ SUSCRIPCION-BLOQUEO-001: lo que el sistema está aplicando de verdad
        estadoCalculado: suscripcionEstado.evaluarSuscripcion(sus || null).estado,
        bloqueada: suscripcionEstado.evaluarSuscripcion(sus || null).bloqueada,
        diasGracia: sus?.diasGracia ?? suscripcionEstado.DIAS_GRACIA_DEFAULT,
        graciaHasta: sus?.graciaHasta || null,
        ultimoPago: sus?.ultimoPago || null,
        fechaInicio: sus?.fechaInicio || null,
        fechaVencimiento: sus?.fechaVencimiento || null,
        diasRestantes: diasRestantes(sus?.fechaVencimiento),
        notas: sus?.notas || ''
      });
    });

    // Orden: sin plan primero (requieren acción), luego por días restantes.
    lista.sort((a, b) => {
      if (!a.plan && b.plan) return -1;
      if (a.plan && !b.plan) return 1;
      return (a.diasRestantes ?? 9999) - (b.diasRestantes ?? 9999);
    });

    res.json({ suscriptores: lista, planes: PLANES });
  } catch (err) {
    console.error('GET suscriptores:', err);
    res.status(500).json({ error: 'Error al listar suscriptores' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/superadmin/suscriptores/:adminId/plan
// Asigna o edita la suscripción: plan, estado, fechas, notas.
// Crea el documento si no existe (backfill de los suscriptores antiguos).
// v1: cambiar a "suspendido" es informativo — NO bloquea el login todavía.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/suscriptores/:adminId/plan', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const { plan, estado, fechaInicio, fechaVencimiento, notas } = req.body;

    if (!PLANES[plan]) {
      return res.status(400).json({ error: `Plan inválido. Opciones: ${Object.keys(PLANES).join(', ')}` });
    }
    if (!ESTADOS.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido. Opciones: ${ESTADOS.join(', ')}` });
    }
    if (!fechaVencimiento) {
      return res.status(400).json({ error: 'La fecha de vencimiento es obligatoria' });
    }

    // El suscriptor debe existir y ser admin
    const userDoc = await db.collection('users').doc(adminId).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(404).json({ error: 'Suscriptor no encontrado' });
    }

    const anterior = (await db.collection('suscripciones').doc(adminId).get()).data() || null;

    // ✅ FIX USUARIOS-001 (2026-06-30): al asignar plan por PRIMERA VEZ a un
    // suscriptor que aún no tiene módulos restringidos (modulos vacío =
    // "ve todo", convención existente del sistema), se auto-pobla su
    // catálogo de módulos según el plan elegido. Evita que un suscriptor
    // quede con acceso a TODO — incluido QR — mientras nadie use el botón
    // "Módulos" por separado. Si ya tiene módulos personalizados (editados
    // por ti vía "Módulos"), esto NO los toca.
    let modulosAutoAsignados = null;
    const modulosActuales = userDoc.data().modulos || [];
    if (!anterior && modulosActuales.length === 0) {
      modulosAutoAsignados = MODULOS_POR_PLAN[plan] || [];
      await userDoc.ref.update({ modulos: modulosAutoAsignados });
      // ✅ FIX CAPACIDAD-TENANT-001
      invalidarCapacidades(adminId);
    }

    const datos = {
      plan,
      estado,
      fechaInicio: fechaInicio || anterior?.fechaInicio || new Date().toISOString().slice(0, 10),
      fechaVencimiento: String(fechaVencimiento).slice(0, 10),
      notas: notas || '',
      actualizadoEn: new Date().toISOString(),
      actualizadoPor: req.superAdminNombre
    };

    await db.collection('suscripciones').doc(adminId).set(datos, { merge: true });
    suscripcionEstado.invalidarCacheSuscripcion(adminId); // ✅ SUSCRIPCION-BLOQUEO-001

    await registrarAuditoria({
      accion: anterior ? 'editar_suscripcion' : 'crear_suscripcion',
      descripcion: `Suscripción de ${userDoc.data().nombre || userDoc.data().email}: plan ${PLANES[plan].nombre}, estado ${estado}, vence ${datos.fechaVencimiento}`
        + (modulosAutoAsignados ? ` — módulos auto-asignados: [${modulosAutoAsignados.join(', ') || 'ninguno'}]` : ''),
      usuarioId: req.user.uid,
      usuarioNombre: req.superAdminNombre,
      documento: adminId,
      datos: { anterior, nuevo: datos, modulosAutoAsignados }
    });

    res.json({
      success: true,
      suscripcion: datos,
      diasRestantes: diasRestantes(datos.fechaVencimiento),
      modulosAutoAsignados
    });
  } catch (err) {
    console.error('PUT plan:', err);
    res.status(500).json({ error: 'Error al guardar la suscripción' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/superadmin/suscriptores/:adminId/modulos
// Edita los módulos activos del admin del tenant (el switch de QR/IA que
// antes se hacía a mano en la consola de Firebase).
//
// Reglas:
//   - body: { modulos: [...] } — array de claves en minúscula.
//   - [] significa TODOS los módulos (convención existente del sistema).
//   - Solo afecta al usuario admin; los sub-usuarios se gestionan dentro
//     del propio tenant como siempre.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/suscriptores/:adminId/modulos', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const { modulos } = req.body;

    if (!Array.isArray(modulos)) {
      return res.status(400).json({ error: 'modulos debe ser un array (vacío = todos los módulos)' });
    }
    const limpios = [...new Set(
      modulos.map(m => String(m).toLowerCase().trim()).filter(Boolean)
    )];

    const userRef = db.collection('users').doc(adminId);
    const userDoc = await userRef.get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(404).json({ error: 'Suscriptor no encontrado' });
    }

    const anteriores = userDoc.data().modulos || [];
    await userRef.update({ modulos: limpios });

    // ✅ FIX CAPACIDAD-TENANT-001: efecto inmediato en la máquina de estados.
    invalidarCapacidades(adminId);

    await registrarAuditoria({
      accion: 'editar_modulos_suscriptor',
      descripcion: `Módulos de ${userDoc.data().nombre || userDoc.data().email}: [${anteriores.join(', ') || 'todos'}] → [${limpios.join(', ') || 'todos'}]`,
      usuarioId: req.user.uid,
      usuarioNombre: req.superAdminNombre,
      documento: adminId,
      datos: { anteriores, nuevos: limpios }
    });

    res.json({ success: true, modulos: limpios });
  } catch (err) {
    console.error('PUT modulos:', err);
    res.status(500).json({ error: 'Error al actualizar módulos' });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// ✅ SUSCRIPCION-BLOQUEO-001 — pago, gracia y suspensión manual
// ─────────────────────────────────────────────────────────────────────────────
// POST /suscriptores/:adminId/pago      { monto, medio, fecha, meses=1, notas }
//   Registra el pago en suscripciones/{id}/pagos, corre el vencimiento
//   `meses` a partir del MAYOR entre hoy y el vencimiento actual (si pagó
//   antes de vencer no pierde días), deja estado 'activo', limpia la gracia
//   extendida y el aviso de suspensión, e invalida el caché → la app del
//   suscriptor se desbloquea en su siguiente clic.
// POST /suscriptores/:adminId/gracia    { dias } → graciaHasta = hoy + dias
// POST /suscriptores/:adminId/suspender { motivo } → estado 'suspendido' ya
// ═════════════════════════════════════════════════════════════════════════════
const sumarMeses = (yyyymmdd, meses) => {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + meses, d));
  // Si el día no existe en el mes destino (31 → feb), Date lo desborda; se corrige al último día.
  if (dt.getUTCMonth() !== ((m - 1 + meses) % 12 + 12) % 12) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
};

router.post('/suscriptores/:adminId/pago', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const { monto, medio = '', fecha, meses = 1, notas = '' } = req.body || {};
    const montoNum = Number(String(monto || '').replace(/[^\d.]/g, ''));
    const mesesNum = Math.min(12, Math.max(1, parseInt(meses, 10) || 1));
    if (!montoNum || montoNum <= 0) return res.status(400).json({ error: 'El monto del pago es obligatorio' });

    const ref = db.collection('suscripciones').doc(adminId);
    const doc = await ref.get();
    const sus = doc.exists ? doc.data() : null;
    if (!sus || !sus.plan) return res.status(400).json({ error: 'Este suscriptor no tiene plan asignado. Asígnale un plan primero.' });

    const hoy = suscripcionEstado.hoyCO();
    const base = (sus.fechaVencimiento && String(sus.fechaVencimiento).slice(0, 10) > hoy) ? String(sus.fechaVencimiento).slice(0, 10) : hoy;
    const nuevoVencimiento = sumarMeses(base, mesesNum);
    const fechaPago = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : hoy;

    const pago = {
      monto: montoNum, medio: String(medio).slice(0, 60), fecha: fechaPago, meses: mesesNum,
      notas: String(notas).slice(0, 300), vencimientoAnterior: sus.fechaVencimiento || null,
      vencimientoNuevo: nuevoVencimiento, registradoPor: req.superAdminNombre,
      registradoEn: new Date().toISOString(), createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await ref.collection('pagos').add(pago);
    await ref.set({
      estado: 'activo',
      fechaVencimiento: nuevoVencimiento,
      graciaHasta: admin.firestore.FieldValue.delete(),
      motivoSuspension: admin.firestore.FieldValue.delete(),
      avisoSuspensionEnviado: admin.firestore.FieldValue.delete(),
      ultimoPago: { monto: montoNum, fecha: fechaPago, medio: pago.medio },
      actualizadoEn: new Date().toISOString(),
      actualizadoPor: req.superAdminNombre
    }, { merge: true });
    suscripcionEstado.invalidarCacheSuscripcion(adminId);

    await registrarAuditoria({
      accion: 'pago_suscripcion',
      descripcion: `Pago de $${montoNum.toLocaleString('es-CO')} (${pago.medio || 'sin medio'}) — vence ahora ${nuevoVencimiento}`,
      usuarioId: req.user.uid, usuarioNombre: req.superAdminNombre, documento: adminId, datos: pago
    });

    res.json({ success: true, fechaVencimiento: nuevoVencimiento, estado: 'activo', diasRestantes: diasRestantes(nuevoVencimiento) });
  } catch (err) {
    console.error('POST pago suscripción:', err);
    res.status(500).json({ error: 'Error al registrar el pago' });
  }
});

router.post('/suscriptores/:adminId/gracia', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const dias = Math.min(30, Math.max(1, parseInt(req.body?.dias, 10) || 0));
    if (!dias) return res.status(400).json({ error: 'Indica los días de gracia (1 a 30)' });
    const ref = db.collection('suscripciones').doc(adminId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Suscripción no encontrada' });
    const hoy = suscripcionEstado.hoyCO();
    const [y, m, d] = hoy.split('-').map(Number);
    const hasta = new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
    const patch = { graciaHasta: hasta, actualizadoEn: new Date().toISOString(), actualizadoPor: req.superAdminNombre };
    // Si estaba suspendida a mano, la gracia la reabre (la suspensión manual manda sobre la fecha).
    if (doc.data().estado === 'suspendido') { patch.estado = 'activo'; patch.motivoSuspension = admin.firestore.FieldValue.delete(); }
    await ref.set(patch, { merge: true });
    suscripcionEstado.invalidarCacheSuscripcion(adminId);
    await registrarAuditoria({ accion: 'gracia_suscripcion', descripcion: `Gracia extendida ${dias} día(s), hasta ${hasta}`, usuarioId: req.user.uid, usuarioNombre: req.superAdminNombre, documento: adminId, datos: { dias, hasta } });
    res.json({ success: true, graciaHasta: hasta });
  } catch (err) {
    console.error('POST gracia:', err);
    res.status(500).json({ error: 'Error al extender la gracia' });
  }
});

router.post('/suscriptores/:adminId/suspender', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const motivo = String(req.body?.motivo || '').trim().slice(0, 200) || 'Suspendida por el administrador de la plataforma';
    const ref = db.collection('suscripciones').doc(adminId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Suscripción no encontrada' });
    const userDoc = await db.collection('users').doc(adminId).get();
    if (userDoc.exists && userDoc.data().superAdmin === true) return res.status(400).json({ error: 'No se puede suspender la cuenta de la plataforma' });
    await ref.set({ estado: 'suspendido', motivoSuspension: motivo, graciaHasta: admin.firestore.FieldValue.delete(), actualizadoEn: new Date().toISOString(), actualizadoPor: req.superAdminNombre }, { merge: true });
    suscripcionEstado.invalidarCacheSuscripcion(adminId);
    await registrarAuditoria({ accion: 'suspender_suscripcion', descripcion: `Suspendida manualmente: ${motivo}`, usuarioId: req.user.uid, usuarioNombre: req.superAdminNombre, documento: adminId, datos: { motivo } });
    res.json({ success: true, estado: 'suspendido' });
  } catch (err) {
    console.error('POST suspender:', err);
    res.status(500).json({ error: 'Error al suspender' });
  }
});

router.get('/suscriptores/:adminId/pagos', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const snap = await db.collection('suscripciones').doc(req.params.adminId).collection('pagos').orderBy('registradoEn', 'desc').limit(24).get();
    res.json({ pagos: snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: undefined })) });
  } catch (err) {
    res.status(500).json({ error: 'Error al leer pagos' });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// ✅ SUSCRIPTOR-ELIMINAR-001 — DELETE /api/superadmin/suscriptores/:adminId
// ─────────────────────────────────────────────────────────────────────────────
// Cierra una cuenta (p. ej. una prueba). Es un BORRADO LÓGICO, no físico:
//   · users/{adminId} y todos sus sub-usuarios → activo:false, eliminado:true,
//     sessionToken borrado (los saca de la app en ese instante)
//   · suscripciones/{adminId} → estado 'cancelado', eliminado:true
//   · desaparece del panel; los datos operativos (órdenes, clientes, caja)
//     NO se borran: anulación sobre eliminación, como el resto del sistema.
// Body: { confirmacion: <email del suscriptor> } — obliga a escribirlo.
// La cuenta de la plataforma (superAdmin) no se puede eliminar.
// ═════════════════════════════════════════════════════════════════════════════
router.delete('/suscriptores/:adminId', authenticate, soloSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;
    const confirmacion = String(req.body?.confirmacion || req.query?.confirmacion || '').trim().toLowerCase();
    const userDoc = await db.collection('users').doc(adminId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'Suscriptor no encontrado' });
    const u = userDoc.data();
    if (u.superAdmin === true) return res.status(400).json({ error: 'No se puede eliminar la cuenta de la plataforma' });
    if (adminId === req.user.uid) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    if (!confirmacion || confirmacion !== String(u.email || '').trim().toLowerCase()) {
      return res.status(400).json({ error: 'Escribe el email del suscriptor exactamente para confirmar' });
    }

    const ahora = new Date().toISOString();
    const marca = { activo: false, eliminado: true, eliminadoEn: ahora, eliminadoPor: req.superAdminNombre, sessionToken: admin.firestore.FieldValue.delete() };

    // Sub-usuarios del tenant (por adminId o creadoPor)
    const [porAdmin, porCreador] = await Promise.all([
      db.collection('users').where('adminId', '==', adminId).get(),
      db.collection('users').where('creadoPor', '==', adminId).get()
    ]);
    const ids = new Set();
    porAdmin.forEach(d => { if (d.id !== adminId) ids.add(d.id); });
    porCreador.forEach(d => { const x = d.data(); if (d.id !== adminId && (!x.adminId || x.adminId === adminId)) ids.add(d.id); });

    const lote = db.batch();
    lote.set(userDoc.ref, marca, { merge: true });
    ids.forEach(id => lote.set(db.collection('users').doc(id), marca, { merge: true }));
    lote.set(db.collection('suscripciones').doc(adminId), { estado: 'cancelado', eliminado: true, eliminadoEn: ahora, actualizadoPor: req.superAdminNombre }, { merge: true });
    await lote.commit();
    suscripcionEstado.invalidarCacheSuscripcion(adminId);

    await registrarAuditoria({
      accion: 'eliminar_suscriptor',
      descripcion: `Cuenta cerrada: ${u.empresa || u.nombre || u.email} (${u.email}) + ${ids.size} sub-usuario(s)`,
      usuarioId: req.user.uid, usuarioNombre: req.superAdminNombre, documento: adminId,
      datos: { email: u.email, subUsuarios: [...ids] }
    });

    res.json({ success: true, subUsuariosDesactivados: ids.size });
  } catch (err) {
    console.error('DELETE suscriptor:', err);
    res.status(500).json({ error: 'Error al eliminar el suscriptor' });
  }
});

module.exports = router;
