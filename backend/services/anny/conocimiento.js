// ============================================================
// Control360 — Anny · MOTOR v3 · conocimiento.js
// Ubicación: backend/services/anny/conocimiento.js
// ============================================================
// ANNY-V3-CONOCIMIENTO: catálogo, diccionario y SELECCIÓN POR
// RELEVANCIA de lo que entra al prompt.
//
// ANNY-COTIZA-056 — regla de cotización:
//   1. Si el DICCIONARIO resuelve → solo esos productos entran.
//      El catálogo completo NO entra. Es determinístico.
//   2. Si no resuelve → catálogo FILTRADO por familia de intención
//      (recarga vs nuevo en extintores) y por coincidencia de
//      palabras con nombre/alias/categoría. Máx 25 líneas.
//   3. Sin familia clara y con pregunta de precio → el prompt le
//      indica al modelo que pregunte UNA cosa antes de cotizar.
//   4. Lo que el cliente dijo y no resolvió queda sugerido como
//      palabra clave (annySugerencias) para el panel.
//
// products usa `creadoPor` como campo de tenant (invariante).
// ============================================================

const { db, admin } = require('../../config/firebase');
const { CACHE_TTL_MS } = require('./config');
const { normalizar, tokens, detectarFamilia, preguntaPrecio } = require('./texto');

const _cacheCatalogo = new Map();
const _cacheDiccionario = new Map();

function _leer(mapa, k) { const c = mapa.get(k); return (c && Date.now() - c.ts < CACHE_TTL_MS) ? c.data : null; }
function _guardar(mapa, k, data) { mapa.set(k, { data, ts: Date.now() }); return data; }

// ============================================================
// Catálogo del tenant (activos, con precio). Sin tope de 80/250:
// el tope va en la SELECCIÓN, no en la carga.
// ============================================================
async function obtenerCatalogoProductos(adminId) {
  const c = _leer(_cacheCatalogo, adminId);
  if (c) return c;
  try {
    const snap = await db.collection('products')
      .where('creadoPor', '==', adminId)
      .where('activo', '==', true)
      .limit(600)
      .get();

    const items = [];
    snap.forEach(d => {
      const p = d.data();
      const precio = Number(p.precioVenta) || 0;
      if (!p.nombre || precio <= 0) return;
      const alias = []
        .concat(Array.isArray(p.alias) ? p.alias : [])
        .concat(Array.isArray(p.palabrasClave) ? p.palabrasClave : [])
        .map(a => String(a).trim()).filter(Boolean).slice(0, 6);
      items.push({
        id: d.id,
        nombre: String(p.nombre).trim(),
        precio,
        categoria: p.categoria ? String(p.categoria).trim() : '',
        alias,
        _n: normalizar(`${p.nombre} ${p.categoria || ''} ${alias.join(' ')}`)
      });
    });
    items.sort((a, b) => (a.categoria || 'zzz').localeCompare(b.categoria || 'zzz') || a.nombre.localeCompare(b.nombre));
    return _guardar(_cacheCatalogo, adminId, items);
  } catch (err) {
    console.error('[ANNY] Error leyendo catálogo:', err.message);
    return [];
  }
}

function invalidarCacheCatalogo(adminId) { _cacheCatalogo.delete(adminId); }

// ============================================================
// Diccionario (ANNY-DICC-049): { [productoId]: { nombre, palabras } }
// ============================================================
async function obtenerDiccionarioTenant(adminId) {
  const c = _leer(_cacheDiccionario, adminId);
  if (c) return c;
  try {
    const doc = await db.collection('diccionarioAnny').doc(adminId).get();
    return _guardar(_cacheDiccionario, adminId, doc.exists ? (doc.data() || {}) : {});
  } catch (err) {
    console.error('[ANNY] Error leyendo diccionario:', err.message);
    return {};
  }
}

function invalidarCacheDiccionario(adminId) { _cacheDiccionario.delete(adminId); }

function resolverPorPalabrasClave(mensajeTexto, diccionario, catalogo) {
  const texto = normalizar(mensajeTexto);
  if (!texto || !diccionario) return [];
  const porId = new Map((catalogo || []).map(p => [p.id, p]));
  const encontrados = [];

  for (const [productoId, entrada] of Object.entries(diccionario)) {
    if (!entrada || !Array.isArray(entrada.palabras)) continue;
    let mejor = null;
    for (const p of entrada.palabras) {
      const n = normalizar(p);
      if (n.length >= 4 && texto.includes(n) && (!mejor || n.length > mejor.length)) mejor = n;
    }
    if (!mejor) continue;
    const prod = porId.get(productoId);
    if (!prod) {
      console.warn(`[ANNY-DICC] "${mejor}" apunta al producto ${productoId}, que ya no está activo`);
      continue;
    }
    encontrados.push({ id: prod.id, nombre: prod.nombre, precio: prod.precio, categoria: prod.categoria, coincidio: mejor, especificidad: mejor.length });
  }
  return encontrados.sort((a, b) => b.especificidad - a.especificidad).slice(0, 5);
}

// ============================================================
// ANNY-COTIZA-056 — selección del catálogo que entra al prompt
// Devuelve { productos: [...], modo: 'diccionario'|'filtrado'|'ninguno'|'ambiguo', familia }
// ============================================================
const MAX_LINEAS = 25;

function seleccionarCatalogo({ mensajeTexto, resueltos, catalogo, familias, slots }) {
  // 1. Diccionario manda
  if (resueltos && resueltos.length) {
    return { productos: resueltos, modo: 'diccionario', familia: null };
  }
  if (!catalogo || !catalogo.length) return { productos: [], modo: 'ninguno', familia: null };

  // Texto de búsqueda: mensaje actual + necesidad ya capturada en slots
  const base = `${mensajeTexto || ''} ${slots?.necesidad || ''}`;
  const familia = detectarFamilia(base, familias);
  const hayFamilias = familias && Object.keys(familias).length > 0;

  // 2. Familia ambigua con pregunta de precio → que pregunte antes
  if (hayFamilias && !familia && preguntaPrecio(base)) {
    return { productos: [], modo: 'ambiguo', familia: null };
  }

  // 3. Puntuar productos por coincidencia de tokens; filtrar por familia
  const palabrasFamilia = familia ? (familias[familia] || []).map(normalizar) : [];
  const otrasFamilias = hayFamilias
    ? Object.entries(familias).filter(([f]) => f !== familia).flatMap(([, ps]) => ps.map(normalizar))
    : [];
  const toks = tokens(base).filter(w => !palabrasFamilia.includes(w));

  const puntuados = catalogo.map(p => {
    let score = 0;
    if (familia) {
      const esDeFamilia = palabrasFamilia.some(w => p._n.includes(w));
      const esDeOtra = otrasFamilias.some(w => p._n.includes(w));
      if (esDeFamilia) score += 3;
      if (esDeOtra && !esDeFamilia) score -= 5;
    }
    for (const w of toks) if (p._n.includes(w)) score += 1;
    return { p, score };
  }).filter(x => x.score > 0);

  puntuados.sort((a, b) => b.score - a.score || a.p.nombre.localeCompare(b.p.nombre));
  const productos = puntuados.slice(0, MAX_LINEAS).map(x => x.p);
  return { productos, modo: productos.length ? 'filtrado' : 'ninguno', familia };
}

// ============================================================
// Sugerencia de palabras clave: frases del cliente que terminaron
// en cotización sin pasar por el diccionario. El panel las lista
// para que el suscriptor las vincule con un click.
// annySugerencias/{adminId}.frases = { [fraseNormalizada]: { veces, ultimaMs, producto } }
// ============================================================
async function sugerirPalabraClave(adminId, fraseCliente, productoNombre) {
  try {
    const f = normalizar(fraseCliente).slice(0, 80);
    if (f.length < 6) return;
    const clave = f.replace(/[.#$\[\]\/]/g, '_');
    await db.collection('annySugerencias').doc(adminId).set({
      frases: {
        [clave]: {
          frase: f,
          producto: productoNombre || null,
          veces: admin.firestore.FieldValue.increment(1),
          ultimaMs: Date.now()
        }
      }
    }, { merge: true });
  } catch (err) { /* nunca bloquea */ }
}

module.exports = {
  obtenerCatalogoProductos,
  invalidarCacheCatalogo,
  obtenerDiccionarioTenant,
  invalidarCacheDiccionario,
  resolverPorPalabrasClave,
  seleccionarCatalogo,
  sugerirPalabraClave
};
