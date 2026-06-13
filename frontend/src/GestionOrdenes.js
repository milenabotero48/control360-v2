import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import NuevaOrden from './NuevaOrden';
import DetalleOrden from './DetalleOrden';
import { exportarExcel } from './exportExcel';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const ESTADOS = {
  completada:         { label: 'Completada',           color: '#16a34a', bg: '#f0fdf4',  modulo: null },
  cxc:                { label: 'CXC',                  color: '#dc2626', bg: '#fef2f2',  modulo: 'cxc' },
  programada:         { label: 'Programada',           color: '#6366f1', bg: '#eef2ff',  modulo: null },
  en_ruta_recogida:   { label: 'En Ruta Recogida',     color: '#f59e0b', bg: '#fffbeb',  modulo: 'logistica' },
  en_taller:          { label: 'En Taller',            color: '#8b5cf6', bg: '#f5f3ff',  modulo: 'taller' },
  facturado:          { label: 'Facturado',            color: '#0284c7', bg: '#e0f2fe',  modulo: null },
  despacho:           { label: 'Despacho',             color: '#d97706', bg: '#fef3c7',  modulo: 'logistica' },
  en_ruta_entrega:    { label: 'En Ruta Entrega',      color: '#059669', bg: '#ecfdf5',  modulo: 'logistica' },
  entrega_cobranza:   { label: 'Entrega Cobranza',     color: '#ea580c', bg: '#fff7ed',  modulo: 'logistica' },
  reparacion_proceso: { label: 'Reparación en Proceso',color: '#e11d48', bg: '#ffe4e8',  modulo: 'taller' },
  cuadre_dinero:      { label: 'Cuadre Dinero',        color: '#0891b2', bg: '#ecfeff',  modulo: 'logistica' },
  anulada:            { label: 'Anulada',              color: '#6b7280', bg: '#f3f4f6',  modulo: null },
};

// Helper: filtrar estados según módulos activos del usuario
const estadosVisibles = (userModulos) => {
  const mods = userModulos || [];
  const sinFiltro = mods.length === 0;
  return Object.entries(ESTADOS).filter(([, v]) =>
    sinFiltro || !v.modulo || mods.includes(v.modulo)
  );
};

const PRIORIDAD_COLOR = { normal: '#6b7280', alta: '#f59e0b', urgente: '#dc2626' };

const formatCOP = (v) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);
const formatFecha = (f) => { if (!f) return '—'; try { return new Date(f).toLocaleDateString('es-CO'); } catch { return '—'; } };

const GestionOrdenes = ({ user }) => {
  const [ordenes, setOrdenes]           = useState([]);
  const [loading, setLoading]           = useState(true);
  const [buscar, setBuscar]             = useState('');
  const [filtroEstado, setFiltroEstado] = useState('');
  const [filtroTipo, setFiltroTipo]     = useState('');
  const [filtroDesde, setFiltroDesde]   = useState('');
  const [filtroHasta, setFiltroHasta]   = useState('');
  const [filtroPendientesPago, setFiltroPendientesPago] = useState(false);  // Ola 2.5
  // Ola 3: si venimos de Telemercadeo con un cliente recién convertido,
  // se abre directamente la creación de orden (el prefill lo lee NuevaOrden).
  const [vistaActual, setVistaActual]   = useState(() =>
    sessionStorage.getItem('c360_orden_prefill') ? 'nueva' : 'lista'
  ); // lista | nueva | detalle | editar
  const [ordenSeleccionada, setOrdenSeleccionada] = useState(null);
  const [ordenEditar, setOrdenEditar]   = useState(null);
  const [error, setError]               = useState('');
  const [exito, setExito]               = useState('');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };
  const isAdmin = user?.role === 'admin';

  const cargarOrdenes = useCallback(async () => {
    try {
      setLoading(true);
      let url = `${API}/orders?`;
      if (filtroEstado) url += `estado=${filtroEstado}&`;
      if (filtroTipo) url += `tipoOrden=${filtroTipo}&`;
      if (buscar) url += `buscar=${encodeURIComponent(buscar)}&`;
      const res = await axios.get(url, { headers });
      setOrdenes(Array.isArray(res.data) ? res.data : []);
    } catch { setOrdenes([]); }
    finally { setLoading(false); }
  }, [filtroEstado, filtroTipo, buscar, token]);

  useEffect(() => { cargarOrdenes(); }, [cargarOrdenes]);

  const abrirDetalle = (orden) => {
    setOrdenSeleccionada(orden);
    setVistaActual('detalle');
  };

  const abrirEdicion = (orden) => {
    setOrdenEditar(orden);
    setVistaActual('editar');
  };

  const handleOrdenCreada = async (tipoAtencion) => {
    await cargarOrdenes();
    setVistaActual('lista');
    setExito('Orden creada exitosamente ✓');
    setTimeout(() => setExito(''), 3000);
  };

  if (vistaActual === 'nueva') {
    return <NuevaOrden user={user} onCreada={handleOrdenCreada} onCancelar={() => setVistaActual('lista')} />;
  }

  if (vistaActual === 'editar' && ordenEditar) {
    return <NuevaOrden user={user} ordenEditar={ordenEditar} onCreada={() => { setOrdenEditar(null); setVistaActual('lista'); cargarOrdenes(); }} onCancelar={() => { setOrdenEditar(null); setVistaActual('lista'); }} />;
  }

  if (vistaActual === 'detalle' && ordenSeleccionada) {
    return <DetalleOrden user={user} ordenId={ordenSeleccionada.id} onVolver={() => { setVistaActual('lista'); cargarOrdenes(); }} />;
  }

  // ─── VISTA LISTA ────────────────────────────────────────────────────────────
  const esPagoVirtualFn = (fp) => fp && fp !== 'Efectivo' && fp !== 'A crédito (CxC)' &&
    fp !== 'A crédito' && fp !== 'CXC' && fp !== 'Cuenta por Pagar';

  // Contador global de pendientes (para el badge del botón)
  const totalPendientesPago = ordenes.filter(o =>
    esPagoVirtualFn(o.formaPago) && o.pagado === true &&
    o.pagoValidado !== true && !o.pagoRechazado
  ).length;

  const ordenesFiltradas = ordenes.filter(o => {
    // Filtro de pendientes de validar pago (Ola 2.5)
    if (filtroPendientesPago) {
      const esVirtual = esPagoVirtualFn(o.formaPago);
      const pend = esVirtual && o.pagado === true && o.pagoValidado !== true && !o.pagoRechazado;
      if (!pend) return false;
    }
    if (!filtroDesde && !filtroHasta) return true;
    const raw = o.createdAt?._seconds ? new Date(o.createdAt._seconds * 1000) : o.createdAt ? new Date(o.createdAt) : null;
    if (!raw) return true;
    const fecha = raw.toISOString().split('T')[0]; // 'YYYY-MM-DD' sin horas
    if (filtroDesde && fecha < filtroDesde) return false;
    if (filtroHasta && fecha > filtroHasta) return false;
    return true;
  });

  return (
    <div style={s.wrapper}>
      {/* HEADER */}
      <div style={s.pageHeader}>
        <div>
          <h2 style={s.pageTitle}>📋 Órdenes de Servicio</h2>
          <p style={s.pageSubtitle}>Gestión completa del flujo operativo</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {/* PAQUETE B: Exportar solo si admin + registra auditoría antes */}
          {user?.role === 'admin' && (
            <button onClick={async () => {
              try {
                // 1. Registrar auditoría primero (si falla, NO exporta)
                await axios.post(`${API}/auditoria/exportacion`, {
                  modulo: 'ordenes',
                  formato: 'excel',
                  cantidad: ordenes.length,
                  filtros: {
                    estado: filtroEstado || null,
                    tipo: filtroTipo || null,
                    desde: filtroDesde || null,
                    hasta: filtroHasta || null,
                    pendientesPago: filtroPendientesPago || null
                  },
                  descripcion: `Exportación de ${ordenes.length} órdenes`
                }, { headers: { Authorization: `Bearer ${token}` } });
                // 2. Si la auditoría aprobó, exportar
                exportarExcel(ordenes, [
                  { key: 'numeroOrden',   label: 'N° Orden' },
                  { key: 'createdAt',     label: 'Fecha', getValue: o => o.createdAt ? new Date(o.createdAt).toLocaleDateString('es-CO') : '' },
                  { key: 'clienteNombre', label: 'Cliente' },
                  { key: 'empresaNombre', label: 'Empresa' },
                  { key: 'estado',        label: 'Estado' },
                  { key: 'lugarAtencion', label: 'Tipo Atención' },
                  { key: 'formaPago',     label: 'Forma Pago' },
                  { key: 'total',         label: 'Total' },
                  { key: 'pagado',        label: 'Pagado', getValue: o => o.pagado ? 'Sí' : 'No' },
                ], 'ordenes');
              } catch (e) {
                alert('No se pudo exportar: ' + (e.response?.data?.error || e.message));
              }
            }} style={{ padding: '10px 16px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              📥 Exportar Excel
            </button>
          )}
          <button onClick={() => setVistaActual('nueva')} style={s.btnPrimario}>+ Nueva Orden</button>
        </div>
      </div>

      {error && <div style={s.alertError}>{error}</div>}
      {exito && <div style={s.alertExito}>{exito}</div>}

      {/* STATS RÁPIDAS */}
      <div style={s.statsRow}>
        {estadosVisibles(user?.modulos).map(([key, val]) => {
          const count = ordenes.filter(o => o.estado === key).length;
          return (
            <button key={key} onClick={() => setFiltroEstado(filtroEstado === key ? '' : key)}
              style={{ ...s.statCard, borderColor: filtroEstado === key ? val.color : '#e5e7eb', background: filtroEstado === key ? val.bg : '#fff' }}>
              <span style={{ ...s.statNum, color: val.color }}>{count}</span>
              <span style={s.statLabel}>{val.label}</span>
            </button>
          );
        })}
      </div>

      {/* FILTROS */}
      <div style={s.filtros}>
        <div style={s.searchWrap}>
          <span>🔍</span>
          <input style={s.searchInput} placeholder="Buscar por número o cliente..."
            value={buscar} onChange={e => setBuscar(e.target.value)} />
          {buscar && <button onClick={() => setBuscar('')} style={s.clearBtn}>✕</button>}
        </div>

        {/* Ola 2.5: filtro rápido de pagos pendientes de validar (admin/tesorería) */}
        {(user?.role === 'admin' || user?.role === 'tesoreria') && totalPendientesPago > 0 && (
          <button
            onClick={() => setFiltroPendientesPago(!filtroPendientesPago)}
            style={{
              padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
              fontSize: 13, fontWeight: 700,
              border: filtroPendientesPago ? '2px solid #f59e0b' : '2px solid #fcd34d',
              background: filtroPendientesPago ? '#f59e0b' : '#fffbeb',
              color: filtroPendientesPago ? '#fff' : '#92400e',
              display: 'flex', alignItems: 'center', gap: 8,
              animation: !filtroPendientesPago ? 'pulse 2s infinite' : 'none'
            }}
            title="Pagos electrónicos pendientes de validación"
          >
            ⏳ Validar pagos
            <span style={{
              background: filtroPendientesPago ? '#fff' : '#f59e0b',
              color: filtroPendientesPago ? '#f59e0b' : '#fff',
              borderRadius: 12, padding: '1px 8px', fontSize: 12, fontWeight: 800
            }}>
              {totalPendientesPago}
            </span>
          </button>
        )}

        <select style={s.select} value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
          <option value="">Todos los estados</option>
          {estadosVisibles(user?.modulos).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select style={s.select} value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
          <option value="">Todos los tipos</option>
          <option value="servicio">🛠️ Servicio</option>
          <option value="cxc">💰 Cobranza</option>
          <option value="interna">📋 Interna</option>
        </select>
        <input type="date" style={{ ...s.select, maxWidth: 150 }} value={filtroDesde}
          onChange={e => setFiltroDesde(e.target.value)} title="Desde" />
        <input type="date" style={{ ...s.select, maxWidth: 150 }} value={filtroHasta}
          onChange={e => setFiltroHasta(e.target.value)} title="Hasta" />
        {(filtroDesde || filtroHasta) && (
          <button onClick={() => { setFiltroDesde(''); setFiltroHasta(''); }}
            style={{ padding: '8px 14px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
            ✕ Limpiar fechas
          </button>
        )}
      </div>

      <p style={s.contador}>{ordenesFiltradas.length} orden{ordenesFiltradas.length !== 1 ? 'es' : ''}</p>

      {/* TABLA */}
      {loading ? (
        <div style={s.loadingBox}>Cargando órdenes...</div>
      ) : ordenesFiltradas.length === 0 ? (
        <div style={s.emptyBox}>
          <p style={{ fontSize: '48px', margin: '0 0 12px' }}>📋</p>
          <p>{ordenes.length === 0 ? 'No hay órdenes aún' : 'No hay órdenes con los filtros seleccionados'}</p>
          {ordenes.length === 0 && <button onClick={() => setVistaActual('nueva')} style={s.btnPrimario}>+ Crear primera orden</button>}
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.tabla}>
            <thead>
              <tr style={s.theadRow}>
                {['Orden #', 'Cliente', 'Tipo', 'Estado', 'Total', 'Fecha', 'Mensajero', 'Acciones'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordenesFiltradas.map((o, i) => {
                // ✅ FIX: si está completada pero sin pagar y es CxC → mostrar "Cuenta por Cobrar"
                const esCxcSinPagar = o.estado === 'completada' && o.pagado === false &&
                  ['A crédito (CxC)', 'A crédito', 'CXC', 'Cuenta por Pagar'].includes(o.formaPago);
                const est = esCxcSinPagar
                  ? { label: '💳 Cuenta por Cobrar', color: '#b45309', bg: '#fef3c7' }
                  : (ESTADOS[o.estado] || { label: o.estado, color: '#666', bg: '#f3f4f6' });
                return (
                  <tr key={o.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', cursor: 'pointer' }}
                    onClick={() => abrirDetalle(o)}>
                    <td style={s.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <code style={s.numOrden}>{o.numeroOrden}</code>
                        {o.prioridad === 'urgente' && <span style={s.urgente}>🔴</span>}
                        {o.prioridad === 'alta' && <span style={s.urgente}>🟡</span>}
                        {o.generaCertificado && <span title="Genera certificado">📜</span>}
                      </div>
                    </td>
                    <td style={s.td}>
                      <div style={{ fontWeight: 600, color: '#111' }}>{o.clienteNombre}</div>
                      {o.sucursalNombre && <div style={{ fontSize: '11px', color: '#9ca3af' }}>{o.sucursalNombre}</div>}
                    </td>
                    <td style={s.td}>
                      <span style={s.tipoBadge}>
                        {o.tipoOrden === 'servicio' ? '🛠️ Servicio' : o.tipoOrden === 'cxc' ? '💰 CxC' : '📋 Interna'}
                      </span>
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                        <span style={{ ...s.estadoBadge, background: est.bg, color: est.color }}>
                          {est.label}
                        </span>
                        {/* Ola 2.5: badge visible cuando hay pago electrónico pendiente de validar */}
                        {(() => {
                          const esVirtual = o.formaPago && o.formaPago !== 'Efectivo' &&
                            o.formaPago !== 'A crédito (CxC)' && o.formaPago !== 'A crédito' &&
                            o.formaPago !== 'CXC' && o.formaPago !== 'Cuenta por Pagar';
                          const pendienteValidar = esVirtual && o.pagado === true &&
                            o.pagoValidado !== true && !o.pagoRechazado;
                          if (!pendienteValidar) return null;
                          return (
                            <span style={{
                              padding: '3px 10px', borderRadius: 12,
                              background: '#fef3c7', color: '#92400e',
                              fontSize: 11, fontWeight: 700,
                              border: '1px solid #fcd34d',
                              animation: 'pulse 2s infinite'
                            }} title="Pago electrónico pendiente de validación por Admin/Tesorería">
                              ⏳ Validar pago
                            </span>
                          );
                        })()}
                        {/* Si ya fue rechazado */}
                        {o.pagoRechazado && (
                          <span style={{
                            padding: '3px 10px', borderRadius: 12,
                            background: '#fee2e2', color: '#991b1b',
                            fontSize: 11, fontWeight: 700, border: '1px solid #fca5a5'
                          }} title={o.pagoValidacionMotivo || 'Pago rechazado'}>
                            ❌ Pago rechazado
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...s.td, fontWeight: 700, color: '#16a34a' }}>{formatCOP(o.total)}</td>
                    <td style={s.td}>{formatFecha(o.fechaProgramada)}</td>
                    <td style={s.td}>{o.mensajeroNombre || <span style={{ color: '#9ca3af' }}>Sin asignar</span>}</td>
                    <td style={s.td} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => abrirDetalle(o)} style={s.btnAccion} title="Ver detalle">👁️</button>
                        {(['programada', 'en_ruta_recogida'].includes(o.estado) || user.role === 'admin') && (
                          <button onClick={() => abrirEdicion(o)} style={s.btnAccion} title="Editar">✏️</button>
                        )}
                        <button onClick={() => {
                          const msg = `Hola, le informamos sobre su orden ${o.numeroOrden}. Total: ${formatCOP(o.total)}. Gracias por preferirnos.`;
                          window.open(`https://wa.me/${o.clienteCelular?.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`, '_blank');
                        }} style={s.btnAccion} title="WhatsApp">📱</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const s = {
  wrapper:    { padding: '32px', maxWidth: '1400px', margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' },
  pageTitle:  { margin: 0, fontSize: '26px', fontWeight: 700, color: '#111' },
  pageSubtitle:{ margin: '4px 0 0', color: '#6b7280', fontSize: '14px' },
  btnPrimario:{ padding: '12px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' },
  alertError: { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' },
  alertExito: { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' },

  statsRow:   { display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' },
  statCard:   { padding: '12px 16px', borderRadius: '8px', border: '2px solid', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '90px', background: '#fff', transition: 'all 0.15s' },
  statNum:    { fontSize: '22px', fontWeight: 800 },
  statLabel:  { fontSize: '10px', color: '#6b7280', textAlign: 'center', marginTop: '2px' },

  filtros:    { display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' },
  searchWrap: { display: 'flex', alignItems: 'center', flex: 1, minWidth: '250px', background: '#fff', border: '2px solid #e5e7eb', borderRadius: '8px', padding: '0 12px' },
  searchInput:{ flex: 1, border: 'none', outline: 'none', fontSize: '14px', padding: '10px 8px', background: 'transparent' },
  clearBtn:   { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' },
  select:     { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', background: '#fff' },
  contador:   { color: '#9ca3af', fontSize: '13px', marginBottom: '12px' },
  loadingBox: { textAlign: 'center', padding: '60px', color: '#9ca3af' },
  emptyBox:   { textAlign: 'center', padding: '60px', color: '#9ca3af', background: '#fff', borderRadius: '12px' },

  tableWrap:  { background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', overflow: 'auto' },
  tabla:      { width: '100%', borderCollapse: 'collapse' },
  theadRow:   { background: '#f9fafb' },
  th:         { padding: '12px 16px', textAlign: 'left', fontSize: '12px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' },
  td:         { padding: '14px 16px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #f3f4f6', verticalAlign: 'middle' },
  numOrden:   { background: '#f3f4f6', padding: '3px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' },
  urgente:    { fontSize: '12px' },
  tipoBadge:  { fontSize: '12px', color: '#6b7280' },
  estadoBadge:{ padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap' },
  btnAccion:  { padding: '6px 10px', background: '#f3f4f6', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' },
};

export default GestionOrdenes;
