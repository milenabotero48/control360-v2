// ═══════════════════════════════════════════════════════════════════════════════
// validacionPagos.js — Fuente ÚNICA de verdad de la validación de pagos
// ─────────────────────────────────────────────────────────────────────────────
// PAGO-VALIDACION-003
//
// PROBLEMA QUE RESUELVE
// ---------------------
// "Validar pago" existía en cuatro lugares con cuatro criterios distintos:
//
//   · GestionOrdenes.js  → virtual + pagado + !pagoValidado
//   · DetalleOrden.js    → lo mismo + !dineroEnCaja   (PAGO-ADMIN-002)
//   · dashboards.js      → lo mismo pero solo en 2 estados
//   · logistics/cxc      → encendían dineroEnCaja sin tocar pagoValidado
//
// Resultado real (agosto 2026, OS-0528 y OS-0516): la lista mostraba
// "⏳ Validar pago" y el detalle NO pintaba el banner — la orden quedaba
// marcada como pendiente para siempre y no existía el botón para validarla.
//
// Un criterio en cuatro archivos no es un criterio: es cuatro. Este módulo lo
// deja en uno solo y los cuatro lugares lo importan.
//
// QUÉ SIGNIFICA VALIDAR (regla de negocio, decidida por la dueña)
// --------------------------------------------------------------
// Validar es que QUIEN TIENE ACCESO A LA CUENTA BANCARIA confirme que la plata
// sí entró al banco. Por eso:
//
//   · Si el pago virtual lo registra admin o tesorería → NACE VALIDADO.
//     Ellos son los que mirarían el banco: pedirles que aprueben su propio
//     registro es papeleo, no control.
//   · Si lo registra cualquier otro (comercial, oficina, mensajero) → QUEDA
//     PENDIENTE. Ese es el caso que de verdad necesita un segundo par de ojos.
//
// El dinero que ya está en caja NO es prueba de validación: entra a caja por
// varias vías que nadie revisó contra el banco. Por eso `dineroEnCaja` ya no
// participa del criterio (era el defecto de PAGO-ADMIN-002).
//
// Aprobar una orden cuyo dinero ya está en caja es seguro: el candado
// CANDADO-MONTO-001 de registrarIngresoEnCaja no deja entrar dos veces.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Normalizador ────────────────────────────────────────────────────────────
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim();

// Formas de pago que son crédito: no hay plata que validar, hay cartera.
const ES_CREDITO = [
  'a credito (cxc)', 'a credito', 'cxc', 'cuenta por pagar', 'credito'
];

// ─── ¿Es un pago que hay que verificar en el banco? ──────────────────────────
// Virtual = el dinero viaja por un canal que deja rastro bancario
// (transferencia, Nequi, Daviplata, datáfono). Es el único caso en que alguien
// puede decir "ya le pagué" sin que la plata haya llegado.
//
// EFECTIVO-PALABRA-001: se compara por PALABRA, no por igualdad exacta. Antes
// se comparaba `formaPago !== 'Efectivo'`, así que "Efectivo Maykol" (la caja
// del mensajero) contaba como pago virtual y pedía validación bancaria de una
// plata que estaba en un bolsillo.
function esPagoVirtual(formaPago) {
  const f = norm(formaPago);
  if (!f) return false;
  if (f.includes('efectivo')) return false;
  if (ES_CREDITO.includes(f)) return false;
  return true;
}

function esFormaCredito(formaPago) {
  return ES_CREDITO.includes(norm(formaPago));
}

// ─── ¿Quién valida con su propio registro? ───────────────────────────────────
// Los roles con acceso a la cuenta bancaria. Si cambia el organigrama, cambia
// esta línea y cambia en todo el sistema.
const ROLES_CON_ACCESO_BANCO = ['admin', 'tesoreria'];

function validaConSuPropioRegistro(user) {
  return ROLES_CON_ACCESO_BANCO.includes(user && user.role);
}

// ─── Campos que se escriben cuando el pago nace validado ─────────────────────
// Devuelve {} cuando NO corresponde auto-validar, para poder hacer spread
// directo sobre el update sin condicionales regados por el código.
// Se deja siempre la huella (quién, cuándo, automático) para no perder el
// rastro contable.
function camposValidacionAutomatica({ user, formaPago, esCxC = false }) {
  if (esCxC) return {};
  if (!esPagoVirtual(formaPago)) return {};
  if (!validaConSuPropioRegistro(user)) return {};
  return {
    pagoValidado: true,
    pagoValidadoPor: (user && (user.uid || user.id)) || null,
    pagoValidadoPorNombre: (user && (user.nombre || user.email)) || null,
    pagoValidadoEn: new Date().toISOString(),
    pagoVirtualPendienteValidar: false,
    validadoAutomaticamente: true
  };
}

// ─── El predicado ────────────────────────────────────────────────────────────
// Único criterio de "esta orden espera que alguien confirme el pago en el
// banco". Lo usan la lista, el detalle y el dashboard.
function pagoPendienteValidacion(orden) {
  if (!orden) return false;
  if (orden.estado === 'anulada') return false;          // anulada puede traer pagado:true viejo
  if (!esPagoVirtual(orden.formaPago)) return false;
  if (orden.pagoValidado === true) return false;
  if (orden.pagoRechazado) return false;
  // Solo pendiente si de verdad alguien dijo que cobró.
  return orden.pagado === true || orden.pagoVirtualPendienteValidar === true;
}

module.exports = {
  norm,
  esPagoVirtual,
  esFormaCredito,
  validaConSuPropioRegistro,
  camposValidacionAutomatica,
  pagoPendienteValidacion,
  ROLES_CON_ACCESO_BANCO
};
