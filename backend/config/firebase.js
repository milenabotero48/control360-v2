const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

const app = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://control360-v2.firebaseio.com'
});

const db = admin.firestore();

module.exports = { admin, db };