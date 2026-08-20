const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const bcrypt = require('bcryptjs');
// FIX PIN-UNICO-001: verificador de PIN compartido. Este endpoint sigue siendo
// la puerta que usa el frontend, pero la LOGICA de validacion vive ahora en
// routes/_autorizacion.js, igual que la que usan orders.js y egresos.js.
const { verificarPin, MATRIZ_ACCIONES } = require('./_autorizacion');

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

// ═════════════════════════════════════════════════════════════════════════════
// ✅ FIX MULTIADMIN-001 (2026-08-20) — PROPIEDAD ≠ ROL
// ─────────────────────────────────────────────────────────────────────────────
//   role          → permisos dentro de la empresa (puede haber N admins)
//   esPropietario → dueño de la suscripción (siempre exactamente 1 por tenant)
//
// Reglas: solo el propietario crea, promueve, degrada o desactiva
// administradores; al propietario nadie lo edita salvo él mismo, nadie lo
// desactiva, y la marca `esPropietario` jamás se acepta desde el body.
// ═════════════════════════════════════════════════════════════════════════════

// Id del tenant (empresa) de quien hace la petición.
// El adminId del JWT es la fuente autorizada porque lo calcula el login con
// resolverTenant(). req.adminId (middleware compartido) queda como respaldo, y
// el uid propio como último recurso para tokens emitidos antes de este cambio.
const tenantDeReq = (req) => req.user?.adminId || req.adminId || req.user?.uid || req.user?.id || null;

const uidDeReq = (req) => req.user?.uid || req.user?.id || null;

// ¿Quien llama es el PROPIETARIO del tenant?
// Se verifica contra Firestore, no contra el JWT: un token viejo o manipulado
// no debe poder otorgar propiedad. Mismo criterio que usa superadmin.js.
const esPropietarioDelTenant = async (req) => {
  const uid = uidDeReq(req);
  if (!uid) return false;
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) return false;
  const u = doc.data();
  if (typeof u.esPropietario === 'boolean') return u.esPropietario === true;
  return u.role === 'admin'; // documento sin migrar → regla legacy
};

// Carga un usuario verificando que pertenece al MISMO tenant de quien llama.
// Antes, PUT / DELETE / GET :id/pin cargaban por id sin verificar la empresa.
// Con un solo admin por tenant el hueco era teórico; con varios administradores
// es un riesgo real de cruce entre suscriptores.
const cargarUsuarioDelTenant = async (id, adminId) => {
  const ref = db.collection('users').doc(id);
  const doc = await ref.get();
  if (!doc.exists) return null;
  const datos = doc.data();
  const tenantDelUsuario = datos.adminId || datos.creadoPor || doc.id;
  if (tenantDelUsuario !== adminId && doc.id !== adminId) return null;
  return { ref, datos, id: doc.id };
};

// ¿Este documento corresponde al propietario del tenant?
const marcaPropietario = (datos, id, adminId) =>
  (typeof datos.esPropietario === 'boolean' ? datos.esPropietario === true : id === adminId);

// ═════════════════════════════════════════════════════════════════════════════
// LÍMITE DE ADMINISTRADORES POR PLAN — palanca comercial
// ─────────────────────────────────────────────────────────────────────────────
// El propietario cuenta dentro del límite. Ajustar esta tabla cuando se defina
// el precio del "administrador adicional". null = sin límite.
// ═════════════════════════════════════════════════════════════════════════════
const LIMITE_ADMINS_POR_PLAN = {
  punto_venta:   1,   // dueño operando solo
  independiente: 2,   // dueño + una mano derecha
  empresa:       4,   // gerencia + jefes de área
  super_pro:     null,
};
const LIMITE_ADMINS_DEFECTO = 2; // tenant sin suscripción registrada

const limiteAdminsDelTenant = async (adminId) => {
  try {
    const sus = await db.collection('suscripciones').doc(adminId).get();
    if (!sus.exists) return LIMITE_ADMINS_DEFECTO;
    const lim = LIMITE_ADMINS_POR_PLAN[sus.data().plan];
    return lim === undefined ? LIMITE_ADMINS_DEFECTO : lim;
  } catch {
    return LIMITE_ADMINS_DEFECTO;
  }
};

const contarAdminsActivos = async (adminId) => {
  const snap = await db.collection('users').where('creadoPor', '==', adminId).get();
  let n = 1; // el propietario siempre cuenta
  snap.forEach(d => {
    const u = d.data();
    if (d.id !== adminId && u.role === 'admin' && u.activo !== false) n++;
  });
  return n;
};

// ─────────────────────────────────────────────────────────────────────────────

// GET /api/users/mensajeros — Lista de mensajeros para asignación de rutas
// ─────────────────────────────────────────────────────────────────────────────
// Accesible para cualquier usuario del tenant (comercial, tesorería, admin).
// Solo devuelve id, nombre, celular y rol — sin datos sensibles.
// Logística lo necesita para el selector de mensajeros en la asignación.
router.get('/mensajeros', authenticate, async (req, res) => {
  try {
    const adminId = tenantDeReq(req);
    const snap = await db.collection('users')
      .where('creadoPor', '==', adminId)
      .where('role', '==', 'mensajero')
      .get();
    const mensajeros = snap.docs.map(d => ({
      id: d.id,
      nombre: d.data().nombre || d.data().email || '',
      celular: d.data().celular || d.data().phone || '',
      role: 'mensajero',
      activo: d.data().activo !== false,
    })).filter(m => m.activo);
    res.json(mensajeros);
  } catch (e) {
    res.status(500).json({ error: 'Error cargando mensajeros' });
  }
});

// GET /api/users — Listar todos los usuarios (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
// ✅ FIX MULTIADMIN-001: el listado ahora incluye también al PROPIETARIO. Antes
// solo salían los sub-usuarios (creadoPor == adminId), así que el titular nunca
// se veía a sí mismo en su propio equipo y no había forma de distinguirlo.
router.get('/', authenticate, soloAdmin, async (req, res) => {
  try {
    const adminId = tenantDeReq(req);
    // AISLAMIENTO SAAS: cada tenant ve solo sus propios usuarios
    const snapshot = await db.collection('users')
      .where('creadoPor', '==', adminId)
      .get();

    const usuarios = [];
    const vistos = new Set();

    const empujar = (id, data) => {
      if (vistos.has(id)) return;
      vistos.add(id);
      // No devolver contraseña, PIN ni sessionToken al frontend.
      const { password, password_hash, pin, sessionToken, ...usuarioSeguro } = data;
      usuarios.push({
        id,
        ...usuarioSeguro,
        esPropietario: marcaPropietario(data, id, adminId),
        tienePin: !!pin // bandera informativa, sin exponer el valor
      });
    };

    snapshot.forEach(doc => empujar(doc.id, doc.data()));

    // El propietario del tenant
    const propietarioDoc = await db.collection('users').doc(adminId).get();
    if (propietarioDoc.exists) empujar(propietarioDoc.id, propietarioDoc.data());

    res.json(usuarios);
  } catch (error) {
    console.error('Error listando usuarios:', error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/limites — Cupo de administradores del plan (solo admin)
// ─────────────────────────────────────────────────────────────────────────────
// ✅ MULTIADMIN-001. Lo usa el frontend para avisar del tope ANTES de que el
// usuario llene el formulario, y para mostrar "X de Y administradores".
router.get('/limites', authenticate, soloAdmin, async (req, res) => {
  try {
    const adminId = tenantDeReq(req);
    const [limite, usados] = await Promise.all([
      limiteAdminsDelTenant(adminId),
      contarAdminsActivos(adminId),
    ]);
    res.json({
      adminsUsados: usados,
      adminsLimite: limite,          // null = ilimitado
      puedeCrearAdmin: limite === null || usados < limite,
    });
  } catch (e) {
    res.status(500).json({ error: 'Error consultando límites del plan' });
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
    const yo = uidDeReq(req);
    const adminId = tenantDeReq(req);

    if (req.user.role !== 'admin' && yo !== id) {
      return res.status(403).json({ error: 'Solo puedes ver tu propio PIN' });
    }

    // ✅ FIX MULTIADMIN-001: aislamiento — no se puede leer el PIN de un usuario
    // de otro suscriptor aunque se conozca su id.
    const encontrado = await cargarUsuarioDelTenant(id, adminId);
    if (!encontrado) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ pin: encontrado.datos.pin || '' });
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
    const adminId = tenantDeReq(req);

    if (!nombre || !email || !codigo || !password || !role) {
      return res.status(400).json({ error: 'Campos obligatorios: nombre, email, código, contraseña, rol' });
    }

    if (pin && !pinValido(pin)) {
      return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos numéricos' });
    }

    // ✅ FIX MULTIADMIN-001: solo el PROPIETARIO puede crear administradores.
    // Un administrador secundario administra la operación, no la cuenta.
    if (role === 'admin') {
      const soyPropietario = await esPropietarioDelTenant(req);
      if (!soyPropietario) {
        return res.status(403).json({
          error: 'Solo el propietario de la cuenta puede crear administradores.'
        });
      }

      const [limite, usados] = await Promise.all([
        limiteAdminsDelTenant(adminId),
        contarAdminsActivos(adminId),
      ]);
      if (limite !== null && usados >= limite) {
        return res.status(403).json({
          error: `Tu plan permite ${limite} administrador(es) y ya tienes ${usados}. `
               + 'Puedes crear el usuario con otro rol, o ampliar el plan para sumar administradores.'
        });
      }
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
      // ✅ FIX MULTIADMIN-001 — identidad de tenant explícita, sin depender del rol
      adminId,                 // empresa a la que pertenece
      creadoPor: adminId,      // ⚠️ el TENANT, no el creador. Todos los listados
                               //    del sistema filtran por este campo: si aquí
                               //    quedara el uid de un admin secundario, los
                               //    usuarios que él cree desaparecerían del
                               //    listado del propietario (tenant partido).
                               //    Hoy es un no-op: el creador ES el dueño.
      esPropietario: false,    // un usuario creado nunca es dueño de la cuenta

      // Trazabilidad de quién lo creó (antes esto ocupaba `creadoPor`)
      creadoPorUid: uidDeReq(req),
      creadoPorNombre: req.user.nombre || req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(firebaseUser.uid).set(nuevoUsuario);

    await registrarAuditoria({
      accion: 'CREAR_USUARIO',
      modulo: 'usuarios',
      descripcion: `${req.user.nombre || req.user.email} creó usuario ${nombre} (${emailNorm}) con rol ${role}`,
      usuarioId: uidDeReq(req),
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
    const adminId = tenantDeReq(req);
    const yo = uidDeReq(req);

    // ✅ FIX MULTIADMIN-001: aislamiento por tenant ANTES de tocar nada.
    const encontrado = await cargarUsuarioDelTenant(id, adminId);
    if (!encontrado) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const userRef = encontrado.ref;
    const datosActuales = encontrado.datos;

    // ── ✅ MULTIADMIN-001: protecciones de propiedad ─────────────────────────
    const objetivoEsPropietario = marcaPropietario(datosActuales, id, adminId);
    const soyPropietario = await esPropietarioDelTenant(req);

    // 1. Al propietario solo lo edita él mismo.
    if (objetivoEsPropietario && yo !== id) {
      return res.status(403).json({
        error: 'No puedes editar la cuenta del propietario. Solo el titular puede modificar sus propios datos.'
      });
    }

    // 2. Al propietario nadie le cambia el rol ni lo desactiva (ni él mismo:
    //    dejaría la empresa sin titular y sin acceso a la suscripción).
    if (objetivoEsPropietario) {
      if (role && role !== datosActuales.role) {
        return res.status(400).json({ error: 'El propietario de la cuenta debe conservar el rol Administrador.' });
      }
      if (activo === false) {
        return res.status(400).json({ error: 'La cuenta del propietario no se puede desactivar.' });
      }
    }

    // 3. Asignar o retirar el rol Administrador es potestad del propietario.
    const promoviendoAAdmin = role === 'admin' && datosActuales.role !== 'admin';
    const degradandoAdmin   = datosActuales.role === 'admin' && role && role !== 'admin';
    if ((promoviendoAAdmin || degradandoAdmin) && !soyPropietario) {
      return res.status(403).json({
        error: 'Solo el propietario de la cuenta puede asignar o retirar el rol Administrador.'
      });
    }

    // 4. Cupo del plan al promover.
    if (promoviendoAAdmin) {
      const [limite, usados] = await Promise.all([
        limiteAdminsDelTenant(adminId),
        contarAdminsActivos(adminId),
      ]);
      if (limite !== null && usados >= limite) {
        return res.status(403).json({
          error: `Tu plan permite ${limite} administrador(es) y ya tienes ${usados}.`
        });
      }
    }

    // 5. La marca `esPropietario` nunca se acepta desde el body: no está en la
    //    lista de campos que se aplican abajo, así que se ignora en silencio.

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
      // ✅ MULTIADMIN-001: el duplicado se busca dentro del tenant, no global.
      const emailExiste = await db.collection('users')
        .where('creadoPor', '==', adminId)
        .where('email', '==', emailNorm).get();
      if (!emailExiste.empty && emailExiste.docs[0].id !== id) {
        return res.status(400).json({ error: 'Ya existe un usuario con ese email' });
      }
      try { await admin.auth().updateUser(id, { email: emailNorm }); } catch (e) { console.warn('Auth update email:', e.message); }
      cambios.email = emailNorm;
    }

    // Si cambia código — verificar duplicado solo en el mismo tenant
    if (codigo && codigo !== datosActuales.codigo) {
      const codigoExiste = await db.collection('users')
        .where('creadoPor', '==', adminId)
        .where('codigo', '==', codigo).get();
      if (!codigoExiste.empty && codigoExiste.docs[0].id !== id) {
        return res.status(400).json({ error: 'Ya existe un usuario con ese código' });
      }
      cambios.codigo = codigo;
    }

    // Si cambia contraseña: actualiza Firebase Auth + bcrypt en Firestore.
    // ⚠️ Cambiar la contraseña NO cierra la sesión activa del usuario (su
    // sessionToken sigue siendo válido hasta el próximo login). Para expulsarlo
    // de inmediato, desactívelo y vuélvalo a activar.
    if (password) {
      try { await admin.auth().updateUser(id, { password }); } catch (e) { console.warn('Auth update password:', e.message); }
      cambios.password_hash = await hashearPassword(password);
    }

    await userRef.update(cambios);

    await registrarAuditoria({
      accion: 'EDITAR_USUARIO',
      modulo: 'usuarios',
      descripcion: `${req.user.nombre || req.user.email} editó usuario ${datosActuales.nombre} (${datosActuales.email})`,
      usuarioId: yo,
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
    const adminId = tenantDeReq(req);
    const yo = uidDeReq(req);

    if (id === yo) {
      return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
    }

    // ✅ FIX MULTIADMIN-001: aislamiento por tenant.
    const encontrado = await cargarUsuarioDelTenant(id, adminId);
    if (!encontrado) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const userRef = encontrado.ref;
    const datosUsuario = encontrado.datos;

    // El propietario es intocable: es el titular de la suscripción.
    if (marcaPropietario(datosUsuario, id, adminId)) {
      return res.status(403).json({
        error: 'La cuenta del propietario no se puede desactivar.'
      });
    }

    // Retirar a un administrador es potestad del propietario.
    if (datosUsuario.role === 'admin') {
      const soyPropietario = await esPropietarioDelTenant(req);
      if (!soyPropietario) {
        return res.status(403).json({
          error: 'Solo el propietario de la cuenta puede desactivar a otro administrador.'
        });
      }
    }

    await userRef.update({
      activo: false,
      // ✅ MULTIADMIN-001: invalida la sesión activa. El sessionToken del JWT
      // deja de coincidir y el usuario queda fuera de inmediato, sin esperar a
      // que expire el token.
      sessionToken: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    try { await admin.auth().updateUser(id, { disabled: true }); } catch (e) { console.warn('Auth disable:', e.message); }

    await registrarAuditoria({
      accion: 'DESACTIVAR_USUARIO',
      modulo: 'usuarios',
      descripcion: `${req.user.nombre || req.user.email} desactivó usuario ${datosUsuario.nombre} (${datosUsuario.email})`,
      usuarioId: yo,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { id, nombre: datosUsuario.nombre, email: datosUsuario.email, role: datosUsuario.role }
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

    // FIX PIN-UNICO-001: delega en el verificador compartido (aplica ademas la
    // matriz de roles por accion). El contrato de respuesta NO cambia.
    const r = await verificarPin(yo, pin, accion || null);

    // Nombre legible para la auditoria, incluso si la verificacion fallo.
    let quien = r.usuario ? r.usuario.nombre : (req.user.nombre || req.user.email || yo);
    const etiqueta = (accion && MATRIZ_ACCIONES[accion] && MATRIZ_ACCIONES[accion].etiqueta) || accion || 'no especificada';

    await registrarAuditoria({
      accion: r.ok ? 'PIN_AUTORIZADO' : 'PIN_FALLIDO',
      modulo: 'auditoria',
      descripcion: `${quien} ${r.ok ? 'autorizó' : 'falló PIN para'} acción: ${etiqueta}`,
      usuarioId: yo,
      usuarioNombre: quien,
      documento: documento || null,
      datos: { accion, ok: r.ok, codigo: r.codigo || null }
    });

    if (!r.ok) {
      // Se conservan EXACTAMENTE los mismos codigos HTTP que antes del fix:
      //   404 usuario inexistente | 400 sin PIN configurado | 403 rol o PIN mal
      const status = r.codigo === 'USUARIO_NO_EXISTE' ? 404
                   : r.codigo === 'SIN_PIN'           ? 400
                   : 403;
      return res.status(status).json({ autorizado: false, error: r.error, codigo: r.codigo });
    }

    res.json({
      autorizado: true,
      usuario: r.usuario
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
    const adminId = tenantDeReq(req);

    const { desdeISO, hastaISO } = rangoFechasCO(desde, hasta);

    // ══════════════════════════════════════════════════════════════════════
    // AISLAMIENTO SAAS POR USUARIOS DEL TENANT (Ola 3 — fix auditoría vacía)
    // ──────────────────────────────────────────────────────────────────────
    // Los registros históricos de audit_logs NO traen adminId (17 de los 18
    // módulos escribían sin él), así que filtrar where('adminId') devolvía
    // SIEMPRE cero. Como TODOS los registros sí traen usuarioId, el
    // aislamiento se hace por el equipo del tenant: el admin + sus
    // sub-usuarios. Funciona retroactivamente con todo el histórico.
    // (Deuda técnica: estampar adminId en los escritores vía Camino C.)
    // ══════════════════════════════════════════════════════════════════════
    const uidsTenant = new Set([adminId]);
    const porCreador = await db.collection('users').where('creadoPor', '==', adminId).get();
    porCreador.forEach(d => uidsTenant.add(d.id));
    // Compatibilidad: usuarios antiguos que guardaron adminId en vez de creadoPor.
    const porAdminId = await db.collection('users').where('adminId', '==', adminId).get();
    porAdminId.forEach(d => uidsTenant.add(d.id));

    const uids = Array.from(uidsTenant);
    let logs = [];
    // Firestore 'in' admite máximo 30 valores → consultar por bloques.
    // Sin orderBy en la consulta (regla del proyecto: evitar índices
    // compuestos) — se ordena en memoria abajo.
    for (let i = 0; i < uids.length; i += 30) {
      const bloque = uids.slice(i, i + 30);
      const snap = await db.collection('audit_logs')
        .where('usuarioId', 'in', bloque)
        .limit(2000)
        .get();
      snap.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));
    }

    // ── Orden y filtros EN MEMORIA ────────────────────────────────────────
    logs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

    // Fix Ola 3: antes solo se filtraba módulo si TAMBIÉN venía usuarioId.
    if (modulo)    logs = logs.filter(l => l.modulo === modulo);
    if (usuarioId) logs = logs.filter(l => l.usuarioId === usuarioId);
    if (desdeISO)  logs = logs.filter(l => l.fecha && l.fecha >= desdeISO);
    if (hastaISO)  logs = logs.filter(l => l.fecha && l.fecha <= hastaISO);

    if (documento) {
      const q = String(documento).toUpperCase();
      logs = logs.filter(l => {
        const enCampo = l.documento && String(l.documento).toUpperCase().includes(q);
        const enDescripcion = l.descripcion && String(l.descripcion).toUpperCase().includes(q);
        const enDatos = l.datos && JSON.stringify(l.datos).toUpperCase().includes(q);
        return enCampo || enDescripcion || enDatos;
      });
    }

    res.json(logs.slice(0, lim));
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
    { key: 'comercial',    label: 'Telemercadeo' },
    { key: 'compras',      label: 'Compras' },
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
    { key: 'usuarios',     label: 'Usuarios' },
    { key: 'vencimientos', label: 'Vencimientos' }
  ]);
});

// POST /api/users/verificar-password — Valida contrasena del usuario logueado
// Usado por GestionEgresos para autorizar edicion de egreso pagado
router.post('/verificar-password', authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ autorizado: false, error: 'Contrasena requerida' });

    const yo = req.user.uid || req.user.id;
    const doc = await db.collection('users').doc(yo).get();
    if (!doc.exists) return res.status(404).json({ autorizado: false, error: 'Usuario no encontrado' });

    const u = doc.data();
    if (u.role !== 'admin') {
      return res.status(403).json({ autorizado: false, error: 'Solo el administrador puede autorizar esta accion' });
    }

    if (!u.password_hash) {
      return res.status(400).json({ autorizado: false, error: 'Este usuario no tiene contrasena configurada en el sistema' });
    }

    const ok = await bcrypt.compare(String(password), String(u.password_hash));

    await registrarAuditoria({
      accion: ok ? 'PASSWORD_VERIFICADA' : 'PASSWORD_FALLIDA',
      modulo: 'egresos',
      descripcion: `${u.nombre || u.email} ${ok ? 'verifico contrasena para editar egreso' : 'fallo verificacion de contrasena'}`,
      usuarioId: yo,
      usuarioNombre: u.nombre || u.email,
      datos: { ok }
    });

    if (!ok) return res.status(403).json({ autorizado: false, error: 'Contrasena incorrecta' });
    res.json({ autorizado: true });
  } catch (e) {
    console.error('verificar-password:', e);
    res.status(500).json({ autorizado: false, error: e.message });
  }
});

module.exports = router;
