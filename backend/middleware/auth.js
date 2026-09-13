const jwt = require('jsonwebtoken');
const { db } = require('../config/firebase');
// ✅ SUSCRIPCION-BLOQUEO-001: el estado de la suscripción se calcula aquí, en
// la puerta de entrada de TODA la API, no solo en pantalla.
const suscripcionEstado = require('../services/suscripcionEstado');

// Caché corta de la marca superAdmin por uid (evita una lectura por petición).
const _superAdminCache = new Map(); // uid → { es, exp }
const SUPERADMIN_CACHE_MS = 5 * 60 * 1000;

async function esSuperAdmin(uid, userDocYaLeido = null) {
  if (!uid) return false;
  const c = _superAdminCache.get(uid);
  if (c && Date.now() < c.exp) return c.es;
  let es = false;
  try {
    const doc = userDocYaLeido || await db.collection('users').doc(uid).get();
    es = !!(doc && doc.exists && doc.data().superAdmin === true);
  } catch (e) { es = false; }
  _superAdminCache.set(uid, { es, exp: Date.now() + SUPERADMIN_CACHE_MS });
  return es;
}

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'control360secret');
    req.user = decoded;
    req.adminId = decoded.adminId || decoded.uid || decoded.id;

    // ── SESIÓN ÚNICA ─────────────────────────────────────────────────────
    // Verifica que el sessionToken del JWT coincida con el activo en Firestore.
    // Si el usuario inició sesión en otro dispositivo, este queda invalidado.
    let userDoc = null;
    if (decoded.sessionToken) {
      try {
        userDoc = await db.collection('users').doc(decoded.uid).get();
        if (userDoc.exists) {
          // ✅ SUSCRIPTOR-ELIMINAR-001: cuenta cerrada o desactivada → fuera al instante
          if (userDoc.data().eliminado === true || userDoc.data().activo === false) {
            return res.status(401).json({ error: 'SESION_DESPLAZADA', mensaje: 'Tu usuario fue desactivado.' });
          }
          const activeToken = userDoc.data().sessionToken;
          if (activeToken && activeToken !== decoded.sessionToken) {
            return res.status(401).json({
              error: 'SESION_DESPLAZADA',
              mensaje: 'Tu sesión fue iniciada en otro dispositivo.'
            });
          }
        }
      } catch (e) {
        // Si falla Firestore, dejamos pasar para no bloquear por error temporal
        console.error('Error verificando sessionToken:', e.message);
      }
    }

    // ── ✅ SUSCRIPCION-BLOQUEO-001: cuenta suspendida por falta de pago ──
    // Aplica a TODOS los usuarios del tenant (admin y sub-usuarios). Exentos:
    // el SuperAdmin (administra la plataforma y su propio tenant desde el
    // panel) y la consulta de estado (/api/auth/suscripcion-estado no pasa
    // por aquí). Ante error de lectura el servicio hace fail-open.
    try {
      const estado = await suscripcionEstado.obtenerEstadoTenant(req.adminId);
      if (estado.bloqueada) {
        // Exento: el SuperAdmin y TODO el tenant cuyo propietario es el
        // SuperAdmin (los empleados de la empresa de la plataforma).
        const exento = (await esSuperAdmin(decoded.uid, userDoc)) || (req.adminId !== decoded.uid && await esSuperAdmin(req.adminId));
        if (!exento) {
          return res.status(402).json({
            error: 'SUSCRIPCION_SUSPENDIDA',
            mensaje: 'La suscripción de tu empresa está suspendida por falta de pago.',
            suscripcion: suscripcionEstado.resumenPublico(estado)
          });
        }
      }
    } catch (e) {
      console.error('Error verificando suscripción:', e.message);
    }

    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

const validarTenant = (nombreColeccion, nombreParametroId = 'id') => {
  return async (req, res, next) => {
    try {
      const docId = req.params[nombreParametroId] || req.params.id || req.params.ordenId || req.params.clienteId || req.params.cajaId;
      if (!docId) return next();
      const adminIdToken = req.user.adminId || req.user.uid;
      if (!adminIdToken) return res.status(401).json({ error: 'Usuario no identificado' });
      const docRef = db.collection(nombreColeccion).doc(docId);
      const docSnap = await docRef.get();
      if (!docSnap.exists) return res.status(404).json({ error: 'Recurso no encontrado' });
      const docData = docSnap.data();
      const adminIdDoc = docData.adminId;
      if (adminIdToken !== adminIdDoc) {
        console.warn(`🔴 [SECURITY] ${adminIdToken} intentó acceder a ${nombreColeccion}/${docId}`);
        return res.status(403).json({ error: 'No tienes acceso', codigo: 'TENANT_MISMATCH' });
      }
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};

const validarTenantEnLista = async (req, res, next) => {
  try {
    const adminId = req.user.adminId || req.user.uid;
    if (!adminId) return res.status(401).json({ error: 'Usuario no identificado' });
    req.adminId = adminId;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = { authenticate, validarTenant, validarTenantEnLista, esSuperAdmin };
