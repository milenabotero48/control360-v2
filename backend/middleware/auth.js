const jwt = require('jsonwebtoken');
const { db } = require('../config/firebase');

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'control360secret');
    req.user = decoded;
    req.adminId = decoded.adminId || decoded.uid || decoded.id;
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

module.exports = { authenticate, validarTenant, validarTenantEnLista };