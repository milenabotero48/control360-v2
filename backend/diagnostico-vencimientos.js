/**
 * Control360 — DIAGNÓSTICO del módulo Vencimientos
 * ─────────────────────────────────────────────────────────────────────────────
 * 100% SOLO LECTURA. No escribe, no borra, no actualiza nada en Firestore.
 * Lo único que escribe es un archivo .json local con el reporte.
 * Puede correrse en producción sin riesgo y las veces que quieras.
 *
 * ─── MODOS ───────────────────────────────────────────────────────────────────
 *   node diagnostico-vencimientos.js --listar
 *       Lista los suscriptores (tenants) con su adminId, plan y módulos.
 *
 *   node diagnostico-vencimientos.js --todos
 *       AUDITORÍA DEL SISTEMA COMPLETO. Recorre todos los suscriptores y
 *       entrega una tabla comparativa + agregados globales. Es el modo para
 *       responder "¿esto le está pasando a todos?".
 *
 *   node diagnostico-vencimientos.js <adminId>
 *   node diagnostico-vencimientos.js --email correo@suscriptor.com
 *       Diagnóstico PROFUNDO de un solo suscriptor, con ejemplos de órdenes
 *       huérfanas, categorías vistas y clientes sin vencimiento.
 *
 * ─── QUÉ MIDE ────────────────────────────────────────────────────────────────
 *   A. Configuración: módulos/capacidades y el IVA de cada empresa facturadora
 *   B. Dónde están los clientes: clients vs prospectos vs vencimientos
 *   C. Órdenes huérfanas: llevaban ítems que generan vencimiento y no existe
 *   D. Vencimientos reales por mes contra el tope de 2000 del panel
 *   E. Clientes sin ningún vencimiento (invisibles para el panel)
 */

require('dotenv').config();
const fs = require('fs');
const { db } = require('./config/firebase');

// ═════════════════════════════════════════════════════════════════════════════
// FILTROS REPLICADOS TAL CUAL DEL CÓDIGO DE PRODUCCIÓN
// Si cambian allá, hay que cambiarlos aquí. No se importan los módulos reales
// para que este script corra aislado y no arrastre dependencias del server.
// ═════════════════════════════════════════════════════════════════════════════

// services/vencimientosService.js → PALABRAS_VENCIMIENTO
const PALABRAS_VENCIMIENTO = [
  'recarga y mantenimiento', 'recarga', 'mantenimiento',
  'extintor', 'extintores',
  'prueba hidrostatica', 'prueba hidrostática',
  'hidrostatica', 'hidrostática',
];
const esItemConVencimiento = (item = {}) => {
  const cat = (item.categoria || '').toLowerCase().trim();
  const nom = (item.nombre || '').toLowerCase().trim();
  return PALABRAS_VENCIMIENTO.some(p => cat.includes(p) || nom.includes(p));
};

// services/capacidadesTenant.js → CLAVES
const CLAVES_CAPACIDAD = ['taller', 'logistica', 'cxc', 'qr'];

// routes/orders.js → el hook SOLO dispara si la orden NACE en este estado.
const ESTADO_QUE_DISPARA_HOOK = 'completada';

// routes/vencimientos.js → topes de los endpoints del panel
const TOPE_PANEL = 2000;   // GET /            .limit(2000)
const TOPE_RESUMEN = 5000; // GET /resumen     .limit(5000)

// ═════════════════════════════════════════════════════════════════════════════
// UTILIDADES DE PRESENTACIÓN
// ═════════════════════════════════════════════════════════════════════════════
const linea = (t = '') => console.log(t);
const titulo = (t) => {
  linea('');
  linea('═'.repeat(78));
  linea('  ' + t);
  linea('═'.repeat(78));
};
const sub = (t) => { linea(''); linea('── ' + t + ' ' + '─'.repeat(Math.max(0, 74 - t.length))); };
const num = (n) => String(n).padStart(7, ' ');
const pct = (parte, total) => total ? ((parte / total) * 100).toFixed(1) + '%' : '—';
const cortar = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n, ' ');
};
const imprimirConteo = (obj, etiquetaVacia = '(vacío)') => {
  const filas = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (!filas.length) { linea('   (sin datos)'); return; }
  filas.forEach(([k, v]) => linea(`   ${num(v)}  ${k || etiquetaVacia}`));
};

// ═════════════════════════════════════════════════════════════════════════════
// ACCESO A DATOS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Recorre una colección completa de un tenant en páginas de 1000.
 * `campos` usa .select() para no traer documentos enteros a memoria: con
 * 10.000 clientes y órdenes de muchos ítems, eso importa.
 */
async function recorrer(coleccion, adminId, campos, porDoc) {
  const TAM = 1000;
  let ultimo = null;
  let total = 0;
  for (;;) {
    let q = db.collection(coleccion).where('adminId', '==', adminId);
    if (campos && campos.length) q = q.select(...campos);
    q = q.orderBy('__name__').limit(TAM);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = await q.get();
    if (snap.empty) break;
    snap.docs.forEach(d => { total++; porDoc(d.id, d.data()); });
    ultimo = snap.docs[snap.docs.length - 1];
    if (snap.size < TAM) break;
  }
  return total;
}

/**
 * Conteo barato con agregación del servidor (no cobra por documento).
 * Si la versión del SDK no la soporta, cae al recorrido normal.
 */
async function contar(coleccion, adminId) {
  try {
    const r = await db.collection(coleccion).where('adminId', '==', adminId).count().get();
    return r.data().count;
  } catch (e) {
    let n = 0;
    await recorrer(coleccion, adminId, ['adminId'], () => { n++; });
    return n;
  }
}

/** Devuelve la lista de tenants (admins) del sistema. */
async function listarTenants() {
  const snap = await db.collection('users').get();
  const filas = [];
  snap.docs.forEach(d => {
    const u = d.data();
    // Un tenant es un admin: los usuarios operativos cuelgan de un adminId ajeno.
    const esAdmin = (u.role === 'admin') || (!u.adminId) || (u.adminId === d.id);
    if (!esAdmin) return;
    filas.push({
      adminId: d.id,
      nombre: u.nombre || u.empresa || '(sin nombre)',
      email: u.email || '—',
      plan: u.plan || u.tipoPlan || '—',
      modulos: Array.isArray(u.modulos) ? u.modulos : [],
      activo: u.activo !== false,
    });
  });
  filas.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
  return filas;
}

/** Capacidades efectivas — misma lógica que services/capacidadesTenant.js */
function capacidadesDe(modulos) {
  const caps = {};
  if (!modulos || modulos.length === 0) {
    // Invariante del sistema: lista vacía = TODOS los módulos activos.
    CLAVES_CAPACIDAD.forEach(k => { caps[k] = true; });
    return caps;
  }
  const set = new Set(modulos.map(m => String(m || '').toLowerCase().trim()));
  CLAVES_CAPACIDAD.forEach(k => { caps[k] = set.has(k); });
  return caps;
}

// ═════════════════════════════════════════════════════════════════════════════
// ANÁLISIS DE UN TENANT
// `detallado: false` omite la enumeración cliente por cliente (usa agregación)
// para que el barrido de todo el sistema sea liviano.
// ═════════════════════════════════════════════════════════════════════════════
async function analizarTenant(tenant, { detallado }) {
  const adminId = tenant.adminId;
  const capacidades = capacidadesDe(tenant.modulos);

  // ─── Empresas facturadoras y su IVA ────────────────────────────────────────
  const empresasSnap = await db.collection('companies').where('adminId', '==', adminId).get();
  const empresas = empresasSnap.docs.map(d => {
    const e = d.data();
    return { id: d.id, nombre: e.nombre || e.razonSocial || '(sin nombre)', iva: Number(e.iva) || 0 };
  });
  const empresasConIva = empresas.filter(e => e.iva > 0);

  // ─── Vencimientos (siempre completo: alimenta el cruce con órdenes) ────────
  const vencPorOrigenDato = {};
  const vencPorMes = {};
  const clientesConVenc = new Set();
  const ordenesConVenc = new Set();
  // ✅ Clave cliente+equipo para separar la fuga REAL del colapso del
  // anti-duplicado: cuando dos órdenes del mismo cliente y mismo equipo caen
  // en el mismo mes, el servicio RENUEVA el documento existente y le
  // sobreescribe el ordenId. La primera orden queda sin ordenId apuntándola y
  // parece huérfana, pero su vencimiento sí existe.
  const vencClienteEquipo = new Set();
  const normEquipo = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let vencSinClienteId = 0;
  let vencSinFecha = 0;
  const totalVencimientos = await recorrer(
    'vencimientos', adminId,
    ['clienteId', 'fechaVencimiento', 'origenDato', 'ordenId', 'descripcionEquipo'],
    (id, v) => {
      const o = v.origenDato || '(sin origenDato)';
      vencPorOrigenDato[o] = (vencPorOrigenDato[o] || 0) + 1;
      const mes = (v.fechaVencimiento || '').slice(0, 7);
      if (mes) vencPorMes[mes] = (vencPorMes[mes] || 0) + 1; else vencSinFecha++;
      if (v.clienteId) clientesConVenc.add(v.clienteId); else vencSinClienteId++;
      if (v.ordenId) ordenesConVenc.add(v.ordenId);
      if (v.clienteId) vencClienteEquipo.add(`${v.clienteId}|${normEquipo(v.descripcionEquipo)}`);
    }
  );

  // ─── Clientes y prospectos ─────────────────────────────────────────────────
  let totalClientes, totalProspectos;
  const clientesPorOrigen = {};
  const prospectosPorPeriodo = {};
  const prospectosPorEstado = {};
  const clienteNombre = new Map();
  const clienteOrigen = new Map();

  if (detallado) {
    totalClientes = await recorrer(
      'clients', adminId, ['nombre', 'origen', 'activo'],
      (id, c) => {
        const o = c.origen || '(sin origen)';
        clientesPorOrigen[o] = (clientesPorOrigen[o] || 0) + 1;
        clienteNombre.set(id, c.nombre || '(sin nombre)');
        clienteOrigen.set(id, o);
      }
    );
    totalProspectos = await recorrer(
      'prospectos', adminId, ['basePeriodo', 'estado'],
      (id, p) => {
        const b = p.basePeriodo || '(sin basePeriodo)';
        prospectosPorPeriodo[b] = (prospectosPorPeriodo[b] || 0) + 1;
        const e = p.estado || '(sin estado)';
        prospectosPorEstado[e] = (prospectosPorEstado[e] || 0) + 1;
      }
    );
  } else {
    totalClientes = await contar('clients', adminId);
    totalProspectos = await contar('prospectos', adminId);
  }

  // ─── Órdenes: el cruce que revela la fuga ──────────────────────────────────
  const porEstado = {};
  const porEstadoInicial = {};
  const porLugar = {};
  const matriz = {};
  const huerfanasPorMes = {};
  const huerfanasEjemplos = [];
  const categoriasVistas = {};
  // ✅ CAMINOS: la secuencia completa de estados por la que pasó la orden.
  // Es la prueba directa del mecanismo: el hook solo dispara si el camino
  // ENTRA a 'completada' desde orders.js (al crear) o desde workshop.js.
  // Los caminos que pasan por 'facturado' o 'listo_entregar' antes de
  // completarse pierden el vencimiento porque nadie lo crea en ese salto.
  const caminos = {};
  let totalOrdenes = 0, conItemsVenc = 0, sinItemsVenc = 0;
  let nacieronCompletada = 0, conVencimientoCreado = 0;
  let huerfanas = 0, sinClienteId = 0, itemsCategoriaVacia = 0;
  let huerfanaFugaReal = 0, huerfanaPosibleAntidup = 0;

  await recorrer(
    'orders', adminId,
    ['numeroOrden', 'estado', 'historialEstados', 'lugarAtencion', 'tipoOrden',
     'items', 'clienteId', 'clienteNombre', 'fecha', 'createdAt', 'fechaCompletada'],
    (id, o) => {
      totalOrdenes++;

      const estado = o.estado || '(sin estado)';
      porEstado[estado] = (porEstado[estado] || 0) + 1;

      const hist = Array.isArray(o.historialEstados) ? o.historialEstados : [];
      const inicial = (hist[0] && hist[0].estado) || '(sin historial)';
      porEstadoInicial[inicial] = (porEstadoInicial[inicial] || 0) + 1;

      const lugar = o.lugarAtencion || '(sin lugar)';
      porLugar[lugar] = (porLugar[lugar] || 0) + 1;

      const items = Array.isArray(o.items) ? o.items : [];
      if (detallado) {
        items.forEach(it => {
          const cat = (it.categoria || '').trim();
          if (!cat) itemsCategoriaVacia++;
          const k = cat || '(CATEGORÍA VACÍA)';
          categoriasVistas[k] = (categoriasVistas[k] || 0) + 1;
        });
      } else {
        items.forEach(it => { if (!String(it.categoria || '').trim()) itemsCategoriaVacia++; });
      }

      const tieneItems = items.some(esItemConVencimiento);
      if (tieneItems) conItemsVenc++; else sinItemsVenc++;
      if (inicial === ESTADO_QUE_DISPARA_HOOK) nacieronCompletada++;
      if (!o.clienteId) sinClienteId++;

      const tieneVenc = ordenesConVenc.has(id);
      if (tieneVenc) conVencimientoCreado++;

      const clave = `${inicial}  →  ${estado}`;
      if (!matriz[clave]) matriz[clave] = { total: 0, conItems: 0, conVenc: 0 };
      matriz[clave].total++;
      if (tieneItems) matriz[clave].conItems++;
      if (tieneVenc) matriz[clave].conVenc++;

      // ✅ Camino completo de estados (firma del flujo que siguió la orden)
      const camino = hist.length
        ? hist.map(h => h && h.estado).filter(Boolean).join(' → ')
        : `(sin historial) → ${estado}`;
      if (!caminos[camino]) caminos[camino] = { total: 0, conItems: 0, conVenc: 0 };
      caminos[camino].total++;
      if (tieneItems) caminos[camino].conItems++;
      if (tieneVenc) caminos[camino].conVenc++;

      if (tieneItems && !tieneVenc) {
        huerfanas++;
        const f = String(o.fecha || o.fechaCompletada || '').slice(0, 7)
          || (o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toISOString().slice(0, 7) : '(sin fecha)');
        huerfanasPorMes[f] = (huerfanasPorMes[f] || 0) + 1;

        // ¿Existe vencimiento para ese cliente+equipo aunque no apunte a esta
        // orden? Si existe → probable colapso del anti-duplicado, no fuga.
        const equiposDeLaOrden = items.filter(esItemConVencimiento)
          .map(i => normEquipo(i.nombre || i.descripcion || 'Extintor'));
        const cubierto = o.clienteId && equiposDeLaOrden
          .some(eq => vencClienteEquipo.has(`${o.clienteId}|${eq}`));
        if (cubierto) huerfanaPosibleAntidup++; else huerfanaFugaReal++;

        if (detallado && huerfanasEjemplos.length < 20) {
          huerfanasEjemplos.push({
            ordenId: id,
            numeroOrden: o.numeroOrden || '—',
            cliente: o.clienteNombre || clienteNombre.get(o.clienteId) || '(sin cliente)',
            estadoInicial: inicial,
            estadoActual: estado,
            lugar,
            camino,
            clasificacion: cubierto ? 'posible anti-duplicado' : 'FUGA REAL',
            items: items.filter(esItemConVencimiento)
              .map(i => `${i.categoria || '(sin cat)'} / ${i.nombre || ''}`).slice(0, 3),
          });
        }
      }
    }
  );

  // ─── Clientes sin ningún vencimiento ───────────────────────────────────────
  let sinVenc = [];
  const sinVencPorOrigen = {};
  if (detallado) {
    clienteNombre.forEach((nombre, id) => {
      if (!clientesConVenc.has(id)) {
        const origen = clienteOrigen.get(id);
        sinVenc.push({ id, nombre, origen });
        sinVencPorOrigen[origen] = (sinVencPorOrigen[origen] || 0) + 1;
      }
    });
  }

  return {
    tenant: { ...tenant, capacidades },
    empresas, empresasConIva,
    clientes: {
      totalClientes, totalProspectos, clientesPorOrigen,
      prospectosPorPeriodo, prospectosPorEstado,
      clientesConVencimiento: clientesConVenc.size,
      clientesSinVencimiento: detallado
        ? sinVenc.length
        : Math.max(0, totalClientes - clientesConVenc.size),
      sinVencPorOrigen,
      muestraSinVencimiento: sinVenc.slice(0, 500),
    },
    vencimientos: {
      total: totalVencimientos, vencPorOrigenDato, vencPorMes,
      vencSinClienteId, vencSinFecha,
      excedeTopePanel: totalVencimientos > TOPE_PANEL,
      ocultosPorTope: Math.max(0, totalVencimientos - TOPE_PANEL),
    },
    ordenes: {
      totalOrdenes, conItemsVenc, sinItemsVenc, nacieronCompletada,
      conVencimientoCreado, huerfanas, sinClienteId, itemsCategoriaVacia,
      huerfanaFugaReal, huerfanaPosibleAntidup,
      porEstado, porEstadoInicial, porLugar, matriz, caminos, huerfanasPorMes,
      categoriasVistas, huerfanasEjemplos,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// HALLAZGOS — misma función para un tenant y para el barrido global
// ═════════════════════════════════════════════════════════════════════════════
function hallazgosDe(a) {
  const h = [];
  a.empresasConIva.forEach(e =>
    h.push(`La empresa "${e.nombre}" tiene IVA ${e.iva}% → sus órdenes de oficina nacen "facturado" y NUNCA crean vencimiento.`));
  if (a.ordenes.huerfanas > 0)
    h.push(`${a.ordenes.huerfanas} órdenes con ítems válidos no tienen vencimiento (${pct(a.ordenes.huerfanas, a.ordenes.conItemsVenc)} de fuga).`);
  if (a.ordenes.nacieronCompletada < a.ordenes.conItemsVenc)
    h.push(`Solo ${a.ordenes.nacieronCompletada} de ${a.ordenes.conItemsVenc} órdenes que aplican nacieron en "completada", el único estado que dispara el hook.`);
  if (a.vencimientos.excedeTopePanel)
    h.push(`El panel oculta ${a.vencimientos.ocultosPorTope} vencimientos por el tope de ${TOPE_PANEL}.`);
  if (a.clientes.totalProspectos > 0)
    h.push(`${a.clientes.totalProspectos} registros están en Prospectos (Telemercadeo), no en Vencimientos: se importaron sin fecha de última recarga.`);
  if (a.ordenes.sinClienteId > 0)
    h.push(`${a.ordenes.sinClienteId} órdenes sin clienteId: el hook las omite por diseño.`);
  if (a.ordenes.itemsCategoriaVacia > 0)
    h.push(`${a.ordenes.itemsCategoriaVacia} ítems de orden llegan con categoría vacía: dependen de que el nombre traiga la palabra clave.`);
  return h;
}

// ═════════════════════════════════════════════════════════════════════════════
// MODO PROFUNDO — UN SOLO SUSCRIPTOR
// ═════════════════════════════════════════════════════════════════════════════
async function reportarUno(tenant) {
  const a = await analizarTenant(tenant, { detallado: true });

  titulo('A. CONFIGURACIÓN DEL SUSCRIPTOR');
  linea(`   Nombre        : ${tenant.nombre}`);
  linea(`   Email         : ${tenant.email}`);
  linea(`   adminId       : ${tenant.adminId}`);
  linea(`   Plan          : ${tenant.plan}`);
  linea(`   modulos       : ${tenant.modulos.length ? tenant.modulos.join(', ') : '(vacío = TODOS activos)'}`);
  linea('');
  linea('   Capacidades efectivas que consume la máquina de estados:');
  CLAVES_CAPACIDAD.forEach(k => linea(`     ${a.tenant.capacidades[k] ? '✔' : '✘'} ${k}`));

  sub('Empresas facturadoras y su IVA');
  linea('   Si iva > 0, requiereFacturaFinal = true y TODA orden de oficina nace');
  linea('   en "facturado", no en "completada". El hook solo dispara con');
  linea('   "completada" y no existe hook en las transiciones posteriores.');
  linea('');
  if (!a.empresas.length) linea('   (este tenant no tiene empresas en `companies`)');
  a.empresas.forEach(e => {
    linea(`   IVA ${String(e.iva).padStart(3)}%   ${e.nombre}${e.iva > 0 ? '  ⚠️  ROMPE EL HOOK' : ''}`);
  });

  titulo('B. ¿DÓNDE ESTÁN LOS CLIENTES?');
  linea(`   clients        ${num(a.clientes.totalClientes)}`);
  linea(`   prospectos     ${num(a.clientes.totalProspectos)}   ← importados SIN fecha de última recarga`);
  linea(`   vencimientos   ${num(a.vencimientos.total)}   documentos (un cliente puede tener varios)`);
  linea('');
  linea(`   Clientes CON al menos un vencimiento : ${num(a.clientes.clientesConVencimiento)}  (${pct(a.clientes.clientesConVencimiento, a.clientes.totalClientes)} de la base)`);
  linea(`   Clientes SIN ningún vencimiento      : ${num(a.clientes.clientesSinVencimiento)}  ← INVISIBLES para el panel`);

  sub('Clientes por origen');
  imprimirConteo(a.clientes.clientesPorOrigen);
  sub('Prospectos por base/periodo (lo que ves en Telemercadeo)');
  imprimirConteo(a.clientes.prospectosPorPeriodo);
  sub('Prospectos por estado');
  imprimirConteo(a.clientes.prospectosPorEstado);
  sub('Vencimientos por origen del dato');
  imprimirConteo(a.vencimientos.vencPorOrigenDato);
  if (a.vencimientos.vencSinClienteId)
    linea(`\n   ⚠️  ${a.vencimientos.vencSinClienteId} vencimientos SIN clienteId → el panel los muestra sin nombre`);
  if (a.vencimientos.vencSinFecha)
    linea(`   ⚠️  ${a.vencimientos.vencSinFecha} vencimientos SIN fechaVencimiento → estado SIN_FECHA`);

  titulo('C. ÓRDENES QUE DEBERÍAN HABER CREADO VENCIMIENTO');
  const o = a.ordenes;
  linea(`   Órdenes totales                         : ${num(o.totalOrdenes)}`);
  linea(`   Con ítems que SÍ generan vencimiento    : ${num(o.conItemsVenc)}  (${pct(o.conItemsVenc, o.totalOrdenes)})`);
  linea(`   Sin ítems que generen vencimiento       : ${num(o.sinItemsVenc)}`);
  linea(`   Nacieron en "completada" (dispara hook) : ${num(o.nacieronCompletada)}`);
  linea(`   Órdenes con su vencimiento creado       : ${num(o.conVencimientoCreado)}`);
  linea('');
  linea(`   ❌ HUÉRFANAS (debían crear vencimiento y NO existe): ${num(o.huerfanas)}  (${pct(o.huerfanas, o.conItemsVenc)} de las que aplican)`);
  linea(`        · FUGA REAL (ese cliente+equipo no está en vencimientos) : ${num(o.huerfanaFugaReal)}`);
  linea(`        · Posible colapso del anti-duplicado (sí está cubierto)  : ${num(o.huerfanaPosibleAntidup)}`);
  if (o.sinClienteId) linea(`   ⚠️  ${o.sinClienteId} órdenes sin clienteId → el hook las omite siempre`);

  sub('CAMINOS DE ESTADO — la prueba del mecanismo');
  linea('   Formato:  total / con ítems que aplican / con vencimiento creado');
  linea('');
  linea('   El hook solo existe en DOS puntos: al crear la orden si nace');
  linea('   "completada" (orders.js), y al completar taller si el siguiente');
  linea('   estado es "completada" (workshop.js). Un camino que pase por');
  linea('   "facturado" o "listo_entregar" antes de completarse NO tiene hook:');
  linea('   ese salto lo hace otro módulo y nadie crea el vencimiento.');
  linea('');
  Object.entries(o.caminos)
    .sort((a, b) => (b[1].conItems - b[1].conVenc) - (a[1].conItems - a[1].conVenc))
    .forEach(([k, v]) => {
      const fuga = v.conItems - v.conVenc;
      linea(`   ${String(v.total).padStart(5)} / ${String(v.conItems).padStart(5)} / ${String(v.conVenc).padStart(5)}   ${fuga > 0 ? '❌' : '✔ '} ${k}`);
    });

  sub('Estado ACTUAL de las órdenes');
  imprimirConteo(o.porEstado);
  sub('Estado INICIAL (el que decide si el hook dispara)');
  imprimirConteo(o.porEstadoInicial);
  sub('Lugar de atención');
  imprimirConteo(o.porLugar);

  sub('Matriz  estadoInicial → estadoActual   (total / con ítems / con vencimiento)');
  Object.entries(o.matriz).sort((x, y) => y[1].total - x[1].total).forEach(([k, v]) => {
    const fuga = v.conItems - v.conVenc;
    linea(`   ${String(v.total).padStart(6)} / ${String(v.conItems).padStart(6)} / ${String(v.conVenc).padStart(6)}   ${k}${fuga > 0 ? `  ← fuga de ${fuga}` : ''}`);
  });

  sub('Huérfanas por mes de la orden');
  imprimirConteo(o.huerfanasPorMes);

  sub('Categorías de ítem encontradas en las órdenes');
  linea('   Palabras que busca el sistema para reconocer un ítem con vencimiento:');
  linea(`   ${PALABRAS_VENCIMIENTO.join(' · ')}`);
  linea('');
  imprimirConteo(o.categoriasVistas);
  if (o.itemsCategoriaVacia)
    linea(`\n   ⚠️  ${o.itemsCategoriaVacia} ítems con categoría VACÍA → solo se salvan si el nombre trae la palabra`);

  if (o.huerfanasEjemplos.length) {
    sub('Ejemplos de órdenes huérfanas (para verificar a mano en la app)');
    o.huerfanasEjemplos.forEach(h => {
      linea('');
      linea(`   Orden ${h.numeroOrden}  ·  ${h.cliente}   [${h.clasificacion}]`);
      linea(`      lugar: ${h.lugar}`);
      linea(`      camino: ${h.camino}`);
      linea(`      ítems: ${h.items.join(' | ')}`);
    });
  }

  titulo('D. VENCIMIENTOS REALES POR MES  vs  LO QUE MUESTRA EL PANEL');
  linea(`   Documentos reales en la colección : ${num(a.vencimientos.total)}`);
  linea(`   Tope del listado del panel        : ${num(TOPE_PANEL)}`);
  linea(`   Tope de las tarjetas de resumen   : ${num(TOPE_RESUMEN)}`);
  linea('');
  if (a.vencimientos.excedeTopePanel) {
    linea(`   🚨 EL PANEL ESTÁ OCULTANDO ${a.vencimientos.ocultosPorTope} vencimientos (${pct(a.vencimientos.ocultosPorTope, a.vencimientos.total)}).`);
    linea('   Los meses del acordeón muestran cifras ARBITRARIAS: Firestore devuelve');
    linea('   los primeros 2000 por ID interno, sin relación con la fecha.');
  } else {
    linea(`   ✔ Por debajo del tope. Margen: ${TOPE_PANEL - a.vencimientos.total} documentos.`);
  }
  if (a.vencimientos.total > TOPE_RESUMEN)
    linea(`   🚨 Incluso las TARJETAS de resumen están cortadas (tope ${TOPE_RESUMEN}).`);

  sub('Vencimientos por mes (conteo REAL, todos los documentos)');
  Object.keys(a.vencimientos.vencPorMes).sort()
    .forEach(m => linea(`   ${m}   ${num(a.vencimientos.vencPorMes[m])}`));
  linea('');
  linea('   El panel cuenta CLIENTES por mes y esto cuenta EQUIPOS, así que el');
  linea('   panel debe dar igual o menos. Si da mucho menos, es el tope de 2000.');

  titulo('E. CLIENTES SIN NINGÚN VENCIMIENTO');
  linea(`   Total: ${num(a.clientes.clientesSinVencimiento)} de ${a.clientes.totalClientes} clientes`);
  sub('Agrupados por origen del cliente');
  imprimirConteo(a.clientes.sinVencPorOrigen);
  linea('');
  linea('   Los de origen "importacion_vencimientos" sin vencimiento son filas');
  linea('   cuya fecha no se pudo interpretar. Los de otros orígenes nunca');
  linea('   pasaron por el importador de vencimientos.');
  sub('Primeros 20');
  a.clientes.muestraSinVencimiento.slice(0, 20)
    .forEach(c => linea(`   ${c.nombre}   [${c.origen}]   ${c.id}`));

  const hallazgos = hallazgosDe(a);
  titulo('RESUMEN EJECUTIVO');
  if (!hallazgos.length) linea('   Sin hallazgos: el módulo está trayendo todo lo que debería.');
  hallazgos.forEach((h, i) => linea(`   ${i + 1}. ${h}`));

  return { ...a, hallazgos };
}

// ═════════════════════════════════════════════════════════════════════════════
// MODO SISTEMA COMPLETO — TODOS LOS SUSCRIPTORES
// ═════════════════════════════════════════════════════════════════════════════
async function reportarTodos() {
  const tenants = await listarTenants();
  titulo(`AUDITORÍA DEL SISTEMA — ${tenants.length} suscriptores`);
  linea('   Recorriendo órdenes, clientes, prospectos y vencimientos de cada uno.');
  linea('   Solo lectura. Puede tardar varios minutos con bases grandes.');
  linea('');

  const resultados = [];
  for (let i = 0; i < tenants.length; i++) {
    const t = tenants[i];
    process.stdout.write(`   [${i + 1}/${tenants.length}] ${cortar(t.nombre, 34)} `);
    try {
      const a = await analizarTenant(t, { detallado: false });
      a.hallazgos = hallazgosDe(a);
      resultados.push(a);
      linea(`ok  · ${a.ordenes.totalOrdenes} órdenes · ${a.vencimientos.total} vencimientos · ${a.ordenes.huerfanas} huérfanas`);
    } catch (e) {
      linea(`ERROR: ${e.message}`);
      resultados.push({ tenant: t, error: e.message });
    }
  }

  const ok = resultados.filter(r => !r.error);

  // ─── Tabla comparativa ─────────────────────────────────────────────────────
  titulo('TABLA COMPARATIVA  (ordenada por fuga de vencimientos)');
  linea('');
  linea('   ' + cortar('SUSCRIPTOR', 26) + ' ' +
        ['CLIENT', 'PROSP', 'VENCIM', 'ORDEN', 'APLICA', 'HUÉRF', 'FUGA%', 'IVA', 'TOPE'].map(h => h.padStart(7)).join(' '));
  linea('   ' + '─'.repeat(26) + ' ' + '─'.repeat(71));

  ok.slice().sort((a, b) => {
    const fa = a.ordenes.conItemsVenc ? a.ordenes.huerfanas / a.ordenes.conItemsVenc : 0;
    const fb = b.ordenes.conItemsVenc ? b.ordenes.huerfanas / b.ordenes.conItemsVenc : 0;
    if (fb !== fa) return fb - fa;
    return b.ordenes.huerfanas - a.ordenes.huerfanas;
  }).forEach(a => {
    linea('   ' + cortar(a.tenant.nombre, 26) + ' ' + [
      a.clientes.totalClientes,
      a.clientes.totalProspectos,
      a.vencimientos.total,
      a.ordenes.totalOrdenes,
      a.ordenes.conItemsVenc,
      a.ordenes.huerfanas,
      pct(a.ordenes.huerfanas, a.ordenes.conItemsVenc),
      a.empresasConIva.length ? 'SÍ' : 'no',
      a.vencimientos.excedeTopePanel ? '🚨' : 'ok',
    ].map(v => String(v).padStart(7)).join(' '));
  });
  linea('');
  linea('   APLICA = órdenes con ítems que SÍ deberían generar vencimiento');
  linea('   HUÉRF  = de esas, cuántas no tienen ningún vencimiento asociado');
  linea('   IVA    = tiene al menos una empresa facturadora con IVA > 0');
  linea('   TOPE   = supera los 2000 documentos que el panel puede mostrar');

  // ─── Agregados globales ────────────────────────────────────────────────────
  const tot = (f) => ok.reduce((s, a) => s + f(a), 0);
  const gClientes = tot(a => a.clientes.totalClientes);
  const gProspectos = tot(a => a.clientes.totalProspectos);
  const gVencimientos = tot(a => a.vencimientos.total);
  const gOrdenes = tot(a => a.ordenes.totalOrdenes);
  const gAplica = tot(a => a.ordenes.conItemsVenc);
  const gHuerfanas = tot(a => a.ordenes.huerfanas);
  const gNacieron = tot(a => a.ordenes.nacieronCompletada);
  const gSinCliente = tot(a => a.ordenes.sinClienteId);

  titulo('AGREGADOS DEL SISTEMA');
  linea(`   Suscriptores analizados          : ${num(ok.length)}`);
  linea(`   Clientes en total                : ${num(gClientes)}`);
  linea(`   Prospectos (importados sin fecha): ${num(gProspectos)}`);
  linea(`   Vencimientos existentes          : ${num(gVencimientos)}`);
  linea(`   Órdenes en total                 : ${num(gOrdenes)}`);
  linea('');
  linea(`   Órdenes que DEBÍAN generar vencimiento : ${num(gAplica)}`);
  linea(`   De esas, SIN vencimiento (huérfanas)   : ${num(gHuerfanas)}   ← ${pct(gHuerfanas, gAplica)} de fuga`);
  linea(`   Nacieron en "completada"               : ${num(gNacieron)}   (${pct(gNacieron, gAplica)})`);
  linea(`   Órdenes sin clienteId                  : ${num(gSinCliente)}`);

  // ─── Patrones transversales ────────────────────────────────────────────────
  const conIva = ok.filter(a => a.empresasConIva.length);
  const sobreTope = ok.filter(a => a.vencimientos.excedeTopePanel);
  const cercaDelTope = ok.filter(a => !a.vencimientos.excedeTopePanel && a.vencimientos.total > TOPE_PANEL * 0.8);
  const fugaTotal = ok.filter(a => a.ordenes.conItemsVenc > 0 && a.ordenes.huerfanas === a.ordenes.conItemsVenc);
  const sinTaller = ok.filter(a => !a.tenant.capacidades.taller);
  const vencioNada = ok.filter(a => a.vencimientos.total === 0 && a.ordenes.conItemsVenc > 0);

  titulo('PATRONES TRANSVERSALES  (¿es sistémico o de un suscriptor?)');

  sub(`Suscriptores con IVA > 0 en alguna empresa: ${conIva.length} de ${ok.length}`);
  linea('   Sus órdenes de oficina nacen "facturado" → el hook nunca dispara.');
  conIva.forEach(a => linea(`   · ${cortar(a.tenant.nombre, 30)} ${a.empresasConIva.map(e => `${e.nombre} (${e.iva}%)`).join(', ')}`));

  sub(`Suscriptores con fuga TOTAL (0 vencimientos de sus órdenes): ${fugaTotal.length}`);
  fugaTotal.forEach(a => linea(`   · ${cortar(a.tenant.nombre, 30)} ${a.ordenes.conItemsVenc} órdenes aplicaban, 0 vencimientos creados`));

  sub(`Suscriptores que YA superan el tope de ${TOPE_PANEL}: ${sobreTope.length}`);
  sobreTope.forEach(a => linea(`   · ${cortar(a.tenant.nombre, 30)} ${a.vencimientos.total} vencimientos → oculta ${a.vencimientos.ocultosPorTope}`));

  sub(`Suscriptores al 80% del tope (reventarán pronto): ${cercaDelTope.length}`);
  cercaDelTope.forEach(a => linea(`   · ${cortar(a.tenant.nombre, 30)} ${a.vencimientos.total} de ${TOPE_PANEL}`));

  sub(`Suscriptores sin capacidad "taller": ${sinTaller.length}`);
  linea('   En estos, las órdenes de oficina no pasan por taller: el único camino');
  linea('   al vencimiento es nacer "completada", o sea sin factura.');
  sinTaller.forEach(a => linea(`   · ${cortar(a.tenant.nombre, 30)} plan ${a.tenant.plan}`));

  sub(`Suscriptores con órdenes que aplican y CERO vencimientos: ${vencioNada.length}`);
  vencioNada.forEach(a => linea(`   · ${cortar(a.tenant.nombre, 30)} ${a.ordenes.conItemsVenc} órdenes aplicaban`));

  // ─── Veredicto ─────────────────────────────────────────────────────────────
  titulo('VEREDICTO');
  const tenantsConFuga = ok.filter(a => a.ordenes.huerfanas > 0).length;
  const tenantsQueAplican = ok.filter(a => a.ordenes.conItemsVenc > 0).length;
  linea(`   Suscriptores con al menos una orden que debía generar vencimiento: ${tenantsQueAplican}`);
  linea(`   De esos, con fuga: ${tenantsConFuga}  (${pct(tenantsConFuga, tenantsQueAplican)})`);
  linea('');
  if (tenantsQueAplican > 0 && tenantsConFuga === tenantsQueAplican) {
    linea('   → ES SISTÉMICO. Todos los suscriptores con operación real pierden');
    linea('     vencimientos. No es un problema de configuración de un cliente:');
    linea('     es el diseño del hook (solo dispara al crear, solo en "completada").');
  } else if (tenantsConFuga > 0) {
    linea('   → FUGA PARCIAL. Revisá en la tabla qué distingue a los que pierden');
    linea('     de los que no: IVA, capacidad de taller, o categorías de producto.');
  } else {
    linea('   → Sin fuga detectada en ningún suscriptor.');
  }

  return {
    generado: new Date().toISOString(),
    totalSuscriptores: tenants.length,
    agregados: {
      clientes: gClientes, prospectos: gProspectos, vencimientos: gVencimientos,
      ordenes: gOrdenes, aplican: gAplica, huerfanas: gHuerfanas,
      nacieronCompletada: gNacieron, sinClienteId: gSinCliente,
      fugaPct: pct(gHuerfanas, gAplica),
    },
    patrones: {
      conIva: conIva.map(a => a.tenant.nombre),
      fugaTotal: fugaTotal.map(a => a.tenant.nombre),
      sobreTope: sobreTope.map(a => a.tenant.nombre),
      cercaDelTope: cercaDelTope.map(a => a.tenant.nombre),
      sinTaller: sinTaller.map(a => a.tenant.nombre),
      vencioNada: vencioNada.map(a => a.tenant.nombre),
    },
    suscriptores: resultados,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const args = process.argv.slice(2);
  const modo = args[0] || '--ayuda';
  let reporte, archivo;

  if (modo === '--ayuda' || modo === '--help' || modo === '-h') {
    linea('');
    linea('  Control360 — Diagnóstico de Vencimientos (solo lectura)');
    linea('');
    linea('  node diagnostico-vencimientos.js --listar');
    linea('      Lista los suscriptores con su adminId, plan y módulos.');
    linea('');
    linea('  node diagnostico-vencimientos.js --todos');
    linea('      Auditoría del sistema completo: tabla comparativa de todos los');
    linea('      suscriptores, agregados globales y patrones transversales.');
    linea('');
    linea('  node diagnostico-vencimientos.js <adminId>');
    linea('  node diagnostico-vencimientos.js --email correo@suscriptor.com');
    linea('      Diagnóstico profundo de un solo suscriptor.');
    linea('');
    process.exit(0);
  }

  if (modo === '--listar' || modo === '--list') {
    const tenants = await listarTenants();
    titulo(`SUSCRIPTORES — ${tenants.length}`);
    if (!tenants.length) linea('   (no se encontraron admins en `users`)');
    tenants.forEach(t => {
      linea('');
      linea(`   ${t.nombre}${t.activo ? '' : '   (inactivo)'}`);
      linea(`      email   : ${t.email}`);
      linea(`      adminId : ${t.adminId}`);
      linea(`      plan    : ${t.plan}   ·   módulos: ${t.modulos.length ? t.modulos.length : '(vacío = todos)'}`);
    });
    linea('');
    linea('   Diagnóstico de uno:  node diagnostico-vencimientos.js <adminId>');
    linea('   Auditoría completa:  node diagnostico-vencimientos.js --todos');
    linea('');
    process.exit(0);
  }

  if (modo === '--todos' || modo === '--all' || modo === '--sistema') {
    reporte = await reportarTodos();
    archivo = `diagnostico-sistema-${Date.now()}.json`;
  } else {
    // Un solo suscriptor: por email o por adminId
    let tenant = null;
    const tenants = await listarTenants();

    if (modo === '--email' && args[1]) {
      tenant = tenants.find(t => String(t.email).toLowerCase() === String(args[1]).toLowerCase());
      if (!tenant) {
        const s = await db.collection('users').where('email', '==', args[1]).limit(1).get();
        if (!s.empty) {
          const u = s.docs[0].data();
          tenant = {
            adminId: s.docs[0].id, nombre: u.nombre || '(sin nombre)', email: u.email || '—',
            plan: u.plan || u.tipoPlan || '—', modulos: Array.isArray(u.modulos) ? u.modulos : [], activo: u.activo !== false,
          };
        }
      }
      if (!tenant) {
        console.error(`\nNo existe usuario con email ${args[1]}`);
        console.error('Corré  node diagnostico-vencimientos.js --listar  para ver los emails reales.\n');
        process.exit(1);
      }
    } else if (!modo.startsWith('--')) {
      tenant = tenants.find(t => t.adminId === modo);
      if (!tenant) {
        const d = await db.collection('users').doc(modo).get();
        if (!d.exists) {
          console.error(`\nNo existe users/${modo}`);
          console.error('Corré  node diagnostico-vencimientos.js --listar\n');
          process.exit(1);
        }
        const u = d.data();
        tenant = {
          adminId: d.id, nombre: u.nombre || '(sin nombre)', email: u.email || '—',
          plan: u.plan || u.tipoPlan || '—', modulos: Array.isArray(u.modulos) ? u.modulos : [], activo: u.activo !== false,
        };
      }
    } else {
      console.error(`\nOpción desconocida: ${modo}`);
      console.error('Corré  node diagnostico-vencimientos.js --ayuda\n');
      process.exit(1);
    }

    reporte = await reportarUno(tenant);
    archivo = `diagnostico-vencimientos-${tenant.adminId}-${Date.now()}.json`;
  }

  fs.writeFileSync(archivo, JSON.stringify(reporte, null, 2), 'utf8');
  linea('');
  linea(`Detalle completo guardado en: ${archivo}`);
  linea('');
  process.exit(0);
})().catch(e => {
  console.error('\nError en el diagnóstico:', e);
  process.exit(1);
});
