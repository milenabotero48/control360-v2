/**
 * Control360 — FUSIÓN de vencimientos con nombre de equipo GENÉRICO
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  SIMULACIÓN POR DEFECTO. Sin --aplicar no toca absolutamente nada.
 *
 * EL PROBLEMA (VENC-EQUIPO-NORM-001)
 * Cuando la celda de equipo del Excel viene vacía, el importador guarda el
 * literal 'Extintor'. Si otra fila del MISMO cliente sí traía el nombre bueno
 * ("EXTINTOR ABC 5 LBS"), quedan dos documentos que el ojo lee como el mismo
 * equipo repetido, pero que ningún agrupador por cliente+equipo detecta: son
 * cadenas distintas. En la tarjeta de Telemercadeo se ve así:
 *
 *      🧯 Extintor ABC 5 lbs · Oficina · vence 12/02/26
 *      🧯 Extintor           · Oficina · vence 12/02/26
 *
 * `limpiar-duplicados-vencimientos.js` NO los detecta — agrupa por nombre
 * exacto. Por eso hace falta este script aparte.
 *
 * QUÉ HACE
 * Por cada cliente y cada CICLO (mes de vencimiento), si existen a la vez
 * documentos con nombre real y documentos genéricos, los genéricos se
 * consideran la misma máquina mal digitada y se eliminan.
 *
 * QUÉ NUNCA SE TOCA — y por qué importa
 *   · Clientes cuyos vencimientos son TODOS genéricos. Ahí el genérico es el
 *     único dato que hay: borrarlo sería borrar el equipo. Se reportan aparte
 *     para que se corrijan en el Excel, que es donde se arreglan de verdad.
 *   · Documentos con origenDato 'orden': nacen de una orden real y su nombre
 *     salió del ítem facturado.
 *   · Documentos ya gestionados, con estadoCiclo cerrado o con gestión de
 *     telemercadeo encima: tienen historial que no se puede perder.
 *   · Sucursales distintas: dos sedes del mismo cliente son equipos distintos.
 *
 * RESPALDO
 * Con --aplicar se guarda un JSON con los documentos completos ANTES de
 * borrarlos. Con ese archivo se restaura todo si algo sale mal. Guardalo fuera
 * de la carpeta del proyecto.
 *
 * ─── MODOS ───────────────────────────────────────────────────────────────────
 *   node fusionar-equipos-genericos.js --todos
 *   node fusionar-equipos-genericos.js <adminId>
 *   node fusionar-equipos-genericos.js <adminId> --aplicar
 */

require('dotenv').config();
const fs = require('fs');
const { db } = require('./config/firebase');
const cacheVenc = require('./services/vencimientosCache');

const linea = (t = '') => console.log(t);
const titulo = (t) => {
  linea(''); linea('═'.repeat(78)); linea('  ' + t); linea('═'.repeat(78));
};
const sub = (t) => { linea(''); linea('── ' + t + ' ' + '─'.repeat(Math.max(0, 74 - t.length))); };
const num = (n) => String(n).padStart(7, ' ');
const cortar = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n, ' ');
};

// ─────────────────────────────────────────────────────────────────────────────
// MISMA regla que routes/vencimientos.js (VENC-EQUIPO-NORM-001).
// Si se cambia allá, se cambia acá: el script y el importador tienen que
// coincidir o el script borraría cosas que el importador va a volver a crear.
// ─────────────────────────────────────────────────────────────────────────────
const GENERICO = '__GENERICO__';

const claveEquipo = (desc) => {
  let t = String(desc || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // sin tildes: SENAL = SEÑAL
    .toUpperCase();
  t = t.replace(/[^A-Z0-9]+/g, ' ');                     // puntuacion fuera
  // "5LBS" y "5 LBS" son lo mismo; "CO2" y "CO 2" tambien.
  t = t.replace(/(\d)([A-Z])/g, '$1 $2').replace(/([A-Z])(\d)/g, '$1 $2');
  t = t.replace(/\b(?:LIBRAS?|LBS)\b/g, 'LB').replace(/\b(?:KILOS?|KGS)\b/g, 'KG');
  // Palabras que estan en casi todos los registros y no distinguen nada.
  // OJO: EXTINTOR(?:ES)? — escribirlo "EXTINTORES?" haria que el ? aplique
  // solo a la S final, o sea "EXTINTORE" + S opcional, y nunca casaria.
  t = t.replace(/\b(?:EXTINTOR(?:ES)?|RECARGAS?|MANTENIMIENTOS?|DE|DEL|EL|LA)\b/g, ' ');
  t = t.replace(/\b0+(\d)/g, '$1');                      // "05 LB" = "5 LB"
  t = t.replace(/\b0\s*(?:LB|KG)\b/g, ' ');              // "0 LBS" es dato basura
  t = t.replace(/\s+/g, ' ').trim();
  return t || GENERICO;
};

const normSuc = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/\s+/g, ' ').trim();

// Un documento está "protegido" si tiene trabajo humano encima.
const protegido = (v) => {
  if (v.origenDato === 'orden' || v.ordenId) return true;
  if (v.gestionado) return true;
  if (v.estadoCiclo && v.estadoCiclo !== 'EN_TELEMERCADEO') return true;
  const t = v.telemercadeo || {};
  if (t.totalLlamadas || t.sinContacto || t.proximaLlamada || t.compromiso) return true;
  if (v.escaladoTelemercadeo) return true;
  return false;
};

async function listarTenants() {
  const snap = await db.collection('users').get();
  const filas = [];
  snap.docs.forEach(d => {
    const u = d.data();
    const esAdmin = (u.role === 'admin') || (!u.adminId) || (u.adminId === d.id);
    if (!esAdmin) return;
    filas.push({ adminId: d.id, nombre: u.nombre || u.empresa || '(sin nombre)', email: u.email || '—' });
  });
  return filas.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
}

async function analizarTenant(tenant, { aplicar }) {
  const adminId = tenant.adminId;

  const docs = [];
  const snap = await db.collection('vencimientos').where('adminId', '==', adminId).get();
  snap.docs.forEach(d => docs.push({ id: d.id, ref: d.ref, ...d.data() }));

  // Nombres de cliente, solo para que el reporte sea legible
  const idsCli = [...new Set(docs.map(v => v.clienteId).filter(Boolean))];
  const nombreCli = new Map();
  for (let i = 0; i < idsCli.length; i += 300) {
    const refs = idsCli.slice(i, i + 300).map(id => db.collection('clients').doc(id));
    if (!refs.length) break;
    const leidos = await db.getAll(...refs);
    leidos.forEach(d => {
      if (d.exists) nombreCli.set(d.id, d.data().nombre || d.data().empresa || '(sin nombre)');
    });
  }

  // Agrupar por cliente + sucursal + ciclo (mes de vencimiento)
  const grupos = new Map();
  docs.forEach(v => {
    if (!v.clienteId || !v.fechaVencimiento) return;
    const k = [v.clienteId, normSuc(v.sucursal), String(v.fechaVencimiento).slice(0, 7)].join('|');
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(v);
  });

  const aBorrar = [];
  const casos = [];
  let soloGenericos = 0;

  grupos.forEach((lista, k) => {
    const genericos = lista.filter(v => claveEquipo(v.descripcionEquipo) === GENERICO);
    if (!genericos.length) return;

    const conNombre = lista.filter(v => claveEquipo(v.descripcionEquipo) !== GENERICO);
    if (!conNombre.length) {
      // Todo el ciclo es genérico → el dato no existe en ninguna parte.
      // Borrarlo sería borrar el equipo. Se reporta, no se toca.
      soloGenericos += genericos.length;
      return;
    }

    const borrables = genericos.filter(v => !protegido(v));
    if (!borrables.length) return;

    const [clienteId, suc, ciclo] = k.split('|');
    casos.push({
      cliente: nombreCli.get(clienteId) || clienteId,
      sucursal: suc || '—',
      ciclo,
      conservaNombres: [...new Set(conNombre.map(v => v.descripcionEquipo))],
      conserva: conNombre.length,
      elimina: borrables.length,
      protegidos: genericos.length - borrables.length,
    });
    borrables.forEach(v => aBorrar.push(v));
  });

  casos.sort((a, b) => b.elimina - a.elimina);

  sub(tenant.nombre);
  linea(`   Vencimientos totales                  : ${num(docs.length)}`);
  linea(`   Genéricos fusionables (hay nombre real): ${num(aBorrar.length)}`);
  linea(`   Genéricos SIN nombre real en el ciclo  : ${num(soloGenericos)}  ← se corrigen en el Excel, no acá`);

  if (casos.length) {
    sub('Casos detectados (muestra de 15)');
    linea('   cliente · sucursal · ciclo — conserva / elimina');
    casos.slice(0, 15).forEach(c => {
      linea(`   ${cortar(c.cliente, 40)} · ${cortar(c.sucursal, 14)} · ${c.ciclo}`);
      linea(`      conserva ${c.conserva} (${cortar(c.conservaNombres.join(' + '), 60)}), elimina ${c.elimina} genérico(s)`);
    });
  }

  let eliminados = 0;
  if (aplicar && aBorrar.length) {
    const archivo = `respaldo-genericos-${adminId}-${Date.now()}.json`;
    fs.writeFileSync(archivo, JSON.stringify(
      aBorrar.map(({ ref, ...resto }) => resto), null, 2), 'utf8');
    sub('RESPALDO');
    linea(`   ${aBorrar.length} documentos guardados en:`);
    linea(`   ${archivo}`);
    linea('   Guardá ese archivo. Con él se puede restaurar todo lo borrado.');

    sub(`ELIMINANDO ${aBorrar.length} genéricos`);
    for (let i = 0; i < aBorrar.length; i += 400) {
      const lote = aBorrar.slice(i, i + 400);
      const batch = db.batch();
      lote.forEach(v => batch.delete(v.ref));
      await batch.commit();
      eliminados += lote.length;
      process.stdout.write(`\r   ${eliminados}/${aBorrar.length} eliminados`);
    }
    linea('');
    cacheVenc.invalidar(adminId);
    linea(`   ✔ Eliminados: ${eliminados}`);
  }

  return {
    tenant: tenant.nombre, adminId,
    total: docs.length, aBorrar: aBorrar.length, soloGenericos, eliminados, casos,
  };
}

(async () => {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const modo = args.find(a => !a.startsWith('--')) || '--todos';

  titulo(aplicar
    ? '⚠️  BORRADO REAL — SE VAN A ELIMINAR DOCUMENTOS'
    : 'SIMULACIÓN — no se borra nada (agregá --aplicar para ejecutar)');

  if (aplicar) {
    linea('');
    linea('   Empieza en 5 segundos. Ctrl+C para cancelar.');
    await new Promise(r => setTimeout(r, 5000));
  }

  const tenants = await listarTenants();
  const objetivo = ['--todos', '--all'].includes(modo)
    ? tenants
    : tenants.filter(t => t.adminId === modo);

  if (!objetivo.length) {
    console.error(`\nNo existe el suscriptor ${modo}\n`);
    process.exit(1);
  }

  const resultados = [];
  for (const t of objetivo) {
    try { resultados.push(await analizarTenant(t, { aplicar })); }
    catch (e) { linea(`   ✘ ${t.nombre}: ${e.message}`); }
  }

  titulo('TOTALES');
  const tot = (f) => resultados.reduce((s, r) => s + (f(r) || 0), 0);
  linea(`   Genéricos fusionables : ${num(tot(r => r.aBorrar))}`);
  linea(`   Sin nombre en el ciclo: ${num(tot(r => r.soloGenericos))}  ← corregir en el Excel`);
  if (aplicar) linea(`   Eliminados            : ${num(tot(r => r.eliminados))}`);
  else linea('\n   Fue una SIMULACIÓN. Agregá --aplicar para ejecutar.');

  const archivo = `genericos-${aplicar ? 'aplicado' : 'simulacion'}-${Date.now()}.json`;
  fs.writeFileSync(archivo, JSON.stringify({ aplicar, resultados }, null, 2), 'utf8');
  linea('');
  linea(`Detalle en: ${archivo}`);
  linea('');
  process.exit(0);
})().catch(e => { console.error('\nError:', e); process.exit(1); });
