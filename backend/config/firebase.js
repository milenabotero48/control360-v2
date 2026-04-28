const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://control360-v2.firebaseio.com'
});

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };