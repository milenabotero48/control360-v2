import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard Comercial (Control360 v2 — Ola 2)
// ─────────────────────────────────────────────────────────────────────────────
// Una sola llamada a /api/dashboards/comercial/:id trae:
//   - Vendido mes (suma de órdenes completadas creadas por este comercial)
//   - Cotizado mes (total cotizado en el mes)
//   - Cotizaciones creadas / aprobadas
//   - Tasa de conversión cotización → venta
//   - CxC propio (saldo de clientes que él vendió)
//   - Meta configurable por comercial (localStorage por ahora)
// ─────────────────────────────────────────────────────────────────────────────

const fmtCop = (v) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0
}).format(v || 0);

const fmtNum = (v) => new Intl.NumberFormat('es-CO').format(v || 0);

// ─── KPI CARD ────────────────────────────────────────────────────────────────
const KpiCard = ({ icon, label, value, sub, color }) => (
  <div style={{
    background: '#fff', borderRadius: 12, padding: '16px 18px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    borderLeft: `4px solid ${color}`
  }}>
    <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>
      {icon} {label}
    </div>
    <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
  </div>
);

// ─── BARRA DE META MENSUAL ───────────────────────────────────────────────────
const BarraMetaMes = ({ vendido, meta, onConfigurarMeta }) => {
  const pct = meta > 0 ? Math.min((vendido / meta) * 100, 100) : 0;
  const hoy = new Date();
  const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const diasRestantes = diasMes - hoy.getDate();
  const color = pct >= 100 ? '#16a34a' : pct >= 70 ? '#f59e0b' : '#7c3aed';

  if (meta === 0) {
    return (
      <div style={{ padding: '16px 18px', background: '#f9fafb', borderRadius: 10, color: '#6b7280', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Sin meta personal configurada</span>
        <button onClick={onConfigurarMeta} style={{ padding: '6px 14px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
          🎯 Configurar
        </button>
      </div>
    );
  }

  return (
    <div style={{ background: '#f9fafb', borderRadius: 10, padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 13, color: '#374151' }}>🎯 Meta personal del mes</strong>
        <div>
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            <strong style={{ color }}>{fmtCop(vendido)}</strong> / {fmtCop(meta)}
          </span>
          <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color }}>({pct.toFixed(0)}%)</span>
          <button onClick={onConfigurarMeta} style={{ marginLeft: 10, padding: '4px 10px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
            Editar
          </button>
        </div>
      </div>
      <div style={{ background: '#e5e7eb', height: 10, borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, textAlign: 'right' }}>
        {pct >= 100 ? '¡Meta alcanzada! ' : `Faltan ${diasRestantes} día(s) del mes`}
      </div>
    </div>
  );
};

// ─── MODAL META ──────────────────────────────────────────────────────────────
const ModalMeta = ({ meta, onGuardar, onCerrar }) => {
  const [v, setV] = useState(String(meta || ''));
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 420, padding: 24 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 18, fontWeight: 700 }}>🎯 Mi meta de ventas del mes</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#6b7280' }}>
          Define cuánto quieres vender este mes. La meta es personal y solo tú la ves.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ color: '#9ca3af', fontSize: 16 }}>$</span>
          <input type="number" value={v} onChange={e => setV(e.target.value)}
            style={{ flex: 1, padding: '10px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 14 }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onCerrar} style={{ padding: '10px 20px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
          <button onClick={() => onGuardar(Number(v) || 0)} style={{ padding: '10px 24px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>💾 Guardar</button>
        </div>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
const DashboardComercial = ({ user }) => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [mostrarMeta, setMostrarMeta] = useState(false);

  // Meta personal en localStorage, por usuario (key incluye el id)
  const claveLocalMeta = `c360_meta_comercial_${user?.id || user?.uid || 'me'}`;
  const [meta, setMeta] = useState(() => {
    try {
      const v = localStorage.getItem(claveLocalMeta);
      return v ? Number(v) : 0;
    } catch { return 0; }
  });

  const token = localStorage.getItem('token');
  const comercialId = user?.id || user?.uid;

  const cargar = useCallback(async () => {
    if (!comercialId) return;
    try {
      const r = await axios.get(`${API}/dashboards/comercial/${comercialId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setData(r.data);
      setError('');
    } catch {
      setError('No se pudo cargar el dashboard comercial');
    } finally {
      setLoading(false);
    }
  }, [token, comercialId]);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, [cargar]);

  const guardarMeta = (m) => {
    setMeta(m);
    localStorage.setItem(claveLocalMeta, String(m));
    setMostrarMeta(false);
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Cargando dashboard comercial...</div>;
  if (error)   return <div style={{ textAlign: 'center', padding: 60, color: '#dc2626' }}>{error}</div>;
  if (!data)   return null;

  const k = data.kpis;
  const mesLabel = new Date().toLocaleDateString('es-CO', { month: 'long', year: 'numeric', timeZone: 'America/Bogota' });
  const saludo = user?.nombre || 'Comercial';

  return (
    <div style={{ padding: 28, maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>

      {/* HEADER */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 4px', color: '#111' }}>
          💼 Dashboard Comercial
        </h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>
          Hola {saludo} — {mesLabel}
        </p>
      </div>

      {/* 6 KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 24 }}>
        <KpiCard icon="💰" label="Vendido mes"            value={fmtCop(k.vendidoMes)}           sub="Órdenes completadas"   color="#16a34a" />
        <KpiCard icon="📄" label="Cotizado mes"           value={fmtCop(k.cotizadoMes)}          sub={`${k.cotizacionesCreadas} cotización(es)`} color="#0284c7" />
        <KpiCard icon="✅" label="Aprobadas"              value={fmtNum(k.cotizacionesAprobadas)} sub="Convertidas a venta"  color="#7c3aed" />
        <KpiCard icon="🎯" label="Tasa de conversión"     value={`${k.tasaConversion}%`}          sub="Cot. → venta"          color="#f59e0b" />
        <KpiCard icon="📋" label="Órdenes creadas"        value={fmtNum(k.ordenesCreadas)}        sub={mesLabel}              color="#8b5cf6" />
        <KpiCard icon="💳" label="CxC propio"             value={fmtCop(k.cxcPropio)}             sub="Saldo pendiente"       color="#dc2626" />
      </div>

      {/* Meta personal */}
      <div style={{ marginBottom: 24 }}>
        <BarraMetaMes vendido={k.vendidoMes} meta={meta} onConfigurarMeta={() => setMostrarMeta(true)} />
      </div>

      {/* Tips y conexiones rápidas */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#374151' }}>📊 Resumen del mes</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ResumenRow label="Cotizaciones creadas"     value={fmtNum(k.cotizacionesCreadas)} />
            <ResumenRow label="Cotizaciones aprobadas"   value={fmtNum(k.cotizacionesAprobadas)} color="#16a34a" />
            <ResumenRow label="Total cotizado"           value={fmtCop(k.cotizadoMes)} />
            <ResumenRow label="Total vendido"            value={fmtCop(k.vendidoMes)} color="#16a34a" bold />
            <ResumenRow label="Brecha por cobrar (CxC)"  value={fmtCop(k.cxcPropio)} color="#dc2626" />
          </div>
        </div>

        <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#374151' }}>💡 Tips para vender más</h3>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#374151', lineHeight: 1.8 }}>
            {k.tasaConversion < 40 && (
              <li>Tu tasa de conversión es <strong style={{ color: '#dc2626' }}>{k.tasaConversion}%</strong> — haz seguimiento más rápido a cotizaciones pendientes.</li>
            )}
            {k.tasaConversion >= 40 && k.tasaConversion < 70 && (
              <li>Buena tasa de conversión (<strong style={{ color: '#f59e0b' }}>{k.tasaConversion}%</strong>) — aún tienes espacio para mejorarla.</li>
            )}
            {k.tasaConversion >= 70 && (
              <li>Excelente tasa de conversión: <strong style={{ color: '#16a34a' }}>{k.tasaConversion}%</strong>. ¡Sigue así!</li>
            )}
            {k.cxcPropio > 0 && (
              <li>Tienes <strong style={{ color: '#dc2626' }}>{fmtCop(k.cxcPropio)}</strong> en cartera de clientes que tú vendiste. Apóyalos con cobranza.</li>
            )}
            {meta > 0 && k.vendidoMes < meta * 0.5 && (
              <li>Vas en el <strong style={{ color: '#f59e0b' }}>{((k.vendidoMes / meta) * 100).toFixed(0)}%</strong> de tu meta. Identifica 3 clientes prioritarios para esta semana.</li>
            )}
            {k.cotizacionesCreadas === 0 && (
              <li>No has creado cotizaciones este mes. Empieza con tus 5 clientes más fuertes.</li>
            )}
          </ul>
        </div>
      </div>

      {mostrarMeta && (
        <ModalMeta meta={meta} onGuardar={guardarMeta} onCerrar={() => setMostrarMeta(false)} />
      )}
    </div>
  );
};

const ResumenRow = ({ label, value, color, bold }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#f9fafb', borderRadius: 8 }}>
    <span style={{ fontSize: 13, color: '#6b7280' }}>{label}</span>
    <span style={{ fontSize: bold ? 15 : 13, fontWeight: bold ? 800 : 700, color: color || '#111' }}>{value}</span>
  </div>
);

export default DashboardComercial;

