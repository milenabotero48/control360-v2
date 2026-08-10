// ═══════════════════════════════════════════════════════════════════════════════
// analisisFinanciero.js — Indicadores y diagnóstico del negocio
// ─────────────────────────────────────────────────────────────────────────────
// FINANZAS-ANALISIS-001
//
// PARA QUÉ SIRVE
// --------------
// Un estado de resultados dice CUÁNTO. Este motor dice QUÉ SIGNIFICA y QUÉ HACER.
//
// La auditoría de julio 2026 lo dejó claro: el informe mostraba una pérdida de
// $2,5 millones, pero no decía que el 85% de esa pérdida venía de UN producto
// mal parametrizado. El número estaba; la lectura no.
//
// FILOSOFÍA
// ---------
// Cada indicador viene con tres cosas, no solo con el número:
//   · CUÁNTO   — el valor
//   · CÓMO ESTÁ — comparado con un rango sano para el sector
//   · QUÉ HACER — la acción concreta, no un consejo genérico
//
// Los rangos de referencia son de servicios técnicos y comercio de productos
// de seguridad industrial en Colombia. Se declaran explícitos y comentados para
// que un contador pueda discutirlos, no escondidos dentro de una fórmula.
//
// ⚠️ SIN ROE NI ENDEUDAMIENTO
// Esos indicadores necesitan patrimonio y deuda de largo plazo, que hoy no
// están en el sistema. Calcularlos con datos incompletos daría un número que
// parece serio y no lo es. Se dejan marcados como pendientes.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Estados de un indicador ─────────────────────────────────────────────────
const BIEN     = 'bien';
const ATENCION = 'atencion';
const CRITICO  = 'critico';
const NEUTRO   = 'neutro';   // informativo, no tiene rango bueno o malo

const money = (n) => {
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })
      .format(Math.round(Number(n) || 0));
  } catch { return '$' + Math.round(Number(n) || 0); }
};

const pct = (n, dec = 1) => `${(Number(n) || 0).toFixed(dec)}%`;
const div = (a, b) => (Number(b) || 0) === 0 ? null : (Number(a) || 0) / Number(b);

// ═════════════════════════════════════════════════════════════════════════════
// RANGOS DE REFERENCIA
// ─────────────────────────────────────────────────────────────────────────────
// Valores orientativos para una pyme colombiana de servicios técnicos con venta
// de productos. No son verdades absolutas: son puntos de partida para conversar.
// ═════════════════════════════════════════════════════════════════════════════
const REFERENCIA = {
  margenBruto:       { bien: 40, atencion: 25 },   // % — debajo de 25 no alcanza para los gastos fijos
  margenOperativo:   { bien: 10, atencion: 3 },
  margenNeto:        { bien: 8,  atencion: 0 },
  costoLaboral:      { bien: 30, atencion: 40 },   // % de ingresos — más alto = más rígida la estructura
  gastosFijos:       { bien: 12, atencion: 20 },   // % de ingresos
  diasCartera:       { bien: 30, atencion: 60 },   // días
  diasInventario:    { bien: 60, atencion: 120 },
  cicloEfectivo:     { bien: 45, atencion: 90 },   // días que la plata queda atrapada
  razonCorriente:    { bien: 1.5, atencion: 1.0 }, // veces
  pruebaAcida:       { bien: 1.0, atencion: 0.7 },
  concentracionCliente: { bien: 20, atencion: 35 } // % de ventas en un solo cliente
};

// Compara contra un rango donde MÁS es mejor
const evaluarMayor = (valor, ref) => {
  if (valor === null || valor === undefined) return NEUTRO;
  if (valor >= ref.bien) return BIEN;
  if (valor >= ref.atencion) return ATENCION;
  return CRITICO;
};

// Compara contra un rango donde MENOS es mejor
const evaluarMenor = (valor, ref) => {
  if (valor === null || valor === undefined) return NEUTRO;
  if (valor <= ref.bien) return BIEN;
  if (valor <= ref.atencion) return ATENCION;
  return CRITICO;
};

// ═════════════════════════════════════════════════════════════════════════════
// 1 · INDICADORES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Calcula todos los indicadores posibles con los datos disponibles.
 *
 * @param {object} d {
 *   ingresos, costoVentas, utilidadBruta, utilidadOperativa, utilidadNeta,
 *   gastosPersonal, gastosFijos, gastosOperativos, gastosAdministrativos,
 *   gastosFinancieros, gastosFiscales,
 *   inventarioAlCosto, cxc, cxp, saldoCajas,
 *   comprasPeriodo, diasPeriodo, empleados, ordenes
 * }
 */
function calcularIndicadores(d = {}) {
  const ingresos = Number(d.ingresos) || 0;
  const costoVentas = Number(d.costoVentas) || 0;
  const ub = Number(d.utilidadBruta) || (ingresos - costoVentas);
  const uo = Number(d.utilidadOperativa) || 0;
  const un = Number(d.utilidadNeta) || 0;
  const dias = Number(d.diasPeriodo) || 30;

  const inventario = Number(d.inventarioAlCosto) || 0;
  const cxc = Number(d.cxc) || 0;
  const cxp = Number(d.cxp) || 0;
  const caja = Number(d.saldoCajas) || 0;
  const compras = Number(d.comprasPeriodo) || 0;

  const gPersonal = Number(d.gastosPersonal) || 0;
  const gFijos = Number(d.gastosFijos) || 0;
  const gastosTotales = gPersonal + gFijos +
    (Number(d.gastosOperativos) || 0) + (Number(d.gastosAdministrativos) || 0) +
    (Number(d.gastosFinancieros) || 0) + (Number(d.gastosFiscales) || 0);

  const ind = [];

  // ─── RENTABILIDAD ──────────────────────────────────────────────────────────
  const margenBruto = ingresos > 0 ? (ub / ingresos) * 100 : null;
  ind.push({
    id: 'margen_bruto', grupo: 'Rentabilidad', nombre: 'Margen bruto',
    valor: margenBruto, formato: 'pct', display: margenBruto === null ? '—' : pct(margenBruto),
    estado: evaluarMayor(margenBruto, REFERENCIA.margenBruto),
    referencia: `Sano: más de ${REFERENCIA.margenBruto.bien}%`,
    formula: 'Utilidad bruta ÷ Ingresos',
    significa: 'De cada $100 que vendés, cuánto queda después de pagar lo que costó producir o comprar lo vendido. Es lo que tenés disponible para cubrir todos los gastos del negocio.'
  });

  const margenOperativo = ingresos > 0 ? (uo / ingresos) * 100 : null;
  ind.push({
    id: 'margen_operativo', grupo: 'Rentabilidad', nombre: 'Margen operativo',
    valor: margenOperativo, formato: 'pct', display: margenOperativo === null ? '—' : pct(margenOperativo),
    estado: evaluarMayor(margenOperativo, REFERENCIA.margenOperativo),
    referencia: `Sano: más de ${REFERENCIA.margenOperativo.bien}%`,
    formula: 'Utilidad operativa ÷ Ingresos',
    significa: 'Lo que gana el negocio por operar, sin contar intereses ni impuestos. Es el mejor termómetro de si el modelo funciona.'
  });

  const margenNeto = ingresos > 0 ? (un / ingresos) * 100 : null;
  ind.push({
    id: 'margen_neto', grupo: 'Rentabilidad', nombre: 'Margen neto',
    valor: margenNeto, formato: 'pct', display: margenNeto === null ? '—' : pct(margenNeto),
    estado: evaluarMayor(margenNeto, REFERENCIA.margenNeto),
    referencia: `Sano: más de ${REFERENCIA.margenNeto.bien}%`,
    formula: 'Utilidad neta ÷ Ingresos',
    significa: 'Lo que realmente queda de cada $100 vendidos, después de absolutamente todo.'
  });

  // ─── PUNTO DE EQUILIBRIO ───────────────────────────────────────────────────
  // Cuánto hay que vender para no perder ni ganar. Se calcula con el margen de
  // contribución: si de cada peso vendido quedan 67 centavos después del costo,
  // se necesitan vender los gastos ÷ 0,67.
  const margenContribucion = ingresos > 0 ? ub / ingresos : 0;
  const puntoEquilibrio = margenContribucion > 0 ? gastosTotales / margenContribucion : null;
  const faltante = puntoEquilibrio !== null ? puntoEquilibrio - ingresos : null;

  ind.push({
    id: 'punto_equilibrio', grupo: 'Rentabilidad', nombre: 'Punto de equilibrio',
    valor: puntoEquilibrio, formato: 'money',
    display: puntoEquilibrio === null ? '—' : money(puntoEquilibrio),
    estado: puntoEquilibrio === null ? NEUTRO : (ingresos >= puntoEquilibrio ? BIEN : CRITICO),
    referencia: faltante === null ? '' :
      (faltante > 0 ? `Te faltaron ${money(faltante)}` : `Lo superaste por ${money(-faltante)}`),
    formula: 'Gastos totales ÷ Margen de contribución',
    significa: 'Cuánto tenés que vender en el período para no perder ni ganar. Por debajo de esta cifra, cada día que abrís cuesta plata.'
  });

  // ─── ACTIVIDAD ─────────────────────────────────────────────────────────────
  // Días de cartera (DSO): cuánto tardás en cobrar lo que vendés
  const diasCartera = ingresos > 0 ? (cxc / ingresos) * dias : null;
  ind.push({
    id: 'dias_cartera', grupo: 'Actividad', nombre: 'Días de cartera',
    valor: diasCartera, formato: 'dias',
    display: diasCartera === null ? '—' : `${Math.round(diasCartera)} días`,
    estado: evaluarMenor(diasCartera, REFERENCIA.diasCartera),
    referencia: `Sano: menos de ${REFERENCIA.diasCartera.bien} días`,
    formula: '(Cartera ÷ Ingresos) × días del período',
    significa: 'Cuánto tardás en promedio en cobrar. Cada día de más es plata tuya financiando a tus clientes gratis.'
  });

  // Días de inventario: cuánto tarda en rotar el stock
  const diasInventario = costoVentas > 0 ? (inventario / costoVentas) * dias : null;
  ind.push({
    id: 'dias_inventario', grupo: 'Actividad', nombre: 'Días de inventario',
    valor: diasInventario, formato: 'dias',
    display: diasInventario === null ? '—' : `${Math.round(diasInventario)} días`,
    estado: evaluarMenor(diasInventario, REFERENCIA.diasInventario),
    referencia: `Sano: menos de ${REFERENCIA.diasInventario.bien} días`,
    formula: '(Inventario al costo ÷ Costo de ventas) × días del período',
    significa: 'Cuánto tarda tu mercancía en venderse. Inventario alto es plata dormida en la bodega, y riesgo de que se vuelva obsoleta.'
  });

  // Días de proveedores (DPO): cuánto tardás en pagar
  const diasProveedores = compras > 0 ? (cxp / compras) * dias : null;
  ind.push({
    id: 'dias_proveedores', grupo: 'Actividad', nombre: 'Días de proveedores',
    valor: diasProveedores, formato: 'dias',
    display: diasProveedores === null ? '—' : `${Math.round(diasProveedores)} días`,
    estado: NEUTRO,
    referencia: 'Mientras más días, mejor para tu caja',
    formula: '(Cuentas por pagar ÷ Compras) × días del período',
    significa: 'Cuánto tardás en pagarle a tus proveedores. Acá más días juega a tu favor: es financiación sin intereses.'
  });

  // ─── CICLO DE CONVERSIÓN DE EFECTIVO ───────────────────────────────────────
  // El indicador más importante para una pyme: cuántos días pasa tu plata
  // atrapada entre que comprás la mercancía y que cobrás la venta.
  const ciclo = (diasInventario !== null && diasCartera !== null)
    ? diasInventario + diasCartera - (diasProveedores || 0) : null;

  ind.push({
    id: 'ciclo_efectivo', grupo: 'Actividad', nombre: 'Ciclo de efectivo',
    valor: ciclo, formato: 'dias',
    display: ciclo === null ? '—' : `${Math.round(ciclo)} días`,
    estado: evaluarMenor(ciclo, REFERENCIA.cicloEfectivo),
    referencia: `Sano: menos de ${REFERENCIA.cicloEfectivo.bien} días`,
    destacado: true,
    formula: 'Días de inventario + Días de cartera − Días de proveedores',
    significa: 'Cuántos días pasa tu plata atrapada entre que comprás y que cobrás. Es el indicador que más explica por qué una empresa rentable puede quedarse sin caja.'
  });

  // ─── LIQUIDEZ ──────────────────────────────────────────────────────────────
  // Aproximación: no hay balance completo, pero con caja, cartera, inventario,
  // CxP y provisiones se arma una foto razonable del corto plazo.
  const activoCorriente = caja + cxc + inventario;
  const pasivoCorriente = cxp + (Number(d.provisionesPrestaciones) || 0) + (Number(d.impuestosPorPagar) || 0);

  const razonCorriente = div(activoCorriente, pasivoCorriente);
  ind.push({
    id: 'razon_corriente', grupo: 'Liquidez', nombre: 'Razón corriente',
    valor: razonCorriente, formato: 'veces',
    display: razonCorriente === null ? '—' : `${razonCorriente.toFixed(2)}`,
    estado: evaluarMayor(razonCorriente, REFERENCIA.razonCorriente),
    referencia: `Sano: más de ${REFERENCIA.razonCorriente.bien}`,
    aproximado: true,
    formula: '(Caja + Cartera + Inventario) ÷ (Por pagar + Prestaciones + Impuestos)',
    significa: 'Por cada peso que debés en el corto plazo, cuántos pesos tenés para responder. Por debajo de 1 significa que no alcanzás a cubrir lo que vence pronto.'
  });

  const pruebaAcida = div(activoCorriente - inventario, pasivoCorriente);
  ind.push({
    id: 'prueba_acida', grupo: 'Liquidez', nombre: 'Prueba ácida',
    valor: pruebaAcida, formato: 'veces',
    display: pruebaAcida === null ? '—' : `${pruebaAcida.toFixed(2)}`,
    estado: evaluarMayor(pruebaAcida, REFERENCIA.pruebaAcida),
    referencia: `Sano: más de ${REFERENCIA.pruebaAcida.bien}`,
    aproximado: true,
    formula: '(Caja + Cartera) ÷ Pasivo corriente',
    significa: 'Lo mismo que la razón corriente pero sin contar el inventario, porque venderlo toma tiempo. Es la prueba dura: si mañana te cobran todo, ¿respondés?'
  });

  const capitalTrabajo = activoCorriente - pasivoCorriente;
  ind.push({
    id: 'capital_trabajo', grupo: 'Liquidez', nombre: 'Capital de trabajo',
    valor: capitalTrabajo, formato: 'money', display: money(capitalTrabajo),
    estado: capitalTrabajo > 0 ? BIEN : CRITICO,
    referencia: capitalTrabajo > 0 ? 'Positivo' : 'Negativo — riesgo de iliquidez',
    aproximado: true,
    formula: 'Activo corriente − Pasivo corriente',
    significa: 'La plata que te queda libre para operar después de cubrir todo lo que vence en el corto plazo.'
  });

  // ─── ESTRUCTURA DE COSTOS ──────────────────────────────────────────────────
  const costoLaboralPct = ingresos > 0 ? (gPersonal / ingresos) * 100 : null;
  ind.push({
    id: 'costo_laboral', grupo: 'Estructura', nombre: 'Costo laboral',
    valor: costoLaboralPct, formato: 'pct',
    display: costoLaboralPct === null ? '—' : pct(costoLaboralPct),
    estado: evaluarMenor(costoLaboralPct, REFERENCIA.costoLaboral),
    referencia: `Sano: menos del ${REFERENCIA.costoLaboral.bien}%`,
    formula: 'Gastos de personal ÷ Ingresos',
    significa: 'Qué parte de lo que vendés se va en el equipo. En servicios técnicos es normal que sea el gasto más grande, pero por encima del 40% la estructura se vuelve rígida: si baja la venta, el gasto no baja.'
  });

  const gastosFijosPct = ingresos > 0 ? (gFijos / ingresos) * 100 : null;
  ind.push({
    id: 'gastos_fijos', grupo: 'Estructura', nombre: 'Gastos fijos',
    valor: gastosFijosPct, formato: 'pct',
    display: gastosFijosPct === null ? '—' : pct(gastosFijosPct),
    estado: evaluarMenor(gastosFijosPct, REFERENCIA.gastosFijos),
    referencia: `Sano: menos del ${REFERENCIA.gastosFijos.bien}%`,
    formula: 'Arriendo + servicios públicos ÷ Ingresos',
    significa: 'Lo que pagás llueva o truene. Mientras más bajo, más fácil aguantar un mes flojo.'
  });

  // ─── PRODUCTIVIDAD ─────────────────────────────────────────────────────────
  const nEmpleados = Number(d.empleados) || 0;
  if (nEmpleados > 0) {
    const ingresoPorEmpleado = ingresos / nEmpleados;
    ind.push({
      id: 'ingreso_empleado', grupo: 'Productividad', nombre: 'Ingreso por empleado',
      valor: ingresoPorEmpleado, formato: 'money', display: money(ingresoPorEmpleado),
      estado: NEUTRO,
      referencia: `${nEmpleados} empleado(s) en el período`,
      formula: 'Ingresos ÷ Número de empleados',
      significa: 'Cuánto factura la empresa por cada persona. Sirve para comparar contra vos misma mes a mes: si contratás y este número baja, la persona nueva todavía no se está pagando.'
    });

    // Cuántas veces cubre cada empleado su propio costo
    const costoPorEmpleado = gPersonal / nEmpleados;
    const vecesCosto = div(ingresoPorEmpleado, costoPorEmpleado);
    ind.push({
      id: 'retorno_empleado', grupo: 'Productividad', nombre: 'Retorno por empleado',
      valor: vecesCosto, formato: 'veces',
      display: vecesCosto === null ? '—' : `${vecesCosto.toFixed(1)}x`,
      estado: vecesCosto === null ? NEUTRO : (vecesCosto >= 3 ? BIEN : vecesCosto >= 2 ? ATENCION : CRITICO),
      referencia: 'Sano: más de 3x',
      formula: 'Ingreso por empleado ÷ Costo por empleado',
      significa: 'Cuántas veces cubre cada persona su propio costo. Debajo de 2x, la operación no da para sostener la estructura.'
    });
  }

  const nOrdenes = Number(d.ordenes) || 0;
  if (nOrdenes > 0) {
    const ticket = ingresos / nOrdenes;
    ind.push({
      id: 'ticket_promedio', grupo: 'Productividad', nombre: 'Ticket promedio',
      valor: ticket, formato: 'money', display: money(ticket),
      estado: NEUTRO,
      referencia: `${nOrdenes} orden(es) en el período`,
      formula: 'Ingresos ÷ Número de órdenes',
      significa: 'Cuánto vale en promedio cada venta. Subir el ticket suele ser más rentable que buscar más clientes: el costo de atender una orden de $50.000 y una de $150.000 es casi el mismo.'
    });
  }

  return {
    indicadores: ind,
    // Datos intermedios, útiles para el diagnóstico y para mostrar el detalle
    base: {
      ingresos, costoVentas, utilidadBruta: ub, utilidadOperativa: uo, utilidadNeta: un,
      gastosTotales, activoCorriente, pasivoCorriente, capitalTrabajo,
      margenContribucion, puntoEquilibrio, faltanteParaEquilibrio: faltante,
      diasCartera, diasInventario, diasProveedores, ciclo,
      costoLaboralPct, margenBruto, margenOperativo, margenNeto
    },
    // Lo que no se puede calcular todavía, dicho explícitamente
    pendientes: [
      {
        id: 'roe', nombre: 'ROE — Rentabilidad del patrimonio',
        motivo: 'Necesita el patrimonio: capital social, aportes de socios y utilidades de años anteriores.',
        comoHabilitarlo: 'Cargar los saldos iniciales del balance.'
      },
      {
        id: 'endeudamiento', nombre: 'Nivel de endeudamiento',
        motivo: 'Necesita las obligaciones financieras de largo plazo (créditos bancarios, leasing).',
        comoHabilitarlo: 'Cargar los saldos iniciales del balance.'
      }
    ]
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2 · MOTOR DE DIAGNÓSTICO
// ─────────────────────────────────────────────────────────────────────────────
// Reglas que leen los números y dicen qué revisar. Cada hallazgo tiene:
//   qué pasa · por qué importa · qué hacer
//
// El orden importa: primero lo que está sangrando plata hoy.
// ═════════════════════════════════════════════════════════════════════════════

const SEV = { critico: 0, alto: 1, medio: 2, info: 3 };

function diagnosticar(datos = {}, indicadores = {}) {
  const b = indicadores.base || {};
  const hallazgos = [];
  const ingresos = Number(datos.ingresos) || 0;

  // ─── D1 · Categorías o líneas con margen negativo ──────────────────────────
  // El caso DOMICILIO: un producto con costo mayor al precio genera pérdida
  // en cada venta. Es el hallazgo más accionable que existe.
  for (const cat of (datos.categorias || [])) {
    const ing = Number(cat.ingreso) || 0;
    const cos = Number(cat.costo) || 0;
    if (cos <= 0) continue;
    const margen = ing > 0 ? ((ing - cos) / ing) * 100 : -100;
    if (margen >= 0) continue;

    const perdida = cos - ing;
    hallazgos.push({
      id: `margen_negativo_${cat.nombre}`,
      severidad: 'critico',
      titulo: `"${cat.nombre}" te está generando pérdida`,
      que: `Ingresó ${money(ing)} y costó ${money(cos)}. Cada venta de esta categoría pierde plata: el margen es ${pct(margen)}.`,
      porque: `Son ${money(perdida)} de pérdida en el período` +
        (b.utilidadNeta < 0 && perdida > 0
          ? `, el ${Math.round(perdida / Math.abs(b.utilidadNeta) * 100)}% de la pérdida total del negocio.`
          : '.'),
      hacer: [
        'Revisá el costo parametrizado del producto en el maestro — un costo mal cargado genera pérdida en cada venta aunque el negocio esté bien.',
        'Si el costo es correcto, el precio de venta está por debajo del costo: hay que subirlo o dejar de venderlo.',
        'Si es un servicio que regalás para cerrar la venta (como el domicilio), decidí si lo cobrás aparte o lo incluís en el precio del producto.'
      ],
      valor: perdida,
      modulo: 'productos'
    });
  }

  // ─── D2 · Punto de equilibrio no alcanzado ─────────────────────────────────
  if (b.puntoEquilibrio && b.faltanteParaEquilibrio > 0) {
    const faltaPct = ingresos > 0 ? (b.faltanteParaEquilibrio / ingresos) * 100 : 0;
    hallazgos.push({
      id: 'bajo_equilibrio',
      severidad: 'critico',
      titulo: 'No alcanzaste el punto de equilibrio',
      que: `Vendiste ${money(ingresos)} y necesitabas ${money(b.puntoEquilibrio)} para no perder. Te faltaron ${money(b.faltanteParaEquilibrio)}.`,
      porque: `Con la estructura de costos actual, tenés que vender un ${pct(faltaPct)} más solo para quedar en cero.`,
      hacer: [
        `Subir ventas: necesitás ${money(b.faltanteParaEquilibrio)} adicionales al mes.`,
        `Bajar gastos: cada peso que recortés de gastos fijos baja el punto de equilibrio en ${b.margenContribucion > 0 ? (1 / b.margenContribucion).toFixed(1) : '—'} pesos de venta requerida.`,
        'Subir margen: si mejorás el margen bruto, el punto de equilibrio baja sin necesidad de vender más.'
      ],
      valor: b.faltanteParaEquilibrio,
      modulo: 'eri'
    });
  }

  // ─── D3 · Costo laboral alto ───────────────────────────────────────────────
  if (b.costoLaboralPct !== null && b.costoLaboralPct > REFERENCIA.costoLaboral.atencion) {
    const nEmp = Number(datos.empleados) || 0;
    hallazgos.push({
      id: 'costo_laboral_alto',
      severidad: b.costoLaboralPct > 50 ? 'critico' : 'alto',
      titulo: 'El costo del personal está consumiendo demasiado ingreso',
      que: `El equipo representa el ${pct(b.costoLaboralPct)} de tus ingresos${nEmp ? ` (${nEmp} personas)` : ''}. En servicios técnicos lo sano está entre ${REFERENCIA.costoLaboral.bien}% y ${REFERENCIA.costoLaboral.atencion}%.`,
      porque: 'Un costo laboral alto vuelve rígida la estructura: si un mes baja la venta, la nómina no baja con ella. Es lo que convierte un mes flojo en un mes de pérdida.',
      hacer: [
        'Medí productividad por persona: ¿cuántas órdenes atiende cada técnico al día? Si un técnico hace 3 y otro 7, el problema no es el número de personas sino la asignación de rutas.',
        'Revisá los cargos administrativos. En una pyme de servicios, cada persona que no factura tiene que estar claramente justificada por el volumen que soporta.',
        'Evaluá si hay cargos que se pueden combinar, o funciones que conviene tercerizar en temporada baja en vez de sostener con contrato fijo.',
        'Antes de recortar, mirá si el problema es de ingresos: con el mismo equipo, más ventas bajan este porcentaje sin tocar a nadie.'
      ],
      valor: Number(datos.gastosPersonal) || 0,
      modulo: 'empleados'
    });
  }

  // ─── D4 · Margen bruto insuficiente ────────────────────────────────────────
  if (b.margenBruto !== null && b.margenBruto < REFERENCIA.margenBruto.atencion) {
    hallazgos.push({
      id: 'margen_bruto_bajo',
      severidad: 'alto',
      titulo: 'El margen bruto no alcanza para sostener los gastos',
      que: `Tu margen bruto es ${pct(b.margenBruto)}. De cada $100 vendidos te quedan ${Math.round(b.margenBruto)} para cubrir TODOS los gastos del negocio.`,
      porque: 'Con un margen así, hay que vender un volumen enorme para que quede algo. Es el problema más difícil de compensar con esfuerzo comercial.',
      hacer: [
        'Revisá precios línea por línea: no todas las líneas tienen que tener el mismo margen, pero ninguna debería estar por debajo del costo.',
        'Negociá con proveedores por volumen o por pronto pago.',
        'Empujá comercialmente las líneas de mayor margen en vez de las de mayor volumen.'
      ],
      valor: null,
      modulo: 'eri'
    });
  }

  // ─── D5 · Cartera lenta ────────────────────────────────────────────────────
  if (b.diasCartera !== null && b.diasCartera > REFERENCIA.diasCartera.atencion) {
    hallazgos.push({
      id: 'cartera_lenta',
      severidad: 'alto',
      titulo: 'Estás tardando demasiado en cobrar',
      que: `Tus días de cartera son ${Math.round(b.diasCartera)}. Tenés ${money(datos.cxc)} facturados que todavía no entraron a caja.`,
      porque: 'Cada día de cartera es plata tuya financiando a tus clientes sin cobrar intereses. Es la causa más común de que una empresa rentable no tenga con qué pagar la nómina.',
      hacer: [
        'Revisá la cartera vencida y priorizá los saldos más viejos: mientras más tiempo pasa, menos probable es cobrarlos.',
        'Definí una política de crédito clara: a quién sí, a cuántos días y con qué tope.',
        'Considerá descuento por pronto pago — un 2% por pagar de contado suele ser más barato que financiar 60 días.'
      ],
      valor: Number(datos.cxc) || 0,
      modulo: 'cxc'
    });
  }

  // ─── D6 · Ciclo de efectivo largo ──────────────────────────────────────────
  if (b.ciclo !== null && b.ciclo > REFERENCIA.cicloEfectivo.atencion) {
    hallazgos.push({
      id: 'ciclo_largo',
      severidad: 'alto',
      titulo: 'Tu plata pasa demasiados días atrapada',
      que: `El ciclo de efectivo es de ${Math.round(b.ciclo)} días: ${Math.round(b.diasInventario || 0)} en inventario + ${Math.round(b.diasCartera || 0)} en cartera − ${Math.round(b.diasProveedores || 0)} que te financian los proveedores.`,
      porque: 'Significa que entre que comprás la mercancía y que cobrás la venta, tenés que financiar la operación con plata propia durante todo ese tiempo.',
      hacer: [
        'El camino más rápido suele ser la cartera: cobrar 15 días antes libera caja de inmediato.',
        'Negociar plazo con proveedores tiene el mismo efecto y no depende del cliente.',
        'Bajar inventario de los productos de rotación lenta libera plata dormida.'
      ],
      valor: null,
      modulo: 'eri'
    });
  }

  // ─── D7 · Inventario inmovilizado ──────────────────────────────────────────
  if (b.diasInventario !== null && b.diasInventario > REFERENCIA.diasInventario.atencion) {
    const inv = Number(datos.inventarioAlCosto) || 0;
    hallazgos.push({
      id: 'inventario_lento',
      severidad: 'medio',
      titulo: 'Tenés mucha plata dormida en inventario',
      que: `Con la rotación actual, tu inventario de ${money(inv)} tardaría ${Math.round(b.diasInventario)} días en venderse.`,
      porque: 'Ese dinero está inmovilizado: no genera rentabilidad, ocupa bodega, y algunos productos pierden valor o se vencen.',
      hacer: [
        'Identificá los productos sin movimiento en los últimos 6 meses y liquidalos aunque sea con descuento — recuperar el 70% hoy vale más que el 100% nunca.',
        'Revisá los mínimos de reposición: puede que estés comprando de más por costumbre.',
        'Concentrá la compra en las referencias que sí rotan.'
      ],
      valor: inv,
      modulo: 'productos'
    });
  }

  // ─── D8 · Liquidez comprometida ────────────────────────────────────────────
  if (b.capitalTrabajo !== undefined && b.capitalTrabajo < 0) {
    hallazgos.push({
      id: 'capital_trabajo_negativo',
      severidad: 'critico',
      titulo: 'El capital de trabajo está en negativo',
      que: `Lo que debés en el corto plazo (${money(b.pasivoCorriente)}) supera lo que tenés disponible (${money(b.activoCorriente)}).`,
      porque: 'Es una señal de alerta de liquidez: podés tener que atrasarte en pagos aunque el negocio sea rentable.',
      hacer: [
        'Acelerá la cobranza de la cartera más antigua.',
        'Renegociá plazos con los proveedores más grandes antes de que venzan.',
        'Revisá si hay inventario convertible en efectivo rápidamente.'
      ],
      valor: b.capitalTrabajo,
      modulo: 'cxc'
    });
  }

  // ─── D9 · Concentración de clientes ────────────────────────────────────────
  const topCliente = (datos.clientes || []).sort((a, b2) => (b2.total || 0) - (a.total || 0))[0];
  if (topCliente && ingresos > 0) {
    const conc = (topCliente.total / ingresos) * 100;
    if (conc > REFERENCIA.concentracionCliente.atencion) {
      hallazgos.push({
        id: 'concentracion_cliente',
        severidad: 'medio',
        titulo: 'Dependés demasiado de un solo cliente',
        que: `"${topCliente.nombre}" representa el ${pct(conc)} de tus ventas del período (${money(topCliente.total)}).`,
        porque: 'Si ese cliente se va, se atrasa o renegocia precios, el impacto en tu caja es inmediato y difícil de reemplazar.',
        hacer: [
          'No es para dejar de atenderlo — es para no depender de él. Poné meta de que ningún cliente supere el 25% de las ventas.',
          'Trabajá la base de clientes medianos: son menos rentables por unidad pero dan estabilidad.',
          'Si es un cliente grande, asegurá la relación con contrato y no solo con órdenes sueltas.'
        ],
        valor: topCliente.total,
        modulo: 'clientes'
      });
    }
  }

  // ─── D10 · Deterioro contra el período anterior ────────────────────────────
  const ant = datos.periodoAnterior;
  if (ant && ant.ingresos > 0 && ingresos > 0) {
    const varIngresos = ((ingresos - ant.ingresos) / ant.ingresos) * 100;
    const margenAnt = ant.utilidadBruta ? (ant.utilidadBruta / ant.ingresos) * 100 : null;

    if (varIngresos < -15) {
      hallazgos.push({
        id: 'caida_ventas',
        severidad: 'alto',
        titulo: 'Las ventas cayeron frente al período anterior',
        que: `Vendiste ${pct(Math.abs(varIngresos))} menos: pasaste de ${money(ant.ingresos)} a ${money(ingresos)}.`,
        porque: 'Los gastos fijos no bajan solos. Una caída sostenida de ventas con la misma estructura lleva a pérdida en pocos meses.',
        hacer: [
          '¿Es estacional o es tendencia? Comparalo contra el mismo mes del año pasado, no solo contra el mes anterior.',
          'Revisá si perdiste clientes específicos o si bajó el ticket promedio de todos — la acción es distinta en cada caso.',
          'Mirá los vencimientos próximos: reactivar un cliente existente cuesta mucho menos que conseguir uno nuevo.'
        ],
        valor: ant.ingresos - ingresos,
        modulo: 'comercial'
      });
    }

    if (margenAnt !== null && b.margenBruto !== null && (b.margenBruto - margenAnt) < -5) {
      hallazgos.push({
        id: 'deterioro_margen',
        severidad: 'alto',
        titulo: 'El margen bruto se deterioró',
        que: `Pasó de ${pct(margenAnt)} a ${pct(b.margenBruto)}, una caída de ${(margenAnt - b.margenBruto).toFixed(1)} puntos.`,
        porque: 'Vender lo mismo con menos margen es vender más barato sin darse cuenta. Suele venir de aumentos de costo que no se trasladaron al precio.',
        hacer: [
          'Revisá si subieron los costos de compra y no se actualizaron los precios de venta.',
          'Mirá si cambió la mezcla: vender más de las líneas de bajo margen baja el promedio aunque cada línea esté bien.',
          'Revisá los descuentos otorgados en el período.'
        ],
        valor: null,
        modulo: 'productos'
      });
    }
  }

  // ─── D11 · Todo bien ───────────────────────────────────────────────────────
  if (hallazgos.length === 0) {
    hallazgos.push({
      id: 'sin_hallazgos',
      severidad: 'info',
      titulo: 'No se detectaron problemas en los indicadores del período',
      que: 'Los márgenes, la rotación y la liquidez están dentro de rangos razonables.',
      porque: 'Es un buen momento para mirar hacia adelante en vez de corregir.',
      hacer: [
        'Compará contra el mismo mes del año pasado para ver la tendencia real.',
        'Revisá qué línea de negocio tiene mejor margen y evaluá si se puede empujar más.',
      ],
      valor: null, modulo: null
    });
  }

  hallazgos.sort((a, b2) => (SEV[a.severidad] ?? 9) - (SEV[b2.severidad] ?? 9));

  return {
    total: hallazgos.length,
    criticos: hallazgos.filter(h => h.severidad === 'critico').length,
    altos: hallazgos.filter(h => h.severidad === 'alto').length,
    hallazgos
  };
}

module.exports = {
  calcularIndicadores,
  diagnosticar,
  REFERENCIA,
  BIEN, ATENCION, CRITICO, NEUTRO,
  money, pct
};
