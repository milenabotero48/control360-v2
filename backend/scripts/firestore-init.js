// ============================================================
// Control360 — Script de inicialización Firestore para Anny
// Ubicación: scripts/initAnnyFirestore.js
// Ejecución: node scripts/initAnnyFirestore.js
// ============================================================

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');

// Inicializar Firebase Admin
const serviceAccount = require(path.join(__dirname, '../config/serviceAccountKey.json'));

initializeApp({
  credential: cert(serviceAccount),
  projectId: 'control360-v2'
});

const db = getFirestore();

// ============================================================
// Datos de inicialización
// ============================================================

const ADMIN_ID = '6h2gpIJ1vAZaUwBA5SLXTRONShp1'; // Milena (Extintores del Valle)

// FIX ANNY-GATE-001: este documento SOLO guarda datos operativos.
// El interruptor real de "activo" vive en users/{ADMIN_ID}.modulos
// (array), y se prende ÚNICAMENTE desde Panel Suscriptores → Módulos,
// exactamente igual que 'llamadas_ia' (Lucy). Este script NO activa
// el módulo — eso lo haces tú manualmente en el panel, a propósito.
const annyConfig = {
  whatsappNumber: '3117762773',
  diasAntes: 30,
  horaEnvio: '09:00',
  conectado: false,
  createdAt: new Date(),
  updatedAt: new Date()
};

const respuestasBase = {
  'precio_abc_5lb': {
    patrones: ['precio', 'cuanto cuesta', 'abc 5', 'recarga 5'],
    respuesta: 'Recarga ABC 5 lb: $19.000',
    tipo: 'PRECIO'
  },
  'precio_abc_10lb': {
    patrones: ['precio abc 10', 'recarga 10 libras', 'abc 10'],
    respuesta: 'Recarga ABC 10 lb: $25.000',
    tipo: 'PRECIO'
  },
  'domicilio': {
    patrones: ['domicilio', 'envio', 'hacen entrega', 'costo envio'],
    respuesta: 'Sí, hacemos domicilio. Cali: $8.000. Otros sectores: se valida con logística. ¿A qué sector?',
    tipo: 'SERVICIO'
  },
  'horario': {
    patrones: ['horario', 'cuando abren', 'que horas', 'estan abiertos'],
    respuesta: 'Martes-Viernes: 8am-5pm\nSábado: 8am-12pm\nDomingo-Lunes: Cerrado',
    tipo: 'INFO'
  },
  'datos_cotizacion': {
    patrones: ['cotizacion', 'presupuesto', 'cuanto me cuesta', 'cotizar'],
    respuesta: 'Perfecto, envíame estos datos:\n✅ Nombre:\n✅ Empresa:\n✅ NIT:\n✅ Dirección:\n✅ Barrio:\n✅ Celular:',
    tipo: 'SOLICITUD_DATOS'
  },
  'ubicacion': {
    patrones: ['donde estan', 'direccion', 'como llego', 'ubicacion'],
    respuesta: 'Estamos en: Cl. 22 Nte. #5bn28, San Vicente, Cali, Valle del Cauca\nMaps: https://maps.google.com/maps/search/extintores+del+valle+sas',
    tipo: 'INFO'
  }
};

// ============================================================
// Función: Inicializar colecciones
// ============================================================
async function initAnnyFirestore() {
  console.log('🚀 Iniciando Firestore para Anny...');
  console.log(`📍 Admin ID: ${ADMIN_ID}`);

  try {
    // 1. Crear annyConfig
    console.log('\n1️⃣ Creando annyConfig...');
    await db.collection('annyConfig').doc(ADMIN_ID).set(annyConfig);
    console.log('   ✅ annyConfig creado');

    // 2. Crear respuestasAnny
    console.log('\n2️⃣ Creando respuestasAnny...');
    await db.collection('respuestasAnny').doc(ADMIN_ID).set(respuestasBase);
    console.log('   ✅ respuestasAnny creado (6 respuestas base)');

    // 3. Crear colecciones vacías (estructura)
    console.log('\n3️⃣ Creando colecciones...');

    // conversacionesAnny
    await db.collection('conversacionesAnny')
      .doc(ADMIN_ID)
      .collection('conversaciones')
      .doc('_placeholder')
      .set({ _placeholder: true });
    await db.collection('conversacionesAnny')
      .doc(ADMIN_ID)
      .collection('conversaciones')
      .doc('_placeholder')
      .delete();
    console.log('   ✅ conversacionesAnny creado');

    // casosEscaladosAnny
    await db.collection('casosEscaladosAnny')
      .doc(ADMIN_ID)
      .collection('casos')
      .doc('_placeholder')
      .set({ _placeholder: true });
    await db.collection('casosEscaladosAnny')
      .doc(ADMIN_ID)
      .collection('casos')
      .doc('_placeholder')
      .delete();
    console.log('   ✅ casosEscaladosAnny creado');

    // aprendizajeAnny
    await db.collection('aprendizajeAnny')
      .doc(ADMIN_ID)
      .set({
        preguntasFrecuentes: [],
        patronesClientes: {},
        mejoresHorarios: {},
        updatedAt: new Date()
      });
    console.log('   ✅ aprendizajeAnny creado');

    // metricsAnny
    console.log('   ✅ metricsAnny (auto-creado con primer uso)');

    // 4. Información de resumen
    console.log('\n📊 RESUMEN:');
    console.log(`   Empresa: Extintores del Valle SAS`);
    console.log(`   Admin ID: ${ADMIN_ID}`);
    console.log(`   Número WhatsApp: ${annyConfig.whatsappNumber}`);
    console.log(`   Estado del módulo: se controla desde Panel Suscriptores → Módulos → 'anny_ia' (no desde este script)`);
    console.log(`   Respuestas pre-configuradas: 6`);

    console.log('\n✅ Firestore inicializado exitosamente!');
    console.log('\n📋 Próximos pasos:');
    console.log('   1. Escanear QR con teléfono (menú Dispositivos vinculados)');
    console.log('   2. Verificar conexión en annyConfig.conectado = true');
    console.log('   3. Probar endpoint: GET /api/anny/metricas');

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// ============================================================
// Función auxiliar: Verificar estado actual
// ============================================================
async function verificarEstado() {
  try {
    console.log('\n🔍 Verificando estado actual...\n');

    const configSnap = await db.collection('annyConfig').doc(ADMIN_ID).get();
    if (configSnap.exists) {
      console.log('✅ annyConfig existe (datos operativos):');
      console.log(`   Conectado: ${configSnap.data().conectado || false}`);
      console.log(`   WhatsApp: ${configSnap.data().whatsappNumber}`);
    } else {
      console.log('❌ annyConfig NO existe');
    }

    const userSnap = await db.collection('users').doc(ADMIN_ID).get();
    const modulos = userSnap.exists ? (userSnap.data().modulos || []) : [];
    console.log(`\n🔐 Gate real del módulo (users.modulos): ${modulos.includes('anny_ia') ? '🟢 anny_ia ACTIVO' : '⚪ anny_ia NO asignado — actívalo desde Panel Suscriptores → Módulos'}`);

    const respuestasSnap = await db.collection('respuestasAnny').doc(ADMIN_ID).get();
    if (respuestasSnap.exists) {
      const keys = Object.keys(respuestasSnap.data());
      console.log(`\n✅ respuestasAnny existe: ${keys.length} respuestas`);
    } else {
      console.log('\n❌ respuestasAnny NO existe');
    }

  } catch (error) {
    console.error('Error verificando:', error.message);
  }
}

// ============================================================
// Ejecutar
// ============================================================
(async () => {
  const comando = process.argv[2];

  if (comando === 'verify') {
    await verificarEstado();
    process.exit(0);
  } else {
    await initAnnyFirestore();
  }
})();
