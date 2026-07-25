// ============================================================
// Control360 — Capacidades operativas del tenant
// Ubicación: backend/services/capacidadesTenant.js
// FIX CAPACIDAD-TENANT-001
// ------------------------------------------------------------
// PROBLEMA QUE RESUELVE
// La máquina de estados de orders.js decidía el flujo mirando SOLO
// los ítems de la orden, asumiendo que todo suscriptor tiene Taller
// y Logística. Un suscriptor del plan Independiente ($75.000) o
// Punto de Venta ($50.000) que crea su categoría "Recarga y
// Mantenimiento" generaba órdenes que nacían en 'en_taller' — un
// estado cuya ÚNICA salida la ejecuta el módulo Taller, que él no
// tiene contratado. Resultado: orden muerta, sin cierre, sin caja.
//
// SOLUCIÓN
// Las capacidades operativas del tenant (qué módulos tiene realmente
// contratados) pasan a ser una ENTRADA de la máquina de estados.
// Si el tenant no tiene 'taller', ninguna orden puede nacer ni caer
// en 'en_taller', venga de la UI, de la API o de un cron.
//
// INVARIANTES RESPETADOS
// 1. `modulos` vacío = TODOS los módulos activos (convención del
//    sistema). Un tenant sin restricción conserva TODAS las
//    capacidades → comportamiento byte-idéntico al actual.
// 2. FAIL-OPEN: si la lectura de Firestore falla, se devuelven todas
//    las capacidades en true, es decir, EXACTAMENTE el comportamiento
//    anterior a este fix. Un error de red nunca puede bloquear una
//    orden ni cambiar un flujo que hoy funciona.
// 3. La fuente de verdad sigue siendo users/{adminId}.modulos. Este
//    servicio no inventa un segundo lugar donde configurar módulos.
//
// RENDIMIENTO
// Caché en memoria del proceso con TTL de 60s por adminId. En el peor
// caso: 1 lectura de Firestore por tenant por minuto. Se invalida de
// inmediato desde superadmin.js al cambiar módulos, así que en la
// práctica el cambio es instantáneo y el TTL es solo red de seguridad.
//
// REGLA DE USO (importante para no degradar el rendimiento):
// llamar SOLO en endpoints que ya hacen operaciones pesadas de
// Firestore (crear orden, cambiar estado, completar taller).
// NUNCA dentro de un bucle por documento ni en endpoints de listado.
// ============================================================

const { db } = require('../config/firebase');

// TTL de la caché en memoria (ms)
const TTL_MS = 60 * 1000;

// adminId → { capacidades, expira }
const CACHE = new Map();

// Capacidades conocidas por el sistema. Cada una corresponde 1:1 con una
// clave real del array `modulos` en la colección `users`.
const CLAVES = ['taller', 'logistica', 'cxc', 'qr'];

// Todas activas = comportamiento histórico del sistema.
const TODAS = Object.freeze(
  CLAVES.reduce((acc, k) => { acc[k] = true; return acc; }, {})
);

const todasActivas = () => ({ ...TODAS });

/**
 * Capacidades operativas de un tenant.
 * @param {string} adminId  UID del admin dueño del tenant.
 * @returns {Promise<{taller:boolean, logistica:boolean, cxc:boolean, qr:boolean}>}
 */
async function getCapacidades(adminId) {
  // Sin adminId no hay nada que restringir: fail-open.
  if (!adminId) return todasActivas();

  const enCache = CACHE.get(adminId);
  if (enCache && enCache.expira > Date.now()) return { ...enCache.capacidades };

  let capacidades = todasActivas();
  try {
    const doc = await db.collection('users').doc(adminId).get();
    const mods = doc.exists && Array.isArray(doc.data().modulos)
      ? doc.data().modulos
      : [];

    // Invariante 1: lista vacía = todos los módulos.
    if (mods.length > 0) {
      const set = new Set(
        mods.map(m => String(m || '').toLowerCase().trim()).filter(Boolean)
      );
      capacidades = CLAVES.reduce((acc, k) => { acc[k] = set.has(k); return acc; }, {});
    }
    CACHE.set(adminId, { capacidades, expira: Date.now() + TTL_MS });
  } catch (e) {
    // Invariante 2: FAIL-OPEN. No se cachea el fallo — se reintenta
    // en la siguiente llamada.
    console.error('CAPACIDAD-TENANT-001 lectura falló, fail-open:', e.message);
    return todasActivas();
  }

  return { ...capacidades };
}

/**
 * Invalida la caché de un tenant (o de todos si no se pasa adminId).
 * Lo llama superadmin.js al guardar módulos para que el cambio sea
 * inmediato y no haya que esperar el TTL.
 */
function invalidarCapacidades(adminId) {
  if (adminId) CACHE.delete(adminId);
  else CACHE.clear();
}

module.exports = { getCapacidades, invalidarCapacidades, todasActivas };
