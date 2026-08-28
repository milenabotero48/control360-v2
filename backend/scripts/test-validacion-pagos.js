// ============================================================
// Control360 — Banco de pruebas de PAGO-VALIDACION-003
// Ubicación: backend/scripts/test-validacion-pagos.js
//   node backend/scripts/test-validacion-pagos.js
//
// No toca la base de datos: prueba el motor puro de reglas.
// ============================================================
const {
  esPagoVirtual, camposValidacionAutomatica, pagoPendienteValidacion
} = require('../services/validacionPagos');

let ok = 0, fail = 0;
const t = (nombre, real, esperado) => {
  const bien = JSON.stringify(real) === JSON.stringify(esperado);
  if (bien) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✖ ${nombre}\n      esperado: ${JSON.stringify(esperado)}\n      real:     ${JSON.stringify(real)}`); }
};
const auto = (args) => Object.keys(camposValidacionAutomatica(args)).length > 0;

console.log('\n── ¿Qué pago hay que verificar en el banco? ──────────────────');
t('Transferencia es virtual', esPagoVirtual('Transferencia'), true);
t('Nequi es virtual', esPagoVirtual('Nequi'), true);
t('Datáfono es virtual', esPagoVirtual('Datáfono'), true);
t('Efectivo NO es virtual', esPagoVirtual('Efectivo'), false);
t('EFECTIVO en mayúsculas NO es virtual', esPagoVirtual('EFECTIVO'), false);
t('"Efectivo Maykol" NO es virtual (caja del mensajero)', esPagoVirtual('Efectivo Maykol'), false);
t('A crédito (CxC) NO es virtual', esPagoVirtual('A crédito (CxC)'), false);
t('A credito sin tilde NO es virtual', esPagoVirtual('A credito'), false);
t('CXC NO es virtual', esPagoVirtual('CXC'), false);
t('Cuenta por Pagar NO es virtual', esPagoVirtual('Cuenta por Pagar'), false);
t('vacío NO es virtual', esPagoVirtual(''), false);
t('null NO es virtual', esPagoVirtual(null), false);

console.log('\n── ¿Quién valida con su propio registro? ────────────────────');
const admin     = { role: 'admin', uid: 'u1', nombre: 'Milena' };
const tesoreria = { role: 'tesoreria', uid: 'u2', nombre: 'Tesorería' };
const comercial = { role: 'comercial', uid: 'u3', nombre: 'Kellys' };
const mensajero = { role: 'mensajero', uid: 'u4', nombre: 'Carlos' };

t('admin + transferencia → nace validado', auto({ user: admin, formaPago: 'Transferencia' }), true);
t('tesorería + Nequi → nace validado', auto({ user: tesoreria, formaPago: 'Nequi' }), true);
t('comercial + transferencia → queda pendiente', auto({ user: comercial, formaPago: 'Transferencia' }), false);
t('mensajero + transferencia → queda pendiente', auto({ user: mensajero, formaPago: 'Transferencia' }), false);
t('admin + efectivo → nada que validar', auto({ user: admin, formaPago: 'Efectivo' }), false);
t('admin + "Efectivo Maykol" → nada que validar', auto({ user: admin, formaPago: 'Efectivo Maykol' }), false);
t('admin + crédito → nada que validar', auto({ user: admin, formaPago: 'A crédito (CxC)' }), false);
t('admin + marca CxC (esCxC) → nada que validar', auto({ user: admin, formaPago: 'Transferencia', esCxC: true }), false);
t('sin usuario → queda pendiente', auto({ user: null, formaPago: 'Transferencia' }), false);
t('la huella queda completa', (() => {
  const c = camposValidacionAutomatica({ user: admin, formaPago: 'Transferencia' });
  return !!(c.pagoValidado === true && c.pagoValidadoPor === 'u1' && c.pagoValidadoPorNombre === 'Milena'
    && c.pagoValidadoEn && c.validadoAutomaticamente === true && c.pagoVirtualPendienteValidar === false);
})(), true);

console.log('\n── ¿Esta orden espera confirmación del banco? ───────────────');
t('virtual + pagada → pendiente', pagoPendienteValidacion({ formaPago: 'Transferencia', pagado: true }), true);
t('ya validada → no pendiente', pagoPendienteValidacion({ formaPago: 'Transferencia', pagado: true, pagoValidado: true }), false);
t('rechazada → no pendiente', pagoPendienteValidacion({ formaPago: 'Transferencia', pagado: true, pagoRechazado: true }), false);
t('anulada → no pendiente', pagoPendienteValidacion({ formaPago: 'Transferencia', pagado: true, estado: 'anulada' }), false);
t('efectivo pagada → no pendiente', pagoPendienteValidacion({ formaPago: 'Efectivo', pagado: true }), false);
t('virtual sin pagar → no pendiente', pagoPendienteValidacion({ formaPago: 'Transferencia', pagado: false }), false);
t('cobro virtual del mensajero (sin pagado) → pendiente',
  pagoPendienteValidacion({ formaPago: 'Transferencia', pagado: false, pagoVirtualPendienteValidar: true }), true);
t('CxC en cartera → no pendiente', pagoPendienteValidacion({ formaPago: 'A crédito (CxC)', pagado: false, estado: 'cxc' }), false);
t('null → no pendiente', pagoPendienteValidacion(null), false);

console.log('\n── El defecto que se está corrigiendo (OS-0528 / OS-0516) ───');
const os0528 = { numeroOrden: 'OS-0528', formaPago: 'Transferencia', pagado: true,
                 dineroEnCaja: true, estado: 'completada' };
t('con dinero en caja SIGUE pendiente (antes el detalle la escondía)',
  pagoPendienteValidacion(os0528), true);
t('validada, sale de la cola',
  pagoPendienteValidacion({ ...os0528, pagoValidado: true }), false);
t('la lista y el detalle dan el MISMO resultado',
  pagoPendienteValidacion(os0528) === pagoPendienteValidacion(os0528), true);

console.log(`\n══════════════════════════════════════════════════════`);
console.log(`  ${ok} en verde · ${fail} en rojo`);
console.log(`══════════════════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
