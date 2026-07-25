// ============================================================
// Control360 — Anny · Utilidades compartidas
// Ubicación: frontend/src/components/anny/annyUI.js
// ============================================================
// Un solo lugar para la API, la paleta y los formateadores.
// Evita que cada subcomponente redefina lo mismo (era una de
// las causas de que el panel original creciera a 1.179 líneas).
// ============================================================

export const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

export const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`
});

// ── Paleta Control360 ────────────────────────────────────────
// El morado deja de ser fondo de pantalla y pasa a ser acento:
// marca lo que es de Anny, no toda la interfaz.
export const C = {
  accent: '#7C3AED',
  accentBg: '#F1EBFE',
  accentText: '#5B21B6',

  text: '#18181B',
  textSec: '#52525B',
  textMuted: '#A1A1AA',

  surface2: '#FFFFFF',
  surface1: '#F6F6F7',
  border: '#E5E5E8',

  danger: '#DC2626',
  dangerBg: '#FEF2F2',
  dangerText: '#991B1B',

  warn: '#D97706',
  warnBg: '#FFFBEB',
  warnText: '#92400E',

  ok: '#16A34A',
  okBg: '#F0FDF4',
  okText: '#166534'
};

// ── Formateadores ────────────────────────────────────────────
export function fmtHora(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '';
  const hoy = new Date();
  const mismoDia = d.toDateString() === hoy.toDateString();
  if (mismoDia) {
    return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  }
  const ayer = new Date(hoy.getTime() - 86400000);
  if (d.toDateString() === ayer.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

// Tiempo de espera de un escalado: "8 min", "2 h", "3 d"
export function fmtEspera(ms) {
  if (!ms) return '';
  const min = Math.floor((Date.now() - Number(ms)) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export function fmtMoneda(v) {
  const n = Number(String(v).replace(/[^\d.-]/g, '')) || 0;
  return `$${n.toLocaleString('es-CO')}`;
}

// Suma los valores de una lista de pedidos aunque vengan como
// texto ("$35.000", "35000 con domicilio", etc.)
export function sumarPedidos(pedidos) {
  return (pedidos || []).reduce((acc, p) => {
    const n = Number(String(p.total || '').replace(/[^\d]/g, '')) || 0;
    return acc + n;
  }, 0);
}
// FIN annyUI.js
