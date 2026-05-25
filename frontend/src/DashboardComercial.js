import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';
const fmt = v => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);
const fmtFecha = f => f ? new Date(f).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) : '—';

const DashboardComercial = ({ user }) => {
  const [stats, setStats]   = useState(null);
  const [loading, setLoading] = useState(true);
  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const cargar = useCallback(async () => {
    try {
      const [resOrdenes, resCots] = await Promise.all([
        axios.get(`${API}/orders`, { headers }),
        axios.get(`${API}/cotizaciones`, { headers }).catch(() => ({ data: [] })),
      ]);

      const todas = Array.isArray(resOrdenes.data) ? resOrdenes.data : [];
      const cots  = Array.isArray(resCots.data) ? resCots.data : [];
      const ahora = new Date();
      const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

      // Órdenes del comercial este mes — buscar por uid, email o creadoPorEmail
      const misMes = todas.filter(o => {
        const esDelUsuario = o.creadoPor === (user?.id || user?.uid) ||
                            o.creadoPorEmail === user?.email ||
                            o.usuarioId === (user?.id || user?.uid);
        const esMes = new Date(o.createdAt?._seconds ? o.createdAt._seconds * 1000 : o.createdAt) >= inicioMes;
        return esDelUsuario && o.estado !== 'anulada' && esMes;
      });

      // Todas las órdenes de la empresa este mes
      const empresaMes = todas.filter(o =>
        o.estado !== 'anulada' &&
        new Date(o.createdAt?._seconds ? o.createdAt._seconds * 1000 : o.createdAt) >= inicioMes
      );

      // Órdenes sin ejecutar (programada o cxc hace más de 2 días)
      const hace2dias = new Date(ahora - 2 * 24 * 60 * 60 * 1000);
      const sinEjecutar = todas.filter(o => {
        const esDelUsuario = o.creadoPor === (user?.id || user?.uid) ||
                            o.creadoPorEmail === user?.email;
        return esDelUsuario &&
          ['programada', 'cxc'].includes(o.estado) &&
          new Date(o.createdAt?._seconds ? o.createdAt._seconds * 1000 : o.createdAt) < hace2dias;
      });

      // Cotizaciones del comercial
      const misCots = cots.filter(c => c.creadoPor === user?.email || c.usuarioId === user?.id);
      const cotsPendientes = misCots.filter(c => c.estado === 'enviada' || c.estado === 'pendiente');
      const cotsAprobadas  = misCots.filter(c => c.estado === 'convertida' || c.estado === 'aprobada');

      setStats({
        misOrdenesMes:    misMes.length,
        misVentasMes:     misMes.reduce((s, o) => s + (o.total || 0), 0),
        empresaVentasMes: empresaMes.reduce((s, o) => s + (o.total || 0), 0),
        sinEjecutar,
        cotsPendientes:   cotsPendientes.length,
        cotsAprobadas:    cotsAprobadas.length,
        ultimasOrdenes:   misMes.slice(0, 5),
      });
    } catch { }
    setLoading(false);
  }, [token]);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Cargando...</div>;

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1200, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#111' }}>
          👋 Hola, {user?.nombre || user?.email?.split('@')[0]}
        </h2>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
          {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        {[
          { label: 'Mis órdenes este mes', value: stats.misOrdenesMes, color: '#7c3aed', icon: '📋', suffix: 'órdenes' },
          { label: 'Mis ventas este mes',  value: fmt(stats.misVentasMes), color: '#16a34a', icon: '💰', suffix: '' },
          { label: 'Ventas empresa mes',   value: fmt(stats.empresaVentasMes), color: '#0284c7', icon: '🏢', suffix: '' },
          { label: 'Sin ejecutar',         value: stats.sinEjecutar.length, color: stats.sinEjecutar.length > 0 ? '#dc2626' : '#16a34a', icon: '⚠️', suffix: 'pendientes' },
        ].map((k, i) => (
          <div key={i} style={{ background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)', borderLeft: `4px solid ${k.color}` }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 8 }}>{k.icon} {k.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: k.color }}>{k.value}</div>
            {k.suffix && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{k.suffix}</div>}
          </div>
        ))}
      </div>

      {/* Cotizaciones */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#374151' }}>📄 Mis cotizaciones</h3>
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1, background: '#fffbeb', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#d97706' }}>{stats.cotsPendientes}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Pendientes respuesta</div>
            </div>
            <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#16a34a' }}>{stats.cotsAprobadas}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Aprobadas / Convertidas</div>
            </div>
          </div>
        </div>

        {/* Órdenes sin ejecutar */}
        <div style={{ background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#374151' }}>
            ⚠️ Órdenes sin ejecutar
            {stats.sinEjecutar.length > 0 && <span style={{ marginLeft: 8, background: '#dc2626', color: '#fff', borderRadius: 20, padding: '2px 8px', fontSize: 11 }}>{stats.sinEjecutar.length}</span>}
          </h3>
          {stats.sinEjecutar.length === 0 ? (
            <div style={{ color: '#16a34a', fontSize: 13, padding: '12px 0' }}>✅ Todas tus órdenes están en proceso</div>
          ) : (
            <div style={{ maxHeight: 150, overflowY: 'auto' }}>
              {stats.sinEjecutar.map((o, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
                  <div>
                    <code style={{ fontSize: 11, color: '#9ca3af' }}>{o.numeroOrden}</code>
                    <span style={{ marginLeft: 8 }}>{o.clienteNombre}</span>
                  </div>
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>{fmt(o.total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Últimas órdenes */}
      <div style={{ background: '#fff', borderRadius: 12, padding: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#374151' }}>📋 Mis últimas órdenes del mes</h3>
        {stats.ultimasOrdenes.length === 0 ? (
          <div style={{ color: '#9ca3af', fontSize: 13, padding: '12px 0' }}>No tienes órdenes este mes aún</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['Orden', 'Cliente', 'Total', 'Estado', 'Fecha'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.ultimasOrdenes.map((o, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px' }}><code style={{ fontSize: 12 }}>{o.numeroOrden}</code></td>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{o.clienteNombre}</td>
                  <td style={{ padding: '10px 12px', color: '#16a34a', fontWeight: 700 }}>{fmt(o.total)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: '#f0fdf4', color: '#16a34a' }}>{o.estado}</span>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>{fmtFecha(o.createdAt?._seconds ? new Date(o.createdAt._seconds * 1000) : o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default DashboardComercial;
