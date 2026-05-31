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

    // ── 4. Cargar ÓRDENES en rango (filtrar por completadas/pagadas) ───────
    // Las órdenes se guardan con campo `adminId` (no `userId`). Las que cuentan
    // como ingreso son las pagadas o completadas. Usamos fechaPago si existe;
    // si no, createdAt como fallback.
    let ordenesQuery = db.collection('orders').where('adminId', '==', adminId);
    if (empresaId) ordenesQuery = ordenesQuery.where('empresaId', '==', empresaId);
    const ordenesSnap = await ordenesQuery.get();

    const ordenesEnRango = [];
    ordenesSnap.docs.forEach(d => {
      const o = d.data();
      // Solo cuentan órdenes pagadas o completadas
      if (!o.pagado && o.estado !== 'completada' && o.estado !== 'cuadre_dinero') return;
      // Excluir órdenes anuladas
      if (o.anulada === true || o.estado === 'anulada') return;
      // Excluir órdenes internas / producción (no son ingreso comercial)
      if (o.tipoOrden === 'interna' || o.tipoOrden === 'produccion') return;
      const fechaRef = parseFecha(o.fechaPago || o.fechaFactura || o.createdAt);
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

        if (cls.esServicio) {
          ingresoServiciosOrden += subtotal;
          totalServicios += subtotal;
          // Asignar a línea correspondiente
          const lineaId = cls.lineaId || '_sin_clasificar';
          if (!porLinea[lineaId]) {
            porLinea[lineaId] = { id: lineaId, nombre: 'Sin clasificar', color: '#9ca3af', ingresoServicio: 0, costoServicio: 0, utilidadBruta: 0, margenPct: 0 };
          }
          porLinea[lineaId].ingresoServicio += subtotal;
        } else {
          ingresoProductosOrden += subtotal;
          totalProductos += subtotal;
          const costo = cls.precioCosto * cantidad;
          costoProductosOrden += costo;
          totalCostoProductos += costo;
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
    });

    // ── Procesar egresos ────────────────────────────────────────────────────
    const gastosPorTipo = {
      gasto_personal: 0, gasto_operativo: 0, gasto_fijo: 0,
      gasto_administrativo: 0, gasto_financiero: 0, gasto_fiscal: 0
    };
    const gastosDetallePorCategoria = {}; // 'Nómina' → 1500000

    egresosEnRango.forEach(e => {
      const cls = mapaCategoria[e.categoria] || { tipoERI: 'gasto_operativo', lineaServicioId: null };
      const monto = Number(e.monto) || 0;

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
        const tipo = cls.tipoERI || 'gasto_operativo';
        if (gastosPorTipo[tipo] !== undefined) {
          gastosPorTipo[tipo] += monto;
        } else {
          gastosPorTipo.gasto_operativo += monto;
        }
        gastosDetallePorCategoria[e.categoria] = (gastosDetallePorCategoria[e.categoria] || 0) + monto;
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
