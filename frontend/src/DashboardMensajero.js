import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';
const fmt = v => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);

const DashboardMensajero = ({ user }) => {
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);
  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const cargar = useCallback(async () => {
    try {
      const [resOrdenes, resCuadre] = await Promise.all([
        axios.get(`${API}/logistica/mis-ordenes`, { headers }),
        axios.get(`${API}/logistica/cuadre/${user?.id || user?.uid}`, { headers }).catch(() => ({ data: {} })),
      ]);

      const ordenes = Array.isArray(resOrdenes.data) ? resOrdenes.data : [];
      const cuadre  = resCuadre.data || {};
      const ahora   = new Date();
      const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
      const hoy = ahora.toISOString().split('T')[0];

      // Todas mis órdenes del mes
      const [resTodas] = await Promise.all([
        axios.get(`${API}/orders`, { headers }).catch(() => ({ data: [] })),
      ]);
      const todas = Array.isArray(resTodas.data) ? resTodas.data : [];
      const misMes = todas.filter(o =>
        o.mensajeroId === (user?.id || user?.uid) &&
        o.estado !== 'anulada' &&
        new Date(o.createdAt?._seconds ? o.createdAt._seconds * 1000 : o.createdAt) >= inicioMes
      );

      const completadasHoy = ordenes.filter(o => o.estado === 'entrega_cobranza').length;
      const enRutaHoy = ordenes.filter(o => ['en_ruta_recogida', 'en_ruta_entrega'].includes(o.estado)).length;
      const pendientesHoy = ordenes.filter(o => ['programada', 'despacho'].includes(o.estado)).length;

      setStats({
        ordenesHoy: ordenes.length,
        completadasHoy,
        enRutaHoy,
        pendientesHoy,
        ordenesMes: misMes.length,
        recaudoMes: misMes.reduce((s, o) => s + (o.montoRecaudado || 0), 0),
        cuadre,
        ordenes,
      });
    } catch { }
    setLoading(false);
  }, [token]);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Cargando...</div>;

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1000, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#111' }}>
          👋 Hola, {user?.nombre || user?.email?.split('@')[0]}
        </h2>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>
          {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })} · Tu ruta de hoy
        </p>
      </div>

      {/* KPIs del día */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        {[
          { label: 'Asignadas hoy',    value: stats.ordenesHoy,     color: '#6366f1', icon: '📋' },
          { label: 'En ruta ahora',    value: stats.enRutaHoy,      color: '#f59e0b', icon: '🚚' },
          { label: 'Entregadas hoy',   value: stats.completadasHoy, color: '#16a34a', icon: '✅' },
          { label: 'Pendientes',       value: stats.pendientesHoy,  color: '#6b7280', icon: '⏳' },
        ].map((k, i) => (
          <div key={i} style={{ background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)', borderLeft: `4px solid ${k.color}` }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 8 }}>{k.icon} {k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Cuadre del día */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 24 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#374151' }}>💰 Mi cuadre de hoy</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#6b7280' }}>
              <span>Cobros a clientes</span>
              <span style={{ fontWeight: 700, color: '#16a34a' }}>{fmt(stats.cuadre.totalCobrado || 0)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#6b7280' }}>
              <span>Gastos previos recibidos</span>
              <span style={{ fontWeight: 700, color: '#dc2626' }}>{fmt(stats.cuadre.totalProvisional || 0)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, borderTop: '1px solid #e5e7eb', paddingTop: 10, marginTop: 4 }}>
              <span>Total a entregar</span>
              <span style={{ color: '#16a34a' }}>{fmt(stats.cuadre.totalAEntregar || 0)}</span>
            </div>
          </div>
          {stats.cuadre.extintoresPendientes?.length > 0 && (
            <div style={{ marginTop: 14, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e' }}>
              ⚠️ Tienes <strong>{stats.cuadre.extintoresPendientes.length}</strong> extintor{stats.cuadre.extintoresPendientes.length !== 1 ? 'es' : ''} en préstamo por devolver
            </div>
          )}
        </div>

        {/* Resumen del mes */}
        <div style={{ background: '#fff', borderRadius: 12, padding: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#374151' }}>📅 Mi mes</h3>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 8, padding: '14px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#16a34a' }}>{stats.ordenesMes}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Servicios completados</div>
            </div>
            <div style={{ flex: 1, background: '#ede9fe', borderRadius: 8, padding: '14px', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#7c3aed' }}>{fmt(stats.recaudoMes)}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Recaudo del mes</div>
            </div>
          </div>
        </div>
      </div>

      {/* Órdenes del día */}
      {stats.ordenes.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#374151' }}>🗺️ Mis órdenes de hoy</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['Orden', 'Cliente', 'Dirección', 'Total', 'Estado'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.ordenes.map((o, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px' }}><code style={{ fontSize: 12 }}>{o.numeroOrden}</code></td>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{o.clienteNombre}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.sucursalDireccion || o.clienteDireccion || '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#16a34a', fontWeight: 700 }}>{fmt(o.total)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: '#fffbeb', color: '#d97706' }}>{o.estado?.replace('_', ' ')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DashboardMensajero;
