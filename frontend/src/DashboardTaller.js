import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard del Taller (Control360 v2 — Ola 2)
// ─────────────────────────────────────────────────────────────────────────────
// Una sola llamada a /api/dashboards/taller trae:
//   - KPIs: en taller, completadas hoy, equipos atendidos, meta diaria, etc.
//   - Cola de órdenes en taller
//   - Órdenes críticas (>48h)
//   - Insumos en stock crítico
//
// Diseño SaaS: ningún nombre de persona hardcoded. Saluda con user.nombre real
// (de la sesión) o genérico "Técnico" como fallback.
// ─────────────────────────────────────────────────────────────────────────────

const fmtNum = (v) => new Intl.NumberFormat('es-CO').format(v || 0);

const horasDesde = (fecha) => {
  if (!fecha) return 0;
  const t = fecha._seconds ? new Date(fecha._seconds * 1000)
          : fecha.seconds   ? new Date(fecha.seconds * 1000)
          : new Date(fecha);
  return ((Date.now() - t.getTime()) / 3600000).toFixed(0);
};

const formatHoraCO = (fecha) => {
  if (!fecha) return '—';
  try {
    const t = fecha._seconds ? new Date(fecha._seconds * 1000)
            : fecha.seconds   ? new Date(fecha.seconds * 1000)
            : new Date(fecha);
    return t.toLocaleString('es-CO', {
      timeZone: 'America/Bogota', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return '—'; }
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
      }} />
    )}
    <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>
      {icon} {label}
    </div>
    <div style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
  </div>
);

// ─── BARRA DE META DIARIA ────────────────────────────────────────────────────
const BarraMetaDiaria = ({ actual, meta }) => {
  const pct = meta > 0 ? Math.min((actual / meta) * 100, 100) : 0;
  const color = pct >= 100 ? '#16a34a' : pct >= 70 ? '#f59e0b' : '#8b5cf6';
  if (meta === 0) {
    return (
      <div style={{ padding: '14px 16px', background: '#f9fafb', borderRadius: 10, color: '#6b7280', fontSize: 12 }}>
        Sin meta diaria configurada. El admin puede definirla desde Taller → Configuración.
      </div>
    );
  }
  return (
    <div style={{ background: '#f9fafb', borderRadius: 10, padding: '14px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 13, color: '#374151' }}>🎯 Meta diaria del taller</strong>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          <strong style={{ color }}>{fmtNum(actual)}</strong> / {fmtNum(meta)} equipos
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color }}>({pct.toFixed(0)}%)</span>
        </div>
      </div>
      <div style={{ background: '#e5e7eb', height: 10, borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, textAlign: 'right' }}>
        {actual >= meta ? '¡Meta alcanzada! ' : `Faltan ${meta - actual} equipo(s) para la meta de hoy`}
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
const DashboardTaller = ({ user }) => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const token = localStorage.getItem('token');

  const cargar = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/dashboards/taller`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setData(r.data);
      setError('');
    } catch {
      setError('No se pudo cargar el dashboard del taller');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 20000); // refresco cada 20s
    return () => clearInterval(t);
  }, [cargar]);

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Cargando dashboard del taller...</div>;
  if (error)   return <div style={{ textAlign: 'center', padding: 60, color: '#dc2626' }}>{error}</div>;
  if (!data)   return null;

  const k = data.kpis;
  // Saludo dinámico: usa el nombre real del usuario logueado (NO hardcoded).
  const saludo = user?.nombre || 'Técnico';

  return (
    <div style={{ padding: 28, maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>

      {/* HEADER */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 4px', color: '#111' }}>
          🔧 Dashboard del Taller
        </h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>
          Hola {saludo} — {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' })}
        </p>
      </div>

      {/* 6 KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 24 }}>
        <KpiCard icon="🛠"  label="En taller"          value={fmtNum(k.enTaller)}         sub="Activas ahora"          color="#8b5cf6" alerta={k.enTaller > 10} />
        <KpiCard icon="✅" label="Completadas hoy"    value={fmtNum(k.completadasHoy)}   sub="Listas para entrega"    color="#16a34a" />
        <KpiCard icon="🧯" label="Equipos atendidos"  value={fmtNum(k.equiposHoy)}       sub="Recargados / inspeccionados hoy" color="#0891b2" />
        <KpiCard icon="🎯" label="Meta diaria"        value={fmtNum(k.metaDiaria)}       sub={k.metaDiaria > 0 ? `Avance: ${((k.equiposHoy / k.metaDiaria) * 100).toFixed(0)}%` : 'No configurada'} color="#7c3aed" />
        <KpiCard icon="⏰" label="Críticas (>48h)"    value={fmtNum(k.ordenesCriticas)}  sub="Atrasadas en taller"    color="#dc2626" alerta={k.ordenesCriticas > 0} />
        <KpiCard icon="📦" label="Insumos críticos"   value={fmtNum(k.insumosCriticos)}  sub="Bajo el stock mínimo"   color="#b45309" alerta={k.insumosCriticos > 0} />
      </div>

      {/* Meta diaria barra de progreso */}
      <div style={{ marginBottom: 24 }}>
        <BarraMetaDiaria actual={k.equiposHoy} meta={k.metaDiaria} />
      </div>

      {/* Columnas: Cola del taller + Insumos críticos */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginBottom: 24 }}>

        {/* Cola del taller */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#111' }}>
            🛠 Órdenes en taller ({data.colaTaller.length})
          </h3>
          {data.colaTaller.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af', fontSize: 13 }}>
              ✓ Sin órdenes en taller — todo al día
            </div>
          ) : (
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              {data.colaTaller.map(o => {
                const horas = horasDesde(o.fechaEnTaller);
                const esCritica = horas > 48;
                return (
                  <div key={o.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 14px', borderRadius: 8,
                    background: esCritica ? '#fef2f2' : '#f9fafb',
                    border: esCritica ? '1px solid #fca5a5' : '1px solid transparent',
                    marginBottom: 6
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed' }}>{o.numeroOrden}</div>
                      <div style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {o.clienteNombre} · {o.items} item(s)
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 100 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: esCritica ? '#dc2626' : '#374151' }}>
                        {horas}h
                      </div>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>
                        {formatHoraCO(o.fechaEnTaller)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Insumos críticos */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#111' }}>
            📦 Insumos críticos ({k.insumosCriticos})
          </h3>
          {data.insumosCriticos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af', fontSize: 13 }}>
              ✓ Todos los insumos con stock suficiente
            </div>
          ) : (
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              {data.insumosCriticos.map(i => (
                <div key={i.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', borderRadius: 8, background: '#fef3c7',
                  border: '1px solid #fcd34d', marginBottom: 6
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#92400e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {i.nombre}
                    </div>
                    <div style={{ fontSize: 11, color: '#a16207' }}>
                      Mínimo: {i.stockMinimo} {i.unidad || ''}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 18, fontWeight: 800, color: '#b45309', marginLeft: 12
                  }}>
                    {i.stock || 0}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Órdenes críticas (>48h) — sección destacada si hay */}
      {data.ordenesCriticas.length > 0 && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 12, padding: 18 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: '#dc2626' }}>
            ⚠ Órdenes atrasadas en taller (más de 48 horas)
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['N° Orden', 'Cliente', 'En taller desde', 'Horas'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, color: '#7f1d1d', fontWeight: 700, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.ordenesCriticas.map(o => (
                <tr key={o.id} style={{ borderTop: '1px solid #fecaca' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 700, color: '#7c3aed' }}>{o.numeroOrden}</td>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>{o.clienteNombre}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280' }}>{formatHoraCO(o.fechaEnTaller)}</td>
                  <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 700, color: '#dc2626' }}>{horasDesde(o.fechaEnTaller)}h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DashboardTaller;
