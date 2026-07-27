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

// ═════════════════════════════════════════════════════════════════════════════
// ✅ CIERRE DE CICLO — VENC-CICLO-001 (2026-07-27)
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA DETECTADO: cuando un cliente venía a recargar, el sistema creaba el
// vencimiento del año siguiente pero DEJABA VIVO el vencimiento vencido. El
// cliente quedaba con dos, y el viejo seguía en la lista con gestionado:false.
// Consecuencia real: Lucy llamaba a clientes que habían pagado días antes para
// decirles que su extintor estaba vencido. Plata perdida y mala imagen.
//
// REGLAS (definidas con Sandra):
//  · Se identifica al cliente por TELÉFONO (no por descripción del equipo): la
//    gente trae de una todo lo que tiene vencido, no equipo por equipo.
//  · Solo se cierran los VENCIDOS. Los vigentes (vencen en meses futuros) se
//    respetan: un cliente con 10 extintores en fechas distintas que recarga los
//    4 vencidos no puede perder las otras 6 recargas.
//  · Se mira hacia ATRÁS sin límite de meses: en este negocio es normal que
//    venza en mayo y el cliente aparezca en julio.
//  · EMPRESAS: si la orden y el vencimiento tienen sucursal/dirección, deben
//    coincidir. Una misma persona aprueba varias sedes, y recargar en una no
//    puede cerrar los vencimientos de otra.
// ═════════════════════════════════════════════════════════════════════════════

// Últimos 10 dígitos — tolera +57, espacios, guiones y prefijos.
const normalizarTelefono = (t) => {
  if (!t) return null;
  const d = String(t).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
};

const normalizarSucursal = (s) =>
  String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();

// ¿La sucursal de la orden corresponde a la del vencimiento?
// Si a cualquiera de los dos le falta el dato, se acepta: es preferible cerrar
// de más en clientes de una sola sede que dejar el ciclo abierto para siempre.
const mismaSucursal = (sucursalOrden, sucursalVenc) => {
  const a = normalizarSucursal(sucursalOrden);
  const b = normalizarSucursal(sucursalVenc);
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
};

const cerrarCiclosAnteriores = async (adminId, { clienteId, telefono, sucursal, ordenId, mesServicio }) => {
  try {
    const telNorm = normalizarTelefono(telefono);
    if (!telNorm && !clienteId) return { cerrados: 0 };

    // Frontera: todo lo que vence HASTA el último día del mes de servicio.
    // Un vencimiento de agosto no se cierra con una orden de julio.
    const limite = `${mesServicio}-31`;

    // Firestore no soporta OR: se consulta por cada clave y se unifica por id.
    const candidatos = new Map();

    if (clienteId) {
      const s = await db.collection('vencimientos')
        .where('adminId', '==', adminId)
        .where('clienteId', '==', clienteId)
        .where('gestionado', '==', false)
        .limit(300).get();
      s.docs.forEach(d => candidatos.set(d.id, d));
    }

    if (telNorm) {
      // El teléfono puede estar guardado con distintos formatos; se filtra en
      // memoria contra la forma normalizada.
      const s = await db.collection('vencimientos')
        .where('adminId', '==', adminId)
        .where('gestionado', '==', false)
        .limit(3000).get();
      s.docs.forEach(d => {
        if (normalizarTelefono(d.data().telefono) === telNorm) candidatos.set(d.id, d);
      });
    }

    if (!candidatos.size) return { cerrados: 0 };

    const batch = db.batch();
    let cerrados = 0;

    candidatos.forEach(doc => {
      const v = doc.data();
      if (!v.fechaVencimiento) return;
      if (v.fechaVencimiento > limite) return;                 // aún vigente
      if (!mismaSucursal(sucursal, v.sucursal)) return;        // otra sede
      if (v.ordenId === ordenId) return;                       // el que acaba de nacer

      batch.update(doc.ref, {
        gestionado: true,
        estadoCiclo: 'RENOVADO',
        cerradoPorOrdenId: ordenId || null,
        cerradoMotivo: 'servicio_facturado',
        cerradoAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      cerrados++;
    });

    if (cerrados) {
      await batch.commit();
      console.log(`[VENC-CICLO] Orden ${ordenId}: ${cerrados} ciclo(s) anterior(es) cerrado(s)`);
    }
    return { cerrados };
  } catch (e) {
    console.error('[VENC-CICLO] Error cerrando ciclos anteriores:', e.message);
    return { cerrados: 0, error: e.message };
  }
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

    // ✅ VENC-CICLO-001: cerrar el ciclo anterior. Va DESPUÉS del commit para
    // que el vencimiento nuevo ya exista y no se cierre a sí mismo.
    await cerrarCiclosAnteriores(adminId, {
      clienteId,
      telefono,
      sucursal: orden.sucursal || orden.sucursalDireccion || null,
      ordenId: orden.id || null,
      mesServicio,
    });
  } catch (e) {
    console.error('[VENC] Error procesando orden:', e.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ ARCHIVADO AUTOMÁTICO — VENC-CICLO-004
// ─────────────────────────────────────────────────────────────────────────────
// Sin esto, al cerrar el año habría doce meses apilados de clientes que nunca
// volvieron, y cada campaña tendría que revolver toda esa acumulación.
//
// Regla (definida con Sandra): un vencimiento con más de 6 MESES de vencido
// pasa a PERDIDO y sale de la base activa. Seis y no cuatro porque en este
// negocio es normal que el cliente aparezca uno o dos meses tarde.
//
// NO se borra nada: queda con estadoCiclo PERDIDO para campañas de
// reactivación anuales, que es distinto a perseguirlo todos los meses. Y si el
// cliente vuelve, cerrarCiclosAnteriores lo reactiva solo.
// ═════════════════════════════════════════════════════════════════════════════
const MESES_PARA_PERDIDO = Number(process.env.VENC_MESES_PERDIDO) || 6;

const archivarVencimientosViejos = async () => {
  try {
    const hoyCO = new Date(Date.now() - 5 * 3600 * 1000);
    const corte = new Date(hoyCO.getFullYear(), hoyCO.getMonth() - MESES_PARA_PERDIDO, 1)
      .toISOString().slice(0, 10);

    const snap = await db.collection('vencimientos')
      .where('gestionado', '==', false)
      .limit(2000)
      .get();

    const viejos = snap.docs.filter(d => {
      const f = d.data().fechaVencimiento;
      return f && f < corte;
    });
    if (!viejos.length) return { archivados: 0 };

    for (let i = 0; i < viejos.length; i += 450) {
      const batch = db.batch();
      viejos.slice(i, i + 450).forEach(d => {
        batch.update(d.ref, {
          gestionado: true,
          estadoCiclo: 'PERDIDO',
          motivoPerdido: `sin_servicio_mas_de_${MESES_PARA_PERDIDO}_meses`,
          archivadoAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
    }

    console.log(`[VENC-CICLO] Archivados ${viejos.length} vencimiento(s) con más de ${MESES_PARA_PERDIDO} meses`);
    return { archivados: viejos.length };
  } catch (e) {
    console.error('[VENC-CICLO] Error archivando vencimientos viejos:', e.message);
    return { archivados: 0, error: e.message };
  }
};

// Cron diario a las 4 AM Colombia — fuera de horario de operación.
const iniciarCronArchivado = () => {
  let ultimaEjecucion = null;
  const verificar = () => {
    const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
    const hoy = ahoraCO.toISOString().slice(0, 10);
    if (ahoraCO.getUTCHours() !== 4) return;
    if (ultimaEjecucion === hoy) return;
    ultimaEjecucion = hoy;
    archivarVencimientosViejos().catch(e => console.error('[VENC-CICLO-CRON]', e.message));
  };
  setInterval(verificar, 30 * 60 * 1000);
  console.log(`✅ Cron de archivado de vencimientos activo — PERDIDO tras ${MESES_PARA_PERDIDO} meses`);
};

module.exports = {
  crearVencimientosDeOrden,
  esItemConVencimiento,
  PALABRAS_VENCIMIENTO,
  cerrarCiclosAnteriores,
  normalizarTelefono,
  archivarVencimientosViejos,
  iniciarCronArchivado,
};
