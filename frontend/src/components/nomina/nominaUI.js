// ═══════════════════════════════════════════════════════════════════════════════
// nominaUI.js — Estilos y helpers compartidos del módulo de nómina
// ─────────────────────────────────────────────────────────────────────────────
// Vive aparte para que los componentes nuevos no tengan que engordar
// GestionEmpleados.js, que ya pasa de 1.200 líneas. Mismo criterio que
// components/anny/annyUI.js.
// ═══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';

export const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

export const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

export const api = {
  get:  (path, config = {}) => axios.get(`${API}${path}`, { headers: headers(), ...config }),
  post: (path, body, config = {}) => axios.post(`${API}${path}`, body, { headers: headers(), ...config }),
};

export const fmt = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(Number(n) || 0);

export const fmtNum = (n, dec = 0) => new Intl.NumberFormat('es-CO', {
  minimumFractionDigits: dec, maximumFractionDigits: dec
}).format(Number(n) || 0);

export const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

/** Extrae el mensaje de error del backend sin dejar al usuario con "Error 500". */
export const errorDe = (e, porDefecto = 'Ocurrió un error') =>
  e?.response?.data?.error || e?.message || porDefecto;

export const COLOR_CONCEPTO = {
  cesantias:          '#7c3aed',
  interesesCesantias: '#0284c7',
  prima:              '#16a34a',
  vacaciones:         '#d97706',
  seguridadSocial:    '#dc2626',
};

export const NIVEL = {
  grave: { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', icono: '⚠️' },
  media: { bg: '#fffbeb', border: '#fde68a', color: '#92400e', icono: '🟡' },
  info:  { bg: '#eff6ff', border: '#bfdbfe', color: '#1e40af', icono: 'ℹ️' },
};

export const S = {
  card: {
    background: '#fff', borderRadius: 16, padding: '20px 22px',
    border: '1px solid #f1f5f9', boxShadow: '0 1px 4px rgba(15,23,42,0.05)',
    marginBottom: 16,
  },
  cardTitle: { margin: 0, fontSize: 15, fontWeight: 800, color: '#0f172a' },
  cardSub: { margin: '4px 0 0', fontSize: 12.5, color: '#64748b', lineHeight: 1.55 },

  grid: (min = 200) => ({
    display: 'grid', gap: 12,
    gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
  }),

  kpi: (color) => ({
    background: '#fff', borderRadius: 14, padding: '15px 17px',
    border: '1px solid #f1f5f9', borderLeft: `4px solid ${color}`,
  }),
  kpiLabel: { fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.04em' },
  kpiValue: (color) => ({ fontSize: 21, fontWeight: 800, color, marginTop: 5, lineHeight: 1.15 }),
  kpiHint: { fontSize: 11, color: '#94a3b8', marginTop: 4 },

  th: {
    padding: '10px 12px', textAlign: 'left', fontSize: 10.5, fontWeight: 700,
    color: '#64748b', textTransform: 'uppercase', letterSpacing: '.04em',
    borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap', background: '#f8fafc',
  },
  td: { padding: '11px 12px', fontSize: 12.5, color: '#334155', borderBottom: '1px solid #f1f5f9' },
  tdNum: { padding: '11px 12px', fontSize: 12.5, color: '#0f172a', textAlign: 'right', fontWeight: 600, borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap' },

  btnPrimary: {
    padding: '10px 20px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
    color: '#fff', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer',
  },
  btnPago: {
    padding: '10px 20px', background: 'linear-gradient(135deg,#7c3aed,#6d28d9)',
    color: '#fff', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer',
  },
  btnPeligro: {
    padding: '10px 20px', background: 'linear-gradient(135deg,#dc2626,#b91c1c)',
    color: '#fff', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer',
  },
  btnSecondary: {
    padding: '10px 20px', background: '#f1f5f9', color: '#475569',
    border: '1px solid #e2e8f0', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  btnMini: {
    padding: '5px 11px', borderRadius: 7, border: '1px solid #e2e8f0', cursor: 'pointer',
    fontSize: 11.5, fontWeight: 600, background: '#f8fafc', color: '#475569',
  },

  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
  },
  modal: (w = 620) => ({
    background: '#fff', borderRadius: 18, maxWidth: w, width: '100%',
    boxShadow: '0 24px 70px rgba(0,0,0,0.25)', maxHeight: '92vh', overflowY: 'auto',
  }),
  modalHeader: {
    padding: '20px 24px 14px', display: 'flex', justifyContent: 'space-between',
    alignItems: 'flex-start', gap: 12, borderBottom: '1px solid #f1f5f9',
  },
  modalTitle: { margin: 0, fontSize: 17, fontWeight: 800, color: '#0f172a' },
  modalBody: { padding: '18px 24px 20px' },
  modalFooter: {
    display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18,
    paddingTop: 16, borderTop: '1px solid #f1f5f9', flexWrap: 'wrap',
  },
  closeBtn: { background: 'none', border: 'none', fontSize: 21, cursor: 'pointer', color: '#94a3b8', padding: 2, lineHeight: 1 },

  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: 700, color: '#374151' },
  input: {
    padding: '10px 12px', border: '1.5px solid #e2e8f0', borderRadius: 9,
    fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff', width: '100%', boxSizing: 'border-box',
  },
  row2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 },
};

/** Caja de aviso reutilizable. */
export const Aviso = ({ nivel = 'info', titulo, children, style }) => {
  const n = NIVEL[nivel] || NIVEL.info;
  return (
    <div style={{
      background: n.bg, border: `1px solid ${n.border}`, borderRadius: 11,
      padding: '12px 15px', fontSize: 12.5, color: n.color, lineHeight: 1.6,
      display: 'flex', gap: 10, alignItems: 'flex-start', ...style,
    }}>
      <span style={{ fontSize: 15, lineHeight: 1.2 }}>{n.icono}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {titulo && <div style={{ fontWeight: 800, marginBottom: 3 }}>{titulo}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
};

/** Campo de PIN — todas las acciones sensibles del sistema lo piden. */
export const CampoPin = ({ value, onChange, accion = 'esta operación' }) => (
  <div style={S.field}>
    <label style={S.label}>PIN de autorización *</label>
    <input
      type="password" inputMode="numeric" maxLength={4} autoComplete="off"
      value={value} onChange={e => onChange(e.target.value.replace(/\D/g, ''))}
      placeholder="····"
      style={{ ...S.input, letterSpacing: 6, fontSize: 17, textAlign: 'center', maxWidth: 150 }}
    />
    <span style={{ fontSize: 11, color: '#94a3b8' }}>
      {accion} queda registrada en auditoría con tu usuario.
    </span>
  </div>
);
