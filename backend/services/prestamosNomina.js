// ═══════════════════════════════════════════════════════════════════════════════
// prestamosNomina.js — Reglas puras del préstamo de nómina
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PRESTAMO-001
//
// QUÉ ES
// ------
// El trabajador pide plata durante la quincena y se le descuenta en el próximo
// pago. El documento que firma es el COMPROBANTE DE PRÉSTAMO; el dinero se mueve
// con un egreso-anticipo (esAnticipoNomina) que la nómina ya sabe cruzar.
//
// Este archivo solo tiene funciones PURAS (sin Firestore) para poder probarlas.
//
// BASE LEGAL (validar con el abogado laboral antes de producción)
//   · CST art. 149 — descuentos del salario solo con autorización escrita
//   · CST art. 151 — el préstamo debe constar por escrito: valor, cuota, plazo,
//                    intereses (si se pactan) y autorización sobre la liquidación
//   · CST art. 153 — los préstamos al trabajador no devengan intereses
//   · Tope: la quinta parte de lo que el salario excede del mínimo (modo legal)
// ═══════════════════════════════════════════════════════════════════════════════

const N = require('./nominaColombia');

const fmt = n => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(Number(n) || 0);

// ─────────────────────────────────────────────────────────────────────────────
// FECHA DE DESCUENTO
// ─────────────────────────────────────────────────────────────────────────────
// Se descuenta en el PRÓXIMO pago de quincena, y si la solicitud cae el mismo
// día del pago, ese mismo día (la política de no prestar el día de nómina es de
// cada empresa, no del sistema).
//
//     solicitud del 1 al 15  → día 15 del mes
//     solicitud del 16 al 30 → día 30 del mes (febrero: su último día, 28 o 29)
//     solicitud del 31       → día 15 del mes siguiente
// ─────────────────────────────────────────────────────────────────────────────
const DIA_PRIMERA_QUINCENA = 15;
const DIA_SEGUNDA_QUINCENA = 30;

const pad2 = (n) => String(n).padStart(2, '0');
const ultimoDiaMes = (anio, mes) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();

const fechaDescuento = (fechaSolicitudISO) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fechaSolicitudISO || ''));
  if (!m) return null;
  let anio = Number(m[1]);
  let mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12) return null;
  const ultimo = ultimoDiaMes(anio, mes);
  if (dia < 1 || dia > ultimo) return null;

  if (dia <= DIA_PRIMERA_QUINCENA) return `${anio}-${pad2(mes)}-${pad2(DIA_PRIMERA_QUINCENA)}`;

  const pago2 = Math.min(DIA_SEGUNDA_QUINCENA, ultimo);
  if (dia <= pago2) return `${anio}-${pad2(mes)}-${pad2(pago2)}`;

  // Día 31: ya pasó el pago del mes, se descuenta el 15 del siguiente.
  mes += 1;
  if (mes > 12) { mes = 1; anio += 1; }
  return `${anio}-${pad2(mes)}-${pad2(DIA_PRIMERA_QUINCENA)}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// TOPE DE DESCUENTO POR QUINCENA
// ─────────────────────────────────────────────────────────────────────────────
// Se calcula con el salario del CONTRATO.
//   modo 'legal'      → (salario − SMMLV) ÷ 5 al mes, la mitad por quincena.
//                       A quien gana el mínimo (o menos) le da cero.
//   modo 'porcentaje' → % del salario del contrato que fija la empresa.
// ─────────────────────────────────────────────────────────────────────────────
const MODOS_TOPE = ['legal', 'porcentaje'];
const CONFIG_TOPE_DEFECTO = { modoTope: 'legal', porcentaje: 20 };

const calcularCupoQuincena = ({ salario, fechaDescuento: fd, modo = 'legal', porcentaje = 20 }) => {
  const sal = Math.max(0, Number(salario) || 0);
  const anio = Number(String(fd || '').slice(0, 4)) || new Date().getFullYear();
  const smmlv = N.parametrosAnio(anio).smmlv;

  let cupoMensual, formula;
  if (modo === 'porcentaje') {
    const p = Math.min(100, Math.max(0, Number(porcentaje) || 0));
    cupoMensual = sal * p / 100;
    formula = `${p}% del salario del contrato (${fmt(sal)})`;
  } else {
    cupoMensual = Math.max(0, (sal - smmlv) / 5);
    formula = sal <= smmlv
      ? `El salario (${fmt(sal)}) no excede el mínimo legal (${fmt(smmlv)}): no queda cupo de descuento`
      : `Quinta parte de lo que el salario (${fmt(sal)}) excede el mínimo (${fmt(smmlv)})`;
  }

  return {
    modo: modo === 'porcentaje' ? 'porcentaje' : 'legal',
    porcentaje: modo === 'porcentaje' ? Math.min(100, Math.max(0, Number(porcentaje) || 0)) : null,
    smmlv,
    salario: sal,
    cupoMensual: Math.round(cupoMensual),
    cupoQuincena: Math.round(cupoMensual / 2),
    formula
  };
};

/**
 * Compara lo que ya se le va a descontar en ESA quincena (más el valor nuevo)
 * contra el cupo. No bloquea: devuelve la advertencia para que la pantalla la
 * muestre y exija confirmación con motivo.
 */
const evaluarTope = ({ salario, fechaDescuento: fd, valor, comprometidoPrevio = 0, modo, porcentaje }) => {
  const cupo = calcularCupoQuincena({ salario, fechaDescuento: fd, modo, porcentaje });
  const nuevo = Math.max(0, Number(valor) || 0);
  const previo = Math.max(0, Number(comprometidoPrevio) || 0);
  const total = previo + nuevo;
  return {
    ...cupo,
    comprometidoPrevio: Math.round(previo),
    valorNuevo: Math.round(nuevo),
    totalConEste: Math.round(total),
    disponible: Math.max(0, cupo.cupoQuincena - Math.round(previo)),
    excedido: total > cupo.cupoQuincena,
    exceso: Math.max(0, Math.round(total) - cupo.cupoQuincena)
  };
};

/** Texto de la advertencia que ve el usuario. */
const textoAdvertencia = (nombre, tope, fechaDescuentoISO, previos = []) => {
  const quien = nombre || 'Este trabajador';
  const f = fechaDescuentoISO ? ` para la quincena del ${fechaDescuentoISO}` : '';
  const ya = tope.comprometidoPrevio > 0
    ? `ya tiene préstamos por ${fmt(tope.comprometidoPrevio)}${previos.length ? ` (${previos.map(p => p.numero).join(', ')})` : ''}${f}; con este llegaría a ${fmt(tope.totalConEste)}`
    : `con este préstamo de ${fmt(tope.valorNuevo)}${f} llegaría a ${fmt(tope.totalConEste)}`;
  return `${quien} ${ya}, lo que supera el máximo de descuento por quincena (${fmt(tope.cupoQuincena)}). ${tope.formula}.`;
};

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO
// ─────────────────────────────────────────────────────────────────────────────
// El estado de pago NO se guarda: se deduce del egreso-anticipo, que es quien
// sabe si la nómina ya lo cruzó. Así no hay dos fuentes de verdad.
//     ANULADO    → el préstamo se anuló
//     DESCONTADO → la nómina ya lo cruzó
//     ACTIVO     → pendiente de descontar
// ─────────────────────────────────────────────────────────────────────────────
const estadoPrestamo = (prestamo, egreso) => {
  if (prestamo?.estado === 'ANULADO') return 'ANULADO';
  if (egreso && egreso.cruzadoEnNomina === true) return 'DESCONTADO';
  return 'ACTIVO';
};

// ─────────────────────────────────────────────────────────────────────────────
// VALOR EN LETRAS (español, pesos colombianos)
// ─────────────────────────────────────────────────────────────────────────────
const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis',
  'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

const menorMil = (n) => {
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const r = n % 100;
  const partes = [];
  if (c) partes.push(CENTENAS[c]);
  if (r) {
    if (r < 30) partes.push(UNIDADES[r]);
    else {
      const d = Math.floor(r / 10);
      const u = r % 10;
      partes.push(u ? `${DECENAS[d]} y ${UNIDADES[u]}` : DECENAS[d]);
    }
  }
  return partes.join(' ');
};

// "uno" → "un" y "veintiuno" → "veintiún" cuando van antes de "mil"/"millones"
const apocope = (s) => s.endsWith('veintiuno') ? s.slice(0, -9) + 'veintiún'
  : s.endsWith('uno') ? s.slice(0, -3) + 'un' : s;

const enLetras = (n) => {
  if (n === 0) return 'cero';
  const millones = Math.floor(n / 1e6);
  const miles = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  const partes = [];
  if (millones) partes.push(millones === 1 ? 'un millón' : `${apocope(enLetras(millones))} millones`);
  if (miles) partes.push(miles === 1 ? 'mil' : `${apocope(menorMil(miles))} mil`);
  if (resto) partes.push(menorMil(resto));
  return partes.join(' ');
};

const valorEnLetras = (valor) => {
  const n = Math.round(Number(valor) || 0);
  if (n < 0) return '';
  if (n === 1) return 'un peso';
  const texto = enLetras(n);
  // "un millón de pesos", "dos millones de pesos"
  return n >= 1e6 && n % 1e6 === 0 ? `${texto} de pesos` : `${texto} pesos`;
};

module.exports = {
  DIA_PRIMERA_QUINCENA,
  DIA_SEGUNDA_QUINCENA,
  MODOS_TOPE,
  CONFIG_TOPE_DEFECTO,
  fechaDescuento,
  calcularCupoQuincena,
  evaluarTope,
  textoAdvertencia,
  estadoPrestamo,
  valorEnLetras
};
