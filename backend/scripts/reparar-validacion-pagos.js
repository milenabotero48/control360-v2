// ============================================================
// Control360 — PAGO-VALIDACION-003: órdenes atascadas en "⏳ Validar pago"
// Ubicación: backend/scripts/reparar-validacion-pagos.js
// ------------------------------------------------------------
// EJECUTAR desde Railway Console o local:
//   node backend/scripts/reparar-validacion-pagos.js              ← DRY-RUN
//   node backend/scripts/reparar-validacion-pagos.js --aplicar    ← APLICA
//   node backend/scripts/reparar-validacion-pagos.js --tenant=UID ← un suscriptor
//   node backend/scripts/reparar-validacion-pagos.js --aplicar --todas
//
// QUÉ REPARA
// ----------
// Entre el 21 y el 28 de agosto de 2026 la lista de órdenes marcaba
// "⏳ Validar pago" con un criterio y el detalle pintaba el botón con otro
// (PAGO-ADMIN-002 le agregó !dineroEnCaja solo al detalle). Las órdenes que
// caían en la diferencia quedaban marcadas como pendientes SIN forma de
// validarlas — caso real OS-0528 y OS-0516.
//
// El criterio ya quedó unificado en services/validacionPagos.js. Este script
// limpia lo que quedó atrás en la base.
//
// DOS GRUPOS, A PROPÓSITO
// -----------------------
//   A) El pago lo registró admin o tesorería → se marca VALIDADO.
//      Con la regla nueva ese pago habría nacido validado: quien tiene acceso
//      al banco valida con su propio registro. Solo se pone al día la base.
//
//   B) Lo registró otro rol (comercial, oficina, mensajero) o no se puede
//      saber quién → se REPORTA y no se toca.
//      Esas son las que de verdad esperan que alguien confirme contra el
//      banco, y ahora sí tienen el botón en el detalle de la orden.
//      Con --todas se marcan también (solo si sabés que ya las revisaste).
//
// Nada se borra. Todo cambio deja huella en la orden y en audit_logs.
// ============================================================

require('dotenv').config();
const { db, admin } = require('../config/firebase');
const { pagoPendienteValidacion } = require('../services/validacionPagos');

const APLICAR   = process.argv.includes('--aplicar');
const TODAS     = process.argv.includes('--todas');
const argTenant = process.argv.find(a => a.startsWith('--tenant='));
const TENANT    = argTenant ? argTenant.split('=')[1] : null;

const ROLES_CON_ACCESO_BANCO = ['admin', 'tesoreria'];
const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('es-CO');
const ahora = () => new Date().toISOString();

// ─── Quién registró el pago de esta orden ────────────────────────────────────
// Se busca en el historial la última acción de pago; si no hay, se cae al
// creador de la orden. Devuelve { usuarioId, usuarioNombre, origen }.
const ACCIONES_PAGO = ['PAGO_REGISTRADO', 'ABONO_PARCIAL', 'PAGO_VALIDADO_APROBADO'];

function quienRegistroElPago(o) {
  const hist = Array.isArray(o.historialEstados) ? o.historialEstados : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i] || {};
    if (ACCIONES_PAGO.includes(h.accion) && h.usuarioId) {
      return { usuarioId: h.usuarioId, usuarioNombre: h.usuarioNombre || '', origen: 'historial' };
    }
  }
  if (o.creadoPor) {
    return { usuarioId: o.creadoPor, usuarioNombre: o.creadoPorNombre || o.creadoPorEmail || '', origen: 'creador' };
  }
  return { usuarioId: null, usuarioNombre: '', origen: 'desconocido' };
}

const cacheRoles = new Map();
async function rolDe(uid) {
  if (!uid) return null;
  if (cacheRoles.has(uid)) return cacheRoles.get(uid);
  let rol = null;
  try {
    const u = await db.collection('users').doc(uid).get();
    if (u.exists) rol = u.data().role || null;
  } catch (e) { /* usuario borrado o sin permiso de lectura */ }
  cacheRoles.set(uid, rol);
  return rol;
}

(async () => {
  console.log('══════════════════════════════════════════════════════');
  console.log(`  VALIDACIÓN DE PAGOS — ${APLICAR ? '🔴 MODO APLICAR' : '🟡 DRY-RUN (no cambia nada)'}`);
  console.log(`  Alcance: ${TENANT ? 'tenant ' + TENANT : 'TODOS los suscriptores'}`);
  console.log(`  Grupo B (registrado por otro rol): ${TODAS ? '🔴 TAMBIÉN se marca' : 'solo se reporta'}`);
  console.log('══════════════════════════════════════════════════════\n');

  let q = db.collection('orders');
  if (TENANT) q = q.where('adminId', '==', TENANT);
  const snap = await q.get();

  const grupoA = [];
  const grupoB = [];

  for (const doc of snap.docs) {
    const o = doc.data();
    if (!pagoPendienteValidacion(o)) continue;

    const quien = quienRegistroElPago(o);
    const rol = await rolDe(quien.usuarioId);
    const fila = {
      id: doc.id,
      numeroOrden: o.numeroOrden,
      cliente: o.clienteNombre,
      total: o.total,
      formaPago: o.formaPago,
      estado: o.estado,
      dineroEnCaja: o.dineroEnCaja === true,
      registradoPor: quien.usuarioNombre || quien.usuarioId || '—',
      rol: rol || 'desconocido',
      origen: quien.origen
    };
    (ROLES_CON_ACCESO_BANCO.includes(rol) ? grupoA : grupoB).push(fila);
  }

  const pinta = (titulo, filas) => {
    console.log(`\n${titulo}  (${filas.length})`);
    console.log('─'.repeat(110));
    if (!filas.length) { console.log('  (ninguna)'); return; }
    for (const f of filas) {
      console.log(`  ${String(f.numeroOrden || f.id).padEnd(10)} ${fmt(f.total).padStart(12)}  ` +
        `${String(f.formaPago || '').padEnd(16)} ${String(f.estado || '').padEnd(18)} ` +
        `caja:${f.dineroEnCaja ? 'sí' : 'no '}  ${String(f.rol).padEnd(12)} ${f.registradoPor}`);
      console.log(`     └ ${f.cliente || ''}`);
    }
  };

  pinta('GRUPO A · registrado por admin/tesorería → nace validado con la regla nueva', grupoA);
  pinta('GRUPO B · registrado por otro rol → espera confirmación contra el banco', grupoB);

  const aMarcar = TODAS ? grupoA.concat(grupoB) : grupoA;
  console.log(`\nÓrdenes a marcar validadas: ${aMarcar.length}`);

  if (!APLICAR) {
    console.log('\n🟡 DRY-RUN: no se escribió nada. Corré con --aplicar para hacerlo.');
    process.exit(0);
  }
  if (!aMarcar.length) {
    console.log('\n✓ Nada que reparar.');
    process.exit(0);
  }

  let ok = 0;
  for (const f of aMarcar) {
    try {
      await db.collection('orders').doc(f.id).update({
        pagoValidado: true,
        pagoValidadoPor: 'reparar-validacion-pagos',
        pagoValidadoPorNombre: 'Script PAGO-VALIDACION-003',
        pagoValidadoEn: ahora(),
        pagoVirtualPendienteValidar: false,
        validadoAutomaticamente: true,
        validacionReparadaPor: f.rol,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        historialEstados: admin.firestore.FieldValue.arrayUnion({
          estado: f.estado,
          fecha: ahora(),
          usuarioId: 'reparar-validacion-pagos',
          usuarioNombre: 'Script PAGO-VALIDACION-003',
          accion: 'PAGO_VALIDADO_REPARACION',
          nota: `Quedó marcada pendiente de validar sin botón para validarla. ` +
                `Pago registrado por ${f.registradoPor} (rol ${f.rol}).`
        })
      });
      await db.collection('audit_logs').add({
        accion: 'PAGO_VALIDADO_REPARACION',
        modulo: 'ordenes',
        descripcion: `Reparación PAGO-VALIDACION-003: ${f.numeroOrden} marcada validada (registró ${f.registradoPor}, rol ${f.rol})`,
        usuarioId: 'reparar-validacion-pagos',
        usuarioNombre: 'Script PAGO-VALIDACION-003',
        ordenId: f.id,
        documento: f.numeroOrden || null,
        datos: { total: f.total, formaPago: f.formaPago, estado: f.estado, dineroEnCaja: f.dineroEnCaja, rol: f.rol },
        fecha: ahora(),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      ok++;
      console.log(`  ✓ ${f.numeroOrden}`);
    } catch (e) {
      console.error(`  ✖ ${f.numeroOrden}: ${e.message}`);
    }
  }

  console.log(`\n✓ Listo: ${ok}/${aMarcar.length} órdenes reparadas.`);
  if (!TODAS && grupoB.length) {
    console.log(`\nQuedan ${grupoB.length} del grupo B esperando confirmación contra el banco.`);
    console.log('Validalas desde el detalle de cada orden (botón ✅ Aprobar) o corré con --todas.');
  }
  process.exit(0);
})().catch(e => { console.error('Error fatal:', e); process.exit(1); });
