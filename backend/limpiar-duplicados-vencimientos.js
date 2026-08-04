/**
 * Control360 — DUPLICADOS de vencimientos por re-importación
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  SIMULACIÓN POR DEFECTO. Sin --aplicar no borra absolutamente nada.
 *
 * EL PROBLEMA
 * `POST /vencimientos/importar` deduplica el CLIENTE (por teléfono, NIT y
 * nombre) pero no los vencimientos: por cada fila hace siempre
 * `batch.set(db.collection('vencimientos').doc(), ...)`, o sea un documento
 * nuevo. Subir el mismo archivo tres veces = el mismo extintor tres veces.
 *
 * CÓMO SE DISTINGUE UN DUPLICADO DE UN EQUIPO REAL
 * Este es el punto delicado: un cliente PUEDE tener legítimamente 4 extintores
 * "ABC 10 LBS" idénticos. No se puede borrar por "nombre repetido".
 *
 * La señal es CUÁNDO se crearon. Los documentos de una misma importación
 * nacen todos en el mismo instante (mismo lote de Firestore). Entonces:
 *
 *   · Se agrupan por cliente + equipo + fecha de vencimiento + sucursal.
 *   · Dentro del grupo se separan por TANDA (createdAt redondeado al minuto).
 *   · Si hay una sola tanda → son equipos reales, NO se toca nada.
 *   · Si hay varias tandas → hubo re-importación. Se conserva la cantidad de
 *     la tanda MÁS GRANDE (la mejor estimación de cuántos equipos tiene de
 *     verdad) y se elimina el resto.
 *
 * Ejemplo: 3 tandas de 1 equipo cada una → se conserva 1, se borran 2.
 *          2 tandas de 4 equipos cada una → se conservan 4, se borran 4.
 *
 * QUÉ NUNCA SE TOCA
 *   · Vencimientos con origenDato 'orden': nacen de una orden real y ya son
 *     idempotentes por ordenId.
 *   · Vencimientos ya gestionados o con estadoCiclo (RENOVADO / PERDIDO):
 *     tienen historial de gestión encima.
 *   · Grupos de una sola tanda.
 *
 * ─── MODOS ───────────────────────────────────────────────────────────────────
 *   node limpiar-duplicados-vencimientos.js --todos
 *   node limpiar-duplicados-vencimientos.js <adminId>
 *   node limpiar-duplicados-vencimientos.js <adminId> --aplicar
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

const normalizar = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

const msDe = (v) => {
  const c = v.createdAt;
  if (c && typeof c.toDate === 'function') return c.toDate().getTime();
  if (typeof c === 'string') { const d = new Date(c); if (!isNaN(d)) return d.getTime(); }
  return null;
};

// ⚠️ CORRECCIÓN IMPORTANTE
// La primera versión agrupaba por MINUTO, y eso está mal: el importador acepta
// hasta 2000 filas y commitea en lotes de 400, así que UNA sola importación
// perfectamente puede cruzar el cambio de minuto. Con la regla anterior, las
// dos mitades de una misma importación parecían dos importaciones distintas y
// el script proponía borrar la mitad de datos BUENOS.
//
// Ahora las tandas se agrupan por CERCANÍA: documentos separados por menos de
// VENTANA_MS pertenecen a la misma corrida. Solo un hueco grande de tiempo
// delata una re-importación de verdad.
const VENTANA_MS = Number(process.env.VENC_VENTANA_MIN || 10) * 60 * 1000;

// Agrupa una lista de docs en corridas por proximidad temporal.
const agruparEnCorridas = (lista) => {
  const conFecha = lista.map(v => ({ v, ms: msDe(v) })).filter(x => x.ms != null);
  const sinFecha = lista.filter(v => msDe(v) == null);
  conFecha.sort((a, b) => a.ms - b.ms);

  const corridas = [];
  let actual = null;
  conFecha.forEach(({ v, ms }) => {
    if (!actual || ms - actual.fin > VENTANA_MS) {
      actual = { inicio: ms, fin: ms, docs: [v] };
      corridas.push(actual);
    } else {
      actual.fin = ms;
      actual.docs.push(v);
    }
  });
  if (sinFecha.length) corridas.push({ inicio: null, fin: null, docs: sinFecha });
  return corridas;
};

const etiquetaCorrida = (c) => {
  if (c.inicio == null) return 'sin fecha';
  const ini = new Date(c.inicio).toISOString().slice(0, 16).replace('T', ' ');
  const durSeg = Math.round((c.fin - c.inicio) / 1000);
  return `${ini} (${c.docs.length} docs, ${durSeg}s)`;
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

  // 1. Traer todos los vencimientos del tenant
  const docs = [];
  const snap = await db.collection('vencimientos').where('adminId', '==', adminId).get();
  snap.docs.forEach(d => docs.push({ id: d.id, ref: d.ref, ...d.data() }));

  // 2. Nombres de cliente para el reporte
  const idsCli = [...new Set(docs.map(v => v.clienteId).filter(Boolean))];
  const nombreCli = new Map();
  for (let i = 0; i < idsCli.length; i += 300) {
    const refs = idsCli.slice(i, i + 300).map(id => db.collection('clients').doc(id));
    if (!refs.length) break;
    const res = await db.getAll(...refs);
    res.forEach(d => { if (d.exists) nombreCli.set(d.id, d.data().nombre || '(sin nombre)'); });
  }

  // 3. Agrupar por cliente + equipo + vencimiento + sucursal
  const grupos = new Map();
  let protegidos = 0;
  docs.forEach(v => {
    // Nunca se tocan: los que vienen de una orden, ni los ya gestionados.
    if ((v.origenDato || '') === 'orden') { protegidos++; return; }
    if (v.gestionado === true || v.estadoCiclo) { protegidos++; return; }
    if (!v.clienteId) { protegidos++; return; }

    // Se agrupa por MES de vencimiento, no por fecha exacta: entre versiones
    // del mismo archivo la fecha del mismo equipo baila (07-01 vs 07-05) y con
    // la fecha exacta nunca se reconocían como el mismo.
    const clave = [
      v.clienteId,
      normalizar(v.descripcionEquipo),
      (v.fechaVencimiento || 'sin_fecha').slice(0, 7),
      normalizar(v.sucursal),
    ].join('|');
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(v);
  });

  // 4. Detectar re-importaciones dentro de cada grupo
  const aBorrar = [];
  const detalle = [];
  grupos.forEach((lista, clave) => {
    if (lista.length < 2) return;

    const corridas = agruparEnCorridas(lista);

    // Una sola corrida = son equipos reales del cliente. No se toca.
    if (corridas.length < 2) return;

    // ⚠️ CUÁNTOS EQUIPOS TIENE DE VERDAD
    // Una reimportación solo puede AGREGAR copias, nunca quitarlas. Entonces
    // la corrida con MENOS documentos es la mejor estimación de la cantidad
    // real. Conservar la más grande era el error: en Valle la corrida de las
    // 16:20 traía el archivo con filas repetidas dentro de sí mismo, así que
    // "la más grande" conservaba justo la peor (44 en vez de 22).
    const cantidadReal = Math.min(...corridas.map(c => c.docs.length));

    // De todas las copias se conservan las MEJOR DESCRITAS: una fila que quedó
    // como "Extintor" genérico o con "0 lbs" es dato malo del archivo, y si hay
    // una versión con la descripción completa, esa es la que debe quedar.
    const calidad = (v) => {
      const d = normalizar(v.descripcionEquipo);
      let p = 0;
      if (d && d !== 'EXTINTOR') p += 2;        // descripción real
      if (!/\b0\s*LBS?\b/.test(d)) p += 1;      // sin el "0 lbs" malo
      if (v.fechaUltimaRecarga) p += 1;         // trae fecha de servicio
      return p;
    };
    const ordenados = [...lista].sort((a, b) => {
      const dif = calidad(b) - calidad(a);
      if (dif !== 0) return dif;
      return (msDe(a) || 0) - (msDe(b) || 0);   // a igual calidad, el más viejo
    });

    const conservar = ordenados.slice(0, cantidadReal);
    const eliminar = ordenados.slice(cantidadReal);
    if (!eliminar.length) return;

    eliminar.forEach(v => aBorrar.push(v));
    const [clienteId, equipo, fechaVencimiento] = clave.split('|');
    detalle.push({
      cliente: nombreCli.get(clienteId) || clienteId,
      equipo,
      fechaVencimiento,
      total: lista.length,
      tandas: corridas
        .slice()
        .sort((a, b) => (a.inicio || 0) - (b.inicio || 0))
        .map(etiquetaCorrida),
      conserva: conservar.length,
      elimina: eliminar.length,
    });
  });

  linea('');
  linea(`   ${tenant.nombre}`);
  linea(`   Vencimientos totales                  : ${num(docs.length)}`);
  linea(`   Protegidos (de orden o ya gestionados): ${num(protegidos)}`);
  linea(`   Grupos con re-importación detectada   : ${num(detalle.length)}`);
  linea(`   ▶ DUPLICADOS A ELIMINAR               : ${num(aBorrar.length)}`);

  if (detalle.length) {
    sub('Casos detectados (muestra de 20)');
    linea('   cliente · equipo — tandas de importación → conserva / elimina');
    detalle
      .sort((a, b) => b.elimina - a.elimina)
      .slice(0, 20)
      .forEach(d => {
        linea('');
        linea(`   ${cortar(d.cliente, 40)} · ${d.equipo}`);
        linea(`      tandas: ${d.tandas.join('  |  ')}`);
        linea(`      conserva ${d.conserva}, elimina ${d.elimina}`);
      });
  }

  if (!aplicar) {
    return { tenant: tenant.nombre, adminId, total: docs.length, aBorrar: aBorrar.length, grupos: detalle.length, eliminados: 0 };
  }

  // 5. RESPALDO antes de borrar — Firestore no tiene papelera.
  // Se guarda el contenido COMPLETO de cada documento, así que si algo sale
  // mal se pueden recrear tal cual. Sin esto, un borrado masivo mal calculado
  // sería irreversible.
  const respaldo = aBorrar.map(v => {
    const { ref, ...datos } = v;
    return datos;
  });
  const archivoRespaldo = `respaldo-eliminados-${adminId}-${Date.now()}.json`;
  fs.writeFileSync(archivoRespaldo, JSON.stringify(respaldo, null, 2), 'utf8');
  sub('RESPALDO');
  linea(`   ${respaldo.length} documentos guardados en:`);
  linea(`   ${archivoRespaldo}`);
  linea('   Guardá ese archivo. Con él se puede restaurar todo lo borrado.');

  // 6. Borrado real
  sub(`ELIMINANDO ${aBorrar.length} duplicados`);
  let eliminados = 0;
  for (let i = 0; i < aBorrar.length; i += 450) {
    const batch = db.batch();
    aBorrar.slice(i, i + 450).forEach(v => { batch.delete(v.ref); eliminados++; });
    await batch.commit();
    process.stdout.write(`\r   ${eliminados}/${aBorrar.length} eliminados   `);
  }
  linea('');
  if (eliminados) cacheVenc.invalidar(adminId);
  linea(`   ✔ Eliminados: ${eliminados}`);

  return { tenant: tenant.nombre, adminId, total: docs.length, aBorrar: aBorrar.length, grupos: detalle.length, eliminados };
}

// ═════════════════════════════════════════════════════════════════════════════
// INSPECCIÓN de un cliente: los timestamps crudos, al segundo.
// Es lo que decide si dos tandas contiguas son una importación partida por el
// cambio de minuto o dos importaciones distintas. No se borra sobre una
// heurística sin haber mirado esto.
// ═════════════════════════════════════════════════════════════════════════════
const soloDigitos = (s) => String(s || '').replace(/\D/g, '');

// Busca por NOMBRE o por TELÉFONO. Si el texto es mayormente numérico se
// interpreta como teléfono: el panel agrupa las tarjetas por
// `clienteId || telefono`, así que a veces la pregunta correcta es
// "¿qué hay colgado de este número?" y no "¿qué tiene este cliente?".
async function inspeccionarCliente(adminId, texto) {
  const snapCli = await db.collection('clients').where('adminId', '==', adminId).get();
  const digitos = soloDigitos(texto);
  const esTelefono = digitos.length >= 7 && digitos.length >= texto.replace(/\s/g, '').length - 2;

  if (esTelefono) {
    const clave = digitos.slice(-10);
    titulo(`BÚSQUEDA POR TELÉFONO ${clave}`);

    const cliCoinciden = snapCli.docs.filter(d => {
      const c = d.data();
      return soloDigitos(c.celular).slice(-10) === clave
          || soloDigitos(c.telefono).slice(-10) === clave;
    });
    sub(`Clientes con ese teléfono: ${cliCoinciden.length}`);
    cliCoinciden.forEach(d => linea(`   ${cortar(d.data().nombre, 45)}  id=${d.id}`));
    if (cliCoinciden.length > 1) {
      linea('');
      linea('   ⚠️  CLIENTES DUPLICADOS: el mismo número en varias fichas.');
    }

    const snapV = await db.collection('vencimientos').where('adminId', '==', adminId).get();
    const idsCoinciden = new Set(cliCoinciden.map(d => d.id));
    const vencs = snapV.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(v => soloDigitos(v.telefono).slice(-10) === clave || idsCoinciden.has(v.clienteId));

    sub(`Vencimientos colgados de ese número: ${vencs.length}`);
    vencs.sort((a, b) => (msDe(a) || 0) - (msDe(b) || 0));
    vencs.forEach(v => {
      const ms = msDe(v);
      const t = ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : 'sin fecha';
      linea(`   ${t}  ${cortar(v.descripcionEquipo, 30)}  ${v.fechaVencimiento || ''}  cli=${cortar(v.clienteId || 'NULO', 22)} [${v.origenDato || '?'}]`);
    });

    const porCliente = {};
    vencs.forEach(v => { const k = v.clienteId || 'SIN CLIENTE'; porCliente[k] = (porCliente[k] || 0) + 1; });
    sub('Agrupados por clienteId (así los junta el panel)');
    Object.entries(porCliente).forEach(([k, n]) => {
      const nom = cliCoinciden.find(d => d.id === k);
      linea(`   ${num(n)}  ${k}  ${nom ? nom.data().nombre : ''}`);
    });
    return;
  }

  const objetivo = snapCli.docs.filter(d =>
    normalizar(d.data().nombre).includes(normalizar(texto)));

  if (!objetivo.length) { linea(`   No se encontró ningún cliente con "${texto}"`); return; }

  for (const cli of objetivo.slice(0, 5)) {
    const snap = await db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .where('clienteId', '==', cli.id)
      .get();

    titulo(`${cli.data().nombre} — ${snap.size} vencimientos`);
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => (msDe(a) || 0) - (msDe(b) || 0));

    let previo = null;
    docs.forEach(v => {
      const ms = msDe(v);
      const t = ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : 'sin fecha';
      const gap = (ms && previo) ? `  +${Math.round((ms - previo) / 1000)}s` : '';
      linea(`   ${t}${gap.padEnd(10)}  ${cortar(v.descripcionEquipo, 32)}  ${v.fechaVencimiento || ''}  [${v.origenDato || '?'}]`);
      if (ms) previo = ms;
    });

    const corridas = agruparEnCorridas(docs);
    sub(`Corridas detectadas (ventana de ${VENTANA_MS / 60000} min): ${corridas.length}`);
    corridas.forEach(c => linea(`   ${etiquetaCorrida(c)}`));
    linea('');
    linea(corridas.length > 1
      ? '   → Varias corridas separadas: hubo re-importación.'
      : '   → Una sola corrida: los registros vienen del MISMO archivo.');

    // ── Por qué el panel puede mostrar MÁS equipos de los que tiene el cliente
    // El acordeón agrupa con `clienteId || telefono`. Los vencimientos SIN
    // clienteId que comparten teléfono caen en la misma tarjeta y se ven como
    // equipos de este cliente aunque no le pertenezcan.
    const tel = String(cli.data().celular || cli.data().telefono || '').replace(/\D/g, '').slice(-10);
    if (tel) {
      const todos = await db.collection('vencimientos').where('adminId', '==', adminId).get();
      const mismosTel = todos.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(v => v.clienteId !== cli.id
          && String(v.telefono || '').replace(/\D/g, '').slice(-10) === tel);

      sub(`Otros vencimientos con el MISMO teléfono (${tel}) pero otro clienteId: ${mismosTel.length}`);
      if (!mismosTel.length) {
        linea('   Ninguno. La tarjeta del panel debería mostrar solo los de arriba.');
      } else {
        linea('   Estos se mezclan en la misma tarjeta del acordeón:');
        linea('');
        mismosTel.slice(0, 30).forEach(v => {
          const ms = msDe(v);
          const t = ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : 'sin fecha';
          linea(`   ${t}  ${cortar(v.descripcionEquipo, 30)}  ${v.fechaVencimiento || ''}  clienteId=${v.clienteId || 'NULO'}  [${v.origenDato || '?'}]`);
        });
        const sinCliente = mismosTel.filter(v => !v.clienteId).length;
        const otroCliente = mismosTel.length - sinCliente;
        linea('');
        linea(`   Sin clienteId : ${sinCliente}   → se pegan a esta tarjeta por teléfono`);
        linea(`   Otro clienteId: ${otroCliente}   → CLIENTE DUPLICADO con el mismo teléfono`);
      }
    }
  }
}

(async () => {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');

  // --corridas <adminId> → inventario de importaciones del suscriptor
  // Cuántos vencimientos dejó cada tanda, cuántos clientes tocó y qué calidad
  // traía el archivo. Es la foto que hace falta para decidir cuál conservar.
  if (args[0] === '--corridas') {
    const adminId = args[1];
    if (!adminId) {
      console.error('\nUso: node limpiar-duplicados-vencimientos.js --corridas <adminId>\n');
      process.exit(1);
    }
    const snap = await db.collection('vencimientos').where('adminId', '==', adminId).get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const importados = docs.filter(v => (v.origenDato || '') !== 'orden');

    titulo(`IMPORTACIONES — ${docs.length} vencimientos (${importados.length} importados)`);

    const corridas = agruparEnCorridas(importados);
    corridas.sort((a, b) => (a.inicio || 0) - (b.inicio || 0));

    linea('');
    linea('   fecha y hora        docs   clientes   genéricos   "0 lbs"   gestionados');
    linea('   ' + '─'.repeat(70));
    corridas.forEach(c => {
      const clientes = new Set(c.docs.map(v => v.clienteId || v.telefono)).size;
      const genericos = c.docs.filter(v => normalizar(v.descripcionEquipo) === 'EXTINTOR').length;
      const ceroLbs = c.docs.filter(v => /0\s*LBS?/.test(normalizar(v.descripcionEquipo))).length;
      const gest = c.docs.filter(v => v.gestionado === true || v.estadoCiclo).length;
      const t = c.inicio ? new Date(c.inicio).toISOString().slice(0, 16).replace('T', ' ') : 'sin fecha';
      linea(`   ${t}  ${String(c.docs.length).padStart(6)}  ${String(clientes).padStart(9)}  ${String(genericos).padStart(10)}  ${String(ceroLbs).padStart(8)}  ${String(gest).padStart(11)}`);
    });
    linea('');
    linea('   genéricos  = descripción quedó en "Extintor" (la fila venía sin equipo)');
    linea('   "0 lbs"    = dato malo en el archivo');
    linea('   gestionados= ya tienen trabajo comercial encima: NO se deberían borrar');
    linea('');
    process.exit(0);
  }

  // --buscar "<nombre o teléfono>"  → barre TODOS los suscriptores
  if (args[0] === '--buscar') {
    const texto = args.slice(1).join(' ');
    if (!texto) {
      console.error('\nUso: node limpiar-duplicados-vencimientos.js --buscar "NOMBRE o TELEFONO"\n');
      process.exit(1);
    }
    const digitos = soloDigitos(texto);
    const porTel = digitos.length >= 7;
    const clave = porTel ? digitos.slice(-10) : normalizar(texto);

    titulo(`BÚSQUEDA GLOBAL: "${texto}"  (${porTel ? 'teléfono' : 'nombre'})`);
    const tenants = await listarTenants();

    for (const t of tenants) {
      const snapCli = await db.collection('clients').where('adminId', '==', t.adminId).get();
      const hallados = snapCli.docs.filter(d => {
        const c = d.data();
        return porTel
          ? (soloDigitos(c.celular).slice(-10) === clave || soloDigitos(c.telefono).slice(-10) === clave)
          : normalizar(c.nombre).includes(clave);
      });
      if (!hallados.length) continue;

      sub(`${t.nombre} — ${hallados.length} ficha(s)`);
      for (const d of hallados) {
        const c = d.data();
        const snapV = await db.collection('vencimientos')
          .where('adminId', '==', t.adminId)
          .where('clienteId', '==', d.id).get();
        linea('');
        linea(`   ${c.nombre}`);
        linea(`      id       : ${d.id}`);
        linea(`      celular  : ${c.celular || '—'}    telefono: ${c.telefono || '—'}`);
        linea(`      vencimientos: ${snapV.size}`);
        snapV.docs
          .map(x => ({ id: x.id, ...x.data() }))
          .sort((a, b) => (msDe(a) || 0) - (msDe(b) || 0))
          .forEach(v => {
            const ms = msDe(v);
            const ts = ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : 'sin fecha';
            linea(`         ${ts}  ${cortar(v.descripcionEquipo, 30)}  ${v.fechaVencimiento || ''}  [${v.origenDato || '?'}]`);
          });
      }
      if (hallados.length > 1) {
        linea('');
        linea('   ⚠️  Varias fichas para lo mismo: CLIENTES DUPLICADOS.');
      }
    }
    linea('');
    process.exit(0);
  }

  // --cliente <adminId> "<texto>"
  if (args[0] === '--cliente') {
    const adminId = args[1];
    const texto = args.slice(2).join(' ');
    if (!adminId || !texto) {
      console.error('\nUso: node limpiar-duplicados-vencimientos.js --cliente <adminId> "NOMBRE"\n');
      process.exit(1);
    }
    await inspeccionarCliente(adminId, texto);
    linea('');
    process.exit(0);
  }

  const modo = args.find(a => a !== '--aplicar') || '--ayuda';

  if (['--ayuda', '--help', '-h'].includes(modo)) {
    linea('');
    linea('  Control360 — Limpieza de vencimientos duplicados por re-importación');
    linea('');
    linea('  SIMULACIÓN (no borra nada):');
    linea('    node limpiar-duplicados-vencimientos.js --todos');
    linea('    node limpiar-duplicados-vencimientos.js <adminId>');
    linea('');
    linea('  BORRADO REAL:');
    linea('    node limpiar-duplicados-vencimientos.js <adminId> --aplicar');
    linea('');
    process.exit(0);
  }

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
  linea(`   Duplicados detectados : ${num(tot(r => r.aBorrar))}`);
  if (aplicar) linea(`   Eliminados            : ${num(tot(r => r.eliminados))}`);
  else linea('\n   Fue una SIMULACIÓN. Agregá --aplicar para ejecutar.');

  const archivo = `duplicados-vencimientos-${aplicar ? 'aplicado' : 'simulacion'}-${Date.now()}.json`;
  fs.writeFileSync(archivo, JSON.stringify({ aplicar, resultados }, null, 2), 'utf8');
  linea('');
  linea(`Detalle en: ${archivo}`);
  linea('');
  process.exit(0);
})().catch(e => { console.error('\nError:', e); process.exit(1); });
