// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-V2-009 — ELECCIÓN DEL PRECIO DE RECARGA PARA LUCY
// ─────────────────────────────────────────────────────────────────────────────
// Lucy llama a recordar vencimientos, o sea que SOLO cotiza RECARGAS — nunca un
// equipo nuevo. Antes el servidor confiaba en un parámetro `esRecarga` que
// llenaba el modelo en plena llamada; un error suyo daba el precio del
// extintor nuevo ($45.000) en vez del de la recarga.
//
// Regla (decidida con Milena):
//   1. CATEGORÍA primero: productos cuya categoría contiene "RECARGA"
//      (p. ej. "RECARGAS Y MANTENIMIENTO"). Cada suscriptor nombra sus
//      categorías, por eso se busca la palabra y no un id fijo. Si el
//      producto no tiene esa categoría, vale que RECARGA esté en su nombre.
//   2. CAPACIDAD después, OBLIGATORIA: cada número pedido ("5", "10") debe
//      aparecer completo en el nombre. "5" no coincide con "15", "25" ni "50".
//      Sin número en la consulta no se adivina: no hay precio.
//   3. TIPO (ABC, CO2...) solo desempata. Si no piden tipo, se prefiere ABC,
//      el más común.
//   4. Precio 0 o ausente nunca se ofrece.
// Si nada cumple: null → Lucy dice que un asesor confirma el valor.
// ═════════════════════════════════════════════════════════════════════════════
const normalizar = (s) =>
  String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const tokensDe = (s) => normalizar(s).match(/[A-Z0-9]+/g) || [];

// Palabras que no ayudan a distinguir un producto de otro.
const RUIDO = new Set([
  'LBS', 'LB', 'LIBRA', 'LIBRAS', 'DE', 'DEL', 'LA', 'EL', 'Y', 'CON', 'PARA',
  'UN', 'UNA', 'EXTINTOR', 'EXTINTORES', 'RECARGA', 'RECARGAS',
]);

const esNumero = (t) => /^\d+$/.test(t);

const contieneNumeroExacto = (nombre, n) =>
  new RegExp(`(^|[^0-9])${n}(?![0-9])`).test(nombre);

const esProductoDeRecarga = (p) =>
  normalizar(p.categoria).includes('RECARGA') || normalizar(p.nombre).includes('RECARGA');

/**
 * @param {Array<{nombre:string,categoria?:string,precioVenta?:number}>} productos
 * @param {string} descripcion  lo que pide Lucy ("recarga ABC 5 lbs", "Extintor ABC 10 lbs")
 * @returns {object|null} el producto elegido o null
 */
const elegirRecarga = (productos, descripcion) => {
  const tokens = tokensDe(descripcion);
  const numeros = tokens.filter(esNumero);
  if (numeros.length === 0) return null;                 // sin capacidad no se adivina

  const tipos = tokens.filter(t => !esNumero(t) && !RUIDO.has(t));

  let mejor = null;
  let mejorPuntaje = -1;

  for (const p of productos) {
    if (!esProductoDeRecarga(p)) continue;
    if (!(Number(p.precioVenta) > 0)) continue;

    const nombre = normalizar(p.nombre);
    if (!numeros.every(n => contieneNumeroExacto(nombre, n))) continue;

    let puntaje = tipos.filter(t => nombre.includes(t)).length * 10;
    if (tipos.length === 0 && nombre.includes('ABC')) puntaje += 5;   // sin tipo: ABC
    puntaje -= nombre.length / 1000;                                  // desempate: nombre más corto

    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = p;
    }
  }
  return mejor;
};

module.exports = { elegirRecarga, normalizar };
