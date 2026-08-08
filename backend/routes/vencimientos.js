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
// ✅ VENC-EDICION-001 / VENC-IMPORT-LOTE-001: editar, borrar y revertir pasan
// por la MISMA autorización por PIN que egresos y órdenes (FIX PIN-UNICO-001).
const { verificarPin } = require('./_autorizacion');

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
// ✅ VENC-EQUIPO-NORM-001 (2026-08-05) — LOS NOMBRES GENÉRICOS QUE ESCAPABAN
// ─────────────────────────────────────────────────────────────────────────────
// Cuando el Excel trae la celda de equipo vacía, `partirEquipos` devuelve el
// literal 'Extintor'. Si otra fila del MISMO cliente sí traía el nombre bueno
// ("EXTINTOR ABC 5 LBS"), quedaban dos vencimientos que el ojo lee como
// duplicados pero que ningún agrupador por cliente+equipo detectaba: son
// cadenas distintas. En la tarjeta de Telemercadeo se ve como el mismo equipo
// listado dos veces, una con nombre completo y otra sin él.
//
// `claveEquipo` reduce el nombre a su forma comparable — mayúsculas, sin
// tildes, sin puntuación, con las unidades unificadas (LB/LBS/LIBRAS → LB) y
// sin la palabra EXTINTOR, que está en casi todos y no distingue nada. Se usa
// para AGRUPAR, nunca para mostrar: lo que ve el usuario sigue siendo el texto
// original del Excel.
//
// `GENERICO` es el marcador de "no sé qué equipo es": una descripción que se
// reduce a vacío. Un genérico NO crea un vencimiento nuevo si el cliente ya
// tiene otro equipo en ese mismo ciclo — se asume que es la misma máquina mal
// digitada, que es lo que pasa en la práctica.
// ═════════════════════════════════════════════════════════════════════════════
const GENERICO = '__GENERICO__';

const claveEquipo = (desc) => {
  let t = String(desc || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // sin tildes: SENAL = SEÑAL
    .toUpperCase();
  t = t.replace(/[^A-Z0-9]+/g, ' ');                     // puntuacion fuera
  // "5LBS" y "5 LBS" son lo mismo; "CO2" y "CO 2" tambien.
  t = t.replace(/(\d)([A-Z])/g, '$1 $2').replace(/([A-Z])(\d)/g, '$1 $2');
  t = t.replace(/\b(?:LIBRAS?|LBS)\b/g, 'LB').replace(/\b(?:KILOS?|KGS)\b/g, 'KG');
  // Palabras que estan en casi todos los registros y no distinguen nada.
  // OJO: EXTINTOR(?:ES)? — escribirlo "EXTINTORES?" haria que el ? aplique
  // solo a la S final, o sea "EXTINTORE" + S opcional, y nunca casaria.
  t = t.replace(/\b(?:EXTINTOR(?:ES)?|RECARGAS?|MANTENIMIENTOS?|DE|DEL|EL|LA)\b/g, ' ');
  t = t.replace(/\b0+(\d)/g, '$1');                      // "05 LB" = "5 LB"
  t = t.replace(/\b0\s*(?:LB|KG)\b/g, ' ');              // "0 LBS" es dato basura
  t = t.replace(/\s+/g, ' ').trim();
  return t || GENERICO;
};

// Clave de identidad de un vencimiento: mismo cliente, mismo equipo, mismo
// ciclo. La sucursal entra porque dos sedes del mismo cliente sí son equipos
// distintos. Es lo que hace que reimportar el mismo archivo no multiplique.
const claveVencimiento = (clienteId, descEquipo, sucursal, fechaVencimiento) => [
  clienteId,
  claveEquipo(descEquipo),
  String(sucursal || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim(),
  String(fechaVencimiento || '').slice(0, 7), // el ciclo es el MES, no el día
].join('|');

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

  // 1. Escaneo completo — el bug era el `.limit(2000)`, no la falta de
  // paginación. Una consulta sin limit devuelve TODOS los documentos que
  // cumplen el filtro: Firestore los entrega en streaming, no hay tope.
  //
  // ⚠️ NO agregar `.orderBy('__name__')` para paginar: combinado con el
  // `where('adminId')` exige un índice compuesto que este proyecto no tiene
  // (regla del proyecto: sin orderBy/índices compuestos). Al intentarlo, la
  // consulta lanzaba FAILED_PRECONDITION, los tres endpoints devolvían 500 y
  // el panel quedaba en "Sin vencimientos". El orden se hace en memoria más
  // abajo, que es lo que ya hacía el código original.
  const crudos = [];
  const snap = await db.collection('vencimientos')
    .where('adminId', '==', adminId)
    .get();
  snap.docs.forEach(d => crudos.push({ id: d.id, ...d.data() }));

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
    console.error('GET /vencimientos/resumen:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vencimientos/estadisticas — Panel de inteligencia comercial
// ─────────────────────────────────────────────────────────────────────────────
// ✅ VENC-KPI-001 (2026-08-08)
//
// Hasta hoy la pantalla contestaba "¿cuántos registros hay?". Un gerente no
// necesita eso: necesita saber CUÁNTA PLATA entra este mes y CUÁNTA se está
// yendo. Este endpoint traduce la base a esas dos preguntas.
//
// Qué devuelve:
//   · mesActual   — clientes esperados, equipos, venta proyectada, ya atendidos
//   · retorno     — serie de 12 meses: esperados vs. regresados vs. % de retorno
//   · proyeccion  — venta esperada de los próximos 6 meses
//   · empresas    — el mismo corte por razón social facturadora
//   · topEquipos  — qué se recarga más (para saber qué tener en inventario)
//
// ── CÓMO SE VALORIZA (regla de negocio) ──────────────────────────────────────
// El precio NUNCA se inventa ni se quema en el código: sale de la lista de
// productos del suscriptor (`products.precioVenta`, el precio al público). Cada
// suscriptor tiene los suyos.
//
// La descripción del equipo se reduce con `claveEquipo` — la MISMA función que
// usa el anti-duplicados — y se busca contra los productos reducidos igual.
// Así "2 x ABC 10 LBS", "recarga abc 10 lb" y "EXTINTOR ABC 10 LIBRAS" caen
// todos en el mismo producto. La cantidad del vencimiento multiplica el precio:
// "2 ABC de 10 lbs" = 2 recargas.
//
// Si un equipo no casa con ningún producto, NO se estima con un promedio: se
// cuenta aparte en `sinPrecio`. Una proyección con supuestos invisibles es peor
// que una proyección incompleta — el gerente tiene que saber qué parte de su
// base todavía no está valorizada.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/estadisticas', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const filas = await cargarTodos(adminId);
    const hoy = hoyColombia();
    const mesHoy = hoy.slice(0, 7);

    // ── 1. Lista de precios del suscriptor ──────────────────────────────────
    const prodSnap = await db.collection('products').where('adminId', '==', adminId).get();
    const preciosPorClave = new Map();
    prodSnap.docs.forEach(d => {
      const p = d.data();
      const precio = Number(p.precioVenta) || 0;
      if (!precio) return;
      const clave = claveEquipo(p.nombre);
      if (clave === GENERICO) return;
      // Si dos productos comparten clave (ej. recarga y venta del mismo
      // extintor), se conserva el de MENOR precio: proyectar recompra sobre el
      // precio de venta de equipo nuevo infla la cifra y engaña al gerente.
      const actual = preciosPorClave.get(clave);
      if (!actual || precio < actual.precio) {
        preciosPorClave.set(clave, { precio, nombre: p.nombre });
      }
    });

    const valorizar = (v) => {
      const clave = claveEquipo(v.descripcionEquipo);
      const cant = Number(v.cantidad) || 1;
      const hit = preciosPorClave.get(clave);
      if (hit) return { valor: hit.precio * cant, conPrecio: true, cant };
      // Coincidencia parcial: el producto puede llamarse "RECARGA ABC 10 LB
      // POLVO QUIMICO" y el equipo venir como "ABC 10 LB".
      if (clave !== GENERICO) {
        for (const [k, item] of preciosPorClave) {
          if (k.includes(clave) || clave.includes(k)) {
            return { valor: item.precio * cant, conPrecio: true, cant };
          }
        }
      }
      return { valor: 0, conPrecio: false, cant };
    };

    // ── 2. Agregación por mes de vencimiento ────────────────────────────────
    // "Regresó" = el ciclo se cerró con venta: RENOVADO, o gestionado, o con
    // una orden asociada. Es el hecho comercial, no una marca manual suelta.
    const regreso = (v) => v.estadoCiclo === 'RENOVADO' || !!v.ordenId || v.gestionado === true;
    const perdido = (v) => v.estadoCiclo === 'PERDIDO';

    const meses = new Map();
    const tocarMes = (k) => {
      if (!meses.has(k)) {
        meses.set(k, {
          mes: k, equipos: 0, cantidadEquipos: 0,
          clientes: new Set(), clientesRegresaron: new Set(), clientesPerdidos: new Set(),
          ventaProyectada: 0, ventaRealizada: 0, sinPrecio: 0,
        });
      }
      return meses.get(k);
    };

    const porEmpresa = new Map();
    const porEquipo = new Map();

    filas.forEach(v => {
      const k = (v.fechaVencimiento || '').slice(0, 7);
      if (!k) return;
      const m = tocarMes(k);
      const val = valorizar(v);
      const cli = v.clienteId || v.telefono || 'sin_cliente';

      m.equipos += 1;
      m.cantidadEquipos += val.cant;
      m.clientes.add(cli);
      m.ventaProyectada += val.valor;
      if (!val.conPrecio) m.sinPrecio += 1;
      if (regreso(v)) { m.clientesRegresaron.add(cli); m.ventaRealizada += val.valor; }
      if (perdido(v)) m.clientesPerdidos.add(cli);

      // Corte por empresa facturadora (solo del mes en curso hacia adelante)
      if (k >= mesHoy) {
        const emp = v.empresaNombre || 'Sin empresa asignada';
        if (!porEmpresa.has(emp)) porEmpresa.set(emp, { empresa: emp, equipos: 0, clientes: new Set(), venta: 0 });
        const e = porEmpresa.get(emp);
        e.equipos += val.cant; e.clientes.add(cli); e.venta += val.valor;
      }

      // Qué se recarga más — sirve para planear inventario
      if (k === mesHoy) {
        const nombreEq = v.descripcionEquipo || 'Sin especificar';
        if (!porEquipo.has(nombreEq)) porEquipo.set(nombreEq, { equipo: nombreEq, cantidad: 0, valor: 0 });
        const pe = porEquipo.get(nombreEq);
        pe.cantidad += val.cant; pe.valor += val.valor;
      }
    });

    const serializarMes = (m) => ({
      mes: m.mes,
      clientesEsperados: m.clientes.size,
      clientesRegresaron: m.clientesRegresaron.size,
      clientesPerdidos: m.clientesPerdidos.size,
      tasaRetorno: m.clientes.size ? Math.round((m.clientesRegresaron.size / m.clientes.size) * 1000) / 10 : 0,
      equipos: m.equipos,
      cantidadEquipos: m.cantidadEquipos,
      ventaProyectada: Math.round(m.ventaProyectada),
      ventaRealizada: Math.round(m.ventaRealizada),
      equiposSinPrecio: m.sinPrecio,
    });

    const todosLosMeses = [...meses.values()].map(serializarMes).sort((a, b) => a.mes.localeCompare(b.mes));

    // ── 3. Recortes que consume la pantalla ─────────────────────────────────
    const idxHoy = todosLosMeses.findIndex(m => m.mes === mesHoy);
    const mesActual = todosLosMeses.find(m => m.mes === mesHoy) || {
      mes: mesHoy, clientesEsperados: 0, clientesRegresaron: 0, clientesPerdidos: 0,
      tasaRetorno: 0, equipos: 0, cantidadEquipos: 0, ventaProyectada: 0, ventaRealizada: 0, equiposSinPrecio: 0,
    };

    // Historia de retorno: 12 meses cerrados hacia atrás (sin incluir el actual,
    // que todavía está corriendo y siempre se vería artificialmente bajo).
    const historico = todosLosMeses.filter(m => m.mes < mesHoy).slice(-12);
    const proyeccion = todosLosMeses.filter(m => m.mes >= mesHoy).slice(0, 6);

    // Vencidos sin atender: el dinero que se está yendo hoy.
    const vencidosAbiertos = filas.filter(v => v.estado === 'VENCIDO');
    const clientesVencidos = new Set(vencidosAbiertos.map(v => v.clienteId || v.telefono));
    const valorVencido = vencidosAbiertos.reduce((s, v) => s + valorizar(v).valor, 0);

    // Promedio de retorno de los últimos 6 meses cerrados — la referencia
    // realista contra la cual comparar el mes en curso.
    const ultimos6 = historico.slice(-6).filter(m => m.clientesEsperados > 0);
    const retornoPromedio = ultimos6.length
      ? Math.round((ultimos6.reduce((s, m) => s + m.tasaRetorno, 0) / ultimos6.length) * 10) / 10
      : 0;

    return res.json({
      generadoEn: hoy,
      mesActual,
      mesAnterior: idxHoy > 0 ? todosLosMeses[idxHoy - 1] : null,
      retornoPromedio6m: retornoPromedio,
      historico,
      proyeccion,
      vencidos: {
        equipos: vencidosAbiertos.length,
        clientes: clientesVencidos.size,
        valor: Math.round(valorVencido),
      },
      empresas: [...porEmpresa.values()]
        .map(e => ({ empresa: e.empresa, equipos: e.equipos, clientes: e.clientes.size, venta: Math.round(e.venta) }))
        .sort((a, b) => b.venta - a.venta),
      topEquipos: [...porEquipo.values()].sort((a, b) => b.cantidad - a.cantidad).slice(0, 8),
      cobertura: {
        productosConPrecio: preciosPorClave.size,
        equiposSinPrecioMes: mesActual.equiposSinPrecio,
      },
    });
  } catch (err) {
    console.error('GET /vencimientos/estadisticas:', err);
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
    // Empresa facturadora POR DEFECTO. Antes era obligatoria y venía de un
    // selector en pantalla; hoy es solo el respaldo para las filas que no
    // traen la suya (ver VENC-IMPORT-EMPRESA-001, justo abajo).
    const empresaId = req.body?.empresaId || '';
    const empresaNombre = req.body?.empresaNombre || '';
    const archivoNombre = String(req.body?.archivoNombre || '').slice(0, 160) || 'importacion.csv';
    // ✅ COMERCIAL-BASE-001: mes de la base importada — lo heredan los
    // prospectos creados desde filas sin fecha, para que en Telemercadeo
    // no se mezclen bases de meses distintos.
    const periodoActual = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 7);
    const basePeriodo = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.body?.basePeriodo || '') ? req.body.basePeriodo : periodoActual;

    if (!filas.length) return res.status(400).json({ error: 'No se recibieron filas para importar' });
    if (filas.length > 2000) return res.status(400).json({ error: 'Máximo 2000 filas por importación. Divide el archivo.' });

    // ═══ ✅ VENC-IMPORT-EMPRESA-001 (2026-08-08) — LA EMPRESA VIAJA EN EL ARCHIVO
    // ─────────────────────────────────────────────────────────────────────────
    // Antes: el selector "¿qué empresa factura?" aplicaba a TODA la carga. Una
    // suscriptora con dos razones sociales tenía que partir su base en dos
    // archivos y hacer dos importaciones — con el riesgo de equivocarse de
    // empresa en la segunda y no darse cuenta hasta facturar.
    //
    // Ahora cada fila puede traer su propia empresa facturadora en la columna
    // `empresaFactura` y se resuelve contra la colección companies del tenant,
    // emparejando por NIT o por nombre normalizado. Un solo archivo con toda
    // la base, cada cliente a su razón social.
    //
    // ⚠️ NO se reutilizó la columna `empresa`: en esta plantilla esa columna ya
    // significa "razón social DEL CLIENTE" y es alias de `nombre`. Cambiarle el
    // sentido habría roto en silencio todos los archivos ya existentes.
    const empresasSnap = await db.collection('companies').where('adminId', '==', adminId).get();
    const normEmpresa = (s) => String(s || '')
      .toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z0-9]/g, '');
    const empresasPorNombre = new Map();
    const empresasPorNit = new Map();
    empresasSnap.docs.forEach(d => {
      const c = d.data();
      const item = { id: d.id, nombre: c.name || '' };
      const n = normEmpresa(c.name);
      if (n) empresasPorNombre.set(n, item);
      const nit = String(c.nit || '').replace(/[^0-9]/g, '');
      if (nit) empresasPorNit.set(nit, item);
    });

    // Empresa por defecto: la del body si vino, si no la única del tenant.
    let empresaDefault = empresaId
      ? { id: empresaId, nombre: empresaNombre }
      : (empresasSnap.size === 1
          ? { id: empresasSnap.docs[0].id, nombre: empresasSnap.docs[0].data().name || '' }
          : null);

    const resolverEmpresa = (valor) => {
      const bruto = String(valor || '').trim();
      if (!bruto) return { empresa: empresaDefault, resuelta: !!empresaDefault, pedida: '' };
      const soloDigitos = bruto.replace(/[^0-9]/g, '');
      if (soloDigitos.length >= 8 && empresasPorNit.has(soloDigitos)) {
        return { empresa: empresasPorNit.get(soloDigitos), resuelta: true, pedida: bruto };
      }
      const n = normEmpresa(bruto);
      if (n && empresasPorNombre.has(n)) {
        return { empresa: empresasPorNombre.get(n), resuelta: true, pedida: bruto };
      }
      // Coincidencia parcial: "ALMAR" contra "EXTINTORES ALMAR SAS".
      if (n.length >= 4) {
        for (const [clave, item] of empresasPorNombre) {
          if (clave.includes(n) || n.includes(clave)) {
            return { empresa: item, resuelta: true, pedida: bruto };
          }
        }
      }
      return { empresa: empresaDefault, resuelta: false, pedida: bruto };
    };

    // Si el archivo no trae empresaFactura en ninguna fila y el tenant tiene
    // varias empresas, sí hace falta decidir: se pide explícitamente.
    const algunaFilaTraeEmpresa = filas.some(f => String(f.empresaFactura || '').trim());
    if (!algunaFilaTraeEmpresa && !empresaDefault) {
      return res.status(400).json({
        error: 'Tu cuenta tiene varias empresas. Agrega la columna "empresaFactura" al archivo o selecciona una empresa por defecto.',
        codigo: 'EMPRESA_REQUERIDA',
        empresas: empresasSnap.docs.map(d => ({ id: d.id, name: d.data().name })),
      });
    }

    // Empresas que el archivo nombró y no existen en el tenant: se avisa al
    // final para que la suscriptora corrija el texto o cree la empresa.
    const empresasNoReconocidas = new Map();

    // ═══ ✅ VENC-IMPORT-LOTE-001 (2026-08-08) — TODA CARGA ES REVERSIBLE ══════
    // Cada documento que nace en esta importación queda marcado con el mismo
    // `loteId`. Eso convierte "me equivoqué de archivo" en un problema de un
    // clic en vez de un script de limpieza a mano — que es exactamente lo que
    // hubo que hacer cuando Valle terminó con 7.961 vencimientos duplicados.
    const loteId = db.collection('importaciones').doc().id;
    const loteRef = db.collection('importaciones').doc(loteId);
    const loteIds = { vencimientos: [], clientes: [], prospectos: [] };

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


    // ═══ ✅ VENC-IMPORT-DUP-001 (2026-08-05) — LA GUARDA QUE FALTABA ═══════════
    // Hasta hoy cada fila hacía `db.collection('vencimientos').doc()` sin
    // preguntar nada: un documento NUEVO siempre. Subir el mismo archivo dos
    // veces multiplicaba la base. Así fue como Valle llegó a 7.961 vencimientos
    // para 2.440 clientes con cuatro importaciones del mismo día, y por eso
    // hubo que borrar 4.045 documentos a mano con un script.
    //
    // Ahora se carga UNA vez el índice de vencimientos ya existentes del tenant
    // y cada fila se compara contra él por clave de identidad
    // (cliente + equipo normalizado + sucursal + mes de vencimiento). Si ya
    // existe, se OMITE — no se pisa, porque el documento viejo puede tener
    // gestión encima (gestionado, telemercadeo, estadoCiclo) que se perdería.
    //
    // El índice también recibe las claves creadas durante ESTA importación, así
    // que un archivo con la misma máquina repetida en dos filas tampoco duplica.
    const vencExistentes = new Set();
    // Índice auxiliar: qué equipos CON NOMBRE ya tiene cada cliente en cada
    // ciclo. Sirve para el caso "genérico": una fila sin nombre de equipo no
    // debe crear una máquina nueva si el cliente ya tiene otra en ese mes.
    const equiposPorClienteCiclo = new Map();
    // Vencimientos que va a crear ESTA importación: clave → { ref, data }.
    // Se acumulan en memoria y se escriben al final, para poder sumar la
    // cantidad cuando el mismo equipo aparece en varias filas del archivo.
    const vencPendientes = new Map();
    {
      // Un solo escaneo alimenta los dos índices.
      const snapV = await db.collection('vencimientos').where('adminId', '==', adminId).get();
      snapV.docs.forEach(d => {
        const v = d.data();
        vencExistentes.add(claveVencimiento(v.clienteId, v.descripcionEquipo, v.sucursal, v.fechaVencimiento));
        if (!v.clienteId || !v.fechaVencimiento) return;
        const ce = claveEquipo(v.descripcionEquipo);
        if (ce === GENERICO) return; // un genérico no "ocupa" el ciclo
        const k = v.clienteId + '|' + String(v.fechaVencimiento).slice(0, 7);
        if (!equiposPorClienteCiclo.has(k)) equiposPorClienteCiclo.set(k, new Set());
        equiposPorClienteCiclo.get(k).add(ce);
      });
    }

    let resultadoExtra = { prospectosActualizados: 0 };
    // ✅ TELEFONO-UNIF-001: contador de teléfonos dudosos (bandera ☎️)
    // ✅ VENC-IMPORT-DUP-001: `vencimientosOmitidos` es dato de gestión, no ruido:
    // si subís un archivo y sale todo omitido, es que ya estaba cargado.
    const resultado = { vencimientosCreados: 0, vencimientosOmitidos: 0, clientesNuevos: 0, prospectosCreados: 0, porVerificar: 0, errores: [] };
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

        // ✅ VENC-IMPORT-EMPRESA-001: empresa facturadora de ESTA fila.
        const rEmp = resolverEmpresa(f.empresaFactura);
        if (!rEmp.resuelta && rEmp.pedida) {
          empresasNoReconocidas.set(rEmp.pedida, (empresasNoReconocidas.get(rEmp.pedida) || 0) + 1);
        }
        const empresaFilaId = rEmp.empresa?.id || '';
        const empresaFilaNombre = rEmp.empresa?.nombre || '';

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
            loteId, // ✅ VENC-IMPORT-LOTE-001
            empresaFacturaId: empresaFilaId || null,
            empresaFacturaNombre: empresaFilaNombre || null,
            basePeriodo, // ✅ COMERCIAL-BASE-001
            estado: 'NUEVO',
            asignadoA: null,
            proximaLlamada: null,
            clienteId: porTelefono.get(telefono) || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          loteIds.prospectos.push(refP.id);
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
            // ✅ VENC-IMPORT-EMPRESA-001: la empresa que factura a ESTE cliente
            // sale de su propia fila, no de un selector global.
            empresaId: empresaFilaId,
            empresaNombre: empresaFilaNombre,
            sucursales: [],
            notas: '',
            origen: 'importacion_vencimientos',
            loteId, // ✅ VENC-IMPORT-LOTE-001
            activo: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          loteIds.clientes.push(refC.id);
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
        const fVencimiento = sumarMeses(fRecarga, 12);
        const cicloKey = clienteId + '|' + fVencimiento.slice(0, 7);
        if (!equiposPorClienteCiclo.has(cicloKey)) equiposPorClienteCiclo.set(cicloKey, new Set());
        const yaEnCiclo = equiposPorClienteCiclo.get(cicloKey);

        for (const eq of equiposFila) {
          const desc = eq.descripcion || 'Extintor';
          const clave = claveVencimiento(clienteId, desc, f.sucursal, fVencimiento);

          // ✅ VENC-IMPORT-DUP-001: este equipo, de este cliente, en este
          // ciclo, YA ESTÁ en la base de una importación anterior → no se
          // toca. Es lo que hace que reimportar el mismo archivo no multiplique.
          if (vencExistentes.has(clave)) { resultado.vencimientosOmitidos++; continue; }

          // ✅ VENC-IMPORT-DUP-001 — el caso que NO es duplicado:
          // el mismo archivo puede traer el mismo equipo en varias filas porque
          // el cliente tiene VARIOS idénticos ("3 extintores ABC 5 LBS" escritos
          // como 3 renglones en vez de uno con cantidad 3). Eso es inventario
          // real: no se descarta, se SUMA la cantidad al documento pendiente.
          // La diferencia con el caso de arriba es de dónde viene la repetición:
          // de otra importación (duplicado) o de este mismo archivo (inventario).
          const pendiente = vencPendientes.get(clave);
          if (pendiente) {
            pendiente.data.cantidad += eq.cantidad;
            continue;
          }

          // ✅ VENC-EQUIPO-NORM-001: fila sin nombre de equipo ("Extintor" a
          // secas) cuando el cliente YA tiene equipos con nombre en este mismo
          // ciclo. No es una máquina adicional: es la misma mal digitada. Antes
          // creaba un vencimiento fantasma y la tarjeta de Telemercadeo
          // mostraba "Extintor ABC 5 lbs" y "Extintor" como si fueran dos.
          if (claveEquipo(desc) === GENERICO && yaEnCiclo.size > 0) {
            resultado.vencimientosOmitidos++;
            continue;
          }

          if (claveEquipo(desc) !== GENERICO) yaEnCiclo.add(claveEquipo(desc));

          vencPendientes.set(clave, {
            ref: db.collection('vencimientos').doc(),
            data: {
              adminId,
              clienteId,
              sucursal: f.sucursal || null,
              descripcionEquipo: desc,
              // ✅ VENC-EQUIPO-NORM-001: la forma comparable se guarda junto al
              // texto original. El usuario sigue viendo lo que trajo su Excel;
              // los agrupadores y la próxima limpieza usan esta.
              equipoClave: claveEquipo(desc),
              cantidad: eq.cantidad,
              fechaUltimaRecarga: fRecarga,
              fechaVencimiento: fVencimiento,
              gestionado: false,
              origenDato: 'importacion',
              loteId, // ✅ VENC-IMPORT-LOTE-001
              // ✅ VENC-IMPORT-EMPRESA-001: se guarda en el vencimiento para
              // poder filtrar y proyectar venta por razón social sin tener que
              // leer el cliente en cada consulta.
              empresaId: empresaFilaId || null,
              empresaNombre: empresaFilaNombre || null,
              ordenId: null,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          });
          resultado.vencimientosCreados++;
        }

      } catch (errFila) {
        resultado.errores.push({ fila, error: errFila.message });
      }
    }

    if (ops > 0) await batch.commit();

    // ✅ VENC-IMPORT-DUP-001: escritura final de los vencimientos, ya con las
    // cantidades sumadas. Va después del bucle porque hasta que no se recorre
    // todo el archivo no se sabe cuántas filas apuntan al mismo equipo.
    {
      const aEscribir = [...vencPendientes.values()];
      for (let i = 0; i < aEscribir.length; i += 400) {
        const loteBatch = db.batch();
        aEscribir.slice(i, i + 400).forEach(v => { loteBatch.set(v.ref, v.data); loteIds.vencimientos.push(v.ref.id); });
        await loteBatch.commit();
      }
    }

    // ✅ VENC-IMPORT-LOTE-001: ficha del lote. Guarda los ids creados para
    // poder revertir exactamente lo que este archivo agregó — ni un documento
    // más. Firestore admite 1 MiB por documento; con ~40 bytes por id eso da
    // margen de sobra para el tope de 2.000 filas del importador.
    const empresasResumen = {};
    [...vencPendientes.values()].forEach(v => {
      const n = v.data.empresaNombre || 'Sin empresa';
      empresasResumen[n] = (empresasResumen[n] || 0) + 1;
    });
    await loteRef.set({
      adminId,
      archivo: archivoNombre,
      fecha: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
      basePeriodo,
      usuarioId: adminId,
      usuarioNombre: req.user?.nombre || req.user?.email || '',
      totalFilas: filas.length,
      vencimientosCreados: resultado.vencimientosCreados,
      vencimientosOmitidos: resultado.vencimientosOmitidos,
      clientesNuevos: resultado.clientesNuevos,
      prospectosCreados: resultado.prospectosCreados,
      prospectosActualizados: resultadoExtra.prospectosActualizados,
      porVerificar: resultado.porVerificar,
      errores: resultado.errores.slice(0, 50),
      totalErrores: resultado.errores.length,
      empresas: empresasResumen,
      empresasNoReconocidas: Object.fromEntries(empresasNoReconocidas),
      ids: loteIds,
      revertido: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await auditar({
      accion: 'importar',
      descripcion: `Importación: ${resultado.vencimientosCreados} vencimientos, ${resultado.vencimientosOmitidos} omitidos por ya existir, ${resultado.clientesNuevos} clientes nuevos, ${resultado.prospectosCreados} prospectos, ${resultadoExtra.prospectosActualizados} prospectos actualizados, ${resultado.porVerificar} teléfonos por verificar`,
      usuarioId: adminId, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { totalFilas: filas.length, errores: resultado.errores.length }
    });

    invalidarCache(adminId); // VENC-TOPE-001
    return res.json({
      ...resultado,
      ...resultadoExtra,
      loteId,
      empresas: empresasResumen,
      empresasNoReconocidas: Object.fromEntries(empresasNoReconocidas),
    });
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

    const { sucursal, descripcionEquipo, cantidad, fechaUltimaRecarga, fechaVencimiento, gestionado, ordenId, pin, motivo } = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    // ═══ ✅ VENC-EDICION-001 — PIN SOLO PARA LO QUE MUEVE EL NEGOCIO ═════════
    // Marcar "gestionado" es la operación del día a día: la hace la vendedora
    // decenas de veces y pedirle PIN cada vez la volvería inutilizable.
    // Cambiar la FECHA o el EQUIPO es distinto: corre el próximo vencimiento
    // del cliente y con él la llamada, la alerta y la venta proyectada. Eso sí
    // pasa por PIN, igual que anular un egreso.
    const cambiaEstructura = descripcionEquipo !== undefined
      || cantidad !== undefined
      || sucursal !== undefined
      || fechaUltimaRecarga !== undefined
      || fechaVencimiento !== undefined;

    if (cambiaEstructura) {
      const auth = await verificarPin(req.user?.uid || req.user?.id, pin, 'editar_vencimiento');
      if (!auth.ok) return res.status(403).json({ error: auth.error, codigo: auth.codigo });
    }

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
      datos: { cambios: Object.keys(update), motivo: motivo || null, antes: doc.data() }
    });

    invalidarCache(adminId); // VENC-TOPE-001
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DELETE /api/vencimientos/:id — Borrar un vencimiento (PIN + motivo)
// ─────────────────────────────────────────────────────────────────────────────
// ✅ VENC-EDICION-001. Borrar saca al cliente del radar comercial: no vuelve a
// aparecer en Vencimientos, ni en Telemercadeo, ni en las alertas de Lucy.
// Por eso: PIN de admin, motivo obligatorio y COPIA COMPLETA en auditoría —
// si se borró por error, el documento se puede reconstruir desde el log.
// ═════════════════════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { pin, motivo } = req.body || {};

    const ref = db.collection('vencimientos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Vencimiento no encontrado' });
    if (doc.data().adminId !== adminId) return res.status(403).json({ error: 'No autorizado' });

    const auth = await verificarPin(req.user?.uid || req.user?.id, pin, 'borrar_vencimiento');
    if (!auth.ok) return res.status(403).json({ error: auth.error, codigo: auth.codigo });

    if (!motivo || String(motivo).trim().length < 5) {
      return res.status(400).json({ error: 'Escribe el motivo del borrado (mínimo 5 caracteres)' });
    }

    const datosPrevios = doc.data();
    await ref.delete();

    await auditar({
      accion: 'borrar',
      descripcion: `Vencimiento borrado: ${datosPrevios.descripcionEquipo || 'equipo'} (vence ${datosPrevios.fechaVencimiento || 's/f'})`,
      usuarioId: adminId, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { vencimientoId: req.params.id, motivo: String(motivo).trim(), documento: datosPrevios },
    });

    invalidarCache(adminId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /vencimientos/:id:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vencimientos/importaciones — Últimas N importaciones (default 5)
// ─────────────────────────────────────────────────────────────────────────────
// ✅ VENC-IMPORT-LOTE-001. Responde la pregunta que hoy nadie puede responder
// mirando la pantalla: "¿qué subí, cuándo, y qué entró de verdad?".
// ═════════════════════════════════════════════════════════════════════════════
router.get('/importaciones', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const limite = Math.min(Number(req.query.limite) || 5, 20);

    // Sin orderBy en la consulta: evita exigir un índice compuesto nuevo en
    // Firestore. El volumen es de decenas de documentos, se ordena en memoria.
    const snap = await db.collection('importaciones').where('adminId', '==', adminId).get();
    const lista = snap.docs
      .map(d => {
        const v = d.data();
        return {
          id: d.id,
          archivo: v.archivo,
          fecha: v.fecha,
          usuarioNombre: v.usuarioNombre,
          basePeriodo: v.basePeriodo,
          totalFilas: v.totalFilas,
          vencimientosCreados: v.vencimientosCreados,
          vencimientosOmitidos: v.vencimientosOmitidos,
          clientesNuevos: v.clientesNuevos,
          prospectosCreados: v.prospectosCreados,
          prospectosActualizados: v.prospectosActualizados || 0,
          porVerificar: v.porVerificar || 0,
          totalErrores: v.totalErrores || 0,
          errores: v.errores || [],
          empresas: v.empresas || {},
          empresasNoReconocidas: v.empresasNoReconocidas || {},
          revertido: !!v.revertido,
          revertidoEn: v.revertidoEn || null,
          revertidoMotivo: v.revertidoMotivo || null,
          // Cuánto se puede deshacer todavía (los ids siguen guardados)
          reversible: !v.revertido && !!(v.ids?.vencimientos?.length || v.ids?.clientes?.length || v.ids?.prospectos?.length),
        };
      })
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
      .slice(0, limite);

    return res.json(lista);
  } catch (err) {
    console.error('GET /vencimientos/importaciones:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/vencimientos/importaciones/:id/revertir — Deshacer una carga
// ─────────────────────────────────────────────────────────────────────────────
// ✅ VENC-IMPORT-LOTE-001. Borra SOLO los documentos que creó ese archivo,
// identificados por id — no por fecha ni por filtro aproximado.
//
// SEGURIDAD, en capas:
//   1. Por defecto es SIMULACIÓN: dice qué borraría sin tocar nada.
//   2. Para aplicar: { aplicar: true } + PIN de admin + motivo escrito.
//   3. NO borra lo que ya tiene gestión encima (gestionado, estadoCiclo,
//      orden asociada). Deshacer una importación jamás puede borrar el
//      trabajo comercial que se hizo después sobre esos registros.
//   4. Los clientes solo se borran si nacieron en esta importación Y no
//      quedaron con vencimientos ni órdenes vivas.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/importaciones/:id/revertir', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { aplicar = false, pin, motivo } = req.body || {};

    const loteRef = db.collection('importaciones').doc(req.params.id);
    const loteDoc = await loteRef.get();
    if (!loteDoc.exists) return res.status(404).json({ error: 'Importación no encontrada' });
    const lote = loteDoc.data();
    if (lote.adminId !== adminId) return res.status(403).json({ error: 'No autorizado' });
    if (lote.revertido) return res.status(400).json({ error: 'Esta importación ya fue revertida' });

    const ids = lote.ids || { vencimientos: [], clientes: [], prospectos: [] };

    // ── Clasificar vencimientos: borrables vs protegidos por gestión ─────────
    const leerEnBloques = async (coleccion, listaIds) => {
      const docs = [];
      for (let i = 0; i < listaIds.length; i += 30) {
        const trozo = listaIds.slice(i, i + 30);
        const snaps = await Promise.all(trozo.map(id => db.collection(coleccion).doc(id).get()));
        snaps.forEach(s => { if (s.exists) docs.push({ id: s.id, ...s.data() }); });
      }
      return docs;
    };

    const vencs = await leerEnBloques('vencimientos', ids.vencimientos || []);
    const tieneGestion = (v) => !!(v.gestionado || v.ordenId || (v.estadoCiclo && v.estadoCiclo !== 'ABIERTO'));
    const vencBorrables = vencs.filter(v => !tieneGestion(v));
    const vencProtegidos = vencs.filter(tieneGestion);

    const prospectos = await leerEnBloques('prospectos', ids.prospectos || []);
    const prospBorrables = prospectos.filter(p => (p.estado || 'NUEVO') === 'NUEVO' && !p.ultimaLlamada);
    const prospProtegidos = prospectos.filter(p => !((p.estado || 'NUEVO') === 'NUEVO' && !p.ultimaLlamada));

    // Clientes: solo los que nacieron aquí y quedan sin vencimientos vivos.
    const idsVencBorrables = new Set(vencBorrables.map(v => v.id));
    const clientesLote = await leerEnBloques('clients', ids.clientes || []);
    const clienteBorrable = [];
    const clienteProtegido = [];
    for (const c of clientesLote) {
      const vivos = vencs.filter(v => v.clienteId === c.id && !idsVencBorrables.has(v.id)).length;
      const ordenSnap = await db.collection('orders').where('clienteId', '==', c.id).limit(1).get();
      if (vivos === 0 && ordenSnap.empty) clienteBorrable.push(c);
      else clienteProtegido.push(c);
    }

    const plan = {
      loteId: req.params.id,
      archivo: lote.archivo,
      vencimientos: { borrar: vencBorrables.length, conservar: vencProtegidos.length },
      prospectos:   { borrar: prospBorrables.length, conservar: prospProtegidos.length },
      clientes:     { borrar: clienteBorrable.length, conservar: clienteProtegido.length },
      motivoConservar: 'Se conservan los registros con gestión comercial encima (llamada registrada, orden asociada o ciclo cerrado).',
    };

    if (!aplicar) return res.json({ simulacion: true, ...plan });

    // ── Aplicar: exige PIN + motivo ──────────────────────────────────────────
    const auth = await verificarPin(req.user?.uid || req.user?.id, pin, 'revertir_importacion');
    if (!auth.ok) return res.status(403).json({ error: auth.error, codigo: auth.codigo });
    if (!motivo || String(motivo).trim().length < 10) {
      return res.status(400).json({ error: 'Escribe el motivo de la reversión (mínimo 10 caracteres)' });
    }

    const borrarLote = async (coleccion, docs) => {
      for (let i = 0; i < docs.length; i += 400) {
        const b = db.batch();
        docs.slice(i, i + 400).forEach(d => b.delete(db.collection(coleccion).doc(d.id)));
        await b.commit();
      }
    };

    await borrarLote('vencimientos', vencBorrables);
    await borrarLote('prospectos', prospBorrables);
    await borrarLote('clients', clienteBorrable);

    await loteRef.update({
      revertido: true,
      revertidoEn: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
      revertidoPor: req.user?.nombre || req.user?.email || adminId,
      revertidoMotivo: String(motivo).trim(),
      revertidoDetalle: plan,
    });

    await auditar({
      accion: 'revertir_importacion',
      descripcion: `Importación "${lote.archivo}" revertida: ${vencBorrables.length} vencimientos, ${prospBorrables.length} prospectos y ${clienteBorrable.length} clientes borrados`,
      usuarioId: adminId, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { loteId: req.params.id, motivo: String(motivo).trim(), plan },
    });

    invalidarCache(adminId);
    return res.json({ simulacion: false, ok: true, ...plan });
  } catch (err) {
    console.error('POST /vencimientos/importaciones/:id/revertir:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
