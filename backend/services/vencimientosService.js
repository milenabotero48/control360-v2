// ============================================================
// Control360 — Servicio de Vencimientos
// Ubicación: backend/services/vencimientosService.js
// ------------------------------------------------------------
// REGLAS DE NEGOCIO (validadas con Sandra, Jun 2026):
//
// 1. TRIGGER: órdenes con items de categoría
//    "RECARGA Y MANTENIMIENTO" o "EXTINTORES"
//    (mismo filtro que el certificado de recarga)
//
// 2. FECHA: solo importa el MES — no el día.
//    Servicio en junio 2026 → vence junio 2027.
//    Se guarda como "YYYY-MM-01" (primer día del mes de vencimiento)
//
// 3. ANTI-DUPLICADO: clienteId + telefono + descripcionEquipo + mesVencimiento
//    Si el mismo cliente recarga el mismo equipo en el mismo mes → renueva
//
// 4. AISLAMIENTO: toda operación filtra por adminId (multi-tenant)
//
// 5. FIRE-AND-FORGET: si falla, la orden sigue su flujo normal
// ============================================================

const { db, admin } = require('../config/firebase');

// ─── Categorías que generan vencimiento (igual que el certificado) ────────────
const PALABRAS_VENCIMIENTO = [
  'recarga y mantenimiento', 'recarga', 'mantenimiento',
  'extintor', 'extintores',
  'prueba hidrostatica', 'prueba hidrostática',
  'hidrostatica', 'hidrostática',
];

const esItemConVencimiento = (item = {}) => {
  const cat = (item.categoria || '').toLowerCase().trim();
  const nom = (item.nombre   || '').toLowerCase().trim();
  return PALABRAS_VENCIMIENTO.some(p => cat.includes(p) || nom.includes(p));
};

// ─── Calcular mes de vencimiento (+12 meses, siempre día 01) ─────────────────
const calcularMesVencimiento = (yyyymm) => {
  // yyyymm = "YYYY-MM"
  const [y, m] = yyyymm.split('-').map(Number);
  const total  = m + 12;
  const anio   = y + Math.floor((total - 1) / 12);
  const mes    = ((total - 1) % 12) + 1;
  return `${anio}-${String(mes).padStart(2, '0')}-01`;
};

// ─── Mes actual en Colombia (UTC-5) ──────────────────────────────────────────
const mesActualColombia = () => {
  const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
  return ahoraCO.toISOString().slice(0, 7); // "YYYY-MM"
};

// ─── Función principal ────────────────────────────────────────────────────────
// Llama desde logistics.js, workshop.js, y donde se creen órdenes de oficina
// Siempre fire-and-forget: crearVencimientosDeOrden(...).catch(() => {})
const crearVencimientosDeOrden = async (adminId, orden) => {
  try {
    const items = (orden.items || []).filter(esItemConVencimiento);
    if (!items.length) return;

    const clienteId = orden.clienteId || orden.cliente?.id || null;
    const telefono  = orden.clienteTelefono || orden.telefono || orden.cliente?.telefono || null;

    if (!clienteId && !telefono) {
      console.log('[VENC] Sin clienteId ni teléfono — omitiendo orden', orden.id);
      return;
    }

    const mesServicio    = mesActualColombia(); // "YYYY-MM"
    const mesVencimiento = calcularMesVencimiento(mesServicio); // "YYYY+1-MM-01"

    const batch = db.batch();
    let creados = 0, renovados = 0;

    for (const item of items) {
      const descripcion = (item.nombre || item.descripcion || 'Extintor').trim();
      const cantidad    = Number(item.cantidad) || 1;

      // Anti-dup: buscar por clienteId (o telefono) + equipo + mesVencimiento
      let snap = null;
      if (clienteId) {
        snap = await db.collection('vencimientos')
          .where('adminId',        '==', adminId)
          .where('clienteId',      '==', clienteId)
          .where('descripcionEquipo', '==', descripcion)
          .where('fechaVencimiento',  '==', mesVencimiento)
          .limit(1).get();
      }
      // Si no encontró por clienteId, buscar por teléfono como respaldo
      if ((!snap || snap.empty) && telefono) {
        snap = await db.collection('vencimientos')
          .where('adminId',           '==', adminId)
          .where('telefono',          '==', telefono)
          .where('descripcionEquipo', '==', descripcion)
          .where('fechaVencimiento',  '==', mesVencimiento)
          .limit(1).get();
      }

      if (snap && !snap.empty) {
        // Ya existe → renovar (actualizar fecha de servicio y orden)
        batch.update(snap.docs[0].ref, {
          mesServicio,
          clienteId: clienteId || snap.docs[0].data().clienteId,
          telefono:  telefono  || snap.docs[0].data().telefono,
          cantidad,
          ordenId:   orden.id || null,
          gestionado: false, // vuelve a pendiente con la nueva fecha
          updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
        });
        renovados++;
      } else {
        // Nuevo
        const ref = db.collection('vencimientos').doc();
        batch.set(ref, {
          adminId,
          clienteId:          clienteId || null,
          telefono:           telefono  || null,
          sucursal:           orden.sucursal || null,
          descripcionEquipo:  descripcion,
          cantidad,
          mesServicio,          // "YYYY-MM" — mes en que se hizo la recarga
          fechaVencimiento:  mesVencimiento, // "YYYY-MM-01" — primer día del mes que vence
          gestionado:        false,
          origenDato:        'orden',
          ordenId:           orden.id || null,
          createdAt:         admin.firestore.FieldValue.serverTimestamp(),
        });
        creados++;
      }
    }

    if (creados + renovados > 0) {
      await batch.commit();
      console.log(`[VENC] Orden ${orden.id}: ${creados} creados, ${renovados} renovados`);
    }
  } catch (e) {
    console.error('[VENC] Error procesando orden:', e.message);
  }
};

module.exports = { crearVencimientosDeOrden, esItemConVencimiento, PALABRAS_VENCIMIENTO };
