/**
 * Control360 — RECUPERACIÓN RETROACTIVA de vencimientos
 * ─────────────────────────────────────────────────────────────────────────────
 * Reconstruye los vencimientos de las órdenes históricas que nunca los
 * generaron por el bug VENC-CREACION-001 (el disparo exigía estado
 * 'completada' y los flujos con taller nunca pasaban por ahí).
 *
 * ⚠️  SIMULACIÓN POR DEFECTO. Sin --aplicar no escribe absolutamente nada:
 *     recorre, calcula y te muestra qué haría. Nunca se corre a ciegas.
 *
 * ─── MODOS ───────────────────────────────────────────────────────────────────
 *   node recuperar-vencimientos.js --listar
 *       Suscriptores con su adminId.
 *
 *   node recuperar-vencimientos.js <adminId>
 *       SIMULACIÓN de un suscriptor. No escribe.
 *
 *   node recuperar-vencimientos.js <adminId> --aplicar
 *       Ejecuta de verdad sobre ese suscriptor.
 *
 *   node recuperar-vencimientos.js --todos
 *   node recuperar-vencimientos.js --todos --aplicar
 *       Todos los suscriptores.
 *
 * ─── POR QUÉ ES SEGURO ───────────────────────────────────────────────────────
 *   · Reusa crearVencimientosDeOrden, la MISMA función que corre en producción.
 *     No hay una segunda lógica que pueda divergir.
 *   · Esa función es IDEMPOTENTE: si la orden ya tiene vencimientos, no hace
 *     nada. Podés correrlo dos veces sin duplicar.
 *   · La fecha sale de la orden, así que una orden de marzo 2025 genera su
 *     vencimiento en marzo 2026, no en el mes de hoy.
 *   · Salta anuladas, producción e internas.
 *   · Se procesa de la más vieja a la más nueva para que los ciclos queden
 *     en orden cronológico.
 *   · El cierre de ciclos anteriores va APAGADO (escanea 3000 docs por orden).
 *     Después de correr esto, usá el botón "Cerrar ciclos atendidos" del panel,
 *     que hace lo mismo de forma masiva y también tiene su simulación.
 */

require('dotenv').config();
const fs = require('fs');
const { db } = require('./config/firebase');
const {
  crearVencimientosDeOrden,
  esItemConVencimiento,
  vencimientosDeItems, // misma función que usa la escritura real
} = require('./services/vencimientosService');

// ─── Presentación ────────────────────────────────────────────────────────────
const linea = (t = '') => console.log(t);
const titulo = (t) => {
  linea('');
  linea('═'.repeat(78));
  linea('  ' + t);
  linea('═'.repeat(78));
};
const sub = (t) => { linea(''); linea('── ' + t + ' ' + '─'.repeat(Math.max(0, 74 - t.length))); };
const num = (n) => String(n).padStart(7, ' ');
const cortar = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n, ' ');
};

// ─── Mismo criterio de mes que el servicio ───────────────────────────────────
const mesDeFecha = (valor) => {
  if (!valor) return null;
  try {
    if (typeof valor === 'string') {
      const m = valor.match(/^(\d{4})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}`;
      const d = new Date(valor);
      if (!isNaN(d)) return new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
      return null;
    }
    if (typeof valor.toDate === 'function') {
      return new Date(valor.toDate().getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
    }
  } catch (e) { /* ignorar */ }
  return null;
};
const mesDeOrden = (o) =>
  mesDeFecha(o.fecha) || mesDeFecha(o.fechaOrden) || mesDeFecha(o.createdAt) || '(sin fecha)';

const mesVencimientoDe = (yyyymm) => {
  if (!/^\d{4}-\d{2}$/.test(yyyymm)) return '(sin fecha)';
  const [y, m] = yyyymm.split('-').map(Number);
  const total = m + 12;
  const anio = y + Math.floor((total - 1) / 12);
  const mes = ((total - 1) % 12) + 1;
  return `${anio}-${String(mes).padStart(2, '0')}`;
};

// ─── Tenants ─────────────────────────────────────────────────────────────────
async function listarTenants() {
  const snap = await db.collection('users').get();
  const filas = [];
  snap.docs.forEach(d => {
    const u = d.data();
    const esAdmin = (u.role === 'admin') || (!u.adminId) || (u.adminId === d.id);
    if (!esAdmin) return;
    filas.push({
      adminId: d.id,
      nombre: u.nombre || u.empresa || '(sin nombre)',
      email: u.email || '—',
    });
  });
  return filas.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
}

// ─── Recorrido de una colección del tenant ───────────────────────────────────
async function recorrer(coleccion, adminId, porDoc) {
  const snap = await db.collection(coleccion).where('adminId', '==', adminId).get();
  snap.docs.forEach(d => porDoc(d.id, d.data()));
  return snap.size;
}

// ═════════════════════════════════════════════════════════════════════════════
// PROCESAR UN TENANT
// ═════════════════════════════════════════════════════════════════════════════
async function procesarTenant(tenant, { aplicar }) {
  const adminId = tenant.adminId;

  // 1. Órdenes que ya tienen vencimiento (para no reprocesarlas ni contarlas)
  const ordenesConVenc = new Set();
  await recorrer('vencimientos', adminId, (id, v) => {
    if (v.ordenId) ordenesConVenc.add(v.ordenId);
  });

  // 2. Órdenes candidatas
  const candidatas = [];
  const motivos = { anuladas: 0, produccionInterna: 0, sinItems: 0, yaTenian: 0, sinCliente: 0 };
  const totalOrdenes = await recorrer('orders', adminId, (id, o) => {
    const estado = String(o.estado || '').toLowerCase();
    const tipo = String(o.tipoOrden || '').toLowerCase();

    if (tipo === 'produccion' || tipo === 'interna') { motivos.produccionInterna++; return; }
    if (estado === 'anulada') { motivos.anuladas++; return; }

    // Se evalúa por lo que REALMENTE generaría, no por lo que dispara: una
    // orden con solo accesorios sueltos del kit dispara el filtro pero no
    // produce ningún vencimiento, y no debe contarse como candidata.
    const items = Array.isArray(o.items) ? o.items : [];
    if (!vencimientosDeItems(items).length) { motivos.sinItems++; return; }

    if (ordenesConVenc.has(id)) { motivos.yaTenian++; return; }

    const tieneCliente = o.clienteId || o.clienteCelular || o.clienteTelefono;
    if (!tieneCliente) { motivos.sinCliente++; return; }

    candidatas.push({ id, ...o });
  });

  // 3. Orden cronológico: de la más vieja a la más nueva
  candidatas.sort((a, b) => String(mesDeOrden(a)).localeCompare(String(mesDeOrden(b))));

  // 4. Proyección por mes de vencimiento
  const proyeccion = {};
  candidatas.forEach(o => {
    const mv = mesVencimientoDe(mesDeOrden(o));
    proyeccion[mv] = (proyeccion[mv] || 0) + 1;
  });

  linea('');
  linea(`   ${tenant.nombre}`);
  linea(`   Órdenes totales                       : ${num(totalOrdenes)}`);
  linea(`   Ya tenían vencimiento                 : ${num(motivos.yaTenian)}`);
  linea(`   Sin ítems que apliquen                : ${num(motivos.sinItems)}`);
  linea(`   Anuladas (se saltan)                  : ${num(motivos.anuladas)}`);
  linea(`   Producción/internas (se saltan)       : ${num(motivos.produccionInterna)}`);
  linea(`   Sin cliente ni teléfono (se saltan)   : ${num(motivos.sinCliente)}`);
  linea(`   ▶ A RECUPERAR                         : ${num(candidatas.length)}`);

  if (Object.keys(proyeccion).length) {
    sub('Vencimientos que quedarían, por mes');
    Object.keys(proyeccion).sort().forEach(m => linea(`   ${m}   ${num(proyeccion[m])} órdenes`));
  }

  if (!aplicar) {
    if (candidatas.length) {
      sub('Muestra de 15 órdenes que se recuperarían');
      linea('   Se muestran los ítems de la orden (izquierda) y el VENCIMIENTO');
      linea('   que realmente quedaría (derecha). Los componentes del kit de');
      linea('   carretera colapsan en uno solo.');
      candidatas.slice(0, 15).forEach(o => {
        const ms = mesDeOrden(o);
        linea('');
        linea(`   ${cortar(o.numeroOrden || o.id, 12)} ${cortar(o.clienteNombre || '(sin nombre)', 34)} ${ms} → ${mesVencimientoDe(ms)}`);
        (o.items || []).filter(esItemConVencimiento).forEach(i => {
          linea(`        ítem      [${i.categoria || 'SIN CATEGORÍA'}] ${i.nombre || i.descripcion || ''}`);
        });
        vencimientosDeItems(o.items).forEach(v => {
          linea(`        ▶ VENCE   ${v.descripcion} x${v.cantidad}${v.esKit ? '   (kit colapsado)' : ''}`);
        });
      });

      // Lista de los VENCIMIENTOS que quedarían — no de los ítems que
      // disparan. Es lo que de verdad se va a escribir, calculado con la misma
      // función que usa la creación real.
      const cuenta = {};
      candidatas.forEach(o => {
        vencimientosDeItems(o.items).forEach(v => {
          cuenta[v.descripcion] = (cuenta[v.descripcion] || 0) + 1;
        });
      });
      const totalVenc = Object.values(cuenta).reduce((s, n) => s + n, 0);
      sub(`LOS ${totalVenc} VENCIMIENTOS QUE SE CREARÍAN`);
      linea('   Revisá esta lista: si hay algo que NO se recarga, avisá antes');
      linea('   de aplicar. Un vencimiento de más es una llamada de más.');
      linea('');
      Object.entries(cuenta).sort((a, b) => b[1] - a[1])
        .forEach(([k, v]) => linea(`   ${num(v)}  ${k}`));
    }
    return { tenant: tenant.nombre, adminId, aRecuperar: candidatas.length, motivos, proyeccion, creados: 0 };
  }

  // 5. EJECUCIÓN REAL
  sub(`APLICANDO — ${candidatas.length} órdenes`);
  let creados = 0, sinCambio = 0, errores = 0;
  const fallos = [];

  for (let i = 0; i < candidatas.length; i++) {
    const o = candidatas[i];
    try {
      // Misma función que producción. Idempotente. Ciclos apagados a propósito.
      const r = await crearVencimientosDeOrden(adminId, o, { cerrarCiclos: false });
      if (r && r.creados > 0) creados += r.creados; else sinCambio++;
    } catch (e) {
      errores++;
      fallos.push({ orden: o.numeroOrden || o.id, error: e.message });
    }
    if ((i + 1) % 25 === 0 || i === candidatas.length - 1) {
      process.stdout.write(`\r   ${i + 1}/${candidatas.length} procesadas · ${creados} vencimientos creados   `);
    }
  }
  linea('');
  linea(`   ✔ Vencimientos creados : ${num(creados)}`);
  linea(`     Sin cambio           : ${num(sinCambio)}  (idempotencia o sin datos suficientes)`);
  if (errores) {
    linea(`     ✘ Errores            : ${num(errores)}`);
    fallos.slice(0, 10).forEach(f => linea(`        ${f.orden}: ${f.error}`));
  }

  return { tenant: tenant.nombre, adminId, aRecuperar: candidatas.length, motivos, proyeccion, creados, errores };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const modo = args.find(a => a !== '--aplicar') || '--ayuda';

  if (['--ayuda', '--help', '-h'].includes(modo)) {
    linea('');
    linea('  Control360 — Recuperación retroactiva de vencimientos');
    linea('');
    linea('  SIMULACIÓN (no escribe nada):');
    linea('    node recuperar-vencimientos.js --listar');
    linea('    node recuperar-vencimientos.js <adminId>');
    linea('    node recuperar-vencimientos.js --todos');
    linea('');
    linea('  EJECUCIÓN REAL (agregar --aplicar):');
    linea('    node recuperar-vencimientos.js <adminId> --aplicar');
    linea('    node recuperar-vencimientos.js --todos --aplicar');
    linea('');
    process.exit(0);
  }

  if (['--listar', '--list'].includes(modo)) {
    const tenants = await listarTenants();
    titulo(`SUSCRIPTORES — ${tenants.length}`);
    tenants.forEach(t => {
      linea('');
      linea(`   ${t.nombre}`);
      linea(`      email   : ${t.email}`);
      linea(`      adminId : ${t.adminId}`);
    });
    linea('');
    process.exit(0);
  }

  titulo(aplicar
    ? '⚠️  EJECUCIÓN REAL — SE VAN A ESCRIBIR VENCIMIENTOS'
    : 'SIMULACIÓN — no se escribe nada (agregá --aplicar para ejecutar)');

  if (aplicar) {
    linea('');
    linea('   Empieza en 5 segundos. Ctrl+C para cancelar.');
    await new Promise(r => setTimeout(r, 5000));
  }

  const tenants = await listarTenants();
  let objetivo = [];

  if (['--todos', '--all'].includes(modo)) {
    objetivo = tenants;
  } else {
    const t = tenants.find(x => x.adminId === modo);
    if (!t) {
      console.error(`\nNo existe el suscriptor ${modo}`);
      console.error('Corré  node recuperar-vencimientos.js --listar\n');
      process.exit(1);
    }
    objetivo = [t];
  }

  const resultados = [];
  for (const t of objetivo) {
    try {
      resultados.push(await procesarTenant(t, { aplicar }));
    } catch (e) {
      linea(`   ✘ ${t.nombre}: ${e.message}`);
      resultados.push({ tenant: t.nombre, adminId: t.adminId, error: e.message });
    }
  }

  titulo('TOTALES');
  const tot = (f) => resultados.reduce((s, r) => s + (f(r) || 0), 0);
  linea(`   Suscriptores procesados : ${num(resultados.length)}`);
  linea(`   Órdenes a recuperar     : ${num(tot(r => r.aRecuperar))}`);
  if (aplicar) {
    linea(`   Vencimientos creados    : ${num(tot(r => r.creados))}`);
    linea('');
    linea('   SIGUIENTE PASO: en el panel de Vencimientos, botón');
    linea('   "Cerrar ciclos atendidos" — cierra los ciclos viejos de los');
    linea('   clientes que ya volvieron. También tiene simulación previa.');
  } else {
    linea('');
    linea('   Esto fue una SIMULACIÓN. Para ejecutar de verdad:');
    linea(`   node recuperar-vencimientos.js ${modo} --aplicar`);
  }

  const archivo = `recuperacion-vencimientos-${aplicar ? 'aplicado' : 'simulacion'}-${Date.now()}.json`;
  fs.writeFileSync(archivo, JSON.stringify({ aplicar, resultados }, null, 2), 'utf8');
  linea('');
  linea(`Detalle en: ${archivo}`);
  linea('');
  process.exit(0);
})().catch(e => {
  console.error('\nError en la recuperación:', e);
  process.exit(1);
});
