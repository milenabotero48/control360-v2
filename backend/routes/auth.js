const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { db }  = require('../config/firebase');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const admin   = require('firebase-admin');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Módulos por plan (tabla validada Jun 2026) ───────────────────────────────
const MODULOS_POR_PLAN = {
  punto_venta: [
    'dashboard','clientes','ordenes','cotizaciones','productos',
    'caja','egresos','proveedores','mi_empresa'
  ],
  independiente: [
    'dashboard','clientes','ordenes','cotizaciones','productos',
    'caja','egresos','proveedores','mi_empresa',
    'cxc','cxp','usuarios','reportes'
  ],
  empresa: [
    'dashboard','clientes','ordenes','cotizaciones','productos',
    'caja','egresos','proveedores','mi_empresa',
    'cxc','cxp','usuarios','reportes',
    'logistica','taller','compras','eri',
    'comercial','vencimientos'
  ],
  super_pro: []
};
const PLANES_PUBLICOS = ['punto_venta','independiente','empresa'];

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
// Seguridad Ola 1 (original):
//   · bcrypt.compare para verificar contraseña
//   · Mensajes genéricos (no revela si el email existe)
//   · Bloquea usuarios desactivados (activo === false)
//
// Seguridad Ola 4 (este archivo):
//   · Capa 1 — Bloqueo por intentos fallidos:
//       5 intentos fallidos → cuenta bloqueada 30 minutos.
//       Contador se guarda en Firestore (intentosFallidos, bloqueadoHasta).
//       Al ingresar correctamente el contador se resetea.
//   · Capa 2 — Huella de sesión en audit_logs:
//       Cada intento (exitoso o fallido) deja registro con:
//         ip, userAgent, hora Colombia, resultado.
//       Si el login es exitoso y el usuario NO es admin:
//         flag FUERA_HORARIO cuando es antes de 07:00 o después de 19:00.
//         flag IP_NUEVA si esa IP nunca había iniciado sesión este usuario.
//       El admin puede ingresar en cualquier horario sin generar alertas.
// ═════════════════════════════════════════════════════════════════════════════

// ── Constantes de seguridad ───────────────────────────────────────────────────
const MAX_INTENTOS     = 5;          // intentos antes del bloqueo
const BLOQUEO_MINUTOS  = 30;         // duración del bloqueo
const HORA_INICIO      = 7;          // 07:00 hora Colombia
const HORA_FIN         = 19;         // 19:00 hora Colombia

// ── Helper: hora actual en Colombia (UTC-5) ──────────────────────────────────
const ahoraEnColombia = () => {
  return new Date(Date.now() - 5 * 60 * 60 * 1000);
};

// ── Helper: IP del cliente (considera proxies como Railway/Netlify) ──────────
const obtenerIP = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'desconocida';
};

// ── Helper: registrar huella en audit_logs ───────────────────────────────────
const registrarHuella = async ({ usuarioId, usuarioNombre, email, ip, userAgent, resultado, alertas, adminId }) => {
  try {
    const ahoraCO = ahoraEnColombia();
    await db.collection('audit_logs').add({
      accion:        'LOGIN',
      modulo:        'auth',
      descripcion:   `${usuarioNombre || email} — ${resultado}${alertas.length ? ' ⚠️ ' + alertas.join(', ') : ''}`,
      usuarioId:     usuarioId  || null,
      usuarioNombre: usuarioNombre || email,
      adminId:       adminId || null,
      datos: {
        ip,
        userAgent: userAgent || 'desconocido',
        horaColombia: ahoraCO.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }),
        fechaColombia: ahoraCO.toISOString().slice(0, 10),
        resultado,
        alertas,
      },
      fecha:     ahoraCO.toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    // La huella nunca debe bloquear el flujo principal
    console.error('Error registrando huella de sesión:', e.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const ip        = obtenerIP(req);
    const userAgent = req.headers['user-agent'] || 'desconocido';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son obligatorios' });
    }

    const userQuery = await db.collection('users')
      .where('email', '==', String(email).trim().toLowerCase())
      .limit(1)
      .get();

    // Email no existe — huella anónima, mensaje genérico
    if (userQuery.empty) {
      await registrarHuella({
        email, ip, userAgent,
        resultado: 'LOGIN_FALLIDO_EMAIL_NO_EXISTE',
        alertas: [],
        usuarioId: null, usuarioNombre: null, adminId: null,
      });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const userDoc = userQuery.docs[0];
    const user    = userDoc.data();
    const uid     = userDoc.id;
    const passHash = user.password_hash;

    // ── CAPA 1: ¿Cuenta bloqueada por intentos? ──────────────────────────────
    if (user.bloqueadoHasta) {
      const bloqueadoHasta = user.bloqueadoHasta?.toDate
        ? user.bloqueadoHasta.toDate()
        : new Date(user.bloqueadoHasta);

      if (new Date() < bloqueadoHasta) {
        const minutosRestantes = Math.ceil((bloqueadoHasta - new Date()) / 60000);
        await registrarHuella({
          usuarioId: uid, usuarioNombre: user.nombre || user.email,
          email, ip, userAgent,
          resultado: 'LOGIN_BLOQUEADO',
          alertas: ['CUENTA_BLOQUEADA'],
          adminId: user.role === 'admin' ? uid : (user.creadoPor || uid),
        });
        return res.status(429).json({
          error: `Cuenta bloqueada por múltiples intentos fallidos. Intenta de nuevo en ${minutosRestantes} minuto(s).`,
          bloqueadaHasta: bloqueadoHasta.toISOString(),
        });
      } else {
        // El bloqueo ya expiró — limpiar el contador
        await userDoc.ref.update({
          intentosFallidos: 0,
          bloqueadoHasta:   admin.firestore.FieldValue.delete(),
        });
      }
    }

    // ── Validaciones existentes ───────────────────────────────────────────────
    if (!passHash) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (user.activo === false) {
      await registrarHuella({
        usuarioId: uid, usuarioNombre: user.nombre || user.email,
        email, ip, userAgent,
        resultado: 'LOGIN_FALLIDO_USUARIO_INACTIVO',
        alertas: [],
        adminId: user.role === 'admin' ? uid : (user.creadoPor || uid),
      });
      return res.status(403).json({ error: 'Usuario desactivado. Contacta al administrador.' });
    }

    // ── Verificar contraseña ──────────────────────────────────────────────────
    let ok = false;
    try {
      ok = await bcrypt.compare(String(password), String(passHash));
    } catch {
      ok = false;
    }

    // ── CAPA 1: Contraseña incorrecta → incrementar contador ─────────────────
    if (!ok) {
      const intentosActuales = (user.intentosFallidos || 0) + 1;
      const actualizacion    = { intentosFallidos: intentosActuales };

      if (intentosActuales >= MAX_INTENTOS) {
        const bloqueadoHasta = new Date(Date.now() + BLOQUEO_MINUTOS * 60 * 1000);
        actualizacion.bloqueadoHasta = admin.firestore.Timestamp.fromDate(bloqueadoHasta);
      }

      await userDoc.ref.update(actualizacion);

      const restantes = MAX_INTENTOS - intentosActuales;
      const alertas   = intentosActuales >= MAX_INTENTOS ? ['CUENTA_BLOQUEADA'] : ['INTENTO_FALLIDO'];

      await registrarHuella({
        usuarioId: uid, usuarioNombre: user.nombre || user.email,
        email, ip, userAgent,
        resultado: `LOGIN_FALLIDO (intento ${intentosActuales}/${MAX_INTENTOS})`,
        alertas,
        adminId: user.role === 'admin' ? uid : (user.creadoPor || uid),
      });

      if (intentosActuales >= MAX_INTENTOS) {
        return res.status(429).json({
          error: `Cuenta bloqueada por ${BLOQUEO_MINUTOS} minutos por múltiples intentos fallidos.`,
        });
      }

      return res.status(401).json({
        error: `Credenciales inválidas. ${restantes} intento(s) restante(s) antes del bloqueo.`,
      });
    }

    // ── Login exitoso → resetear contador ────────────────────────────────────
    // Generar sessionToken único para esta sesión.
    // Cualquier login posterior sobreescribe este token → sesión anterior invalidada.
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const resetCampos = { intentosFallidos: 0, sessionToken };
    if (user.bloqueadoHasta) resetCampos.bloqueadoHasta = admin.firestore.FieldValue.delete();
    await userDoc.ref.update(resetCampos);

    // ── CAPA 2: Detectar alertas de sesión (solo no-admin) ───────────────────
    const esAdmin  = user.role === 'admin';
    const adminId  = esAdmin ? uid : (user.creadoPor || uid);
    const alertas  = [];

    if (!esAdmin) {
      // Alerta horario: antes de 07:00 o después de 19:00 hora Colombia
      const ahoraCO = ahoraEnColombia();
      const hora    = ahoraCO.getUTCHours(); // ya ajustado a CO en ahoraEnColombia()
      if (hora < HORA_INICIO || hora >= HORA_FIN) {
        alertas.push('FUERA_HORARIO');
      }

      // Alerta IP nueva: verificar si esta IP ya fue usada por este usuario
      const ipYaUsada = await db.collection('audit_logs')
        .where('usuarioId', '==', uid)
        .where('accion', '==', 'LOGIN')
        .limit(50)
        .get();

      const ipsConocidas = new Set();
      ipYaUsada.forEach(doc => {
        const datos = doc.data()?.datos;
        if (datos?.ip) ipsConocidas.add(datos.ip);
      });

      if (!ipsConocidas.has(ip)) {
        alertas.push('IP_NUEVA');
      }
    }

    // ── Registrar huella exitosa ──────────────────────────────────────────────
    await registrarHuella({
      usuarioId: uid, usuarioNombre: user.nombre || user.email,
      email, ip, userAgent,
      resultado: 'LOGIN_OK',
      alertas,
      adminId,
    });

    // ── modulosTenant (lógica original intacta) ───────────────────────────────
    let modulosTenant = user.modulos || [];
    if (!esAdmin && adminId && adminId !== uid) {
      try {
        const adminDoc = await db.collection('users').doc(adminId).get();
        if (adminDoc.exists) {
          modulosTenant = adminDoc.data().modulos || [];
        }
      } catch (e) {
        modulosTenant = user.modulos || [];
      }
    }

    // ── Generar JWT (idéntico al original) ───────────────────────────────────
    const token = jwt.sign(
      {
        uid,
        email: user.email,
        role:  user.role,
        nombre: user.nombre || user.email,
        adminId,
        sessionToken, // incluido en JWT para verificación en middleware
      },
      process.env.JWT_SECRET || 'control360secret',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id:           uid,
        email:        user.email,
        nombre:       user.nombre,
        role:         user.role,
        modulos:      user.modulos || [],
        modulosTenant,
        codigo:       user.codigo || '',
        adminId,
        // superAdmin: SOLO para mostrar Panel de Suscriptores en el frontend.
        // La seguridad real verifica en Firestore en cada endpoint /superadmin.
        superAdmin:   user.superAdmin === true,
      },
    });

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// ═══════════════════════════════════════════════════════
// GET /api/auth/suscripcion-estado — Estado de suscripción
// Usado por BannerSuscripcion.js para mostrar alerta
// ═══════════════════════════════════════════════════════
router.get('/suscripcion-estado', async (req, res) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    const jwt2   = require('jsonwebtoken');
    const decoded = jwt2.verify(token, process.env.JWT_SECRET || 'control360secret');
    const adminId = decoded.adminId || decoded.uid;

    const susDoc = await db.collection('suscripciones').doc(adminId).get();
    if (!susDoc.exists) return res.json({ dias: null, plan: null });

    const sus = susDoc.data();
    if (!sus.fechaVencimiento) return res.json({ dias: null, plan: sus.plan });

    const fin  = new Date(`${sus.fechaVencimiento}T23:59:59-05:00`);
    const dias = Math.ceil((fin - new Date()) / (1000 * 60 * 60 * 24));

    return res.json({ dias, plan: sus.plan, fechaVencimiento: sus.fechaVencimiento, estado: sus.estado });
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
});

// ═══════════════════════════════════════════════════════
// POST /api/auth/registro
// ═══════════════════════════════════════════════════════
router.post('/registro', async (req, res) => {
  try {
    const { nombre, empresa, email, password, plan, nit, telefono, ciudad } = req.body;
    if (!nombre || !email || !password || !plan)
      return res.status(400).json({ error: 'Nombre, email, contraseña y plan son obligatorios' });
    if (!PLANES_PUBLICOS.includes(plan))
      return res.status(400).json({ error: 'Plan inválido' });
    if (String(password).length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
    const emailLimpio = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpio))
      return res.status(400).json({ error: 'Email inválido' });

    const existe = await db.collection('users').where('email','==',emailLimpio).limit(1).get();
    if (!existe.empty) return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });

    const passwordHash = await bcrypt.hash(String(password), 12);
    const hoy = new Date(Date.now() - 5*3600*1000).toISOString().slice(0,10);
    const vencimiento = new Date(Date.now() - 5*3600*1000 + 14*24*3600*1000).toISOString().slice(0,10);

    const userRef = await db.collection('users').add({
      nombre: String(nombre).trim(), empresa: empresa||null,
      email: emailLimpio, password_hash: passwordHash,
      role: 'admin', modulos: MODULOS_POR_PLAN[plan],
      activo: true, nit: nit||null, telefono: telefono||null,
      ciudad: ciudad||null, superAdmin: false,
      intentosFallidos: 0, origenRegistro: 'web_publica',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const adminId = userRef.id;

    await db.collection('suscripciones').doc(adminId).set({
      plan, estado: 'trial', fechaInicio: hoy,
      fechaVencimiento: vencimiento,
      notas: 'Registro web automático',
      actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
      actualizadoPor: 'sistema',
    });

    await db.collection('audit_logs').add({
      accion:'REGISTRO', modulo:'auth',
      descripcion:`Nuevo suscriptor: ${nombre} (${emailLimpio}) — Plan ${plan}`,
      usuarioId: adminId, usuarioNombre: String(nombre).trim(), adminId,
      datos: { plan, empresa:empresa||null, ciudad:ciudad||null },
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    const NOMBRE_PLAN = { punto_venta:'Punto de Venta', independiente:'Independiente', empresa:'Empresa' };
    try {
      await resend.emails.send({
        from: 'Control360 <noreply@tucontrol360.com>',
        to: emailLimpio,
        subject: 'Bienvenido a Control360 — Tu prueba de 14 días comienza ahora',
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;">
            <div style="text-align:center;margin-bottom:24px;">
              <span style="font-size:26px;font-weight:900;color:#0D1B2A;">Control<span style="color:#7c3aed;">360</span></span>
            </div>
            <h2 style="color:#1a1a2e;">Hola ${String(nombre).trim().split(' ')[0]}, bienvenido 🎉</h2>
            <p style="color:#374151;line-height:1.6;">Tu cuenta está lista. Tienes <strong>14 días gratis</strong> para explorar el plan <strong>${NOMBRE_PLAN[plan]}</strong>.</p>
            <div style="background:#f5f3ff;border-radius:10px;padding:16px 20px;margin:20px 0;">
              <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">TU ACCESO</div>
              <div style="font-weight:700;color:#1a1a2e;">${emailLimpio}</div>
              <div style="font-size:11px;color:#6b7280;margin-top:6px;">Plan: ${NOMBRE_PLAN[plan]} · Trial hasta: ${vencimiento}</div>
            </div>
            <div style="background:#fff8e6;border-radius:10px;padding:14px 18px;margin:16px 0;border:1px solid #f3d98a;">
              <div style="font-size:11px;font-weight:800;color:#8a6d1a;margin-bottom:6px;">¿NECESITAS AYUDA?</div>
              <p style="font-size:13px;color:#374151;margin:0;">Escríbenos por WhatsApp: <a href="https://wa.me/573234152442" style="color:#7c3aed;font-weight:700;">+57 323 415 2442</a></p>
            </div>
            <a href="${process.env.FRONTEND_URL||'https://app.tucontrol360.com'}"
               style="display:block;text-align:center;background:#7c3aed;color:white;padding:14px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;margin:20px 0;">
              Ingresar a Control360
            </a>
          </div>`,
      });
    } catch(e) { console.error('Email bienvenida:', e.message); }

    const token = jwt.sign(
      { uid:adminId, email:emailLimpio, role:'admin', nombre:String(nombre).trim(), adminId },
      process.env.JWT_SECRET||'control360secret',
      { expiresIn:'24h' }
    );
    const userData = {
      id:adminId, email:emailLimpio, nombre:String(nombre).trim(),
      role:'admin', modulos:MODULOS_POR_PLAN[plan],
      modulosTenant:MODULOS_POR_PLAN[plan], adminId, superAdmin:false,
    };
    return res.status(201).json({ token, user:userData,
      suscripcion:{ plan, estado:'trial', fechaVencimiento:vencimiento } });
  } catch(error) {
    console.error('Error en registro:', error);
    return res.status(500).json({ error:'Error al crear la cuenta. Inténtalo de nuevo.' });
  }
});

module.exports = router;
