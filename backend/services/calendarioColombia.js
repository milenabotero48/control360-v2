// ═══════════════════════════════════════════════════════════════════════════════
// calendarioColombia.js — Calendario laboral y tributario colombiano
// ─────────────────────────────────────────────────────────────────────────────
// NOVEDADES-001
//
// POR QUÉ EXISTE
// --------------
// Un software de gestión que solo guarda datos es una herramienta. Uno que
// además avisa "el 14 de febrero vence el pago de cesantías" es un asesor.
//
// Para el mercado de Control360 —pymes que muchas veces no tienen contador de
// planta— esa diferencia vale más que cualquier funcionalidad nueva: es lo que
// evita una sanción de la UGPP o un interés de mora que nadie vio venir.
//
// CÓMO FUNCIONA
// -------------
// Cada evento tiene una fecha límite y una antelación de aviso. El cron diario
// revisa qué eventos entran en ventana y genera la novedad correspondiente
// para todos los suscriptores. Nunca se repite el mismo evento el mismo año.
//
// ⚠️ Las fechas de vencimiento tributario (renta, IVA, ICA) dependen del último
//    dígito del NIT y del calendario que la DIAN publica cada año en un decreto.
//    Por eso acá SOLO están los eventos de fecha fija y alcance general. Los
//    vencimientos por NIT quedan fuera a propósito: dar una fecha equivocada es
//    peor que no dar ninguna.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Tipos de aviso ──────────────────────────────────────────────────────────
const OBLIGACION = 'obligacion';   // hay una fecha límite legal
const RECORDATORIO = 'recordatorio'; // conviene revisar algo
const PARAMETRO = 'parametro';     // cambió un valor que el sistema usa

// ═════════════════════════════════════════════════════════════════════════════
// EVENTOS DEL CALENDARIO
// ─────────────────────────────────────────────────────────────────────────────
//   id            · identificador estable (evita duplicar el aviso)
//   mes / dia     · fecha límite
//   avisarDias    · con cuántos días de antelación se avisa
//   critico       · true → además del campanazo, muestra banner
//   requiere      · 'empleados' → solo se manda si el suscriptor tiene nómina
// ═════════════════════════════════════════════════════════════════════════════
const EVENTOS = [

  // ─── INTERESES A LAS CESANTÍAS ─────────────────────────────────────────────
  {
    id: 'intereses_cesantias',
    tipo: OBLIGACION,
    mes: 1, dia: 31,
    avisarDias: 15,
    critico: true,
    requiere: 'empleados',
    titulo: 'Vence el pago de intereses a las cesantías',
    cuerpo:
      'Antes del **31 de enero** debés pagarle directamente a cada empleado los intereses sobre ' +
      'las cesantías del año anterior: el **12% anual** sobre el saldo acumulado, proporcional al ' +
      'tiempo trabajado.\n\n' +
      'No van al fondo — se le entregan al trabajador.\n\n' +
      'Podés consultar el valor acumulado en **Empleados → Provisiones**, en el bloque de pasivo.',
    accion: { texto: 'Ver mis provisiones', modulo: 'empleados' }
  },

  // ─── CESANTÍAS AL FONDO ────────────────────────────────────────────────────
  {
    id: 'cesantias_fondo',
    tipo: OBLIGACION,
    mes: 2, dia: 14,
    avisarDias: 15,
    critico: true,
    requiere: 'empleados',
    titulo: 'Vence la consignación de cesantías al fondo',
    cuerpo:
      'Antes del **14 de febrero** hay que consignar en el fondo de cesantías el valor acumulado ' +
      'de cada empleado al 31 de diciembre.\n\n' +
      'Consignar tarde genera una sanción de **un día de salario por cada día de retraso**, por ' +
      'trabajador. Es de las multas más caras y más fáciles de evitar.\n\n' +
      'El valor lo tenés en **Empleados → Provisiones**.',
    accion: { texto: 'Ver mis provisiones', modulo: 'empleados' }
  },

  // ─── PRIMA DE SERVICIOS · PRIMER SEMESTRE ──────────────────────────────────
  {
    id: 'prima_junio',
    tipo: OBLIGACION,
    mes: 6, dia: 30,
    avisarDias: 20,
    critico: true,
    requiere: 'empleados',
    titulo: 'Vence la prima de servicios del primer semestre',
    cuerpo:
      'A más tardar el **30 de junio** se paga la primera prima: **15 días de salario** por el ' +
      'semestre trabajado, calculados sobre el salario más el auxilio de transporte.\n\n' +
      'Si venís causando la provisión mes a mes, el dinero ya debería estar previsto. ' +
      'Revisá el acumulado en **Empleados → Provisiones** antes de pagar.',
    accion: { texto: 'Ver mis provisiones', modulo: 'empleados' }
  },

  // ─── PRIMA DE SERVICIOS · SEGUNDO SEMESTRE ─────────────────────────────────
  {
    id: 'prima_diciembre',
    tipo: OBLIGACION,
    mes: 12, dia: 20,
    avisarDias: 20,
    critico: true,
    requiere: 'empleados',
    titulo: 'Vence la prima de servicios de fin de año',
    cuerpo:
      'A más tardar el **20 de diciembre** se paga la segunda prima del año.\n\n' +
      'Diciembre concentra prima, aguinaldos y menos cobranza. Si no tenés la provisión ' +
      'separada, revisá tu flujo con tiempo — es el mes donde más pymes se quedan cortas de caja.',
    accion: { texto: 'Ver mis provisiones', modulo: 'empleados' }
  },

  // ─── VACACIONES ────────────────────────────────────────────────────────────
  {
    id: 'vacaciones_pendientes',
    tipo: RECORDATORIO,
    mes: 11, dia: 15,
    avisarDias: 10,
    critico: false,
    requiere: 'empleados',
    titulo: 'Revisá las vacaciones pendientes antes de cerrar el año',
    cuerpo:
      'Las vacaciones no disfrutadas se acumulan y se vuelven un pasivo cada vez más grande. ' +
      'Además, la ley limita cuántos períodos se pueden acumular.\n\n' +
      'Es buen momento para revisar quién tiene vacaciones pendientes y programarlas.',
    accion: { texto: 'Ver empleados', modulo: 'empleados' }
  },

  // ─── SALARIO MÍNIMO DEL AÑO SIGUIENTE ──────────────────────────────────────
  {
    id: 'salario_minimo',
    tipo: PARAMETRO,
    mes: 1, dia: 5,
    avisarDias: 5,
    critico: false,
    requiere: 'empleados',
    titulo: 'Nuevo salario mínimo y auxilio de transporte',
    cuerpo:
      'Ya está cargado en el sistema el salario mínimo y el auxilio de transporte del año.\n\n' +
      'Si tenés empleados que ganaban el mínimo, **actualizá su salario en el maestro de ' +
      'empleados** para que las provisiones y la nómina salgan bien desde enero.\n\n' +
      'Revisá también los contratos que se ajustan por IPC o por incremento del mínimo.',
    accion: { texto: 'Actualizar salarios', modulo: 'empleados' }
  },

  // ─── CIERRE CONTABLE ───────────────────────────────────────────────────────
  {
    id: 'cierre_anual',
    tipo: RECORDATORIO,
    mes: 12, dia: 31,
    avisarDias: 15,
    critico: false,
    titulo: 'Preparate para el cierre contable del año',
    cuerpo:
      'Antes de cerrar el año conviene revisar:\n\n' +
      '· **Egresos → Revisión** — que no queden movimientos con observaciones sin resolver\n' +
      '· **Empleados → Provisiones** — que todos los meses estén causados\n' +
      '· **Inventario** — hacer el conteo físico y ajustar diferencias\n' +
      '· **CxC y CxP** — depurar saldos viejos que ya no se van a cobrar o pagar\n\n' +
      'Un cierre limpio en diciembre te ahorra semanas de trabajo en marzo.',
    accion: { texto: 'Ir a Revisión', modulo: 'egresos' }
  },

  // ─── AUTORRETENCIÓN Y SEGURIDAD SOCIAL MENSUAL ─────────────────────────────
  {
    id: 'pila_mensual',
    tipo: RECORDATORIO,
    mes: null, dia: 8,      // mes: null → todos los meses
    avisarDias: 3,
    critico: false,
    requiere: 'empleados',
    titulo: 'Se acerca el vencimiento de la planilla PILA',
    cuerpo:
      'El pago de seguridad social y parafiscales vence en los primeros días hábiles del mes, ' +
      'según el último dígito de tu NIT.\n\n' +
      'Recordá que el pago de la PILA se registra en **Egresos**, no en el módulo de nómina: ' +
      'la nómina es lo que se le paga al empleado, la PILA es lo que se le paga al Estado.',
    accion: { texto: 'Ir a Egresos', modulo: 'egresos' }
  },

];

// ═════════════════════════════════════════════════════════════════════════════
// LÓGICA DE VENTANA
// ═════════════════════════════════════════════════════════════════════════════

const hoyCO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

const diasEntre = (desdeISO, hastaISO) => {
  const a = new Date(desdeISO + 'T00:00:00');
  const b = new Date(hastaISO + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
};

/**
 * Devuelve los eventos que hoy caen dentro de su ventana de aviso.
 *
 * Un evento entra en ventana cuando faltan `avisarDias` o menos para su fecha
 * límite, y todavía no llegó la fecha. El día exacto también cuenta.
 *
 * @param {string} fechaRef  'YYYY-MM-DD' — por defecto hoy en Colombia
 * @returns {Array} eventos con { ...evento, fechaLimite, diasRestantes, clave }
 */
function eventosDelDia(fechaRef) {
  const hoy = fechaRef || hoyCO();
  const [anioStr, mesStr] = hoy.split('-');
  const anio = Number(anioStr);
  const mesActual = Number(mesStr);
  const activos = [];

  for (const ev of EVENTOS) {
    // Eventos mensuales (mes: null) → se evalúan contra el mes en curso
    const meses = ev.mes === null ? [mesActual] : [ev.mes];

    for (const m of meses) {
      const fechaLimite = `${anio}-${String(m).padStart(2, '0')}-${String(ev.dia).padStart(2, '0')}`;
      const faltan = diasEntre(hoy, fechaLimite);
      if (faltan === null) continue;
      if (faltan < 0 || faltan > ev.avisarDias) continue;

      activos.push({
        ...ev,
        fechaLimite,
        diasRestantes: faltan,
        // Clave única por año (y por mes en los mensuales) — evita repetir
        clave: ev.mes === null
          ? `${ev.id}_${anio}_${String(m).padStart(2, '0')}`
          : `${ev.id}_${anio}`
      });
      break;
    }
  }

  // Los más urgentes primero
  return activos.sort((a, b) => a.diasRestantes - b.diasRestantes);
}

/** Texto de urgencia para el título de la novedad. */
const etiquetaUrgencia = (dias) => {
  if (dias === 0) return 'Vence HOY';
  if (dias === 1) return 'Vence mañana';
  return `Faltan ${dias} días`;
};

/** Todos los eventos del año, para mostrar el calendario completo en la UI. */
function calendarioAnual(anio) {
  const a = anio || new Date().getFullYear();
  return EVENTOS
    .filter(ev => ev.mes !== null)
    .map(ev => ({
      id: ev.id,
      tipo: ev.tipo,
      titulo: ev.titulo,
      fechaLimite: `${a}-${String(ev.mes).padStart(2, '0')}-${String(ev.dia).padStart(2, '0')}`,
      critico: ev.critico === true,
      requiere: ev.requiere || null
    }))
    .sort((x, y) => x.fechaLimite.localeCompare(y.fechaLimite));
}

module.exports = {
  EVENTOS,
  OBLIGACION, RECORDATORIO, PARAMETRO,
  eventosDelDia,
  etiquetaUrgencia,
  calendarioAnual,
  hoyCO
};
