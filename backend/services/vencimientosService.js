// ============================================================
// Control360 — Servicio de Vencimientos
// Ubicación: backend/services/vencimientosService.js
// ------------------------------------------------------------
// REGLA DE NEGOCIO (definida por Sandra, Jul 2026) — VENC-CREACION-001
//
//   "Orden creada que tenga extintores, recargas, mantenimiento o kit de
//    carretera pasa a vencimiento y listo. Igual que hoy una orden entra a
//    CxC al crearse. Si luego la anulan, sale de vencimiento."
//
// POR QUÉ CAMBIÓ (lo que estaba mal antes):
//   El disparo vivía en DOS endpoints y ambos exigían que el estado fuera
//   'completada' en ese instante: orders.js al crear (solo si nacía
//   completada) y workshop.js al cerrar taller. Pero según construirFlujo,
//   'en_taller' avanza a 'completada' en UN solo caso (oficina sin factura);
//   en domicilio, despacho y taller avanza a 'facturado' o 'en_ruta_entrega',
//   y el salto final lo hace otro módulo que no tenía hook.
//   Medición sobre los 5 suscriptores con operación real: 565 de 1.594
//   órdenes nunca generaron vencimiento (35%). En los tenants CON taller la
//   fuga llegaba al 55%. TODOS los caminos que pasaban por taller daban CERO.
//
// POR QUÉ EL DISPARO VA EN LA CREACIÓN Y NO EN EL CIERRE:
//   El tiempo del pago no tiene nada que ver con el tiempo del servicio. Una
//   orden a 60 días ya entregó el equipo: el vencimiento corre desde que se
//   prestó el servicio, no desde que entra la plata. Atar el disparo a
//   'completada' dejaba sin vencimiento a todas las órdenes en CxC hasta que
//   pagaran — 42 casos así en un solo suscriptor.
//
// REGLAS VIGENTES:
//   1. TRIGGER: creación de la orden. Cualquier estado inicial, cualquier
//      lugar de atención. Excluye producción e internas: no son ventas.
//   2. FECHA: se toma el mes de la ORDEN, no el mes de hoy. Una orden de
//      mayo registrada en julio vence en mayo del año siguiente.
//   3. VENCE: mes de la orden + 12 meses, guardado como 'YYYY-MM-01'.
//   4. IDEMPOTENTE: si la orden ya tiene vencimientos, no duplica.
//   5. ANULACIÓN: al anular la orden, sus vencimientos se retiran.
//   6. CICLOS: al nacer el vencimiento nuevo se cierra el anterior del mismo
//      cliente/sucursal (VENC-CICLO-001), que queda como RENOVADO.
//   7. AISLAMIENTO: toda operación filtra por adminId (multi-tenant).
//   8. NO BLOQUEA: si falla, la orden sigue su flujo. Pero el error queda en
//      audit_logs — antes se lo tragaba un .catch(() => {}).
// ============================================================

const { db, admin } = require('../config/firebase');
// ✅ VENC-TOPE-001: el panel lee de una caché por tenant. Si creamos o
// retiramos vencimientos hay que invalidarla, o la orden recién creada no
// aparecería hasta que expire el TTL.
const cacheVenc = require('./vencimientosCache');

// ─── Palabras que identifican un ítem con vencimiento ────────────────────────
// Se buscan en la categoría Y en el nombre: los suscriptores nombran sus
// productos de formas distintas y no todos usan categorías consistentes.
const PALABRAS_VENCIMIENTO = [
  'recarga y mantenimiento', 'recargas y mantenimiento',
  'recarga', 'recargas', 'mantenimiento',
  'extintor', 'extintores',
  'prueba hidrostatica', 'prueba hidrostática',
  'hidrostatica', 'hidrostática',
  // ✅ VENC-CREACION-001: el kit de carretera lleva extintor y también vence.
  'kit de carretera', 'kit carretera',
];

// ─── Accesorios que traen la palabra pero NO vencen ──────────────────────────
// Sin esta lista, "CANASTILLA MET EXTINTOR 5 LBS" (un soporte metálico) o un
// ítem "GARANTIA" dentro de la categoría de extintores generaban vencimiento,
// y el sistema terminaba llamando al cliente a recargar una canastilla.
const PALABRAS_EXCLUIDAS = [
  'canastilla', 'soporte', 'porta extintor', 'portaextintor', 'base extintor',
  'gabinete', 'garantia', 'garantía',
  'señalizacion', 'señalización', 'senalizacion', 'vinilo',
  'manguera', 'manometro', 'manómetro',
];

const textoDelItem = (item = {}) =>
  `${item.categoria || ''} ${item.nombre || ''} ${item.descripcion || ''}`
    .toLowerCase().trim();

const esItemConVencimiento = (item = {}) => {
  const texto = textoDelItem(item);
  if (!texto) return false;
  if (PALABRAS_EXCLUIDAS.some(p => texto.includes(p))) return false;
  return PALABRAS_VENCIMIENTO.some(p => texto.includes(p));
};

// ─── Mes de una fecha, tolerante al tipo que venga de Firestore ──────────────
// Railway corre en UTC y Colombia es UTC-5: se resta el desfase antes de
// tomar el mes, para que una orden del día 1 no se corra al mes anterior.
const mesDeFecha = (valor) => {
  if (!valor) return null;
  try {
    if (typeof valor === 'string') {
      const m = valor.match(/^(\d{4})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}`;
      const d = new Date(valor);
      if (!isNaN(d)) return new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
      return null;
    }
    if (typeof valor.toDate === 'function') {
      return new Date(valor.toDate().getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
    }
    if (valor instanceof Date && !isNaN(valor)) {
      return new Date(valor.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
    }
  } catch (e) { /* formato inesperado → se cae al mes actual */ }
  return null;
};

const mesActualColombia = () =>
  new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 7);

// ─── Mes de vencimiento = mes del servicio + 12 meses, día 01 ────────────────
const calcularMesVencimiento = (yyyymm) => {
  const [y, m] = yyyymm.split('-').map(Number);
  const total = m + 12;
  const anio = y + Math.floor((total - 1) / 12);
  const mes = ((total - 1) % 12) + 1;
  return `${anio}-${String(mes).padStart(2, '0')}-01`;
};

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

// ─── Auditoría de fallos (antes se perdían en silencio) ──────────────────────
const auditarFallo = async (adminId, ordenId, mensaje) => {
  try {
    await db.collection('audit_logs').add({
      accion: 'VENCIMIENTO_FALLIDO',
      modulo: 'vencimientos',
      descripcion: `No se pudo crear el vencimiento de la orden ${ordenId}: ${mensaje}`,
      adminId: adminId || null,
      ordenId: ordenId || null,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error('[VENC] no se pudo auditar el fallo:', e.message); }
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ VENC-CICLO-001 — cerrar el ciclo anterior
// Cuando el cliente vuelve a recargar, el vencimiento del año pasado deja de
// perseguirse: queda RENOVADO. Sin esto, la campaña del mes arrastraría
// clientes que ya vinieron.
// ═════════════════════════════════════════════════════════════════════════════
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
      cacheVenc.invalidar(adminId);
      console.log(`[VENC-CICLO] Orden ${ordenId}: ${cerrados} ciclo(s) anterior(es) cerrado(s)`);
    }
    return { cerrados };
  } catch (e) {
    console.error('[VENC-CICLO] Error cerrando ciclos anteriores:', e.message);
    return { cerrados: 0, error: e.message };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// CREAR los vencimientos de una orden
// Idempotente. Uso normal (fire-and-forget, nunca bloquea la orden):
//   crearVencimientosDeOrden(adminId, { ...orden, id: ref.id }).catch(() => {});
// ═════════════════════════════════════════════════════════════════════════════
const crearVencimientosDeOrden = async (adminId, orden = {}) => {
  const ordenId = orden.id || null;
  try {
    if (!adminId || !ordenId) return { creados: 0, motivo: 'sin adminId u ordenId' };

    // Producción e internas no son ventas: no generan vencimiento.
    const tipo = String(orden.tipoOrden || '').toLowerCase();
    if (tipo === 'produccion' || tipo === 'interna') {
      return { creados: 0, motivo: 'orden de producción o interna' };
    }
    // Una orden anulada nunca debe dejar vencimiento.
    if (String(orden.estado || '').toLowerCase() === 'anulada') {
      return { creados: 0, motivo: 'orden anulada' };
    }

    const items = (orden.items || []).filter(esItemConVencimiento);
    if (!items.length) return { creados: 0, motivo: 'sin ítems con vencimiento' };

    const clienteId = orden.clienteId || orden.cliente?.id || null;
    // ✅ orders.js usa clienteCelular y workshop.js no mapeaba nada: se
    // aceptan todos los alias para que el teléfono nunca se pierda.
    const telefono = orden.clienteTelefono || orden.clienteCelular
      || orden.telefono || orden.cliente?.telefono || null;
    if (!clienteId && !telefono) {
      await auditarFallo(adminId, ordenId, 'la orden no tiene clienteId ni teléfono');
      return { creados: 0, motivo: 'sin cliente ni teléfono' };
    }

    // ✅ IDEMPOTENCIA: ¿esta orden ya generó vencimientos?
    const yaExiste = await db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .where('ordenId', '==', ordenId)
      .limit(1).get();
    if (!yaExiste.empty) return { creados: 0, motivo: 'ya existían (idempotencia)' };

    // ✅ FECHA REAL DE LA ORDEN, no la de hoy.
    const mesServicio = mesDeFecha(orden.fecha)
      || mesDeFecha(orden.fechaOrden)
      || mesDeFecha(orden.createdAt)
      || mesActualColombia();
    const mesVencimiento = calcularMesVencimiento(mesServicio);

    const batch = db.batch();
    let creados = 0;

    for (const item of items) {
      const descripcion = String(item.nombre || item.descripcion || 'Extintor').trim();
      const cantidad = Number(item.cantidad) || 1;
      const ref = db.collection('vencimientos').doc();
      batch.set(ref, {
        adminId,
        clienteId: clienteId || null,
        telefono: telefono || null,
        sucursal: orden.sucursal || null,
        descripcionEquipo: descripcion,
        cantidad,
        mesServicio,                             // 'YYYY-MM' del servicio
        fechaUltimaRecarga: `${mesServicio}-01`, // mismo esquema del importador
        fechaVencimiento: mesVencimiento,        // 'YYYY-MM-01'
        gestionado: false,
        origenDato: 'orden',
        ordenId,
        numeroOrden: orden.numeroOrden || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      creados++;
    }

    if (creados > 0) {
      await batch.commit();
      cacheVenc.invalidar(adminId);
      console.log(`[VENC] Orden ${orden.numeroOrden || ordenId}: ${creados} vencimientos → ${mesVencimiento}`);
    }

    // ✅ VENC-CICLO-001: cerrar el ciclo anterior. Va DESPUÉS del commit para
    // que el vencimiento nuevo ya exista y no se cierre a sí mismo.
    await cerrarCiclosAnteriores(adminId, {
      clienteId,
      telefono,
      sucursal: orden.sucursal || orden.sucursalDireccion || null,
      ordenId,
      mesServicio,
    });

    return { creados, mesServicio, mesVencimiento };
  } catch (e) {
    console.error('[VENC] Error creando vencimientos:', e.message);
    await auditarFallo(adminId, ordenId, e.message);
    return { creados: 0, error: e.message };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ANULAR los vencimientos de una orden — VENC-CREACION-001
// "Si luego la anulan, sale de vencimiento."
// Solo toca los vencimientos con origenDato 'orden' que apunten a ESTA orden:
// los importados manualmente jamás se borran desde acá.
// ═════════════════════════════════════════════════════════════════════════════
const anularVencimientosDeOrden = async (adminId, ordenId) => {
  try {
    if (!adminId || !ordenId) return { eliminados: 0 };

    const snap = await db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .where('ordenId', '==', ordenId)
      .get();
    if (snap.empty) return { eliminados: 0 };

    const batch = db.batch();
    let eliminados = 0;
    snap.docs.forEach(d => {
      // Cinturón: nunca borrar un vencimiento que vino de importación.
      if ((d.data().origenDato || 'orden') !== 'orden') return;
      batch.delete(d.ref);
      eliminados++;
    });
    if (eliminados > 0) {
      await batch.commit();
      cacheVenc.invalidar(adminId);
      console.log(`[VENC] Orden ${ordenId} anulada: ${eliminados} vencimientos retirados`);
    }
    return { eliminados };
  } catch (e) {
    console.error('[VENC] Error anulando vencimientos:', e.message);
    await auditarFallo(adminId, ordenId, `anulación: ${e.message}`);
    return { eliminados: 0, error: e.message };
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

    const tenantsTocados = new Set();
    for (let i = 0; i < viejos.length; i += 450) {
      const batch = db.batch();
      viejos.slice(i, i + 450).forEach(d => {
        tenantsTocados.add(d.data().adminId);
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
    // VENC-TOPE-001: el cron toca varios tenants, hay que refrescarles la caché.
    tenantsTocados.forEach(t => cacheVenc.invalidar(t));

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
  anularVencimientosDeOrden,
  esItemConVencimiento,
  PALABRAS_VENCIMIENTO,
  PALABRAS_EXCLUIDAS,
  cerrarCiclosAnteriores,
  normalizarTelefono,
  archivarVencimientosViejos,
  iniciarCronArchivado,
};
