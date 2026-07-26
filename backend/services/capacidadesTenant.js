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
//
// ============================================================
// FIX INV-KARDEX-001 — CLAVES PREMIUM OPT-IN
// ------------------------------------------------------------
// PROBLEMA
// La convención "modulos vacío = TODOS activos" es correcta para
// las capacidades OPERATIVAS (taller, logistica, cxc, qr): un
// suscriptor sin restricción configurada debe poder operar. Pero
// aplicada a los módulos COMERCIALES premium produce lo contrario
// de lo que el negocio necesita: cualquier tenant con `modulos`
// vacío quedaría con Kardex, Lucy y Anny encendidos gratis.
//
// SOLUCIÓN
// Se separan dos universos con semánticas opuestas:
//
//   CLAVES (operativas)  → vacío = TODAS activas   (fail-open)
//   PREMIUM (comerciales)→ vacío = NINGUNA activa  (opt-in)
//
// Un módulo premium solo se concede si su clave está listada
// EXPLÍCITAMENTE en users/{adminId}.modulos. Sandra las activa una
// por una desde el Panel de Suscriptores.
//
// POR QUÉ 'qr' NO SE MUEVE A PREMIUM
// 'qr' es a la vez capacidad operativa (la máquina de estados de
// orders.js decide flujos con ella) y módulo comercial. Moverla a
// opt-in cambiaría el flujo de órdenes de todo tenant con `modulos`
// vacío — un cambio de comportamiento que NO pertenece a este fix.
// Se deja en CLAVES. Su restricción comercial se sigue haciendo en
// la UI, como hasta hoy.
//
// FAIL-CLOSED (inverso al de las operativas)
// Si la lectura de Firestore falla, un módulo premium se niega. Un
// error de red nunca puede regalar un módulo de pago. Es la decisión
// segura: el peor caso es que Sandra vea un "no disponible" pasajero,
// no que un competidor acceda al Kardex.
// ============================================================

const { db } = require('../config/firebase');

// TTL de la caché en memoria (ms)
const TTL_MS = 60 * 1000;

// adminId → { capacidades, expira }
const CACHE = new Map();

// ✅ INV-KARDEX-001: caché de módulos premium. Se declara AQUÍ, junto a CACHE,
// y no más abajo: invalidarCapacidades() la referencia, y dejar la declaración
// después de esa función crearía una Temporal Dead Zone.
const CACHE_PREMIUM = new Map();

// Capacidades conocidas por el sistema. Cada una corresponde 1:1 con una
// clave real del array `modulos` en la colección `users`.
const CLAVES = ['taller', 'logistica', 'cxc', 'qr'];

// ✅ INV-KARDEX-001: módulos comerciales premium. Semántica OPT-IN: solo se
// conceden si la clave está listada explícitamente en users/{adminId}.modulos.
// La convención "vacío = todo activo" NO aplica aquí.
const PREMIUM = ['llamadas_ia', 'anny_ia', 'inventario_pro'];

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
  CACHE_PREMIUM.delete(adminId || '');
  if (!adminId) CACHE_PREMIUM.clear();
}

// ════════════════════════════════════════════════════════════════════════════
// ✅ INV-KARDEX-001: MÓDULOS PREMIUM (OPT-IN)
// ════════════════════════════════════════════════════════════════════════════

// (CACHE_PREMIUM se declara arriba, junto a CACHE)

/**
 * ¿El tenant tiene contratado un módulo premium?
 * Semántica OPT-IN: `modulos` vacío o ausente = NO lo tiene.
 * FAIL-CLOSED: si la lectura falla, devuelve false.
 *
 * @param {string} adminId  UID del admin dueño del tenant.
 * @param {string} clave    p.ej. 'inventario_pro'
 * @returns {Promise<boolean>}
 */
async function tieneModuloPremium(adminId, clave) {
  if (!adminId || !clave) return false;

  const k = String(clave).toLowerCase().trim();
  // Una clave que no está declarada como premium no se gestiona aquí.
  if (!PREMIUM.includes(k)) return false;

  const enCache = CACHE_PREMIUM.get(adminId);
  if (enCache && enCache.expira > Date.now()) return enCache.modulos.has(k);

  try {
    const doc = await db.collection('users').doc(adminId).get();
    const mods = doc.exists && Array.isArray(doc.data().modulos)
      ? doc.data().modulos
      : [];
    const set = new Set(
      mods.map(m => String(m || '').toLowerCase().trim()).filter(Boolean)
    );
    CACHE_PREMIUM.set(adminId, { modulos: set, expira: Date.now() + TTL_MS });
    return set.has(k);
  } catch (e) {
    // FAIL-CLOSED: un error de red no regala un módulo de pago.
    console.error('INV-KARDEX-001 lectura premium falló, fail-closed:', e.message);
    return false;
  }
}

/**
 * Middleware Express que exige un módulo premium.
 * Uso: router.use(requireModuloPremium('inventario_pro'))
 */
function requireModuloPremium(clave) {
  return async (req, res, next) => {
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    const tiene = await tieneModuloPremium(adminId, clave);
    if (!tiene) {
      return res.status(403).json({
        error: 'MODULO_NO_ACTIVO',
        modulo: clave,
        mensaje: 'Este módulo no está activo en tu plan. Contacta a Control360 para activarlo.'
      });
    }
    next();
  };
}

module.exports = {
  getCapacidades,
  invalidarCapacidades,
  todasActivas,
  PREMIUM,
  tieneModuloPremium,
  requireModuloPremium
};
