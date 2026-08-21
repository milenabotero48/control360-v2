/**
 * Control360 — DIAGNÓSTICO de pasos de taller duplicados (TALLER-IDEMP-001)
 * ─────────────────────────────────────────────────────────────────────────────
 * 100% SOLO LECTURA. No escribe, no borra, no actualiza nada en Firestore.
 * Lo único que escribe es un archivo .json local con el reporte.
 * Puede correrse en producción sin riesgo y las veces que quieras.
 *
 * ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────────
 * Hasta el fix TALLER-IDEMP-001, POST /workshop/ordenes/:id/paso usaba
 * arrayUnion(registro) con `fecha` y `tecnicoId` dentro del objeto. Como cada
 * llamada generaba un objeto distinto, arrayUnion NUNCA deduplicaba: procesar
 * dos veces el mismo equipo escribía el paso dos veces Y descontaba los
 * insumos dos veces.
 *
 * El bug de sincronización de la UI (TALLER-SYNC-001) hacía justamente que el
 * técnico reprocesara equipos que la pantalla había devuelto a "pendiente".
 * Este script mide cuánto insumo se descontó de más por esa vía.
 *
 * ─── MODOS ───────────────────────────────────────────────────────────────────
 *   node diagnostico-pasos-taller.js --listar
 *       Lista los suscriptores (tenants) con su adminId y correo.
 *
 *   node diagnostico-pasos-taller.js --todos
 *       Recorre TODOS los suscriptores. Es el modo para responder
 *       "¿esto le está pasando a todos o solo a mí?".
 *
 *   node diagnostico-pasos-taller.js <adminId>
 *   node diagnostico-pasos-taller.js --email correo@suscriptor.com
 *       Detalle de un solo suscriptor, con las órdenes afectadas.
 *
 * ─── QUÉ MIDE ────────────────────────────────────────────────────────────────
 *   A. Órdenes con pasos repetidos (mismo pasoId más de una vez)
 *   B. Insumo descontado de más, por insumo, en unidades
 *   C. Pasos con el pasoId roto de versiones viejas ("equipo_undefined",
 *      "equipo_sinqr_undefined_undefined") — indetectables como duplicado
 *   D. Órdenes cerradas con menos pasos que equipos de taller (posible
 *      completado prematuro por el bug de la carrera)
 */

require('dotenv').config();
const fs = require('fs');
const { db } = require('./config/firebase');

// routes/workshop.js — qué ítems van al taller. Réplica del filtro de front
// (esItemTallerFront en GestionTaller.js). Si cambia allá, cambiar aquí.
const CATEGORIAS_TALLER = [
  'recarga', 'mantenimiento', 'prueba hidrostatica',
  'prueba hidrostática', 'hidrostatica', 'hidrostática'
];
const esItemTaller = (item = {}) => {
  const cat = (item.categoria || '').toLowerCase();
  return CATEGORIAS_TALLER.some(c => cat.includes(c));
};

// pasoIds que las versiones viejas generaban mal: todos los equipos sin QR
// caían en la misma clave, así que ni siquiera se pueden contar como
// duplicados "de un mismo equipo" — son un revoltijo.
const PASO_ID_ROTO = (id) =>
  !id ||
  id === 'equipo_undefined' ||
  String(id).includes('undefined');

const args = process.argv.slice(2);
const modo = args[0] || '--listar';

// ─────────────────────────────────────────────────────────────────────────────
// Misma definición de "tenant" que diagnostico-vencimientos.js: un tenant es
// un admin — los usuarios operativos cuelgan de un adminId ajeno. Se replica
// en vez de importarse para que el script corra aislado, igual que los otros
// diagnósticos del backend.
const listarTenants = async () => {
  const snap = await db.collection('users').get();
  const filas = [];
  snap.docs.forEach(d => {
    const u = d.data();
    const esAdmin = (u.role === 'admin') || (!u.adminId) || (u.adminId === d.id);
    if (!esAdmin) return;
    filas.push({
      adminId: d.id,
      email: u.email || '(sin email)',
      nombre: u.nombre || u.empresa || ''
    });
  });
  filas.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
  return filas;
};

// ─────────────────────────────────────────────────────────────────────────────
const auditarTenant = async (adminId, etiqueta = '') => {
  const snap = await db.collection('orders').where('adminId', '==', adminId).get();

  const reporte = {
    adminId,
    etiqueta,
    ordenesRevisadas: snap.size,
    ordenesConPasos: 0,
    ordenesConDuplicados: [],
    ordenesConPasoIdRoto: [],
    ordenesCerradasIncompletas: [],
    insumoDescontadoDeMas: {},   // insumoNombre -> unidades
    totalPasos: 0,
    totalPasosDuplicados: 0
  };

  snap.forEach(doc => {
    const o = doc.data();
    const pasos = Array.isArray(o.tallerPasos) ? o.tallerPasos : [];
    if (pasos.length === 0) return;
    reporte.ordenesConPasos++;
    reporte.totalPasos += pasos.length;

    // ── A. pasoIds repetidos ────────────────────────────────────────────
    const conteo = new Map();
    pasos.forEach(p => {
      const id = p?.pasoId;
      conteo.set(id, (conteo.get(id) || 0) + 1);
    });

    const repetidos = [...conteo.entries()].filter(([id, n]) => n > 1 && !PASO_ID_ROTO(id));
    const rotos = [...conteo.entries()].filter(([id]) => PASO_ID_ROTO(id));

    if (repetidos.length > 0) {
      const extras = repetidos.reduce((acc, [, n]) => acc + (n - 1), 0);
      reporte.totalPasosDuplicados += extras;
      reporte.ordenesConDuplicados.push({
        ordenId: doc.id,
        numeroOrden: o.numeroOrden || '(sin número)',
        cliente: o.clienteNombre || '',
        estado: o.estado || '',
        pasosExtra: extras,
        detalle: repetidos.map(([id, n]) => ({ pasoId: id, veces: n }))
      });

      // ── B. insumo descontado de más ───────────────────────────────────
      // Por cada repetición extra, los insumos de ESE paso se descontaron
      // una vez de más. Se toma la segunda aparición en adelante.
      repetidos.forEach(([id]) => {
        const delMismo = pasos.filter(p => p?.pasoId === id);
        delMismo.slice(1).forEach(p => {
          (p.insumosUsados || []).forEach(ins => {
            if (!ins?.insumoNombre && !ins?.insumoId) return;
            const clave = ins.insumoNombre || ins.insumoId;
            const cant = Number(ins.cantidad) || 0;
            if (cant <= 0) return;
            reporte.insumoDescontadoDeMas[clave] =
              (reporte.insumoDescontadoDeMas[clave] || 0) + cant;
          });
        });
      });
    }

    // ── C. pasoIds rotos de versiones viejas ────────────────────────────
    if (rotos.length > 0) {
      const total = rotos.reduce((acc, [, n]) => acc + n, 0);
      reporte.ordenesConPasoIdRoto.push({
        ordenId: doc.id,
        numeroOrden: o.numeroOrden || '(sin número)',
        cliente: o.clienteNombre || '',
        pasosSinIdentidad: total,
        ids: rotos.map(([id, n]) => ({ pasoId: id, veces: n }))
      });
    }

    // ── D. órdenes cerradas con menos pasos que equipos ──────────────────
    const equiposTaller = (o.items || [])
      .filter(esItemTaller)
      .reduce((acc, it) => acc + (it.cantidad || 1), 0);
    const pasosUnicos = new Set(pasos.map(p => p?.pasoId).filter(id => !PASO_ID_ROTO(id))).size;
    const cerrada = !!o.tallerCompletado ||
      ['completada', 'facturada', 'entregada', 'cerrada'].includes((o.estado || '').toLowerCase());

    if (cerrada && equiposTaller > 0 && pasosUnicos < equiposTaller) {
      reporte.ordenesCerradasIncompletas.push({
        ordenId: doc.id,
        numeroOrden: o.numeroOrden || '(sin número)',
        cliente: o.clienteNombre || '',
        estado: o.estado || '',
        equiposDeTaller: equiposTaller,
        pasosRegistrados: pasosUnicos,
        faltantes: equiposTaller - pasosUnicos
      });
    }
  });

  return reporte;
};

// ─────────────────────────────────────────────────────────────────────────────
const imprimirResumen = (r) => {
  const linea = '─'.repeat(72);
  console.log('\n' + linea);
  console.log(`TENANT ${r.adminId}${r.etiqueta ? '  ·  ' + r.etiqueta : ''}`);
  console.log(linea);
  console.log(`  Órdenes revisadas ............... ${r.ordenesRevisadas}`);
  console.log(`  Con pasos de taller ............. ${r.ordenesConPasos}`);
  console.log(`  Pasos registrados ............... ${r.totalPasos}`);
  console.log(`  Pasos DUPLICADOS (de más) ....... ${r.totalPasosDuplicados}`);
  console.log(`  Órdenes con duplicados .......... ${r.ordenesConDuplicados.length}`);
  console.log(`  Órdenes con pasoId roto (viejo) . ${r.ordenesConPasoIdRoto.length}`);
  console.log(`  Órdenes cerradas incompletas .... ${r.ordenesCerradasIncompletas.length}`);

  const insumos = Object.entries(r.insumoDescontadoDeMas).sort((a, b) => b[1] - a[1]);
  if (insumos.length > 0) {
    console.log('\n  INSUMO DESCONTADO DE MÁS:');
    insumos.forEach(([nombre, cant]) => console.log(`    · ${nombre}: ${cant}`));
  } else {
    console.log('\n  Sin insumo descontado de más por esta vía.');
  }

  if (r.ordenesConDuplicados.length > 0) {
    console.log('\n  ÓRDENES AFECTADAS (primeras 10):');
    r.ordenesConDuplicados.slice(0, 10).forEach(o =>
      console.log(`    · ${o.numeroOrden} — ${o.cliente} — ${o.pasosExtra} paso(s) de más [${o.estado}]`));
    if (r.ordenesConDuplicados.length > 10) {
      console.log(`    … y ${r.ordenesConDuplicados.length - 10} más (ver el .json)`);
    }
  }

  if (r.ordenesCerradasIncompletas.length > 0) {
    console.log('\n  ⚠️  CERRADAS CON EQUIPOS SIN PROCESAR (primeras 10):');
    r.ordenesCerradasIncompletas.slice(0, 10).forEach(o =>
      console.log(`    · ${o.numeroOrden} — ${o.cliente} — ${o.pasosRegistrados}/${o.equiposDeTaller} equipos`));
    if (r.ordenesCerradasIncompletas.length > 10) {
      console.log(`    … y ${r.ordenesCerradasIncompletas.length - 10} más (ver el .json)`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
const guardar = (nombre, data) => {
  // El nombre del archivo lo estampa quien corre el script, no el reporte.
  const ts = Date.now();
  const archivo = `${nombre}-${ts}.json`;
  fs.writeFileSync(archivo, JSON.stringify(data, null, 2));
  console.log(`\n📄 Reporte completo: ${archivo}\n`);
};

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (modo === '--listar') {
      const tenants = await listarTenants();
      console.log('\nSUSCRIPTORES:\n');
      tenants.forEach(t => console.log(`  ${t.adminId}  ${t.email}  ${t.nombre}`));
      console.log(`\n${tenants.length} suscriptor(es).`);
      console.log('\nUso: node diagnostico-pasos-taller.js <adminId>');
      console.log('     node diagnostico-pasos-taller.js --todos\n');
      process.exit(0);
    }

    if (modo === '--todos') {
      const tenants = await listarTenants();
      const reportes = [];
      for (const t of tenants) {
        const r = await auditarTenant(t.adminId, t.email);
        reportes.push(r);
        imprimirResumen(r);
      }
      const global = {
        tenants: reportes.length,
        pasosDuplicadosTotales: reportes.reduce((a, r) => a + r.totalPasosDuplicados, 0),
        ordenesCerradasIncompletas: reportes.reduce((a, r) => a + r.ordenesCerradasIncompletas.length, 0)
      };
      console.log('\n' + '═'.repeat(72));
      console.log(`GLOBAL: ${global.pasosDuplicadosTotales} pasos duplicados · ` +
                  `${global.ordenesCerradasIncompletas} órdenes cerradas incompletas`);
      console.log('═'.repeat(72));
      guardar('diagnostico-pasos-taller-todos', { global, reportes });
      process.exit(0);
    }

    let adminId = modo;
    if (modo === '--email') {
      const email = args[1];
      if (!email) { console.error('Falta el correo. Uso: --email correo@x.com'); process.exit(1); }
      const tenants = await listarTenants();
      const t = tenants.find(x => (x.email || '').toLowerCase() === email.toLowerCase());
      if (!t) { console.error(`No hay suscriptor con el correo ${email}`); process.exit(1); }
      adminId = t.adminId;
    }

    const r = await auditarTenant(adminId);
    imprimirResumen(r);
    guardar(`diagnostico-pasos-taller-${adminId}`, r);
    process.exit(0);
  } catch (e) {
    console.error('\n❌ Error corriendo el diagnóstico:', e.message);
    process.exit(1);
  }
})();
