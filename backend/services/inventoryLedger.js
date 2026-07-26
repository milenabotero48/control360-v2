// ============================================================================
// Control360 — Motor de Kardex / Ledger de Inventario
// Ubicación: backend/services/inventoryLedger.js
// FIX INV-KARDEX-001
// ----------------------------------------------------------------------------
// PROBLEMA QUE RESUELVE
// El campo products.stock era un número mutable que se incrementaba o
// decrementaba desde 6 puntos distintos del sistema (orders x3, compras x2,
// egresos x1, products PUT) sin dejar NINGÚN registro del movimiento. No había
// forma de saber quién movió qué, cuándo, ni por qué. Un conteo físico que no
// cuadraba con el sistema era un callejón sin salida.
//
// SOLUCIÓN
// Toda variación de stock pasa por registrarMovimiento(), que escribe el
// movimiento en `inventory_movements` Y actualiza products.stock dentro de la
// MISMA transacción atómica de Firestore. El ledger no puede desincronizarse
// del saldo: o entran los dos, o no entra ninguno.
//
// products.stock pasa a ser un SALDO CACHEADO. La verdad es el ledger.
// Mismo principio que ya usa el módulo de Caja con los movimientos de dinero.
//
// INVARIANTES RESPETADOS
// 1. Multi-tenant: todo movimiento lleva adminId. El tenant se resuelve SIEMPRE
//    desde el documento del producto (adminId || creadoPor — los productos
//    antiguos solo tienen creadoPor). Nunca se recibe adminId por parámetro
//    del cliente.
// 2. Los productos tipo 'servicio' o con tieneStock === false NO generan
//    movimiento. Devuelven null sin error.
// 3. NUNCA bloquea la operación de negocio. Si el producto no existe o la
//    lectura falla, se registra la incidencia y se devuelve null — igual que
//    el comportamiento actual de orders.js (console.warn + continuar). Una
//    venta jamás se cae por un problema del kardex.
// 4. El stock puede quedar negativo. No se bloquea: se marca el movimiento con
//    stockNegativo=true para que la anomalía sea VISIBLE en lugar de silenciosa.
// 5. La reconstrucción histórica NO modifica products.stock. El stock actual es
//    el punto de anclaje; el ledger se construye para explicarlo.
//
// COLECCIÓN: inventory_movements
//   adminId, productoId, productoNombre, productoCodigo, categoria
//   tipo, cantidad (con signo), stockAntes, stockDespues, stockNegativo
//   origenTipo, origenId, origenNumero
//   clienteId, clienteNombre, proveedorNombre
//   usuarioId, usuarioNombre, motivo
//   costoUnitario, valorMovimiento
//   fecha (ISO string), timestamp (serverTimestamp), reconstruido (bool)
//
// ÍNDICES COMPUESTOS REQUERIDOS EN FIRESTORE
//   (adminId ASC, productoId ASC, fecha DESC)
//   (adminId ASC, fecha DESC)
//   (adminId ASC, tipo ASC, fecha DESC)
// ============================================================================

const { db, admin } = require('../config/firebase');

// ─── TIPOS DE MOVIMIENTO ────────────────────────────────────────────────────
// El signo NO se recibe por parámetro: lo determina el tipo. Así es imposible
// que un llamador equivocado sume donde debía restar.
const TIPOS = Object.freeze({
  ENTRADA_COMPRA:              'ENTRADA_COMPRA',
  ENTRADA_DEVOLUCION_CLIENTE:  'ENTRADA_DEVOLUCION_CLIENTE',
  DEVOLUCION_ANULACION:        'DEVOLUCION_ANULACION',
  ENTRADA_AJUSTE:              'ENTRADA_AJUSTE',
  ENTRADA_IMPORTACION:         'ENTRADA_IMPORTACION',
  SALIDA_VENTA:                'SALIDA_VENTA',
  SALIDA_TALLER:               'SALIDA_TALLER',
  CONSUMO_COMPUESTO:           'CONSUMO_COMPUESTO',
  // ✅ INV-KARDEX-002: las órdenes de producción NO descuentan al crearse, pero
  // SÍ mueven inventario al completarse: consumen componentes y dan de alta el
  // producto terminado. La v1 las ignoraba por completo — todo lo fabricado
  // internamente habría quedado fuera del kardex.
  CONSUMO_PRODUCCION:          'CONSUMO_PRODUCCION',
  ENTRADA_PRODUCCION:          'ENTRADA_PRODUCCION',
  SALIDA_AJUSTE:               'SALIDA_AJUSTE',
  SALIDA_DEVOLUCION_PROVEEDOR: 'SALIDA_DEVOLUCION_PROVEEDOR',
  AJUSTE_CONTEO:               'AJUSTE_CONTEO',
  AJUSTE_HISTORICO_NO_TRAZADO: 'AJUSTE_HISTORICO_NO_TRAZADO'
});

// +1 suma al stock, -1 resta, 0 = el signo lo define la cantidad recibida
// (solo para ajustes, que pueden ir en cualquier dirección).
const SIGNO = Object.freeze({
  [TIPOS.ENTRADA_COMPRA]:              1,
  [TIPOS.ENTRADA_DEVOLUCION_CLIENTE]:  1,
  [TIPOS.DEVOLUCION_ANULACION]:        1,
  [TIPOS.ENTRADA_AJUSTE]:              1,
  [TIPOS.ENTRADA_IMPORTACION]:         1,
  [TIPOS.SALIDA_VENTA]:               -1,
  [TIPOS.SALIDA_TALLER]:              -1,
  [TIPOS.CONSUMO_COMPUESTO]:          -1,
  [TIPOS.CONSUMO_PRODUCCION]:         -1,
  [TIPOS.ENTRADA_PRODUCCION]:          1,
  [TIPOS.SALIDA_AJUSTE]:              -1,
  [TIPOS.SALIDA_DEVOLUCION_PROVEEDOR]:-1,
  [TIPOS.AJUSTE_CONTEO]:               0,
  [TIPOS.AJUSTE_HISTORICO_NO_TRAZADO]: 0
});

// Etiquetas legibles para la UI y los exportables. Una sola fuente de verdad:
// si mañana se agrega un tipo, se agrega aquí y aparece bien en todas partes.
const ETIQUETAS = Object.freeze({
  [TIPOS.ENTRADA_COMPRA]:              'Entrada por compra',
  [TIPOS.ENTRADA_DEVOLUCION_CLIENTE]:  'Devolución de cliente',
  [TIPOS.DEVOLUCION_ANULACION]:        'Devolución por anulación',
  [TIPOS.ENTRADA_AJUSTE]:              'Ajuste — entrada',
  [TIPOS.ENTRADA_IMPORTACION]:         'Carga inicial / importación',
  [TIPOS.SALIDA_VENTA]:                'Salida por venta',
  [TIPOS.SALIDA_TALLER]:               'Consumo de taller',
  [TIPOS.CONSUMO_COMPUESTO]:           'Consumo como componente',
  [TIPOS.CONSUMO_PRODUCCION]:          'Consumo en producción',
  [TIPOS.ENTRADA_PRODUCCION]:          'Entrada por producción',
  [TIPOS.SALIDA_AJUSTE]:               'Ajuste — salida',
  [TIPOS.SALIDA_DEVOLUCION_PROVEEDOR]: 'Devolución a proveedor',
  [TIPOS.AJUSTE_CONTEO]:               'Ajuste por conteo físico',
  [TIPOS.AJUSTE_HISTORICO_NO_TRAZADO]: 'Diferencia histórica no trazada'
});

const COL = 'inventory_movements';

// ─── HELPERS ────────────────────────────────────────────────────────────────

const aISO = (v) => {
  if (!v) return null;
  try {
    if (typeof v === 'string') return new Date(v).toISOString();
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  } catch { /* fecha inválida */ }
  return null;
};

// El tenant se resuelve SIEMPRE desde el producto, nunca desde el request.
// Los productos creados antes del fix de multi-tenant solo tienen creadoPor.
const tenantDe = (prod) => prod.adminId || prod.creadoPor || null;

const mueveStock = (prod) =>
  prod.tipo !== 'servicio' && prod.tieneStock !== false;

// ✅ INV-KARDEX-002: cuando un movimiento deja el saldo en negativo, el kardex
// no se limita a marcarlo: explica QUÉ lo causó y QUÉ hay que hacer. Un "-8" sin
// contexto no le sirve a nadie; "vendiste 8 unidades sin respaldo de entrada,
// revisa la venta" sí. Se guarda en el movimiento para que la nota viaje con el
// hecho y no dependa de que la UI la reconstruya después.
function notaNegativo(tipo, stockAntes, stockDespues, origenNumero) {
  if (stockDespues >= 0) return null;
  const faltan = Math.abs(stockDespues);
  const ref = origenNumero ? ` (${origenNumero})` : '';

  switch (tipo) {
    case TIPOS.SALIDA_DEVOLUCION_PROVEEDOR:
      return `Quedó en −${faltan}. Se anuló o devolvió una compra${ref} cuya mercancía ya había salido. Hay ${faltan} unidad(es) vendida(s) sin respaldo de entrada: revisa esas ventas o registra la compra correcta.`;
    case TIPOS.SALIDA_VENTA:
    case TIPOS.CONSUMO_COMPUESTO:
      return `Quedó en −${faltan}. Se vendió${ref} más de lo que el sistema tenía registrado. Falta registrar una entrada (compra o ajuste), o hay un error en la cantidad de la venta.`;
    case TIPOS.CONSUMO_PRODUCCION:
      return `Quedó en −${faltan}. La producción${ref} consumió más componentes de los que había en stock. Revisa la receta del producto o registra la entrada faltante.`;
    case TIPOS.SALIDA_TALLER:
      return `Quedó en −${faltan}. El taller consumió${ref} más de lo disponible. Registra la entrada faltante.`;
    default:
      return `Quedó en −${faltan}. Este movimiento dejó el saldo por debajo de cero: falta registrar una entrada o corregir una salida anterior.`;
  }
}

// ============================================================================
// REGISTRAR MOVIMIENTO — punto de entrada único
// ============================================================================
// Escribe el movimiento y actualiza el stock en UNA transacción atómica.
//
// @param {string} productoId   obligatorio
// @param {string} tipo         una clave de TIPOS
// @param {number} cantidad     positiva; el signo lo pone el tipo.
//                              En AJUSTE_CONTEO / AJUSTE_HISTORICO se respeta
//                              el signo recibido (puede ser negativo).
// @param {object} origen       { tipo, id, numero } — orden, compra, egreso...
// @param {object} usuario      { id, nombre }
// @param {string} motivo       obligatorio en ajustes
// @returns {Promise<object|null>} movimiento creado, o null si no aplica
// ============================================================================
async function registrarMovimiento({
  productoId,
  tipo,
  cantidad,
  origenTipo = null,
  origenId = null,
  origenNumero = null,
  clienteId = null,
  clienteNombre = null,
  proveedorNombre = null,
  usuarioId = null,
  usuarioNombre = null,
  motivo = '',
  costoUnitario = null,
  fecha = null,
  reconstruido = false
}) {
  if (!productoId) return null;
  if (!TIPOS[tipo]) throw new Error(`Tipo de movimiento inválido: ${tipo}`);

  const signo = SIGNO[tipo];
  const cant = Number(cantidad);
  if (!cant || isNaN(cant)) return null;

  // En ajustes el signo viene en la cantidad; en el resto lo impone el tipo.
  const delta = signo === 0 ? cant : signo * Math.abs(cant);
  if (delta === 0) return null;

  const prodRef = db.collection('products').doc(productoId);
  const movRef  = db.collection(COL).doc();

  try {
    return await db.runTransaction(async (tx) => {
      const prodDoc = await tx.get(prodRef);
      if (!prodDoc.exists) return null;

      const prod = prodDoc.data();
      if (!mueveStock(prod)) return null;

      const adminId = tenantDe(prod);
      if (!adminId) {
        console.warn(`[INV-KARDEX-001] Producto ${productoId} sin tenant, movimiento omitido`);
        return null;
      }

      const stockAntes   = Number(prod.stock) || 0;
      const stockDespues = stockAntes + delta;
      const costo        = costoUnitario !== null
        ? Number(costoUnitario) || 0
        : Number(prod.precioCosto) || 0;

      const mov = {
        adminId,
        productoId,
        productoNombre: prod.nombre || '',
        productoCodigo: prod.codigo || '',
        categoria:      prod.categoria || '',
        tipo,
        tipoLabel:      ETIQUETAS[tipo] || tipo,
        cantidad:       delta,
        stockAntes,
        stockDespues,
        stockNegativo:  stockDespues < 0,
        // ✅ INV-KARDEX-002: la explicación viaja con el hecho.
        notaNegativo:   notaNegativo(tipo, stockAntes, stockDespues, origenNumero),
        origenTipo, origenId, origenNumero,
        clienteId, clienteNombre, proveedorNombre,
        usuarioId, usuarioNombre,
        motivo: motivo || '',
        costoUnitario:   costo,
        valorMovimiento: Math.round(Math.abs(delta) * costo),
        fecha: aISO(fecha) || new Date().toISOString(),
        reconstruido: !!reconstruido,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };

      tx.update(prodRef, {
        stock: stockDespues,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(movRef, mov);

      return { id: movRef.id, ...mov };
    });
  } catch (e) {
    // INVARIANTE 3: el kardex nunca tumba una venta ni una compra.
    console.error(`[INV-KARDEX-001] Fallo registrando movimiento ${tipo} de ${productoId}:`, e.message);
    return null;
  }
}

// ============================================================================
// EXPANDIR ITEM — resuelve productos compuestos a sus componentes
// ============================================================================
// Un producto 'compuesto' no descuenta su propio stock: descuenta el de sus
// componentes. Esta función centraliza esa regla para que orders.js, taller y
// la reconstrucción la apliquen exactamente igual.
//
// @returns {Promise<Array<{productoId, cantidad, esComponente}>>}
// ============================================================================
async function expandirItem(productoId, cantidad, cacheProductos = null) {
  const cant = Number(cantidad) || 0;
  if (!productoId || cant <= 0) return [];

  let prod = cacheProductos ? cacheProductos[productoId] : null;
  if (!prod) {
    try {
      const doc = await db.collection('products').doc(productoId).get();
      if (!doc.exists) return [];
      prod = doc.data();
      if (cacheProductos) cacheProductos[productoId] = prod;
    } catch { return []; }
  }

  if (prod.tipo === 'compuesto' && Array.isArray(prod.componentes) && prod.componentes.length) {
    return prod.componentes
      .filter(c => c.productoId)
      .map(c => ({
        productoId: c.productoId,
        cantidad: (Number(c.cantidad) || 0) * cant,
        esComponente: true
      }))
      .filter(c => c.cantidad > 0);
  }

  if (!mueveStock(prod)) return [];
  return [{ productoId, cantidad: cant, esComponente: false }];
}

// ============================================================================
// REGISTRAR ITEMS DE UNA ORDEN — helper de alto nivel
// ============================================================================
// Recorre los items de una orden, expande compuestos y registra un movimiento
// por cada uno. Tolerante a fallos: un item problemático no detiene el resto.
// La usan orders.js (venta, taller, anulación) en los 3 puntos de mutación.
// ============================================================================
async function registrarItemsOrden({
  items = [],
  tipo,
  orden = {},
  usuarioId = null,
  usuarioNombre = null,
  motivo = '',
  fecha = null
}) {
  const cache = {};
  const registrados = [];

  for (const item of items) {
    if (!item.productoId) continue;
    const partes = await expandirItem(item.productoId, item.cantidad, cache);

    for (const parte of partes) {
      // Un componente consumido dentro de un compuesto se marca aparte para que
      // el kardex explique POR QUÉ salió, aunque nunca se vendió directamente.
      const tipoReal = parte.esComponente && tipo === TIPOS.SALIDA_VENTA
        ? TIPOS.CONSUMO_COMPUESTO
        : tipo;

      const mov = await registrarMovimiento({
        productoId:   parte.productoId,
        tipo:         tipoReal,
        cantidad:     parte.cantidad,
        origenTipo:   'orden',
        origenId:     orden.id || null,
        origenNumero: orden.numeroOrden || null,
        clienteId:      orden.clienteId || null,
        clienteNombre:  orden.clienteNombre || null,
        usuarioId, usuarioNombre,
        motivo: parte.esComponente
          ? `${motivo || ''} (componente de ${item.nombre || 'producto compuesto'})`.trim()
          : motivo,
        fecha
      });
      if (mov) registrados.push(mov);
    }
  }

  return registrados;
}

// ============================================================================
// CONSULTAS
// ============================================================================

// Kardex de un producto: movimientos ordenados del más reciente al más antiguo.
async function obtenerKardex({ adminId, productoId, desde = null, hasta = null, limite = 500 }) {
  if (!adminId || !productoId) return [];
  const snap = await db.collection(COL)
    .where('adminId', '==', adminId)
    .where('productoId', '==', productoId)
    .get();

  let movs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (desde) movs = movs.filter(m => m.fecha >= desde);
  if (hasta) movs = movs.filter(m => m.fecha <= hasta);

  // Orden en memoria: evita exigir un índice compuesto adicional en tenants
  // que aún no lo tengan creado (misma estrategia que usa cxc.js).
  movs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  return movs.slice(0, limite);
}

// Saldo de un producto a una fecha de corte, reconstruido desde el ledger.
// Es la pieza que hace posible calcular rotación: sin historia de saldos no hay
// inventario promedio, y sin inventario promedio no hay índice de rotación.
async function saldoAFecha({ adminId, productoId, fechaCorte }) {
  const movs = await obtenerKardex({ adminId, productoId, hasta: fechaCorte, limite: 100000 });
  return movs.reduce((s, m) => s + (Number(m.cantidad) || 0), 0);
}

// Movimientos del tenant en un rango. Base de la vista global y de rotación.
async function movimientosEnRango({ adminId, desde, hasta, tipo = null, productoId = null }) {
  if (!adminId) return [];
  let q = db.collection(COL).where('adminId', '==', adminId);
  if (tipo)       q = q.where('tipo', '==', tipo);
  if (productoId) q = q.where('productoId', '==', productoId);

  const snap = await q.get();
  let movs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (desde) movs = movs.filter(m => m.fecha >= desde);
  if (hasta) movs = movs.filter(m => m.fecha <= hasta);
  movs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  return movs;
}

// ¿Este tenant ya tiene kardex? Evita reconstruir dos veces.
async function tieneMovimientos(adminId) {
  const snap = await db.collection(COL)
    .where('adminId', '==', adminId)
    .limit(1)
    .get();
  return !snap.empty;
}

// ============================================================================
// RECONSTRUCCIÓN HISTÓRICA (BACKFILL)
// ============================================================================
// Reconstruye el kardex hacia atrás desde `orders` y `compras`.
//
// QUÉ RECUPERA
//   · Salidas por venta (con orden, fecha y cliente)
//   · Consumo de componentes de productos compuestos
//   · Devoluciones por anulación de orden
//   · Entradas por compra recibida
//
// QUÉ NO PUEDE RECUPERAR (y por qué está bien)
//   · Ediciones manuales de stock — nunca se registraron en ninguna parte
//   · Importaciones masivas de productos
//   · Egresos antiguos sin línea de producto
//   La diferencia entre el saldo calculado y el stock real se registra como
//   AJUSTE_HISTORICO_NO_TRAZADO al día del corte. Es el asiento de apertura:
//   deja el kardex cuadrado al 100% desde el día 1 y la diferencia VISIBLE y
//   valorizada al costo, en lugar de escondida.
//
// NO MODIFICA products.stock. El stock actual es el ancla.
//
// @param {boolean} dryRun  true = solo devuelve el informe, no escribe nada
// ============================================================================
async function reconstruirHistorico({ adminId, dryRun = true, usuarioId = null, usuarioNombre = 'Sistema' }) {
  if (!adminId) throw new Error('adminId requerido');

  const corte = new Date().toISOString();

  // ── 1) Cargar productos del tenant ────────────────────────────────────────
  // Los productos antiguos solo tienen creadoPor; los nuevos tienen ambos.
  // Se consultan los dos campos y se deduplica por id.
  const productos = {};
  const [snapA, snapB] = await Promise.all([
    db.collection('products').where('creadoPor', '==', adminId).get(),
    db.collection('products').where('adminId', '==', adminId).get()
  ]);
  [...snapA.docs, ...snapB.docs].forEach(d => { productos[d.id] = d.data(); });

  // ── 2) Construir la línea de tiempo de eventos ────────────────────────────
  const eventos = [];

  const ordSnap = await db.collection('orders').where('adminId', '==', adminId).get();
  ordSnap.forEach(d => {
    const o = d.data();

    // Las órdenes internas NUNCA movieron inventario. Incluirlas inventaría
    // salidas que no ocurrieron.
    if (o.tipoOrden === 'interna') return;

    const fechaOrden = aISO(o.createdAt) || aISO(o.fechaCreacion) || corte;

    // ══════════════════════════════════════════════════════════════════════
    // ✅ INV-KARDEX-002: ÓRDENES DE PRODUCCIÓN
    // No descuentan al crearse (orders.js línea 1163 las excluye), pero al
    // COMPLETARSE consumen los componentes y dan de alta el producto
    // terminado (orders.js líneas 1894 y 1914). La v1 las descartaba enteras
    // y todo lo fabricado internamente quedaba fuera del histórico.
    // Solo cuentan si la orden efectivamente llegó a completarse: una orden
    // de producción a medias nunca tocó el stock.
    // ══════════════════════════════════════════════════════════════════════
    if (o.tipoOrden === 'produccion') {
      if (o.estado !== 'completada' && o.estado !== 'cuadre_dinero' && o.estado !== 'cxc') return;
      const fechaProd = aISO(o.completadaEn) || aISO(o.updatedAt) || fechaOrden;

      (o.items || []).forEach(item => {
        if (!item.productoId) return;
        const cant = Number(item.cantidad) || 0;
        if (cant <= 0) return;

        // 1) Consumo de componentes (ya expandido: no debe volver a expandirse)
        const prod = productos[item.productoId];
        if (prod && prod.tipo === 'compuesto' && Array.isArray(prod.componentes)) {
          prod.componentes.forEach(c => {
            if (!c.productoId) return;
            eventos.push({
              fecha: fechaProd,
              tipo: TIPOS.CONSUMO_PRODUCCION,
              productoId: c.productoId,
              cantidad: (Number(c.cantidad) || 0) * cant,
              yaExpandido: true,
              origenTipo: 'orden', origenId: d.id, origenNumero: o.numeroOrden || '',
              nombreItem: item.nombre || ''
            });
          });
        }

        // 2) Alta del producto terminado
        eventos.push({
          fecha: fechaProd,
          tipo: TIPOS.ENTRADA_PRODUCCION,
          productoId: item.productoId,
          cantidad: cant,
          yaExpandido: true,
          origenTipo: 'orden', origenId: d.id, origenNumero: o.numeroOrden || '',
          nombreItem: item.nombre || ''
        });
      });
      return;
    }

    (o.items || []).forEach(item => {
      if (!item.productoId) return;
      eventos.push({
        fecha: fechaOrden,
        tipo: TIPOS.SALIDA_VENTA,
        productoId: item.productoId,
        cantidad: Number(item.cantidad) || 0,
        origenTipo: 'orden', origenId: d.id, origenNumero: o.numeroOrden || '',
        clienteId: o.clienteId || null,
        clienteNombre: o.clienteNombre || '',
        nombreItem: item.nombre || ''
      });
    });

    // Una orden anulada devolvió el inventario. Se registran los dos hechos
    // —salió y volvió— porque ambos ocurrieron de verdad.
    if (o.estado === 'anulada') {
      const fechaAnul = aISO(o.anuladaEn) || aISO(o.updatedAt) || fechaOrden;
      (o.items || []).forEach(item => {
        if (!item.productoId) return;
        eventos.push({
          fecha: fechaAnul,
          tipo: TIPOS.DEVOLUCION_ANULACION,
          productoId: item.productoId,
          cantidad: Number(item.cantidad) || 0,
          origenTipo: 'orden', origenId: d.id, origenNumero: o.numeroOrden || '',
          clienteId: o.clienteId || null,
          clienteNombre: o.clienteNombre || '',
          nombreItem: item.nombre || ''
        });
      });
    }
  });

  const cmpSnap = await db.collection('compras').where('adminId', '==', adminId).get();
  cmpSnap.forEach(d => {
    const c = d.data();
    // Solo las compras que efectivamente movieron inventario. Un borrador o una
    // compra anulada nunca tocó el stock.
    if (c.estado === 'borrador' || c.estado === 'anulada') return;

    const fechaCompra = aISO(c.fechaRecepcion) || aISO(c.createdAt) ||
                        (c.fechaFactura ? `${c.fechaFactura}T12:00:00.000Z` : corte);

    (c.lineas || []).forEach(l => {
      // destino 'taller' fue a taller_insumos, no a products.
      if (!l.productoId || l.destino === 'taller') return;
      eventos.push({
        fecha: fechaCompra,
        tipo: TIPOS.ENTRADA_COMPRA,
        productoId: l.productoId,
        cantidad: Number(l.cantidad) || 0,
        origenTipo: 'compra', origenId: d.id, origenNumero: c.numero || '',
        proveedorNombre: c.proveedorNombre || '',
        costoUnitario: Number(l.precioUnitario) || 0,
        nombreItem: l.productoNombre || ''
      });
    });
  });

  eventos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  // ── 3) Expandir compuestos y calcular saldo corrido por producto ──────────
  // Advertencia deliberada: la expansión usa la receta ACTUAL del compuesto.
  // Si una receta cambió en el pasado, el histórico es una aproximación. La
  // diferencia no se pierde: cae en el ajuste de apertura.
  const movimientos = [];
  const saldos = {};

  for (const ev of eventos) {
    const prod = productos[ev.productoId];
    if (!prod) continue;

    let partes;
    // ✅ INV-KARDEX-002: los eventos de producción llegan YA resueltos a nivel
    // de componente. Volver a expandirlos multiplicaría el consumo.
    if (ev.yaExpandido) {
      partes = [{ productoId: ev.productoId, cantidad: ev.cantidad, esComponente: false }];
    } else if (prod.tipo === 'compuesto' && Array.isArray(prod.componentes) && prod.componentes.length) {
      partes = prod.componentes
        .filter(c => c.productoId && productos[c.productoId])
        .map(c => ({
          productoId: c.productoId,
          cantidad: (Number(c.cantidad) || 0) * ev.cantidad,
          esComponente: true
        }));
    } else if (mueveStock(prod)) {
      partes = [{ productoId: ev.productoId, cantidad: ev.cantidad, esComponente: false }];
    } else {
      continue;
    }

    for (const parte of partes) {
      if (!parte.cantidad || parte.cantidad <= 0) continue;
      const p = productos[parte.productoId];
      if (!p || !mueveStock(p)) continue;

      const tipoReal = parte.esComponente && ev.tipo === TIPOS.SALIDA_VENTA
        ? TIPOS.CONSUMO_COMPUESTO
        : ev.tipo;

      const signo = SIGNO[tipoReal];
      const delta = signo * parte.cantidad;
      const antes = saldos[parte.productoId] || 0;
      const despues = antes + delta;
      saldos[parte.productoId] = despues;

      const costo = ev.costoUnitario !== undefined && ev.costoUnitario !== null
        ? ev.costoUnitario
        : (Number(p.precioCosto) || 0);

      movimientos.push({
        adminId,
        productoId: parte.productoId,
        productoNombre: p.nombre || '',
        productoCodigo: p.codigo || '',
        categoria: p.categoria || '',
        tipo: tipoReal,
        tipoLabel: ETIQUETAS[tipoReal] || tipoReal,
        cantidad: delta,
        stockAntes: antes,
        stockDespues: despues,
        stockNegativo: despues < 0,
        notaNegativo: notaNegativo(tipoReal, antes, despues, ev.origenNumero),
        origenTipo: ev.origenTipo, origenId: ev.origenId, origenNumero: ev.origenNumero,
        clienteId: ev.clienteId || null,
        clienteNombre: ev.clienteNombre || null,
        proveedorNombre: ev.proveedorNombre || null,
        usuarioId: null,
        usuarioNombre: 'Reconstrucción histórica',
        motivo: parte.esComponente
          ? `Componente de ${ev.nombreItem || 'producto compuesto'}`
          : '',
        costoUnitario: costo,
        valorMovimiento: Math.round(Math.abs(delta) * costo),
        fecha: ev.fecha,
        reconstruido: true
      });
    }
  }

  // ── 4) Asiento de apertura: cuadrar contra el stock real ──────────────────
  const diferencias = [];
  Object.entries(productos).forEach(([id, p]) => {
    if (!mueveStock(p)) return;
    const calculado = saldos[id] || 0;
    const real = Number(p.stock) || 0;
    const dif = real - calculado;
    if (dif === 0) return;

    const costo = Number(p.precioCosto) || 0;
    diferencias.push({
      productoId: id,
      nombre: p.nombre || '',
      codigo: p.codigo || '',
      calculado, real, diferencia: dif,
      valorDiferencia: Math.round(Math.abs(dif) * costo)
    });

    movimientos.push({
      adminId,
      productoId: id,
      productoNombre: p.nombre || '',
      productoCodigo: p.codigo || '',
      categoria: p.categoria || '',
      tipo: TIPOS.AJUSTE_HISTORICO_NO_TRAZADO,
      tipoLabel: ETIQUETAS[TIPOS.AJUSTE_HISTORICO_NO_TRAZADO],
      cantidad: dif,
      stockAntes: calculado,
      stockDespues: real,
      stockNegativo: false,
      notaNegativo: null,
      origenTipo: 'reconstruccion', origenId: null, origenNumero: null,
      clienteId: null, clienteNombre: null, proveedorNombre: null,
      usuarioId, usuarioNombre,
      motivo: 'Diferencia previa a la implementación del Kardex — movimientos no trazados (ediciones manuales, importaciones o cargas iniciales)',
      costoUnitario: costo,
      valorMovimiento: Math.round(Math.abs(dif) * costo),
      fecha: corte,
      reconstruido: true
    });
  });

  const informe = {
    adminId,
    corte,
    dryRun,
    productosAnalizados: Object.keys(productos).length,
    ordenesLeidas: ordSnap.size,
    comprasLeidas: cmpSnap.size,
    movimientosGenerados: movimientos.length,
    productosConDiferencia: diferencias.length,
    valorTotalDiferencias: diferencias.reduce((s, d) => s + d.valorDiferencia, 0),
    diferencias: diferencias.sort((a, b) => b.valorDiferencia - a.valorDiferencia)
  };

  if (dryRun) return informe;

  // ── 5) Escritura por lotes (Firestore admite 500 ops por batch) ───────────
  const TAM = 400;
  for (let i = 0; i < movimientos.length; i += TAM) {
    const batch = db.batch();
    movimientos.slice(i, i + TAM).forEach(m => {
      batch.set(db.collection(COL).doc(), {
        ...m,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
  }

  // Marca en el tenant para que la UI sepa que el kardex ya arrancó y para
  // impedir una segunda reconstrucción por error.
  await db.collection('users').doc(adminId).set({
    inventarioKardex: {
      reconstruido: true,
      fechaReconstruccion: corte,
      movimientosGenerados: movimientos.length,
      productosConDiferencia: diferencias.length,
      valorTotalDiferencias: informe.valorTotalDiferencias
    }
  }, { merge: true });

  return { ...informe, escritos: movimientos.length };
}

module.exports = {
  TIPOS,
  SIGNO,
  ETIQUETAS,
  COL,
  registrarMovimiento,
  registrarItemsOrden,
  expandirItem,
  obtenerKardex,
  saldoAFecha,
  movimientosEnRango,
  tieneMovimientos,
  reconstruirHistorico
};
