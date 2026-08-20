// ═══════════════════════════════════════════════════════════════════════════════
// test-liquidacion.js — Pruebas del motor de liquidación y del pasivo laboral
// ─────────────────────────────────────────────────────────────────────────────
// Se ejecuta sin Firestore: solo prueba funciones puras.
//     node backend/scripts/test-liquidacion.js
//
// Si algo falla, el proceso sale con código 1 y detalla el caso.
// ═══════════════════════════════════════════════════════════════════════════════

const N = require('../services/nominaColombia');
const PL = require('../services/pasivoLaboral');

let pasaron = 0, fallaron = 0;
const casos = [];

const fmt = n => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

function check(nombre, obtenido, esperado, tolerancia = 0) {
  const ok = typeof esperado === 'number'
    ? Math.abs(obtenido - esperado) <= tolerancia
    : obtenido === esperado;
  casos.push({ nombre, obtenido, esperado, ok });
  ok ? pasaron++ : fallaron++;
}

function seccion(t) { casos.push({ seccion: t }); }

const SMMLV_2026 = 1750905;
const AUX_2026 = 249095;

// ═════════════════════════════════════════════════════════════════════════════
seccion('1 · dias360 — convención laboral de mes comercial');
// ═════════════════════════════════════════════════════════════════════════════
check('1-ene a 30-ene = 30 días', N.dias360('2026-01-01', '2026-01-30'), 30);
check('1-ene a 31-dic = 360 días', N.dias360('2026-01-01', '2026-12-31'), 360, 1);
check('1-ene a 30-jun = 180 días', N.dias360('2026-01-01', '2026-06-30'), 180);
check('mismo día = 1 día', N.dias360('2026-05-10', '2026-05-10'), 1);
check('rango invertido = 0', N.dias360('2026-05-10', '2026-05-01'), 0);

// ═════════════════════════════════════════════════════════════════════════════
seccion('2 · Indemnización art. 64 — término INDEFINIDO, salario < 10 SMMLV');
// ═════════════════════════════════════════════════════════════════════════════
const empIndef = {
  id: 'e1', nombre: 'Mensajero', tipoContrato: 'indefinido',
  salario: 2000000, fechaInicio: '2025-03-01'
};

// 8 meses de antigüedad → menos de un año → 30 días completos (es un mínimo)
const i1 = N.calcularIndemnizacion(empIndef, { fechaRetiro: '2025-11-01', anio: 2025 });
check('menos de 1 año → 30 días', i1.dias, 30);
check('valor = 30 × (2.000.000/30)', i1.valor, 2000000, 1);

// 3 años exactos → 30 + 20×2 = 70 días
const i2 = N.calcularIndemnizacion(empIndef, { fechaRetiro: '2028-03-01', anio: 2028 });
check('3 años → 70 días', Math.round(i2.dias), 70, 1);

// 1 año y 6 meses → 30 + 20×0,5 = 40 días
const i3 = N.calcularIndemnizacion(empIndef, { fechaRetiro: '2026-09-01', anio: 2026 });
check('1,5 años → 40 días', Math.round(i3.dias), 40, 1);

// ═════════════════════════════════════════════════════════════════════════════
seccion('3 · Indemnización — salario ALTO (≥ 10 SMMLV) usa la otra escala');
// ═════════════════════════════════════════════════════════════════════════════
const empAlto = {
  id: 'e2', nombre: 'Gerente', tipoContrato: 'indefinido',
  salario: SMMLV_2026 * 12, fechaInicio: '2023-01-01'
};
const i4 = N.calcularIndemnizacion(empAlto, { fechaRetiro: '2026-01-01', anio: 2026 });
check('salario alto detectado', i4.escala.esSalarioAlto, true);
check('3 años salario alto → 20 + 15×2 = 50 días', Math.round(i4.dias), 50, 1);

// ═════════════════════════════════════════════════════════════════════════════
seccion('4 · Indemnización — TÉRMINO FIJO: lo que falte del plazo');
// ═════════════════════════════════════════════════════════════════════════════
const empFijo = {
  id: 'e3', nombre: 'Auxiliar', tipoContrato: 'fijo',
  salario: SMMLV_2026, fechaInicio: '2026-01-01', fechaFin: '2026-12-31'
};
const i5 = N.calcularIndemnizacion(empFijo, { fechaRetiro: '2026-06-30', anio: 2026 });
// Del 30-jun al 31-dic = 181 días (360-based), menos el día de retiro = 180
check('fijo despedido a mitad → ~180 días', i5.dias, 180, 2);
check('fijo: valor ≈ 6 salarios', i5.valor, SMMLV_2026 * 6, SMMLV_2026 * 0.05);

// Despedido después del vencimiento → sin indemnización
const i6 = N.calcularIndemnizacion(empFijo, { fechaRetiro: '2027-01-15', anio: 2027 });
check('fijo vencido → 0 días', i6.dias, 0);

// Fijo sin fecha pactada → no calcula, avisa
const i7 = N.calcularIndemnizacion(
  { ...empFijo, fechaFin: '' }, { fechaRetiro: '2026-06-30', anio: 2026 });
check('fijo sin fecha fin → no aplica', i7.aplica, false);
check('fijo sin fecha fin → avisa', i7.avisos.length > 0, true);

// ═════════════════════════════════════════════════════════════════════════════
seccion('5 · Indemnización — OBRA O LABOR: mínimo 15 días');
// ═════════════════════════════════════════════════════════════════════════════
const empObra = {
  id: 'e4', nombre: 'Técnico', tipoContrato: 'obra_labor',
  salario: 2000000, fechaInicio: '2026-01-01'
};
const i8 = N.calcularIndemnizacion(empObra, { fechaRetiro: '2026-03-01', anio: 2026 });
check('obra sin fecha → mínimo 15 días', i8.dias, 15);
const i9 = N.calcularIndemnizacion(empObra, { fechaRetiro: '2026-03-01', anio: 2026, fechaFinObra: '2026-09-01' });
check('obra con fecha → 179 días', i9.dias, 179, 2);

// ═════════════════════════════════════════════════════════════════════════════
seccion('6 · Retención sobre indemnización — art. 401-3 ET');
// ═════════════════════════════════════════════════════════════════════════════
const UVT_2026 = 52122;
const r1 = N.retencionIndemnizacion(10000000, UVT_2026 * 100, 2026); // 100 UVT → no aplica
check('salario < 204 UVT → sin retención', r1.aplica, false);
const r2 = N.retencionIndemnizacion(10000000, UVT_2026 * 300, 2026); // 300 UVT → aplica
check('salario > 204 UVT → retiene 20%', r2.valor, 2000000);

// ═════════════════════════════════════════════════════════════════════════════
seccion('7 · Liquidación completa — salario mínimo, despido sin justa causa');
// ═════════════════════════════════════════════════════════════════════════════
const empMin = {
  id: 'e5', nombre: 'Operario', documento: '111', tipoContrato: 'indefinido',
  salario: SMMLV_2026, fechaInicio: '2026-01-01'
};
const L = N.liquidarContrato(empMin, {
  fechaRetiro: '2026-06-30', motivo: 'sin_justa_causa', anio: 2026, diasSalarioPendiente: 30
});

// Cesantías: (salario + auxilio) × 180/360 = mitad de un mes de base
const baseEsperada = SMMLV_2026 + AUX_2026;
check('cesantías = base × 180/360', L.prestaciones.cesantias.valor, baseEsperada / 2, 2);
// Intereses: cesantías × 180 × 12% / 360 = cesantías × 6%
check('intereses = cesantías × 6%', L.prestaciones.interesesCesantias.valor,
  (baseEsperada / 2) * 0.06, 100);
// Prima: semestre completo ene-jun = 180/360
check('prima = base × 180/360', L.prestaciones.prima.valor, baseEsperada / 2, 2);
// Vacaciones: salario × 180/720 = salario/4 (SIN auxilio)
check('vacaciones = salario × 180/720 (sin auxilio)', L.prestaciones.vacaciones.valor,
  SMMLV_2026 / 4, 2);
check('indemnización presente', L.indemnizacion !== null, true);
check('indemnización 30 días (< 1 año)', L.indemnizacion.dias, 30);
check('la indemnización NO descarga provisión',
  L.contabilidad.descargaProvision, L.totalPrestaciones);
check('el gasto nuevo incluye la indemnización',
  L.contabilidad.gastoNuevo >= L.indemnizacion.valor, true);
check('aviso de fuero presente',
  L.avisos.some(a => /fuero|estabilidad reforzada/i.test(a.texto)), true);

// Renuncia: mismo período, sin indemnización
const L2 = N.liquidarContrato(empMin, {
  fechaRetiro: '2026-06-30', motivo: 'renuncia', anio: 2026, diasSalarioPendiente: 30
});
check('renuncia → sin indemnización', L2.indemnizacion, null);
check('renuncia → mismas prestaciones', L2.totalPrestaciones, L.totalPrestaciones);

// ═════════════════════════════════════════════════════════════════════════════
seccion('8 · Cesantías solo del año en curso (lo anterior ya fue al fondo)');
// ═════════════════════════════════════════════════════════════════════════════
const empViejo = { ...empMin, id: 'e6', fechaInicio: '2020-05-15' };
const L3 = N.liquidarContrato(empViejo, {
  fechaRetiro: '2026-06-30', motivo: 'renuncia', anio: 2026, diasSalarioPendiente: 30
});
check('cesantías cuentan desde el 1-ene, no desde 2020',
  L3.prestaciones.cesantias.dias, 180, 1);
check('vacaciones sí acumulan desde el ingreso',
  L3.prestaciones.vacaciones.dias > 2000, true);

// ═════════════════════════════════════════════════════════════════════════════
seccion('9 · Horas extras SÍ entran en la base de la provisión');
// ═════════════════════════════════════════════════════════════════════════════
const sinExtras = N.calcularProvisionMensual(empMin, { anio: 2026, mes: 3, diasTrabajados: 30 });
const conExtras = N.calcularProvisionMensual(empMin, { anio: 2026, mes: 3, diasTrabajados: 30, devengadoAdicional: 500000 });
check('sin extras < con extras', conExtras.totalPrestaciones > sinExtras.totalPrestaciones, true);
// Cesantías + prima + vacaciones dan el 20,83%; los intereses ya no son un 1%
// plano sino la porción proporcional al tiempo acumulado del año.
check('cesantías, prima y vacaciones = 20,83% de las extras',
  conExtras.totalPrestaciones - sinExtras.totalPrestaciones, 500000 * 0.2083, 3500);

// El extractor que alimenta la causación
const comprobante = {
  numero: 'EGR-0001',
  liquidacion: {
    devengados: [
      { clave: 'salario', etiqueta: 'Salario', valor: SMMLV_2026, esSalarial: true },
      { clave: 'extra_diurna', etiqueta: 'Hora extra diurna (10h)', valor: 99483, esSalarial: true },
      { clave: 'auxilio_transporte', etiqueta: 'Auxilio de transporte', valor: AUX_2026, esSalarial: false },
    ]
  }
};
const ex = N.devengadoAdicionalDeComprobantes([comprobante]);
check('extrae solo las extras (no salario ni auxilio)', ex.total, 99483);

// ═════════════════════════════════════════════════════════════════════════════
seccion('10 · Pasivo laboral — consolidación causado/pagado/saldo');
// ═════════════════════════════════════════════════════════════════════════════
const prov = (id, periodo, empleadoId, valores, aplicado) => ({
  id, periodo, empleadoId, empleadoNombre: 'Operario', revertida: false,
  prestaciones: {
    cesantias: { valor: valores[0] },
    interesesCesantias: { valor: valores[1] },
    prima: { valor: valores[2] },
    vacaciones: { valor: valores[3] },
  },
  totalPrestaciones: valores.reduce((a, b) => a + b, 0),
  aplicado: aplicado || undefined,
});

const provisiones = [
  prov('p1', '2026-01', 'e5', [100000, 12000, 100000, 50000]),
  prov('p2', '2026-02', 'e5', [100000, 12000, 100000, 50000]),
  prov('p3', '2026-03', 'e5', [100000, 12000, 100000, 50000]),
];

const c0 = PL.consolidarPasivo(provisiones);
check('causado cesantías = 300.000', c0.porConcepto.cesantias, 300000);
check('pagado inicial = 0', c0.pagadoTotal, 0);
check('total pasivo = suma de las 3', c0.total, 786000);

// Pago FIFO de 250.000 sobre tres provisiones de 100.000 cada una:
// consume p1 y p2 completas y 50.000 de p3.
const plan = PL.planificarAplicacion(provisiones, 'cesantias', 250000);
check('FIFO toca las 3 provisiones', plan.aplicaciones.length, 3);
check('FIFO arranca por la más antigua', plan.aplicaciones[0].periodo, '2026-01');
check('FIFO aplica 100k a p1', plan.aplicaciones[0].aplicar, 100000);
check('FIFO aplica 100k a p2', plan.aplicaciones[1].aplicar, 100000);
check('FIFO aplica solo 50k a p3', plan.aplicaciones[2].aplicar, 50000);
check('p1 queda saldada', plan.aplicaciones[0].quedaSaldada, true);
check('p3 NO queda saldada', plan.aplicaciones[2].quedaSaldada, false);
check('sin sobrante', plan.sobrante, 0);
check('saldo después = 50.000', plan.saldoDespues, 50000);

// Pago mayor al pasivo → el excedente NO se fuerza: sale como sobrante
const plan2 = PL.planificarAplicacion(provisiones, 'cesantias', 400000);
check('pago mayor al pasivo → sobrante 100.000', plan2.sobrante, 100000);
check('aplicado tope = 300.000', plan2.aplicado, 300000);

// Aplicar y reconsolidar: el saldo BAJA. Este es EL bug original —
// `pasivoAcumulado` sumaba las provisiones y nunca restaba nada, así que el
// pasivo del balance solo crecía por más que se pagara.
const aplicadas = provisiones.map((p, i) => ({
  ...p, aplicado: PL.mezclarAplicado(p, [plan.aplicaciones[i]])
}));
const c1 = PL.consolidarPasivo(aplicadas);
check('tras el pago, el saldo de cesantías BAJA a 50.000', c1.porConcepto.cesantias, 50000);
check('lo pagado queda registrado', c1.pagadoPorConcepto.cesantias, 250000);
check('el causado no se pierde', c1.causadoPorConcepto.cesantias, 300000);
// p1 pagó cesantías pero le quedan vivos prima, intereses y vacaciones
check('p1 NO está saldada del todo (faltan otros conceptos)',
  PL.estaSaldada(provisiones[0], aplicadas[0].aplicado), false);

// Provisión revertida no cuenta
const c2 = PL.consolidarPasivo([{ ...provisiones[0], revertida: true }, provisiones[1]]);
check('provisión revertida excluida', c2.porConcepto.cesantias, 100000);

// ═════════════════════════════════════════════════════════════════════════════
seccion('11 · Seguridad social — apagada por defecto, no genera pasivo');
// ═════════════════════════════════════════════════════════════════════════════
const provSS = [
  { id: 's1', periodo: '2026-01', empleadoId: 'e5', revertida: false, totalSeguridadSocial: 400000 },
  { id: 's2', periodo: '2026-02', empleadoId: 'e5', revertida: false, totalSeguridadSocial: 400000, causaSeguridadSocial: true },
];
const ss = PL.consolidarSeguridadSocial(provSS);
check('solo cuenta la causada con el flag encendido', ss.causado, 400000);
check('la otra queda como informativa', ss.calculadoSinCausar, 400000);
check('saldo = 400.000', ss.saldo, 400000);

// ═════════════════════════════════════════════════════════════════════════════
seccion('12 · Preaviso de término fijo — art. 46 CST');
// ═════════════════════════════════════════════════════════════════════════════
const pre1 = N.estadoPreavisoFijo(empFijo, '2026-11-15'); // límite: 2026-12-01
check('dentro de la ventana de preaviso', pre1.enVentana, true);
check('límite = 30 días antes del fin', pre1.fechaLimitePreaviso, '2026-12-01');
const pre2 = N.estadoPreavisoFijo(empFijo, '2026-12-10');
check('pasado el límite → preaviso vencido', pre2.preavisoVencido, true);
const pre3 = N.estadoPreavisoFijo(empIndef, '2026-11-15');
check('indefinido no tiene preaviso', pre3, null);

// ═════════════════════════════════════════════════════════════════════════════
seccion('13 · Contratos que NO generan prestaciones');
// ═════════════════════════════════════════════════════════════════════════════
const empPS = { id: 'e7', nombre: 'Contratista', tipoContrato: 'prestacion_servicios', salario: 3000000, fechaInicio: '2026-01-01' };
const L4 = N.liquidarContrato(empPS, { fechaRetiro: '2026-06-30', motivo: 'sin_justa_causa', anio: 2026 });
check('prestación de servicios → sin prestaciones', L4.totalPrestaciones, 0);
const i10 = N.calcularIndemnizacion(empPS, { fechaRetiro: '2026-06-30', anio: 2026 });
check('prestación de servicios → sin indemnización art. 64', i10.aplica, false);

// ═════════════════════════════════════════════════════════════════════════════
seccion('14 · NÓMINA QUINCENAL — dos quincenas deben igualar un mes');
// ═════════════════════════════════════════════════════════════════════════════
// El bug que esto detectó: el FSP se evaluaba contra la base del PERÍODO. En
// quincena, un salario de 4 SMMLV se veía como 2, caía bajo el umbral y no se
// descontaba nada. Dos quincenas daban $0 donde el mes daba el descuento entero.
const conceptosDeduccion = (liq) =>
  Object.fromEntries(liq.deducciones.map(d => [d.clave, d.valor]));

const compararQuincenal = (etiqueta, salario) => {
  const emp = { id: 'q', nombre: 'X', tipoContrato: 'indefinido', salario, fechaInicio: '2025-01-01', claseRiesgoARL: 'III' };
  const base = { anio: 2026, mes: 3, empresaExonerada: true };
  const mes = N.liquidarNomina(emp, { ...base, diasTrabajados: 30, desde: '2026-03-01', hasta: '2026-03-30' });
  const q1 = N.liquidarNomina(emp, { ...base, diasTrabajados: 15, desde: '2026-03-01', hasta: '2026-03-15' });
  const q2 = N.liquidarNomina(emp, { ...base, diasTrabajados: 15, desde: '2026-03-16', hasta: '2026-03-30' });
  const M = conceptosDeduccion(mes), A = conceptosDeduccion(q1), B = conceptosDeduccion(q2);
  for (const k of ['salud_empleado', 'pension_empleado', 'fsp']) {
    check(`${etiqueta} · ${k}: 2 quincenas = 1 mes`, (A[k] || 0) + (B[k] || 0), M[k] || 0, 2);
  }
  check(`${etiqueta} · devengado: 2 quincenas = 1 mes`,
    q1.totalDevengado + q2.totalDevengado, mes.totalDevengado, 2);
  // Tolerancia de 5 pesos: la retención suma TRES conceptos redondeados de
  // forma independiente en cada quincena (salud, pensión, FSP), así que el
  // error de redondeo se acumula. Es inmaterial — la PILA se presenta con
  // valores redondeados a la centena.
  check(`${etiqueta} · retención total = 2 quincenas`,
    q1.retencionSeguridadSocial + q2.retencionSeguridadSocial, mes.retencionSeguridadSocial, 5);
  return { mes, q1, q2 };
};

compararQuincenal('mínimo', SMMLV_2026);
const c4 = compararQuincenal('4 SMMLV', SMMLV_2026 * 4);
compararQuincenal('6 SMMLV', SMMLV_2026 * 6);
compararQuincenal('8 SMMLV', SMMLV_2026 * 8);
compararQuincenal('17 SMMLV (banda 1,2%)', SMMLV_2026 * 17);

// El caso exacto que fallaba antes del arreglo
check('4 SMMLV quincenal SÍ descuenta FSP (antes daba 0)',
  conceptosDeduccion(c4.q1).fsp > 0, true);

// La retención es lo que va a la PILA, y sale del salario, no del auxilio
const liqMin = N.liquidarNomina(
  { id: 'r', nombre: 'X', tipoContrato: 'indefinido', salario: SMMLV_2026, fechaInicio: '2025-01-01' },
  { anio: 2026, mes: 3, diasTrabajados: 30, hasta: '2026-03-30', empresaExonerada: true });
check('retención = salud + pensión sobre el salario (sin auxilio)',
  liqMin.retencionSeguridadSocial, Math.round(SMMLV_2026 * 0.08), 2);
check('el neto = devengado − retención', liqMin.netoAPagar,
  liqMin.totalDevengado - liqMin.retencionSeguridadSocial, 2);

// ═════════════════════════════════════════════════════════════════════════════
seccion('15 · Retención al trabajador como pasivo (Fase 3)');
// ═════════════════════════════════════════════════════════════════════════════
const comp = (id, fecha, retencion, activo, aplicado) => ({
  id, numero: id, fecha, esComprobanteNomina: true, anulado: false,
  empleadoId: 'e5', empleadoNombre: 'Operario',
  periodoNomina: { anio: 2026, mes: 3, desde: fecha, hasta: fecha },
  retencionSeguridadSocial: retencion,
  causaRetencionEmpleado: activo,
  aplicadoRetencionEmpleado: aplicado || 0,
});

// Dos quincenas de marzo, causación encendida
const comprobantes = [
  comp('EGR-1', '2026-03-15', 70036, true),
  comp('EGR-2', '2026-03-30', 70036, true),
  comp('EGR-3', '2026-02-28', 70036, false),  // mes anterior, causación apagada
];
const ret = PL.consolidarRetencionEmpleado(comprobantes);
check('suma las dos quincenas', ret.retenido, 140072);
check('excluye lo generado con la causación apagada', ret.retenidoSinCausar, 70036);
check('saldo pendiente de consignar', ret.saldo, 140072);

// Pago de PILA: primero la retención del trabajador, luego los aportes propios
const planRet = PL.planificarAplicacionRetencion(comprobantes, 100000);
check('FIFO por fecha: arranca por la primera quincena', planRet.aplicaciones[0].numero, 'EGR-1');
check('aplica la primera quincena completa', planRet.aplicaciones[0].aplicar, 70036);
check('y el resto a la segunda', planRet.aplicaciones[1].aplicar, 29964);
check('sin sobrante', planRet.sobrante, 0);

// Pago completo de la planilla: retención + aportes patronales
const planCompleto = PL.planificarAplicacionRetencion(comprobantes, 462869);
check('cubre toda la retención', planCompleto.aplicado, 140072);
check('lo que sobra va a los aportes patronales', planCompleto.sobrante, 322797);

// Tras aplicar, el saldo baja
const trasPago = comprobantes.map(c => {
  const a = planRet.aplicaciones.find(x => x.comprobanteId === c.id);
  return a ? { ...c, aplicadoRetencionEmpleado: a.aplicadoDespues } : c;
});
check('tras el pago parcial el saldo baja a 40.072',
  PL.consolidarRetencionEmpleado(trasPago).saldo, 40072);

// ═════════════════════════════════════════════════════════════════════════════
seccion('16 · Intereses a las cesantías proporcionales al tiempo');
// ═════════════════════════════════════════════════════════════════════════════
// El 1% mensual del factor prestacional es el 12% ANUAL: solo cuadra si el
// trabajador completó el año. Antes sobreprovisionaba 12 veces en el primer
// mes y 4 veces a los tres meses.
const empInt = {
  id: 'i', nombre: 'Test', tipoContrato: 'indefinido',
  salario: 1261413, fechaInicio: '2026-01-01', auxilioTransporteManual: 249095
};
const acumular = (emp, desdeMes, hastaMes) => {
  let ces = 0, int = 0;
  for (let m = desdeMes; m <= hastaMes; m++) {
    const d = N.diasTrabajadosEnMes(emp, 2026, m);
    if (d <= 0) continue;
    const p = N.calcularProvisionMensual(emp, { anio: 2026, mes: m, diasTrabajados: d });
    ces += p.prestaciones.cesantias.valor;
    int += p.prestaciones.interesesCesantias.valor;
  }
  return { ces, int };
};

// Un mes: los intereses deben ser mínimos, no el 1% de la base
const m1 = acumular(empInt, 1, 1);
check('1 mes · intereses = cesantías × 30 × 12%/360', m1.int, m1.ces * 30 * 0.12 / 360, 5);
check('1 mes · NO es el 1% de la base (viejo error)', m1.int < m1.ces * 0.12 / 4, true);

// Tres meses
const m3 = acumular(empInt, 1, 3);
check('3 meses · coincide con la fórmula legal', m3.int, m3.ces * 90 * 0.12 / 360, 20);

// Seis meses
const m6 = acumular(empInt, 1, 6);
check('6 meses · coincide con la fórmula legal', m6.int, m6.ces * 180 * 0.12 / 360, 40);

// Año completo: acá SÍ debe dar el 12% de las cesantías (y el 1% mensual)
const m12 = acumular(empInt, 1, 12);
check('12 meses · intereses = 12% de las cesantías', m12.int, m12.ces * 0.12, 100);
check('12 meses · converge al 1% mensual del factor',
  m12.int, (1261413 + 249095) * 0.01 * 12, 200);

// Ingreso a mitad de año: cuenta desde el ingreso, no desde enero
const empMedio = { ...empInt, id: 'i2', fechaInicio: '2026-06-01' };
const j3 = acumular(empMedio, 6, 8);
check('ingreso en junio · 3 meses trabajados', j3.int, j3.ces * 90 * 0.12 / 360, 20);
check('ingreso en junio · da lo mismo que 3 meses desde enero', j3.int, m3.int, 20);

// Los intereses crecen mes a mes, no son planos
const jun = N.calcularProvisionMensual(empMedio, { anio: 2026, mes: 6, diasTrabajados: 30 });
const ago = N.calcularProvisionMensual(empMedio, { anio: 2026, mes: 8, diasTrabajados: 30 });
check('los intereses crecen con el saldo acumulado',
  ago.prestaciones.interesesCesantias.valor > jun.prestaciones.interesesCesantias.valor, true);
// El acumulado de intereses es cuadrático (las cesantías también crecen), así
// que las cuotas mensuales van 1×, 3×, 5×… no 1×, 2×, 3×.
check('agosto = 5× junio (la curva es cuadrática)',
  ago.prestaciones.interesesCesantias.valor, jun.prestaciones.interesesCesantias.valor * 5, 20);

// ═════════════════════════════════════════════════════════════════════════════
seccion('17 · Historial de salario y base de liquidación — art. 253 CST');
// ═════════════════════════════════════════════════════════════════════════════
const empSube = {
  id: 's1', nombre: 'Kellys', tipoContrato: 'indefinido',
  salario: 1361413, fechaInicio: '2026-06-01',
  historialSalarios: [
    { desde: '2026-06-01', salario: 1261413 },
    { desde: '2026-08-01', salario: 1361413 },
  ]
};

check('salario en junio', N.salarioEnFecha(empSube, '2026-06-15'), 1261413);
check('salario en agosto', N.salarioEnFecha(empSube, '2026-08-15'), 1361413);
check('salario antes del ingreso usa el primer tramo', N.salarioEnFecha(empSube, '2020-01-01'), 1261413);

// Aumento el 1-ago, retiro el 30-sep → varió dentro de los últimos 3 meses
const bSube = N.basesLiquidacion(empSube, '2026-09-30');
check('detecta variación en el trimestre', bSube.varioEnTrimestre, true);
check('cesantías van al promedio del año', bSube.cesantias.metodo, 'promedio_anio');
check('prima va al promedio del semestre', bSube.prima.metodo, 'promedio_semestre');
check('vacaciones van con el último salario', bSube.vacaciones.metodo, 'ultimo_salario');
check('el promedio queda entre los dos salarios',
  bSube.promedioAnio > 1261413 && bSube.promedioAnio < 1361413, true);

// Sin cambios recientes → último salario en todo
const empEstable = { ...empSube, id: 's2', historialSalarios: [{ desde: '2026-06-01', salario: 1361413 }] };
const bEst = N.basesLiquidacion(empEstable, '2026-09-30');
check('sin variación → último salario en cesantías', bEst.cesantias.metodo, 'ultimo_salario');
check('sin variación → último salario en prima', bEst.prima.metodo, 'ultimo_salario');

// Sin historial: se comporta como antes (nada se rompe)
const empSinHist = { id: 's3', tipoContrato: 'indefinido', salario: 2000000, fechaInicio: '2025-01-01' };
const bSin = N.basesLiquidacion(empSinHist, '2026-09-30');
check('sin historial → último salario', bSin.cesantias.valor, 2000000);
check('sin historial → no detecta variación', bSin.varioEnTrimestre, false);

// El aumento se refleja en la liquidación
const LSube = N.liquidarContrato(empSube, {
  fechaRetiro: '2026-09-30', motivo: 'renuncia', anio: 2026, diasSalarioPendiente: 30
});
const LEst = N.liquidarContrato(empEstable, {
  fechaRetiro: '2026-09-30', motivo: 'renuncia', anio: 2026, diasSalarioPendiente: 30
});
check('cesantías con promedio < cesantías con salario final',
  LSube.prestaciones.cesantias.valor < LEst.prestaciones.cesantias.valor, true);
check('vacaciones iguales (ambas usan el salario final)',
  LSube.prestaciones.vacaciones.valor, LEst.prestaciones.vacaciones.valor, 2);
check('avisa del cambio de salario',
  LSube.avisos.some(a => /salario.*cambió|promedio/i.test(a.texto)), true);

// Promedio ponderado por días, no aritmético
const emp5050 = {
  id: 's4', tipoContrato: 'indefinido', salario: 2000000, fechaInicio: '2025-10-01',
  historialSalarios: [
    { desde: '2025-10-01', salario: 1000000 },
    { desde: '2026-04-01', salario: 2000000 },
  ]
};
// Del 1-oct-2025 al 30-sep-2026: 180 días a 1M y 180 días a 2M → 1,5M
check('promedio ponderado por días', N.promedioSalario(emp5050, '2025-10-01', '2026-09-30'), 1500000, 15000);

// ═════════════════════════════════════════════════════════════════════════════
// RESULTADOS
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════════════════');
console.log('  PRUEBAS · Liquidación de contrato y pasivo laboral');
console.log('══════════════════════════════════════════════════════════════\n');
for (const c of casos) {
  if (c.seccion) { console.log(`\n${c.seccion}`); console.log('─'.repeat(62)); continue; }
  const icono = c.ok ? '✓' : '✗';
  const val = typeof c.obtenido === 'number' ? fmt(c.obtenido) : String(c.obtenido);
  const esp = typeof c.esperado === 'number' ? fmt(c.esperado) : String(c.esperado);
  console.log(`  ${icono} ${c.nombre}`);
  if (!c.ok) console.log(`      obtenido: ${val}   ·   esperado: ${esp}`);
}
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  ${pasaron} pasaron · ${fallaron} fallaron`);
console.log('══════════════════════════════════════════════════════════════\n');
process.exit(fallaron > 0 ? 1 : 0);
