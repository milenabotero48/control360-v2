import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard del Mensajero (Control360 v2 — Ola 2)
// ─────────────────────────────────────────────────────────────────────────────
// Una sola llamada a /api/dashboards/mensajero/:id trae:
//   - KPIs: ruta hoy, entregadas hoy, entregadas mes, cobro pendiente, fotos pendientes
//   - Lista de órdenes en ruta del día
//   - Histórico de últimos 5 cuadres
//
// Ola 2 Frente 3: agrega botón "+ Agregar items" en cada orden de la ruta.
// Permite al mensajero sumar productos sobre la marcha cuando el cliente
// pide cosas adicionales en sitio (señalización, botiquines, extintores
// nuevos). NO se permiten items de taller (recarga/mantenimiento/PH) —
// para eso debe crearse una orden nueva.
// ─────────────────────────────────────────────────────────────────────────────

const fmtCop = (v) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0
}).format(v || 0);

const fmtNum = (v) => new Intl.NumberFormat('es-CO').format(v || 0);

const ESTADO_LABELS = {
  programada:       { label: 'Programada',       color: '#6366f1', bg: '#eef2ff' },
  en_ruta_recogida: { label: 'En Ruta Recogida', color: '#f59e0b', bg: '#fffbeb' },
  despacho:         { label: 'Despacho',         color: '#d97706', bg: '#fef3c7' },
  en_ruta_entrega:  { label: 'En Ruta Entrega',  color: '#059669', bg: '#ecfdf5' },
  entrega_cobranza: { label: 'Cobranza',          color: '#dc2626', bg: '#fef2f2' },
};

// Categorías que SÍ se pueden agregar en sitio (NO taller)
const esCategoriaTaller = (cat) => {
  const c = (cat || '').toLowerCase();
  return c.includes('recarga') || c.includes('mantenimiento') || c.includes('hidrost');
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
      <div style={{ position: 'absolute', top: 8, right: 10, width: 10, height: 10, borderRadius: '50%', background: '#dc2626' }} />
    )}
    <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>
      {icon} {label}
    </div>
    <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
  </div>
);

// ═════════════════════════════════════════════════════════════════════════════
// MODAL: AGREGAR ITEMS EN SITIO (Ola 2 Frente 3)
// ═════════════════════════════════════════════════════════════════════════════
const ModalAgregarItems = ({ orden, productos, onAgregado, onCerrar }) => {
  const [busqueda, setBusqueda] = useState('');
  const [carrito, setCarrito]   = useState([]); // [{productoId, nombre, categoria, cantidad, precioUnitario, descuento, notas}]
  const [guardando, setGuardando] = useState(false);
  const [error, setError]       = useState('');

  // Filtrar productos: ocultar los de categoría taller
  const productosVisibles = productos
    .filter(p => !esCategoriaTaller(p.categoria))
    .filter(p => !busqueda || p.nombre.toLowerCase().includes(busqueda.toLowerCase()))
    .slice(0, 30);

  const agregarAlCarrito = (p) => {
    setError('');
    const existe = carrito.find(c => c.productoId === p.id);
    if (existe) {
      setCarrito(carrito.map(c => c.productoId === p.id ? { ...c, cantidad: c.cantidad + 1 } : c));
    } else {
      setCarrito([...carrito, {
        productoId: p.id,
        nombre: p.nombre,
        categoria: p.categoria,
        cantidad: 1,
        precioUnitario: Number(p.precioVenta) || 0,
        descuento: 0,
        notas: ''
      }]);
    }
  };

  const cambiarCantidad = (productoId, delta) => {
    setCarrito(carrito.map(c => {
      if (c.productoId !== productoId) return c;
      const nuevoCant = Math.max(1, c.cantidad + delta);
      return { ...c, cantidad: nuevoCant };
    }));
  };

  const quitarDelCarrito = (productoId) => {
    setCarrito(carrito.filter(c => c.productoId !== productoId));
  };

  const totalCarrito = carrito.reduce((s, c) => s + (c.cantidad * c.precioUnitario), 0);

  const confirmar = async () => {
    setError('');
    if (carrito.length === 0) return setError('Agrega al menos un producto');
    try {
      setGuardando(true);
      await axios.post(
        `${API}/orders/${orden.id}/agregar-items`,
        { items: carrito },
        { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
      );
      onAgregado();
    } catch (e) {
      setError(e.response?.data?.error || 'Error al agregar items');
    } finally {
      setGuardando(false);
    }
  };

  const st = {
    overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 },
    modal:      { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 720, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' },
    header:     { padding: '20px 24px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: 'linear-gradient(135deg, #ede9fe 0%, #fff 100%)' },
    title:      { margin: 0, fontSize: 17, fontWeight: 700, color: '#111' },
    subtitle:   { margin: '4px 0 0', fontSize: 13, color: '#6b7280' },
    btnX:       { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16 },
    alert:      { padding: '10px 14px', background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', borderRadius: 8, fontSize: 13, fontWeight: 500, margin: '12px 24px 0' },
    body:       { padding: '16px 24px', overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 },
    aviso:      { padding: '10px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 12, color: '#78350f' },
    search:     { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 14, outline: 'none' },
    listaProd:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, maxHeight: 200, overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: 8 },
    prodCard:   { padding: '10px', borderRadius: 6, background: '#f9fafb', cursor: 'pointer', transition: 'background 0.15s', border: '1px solid transparent' },
    carritoBox: { background: '#f9fafb', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 },
    carritoRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px', background: '#fff', borderRadius: 6 },
    footer:     { padding: '14px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fafafa' },
    btnCancel:  { padding: '10px 20px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
    btnOk:      { padding: '10px 22px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' }
  };

  return (
    <div style={st.overlay} onClick={() => !guardando && onCerrar()}>
      <div style={st.modal} onClick={e => e.stopPropagation()}>
        <div style={st.header}>
          <div>
            <h3 style={st.title}>➕ Agregar items a {orden.numeroOrden}</h3>
            <p style={st.subtitle}>Cliente: {orden.clienteNombre}</p>
          </div>
          <button onClick={onCerrar} style={st.btnX} disabled={guardando}>✕</button>
        </div>

        {error && <div style={st.alert}>⚠ {error}</div>}

        <div style={st.body}>
          <div style={st.aviso}>
            <strong>Solo productos de venta directa.</strong> No se permiten recargas, mantenimientos ni pruebas hidrostáticas — esos requieren orden nueva y traer el equipo al taller.
          </div>

          <input
            type="text"
            placeholder="🔍 Buscar producto..."
            style={st.search}
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
          />

          <div style={st.listaProd}>
            {productosVisibles.length === 0 ? (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#9ca3af', padding: 20, fontSize: 13 }}>
                {busqueda ? 'No hay productos con ese nombre' : 'No hay productos disponibles para venta directa'}
              </div>
            ) : productosVisibles.map(p => (
              <div key={p.id} style={st.prodCard}
                onClick={() => agregarAlCarrito(p)}
                onMouseOver={e => e.currentTarget.style.background = '#ede9fe'}
                onMouseOut={e => e.currentTarget.style.background = '#f9fafb'}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.nombre}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{p.categoria || 'Sin categoría'}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#16a34a', marginTop: 4 }}>{fmtCop(p.precioVenta || 0)}</div>
                {p.tieneStock && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>Stock: {p.stock || 0}</div>}
              </div>
            ))}
          </div>

          {/* Carrito */}
          {carrito.length > 0 && (
            <div style={st.carritoBox}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 4 }}>
                🛒 Items a agregar ({carrito.length})
              </div>
              {carrito.map(c => (
                <div key={c.productoId} style={st.carritoRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.nombre}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>{fmtCop(c.precioUnitario)} c/u</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button onClick={() => cambiarCantidad(c.productoId, -1)} style={{ width: 26, height: 26, borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontWeight: 700 }}>−</button>
                    <div style={{ minWidth: 28, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{c.cantidad}</div>
                    <button onClick={() => cambiarCantidad(c.productoId, 1)} style={{ width: 26, height: 26, borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontWeight: 700 }}>+</button>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#16a34a', minWidth: 80, textAlign: 'right' }}>
                    {fmtCop(c.cantidad * c.precioUnitario)}
                  </div>
                  <button onClick={() => quitarDelCarrito(c.productoId)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 14 }}>✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #d1d5db', paddingTop: 8, marginTop: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Subtotal a agregar</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: '#16a34a' }}>{fmtCop(totalCarrito)}</span>
              </div>
            </div>
          )}
        </div>

        <div style={st.footer}>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {carrito.length} producto(s) · {carrito.reduce((s, c) => s + c.cantidad, 0)} unidad(es)
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onCerrar} style={st.btnCancel} disabled={guardando}>Cancelar</button>
            <button
              onClick={confirmar}
              style={{ ...st.btnOk, opacity: guardando || carrito.length === 0 ? 0.5 : 1, cursor: guardando ? 'not-allowed' : 'pointer' }}
              disabled={guardando || carrito.length === 0}
            >
              {guardando ? 'Agregando...' : `✓ Agregar a la orden`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
const DashboardMensajero = ({ user }) => {
  const [data, setData]         = useState(null);
  const [productos, setProductos] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [ordenAgregar, setOrdenAgregar] = useState(null);

  const token = localStorage.getItem('token');
  const mensajeroId = user?.id || user?.uid;

  const cargar = useCallback(async () => {
    if (!mensajeroId) return;
    try {
      const [d, p] = await Promise.all([
        axios.get(`${API}/dashboards/mensajero/${mensajeroId}`, { headers: { Authorization: `Bearer ${token}` } }),
        axios.get(`${API}/products`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] }))
      ]);
      setData(d.data);
      setProductos(Array.isArray(p.data) ? p.data : []);
      setError('');
    } catch {
      setError('No se pudo cargar el dashboard');
    } finally {
      setLoading(false);
    }
  }, [token, mensajeroId]);

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 15000);
    return () => clearInterval(t);
  }, [cargar]);

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Cargando ruta del día...</div>;
  if (error)   return <div style={{ textAlign: 'center', padding: 60, color: '#dc2626' }}>{error}</div>;
  if (!data)   return null;

  const k = data.kpis;
  const saludo = user?.nombre || 'Mensajero';

  return (
    <div style={{ padding: 28, maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>

      {/* HEADER */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 4px', color: '#111' }}>
          🚚 Mi ruta del día
        </h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>
          Hola {saludo} — {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' })}
        </p>
      </div>

      {/* 5 KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 24 }}>
        <KpiCard icon="📋" label="Órdenes en ruta"     value={fmtNum(k.ordenesRutaHoy)}    sub="Asignadas hoy"           color="#0891b2" />
        <KpiCard icon="✅" label="Entregadas hoy"      value={fmtNum(k.entregadasHoy)}     sub="Completadas"             color="#16a34a" />
        <KpiCard icon="📅" label="Entregadas mes"      value={fmtNum(k.entregadasMes)}     sub="Total mes"               color="#7c3aed" />
        <KpiCard icon="💵" label="Por cobrar hoy"      value={fmtCop(k.cobroPendienteHoy)} sub="Pendiente en ruta"       color="#dc2626" alerta={k.cobroPendienteHoy > 0} />
        <KpiCard icon="📸" label="Fotos pendientes"    value={fmtNum(k.fotosPendientes)}   sub="Sin foto de evidencia"   color="#f59e0b" alerta={k.fotosPendientes > 0} />
      </div>

      {/* Ruta de hoy */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.06)', marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#111' }}>
          🗺 Órdenes asignadas a mi ruta ({data.rutaHoy.length})
        </h3>
        {data.rutaHoy.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 14 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
            <div>Sin órdenes pendientes</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Ruta completada o ninguna asignada</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.rutaHoy.map(o => {
              const e = ESTADO_LABELS[o.estado] || { label: o.estado, color: '#6b7280', bg: '#f3f4f6' };
              // Solo permite agregar en estados donde el mensajero está activo (no programada)
              const puedeAgregar = ['en_ruta_recogida', 'despacho', 'en_ruta_entrega', 'entrega_cobranza'].includes(o.estado);
              return (
                <div key={o.id} style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '14px 16px', background: '#f9fafb', borderRadius: 10,
                  border: '1px solid #e5e7eb'
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#7c3aed' }}>{o.numeroOrden}</span>
                      <span style={{ padding: '2px 10px', borderRadius: 10, background: e.bg, color: e.color, fontSize: 11, fontWeight: 700 }}>{e.label}</span>
                      <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'capitalize' }}>· {o.lugarAtencion}</span>
                    </div>
                    <div style={{ fontSize: 13, color: '#111', fontWeight: 600 }}>{o.clienteNombre}</div>
                    {o.direccion && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>📍 {o.direccion}</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#16a34a' }}>{fmtCop(o.total)}</div>
                    {/* Ola 2.5: indicador si tiene cobro pendiente */}
                    {o.estado === 'entrega_cobranza' && (
                      <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 700, marginTop: 2 }}>
                        💵 Cobrar al entregar
                      </div>
                    )}
                    {o.tipoOrden === 'cxc' && (
                      <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 700, marginTop: 2 }}>
                        💵 Cobranza CxC
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                      {puedeAgregar && (
                        <button
                          onClick={() => setOrdenAgregar(o)}
                          style={{ padding: '6px 12px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
                          ➕ Agregar items
                        </button>
                      )}
                      <button
                        onClick={() => window.alert('Para gestionar esta orden (avanzar estado, cobrar, agregar préstamo) ve al módulo "Logística" en el menú lateral.')}
                        style={{ padding: '6px 12px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
                        🚀 Gestionar
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Histórico de cuadres */}
      {data.cuadresRecientes.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: '#111' }}>
            🕐 Mis últimos cuadres
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Fecha', 'Recaudo', 'Estado'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.cuadresRecientes.map(c => (
                <tr key={c.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>
                    {c.fecha ? new Date(c.fecha._seconds ? c.fecha._seconds * 1000 : c.fecha).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 700, color: '#16a34a' }}>{fmtCop(c.montoRecibido || c.total || 0)}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#16a34a' }}>✓ Cuadrado</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ordenAgregar && (
        <ModalAgregarItems
          orden={ordenAgregar}
          productos={productos}
          onAgregado={() => { setOrdenAgregar(null); cargar(); }}
          onCerrar={() => setOrdenAgregar(null)}
        />
      )}
    </div>
  );
};

export default DashboardMensajero;
