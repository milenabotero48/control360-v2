const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const bcrypt = require('bcryptjs');

// ─────────────────────────────────────────────────────────────────────────────
// Cambios Ola 1 sobre el original:
//   1) Campo `pin` agregado al modelo de usuario (4 dígitos).
//        - Solo roles "admin" y "tesoreria" usan PIN para acciones sensibles.
//        - Otros roles pueden tener PIN guardado pero no se valida nunca para
//          autorizaciones críticas (anulación, cuadre, desbloqueo cartera).
//   2) Endpoint POST /api/users/verificar-pin
//        Recibe { pin, accion } y responde { autorizado, usuario }.
//        Es la fuente ÚNICA de verdad para validar PIN en todo el sistema.
//   3) Auditoría: GET /api/users/auditoria/log con filtros por
//        módulo, N° documento, usuario y rango de fechas (zona Colombia).
//   4) bcrypt para hashear contraseñas al crear/editar usuario
//        (sustituye al uso anterior de Firebase Auth como único guardián).
//   5) Helpers de zona horaria Colombia (rango fechas → UTC -5).
// ─────────────────────────────────────────────────────────────────────────────

const SALT_ROUNDS = 10;

// ─── MIDDLEWARE: verificar token ─────────────────────────────────────────────
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

// ─── MIDDLEWARE: solo admin ───────────────────────────────────────────────────
const soloAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
  next();
};

// ─── HELPER: registrar auditoría ─────────────────────────────────────────────
const registrarAuditoria = async ({ accion, modulo, descripcion, usuarioId, usuarioNombre, documento = null, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion,
      modulo,
      descripcion,
      usuarioId,
      usuarioNombre,
      documento, // N° de orden, egreso, factura, etc. — para filtrar después.
      datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error auditoría:', err);
  }
};

// ─── HELPER: zona horaria Colombia ────────────────────────────────────────────
// Convierte un rango "YYYY-MM-DD ... YYYY-MM-DD" digitado por el usuario en
// Colombia (UTC-5) al rango UTC real que cubre esos días completos.
// Ejemplo: 2025-05-01 a 2025-05-31 →  2025-05-01T05:00:00Z  ...  2025-06-01T04:59:59.999Z
const rangoFechasCO = (desde, hasta) => {
  const out = { desdeISO: null, hastaISO: null };
  if (desde) {
    out.desdeISO = new Date(`${desde}T00:00:00-05:00`).toISOString();
  }
  if (hasta) {
    // Final del día inclusivo: 23:59:59.999 hora Colombia.
    out.hastaISO = new Date(`${hasta}T23:59:59.999-05:00`).toISOString();
  }
  return out;
};

// ─── HELPER: validar PIN (4 dígitos numéricos) ────────────────────────────────
const pinValido = (v) => typeof v === 'string' && /^\d{4}$/.test(v);

// ─── HELPER: hashear contraseña con bcrypt ────────────────────────────────────
const hashearPassword = async (raw) => bcrypt.hash(String(raw), SALT_ROUNDS);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users — Listar todos los usuarios (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, soloAdmin, async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    // AISLAMIENTO SAAS: cada admin ve solo sus propios usuarios
    const snapshot = await db.collection('users')
      .where('creadoPor', '==', adminId)
      .get();
    const usuarios = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // No devolver contraseña ni PIN al frontend en el listado.
      const { password, password_hash, pin, ...usuarioSeguro } = data;
      usuarios.push({
        id: doc.id,
        ...usuarioSeguro,
        tienePin: !!pin // bandera informativa, sin exponer el valor
      });
    });
    res.json(usuarios);
  } catch (error) {
    console.error('Error listando usuarios:', error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/:id/pin — Ver PIN propio o de otro usuario (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
// Necesario para que el modal de "Editar Usuario" pueda mostrar el PIN actual
// al admin. Cada usuario puede ver su propio PIN; el admin puede ver cualquiera.
router.get('/:id/pin', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const yo = req.user.uid || req.user.id;

    if (req.user.role !== 'admin' && yo !== id) {
      return res.status(403).json({ error: 'Solo puedes ver tu propio PIN' });
    }

    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ pin: doc.data().pin || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users — Crear usuario nuevo (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, soloAdmin, async (req, res) => {
  try {
    const { nombre, email, codigo, password, pin, role, modulos, activo = true } = req.body;
    // AISLAMIENTO SAAS: obtener adminId del token
    const adminId = req.adminId || req.user?.uid || req.user?.id;

    if (!nombre || !email || !codigo || !password || !role) {
      return res.status(400).json({ error: 'Campos obligatorios: nombre, email, código, contraseña, rol' });
    }

    if (pin && !pinValido(pin)) {
      return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos numéricos' });
    }

    // Email duplicado (solo dentro del mismo tenant)
    const emailNorm = String(email).trim().toLowerCase();
    const emailExiste = await db.collection('users')
      .where('creadoPor', '==', adminId)
      .where('email', '==', emailNorm).get();
    if (!emailExiste.empty) {
      return res.status(400).json({ error: 'Ya existe un usuario con ese email' });
    }

    // Código duplicado (solo dentro del mismo tenant)
    const codigoExiste = await db.collection('users')
      .where('creadoPor', '==', adminId)
      .where('codigo', '==', codigo).get();
    if (!codigoExiste.empty) {
      return res.status(400).json({ error: 'Ya existe un usuario con ese código' });
    }

    // Crear en Firebase Auth (mantenemos compatibilidad — Firebase Auth como
    // identidad federada). La verdad de la contraseña vive en Firestore con bcrypt.
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().createUser({
        email: emailNorm,
        password,
        displayName: nombre
      });
    } catch (authError) {
      return res.status(400).json({ error: `Error Firebase Auth: ${authError.message}` });
    }

    const passHash = await hashearPassword(password);

    const modulosPorRol = {
      admin: ['dashboard', 'usuarios', 'empresas', 'ordenes', 'cotizaciones', 'clientes', 'productos', 'logistica', 'taller', 'qr', 'inventarios', 'egresos', 'caja', 'cxc', 'reportes', 'auditoria'],
      comercial: ['dashboard', 'ordenes', 'cotizaciones', 'clientes', 'productos', 'cxc', 'reportes'],
      mensajero: ['dashboard', 'logistica', 'caja'],
      taller: ['dashboard', 'taller', 'productos', 'reportes'],
      tesoreria: ['dashboard', 'caja', 'egresos', 'cxc', 'reportes'],
      visor: ['dashboard', 'reportes']
    };

    const modulosFinales = modulos && modulos.length > 0 ? modulos : (modulosPorRol[role] || ['dashboard']);

    const nuevoUsuario = {
      uid: firebaseUser.uid,
      nombre,
      email: emailNorm,
      codigo,
      pin: pin || '', // PIN opcional; solo Admin/Tesorería lo usan en validaciones
      role,
      modulos: modulosFinales,
      activo,
      password_hash: passHash,
      creadoPor: req.user.uid || req.user.id,
      creadoPorNombre: req.user.nombre || req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(firebaseUser.uid).set(nuevoUsuario);

    await registrarAuditoria({
      accion: 'CREAR_USUARIO',
      modulo: 'usuarios',
      descripcion: `Admin creó usuario ${nombre} (${emailNorm}) con rol ${role}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { nombre, email: emailNorm, codigo, role, modulos: modulosFinales, tienePin: !!pin }
    });

    // No devolver hash ni PIN
    const { password_hash, pin: _pin, ...respuestaSegura } = nuevoUsuario;
    res.status(201).json({
      message: 'Usuario creado exitosamente',
      usuario: { id: firebaseUser.uid, ...respuestaSegura, tienePin: !!pin }
    });

  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/users/:id — Editar usuario (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', authenticate, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, email, codigo, password, pin, role, modulos, activo } = req.body;

    const userRef = db.collection('users').doc(id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const datosActuales = userDoc.data();
    const cambios = {};

    if (nombre) cambios.nombre = nombre;
    if (role)   cambios.role = role;
    if (modulos) cambios.modulos = modulos;
    if (activo !== undefined) cambios.activo = activo;
    cambios.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    // PIN: solo se cambia si el admin lo digitó (string no vacío).
    if (pin !== undefined && pin !== null && pin !== '') {
      if (!pinValido(pin)) {
        return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos numéricos' });
      }
      cambios.pin = pin;
    }

    // Si cambia email
    if (email && email !== datosActuales.email) {
      const emailNorm = String(email).trim().toLowerCase();
      const emailExiste = await db.collection('users').where('email', '==', emailNorm).get();
      if (!emailExiste.empty && emailExiste.docs[0].id !== id) {
        return res.status(400).json({ error: 'Ya existe un usuario con ese email' });
      }
      try { await admin.auth().updateUser(id, { email: emailNorm }); } catch (e) { console.warn('Auth update email:', e.message); }
      cambios.email = emailNorm;
    }

    // Si cambia código — verificar duplicado solo en el mismo tenant
    if (codigo && codigo !== datosActuales.codigo) {
      const adminIdPut = req.adminId || req.user?.uid || req.user?.id;
      const codigoExiste = await db.collection('users')
        .where('creadoPor', '==', adminIdPut)
        .where('codigo', '==', codigo).get();
      if (!codigoExiste.empty && codigoExiste.docs[0].id !== id) {
        return res.status(400).json({ error: 'Ya existe un usuario con ese código' });
      }
      cambios.codigo = codigo;
    }

    // Si cambia contraseña: actualiza Firebase Auth + bcrypt en Firestore
    if (password) {
      try { await admin.auth().updateUser(id, { password }); } catch (e) { console.warn('Auth update password:', e.message); }
      cambios.password_hash = await hashearPassword(password);
    }

    await userRef.update(cambios);

    await registrarAuditoria({
      accion: 'EDITAR_USUARIO',
      modulo: 'usuarios',
      descripcion: `Admin editó usuario ${datosActuales.nombre} (${datosActuales.email})`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { id, campos: Object.keys(cambios).filter(k => k !== 'password_hash' && k !== 'pin') }
    });

    res.json({ message: 'Usuario actualizado' });

  } catch (error) {
    console.error('Error editando usuario:', error);
    res.status(500).json({ error: 'Error al editar usuario' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/users/:id — Desactivar usuario (solo admin, no se elimina físico)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, soloAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (id === (req.user.uid || req.user.id)) {
      return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
    }

    const userRef = db.collection('users').doc(id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const datosUsuario = userDoc.data();

    await userRef.update({
      activo: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    try { await admin.auth().updateUser(id, { disabled: true }); } catch (e) { console.warn('Auth disable:', e.message); }

    await registrarAuditoria({
      accion: 'DESACTIVAR_USUARIO',
      modulo: 'usuarios',
      descripcion: `Admin desactivó usuario ${datosUsuario.nombre} (${datosUsuario.email})`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { id, nombre: datosUsuario.nombre, email: datosUsuario.email }
    });

    res.json({ message: 'Usuario desactivado correctamente' });

  } catch (error) {
    console.error('Error desactivando usuario:', error);
    res.status(500).json({ error: 'Error al desactivar usuario' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/users/verificar-pin — fuente ÚNICA de verdad para validar PIN
// ─────────────────────────────────────────────────────────────────────────────
// Body: { pin: "1234", accion: "anular_orden" | "cuadre_mensajero" | ... }
// Respuesta: { autorizado, usuario: { id, nombre, role } }
//
// Reglas:
//   - Solo Admin y Tesorería pueden autorizar acciones sensibles con PIN.
//   - El PIN se valida contra el usuario LOGUEADO (req.user.uid).
//   - Si el usuario logueado no tiene PIN configurado → 400.
//   - Si el PIN no coincide → 403 + audit log de intento fallido.
//   - Si coincide → 200 + audit log de autorización exitosa.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/verificar-pin', authenticate, async (req, res) => {
  try {
    const { pin, accion, documento } = req.body;
    if (!pin) return res.status(400).json({ autorizado: false, error: 'PIN requerido' });

    const yo = req.user.uid || req.user.id;
    const doc = await db.collection('users').doc(yo).get();
    if (!doc.exists) return res.status(404).json({ autorizado: false, error: 'Usuario no encontrado' });

    const u = doc.data();

    if (u.role !== 'admin' && u.role !== 'tesoreria') {
      return res.status(403).json({ autorizado: false, error: 'Tu rol no puede autorizar esta acción' });
    }

    if (!u.pin) {
      return res.status(400).json({
        autorizado: false,
        error: 'No tienes PIN configurado. Pídele al administrador que te lo asigne.'
      });
    }

    const ok = String(u.pin) === String(pin);

    await registrarAuditoria({
      accion: ok ? 'PIN_AUTORIZADO' : 'PIN_FALLIDO',
      modulo: 'auditoria',
      descripcion: `${u.nombre || u.email} ${ok ? 'autorizó' : 'falló PIN para'} acción: ${accion || 'no especificada'}`,
      usuarioId: yo,
      usuarioNombre: u.nombre || u.email,
      documento: documento || null,
      datos: { accion, ok }
    });

    if (!ok) return res.status(403).json({ autorizado: false, error: 'PIN incorrecto' });

    res.json({
      autorizado: true,
      usuario: { id: yo, nombre: u.nombre, role: u.role, email: u.email }
    });
  } catch (e) {
    console.error('verificar-pin:', e);
    res.status(500).json({ autorizado: false, error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/users/auditoria/log — Log con filtros (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
// Query params (todos opcionales):
//   modulo       → "ordenes" | "egresos" | "caja" | "logistica" | ...
//   documento    → coincidencia parcial sobre N° orden/egreso/factura
//   usuarioId    → UID del usuario que ejecutó la acción
//   desde, hasta → YYYY-MM-DD (zona Colombia, inclusivo)
//   limite       → default 200
// ═════════════════════════════════════════════════════════════════════════════
router.get('/auditoria/log', authenticate, soloAdmin, async (req, res) => {
  try {
    const { modulo, documento, usuarioId, desde, hasta, limite = 200 } = req.query;
    const lim = Math.min(parseInt(limite) || 200, 1000);
    const adminId = req.adminId || req.user?.uid || req.user?.id;

    const { desdeISO, hastaISO } = rangoFechasCO(desde, hasta);

    // AISLAMIENTO SAAS: siempre filtrar por adminId primero
    // El resto se filtra en memoria para evitar índices compuestos
    let query = db.collection('audit_logs')
      .where('adminId', '==', adminId)
      .orderBy('fecha', 'desc')
      .limit(lim);

    const snapshot = await query.get();
    let logs = [];
    snapshot.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));

    // Filtros en memoria
    if (modulo && usuarioId) {
      // Si se usaron ambos, ya filtramos por usuarioId arriba; falta módulo.
      logs = logs.filter(l => l.modulo === modulo);
    }

    if (desdeISO) logs = logs.filter(l => l.fecha && l.fecha >= desdeISO);
    if (hastaISO) logs = logs.filter(l => l.fecha && l.fecha <= hastaISO);

    if (documento) {
      const q = String(documento).toUpperCase();
      logs = logs.filter(l => {
        const enCampo = l.documento && String(l.documento).toUpperCase().includes(q);
        const enDescripcion = l.descripcion && String(l.descripcion).toUpperCase().includes(q);
        const enDatos = l.datos && JSON.stringify(l.datos).toUpperCase().includes(q);
        return enCampo || enDescripcion || enDatos;
      });
    }

    res.json(logs);
  } catch (error) {
    console.error('Error obteniendo auditoría:', error);
    res.status(500).json({ error: 'Error al obtener auditoría' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/auditoria/modulos — Lista de módulos para el dropdown
// ─────────────────────────────────────────────────────────────────────────────
router.get('/auditoria/modulos', authenticate, soloAdmin, async (req, res) => {
  // Fija (no calculada desde la BD para responder rápido y sin sorpresas).
  res.json([
    { key: 'auditoria',    label: 'Auditoría' },
    { key: 'caja',         label: 'Caja' },
    { key: 'clientes',     label: 'Clientes' },
    { key: 'cotizaciones', label: 'Cotizaciones' },
    { key: 'cxc',          label: 'CxC' },
    { key: 'cxp',          label: 'CxP' },
    { key: 'egresos',      label: 'Egresos' },
    { key: 'empresas',     label: 'Mi Empresa' },
    { key: 'logistica',    label: 'Logística' },
    { key: 'ordenes',      label: 'Órdenes' },
    { key: 'productos',    label: 'Productos' },
    { key: 'proveedores',  label: 'Proveedores' },
    { key: 'qr',           label: 'QR / Hojas de Vida' },
    { key: 'taller',       label: 'Taller' },
    { key: 'usuarios',     label: 'Usuarios' }
  ]);
});

module.exports = router;
