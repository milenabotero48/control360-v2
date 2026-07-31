// ═══════════════════════════════════════════════════════════════════════════
// ✅ MOVIMIENTOS-SIGNO-001 — FUENTE ÚNICA DE VERDAD DEL SIGNO DE UN MOVIMIENTO
// ---------------------------------------------------------------------------
// PROBLEMA QUE RESUELVE (caso real OS-0759, 31/07/2026):
// Un traslado entre cajas genera DOS documentos en `movimientos`
// (backend/routes/cajas.js:291-293):
//     · tipo 'traslado_salida'  en la caja ORIGEN   → el dinero sale
//     · tipo 'traslado_entrada' en la caja DESTINO  → el dinero entra
//
// El frontend tenía TRES reglas distintas para el mismo dato:
//     · GestionCaja.js:681   ['ingreso','traslado_entrada']        ✔ correcta
//     · GestionCaja.js:787   tipo === 'egreso' ? '-' : '+'         ✘
//     · GestionCaja.js:1095  tipo === 'ingreso' ? '+' : '-'        ✘ ← el bug
//     · CajaGraficas.js:138  ignoraba los traslados por completo   ✘
//
// Con la regla de la línea 1095, un 'traslado_entrada' (plata que ENTRA) se
// pintaba en rojo con signo menos. El mismo traslado aparecía negativo en la
// caja origen Y en la caja destino: en pantalla parecían salir $199.920
// cuando en realidad no salió un peso de la empresa.
//
// Los SALDOS nunca estuvieron mal (el backend los mueve en batch atómico).
// Lo que estaba roto era la lectura.
//
// Esta regla es la MISMA que ya usa el backend en el Cuadre Diario
// (backend/routes/cajas.js:503) — la única implementación que estaba bien.
// Cualquier pantalla nueva que lea `movimientos` debe importar de aquí.
// ═══════════════════════════════════════════════════════════════════════════

// Tipos que AUMENTAN el saldo de la caja en la que están registrados.
export const TIPOS_ENTRADA = ['ingreso', 'traslado_entrada'];

// Tipos que DISMINUYEN el saldo de la caja en la que están registrados.
export const TIPOS_SALIDA = ['egreso', 'traslado_salida'];

// Un traslado NO es ingreso ni egreso del negocio: es dinero cambiando de
// bolsillo dentro de la misma empresa. Contablemente no toca resultados, por
// eso se reporta SEPARADO del flujo operativo (ver FlujoMensual).
export const esTraslado = (tipo) => String(tipo || '').startsWith('traslado_');

export const esEntrada = (tipo) => TIPOS_ENTRADA.includes(tipo);
export const esSalida = (tipo) => TIPOS_SALIDA.includes(tipo);

// Signo visual. Nota: se define por lista blanca de ENTRADAS. Un tipo nuevo
// y desconocido se trata como salida (conservador: es preferible alarmar de
// más que dar por buena una entrada que no lo es).
export const signoDe = (tipo) => (esEntrada(tipo) ? '+' : '-');

// Colores del sistema (verde entrada / rojo salida / gris traslado).
export const COLOR_ENTRADA = '#16a34a';
export const COLOR_SALIDA = '#dc2626';
export const COLOR_TRASLADO = '#64748b';

export const colorDe = (tipo) => (esEntrada(tipo) ? COLOR_ENTRADA : COLOR_SALIDA);

export const iconoDe = (tipo) => ({
  ingreso: '📥',
  egreso: '📤',
  traslado_salida: '🔄↗',
  traslado_entrada: '🔄↘',
  ajuste: '⚖️',
}[tipo] || '💰');

// Etiqueta legible para el usuario final (no el nombre técnico del campo).
export const etiquetaDe = (tipo) => ({
  ingreso: 'Ingreso',
  egreso: 'Egreso',
  traslado_salida: 'Traslado enviado',
  traslado_entrada: 'Traslado recibido',
  ajuste: 'Ajuste',
}[tipo] || tipo || 'Movimiento');

// Monto normalizado (siempre positivo) — para pintar junto a `signoDe`.
export const montoAbs = (m) => Math.abs(Number(m?.monto) || 0);

// Monto CON signo — para sumar. Usar esto para cuadrar contra el saldo:
//   saldo === saldoInicial + movimientos.reduce((a, m) => a + montoConSigno(m), 0)
export const montoConSigno = (m) => (esEntrada(m?.tipo) ? 1 : -1) * montoAbs(m);
