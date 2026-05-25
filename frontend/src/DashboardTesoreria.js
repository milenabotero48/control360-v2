import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';
const fmt = v => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);

const DashboardTesoreria = ({ user }) => {
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);
  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const cargar = useCallback(async () => {
    try {
      const [resCajas, resEgresos, resCxc, resOrdenes] = await Promise.all([
        axios.get(`${API}/cajas`, { headers }).catch(() => ({ data: [] })),
        axios.get(`${API}/egresos`, { headers }).catch(() => ({ data: [] })),
        axios.get(`${API}/cxc`, { headers }).catch(() => ({ data: { clientes: [], totales: {} } })),
        axios.get(`${API}/orders`, { headers }).catch(() => ({ data: [] })),
      ]);

      const cajas    = Array.isArray(resCajas.data) ? resCajas.data : [];
      const egresos  = Array.isArray(resEgresos.data) ? resEgresos.data : [];
      const cxc      = resCxc.data || {};
      const ordenes  = Array.isArray(resOrdenes.data) ? resOrdenes.data : [];

      const ahora = new Date();
      const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

      // Totales caja
      const totalCajas = cajas.reduce((s, c) => s + (c.saldo || 0), 0);

      // Egresos pendientes
      const egresosPendientes = egresos.filter(e => e.estado === 'PENDIENTE');
      const totalEgresosPendientes = egresosPendientes.reduce((s, e) => s + (e.totalPagar || e.monto || 0), 0);

      // Egresos del mes
      const egresosMes = egresos.filter(e =>
        new Date(e.fecha || e.createdAt?._seconds * 1000) >= inicioMes
      );
      const totalEgresosMes = egresosMes.reduce((s, e) => s + (e.totalPagar || e.monto || 0), 0);

      // Ingresos del mes (órdenes completadas)
      const ingresosMes = ordenes.filter(o =>
        o.estado !== 'anulada' && o.estado !== 'cxc' &&
        new Date(o.createdAt?._seconds ? o.createdAt._seconds * 1000 : o.createdAt) >= inicioMes
      );
      const totalIngresosMes = ingresosMes.reduce((s, o) => s + (o.total || 0), 0);

      setStats({
        totalCajas,
        cajas,
        totalEgresosPendientes,
        egresosPendientes: egresosPendientes.length,
        totalEgresosMes,
        totalIngresosMes,
        utilidadMes: totalIngresosMes - totalEgresosMes,
        totalCxC: cxc.totales?.totalPendiente || cxc.clientes?.reduce((s, c) => s + (c.totalPendiente || 0), 0) || 0,
        clientesCxC: cxc.clientes?.length || 0,
      });
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [token]);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Cargando...</div>;

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1200, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#111' }}>
          💰 Tesorería
        </h2>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
          {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      {/* KPIs principales */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        {[
          { label: 'Total en cajas',        value: fmt(stats.totalCajas),            color: '#16a34a', icon: '🏦' },
          { label: 'Ingresos del mes',       value: fmt(stats.totalIngresosMes),      color: '#0284c7', icon: '📈' },
          { label: 'Egresos del mes',        value: fmt(stats.totalEgresosMes),       color: '#dc2626', icon: '📉' },
          { label: 'Utilidad del mes',       value: fmt(stats.utilidadMes),           color: stats.utilidadMes >= 0 ? '#16a34a' : '#dc2626', icon: '💹' },
        ].map((k, i) => (
          <div key={i} style={{ background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)', borderLeft: `4px solid ${k.color}` }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 8 }}>{k.icon} {k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Cajas + CxC + Egresos pendientes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 24 }}>

        {/* Saldo por caja */}
        <div style={{ background: '#fff', borderRadius: 12, padding: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#374151' }}>🏦 Saldo por caja</h3>
          {stats.cajas.length === 0 ? (
            <div style={{ color: '#9ca3af', fontSize: 13 }}>Sin cajas configuradas</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stats.cajas.map((c, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: '#f9fafb', borderRadius: 8 }}>
                  <span style={{ fontSize: 13, color: '#374151' }}>{c.nombre}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: c.saldo >= 0 ? '#16a34a' : '#dc2626' }}>{fmt(c.saldo || 0)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: '#f0fdf4', borderRadius: 8, fontWeight: 800 }}>
                <span style={{ fontSize: 13 }}>Total</span>
                <span style={{ fontSize: 14, color: '#16a34a' }}>{fmt(stats.totalCajas)}</span>
              </div>
            </div>
          )}
        </div>

        {/* CxC */}
        <div style={{ background: '#fff', borderRadius: 12, padding: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#374151' }}>💳 Cuentas por Cobrar</h3>
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: '#dc2626' }}>{fmt(stats.totalCxC)}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>{stats.clientesCxC} cliente{stats.clientesCxC !== 1 ? 's' : ''} con deuda</div>
          </div>
        </div>

        {/* Egresos pendientes */}
        <div style={{ background: '#fff', borderRadius: 12, padding: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: '#374151' }}>⏳ Egresos por pagar</h3>
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: '#f59e0b' }}>{fmt(stats.totalEgresosPendientes)}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>{stats.egresosPendientes} egreso{stats.egresosPendientes !== 1 ? 's' : ''} pendiente{stats.egresosPendientes !== 1 ? 's' : ''}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardTesoreria;
