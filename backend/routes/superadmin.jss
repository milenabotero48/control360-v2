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

const ESTADOS = ['trial', 'activo', 'suspendido'];

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

    // Conteo de sub-usuarios por tenant
    const subUsuarios = {};
    usersSnap.forEach(d => {
      const u = d.data();
      if (u.creadoPor) subUsuarios[u.creadoPor] = (subUsuarios[u.creadoPor] || 0) + 1;
    });

    const lista = [];
    usersSnap.forEach(d => {
      const u = d.data();
      if (u.role !== 'admin') return;

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

    await registrarAuditoria({
      accion: anterior ? 'editar_suscripcion' : 'crear_suscripcion',
      descripcion: `Suscripción de ${userDoc.data().nombre || userDoc.data().email}: plan ${PLANES[plan].nombre}, estado ${estado}, vence ${datos.fechaVencimiento}`,
      usuarioId: req.user.uid,
      usuarioNombre: req.superAdminNombre,
      documento: adminId,
      datos: { anterior, nuevo: datos }
    });

    res.json({ success: true, suscripcion: datos, diasRestantes: diasRestantes(datos.fechaVencimiento) });
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

module.exports = router;
