import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import PanelAlertasInteligentes from './PanelAlertasInteligentes'; // Ola 3 Bloque 3

const API = 'http://localhost:5000/api';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard del Admin (Control360 v2 — Ola 2)
// ─────────────────────────────────────────────────────────────────────────────
// Una sola llamada a /api/dashboards/admin trae todos los datos.
// 8 KPIs + 3 barras de meta + panel de alertas + actividad reciente.
// ─────────────────────────────────────────────────────────────────────────────

const fmtCop = (v) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0
}).format(v || 0);

const fmtNum = (v) => new Intl.NumberFormat('es-CO').format(v || 0);

const ESTADO_LABELS = {
  programada:       { label: 'Programada',       color: '#6366f1', bg: '#eef2ff' },
  en_ruta_recogida: { label: 'En Ruta Recogida', color: '#f59e0b', bg: '#fffbeb' },
  en_taller:        { label: 'En Taller',         color: '#8b5cf6', bg: '#f5f3ff' },
  facturado:        { label: 'Facturado',         color: '#0284c7', bg: '#e0f2fe' },
  despacho:         { label: 'Despacho',          color: '#d97706', bg: '#fef3c7' },
  en_ruta_entrega:  { label: 'En Ruta Entrega',   color: '#059669', bg: '#ecfdf5' },
  entrega_cobranza: { label: 'Cobranza',          color: '#dc2626', bg: '#fef2f2' },
  cuadre_dinero:    { label: 'Completada',         color: '#16a34a', bg: '#f0fdf4' },
  completada:       { label: 'Completada',         color: '#16a34a', bg: '#f0fdf4' },
  cxc:              { label: 'CxC',                color: '#b45309', bg: '#fef3c7' },
  anulada:          { label: 'Anulada',           color: '#9ca3af', bg: '#f3f4f6' },
};

// ─── KPI CARD ────────────────────────────────────────────────────────────────
const KpiCard = ({ icon, label, value, sub, color, alerta }) => (
  <div style={{
    background: '#fff', borderRadius: 12, padding: '16px 18px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    borderLeft: `4px solid ${color}`,
    position: 'relative'
  }}>
    {alerta && (
      <div style={{
        position: 'absolute', top: 8, right: 10, width: 10, height: 10,
        borderRadius: '50%', background: '#dc2626'
      }} title="Requiere atención" />
    )}
    <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>
      {icon} {label}
    </div>
    <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
  </div>
);

// ─── BARRA DE META ───────────────────────────────────────────────────────────
const BarraMeta = ({ label, actual, meta, color, unidad, emoji }) => {
  const pct = meta > 0 ? Math.min((actual / meta) * 100, 100) : 0;
  const hoy = new Date();
  const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const diasRestantes = diasMes - hoy.getDate();
  const colorBarra = pct >= 100 ? '#16a34a' : pct >= 70 ? '#f59e0b' : color;
  const formatValor = (v) => unidad === '$' ? fmtCop(v) : `${fmtNum(v)} ${unidad}`;
  return (
    <div style={{ background: '#f9fafb', borderRadius: 10, padding: '12px 16px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{emoji}</span>
          <strong style={{ fontSize: 13, color: '#374151' }}>{label}</strong>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {formatValor(actual)} / {formatValor(meta)} <strong style={{ color: colorBarra }}>({pct.toFixed(0)}%)</strong>
        </div>
      </div>
      <div style={{ background: '#e5e7eb', height: 8, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: colorBarra, transition: 'width 0.3s' }} />
      </div>
      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, textAlign: 'right' }}>
        Faltan {diasRestantes} día(s) del mes
      </div>
    </div>
  );
};

// ─── MODAL METAS ─────────────────────────────────────────────────────────────
const ModalMetas = ({ metas, onGuardar, onCerrar }) => {
  const [form, setForm] = useState({ ...metas });
  return (
    <div style={st.overlay}>
      <div style={{ ...st.modal, maxWidth: 480 }}>
        <div style={st.modalHeader}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>🎯 Configurar metas</h3>
          <button onClick={onCerrar} style={st.btnX}>✕</button>
        </div>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            { key: 'metaVentas',     label: '💰 Ventas del mes (sin IVA)', prefix: '$' },
            { key: 'metaDomicilios', label: '🚚 Domicilios completados',   prefix: '#' },
            { key: 'metaExtintores', label: '🧯 Extintores recargados',    prefix: '#' },
          ].map(f => (
            <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{f.label}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#9ca3af' }}>{f.prefix}</span>
                <input type="number" value={form[f.key] || ''}
                  onChange={e => setForm(p => ({ ...p, [f.key]: Number(e.target.value) }))}
                  style={{ flex: 1, padding: '10px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 14 }} />
              </div>
            </div>
          ))}
        </div>
        <div style={st.modalFooter}>
          <button onClick={onCerrar} style={st.btnCancel}>Cancelar</button>
          <button onClick={() => onGuardar(form)} style={st.btnPrim}>💾 Guardar</button>
        </div>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
const Dashboard = ({ user }) => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [mostrarMetas, setMostrarMetas] = useState(false);
  const [metas, setMetas]     = useState(() => {
    try {
      const s = localStorage.getItem('c360_metas');
      return s ? JSON.parse(s) : { metaVentas: 25000000, metaDomicilios: 80, metaExtintores: 50 };
    } catch { return { metaVentas: 25000000, metaDomicilios: 80, metaExtintores: 50 }; }
  });

  const token = localStorage.getItem('token');
  const isAdmin = user?.role === 'admin';

  const cargar = useCallback(async () => {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const r = await axios.get(`${API}/dashboards/admin`, { headers });
      setData(r.data);
      setError('');
    } catch (e) {
      setError('No se pudo cargar el dashboard');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 30000); // refresco cada 30s
    return () => clearInterval(t);
  }, [cargar]);

  const guardarMetas = (m) => {
    setMetas(m);
    localStorage.setItem('c360_metas', JSON.stringify(m));
    setMostrarMetas(false);
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Cargando dashboard...</div>;
  if (error)   return <div style={{ textAlign: 'center', padding: 60, color: '#dc2626' }}>{error}</div>;
  if (!data)   return null;

  const k = data.kpis;
  const mesLabel = new Date().toLocaleDateString('es-CO', { month: 'long', year: 'numeric', timeZone: 'America/Bogota' });

  return (
    <div style={{ padding: 28, maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>

      {/* ── HEADER ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 4px', color: '#111' }}>
            📊 Dashboard — Control360
          </h2>
          <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>
            {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })} · Actualizado en tiempo real
          </p>
        </div>
        {isAdmin && (
          <button onClick={() => setMostrarMetas(true)}
            style={{ padding: '10px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
            🎯 Configurar metas
          </button>
        )}
      </div>

      {/* Ola 3 Bloque 3: Panel de Alertas Inteligentes */}
      <PanelAlertasInteligentes />

      {/* ── PANEL DE ALERTAS (legacy del backend) ─────────────────────────── */}
      {data.alertas?.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, marginBottom: 24 }}>
          {data.alertas.map((a, i) => {
            const colores = {
              critico:      { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626', icon: '🔴' },
              advertencia:  { bg: '#fffbeb', border: '#fcd34d', text: '#b45309', icon: '🟡' },
              info:         { bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8', icon: '🔵' }
            };
            const c = colores[a.nivel] || colores.info;
            return (
              <div key={i} style={{
                background: c.bg, border: `1px solid ${c.border}`,
                borderRadius: 10, padding: '12px 14px',
                display: 'flex', alignItems: 'flex-start', gap: 10
              }}>
                <div style={{ fontSize: 18 }}>{c.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: c.text, fontWeight: 700 }}>{a.mensaje}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2, textTransform: 'uppercase' }}>Módulo: {a.modulo}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 8 KPIs ─────────────────────────────────────────────────────────── */}
      {(() => {
        const mods = user?.modulos || [];
        const sinFiltro = mods.length === 0;
        const tiene = (m) => sinFiltro || mods.includes(m);
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 24 }}>
            <KpiCard icon="📋" label="Órdenes hoy"        value={fmtNum(k.ordenesHoy)}        sub="Creadas hoy"               color="#7c3aed" />
            <KpiCard icon="💵" label="Recaudo hoy"        value={fmtCop(k.recaudoHoy)}        sub="Ingresos en caja"          color="#16a34a" />
            {tiene('taller')    && <KpiCard icon="🔧" label="En taller"          value={fmtNum(k.enTaller)}          sub="Activas ahora"             color="#8b5cf6" alerta={k.enTaller > 10} />}
            {tiene('logistica') && <KpiCard icon="🚚" label="Mensajeros activos" value={fmtNum(k.mensajerosActivos)} sub="En ruta"                   color="#0891b2" />}
            <KpiCard icon="📦" label="Stock crítico"      value={fmtNum(k.stockCritico)}      sub="productos bajo mínimo"     color="#b45309" alerta={k.stockCritico > 0} />
            {tiene('cxc')       && <KpiCard icon="💳" label="CxC pendiente"      value={fmtCop(k.cxcPendiente)}      sub={`${k.clientesConMora} cliente(s) en mora`} color="#dc2626" alerta={k.clientesConMora > 0} />}
            {tiene('egresos')   && <KpiCard icon="💸" label="Egresos mes"        value={fmtCop(k.egresosMes)}        sub={mesLabel}                  color="#f59e0b" />}
            {tiene('eri')       && <KpiCard icon="📈" label="Utilidad mes"       value={fmtCop(k.utilidadMes)}       sub={`Ventas − Egresos · ${mesLabel}`} color={k.utilidadMes >= 0 ? '#16a34a' : '#dc2626'} />}
          </div>
        );
      })()}

      {/* ── BARRAS DE META + STOCK CRÍTICO (lado a lado) ───────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16, marginBottom: 24 }}>
        {/* Metas */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#111' }}>
            🎯 Avance del mes — {mesLabel}
          </h3>
          <BarraMeta label="Ventas del mes"          actual={k.ventasMes}     meta={metas.metaVentas}     color="#667eea" unidad="$"            emoji="💰" />
          {((user?.modulos || []).length === 0 || (user?.modulos || []).includes('logistica')) &&
            <BarraMeta label="Domicilios completados"  actual={k.domiciliosMes} meta={metas.metaDomicilios} color="#0284c7" unidad="domicilios"   emoji="🚚" />}
          {((user?.modulos || []).length === 0 || (user?.modulos || []).includes('taller')) &&
            <BarraMeta label="Extintores recargados"   actual={k.extintoresMes} meta={metas.metaExtintores} color="#8b5cf6" unidad="extintores"   emoji="🧯" />}
        </div>

        {/* Stock crítico */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#111' }}>
            📦 Stock crítico ({k.stockCritico})
          </h3>
          {data.productosStockCritico.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af', fontSize: 13 }}>
              ✓ Ningún producto en stock crítico
            </div>
          ) : (
            data.productosStockCritico.map(p => (
              <div key={p.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 12px', borderRadius: 8, background: '#fef2f2', marginBottom: 6
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.nombre}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>Mín: {p.stockMinimo}</div>
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#dc2626' }}>{p.stock}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── ÓRDENES RECIENTES ───────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#111' }}>
          🕐 Actividad reciente
        </h3>
        {data.ordenesRecientes.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af', fontSize: 13 }}>Sin órdenes recientes</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['N°', 'Cliente', 'Estado', 'Tipo', 'Total'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.ordenesRecientes.map(o => {
                const e = ESTADO_LABELS[o.estado] || ESTADO_LABELS.programada;
                return (
                  <tr key={o.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 700, color: '#7c3aed' }}>{o.numeroOrden}</td>
                    <td style={{ padding: '10px 12px', fontSize: 13 }}>{o.clienteNombre}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ padding: '2px 10px', borderRadius: 10, background: e.bg, color: e.color, fontSize: 11, fontWeight: 700 }}>{e.label}</span>
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280', textTransform: 'capitalize' }}>{o.lugarAtencion}</td>
                    <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600 }}>{fmtCop(o.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {mostrarMetas && (
        <ModalMetas metas={metas} onGuardar={guardarMetas} onCerrar={() => setMostrarMetas(false)} />
      )}
    </div>
  );
};

// ─── ESTILOS ─────────────────────────────────────────────────────────────────
const st = {
  overlay:     { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 },
  modal:       { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 560, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  modalHeader: { padding: '20px 24px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  modalFooter: { padding: '16px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 10 },
  btnX:        { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16, color: '#6b7280' },
  btnCancel:   { padding: '10px 20px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
  btnPrim:     { padding: '10px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 },
};

export default Dashboard;
