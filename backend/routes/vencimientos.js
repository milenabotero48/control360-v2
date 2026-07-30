// ============================================================
// Control360 — Motor de Vencimientos (Fase 2)
// Ubicación: backend/routes/vencimientos.js
// ------------------------------------------------------------
// MONTAJE en server.js (UNA línea junto a las demás rutas):
//   app.use('/api/vencimientos', authenticate, require('./routes/vencimientos'));
//
// REGLAS DEL DOCUMENTO ARQ-COMERCIAL-V1.1 implementadas aquí:
//   R-COM-01  El vencimiento pertenece al equipo, no al cliente
//   R-COM-03  Filas sin fecha → colección prospectos (no clients)
//   (R-COM-02 / 07 — agrupación y candado 30 días — viven en el
//    motor automático de la Fase 4, no en este archivo)
//
// ✅ TELEFONO-UNIF-001 (2026-07-06): la normalización telefónica de este
// archivo AGREGABA el prefijo 57 (573105...), mientras que el dominio
// comercial (DUP-002) lo QUITA (3105...). El mismo cliente quedaba con dos
// formatos y los emparejamientos anti-duplicado nunca casaban. Ahora este
// archivo usa la MISMA regla que comercial.js:
//   · Celular colombiano válido = 10 dígitos empezando en 3.
//   · 12 dígitos con prefijo 57 → se QUITA el 57.
//   · Otras longitudes (11, 13, 9...) → NO se pierde la fila: entra con
//     bandera telefonoPorVerificar para corrección en la primera gestión.
// Requiere correr UNA vez el script migrar-telefonos.js para normalizar
// los datos ya guardados con 57 (clientes de importaciones anteriores).
//
// DISEÑO DEL IMPORTADOR: el frontend parsea el Excel con SheetJS
// (ya disponible en el stack) y envía JSON. El backend NO necesita
// dependencias nuevas (multer/xlsx). Cero cambios en package.json.
//
// FECHAS: strings 'YYYY-MM-DD' (regla del proyecto: Railway corre
// en UTC, Colombia es UTC-5 — se evita Date() para días calendario).
// ============================================================

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { normalizarTelefono: normTelCiclo } = require('../services/vencimientosService');

// ─── HELPER: auditoría (mismo patrón de clients.js) ─────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'vencimientos', descripcion,
      usuarioId, usuarioNombre, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

// ─── HELPER: resolver tenant (patrón estándar del proyecto) ──────────────────
const getAdminId = (req) => req.adminId || req.user?.uid || req.user?.id;

// ─── HELPER: fechas calendario sin riesgo de zona horaria ────────────────────
// 'YYYY-MM-DD' + meses → 'YYYY-MM-DD'
const sumarMeses = (fechaStr, meses) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1 + meses, d));
  return fecha.toISOString().slice(0, 10);
};

const hoyColombia = () => {
  // UTC-5: restar 5 horas al reloj UTC y tomar la fecha
  const ahora = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return ahora.toISOString().slice(0, 10);
};

const esFechaValida = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ─── HELPER: parseo flexible de fecha SOLO para el importador masivo ─────────
// El formulario manual y el resto del sistema siguen exigiendo 'YYYY-MM-DD'
// estricto (esFechaValida). Esta función existe porque los archivos que las
// suscriptoras exportan desde Excel/su sistema anterior traen fechas en
// formatos variados (ej: "26-Jul-25") y antes se descartaban silenciosamente,
// mandando esas filas a Prospectos en vez de crear el vencimiento.
const pad2 = (n) => String(n).padStart(2, '0');
const MESES_ABREV = {
  ene:1, jan:1, feb:2, mar:3, abr:4, apr:4, may:5, jun:6, jul:7,
  ago:8, aug:8, sep:9, sept:9, oct:10, nov:11, dic:12, dec:12,
};
const parsearFechaFlexible = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return null;

  // YYYY-MM-DD (ya válido)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // YYYY-MM (se asume día 01)
  if (/^\d{4}-\d{2}$/.test(s)) return s + '-01';

  // YYYY/MM/DD
  let m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  // DD-MMM-YY o DD-MMM-YYYY (ej: 26-Jul-25, 26-Jul-2025, 26 Jul 25)
  m = s.match(/^(\d{1,2})[\-\/\s]+([a-zA-ZñÑ]{3,9})[\-\/\s]+(\d{2,4})$/);
  if (m) {
    const mesNum = MESES_ABREV[m[2].toLowerCase().slice(0, 3)];
    if (mesNum) {
      let year = m[3];
      if (year.length === 2) year = (Number(year) <= 30 ? '20' : '19') + year;
      const dia = Number(m[1]);
      if (dia >= 1 && dia <= 31) return `${year}-${pad2(mesNum)}-${pad2(dia)}`;
    }
  }

  // DD/MM/YYYY o DD-MM-YYYY (numérico, día primero — convención colombiana)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let year = m[3];
    if (year.length === 2) year = (Number(year) <= 30 ? '20' : '19') + year;
    let dia = Number(m[1]), mes = Number(m[2]);
    if (mes > 12 && dia <= 12) { const t = dia; dia = mes; mes = t; } // invertir si el "mes" no es válido
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) return `${year}-${pad2(mes)}-${pad2(dia)}`;
  }

  // MM/YYYY o MM-YYYY (solo mes y año)
  m = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[2]}-${pad2(m[1])}-01`;

  return null;
};

// Estado calculado dinámicamente (no se "pudre" en la base):
// GESTIONADO se respeta si está marcado; el resto se deriva de la fecha.
// ✅ VENC-CICLO-003: si el ciclo tiene un desenlace explícito, ese manda.
// Antes todo lo cerrado se veía igual ("GESTIONADO"), sin poder distinguir un
// cliente que renovó de uno que se perdió o que ya no es cliente.
const CICLOS_CERRADOS = {
  RENOVADO: 'RENOVADO',
  PERDIDO:  'PERDIDO',
  INACTIVO: 'INACTIVO',
};

const calcularEstado = (venc, hoy) => {
  if (CICLOS_CERRADOS[venc.estadoCiclo]) return CICLOS_CERRADOS[venc.estadoCiclo];
  if (venc.gestionado) return 'GESTIONADO';
  if (!venc.fechaVencimiento) return 'SIN_FECHA';
  if (venc.estadoCiclo === 'EN_TELEMERCADEO') return 'EN_TELEMERCADEO';
  if (venc.fechaVencimiento < hoy) return 'VENCIDO';
  const limite30 = sumarMeses(hoy, 1); // ~30 días
  if (venc.fechaVencimiento <= limite30) return 'POR_VENCER';
  return 'VIGENTE';
};

// ─── ✅ TELEFONO-UNIF-001: normalización UNIFICADA (regla DUP-002) ────────────
// MISMA función que backend/routes/comercial.js — fuente única de verdad.
//   - Celular colombiano válido = exactamente 10 dígitos empezando en 3.
//   - Se ELIMINA el prefijo 57 (12 dígitos → 10). Antes este archivo lo
//     AGREGABA, creando clientes 573105... que nunca casaban con los
//     3105... de telemercadeo — raíz de los duplicados.
//   - Devuelve { tel, valido }: valido=false NO descarta la fila — activa
//     la bandera telefonoPorVerificar (11+ dígitos raros, sin 3 inicial...).
const normalizarTelefonoInfo = (telefono) => {
  if (!telefono) return { tel: null, valido: false };
  let t = String(telefono).replace(/[\s\-().+]/g, '').replace(/\D/g, '');
  if (t.length === 12 && t.startsWith('57')) t = t.slice(2); // quitar prefijo país
  const valido = /^3\d{9}$/.test(t); // celular CO: 10 dígitos, empieza en 3
  return { tel: t || null, valido };
};

// Compatibilidad: el resto del archivo espera un string (o null).
const normalizarTelefono = (telefono) => {
  const { tel } = normalizarTelefonoInfo(telefono);
  return tel;
};

// ✅ FIX VENC-EQUIPOS-003 (2026-07-01): una fila puede traer VARIOS equipos
// separados por "|" o por coma+espacio, cada uno con prefijo de cantidad "5x".
// Ej: "5x Recarga ABC 10 lb | Extintor CO2 5 lbs, 3x Recarga BC 20 lb"
//   → 3 vencimientos individuales con cantidades 5, 1 y 3.
// OJO: la coma SIN espacio no separa — protege decimales colombianos
// como "Recarga Agua 2,5 GLS" (por eso el separador recomendado es "|").
const partirEquipos = (equipoStr, cantidadFila) => {
  const partes = String(equipoStr || '').split(/\s*\|\s*|;\s*|,\s+/).map(p => p.trim()).filter(Boolean);
  if (!partes.length) return [{ descripcion: 'Extintor', cantidad: Number(cantidadFila) || 1 }];
  const leerParte = (p, cantDefault) => {
    const m = p.match(/^(\d+)\s*[xX×]\s*(.+)$/);
    return m
      ? { descripcion: m[2].trim(), cantidad: Number(m[1]) || 1 }
      : { descripcion: p, cantidad: cantDefault };
  };
  // Con UN solo equipo, la columna "cantidad" de la fila sigue mandando;
  // con VARIOS, cada uno usa su prefijo "Nx" (o 1 si no lo trae).
  if (partes.length === 1) return [leerParte(partes[0], Number(cantidadFila) || 1)];
  return partes.map(p => leerParte(p, 1));
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ VENC-TOPE-001 (2026-07-29) — EL TOPE DE 2000 QUE MENTÍA
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA: `GET /` hacía `.limit(2000)` SIN orderBy y agrupaba por mes DESPUÉS,
// en memoria. Firestore devuelve los primeros 2000 por ID interno, sin relación
// con la fecha, así que el acordeón mostraba cifras ARBITRARIAS: Extintores del
// Sur tiene 8.027 vencimientos y el panel mostraba 2.000 — ocultaba el 75% y
// "Julio 2027" aparecía con 36 clientes en vez de los reales. Lo mismo Valle
// con 7.744. El `/resumen` tenía el mismo vicio con tope de 5000.
//
// SOLUCIÓN: se recorre la colección COMPLETA en páginas de 1000 ordenando por
// __name__ (no requiere índice compuesto — se respeta la regla del proyecto),
// se enriquece con los datos del cliente UNA vez, y el resultado queda en una
// caché en memoria por tenant con TTL de 60s. Sobre esa caché responden los
// tres endpoints de lectura, así que el acordeón, las tarjetas y el detalle de
// cada mes salen SIEMPRE del mismo universo de datos y ninguno puede mentir.
//
// COSTO: 1 escaneo por tenant por minuto en el peor caso. Con 30.000
// vencimientos son 30 lecturas de página, no 30.000 consultas.
// ═════════════════════════════════════════════════════════════════════════════
// La caché vive en services/vencimientosCache.js para que el servicio que
// CREA vencimientos y la ruta que los LEE puedan invalidarla sin depender uno
// del otro (evita la dependencia circular ruta ↔ servicio).
const cacheVenc = require('../services/vencimientosCache');
const invalidarCache = cacheVenc.invalidar;

// Recorre TODOS los vencimientos del tenant y los devuelve enriquecidos.
const cargarTodos = async (adminId) => {
  const enCache = cacheVenc.obtener(adminId);
  if (enCache) return enCache;

  // 1. Escaneo completo paginado — sin topes arbitrarios.
  const TAM = 1000;
  let ultimo = null;
  const crudos = [];
  for (;;) {
    let q = db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .orderBy('__name__')
      .limit(TAM);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = await q.get();
    if (snap.empty) break;
    snap.docs.forEach(d => crudos.push({ id: d.id, ...d.data() }));
    ultimo = snap.docs[snap.docs.length - 1];
    if (snap.size < TAM) break;
  }

  // 2. Estado calculado al vuelo (no se "pudre" en la base).
  const hoy = hoyColombia();
  crudos.forEach(v => { v.estado = calcularEstado(v, hoy); });

  // 3. Enriquecimiento con datos del cliente — FIX VENC-NOMBRE-001: el cruce
  // se hace acá con getAll por lotes y no en el frontend contra /clients, que
  // está paginado a 100 y dejaba "Sin nombre" a todo cliente fuera de esa
  // ventana. Funciona con bases de cualquier tamaño.
  const idsUnicos = [...new Set(crudos.map(v => v.clienteId).filter(Boolean))];
  const clientesMap = new Map();
  for (let i = 0; i < idsUnicos.length; i += 300) {
    const refs = idsUnicos.slice(i, i + 300).map(id => db.collection('clients').doc(id));
    if (!refs.length) break;
    const docs = await db.getAll(...refs);
    docs.forEach(d => {
      // Defensa multi-tenant: solo clientes del mismo tenant
      if (d.exists && d.data().adminId === adminId) clientesMap.set(d.id, d.data());
    });
  }
  const filas = crudos.map(v => {
    const c = clientesMap.get(v.clienteId);
    if (!c) return v;
    return {
      ...v,
      clienteNombre:    c.nombre || c.empresa || '',
      clienteContacto:  c.contacto || '',
      clienteTelefono:  c.celular || c.telefono || '',
      clienteDireccion: c.direccionPrincipal || c.direccion || '',
      clienteBarrio:    c.barrio || '',
      clienteEmail:     c.emailLegal || c.email || ''
    };
  });

  filas.sort((a, b) => (a.fechaVencimiento || '9999').localeCompare(b.fechaVencimiento || '9999'));
  cacheVenc.guardar(adminId, filas);
  console.log(`[VENC] Caché reconstruida para ${adminId}: ${filas.length} vencimientos`);
  return filas;
};

// Texto sobre el que corre la búsqueda del panel.
const coincideBusqueda = (v, q) => {
  if (!q) return true;
  const t = q.toLowerCase();
  return [
    v.descripcionEquipo, v.sucursal, v.clienteNombre, v.clienteContacto,
    v.clienteTelefono, v.telefono, v.numeroOrden, v.clienteBarrio,
  ].some(campo => String(campo || '').toLowerCase().includes(t));
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vencimientos — Listar con filtros (estado, clienteId, mes, q)
// Con `mes`, `clienteId` o `q` devuelve TODAS las filas que cumplen: ya no hay
// tope silencioso. Sin ningún filtro se limita a 2000 por peso de red, pero el
// panel ya no usa esa ruta: pide el acordeón por /meses y el detalle por mes.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { estado, clienteId, mes, q, todos } = req.query; // mes: 'YYYY-MM'

    let lista = await cargarTodos(adminId);

    if (clienteId) lista = lista.filter(v => v.clienteId === clienteId);
    if (mes)       lista = lista.filter(v => (v.fechaVencimiento || '').startsWith(mes));
    if (estado)    lista = lista.filter(v => v.estado === estado);
    if (q)         lista = lista.filter(v => coincideBusqueda(v, q));

    // Solo se acota cuando NO hay filtro NI se pidió todo explícitamente
    // (evita mandar 30.000 filas a un navegador que no las pidió). `todos=1`
    // lo usan los exports, que sí necesitan la base completa.
    const pidioTodo = todos === '1' || todos === 'true';
    const sinFiltros = !clienteId && !mes && !estado && !q;
    if (sinFiltros && !pidioTodo && lista.length > 2000) lista = lista.slice(0, 2000);

    return res.json(lista);
  } catch (err) {
    console.error('GET /vencimientos:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vencimientos/meses — Acordeón por mes, contado sobre el 100%
// Devuelve lo que la pantalla necesita para pintar las cabeceras sin tener que
// bajarse todas las filas: por mes, cuántos CLIENTES distintos, cuántos
// equipos, y el desglose por estado. Acepta `q` para que la búsqueda siga
// funcionando sobre la base completa.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/meses', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { q, estado } = req.query;

    let filas = await cargarTodos(adminId);
    if (estado) filas = filas.filter(v => v.estado === estado);
    if (q)      filas = filas.filter(v => coincideBusqueda(v, q));

    const porMes = new Map();
    filas.forEach(v => {
      const mk = (v.fechaVencimiento || '').slice(0, 7) || 'sin_fecha';
      if (!porMes.has(mk)) {
        porMes.set(mk, { key: mk, equipos: 0, clientes: new Map() });
      }
      const m = porMes.get(mk);
      m.equipos += 1;
      const cKey = v.clienteId || v.telefono || 'sin_cliente';
      // El estado del cliente en el mes es el MÁS URGENTE de sus equipos,
      // igual que hace la pantalla: VENCIDO > POR_VENCER > VIGENTE.
      const prioridad = { VENCIDO: 4, POR_VENCER: 3, VIGENTE: 2, SIN_FECHA: 1, GESTIONADO: 0 };
      const actual = m.clientes.get(cKey);
      if (!actual || (prioridad[v.estado] || 0) > (prioridad[actual] || 0)) {
        m.clientes.set(cKey, v.estado);
      }
    });

    const meses = [...porMes.values()].map(m => {
      const estados = { VENCIDO: 0, POR_VENCER: 0, VIGENTE: 0, GESTIONADO: 0, SIN_FECHA: 0 };
      m.clientes.forEach(e => { estados[e] = (estados[e] || 0) + 1; });
      return { key: m.key, totalClientes: m.clientes.size, totalEquipos: m.equipos, estados };
    }).sort((a, b) => a.key.localeCompare(b.key));

    return res.json({
      meses,
      totalEquipos: filas.length,
      totalMeses: meses.length,
    });
  } catch (err) {
    console.error('GET /vencimientos/meses:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vencimientos/resumen — Tarjetas del dashboard
// Cuenta sobre el 100% de la colección: antes tenía tope de 5000 y a Sur y
// Valle les mentía igual que el listado.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/resumen', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const filas = await cargarTodos(adminId);

    const resumen = { VENCIDO: 0, POR_VENCER: 0, VIGENTE: 0, GESTIONADO: 0, SIN_FECHA: 0, total: 0 };
    filas.forEach(v => {
      resumen[v.estado] = (resumen[v.estado] || 0) + 1;
      resumen.total++;
    });

    return res.json(resumen);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/vencimientos — Crear registro manual (desde ficha cliente o llamada)
// Body: { clienteId, sucursal?, descripcionEquipo, cantidad?,
//         fechaUltimaRecarga? | fechaVencimiento?, origenDato? }
// Si solo viene fechaUltimaRecarga → vencimiento = +12 meses (R-COM-04)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { clienteId, sucursal, descripcionEquipo, cantidad, fechaUltimaRecarga, fechaVencimiento, origenDato, ordenId } = req.body;

    if (!clienteId || !descripcionEquipo) {
      return res.status(400).json({ error: 'clienteId y descripcionEquipo son requeridos' });
    }

    // ✅ FIX TENANT-ADMINID-002 (2026-07-01): el clienteId llega del cliente
    // HTTP — se valida propiedad contra Firestore para que nadie pueda crear
    // vencimientos apuntando a clientes de otro tenant.
    const cliDoc = await db.collection('clients').doc(clienteId).get();
    if (!cliDoc.exists || cliDoc.data().adminId !== adminId) {
      return res.status(403).json({ error: 'El cliente no pertenece a tu cuenta' });
    }

    let fVenc = esFechaValida(fechaVencimiento) ? fechaVencimiento : null;
    const fRecarga = esFechaValida(fechaUltimaRecarga) ? fechaUltimaRecarga : null;
    if (!fVenc && fRecarga) fVenc = sumarMeses(fRecarga, 12);
    if (!fVenc) return res.status(400).json({ error: 'Se requiere fechaVencimiento o fechaUltimaRecarga (YYYY-MM-DD)' });

    const nuevo = {
      adminId,
      clienteId,
      sucursal: sucursal || null,
      descripcionEquipo,
      cantidad: Number(cantidad) || 1,
      fechaUltimaRecarga: fRecarga,
      fechaVencimiento: fVenc,
      gestionado: false,
      origenDato: origenDato || 'manual',
      ordenId: ordenId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('vencimientos').add(nuevo);

    await auditar({
      accion: 'crear', descripcion: `Vencimiento creado: ${descripcionEquipo} (${fVenc})`,
      usuarioId: getAdminId(req), usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { vencimientoId: ref.id, clienteId }
    });

    invalidarCache(adminId); // VENC-TOPE-001: el panel debe verlo al instante
    return res.status(201).json({ id: ref.id, ...nuevo });
  } catch (err) {
    console.error('POST /vencimientos:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/vencimientos/importar — Importación masiva (Excel → JSON)
// El frontend parsea el Excel con SheetJS y envía:
// Body: { filas: [{ nombre, empresa?, telefono, sucursal?, equipo,
//                   cantidad?, fechaUltimaRecarga? ('YYYY-MM-DD' o 'YYYY-MM') }] }
//
// Enrutamiento por fila (sección 06 del documento):
//   CON fecha  → cliente (existente o nuevo) + registro en vencimientos
//   SIN fecha  → colección prospectos (estado NUEVO) para la vendedora
//   Teléfono ya en clients → no duplica cliente, agrega vencimientos
//
// ✅ TELEFONO-UNIF-001: teléfonos con prefijo 57 (12 dígitos) se normalizan a
// 10 dígitos ANTES de guardar y de emparejar. Teléfonos con longitudes raras
// (11, 13, 9...) NO descartan la fila: entran con telefonoPorVerificar=true
// para corrección en la primera gestión. Los mapas de emparejamiento también
// normalizan lo YA guardado, así el emparejado funciona incluso antes de
// correr la migración de datos.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/importar', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede importar' });
    }
    const adminId = getAdminId(req);
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    // Ola 3: la importación pertenece a UNA empresa facturadora (selector en
    // pantalla). Los clientes nuevos nacen con el esquema oficial completo.
    const empresaId = req.body?.empresaId || '';
    const empresaNombre = req.body?.empresaNombre || '';
    // ✅ COMERCIAL-BASE-001: mes de la base importada — lo heredan los
    // prospectos creados desde filas sin fecha, para que en Telemercadeo
    // no se mezclen bases de meses distintos.
    const periodoActual = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 7);
    const basePeriodo = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.body?.basePeriodo || '') ? req.body.basePeriodo : periodoActual;

    if (!filas.length) return res.status(400).json({ error: 'No se recibieron filas para importar' });
    if (filas.length > 2000) return res.status(400).json({ error: 'Máximo 2000 filas por importación. Divide el archivo.' });
    if (!empresaId) return res.status(400).json({ error: 'Selecciona la empresa que factura para esta importación' });

    // 1. Cargar clientes existentes del tenant UNA vez (mapa por teléfono)
    const clientesSnap = await db.collection('clients').where('adminId', '==', adminId).get();
    const porTelefono = new Map();
    // ✅ CLIENTES-DUP-001: regla única de identidad — el emparejamiento ya no es
    // solo por teléfono: también por NIT y por nombre normalizado. Antes, un
    // cliente existente con OTRO teléfono en el Excel (otro contacto, fijo vs
    // celular) se duplicaba aunque el NIT fuera idéntico. Los tres mapas salen
    // del MISMO snapshot que ya se cargaba — cero lecturas adicionales.
    const porNit = new Map();
    const porNombre = new Map();
    const normNombreCli = (n) => String(n || '').toUpperCase().trim().replace(/\s+/g, ' ') || null;
    clientesSnap.docs.forEach(d => {
      // Clientes oficiales usan `celular`; antiguos pueden usar `telefono`.
      // ✅ TELEFONO-UNIF-001: normalizar TAMBIÉN lo guardado — un cliente viejo
      // con 573105... queda indexado como 3105... y el emparejado sí casa.
      const data = d.data();
      if (data.activo === false) return;
      [normalizarTelefono(data.celular), normalizarTelefono(data.telefono)]
        .filter(Boolean)
        .forEach(t => { if (!porTelefono.has(t)) porTelefono.set(t, d.id); });
      const nitCli = String(data.nit || '').replace(/[^0-9]/g, '');
      if (nitCli && !porNit.has(nitCli)) porNit.set(nitCli, d.id);
      const nomCli = normNombreCli(data.nombre);
      if (nomCli && !porNombre.has(nomCli)) porNombre.set(nomCli, d.id);
    });

    // Prospectos existentes por teléfono → MODO ACTUALIZAR: si la fila trae
    // datos nuevos (NIT, empresa, equipo), se ENRIQUECE el prospecto en vez
    // de duplicarlo. Así una re-importación del mismo archivo completa la
    // base sin tocar el trabajo de llamadas ya hecho.
    const prospSnap = await db.collection('prospectos').where('adminId', '==', adminId).get();
    const prospPorTel = new Map();
    prospSnap.docs.forEach(d => {
      const t = normalizarTelefono(d.data().telefono);
      if (t && !prospPorTel.has(t)) prospPorTel.set(t, { id: d.id, ...d.data() });
    });


    let resultadoExtra = { prospectosActualizados: 0 };
    // ✅ TELEFONO-UNIF-001: contador de teléfonos dudosos (bandera ☎️)
    const resultado = { vencimientosCreados: 0, clientesNuevos: 0, prospectosCreados: 0, porVerificar: 0, errores: [] };
    let batch = db.batch();
    let ops = 0;
    const commitSiLleno = async () => {
      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    };

    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const fila = i + 2; // +2: encabezado del Excel
      try {
        // Alias de columnas — acepta la plantilla de clientes de la empresa:
        const nombre = String(f.nombre || f.razonSocial || f['razon social'] || f.empresa || '').trim();
        // ✅ TELEFONO-UNIF-001: normalizar con la regla DUP-002. Un teléfono
        // "raro" (11+ dígitos, fijo, etc.) NO bota la fila — entra marcada.
        const { tel: telefono, valido: telValido } = normalizarTelefonoInfo(f.telefono || f.celular);
        const nitFila = String(f.nit || '').replace(/[^0-9]/g, '') || null;

        if (!nombre || !telefono) {
          resultado.errores.push({ fila, error: 'Falta nombre o teléfono' });
          continue;
        }
        if (!telValido) resultado.porVerificar++; // ✅ TELEFONO-UNIF-001

        // ✅ FIX: antes solo aceptaba 'YYYY-MM-DD'/'YYYY-MM'; formatos como
        // "26-Jul-25" se descartaban silenciosamente y la fila caía a Prospectos.
        const fRecarga = parsearFechaFlexible(f.fechaUltimaRecarga);

        if (!fRecarga) {
          // ─── SIN FECHA → prospecto para la vendedora (R-COM-03 / sección 06)
          const existente = prospPorTel.get(telefono);
          if (existente) {
            // MODO ACTUALIZAR: enriquecer sin duplicar ni borrar gestión.
            const cambios = {};
            if (nitFila && !existente.nit) cambios.nit = nitFila;
            if (f.empresa && !existente.empresa) cambios.empresa = f.empresa;
            if (f.sucursal && !existente.sucursal) cambios.sucursal = f.sucursal;
            if (f.equipo && !existente.equipoReportado) cambios.equipoReportado = f.equipo;
            if (!existente.clienteId && porTelefono.get(telefono)) cambios.clienteId = porTelefono.get(telefono);
            if (Object.keys(cambios).length) {
              cambios.updatedAt = admin.firestore.FieldValue.serverTimestamp();
              batch.update(db.collection('prospectos').doc(existente.id), cambios);
              ops++; resultadoExtra.prospectosActualizados++;
              await commitSiLleno();
            }
            continue;
          }
          const refP = db.collection('prospectos').doc();
          batch.set(refP, {
            adminId,
            nombre,
            empresa: f.empresa || null,
            telefono,
            telefonoPorVerificar: !telValido, // ✅ TELEFONO-UNIF-001: bandera ☎️
            nit: nitFila,
            sucursal: f.sucursal || null,
            equipoReportado: f.equipo || null,
            origen: 'importacion',
            basePeriodo, // ✅ COMERCIAL-BASE-001
            estado: 'NUEVO',
            asignadoA: null,
            proximaLlamada: null,
            clienteId: porTelefono.get(telefono) || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          prospPorTel.set(telefono, { id: refP.id, nombre, telefono });
          ops++; resultado.prospectosCreados++;
          await commitSiLleno();
          continue;
        }

        // ─── CON FECHA → cliente + vencimiento
        // ✅ CLIENTES-DUP-001: teléfono primero, luego NIT, luego nombre
        let clienteId = porTelefono.get(telefono)
          || (nitFila ? porNit.get(nitFila) : null)
          || porNombre.get(normNombreCli(nombre));
        if (!clienteId) {
          // Esquema OFICIAL de cliente (visible y editable en el módulo Clientes)
          const refC = db.collection('clients').doc();
          batch.set(refC, {
            adminId,
            nombre: nombre.toUpperCase(),
            // ✅ FIX VENC-PLANTILLA-002 (2026-07-01): persona de contacto —
            // Lucy (llamadas IA) la usa para saludar por nombre propio:
            // "¿hablo con Milena de la empresa La Monumental?"
            contacto: String(f.contacto || '').trim() || null,
            tipoDocumento: 'NIT',
            nit: nitFila,
            // ✅ TELEFONO-UNIF-001: el cliente nace con 10 dígitos limpios
            // (ya sin 57) — mismo formato que telemercadeo y conversiones.
            celular: telefono,
            telefono,
            telefonoPorVerificar: !telValido, // ✅ TELEFONO-UNIF-001
            emailLegal: f.email || null,
            emailsAdicionales: [],
            direccionPrincipal: f.direccion || null,
            barrio: String(f.barrio || '').trim() || null,
            ciudad: f.ciudad || null,
            empresaId,
            empresaNombre,
            sucursales: [],
            notas: '',
            origen: 'importacion_vencimientos',
            activo: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          clienteId = refC.id;
          porTelefono.set(telefono, clienteId); // evita duplicar en filas siguientes
          // ✅ CLIENTES-DUP-001: registrar en los tres mapas
          if (nitFila) porNit.set(nitFila, clienteId);
          const nomNuevo = normNombreCli(nombre);
          if (nomNuevo) porNombre.set(nomNuevo, clienteId);
          ops++; resultado.clientesNuevos++;
        }
        // Si existe un prospecto con este teléfono → vincularlo y enriquecerlo
        const prospLink = prospPorTel.get(telefono);
        if (prospLink && (!prospLink.clienteId || (nitFila && !prospLink.nit))) {
          const cambiosP = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
          if (!prospLink.clienteId) cambiosP.clienteId = clienteId;
          if (nitFila && !prospLink.nit) cambiosP.nit = nitFila;
          batch.update(db.collection('prospectos').doc(prospLink.id), cambiosP);
          prospLink.clienteId = clienteId;
          ops++; resultadoExtra.prospectosActualizados++;
        }

        // ✅ FIX VENC-EQUIPOS-003: la fila puede traer varios equipos —
        // cada uno genera SU PROPIO vencimiento con su propia cantidad,
        // para que la gestión y las alertas sean individuales por equipo.
        const equiposFila = partirEquipos(f.equipo, f.cantidad);
        for (const eq of equiposFila) {
          const refV = db.collection('vencimientos').doc();
          batch.set(refV, {
            adminId,
            clienteId,
            sucursal: f.sucursal || null,
            descripcionEquipo: eq.descripcion || 'Extintor',
            cantidad: eq.cantidad,
            fechaUltimaRecarga: fRecarga,
            fechaVencimiento: sumarMeses(fRecarga, 12),
            gestionado: false,
            origenDato: 'importacion',
            ordenId: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          ops++; resultado.vencimientosCreados++;
          await commitSiLleno();
        }

      } catch (errFila) {
        resultado.errores.push({ fila, error: errFila.message });
      }
    }

    if (ops > 0) await batch.commit();

    await auditar({
      accion: 'importar',
      descripcion: `Importación: ${resultado.vencimientosCreados} vencimientos, ${resultado.clientesNuevos} clientes nuevos, ${resultado.prospectosCreados} prospectos, ${resultadoExtra.prospectosActualizados} prospectos actualizados, ${resultado.porVerificar} teléfonos por verificar`,
      usuarioId: adminId, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { totalFilas: filas.length, errores: resultado.errores.length }
    });

    invalidarCache(adminId); // VENC-TOPE-001
    return res.json({ ...resultado, ...resultadoExtra });
  } catch (err) {
    console.error('POST /vencimientos/importar:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// ✅ VENC-CICLO-002 — LIMPIEZA RETROACTIVA
// ─────────────────────────────────────────────────────────────────────────────
// El cierre automático solo aplica a órdenes NUEVAS. Los vencimientos que hoy
// están abiertos aunque el cliente ya vino quedaron así por el bug anterior.
// Esta ruta los detecta cruzando contra las órdenes ya facturadas.
//
// SEGURIDAD: por defecto es SIMULACIÓN — devuelve qué cerraría sin tocar nada.
// Solo con { aplicar: true } escribe. Nunca se cierra una base a ciegas.
//
// Body: { aplicar?: boolean, mesesAtras?: number }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/cerrar-ciclos-servidos', async (req, res) => {
  try {
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    if (req.user?.role !== 'admin' && !req.user?.superAdmin) {
      return res.status(403).json({ error: 'Solo el administrador puede cerrar ciclos' });
    }

    const aplicar    = req.body?.aplicar === true;
    const mesesAtras = Math.min(Math.max(Number(req.body?.mesesAtras) || 6, 1), 24);

    // Fecha límite hacia atrás para revisar órdenes
    const hoyCO = new Date(Date.now() - 5 * 3600 * 1000);
    const desde = new Date(hoyCO.getFullYear(), hoyCO.getMonth() - mesesAtras, 1)
      .toISOString().slice(0, 10);

    // 1) Órdenes del tenant con items que generan vencimiento
    const { esItemConVencimiento } = require('../services/vencimientosService');
    const ordSnap = await db.collection('orders')
      .where('adminId', '==', adminId)
      .limit(5000).get();

    // Teléfono → dato del servicio más reciente
    const servidos = new Map();
    ordSnap.docs.forEach(d => {
      const o = d.data();
      const fecha = (o.fecha || o.createdAt?.toDate?.()?.toISOString() || '').slice(0, 10);
      if (!fecha || fecha < desde) return;
      if (o.estado === 'anulada' || o.anulada === true) return;
      if (!(o.items || []).some(esItemConVencimiento)) return;

      const tel = normTelCiclo(o.clienteCelular || o.clienteTelefono || o.telefono);
      if (!tel) return;
      const previo = servidos.get(tel);
      if (!previo || fecha > previo.fecha) {
        servidos.set(tel, {
          fecha,
          mes: fecha.slice(0, 7),
          ordenId: d.id,
          numeroOrden: o.numeroOrden || '',
          cliente: o.clienteNombre || '',
          sucursal: o.sucursal || o.sucursalDireccion || null,
        });
      }
    });

    if (!servidos.size) {
      return res.json({ simulacion: !aplicar, revisados: 0, aCerrar: 0, detalle: [] });
    }

    // 2) Vencimientos abiertos que ya deberían estar cerrados
    const vencSnap = await db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .where('gestionado', '==', false)
      .limit(5000).get();

    const aCerrar = [];
    vencSnap.docs.forEach(d => {
      const v = d.data();
      if (!v.fechaVencimiento) return;
      const tel = normTelCiclo(v.telefono);
      if (!tel) return;
      const serv = servidos.get(tel);
      if (!serv) return;
      // Solo VENCIDOS respecto al mes en que se prestó el servicio.
      // Un vencimiento posterior al servicio sigue vivo (equipos con otras fechas).
      if (v.fechaVencimiento > `${serv.mes}-31`) return;

      aCerrar.push({
        id: d.id,
        cliente: v.clienteNombre || serv.cliente || '',
        telefono: v.telefono,
        equipo: v.descripcionEquipo || '',
        vencia: v.fechaVencimiento,
        atendidoEn: serv.fecha,
        orden: serv.numeroOrden,
        ordenId: serv.ordenId,
      });
    });

    // 3) Aplicar solo si se pidió explícitamente
    if (aplicar && aCerrar.length) {
      // Firestore limita a 500 escrituras por lote
      for (let i = 0; i < aCerrar.length; i += 450) {
        const lote = db.batch();
        aCerrar.slice(i, i + 450).forEach(x => {
          lote.update(db.collection('vencimientos').doc(x.id), {
            gestionado: true,
            estadoCiclo: 'RENOVADO',
            cerradoPorOrdenId: x.ordenId,
            cerradoMotivo: 'limpieza_retroactiva',
            cerradoAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await lote.commit();
      }

      await auditar({
        accion: 'cerrar_ciclos_servidos',
        descripcion: `Cierre retroactivo: ${aCerrar.length} vencimiento(s) marcados como renovados por servicio ya facturado`,
        usuarioId: adminId,
        usuarioNombre: req.user?.nombre || '',
        datos: { cantidad: aCerrar.length, mesesAtras },
      });
    }

    if (aplicar && aCerrar.length) invalidarCache(adminId); // VENC-TOPE-001

    return res.json({
      simulacion: !aplicar,
      clientesConServicio: servidos.size,
      aCerrar: aCerrar.length,
      detalle: aCerrar.slice(0, 100), // muestra para revisión
    });
  } catch (err) {
    console.error('POST /vencimientos/cerrar-ciclos-servidos:', err);
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/vencimientos/:id — Actualizar (fecha, sucursal) o marcar gestionado
// ═════════════════════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const ref = db.collection('vencimientos').doc(req.params.id);
    const doc = await ref.get();

    if (!doc.exists) return res.status(404).json({ error: 'Vencimiento no encontrado' });
    if (doc.data().adminId !== adminId) return res.status(403).json({ error: 'No autorizado' }); // aislamiento

    const { sucursal, descripcionEquipo, cantidad, fechaUltimaRecarga, fechaVencimiento, gestionado, ordenId } = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (sucursal !== undefined) update.sucursal = sucursal;
    if (descripcionEquipo) update.descripcionEquipo = descripcionEquipo;
    if (cantidad !== undefined) update.cantidad = Number(cantidad) || 1;
    if (esFechaValida(fechaUltimaRecarga)) {
      update.fechaUltimaRecarga = fechaUltimaRecarga;
      update.fechaVencimiento = sumarMeses(fechaUltimaRecarga, 12);
    }
    if (esFechaValida(fechaVencimiento)) update.fechaVencimiento = fechaVencimiento;
    if (typeof gestionado === 'boolean') update.gestionado = gestionado;
    if (ordenId !== undefined) update.ordenId = ordenId;

    await ref.update(update);

    await auditar({
      accion: 'actualizar', descripcion: `Vencimiento ${req.params.id} actualizado`,
      usuarioId: adminId, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { cambios: Object.keys(update) }
    });

    invalidarCache(adminId); // VENC-TOPE-001
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
