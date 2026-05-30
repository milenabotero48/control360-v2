const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

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

const CATEGORIAS_DEFAULT = [
  { nombre: 'Insumos taller',           tipoERI: 'costo_operativo',  activa: true, orden: 1 },
  { nombre: 'Transporte / Combustible', tipoERI: 'gasto_operativo',  activa: true, orden: 2 },
  { nombre: 'Arriendo',                 tipoERI: 'gasto_fijo',       activa: true, orden: 3 },
  { nombre: 'Servicios públicos',       tipoERI: 'gasto_fijo',       activa: true, orden: 4 },
  { nombre: 'Papelería',                tipoERI: 'gasto_operativo',  activa: true, orden: 5 },
  { nombre: 'Mantenimiento',            tipoERI: 'gasto_operativo',  activa: true, orden: 6 },
  { nombre: 'Nómina',                   tipoERI: 'gasto_personal',   activa: true, orden: 7 },
  { nombre: 'Marketing',                tipoERI: 'gasto_operativo',  activa: false, orden: 8 },
  { nombre: 'Impuestos',                tipoERI: 'gasto_fiscal',     activa: true, orden: 9 },
  { nombre: 'Otros',                    tipoERI: 'gasto_operativo',  activa: true, orden: 10 },
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return {
      formasPago: FORMAS_PAGO_DEFAULT,
      categoriasEgresos: CATEGORIAS_DEFAULT,
      retenciones: RETENCIONES_DEFAULT,
      sectores: SECTORES_DEFAULT
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

    for (const c of categoriasEgresos) {
      if (!c.nombre?.trim()) return res.status(400).json({ error: 'Cada categoría debe tener nombre' });
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

module.exports = router;
