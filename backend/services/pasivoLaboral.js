// ═══════════════════════════════════════════════════════════════════════════════
// pasivoLaboral.js — Saldo y descargue del pasivo de prestaciones sociales
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PASIVO-001
//
// EL PROBLEMA QUE RESUELVE
// ------------------------
// El módulo de nómina causaba el pasivo (provisiones_prestaciones) pero nunca
// lo descargaba. El campo `pagada: false` se escribía una vez y ningún endpoint
// volvía a tocarlo. Resultado: el pasivo laboral del balance SOLO CRECÍA.
//
// Cuando se consignaban las cesantías al fondo el 14 de febrero, o se pagaba la
// prima el 30 de junio, la provisión seguía completa. En doce meses el balance
// mostraba una deuda laboral que la empresa ya no tenía.
//
// CÓMO FUNCIONA EL DESCARGUE
// --------------------------
// Un pago se aplica FIFO: primero contra las provisiones más antiguas del mismo
// concepto. Es la regla correcta porque la obligación más vieja es la que
// primero se vuelve exigible (las cesantías de enero se consignan antes que las
// de diciembre).
//
// Cada provisión guarda cuánto lleva aplicado por concepto:
//     aplicado: { cesantias: 120000, prima: 0, ... }
// Un documento sin ese campo se lee como cero — no requiere migración.
//
// DIFERENCIA REAL VS. PROVISIONADO
// --------------------------------
// Si el pago real supera lo provisionado, el excedente NO se fuerza contra el
// pasivo: se devuelve como `sobrante` y el llamador lo registra como gasto del
// período. Si sobra provisión (se provisionó de más), queda viva y se cruza en
// el siguiente pago o en la liquidación final.
//
// COLECCIONES
//   provisiones_prestaciones · el pasivo causado (una por empleado/mes)
//   pagos_prestaciones       · cada pago o consignación que lo descarga
// ═══════════════════════════════════════════════════════════════════════════════

// Los cuatro conceptos del pasivo. El orden importa: es el de presentación.
const CONCEPTOS = ['cesantias', 'interesesCesantias', 'prima', 'vacaciones'];

const ETIQUETAS = {
  cesantias:          'Cesantías',
  interesesCesantias: 'Intereses a las cesantías',
  prima:              'Prima de servicios',
  vacaciones:         'Vacaciones',
};

const CUENTAS_PUC = {
  cesantias:          '2510',
  interesesCesantias: '2515',
  prima:              '2610',
  vacaciones:         '2525',
};

// Tipos de pago. Determinan el texto del comprobante y las validaciones.
const TIPOS_PAGO = {
  consignacion_fondo: {
    id: 'consignacion_fondo',
    etiqueta: 'Consignación al fondo de cesantías',
    conceptos: ['cesantias'],
    descripcion: 'Consignación anual al fondo, a más tardar el 14 de febrero, por el saldo acumulado al 31 de diciembre.',
    fundamento: 'Ley 50 de 1990. El retraso genera un día de salario por cada día de mora, por trabajador.'
  },
  pago_directo: {
    id: 'pago_directo',
    etiqueta: 'Pago directo al empleado',
    conceptos: ['interesesCesantias', 'prima', 'cesantias'],
    descripcion: 'Se le entrega directamente al trabajador: intereses a las cesantías (31 de enero), prima (30 de junio y 20 de diciembre).',
  },
  disfrute_vacaciones: {
    id: 'disfrute_vacaciones',
    etiqueta: 'Disfrute de vacaciones',
    conceptos: ['vacaciones'],
    descripcion: 'El trabajador toma sus vacaciones. Se descarga la provisión acumulada por los días disfrutados.',
  },
  liquidacion_contrato: {
    id: 'liquidacion_contrato',
    etiqueta: 'Liquidación por terminación de contrato',
    conceptos: CONCEPTOS,
    descripcion: 'Descarga todo el saldo pendiente del empleado al terminar la relación laboral.',
  },
  retiro_parcial: {
    id: 'retiro_parcial',
    etiqueta: 'Retiro parcial de cesantías',
    conceptos: ['cesantias'],
    descripcion: 'Retiro autorizado para vivienda o educación. Solo procede sobre cesantías aún no consignadas al fondo.',
  },
};

const num = (v) => Number(v) || 0;
const cero = () => CONCEPTOS.reduce((a, k) => (a[k] = 0, a), {});

/** Valor causado de un concepto en una provisión. */
const valorCausado = (prov, concepto) => num(prov?.prestaciones?.[concepto]?.valor);

/** Valor ya aplicado (pagado) de un concepto en una provisión. */
const valorAplicado = (prov, concepto) => num(prov?.aplicado?.[concepto]);

/** Saldo vivo de un concepto en una provisión. Nunca negativo. */
const saldoProvision = (prov, concepto) =>
  Math.max(0, valorCausado(prov, concepto) - valorAplicado(prov, concepto));

/** Una provisión cuenta para el pasivo si no fue revertida. */
const provisionVigente = (prov) => prov?.revertida !== true;

/**
 * Consolida el pasivo laboral a partir de las provisiones causadas.
 *
 * Función PURA: recibe arrays, no toca la base de datos. Así se puede probar
 * sin Firestore y reusar desde el ERI, el balance y la pantalla de empleados.
 *
 * @param {Array} provisiones docs de provisiones_prestaciones
 * @param {object} filtro { empleadoId?, hasta? (YYYY-MM, inclusive) }
 * @returns { porConcepto, porEmpleado, total, causadoTotal, pagadoTotal }
 */
function consolidarPasivo(provisiones = [], filtro = {}) {
  const causado = cero();
  const pagado = cero();
  const saldo = cero();
  const porEmpleado = {};

  for (const p of provisiones) {
    if (!provisionVigente(p)) continue;
    if (filtro.empleadoId && p.empleadoId !== filtro.empleadoId) continue;
    const periodo = p.periodo || `${p.anio}-${String(p.mes).padStart(2, '0')}`;
    if (filtro.hasta && periodo > filtro.hasta) continue;

    const id = p.empleadoId || '_sin_empleado';
    if (!porEmpleado[id]) {
      porEmpleado[id] = {
        empleadoId: id,
        nombre: p.empleadoNombre || '',
        documento: p.empleadoDocumento || '',
        tipoContrato: p.tipoContrato || '',
        causado: cero(), pagado: cero(), saldo: cero(),
        total: 0, periodos: 0,
        primerPeriodo: periodo, ultimoPeriodo: periodo,
      };
    }
    const e = porEmpleado[id];
    e.periodos += 1;
    if (periodo < e.primerPeriodo) e.primerPeriodo = periodo;
    if (periodo > e.ultimoPeriodo) e.ultimoPeriodo = periodo;

    for (const c of CONCEPTOS) {
      const cau = valorCausado(p, c);
      const apl = Math.min(valorAplicado(p, c), cau); // nunca más de lo causado
      causado[c] += cau; pagado[c] += apl; saldo[c] += (cau - apl);
      e.causado[c] += cau; e.pagado[c] += apl; e.saldo[c] += (cau - apl);
    }
  }

  for (const e of Object.values(porEmpleado)) {
    e.total = CONCEPTOS.reduce((a, c) => a + e.saldo[c], 0);
  }

  const total = CONCEPTOS.reduce((a, c) => a + saldo[c], 0);

  return {
    conceptos: CONCEPTOS.map(c => ({
      clave: c,
      etiqueta: ETIQUETAS[c],
      cuentaPUC: CUENTAS_PUC[c],
      causado: causado[c],
      pagado: pagado[c],
      saldo: saldo[c],
    })),
    porConcepto: saldo,
    causadoPorConcepto: causado,
    pagadoPorConcepto: pagado,
    porEmpleado: Object.values(porEmpleado).sort((a, b) => b.total - a.total),
    causadoTotal: CONCEPTOS.reduce((a, c) => a + causado[c], 0),
    pagadoTotal: CONCEPTOS.reduce((a, c) => a + pagado[c], 0),
    total,
  };
}

/**
 * Aplica un pago FIFO sobre las provisiones de UN concepto.
 *
 * No escribe nada: devuelve el plan de aplicación para que el llamador lo
 * ejecute en un batch. Separar el cálculo de la escritura hace que se pueda
 * mostrar un preview al usuario antes de confirmar.
 *
 * @param {Array} provisiones docs (se filtran y ordenan acá)
 * @param {string} concepto   clave de CONCEPTOS
 * @param {number} monto      valor a aplicar
 * @param {object} filtro     { empleadoId? }
 * @returns { aplicaciones[], aplicado, sobrante, saldoAntes, saldoDespues }
 */
function planificarAplicacion(provisiones = [], concepto, monto, filtro = {}) {
  if (!CONCEPTOS.includes(concepto)) {
    throw new Error(`Concepto inválido: ${concepto}. Válidos: ${CONCEPTOS.join(', ')}`);
  }
  let restante = Math.max(0, num(monto));
  const aplicaciones = [];

  const candidatas = provisiones
    .filter(provisionVigente)
    .filter(p => !filtro.empleadoId || p.empleadoId === filtro.empleadoId)
    .filter(p => saldoProvision(p, concepto) > 0)
    // FIFO: la obligación más antigua se descarga primero
    .sort((a, b) => {
      const pa = a.periodo || `${a.anio}-${String(a.mes).padStart(2, '0')}`;
      const pb = b.periodo || `${b.anio}-${String(b.mes).padStart(2, '0')}`;
      return pa.localeCompare(pb);
    });

  const saldoAntes = candidatas.reduce((a, p) => a + saldoProvision(p, concepto), 0);

  for (const p of candidatas) {
    if (restante <= 0) break;
    const disponible = saldoProvision(p, concepto);
    const aplicar = Math.min(disponible, restante);
    if (aplicar <= 0) continue;
    aplicaciones.push({
      provisionId: p.id,
      empleadoId: p.empleadoId,
      empleadoNombre: p.empleadoNombre || '',
      periodo: p.periodo || `${p.anio}-${String(p.mes).padStart(2, '0')}`,
      concepto,
      causado: valorCausado(p, concepto),
      aplicadoAntes: valorAplicado(p, concepto),
      aplicar,
      aplicadoDespues: valorAplicado(p, concepto) + aplicar,
      quedaSaldada: (valorAplicado(p, concepto) + aplicar) >= valorCausado(p, concepto),
    });
    restante -= aplicar;
  }

  const aplicado = num(monto) - restante;

  return {
    concepto,
    etiqueta: ETIQUETAS[concepto],
    montoSolicitado: num(monto),
    aplicaciones,
    aplicado,
    // Lo que el pago excede al pasivo causado. NO se fuerza contra la
    // provisión: es gasto del período (se provisionó de menos).
    sobrante: restante,
    saldoAntes,
    saldoDespues: Math.max(0, saldoAntes - aplicado),
    // Si sobró pasivo sin pagar, se provisionó de más: queda vivo.
    provisionExcedente: aplicado < saldoAntes ? saldoAntes - aplicado : 0,
  };
}

/**
 * Plan de aplicación para VARIOS conceptos a la vez (liquidación de contrato).
 * @param {object} montos { cesantias: n, prima: n, ... }
 */
function planificarAplicacionMultiple(provisiones = [], montos = {}, filtro = {}) {
  const planes = {};
  let totalAplicado = 0, totalSobrante = 0;
  for (const c of CONCEPTOS) {
    const monto = num(montos[c]);
    if (monto <= 0) continue;
    const plan = planificarAplicacion(provisiones, c, monto, filtro);
    planes[c] = plan;
    totalAplicado += plan.aplicado;
    totalSobrante += plan.sobrante;
  }
  return {
    planes,
    totalAplicado,
    totalSobrante,
    aplicaciones: Object.values(planes).flatMap(p => p.aplicaciones),
  };
}

/**
 * Construye el objeto `aplicado` actualizado de una provisión, sumando las
 * aplicaciones de este pago. Mezcla con lo que ya tenía — nunca lo reemplaza.
 */
function mezclarAplicado(provisionActual, aplicacionesDeEstaProvision = []) {
  const base = { ...cero(), ...(provisionActual?.aplicado || {}) };
  for (const a of aplicacionesDeEstaProvision) {
    base[a.concepto] = num(base[a.concepto]) + num(a.aplicar);
  }
  return base;
}

/** ¿Quedó completamente saldada la provisión en todos sus conceptos? */
function estaSaldada(provisionActual, aplicadoNuevo) {
  return CONCEPTOS.every(c => {
    const causado = valorCausado(provisionActual, c);
    if (causado <= 0) return true;
    return num(aplicadoNuevo[c]) >= causado;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SEGURIDAD SOCIAL — FASE 3, APAGADA POR DEFECTO
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ LEER ANTES DE ENCENDER `causarSeguridadSocial`
//
// Hoy el ERI causa solo las PRESTACIONES desde la provisión. Los aportes
// patronales (salud, pensión, SENA, ICBF, caja, ARL) se calculan y se guardan
// en `provisiones_prestaciones.totalSeguridadSocial`, pero el ERI NO los suma:
// entran al gasto cuando el suscriptor digita la planilla PILA como egreso.
//
// Eso mezcla dos criterios contables (prestaciones por causación, aportes por
// caja y con un mes de desfase), pero HOY NO DUPLICA.
//
// Si se enciende el interruptor, los aportes empiezan a causarse mes a mes. A
// partir de ese momento la PILA ya NO puede digitarse como egreso categoría
// "Nómina": tiene que registrarse como pago de pasivo (endpoint /pila), o el
// gasto se cuenta DOS VECES.
//
// PROCEDIMIENTO DE CORTE (en este orden, sin saltarse pasos):
//   1. Pagar la PILA del mes anterior como se venía haciendo.
//   2. Encender `causarSeguridadSocial` en Ajustes.
//   3. Causar el mes en curso: la provisión ya incluye los aportes.
//   4. De ahí en adelante, pagar la PILA desde Empleados → Pasivo laboral.
//   5. Verificar en el ERI que "Personal" no dé un salto: si subió el doble,
//      algún pago de PILA quedó como categoría "Nómina".
// ═════════════════════════════════════════════════════════════════════════════

/** Aportes patronales causados y pagados. Estructura paralela, no toca CONCEPTOS. */
function consolidarSeguridadSocial(provisiones = [], filtro = {}) {
  let causado = 0, pagado = 0, causadoNoActivo = 0;
  const porPeriodo = {};

  for (const p of provisiones) {
    if (!provisionVigente(p)) continue;
    if (filtro.empleadoId && p.empleadoId !== filtro.empleadoId) continue;
    const periodo = p.periodo || `${p.anio}-${String(p.mes).padStart(2, '0')}`;
    if (filtro.hasta && periodo > filtro.hasta) continue;

    const total = num(p.totalSeguridadSocial);
    // Solo cuenta como pasivo si la provisión se causó CON el interruptor
    // encendido. Las anteriores llevan los aportes por caja: no son pasivo.
    if (p.causaSeguridadSocial !== true) { causadoNoActivo += total; continue; }

    const apl = Math.min(num(p.aplicadoSeguridadSocial), total);
    causado += total; pagado += apl;
    if (!porPeriodo[periodo]) porPeriodo[periodo] = { periodo, causado: 0, pagado: 0, saldo: 0 };
    porPeriodo[periodo].causado += total;
    porPeriodo[periodo].pagado += apl;
    porPeriodo[periodo].saldo += (total - apl);
  }

  return {
    causado, pagado,
    saldo: Math.max(0, causado - pagado),
    // Informativo: aportes calculados en meses en que la causación estaba
    // apagada. NO son pasivo — se pagaron/pagarán vía egreso de PILA.
    calculadoSinCausar: causadoNoActivo,
    porPeriodo: Object.values(porPeriodo).sort((a, b) => a.periodo.localeCompare(b.periodo)),
  };
}

/**
 * ✅ NOMINA-RETENCION-001 — retención al trabajador
 *
 * Salud (4%), pensión (4%) y FSP se le DESCUENTAN al empleado del pago, pero la
 * empresa no se los queda: los retiene para consignarlos en la PILA del mes
 * siguiente. Mientras tanto están en la caja de la empresa sin ser suyos.
 *
 * CON NÓMINA QUINCENAL ESTO IMPORTA MÁS
 * -------------------------------------
 * Se retiene el 15 y el 30, y se paga una sola vez en los primeros días del mes
 * siguiente. Entre la primera retención y el pago pasan hasta seis semanas con
 * esa plata en la cuenta. Sin registrarla como pasivo, el saldo de caja se lee
 * como disponible y no lo es.
 *
 * Lee los COMPROBANTES de nómina (egresos con esComprobanteNomina) porque es
 * ahí donde vive la retención — un comprobante por quincena.
 */
function consolidarRetencionEmpleado(comprobantes = [], filtro = {}) {
  let retenido = 0, pagado = 0, retenidoNoActivo = 0;
  const porPeriodo = {};

  for (const c of comprobantes) {
    if (c.esComprobanteNomina !== true || c.anulado === true) continue;
    if (filtro.empleadoId && c.empleadoId !== filtro.empleadoId) continue;
    const pn = c.periodoNomina || {};
    const periodo = pn.anio && pn.mes
      ? `${pn.anio}-${String(pn.mes).padStart(2, '0')}`
      : String(c.fecha || '').slice(0, 7);
    if (filtro.hasta && periodo > filtro.hasta) continue;

    const total = num(c.retencionSeguridadSocial);
    if (total <= 0) continue;

    // Igual que los aportes patronales: solo es pasivo si el comprobante se
    // generó con la causación encendida. Los anteriores entran al gasto por el
    // egreso de la PILA, como venía funcionando.
    if (c.causaRetencionEmpleado !== true) { retenidoNoActivo += total; continue; }

    const apl = Math.min(num(c.aplicadoRetencionEmpleado), total);
    retenido += total; pagado += apl;
    if (!porPeriodo[periodo]) porPeriodo[periodo] = { periodo, retenido: 0, pagado: 0, saldo: 0, comprobantes: 0 };
    porPeriodo[periodo].retenido += total;
    porPeriodo[periodo].pagado += apl;
    porPeriodo[periodo].saldo += (total - apl);
    porPeriodo[periodo].comprobantes += 1;
  }

  return {
    retenido, pagado,
    saldo: Math.max(0, retenido - pagado),
    retenidoSinCausar: retenidoNoActivo,
    porPeriodo: Object.values(porPeriodo).sort((a, b) => a.periodo.localeCompare(b.periodo)),
  };
}

/** Aplicación FIFO del pago de PILA sobre la retención al trabajador. */
function planificarAplicacionRetencion(comprobantes = [], monto, filtro = {}) {
  let restante = Math.max(0, num(monto));
  const aplicaciones = [];

  const candidatos = comprobantes
    .filter(c => c.esComprobanteNomina === true && c.anulado !== true)
    .filter(c => c.causaRetencionEmpleado === true)
    .filter(c => !filtro.empleadoId || c.empleadoId === filtro.empleadoId)
    .filter(c => num(c.retencionSeguridadSocial) - num(c.aplicadoRetencionEmpleado) > 0)
    .sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));

  const saldoAntes = candidatos.reduce(
    (a, c) => a + (num(c.retencionSeguridadSocial) - num(c.aplicadoRetencionEmpleado)), 0);

  for (const c of candidatos) {
    if (restante <= 0) break;
    const disponible = num(c.retencionSeguridadSocial) - num(c.aplicadoRetencionEmpleado);
    const aplicar = Math.min(disponible, restante);
    if (aplicar <= 0) continue;
    aplicaciones.push({
      comprobanteId: c.id,
      numero: c.numero || '',
      empleadoId: c.empleadoId,
      empleadoNombre: c.empleadoNombre || '',
      periodo: c.periodoNomina
        ? `${c.periodoNomina.desde || ''} a ${c.periodoNomina.hasta || ''}`
        : String(c.fecha || '').slice(0, 10),
      concepto: 'retencionEmpleado',
      retenido: num(c.retencionSeguridadSocial),
      aplicadoAntes: num(c.aplicadoRetencionEmpleado),
      aplicar,
      aplicadoDespues: num(c.aplicadoRetencionEmpleado) + aplicar,
    });
    restante -= aplicar;
  }

  const aplicado = num(monto) - restante;
  return {
    concepto: 'retencionEmpleado',
    etiqueta: 'Retención al trabajador (salud, pensión, FSP)',
    montoSolicitado: num(monto),
    aplicaciones, aplicado, sobrante: restante,
    saldoAntes, saldoDespues: Math.max(0, saldoAntes - aplicado),
  };
}

/** Aplicación FIFO del pago de PILA sobre los aportes causados. */
function planificarAplicacionSS(provisiones = [], monto, filtro = {}) {
  let restante = Math.max(0, num(monto));
  const aplicaciones = [];

  const candidatas = provisiones
    .filter(provisionVigente)
    .filter(p => p.causaSeguridadSocial === true)
    .filter(p => !filtro.empleadoId || p.empleadoId === filtro.empleadoId)
    .filter(p => num(p.totalSeguridadSocial) - num(p.aplicadoSeguridadSocial) > 0)
    .sort((a, b) => {
      const pa = a.periodo || `${a.anio}-${String(a.mes).padStart(2, '0')}`;
      const pb = b.periodo || `${b.anio}-${String(b.mes).padStart(2, '0')}`;
      return pa.localeCompare(pb);
    });

  const saldoAntes = candidatas.reduce(
    (a, p) => a + (num(p.totalSeguridadSocial) - num(p.aplicadoSeguridadSocial)), 0);

  for (const p of candidatas) {
    if (restante <= 0) break;
    const disponible = num(p.totalSeguridadSocial) - num(p.aplicadoSeguridadSocial);
    const aplicar = Math.min(disponible, restante);
    if (aplicar <= 0) continue;
    aplicaciones.push({
      provisionId: p.id,
      empleadoId: p.empleadoId,
      empleadoNombre: p.empleadoNombre || '',
      periodo: p.periodo || `${p.anio}-${String(p.mes).padStart(2, '0')}`,
      concepto: 'seguridadSocial',
      causado: num(p.totalSeguridadSocial),
      aplicadoAntes: num(p.aplicadoSeguridadSocial),
      aplicar,
      aplicadoDespues: num(p.aplicadoSeguridadSocial) + aplicar,
    });
    restante -= aplicar;
  }

  const aplicado = num(monto) - restante;
  return {
    concepto: 'seguridadSocial',
    etiqueta: 'Aportes patronales (PILA)',
    montoSolicitado: num(monto),
    aplicaciones, aplicado, sobrante: restante,
    saldoAntes, saldoDespues: Math.max(0, saldoAntes - aplicado),
  };
}

module.exports = {
  CONCEPTOS,
  ETIQUETAS,
  CUENTAS_PUC,
  TIPOS_PAGO,
  consolidarSeguridadSocial,
  planificarAplicacionSS,
  consolidarRetencionEmpleado,
  planificarAplicacionRetencion,
  valorCausado,
  valorAplicado,
  saldoProvision,
  provisionVigente,
  consolidarPasivo,
  planificarAplicacion,
  planificarAplicacionMultiple,
  mezclarAplicado,
  estaSaldada,
};
