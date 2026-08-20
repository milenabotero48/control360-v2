// ═══════════════════════════════════════════════════════════════════════════════
// ERI — Estado de Resultados Integral (Ola 3 — Bloque 1)
// ─────────────────────────────────────────────────────────────────────────────
// Calcula el P&G de la empresa en TIEMPO REAL para un rango de fechas dado.
//
// Modelo contable (decisión Ola 3):
//
//   INGRESOS POR SERVICIOS (mano de obra)
//     - Servicios línea Recargas y Mantenimiento     $X
//     - Servicios línea Señalización                  $X
//     - Servicios línea Otros                          $X
//
//   (-) COSTOS DE SERVICIOS (egresos categoría costo_servicio)
//     - Insumos taller → línea Recargas
//     - Compra señales → línea Señalización
//
//   = UTILIDAD BRUTA SERVICIOS (por línea y total)
//
//   INGRESOS POR PRODUCTOS (lámparas, botiquines, extintores nuevos, etc.)
//     - Ventas de productos                          $X
//
//   (-) COSTO DE VENTA DE PRODUCTOS (precioCosto × cantidad de items vendidos)
//
//   = UTILIDAD BRUTA PRODUCTOS
//
//   UTILIDAD BRUTA TOTAL = Servicios + Productos
//
//   (-) GASTOS OPERATIVOS (transporte, mantenimiento, papelería, ...)
//   (-) GASTOS FIJOS (arriendo, servicios públicos)
//   (-) GASTOS DE PERSONAL (nómina)
//   (-) GASTOS ADMINISTRATIVOS (marketing, contabilidad externa)
//   (-) GASTOS FINANCIEROS (comisiones bancarias)
//   (-) GASTOS FISCALES (impuestos)
//
//   = UTILIDAD NETA
//
// Filtros disponibles:
//   - desde / hasta (rango de fechas YYYY-MM-DD)
//   - empresaId (opcional → si no viene, consolidado de todas las empresas)
//   - vista: 'completa' | 'lineas' | 'empresa'
//
// Endpoint: GET /api/eri?desde=2026-01-01&hasta=2026-05-30&empresaId=&vista=completa
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();

// ── Helpers ──────────────────────────────────────────────────────────────────

// Parseo de fechas: acepta YYYY-MM-DD, ISO completo, o Timestamp Firestore.
const parseFecha = (raw) => {
  if (!raw) return null;
  if (raw._seconds) return new Date(raw._seconds * 1000);
  if (raw.toDate)   return raw.toDate();
  if (typeof raw === 'string') return new Date(raw);
  return new Date(raw);
};

// Convierte YYYY-MM-DD a Date inicio/fin del día (zona Colombia UTC-5)
const fechaInicioCO = (yyyymmdd) => {
  if (!yyyymmdd) return null;
  return new Date(`${yyyymmdd}T00:00:00.000-05:00`);
};
const fechaFinCO = (yyyymmdd) => {
  if (!yyyymmdd) return null;
  return new Date(`${yyyymmdd}T23:59:59.999-05:00`);
};

// ── Endpoint principal: GET /api/eri ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    if (!adminId) return res.status(401).json({ error: 'Sin autenticación' });

    const { desde, hasta, empresaId = '', vista = 'completa' } = req.query;

    // Si no vienen fechas, usar el mes actual
    const hoy = new Date();
    const yyyy = hoy.getFullYear();
    const mm = String(hoy.getMonth() + 1).padStart(2, '0');
    const desdeStr = desde || `${yyyy}-${mm}-01`;
    const hastaStr = hasta || `${yyyy}-${mm}-${String(new Date(yyyy, hoy.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
    const desdeDate = fechaInicioCO(desdeStr);
    const hastaDate = fechaFinCO(hastaStr);

    // ── 1. Cargar configuración (líneas de servicio + categorías) ───────────
    const configDoc = await db.collection('configuracion').doc(adminId).get();
    const config = configDoc.exists ? configDoc.data() : {};
    const lineasServicio = (config.lineasServicio || []).filter(l => l.activa !== false);
    const categoriasEgresos = config.categoriasEgresos || [];

    // Mapa rápido categoría nombre → { tipoERI, lineaServicioId }
    const mapaCategoria = {};
    categoriasEgresos.forEach(c => {
      mapaCategoria[c.nombre] = {
        tipoERI: c.tipoERI || 'gasto_operativo',
        lineaServicioId: c.lineaServicioId || null
      };
    });

    // ── 2. Cargar productos (para conocer precioCosto y tipo) ──────────────
    // Los productos se guardan con campo `creadoPor` = uid del admin. Cargamos
    // los del admin actual. Si el catálogo es viejo (sin creadoPor) caemos al
    // catálogo completo, pero filtramos rápido para no disparar logs de seguridad.
    let prodsSnap = await db.collection('products').where('creadoPor', '==', adminId).get();
    const productos = {};
    prodsSnap.docs.forEach(d => { productos[d.id] = d.data(); });
    // Fallback: si el catálogo no tiene creadoPor (productos legacy), cargamos todo
    if (Object.keys(productos).length === 0) {
      const all = await db.collection('products').get();
      all.docs.forEach(d => { productos[d.id] = d.data(); });
    }

    // ── 3. Cargar empresas (para nombres en la salida) ──────────────────────
    const empresasSnap = await db.collection('companies')
      .where('user_id', '==', adminId).get();
    const empresas = {};
    empresasSnap.docs.forEach(d => { empresas[d.id] = { id: d.id, ...d.data() }; });

    // ── 4. Cargar ÓRDENES en rango — PRINCIPIO DE CAUSACIÓN ─────────────────
    // ✅ ERI-CAUSACION-001: bajo la norma colombiana, el ingreso se reconoce
    // cuando se PRESTA el servicio (se devenga), NO cuando se cobra. Por eso:
    //   - Cuenta TODA orden cuyo servicio se prestó en el período, esté
    //     pagada, a crédito (CxC) o pendiente de cobro.
    //   - La fecha de reconocimiento es la de ELABORACIÓN de la orden
    //     (fechaCreacion/createdAt), no la de pago.
    //   - Una venta de junio cuenta en JUNIO aunque paguen en julio.
    //   - Las anuladas NO cuentan. Las internas/producción tampoco (no son
    //     ingreso comercial).
    // La cartera (CxC/CxP) se muestra aparte como sección informativa.
    let ordenesQuery = db.collection('orders').where('adminId', '==', adminId);
    if (empresaId) ordenesQuery = ordenesQuery.where('empresaId', '==', empresaId);
    const ordenesSnap = await ordenesQuery.get();

    const ordenesEnRango = [];
    ordenesSnap.docs.forEach(d => {
      const o = d.data();
      // Excluir anuladas (no se devengó nada)
      if (o.anulada === true || o.estado === 'anulada') return;
      // Excluir internas / producción (no son ingreso comercial)
      if (o.tipoOrden === 'interna' || o.tipoOrden === 'produccion') return;
      // ✅ CAUSACIÓN: fecha de elaboración de la orden (no de pago)
      const fechaRef = parseFecha(o.fechaCreacion || o.createdAt || o.fechaFactura);
      if (!fechaRef) return;
      if (fechaRef < desdeDate || fechaRef > hastaDate) return;
      ordenesEnRango.push({ id: d.id, ...o, _fechaRef: fechaRef });
    });

    // ── 5. Cargar EGRESOS en rango (solo PAGADOS) ───────────────────────────
    const egresosSnap = await db.collection('egresos')
      .where('userId', '==', adminId).get();

    const egresosEnRango = [];
    egresosSnap.docs.forEach(d => {
      const e = d.data();
      if (e.estado !== 'PAGADO') return;
      // Excluir retenciones automáticas (ya están en la orden, no doble-contar)
      if (e.tipo === 'retencion') return;
      // ✅ EGRESO-PROV-001: los ANTICIPOS a mensajeros NO son gasto. El gasto
      // entra al ERI cuando se legaliza, por el egreso definitivo con su
      // factura, IVA y retención. Exclusión EXPLÍCITA — antes solo quedaban
      // fuera por accidente (nacían en estado 'PENDIENTE'); si alguien le daba
      // "Pagar" al anticipo, empezaba a contar como gasto y se duplicaba.
      if (e.tipo === 'provisional' || e.estado === 'ANTICIPO') return;
      // Excluir anulados (no se devengó nada)
      if (e.anulado === true) return;
      // ══════════════════════════════════════════════════════════════════════
      // ✅ FIX CAUSACION-001 — el ERI usa la fecha de CAUSACIÓN, no la de pago
      // ──────────────────────────────────────────────────────────────────────
      // Antes se priorizaba `fechaPago`, que es exactamente al revés de lo que
      // manda el principio de devengo. Un servicio prestado en julio y pagado
      // en agosto quedaba como costo de agosto: julio salía con margen inflado
      // y agosto con un costo que no le corresponde.
      //
      // Ahora manda `fechaCausacion` (a qué mes pertenece el gasto). Si el
      // egreso no la tiene —los registrados antes de este cambio— se cae a
      // `fecha`, que es el comportamiento que ya tenían.
      //
      // La fecha de pago sigue mandando en el Estado de Flujo de Efectivo,
      // que es donde corresponde: ahí importa cuándo se movió la plata.
      // ══════════════════════════════════════════════════════════════════════
      const fechaRef = parseFecha(e.fechaCausacion || e.fecha || e.createdAt);
      if (!fechaRef) return;
      if (fechaRef < desdeDate || fechaRef > hastaDate) return;
      egresosEnRango.push({ id: d.id, ...e, _fechaRef: fechaRef });
    });

    // ─────────────────────────────────────────────────────────────────────
    // CÁLCULO DEL ERI
    // ─────────────────────────────────────────────────────────────────────

    // Estructura del resultado por línea de servicio
    const porLinea = {};
    lineasServicio.forEach(l => {
      porLinea[l.id] = {
        id: l.id,
        nombre: l.nombre,
        color: l.color,
        ingresoServicio: 0,
        costoServicio: 0,
        // ✅ FIX ERI-LINEA-002: el costo de una línea suma DOS cosas distintas.
        // Mostrarlas juntas hacía imposible cuadrar la vista por línea contra
        // el desglose por categoría del estado de resultados, porque miden
        // cosas diferentes. Ahora se guardan separadas y la línea las explica.
        //   costoInsumos  · egresos de insumos (categoría costo_servicio)
        //   costoProductos· costo de los productos vendidos en esa línea
        costoInsumos: 0,
        costoProductos: 0,
        utilidadBruta: 0,
        margenPct: 0
      };
    });
    // Línea "sin clasificar" para servicios cuya categoría no mapea
    porLinea['_sin_clasificar'] = {
      id: '_sin_clasificar', nombre: 'Sin clasificar',
      color: '#9ca3af',
      ingresoServicio: 0, costoServicio: 0,
      costoInsumos: 0, costoProductos: 0,
      utilidadBruta: 0, margenPct: 0
    };

    // Acumuladores principales
    let totalServicios = 0;
    let totalCostoServicios = 0;
    let totalProductos = 0;
    let totalCostoProductos = 0;
    // ✅ ERI-TRAZABILIDAD-001: detalle línea por línea de cada categoría
    const detallePorCategoria = {};
    const ingresosPorEmpresa = {};   // empresaId → monto
    const cantidadOrdenes = {};      // empresaId → conteo
    const detalleOrdenes = [];       // Para drill-down
    const detalleEgresos = [];

    // ✅ ERI-COSTO-001: acumuladores del INFORME P&G por CATEGORÍA de producto.
    // Ingresos y costo de ventas se agrupan por la categoría del producto
    // (Extintores, Botiquines, Recarga...). El costo es el REAL de lo vendido:
    // cantidad vendida × precioCosto del producto — nunca la compra de mercancía.
    const ingresoPorCategoria = {};  // categoria → monto vendido
    const costoPorCategoria = {};    // categoria → costo de lo vendido
    const anexoVentas = [];          // listado de órdenes (anexo)

    // Helper: clasificar item como servicio o producto
    const clasificarItem = (item) => {
      const prod = productos[item.productoId];
      const tipo = prod?.tipo || 'simple';
      const esServicio = ['servicio', 'combo'].includes(tipo);
      return {
        esServicio,
        tipo,
        precioCosto: Number(prod?.precioCosto || 0),
        categoria: item.categoria || prod?.categoriaNombre || '',
        // La línea del servicio se determina por la categoría del item
        lineaId: esServicio ? matchCategoriaConLinea(item.categoria || prod?.categoriaNombre || '', lineasServicio) : null
      };
    };

    // ── Procesar órdenes ────────────────────────────────────────────────────
    ordenesEnRango.forEach(o => {
      const empId = o.empresaId || 'sin_empresa';
      ingresosPorEmpresa[empId] = (ingresosPorEmpresa[empId] || 0) + (Number(o.total) || 0);
      cantidadOrdenes[empId] = (cantidadOrdenes[empId] || 0) + 1;

      let ingresoServiciosOrden = 0;
      let ingresoProductosOrden = 0;
      let costoProductosOrden = 0;

      (o.items || []).forEach(item => {
        const cls = clasificarItem(item);
        const cantidad = Number(item.cantidad) || 1;
        const subtotal = Number(item.subtotalItem || (item.precioUnitario * cantidad * (1 - (item.descuento || 0) / 100))) || 0;

        // ✅ ERI-COSTO-001: agrupar por categoría de producto para el informe.
        // Ingreso = lo vendido; costo = cantidad × precioCosto (costo real de
        // lo vendido, NO la compra de mercancía). Los servicios también tienen
        // categoría (Recarga, etc.) y su costo directo si el producto lo define.
        const catNombre = cls.categoria || 'Sin categoría';
        ingresoPorCategoria[catNombre] = (ingresoPorCategoria[catNombre] || 0) + subtotal;
        const costoItem = cls.precioCosto * cantidad;
        if (costoItem > 0) {
          costoPorCategoria[catNombre] = (costoPorCategoria[catNombre] || 0) + costoItem;
        }

        // ══════════════════════════════════════════════════════════════════
        // ✅ ERI-TRAZABILIDAD-001 — De dónde sale cada cifra
        // ──────────────────────────────────────────────────────────────────
        // Antes el informe mostraba "CINTAS $37.100" y ahí se acababa: para
        // saber QUÉ ventas generaron ese costo había que salir del sistema y
        // revisar las órdenes a mano.
        //
        // Ahora cada categoría guarda el detalle línea por línea: qué orden,
        // qué cliente, qué producto, cuántas unidades y a qué costo. Un
        // informe que no se puede auditar no sirve para tomar decisiones.
        // ══════════════════════════════════════════════════════════════════
        if (!detallePorCategoria[catNombre]) detallePorCategoria[catNombre] = [];
        detallePorCategoria[catNombre].push({
          numeroOrden: o.numeroOrden || '',
          fecha: (o._fechaRef instanceof Date ? o._fechaRef.toISOString() : '').slice(0, 10),
          cliente: o.clienteNombre || '',
          producto: item.nombre || item.descripcion || item.productoNombre || 'Sin nombre',
          esServicio: cls.esServicio,
          cantidad,
          precioUnitario: Number(item.precioUnitario) || 0,
          costoUnitario: cls.precioCosto,
          ingreso: subtotal,
          costo: costoItem
        });

        if (cls.esServicio) {
          ingresoServiciosOrden += subtotal;
          totalServicios += subtotal;
          // Asignar a línea correspondiente
          const lineaId = cls.lineaId || '_sin_clasificar';
          if (!porLinea[lineaId]) {
            porLinea[lineaId] = { id: lineaId, nombre: 'Sin clasificar', color: '#9ca3af', ingresoServicio: 0, costoServicio: 0, costoInsumos: 0, costoProductos: 0, utilidadBruta: 0, margenPct: 0 };
          }
          porLinea[lineaId].ingresoServicio += subtotal;
          // ✅ ERI-COSTO-002: si el SERVICIO tiene precioCosto definido (raro,
          // pero posible), también suma a su costo de línea. El costo principal
          // de un servicio fabricado viene de los insumos (egresos costo_servicio).
          // ══════════════════════════════════════════════════════════════════
          // ✅ FIX ERI-COSTOSERVICIO-002 — costo unitario de un servicio
          // ──────────────────────────────────────────────────────────────────
          // EL BUG: este costo se sumaba al desglose por categoría y a la línea,
          // pero NUNCA al total del costo de ventas. Resultado: aparecía en la
          // lista sin contarse, la utilidad bruta quedaba sobrestimada por ese
          // valor, y el desglose no cuadraba con el total. En Extintores del
          // Valle eran $433.000 que se veían pero no sumaban — el síntoma fue
          // una fila de "costos sin clasificar" en NEGATIVO.
          //
          // Un servicio con costo unitario definido SÍ es costo de ventas: es
          // lo que cuesta prestarlo. Va al total de costos de servicio, que es
          // donde corresponde por naturaleza.
          // ══════════════════════════════════════════════════════════════════
          if (cls.precioCosto > 0) {
            const costoServicioItem = cls.precioCosto * cantidad;
            porLinea[lineaId].costoServicio += costoServicioItem;
            porLinea[lineaId].costoProductos += costoServicioItem;
            totalCostoServicios += costoServicioItem;
          }
        } else {
          ingresoProductosOrden += subtotal;
          totalProductos += subtotal;
          const costo = cls.precioCosto * cantidad;
          costoProductosOrden += costo;
          totalCostoProductos += costo;
          // ✅ ERI-COSTO-002: los PRODUCTOS también pertenecen a una línea (ej:
          // señales compradas ya hechas → línea Señalización). Su ingreso y su
          // costo (precioCosto ya digitado) van a la línea, para que el margen
          // por línea sea real. Antes los productos no sumaban a ninguna línea
          // y el costo de señales compradas se perdía.
          const lineaIdProd = matchCategoriaConLinea(cls.categoria, lineasServicio);
          if (lineaIdProd) {
            if (!porLinea[lineaIdProd]) {
              porLinea[lineaIdProd] = { id: lineaIdProd, nombre: 'Sin clasificar', color: '#9ca3af', ingresoServicio: 0, costoServicio: 0, costoInsumos: 0, costoProductos: 0, utilidadBruta: 0, margenPct: 0 };
            }
            porLinea[lineaIdProd].ingresoServicio += subtotal;
            porLinea[lineaIdProd].costoServicio += costo;
            porLinea[lineaIdProd].costoProductos += costo;
          }
        }
      });

      detalleOrdenes.push({
        id: o.id, numeroOrden: o.numeroOrden, empresaNombre: o.empresaNombre,
        clienteNombre: o.clienteNombre, fecha: o._fechaRef.toISOString(),
        total: o.total, formaPago: o.formaPago,
        ingresoServicios: ingresoServiciosOrden,
        ingresoProductos: ingresoProductosOrden,
        costoProductos: costoProductosOrden
      });

      // ✅ ERI-COSTO-001: anexo de ventas — una línea por orden (suma = ingresos)
      anexoVentas.push({
        numeroOrden: o.numeroOrden,
        fecha: o._fechaRef.toISOString().slice(0, 10),
        clienteNombre: o.clienteNombre || '',
        empresaNombre: o.empresaNombre || '',   // ✅ para auditar por empresa
        estado: o.estado || '',                 // ✅ ver el estado de cada orden
        total: Number(o.total) || 0
      });
    });

    // ── Procesar egresos ────────────────────────────────────────────────────
    const gastosPorTipo = {
      gasto_personal: 0, gasto_operativo: 0, gasto_fijo: 0,
      gasto_administrativo: 0, gasto_financiero: 0, gasto_fiscal: 0
    };
    const gastosDetallePorCategoria = {}; // 'Nómina' → 1500000
    // ✅ ERI-COSTO-001: compras de mercancía — acumulan APARTE, NO son gasto ni
    // costo del período. Van a la sección informativa de inventario.
    let totalComprasInventario = 0;
    const anexoCompras = []; // listado de compras de mercancía (anexo)

    // ✅ NOMINA-PASIVO-001: pagos que descargan el pasivo laboral. NO son gasto:
    // las prestaciones ya se causaron mes a mes en `provisiones_prestaciones`.
    // Contarlas otra vez acá era el doble conteo que inflaba febrero, junio y
    // diciembre. Salen del P&G y se muestran aparte, igual que las compras de
    // inventario. La plata sí se ve salir en el flujo de efectivo.
    let totalPagosPasivoLaboral = 0;
    const anexoPagosPasivo = [];

    egresosEnRango.forEach(e => {
      const cls = mapaCategoria[e.categoria] || { tipoERI: 'gasto_operativo', lineaServicioId: null };
      const monto = Number(e.monto) || 0;

      // ✅ NOMINA-PASIVO-001: descargue de pasivo laboral — fuera del P&G.
      // Se reconoce por la marca del documento (robusta aunque el usuario
      // elija mal la categoría) o por el tipoERI de la categoría.
      if (e.esPagoPasivoLaboral === true || cls.tipoERI === 'pago_pasivo_laboral') {
        totalPagosPasivoLaboral += monto;
        anexoPagosPasivo.push({
          fecha: (e.fecha || '').slice(0, 10),
          numero: e.numero || '',
          beneficiario: e.empleadoNombre || e.proveedor || '',
          concepto: e.concepto || '',
          monto
        });
        // El excedente sobre lo provisionado SÍ es gasto: se provisionó de menos.
        const excedente = Number(e.excedenteGasto) || 0;
        if (excedente > 0) {
          gastosPorTipo.gasto_personal += excedente;
          gastosDetallePorCategoria['Ajuste por defecto de provisión'] =
            (gastosDetallePorCategoria['Ajuste por defecto de provisión'] || 0) + excedente;
        }
        return; // no suma a gastos ni a costos
      }

      // ✅ NOMINA-RETENCION-001 (Fase 3, apagada por defecto)
      // El comprobante de nómina sale por el NETO, pero el gasto real es el
      // DEVENGADO: la salud y la pensión que se le retienen al trabajador
      // también son costo del período, solo que la empresa las guarda hasta
      // pagar la PILA. Con la causación encendida, se agrega la retención
      // acá y el pago de la PILA deja de ser gasto.
      // Apagado (por defecto) no entra nada y todo funciona como siempre.
      if (e.esComprobanteNomina === true && e.causaRetencionEmpleado === true) {
        const retenido = Number(e.retencionSeguridadSocial) || 0;
        if (retenido > 0) {
          gastosPorTipo.gasto_personal += retenido;
          gastosDetallePorCategoria['Retención al trabajador (salud y pensión)'] =
            (gastosDetallePorCategoria['Retención al trabajador (salud y pensión)'] || 0) + retenido;
        }
      }

      // ✅ ERI-COSTO-001: compra de mercancía NO entra al P&G
      if (cls.tipoERI === 'compra_inventario') {
        totalComprasInventario += monto;
        anexoCompras.push({
          fecha: (e.fecha || '').slice(0, 10),
          proveedor: e.proveedor || '',
          concepto: e.concepto || '',
          monto
        });
        return; // no suma a gastos ni a costos
      }

      if (cls.tipoERI === 'costo_servicio') {
        // Costo directo de una línea
        const lineaId = cls.lineaServicioId || '_sin_clasificar';
        if (!porLinea[lineaId]) {
          porLinea[lineaId] = { id: lineaId, nombre: 'Sin clasificar', color: '#9ca3af', ingresoServicio: 0, costoServicio: 0, costoInsumos: 0, costoProductos: 0, utilidadBruta: 0, margenPct: 0 };
        }
        porLinea[lineaId].costoServicio += monto;
        porLinea[lineaId].costoInsumos += monto;
        totalCostoServicios += monto;
      } else {
        // Gasto operativo/fijo/etc.
        // ✅ ERI-GASTOS-001: garantizar que NINGÚN gasto se pierda. Si la
        // categoría no tiene un tipoERI válido reconocido, el gasto NO se
        // descarta ni se esconde: se marca como "Otros gastos no identificados"
        // para que sea visible y Sandra lo reclasifique. El dinero SIEMPRE
        // aparece en el informe.
        const tiposValidos = ['gasto_personal', 'gasto_operativo', 'gasto_fijo', 'gasto_administrativo', 'gasto_financiero', 'gasto_fiscal'];
        const tipo = tiposValidos.includes(cls.tipoERI) ? cls.tipoERI : 'gasto_operativo';
        const noIdentificado = !cls.tipoERI || !tiposValidos.includes(cls.tipoERI);
        gastosPorTipo[tipo] += monto;
        // La categoría visible: si no está identificada, se agrupa aparte
        const catVisible = noIdentificado ? 'Otros gastos no identificados' : (e.categoria || 'Sin categoría');
        gastosDetallePorCategoria[catVisible] = (gastosDetallePorCategoria[catVisible] || 0) + monto;
      }

      detalleEgresos.push({
        id: e.id, numero: e.numero, concepto: e.concepto,
        categoria: e.categoria, monto, fecha: e._fechaRef.toISOString(),
        tipoERI: cls.tipoERI
      });
    });

    // ── Calcular utilidad por línea ─────────────────────────────────────────
    Object.values(porLinea).forEach(l => {
      l.utilidadBruta = l.ingresoServicio - l.costoServicio;
      l.margenPct = l.ingresoServicio > 0 ? (l.utilidadBruta / l.ingresoServicio) * 100 : 0;
    });

    // ══════════════════════════════════════════════════════════════════════
    // ✅ ERI-PRESTACIONES-001 — Provisiones de prestaciones sociales
    // ──────────────────────────────────────────────────────────────────────
    // ESTO ES LO QUE FALTABA EN EL INFORME DE JULIO 2026.
    //
    // Las cesantías, los intereses, la prima y las vacaciones se CAUSAN mes a
    // mes aunque se paguen después. Bajo principio de devengo, el gasto se
    // reconoce cuando el empleado trabaja, no cuando sale la plata.
    //
    // Sin esto, la nómina del ERI mostraba solo lo que salió de caja y
    // subestimaba el costo real del personal en un 21,83% del salario base
    // — entre $2,5 y $2,8 millones mensuales en el caso auditado.
    //
    // Las provisiones NO son egresos: viven en su propia colección y se suman
    // acá como gasto de personal, con su contrapartida en el pasivo.
    // ══════════════════════════════════════════════════════════════════════
    let provisionesPrestaciones = 0;
    let aportesPatronalesCausados = 0;   // ✅ FASE 3, apagada por defecto
    const anexoProvisiones = [];
    try {
      const provSnap = await db.collection('provisiones_prestaciones')
        .where('userId', '==', adminId).get();

      provSnap.docs.forEach(d => {
        const p = d.data();
        if (p.revertida === true) return;
        // El período de la provisión es año-mes; se compara contra el rango
        const periodo = p.periodo || `${p.anio}-${String(p.mes).padStart(2, '0')}`;
        const primerDia = `${periodo}-01`;
        const ultimoDia = `${periodo}-31`;
        if (desde && ultimoDia < desde) return;
        if (hasta && primerDia > hasta) return;

        const valor = Number(p.totalPrestaciones) || 0;
        provisionesPrestaciones += valor;
        // ✅ FASE 3 (apagada por defecto): los aportes patronales solo se causan
        // si la provisión se generó con `causaSeguridadSocial: true`. Mientras
        // esté apagado, entran al gasto vía el egreso de la planilla PILA —
        // que es como venía funcionando. Causarlos acá sin apagar el otro
        // camino contaría el mismo aporte dos veces.
        if (p.causaSeguridadSocial === true) {
          aportesPatronalesCausados += Number(p.totalSeguridadSocial) || 0;
        }
        anexoProvisiones.push({
          periodo,
          empleado: p.empleadoNombre || '',
          documento: p.empleadoDocumento || '',
          diasTrabajados: p.diasTrabajados || 30,
          cesantias: Number(p.prestaciones?.cesantias?.valor) || 0,
          intereses: Number(p.prestaciones?.interesesCesantias?.valor) || 0,
          prima: Number(p.prestaciones?.prima?.valor) || 0,
          vacaciones: Number(p.prestaciones?.vacaciones?.valor) || 0,
          total: valor
        });
      });

      // Suma al gasto de personal: es gasto del período, aunque no mueva caja
      gastosPorTipo.gasto_personal += provisionesPrestaciones;
      if (provisionesPrestaciones > 0) {
        gastosDetallePorCategoria['Provisión de prestaciones sociales'] =
          (gastosDetallePorCategoria['Provisión de prestaciones sociales'] || 0) + provisionesPrestaciones;
      }
      // ✅ FASE 3: solo entra si el suscriptor encendió la causación de aportes.
      if (aportesPatronalesCausados > 0) {
        gastosPorTipo.gasto_personal += aportesPatronalesCausados;
        gastosDetallePorCategoria['Aportes patronales causados'] =
          (gastosDetallePorCategoria['Aportes patronales causados'] || 0) + aportesPatronalesCausados;
      }
    } catch (e) {
      // Si la colección no existe todavía, el ERI sigue funcionando sin ellas
      console.error('ERI provisiones:', e.message);
    }

    // ══════════════════════════════════════════════════════════════════════
    // ✅ NOMINA-LIQUIDACION-001 · GASTO NUEVO POR LIQUIDACIÓN DE CONTRATO
    // ──────────────────────────────────────────────────────────────────────
    // Una liquidación tiene dos naturalezas y hay que separarlas:
    //
    //   · Prestaciones ya causadas → NO son gasto acá. Se descargan del
    //     pasivo; el gasto se reconoció mes a mes.
    //   · Indemnización, salario pendiente y el defecto de provisión → SÍ son
    //     gasto del período. La indemnización nunca se provisiona (no se sabe
    //     si va a ocurrir) y no constituye salario.
    //
    // Por eso la CxP de la liquidación queda marcada `esPagoPasivoLaboral` y
    // sale del P&G, mientras que este bloque causa únicamente lo nuevo.
    // ══════════════════════════════════════════════════════════════════════
    let gastoLiquidaciones = 0;
    let indemnizacionesPeriodo = 0;
    const anexoLiquidaciones = [];
    try {
      const liqSnap = await db.collection('liquidaciones_contrato')
        .where('userId', '==', adminId).get();

      liqSnap.docs.forEach(d => {
        const l = d.data();
        if (l.anulada === true) return;
        const fecha = String(l.fechaRetiro || '').slice(0, 10);
        if (!fecha) return;
        if (desde && fecha < desde) return;
        if (hasta && fecha > hasta) return;

        const valor = Number(l.gastoNuevoTotal) || 0;
        gastoLiquidaciones += valor;
        indemnizacionesPeriodo += Number(l.valorIndemnizacion) || 0;
        anexoLiquidaciones.push({
          fecha,
          numero: l.numero || '',
          empleado: l.empleadoNombre || '',
          motivo: l.motivoEtiqueta || '',
          prestaciones: Number(l.totalPrestaciones) || 0,
          descargadoDelPasivo: Number(l.descargadoDelPasivo) || 0,
          indemnizacion: Number(l.valorIndemnizacion) || 0,
          salarioPendiente: Number(l.salarioPendiente) || 0,
          defectoProvision: Number(l.defectoProvision) || 0,
          gastoNuevo: valor,
          netoAPagar: Number(l.netoAPagar) || 0
        });
      });

      if (gastoLiquidaciones > 0) {
        gastosPorTipo.gasto_personal += gastoLiquidaciones;
        gastosDetallePorCategoria['Liquidaciones e indemnizaciones'] =
          (gastosDetallePorCategoria['Liquidaciones e indemnizaciones'] || 0) + gastoLiquidaciones;
      }
    } catch (e) {
      // Colección aún inexistente: el ERI sigue funcionando
      console.error('ERI liquidaciones:', e.message);
    }

    // ── Totales ─────────────────────────────────────────────────────────────
    const totalIngresos = totalServicios + totalProductos;
    const utilidadBrutaServicios = totalServicios - totalCostoServicios;
    const utilidadBrutaProductos = totalProductos - totalCostoProductos;
    const utilidadBrutaTotal = utilidadBrutaServicios + utilidadBrutaProductos;

    const totalGastos =
      gastosPorTipo.gasto_personal +
      gastosPorTipo.gasto_operativo +
      gastosPorTipo.gasto_fijo +
      gastosPorTipo.gasto_administrativo +
      gastosPorTipo.gasto_financiero +
      gastosPorTipo.gasto_fiscal;

    const utilidadOperativa = utilidadBrutaTotal
      - gastosPorTipo.gasto_personal
      - gastosPorTipo.gasto_operativo
      - gastosPorTipo.gasto_fijo
      - gastosPorTipo.gasto_administrativo;

    const utilidadNetaAntesImpuestos = utilidadOperativa - gastosPorTipo.gasto_financiero;
    const utilidadNeta = utilidadNetaAntesImpuestos - gastosPorTipo.gasto_fiscal;

    const margenBruto = totalIngresos > 0 ? (utilidadBrutaTotal / totalIngresos) * 100 : 0;
    const margenOperativo = totalIngresos > 0 ? (utilidadOperativa / totalIngresos) * 100 : 0;
    const margenNeto = totalIngresos > 0 ? (utilidadNeta / totalIngresos) * 100 : 0;

    // ── Estructura de respuesta ─────────────────────────────────────────────
    const respuesta = {
      meta: {
        desde: desdeStr,
        hasta: hastaStr,
        empresaId: empresaId || 'consolidado',
        empresaNombre: empresaId ? (empresas[empresaId]?.name || '—') : 'Consolidado (todas las empresas)',
        nit: empresaId ? (empresas[empresaId]?.nit || empresas[empresaId]?.NIT || '') : '', // ✅ ERI-PDF-001: membrete
        cantidadOrdenes: ordenesEnRango.length,
        cantidadEgresos: egresosEnRango.length,
        calculadoEn: new Date().toISOString()
      },
      ingresos: {
        servicios: totalServicios,
        productos: totalProductos,
        total: totalIngresos,
        porEmpresa: Object.entries(ingresosPorEmpresa).map(([id, monto]) => ({
          empresaId: id,
          empresaNombre: empresas[id]?.name || (id === 'sin_empresa' ? 'Sin empresa' : '—'),
          monto,
          cantidadOrdenes: cantidadOrdenes[id] || 0,
          porcentaje: totalIngresos > 0 ? (monto / totalIngresos) * 100 : 0
        }))
      },
      costoVentas: {
        servicios: totalCostoServicios,
        productos: totalCostoProductos,
        total: totalCostoServicios + totalCostoProductos
      },
      utilidadBruta: {
        servicios: utilidadBrutaServicios,
        productos: utilidadBrutaProductos,
        total: utilidadBrutaTotal,
        margen: margenBruto
      },
      porLinea: Object.values(porLinea).filter(l =>
        l.ingresoServicio > 0 || l.costoServicio > 0
      ),
      gastos: {
        personal: gastosPorTipo.gasto_personal,
        operativos: gastosPorTipo.gasto_operativo,
        fijos: gastosPorTipo.gasto_fijo,
        administrativos: gastosPorTipo.gasto_administrativo,
        financieros: gastosPorTipo.gasto_financiero,
        fiscales: gastosPorTipo.gasto_fiscal,
        total: totalGastos,
        detallePorCategoria: Object.entries(gastosDetallePorCategoria)
          .map(([categoria, monto]) => ({ categoria, monto }))
          .sort((a, b) => b.monto - a.monto)
      },
      utilidadOperativa: { valor: utilidadOperativa, margen: margenOperativo },
      utilidadAntesImpuestos: { valor: utilidadNetaAntesImpuestos },
      utilidadNeta: { valor: utilidadNeta, margen: margenNeto }
    };

    // Solo en vista 'completa' enviamos detalle (es pesado)
    if (vista === 'completa' || vista === 'detalle') {
      respuesta.detalleOrdenes = detalleOrdenes;
      respuesta.detalleEgresos = detalleEgresos;
    }

    // ✅ ERI-COSTO-001: INVENTARIO (informativo) — desde el módulo de productos.
    // Al costo = Σ(stock × precioCosto). Valorizado = Σ(stock × precioVenta).
    // Es un activo, no afecta la utilidad; solo para que el dinero no se pierda.
    let inventarioAlCosto = 0;
    let inventarioValorizado = 0;
    const anexoCostos = []; // productos por categoría con su costo (anexo)
    Object.values(productos).forEach(p => {
      const stock = Number(p.stock) || 0;
      const costo = Number(p.precioCosto) || 0;
      const venta = Number(p.precioVenta) || 0;
      if (stock > 0) {
        inventarioAlCosto += stock * costo;
        inventarioValorizado += stock * venta;
      }
    });

    // Costo de ventas por categoría (anexo): lo que se vendió, agrupado
    Object.entries(costoPorCategoria).forEach(([categoria, costo]) => {
      anexoCostos.push({ categoria, costo, ingreso: ingresoPorCategoria[categoria] || 0 });
    });
    // El orden y las filas de diferencia se aplican MÁS ABAJO, después de
    // ajustar el desglose contra los totales (ver FIX ERI-CUADRE-001). Si se
    // ordenara acá, el anexo quedaría desalineado con el cuerpo del informe.

    // ✅ ERI-COSTO-001: INFORME P&G — ingresos y costos por CATEGORÍA de producto,
    // gastos por categoría de egreso. Regla: los valores en $0 se filtran (un
    // punto de venta sin servicios no ve "Costo recarga: $0").
    const noCero = (obj) => Object.entries(obj)
      .filter(([, v]) => Math.round(v) !== 0)
      .map(([nombre, valor]) => ({ nombre, valor }))
      .sort((a, b) => b.valor - a.valor);

    // ══════════════════════════════════════════════════════════════════════
    // ✅ FIX ERI-CUADRE-001 — UNA SOLA FUENTE DE VERDAD
    // ──────────────────────────────────────────────────────────────────────
    // EL BUG QUE ESTO CORRIGE
    // El informe calculaba la utilidad por su cuenta, sumando las categorías
    // de producto, mientras las tarjetas KPI la calculaban por otro camino
    // (costo de servicios + costo de productos). Los dos números salían
    // distintos y el usuario veía dos utilidades netas diferentes en la misma
    // pantalla: -$3.181.607 arriba y -$1.968.303 abajo.
    //
    // La diferencia eran $1.213.304 de costo de servicios que la agrupación
    // por categoría de producto no alcanzaba a capturar.
    //
    // LA REGLA AHORA
    // Los totales SIEMPRE vienen del cálculo principal. El desglose por
    // categoría es eso: un DESGLOSE, no un cálculo paralelo. Si el desglose no
    // suma el total, se agrega una fila explícita con la diferencia en vez de
    // mostrar en silencio un número distinto.
    // ══════════════════════════════════════════════════════════════════════
    const totalIngresosInforme = totalIngresos;
    const totalCostoInforme = totalCostoServicios + totalCostoProductos;
    const utilidadBrutaInforme = utilidadBrutaTotal;

    // Cuánto del total NO quedó explicado por el desglose de categorías
    const sumaCategoriasIngreso = Object.values(ingresoPorCategoria).reduce((s, v) => s + v, 0);
    const sumaCategoriasCosto = Object.values(costoPorCategoria).reduce((s, v) => s + v, 0);
    const difIngreso = Math.round(totalIngresosInforme - sumaCategoriasIngreso);
    const difCosto = Math.round(totalCostoInforme - sumaCategoriasCosto);

    // Si sobra o falta, se muestra. Nunca se esconde.
    if (Math.abs(difIngreso) > 1) {
      ingresoPorCategoria['(Sin desglosar por categoría)'] =
        (ingresoPorCategoria['(Sin desglosar por categoría)'] || 0) + difIngreso;
    }
    // ══════════════════════════════════════════════════════════════════════
    // ✅ FIX ERI-COSTOSERVICIO-001 — Los insumos se muestran POR LÍNEA
    // ──────────────────────────────────────────────────────────────────────
    // EL PROBLEMA
    // El costo de ventas mostraba, por ejemplo:
    //     RECARGAS Y MANTENIMIENTO                          $31.500
    //     (Costos de servicio sin categoría de producto)   $768.400
    //
    // Y esos $31.500 son solo el costo de los PRODUCTOS de esa categoría. El
    // costo real de prestar el servicio de recarga —polvo químico, nitrógeno,
    // válvulas, sellos— estaba dentro del bulto anónimo de $768.400.
    //
    // Leído así, parecía que una recarga cuesta $31.500 hacerla, que no tiene
    // nada que ver con la realidad, y era imposible cuadrarlo contra la vista
    // por línea de servicio.
    //
    // LA CORRECCIÓN
    // Los insumos SÍ saben a qué línea pertenecen: la categoría del egreso
    // trae su `lineaServicioId`. En vez de agruparlos en un bulto sin nombre,
    // se muestran con el nombre de su línea. El total no cambia — cambia que
    // ahora se puede leer.
    // ══════════════════════════════════════════════════════════════════════
    if (Math.abs(difCosto) > 1) {
      const lineasConInsumos = Object.values(porLinea)
        .filter(l => (l.costoInsumos || 0) > 0)
        .sort((a, b) => b.costoInsumos - a.costoInsumos);

      let repartido = 0;
      for (const l of lineasConInsumos) {
        const etiqueta = l.id === '_sin_clasificar'
          ? 'Insumos de servicio · sin línea asignada'
          : `Insumos de servicio · ${l.nombre}`;
        costoPorCategoria[etiqueta] = (costoPorCategoria[etiqueta] || 0) + l.costoInsumos;
        anexoCostos.push({ categoria: etiqueta, costo: l.costoInsumos, ingreso: 0 });
        repartido += l.costoInsumos;
      }

      // Si quedara un residuo sin línea (no debería, pero el informe nunca
      // debe esconder plata), se muestra explícitamente.
      const residuo = Math.round(difCosto - repartido);
      if (Math.abs(residuo) > 1) {
        costoPorCategoria['(Costos de servicio sin clasificar)'] =
          (costoPorCategoria['(Costos de servicio sin clasificar)'] || 0) + residuo;
        anexoCostos.push({ categoria: '(Costos de servicio sin clasificar)', costo: residuo, ingreso: 0 });
      }
    }
    if (Math.abs(difIngreso) > 1) {
      anexoCostos.push({
        categoria: '(Ingresos sin desglosar por categoría)',
        costo: 0,
        ingreso: difIngreso
      });
    }
    anexoCostos.sort((a, b) => b.costo - a.costo);

    // ── ✅ ERI-CARTERA-001: cartera informativa (NO afecta el resultado) ──────
    // Bajo causación, el ingreso ya se reconoció al prestar el servicio. La
    // cartera (CxC) es el dinero pendiente de cobrar de ese ingreso ya
    // reconocido — se muestra aparte para control, no vuelve a sumar. La CxP
    // es lo pendiente de pagar a proveedores.
    let carteraCxC = 0;
    const anexoCxC = [];
    ordenesEnRango.forEach(o => {
      // Una orden es cartera si está a crédito y no pagada
      const esCredito = o.estado === 'cxc' || (o.pagado !== true &&
        ['A crédito (CxC)', 'A crédito', 'CXC'].includes(o.formaPago));
      const saldo = Number(o.saldoPendiente ?? (o.pagado ? 0 : o.total)) || 0;
      if (esCredito && saldo > 0) {
        carteraCxC += saldo;
        anexoCxC.push({
          numeroOrden: o.numeroOrden,
          fecha: o._fechaRef.toISOString().slice(0, 10),
          clienteNombre: o.clienteNombre || '',
          saldo
        });
      }
    });

    // ✅ ERI-CXP-FIX2: replicar EXACTAMENTE la lógica del módulo CxP real.
    // Un egreso es cuenta por pagar si estado === 'PENDIENTE'. NO se exige que
    // tenga proveedor (si no lo tiene, va como "Sin proveedor" — así aparece la
    // retención de GOICOCHEA que antes se perdía). Se excluyen provisionales no
    // cuadrados. El saldo = (totalPagar||monto) − montoPagado.
    let carteraCxP = 0;
    const anexoCxP = [];
    try {
      const cxpSnap = await db.collection('egresos')
        .where('userId', '==', adminId)
        .where('estado', '==', 'PENDIENTE').get();
      cxpSnap.docs.forEach(d => {
        const e = d.data();
        if (e.esProvisional && !e.cuadrado) return;
        if (e.anulado === true) return;
        const saldo = (Number(e.totalPagar || e.monto) || 0) - (Number(e.montoPagado) || 0);
        if (saldo > 0) {
          carteraCxP += saldo;
          anexoCxP.push({
            proveedor: e.proveedor || 'Sin proveedor',
            fecha: (e.fecha || (e.createdAt && e.createdAt.toDate ? e.createdAt.toDate().toISOString() : '') || '').slice(0, 10),
            concepto: e.concepto || e.numeroFactura || '',
            saldo
          });
        }
      });
    } catch (eCxp) { /* si falla la lectura, cartera CxP queda en 0 (no rompe el ERI) */ }

    respuesta.informe = {
      periodo: respuesta.periodo || { desde: desde || null, hasta: hasta || null },
      ingresos: {
        porCategoria: noCero(ingresoPorCategoria),
        total: totalIngresosInforme
      },
      costoVentas: {
        porCategoria: noCero(costoPorCategoria),
        total: totalCostoInforme
      },
      utilidadBruta: utilidadBrutaInforme,
      gastos: {
        // por categoría real de egreso, sin ceros
        porCategoria: Object.entries(gastosDetallePorCategoria)
          .filter(([, v]) => Math.round(v) !== 0)
          .map(([nombre, valor]) => ({ nombre, valor }))
          .sort((a, b) => b.valor - a.valor),
        total: totalGastos
      },
      // ✅ FIX ERI-CUADRE-001: la utilidad neta del cuerpo es LA MISMA que la
      // de las tarjetas. Antes se recalculaba acá y daba distinto.
      utilidadNeta,
      utilidadOperativa,
      // Validación de cuadre: si algún día vuelven a divergir, el informe lo
      // dice en vez de mostrar dos números y dejar que el usuario lo descubra.
      cuadre: (() => {
        const porCadena = Math.round(utilidadBrutaTotal - totalGastos);
        const ok = Math.abs(porCadena - Math.round(utilidadNeta)) <= 1;
        return {
          ok,
          utilidadPorCadena: porCadena,
          utilidadReportada: Math.round(utilidadNeta),
          diferencia: porCadena - Math.round(utilidadNeta),
          desgloseIngresoCuadra: Math.abs(difIngreso) <= 1,
          desgloseCostoCuadra: Math.abs(difCosto) <= 1,
          mensaje: ok
            ? 'Las cifras del informe cuadran con el detalle.'
            : 'ATENCIÓN: la utilidad calculada por la cadena no coincide con la reportada. Revisá el detalle antes de usar este informe.'
        };
      })(),
      // ✅ Sección inventario (informativa, NO afecta utilidad)
      inventario: {
        comprasDelPeriodo: totalComprasInventario,
        alCosto: Math.round(inventarioAlCosto),
        valorizado: Math.round(inventarioValorizado),
        // ✅ ERI-CARTERA-001: utilidad potencial en stock (valorizado − costo)
        potencial: Math.round(inventarioValorizado - inventarioAlCosto)
      },
      // ✅ ERI-CARTERA-001: cartera informativa — NO afecta el resultado (el
      // ingreso ya se reconoció por causación). Solo control de cobro/pago.
      cartera: {
        cxc: { total: Math.round(carteraCxC), detalle: anexoCxC.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')) },
        cxp: { total: Math.round(carteraCxP), detalle: anexoCxP.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')) }
      },
      // Anexos (soporte del informe)
      anexos: {
        // ✅ ERI-PDF-001: ordenar por N° de orden (no por fecha) para que la
        // supervisión sea más fácil — se lee secuencial OS-0001, OS-0002...
        ventas: anexoVentas.sort((a, b) => String(a.numeroOrden || '').localeCompare(String(b.numeroOrden || ''), undefined, { numeric: true })),
        costos: anexoCostos,
        gastos: Object.entries(gastosDetallePorCategoria)
          .map(([categoria, monto]) => ({ categoria, monto }))
          .sort((a, b) => b.monto - a.monto),
        compras: anexoCompras.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')),
        // ✅ ERI-CARTERA-001: anexos de cartera
        cxc: anexoCxC.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')),
        cxp: anexoCxP.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')),
        // ✅ ERI-ANEXO-EGRESOS-001: egresos detallados CON número de comprobante,
        // para poder auditar cuáles están y cuáles faltan (antes el anexo de
        // gastos solo agrupaba por categoría, sin el N° EGR-XXXX).
        egresos: detalleEgresos
          .map(e => ({
            numero: e.numero || '—',
            fecha: (e.fecha || '').slice(0, 10),
            categoria: e.categoria || '',
            concepto: e.concepto || '',
            monto: e.monto,
            tipoERI: e.tipoERI || ''
          }))
          .sort((a, b) => String(a.numero || '').localeCompare(String(b.numero || ''), undefined, { numeric: true })),
        // ✅ ERI-TRAZABILIDAD-001: qué ventas generaron el ingreso y el costo
        // de cada categoría. Es lo que permite responder "¿de qué son estos
        // $37.100?" sin salir del sistema.
        detalleCategorias: Object.entries(detallePorCategoria)
          .map(([categoria, items]) => ({
            categoria,
            items: items.sort((a, b) => b.costo - a.costo),
            totalIngreso: items.reduce((a, i) => a + i.ingreso, 0),
            totalCosto: items.reduce((a, i) => a + i.costo, 0),
            cantidadItems: items.length
          }))
          .sort((a, b) => b.totalCosto - a.totalCosto),
        // ✅ ERI-PRESTACIONES-001: soporte de la provisión causada
        provisiones: anexoProvisiones.sort((a, b) =>
          String(a.periodo).localeCompare(String(b.periodo)) ||
          String(a.empleado).localeCompare(String(b.empleado))),
        // ✅ NOMINA-PASIVO-001: pagos que descargaron el pasivo. Van de anexo
        // porque no son gasto, pero el dinero salió y tiene que verse.
        pagosPasivoLaboral: anexoPagosPasivo.sort((a, b) =>
          String(a.fecha).localeCompare(String(b.fecha))),
        // ✅ NOMINA-LIQUIDACION-001: liquidaciones del período
        liquidaciones: anexoLiquidaciones.sort((a, b) =>
          String(a.fecha).localeCompare(String(b.fecha)))
      },
      // ✅ ERI-PRESTACIONES-001: se expone aparte para que el análisis
      // financiero pueda usarlo como pasivo corriente sin recalcularlo.
      prestaciones: {
        causadasEnPeriodo: Math.round(provisionesPrestaciones),
        empleadosConProvision: new Set(anexoProvisiones.map(p => p.documento)).size,
        // ✅ NOMINA-PASIVO-001 / NOMINA-LIQUIDACION-001
        pagadasEnPeriodo: Math.round(totalPagosPasivoLaboral),
        // ✅ FASE 3: 0 mientras el interruptor esté apagado (los aportes entran
        // por el egreso de la PILA, como siempre).
        aportesPatronalesCausados: Math.round(aportesPatronalesCausados),
        gastoPorLiquidaciones: Math.round(gastoLiquidaciones),
        indemnizacionesDelPeriodo: Math.round(indemnizacionesPeriodo),
        notaPagos: totalPagosPasivoLaboral > 0
          ? 'Los pagos de prestaciones NO restan en este informe: descargan el pasivo que ya se causó mes a mes. Contarlos acá sería duplicar el gasto.'
          : null,
        notaLiquidaciones: gastoLiquidaciones > 0
          ? 'De las liquidaciones solo entra al gasto lo que NO estaba provisionado: indemnización, salario pendiente y el defecto de provisión.'
          : null,
        nota: provisionesPrestaciones > 0
          ? 'Gasto causado del período. No mueve caja: se acumula como obligación con los empleados.'
          : 'No hay provisiones causadas en este período. Causalas en Empleados → Provisiones para que el informe refleje el costo real de la nómina.'
      }
    };

    res.json(respuesta);
  } catch (e) {
    console.error('GET /eri:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Helper: match categoría de producto con línea de servicio ───────────────
// La idea: si la categoría del producto contiene el nombre de la línea (parcial,
// case-insensitive), entonces ese producto pertenece a esa línea.
// Ej: producto categoría "Recarga" → matchea con línea "Recargas y Mantenimiento".
//     producto categoría "Mantenimiento" → matchea con línea "Recargas y Mantenimiento".
//     producto categoría "Señalización" → matchea con línea "Señalización".
// Para casos exóticos (vertical de otro suscriptor), Sandra puede crear una línea
// "Mantenimiento" si quiere separar mantenimiento de recargas. El match seguirá
// funcionando por substring.
function matchCategoriaConLinea(categoria, lineas) {
  if (!categoria) return null;
  const catLower = categoria.toLowerCase().trim();
  // Match exacto primero
  for (const l of lineas) {
    const lNombre = (l.nombre || '').toLowerCase();
    if (catLower === lNombre) return l.id;
  }
  // Match parcial: ¿la categoría está contenida en el nombre de la línea?
  for (const l of lineas) {
    const lNombre = (l.nombre || '').toLowerCase();
    if (lNombre.includes(catLower) || catLower.includes(lNombre.split(' ')[0])) return l.id;
  }
  // Reglas conocidas para tu vertical
  if (/recarga|mantenimiento|hidrostat/.test(catLower)) {
    const l = lineas.find(x => /recarga|mantenimient/i.test(x.nombre));
    if (l) return l.id;
  }
  if (/señaliz|demarc|señal/.test(catLower)) {
    const l = lineas.find(x => /señaliz/i.test(x.nombre));
    if (l) return l.id;
  }
  return null;
}

module.exports = router;
