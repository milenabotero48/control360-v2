import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';

const ESTADOS = {
  programada:       { label: 'Programada',       color: '#6366f1', bg: '#eef2ff' },
  en_ruta_recogida: { label: 'En Ruta Recogida', color: '#f59e0b', bg: '#fffbeb' },
  en_taller:        { label: 'En Taller',         color: '#8b5cf6', bg: '#f5f3ff' },
  facturado:        { label: 'Facturado',          color: '#0284c7', bg: '#e0f2fe' },
  despacho:         { label: 'Despacho',           color: '#d97706', bg: '#fef3c7' },
  en_ruta_entrega:  { label: 'En Ruta Entrega',   color: '#059669', bg: '#ecfdf5' },
  entrega_cobranza: { label: 'Entrega Cobranza',  color: '#dc2626', bg: '#fef2f2' },
  cuadre_dinero:    { label: 'Completada',         color: '#16a34a', bg: '#f0fdf4' },
  anulada:          { label: 'Anulada',           color: '#9ca3af', bg: '#f3f4f6' },
};

const formatCOP = (v) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);

const BarraMeta = ({ label, actual, meta, color, unidad, emoji }) => {
  const pct = meta > 0 ? Math.min((actual / meta) * 100, 100) : 0;
  const hoy = new Date();
  const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const diasRestantes = diasMes - hoy.getDate();
  const colorBarra = pct >= 100 ? '#16a34a' : pct >= 70 ? '#f59e0b' : color;
  return (
    <div style={{ background: '#f9fafb', borderRadius: '10px', padding: '14px 16px', marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '18px' }}>{emoji}</span>
          <span style={{ fontWeight: 700, fontSize: '14px', color: '#374151' }}>{label}</span>
        </div>
        <span style={{ fontSize: '20px', fontWeight: 800, color: colorBarra }}>{pct.toFixed(0)}%</span>
      </div>
      <div style={{ background: '#e5e7eb', borderRadius: '999px', height: '10px', overflow: 'hidden' }}>
        <div style={{ width: pct + '%', height: '100%', background: colorBarra, borderRadius: '999px', transition: 'width 0.8s ease' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '12px' }}>
        <span style={{ color: '#374151', fontWeight: 600 }}>
          {unidad === '$' ? formatCOP(actual) + ' de ' + formatCOP(meta) : actual + ' de ' + meta + ' ' + unidad}
        </span>
        <span style={{ color: '#9ca3af' }}>{diasRestantes} días restantes</span>
      </div>
    </div>
  );
};

const ModalMetas = ({ metas, onGuardar, onCerrar }) => {
  const [form, setForm] = useState({ ...metas });
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '480px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>🎯 Metas del mes</h3>
          <button onClick={onCerrar} style={{ background: '#f3f4f6', border: 'none', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <p style={{ color: '#6b7280', fontSize: '13px', marginBottom: '20px' }}>Se reinician automáticamente cada mes.</p>
          {[
            { key: 'metaVentas', label: '💰 Meta ventas del mes (sin IVA)', prefix: '$' },
            { key: 'metaDomicilios', label: '🚚 Meta domicilios completados', prefix: '#' },
            { key: 'metaExtintores', label: '🔧 Meta extintores recargados', prefix: '#' },
          ].map(c => (
            <div key={c.key} style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: '#374151', marginBottom: '6px' }}>{c.label}</label>
              <div style={{ display: 'flex', alignItems: 'center', border: '2px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                <span style={{ padding: '10px 12px', background: '#f3f4f6', color: '#6b7280', fontWeight: 700 }}>{c.prefix}</span>
                <input type="number" style={{ flex: 1, padding: '10px 14px', border: 'none', outline: 'none', fontSize: '14px' }}
                  value={form[c.key] || ''} onChange={e => setForm(p => ({ ...p, [c.key]: parseFloat(e.target.value) || 0 }))} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
          <button onClick={onCerrar} style={{ padding: '10px 20px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>Cancelar</button>
          <button onClick={() => onGuardar(form)} style={{ padding: '10px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>💾 Guardar</button>
        </div>
      </div>
    </div>
  );
};

const Dashboard = ({ user }) => {
  const [stats, setStats]     = useState({ totalOrders: 0, activeOrders: 0, canceledOrders: 0, completadasMes: 0, totalClients: 0, ventasMes: 0, ivaMes: 0, domiciliosMes: 0, extintorescargados: 0 });
  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [mostrarMetas, setMostrarMetas] = useState(false);
  const [metas, setMetas]     = useState(() => {
    try { const s = localStorage.getItem('c360_metas'); return s ? JSON.parse(s) : { metaVentas: 25000000, metaDomicilios: 80, metaExtintores: 50 }; }
    catch { return { metaVentas: 25000000, metaDomicilios: 80, metaExtintores: 50 }; }
  });

  const token = localStorage.getItem('token');
  const isAdmin = user?.role === 'admin';
  const [alertasCobranza, setAlertasCobranza] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [ordersRes, clientsRes, productsRes, gestionesRes] = await Promise.all([
        axios.get(`${API}/orders`, { headers }),
        axios.get(`${API}/clients?activo=true`, { headers }),
        axios.get(`${API}/products`, { headers }),
        axios.get(`${API}/cxc/gestiones/todas`, { headers }).catch(() => ({ data: [] })),
      ]);

      // Alertas cobranza: gestiones con proximoSeguimiento <= hoy
      const hoyStr = new Date().toISOString().split('T')[0];
      const gestiones = Array.isArray(gestionesRes.data) ? gestionesRes.data : [];
      // Agrupar por cliente y tomar la más reciente
      const porCliente = {};
      gestiones.forEach(g => {
        if (!g.proximoSeguimiento) return;
        if (!porCliente[g.clienteId] || g.proximoSeguimiento > porCliente[g.clienteId].proximoSeguimiento) {
          porCliente[g.clienteId] = g;
        }
      });
      const alertas = Object.values(porCliente).filter(g => g.proximoSeguimiento <= hoyStr);
      setAlertasCobranza(alertas);

      const all = Array.isArray(ordersRes.data) ? ordersRes.data : [];
      const clients = Array.isArray(clientsRes.data) ? clientsRes.data : [];

      const ahora = new Date();
      const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

      const validas = all.filter(o => o.estado !== 'anulada');
      const anuladas = all.filter(o => o.estado === 'anulada');
      const activas = validas.filter(o => o.estado !== 'cuadre_dinero');

      const toDate = (val) => {
        if (!val) return null;
        if (val._seconds) return new Date(val._seconds * 1000);
        if (val.toDate) return val.toDate();
        return new Date(val);
      };
      const ordenesMes = validas.filter(o => {
        const f = toDate(o.createdAt);
        return f && f >= inicioMes;
      });

     const completadasMes = ordenesMes.filter(o => o.estado === 'cuadre_dinero');
      const ventasMes = ordenesMes.reduce((s, o) => s + (o.subtotal || 0), 0);
      const ivaMes = ordenesMes.reduce((s, o) => s + (o.ivaValor || 0), 0);
      const domiciliosMes = ordenesMes.filter(o => o.lugarAtencion === 'domicilio').length;

      let extintorescargados = 0;
      completadasMes.forEach(o => {
        (o.items || []).forEach(item => {
          const cat = (item.categoria || '').toLowerCase();
          if (cat.includes('recarga') || cat.includes('mantenimiento')) extintorescargados += (item.cantidad || 1);
        });
      });

      setStats({ totalOrders: validas.length, activeOrders: activas.length, canceledOrders: anuladas.length, completadasMes: completadasMes.length, totalClients: clients.length, totalProducts: (Array.isArray(productsRes.data) ? productsRes.data : []).length, ventasMes, ivaMes, domiciliosMes, extintorescargados });
      setOrders([...all].sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0)).slice(0, 8));
      setLoading(false);
    } catch (e) { console.error(e); setLoading(false); }
  }, [token]);

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 15000); return () => clearInterval(t); }, [fetchData]);

  const guardarMetas = (m) => { setMetas(m); localStorage.setItem('c360_metas', JSON.stringify(m)); setMostrarMetas(false); };

  if (loading) return <div style={{ textAlign: 'center', padding: '60px', color: '#9ca3af' }}>Cargando dashboard...</div>;

  const mesLabel = new Date().toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });

  return (
    <div style={{ padding: '32px', maxWidth: '1400px', margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>

      {/* HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px' }}>
        <div>
          <h2 style={{ fontSize: '26px', fontWeight: 700, margin: '0 0 4px', color: '#111' }}>📊 Dashboard — Control360</h2>
          <p style={{ color: '#9ca3af', fontSize: '14px', margin: 0 }}>Resumen en tiempo real • {mesLabel}</p>
        </div>
        {isAdmin && <button onClick={() => setMostrarMetas(true)} style={{ padding: '10px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' }}>🎯 Configurar metas</button>}
      </div>

      {/* STATS */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        {[
          { emoji: '📋', num: stats.totalOrders,     label: 'Órdenes totales',      color: '#6366f1', bg: '#eef2ff' },
          { emoji: '⚡', num: stats.activeOrders,    label: 'En proceso',           color: '#f59e0b', bg: '#fffbeb' },
          { emoji: '✅', num: stats.completadasMes,  label: 'Completadas este mes', color: '#16a34a', bg: '#f0fdf4' },
          { emoji: '👥', num: stats.totalClients,    label: 'Clientes activos',     color: '#0284c7', bg: '#e0f2fe' },
          { emoji: '🚫', num: stats.canceledOrders,  label: 'Anuladas',             color: '#dc2626', bg: '#fef2f2' },
        ].map((st, i) => (
          <div key={i} style={{ background: '#fff', padding: '20px', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', textAlign: 'center' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: st.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px', fontSize: '20px' }}>{st.emoji}</div>
            <div style={{ fontSize: '28px', fontWeight: 800, color: st.color, marginBottom: '4px' }}>{st.num}</div>
            <div style={{ fontSize: '12px', color: '#9ca3af', fontWeight: 600 }}>{st.label}</div>
          </div>
        ))}
        {/* Card especial ventas */}
        <div style={{ background: '#fff', padding: '20px', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', textAlign: 'center' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px', fontSize: '20px' }}>💰</div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: '#16a34a', marginBottom: '2px' }}>{formatCOP(stats.ventasMes)}</div>
          <div style={{ fontSize: '12px', color: '#9ca3af', fontWeight: 600 }}>Ventas del mes</div>
          {stats.ivaMes > 0 && <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '4px', fontWeight: 600 }}>IVA: {formatCOP(stats.ivaMes)}</div>}
        </div>
      </div>

      {/* DOS COLUMNAS */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>

        {/* METAS */}
        <div style={{ background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 20px 16px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>🎯 Metas del mes</h3>
            {isAdmin && <button onClick={() => setMostrarMetas(true)} style={{ padding: '6px 14px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '12px' }}>✏️ Editar</button>}
          </div>
          <div style={{ padding: '0 16px 16px' }}>
            <BarraMeta label="Ventas del mes" actual={stats.ventasMes} meta={metas.metaVentas} color="#667eea" unidad="$" emoji="💰" />
            <BarraMeta label="Domicilios completados" actual={stats.domiciliosMes} meta={metas.metaDomicilios} color="#0284c7" unidad="domicilios" emoji="🚚" />
            <BarraMeta label="Extintores recargados" actual={stats.extintorescargados} meta={metas.metaExtintores} color="#8b5cf6" unidad="extintores" emoji="🔧" />
          </div>
        </div>

        {/* FLUJO ESTADOS */}
        <div style={{ background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, padding: '20px 20px 16px' }}>📊 Flujo de órdenes</h3>
          <div style={{ padding: '0 16px 16px' }}>
            {Object.entries(ESTADOS).filter(([k]) => k !== 'anulada').map(([key, val]) => {
              const count = orders.filter(o => o.estado === key).length;
              return (
                <div key={key} style={{ marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
                    <span style={{ color: val.color, fontWeight: 600 }}>{val.label}</span>
                    <span style={{ fontWeight: 700, color: '#374151' }}>{count}</span>
                  </div>
                  <div style={{ background: '#f3f4f6', borderRadius: '999px', height: '6px' }}>
                    <div style={{ width: count > 0 ? Math.max(count * 20, 8) + 'px' : '0', height: '100%', background: val.color, borderRadius: '999px', transition: 'width 0.5s' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ALERTAS COBRANZA */}
      {alertasCobranza.length > 0 && (
        <div style={{ background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', overflow: 'hidden', marginBottom: '24px' }}>
          <div style={{ padding: '16px 20px', background: 'linear-gradient(135deg,#dc2626,#b91c1c)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#fff' }}>🔔 Cobranzas pendientes hoy</h3>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'rgba(255,255,255,0.8)' }}>Clientes que requieren seguimiento de cartera</p>
            </div>
            <span style={{ background: '#fff', color: '#dc2626', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16 }}>
              {alertasCobranza.length}
            </span>
          </div>
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {alertasCobranza.map((g, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 16px' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#111' }}>{g.clienteNombre}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>📅 Seguimiento programado: {new Date(g.proximoSeguimiento + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'long' })}</div>
                  {g.nota && <div style={{ fontSize: 12, color: '#374151', marginTop: 2, fontStyle: 'italic' }}>"{g.nota.substring(0, 80)}{g.nota.length > 80 ? '...' : ''}"</div>}
                </div>
                <span style={{ background: '#dc2626', color: '#fff', padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', marginLeft: 12 }}>
                  📞 Cobrar hoy
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TABLA ÚLTIMAS ÓRDENES */}
      <div style={{ background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, padding: '20px 20px 16px' }}>📋 Últimas órdenes</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Orden #', 'Cliente', 'Subtotal', 'IVA', 'Total', 'Estado', 'Fecha'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o, i) => {
                const est = ESTADOS[o.estado] || { label: o.estado || '—', color: '#666', bg: '#f3f4f6' };
                const fecha = o.createdAt?._seconds ? new Date(o.createdAt._seconds * 1000).toLocaleDateString('es-CO') : '—';
                const anulada = o.estado === 'anulada';
                return (
                  <tr key={o.id} style={{ background: anulada ? '#fef9f9' : i % 2 === 0 ? '#fff' : '#f9fafb', borderBottom: '1px solid #f3f4f6', opacity: anulada ? 0.6 : 1 }}>
                    <td style={{ padding: '12px 16px', fontSize: '13px' }}>
                      <code style={{ background: '#f3f4f6', padding: '3px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}>{o.numeroOrden || '—'}</code>
                      {anulada && <span style={{ marginLeft: '6px', fontSize: '10px', color: '#dc2626', fontWeight: 700 }}>ANULADA</span>}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: '13px', fontWeight: 600 }}>{o.clienteNombre || '—'}</td>
                    <td style={{ padding: '12px 16px', fontSize: '13px', color: '#374151' }}>{formatCOP(o.subtotal || 0)}</td>
                    <td style={{ padding: '12px 16px', fontSize: '12px', color: '#f59e0b' }}>{o.ivaValor > 0 ? formatCOP(o.ivaValor) : '—'}</td>
                    <td style={{ padding: '12px 16px', fontSize: '13px', fontWeight: 700, color: anulada ? '#9ca3af' : '#16a34a', textDecoration: anulada ? 'line-through' : 'none' }}>{formatCOP(o.total)}</td>
                    <td style={{ padding: '12px 16px', fontSize: '13px' }}>
                      <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, background: est.bg, color: est.color }}>{est.label}</span>
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: '13px', color: '#374151' }}>{fecha}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: '12px', marginTop: '20px' }}>🔄 Actualizando cada 15 segundos</div>

      {mostrarMetas && <ModalMetas metas={metas} onGuardar={guardarMetas} onCerrar={() => setMostrarMetas(false)} />}
    </div>
  );
};

export default Dashboard;
