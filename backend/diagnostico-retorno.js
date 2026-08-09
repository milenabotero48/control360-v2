// ═════════════════════════════════════════════════════════════════════════════
// diagnostico-retorno.js — ¿Por qué la tasa de retorno se cayó a cero?
// ─────────────────────────────────────────────────────────────────────────────
// EL SÍNTOMA:
//   El panel de Vencimientos muestra retorno de 27% → 25% → 22% → 17% → 20%
//   hasta enero 2026, y a partir de febrero cae a 0%, 0.5%, 0.4%, 0%, 0.8%.
//
//   Una caída así de limpia a cero casi nunca es el negocio: si de verdad solo
//   volviera el 0.5% de los clientes, la empresa ya habría cerrado. Lo que
//   suele pasar es que dejó de REGISTRARSE el cierre del ciclo.
//
// QUÉ HACE ESTE SCRIPT:
//   Toma cada mes de los últimos 18 y cuenta, por separado, las TRES formas en
//   que un vencimiento puede quedar cerrado:
//     · gestionado = true          (alguien lo marcó a mano en la pantalla)
//     · ordenId presente           (se le facturó una orden de servicio)
//     · estadoCiclo = RENOVADO     (lo cerró el motor automático)
//
//   Si el retorno cae pero las ÓRDENES siguen llegando, el negocio está sano y
//   lo que se rompió es el vínculo orden → vencimiento. Si también caen las
//   órdenes, la caída es real y es un problema comercial.
//
//   Además cruza contra la colección `orders` para ver cuántas órdenes hubo en
//   cada mes sin importar si quedaron enlazadas.
//
// SOLO LEE. No escribe ni modifica un solo documento.
//
// USO:
//   node diagnostico-retorno.js <adminId>
//   node diagnostico-retorno.js <adminId> > retorno.txt
// ═════════════════════════════════════════════════════════════════════════════

const { db } = require('./config/firebase');

const adminId = process.argv[2];
if (!adminId) {
  console.error('Falta el adminId.\n  Uso: node diagnostico-retorno.js <adminId>');
  process.exit(1);
}

const MESES_ATRAS = 18;

const mesesRecientes = (n) => {
  const out = [];
  const hoy = new Date(Date.now() - 5 * 3600 * 1000);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
};

const fechaDeOrden = (o) => {
  const v = o.fecha || o.createdAt || o.fechaCreacion;
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 7);
  if (v._seconds) return new Date(v._seconds * 1000).toISOString().slice(0, 7);
  if (v.seconds) return new Date(v.seconds * 1000).toISOString().slice(0, 7);
  if (typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 7);
  return '';
};

(async () => {
  console.log('═'.repeat(96));
  console.log('DIAGNÓSTICO DE RETORNO — tenant', adminId);
  console.log('═'.repeat(96));

  // ── 1. Vencimientos ────────────────────────────────────────────────────────
  const snap = await db.collection('vencimientos').where('adminId', '==', adminId).get();
  console.log(`\nVencimientos leídos: ${snap.size}\n`);

  const porMes = new Map();
  const tocar = (k) => {
    if (!porMes.has(k)) {
      porMes.set(k, {
        total: 0, clientes: new Set(),
        gestionado: new Set(), conOrden: new Set(), renovado: new Set(),
        perdido: new Set(), enTelemercadeo: 0, sinTocar: 0,
      });
    }
    return porMes.get(k);
  };

  snap.docs.forEach(d => {
    const v = d.data();
    const k = String(v.fechaVencimiento || '').slice(0, 7);
    if (!k) return;
    const m = tocar(k);
    const cli = v.clienteId || v.telefono || d.id;
    m.total++;
    m.clientes.add(cli);
    if (v.gestionado === true) m.gestionado.add(cli);
    if (v.ordenId) m.conOrden.add(cli);
    if (v.estadoCiclo === 'RENOVADO') m.renovado.add(cli);
    if (v.estadoCiclo === 'PERDIDO') m.perdido.add(cli);
    if (v.estadoCiclo === 'EN_TELEMERCADEO') m.enTelemercadeo++;
    if (!v.gestionado && !v.ordenId && !v.estadoCiclo) m.sinTocar++;
  });

  // ── 2. Órdenes por mes (el contraste que importa) ──────────────────────────
  const ordSnap = await db.collection('orders').where('adminId', '==', adminId).get();
  const ordenesPorMes = new Map();
  const ordenesConVenc = new Map();
  ordSnap.docs.forEach(d => {
    const o = d.data();
    const k = fechaDeOrden(o);
    if (!k) return;
    ordenesPorMes.set(k, (ordenesPorMes.get(k) || 0) + 1);
    if (o.vencimientoId || o.vencimientosCerrados) {
      ordenesConVenc.set(k, (ordenesConVenc.get(k) || 0) + 1);
    }
  });
  console.log(`Órdenes leídas: ${ordSnap.size}\n`);

  // ── 3. Tabla ───────────────────────────────────────────────────────────────
  const meses = mesesRecientes(MESES_ATRAS);
  const fila = (c) => [
    String(c[0]).padEnd(9),
    String(c[1]).padStart(9),
    String(c[2]).padStart(11),
    String(c[3]).padStart(9),
    String(c[4]).padStart(10),
    String(c[5]).padStart(9),
    String(c[6]).padStart(9),
    String(c[7]).padStart(10),
  ].join(' │ ');

  console.log(fila(['MES', 'VENCÍAN', 'GESTIONADO', 'C/ORDEN', 'RENOVADO', 'RETORNO', 'ÓRDENES', 'ORD↔VENC']));
  console.log('─'.repeat(96));

  let corte = null;
  let anterior = null;

  meses.forEach(k => {
    const m = porMes.get(k);
    if (!m) { console.log(fila([k, 0, 0, 0, 0, '—', ordenesPorMes.get(k) || 0, ordenesConVenc.get(k) || 0])); return; }
    const cerrados = new Set([...m.gestionado, ...m.conOrden, ...m.renovado]);
    const pct = m.clientes.size ? (cerrados.size / m.clientes.size) * 100 : 0;
    console.log(fila([
      k, m.clientes.size, m.gestionado.size, m.conOrden.size, m.renovado.size,
      pct.toFixed(1) + '%', ordenesPorMes.get(k) || 0, ordenesConVenc.get(k) || 0,
    ]));

    // Detectar el mes exacto del quiebre: caída de más de 10 puntos.
    if (anterior !== null && anterior - pct > 10 && !corte) corte = { mes: k, antes: anterior, despues: pct };
    anterior = pct;
  });

  // ── 4. Lectura del resultado ───────────────────────────────────────────────
  console.log('\n' + '═'.repeat(96));
  console.log('LECTURA');
  console.log('═'.repeat(96));

  if (corte) {
    console.log(`\n⚠️  Quiebre detectado en ${corte.mes}: el retorno pasó de ${corte.antes.toFixed(1)}% a ${corte.despues.toFixed(1)}%.\n`);

    const ordAntes = [...ordenesPorMes.entries()].filter(([k]) => k < corte.mes).slice(-3).map(([, v]) => v);
    const ordDespues = [...ordenesPorMes.entries()].filter(([k]) => k >= corte.mes).slice(0, 3).map(([, v]) => v);
    const prom = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const pAntes = prom(ordAntes), pDespues = prom(ordDespues);

    console.log(`   Órdenes/mes antes del quiebre:   ${pAntes.toFixed(0)}`);
    console.log(`   Órdenes/mes después del quiebre: ${pDespues.toFixed(0)}\n`);

    if (pDespues >= pAntes * 0.7) {
      console.log('   ✅ Las órdenes SIGUIERON llegando casi igual.');
      console.log('      → El negocio está sano. Lo que se rompió es el REGISTRO: las órdenes');
      console.log('        dejaron de cerrar el vencimiento del cliente.');
      console.log('      → Revisa qué cambió en esa fecha (despliegue, cambio de flujo, personal');
      console.log('        nuevo facturando sin asociar el vencimiento).');
      console.log('      → Se puede recuperar con: node backend/recuperar-vencimientos.js');
      console.log('        o con el botón "Cerrar ciclos atendidos" de la pantalla, que cruza');
      console.log('        las órdenes ya facturadas contra los vencimientos abiertos.');
    } else {
      console.log('   🔴 Las órdenes TAMBIÉN cayeron.');
      console.log('      → La caída es real: se están perdiendo clientes de verdad.');
      console.log('      → Prioridad comercial: campaña de retención sobre los vencidos,');
      console.log('        empezando por los de mayor valor.');
    }
  } else {
    console.log('\n   No se detectó un quiebre brusco en el periodo analizado.');
  }

  const totalSinTocar = [...porMes.values()].reduce((s, m) => s + m.sinTocar, 0);
  console.log(`\n   Vencimientos sin ninguna marca de gestión: ${totalSinTocar} de ${snap.size}`);
  console.log('\n   (Este script solo lee. No modificó ningún dato.)\n');

  process.exit(0);
})().catch(e => { console.error('Error:', e); process.exit(1); });
