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

    const fsp = Math.round(calcularFSP(baseSalarial, P.smmlv));
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
// 8 · UTILIDADES
// ═════════════════════════════════════════════════════════════════════════════

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
  calcularProvisionMensual,
  liquidarNomina,
  mesesEntre,
  vigenteEnMes,
  diasTrabajadosEnMes
};
