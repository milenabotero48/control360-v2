/**
 * validar-dashboard.js — Control360 · paso previo a DASHBOARD-001   [v2]
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * QUÉ CAMBIÓ EN LA v2
 *
 * La v1 comparaba `createdAt` contra un STRING ISO. Los datos reales guardan
 * `createdAt` como TIMESTAMP de Firestore. Firestore ordena por tipo antes que
 * por valor, así que una comparación `Timestamp >= "2026-08-01T..."` no falla:
 * devuelve CERO documentos, en silencio.
 *
 * Si ese error hubiera llegado al dashboard, las ventas del mes habrían
 * quedado en 0 sin un solo mensaje de error. Por eso ahora las consultas
 * comparan Timestamp contra Timestamp.
 *
 * Esta versión además:
 *   - imprime el link COMPLETO para crear el índice que falte
 *   - agrega una prueba de control que demuestra el bug del string, para que
 *     quede constancia de por qué la consulta va con Timestamp
 *
 * NO MODIFICA NADA. Solo lee y compara.
 *
 * CÓMO SE USA
 *   cd C:\Users\milen\control360-v2\backend
 *   node validar-dashboard.js
 * ══════════════════════════════════════════════════════════════════════════════
 */

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// ── Mismos helpers de fecha que usa routes/dashboards.js ─────────────────────
const rangoMesCO = () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const hoyCO = fmt.format(new Date());
  const [year, month] = hoyCO.split('-');
  const ultimoDia = new Date(Number(year), Number(month), 0).getDate();
  return {
    inicioISO: new Date(`${year}-${month}-01T00:00:00-05:00`).toISOString(),
    finISO: new Date(`${year}-${month}-${String(ultimoDia).padStart(2, '0')}T23:59:59.999-05:00`).toISOString(),
  };
};

const rangoHoyCO = () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const hoyCO = fmt.format(new Date());
  return {
    inicioISO: new Date(`${hoyCO}T00:00:00-05:00`).toISOString(),
    finISO: new Date(`${hoyCO}T23:59:59.999-05:00`).toISOString(),
  };
};

const aTime = (v) => {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') return new Date(v);
  if (v.toDate) return v.toDate();
  if (v._seconds) return new Date(v._seconds * 1000);
  if (v.seconds) return new Date(v.seconds * 1000);
  return null;
};

const dentroDeRango = (val, ini, fin) => {
  const t = aTime(val);
  if (!t) return false;
  const ms = t.getTime();
  return ms >= new Date(ini).getTime() && ms <= new Date(fin).getTime();
};

const fmtN = (n) => Number(n).toLocaleString('es-CO');
const linea = (t = '─') => console.log(t.repeat(74));

// Índices que hacen falta, recolectados durante la corrida
const indicesFaltantes = new Set();

const registrarError = (e) => {
  const msg = String(e?.message || e);
  const link = msg.match(/https:\/\/console\.firebase\.google\.com\S+/);
  if (link) indicesFaltantes.add(link[0]);
  return msg;
};

// Ejecuta una consulta y devuelve { size } o { error }
const contar = async (query) => {
  try {
    const s = await query.get();
    return { size: s.size };
  } catch (e) {
    return { error: registrarError(e) };
  }
};

const veredicto = (esperado, obtenido) => {
  if (obtenido.error) {
    return `      → ⏳ FALTA ÍNDICE — crear y volver a correr\n         ${obtenido.error.slice(0, 200)}`;
  }
  if (obtenido.size === esperado) {
    return `      → ✅ SEGURO — mismo resultado`;
  }
  return `      → ❌ NO APLICAR — difiere en ${fmtN(Math.abs(esperado - obtenido.size))} documentos`;
};

(async () => {
  const usersSnap = await db.collection('users').get();
  const adminIds = [...new Set(
    usersSnap.docs.map(d => {
      const u = d.data();
      return u.adminId || (u.role === 'admin' ? d.id : null);
    }).filter(Boolean)
  )];

  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  VALIDACIÓN v2 — filtros de fecha con Timestamp (no string)              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');
  console.log(`Tenants detectados: ${adminIds.length}\n`);

  const ESTADOS_ABIERTOS = ['en_taller', 'taller_proceso', 'en_ruta_recogida', 'en_ruta_entrega', 'despacho'];

  let seguras = { A: 0, B: 0, C: 0 };
  let fallidas = { A: 0, B: 0, C: 0 };
  let pendientes = { A: 0, B: 0, C: 0 };

  const anotar = (prueba, res, esperado) => {
    if (res.error) pendientes[prueba]++;
    else if (res.size === esperado) seguras[prueba]++;
    else fallidas[prueba]++;
  };

  for (const adminId of adminIds) {
    const mes = rangoMesCO();
    const hoy = rangoHoyCO();
    const tsMesIni = Timestamp.fromDate(new Date(mes.inicioISO));
    const tsMesFin = Timestamp.fromDate(new Date(mes.finISO));
    const tsHoyIni = Timestamp.fromDate(new Date(hoy.inicioISO));
    const tsHoyFin = Timestamp.fromDate(new Date(hoy.finISO));

    linea('═');
    console.log(`TENANT  ${adminId}`);
    linea('═');

    // ── Referencia: cómo lo hace hoy el dashboard ────────────────────────────
    const ordersSnap = await db.collection('orders').where('adminId', '==', adminId).get();
    const mesMem = ordersSnap.docs.filter(d => dentroDeRango(d.data().createdAt, mes.inicioISO, mes.finISO)).length;
    const abiertasMem = ordersSnap.docs.filter(d => ESTADOS_ABIERTOS.includes(d.data().estado)).length;

    console.log(`\n  orders — ${fmtN(ordersSnap.size)} documentos`);

    // ── PRUEBA A — órdenes del mes, comparando Timestamp contra Timestamp ────
    const A = await contar(
      db.collection('orders')
        .where('adminId', '==', adminId)
        .where('createdAt', '>=', tsMesIni)
        .where('createdAt', '<=', tsMesFin)
    );
    console.log(`\n  PRUEBA A — órdenes del mes en curso`);
    console.log(`      hoy   (filtro en memoria)   : ${fmtN(mesMem)}`);
    console.log(`      nuevo (Timestamp Firestore) : ${A.error ? '—' : fmtN(A.size)}`);
    console.log(veredicto(mesMem, A));
    anotar('A', A, mesMem);

    // ── CONTROL — la versión con string, para dejar constancia del bug ───────
    if (!A.error) {
      const ctrl = await contar(
        db.collection('orders')
          .where('adminId', '==', adminId)
          .where('createdAt', '>=', mes.inicioISO)
          .where('createdAt', '<=', mes.finISO)
      );
      if (!ctrl.error) {
        console.log(`      control (string ISO)        : ${fmtN(ctrl.size)}  ${ctrl.size === 0 ? '← confirma por qué NO se usa string' : ''}`);
      }
    }

    // ── PRUEBA B — órdenes en estados abiertos ───────────────────────────────
    const B = await contar(
      db.collection('orders')
        .where('adminId', '==', adminId)
        .where('estado', 'in', ESTADOS_ABIERTOS)
    );
    console.log(`\n  PRUEBA B — órdenes en taller o en ruta`);
    console.log(`      hoy   (filtro en memoria)   : ${fmtN(abiertasMem)}`);
    console.log(`      nuevo (filtro en Firestore) : ${B.error ? '—' : fmtN(B.size)}`);
    console.log(veredicto(abiertasMem, B));
    anotar('B', B, abiertasMem);

    // ── PRUEBA C — movimientos de ingreso de hoy ─────────────────────────────
    const movsSnap = await db.collection('movimientos')
      .where('userId', '==', adminId).where('tipo', '==', 'ingreso').get();
    const movsMem = movsSnap.docs.filter(d => dentroDeRango(d.data().createdAt, hoy.inicioISO, hoy.finISO)).length;

    const C = await contar(
      db.collection('movimientos')
        .where('userId', '==', adminId)
        .where('tipo', '==', 'ingreso')
        .where('createdAt', '>=', tsHoyIni)
        .where('createdAt', '<=', tsHoyFin)
    );
    console.log(`\n  movimientos (ingresos) — ${fmtN(movsSnap.size)} documentos`);
    console.log(`  PRUEBA C — ingresos de hoy`);
    console.log(`      hoy   (filtro en memoria)   : ${fmtN(movsMem)}`);
    console.log(`      nuevo (Timestamp Firestore) : ${C.error ? '—' : fmtN(C.size)}`);
    console.log(veredicto(movsMem, C));
    anotar('C', C, movsMem);

    console.log('');
  }

  // ── RESUMEN ────────────────────────────────────────────────────────────────
  linea('═');
  console.log('\nRESUMEN POR PRUEBA (sobre ' + adminIds.length + ' tenants)\n');
  const fila = (n, etiqueta) => {
    console.log(`  ${etiqueta.padEnd(34)} seguras ${String(seguras[n]).padStart(2)}   ` +
                `difieren ${String(fallidas[n]).padStart(2)}   sin índice ${String(pendientes[n]).padStart(2)}`);
  };
  fila('A', 'A · órdenes del mes');
  fila('B', 'B · órdenes en taller/ruta');
  fila('C', 'C · ingresos de hoy');

  if (indicesFaltantes.size) {
    console.log('\n' + '─'.repeat(74));
    console.log('\n⏳ ÍNDICES QUE HAY QUE CREAR — abrí estos links y dale "Crear índice".');
    console.log('   Tardan 1 a 5 minutos en compilar. Después volvé a correr este script.\n');
    [...indicesFaltantes].forEach((l, i) => console.log(`   ${i + 1}. ${l}\n`));
    console.log('   Si preferís crearlos a mano (Firestore → Índices → Compuesto):');
    console.log('     · orders       →  adminId (Asc) + createdAt (Asc)');
    console.log('     · movimientos  →  userId (Asc) + tipo (Asc) + createdAt (Asc)\n');
  }

  const listo = fallidas.A + fallidas.B + fallidas.C === 0 &&
                pendientes.A + pendientes.B + pendientes.C === 0;
  console.log(listo
    ? '\n✅ TODO VERDE — es seguro aplicar las tres optimizaciones al dashboard.\n'
    : '\n➡️  Creá los índices de arriba, volvé a correr este script y pasame la salida.\n');

  process.exit(0);
})().catch((err) => {
  console.error('\n❌ Error ejecutando la validación:', err.message);
  console.error(err.stack);
  process.exit(1);
});
