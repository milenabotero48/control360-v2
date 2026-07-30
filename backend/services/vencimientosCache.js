// ============================================================
// Control360 — Caché de lectura del módulo Vencimientos
// Ubicación: backend/services/vencimientosCache.js
// ------------------------------------------------------------
// POR QUÉ EXISTE (VENC-TOPE-001)
// Los tres endpoints de lectura del panel (listado, acordeón por mes y
// tarjetas de resumen) tienen que responder sobre el MISMO universo de datos,
// o vuelven a pasar cosas como que el resumen diga 8.027 y el acordeón sume
// 1.906. Para lograrlo se recorre la colección completa una vez y el
// resultado vive acá, compartido por los tres.
//
// POR QUÉ ES UN MÓDULO APARTE Y NO UNA VARIABLE EN LA RUTA
// Porque quien crea vencimientos es el servicio (al crear una orden), y quien
// los lee es la ruta. Si la caché viviera dentro de routes/vencimientos.js, el
// servicio tendría que importar una ruta para invalidarla — dependencia
// circular. Con este módulo intermedio, ambos dependen de él y ninguno del
// otro.
//
// TTL de 60s como red de seguridad. En la práctica la invalidación explícita
// hace que el cambio se vea al instante: si creás una orden con recarga, el
// vencimiento aparece en el panel al recargar, no en un minuto.
// ============================================================

const TTL_MS = 60 * 1000;

// adminId → { filas, expira }
const CACHE = new Map();

/** Devuelve las filas cacheadas del tenant, o null si no hay o vencieron. */
function obtener(adminId) {
  if (!adminId) return null;
  const entrada = CACHE.get(adminId);
  if (!entrada) return null;
  if (entrada.expira <= Date.now()) { CACHE.delete(adminId); return null; }
  return entrada.filas;
}

/** Guarda las filas del tenant. */
function guardar(adminId, filas) {
  if (!adminId) return;
  CACHE.set(adminId, { filas, expira: Date.now() + TTL_MS });
}

/**
 * Invalida la caché de un tenant (o de todos si no se pasa adminId).
 * Llamar SIEMPRE después de crear, editar, importar o borrar vencimientos.
 */
function invalidar(adminId) {
  if (adminId) CACHE.delete(adminId); else CACHE.clear();
}

module.exports = { obtener, guardar, invalidar, TTL_MS };
