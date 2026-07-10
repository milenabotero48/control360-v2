// ============================================================
// Control360 — ✅ FIX REPARAR-DATOS-001: reparación de datos dañados
// Ubicación: backend/scripts/reparar-datos.js
// ------------------------------------------------------------
// EJECUTAR desde Railway Console o local:
//   node backend/scripts/reparar-datos.js               ← DRY-RUN (solo muestra)
//   node backend/scripts/reparar-datos.js --aplicar     ← APLICA los cambios
//   node backend/scripts/reparar-datos.js --tenant=UID  ← limita a un suscriptor
//
// Repara TRES daños históricos (para TODOS los suscriptores):
//
//   A. ÓRDENES EN ESTADO ILEGAL (bug de asignación, ASIGNAR-FLUJO-001):
//      · interna en en_ruta_recogida/en_ruta_entrega/entrega_cobranza
//        → interna_proceso (si tiene mensajero) o programada (si no)
//      · cobranza en en_ruta_entrega → en_ruta_recogida
//      · cualquier otra orden cuyo estado no exista en su flujo → se REPORTA
//        (no se toca automáticamente)
//
//   B. EFECTIVO PAGADO SIN CAJA (bug FIX CAJA-002, caso OS-0187):
//      · orden completada + pagada en efectivo + dineroEnCaja=false +
//        sin movimiento de ingreso → registra el ingreso en la caja de
//        efectivo del suscriptor, marca dineroEnCaja y deja huella
//
//   C. LEDGER CxC DESALINEADO:
//      · registros de la colección `cxc` en 'pendiente' cuya orden ya está
//        pagada → se marcan 'pagada' (higiene del ledger; la pantalla CxC
//        lee de orders, esto es solo consistencia)
//
// Todo cambio deja nota en historial/auditoría. Nada se borra.
// ============================================================

require('dotenv').config();
require('../config/firebase');
const { db, admin } = require('../config/firebase');

// La MISMA máquina de estados del sistema (una sola fuente de verdad)
const ordersRouter = require('../routes/orders');
const construirFlujo = ordersRouter.construirFlujo;

const APLICAR = process.argv.includes('--aplicar');
const argTenant = process.argv.find(a => a.startsWith('--tenant='));
const TENANT = argTenant ? argTenant.split('=')[1] : null;

const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('es-CO');
const ESTADOS_TERMINALES = ['completada', 'cxc', 'anulada', 'cuadre_dinero'];
const ahora = () => new Date().toISOString();

const nota = (texto) => ({
  fecha: ahora(),
  usuarioId: 'reparar-datos',
  usuarioNombre: 'Script reparar-datos.js',
  nota: texto
});

(async () => {
  console.log('══════════════════════════════════════════════════════');
  console.log(`  REPARACIÓN DE DATOS — ${APLICAR ? '🔴 MODO APLICAR' : '🟡 DRY-RUN (solo muestra, no cambia nada)'}`);
  console.log(`  Alcance: ${TENANT ? 'tenant ' + TENANT : 'TODOS los suscriptores'}`);
  console.log('══════════════════════════════════════════════════════\n');

  let q = db.collection('orders');
  if (TENANT) q = q.where('adminId', '==', TENANT);
  const snap = await q.get();
  console.log(`Órdenes leídas: ${snap.size}\n`);

  const esItemTallerReal = (it) => {
    const c = (it.categoria || '').toLowerCase();
    const esTaller = ['recarga', 'mantenimiento', 'hidrostatica', 'hidrostática'].some(k => c.includes(k));
    return esTaller && !it.esCambio;
  };

  // ── A. ESTADOS ILEGALES ────────────────────────────────────
  console.log('── A. ÓRDENES EN ESTADO FUERA DE SU FLUJO ──────────────');
  let repEstados = 0, repReportadas = 0;
  for (const doc of snap.docs) {
    const o = doc.data();
    if (ESTADOS_TERMINALES.includes(o.estado)) continue;

    const tieneTaller = typeof o.tieneEquipoTaller === 'boolean'
      ? o.tieneEquipoTaller
      : (o.items || []).some(esItemTallerReal);
    const flujo = construirFlujo(o.lugarAtencion, o.requiereFactura, tieneTaller);
    const estadosLegales = new Set([...Object.keys(flujo), 'programada']);
    // reparacion_proceso es pausa legal dentro de taller
    if (flujo['en_taller']) estadosLegales.add('reparacion_proceso');
    // el destino de cada paso también es legal (p.ej. listo_entregar, despacho)
    Object.values(flujo).forEach(p => p?.siguiente && estadosLegales.add(p.siguiente));

    if (estadosLegales.has(o.estado)) continue;

    const esInterna = o.tipoOrden === 'interna' || (o.lugarAtencion || '').toLowerCase() === 'interna';
    const esCobranza = (o.lugarAtencion || '').toLowerCase() === 'cobranza';

    let nuevoEstado = null;
    if (esInterna && ['en_ruta_recogida', 'en_ruta_entrega', 'entrega_cobranza'].includes(o.estado)) {
      nuevoEstado = o.mensajeroId ? 'interna_proceso' : 'programada';
    } else if (esCobranza && o.estado === 'en_ruta_entrega') {
      nuevoEstado = 'en_ruta_recogida';
    }

    if (nuevoEstado) {
      repEstados++;
      console.log(`  🔧 ${o.numeroOrden} [${o.adminId}] ${o.lugarAtencion}/${o.tipoOrden || '-'}: "${o.estado}" → "${nuevoEstado}"`);
      if (APLICAR) {
        await doc.ref.update({
          estado: nuevoEstado,
          historialEstados: admin.firestore.FieldValue.arrayUnion({
            estado: nuevoEstado,
            ...nota(`Reparación: estaba en "${o.estado}", estado inexistente en su flujo (bug de asignación ASIGNAR-FLUJO-001)`)
          }),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    } else {
      repReportadas++;
      console.log(`  ⚠️  ${o.numeroOrden} [${o.adminId}] ${o.lugarAtencion}/${o.tipoOrden || '-'}: estado "${o.estado}" fuera de flujo — REVISAR A MANO (no se toca)`);
    }
  }
  console.log(`  Subtotal: ${repEstados} reparadas, ${repReportadas} reportadas\n`);

  // ── B. EFECTIVO PAGADO SIN CAJA ───────────────────────────
  console.log('── B. EFECTIVO PAGADO QUE NUNCA ENTRÓ A CAJA ───────────');
  // Cache de caja de efectivo por tenant
  const cajaEfectivoDe = {};
  const buscarCajaEfectivo = async (adminId) => {
    if (cajaEfectivoDe[adminId] !== undefined) return cajaEfectivoDe[adminId];
    const cs = await db.collection('cajas').where('userId', '==', adminId).get();
    const caja = cs.docs.find(d => {
      const c = d.data();
      return c.activa !== false && (/efectivo/i.test(c.nombre || '') || /efectivo/i.test(c.tipo || ''));
    }) || null;
    cajaEfectivoDe[adminId] = caja;
    return caja;
  };

  let repCaja = 0, totalRecuperado = 0, sinCaja = 0;
  for (const doc of snap.docs) {
    const o = doc.data();
    if (o.estado !== 'completada') continue;
    if (o.pagado !== true) continue;
    if (o.dineroEnCaja === true) continue;
    if (o.cuadrado === true) continue; // entró (o entrará) por cuadre de mensajero
    const fp = o.formaPagoRecaudo || o.formaPago || '';
    if (!/efectivo/i.test(fp)) continue;
    const monto = Number(o.montoPagado) || Number(o.montoRecaudado) || Number(o.total) || 0;
    if (monto <= 0) continue;

    // ¿Ya existe un ingreso de esta orden? (candado)
    const movs = await db.collection('movimientos').where('ordenId', '==', doc.id).limit(5).get();
    const yaIngreso = movs.docs.some(m => m.data().tipo === 'ingreso');
    if (yaIngreso) continue;

    const caja = await buscarCajaEfectivo(o.adminId);
    if (!caja) {
      sinCaja++;
      console.log(`  ⚠️  ${o.numeroOrden} [${o.adminId}]: ${fmt(monto)} SIN caja de efectivo en el tenant — no se puede reparar automático`);
      continue;
    }

    repCaja++;
    totalRecuperado += monto;
    console.log(`  💰 ${o.numeroOrden} [${o.adminId}]: ${fmt(monto)} → caja "${caja.data().nombre}" (${fp})`);
    if (APLICAR) {
      await caja.ref.update({
        saldo: admin.firestore.FieldValue.increment(monto),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('movimientos').add({
        userId: o.adminId,
        cajaId: caja.id,
        cajaNombre: caja.data().nombre || '',
        tipo: 'ingreso',
        concepto: `Reparación: pago ${o.numeroOrden} — ${o.clienteNombre || ''} (efectivo que no había entrado a caja)`,
        monto,
        referencia: o.numeroOrden,
        ordenId: doc.id,
        formaPago: fp,
        esReparacion: true,
        creadoPor: 'reparar-datos.js',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await doc.ref.update({
        dineroEnCaja: true,
        dineroEnCajaFecha: ahora(),
        dineroEnCajaPor: 'reparar-datos.js',
        historialEstados: admin.firestore.FieldValue.arrayUnion({
          estado: o.estado,
          ...nota(`Reparación: ingreso de ${fmt(monto)} registrado en caja "${caja.data().nombre}" (bug FIX CAJA-002)`)
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('audit_logs').add({
        accion: 'REPARACION_CAJA',
        adminId: o.adminId,
        descripcion: `reparar-datos.js: ${fmt(monto)} de ${o.numeroOrden} ingresado a caja "${caja.data().nombre}"`,
        fecha: ahora(),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }
  console.log(`  Subtotal: ${repCaja} órdenes, ${fmt(totalRecuperado)} recuperados${sinCaja ? `, ${sinCaja} sin caja de efectivo` : ''}\n`);

  // ── C. LEDGER CxC DESALINEADO ─────────────────────────────
  console.log('── C. REGISTROS CxC PENDIENTES DE ÓRDENES YA PAGADAS ───');
  let qc = db.collection('cxc').where('estado', '==', 'pendiente');
  if (TENANT) qc = qc.where('userId', '==', TENANT);
  const cxcSnap = await qc.get();
  let repCxc = 0;
  for (const doc of cxcSnap.docs) {
    const c = doc.data();
    if (!c.ordenId) continue;
    const ordDoc = await db.collection('orders').doc(c.ordenId).get();
    if (!ordDoc.exists) continue;
    const o = ordDoc.data();
    if (o.pagado === true && o.estado === 'completada') {
      repCxc++;
      console.log(`  🧾 CxC ${c.numeroOrden || c.ordenId} [${c.userId}]: ${fmt(c.monto)} pendiente pero la orden ya está pagada → 'pagada'`);
      if (APLICAR) {
        await doc.ref.update({
          estado: 'pagada',
          pagadaEn: ahora(),
          pagadaPor: 'reparar-datos.js (reparación de ledger)',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }
  }
  console.log(`  Subtotal: ${repCxc} registros CxC alineados\n`);

  console.log('══════════════════════════════════════════════════════');
  console.log(`  RESUMEN ${APLICAR ? '(APLICADO)' : '(DRY-RUN — nada se cambió)'}`);
  console.log(`  A. Estados reparados:   ${repEstados} (+${repReportadas} solo reportadas)`);
  console.log(`  B. Dinero recuperado:   ${fmt(totalRecuperado)} en ${repCaja} órdenes`);
  console.log(`  C. Ledger CxC alineado: ${repCxc} registros`);
  if (!APLICAR) console.log('\n  Para aplicar: node backend/scripts/reparar-datos.js --aplicar');
  console.log('══════════════════════════════════════════════════════');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
