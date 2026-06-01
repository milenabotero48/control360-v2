import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import PanelAlertasInteligentes from './PanelAlertasInteligentes'; // Ola 3 Bloque 3

const API = 'http://localhost:5000/api';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard de Tesorería (Control360 v2 — Ola 2)
// ─────────────────────────────────────────────────────────────────────────────
// Una sola llamada a /api/dashboards/tesoreria trae todos los datos.
// KPIs según el spec:
//   - Saldo por caja + Total en cajas
//   - Ingresos / Egresos / Utilidad del mes
//   - CxC pendiente + clientes con deuda + top 5 deudores
//   - Egresos por pagar + pendientes facturar + pagos electrónicos sin validar
//   - Provisionales pendientes (badge de alerta)
// ─────────────────────────────────────────────────────────────────────────────

const fmtCop = (v) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0
}).format(v || 0);

const fmtNum = (v) => new Intl.NumberFormat('es-CO').format(v || 0);

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
    <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
  </div>
);

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
const DashboardTesoreria = ({ user }) => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const token = localStorage.getItem('token');

  const cargar = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/dashboards/tesoreria`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setData(r.data);
      setError('');
    } catch {
      setError('No se pudo cargar el dashboard de tesorería');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 20000); // refresco cada 20s
    return () => clearInterval(t);
  }, [cargar]);

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Cargando tesorería...</div>;
  if (error)   return <div style={{ textAlign: 'center', padding: 60, color: '#dc2626' }}>{error}</div>;
  if (!data)   return null;

  const k = data.kpis;
  const mesLabel = new Date().toLocaleDateString('es-CO', { month: 'long', year: 'numeric', timeZone: 'America/Bogota' });
  const saludo = user?.nombre || 'Tesorería';

  return (
    <div style={{ padding: 28, maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>

      {/* HEADER */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 4px', color: '#111' }}>
          💰 Tesorería
        </h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>
          Hola {saludo} — {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' })}
        </p>
      </div>

      {/* Ola 3 Bloque 3: Panel de alertas inteligentes (solo PAGO y CXC para Tesorería) */}
      <PanelAlertasInteligentes filtroTipo={['PAGO_PENDIENTE', 'CXC_VENCIDO']} />

      {/* Alertas (provisionales sin cuadrar + pagos sin validar) */}
      {(k.provisionalesPendientes > 0 || k.pagosElectronicosSinValidar > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, marginBottom: 24 }}>
          {k.provisionalesPendientes > 0 && (
            <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 18 }}>🟡</span>
              <div>
                <div style={{ fontSize: 13, color: '#b45309', fontWeight: 700 }}>
                  {k.provisionalesPendientes} egreso(s) provisional(es) sin cuadrar
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Ir a Egresos → pestaña Provisionales para cuadrar el definitivo</div>
              </div>
            </div>
          )}
          {k.pagosElectronicosSinValidar > 0 && (
            <div style={{ background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 18 }}>🔵</span>
              <div>
                <div style={{ fontSize: 13, color: '#1d4ed8', fontWeight: 700 }}>
                  {k.pagosElectronicosSinValidar} pago(s) electrónico(s) sin validar
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Revisar comprobantes de transferencia / Nequi en las órdenes</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 4 KPIs principales — FIX: Tesorería no ve utilidad ni egresos (son del admin).
          Tesorería ve: saldo en cajas, ingresos del mes, CxC pendiente y egresos POR PAGAR. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 24 }}>
        <KpiCard icon="🏦" label="Total en cajas"      value={fmtCop(k.totalEnCajas)}     sub="Saldo disponible"   color="#16a34a" />
        <KpiCard icon="📈" label="Ingresos mes"        value={fmtCop(k.ingresosMes)}      sub={mesLabel}           color="#0284c7" />
        <KpiCard icon="💳" label="CxC pendiente"       value={fmtCop(k.cxcPendiente)}     sub={`${k.clientesConDeuda} cliente(s)`} color="#b45309" alerta={k.clientesConDeuda > 0} />
        <KpiCard icon="⏳" label="Egresos por pagar"   value={fmtCop(k.egresosPorPagar)}  sub={`${k.countEgresosPendientes} pendiente(s)`} color="#f59e0b" alerta={k.countEgresosPendientes > 0} />
      </div>

      {/* 3 columnas: cajas + top deudores + acciones pendientes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 24 }}>

        {/* Saldo por caja */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#374151' }}>🏦 Saldo por caja</h3>
          {data.cajas.length === 0 ? (
            <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: 20 }}>Sin cajas configuradas</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.cajas.map(c => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: '#f9fafb', borderRadius: 8 }}>
                  <span style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>{c.nombre}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: c.saldo >= 0 ? '#16a34a' : '#dc2626' }}>
                    {fmtCop(c.saldo || 0)}
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', background: '#f0fdf4', borderRadius: 8, fontWeight: 800, borderTop: '2px solid #d1fae5', marginTop: 4 }}>
                <span style={{ fontSize: 13 }}>Total</span>
                <span style={{ fontSize: 14, color: '#16a34a' }}>{fmtCop(k.totalEnCajas)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Top deudores */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#374151' }}>
            💳 Top deudores
          </h3>
          {data.topDeudores.length === 0 ? (
            <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: 20 }}>✓ Sin clientes con deuda</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.topDeudores.map((d, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', background: i === 0 ? '#fef2f2' : '#f9fafb',
                  borderRadius: 8, border: i === 0 ? '1px solid #fca5a5' : 'none'
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {i + 1}. {d.nombre}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626', marginLeft: 10 }}>
                    {fmtCop(d.saldo)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Acciones pendientes */}
        <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#374151' }}>
            ⚡ Acciones pendientes
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ padding: '12px 14px', background: '#fef3c7', borderRadius: 8, borderLeft: '4px solid #f59e0b' }}>
              <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, textTransform: 'uppercase' }}>Por facturar</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#b45309', marginTop: 4 }}>{fmtNum(k.pendientesFacturar)}</div>
              <div style={{ fontSize: 11, color: '#92400e' }}>órden(es) sin facturar</div>
            </div>
            <div style={{ padding: '12px 14px', background: '#eff6ff', borderRadius: 8, borderLeft: '4px solid #0284c7' }}>
              <div style={{ fontSize: 11, color: '#0c4a6e', fontWeight: 700, textTransform: 'uppercase' }}>Pagos sin validar</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#0284c7', marginTop: 4 }}>{fmtNum(k.pagosElectronicosSinValidar)}</div>
              <div style={{ fontSize: 11, color: '#0c4a6e' }}>transferencias / Nequi</div>
            </div>
            <div style={{ padding: '12px 14px', background: '#fffbeb', borderRadius: 8, borderLeft: '4px solid #d97706' }}>
              <div style={{ fontSize: 11, color: '#78350f', fontWeight: 700, textTransform: 'uppercase' }}>Provisionales</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#d97706', marginTop: 4 }}>{fmtNum(k.provisionalesPendientes)}</div>
              <div style={{ fontSize: 11, color: '#78350f' }}>por cuadrar definitivo</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardTesoreria;
