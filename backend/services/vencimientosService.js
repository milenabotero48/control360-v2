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
  // Soportes y accesorios del extintor
  'canastilla', 'soporte', 'porta extintor', 'portaextintor', 'base extintor',
  'gabinete', 'garantia', 'garantía',
  'señalizacion', 'señalización', 'senalizacion', 'vinilo',
  // ✅ Repuestos y partes: llevan "extintor" en la categoría pero no se
  // recargan. Sin esto se le crea vencimiento a una válvula o un tornillo y
  // al año siguiente el sistema llama al cliente a "renovar" un repuesto.
  'manguera', 'manometro', 'manómetro',
  'valvula', 'válvula', 'cilindro', 'cilindros', 'tornillo',
  'partes del extintor', 'repuesto', 'repuestos',
  // Servicios que no generan ciclo de recarga
  'pintura', 'alquiler',
];

const textoDelItem = (item = {}) =>
  `${item.categoria || ''} ${item.nombre || ''} ${item.descripcion || ''}`
    .toLowerCase().trim();

// ─── Palabras que SÍ son el servicio de recarga ─────────────────────────────
// Distinción clave: "recarga"/"mantenimiento" describen el SERVICIO que abre
// el ciclo de 12 meses. "extintor" a secas describe un PRODUCTO, y ese
// producto puede ser el equipo (vence) o un repuesto (no vence).
// Por eso el servicio manda siempre, y la palabra "extintor" queda sujeta a
// la lista de exclusiones. Sin esta separación, "PINTURA EXTINTOR DE 10 LB"
// y "VALVULA GRANDE [PARTES DEL EXTINTOR]" generaban vencimiento.
const PALABRAS_SERVICIO = [
  'recarga y mantenimiento', 'recargas y mantenimiento',
  'recarga', 'recargas', 'mantenimiento',
  'prueba hidrostatica', 'prueba hidrostática',
  'hidrostatica', 'hidrostática',
];

// Excepciones dentro del servicio: mantener partes no abre ciclo de recarga.
const SERVICIO_NO_VENCE = ['otras partes', 'de partes'];

// El NOMBRE describe la cosa; la CATEGORÍA solo dice en qué estante vive.
// Cuando se contradicen, manda el nombre: "CILINDROS 20 LBS ABC" está en la
// categoría RECARGA Y MANTENIMIENTO pero es un repuesto, no una recarga.
const esItemConVencimiento = (item = {}) => {
  const texto = textoDelItem(item);
  if (!texto) return false;
  const nombre = String(item.nombre || item.descripcion || '').toLowerCase().trim();

  // 1. El nombre EMPIEZA con el servicio ("RECARGA ...", "MANTENIMIENTO ...").
  //    Es lo más confiable que hay: es el servicio, punto.
  if (PALABRAS_SERVICIO.some(p => nombre.startsWith(p))) {
    return !SERVICIO_NO_VENCE.some(p => texto.includes(p));
  }

  // 2. El nombre es un repuesto o un servicio que no abre ciclo, aunque la
  //    categoría diga otra cosa.
  if (PALABRAS_EXCLUIDAS.some(p => nombre.includes(p))) return false;

  // 3. El servicio aparece en la categoría y el nombre no lo contradice.
  if (PALABRAS_SERVICIO.some(p => texto.includes(p))) {
    return !SERVICIO_NO_VENCE.some(p => texto.includes(p));
  }

  // 4. Producto: acá sí aplican todas las exclusiones sobre el texto completo.
  if (PALABRAS_EXCLUIDAS.some(p => texto.includes(p))) return false;
  return PALABRAS_VENCIMIENTO.some(p => texto.includes(p));
};

// ─── Kit de carretera: UN vencimiento por kit, no uno por componente ─────────
// El kit se vende como varios ítems sueltos (alfombra, linterna, chaleco,
// herramientas) que comparten la categoría "KIT DE CARRETERA". Sin esta regla,
// una sola venta de kit generaba CINCO vencimientos y cuatro eran de cosas que
// no se recargan nunca. Regla definida por Sandra: un kit vendido = un
// vencimiento, a nombre del kit.
const PALABRAS_KIT = ['kit de carretera', 'kit carretera'];

const esItemKit = (item = {}) => {
  const texto = textoDelItem(item);
  return PALABRAS_KIT.some(p => texto.includes(p));
};

// ─── ¿El ítem ES el kit, o es un accesorio suelto de esa categoría? ─────────
// Regla definida por Sandra: el vencimiento nace SOLO si se vendió el kit.
// En la categoría "KIT DE CARRETERA" conviven el producto kit (KIT BASICO) y
// accesorios que se venden sueltos (chaleco, linterna, alfombra, taco,
// cruceta). Sin esta distinción, quien compraba un chaleco quedaba con un
// vencimiento de "KIT DE CARRETERA" y al año siguiente Anny lo llamaba a
// renovar un kit que nunca compró.
//
// KIT DE HERRAMIENTAS es un juego de herramientas, NO un kit de carretera.
const PALABRAS_NO_SON_KIT = ['herramienta', 'herramientas'];

const esProductoKit = (item = {}) => {
  const nom = String(item.nombre || item.descripcion || '').toLowerCase();
  if (!nom.includes('kit')) return false;
  if (PALABRAS_NO_SON_KIT.some(p => nom.includes(p))) return false;
  return true;
};

// Cuántos kits se vendieron: la suma de las cantidades de los productos kit.
const contarKits = (productosKit = []) =>
  productosKit.reduce((s, i) => s + (Number(i.cantidad) || 1), 0) || 1;

// ═════════════════════════════════════════════════════════════════════════════
// QUÉ VENCIMIENTOS GENERA UNA ORDEN — fuente única de verdad
// ─────────────────────────────────────────────────────────────────────────────
// La usa tanto la creación real como la simulación del script de recuperación.
// Si estuviera duplicada, la simulación podría mostrar una cosa y escribirse
// otra: exactamente el tipo de mentira que causó todo este problema.
// Devuelve [{ descripcion, cantidad, esKit }].
// ═════════════════════════════════════════════════════════════════════════════
const vencimientosDeItems = (items = []) => {
  const aplican = (items || []).filter(esItemConVencimiento);
  if (!aplican.length) return [];

  // Todo lo que pertenece al mundo "kit de carretera" (producto o accesorio)
  const delMundoKit = aplican.filter(esItemKit);
  // El resto (recargas, extintores, mantenimiento, PH) genera uno cada uno.
  const itemsSueltos = aplican.filter(i => !esItemKit(i));

  const salida = itemsSueltos.map(i => ({
    descripcion: String(i.nombre || i.descripcion || 'Extintor').trim(),
    cantidad: Number(i.cantidad) || 1,
    esKit: false,
  }));

  // Solo si se vendió el PRODUCTO kit nace el vencimiento, y uno solo:
  // los accesorios que lo acompañan quedan absorbidos. Si la orden trae
  // únicamente accesorios sueltos, no vence nada.
  const productosKit = delMundoKit.filter(esProductoKit);
  if (productosKit.length) {
    salida.push({
      descripcion: 'KIT DE CARRETERA',
      cantidad: contarKits(productosKit),
      esKit: true,
    });
  }
  return salida;
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
// `opciones.cerrarCiclos` (default true): en el uso normal hay que cerrar el
// ciclo anterior del cliente. En la recuperación retroactiva se apaga, porque
// cerrarCiclosAnteriores escanea hasta 3000 documentos POR ORDEN y con 565
// órdenes serían más de un millón de lecturas. Para ese caso existe el
// endpoint masivo /vencimientos/cerrar-ciclos-servidos, que lo hace de una.
const crearVencimientosDeOrden = async (adminId, orden = {}, opciones = {}) => {
  const { cerrarCiclos = true } = opciones;
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

    // Misma función que usa la simulación del script de recuperación.
    const aCrear = vencimientosDeItems(items);
    if (!aCrear.length) return { creados: 0, motivo: 'sin ítems con vencimiento' };

    const batch = db.batch();
    let creados = 0;

    for (const item of aCrear) {
      const descripcion = item.descripcion;
      const cantidad = item.cantidad;
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
        esKit: item.esKit || false,
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
    if (cerrarCiclos) {
      await cerrarCiclosAnteriores(adminId, {
        clienteId,
        telefono,
        sucursal: orden.sucursal || orden.sucursalDireccion || null,
        ordenId,
        mesServicio,
      });
    }

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
  esItemKit,
  vencimientosDeItems,
  PALABRAS_VENCIMIENTO,
  PALABRAS_EXCLUIDAS,
  PALABRAS_KIT,
  cerrarCiclosAnteriores,
  normalizarTelefono,
  archivarVencimientosViejos,
  iniciarCronArchivado,
};
