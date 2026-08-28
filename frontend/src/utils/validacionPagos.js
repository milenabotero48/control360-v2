// ═══════════════════════════════════════════════════════════════════════════════
// validacionPagos.js (FRONTEND) — ⚠️ ARCHIVO ESPEJO · NO EDITAR A MANO
// ─────────────────────────────────────────────────────────────────────────────
// Copia exacta de backend/services/validacionPagos.js, con la única
// diferencia del sistema de módulos (ESM en vez de CommonJS).
//
// POR QUÉ ESTÁ DUPLICADO
// El frontend aplica la regla MIENTRAS se usa la pantalla (feedback inmediato,
// sin ida y vuelta al servidor). El backend la aplica AL GUARDAR (nadie puede
// saltársela llamando la API directo). Las dos capas deben aplicar EXACTAMENTE
// las mismas reglas, si no el usuario ve una cosa y el sistema guarda otra.
//
// CÓMO ACTUALIZARLO
// Editá SIEMPRE backend/services/validacionPagos.js y volvé a generar este:
//     node backend/scripts/sync-validaciones.js
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

export {
  norm,
  esPagoVirtual,
  esFormaCredito,
  validaConSuPropioRegistro,
  camposValidacionAutomatica,
  pagoPendienteValidacion,
  ROLES_CON_ACCESO_BANCO
};
