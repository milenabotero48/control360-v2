const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.log('Firebase ya inicializado');
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };