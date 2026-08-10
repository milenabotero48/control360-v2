// ═══════════════════════════════════════════════════════════════════════════════
// finanzas.js — Flujo de efectivo, indicadores y diagnóstico
// ─────────────────────────────────────────────────────────────────────────────
// FINANZAS-ANALISIS-001
//
// QUÉ AGREGA SOBRE EL ERI
// -----------------------
// El ERI dice cuánto ganó o perdió el negocio. Este módulo responde las dos
// preguntas que vienen después:
//
//   1. "¿Y dónde está la plata?"       → Estado de Flujo de Efectivo
//   2. "¿Eso está bien o mal?"          → Indicadores y diagnóstico
//
// EL ESTADO DE FLUJO DE EFECTIVO
// ------------------------------
// Es el estado financiero que explica por qué una empresa puede mostrar
// utilidad y no tener con qué pagar la nómina. Separa el movimiento de dinero
// en tres actividades:
//
//   OPERACIÓN    · lo que genera o consume el negocio en sí
//   INVERSIÓN    · compra o venta de activos (equipos, vehículos, herramientas)
//   FINANCIACIÓN · préstamos, aportes de socios, retiros
//
// Se usa el MÉTODO DIRECTO (entradas y salidas reales), que es el que entiende
// un empresario, y además se muestra la CONCILIACIÓN con la utilidad contable,
// que es la parte que de verdad explica la diferencia.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();
const A = require('../services/analisisFinanciero');

const resolverAdminId = (req) => req.adminId || req.user?.uid || req.user?.id || null;

const diasEntre = (desde, hasta) => {
  const a = new Date(String(desde) + 'T00:00:00');
  const b = new Date(String(hasta) + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return 30;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
};

const enRango = (fecha, desde, hasta) => {
  const f = String(fecha || '').slice(0, 10);
  if (!f) return false;
  if (desde && f < desde) return false;
  if (hasta && f > hasta) return false;
  return true;
};

// Categorías que representan compra de activos, no gasto del período
const esInversion = (categoria) => /activo fijo|equipo|maquinaria|herramienta|vehiculo|veh[íi]culo|mueble|computador|inversion|inversi[óo]n/i
  .test(String(categoria || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));

// Categorías de financiación: préstamos, aportes, retiros de socios
const esFinanciacion = (categoria, concepto) => {
  const t = `${categoria || ''} ${concepto || ''}`.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /prestamo|credito|cuota bancaria|leasing|aporte socio|retiro socio|dividendo|capital/i.test(t);
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/finanzas/flujo-efectivo?desde&hasta
// ═════════════════════════════════════════════════════════════════════════════
router.get('/flujo-efectivo', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'No autenticado' });

    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requiere el rango de fechas' });

    const [ordSnap, egrSnap, movSnap, cajaSnap] = await Promise.all([
      db.collection('orders').where('userId', '==', adminId).get().catch(() => ({ docs: [] })),
      db.collection('egresos').where('userId', '==', adminId).get(),
      db.collection('movimientos').where('userId', '==', adminId).get().catch(() => ({ docs: [] })),
      db.collection('cajas').where('userId', '==', adminId).get().catch(() => ({ docs: [] })),
    ]);

    // ─── ENTRADAS DE EFECTIVO ────────────────────────────────────────────────
    // Solo lo efectivamente COBRADO en el período. Una venta a crédito genera
    // ingreso en el ERI pero NO entra acá hasta que el cliente pague: esa es
    // justamente la diferencia que este estado viene a explicar.
    let cobrosClientes = 0;
    let ventasCausadas = 0;
    let ventasACredito = 0;
    const detalleCobros = [];

    ordSnap.docs.forEach(d => {
      const o = d.data();
      if (o.anulada === true || o.estado === 'ANULADA') return;
      const total = Number(o.total || o.totalOrden || o.valorTotal) || 0;
      if (total <= 0) return;

      const fechaOrden = String(o.fecha || o.fechaCreacion || '').slice(0, 10);
      if (enRango(fechaOrden, desde, hasta)) ventasCausadas += total;

      // Cobrado: si está pagada y la fecha de pago cae en el rango
      const pagada = o.pagado === true || o.estado === 'PAGADA' || o.estado === 'pagado';
      const fechaCobro = String(o.fechaPago || o.fecha || '').slice(0, 10);

      if (pagada && enRango(fechaCobro, desde, hasta)) {
        cobrosClientes += total;
        detalleCobros.push({
          numero: o.numeroOrden || o.numero || '', fecha: fechaCobro,
          cliente: o.clienteNombre || o.cliente || '', valor: total
        });
      } else if (!pagada && enRango(fechaOrden, desde, hasta)) {
        ventasACredito += total;
      }
    });

    // ─── SALIDAS DE EFECTIVO ─────────────────────────────────────────────────
    const salidas = {
      proveedores: 0,      // compra de mercancía
      personal: 0,         // nómina y anticipos
      operativos: 0,       // transporte, papelería, mantenimiento
      fijos: 0,            // arriendo, servicios públicos
      administrativos: 0,
      financieros: 0,
      impuestos: 0,
      inversion: 0,        // compra de activos → actividad de inversión
      financiacion: 0      // préstamos, aportes, retiros → actividad de financiación
    };
    const detalleSalidas = [];

    // Mapa categoría → tipoERI, para clasificar bien cada salida
    const cfgDoc = await db.collection('configuracion').doc(adminId).get();
    const cats = cfgDoc.exists ? (cfgDoc.data().categoriasEgresos || []) : [];
    const tipoDeCategoria = {};
    cats.forEach(c => { tipoDeCategoria[String(c.nombre || '').toLowerCase()] = c.tipoERI; });

    egrSnap.docs.forEach(d => {
      const e = d.data();
      if (e.anulado === true) return;
      if (e.estado !== 'PAGADO') return;
      // Los anticipos a mensajeros no son salida definitiva: se legalizan
      if (e.tipo === 'provisional' || e.estado === 'ANTICIPO') return;
      if (e.tipo === 'retencion') return;

      const fecha = String(e.fechaPago || e.fecha || '').slice(0, 10);
      if (!enRango(fecha, desde, hasta)) return;

      const valor = Number(e.totalPagar || e.monto) || 0;
      if (valor <= 0) return;

      const cat = e.categoria || '';
      const tipoERI = tipoDeCategoria[cat.toLowerCase()] || '';

      let bucket;
      if (esFinanciacion(cat, e.concepto))      bucket = 'financiacion';
      else if (esInversion(cat))                bucket = 'inversion';
      else if (tipoERI === 'compra_inventario') bucket = 'proveedores';
      else if (tipoERI === 'gasto_personal')    bucket = 'personal';
      else if (tipoERI === 'gasto_fijo')        bucket = 'fijos';
      else if (tipoERI === 'gasto_administrativo') bucket = 'administrativos';
      else if (tipoERI === 'gasto_financiero')  bucket = 'financieros';
      else if (tipoERI === 'gasto_fiscal')      bucket = 'impuestos';
      else                                      bucket = 'operativos';

      salidas[bucket] += valor;
      detalleSalidas.push({
        numero: e.numero || '', fecha, categoria: cat,
        concepto: e.concepto || '', valor, actividad: bucket
      });
    });

    // ─── ARMADO DEL ESTADO ───────────────────────────────────────────────────
    const salidasOperacion =
      salidas.proveedores + salidas.personal + salidas.operativos +
      salidas.fijos + salidas.administrativos + salidas.financieros + salidas.impuestos;

    const flujoOperacion = cobrosClientes - salidasOperacion;
    const flujoInversion = -salidas.inversion;
    const flujoFinanciacion = -salidas.financiacion;
    const flujoNeto = flujoOperacion + flujoInversion + flujoFinanciacion;

    // Saldo actual de cajas (foto de hoy, no del período)
    let saldoCajas = 0;
    cajaSnap.docs.forEach(d => { saldoCajas += Number(d.data().saldo) || 0; });

    // ─── CONCILIACIÓN CON LA UTILIDAD ────────────────────────────────────────
    // La parte que responde "gané pero no tengo plata".
    const conciliacion = [];
    if (ventasACredito > 0) {
      conciliacion.push({
        concepto: 'Ventas facturadas que aún no se han cobrado',
        valor: -ventasACredito,
        explica: 'El estado de resultados ya las cuenta como ingreso, pero la plata todavía está en cartera.'
      });
    }
    if (salidas.proveedores > 0) {
      conciliacion.push({
        concepto: 'Compra de mercancía para inventario',
        valor: -salidas.proveedores,
        explica: 'Salió de caja pero no es gasto: se convirtió en inventario. Será costo cuando se venda.'
      });
    }

    // Provisiones causadas: gasto que NO movió caja — va en sentido contrario
    let provisiones = 0;
    try {
      const pSnap = await db.collection('provisiones_prestaciones')
        .where('userId', '==', adminId).get();
      pSnap.docs.forEach(d => {
        const p = d.data();
        if (p.revertida === true) return;
        const periodo = p.periodo || `${p.anio}-${String(p.mes).padStart(2, '0')}`;
        if (desde && `${periodo}-31` < desde) return;
        if (hasta && `${periodo}-01` > hasta) return;
        provisiones += Number(p.totalPrestaciones) || 0;
      });
    } catch { }

    if (provisiones > 0) {
      conciliacion.push({
        concepto: 'Provisión de prestaciones sociales',
        valor: provisiones,
        explica: 'Es gasto del período pero no salió de caja: se paga después (cesantías en febrero, prima en junio y diciembre).'
      });
    }

    res.json({
      periodo: { desde, hasta, dias: diasEntre(desde, hasta) },

      operacion: {
        entradas: [
          { concepto: 'Cobros a clientes', valor: Math.round(cobrosClientes), detalle: detalleCobros.length }
        ],
        totalEntradas: Math.round(cobrosClientes),
        salidas: [
          { concepto: 'Pago a proveedores (mercancía)', valor: Math.round(salidas.proveedores) },
          { concepto: 'Pago de personal',               valor: Math.round(salidas.personal) },
          { concepto: 'Gastos operativos',              valor: Math.round(salidas.operativos) },
          { concepto: 'Gastos fijos',                   valor: Math.round(salidas.fijos) },
          { concepto: 'Gastos administrativos',         valor: Math.round(salidas.administrativos) },
          { concepto: 'Gastos financieros',             valor: Math.round(salidas.financieros) },
          { concepto: 'Impuestos',                      valor: Math.round(salidas.impuestos) },
        ].filter(x => x.valor !== 0),
        totalSalidas: Math.round(salidasOperacion),
        flujo: Math.round(flujoOperacion)
      },

      inversion: {
        salidas: [{ concepto: 'Compra de activos y equipos', valor: Math.round(salidas.inversion) }].filter(x => x.valor !== 0),
        flujo: Math.round(flujoInversion),
        nota: salidas.inversion === 0
          ? 'No se registraron compras de activos en el período. Si comprás equipos o vehículos, clasificalos con una categoría de activo fijo para que aparezcan acá y no como gasto.'
          : null
      },

      financiacion: {
        salidas: [{ concepto: 'Préstamos, aportes y retiros', valor: Math.round(salidas.financiacion) }].filter(x => x.valor !== 0),
        flujo: Math.round(flujoFinanciacion),
        nota: salidas.financiacion === 0
          ? 'No se registraron movimientos de financiación. Los préstamos bancarios y los retiros de socios van acá, no en gastos operativos.'
          : null
      },

      resumen: {
        flujoOperacion: Math.round(flujoOperacion),
        flujoInversion: Math.round(flujoInversion),
        flujoFinanciacion: Math.round(flujoFinanciacion),
        flujoNeto: Math.round(flujoNeto),
        saldoCajasHoy: Math.round(saldoCajas),
        // La lectura de fondo: ¿el negocio genera caja por sí solo?
        interpretacion: flujoOperacion > 0
          ? 'La operación genera efectivo por sí sola. Es la señal más sana que puede dar un negocio.'
          : 'La operación consume más efectivo del que genera. Se está financiando con caja acumulada, con crédito o con aportes.'
      },

      conciliacion: {
        detalle: conciliacion,
        nota: 'Estas son las diferencias entre la utilidad del estado de resultados y el efectivo real. Explican por qué el informe puede mostrar ganancia sin que haya plata en el banco.'
      },

      ventasCausadas: Math.round(ventasCausadas),
      ventasACredito: Math.round(ventasACredito),
      detalleSalidas: detalleSalidas.sort((a, b) => b.valor - a.valor).slice(0, 200)
    });
  } catch (e) {
    console.error('GET flujo-efectivo:', e);
    res.status(500).json({ error: 'Error al calcular el flujo de efectivo' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/finanzas/analisis?desde&hasta
// ─────────────────────────────────────────────────────────────────────────────
// Indicadores + diagnóstico. Se apoya en el ERI para no duplicar el cálculo
// del estado de resultados: una sola fuente de verdad para las cifras.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/analisis', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requiere el rango de fechas' });

    // Se reutiliza el router del ERI llamándolo internamente sería frágil;
    // en su lugar el frontend manda el ERI ya calculado por POST. Este GET
    // queda para consultas simples que no necesitan el ERI completo.
    res.status(400).json({
      error: 'Usá POST /api/finanzas/analisis enviando el ERI del período en el cuerpo.'
    });
  } catch (e) {
    res.status(500).json({ error: 'Error en el análisis' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/finanzas/analisis
// ─────────────────────────────────────────────────────────────────────────────
// Recibe el ERI ya calculado y devuelve indicadores + diagnóstico.
// Se hace así a propósito: el ERI es la única fuente de las cifras, y este
// endpoint solo las interpreta. Si mañana cambia una regla contable, cambia
// en un solo lugar.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/analisis', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const { eri, desde, hasta, periodoAnterior } = req.body || {};
    if (!eri) return res.status(400).json({ error: 'Se requiere el ERI del período' });

    // Saldo de cajas y conteo de empleados — datos que el ERI no trae
    const [cajaSnap, empSnap] = await Promise.all([
      db.collection('cajas').where('userId', '==', adminId).get().catch(() => ({ docs: [] })),
      db.collection('empleados').where('userId', '==', adminId).get().catch(() => ({ docs: [] })),
    ]);

    let saldoCajas = 0;
    cajaSnap.docs.forEach(d => { saldoCajas += Number(d.data().saldo) || 0; });

    let empleadosActivos = 0;
    empSnap.docs.forEach(d => { if (d.data().activo !== false) empleadosActivos += 1; });

    // ══════════════════════════════════════════════════════════════════════
    // ✅ FIX FINANZAS-MAPEO-001
    // ──────────────────────────────────────────────────────────────────────
    // La estructura de la respuesta del ERI se había asumido en vez de
    // verificarse, y casi ningún campo coincidía. El resultado era silencioso
    // y engañoso: el costo de ventas caía a 0 (margen bruto 100%), la utilidad
    // operativa y la neta llegaban como OBJETO en vez de número (Number({}) es
    // NaN, que caía a 0 → márgenes en 0%), y el inventario, la cartera y las
    // categorías quedaban vacíos, dejando sin calcular los días de inventario
    // y el ciclo de efectivo.
    //
    // La forma REAL de la respuesta (routes/eri.js):
    //   eri.ingresos.total
    //   eri.costoVentas.total
    //   eri.utilidadBruta.total
    //   eri.utilidadOperativa.valor        ← objeto { valor, margen }
    //   eri.utilidadNeta.valor             ← objeto { valor, margen }
    //   eri.gastos.{personal,operativos,fijos,...}
    //   eri.meta.cantidadOrdenes
    //   eri.informe.inventario.{alCosto,comprasDelPeriodo}
    //   eri.informe.cartera.{cxc,cxp}.total
    //   eri.informe.anexos.{costos,ventas}
    //   eri.informe.prestaciones.causadasEnPeriodo
    //
    // Los números se pasan por Number() a propósito: si mañana cambia la forma
    // otra vez, es preferible un 0 explícito a un NaN propagándose por todos
    // los indicadores.
    // ══════════════════════════════════════════════════════════════════════
    const num = (v) => {
      const n = Number(v);
      return isFinite(n) ? n : 0;
    };

    const g = eri.gastos || {};
    const inf = eri.informe || {};

    const datos = {
      ingresos:          num(eri.ingresos?.total),
      costoVentas:       num(eri.costoVentas?.total),
      utilidadBruta:     num(eri.utilidadBruta?.total),
      utilidadOperativa: num(eri.utilidadOperativa?.valor),
      utilidadNeta:      num(eri.utilidadNeta?.valor),

      gastosPersonal:        num(g.personal),
      gastosOperativos:      num(g.operativos),
      gastosFijos:           num(g.fijos),
      gastosAdministrativos: num(g.administrativos),
      gastosFinancieros:     num(g.financieros),
      gastosFiscales:        num(g.fiscales),

      inventarioAlCosto: num(inf.inventario?.alCosto),
      comprasPeriodo:    num(inf.inventario?.comprasDelPeriodo),
      cxc:               num(inf.cartera?.cxc?.total),
      cxp:               num(inf.cartera?.cxp?.total),
      provisionesPrestaciones: num(inf.prestaciones?.causadasEnPeriodo),

      saldoCajas,
      empleados: empleadosActivos,
      ordenes: num(eri.meta?.cantidadOrdenes) || (inf.anexos?.ventas || []).length,
      diasPeriodo: diasEntre(desde, hasta),

      // Para el diagnóstico de líneas con margen negativo
      categorias: (inf.anexos?.costos || []).map(c => ({
        nombre: c.categoria, ingreso: num(c.ingreso), costo: num(c.costo)
      })),

      // Concentración de clientes
      clientes: (() => {
        const m = {};
        for (const v of (inf.anexos?.ventas || [])) {
          const n = v.clienteNombre || 'Sin cliente';
          m[n] = (m[n] || 0) + num(v.total);
        }
        return Object.entries(m).map(([nombre, total]) => ({ nombre, total }));
      })(),

      periodoAnterior: periodoAnterior || null
    };

    // Aviso si el ERI llegó sin las cifras principales: es preferible decirlo
    // a mostrar indicadores calculados sobre ceros.
    const avisos = [];
    if (datos.ingresos === 0) {
      avisos.push('El ERI del período no trae ingresos. Verificá el rango de fechas y que haya órdenes registradas.');
    }
    if (datos.ingresos > 0 && datos.costoVentas === 0) {
      avisos.push('El costo de ventas del período es cero, lo que da un margen bruto del 100%. Revisá que los productos vendidos tengan costo parametrizado y que los insumos de servicio estén clasificados como costo.');
    }

    const indicadores = A.calcularIndicadores(datos);
    const diagnostico = A.diagnosticar(datos, indicadores);

    res.json({
      periodo: { desde, hasta, dias: datos.diasPeriodo },
      indicadores: indicadores.indicadores,
      base: indicadores.base,
      pendientes: indicadores.pendientes,
      diagnostico,
      avisos,
      contexto: {
        empleadosActivos,
        saldoCajas: Math.round(saldoCajas),
        referencias: A.REFERENCIA,
        // Se devuelven las cifras usadas para poder auditar el mapeo desde la
        // interfaz sin tener que leer el código.
        cifrasUsadas: {
          ingresos: datos.ingresos,
          costoVentas: datos.costoVentas,
          utilidadBruta: datos.utilidadBruta,
          utilidadOperativa: datos.utilidadOperativa,
          utilidadNeta: datos.utilidadNeta,
          gastosTotales: indicadores.base.gastosTotales,
          inventario: datos.inventarioAlCosto,
          cxc: datos.cxc,
          cxp: datos.cxp
        }
      }
    });
  } catch (e) {
    console.error('POST analisis:', e);
    res.status(500).json({ error: 'Error al generar el análisis financiero' });
  }
});

module.exports = router;
