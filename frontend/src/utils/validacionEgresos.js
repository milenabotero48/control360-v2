// ═══════════════════════════════════════════════════════════════════════════════
// validacionEgresos.js (FRONTEND) — ⚠️ ARCHIVO ESPEJO · NO EDITAR A MANO
// ─────────────────────────────────────────────────────────────────────────────
// Copia exacta de backend/services/validacionEgresos.js, con la única
// diferencia del sistema de módulos (ESM en vez de CommonJS).
//
// POR QUÉ ESTÁ DUPLICADO
// El frontend valida MIENTRAS se digita (feedback inmediato, sin ida y vuelta
// al servidor). El backend valida AL GUARDAR (nadie puede saltarse la regla
// llamando la API directo). Las dos capas deben aplicar EXACTAMENTE las mismas
// reglas, si no el usuario ve una cosa y el sistema guarda otra.
//
// CÓMO ACTUALIZARLO
// Editá SIEMPRE backend/services/validacionEgresos.js y volvé a generar este:
//     node backend/scripts/sync-validaciones.js
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Severidades ─────────────────────────────────────────────────────────────
const GRAVE = 'grave';   // error contable casi seguro — se muestra en rojo
const MEDIA = 'media';   // muy probablemente un error — naranja
const LEVE  = 'leve';    // higiene de datos — azul

// ─── Normalizador de texto ───────────────────────────────────────────────────
// Quita tildes y baja a minúscula. Es el mismo criterio que evita que
// "SEÑALIZACIÓN GENERICA" y "SEÑALIZACION GENERICA" cuenten como dos cosas.
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim();

// ─── Detectores de familia de categoría ──────────────────────────────────────
// Se apoyan primero en `tipoERI` (el dato bueno, definido en configuracion.js)
// y caen a heurística de nombre solo si la categoría no tiene tipoERI —
// que es el caso de las categorías que los usuarios crearon a mano
// ("gastos de oficina", "fletes", "anticipos de nomina", "servicio telefonico").
const esPersonal = (cat, meta) => {
  if (meta?.tipoERI === 'gasto_personal') return true;
  const n = norm(cat);
  return /nomina|salario|sueldo|prestacion|anticipo de nomina|anticipos de nomina|seguridad social|parafiscal|liquidacion|cesantia|prima/.test(n);
};

const esCombustible = (cat, meta) => {
  const n = norm(cat);
  return /combustible|gasolina|acpm|diesel|transporte|vehiculo|peaje|parqueadero/.test(n);
};

const esInventario = (cat, meta) => {
  if (meta?.tipoERI === 'compra_inventario') return true;
  return /compra de mercancia|compra mercancia/.test(norm(cat));
};

const esFiscal = (cat, meta) => {
  if (meta?.tipoERI === 'gasto_fiscal') return true;
  return /impuesto|retencion|dian|ica|renta/.test(norm(cat));
};

// ─── Fecha de hoy en Colombia (YYYY-MM-DD) ───────────────────────────────────
const hoyCO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

const diasEntre = (a, b) => {
  const d1 = new Date(a + 'T00:00:00');
  const d2 = new Date(b + 'T00:00:00');
  if (isNaN(d1) || isNaN(d2)) return 0;
  return Math.round((d2 - d1) / 86400000);
};

// ═════════════════════════════════════════════════════════════════════════════
// REGLAS
// ─────────────────────────────────────────────────────────────────────────────
// Cada regla recibe (e, ctx) y devuelve null o un objeto de alerta.
//   e   = egreso normalizado
//   ctx = { categoriaMeta, egresosRecientes, vehiculos, periodoCerradoHasta }
// ═════════════════════════════════════════════════════════════════════════════

const REGLAS = [

  // ───────────────────────────────────────────────────────────────────────────
  // R1 · IVA en categoría de personal
  // El hallazgo literal de julio: $18.316 de IVA descontable dentro de Nómina.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'IVA_EN_NOMINA',
    severidad: GRAVE,
    test: (e, ctx) => esPersonal(e.categoria, ctx.categoriaMeta) && Number(e.ivaVal) > 0,
    mensaje: (e) => ({
      titulo: 'La nómina no genera IVA descontable',
      detalle: `Este egreso está en una categoría de personal pero trae ${money(e.ivaVal)} de IVA. ` +
               `Los pagos laborales no son una compra gravada: no hay factura con IVA que descontar. ` +
               `Lo más probable es que sea la factura de un tercero (un contratista, un servicio) mal categorizada.`,
      sugerencia: 'Revisá si la categoría correcta es otra, o si el IVA se digitó por error.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R2 · Retención practicada en categoría de personal
  // A un empleado no se le practica retención en la fuente por compras: se le
  // aplica retención por salarios, que es otro cálculo y otro formulario.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'RETENCION_EN_NOMINA',
    severidad: MEDIA,
    test: (e, ctx) => esPersonal(e.categoria, ctx.categoriaMeta) && Number(e.retenVal) > 0,
    mensaje: (e) => ({
      titulo: 'Retención de compras sobre un pago de nómina',
      detalle: `Se registró ${money(e.retenVal)} de retención en la fuente sobre un egreso de personal. ` +
               `La retención por salarios se calcula con procedimiento propio (art. 383 E.T.), no con los ` +
               `porcentajes de compras o servicios.`,
      sugerencia: 'Verificá si el egreso es realmente de nómina o si es un contratista por prestación de servicios.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R3 · IVA que no cuadra con el porcentaje declarado
  // Detecta el error de tipeo clásico: base 100.000, IVA 19% pero digitaron
  // 1.900 o 190.000 en el valor.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'IVA_DESCUADRADO',
    severidad: MEDIA,
    test: (e) => {
      const base = Number(e.monto) || 0;
      const pct  = Number(e.ivaPct) || 0;
      const val  = Number(e.ivaVal) || 0;
      if (base <= 0 || pct <= 0) return false;
      const esperado = Math.round(base * pct / 100);
      // tolerancia de $2 por redondeos
      return Math.abs(esperado - val) > 2;
    },
    mensaje: (e) => {
      const esperado = Math.round((Number(e.monto) || 0) * (Number(e.ivaPct) || 0) / 100);
      return {
        titulo: 'El IVA no corresponde al porcentaje',
        detalle: `Con base ${money(e.monto)} al ${e.ivaPct}%, el IVA debería ser ${money(esperado)}, ` +
                 `pero está registrado ${money(e.ivaVal)}.`,
        sugerencia: 'Revisá el valor o el porcentaje contra la factura física.'
      };
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R4 · Fecha en período ya cerrado
  // El caso del nitrógeno con fecha 2026-08-02 dentro del informe de julio.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'PERIODO_CERRADO',
    severidad: GRAVE,
    test: (e, ctx) => !!(ctx.periodoCerradoHasta && e.fecha && e.fecha <= ctx.periodoCerradoHasta),
    mensaje: (e, ctx) => ({
      titulo: 'La fecha cae en un período ya cerrado',
      detalle: `El período está cerrado hasta ${ctx.periodoCerradoHasta}. Registrar un egreso con fecha ` +
               `${e.fecha} cambiaría un estado de resultados que ya fue emitido.`,
      sugerencia: 'Registralo con fecha del período abierto, o pedí la reapertura del período.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R5 · Fecha futura
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'FECHA_FUTURA',
    severidad: MEDIA,
    test: (e) => !!(e.fecha && e.fecha > hoyCO()),
    mensaje: (e) => ({
      titulo: 'Fecha en el futuro',
      detalle: `El egreso tiene fecha ${e.fecha}, posterior a hoy (${hoyCO()}). Un gasto se causa cuando ocurre el ` +
               `hecho económico, no antes.`,
      sugerencia: 'Si es un pago programado, registralo como pendiente con la fecha real de la factura.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R6 · Fecha muy vieja
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'FECHA_ANTIGUA',
    severidad: LEVE,
    test: (e) => !!(e.fecha && diasEntre(e.fecha, hoyCO()) > 90),
    mensaje: (e) => ({
      titulo: 'Egreso con más de 90 días de antigüedad',
      detalle: `La fecha ${e.fecha} tiene ${diasEntre(e.fecha, hoyCO())} días. Afectará un mes cuyo informe ` +
               `probablemente ya se revisó.`,
      sugerencia: 'Confirmá que la fecha sea correcta antes de guardar.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R7 · Combustible sin vehículo asignado
  // Sin esto no se puede saber cuánto consume cada vehículo. En julio hubo
  // $1.206.682 de Transporte/Combustible sin forma de atribuirlos.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'COMBUSTIBLE_SIN_VEHICULO',
    severidad: MEDIA,
    test: (e, ctx) => esCombustible(e.categoria, ctx.categoriaMeta) && !e.vehiculoId,
    mensaje: () => ({
      titulo: 'Gasto de vehículo sin placa asignada',
      detalle: 'Sin la placa no se puede saber cuánto consume cada vehículo ni detectar un consumo anormal. ' +
               'Es la diferencia entre "gastamos 1,2 millones en combustible" y "la WGY123 se está comiendo el 60%".',
      sugerencia: 'Seleccioná el vehículo en el campo correspondiente.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R8 · Sin proveedor / tercero
  // Los CxP de julio con proveedor "Sin proveedor" venían de aquí.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'SIN_TERCERO',
    severidad: LEVE,
    test: (e) => !String(e.proveedor || '').trim(),
    mensaje: () => ({
      titulo: 'Egreso sin tercero identificado',
      detalle: 'Sin proveedor no se puede construir el reporte de "a quién le compramos más", ni soportar ' +
               'el gasto ante una revisión de la DIAN.',
      sugerencia: 'Indicá a quién se le pagó.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R9 · Concepto vago
  // "PAGO", "VARIOS", "GASTO" no dicen nada dentro de 800 registros.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'CONCEPTO_VAGO',
    severidad: LEVE,
    test: (e) => {
      const c = norm(e.concepto);
      if (!c) return true;
      if (c.length < 4) return true;
      return /^(pago|varios|otro|otros|gasto|gastos|compra|abono|sn|n\/a|na|x)$/.test(c);
    },
    mensaje: () => ({
      titulo: 'El concepto no describe el gasto',
      detalle: 'Dentro de cientos de egresos, un concepto como "pago" o "varios" hace imposible encontrar ' +
               'el registro después. En julio solo 7 de 27 anticipos tenían la palabra "anticipo" en el concepto.',
      sugerencia: 'Escribí qué se pagó y a qué corresponde.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R10 · Posible duplicado
  // Mismo tercero + mismo valor + fecha cercana. Es el error más caro y el
  // más difícil de ver a ojo.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'POSIBLE_DUPLICADO',
    severidad: MEDIA,
    test: (e, ctx) => {
      if (!Array.isArray(ctx.egresosRecientes) || !e.proveedor) return false;
      const total = Number(e.totalPagar || e.monto) || 0;
      if (total <= 0) return false;
      return ctx.egresosRecientes.some(x =>
        x.id !== e.id &&
        x.anulado !== true &&
        norm(x.proveedor) === norm(e.proveedor) &&
        Math.abs((Number(x.totalPagar || x.monto) || 0) - total) < 1 &&
        x.fecha && e.fecha && Math.abs(diasEntre(x.fecha, e.fecha)) <= 3
      );
    },
    mensaje: (e, ctx) => {
      const total = Number(e.totalPagar || e.monto) || 0;
      const gemelo = ctx.egresosRecientes.find(x =>
        x.id !== e.id && norm(x.proveedor) === norm(e.proveedor) &&
        Math.abs((Number(x.totalPagar || x.monto) || 0) - total) < 1
      );
      return {
        titulo: 'Posible pago duplicado',
        detalle: `Ya existe ${gemelo?.numero || 'otro egreso'} a ${e.proveedor} por ${money(total)} ` +
                 `con fecha cercana (${gemelo?.fecha || '—'}).`,
        sugerencia: 'Verificá que no sea el mismo pago registrado dos veces.'
      };
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R11 · Compra de mercancía sin productos
  // Si no se detallan los productos, el inventario no se mueve y el costo de
  // ventas queda mal para siempre.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'INVENTARIO_SIN_DETALLE',
    severidad: MEDIA,
    test: (e, ctx) => esInventario(e.categoria, ctx.categoriaMeta) &&
                      (!Array.isArray(e.productosCompra) || e.productosCompra.length === 0),
    mensaje: () => ({
      titulo: 'Compra de mercancía sin detalle de productos',
      detalle: 'Sin el detalle, el stock no se actualiza y el costo de venta de esos productos queda mal ' +
               'calculado cuando se vendan.',
      sugerencia: 'Agregá los productos comprados con cantidad y costo unitario.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R12 · Monto en cero
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'MONTO_CERO',
    severidad: MEDIA,
    test: (e) => (Number(e.monto) || 0) <= 0,
    mensaje: () => ({
      titulo: 'Egreso sin valor',
      detalle: 'Un egreso en cero no representa ningún movimiento de dinero.',
      sugerencia: 'Digitá el valor real o eliminá el registro.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R13 · Categoría sin clasificación contable
  // Las categorías creadas a mano por los usuarios ("gastos de oficina",
  // "fletes", "servicio telefonico") no tienen tipoERI, entonces el ERI las
  // agrupa por defecto y la lectura queda distorsionada.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'CATEGORIA_SIN_TIPO_ERI',
    severidad: MEDIA,
    test: (e, ctx) => !!e.categoria && !!ctx.categoriaMeta && !ctx.categoriaMeta.tipoERI,
    mensaje: (e) => ({
      titulo: 'La categoría no tiene clasificación contable',
      detalle: `"${e.categoria}" no está marcada como costo, gasto operativo, fijo, administrativo, ` +
               `financiero o fiscal. El ERI no sabe dónde ubicarla y la manda al grupo por defecto.`,
      sugerencia: 'Configurá el tipo de la categoría en Configuración → Categorías de egreso.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R14 · Categoría inexistente en el catálogo
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'CATEGORIA_LIBRE',
    severidad: MEDIA,
    test: (e, ctx) => !!e.categoria && Array.isArray(ctx.categoriasValidas) &&
                      ctx.categoriasValidas.length > 0 &&
                      !ctx.categoriasValidas.some(c => norm(c) === norm(e.categoria)),
    mensaje: (e) => ({
      titulo: 'Categoría fuera del catálogo',
      detalle: `"${e.categoria}" no existe en el catálogo de categorías activas. Así fue como aparecieron ` +
               `cuatro variantes de "Señalización" en el informe.`,
      sugerencia: 'Elegí una categoría del catálogo o creála formalmente en Configuración.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R15 · IVA descontable sobre categoría fiscal
  // Un impuesto no genera IVA descontable.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'IVA_EN_IMPUESTOS',
    severidad: MEDIA,
    test: (e, ctx) => esFiscal(e.categoria, ctx.categoriaMeta) && Number(e.ivaVal) > 0,
    mensaje: (e) => ({
      titulo: 'IVA descontable sobre un impuesto',
      detalle: `El pago de un impuesto no es una compra gravada. No hay ${money(e.ivaVal)} de IVA que descontar.`,
      sugerencia: 'Quitá el IVA o revisá la categoría.'
    })
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R16 · El tercero es un EMPLEADO y el egreso no está marcado como anticipo
  // ───────────────────────────────────────────────────────────────────────────
  // NOMINA-PROVISIONES-001
  //
  // Este es el caso exacto de julio 2026: pagos a LUZ MARINA BOTERO M
  // registrados unos como "Nómina" y otros como "anticipos de nomina", con el
  // concepto cruzado en los dos sentidos. Ninguno de los dos totales servía.
  //
  // Cuando el proveedor coincide con un empleado registrado, el sistema
  // pregunta explícitamente: ¿esto es un anticipo de nómina? Si lo es, se
  // enlaza al empleado y se descuenta en la liquidación del período — en vez
  // de quedar como un gasto suelto que después duplica la nómina.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'TERCERO_ES_EMPLEADO',
    severidad: MEDIA,
    test: (e, ctx) => {
      if (e.esComprobanteNomina === true) return false;   // el comprobante formal está bien
      if (e.esAnticipoNomina === true && e.empleadoId) return false; // ya está resuelto
      const empleados = ctx.empleados || [];
      if (!empleados.length) return false;
      const texto = `${norm(e.proveedor)} ${norm(e.concepto)}`;
      return empleados.some(emp => {
        const n = norm(emp.nombre);
        return n.length >= 5 && texto.includes(n);
      });
    },
    mensaje: (e, ctx) => {
      const emp = (ctx.empleados || []).find(x => {
        const n = norm(x.nombre);
        return n.length >= 5 && `${norm(e.proveedor)} ${norm(e.concepto)}`.includes(n);
      });
      return {
        titulo: `"${emp?.nombre || 'Este tercero'}" es un empleado registrado`,
        detalle: e.esAnticipoNomina === true
          ? `Está marcado como anticipo pero no tiene el empleado enlazado, así que no se podrá cruzar contra la nómina.`
          : `Los pagos a empleados fuera del comprobante de nómina casi siempre son ANTICIPOS. ` +
            `Un anticipo no es gasto: es una cuenta por cobrar que se descuenta de la quincena. ` +
            `Si lo registrás como gasto y después pagás el salario completo, el gasto queda duplicado.`,
        sugerencia: 'Marcá el egreso como anticipo de nómina y enlazalo al empleado, o generá el comprobante desde Empleados → Nómina.'
      };
    }
  },

  // ───────────────────────────────────────────────────────────────────────────
  // R17 · Anticipo de nómina sin empleado asignado
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'ANTICIPO_SIN_EMPLEADO',
    severidad: GRAVE,
    test: (e) => e.esAnticipoNomina === true && !e.empleadoId,
    mensaje: () => ({
      titulo: 'Anticipo de nómina sin empleado enlazado',
      detalle: 'Sin el empleado, este anticipo no se puede cruzar contra la liquidación de la quincena. ' +
               'Va a quedar contado como gasto Y el salario completo también: el gasto se duplica.',
      sugerencia: 'Seleccioná a qué empleado corresponde el anticipo.'
    })
  },

];

// ─── Formateador de moneda ───────────────────────────────────────────────────
function money(n) {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency', currency: 'COP', maximumFractionDigits: 0
    }).format(Number(n) || 0);
  } catch { return '$' + (Number(n) || 0); }
}

// ═════════════════════════════════════════════════════════════════════════════
// API PÚBLICA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Evalúa un egreso contra todas las reglas.
 *
 * @param {object} egreso   Documento de egreso (nuevo o existente)
 * @param {object} contexto {
 *   categoriaMeta        : objeto de la categoría desde configuracion (con tipoERI)
 *   categoriasValidas    : array de nombres de categorías activas
 *   egresosRecientes     : array de egresos del período (para detectar duplicados)
 *   periodoCerradoHasta  : 'YYYY-MM-DD' o null
 *   empleados            : array de empleados activos [{ id, nombre, documento }]
 * }
 * @returns {{ alertas: Array, hayGraves: boolean, resumen: string }}
 */
function validarEgreso(egreso, contexto = {}) {
  const e = egreso || {};
  const ctx = {
    categoriaMeta: contexto.categoriaMeta || null,
    categoriasValidas: contexto.categoriasValidas || [],
    egresosRecientes: contexto.egresosRecientes || [],
    periodoCerradoHasta: contexto.periodoCerradoHasta || null,
    // ✅ NOMINA-PROVISIONES-001: lista de empleados, para detectar si el
    // tercero de un egreso es en realidad alguien de la nómina.
    empleados: contexto.empleados || []
  };

  const alertas = [];
  for (const regla of REGLAS) {
    let dispara = false;
    try { dispara = regla.test(e, ctx); } catch { dispara = false; }
    if (!dispara) continue;
    let cuerpo = {};
    try { cuerpo = regla.mensaje(e, ctx) || {}; } catch { cuerpo = {}; }
    alertas.push({
      id: regla.id,
      severidad: regla.severidad,
      titulo: cuerpo.titulo || regla.id,
      detalle: cuerpo.detalle || '',
      sugerencia: cuerpo.sugerencia || ''
    });
  }

  // Orden: graves primero
  const peso = { [GRAVE]: 0, [MEDIA]: 1, [LEVE]: 2 };
  alertas.sort((a, b) => peso[a.severidad] - peso[b.severidad]);

  const graves = alertas.filter(a => a.severidad === GRAVE).length;
  const medias = alertas.filter(a => a.severidad === MEDIA).length;
  const leves  = alertas.filter(a => a.severidad === LEVE).length;

  let resumen = 'Sin observaciones';
  if (alertas.length) {
    const partes = [];
    if (graves) partes.push(`${graves} grave${graves > 1 ? 's' : ''}`);
    if (medias) partes.push(`${medias} media${medias > 1 ? 's' : ''}`);
    if (leves)  partes.push(`${leves} leve${leves > 1 ? 's' : ''}`);
    resumen = partes.join(' · ');
  }

  return { alertas, hayGraves: graves > 0, resumen, conteo: { graves, medias, leves } };
}

/**
 * Corre las validaciones sobre una lista completa de egresos.
 * Se usa para el panel "Revisión de calidad" del módulo y para el ERI.
 */
function auditarLote(egresos, contexto = {}) {
  const lista = Array.isArray(egresos) ? egresos : [];
  const porRegla = {};
  const conAlerta = [];

  for (const e of lista) {
    if (e.anulado === true) continue;
    const meta = (contexto.categoriasMeta || []).find(c => norm(c.nombre) === norm(e.categoria)) || null;
    const r = validarEgreso(e, {
      ...contexto,
      categoriaMeta: meta,
      egresosRecientes: lista,
      empleados: contexto.empleados || []
    });
    if (!r.alertas.length) continue;
    conAlerta.push({
      id: e.id, numero: e.numero, fecha: e.fecha, concepto: e.concepto,
      proveedor: e.proveedor, categoria: e.categoria,
      monto: Number(e.totalPagar || e.monto) || 0,
      alertas: r.alertas
    });
    for (const a of r.alertas) {
      if (!porRegla[a.id]) porRegla[a.id] = { id: a.id, titulo: a.titulo, severidad: a.severidad, cantidad: 0, valor: 0 };
      porRegla[a.id].cantidad += 1;
      porRegla[a.id].valor += Number(e.totalPagar || e.monto) || 0;
    }
  }

  const peso = { [GRAVE]: 0, [MEDIA]: 1, [LEVE]: 2 };
  const ranking = Object.values(porRegla).sort((a, b) =>
    peso[a.severidad] - peso[b.severidad] || b.cantidad - a.cantidad
  );

  return {
    totalRevisados: lista.filter(e => e.anulado !== true).length,
    totalConAlerta: conAlerta.length,
    ranking,
    detalle: conAlerta
  };
}

export { validarEgreso, auditarLote, norm, GRAVE, MEDIA, LEVE };
