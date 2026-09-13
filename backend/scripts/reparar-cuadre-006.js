// ═══════════════════════════════════════════════════════════════════════════════
// reparar-cuadre-006.js — Reparación histórica de PAGO-CUADRE-006
// ─────────────────────────────────────────────────────────────────────────────
// El bug (ver backend/routes/orders.js, PAGO-CUADRE-006): órdenes creadas con
// pago virtual (Nequi, Daviplata, Bancolombia, transferencia...) que nacieron
// YA validadas (porque quien las creó fue admin o tesorería — PAGO-VALIDACION-003)
// nunca registraron el ingreso en ninguna caja: el bloque de caja al crear solo
// cubría efectivo, y el flujo de validación manual posterior nunca se ejecuta
// para algo que ya nació con pagoValidado === true.
//
// Este script encuentra esas órdenes "huérfanas de caja" y, en modo --aplicar,
// repone el ingreso usando la MISMA función de negocio que usa el sistema en
// producción (registrarIngresoEnCaja, con su candado CANDADO-MONTO-001 contra
// duplicados).
//
// MODOS
// -----
//   node scripts/reparar-cuadre-006.js            → DRY-RUN (por defecto). Solo
//                                                    imprime, no escribe nada.
//   node scripts/reparar-cuadre-006.js --aplicar  → escribe: llama a
//                                                    registrarIngresoEnCaja()
//                                                    por cada orden encontrada.
//
// CRITERIO DE BÚSQUEDA
// ---------------------
//   orden.pagoValidado === true
//   orden.validadoAutomaticamente === true
//   esPagoVirtual(orden.formaPago) === true   (misma función que el resto del
//                                              sistema — no se reinventa la
//                                              lista de formas de pago virtuales)
//   Y NO existe ningún documento en `movimientos` con ese ordenId.
//
// Son pocas decenas de casos esperados, así que se hace UNA consulta a
// `movimientos` por orden candidata (precisión sobre performance).
// ═══════════════════════════════════════════════════════════════════════════════

const { db } = require('../config/firebase');
const { esPagoVirtual } = require('../services/validacionPagos');
const ordersRouter = require('../routes/orders');
const registrarIngresoEnCaja = ordersRouter.registrarIngresoEnCaja;

const APLICAR = process.argv.includes('--aplicar');

function fmtMonto(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');
}

async function tieneMovimientoDeCaja(ordenId) {
  const snap = await db.collection('movimientos')
    .where('ordenId', '==', ordenId)
    .limit(1)
    .get();
  return !snap.empty;
}

async function buscarOrdenesRotas() {
  // Trae candidatas por los tres campos booleanos/estado que sí son igualdad
  // exacta y sí están indexados por Firestore sin composición rara; el filtro
  // de "es pago virtual" (que depende de texto libre en formaPago) se aplica
  // en memoria con la misma función que usa el resto del sistema.
  const snap = await db.collection('orders')
    .where('pagoValidado', '==', true)
    .where('validadoAutomaticamente', '==', true)
    .get();

  const candidatas = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(o => esPagoVirtual(o.formaPago));

  const rotas = [];
  for (const orden of candidatas) {
    const yaTieneCaja = await tieneMovimientoDeCaja(orden.id);
    if (!yaTieneCaja) rotas.push(orden);
  }
  return rotas;
}

function mejorFecha(orden) {
  return orden.fechaCuadre
    || orden.fechaCompletada
    || orden.dineroEnCajaFecha
    || orden.fechaPago
    || orden.pagoValidadoEn
    || null;
}

async function main() {
  console.log(`\n═══ PAGO-CUADRE-006 — Reparación histórica — modo ${APLICAR ? 'APLICAR (escribe)' : 'DRY-RUN (solo lectura)'} ═══\n`);

  const rotas = await buscarOrdenesRotas();

  if (rotas.length === 0) {
    console.log('No se encontraron órdenes con caja pendiente de reparar. Nada que hacer.\n');
    return;
  }

  console.log(`Encontradas ${rotas.length} orden(es) validada(s) automáticamente sin ingreso en caja:\n`);

  const porTenant = {};
  let totalGeneral = 0;

  for (const o of rotas) {
    const tenantId = o.adminId || '(sin adminId)';
    const monto = Math.round(Number(o.montoPagado || o.total) || 0);
    porTenant[tenantId] = (porTenant[tenantId] || 0) + monto;
    totalGeneral += monto;

    console.log(
      `  · tenant=${tenantId}  orden=${o.id}  #${o.numeroOrden || '?'}  ` +
      `cliente="${o.clienteNombre || ''}"  monto=${fmtMonto(monto)}  ` +
      `formaPago="${o.formaPago || ''}"  fechaPago=${mejorFecha(o) || '(sin fecha)'}`
    );
  }

  console.log('\n── Totales por tenant ──');
  for (const [tenantId, monto] of Object.entries(porTenant)) {
    console.log(`  ${tenantId}: ${fmtMonto(monto)}`);
  }
  console.log(`\nTOTAL GENERAL A REPONER: ${fmtMonto(totalGeneral)} (${rotas.length} orden(es))\n`);

  if (!APLICAR) {
    console.log('Modo DRY-RUN: no se escribió nada. Para aplicar la reparación, corre:');
    console.log('  node scripts/reparar-cuadre-006.js --aplicar\n');
    return;
  }

  console.log('── Aplicando reparación ──\n');

  let ok = 0, fallidas = 0, montoRepuesto = 0;

  for (const o of rotas) {
    const monto = Math.round(Number(o.montoPagado || o.total) || 0);
    const fechaContable = mejorFecha(o);

    console.log(
      `→ Registrando en caja: orden=${o.id} #${o.numeroOrden || '?'} ` +
      `cliente="${o.clienteNombre || ''}" monto=${fmtMonto(monto)} ` +
      `formaPago="${o.formaPago || ''}" fechaContable=${fechaContable || '(sin fecha — usa hoy)'}`
    );

    try {
      const resultado = await registrarIngresoEnCaja({
        userId: o.adminId,
        ordenId: o.id,
        numeroOrden: o.numeroOrden,
        clienteNombre: o.clienteNombre || '',
        monto,
        formaPago: o.formaPago,
        usuarioEmail: o.pagoValidadoPorNombre || 'reparacion-cuadre-006',
        numeroFactura: o.numeroFactura || '',
        fechaContable
      });
      console.log(`  ✅ OK — ${resultado?.tipo || 'registrado'} ${resultado?.mensaje || ''}`);
      ok++;
      montoRepuesto += monto;
    } catch (e) {
      console.error(`  ❌ ERROR en orden ${o.id}: ${e.message}`);
      fallidas++;
    }
  }

  console.log('\n═══ Resumen ═══');
  console.log(`  Reparadas: ${ok}`);
  console.log(`  Fallidas:  ${fallidas}`);
  console.log(`  Monto total repuesto: ${fmtMonto(montoRepuesto)}\n`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('Error fatal en reparar-cuadre-006.js:', e);
    process.exit(1);
  });
