// ═══════════════════════════════════════════════════════════════════════════════
// nominaColombia.js — Motor de cálculo laboral colombiano
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PROVISIONES-001
//
// POR QUÉ EXISTE
// --------------
// La auditoría del ERI de julio 2026 encontró que la nómina registrada
// ($15.440.975) incluye pagos a empleados y seguridad social, pero NO las
// prestaciones sociales causadas. Faltaban entre $2,5 y $2,8 millones
// MENSUALES de gasto real que nunca llegaron al estado de resultados
// — entre $30 y $34 millones al año.
//
// La razón es que el sistema no tenía cómo causarlas: solo registraba egresos
// de caja. Pero una prestación social NO es un pago: es una OBLIGACIÓN que se
// va acumulando mes a mes y se paga después (la prima en junio y diciembre,
// las cesantías en febrero del año siguiente, las vacaciones cuando se toman).
//
// Contablemente eso es un PASIVO. Y bajo el principio de causación, el gasto
// se reconoce en el mes en que el empleado trabaja, no en el mes en que se
// entrega la plata.
//
// ─────────────────────────────────────────────────────────────────────────────
// MARCO NORMATIVO APLICADO
//   · Código Sustantivo del Trabajo (CST)
//   · Ley 1819 de 2016 art. 65 (exoneración de aportes, antes Ley 1607/2012)
//   · Ley 2466 de 2025 — reforma laboral (jornada nocturna y recargos)
//   · Decreto 1469 de 2025 — salario mínimo y auxilio de transporte 2026
//
// ⚠️ Los valores anuales se declaran por año en TABLA_ANUAL. Cada diciembre
//    hay que agregar el año siguiente. El sistema avisa si trabaja con un año
//    que no tiene parámetros cargados.
// ═══════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// 1 · PARÁMETROS ANUALES
// ═════════════════════════════════════════════════════════════════════════════
const TABLA_ANUAL = {
  2024: { smmlv: 1300000, auxilioTransporte: 162000, uvt: 47065 },
  2025: { smmlv: 1423500, auxilioTransporte: 200000, uvt: 49799 },
  // Decreto 1469 del 29 de diciembre de 2025
  2026: { smmlv: 1750905, auxilioTransporte: 249095, uvt: 52122 },
};

const ANIO_MAS_RECIENTE = Math.max(...Object.keys(TABLA_ANUAL).map(Number));

const parametrosAnio = (anio) => {
  const a = Number(anio) || new Date().getFullYear();
  if (TABLA_ANUAL[a]) return { anio: a, ...TABLA_ANUAL[a], estimado: false };
  // Si piden un año futuro sin cargar, se usa el último conocido y se marca
  // como estimado — nunca se falla en silencio.
  return { anio: a, ...TABLA_ANUAL[ANIO_MAS_RECIENTE], estimado: true, anioBase: ANIO_MAS_RECIENTE };
};

// ═════════════════════════════════════════════════════════════════════════════
// 2 · TIPOS DE CONTRATO
// ─────────────────────────────────────────────────────────────────────────────
// La diferencia clave que pidió la contadora: un contratista por PRESTACIÓN DE
// SERVICIOS no genera prestaciones sociales. No es un empleado — es una
// relación civil/comercial, no laboral. Calcularle cesantías o prima sería un
// error grave (y además, pagárselas configura contrato realidad).
// ═════════════════════════════════════════════════════════════════════════════
const TIPOS_CONTRATO = {
  indefinido: {
    id: 'indefinido',
    etiqueta: 'Término indefinido',
    esLaboral: true,
    generaPrestaciones: true,
    generaSeguridadSocialPatronal: true,
    aplicaAuxilioTransporte: true,
    descripcion: 'Contrato laboral sin fecha de terminación. Genera todas las prestaciones sociales.'
  },
  fijo: {
    id: 'fijo',
    etiqueta: 'Término fijo',
    esLaboral: true,
    generaPrestaciones: true,
    generaSeguridadSocialPatronal: true,
    aplicaAuxilioTransporte: true,
    requiereFechaFin: true,
    descripcion: 'Contrato laboral con fecha de terminación pactada. Genera todas las prestaciones.'
  },
  obra_labor: {
    id: 'obra_labor',
    etiqueta: 'Obra o labor determinada',
    esLaboral: true,
    generaPrestaciones: true,
    generaSeguridadSocialPatronal: true,
    aplicaAuxilioTransporte: true,
    descripcion: 'Dura lo que dure la obra. Genera todas las prestaciones sociales.'
  },
  integral: {
    id: 'integral',
    etiqueta: 'Salario integral',
    esLaboral: true,
    generaPrestaciones: false,   // van incluidas en el factor prestacional
    generaSeguridadSocialPatronal: true,
    aplicaAuxilioTransporte: false,
    minimoSMMLV: 13,             // mínimo 10 SMMLV + 30% factor prestacional
    baseSeguridadSocialPct: 70,  // los aportes se liquidan sobre el 70%
    descripcion: 'Mínimo 13 SMMLV (10 de salario + 30% factor prestacional). Las prestaciones YA están incluidas: no se provisionan aparte. Los aportes se calculan sobre el 70%.'
  },
  aprendiz_lectiva: {
    id: 'aprendiz_lectiva',
    etiqueta: 'Aprendiz SENA · etapa lectiva',
    esLaboral: false,
    generaPrestaciones: false,
    generaSeguridadSocialPatronal: false,
    soloEPS: true,
    aplicaAuxilioTransporte: false,
    apoyoSostenimientoPct: 50,   // 50% del SMMLV
    descripcion: 'Apoyo de sostenimiento del 50% del SMMLV. No genera prestaciones. Solo afiliación a EPS.'
  },
  aprendiz_practica: {
    id: 'aprendiz_practica',
    etiqueta: 'Aprendiz SENA · etapa práctica',
    esLaboral: false,
    generaPrestaciones: false,
    generaSeguridadSocialPatronal: false,
    soloEPSyARL: true,
    aplicaAuxilioTransporte: false,
    apoyoSostenimientoPct: 100,  // Ley 2466/2025 lo llevó al 100% del SMMLV
    descripcion: 'Apoyo de sostenimiento del 100% del SMMLV (Ley 2466 de 2025). No genera prestaciones. Afiliación a EPS y ARL.'
  },
  prestacion_servicios: {
    id: 'prestacion_servicios',
    etiqueta: 'Prestación de servicios',
    esLaboral: false,
    generaPrestaciones: false,
    generaSeguridadSocialPatronal: false,
    aplicaAuxilioTransporte: false,
    advertencia: 'NO es una relación laboral. No genera prestaciones sociales ni aportes patronales. ' +
                 'El contratista cotiza por su cuenta sobre el 40% del valor del contrato. ' +
                 'Si le pagás prestaciones o le exigís horario y subordinación, se configura contrato realidad.',
    descripcion: 'Relación civil, no laboral. Sin prestaciones ni aportes a cargo de la empresa.'
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// 3 · PRESTACIONES SOCIALES
// ─────────────────────────────────────────────────────────────────────────────
// Estos son los porcentajes que faltaban en el ERI. Los cuatro conceptos:
//
//   Cesantías        8,33%  → 1 salario mensual por año trabajado (30/360)
//   Int. cesantías   1,00%  → 12% anual sobre las cesantías acumuladas
//   Prima servicios  8,33%  → 1 salario mensual por año (15 días en jun + 15 en dic)
//   Vacaciones       4,17%  → 15 días HÁBILES por año (15/360)
//                     ─────
//                    21,83% del salario base
//
// ⚠️ BASE DE CÁLCULO — este detalle es el que más se equivoca:
//   · Cesantías, intereses y prima → salario + AUXILIO DE TRANSPORTE
//   · Vacaciones                   → salario SIN auxilio de transporte
//     (el auxilio no es salario; solo se incluye por mandato expreso del CST
//      para cesantías y prima, y las vacaciones no están en esa excepción)
// ═════════════════════════════════════════════════════════════════════════════
const PRESTACIONES = {
  cesantias:          { pct: 8.33,  incluyeAuxilio: true,  etiqueta: 'Cesantías',              cuenta: '2510', base: 'Salario + auxilio de transporte' },
  interesesCesantias: { pct: 1.00,  incluyeAuxilio: true,  etiqueta: 'Intereses a cesantías',  cuenta: '2515', base: '12% anual sobre las cesantías' },
  prima:              { pct: 8.33,  incluyeAuxilio: true,  etiqueta: 'Prima de servicios',     cuenta: '2610', base: 'Salario + auxilio de transporte' },
  vacaciones:         { pct: 4.17,  incluyeAuxilio: false, etiqueta: 'Vacaciones',             cuenta: '2525', base: 'Salario sin auxilio de transporte' }
};

// ═════════════════════════════════════════════════════════════════════════════
// 4 · SEGURIDAD SOCIAL Y PARAFISCALES
// ─────────────────────────────────────────────────────────────────────────────
// EXONERACIÓN (Ley 1819 de 2016, art. 65 — modificó el art. 114-1 del E.T.):
// Las sociedades contribuyentes del impuesto de renta están EXONERADAS de
// aportar salud (8,5%), SENA (2%) e ICBF (3%) por los empleados que ganen
// MENOS de 10 SMMLV. La Caja de Compensación (4%) NUNCA se exonera.
//
// Efecto práctico: para una SAS con empleados de salario normal, el aporte
// patronal baja de ~32,5% a ~19%. Es una diferencia enorme en el costo real.
// ═════════════════════════════════════════════════════════════════════════════
const SEGURIDAD_SOCIAL = {
  // A cargo del EMPLEADOR
  patronal: {
    salud:     { pct: 8.5,  exonerable: true,  etiqueta: 'Salud (EPS)' },
    pension:   { pct: 12,   exonerable: false, etiqueta: 'Pensión' },
    sena:      { pct: 2,    exonerable: true,  etiqueta: 'SENA' },
    icbf:      { pct: 3,    exonerable: true,  etiqueta: 'ICBF' },
    caja:      { pct: 4,    exonerable: false, etiqueta: 'Caja de Compensación' }
    // ARL va aparte: depende de la clase de riesgo de cada cargo
  },
  // A cargo del EMPLEADO (se descuenta del pago)
  empleado: {
    salud:   { pct: 4, etiqueta: 'Salud (EPS)' },
    pension: { pct: 4, etiqueta: 'Pensión' }
  },
  // Umbral de exoneración
  topeExoneracionSMMLV: 10
};

// ─── ARL por clase de riesgo (Decreto 1772 de 1994, art. 13) ─────────────────
//
// LA CLASE ES POR TRABAJADOR, NO POR EMPRESA.
// Una misma empresa puede tener a la auxiliar comercial en clase I (oficina)
// y al mensajero que manipula cilindros a presión en clase IV. La clase la
// asigna la ARL según la actividad real del cargo y el centro de trabajo, no
// se elige libremente.
//
// CADA CLASE TIENE UN RANGO, NO UN VALOR ÚNICO.
// La tarifa "inicial" es con la que arranca toda empresa nueva. Después la ARL
// puede subirla o bajarla dentro del rango según la siniestralidad y el
// cumplimiento del SG-SST. Por eso el sistema permite registrar la tarifa REAL
// que la ARL le asignó a cada trabajador — si no se indica, usa la inicial.
const CLASES_RIESGO_ARL = {
  I:   { pct: 0.522, min: 0.348, max: 0.696, etiqueta: 'Clase I · Riesgo mínimo',  ejemplo: 'Trabajo administrativo, oficina, comercial interno' },
  II:  { pct: 1.044, min: 0.435, max: 1.653, etiqueta: 'Clase II · Riesgo bajo',   ejemplo: 'Ventas externas, mensajería urbana' },
  III: { pct: 2.436, min: 0.783, max: 4.089, etiqueta: 'Clase III · Riesgo medio', ejemplo: 'Taller, mantenimiento, manipulación de equipos' },
  IV:  { pct: 4.350, min: 1.740, max: 6.960, etiqueta: 'Clase IV · Riesgo alto',   ejemplo: 'Trabajo en campo, manejo de gases a presión' },
  V:   { pct: 6.960, min: 3.219, max: 8.700, etiqueta: 'Clase V · Riesgo máximo',  ejemplo: 'Trabajo en alturas, sustancias peligrosas' }
};

/**
 * Devuelve la tarifa de ARL que aplica a un empleado.
 * Prioriza la tarifa real asignada por la ARL; si no hay, usa la inicial de
 * la clase. Valida que la tarifa personalizada esté dentro del rango legal.
 */
const tarifaARL = (empleado) => {
  const clase = CLASES_RIESGO_ARL[empleado?.claseRiesgoARL] || CLASES_RIESGO_ARL.III;
  const custom = empleado?.tarifaARLPersonalizada;
  if (custom === undefined || custom === null || custom === '') {
    return { pct: clase.pct, clase, personalizada: false, fueraDeRango: false };
  }
  const v = Number(custom);
  if (!isFinite(v) || v <= 0) {
    return { pct: clase.pct, clase, personalizada: false, fueraDeRango: false };
  }
  return {
    pct: v,
    clase,
    personalizada: true,
    // No se bloquea: se avisa. Puede haber convenios especiales.
    fueraDeRango: v < clase.min || v > clase.max
  };
};

// ─── Fondo de Solidaridad Pensional ──────────────────────────────────────────
// A cargo del empleado, adicional, si gana 4 SMMLV o más (Ley 797 de 2003).
//
// ⚠️ LA BASE ES MENSUAL, SIEMPRE. Ver `calcularFSPPeriodo` abajo: pasarle acá
// la base de una quincena hace que un salario de 4 SMMLV se vea como 2 y el
// descuento no se practique.
const calcularFSP = (salario, smmlv) => {
  const enSMMLV = salario / smmlv;
  if (enSMMLV < 4)  return 0;
  if (enSMMLV < 16) return salario * 0.01;
  if (enSMMLV < 17) return salario * 0.012;
  if (enSMMLV < 18) return salario * 0.014;
  if (enSMMLV < 19) return salario * 0.016;
  if (enSMMLV < 20) return salario * 0.018;
  return salario * 0.02;
};

/**
 * ✅ FIX NOMINA-QUINCENAL-001
 *
 * FSP de un PERÍODO que puede no ser un mes completo (quincena, ingreso o
 * retiro a mitad de mes).
 *
 * EL BUG QUE CORRIGE
 * ------------------
 * `calcularFSP` compara la base contra los 4 SMMLV de la ley. Si se le pasa la
 * base de una quincena, un trabajador de 4 SMMLV se ve como 2 SMMLV: cae bajo
 * el umbral y NO se le descuenta nada. Dos quincenas del mes daban $0 de FSP
 * donde la nómina mensual daba el descuento completo.
 *
 * Afectaba a todo salario entre 4 y 8 SMMLV. Y entre 16 y 20 SMMLV la mitad
 * caía en una banda inferior, descontando de menos.
 *
 * LA REGLA: se mensualiza la base, se evalúa la escala contra el mes, y el
 * resultado se prorratea por los días del período. Así dos quincenas suman
 * exactamente lo mismo que una nómina mensual.
 */
const calcularFSPPeriodo = (baseDelPeriodo, smmlv, diasTrabajados = 30) => {
  const dias = Math.min(30, Math.max(0, Number(diasTrabajados) || 0));
  if (dias <= 0) return 0;
  const baseMensualizada = (Number(baseDelPeriodo) || 0) * 30 / dias;
  return Math.round(calcularFSP(baseMensualizada, smmlv) * dias / 30);
};

// ═════════════════════════════════════════════════════════════════════════════
// 5 · HORAS EXTRAS Y RECARGOS — Ley 2466 de 2025 (reforma laboral)
// ─────────────────────────────────────────────────────────────────────────────
// DOS CAMBIOS QUE IMPORTAN:
//
// 1. La jornada nocturna volvió a las 7:00 p.m. (antes era 9:00 p.m.).
//    Todo lo trabajado entre 7 p.m. y 6 a.m. lleva recargo nocturno del 35%.
//
// 2. El recargo dominical y festivo sube ESCALONADAMENTE:
//       hasta 30/jun/2026 → 80%
//       desde 01/jul/2026 → 90%   ← ya está vigente
//       desde 01/jul/2027 → 100%
//    Por eso el cálculo depende de la FECHA del período liquidado, no del
//    momento en que se abre la pantalla.
// ═════════════════════════════════════════════════════════════════════════════
const recargoDominicalVigente = (fechaISO) => {
  const f = String(fechaISO || '').slice(0, 10);
  if (f >= '2027-07-01') return 100;
  if (f >= '2026-07-01') return 90;
  return 80;
};

const HORAS_MES_LEGAL = 220;   // 44 horas semanales tras la reforma (Ley 2101/2021)

const conceptosHoras = (fechaISO) => {
  const dom = recargoDominicalVigente(fechaISO);
  return {
    recargo_nocturno:        { pct: 35,        etiqueta: 'Recargo nocturno (7pm–6am)',    esRecargo: true },
    recargo_dominical:       { pct: dom,       etiqueta: `Recargo dominical/festivo`,      esRecargo: true },
    recargo_nocturno_dom:    { pct: dom + 35,  etiqueta: 'Recargo nocturno dominical',     esRecargo: true },
    extra_diurna:            { pct: 25,        etiqueta: 'Hora extra diurna',              esRecargo: false },
    extra_nocturna:          { pct: 75,        etiqueta: 'Hora extra nocturna',            esRecargo: false },
    extra_diurna_dom:        { pct: dom + 25,  etiqueta: 'Hora extra diurna dominical',    esRecargo: false },
    extra_nocturna_dom:      { pct: dom + 75,  etiqueta: 'Hora extra nocturna dominical',  esRecargo: false }
  };
};

// Valor de una hora ordinaria
const valorHoraOrdinaria = (salarioMensual) => (Number(salarioMensual) || 0) / HORAS_MES_LEGAL;

/**
 * Calcula el valor de las horas extras y recargos de un período.
 *
 * Un RECARGO paga solo el porcentaje adicional (la hora ordinaria ya está en
 * el salario). Una HORA EXTRA paga la hora completa más el porcentaje.
 */
const calcularHorasExtras = (salarioMensual, horas = {}, fechaISO) => {
  const vh = valorHoraOrdinaria(salarioMensual);
  const conceptos = conceptosHoras(fechaISO);
  const detalle = [];
  let total = 0;

  for (const [clave, cfg] of Object.entries(conceptos)) {
    const cantidad = Number(horas[clave]) || 0;
    if (cantidad <= 0) continue;
    // Recargo: solo el %. Extra: 100% + %.
    const factor = cfg.esRecargo ? (cfg.pct / 100) : (1 + cfg.pct / 100);
    const valor = Math.round(vh * factor * cantidad);
    detalle.push({
      clave, etiqueta: cfg.etiqueta, pct: cfg.pct, cantidad,
      valorHora: Math.round(vh * factor), valor, esRecargo: cfg.esRecargo
    });
    total += valor;
  }

  return { valorHoraOrdinaria: Math.round(vh), horasMes: HORAS_MES_LEGAL, detalle, total };
};

// ═════════════════════════════════════════════════════════════════════════════
// 6 · PROVISIÓN MENSUAL DE PRESTACIONES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Calcula la provisión de prestaciones sociales de UN empleado para UN mes.
 *
 * @param {object} empleado {
 *   tipoContrato, salario, auxilioTransporteManual?, claseRiesgoARL,
 *   fechaInicio, fechaFin?, activo
 * }
 * @param {object} opciones {
 *   anio, mes, diasTrabajados (default 30), empresaExonerada (default true),
 *   devengadoAdicional (horas extras, comisiones — sí entran en la base)
 * }
 */
function calcularProvisionMensual(empleado, opciones = {}) {
  const anio = Number(opciones.anio) || new Date().getFullYear();
  const P = parametrosAnio(anio);
  const tipo = TIPOS_CONTRATO[empleado?.tipoContrato] || TIPOS_CONTRATO.indefinido;
  const diasTrabajados = Math.min(30, Math.max(0, Number(opciones.diasTrabajados ?? 30)));
  const salario = Number(empleado?.salario) || 0;
  const devengadoAdicional = Number(opciones.devengadoAdicional) || 0;

  const resultado = {
    empleadoId: empleado?.id || null,
    nombre: empleado?.nombre || '',
    tipoContrato: tipo.id,
    tipoContratoEtiqueta: tipo.etiqueta,
    anio, mes: opciones.mes ?? null,
    parametros: P,
    salario, diasTrabajados,
    aplicaProvision: tipo.generaPrestaciones,
    motivoNoAplica: null,
    auxilioTransporte: 0,
    baseConAuxilio: 0,
    baseSinAuxilio: 0,
    prestaciones: {},
    totalPrestaciones: 0,
    seguridadSocialPatronal: {},
    totalSeguridadSocial: 0,
    costoTotalEmpleador: 0,
    factorPrestacional: 0
  };

  // ─── Contratos que NO generan prestaciones ────────────────────────────────
  if (!tipo.generaPrestaciones) {
    resultado.motivoNoAplica = tipo.id === 'prestacion_servicios'
      ? 'Contrato por prestación de servicios: relación civil, no laboral. No genera prestaciones sociales ni aportes patronales.'
      : tipo.id === 'integral'
        ? 'Salario integral: las prestaciones ya están incluidas en el factor prestacional del 30%. Provisionarlas aparte sería duplicar el gasto.'
        : 'Contrato de aprendizaje: el apoyo de sostenimiento no genera prestaciones sociales.';
  }

  // ─── Auxilio de transporte ────────────────────────────────────────────────
  // Se paga a quien gane hasta 2 SMMLV. Es el suscriptor quien puede forzarlo
  // (por ejemplo, si el empleado no lo recibe por vivir en el sitio de trabajo).
  if (tipo.aplicaAuxilioTransporte) {
    const tieneDerecho = salario <= (P.smmlv * 2);
    const forzado = empleado?.auxilioTransporteManual;
    const valorAux = forzado !== undefined && forzado !== null && forzado !== ''
      ? Number(forzado)
      : (tieneDerecho ? P.auxilioTransporte : 0);
    resultado.auxilioTransporte = Math.round(valorAux * diasTrabajados / 30);
    resultado.tieneDerechoAuxilio = tieneDerecho;
  }

  // ─── Bases de cálculo ─────────────────────────────────────────────────────
  const salarioProporcional = Math.round(salario * diasTrabajados / 30);
  resultado.salarioProporcional = salarioProporcional;
  resultado.baseSinAuxilio = salarioProporcional + devengadoAdicional;
  resultado.baseConAuxilio = resultado.baseSinAuxilio + resultado.auxilioTransporte;

  // ─── Prestaciones sociales ────────────────────────────────────────────────
  if (tipo.generaPrestaciones) {
    let total = 0;
    for (const [clave, cfg] of Object.entries(PRESTACIONES)) {
      const base = cfg.incluyeAuxilio ? resultado.baseConAuxilio : resultado.baseSinAuxilio;
      const valor = Math.round(base * cfg.pct / 100);
      resultado.prestaciones[clave] = {
        etiqueta: cfg.etiqueta, pct: cfg.pct, base, valor,
        cuentaPUC: cfg.cuenta, explicacionBase: cfg.base
      };
      total += valor;
    }
    resultado.totalPrestaciones = total;
  }

  // ─── Seguridad social y parafiscales patronales ───────────────────────────
  if (tipo.generaSeguridadSocialPatronal) {
    // Base: NO incluye auxilio de transporte (no es salario para aportes).
    // En salario integral se liquida sobre el 70%.
    let baseAportes = resultado.baseSinAuxilio;
    if (tipo.baseSeguridadSocialPct) {
      baseAportes = Math.round(baseAportes * tipo.baseSeguridadSocialPct / 100);
    }
    // El IBC no puede ser menor a 1 SMMLV proporcional
    const ibcMinimo = Math.round(P.smmlv * diasTrabajados / 30);
    baseAportes = Math.max(baseAportes, ibcMinimo);
    resultado.baseAportes = baseAportes;

    const exonerada = opciones.empresaExonerada !== false;
    const bajoTope = salario < (P.smmlv * SEGURIDAD_SOCIAL.topeExoneracionSMMLV);
    const aplicaExoneracion = exonerada && bajoTope;
    resultado.aplicaExoneracion = aplicaExoneracion;
    resultado.explicacionExoneracion = aplicaExoneracion
      ? `Exonerada de salud, SENA e ICBF (Ley 1819/2016 art. 65): el salario está por debajo de 10 SMMLV.`
      : bajoTope
        ? 'La empresa no está marcada como exonerada. Se aplican todos los aportes.'
        : `El salario supera 10 SMMLV (${new Intl.NumberFormat('es-CO').format(P.smmlv * 10)}): no aplica exoneración.`;

    let totalSS = 0;
    for (const [clave, cfg] of Object.entries(SEGURIDAD_SOCIAL.patronal)) {
      const exonerado = aplicaExoneracion && cfg.exonerable;
      const valor = exonerado ? 0 : Math.round(baseAportes * cfg.pct / 100);
      resultado.seguridadSocialPatronal[clave] = {
        etiqueta: cfg.etiqueta, pct: exonerado ? 0 : cfg.pct, pctNominal: cfg.pct,
        valor, exonerado
      };
      totalSS += valor;
    }

    // ARL — siempre se paga, nunca se exonera.
    // Es el único aporte que varía por TRABAJADOR y no por empresa: depende de
    // la actividad real del cargo. La comercial de oficina y el mensajero que
    // manipula cilindros no cotizan lo mismo aunque ganen igual.
    const t = tarifaARL(empleado);
    const valorARL = Math.round(baseAportes * t.pct / 100);
    resultado.seguridadSocialPatronal.arl = {
      etiqueta: `ARL · ${t.clase.etiqueta}`,
      pct: t.pct,
      pctInicialClase: t.clase.pct,
      rangoClase: { min: t.clase.min, max: t.clase.max },
      personalizada: t.personalizada,
      fueraDeRango: t.fueraDeRango,
      valor: valorARL,
      exonerado: false
    };
    if (t.fueraDeRango) {
      resultado.avisoARL = `La tarifa de ARL registrada (${t.pct}%) está fuera del rango legal de la ` +
        `${t.clase.etiqueta} (${t.clase.min}% a ${t.clase.max}%). Verificá la carta de la ARL.`;
    }
    totalSS += valorARL;

    resultado.totalSeguridadSocial = totalSS;
  }

  // ─── Costo total para el empleador ────────────────────────────────────────
  resultado.costoTotalEmpleador =
    resultado.baseConAuxilio + resultado.totalPrestaciones + resultado.totalSeguridadSocial;

  // Factor prestacional: cuánto cuesta realmente cada peso de salario
  resultado.factorPrestacional = resultado.baseSinAuxilio > 0
    ? Number((resultado.costoTotalEmpleador / resultado.baseSinAuxilio).toFixed(4))
    : 0;

  return resultado;
}

// ═════════════════════════════════════════════════════════════════════════════
// 7 · LIQUIDACIÓN DE NÓMINA (comprobante de pago)
// ─────────────────────────────────────────────────────────────────────────────
// Esto es lo que produce el comprobante de egreso de nómina: qué se le devenga
// al empleado, qué se le descuenta (incluidos los ANTICIPOS que pidió durante
// la quincena) y cuánto se le entrega efectivamente.
//
// La distinción que resuelve el problema del ERI:
//   · DEVENGADO  = el gasto del mes (va al estado de resultados)
//   · ANTICIPO   = plata que ya se entregó (era una cuenta por cobrar, ahora se cruza)
//   · NETO       = lo que efectivamente sale de caja hoy
//
// Antes, el anticipo se registraba como gasto Y el salario completo también:
// eso duplicaba el gasto. Aquí el anticipo se DESCUENTA, no se suma.
// ═════════════════════════════════════════════════════════════════════════════
function liquidarNomina(empleado, datos = {}) {
  const anio = Number(datos.anio) || new Date().getFullYear();
  const P = parametrosAnio(anio);
  const tipo = TIPOS_CONTRATO[empleado?.tipoContrato] || TIPOS_CONTRATO.indefinido;
  const salario = Number(empleado?.salario) || 0;
  const diasTrabajados = Math.min(30, Math.max(0, Number(datos.diasTrabajados ?? 30)));
  const fechaRef = datos.fechaPago || datos.hasta || `${anio}-01-01`;

  const devengados = [];
  const deducciones = [];

  // ─── DEVENGADOS ───────────────────────────────────────────────────────────
  const salarioProporcional = Math.round(salario * diasTrabajados / 30);
  devengados.push({
    clave: 'salario',
    etiqueta: diasTrabajados < 30 ? `Salario (${diasTrabajados} días)` : 'Salario',
    valor: salarioProporcional, esSalarial: true
  });

  // Horas extras y recargos
  const horas = calcularHorasExtras(salario, datos.horas || {}, fechaRef);
  for (const h of horas.detalle) {
    devengados.push({ clave: h.clave, etiqueta: `${h.etiqueta} (${h.cantidad}h)`, valor: h.valor, esSalarial: true });
  }

  // Auxilio de transporte — NO es salarial
  let auxilio = 0;
  if (tipo.aplicaAuxilioTransporte) {
    const forzado = empleado?.auxilioTransporteManual;
    const valorBase = forzado !== undefined && forzado !== null && forzado !== ''
      ? Number(forzado)
      : (salario <= P.smmlv * 2 ? P.auxilioTransporte : 0);
    auxilio = Math.round(valorBase * diasTrabajados / 30);
    if (auxilio > 0) {
      devengados.push({ clave: 'auxilio_transporte', etiqueta: 'Auxilio de transporte', valor: auxilio, esSalarial: false });
    }
  }

  // Otros devengados libres (comisiones, bonificaciones)
  for (const otro of (datos.otrosDevengados || [])) {
    const v = Number(otro.valor) || 0;
    if (v === 0) continue;
    devengados.push({
      clave: 'otro_devengado',
      etiqueta: otro.concepto || 'Otro devengado',
      valor: v,
      esSalarial: otro.esSalarial !== false
    });
  }

  const totalDevengado = devengados.reduce((a, d) => a + d.valor, 0);
  const baseSalarial = devengados.filter(d => d.esSalarial).reduce((a, d) => a + d.valor, 0);

  // ─── DEDUCCIONES ──────────────────────────────────────────────────────────
  if (tipo.esLaboral) {
    // IBC: base salarial, mínimo 1 SMMLV proporcional
    let ibc = baseSalarial;
    if (tipo.baseSeguridadSocialPct) ibc = Math.round(ibc * tipo.baseSeguridadSocialPct / 100);
    ibc = Math.max(ibc, Math.round(P.smmlv * diasTrabajados / 30));

    const saludEmp = Math.round(ibc * SEGURIDAD_SOCIAL.empleado.salud.pct / 100);
    const pensionEmp = Math.round(ibc * SEGURIDAD_SOCIAL.empleado.pension.pct / 100);
    deducciones.push({ clave: 'salud_empleado',   etiqueta: 'Salud (4%)',   valor: saludEmp });
    deducciones.push({ clave: 'pension_empleado', etiqueta: 'Pensión (4%)', valor: pensionEmp });

    // ✅ FIX NOMINA-QUINCENAL-001: la escala del FSP se evalúa contra el mes,
    // no contra la quincena. Ver calcularFSPPeriodo.
    const fsp = calcularFSPPeriodo(baseSalarial, P.smmlv, diasTrabajados);
    if (fsp > 0) deducciones.push({ clave: 'fsp', etiqueta: 'Fondo de Solidaridad Pensional', valor: fsp });
  }

  // ─── ANTICIPOS DE NÓMINA ──────────────────────────────────────────────────
  // Este es el corazón del asunto. Los anticipos que el empleado pidió durante
  // el período NO son un gasto: eran una cuenta por cobrar. Aquí se cruzan.
  const anticipos = datos.anticipos || [];
  const totalAnticipos = anticipos.reduce((a, x) => a + (Number(x.valor) || 0), 0);
  if (totalAnticipos > 0) {
    deducciones.push({
      clave: 'anticipos',
      etiqueta: `Anticipos del período (${anticipos.length})`,
      valor: totalAnticipos,
      esCruceAnticipo: true,
      detalle: anticipos.map(a => ({
        egresoId: a.egresoId || a.id, numero: a.numero,
        fecha: a.fecha, valor: Number(a.valor) || 0, concepto: a.concepto
      }))
    });
  }

  // Otras deducciones libres (embargos, libranzas, préstamos)
  for (const otra of (datos.otrasDeducciones || [])) {
    const v = Number(otra.valor) || 0;
    if (v === 0) continue;
    deducciones.push({ clave: 'otra_deduccion', etiqueta: otra.concepto || 'Otra deducción', valor: v });
  }

  const totalDeducciones = deducciones.reduce((a, d) => a + d.valor, 0);
  const netoAPagar = totalDevengado - totalDeducciones;

  // ✅ NOMINA-RETENCION-001: lo que se le RETIENE al trabajador para la PILA.
  // No es plata de la empresa: se descuenta del pago y se queda en caja hasta
  // que se paga la planilla el mes siguiente. Es un pasivo, no un ingreso.
  //
  // Importa especialmente con nómina QUINCENAL: se retiene dos veces al mes y
  // se paga una sola vez, así que entre la primera quincena y el pago de la
  // PILA pueden pasar seis semanas con esa plata en la cuenta.
  const CLAVES_RETENCION = ['salud_empleado', 'pension_empleado', 'fsp'];
  const retencionSeguridadSocial = deducciones
    .filter(d => CLAVES_RETENCION.includes(d.clave))
    .reduce((a, d) => a + d.valor, 0);

  // ─── PROVISIÓN Y APORTES PATRONALES DEL PERÍODO ───────────────────────────
  const provision = calcularProvisionMensual(empleado, {
    anio, mes: datos.mes, diasTrabajados,
    empresaExonerada: datos.empresaExonerada,
    devengadoAdicional: horas.total
  });

  return {
    empleadoId: empleado?.id || null,
    nombre: empleado?.nombre || '',
    documento: empleado?.documento || '',
    cargo: empleado?.cargo || '',
    tipoContrato: tipo.id,
    tipoContratoEtiqueta: tipo.etiqueta,
    periodo: { anio, mes: datos.mes ?? null, desde: datos.desde || null, hasta: datos.hasta || null, diasTrabajados },
    parametros: P,
    horasExtras: horas,
    devengados, totalDevengado, baseSalarial,
    deducciones, totalDeducciones, totalAnticipos,
    netoAPagar,
    // ✅ NOMINA-RETENCION-001
    retencionSeguridadSocial,
    provision,
    // El costo REAL del empleado para la empresa este período
    costoTotalEmpleador: totalDevengado + provision.totalPrestaciones + provision.totalSeguridadSocial,
    // Advertencias contables
    advertencias: [
      ...(netoAPagar < 0 ? [{
        nivel: 'grave',
        texto: `El neto a pagar es negativo (${netoAPagar}). Los anticipos y deducciones superan lo devengado. Revisá si algún anticipo ya fue descontado en otro período.`
      }] : []),
      ...(tipo.id === 'prestacion_servicios' ? [{
        nivel: 'media',
        texto: tipo.advertencia
      }] : []),
      ...(P.estimado ? [{
        nivel: 'media',
        texto: `No hay parámetros cargados para ${anio}. Se usaron los de ${P.anioBase}. Actualizá el salario mínimo del año en el motor de nómina.`
      }] : [])
    ]
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 8 · TERMINACIÓN DE CONTRATO — INDEMNIZACIÓN Y LIQUIDACIÓN DEFINITIVA
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-LIQUIDACION-001
//
// Lo que faltaba: el módulo causaba el pasivo pero no sabía cerrarlo. Cuando un
// empleado se retiraba, su provisión acumulada quedaba huérfana en el balance.
//
// DOS CÁLCULOS DISTINTOS QUE NO HAY QUE MEZCLAR
// --------------------------------------------
//   1. LIQUIDACIÓN  · lo que el empleado YA se ganó (cesantías, intereses,
//      prima, vacaciones, salario pendiente). Esto se DESCARGA contra la
//      provisión: no es gasto nuevo, ya se causó mes a mes.
//
//   2. INDEMNIZACIÓN · la sanción por terminar sin justa causa. NUNCA se
//      provisiona (no se sabe si va a pasar) y NO constituye salario: no
//      genera prestaciones ni aportes. Es gasto NUEVO del mes del despido.
//
// Confundirlas es el error clásico: descargar la indemnización contra la
// provisión deja el pasivo corto y el gasto subestimado.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Días entre dos fechas en año comercial de 360 días (30 días por mes).
 * Es la convención laboral colombiana para liquidar prestaciones.
 * Inclusive de ambos extremos: del 1 al 30 de enero son 30 días.
 */
const dias360 = (desdeISO, hastaISO) => {
  const d = String(desdeISO || '').slice(0, 10);
  const h = String(hastaISO || '').slice(0, 10);
  if (d.length !== 10 || h.length !== 10 || h < d) return 0;
  const [ay, am, ad] = d.split('-').map(Number);
  const [by, bm, bd] = h.split('-').map(Number);
  const diaA = Math.min(ad, 30);
  const diaB = Math.min(bd, 30);
  return Math.max(0, (by - ay) * 360 + (bm - am) * 30 + (diaB - diaA) + 1);
};

/** Suma días a una fecha ISO (calendario real, para preavisos). */
const sumarDias = (fechaISO, dias) => {
  const f = new Date(String(fechaISO).slice(0, 10) + 'T00:00:00');
  if (isNaN(f)) return null;
  f.setDate(f.getDate() + Number(dias || 0));
  return f.toISOString().slice(0, 10);
};

// ─── Motivos de terminación ──────────────────────────────────────────────────
// Solo uno genera indemnización. Se declaran acá para que la UI los liste sin
// hardcodear strings y para que el backend valide contra la misma fuente.
const MOTIVOS_TERMINACION = {
  sin_justa_causa: {
    id: 'sin_justa_causa',
    etiqueta: 'Despido sin justa causa',
    generaIndemnizacion: true,
    descripcion: 'El empleador termina el contrato sin una de las causales del art. 62 CST. Genera indemnización del art. 64 CST.'
  },
  justa_causa: {
    id: 'justa_causa',
    etiqueta: 'Despido con justa causa',
    generaIndemnizacion: false,
    descripcion: 'Terminación por una causal del art. 62 CST, con proceso disciplinario y diligencia de descargos documentada. Sin indemnización.',
    advertencia: 'La justa causa debe estar probada y documentada (carta motivada + diligencia de descargos). Si un juez la desestima, se paga la indemnización más las costas.'
  },
  renuncia: {
    id: 'renuncia',
    etiqueta: 'Renuncia voluntaria',
    generaIndemnizacion: false,
    descripcion: 'El trabajador termina el contrato. Se liquida lo causado, sin indemnización.'
  },
  mutuo_acuerdo: {
    id: 'mutuo_acuerdo',
    etiqueta: 'Mutuo acuerdo',
    generaIndemnizacion: false,
    descripcion: 'Terminación acordada entre las partes. Puede pactarse una bonificación, que se registra como otro devengado — no es indemnización de ley.'
  },
  vencimiento_plazo: {
    id: 'vencimiento_plazo',
    etiqueta: 'Vencimiento del plazo pactado',
    generaIndemnizacion: false,
    descripcion: 'Termina un contrato a término fijo en su fecha, con preaviso de 30 días dado a tiempo. Sin indemnización.',
    advertencia: 'Sin preaviso escrito con 30 días de anticipación, el contrato se renueva automáticamente por un período igual (art. 46 CST).'
  },
  terminacion_obra: {
    id: 'terminacion_obra',
    etiqueta: 'Terminación de la obra o labor',
    generaIndemnizacion: false,
    descripcion: 'La obra contratada terminó. Sin indemnización si efectivamente concluyó.'
  }
};

/**
 * Indemnización por despido sin justa causa — art. 64 CST (Ley 789/2002 art. 28).
 *
 * TÉRMINO FIJO      · salarios del tiempo que falte hasta la fecha pactada
 * OBRA O LABOR      · tiempo que falte para terminar la obra, mínimo 15 días
 * INDEFINIDO < 10 SMMLV · 30 días el primer año + 20 días por año adicional
 * INDEFINIDO ≥ 10 SMMLV · 20 días el primer año + 15 días por año adicional
 *
 * La fracción de año posterior al primero se paga proporcionalmente.
 *
 * @param {object} empleado  { tipoContrato, salario, fechaInicio, fechaFin }
 * @param {object} opciones  { fechaRetiro, anio, salarioBase?, fechaFinObra? }
 */
function calcularIndemnizacion(empleado, opciones = {}) {
  const anio = Number(opciones.anio) || Number(String(opciones.fechaRetiro || '').slice(0, 4)) || new Date().getFullYear();
  const P = parametrosAnio(anio);
  const tipo = TIPOS_CONTRATO[empleado?.tipoContrato] || TIPOS_CONTRATO.indefinido;
  const fechaRetiro = String(opciones.fechaRetiro || '').slice(0, 10);
  const fechaInicio = String(empleado?.fechaInicio || '').slice(0, 10);

  // La base es el SALARIO (incluye factores salariales como comisiones y
  // extras habituales). NO incluye auxilio de transporte: no es salario.
  const salarioBase = Number(opciones.salarioBase) || Number(empleado?.salario) || 0;
  const valorDia = salarioBase / 30;

  const r = {
    aplica: false,
    tipoContrato: tipo.id,
    tipoContratoEtiqueta: tipo.etiqueta,
    salarioBase,
    valorDia: Math.round(valorDia),
    dias: 0,
    valor: 0,
    formula: '',
    fundamento: 'Art. 64 CST, modificado por la Ley 789 de 2002 art. 28',
    avisos: []
  };

  if (!tipo.esLaboral) {
    r.formula = 'La relación no es laboral: no hay indemnización del art. 64 CST.';
    return r;
  }
  if (!fechaInicio || !fechaRetiro) {
    r.avisos.push({ nivel: 'grave', texto: 'Falta la fecha de ingreso o la de retiro: no se puede calcular la indemnización.' });
    return r;
  }

  r.aplica = true;
  const antiguedadDias = dias360(fechaInicio, fechaRetiro);
  r.antiguedadDias = antiguedadDias;
  r.antiguedadAnios = Number((antiguedadDias / 360).toFixed(2));

  // ─── Término fijo: lo que falte del plazo pactado ──────────────────────────
  if (tipo.id === 'fijo') {
    const pactada = String(empleado?.fechaFin || '').slice(0, 10);
    if (!pactada) {
      r.aplica = false;
      r.avisos.push({
        nivel: 'grave',
        texto: 'El contrato es a término fijo pero no tiene fecha de terminación pactada. Sin ella no se puede calcular la indemnización.'
      });
      return r;
    }
    if (pactada <= fechaRetiro) {
      r.dias = 0; r.valor = 0;
      r.formula = 'El plazo pactado ya venció: terminar el contrato en esta fecha no genera indemnización.';
      return r;
    }
    // El día de retiro ya se paga como salario: se cuenta desde el siguiente.
    r.dias = Math.max(0, dias360(fechaRetiro, pactada) - 1);
    r.valor = Math.round(valorDia * r.dias);
    r.formula = `Término fijo: ${r.dias} días que faltan hasta el ${pactada} × ${Math.round(valorDia).toLocaleString('es-CO')}/día`;
    return r;
  }

  // ─── Obra o labor: lo que falte, mínimo 15 días ────────────────────────────
  if (tipo.id === 'obra_labor') {
    const finObra = String(opciones.fechaFinObra || empleado?.fechaFinObraEstimada || '').slice(0, 10);
    let diasRestantes = 0;
    if (finObra && finObra > fechaRetiro) {
      diasRestantes = Math.max(0, dias360(fechaRetiro, finObra) - 1);
    } else {
      r.avisos.push({
        nivel: 'media',
        texto: 'No hay fecha estimada de terminación de la obra. Se aplica el mínimo legal de 15 días; si la obra tenía más tiempo por delante, la indemnización es mayor.'
      });
    }
    r.dias = Math.max(15, diasRestantes);
    r.valor = Math.round(valorDia * r.dias);
    r.formula = diasRestantes > 15
      ? `Obra o labor: ${r.dias} días que faltan para terminar la obra`
      : 'Obra o labor: mínimo legal de 15 días de salario';
    return r;
  }

  // ─── Indefinido: escala del art. 64 ────────────────────────────────────────
  const topeAlto = P.smmlv * 10;
  const esSalarioAlto = salarioBase >= topeAlto;
  const diasPrimerAnio = esSalarioAlto ? 20 : 30;
  const diasPorAnioAdicional = esSalarioAlto ? 15 : 20;

  if (antiguedadDias <= 360) {
    // Menos de un año se paga completo el primer año: es un mínimo, no un prorrateo.
    r.dias = diasPrimerAnio;
    r.formula = `Indefinido, salario ${esSalarioAlto ? '≥' : '<'} 10 SMMLV: ${diasPrimerAnio} días por el primer año`;
  } else {
    const diasAdicionales = antiguedadDias - 360;
    const proporcional = (diasAdicionales / 360) * diasPorAnioAdicional;
    r.dias = Number((diasPrimerAnio + proporcional).toFixed(2));
    r.formula =
      `Indefinido, salario ${esSalarioAlto ? '≥' : '<'} 10 SMMLV: ${diasPrimerAnio} días del primer año ` +
      `+ ${proporcional.toFixed(2)} días por ${(diasAdicionales / 360).toFixed(2)} años adicionales ` +
      `(${diasPorAnioAdicional} días/año, proporcional por fracción)`;
  }
  r.valor = Math.round(valorDia * r.dias);
  r.escala = { diasPrimerAnio, diasPorAnioAdicional, topeAlto, esSalarioAlto };

  // Régimen de transición: quien tenía 10+ años al 27-dic-2002 conserva el
  // régimen anterior (más favorable). No se calcula acá: se advierte.
  if (fechaInicio <= '1992-12-27') {
    r.avisos.push({
      nivel: 'grave',
      texto: 'Este trabajador tenía 10 o más años de servicio al 27 de diciembre de 2002. ' +
             'Conserva el régimen de indemnización anterior a la Ley 789 de 2002, que es más favorable ' +
             'y puede incluir reintegro. El valor calculado acá NO le aplica: consultá con un abogado laboral.'
    });
  }

  return r;
}

/**
 * Retención en la fuente sobre indemnizaciones laborales — art. 401-3 ET.
 * 20% para trabajadores que devenguen más de 204 UVT mensuales.
 */
const retencionIndemnizacion = (valorIndemnizacion, salarioMensual, anio) => {
  const P = parametrosAnio(anio);
  const tope = P.uvt * 204;
  const aplica = Number(salarioMensual) > tope;
  return {
    aplica,
    pct: aplica ? 20 : 0,
    topeUVT: 204,
    topePesos: Math.round(tope),
    valor: aplica ? Math.round(Number(valorIndemnizacion) * 0.20) : 0,
    fundamento: 'Art. 401-3 ET: retención del 20% sobre indemnizaciones laborales de trabajadores que devenguen más de 204 UVT mensuales.'
  };
};

/**
 * LIQUIDACIÓN DEFINITIVA DE CONTRATO.
 *
 * Devuelve tres bloques que el backend usa para asientos distintos:
 *   · prestaciones  → se DESCARGAN contra la provisión acumulada
 *   · indemnizacion → gasto NUEVO del período
 *   · deducciones   → menor valor a pagar
 *
 * @param {object} empleado
 * @param {object} datos {
 *   fechaRetiro, motivo, anio?,
 *   diasVacacionesPendientes?  (días de vacaciones no disfrutadas, en días de salario)
 *   fechaUltimasVacaciones?    (si no se pasa, se toma desde fechaInicio)
 *   salarioBaseIndemnizacion?  (promedio con factores variables)
 *   otrosDevengados[], otrasDeducciones[],
 *   diasSalarioPendiente?      (días del mes de retiro aún no pagados)
 *   fechaFinObra?
 * }
 */
function liquidarContrato(empleado, datos = {}) {
  const fechaRetiro = String(datos.fechaRetiro || '').slice(0, 10);
  const anio = Number(datos.anio) || Number(fechaRetiro.slice(0, 4)) || new Date().getFullYear();
  const P = parametrosAnio(anio);
  const tipo = TIPOS_CONTRATO[empleado?.tipoContrato] || TIPOS_CONTRATO.indefinido;
  const motivo = MOTIVOS_TERMINACION[datos.motivo] || MOTIVOS_TERMINACION.sin_justa_causa;

  const salario = Number(empleado?.salario) || 0;
  const fechaInicio = String(empleado?.fechaInicio || '').slice(0, 10);

  const r = {
    empleadoId: empleado?.id || null,
    nombre: empleado?.nombre || '',
    documento: empleado?.documento || '',
    tipoContrato: tipo.id,
    tipoContratoEtiqueta: tipo.etiqueta,
    motivo: motivo.id,
    motivoEtiqueta: motivo.etiqueta,
    fechaInicio, fechaRetiro,
    parametros: P,
    prestaciones: {},
    totalPrestaciones: 0,
    salarioPendiente: 0,
    otrosDevengados: [],
    indemnizacion: null,
    deducciones: [],
    totalDeducciones: 0,
    totalADevengar: 0,
    netoAPagar: 0,
    avisos: []
  };

  if (!fechaInicio || !fechaRetiro) {
    r.avisos.push({ nivel: 'grave', texto: 'Se requieren fecha de ingreso y fecha de retiro para liquidar.' });
    return r;
  }
  if (fechaRetiro < fechaInicio) {
    r.avisos.push({ nivel: 'grave', texto: 'La fecha de retiro es anterior a la de ingreso.' });
    return r;
  }

  // ─── Auxilio de transporte del período ────────────────────────────────────
  const tieneAuxilio = tipo.aplicaAuxilioTransporte && salario <= P.smmlv * 2;
  const auxilioMensual = tieneAuxilio ? P.auxilioTransporte : 0;
  const baseConAuxilio = salario + auxilioMensual;

  // ─── Períodos de causación ────────────────────────────────────────────────
  // Cesantías e intereses: desde el 1-ene del año de retiro (o el ingreso si
  // fue después). Lo del año anterior YA se consignó al fondo el 14-feb.
  const inicioAnio = `${anio}-01-01`;
  const desdeCesantias = fechaInicio > inicioAnio ? fechaInicio : inicioAnio;
  const diasCesantias = dias360(desdeCesantias, fechaRetiro);

  // Prima: por semestre. Ene–jun o jul–dic.
  const mesRetiro = Number(fechaRetiro.slice(5, 7));
  const inicioSemestre = mesRetiro <= 6 ? `${anio}-01-01` : `${anio}-07-01`;
  const desdePrima = fechaInicio > inicioSemestre ? fechaInicio : inicioSemestre;
  const diasPrima = dias360(desdePrima, fechaRetiro);

  // Vacaciones: desde las últimas disfrutadas (o el ingreso).
  const desdeVacaciones = String(datos.fechaUltimasVacaciones || '').slice(0, 10) || fechaInicio;
  const diasVacaciones = datos.diasVacacionesPendientes !== undefined && datos.diasVacacionesPendientes !== null && datos.diasVacacionesPendientes !== ''
    ? null
    : dias360(desdeVacaciones, fechaRetiro);

  if (tipo.generaPrestaciones) {
    // Cesantías: salario + auxilio, proporcional a 360 días
    const cesantias = Math.round(baseConAuxilio * diasCesantias / 360);
    // Intereses: 12% anual sobre las cesantías, proporcional al tiempo
    const intereses = Math.round(cesantias * diasCesantias * 0.12 / 360);
    // Prima: salario + auxilio, proporcional al semestre
    const prima = Math.round(baseConAuxilio * diasPrima / 360);
    // Vacaciones: SIN auxilio, 15 días hábiles por año → días/720
    const vacaciones = diasVacaciones !== null
      ? Math.round(salario * diasVacaciones / 720)
      : Math.round((salario / 30) * Number(datos.diasVacacionesPendientes || 0));

    r.prestaciones = {
      cesantias: {
        etiqueta: 'Cesantías', valor: cesantias, dias: diasCesantias, cuentaPUC: '2510',
        base: baseConAuxilio, desde: desdeCesantias, hasta: fechaRetiro,
        explica: 'Solo el año en curso. Lo del año anterior ya se consignó al fondo el 14 de febrero.'
      },
      interesesCesantias: {
        etiqueta: 'Intereses a las cesantías', valor: intereses, dias: diasCesantias, cuentaPUC: '2515',
        base: cesantias, explica: '12% anual sobre las cesantías, proporcional al tiempo trabajado.'
      },
      prima: {
        etiqueta: 'Prima de servicios', valor: prima, dias: diasPrima, cuentaPUC: '2610',
        base: baseConAuxilio, desde: desdePrima, hasta: fechaRetiro,
        explica: `Proporcional al semestre en curso (${mesRetiro <= 6 ? 'enero–junio' : 'julio–diciembre'}).`
      },
      vacaciones: {
        etiqueta: 'Vacaciones compensadas', valor: vacaciones,
        dias: diasVacaciones, cuentaPUC: '2525', base: salario,
        explica: 'Sin auxilio de transporte. 15 días hábiles por año trabajado (días / 720).'
      }
    };
    r.totalPrestaciones = cesantias + intereses + prima + vacaciones;
  } else {
    r.avisos.push({
      nivel: 'media',
      texto: tipo.id === 'integral'
        ? 'Salario integral: las prestaciones ya están incluidas en el factor prestacional. Solo se liquidan vacaciones y salario pendiente.'
        : 'Este tipo de contrato no genera prestaciones sociales.'
    });
    if (tipo.id === 'integral') {
      const diasVac = diasVacaciones !== null ? diasVacaciones : 0;
      const vacaciones = Math.round(salario * 0.70 * diasVac / 720);
      r.prestaciones = {
        vacaciones: {
          etiqueta: 'Vacaciones compensadas', valor: vacaciones, dias: diasVac, cuentaPUC: '2525',
          base: Math.round(salario * 0.70),
          explica: 'En salario integral las vacaciones se liquidan sobre el 70% (factor salarial).'
        }
      };
      r.totalPrestaciones = vacaciones;
    }
  }

  // ─── Salario pendiente del mes de retiro ──────────────────────────────────
  const diasSalario = Number(datos.diasSalarioPendiente ?? diasTrabajadosEnMes(
    { ...empleado, fechaFin: fechaRetiro }, anio, mesRetiro
  )) || 0;
  r.salarioPendiente = Math.round(salario * diasSalario / 30);
  r.diasSalarioPendiente = diasSalario;
  r.auxilioPendiente = Math.round(auxilioMensual * diasSalario / 30);

  // ─── Otros devengados ─────────────────────────────────────────────────────
  r.otrosDevengados = (datos.otrosDevengados || [])
    .map(o => ({ concepto: o.concepto || 'Otro devengado', valor: Number(o.valor) || 0 }))
    .filter(o => o.valor !== 0);
  const totalOtros = r.otrosDevengados.reduce((a, o) => a + o.valor, 0);

  // ─── Indemnización ────────────────────────────────────────────────────────
  if (motivo.generaIndemnizacion) {
    const ind = calcularIndemnizacion(empleado, {
      fechaRetiro, anio,
      salarioBase: Number(datos.salarioBaseIndemnizacion) || salario,
      fechaFinObra: datos.fechaFinObra
    });
    ind.esGastoNuevo = true;
    ind.explica = 'La indemnización NO se provisiona ni constituye salario: no genera prestaciones ni aportes. ' +
                  'Es gasto del período en que se despide.';
    r.indemnizacion = ind;
    r.avisos.push(...(ind.avisos || []));
  }
  if (motivo.advertencia) {
    r.avisos.push({ nivel: 'media', texto: motivo.advertencia });
  }

  // ─── Deducciones ──────────────────────────────────────────────────────────
  // Salud y pensión SOLO sobre el salario del mes. Las prestaciones sociales
  // no son base de aportes. La indemnización tampoco.
  if (tipo.esLaboral && r.salarioPendiente > 0) {
    let ibc = r.salarioPendiente;
    if (tipo.baseSeguridadSocialPct) ibc = Math.round(ibc * tipo.baseSeguridadSocialPct / 100);
    ibc = Math.max(ibc, Math.round(P.smmlv * diasSalario / 30));
    r.deducciones.push({ clave: 'salud_empleado', etiqueta: 'Salud (4%)', valor: Math.round(ibc * 4 / 100) });
    r.deducciones.push({ clave: 'pension_empleado', etiqueta: 'Pensión (4%)', valor: Math.round(ibc * 4 / 100) });
    // ✅ FIX NOMINA-QUINCENAL-001: mismo criterio en la liquidación final —
    // si el retiro es a mitad de mes, la escala se evalúa contra el mes.
    const fsp = calcularFSPPeriodo(r.salarioPendiente, P.smmlv, diasSalario);
    if (fsp > 0) r.deducciones.push({ clave: 'fsp', etiqueta: 'Fondo de Solidaridad Pensional', valor: fsp });
  }

  // Retención sobre la indemnización
  if (r.indemnizacion && r.indemnizacion.valor > 0) {
    const ret = retencionIndemnizacion(r.indemnizacion.valor, salario, anio);
    r.retencionIndemnizacion = ret;
    if (ret.valor > 0) {
      r.deducciones.push({
        clave: 'retencion_indemnizacion',
        etiqueta: `Retención sobre indemnización (${ret.pct}%)`,
        valor: ret.valor,
        fundamento: ret.fundamento
      });
    }
  }

  // Anticipos y otras deducciones libres (préstamos, embargos, dotación)
  for (const o of (datos.otrasDeducciones || [])) {
    const v = Number(o.valor) || 0;
    if (v === 0) continue;
    r.deducciones.push({ clave: 'otra_deduccion', etiqueta: o.concepto || 'Otra deducción', valor: v });
  }

  r.totalDeducciones = r.deducciones.reduce((a, d) => a + d.valor, 0);
  r.totalADevengar =
    r.totalPrestaciones + r.salarioPendiente + r.auxilioPendiente + totalOtros +
    (r.indemnizacion?.valor || 0);
  r.netoAPagar = r.totalADevengar - r.totalDeducciones;

  // ─── Naturaleza contable de cada bloque ───────────────────────────────────
  // Esto es lo que el backend usa para no equivocarse en el asiento.
  r.contabilidad = {
    descargaProvision: r.totalPrestaciones,        // cruza contra el pasivo causado
    gastoNuevo: (r.indemnizacion?.valor || 0) + r.salarioPendiente + r.auxilioPendiente + totalOtros,
    explica: 'Las prestaciones se descargan contra la provisión acumulada (no son gasto nuevo). ' +
             'La indemnización, el salario pendiente y otros devengados sí son gasto del período.'
  };

  // ─── Avisos de protección especial ────────────────────────────────────────
  if (motivo.generaIndemnizacion) {
    r.avisos.push({
      nivel: 'grave',
      texto: 'Antes de terminar, verificá si el trabajador tiene protección especial: fuero de maternidad o ' +
             'lactancia, estabilidad reforzada por salud, prepensionado o fuero sindical. En esos casos el ' +
             'despido puede declararse INEFICAZ y ordenarse el reintegro con salarios dejados de percibir: ' +
             'pagar la indemnización no basta.'
    });
  }
  if (P.estimado) {
    r.avisos.push({
      nivel: 'media',
      texto: `No hay parámetros cargados para ${anio}. Se usaron los de ${P.anioBase}. Actualizá el salario mínimo del año.`
    });
  }

  return r;
}

/**
 * Preaviso de término fijo — art. 46 CST.
 * Sin aviso escrito 30 días antes del vencimiento, el contrato se renueva
 * automáticamente por un período igual.
 */
const estadoPreavisoFijo = (empleado, hoyISO) => {
  const tipo = TIPOS_CONTRATO[empleado?.tipoContrato];
  if (!tipo || tipo.id !== 'fijo') return null;
  const fin = String(empleado?.fechaFin || '').slice(0, 10);
  if (!fin) return null;
  const hoy = String(hoyISO || '').slice(0, 10);
  const limite = sumarDias(fin, -30);
  const dif = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
  const diasParaVencer = dif(fin, hoy);
  // Lo que importa no es cuánto falta para que venza el contrato, sino cuánto
  // queda para poder avisar. Se alerta dentro de los 30 días previos al límite:
  // así el aviso llega cuando todavía se puede actuar, no cuando ya no.
  const diasParaLimite = dif(limite, hoy);
  return {
    empleadoId: empleado?.id || null,
    nombre: empleado?.nombre || '',
    fechaFin: fin,
    fechaLimitePreaviso: limite,
    diasParaVencer,
    diasParaLimite,
    vencido: hoy > fin,
    preavisoVencido: hoy > limite && hoy <= fin,
    enVentana: diasParaLimite >= 0 && diasParaLimite <= 30,
    mensaje: hoy > fin
      ? 'El contrato ya venció. Si el trabajador sigue laborando y no hubo preaviso, se renovó por un período igual.'
      : hoy > limite
        ? `Ya pasó el plazo de preaviso (era el ${limite}). Si no avisaste por escrito, el contrato se renueva automáticamente por un período igual.`
        : `Tenés ${diasParaLimite} día(s) — hasta el ${limite} — para dar el preaviso escrito de no renovación.`
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// 9 · UTILIDADES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX NOMINA-EXTRAS-001
 *
 * Devengado adicional salarial de un comprobante de nómina ya generado:
 * horas extras, recargos, comisiones y bonificaciones salariales — todo menos
 * el salario base (que la provisión ya calcula por su cuenta) y el auxilio de
 * transporte (que no es salario y se suma aparte).
 *
 * POR QUÉ EXISTE: `calcularProvisionMensual` siempre aceptó `devengadoAdicional`,
 * pero la causación mensual nunca se lo pasaba. La provisión que se contabilizaba
 * quedaba sin horas extras, subvaluada en 21,83% de esas extras. Las horas
 * extras SON salario (art. 127 CST) y entran en la base de cesantías, intereses,
 * prima y vacaciones.
 *
 * @param {Array} comprobantes egresos con esComprobanteNomina === true
 */
const devengadoAdicionalDeComprobantes = (comprobantes = []) => {
  let total = 0;
  const detalle = [];
  for (const c of comprobantes) {
    const devengados = c?.liquidacion?.devengados || [];
    for (const d of devengados) {
      if (d.esSalarial !== true) continue;      // el auxilio queda fuera
      if (d.clave === 'salario') continue;      // ya lo calcula la provisión
      const v = Number(d.valor) || 0;
      if (v === 0) continue;
      total += v;
      detalle.push({ comprobante: c.numero || '', etiqueta: d.etiqueta || d.clave, valor: v });
    }
  }
  return { total, detalle };
};

/** Meses entre dos fechas — para saber cuántos períodos provisionar. */
const mesesEntre = (desdeISO, hastaISO) => {
  const d = new Date(String(desdeISO).slice(0, 10) + 'T00:00:00');
  const h = new Date(String(hastaISO).slice(0, 10) + 'T00:00:00');
  if (isNaN(d) || isNaN(h)) return [];
  const lista = [];
  const cur = new Date(d.getFullYear(), d.getMonth(), 1);
  const fin = new Date(h.getFullYear(), h.getMonth(), 1);
  while (cur <= fin) {
    lista.push({ anio: cur.getFullYear(), mes: cur.getMonth() + 1, clave: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}` });
    cur.setMonth(cur.getMonth() + 1);
  }
  return lista;
};

/** ¿El empleado estaba vigente en ese mes? */
const vigenteEnMes = (empleado, anio, mes) => {
  const ini = String(empleado?.fechaInicio || '').slice(0, 7);
  const fin = String(empleado?.fechaFin || '').slice(0, 7);
  const clave = `${anio}-${String(mes).padStart(2, '0')}`;
  if (ini && clave < ini) return false;
  if (fin && clave > fin) return false;
  return true;
};

/** Días trabajados en un mes, respetando ingreso y retiro a mitad de mes. */
const diasTrabajadosEnMes = (empleado, anio, mes) => {
  if (!vigenteEnMes(empleado, anio, mes)) return 0;
  const ini = String(empleado?.fechaInicio || '').slice(0, 10);
  const fin = String(empleado?.fechaFin || '').slice(0, 10);
  const primerDia = `${anio}-${String(mes).padStart(2, '0')}-01`;
  // Mes comercial de 30 días (norma laboral colombiana)
  const ultimoDia = `${anio}-${String(mes).padStart(2, '0')}-30`;

  let desde = 1, hasta = 30;
  if (ini && ini > primerDia && ini <= ultimoDia) desde = Math.min(30, Number(ini.slice(8, 10)));
  if (fin && fin >= primerDia && fin < ultimoDia)  hasta = Math.min(30, Number(fin.slice(8, 10)));
  return Math.max(0, hasta - desde + 1);
};

module.exports = {
  TABLA_ANUAL,
  parametrosAnio,
  TIPOS_CONTRATO,
  PRESTACIONES,
  SEGURIDAD_SOCIAL,
  CLASES_RIESGO_ARL,
  HORAS_MES_LEGAL,
  conceptosHoras,
  recargoDominicalVigente,
  valorHoraOrdinaria,
  tarifaARL,
  calcularHorasExtras,
  calcularFSP,
  calcularFSPPeriodo,
  calcularProvisionMensual,
  liquidarNomina,
  mesesEntre,
  vigenteEnMes,
  diasTrabajadosEnMes,
  // ── NOMINA-LIQUIDACION-001 ──
  MOTIVOS_TERMINACION,
  dias360,
  sumarDias,
  calcularIndemnizacion,
  retencionIndemnizacion,
  liquidarContrato,
  estadoPreavisoFijo,
  devengadoAdicionalDeComprobantes
};
