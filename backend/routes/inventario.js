// ============================================================================
// Control360 — Rutas del módulo Inventario (Kardex)
// Ubicación: backend/routes/inventario.js
// FIX INV-KARDEX-001
// ----------------------------------------------------------------------------
// Expone el motor de inventoryLedger.js como API. Todo lo que vive aquí es
// PREMIUM: el router completo está detrás de requireModuloPremium('inventario_pro'),
// con semántica opt-in — solo los tenants que Sandra activa explícitamente en el
// Panel de Suscriptores pueden llegar a estos endpoints.
//
// ENDPOINTS
//   GET  /api/inventario/kardex/:productoId   Kardex de un producto
//   GET  /api/inventario/movimientos          Movimientos del tenant (filtrable)
//   GET  /api/inventario/rotacion             Índice de rotación y días de inv.
//   GET  /api/inventario/resumen              KPIs del módulo
//   POST /api/inventario/ajuste               Ajuste manual (motivo obligatorio)
//   POST /api/inventario/conteo/preview       Conteo físico: diferencias
//   POST /api/inventario/conteo/aplicar       Conteo físico: aplicar ajustes
//   GET  /api/inventario/reconstruir/estado   ¿Ya se reconstruyó este tenant?
//   POST /api/inventario/reconstruir          Backfill histórico (dryRun por defecto)
//
// PERMISOS
//   Lectura  → admin y comercial (comercial nunca ve precioCosto ni valores)
//   Escritura (ajuste, conteo, reconstrucción) → SOLO admin.
//   Un ajuste de inventario es una decisión patrimonial: mueve el valor del
//   activo. Se trata con el mismo criterio que un egreso.
// ============================================================================

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const ledger = require('../services/inventoryLedger');
const { requireModuloPremium } = require('../services/capacidadesTenant');

// ─── Gating premium para TODO el módulo ─────────────────────────────────────
router.use(requireModuloPremium('inventario_pro'));

// ─── HELPERS ────────────────────────────────────────────────────────────────

const tenant = (req) => req.adminId || req.user?.uid || req.user?.id;
const esAdmin = (req) => req.user?.role === 'admin';

const soloAdmin = (req, res, next) => {
  if (!esAdmin(req)) {
    return res.status(403).json({ error: 'Solo el administrador puede realizar esta acción' });
  }
  next();
};

const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'inventario', descripcion,
      usuarioId, usuarioNombre, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría inventario:', e); }
};

// Los productos antiguos solo tienen creadoPor; los nuevos tienen ambos campos.
// Se consultan los dos y se deduplica por id.
const cargarProductos = async (adminId) => {
  const [a, b] = await Promise.all([
    db.collection('products').where('creadoPor', '==', adminId).get(),
    db.collection('products').where('adminId', '==', adminId).get()
  ]);
  const map = {};
  [...a.docs, ...b.docs].forEach(d => { map[d.id] = { id: d.id, ...d.data() }; });
  return map;
};

// Un comercial no puede ver costos ni valorizaciones.
const limpiarCostos = (obj, req) => {
  if (esAdmin(req)) return obj;
  const { costoUnitario, valorMovimiento, ...resto } = obj;
  return resto;
};

const rango = (req) => {
  const hoy = new Date();
  const desde = req.query.desde
    ? `${req.query.desde}T00:00:00.000Z`
    : new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString();
  const hasta = req.query.hasta
    ? `${req.query.hasta}T23:59:59.999Z`
    : hoy.toISOString();
  return { desde, hasta };
};

// ════════════════════════════════════════════════════════════════════════════
// GET /api/inventario/kardex/:productoId
// ════════════════════════════════════════════════════════════════════════════
// Responde la pregunta central: qué entró, qué salió, cuándo, por qué, quién y
// para qué cliente. Devuelve el saldo corrido para que la UI lo pinte sin
// recalcular nada.
// ════════════════════════════════════════════════════════════════════════════
router.get('/kardex/:productoId', async (req, res) => {
  try {
    const adminId = tenant(req);
    const { productoId } = req.params;

    const prodDoc = await db.collection('products').doc(productoId).get();
    if (!prodDoc.exists) return res.status(404).json({ error: 'Producto no encontrado' });

    const prod = prodDoc.data();
    // Aislamiento multi-tenant explícito: no basta con que exista el documento.
    if ((prod.adminId || prod.creadoPor) !== adminId) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { desde, hasta } = req.query.desde || req.query.hasta
      ? rango(req)
      : { desde: null, hasta: null };

    const movs = await ledger.obtenerKardex({
      adminId, productoId, desde, hasta,
      limite: Number(req.query.limite) || 500
    });

    // El saldo corrido se calcula de atrás hacia adelante desde el stock actual:
    // así la primera fila que ve el usuario siempre coincide con el stock real
    // que tiene en pantalla, sin depender de que el histórico esté completo.
    let saldo = Number(prod.stock) || 0;
    const filas = movs.map(m => {
      const fila = { ...m, saldo };
      saldo = saldo - (Number(m.cantidad) || 0);
      return limpiarCostos(fila, req);
    });

    res.json({
      producto: {
        id: productoId,
        nombre: prod.nombre,
        codigo: prod.codigo,
        categoria: prod.categoria,
        stock: Number(prod.stock) || 0,
        stockMinimo: Number(prod.stockMinimo) || 0,
        tipo: prod.tipo,
        ...(esAdmin(req) ? { precioCosto: Number(prod.precioCosto) || 0 } : {})
      },
      movimientos: filas,
      total: filas.length
    });
  } catch (e) {
    console.error('GET kardex:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/inventario/movimientos
// Vista global. Filtros: desde, hasta, tipo, productoId, categoria, texto
// ════════════════════════════════════════════════════════════════════════════
router.get('/movimientos', async (req, res) => {
  try {
    const adminId = tenant(req);
    const { desde, hasta } = rango(req);

    let movs = await ledger.movimientosEnRango({
      adminId, desde, hasta,
      tipo: req.query.tipo || null,
      productoId: req.query.productoId || null
    });

    if (req.query.categoria) {
      movs = movs.filter(m => (m.categoria || '') === req.query.categoria);
    }
    if (req.query.texto) {
      const q = String(req.query.texto).toUpperCase();
      movs = movs.filter(m =>
        (m.productoNombre || '').toUpperCase().includes(q) ||
        (m.productoCodigo || '').toUpperCase().includes(q) ||
        (m.clienteNombre || '').toUpperCase().includes(q) ||
        (m.origenNumero || '').toUpperCase().includes(q)
      );
    }

    const limite = Number(req.query.limite) || 1000;
    res.json({
      movimientos: movs.slice(0, limite).map(m => limpiarCostos(m, req)),
      total: movs.length,
      truncado: movs.length > limite
    });
  } catch (e) {
    console.error('GET movimientos:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/inventario/rotacion
// ════════════════════════════════════════════════════════════════════════════
// Rotación = costo de la mercancía vendida en el período / inventario promedio.
// Inventario promedio = (saldo inicial + saldo final) / 2, ambos reconstruidos
// desde el ledger. Sin historia de saldos esto era imposible de calcular — es
// exactamente lo que el Kardex vino a habilitar.
//
// Días de inventario = días del período / rotación. Es la lectura que de verdad
// sirve para decidir compras: "esta referencia me dura 180 días" pesa más que
// "rota 2 veces al año".
// ════════════════════════════════════════════════════════════════════════════
router.get('/rotacion', soloAdmin, async (req, res) => {
  try {
    const adminId = tenant(req);
    const { desde, hasta } = rango(req);

    const productos = await cargarProductos(adminId);
    const todos = await ledger.movimientosEnRango({ adminId, desde: null, hasta });

    const dias = Math.max(1, Math.round((new Date(hasta) - new Date(desde)) / 86400000));

    const porProducto = {};
    todos.forEach(m => {
      const p = porProducto[m.productoId] || (porProducto[m.productoId] = {
        productoId: m.productoId,
        nombre: m.productoNombre,
        codigo: m.productoCodigo,
        categoria: m.categoria,
        saldoInicial: 0,
        salidasPeriodo: 0,
        entradasPeriodo: 0,
        costoVendido: 0,
        ultimoMovimiento: null
      });

      const cant = Number(m.cantidad) || 0;

      // Todo lo anterior al período construye el saldo inicial.
      if (m.fecha < desde) { p.saldoInicial += cant; return; }

      if (cant < 0) {
        p.salidasPeriodo += Math.abs(cant);
        // Solo la salida por venta o consumo es costo de mercancía vendida.
        // Un ajuste por conteo es una pérdida, no una venta: distorsionaría la
        // rotación si se contara aquí.
        if (m.tipo === ledger.TIPOS.SALIDA_VENTA || m.tipo === ledger.TIPOS.CONSUMO_COMPUESTO) {
          p.costoVendido += Number(m.valorMovimiento) || 0;
        }
      } else {
        p.entradasPeriodo += cant;
      }

      if (!p.ultimoMovimiento || m.fecha > p.ultimoMovimiento) p.ultimoMovimiento = m.fecha;
    });

    const filas = Object.values(porProducto).map(p => {
      const prod = productos[p.productoId] || {};
      const costo = Number(prod.precioCosto) || 0;
      const saldoFinal = Number(prod.stock) || 0;
      const promedio = (p.saldoInicial + saldoFinal) / 2;

      const rotacion = promedio > 0
        ? Number((p.salidasPeriodo / promedio).toFixed(2))
        : null;
      const diasInventario = rotacion && rotacion > 0
        ? Math.round(dias / rotacion)
        : null;

      return {
        ...p,
        saldoFinal,
        inventarioPromedio: Number(promedio.toFixed(2)),
        rotacion,
        diasInventario,
        valorStockActual: Math.round(saldoFinal * costo),
        // Sin movimiento en el período y con stock parado = capital dormido.
        capitalDormido: p.salidasPeriodo === 0 && saldoFinal > 0
      };
    });

    filas.sort((a, b) => (b.salidasPeriodo || 0) - (a.salidasPeriodo || 0));

    const capitalDormido = filas.filter(f => f.capitalDormido);

    res.json({
      periodo: { desde, hasta, dias },
      productos: filas,
      resumen: {
        referenciasAnalizadas: filas.length,
        referenciasSinMovimiento: capitalDormido.length,
        valorCapitalDormido: capitalDormido.reduce((s, f) => s + f.valorStockActual, 0),
        costoVendidoTotal: filas.reduce((s, f) => s + f.costoVendido, 0),
        valorInventarioActual: filas.reduce((s, f) => s + f.valorStockActual, 0)
      }
    });
  } catch (e) {
    console.error('GET rotacion:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/inventario/resumen — KPIs de cabecera del módulo
// ════════════════════════════════════════════════════════════════════════════
router.get('/resumen', async (req, res) => {
  try {
    const adminId = tenant(req);
    const { desde, hasta } = rango(req);

    const [productos, movs] = await Promise.all([
      cargarProductos(adminId),
      ledger.movimientosEnRango({ adminId, desde, hasta })
    ]);

    let entradas = 0, salidas = 0, ajustes = 0, valorEntradas = 0, valorSalidas = 0;
    movs.forEach(m => {
      const c = Number(m.cantidad) || 0;
      const v = Number(m.valorMovimiento) || 0;
      if (m.tipo === ledger.TIPOS.AJUSTE_CONTEO || m.tipo === ledger.TIPOS.ENTRADA_AJUSTE ||
          m.tipo === ledger.TIPOS.SALIDA_AJUSTE) { ajustes++; }
      if (c > 0) { entradas += c; valorEntradas += v; }
      else       { salidas  += Math.abs(c); valorSalidas += v; }
    });

    const lista = Object.values(productos).filter(p => p.tipo !== 'servicio' && p.tieneStock !== false);
    const valorInventario = lista.reduce((s, p) =>
      s + ((Number(p.stock) || 0) * (Number(p.precioCosto) || 0)), 0);
    const negativos = lista.filter(p => (Number(p.stock) || 0) < 0);

    // ✅ INV-KARDEX-002: para cada producto en negativo se busca el movimiento
    // que lo causó y se devuelve su nota. Un "-8" pelado no le dice nada a nadie;
    // "se anuló la compra CMP-0012 y 8 unidades ya se habían vendido" sí le dice
    // qué venta tiene que ir a ajustar.
    const notasPorProducto = {};
    if (negativos.length) {
      const idsNeg = new Set(negativos.map(p => p.id));
      const movsNeg = await ledger.movimientosEnRango({ adminId, desde: null, hasta: null });
      movsNeg
        .filter(m => idsNeg.has(m.productoId) && m.stockNegativo && m.notaNegativo)
        .forEach(m => {
          // movimientosEnRango viene ordenado de más reciente a más antiguo:
          // el primero que se encuentra es el más reciente, que es el vigente.
          if (!notasPorProducto[m.productoId]) {
            notasPorProducto[m.productoId] = {
              nota: m.notaNegativo,
              fecha: m.fecha,
              origenNumero: m.origenNumero || null,
              tipoLabel: m.tipoLabel || null
            };
          }
        });
    }

    res.json({
      periodo: { desde, hasta },
      unidadesIngresadas: entradas,
      unidadesSalidas: salidas,
      movimientosTotales: movs.length,
      ajustesRealizados: ajustes,
      referenciasConStock: lista.filter(p => (Number(p.stock) || 0) > 0).length,
      referenciasEnNegativo: negativos.length,
      productosEnNegativo: negativos.map(p => ({
        id: p.id, nombre: p.nombre, codigo: p.codigo, stock: Number(p.stock) || 0,
        // ✅ INV-KARDEX-002
        ...(notasPorProducto[p.id] || {})
      })),
      ...(esAdmin(req) ? {
        valorEntradas: Math.round(valorEntradas),
        valorSalidas: Math.round(valorSalidas),
        valorInventario: Math.round(valorInventario)
      } : {})
    });
  } catch (e) {
    console.error('GET resumen inventario:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/inventario/ajuste — ajuste manual de stock
// Body: { productoId, cantidad (con signo), motivo }
// ════════════════════════════════════════════════════════════════════════════
// El reemplazo del campo editable que se quitó del formulario de producto. La
// diferencia es toda: aquí el motivo es OBLIGATORIO y queda un asiento con
// nombre y apellido.
// ════════════════════════════════════════════════════════════════════════════
router.post('/ajuste', soloAdmin, async (req, res) => {
  try {
    const adminId = tenant(req);
    const { productoId, cantidad, motivo } = req.body;

    if (!productoId) return res.status(400).json({ error: 'Producto requerido' });

    const cant = Number(cantidad);
    if (!cant || isNaN(cant)) {
      return res.status(400).json({ error: 'La cantidad debe ser distinta de cero (usa negativo para descontar)' });
    }
    if (!motivo || String(motivo).trim().length < 5) {
      return res.status(400).json({ error: 'El motivo es obligatorio (mínimo 5 caracteres). Un ajuste sin explicación es exactamente el problema que el Kardex resuelve.' });
    }

    const prodDoc = await db.collection('products').doc(productoId).get();
    if (!prodDoc.exists) return res.status(404).json({ error: 'Producto no encontrado' });
    const prod = prodDoc.data();
    if ((prod.adminId || prod.creadoPor) !== adminId) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const mov = await ledger.registrarMovimiento({
      productoId,
      tipo: cant > 0 ? ledger.TIPOS.ENTRADA_AJUSTE : ledger.TIPOS.SALIDA_AJUSTE,
      cantidad: Math.abs(cant),
      origenTipo: 'ajuste',
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      motivo: String(motivo).trim()
    });

    if (!mov) {
      return res.status(400).json({ error: 'El producto no maneja stock (servicio) o no pudo registrarse el ajuste' });
    }

    await auditar({
      accion: 'AJUSTE_STOCK',
      descripcion: `${req.user.nombre || req.user.email} ajustó ${prod.nombre} de ${mov.stockAntes} a ${mov.stockDespues} — ${motivo}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { productoId, cantidad: cant, motivo, stockAntes: mov.stockAntes, stockDespues: mov.stockDespues }
    });

    res.json({ ok: true, movimiento: mov });
  } catch (e) {
    console.error('POST ajuste:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/inventario/conteo/preview
// Body: { conteos: [ { productoId, contado } ] }
// ════════════════════════════════════════════════════════════════════════════
// Toma física: se compara lo contado contra el sistema ANTES de tocar nada.
// Devuelve el faltante/sobrante valorizado al costo. Es el informe que le hace
// falta a la suscriptora que no encontró las vendas.
// ════════════════════════════════════════════════════════════════════════════
router.post('/conteo/preview', soloAdmin, async (req, res) => {
  try {
    const adminId = tenant(req);
    const { conteos } = req.body;
    if (!Array.isArray(conteos) || !conteos.length) {
      return res.status(400).json({ error: 'Sin conteos para procesar' });
    }

    const productos = await cargarProductos(adminId);
    const filas = [];
    let valorFaltante = 0, valorSobrante = 0;

    conteos.forEach(c => {
      const p = productos[c.productoId];
      if (!p) return;
      if (p.tipo === 'servicio' || p.tieneStock === false) return;

      const sistema = Number(p.stock) || 0;
      const contado = Number(c.contado);
      if (isNaN(contado)) return;

      const diferencia = contado - sistema;
      const costo = Number(p.precioCosto) || 0;
      const valor = Math.round(Math.abs(diferencia) * costo);

      if (diferencia < 0) valorFaltante += valor;
      if (diferencia > 0) valorSobrante += valor;

      filas.push({
        productoId: p.id,
        nombre: p.nombre,
        codigo: p.codigo,
        categoria: p.categoria,
        sistema, contado, diferencia,
        costoUnitario: costo,
        valorDiferencia: valor,
        estado: diferencia === 0 ? 'cuadra' : (diferencia < 0 ? 'faltante' : 'sobrante')
      });
    });

    filas.sort((a, b) => b.valorDiferencia - a.valorDiferencia);

    res.json({
      filas,
      resumen: {
        referenciasContadas: filas.length,
        cuadran: filas.filter(f => f.estado === 'cuadra').length,
        faltantes: filas.filter(f => f.estado === 'faltante').length,
        sobrantes: filas.filter(f => f.estado === 'sobrante').length,
        valorFaltante,
        valorSobrante,
        impactoNeto: valorSobrante - valorFaltante
      }
    });
  } catch (e) {
    console.error('POST conteo preview:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/inventario/conteo/aplicar
// Body: { conteos: [ { productoId, contado } ], motivo }
// ════════════════════════════════════════════════════════════════════════════
router.post('/conteo/aplicar', soloAdmin, async (req, res) => {
  try {
    const adminId = tenant(req);
    const { conteos, motivo } = req.body;
    if (!Array.isArray(conteos) || !conteos.length) {
      return res.status(400).json({ error: 'Sin conteos para aplicar' });
    }

    const productos = await cargarProductos(adminId);
    const aplicados = [];
    const omitidos = [];
    const fechaConteo = new Date().toISOString();
    const motivoFinal = (motivo && String(motivo).trim()) || `Conteo físico ${fechaConteo.slice(0, 10)}`;

    for (const c of conteos) {
      const p = productos[c.productoId];
      if (!p) { omitidos.push({ productoId: c.productoId, razon: 'no encontrado' }); continue; }
      if (p.tipo === 'servicio' || p.tieneStock === false) continue;

      const sistema = Number(p.stock) || 0;
      const contado = Number(c.contado);
      if (isNaN(contado) || contado === sistema) continue;

      // AJUSTE_CONTEO lleva signo propio: la diferencia puede ir en cualquier
      // dirección y el tipo no debe imponerlo.
      const mov = await ledger.registrarMovimiento({
        productoId: p.id,
        tipo: ledger.TIPOS.AJUSTE_CONTEO,
        cantidad: contado - sistema,
        origenTipo: 'conteo',
        usuarioId: req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        motivo: motivoFinal,
        fecha: fechaConteo
      });

      if (mov) aplicados.push(mov);
      else omitidos.push({ productoId: p.id, razon: 'no se pudo registrar' });
    }

    const valorAjustado = aplicados.reduce((s, m) =>
      s + (m.cantidad < 0 ? -m.valorMovimiento : m.valorMovimiento), 0);

    await auditar({
      accion: 'CONTEO_FISICO',
      descripcion: `${req.user.nombre || req.user.email} aplicó conteo físico: ${aplicados.length} ajuste(s), impacto ${valorAjustado}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { ajustes: aplicados.length, omitidos: omitidos.length, valorAjustado, motivo: motivoFinal }
    });

    res.json({
      ok: true,
      ajustesAplicados: aplicados.length,
      omitidos,
      valorAjustado,
      movimientos: aplicados
    });
  } catch (e) {
    console.error('POST conteo aplicar:', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/inventario/reconstruir/estado
// ════════════════════════════════════════════════════════════════════════════
router.get('/reconstruir/estado', soloAdmin, async (req, res) => {
  try {
    const adminId = tenant(req);
    const [doc, hayMovs] = await Promise.all([
      db.collection('users').doc(adminId).get(),
      ledger.tieneMovimientos(adminId)
    ]);
    const info = (doc.exists && doc.data().inventarioKardex) || null;
    res.json({
      reconstruido: !!(info && info.reconstruido),
      tieneMovimientos: hayMovs,
      detalle: info
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/inventario/reconstruir
// Body: { confirmar: true }  ← sin esto corre en dryRun y NO escribe nada
// ════════════════════════════════════════════════════════════════════════════
// Operación pesada y de una sola vez por tenant. Por eso:
//   1. dryRun por defecto — hay que pedir la escritura explícitamente
//   2. se bloquea si el tenant ya fue reconstruido (duplicaría el histórico)
// ════════════════════════════════════════════════════════════════════════════
router.post('/reconstruir', soloAdmin, async (req, res) => {
  try {
    const adminId = tenant(req);
    const confirmar = req.body?.confirmar === true;

    if (confirmar) {
      const doc = await db.collection('users').doc(adminId).get();
      const info = doc.exists && doc.data().inventarioKardex;
      if (info && info.reconstruido) {
        return res.status(409).json({
          error: 'RECONSTRUCCION_YA_APLICADA',
          mensaje: `Este tenant ya fue reconstruido el ${String(info.fechaReconstruccion || '').slice(0, 10)}. Volver a hacerlo duplicaría todo el histórico.`,
          detalle: info
        });
      }
    }

    const informe = await ledger.reconstruirHistorico({
      adminId,
      dryRun: !confirmar,
      usuarioId: req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email
    });

    if (confirmar) {
      await auditar({
        accion: 'RECONSTRUIR_KARDEX',
        descripcion: `${req.user.nombre || req.user.email} reconstruyó el histórico de inventario: ${informe.movimientosGenerados} movimientos, ${informe.productosConDiferencia} productos con diferencia`,
        usuarioId: req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        datos: {
          movimientos: informe.movimientosGenerados,
          diferencias: informe.productosConDiferencia,
          valorDiferencias: informe.valorTotalDiferencias
        }
      });
    }

    res.json(informe);
  } catch (e) {
    console.error('POST reconstruir:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
