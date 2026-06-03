const { db } = require('./config/firebase');

const ADMIN_ID = '6h2gpIJ1vAZaUwBA5SLXTRONShp1';

const migrarAdminId = async () => {
  console.log('Buscando productos sin adminId...');
  
  const snap = await db.collection('products')
    .where('creadoPor', '==', ADMIN_ID)
    .get();

  console.log(`Encontrados: ${snap.size} productos`);

  let actualizados = 0;
  const batch = db.batch();

  snap.forEach(doc => {
    const data = doc.data();
    if (!data.adminId) {
      batch.update(doc.ref, { adminId: ADMIN_ID });
      actualizados++;
    }
  });

  if (actualizados === 0) {
    console.log('Todos ya tienen adminId.');
    return;
  }

  await batch.commit();
  console.log(`✅ ${actualizados} productos actualizados`);
};

migrarAdminId()
  .then(() => process.exit(0))
  .catch(e => { console.error('Error:', e); process.exit(1); });