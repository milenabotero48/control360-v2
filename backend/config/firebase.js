const admin = require('firebase-admin');

// PRODUCCIÓN vs LOCAL:
// - Local: usa serviceAccountKey.json (no se sube a GitHub)
// - Railway: usa variables de entorno FIREBASE_*
let credential;

if (process.env.FIREBASE_PRIVATE_KEY) {
  // Producción (Railway) — usa variables de entorno
  credential = admin.credential.cert({
    projectId:    process.env.FIREBASE_PROJECT_ID,
    privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
    privateKey:   process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
  });
} else {
  // Local — usa el archivo JSON (no sube a GitHub)
  const serviceAccount = require('../serviceAccountKey.json');
  credential = admin.credential.cert(serviceAccount);
}

if (!admin.apps.length) {
  admin.initializeApp({ credential });
}

const db = admin.firestore();
module.exports = { admin, db };
