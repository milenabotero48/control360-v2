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
      const fechaRef = parseFecha(e.fechaPago || e.fecha || e.createdAt);
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
        utilidadBruta: 0,
        margenPct: 0
      };
    });
    // Línea "sin clasificar" para servicios cuya categoría no mapea
    porLinea['_sin_clasificar'] = {
      id: '_sin_clasificar', nombre: 'Sin clasificar',
      color: '#9ca3af',
      ingresoServicio: 0, costoServicio: 0,
      utilidadBruta: 0, margenPct: 0
    };

    // Acumuladores principales
    let totalServicios = 0;
    let totalCostoServicios = 0;
    let totalProductos = 0;
    let totalCostoProductos = 0;
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

        if (cls.esServicio) {
          ingresoServiciosOrden += subtotal;
          totalServicios += subtotal;
          // Asignar a línea correspondiente
          const lineaId = cls.lineaId || '_sin_clasificar';
          if (!porLinea[lineaId]) {
            porLinea[lineaId] = { id: lineaId, nombre: 'Sin clasificar', color: '#9ca3af', ingresoServicio: 0, costoServicio: 0, utilidadBruta: 0, margenPct: 0 };
          }
          porLinea[lineaId].ingresoServicio += subtotal;
          // ✅ ERI-COSTO-002: si el SERVICIO tiene precioCosto definido (raro,
          // pero posible), también suma a su costo de línea. El costo principal
          // de un servicio fabricado viene de los insumos (egresos costo_servicio).
          if (cls.precioCosto > 0) {
            porLinea[lineaId].costoServicio += cls.precioCosto * cantidad;
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
              porLinea[lineaIdProd] = { id: lineaIdProd, nombre: 'Sin clasificar', color: '#9ca3af', ingresoServicio: 0, costoServicio: 0, utilidadBruta: 0, margenPct: 0 };
            }
            porLinea[lineaIdProd].ingresoServicio += subtotal;
            porLinea[lineaIdProd].costoServicio += costo;
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

    egresosEnRango.forEach(e => {
      const cls = mapaCategoria[e.categoria] || { tipoERI: 'gasto_operativo', lineaServicioId: null };
      const monto = Number(e.monto) || 0;

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
          porLinea[lineaId] = { id: lineaId, nombre: 'Sin clasificar', color: '#9ca3af', ingresoServicio: 0, costoServicio: 0, utilidadBruta: 0, margenPct: 0 };
        }
        porLinea[lineaId].costoServicio += monto;
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
    anexoCostos.sort((a, b) => b.costo - a.costo);

    // ✅ ERI-COSTO-001: INFORME P&G — ingresos y costos por CATEGORÍA de producto,
    // gastos por categoría de egreso. Regla: los valores en $0 se filtran (un
    // punto de venta sin servicios no ve "Costo recarga: $0").
    const noCero = (obj) => Object.entries(obj)
      .filter(([, v]) => Math.round(v) !== 0)
      .map(([nombre, valor]) => ({ nombre, valor }))
      .sort((a, b) => b.valor - a.valor);

    const totalIngresosInforme = Object.values(ingresoPorCategoria).reduce((s, v) => s + v, 0);
    const totalCostoInforme = Object.values(costoPorCategoria).reduce((s, v) => s + v, 0);
    const utilidadBrutaInforme = totalIngresosInforme - totalCostoInforme;

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
      utilidadNeta: utilidadBrutaInforme - totalGastos,
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
          .sort((a, b) => String(a.numero || '').localeCompare(String(b.numero || ''), undefined, { numeric: true }))
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
