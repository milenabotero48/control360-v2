// ============================================================
// Control360 — ✅ FIX CAJA-002: Diagnóstico de dinero perdido
// Ubicación: backend/scripts/diagnostico-caja.js
// ------------------------------------------------------------
// EJECUTAR desde Railway Console o local:
//   node backend/scripts/diagnostico-caja.js
//   node backend/scripts/diagnostico-caja.js OS-0187 OS-0141
//
// Qué hace (100% READ-ONLY — no modifica NADA):
//   · Imprime el estado completo de las órdenes indicadas
//     (por defecto OS-0187, OS-0141 y OI-0005): estado, pagado,
//     dineroEnCaja, cuadrado, montoRecaudado, historial resumido
//   · Lista los movimientos de caja asociados a cada orden
//   · Lista TODOS los movimientos con cajaId 'sin_asignar'
//     (el dinero huérfano que ninguna caja recibió)
//   · Lista los arqueos (cuadres_historial) de los últimos 15 días
//
// SEGURO: solo lecturas. Cero writes.
// ============================================================

require('dotenv').config();
require('../config/firebase'); // inicializa Firebase Admin
const { db } = require('../config/firebase');

const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('es-CO');
const fechaDe = (v) => {
  if (!v) return '—';
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.seconds) return new Date(v.seconds * 1000).toISOString();
  return String(v);
};

const ORDENES_DEFAULT = ['OS-0187', 'OS-0141', 'OI-0005'];

(async () => {
  const numeros = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ORDENES_DEFAULT;
  console.log('══════════════════════════════════════════════════════');
  console.log('  DIAGNÓSTICO DE CAJA — READ ONLY');
  console.log('  Órdenes a revisar:', numeros.join(', '));
  console.log('══════════════════════════════════════════════════════\n');

  // ── 1. Órdenes ────────────────────────────────────────────
  for (const num of numeros) {
    const snap = await db.collection('orders').where('numeroOrden', '==', num).get();
    if (snap.empty) { console.log(`\n📋 ${num}: NO ENCONTRADA\n`); continue; }
    for (const doc of snap.docs) {
      const o = doc.data();
      console.log(`\n📋 ORDEN ${num}  (id: ${doc.id})`);
      console.log('   adminId:        ', o.adminId || '—');
      console.log('   estado:         ', o.estado);
      console.log('   lugarAtencion:  ', o.lugarAtencion, '| tipoOrden:', o.tipoOrden || '—');
      console.log('   total:          ', fmt(o.total), '| subtotal:', fmt(o.subtotal));
      console.log('   pagado:         ', o.pagado === true, '| montoPagado:', fmt(o.montoPagado));
      console.log('   montoRecaudado: ', fmt(o.montoRecaudado), '| formaPagoRecaudo:', o.formaPagoRecaudo || '—');
      console.log('   formaPago:      ', o.formaPago || '—', '| tipoCobro:', o.tipoCobro || '—');
      console.log('   dineroEnCaja:   ', o.dineroEnCaja === true,
        o.dineroEnCaja === true ? `(${fechaDe(o.dineroEnCajaFecha)} por ${o.dineroEnCajaPor || '?'})` : '');
      console.log('   cuadrado:       ', o.cuadrado === true,
        o.cuadrado === true ? `(${fechaDe(o.fechaCuadre)} por ${o.cuadradoPor || '?'})` : '');
      console.log('   mensajero:      ', o.mensajeroNombre || '—', `(${o.mensajeroId || 'sin id'})`);
      console.log('   fechaCreacion:  ', fechaDe(o.fechaCreacion || o.createdAt));
      console.log('   fechaCompletada:', fechaDe(o.fechaCompletada));
      console.log('   ── Historial de estados:');
      (o.historialEstados || []).forEach(h => {
        console.log(`      · ${fechaDe(h.fecha).slice(0, 16)}  ${h.estado.padEnd(18)} ${h.usuarioNombre || h.usuarioId || ''} ${h.nota || h.notas || ''}`);
      });

      // Movimientos de caja de esta orden
      const movs = await db.collection('movimientos').where('ordenId', '==', doc.id).get();
      if (movs.empty) {
        console.log('   ── Movimientos de caja: ❌ NINGUNO (el dinero nunca entró a una caja)');
      } else {
        console.log(`   ── Movimientos de caja (${movs.size}):`);
        movs.docs.forEach(m => {
          const mv = m.data();
          console.log(`      · [${mv.tipo}] ${fmt(mv.monto)} → caja: ${mv.cajaId}${mv.cajaId === 'sin_asignar' ? '  ⚠️ HUÉRFANO' : ''} | ${fechaDe(mv.createdAt).slice(0, 16)} | ${mv.concepto || ''} ${mv.resuelto ? `| resuelto: ${mv.resolucion}` : ''}`);
        });
      }

      // Registros CxC de esta orden
      const cxcs = await db.collection('cxc').where('ordenId', '==', doc.id).get();
      if (!cxcs.empty) {
        console.log(`   ── Registros CxC (${cxcs.size}):`);
        cxcs.docs.forEach(c => {
          const cx = c.data();
          console.log(`      · ${fmt(cx.monto)} estado: ${cx.estado} | ${fechaDe(cx.fechaCreacion)}`);
        });
      }
    }
  }

  // ── 2. Movimientos huérfanos (sin_asignar) ────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  💸 MOVIMIENTOS SIN CAJA ASIGNADA (dinero huérfano)');
  console.log('══════════════════════════════════════════════════════');
  const huerfanos = await db.collection('movimientos').where('cajaId', '==', 'sin_asignar').get();
  if (huerfanos.empty) {
    console.log('   (ninguno — no hay dinero huérfano)');
  } else {
    let totalHuerfano = 0;
    huerfanos.docs.forEach(m => {
      const mv = m.data();
      const pend = mv.resuelto !== true;
      if (pend && mv.tipo === 'ingreso') totalHuerfano += Number(mv.monto) || 0;
      console.log(`   · [${mv.tipo}] ${fmt(mv.monto)} | ${fechaDe(mv.createdAt).slice(0, 16)} | ref: ${mv.referencia || '—'} | userId: ${mv.userId} | ${pend ? '⚠️ PENDIENTE' : `resuelto: ${mv.resolucion || 'sí'}`}`);
      console.log(`     ${mv.concepto || ''} (id mov: ${m.id})`);
    });
    console.log(`\n   TOTAL INGRESOS HUÉRFANOS PENDIENTES: ${fmt(totalHuerfano)}`);
  }

  // ── 3. Arqueos últimos 15 días ────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  🧾 ARQUEOS (cuadres_historial) — últimos 15 días');
  console.log('══════════════════════════════════════════════════════');
  const corte = new Date(Date.now() - 15 * 24 * 3600000).toISOString();
  const arqueos = await db.collection('cuadres_historial').get();
  const recientes = arqueos.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(a => (a.fecha || '') >= corte)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  if (recientes.length === 0) {
    console.log('   (sin arqueos en los últimos 15 días)');
  } else {
    recientes.forEach(a => {
      console.log(`   · ${fechaDe(a.fecha).slice(0, 16)} | ${a.mensajeroNombre || a.mensajeroId} | esperado: ${fmt(a.efectivoEsperado)} | recibido: ${fmt(a.efectivoRecibido)} | descuadre: ${fmt(a.descuadre)}`);
      (a.ordenesCuadradas || []).forEach(o => console.log(`       - ${o.numeroOrden}: ${fmt(o.monto)}`));
    });
  }

  console.log('\n✅ Diagnóstico terminado (no se modificó ningún dato).');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
