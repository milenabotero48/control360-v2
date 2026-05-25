const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

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
const registrarAuditoria = async ({ accion, modulo, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion,
      modulo,
      descripcion,
      usuarioId,
      usuarioNombre,
      datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error auditoría:', err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users — Listar todos los usuarios (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, soloAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('users').orderBy('createdAt', 'desc').get();
    const usuarios = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // No devolver contraseña
      const { password, ...usuarioSeguro } = data;
      usuarios.push({ id: doc.id, ...usuarioSeguro });
    });
    res.json(usuarios);
  } catch (error) {
    console.error('Error listando usuarios:', error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users — Crear usuario nuevo (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, soloAdmin, async (req, res) => {
  try {
    const { nombre, email, codigo, password, role, modulos, activo = true } = req.body;

    // Validaciones básicas
    if (!nombre || !email || !codigo || !password || !role) {
      return res.status(400).json({ error: 'Campos obligatorios: nombre, email, código, contraseña, rol' });
    }

    // Verificar email duplicado
    const emailExiste = await db.collection('users').where('email', '==', email).get();
    if (!emailExiste.empty) {
      return res.status(400).json({ error: 'Ya existe un usuario con ese email' });
    }

    // Verificar código duplicado
    const codigoExiste = await db.collection('users').where('codigo', '==', codigo).get();
    if (!codigoExiste.empty) {
      return res.status(400).json({ error: 'Ya existe un usuario con ese código' });
    }

    // Crear en Firebase Auth
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().createUser({
        email,
        password,
        displayName: nombre
      });
    } catch (authError) {
      return res.status(400).json({ error: `Error Firebase Auth: ${authError.message}` });
    }

    // Módulos por defecto según rol
    const modulosPorRol = {
      admin: ['dashboard', 'usuarios', 'empresas', 'ordenes', 'cotizaciones', 'clientes', 'productos', 'logistica', 'taller', 'qr', 'inventarios', 'egresos', 'caja', 'cxc', 'reportes', 'auditoria'],
      comercial: ['dashboard', 'ordenes', 'cotizaciones', 'clientes', 'productos', 'cxc', 'reportes'],
      mensajero: ['dashboard', 'logistica', 'caja'],
      taller: ['dashboard', 'taller', 'productos', 'reportes'],
      tesoreria: ['dashboard', 'caja', 'egresos', 'cxc', 'reportes'],
      visor: ['dashboard', 'reportes']
    };

    const modulosFinales = modulos && modulos.length > 0 ? modulos : (modulosPorRol[role] || ['dashboard']);

    // Guardar en Firestore
    const nuevoUsuario = {
      uid: firebaseUser.uid,
      nombre,
      email,
      codigo,
      role,
      modulos: modulosFinales,
      activo,
      creadoPor: req.user.uid || req.user.id,
      creadoPorNombre: req.user.nombre || req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(firebaseUser.uid).set(nuevoUsuario);

    // Auditoría
    await registrarAuditoria({
      accion: 'CREAR_USUARIO',
      modulo: 'usuarios',
      descripcion: `Admin creó usuario ${nombre} (${email}) con rol ${role}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { nombre, email, codigo, role, modulos: modulosFinales }
    });

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      usuario: { id: firebaseUser.uid, ...nuevoUsuario }
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
    const { nombre, email, codigo, password, role, modulos, activo } = req.body;

    const userRef = db.collection('users').doc(id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const datosActuales = userDoc.data();
    const cambios = {};

    if (nombre) cambios.nombre = nombre;
    if (role) cambios.role = role;
    if (modulos) cambios.modulos = modulos;
    if (activo !== undefined) cambios.activo = activo;
    cambios.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    // Si cambia email
    if (email && email !== datosActuales.email) {
      const emailExiste = await db.collection('users').where('email', '==', email).get();
      if (!emailExiste.empty && emailExiste.docs[0].id !== id) {
        return res.status(400).json({ error: 'Ya existe un usuario con ese email' });
      }
      await admin.auth().updateUser(id, { email });
      cambios.email = email;
    }

    // Si cambia código
    if (codigo && codigo !== datosActuales.codigo) {
      const codigoExiste = await db.collection('users').where('codigo', '==', codigo).get();
      if (!codigoExiste.empty && codigoExiste.docs[0].id !== id) {
        return res.status(400).json({ error: 'Ya existe un usuario con ese código' });
      }
      cambios.codigo = codigo;
    }

    // Si cambia contraseña
    if (password) {
      await admin.auth().updateUser(id, { password });
    }

    await userRef.update(cambios);

    // Auditoría
    await registrarAuditoria({
      accion: 'EDITAR_USUARIO',
      modulo: 'usuarios',
      descripcion: `Admin editó usuario ${datosActuales.nombre} (${datosActuales.email})`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { id, cambios }
    });

    res.json({ message: 'Usuario actualizado', cambios });

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

    // No permitir eliminar al propio admin
    if (id === (req.user.uid || req.user.id)) {
      return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
    }

    const userRef = db.collection('users').doc(id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const datosUsuario = userDoc.data();

    // Desactivar en Firestore (no eliminar físicamente)
    await userRef.update({
      activo: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Deshabilitar en Firebase Auth
    await admin.auth().updateUser(id, { disabled: true });

    // Auditoría
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/auditoria — Ver log de auditoría (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/auditoria/log', authenticate, soloAdmin, async (req, res) => {
  try {
    const { limite = 50, usuarioId } = req.query;
    let query = db.collection('audit_logs').orderBy('fecha', 'desc').limit(parseInt(limite));

    if (usuarioId) {
      query = db.collection('audit_logs')
        .where('usuarioId', '==', usuarioId)
        .orderBy('fecha', 'desc')
        .limit(parseInt(limite));
    }

    const snapshot = await query.get();
    const logs = [];
    snapshot.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));

    res.json(logs);
  } catch (error) {
    console.error('Error obteniendo auditoría:', error);
    res.status(500).json({ error: 'Error al obtener auditoría' });
  }
});

module.exports = router;
