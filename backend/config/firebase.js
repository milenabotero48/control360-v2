const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

// Inicialización única y segura
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

module.exports = { admin, db };