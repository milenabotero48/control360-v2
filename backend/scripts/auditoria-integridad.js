// ============================================================
// Control360 — AUDITORÍA GLOBAL DE INTEGRIDAD DE DINERO (v2)
// Ubicación: backend/scripts/auditoria-integridad.js
// ------------------------------------------------------------
// EJECUTAR (100% READ-ONLY — no modifica NADA):
//   node backend/scripts/auditoria-integridad.js
//   node backend/scripts/auditoria-integridad.js --tenant=UID
//
// v2: los ingresos del CUADRE de mensajero son movimientos AGRUPADOS
// sin ordenId (varias órdenes en un solo movimiento). La v1 no los
// veía y marcaba "fantasma" órdenes cuyo dinero SÍ entró a caja.
// Ahora se cruza contra los arqueos inmutables (cuadres_historial),
// que guardan orden por orden con su monto y caja destino, y contra
// la referencia de los movimientos agrupados.
//
// Categorías:
//   1. LIMBO SIN CUADRE (caso OS-0185): pagada en efectivo, sin
//      ingreso, sin mensajero → nunca habrá cuadre. DINERO PERDIDO DE VISTA.
//   2. FANTASMA EN CAJA: dineroEnCaja=true sin NINGÚN ingreso real
//      (directo, por arqueo ni por referencia). SALDO DE CAJA INCOMPLETO.
//   3. INGRESO DUPLICADO: ingresos (directos + cuadre) > total. INFLADO.
//   4. COBRO SIN CUADRAR viejo (>3 días): dinero en la calle (operativo).
//   5. VIRTUAL SIN VALIDAR viejo (>3 días).
//   6. "PAGADA" CON SALDO PENDIENTE.
// ============================================================

require('dotenv').config();
require('../config/firebase');
const { db } = require('../config/firebase');

const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('es-CO');
const argTenant = process.argv.find(a => a.startsWith('--tenant='));
const TENANT = argTenant ? argTenant.split('=')[1] : null;
const DIAS_VIEJO = 3;
const msViejo = DIAS_VIEJO * 24 * 3600000;
const L = '='.repeat(64);
const l = '-'.repeat(64);

const fechaMs = (v) => {
  if (!v) return 0;
  if (typeof v === 'string') return new Date(v).getTime() || 0;
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (v._seconds) return v._seconds * 1000;
  if (v.seconds) return v.seconds * 1000;
  return 0;
};
const esEfectivo = (o) => {
  const fp = o.formaPagoRecaudo || o.formaPago || '';
  return o.tipoCobro === 'efectivo' || /efectivo/i.test(fp);
};
const esCreditoFp = (fp) => /cr.dito|cxc|fiado/i.test(fp || '');

(async () => {
  console.log(L);
  console.log('  AUDITORIA GLOBAL DE INTEGRIDAD (v2) — READ ONLY');
  console.log('  Fecha:', new Date().toISOString(), TENANT ? `| tenant: ${TENANT}` : '| TODOS los suscriptores');
  console.log(L);

  const [snapOrders, snapMovs, snapCajas, snapArqueos] = await Promise.all([
    TENANT ? db.collection('orders').where('adminId', '==', TENANT).get() : db.collection('orders').get(),
    TENANT ? db.collection('movimientos').where('userId', '==', TENANT).get() : db.collection('movimientos').get(),
    TENANT ? db.collection('cajas').where('userId', '==', TENANT).get() : db.collection('cajas').get(),
    TENANT ? db.collection('cuadres_historial').where('adminId', '==', TENANT).get() : db.collection('cuadres_historial').get()
  ]);
  console.log(`\nOrdenes: ${snapOrders.size} | Movimientos: ${snapMovs.size} | Cajas: ${snapCajas.size} | Arqueos: ${snapArqueos.size}\n`);

  const cajasReales = new Set(snapCajas.docs.map(d => d.id));

  // Ingresos DIRECTOS por orden (movimientos con ordenId hacia cajas reales)
  const ingresosPorOrden = {};
  // Números de orden mencionados en la referencia de ingresos AGRUPADOS (sin ordenId)
  const refsAgrupadas = new Set();
  const huerfanosPorTenant = {};
  snapMovs.forEach(d => {
    const m = d.data();
    if (m.tipo !== 'ingreso') return;
    if (m.cajaId === 'sin_asignar' && m.resuelto !== true) {
      (huerfanosPorTenant[m.userId] = huerfanosPorTenant[m.userId] || []).push(m);
      return;
    }
    if (!cajasReales.has(m.cajaId)) return;
    if (m.ordenId) {
      (ingresosPorOrden[m.ordenId] = ingresosPorOrden[m.ordenId] || []).push({ monto: Number(m.monto) || 0 });
    } else if (m.referencia) {
      // Movimiento agrupado del cuadre: "OS-0001, OS-0002, ..."
      String(m.referencia).split(/[,\s]+/).forEach(tok => { if (tok) refsAgrupadas.add(tok.trim()); });
    }
  });

  // Crédito por ARQUEO: cuadres_historial guarda orden por orden (ordenId + monto)
  const creditoArqueo = {}; // ordenId → suma
  snapArqueos.forEach(d => {
    const a = d.data();
    if (a.anulado === true) return;
    (a.ordenesCuadradas || []).forEach(oc => {
      if (!oc.ordenId) return;
      creditoArqueo[oc.ordenId] = (creditoArqueo[oc.ordenId] || 0) + (Number(oc.monto) || 0);
    });
  });

  const nombreTenant = {};
  const resolverTenant = async (id) => {
    if (nombreTenant[id]) return nombreTenant[id];
    try {
      const u = await db.collection('users').doc(id).get();
      nombreTenant[id] = u.exists ? (u.data().empresa || u.data().nombre || u.data().email || id) : id;
    } catch { nombreTenant[id] = id; }
    return nombreTenant[id];
  };

  const porTenant = {};
  const bucket = (aid) => porTenant[aid] = porTenant[aid] || { limbo: [], fantasma: [], duplicado: [], pendCuadre: [], virtual: [], saldoInc: [], porCuadre: 0 };
  const ahora = Date.now();

  snapOrders.forEach(doc => {
    const o = doc.data();
    if (o.estado === 'anulada') return;
    const aid = o.adminId || 'SIN_ADMIN';
    const total = Math.round(Number(o.total) || 0);
    const pagado = Math.round(Number(o.montoPagado) || 0);
    const directos = (ingresosPorOrden[doc.id] || []).reduce((s, m) => s + m.monto, 0);
    const porArqueo = creditoArqueo[doc.id] || 0;
    const enRefAgrupada = o.numeroOrden && refsAgrupadas.has(o.numeroOrden);
    const cubiertaPorCuadre = porArqueo > 0 || (enRefAgrupada && o.cuadrado === true);
    const sumaIng = directos + porArqueo;
    const info = { num: o.numeroOrden, cliente: o.clienteNombre || '', estado: o.estado, total, pagado, sumaIng, mensajero: o.mensajeroNombre || '' };

    // 1. LIMBO SIN CUADRE (caso OS-0185)
    if ((o.pagado === true || pagado > 0) && esEfectivo(o)
        && o.dineroEnCaja !== true && o.cuadrado !== true
        && directos <= 0 && !cubiertaPorCuadre && !o.mensajeroId
        && !esCreditoFp(o.formaPagoRecaudo)) {
      bucket(aid).limbo.push({ ...info, monto: pagado || Math.round(Number(o.montoRecaudado) || 0) || total });
    }

    // 2. FANTASMA EN CAJA — sin ingreso directo, ni por arqueo, ni agrupado
    if (o.dineroEnCaja === true && directos <= 0 && !cubiertaPorCuadre && !enRefAgrupada
        && (o.pagado === true || pagado > 0) && total > 0) {
      bucket(aid).fantasma.push({ ...info, monto: pagado || total });
    }
    if (o.dineroEnCaja === true && (cubiertaPorCuadre || enRefAgrupada) && directos <= 0) {
      bucket(aid).porCuadre++; // sano: entró por cuadre agrupado (verificado)
    }

    // 3. INGRESO DUPLICADO (directos + arqueo > total, sin conciliar)
    if (sumaIng > total + 1 && total > 0
        && o.ajusteDuplicadoCajaAplicado !== true && o.duplicadoCajaConciliado !== true) {
      bucket(aid).duplicado.push({ ...info, exceso: sumaIng - total, directos, porArqueo });
    }

    // 4. COBRO SIN CUADRAR viejo — dinero en la calle
    const recaudo = Math.round(Number(o.montoRecaudado) || 0);
    if (recaudo > 0 && o.tipoCobro !== 'virtual' && !esCreditoFp(o.formaPagoRecaudo)
        && o.dineroEnCaja !== true && o.cuadrado !== true && o.mensajeroId) {
      const desde = fechaMs(o.fechaPago || o.updatedAt || o.createdAt);
      if (desde && (ahora - desde) > msViejo) {
        bucket(aid).pendCuadre.push({ ...info, monto: recaudo, dias: Math.floor((ahora - desde) / 86400000) });
      }
    }

    // 5. VIRTUAL SIN VALIDAR viejo
    if (o.pagoVirtualPendienteValidar === true && o.pagoValidado !== true) {
      const desde = fechaMs(o.fechaPago || o.updatedAt || o.createdAt);
      if (desde && (ahora - desde) > msViejo) {
        bucket(aid).virtual.push({ ...info, monto: recaudo || total, dias: Math.floor((ahora - desde) / 86400000) });
      }
    }

    // 6. "PAGADA" con saldo pendiente
    if (o.pagado === true && total - pagado > 1) {
      bucket(aid).saldoInc.push({ ...info, saldo: total - pagado });
    }
  });

  const SEC = [
    ['limbo',      '1. LIMBO SIN CUADRE (dinero que NUNCA entrara a caja — caso OS-0185)', 'monto'],
    ['fantasma',   '2. FANTASMA EN CAJA (marcada "en caja" sin ingreso real)', 'monto'],
    ['duplicado',  '3. INGRESO DUPLICADO (saldo de caja inflado)', 'exceso'],
    ['pendCuadre', `4. COBRO SIN CUADRAR hace mas de ${DIAS_VIEJO} dias (dinero en la calle)`, 'monto'],
    ['virtual',    `5. PAGO VIRTUAL SIN VALIDAR hace mas de ${DIAS_VIEJO} dias`, 'monto'],
    ['saldoInc',   '6. "PAGADA" CON SALDO PENDIENTE (bandera inconsistente)', 'saldo']
  ];
  const totGlobal = {};

  for (const aid of Object.keys(porTenant).sort()) {
    const b = porTenant[aid];
    const hay = SEC.some(([k]) => b[k].length > 0) || (huerfanosPorTenant[aid] || []).length > 0;
    if (!hay) {
      if (b.porCuadre > 0) { /* tenant sano, nada que reportar */ }
      continue;
    }
    const nom = await resolverTenant(aid);
    console.log(l);
    console.log(`SUSCRIPTOR: ${nom}  (${aid})`);
    if (b.porCuadre > 0) console.log(`  [OK] ${b.porCuadre} orden(es) verificadas: su dinero SI entro por cuadre agrupado`);
    for (const [key, titulo, campo] of SEC) {
      if (b[key].length === 0) continue;
      const tot = b[key].reduce((s, x) => s + (x[campo] || 0), 0);
      totGlobal[key] = (totGlobal[key] || 0) + tot;
      console.log(`\n  ${titulo} — ${b[key].length} orden(es), ${fmt(tot)}:`);
      b[key].forEach(x => {
        console.log(`     - ${x.num} — ${x.cliente} | ${x.estado} | total ${fmt(x.total)} | pagado ${fmt(x.pagado)} | en caja ${fmt(x.sumaIng)}`
          + (x.exceso ? ` | EXCESO ${fmt(x.exceso)} (directos ${fmt(x.directos)} + cuadre ${fmt(x.porArqueo)})` : '')
          + (x.saldo ? ` | SALDO ${fmt(x.saldo)}` : '')
          + (x.dias ? ` | hace ${x.dias} dias` : '')
          + (x.mensajero ? ` | mensajero: ${x.mensajero}` : ''));
      });
    }
    const hh = huerfanosPorTenant[aid] || [];
    if (hh.length > 0) {
      const tot = hh.reduce((s, m) => s + (Number(m.monto) || 0), 0);
      console.log(`\n  MOVIMIENTOS SIN CAJA ASIGNADA pendientes — ${hh.length}, ${fmt(tot)}:`);
      hh.forEach(m => console.log(`     - ${fmt(m.monto)} | ref ${m.referencia || '-'} | ${m.concepto || ''}`));
    }
    console.log('');
  }

  console.log(L);
  console.log('  RESUMEN GLOBAL');
  console.log(L);
  const okCuadre = Object.values(porTenant).reduce((s, b) => s + b.porCuadre, 0);
  console.log(`  [OK] Ordenes verificadas por cuadre agrupado (dinero SI entro): ${okCuadre}`);
  for (const [key, titulo] of SEC) {
    const n = Object.values(porTenant).reduce((s, b) => s + b[key].length, 0);
    console.log(`  ${titulo.split('(')[0].trim()}: ${n} orden(es) — ${fmt(totGlobal[key] || 0)}`);
  }
  console.log('\n  Acciones sugeridas:');
  console.log('  - Caso 1 -> node backend/scripts/reparar-datos.js --tenant=UID (seccion B)');
  console.log('  - Caso 2 -> revisar una por una (dinero marcado que no consta en ningun lado)');
  console.log('  - Caso 3 -> Revision de pagos en CxC del suscriptor');
  console.log('  - Casos 4 y 5 -> gestion operativa: cuadrar mensajero / validar en tesoreria');
  console.log('  - Caso 6 -> Revision de pagos en CxC (recalcula saldos)');
  console.log('\n[OK] Auditoria terminada (no se modifico ningun dato).');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
