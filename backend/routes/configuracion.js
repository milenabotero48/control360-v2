const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
// ✅ FIX NUMERACION-001: reutiliza el MISMO helper de orders.js — evita
// duplicar la lógica de inicialización del contador atómico.
const ordersRouter = require('./orders');
const asegurarContadorInicializado = ordersRouter.asegurarContadorInicializado;

// Configuración por defecto para nuevos suscriptores
const FORMAS_PAGO_DEFAULT = [
  { nombre: 'Efectivo',         tipo: 'fisico',       activa: true, orden: 1 },
  { nombre: 'Transferencia',    tipo: 'digital',      activa: true, orden: 2 },
  { nombre: 'Nequi',            tipo: 'digital',      activa: true, orden: 3 },
  { nombre: 'Daviplata',        tipo: 'digital',      activa: true, orden: 4 },
  { nombre: 'Datafono',         tipo: 'fisico',       activa: true, orden: 5 },
  { nombre: 'Cheque',           tipo: 'fisico',       activa: false, orden: 6 },
  { nombre: 'A crédito (CxC)',  tipo: 'credito',      activa: true, orden: 7 },
];

// ─── LÍNEAS DE SERVICIO — Ola 3 ─────────────────────────────────────────────
// Las "líneas de servicio" agrupan los SERVICIOS (mano de obra) que vende la
// empresa. Cada línea tiene un INGRESO (lo cobrado por servicios de esa línea)
// y un COSTO (insumos asociados a esa línea). La utilidad por línea sale de:
//
//    Ingreso de servicios de la línea − Costo de insumos de la línea
//
// Importante: los PRODUCTOS (lámparas, botiquines, extintores nuevos, etc.)
// NO usan línea de servicio. Su costo va directo del precioCosto del producto.
//
// Cómo se determina la línea de un servicio: la categoría del producto
// (Recarga, Mantenimiento, Hidrostática, Señalización, etc.) se asocia con
// una línea desde el módulo de productos.
const LINEAS_SERVICIO_DEFAULT = [
  { id: 'lin_recargas',     nombre: 'Recargas y Mantenimiento', color: '#dc2626', activa: true, orden: 1 },
  { id: 'lin_senalizacion', nombre: 'Señalización',             color: '#f59e0b', activa: true, orden: 2 },
  { id: 'lin_otros',        nombre: 'Otros servicios',          color: '#6b7280', activa: true, orden: 99 },
];

// ─── CATEGORÍAS DE EGRESOS — actualizada Ola 3 ──────────────────────────────
// Cada categoría tiene 2 niveles de clasificación contable:
//
//   tipoERI:
//     'costo_servicio'      — Costo directo de una línea de servicio (insumos
//                              taller, compra de señales). Afecta utilidad bruta
//                              de servicios. Requiere lineaServicioId.
//     'costo_producto'      — Costo de compra de productos para vender (NO se
//                              usa en categorías porque el costo está en el
//                              producto). Solo para reservado.
//     'gasto_personal'      — Nómina, prestaciones, capacitaciones, etc.
//     'gasto_operativo'     — Transporte, mantenimiento de equipos, papelería
//     'gasto_fijo'          — Arriendo, servicios públicos, internet
//     'gasto_administrativo'— Marketing, publicidad, contabilidad externa
//     'gasto_financiero'    — Intereses, comisiones bancarias
//     'gasto_fiscal'        — Impuestos, retenciones (la Retefuente la práctica
//                              el sistema automáticamente desde CxC)
//     'compra_inventario'   — ✅ ERI-COSTO-001: compra de mercancía para stock.
//                              NO es gasto NI costo del período: es convertir
//                              dinero en inventario (un activo). NO resta en el
//                              ERI. Se muestra aparte, informativo, para que el
//                              movimiento de dinero no se pierda. El costo real
//                              se causa cuando la mercancía se VENDE (costo de
//                              ventas por categoría, calculado desde productos).
//
//   lineaServicioId:
//     Solo aplica para tipoERI = 'costo_servicio'. En las demás es null.
//
// Sandra puede crear más categorías y asignar lineas en la UI.
const CATEGORIAS_DEFAULT = [
  { nombre: 'Insumos taller (recargas)',  tipoERI: 'costo_servicio',  lineaServicioId: 'lin_recargas',     activa: true, orden: 1 },
  { nombre: 'Compra de señales',          tipoERI: 'costo_servicio',  lineaServicioId: 'lin_senalizacion', activa: true, orden: 2 },
  { nombre: 'Insumos otros servicios',    tipoERI: 'costo_servicio',  lineaServicioId: 'lin_otros',        activa: false, orden: 3 },
  { nombre: 'Transporte / Combustible',   tipoERI: 'gasto_operativo', lineaServicioId: null, activa: true, orden: 4 },
  { nombre: 'Arriendo',                   tipoERI: 'gasto_fijo',      lineaServicioId: null, activa: true, orden: 5 },
  { nombre: 'Servicios públicos',         tipoERI: 'gasto_fijo',      lineaServicioId: null, activa: true, orden: 6 },
  { nombre: 'Papelería',                  tipoERI: 'gasto_operativo', lineaServicioId: null, activa: true, orden: 7 },
  { nombre: 'Mantenimiento equipos',      tipoERI: 'gasto_operativo', lineaServicioId: null, activa: true, orden: 8 },
  { nombre: 'Nómina',                     tipoERI: 'gasto_personal',  lineaServicioId: null, activa: true, orden: 9 },
  { nombre: 'Marketing',                  tipoERI: 'gasto_administrativo', lineaServicioId: null, activa: false, orden: 10 },
  { nombre: 'Comisiones bancarias',       tipoERI: 'gasto_financiero', lineaServicioId: null, activa: true, orden: 11 },
  { nombre: 'Impuestos',                  tipoERI: 'gasto_fiscal',    lineaServicioId: null, activa: true, orden: 12 },
  // ✅ ERI-COSTO-001: compra de mercancía va como inventario, NO como gasto/costo
  { nombre: 'Compra de mercancía',        tipoERI: 'compra_inventario', lineaServicioId: null, activa: true, orden: 13 },
  { nombre: 'Otros',                      tipoERI: 'gasto_operativo', lineaServicioId: null, activa: true, orden: 14 },
];

// ─── RETENCIONES — Ola 2.5 Bloque 3 ─────────────────────────────────────────
// Catálogo de tipos de retención que el mensajero puede elegir al cobrar una
// CxC. Estándares de Colombia. El admin los puede activar/desactivar o crear
// adicionales desde la UI.
const RETENCIONES_DEFAULT = [
  { id: 'rte_compras_4',     etiqueta: 'Retención Renta Compras',   porcentaje: 4,    tipo: 'renta',  activo: true,  orden: 1 },
  { id: 'rte_servicios_6',   etiqueta: 'Retención Renta Servicios', porcentaje: 6,    tipo: 'renta',  activo: true,  orden: 2 },
  { id: 'rte_iva_15',        etiqueta: 'ReteIVA',                    porcentaje: 15,   tipo: 'iva',    activo: true,  orden: 3 },
  { id: 'rte_ica_com_07',    etiqueta: 'ReteICA Comercial',          porcentaje: 0.7,  tipo: 'ica',    activo: true,  orden: 4 },
  { id: 'rte_ica_srv_10',    etiqueta: 'ReteICA Servicios',          porcentaje: 1.0,  tipo: 'ica',    activo: true,  orden: 5 },
  { id: 'rte_personalizado', etiqueta: 'Personalizado (digitar %)',  porcentaje: null, tipo: 'custom', activo: true,  orden: 99 },
];

// ─── SECTORES — Mini-Ola 2.6 ────────────────────────────────────────────────
// Los sectores agrupan clientes/sucursales geográficamente para que logística
// organice las rutas. Son configurables por admin: en Cali pueden ser Norte/
// Sur/Centro/Oriente; en Medellín podrían ser Poblado/Laureles/etc.
//
// Sandra puede asignar el sector al crear el cliente, al crear/editar la
// sucursal o desde Logística cuando el mensajero llegue a una orden sin
// sector. Si una orden tiene sucursal → toma sucursal.sectorId. Si no tiene
// sucursal → toma cliente.sectorId. Si ninguno tiene → "Sin Asignar".
const SECTORES_DEFAULT = [
  { id: 'sec_norte',       etiqueta: 'Norte',        color: '#0284c7', activo: true, orden: 1 },
  { id: 'sec_sur',         etiqueta: 'Sur',          color: '#dc2626', activo: true, orden: 2 },
  { id: 'sec_oriente',     etiqueta: 'Oriente',      color: '#16a34a', activo: true, orden: 3 },
  { id: 'sec_occidente',   etiqueta: 'Occidente',    color: '#7c3aed', activo: true, orden: 4 },
  { id: 'sec_centro',      etiqueta: 'Centro',       color: '#f59e0b', activo: true, orden: 5 },
  { id: 'sec_periferia',   etiqueta: 'Periferia',    color: '#6b7280', activo: true, orden: 6 },
];

// ✅ OTROS-INGRESOS-001: conceptos de ingresos NO operacionales (recuperación
// de cartera, venta de chatarra, reintegros...). Configurables por el
// suscriptor. El tipo "Otros ingresos" es fijo — siempre va al ERI como no
// operacional, separado de las ventas del período.
const CONCEPTOS_OTROS_INGRESOS_DEFAULT = [
  { id: 'oi_cartera',  nombre: 'Recuperación de cartera', activo: true },
  { id: 'oi_otro',     nombre: 'Otro ingreso',            activo: true },
];

// Helper: obtener o crear doc de configuración del usuario
const getConfigRef = (userId) => db.collection('configuracion').doc(userId);

const inicializarConfigSiNoExiste = async (userId) => {
  const ref = getConfigRef(userId);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({
      userId,
      formasPago: FORMAS_PAGO_DEFAULT,
      categoriasEgresos: CATEGORIAS_DEFAULT,
      retenciones: RETENCIONES_DEFAULT,
      sectores: SECTORES_DEFAULT,
      lineasServicio: LINEAS_SERVICIO_DEFAULT,  // Ola 3
      conceptosOtrosIngresos: CONCEPTOS_OTROS_INGRESOS_DEFAULT, // ✅ OTROS-INGRESOS-001
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return {
      formasPago: FORMAS_PAGO_DEFAULT,
      categoriasEgresos: CATEGORIAS_DEFAULT,
      retenciones: RETENCIONES_DEFAULT,
      sectores: SECTORES_DEFAULT,
      lineasServicio: LINEAS_SERVICIO_DEFAULT,
      conceptosOtrosIngresos: CONCEPTOS_OTROS_INGRESOS_DEFAULT // ✅ OTROS-INGRESOS-001
    };
  }
  const data = doc.data();
  // Auto-seed de retenciones (suscriptores anteriores a Ola 2.5)
  if (!Array.isArray(data.retenciones) || data.retenciones.length === 0) {
    await ref.set({ retenciones: RETENCIONES_DEFAULT }, { merge: true });
    data.retenciones = RETENCIONES_DEFAULT;
  }
  // Auto-seed de sectores (suscriptores anteriores a Mini-Ola 2.6)
  if (!Array.isArray(data.sectores) || data.sectores.length === 0) {
    await ref.set({ sectores: SECTORES_DEFAULT }, { merge: true });
    data.sectores = SECTORES_DEFAULT;
  }
  // Auto-seed de líneas de servicio (suscriptores anteriores a Ola 3)
  if (!Array.isArray(data.lineasServicio) || data.lineasServicio.length === 0) {
    await ref.set({ lineasServicio: LINEAS_SERVICIO_DEFAULT }, { merge: true });
    data.lineasServicio = LINEAS_SERVICIO_DEFAULT;
  }
  // Ola 3: migrar categorías viejas que solo tienen tipoERI sin lineaServicioId.
  // Las categorías "costo_operativo" del modelo viejo se reclasifican a
  // "gasto_operativo" (más conservador). El admin puede luego marcarlas como
  // "costo_servicio" si aplica.
  if (Array.isArray(data.categoriasEgresos) && data.categoriasEgresos.length > 0) {
    let necesitaMigrar = false;
    const migradas = data.categoriasEgresos.map(c => {
      const tieneLinea = c.lineaServicioId !== undefined;
      const tipoViejo = c.tipoERI === 'costo_operativo';
      if (!tieneLinea || tipoViejo) {
        necesitaMigrar = true;
        return {
          ...c,
          tipoERI: tipoViejo ? 'gasto_operativo' : (c.tipoERI || 'gasto_operativo'),
          lineaServicioId: c.lineaServicioId !== undefined ? c.lineaServicioId : null
        };
      }
      return c;
    });
    if (necesitaMigrar) {
      await ref.set({ categoriasEgresos: migradas }, { merge: true });
      data.categoriasEgresos = migradas;
    }
  }
  return data;
};

// ─── GET /api/configuracion ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const config = await inicializarConfigSiNoExiste(req.adminId || req.user.uid);
    res.json(config);
  } catch (e) {
    console.error('GET configuracion:', e);
    res.status(500).json({ error: 'Error al obtener configuración' });
  }
});

// ─── PUT /api/configuracion/formas-pago ───────────────────────────────────────
router.put('/formas-pago', async (req, res) => {
  try {
    const { formasPago } = req.body;
    if (!Array.isArray(formasPago)) return res.status(400).json({ error: 'formasPago debe ser un array' });

    // Validar que cada forma tenga nombre
    for (const fp of formasPago) {
      if (!fp.nombre?.trim()) return res.status(400).json({ error: 'Cada forma de pago debe tener nombre' });
    }

    const ref = getConfigRef(req.adminId || req.user.uid);
    await ref.set({
      userId: req.adminId || req.user.uid,
      formasPago,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'FORMAS_PAGO_ACTUALIZADAS', modulo: 'configuracion',
      descripcion: `Formas de pago actualizadas (${formasPago.length} registros)`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, formasPago });
  } catch (e) {
    console.error('PUT formas-pago:', e);
    res.status(500).json({ error: 'Error al guardar formas de pago' });
  }
});

// ─── PUT /api/configuracion/categorias ───────────────────────────────────────
router.put('/categorias', async (req, res) => {
  try {
    const { categoriasEgresos } = req.body;
    if (!Array.isArray(categoriasEgresos)) return res.status(400).json({ error: 'categoriasEgresos debe ser un array' });

    // Tipos válidos contables (Ola 3)
    const TIPOS_ERI_VALIDOS = [
      'costo_servicio', 'gasto_personal', 'gasto_operativo',
      'gasto_fijo', 'gasto_administrativo', 'gasto_financiero', 'gasto_fiscal',
      'compra_inventario' // ✅ ERI-COSTO-001: faltaba — sin esto se rechazaba al reclasificar
    ];

    for (const c of categoriasEgresos) {
      if (!c.nombre?.trim()) return res.status(400).json({ error: 'Cada categoría debe tener nombre' });
      if (c.tipoERI && !TIPOS_ERI_VALIDOS.includes(c.tipoERI)) {
        return res.status(400).json({ error: `tipoERI inválido en "${c.nombre}": ${c.tipoERI}` });
      }
      // Si es costo_servicio, debe tener lineaServicioId
      if (c.tipoERI === 'costo_servicio' && !c.lineaServicioId) {
        return res.status(400).json({
          error: `La categoría "${c.nombre}" es Costo de Servicio. Debes asignarle una línea de servicio.`
        });
      }
      // Si NO es costo_servicio, forzar lineaServicioId a null
      if (c.tipoERI !== 'costo_servicio') {
        c.lineaServicioId = null;
      }
    }

    const ref = getConfigRef(req.adminId || req.user.uid);
    await ref.set({
      userId: req.adminId || req.user.uid,
      categoriasEgresos,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'CATEGORIAS_ACTUALIZADAS', modulo: 'configuracion',
      descripcion: `Categorías de egresos actualizadas (${categoriasEgresos.length} registros)`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, categoriasEgresos });
  } catch (e) {
    console.error('PUT categorias:', e);
    res.status(500).json({ error: 'Error al guardar categorías' });
  }
});

// ─── ✅ OTROS-INGRESOS-001: PUT /api/configuracion/conceptos-otros-ingresos ────
router.put('/conceptos-otros-ingresos', async (req, res) => {
  try {
    const { conceptosOtrosIngresos } = req.body;
    if (!Array.isArray(conceptosOtrosIngresos)) {
      return res.status(400).json({ error: 'conceptosOtrosIngresos debe ser un array' });
    }
    for (const c of conceptosOtrosIngresos) {
      if (!c.nombre?.trim()) return res.status(400).json({ error: 'Cada concepto debe tener nombre' });
    }
    const ref = getConfigRef(req.adminId || req.user.uid);
    await ref.set({
      userId: req.adminId || req.user.uid,
      conceptosOtrosIngresos,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'CONCEPTOS_OTROS_INGRESOS_ACTUALIZADOS', modulo: 'configuracion',
      descripcion: `Conceptos de otros ingresos actualizados (${conceptosOtrosIngresos.length})`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, conceptosOtrosIngresos });
  } catch (e) {
    console.error('PUT conceptos-otros-ingresos:', e);
    res.status(500).json({ error: 'Error al guardar conceptos' });
  }
});

// ─── PUT /api/configuracion/mapeo-cajas ──────────────────────────────────────
// Asocia cada forma de pago a una caja destino
router.put('/mapeo-cajas', async (req, res) => {
  try {
    const { mapeoCajas } = req.body;
    // { "Efectivo": "cajaId1", "Transferencia": "cajaId2", ... }
    if (typeof mapeoCajas !== 'object') return res.status(400).json({ error: 'mapeoCajas debe ser un objeto' });

    const ref = getConfigRef(req.adminId || req.user.uid);
    await ref.set({
      userId: req.adminId || req.user.uid,
      mapeoCajas,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true, mapeoCajas });
  } catch (e) {
    console.error('PUT mapeo-cajas:', e);
    res.status(500).json({ error: 'Error al guardar mapeo de cajas' });
  }
});

// ─── PUT /api/configuracion/retenciones — Ola 2.5 Bloque 3 ─────────────────
// Permite al admin gestionar el catálogo de retenciones que verá el mensajero
// al cobrar. Valida estructura mínima de cada retención.
router.put('/retenciones', async (req, res) => {
  try {
    const { retenciones } = req.body;
    if (!Array.isArray(retenciones)) {
      return res.status(400).json({ error: 'retenciones debe ser un array' });
    }

    // Validar cada retención
    for (const r of retenciones) {
      if (!r.etiqueta || !r.etiqueta.trim()) {
        return res.status(400).json({ error: 'Cada retención debe tener etiqueta' });
      }
      if (!r.id || !r.id.trim()) {
        return res.status(400).json({ error: 'Cada retención debe tener un id único' });
      }
      // porcentaje puede ser null (custom) o número >= 0
      if (r.porcentaje !== null && (isNaN(Number(r.porcentaje)) || Number(r.porcentaje) < 0)) {
        return res.status(400).json({ error: `Porcentaje inválido en "${r.etiqueta}"` });
      }
    }

    // Validar que no haya IDs duplicados
    const ids = retenciones.map(r => r.id);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Hay retenciones con el mismo id' });
    }

    const userId = req.adminId || req.user.uid;
    const ref = getConfigRef(userId);
    await ref.set({
      userId,
      retenciones,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'RETENCIONES_ACTUALIZADAS', modulo: 'configuracion',
      descripcion: `Catálogo de retenciones actualizado (${retenciones.length} registros)`,
      usuarioId: userId, usuarioNombre: req.user.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, retenciones });
  } catch (e) {
    console.error('PUT retenciones:', e);
    res.status(500).json({ error: 'Error al guardar retenciones' });
  }
});

// ─── PUT /api/configuracion/sectores — Mini-Ola 2.6 ────────────────────────
// Permite al admin gestionar el catálogo de sectores geográficos. Cada
// suscriptor define los suyos (Cali, Medellín, etc tendrán nombres distintos).
router.put('/sectores', async (req, res) => {
  try {
    const { sectores } = req.body;
    if (!Array.isArray(sectores)) {
      return res.status(400).json({ error: 'sectores debe ser un array' });
    }

    // Validar cada sector
    for (const s of sectores) {
      if (!s.etiqueta || !s.etiqueta.trim()) {
        return res.status(400).json({ error: 'Cada sector debe tener etiqueta' });
      }
      if (!s.id || !s.id.trim()) {
        return res.status(400).json({ error: 'Cada sector debe tener un id único' });
      }
    }

    // No duplicar IDs
    const ids = sectores.map(s => s.id);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Hay sectores con el mismo id' });
    }

    const userId = req.adminId || req.user.uid;
    const ref = getConfigRef(userId);
    await ref.set({
      userId,
      sectores,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'SECTORES_ACTUALIZADOS', modulo: 'configuracion',
      descripcion: `Catálogo de sectores actualizado (${sectores.length} registros)`,
      usuarioId: userId, usuarioNombre: req.user.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, sectores });
  } catch (e) {
    console.error('PUT sectores:', e);
    res.status(500).json({ error: 'Error al guardar sectores' });
  }
});

// ─── PUT /api/configuracion/lineas-servicio — Ola 3 ────────────────────────
// Permite al admin gestionar las líneas de servicio que componen su negocio.
// Las líneas se usan en el ERI para calcular utilidad por línea.
router.put('/lineas-servicio', async (req, res) => {
  try {
    const { lineasServicio } = req.body;
    if (!Array.isArray(lineasServicio)) {
      return res.status(400).json({ error: 'lineasServicio debe ser un array' });
    }

    for (const l of lineasServicio) {
      if (!l.nombre || !l.nombre.trim()) {
        return res.status(400).json({ error: 'Cada línea debe tener nombre' });
      }
      if (!l.id || !l.id.trim()) {
        return res.status(400).json({ error: 'Cada línea debe tener un id único' });
      }
    }

    const ids = lineasServicio.map(l => l.id);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'Hay líneas con el mismo id' });
    }

    const userId = req.adminId || req.user.uid;
    const ref = getConfigRef(userId);
    await ref.set({
      userId,
      lineasServicio,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'LINEAS_SERVICIO_ACTUALIZADAS', modulo: 'configuracion',
      descripcion: `Líneas de servicio actualizadas (${lineasServicio.length} registros)`,
      usuarioId: userId, usuarioNombre: req.user.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, lineasServicio });
  } catch (e) {
    console.error('PUT lineas-servicio:', e);
    res.status(500).json({ error: 'Error al guardar líneas de servicio' });
  }
});


// ─── GET/PUT /api/configuracion/metas — Metas del dashboard por adminId ──────
router.get('/metas', authenticate, async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const ref = db.collection('configuracion').doc(adminId);
    const doc = await ref.get();
    const metas = doc.exists ? (doc.data().metas || {}) : {};
    const defaults = { metaVentas: 25000000, metaDomicilios: 80, metaExtintores: 50 };
    res.json({ ...defaults, ...metas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/metas', authenticate, async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const { metaVentas, metaDomicilios, metaExtintores } = req.body;
    const metas = {};
    if (metaVentas !== undefined)     metas.metaVentas     = Number(metaVentas);
    if (metaDomicilios !== undefined) metas.metaDomicilios = Number(metaDomicilios);
    if (metaExtintores !== undefined) metas.metaExtintores = Number(metaExtintores);
    await db.collection('configuracion').doc(adminId).set(
      { metas, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    res.json({ ok: true, metas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NUMERACIÓN DE ÓRDENES DE SERVICIO — el suscriptor elige prefijo y número
// inicial de sus propias Órdenes de Servicio (tipo 'servicio' → prefijo OS
// por defecto). Vive sobre el MISMO contador atómico que usa orders.js
// (counters/{adminId}_orders_servicio) — una sola fuente de verdad, sin
// riesgo de que este ajuste quede desincronizado del contador real.
//
// Reglas:
//   - Solo afecta órdenes NUEVAS. Las ya creadas conservan su número.
//   - No se permite un número inicial que choque con órdenes ya existentes
//     que usen el mismo prefijo (evita duplicados).
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/configuracion/numeracion
router.get('/numeracion', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid || req.user.id;

    // Garantiza que el contador exista y refleje el histórico real antes
    // de mostrarlo (mismo helper que usa la creación de órdenes).
    await asegurarContadorInicializado('servicio', adminId);

    const counterRef = db.collection('counters').doc(`${adminId}_orders_servicio`);
    const doc = await counterRef.get();
    const data = doc.exists ? doc.data() : {};

    const prefijo = data.prefijo || 'OS';
    const siguienteNumero = (Number(data.value) || 0) + 1;

    res.json({ prefijo, siguienteNumero });
  } catch (e) {
    console.error('GET numeracion:', e);
    res.status(500).json({ error: 'Error al consultar la numeración' });
  }
});

// PUT /api/configuracion/numeracion — body: { prefijo, siguienteNumero }
router.put('/numeracion', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid || req.user.id;
    let { prefijo, siguienteNumero } = req.body;

    // Sanitizar: solo letras y números, mayúsculas (el guion va aparte,
    // fijo, entre prefijo y consecutivo — igual que hoy: OS-0001).
    prefijo = String(prefijo || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!prefijo) {
      return res.status(400).json({ error: 'El prefijo es obligatorio (solo letras y números, sin espacios ni símbolos)' });
    }
    if (prefijo.length > 10) {
      return res.status(400).json({ error: 'El prefijo no puede tener más de 10 caracteres' });
    }

    siguienteNumero = parseInt(siguienteNumero, 10);
    if (!Number.isInteger(siguienteNumero) || siguienteNumero < 1 || siguienteNumero > 999999) {
      return res.status(400).json({ error: 'El número inicial debe ser un entero entre 1 y 999999' });
    }

    // ✅ FIX NUMERACION-001: evitar choques con Órdenes de Servicio ya
    // existentes que usen ese mismo prefijo.
    const snap = await db.collection('orders')
      .where('adminId', '==', adminId)
      .where('tipoOrden', '==', 'servicio')
      .get();

    let maximoConEsePrefijo = 0;
    snap.forEach(doc => {
      const partes = String(doc.data().numeroOrden || '').split('-');
      if (partes.length === 2 && partes[0] === prefijo) {
        const n = parseInt(partes[1], 10);
        if (!isNaN(n) && n > maximoConEsePrefijo) maximoConEsePrefijo = n;
      }
    });

    if (siguienteNumero <= maximoConEsePrefijo) {
      return res.status(400).json({
        error: `Ya existe ${prefijo}-${String(maximoConEsePrefijo).padStart(4, '0')}. El número inicial debe ser mayor a ${maximoConEsePrefijo}.`
      });
    }

    const counterRef = db.collection('counters').doc(`${adminId}_orders_servicio`);
    await counterRef.set({
      value: siguienteNumero - 1,
      tipo: 'servicio',
      adminId,
      prefijo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('audit_logs').add({
      accion: 'NUMERACION_OS_ACTUALIZADA', modulo: 'configuracion',
      descripcion: `Numeración de Órdenes de Servicio actualizada: próxima orden será ${prefijo}-${String(siguienteNumero).padStart(4, '0')}`,
      usuarioId: adminId, usuarioNombre: req.user.email,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.json({ ok: true, prefijo, siguienteNumero });
  } catch (e) {
    console.error('PUT numeracion:', e);
    res.status(500).json({ error: 'Error al guardar la numeración' });
  }
});

module.exports = router;
