// ════════════════════════════════════════════════════════════════════════════════
// ModuloReportes.js — Reportes operativos Ola 3 Bloque 2
// ─────────────────────────────────────────────────────────────────────────────
// 4 vistas en tabs: Mensajero, Comercial, Taller, Operación General.
// Filtros comunes: rango de fechas (7 presets + personalizado), selector empresa.
// Cada vista tiene KPIs grandes, tablas drill-down e indicadores visuales.
// ════════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { exportarExcel } from './exportExcel';

const API = 'http://localhost:5000/api';

// ── HELPERS DE FORMATO ───────────────────────────────────────────────────────
const fmtCop = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const fmtPct = (n) => `${(n || 0).toFixed(1)}%`;
const fmtFecha = (raw) => {
  if (!raw) return '—';
  try { return new Date(raw).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }); }
  catch { return '—'; }
};
const fmtHoras = (h) => {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} días`;
};

// ── HELPERS DE FECHA ─────────────────────────────────────────────────────────
const hoy = () => new Date().toISOString().slice(0, 10);
const inicioMes = (offset = 0) => {
  const d = new Date(); d.setMonth(d.getMonth() + offset); d.setDate(1);
  return d.toISOString().slice(0, 10);
};
const finMes = (offset = 0) => {
  const d = new Date(); d.setMonth(d.getMonth() + offset + 1); d.setDate(0);
  return d.toISOString().slice(0, 10);
};
const inicioAnio = () => `${new Date().getFullYear()}-01-01`;
const finAnio = () => `${new Date().getFullYear()}-12-31`;

// ────────────────────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL
// ────────────────────────────────────────────────────────────────────────────
const ModuloReportes = ({ user }) => {
  const [tab, setTab] = useState('mensajero');
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoy());
  const [empresaId, setEmpresaId] = useState('');
  const [empresas, setEmpresas] = useState([]);
  const [presetActivo, setPresetActivo] = useState('mes_actual');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    axios.get(`${API}/companies`, { headers })
      .then(r => setEmpresas(Array.isArray(r.data) ? r.data : []))
      .catch(() => setEmpresas([]));
    // eslint-disable-next-line
  }, []);

  const aplicarPreset = (p) => {
    setPresetActivo(p);
    switch (p) {
      case 'mes_actual':    setDesde(inicioMes()); setHasta(hoy()); break;
      case 'mes_anterior':  setDesde(inicioMes(-1)); setHasta(finMes(-1)); break;
      case 'anio_actual':   setDesde(inicioAnio()); setHasta(hoy()); break;
      case 'anio_completo': setDesde(inicioAnio()); setHasta(finAnio()); break;
      case 'ultimos_7':     { const d = new Date(); d.setDate(d.getDate() - 6); setDesde(d.toISOString().slice(0, 10)); setHasta(hoy()); break; }
      case 'ultimos_30':    { const d = new Date(); d.setDate(d.getDate() - 29); setDesde(d.toISOString().slice(0, 10)); setHasta(hoy()); break; }
      case 'trimestre':     { const d = new Date(); d.setMonth(d.getMonth() - 2); d.setDate(1); setDesde(d.toISOString().slice(0, 10)); setHasta(hoy()); break; }
      default: break;
    }
  };

  return (
    <div style={s.wrapper}>
      <div style={s.pageHeader}>
        <div>
          <h2 style={s.pageTitle}>📉 Reportes Operativos</h2>
          <p style={s.pageSubtitle}>Inteligencia operativa en tiempo real</p>
        </div>
      </div>

      {/* FILTROS COMUNES */}
      <div style={s.filtros}>
        <div style={s.presets}>
          {[
            { v: 'mes_actual', l: 'Mes actual' },
            { v: 'mes_anterior', l: 'Mes anterior' },
            { v: 'trimestre', l: 'Último trimestre' },
            { v: 'anio_actual', l: 'Año (YTD)' },
            { v: 'anio_completo', l: 'Año completo' },
            { v: 'ultimos_7', l: 'Últimos 7 días' },
            { v: 'ultimos_30', l: 'Últimos 30 días' },
          ].map(p => (
            <button key={p.v} onClick={() => aplicarPreset(p.v)}
              style={{ ...s.preset, ...(presetActivo === p.v ? s.presetActivo : {}) }}>{p.l}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={s.campoF}>
            <label style={s.labelF}>Desde</label>
            <input type="date" value={desde} onChange={e => { setDesde(e.target.value); setPresetActivo(''); }} style={s.inputF} />
          </div>
          <div style={s.campoF}>
            <label style={s.labelF}>Hasta</label>
            <input type="date" value={hasta} onChange={e => { setHasta(e.target.value); setPresetActivo(''); }} style={s.inputF} />
          </div>
          <div style={s.campoF}>
            <label style={s.labelF}>Empresa</label>
            <select value={empresaId} onChange={e => setEmpresaId(e.target.value)} style={{ ...s.inputF, minWidth: 220 }}>
              <option value="">Todas las empresas</option>
              {empresas.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* TABS */}
      <div style={s.tabs}>
        {[
          { v: 'mensajero', l: '🚚 Mensajeros' },
          { v: 'comercial', l: '💼 Comerciales' },
          { v: 'taller',    l: '🔧 Taller' },
          { v: 'general',   l: '🎯 Operación General' },
        ].map(t => (
          <button key={t.v} onClick={() => setTab(t.v)}
            style={{ ...s.tab, ...(tab === t.v ? s.tabActivo : {}) }}>{t.l}</button>
        ))}
      </div>

      {/* VISTAS */}
      {tab === 'mensajero' && <VistaMensajero desde={desde} hasta={hasta} empresaId={empresaId} headers={headers} />}
      {tab === 'comercial' && <VistaComercial desde={desde} hasta={hasta} empresaId={empresaId} headers={headers} />}
      {tab === 'taller'    && <VistaTaller    desde={desde} hasta={hasta} empresaId={empresaId} headers={headers} />}
      {tab === 'general'   && <VistaGeneral   desde={desde} hasta={hasta} empresaId={empresaId} headers={headers} />}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// VISTA 1: MENSAJEROS
// ────────────────────────────────────────────────────────────────────────────
const VistaMensajero = ({ desde, hasta, empresaId, headers }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [usuarioSel, setUsuarioSel] = useState('');

  const cargar = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ desde, hasta });
      if (empresaId) params.append('empresaId', empresaId);
      const r = await axios.get(`${API}/reportes/mensajero?${params}`, { headers });
      setData(r.data);
    } catch (e) { setError(e.response?.data?.error || 'Error'); }
    setLoading(false);
    // eslint-disable-next-line
  }, [desde, hasta, empresaId]);

  useEffect(() => { cargar(); }, [cargar]);

  const exportar = () => {
    if (!data) return;
    const filas = [];
    data.mensajeros.forEach(m => {
      filas.push({ a: m.nombre, b: 'Asignadas', c: m.eficiencia.asignadas });
      filas.push({ a: m.nombre, b: 'Completadas', c: m.eficiencia.completadas });
      filas.push({ a: m.nombre, b: 'Tasa completitud', c: fmtPct(m.eficiencia.tasaCompletitud) });
      filas.push({ a: m.nombre, b: 'Tiempo promedio', c: fmtHoras(m.eficiencia.tiempoPromedioHoras) });
      filas.push({ a: m.nombre, b: '% Foto recogida', c: fmtPct(m.fotos.pctRecogida) });
      filas.push({ a: m.nombre, b: '% Foto entrega', c: fmtPct(m.fotos.pctEntrega) });
      filas.push({ a: m.nombre, b: '% Comprobante virtual', c: fmtPct(m.fotos.pctComprobante) });
      filas.push({ a: m.nombre, b: 'Recaudado', c: m.dinero.totalRecaudado });
      filas.push({ a: m.nombre, b: 'Faltante histórico', c: m.dinero.faltanteHistorico });
      filas.push({ a: m.nombre, b: 'Préstamos pendientes 30+ días', c: m.prestamos.pendientes30 });
      filas.push({ a: '', b: '', c: '' });
    });
    exportarExcel(filas, [
      { label: 'Mensajero', key: 'a' },
      { label: 'KPI', key: 'b' },
      { label: 'Valor', key: 'c' }
    ], `reporte_mensajeros_${desde}_${hasta}`);
  };

  if (loading) return <div style={s.cargando}>Cargando reporte de mensajeros...</div>;
  if (error) return <div style={s.error}>⚠ {error}</div>;
  if (!data || data.mensajeros.length === 0) return <div style={{ ...s.card, textAlign: 'center', color: '#9ca3af', padding: 40 }}>Sin mensajeros con actividad en el período</div>;

  const seleccionado = usuarioSel ? data.mensajeros.find(m => m.id === usuarioSel) : null;

  return (
    <div>
      {/* Barra de selección + exportar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 700 }}>VER:</span>
          <button onClick={() => setUsuarioSel('')}
            style={{ ...s.chip, ...(!usuarioSel ? s.chipActivo : {}) }}>Todos ({data.mensajeros.length})</button>
          {data.mensajeros.map(m => (
            <button key={m.id} onClick={() => setUsuarioSel(m.id)}
              style={{ ...s.chip, ...(usuarioSel === m.id ? s.chipActivo : {}) }}>{m.nombre}</button>
          ))}
        </div>
        <button onClick={exportar} style={{ ...s.btn, background: '#16a34a', color: '#fff' }}>📊 Excel</button>
      </div>

      {/* Si está seleccionado UNO, vista detalle */}
      {seleccionado ? <CardMensajeroDetalle m={seleccionado} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
          {data.mensajeros.map(m => <CardMensajeroResumen key={m.id} m={m} onVerDetalle={() => setUsuarioSel(m.id)} />)}
        </div>
      )}
    </div>
  );
};

// Card resumen mensajero (en grid)
const CardMensajeroResumen = ({ m, onVerDetalle }) => {
  const banderaRoja = m.fotos.alertaSinFoto;
  const tieneFaltante = m.dinero.faltanteHistorico > 0;

  return (
    <div style={{ ...s.card, padding: 0, overflow: 'hidden', cursor: 'pointer' }} onClick={onVerDetalle}>
      <div style={{ background: '#1a1a2e', color: '#fff', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>🚚 {m.nombre}</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>{m.eficiencia.completadas}/{m.eficiencia.asignadas} órdenes · {fmtPct(m.eficiencia.tasaCompletitud)}</div>
        </div>
        {(banderaRoja || tieneFaltante) && (
          <span style={{ background: '#dc2626', color: '#fff', padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>⚠ Atención</span>
        )}
      </div>
      <div style={{ padding: 18, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
        <MiniKPI label="Tiempo promedio" value={fmtHoras(m.eficiencia.tiempoPromedioHoras)} color="#7c3aed" />
        <MiniKPI label="Recaudado" value={fmtCop(m.dinero.totalRecaudado)} color="#0284c7" />
        <MiniKPI label="% Fotos entrega" value={fmtPct(m.fotos.pctEntrega)}
          color={m.fotos.pctEntrega >= 90 ? '#16a34a' : m.fotos.pctEntrega >= 70 ? '#f59e0b' : '#dc2626'} />
        <MiniKPI label="% Comprobante" value={fmtPct(m.fotos.pctComprobante)}
          color={m.fotos.pctComprobante >= 95 ? '#16a34a' : m.fotos.pctComprobante >= 80 ? '#f59e0b' : '#dc2626'} />

        {banderaRoja && (
          <div style={{ gridColumn: '1 / -1', background: '#fef2f2', color: '#991b1b', padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
            🚨 {m.fotos.sinFotoCantidad} órdenes sin foto de entrega → Posibles descargos
          </div>
        )}
        {tieneFaltante && (
          <div style={{ gridColumn: '1 / -1', background: '#fff7ed', color: '#9a3412', padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
            💸 Faltante histórico: {fmtCop(m.dinero.faltanteHistorico)}
          </div>
        )}
        {m.prestamos.pendientes30 > 0 && (
          <div style={{ gridColumn: '1 / -1', background: '#fef3c7', color: '#78350f', padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
            🔁 {m.prestamos.pendientes30} préstamos pendientes hace +30 días
          </div>
        )}
      </div>
    </div>
  );
};

const CardMensajeroDetalle = ({ m }) => (
  <div style={s.card}>
    <h3 style={{ margin: '0 0 18px', fontSize: 20, color: '#1a1a2e' }}>🚚 {m.nombre}</h3>

    {/* KPIs grandes */}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
      <KPIGrande icon="📦" label="Asignadas" value={m.eficiencia.asignadas} />
      <KPIGrande icon="✅" label="Completadas" value={m.eficiencia.completadas} />
      <KPIGrande icon="📊" label="Tasa" value={fmtPct(m.eficiencia.tasaCompletitud)} color={m.eficiencia.tasaCompletitud >= 90 ? '#16a34a' : '#f59e0b'} />
      <KPIGrande icon="⏱" label="Tiempo promedio" value={fmtHoras(m.eficiencia.tiempoPromedioHoras)} />
    </div>

    {/* Tiempo por estado */}
    <h4 style={s.h4}>⏱ Tiempo promedio por estado</h4>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginBottom: 24 }}>
      {m.eficiencia.tiempoPorEstado.map(t => (
        <div key={t.estado} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{t.label}</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#7c3aed', marginTop: 4 }}>{fmtHoras(t.promedioHoras)}</div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{t.cantidad} transiciones</div>
        </div>
      ))}
    </div>

    {/* Calidad fotos */}
    <h4 style={s.h4}>📷 Calidad — Fotos</h4>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 24 }}>
      <KPIGrande icon="📸" label="% Foto recogida" value={fmtPct(m.fotos.pctRecogida)}
        color={m.fotos.pctRecogida >= 90 ? '#16a34a' : m.fotos.pctRecogida >= 70 ? '#f59e0b' : '#dc2626'} />
      <KPIGrande icon="📷" label="% Foto entrega" value={fmtPct(m.fotos.pctEntrega)}
        color={m.fotos.pctEntrega >= 90 ? '#16a34a' : m.fotos.pctEntrega >= 70 ? '#f59e0b' : '#dc2626'} />
      <KPIGrande icon="💳" label="% Comprobante virtual" value={fmtPct(m.fotos.pctComprobante)}
        color={m.fotos.pctComprobante >= 95 ? '#16a34a' : m.fotos.pctComprobante >= 80 ? '#f59e0b' : '#dc2626'} />
      <KPIGrande icon="❌" label="Sin foto entrega" value={m.fotos.sinFotoCantidad}
        color={m.fotos.sinFotoCantidad >= 3 ? '#dc2626' : '#374151'} />
    </div>
    {m.fotos.alertaSinFoto && (
      <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: 12, borderRadius: 8, fontSize: 13, fontWeight: 600, marginBottom: 24 }}>
        🚨 <strong>Posibles descargos:</strong> {m.nombre} tiene {m.fotos.sinFotoCantidad} órdenes sin foto de entrega.
        Esto puede ser causal de proceso formal por incumplimiento.
      </div>
    )}

    {/* Dinero */}
    <h4 style={s.h4}>💰 Disciplina financiera</h4>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
      <KPIGrande icon="💵" label="Recaudado" value={fmtCop(m.dinero.totalRecaudado)} color="#0284c7" />
      <KPIGrande icon="✅" label="Cuadrado" value={fmtCop(m.dinero.totalCuadrado)} color="#16a34a" />
      <KPIGrande icon="💸" label="Faltante histórico" value={fmtCop(m.dinero.faltanteHistorico)}
        color={m.dinero.faltanteHistorico > 0 ? '#dc2626' : '#374151'} />
      <KPIGrande icon="🟢" label="Sobrante histórico" value={fmtCop(m.dinero.sobranteHistorico)}
        color={m.dinero.sobranteHistorico > 0 ? '#f59e0b' : '#374151'} />
      <KPIGrande icon="⏰" label="Tiempo cobro→cuadre" value={fmtHoras(m.dinero.horasPromedioCuadre)} />
      <KPIGrande icon="🔔" label="Alertas abiertas" value={m.dinero.alertasAbiertas}
        color={m.dinero.alertasAbiertas > 0 ? '#dc2626' : '#374151'} />
    </div>

    {/* Préstamos */}
    <h4 style={s.h4}>🔁 Préstamos de extintores</h4>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
      <KPIGrande icon="📤" label="Entregados" value={m.prestamos.entregados} />
      <KPIGrande icon="📥" label="Recogidos" value={m.prestamos.recogidos} />
      <KPIGrande icon="⚠" label="Pendientes >30 días" value={m.prestamos.pendientes30}
        color={m.prestamos.pendientes30 > 0 ? '#dc2626' : '#374151'} />
    </div>
  </div>
);

// ────────────────────────────────────────────────────────────────────────────
// VISTA 2: COMERCIAL — Ranking + drill-down
// ────────────────────────────────────────────────────────────────────────────
const VistaComercial = ({ desde, hasta, empresaId, headers }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [comSel, setComSel] = useState('');

  const cargar = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ desde, hasta });
      if (empresaId) params.append('empresaId', empresaId);
      const r = await axios.get(`${API}/reportes/comercial?${params}`, { headers });
      setData(r.data);
    } catch (e) { setError(e.response?.data?.error || 'Error'); }
    setLoading(false);
    // eslint-disable-next-line
  }, [desde, hasta, empresaId]);
  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return <div style={s.cargando}>Cargando reporte comercial...</div>;
  if (error) return <div style={s.error}>⚠ {error}</div>;
  if (!data || data.comerciales.length === 0) return <div style={{ ...s.card, textAlign: 'center', color: '#9ca3af', padding: 40 }}>Sin comerciales con actividad</div>;

  const sel = comSel ? data.comerciales.find(c => c.id === comSel) : null;

  return (
    <div>
      {/* RANKING */}
      <div style={s.card}>
        <h3 style={{ margin: '0 0 14px', fontSize: 17, color: '#1a1a2e' }}>🏆 Ranking de Comerciales</h3>
        <table style={s.tablaR}>
          <thead>
            <tr>
              <th style={s.th}>#</th>
              <th style={s.th}>Comercial</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Cotizaciones</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Aprobadas</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Conversión</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Órdenes</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Facturado</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Ticket prom.</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {data.ranking.map((c, i) => {
              const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
              return (
                <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ ...s.td, fontWeight: 700, fontSize: 14 }}>{medal}</td>
                  <td style={s.td}><strong>{c.nombre}</strong></td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.cotizacionesCreadas}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.cotizacionesAprobadas}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, color: c.tasaConversion >= 50 ? '#16a34a' : '#f59e0b' }}>{fmtPct(c.tasaConversion)}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.ordenesCreadas}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtCop(c.totalFacturado)}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{fmtCop(c.ticketPromedio)}</td>
                  <td style={s.td}>
                    <button onClick={() => setComSel(c.id)} style={s.btnLink}>Ver detalle</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* DETALLE individual */}
      {sel && (
        <div style={{ ...s.card, marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 18 }}>💼 {sel.nombre} — detalle</h3>
            <button onClick={() => setComSel('')} style={s.btnSec}>✕ Cerrar</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
            <KPIGrande icon="📋" label="Cotizaciones" value={sel.cotizacionesCreadas} />
            <KPIGrande icon="✅" label="Aprobadas" value={sel.cotizacionesAprobadas} />
            <KPIGrande icon="📊" label="% Conversión" value={fmtPct(sel.tasaConversion)} color={sel.tasaConversion >= 50 ? '#16a34a' : '#f59e0b'} />
            <KPIGrande icon="📦" label="Órdenes" value={sel.ordenesCreadas} />
            <KPIGrande icon="💵" label="Facturado" value={fmtCop(sel.totalFacturado)} color="#16a34a" />
            <KPIGrande icon="🎯" label="Ticket promedio" value={fmtCop(sel.ticketPromedio)} />
            <KPIGrande icon="💚" label="% Pagadas" value={fmtPct(sel.pctPagadas)} color={sel.pctPagadas >= 80 ? '#16a34a' : '#f59e0b'} />
          </div>

          <h4 style={s.h4}>🏅 Top 5 clientes</h4>
          <table style={s.tablaR}>
            <thead>
              <tr>
                <th style={s.th}>Cliente</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Órdenes</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {sel.topClientes.map((c, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={s.td}>{c.nombre}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.ordenes}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtCop(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// VISTA 3: TALLER
// ────────────────────────────────────────────────────────────────────────────
const VistaTaller = ({ desde, hasta, empresaId, headers }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ desde, hasta });
      if (empresaId) params.append('empresaId', empresaId);
      const r = await axios.get(`${API}/reportes/taller?${params}`, { headers });
      setData(r.data);
    } catch (e) { setError(e.response?.data?.error || 'Error'); }
    setLoading(false);
    // eslint-disable-next-line
  }, [desde, hasta, empresaId]);
  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return <div style={s.cargando}>Cargando reporte de taller...</div>;
  if (error) return <div style={s.error}>⚠ {error}</div>;
  if (!data) return null;

  return (
    <div>
      {/* Volumen */}
      <div style={s.card}>
        <h3 style={{ margin: '0 0 14px', fontSize: 17 }}>📦 Volumen</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
          <KPIGrande icon="📋" label="Órdenes en taller" value={data.volumen.ordenesEnTaller} />
          <KPIGrande icon="🔧" label="Equipos procesados" value={data.volumen.equiposProcesados} color="#7c3aed" />
        </div>
        <h4 style={s.h4}>Por tipo de servicio</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <MiniKPI label="Recarga" value={data.volumen.porTipoServicio.recarga} color="#dc2626" />
          <MiniKPI label="Mantenimiento" value={data.volumen.porTipoServicio.mantenimiento} color="#f59e0b" />
          <MiniKPI label="Hidrostática" value={data.volumen.porTipoServicio.hidrostatica} color="#0284c7" />
          <MiniKPI label="Otros" value={data.volumen.porTipoServicio.otros} color="#6b7280" />
        </div>
      </div>

      {/* Eficiencia */}
      <div style={{ ...s.card, marginTop: 20 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 17 }}>⏱ Eficiencia</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <KPIGrande icon="⏰" label="Tiempo promedio en taller" value={fmtHoras(data.eficiencia.tiempoPromedioHoras)}
            color={data.eficiencia.tiempoPromedioDias >= 3 ? '#dc2626' : '#7c3aed'} />
          <KPIGrande icon="🚨" label="Atoradas >3 días" value={data.eficiencia.ordenesAtoradas}
            color={data.eficiencia.ordenesAtoradas > 0 ? '#dc2626' : '#16a34a'} />
        </div>
        {data.eficiencia.atoradosDetalle && data.eficiencia.atoradosDetalle.length > 0 && (
          <>
            <h4 style={s.h4}>🚨 Detalle de órdenes atoradas</h4>
            <table style={s.tablaR}>
              <thead><tr><th style={s.th}>Orden</th><th style={s.th}>Cliente</th><th style={s.th}>Tiempo</th></tr></thead>
              <tbody>
                {data.eficiencia.atoradosDetalle.map(a => (
                  <tr key={a.id} style={{ borderBottom: '1px solid #fee2e2', background: '#fef2f2' }}>
                    <td style={s.td}><code>{a.numeroOrden}</code></td>
                    <td style={s.td}>{a.clienteNombre}</td>
                    <td style={{ ...s.td, color: '#dc2626', fontWeight: 700 }}>{fmtHoras(a.horas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Costos del ERI */}
      <div style={{ ...s.card, marginTop: 20, background: 'linear-gradient(135deg, #fef3c715 0%, #fff 100%)', border: '2px solid #fbbf24' }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 17 }}>💰 Costos (conectado con ERI)</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <KPIGrande icon="📥" label="Total insumos taller" value={fmtCop(data.costos.totalCostoInsumos)} color="#dc2626" />
          <KPIGrande icon="📦" label="Costo promedio por equipo" value={fmtCop(data.costos.costoPromedioPorEquipo)} color="#7c3aed" />
          <KPIGrande icon="🧾" label="Egresos registrados" value={data.costos.cantidadInsumos} />
        </div>
        <div style={{ background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 8, padding: 12, marginTop: 14, fontSize: 13, color: '#78350f' }}>
          💡 <strong>Tip contable:</strong> El "costo promedio por equipo" es el indicador más valioso para fijar tu precio de venta.
          Si el costo es ${fmtCop(data.costos.costoPromedioPorEquipo).replace('$', '')}, tu precio debería estar al menos 3x este valor para tener margen sano.
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// VISTA 4: OPERACIÓN GENERAL
// ────────────────────────────────────────────────────────────────────────────
const VistaGeneral = ({ desde, hasta, empresaId, headers }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ desde, hasta });
      if (empresaId) params.append('empresaId', empresaId);
      const r = await axios.get(`${API}/reportes/general?${params}`, { headers });
      setData(r.data);
    } catch (e) { setError(e.response?.data?.error || 'Error'); }
    setLoading(false);
    // eslint-disable-next-line
  }, [desde, hasta, empresaId]);
  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return <div style={s.cargando}>Cargando operación general...</div>;
  if (error) return <div style={s.error}>⚠ {error}</div>;
  if (!data) return null;

  const maxEmbudo = Math.max(...data.embudo.map(e => e.cantidad), 1);

  return (
    <div>
      {/* Embudo */}
      <div style={s.card}>
        <h3 style={{ margin: '0 0 14px', fontSize: 17 }}>🎯 Embudo de Órdenes (estado actual)</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.embudo.map(e => (
            <div key={e.estado} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 180, fontSize: 13, fontWeight: 600 }}>{e.label}</div>
              <div style={{ flex: 1, height: 28, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
                <div style={{
                  height: '100%', width: `${(e.cantidad / maxEmbudo) * 100}%`,
                  background: 'linear-gradient(90deg, #7c3aed, #ec4899)',
                  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 10,
                  color: '#fff', fontWeight: 700, fontSize: 13
                }}>
                  {e.cantidad}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tiempos por estado */}
      <div style={{ ...s.card, marginTop: 20 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 17 }}>⏱ Tiempos por estado (¿dónde se atasca?)</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
          {data.tiemposEstado.map(t => (
            <div key={t.estado} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{t.label}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#7c3aed', marginTop: 4 }}>{fmtHoras(t.promedioHoras)}</div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{t.cantidad} transiciones</div>
            </div>
          ))}
        </div>
      </div>

      {/* Órdenes perdidas */}
      {data.perdidas && data.perdidas.length > 0 && (
        <div style={{ ...s.card, marginTop: 20 }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 17, color: '#dc2626' }}>⚠ Órdenes perdidas (>7 días sin movimiento)</h3>
          <table style={s.tablaR}>
            <thead><tr><th style={s.th}>Orden</th><th style={s.th}>Cliente</th><th style={s.th}>Estado</th><th style={s.th}>Días</th></tr></thead>
            <tbody>
              {data.perdidas.slice(0, 20).map(o => (
                <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={s.td}><code>{o.numeroOrden}</code></td>
                  <td style={s.td}>{o.clienteNombre}</td>
                  <td style={s.td}>{o.estado}</td>
                  <td style={{ ...s.td, color: '#dc2626', fontWeight: 700 }}>{o.dias} días</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* CxC en mora */}
      {data.cxcMora && data.cxcMora.length > 0 && (
        <div style={{ ...s.card, marginTop: 20 }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 17, color: '#dc2626' }}>💸 CxC en mora</h3>
          <table style={s.tablaR}>
            <thead><tr><th style={s.th}>Cliente</th><th style={s.th}>Orden</th><th style={{ ...s.th, textAlign: 'right' }}>Saldo</th><th style={s.th}>Días mora</th></tr></thead>
            <tbody>
              {data.cxcMora.slice(0, 15).map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={s.td}>{c.clienteNombre}</td>
                  <td style={s.td}><code>{c.numeroOrden}</code></td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{fmtCop(c.saldoPendiente || c.monto)}</td>
                  <td style={{ ...s.td, fontWeight: 700, color: '#dc2626' }}>{c.diasMora}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Top clientes */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, marginTop: 20 }}>
        <div style={s.card}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>🏆 Top clientes por ingreso</h3>
          <table style={s.tablaR}>
            <thead><tr><th style={s.th}>#</th><th style={s.th}>Cliente</th><th style={{ ...s.th, textAlign: 'right' }}>Total</th></tr></thead>
            <tbody>
              {data.topPorIngreso.map((c, i) => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ ...s.td, fontWeight: 700 }}>#{i + 1}</td>
                  <td style={s.td}>{c.nombre}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtCop(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={s.card}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>📦 Top clientes por cantidad</h3>
          <table style={s.tablaR}>
            <thead><tr><th style={s.th}>#</th><th style={s.th}>Cliente</th><th style={{ ...s.th, textAlign: 'right' }}>Órdenes</th></tr></thead>
            <tbody>
              {data.topPorCantidad.map((c, i) => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ ...s.td, fontWeight: 700 }}>#{i + 1}</td>
                  <td style={s.td}>{c.nombre}</td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 700 }}>{c.ordenes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Clientes fugados */}
      {data.fugados && data.fugados.length > 0 && (
        <div style={{ ...s.card, marginTop: 20, background: '#fff7ed', border: '2px solid #fb923c' }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 17, color: '#9a3412' }}>🚨 Clientes fugados (>13 meses sin comprar)</h3>
          <div style={{ background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 8, padding: 10, marginBottom: 14, fontSize: 12, color: '#78350f' }}>
            💡 Tu ciclo es anual. Estos clientes ya pasaron su próxima recarga sin que les vendieras. <strong>Acción:</strong> contáctalos para recuperarlos.
          </div>
          <table style={s.tablaR}>
            <thead><tr><th style={s.th}>Cliente</th><th style={s.th}>Celular</th><th style={s.th}>Última compra</th><th style={s.th}>Meses</th></tr></thead>
            <tbody>
              {data.fugados.slice(0, 30).map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid #fde68a' }}>
                  <td style={s.td}>{c.nombre}</td>
                  <td style={s.td}>{c.celular || '—'}</td>
                  <td style={s.td}>{fmtFecha(c.ultimaCompraFecha)}</td>
                  <td style={{ ...s.td, fontWeight: 700, color: '#9a3412' }}>{c.meses} meses</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Anuladas */}
      {data.anuladas && data.anuladas.length > 0 && (
        <div style={{ ...s.card, marginTop: 20 }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 16, color: '#6b7280' }}>❌ Órdenes anuladas en el período</h3>
          <table style={s.tablaR}>
            <thead><tr><th style={s.th}>Orden</th><th style={s.th}>Cliente</th><th style={s.th}>Motivo</th><th style={s.th}>Fecha</th></tr></thead>
            <tbody>
              {data.anuladas.slice(0, 15).map(o => (
                <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={s.td}><code>{o.numeroOrden}</code></td>
                  <td style={s.td}>{o.clienteNombre}</td>
                  <td style={{ ...s.td, fontStyle: 'italic', color: '#6b7280' }}>{o.motivoAnulacion}</td>
                  <td style={s.td}>{fmtFecha(o.fecha)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTES GENÉRICOS
// ────────────────────────────────────────────────────────────────────────────
const KPIGrande = ({ icon, label, value, color = '#1a1a2e' }) => (
  <div style={{ background: '#fff', border: '2px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{icon} {label}</div>
    <div style={{ fontSize: 18, fontWeight: 800, color, marginTop: 6 }}>{value}</div>
  </div>
);

const MiniKPI = ({ label, value, color = '#1a1a2e' }) => (
  <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
    <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
  </div>
);

// ────────────────────────────────────────────────────────────────────────────
// ESTILOS
// ────────────────────────────────────────────────────────────────────────────
const s = {
  wrapper: { padding: '24px 32px', maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 },
  pageTitle: { margin: 0, fontSize: 26, fontWeight: 700, color: '#111' },
  pageSubtitle: { margin: '4px 0 0', color: '#6b7280', fontSize: 14 },

  filtros: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 14 },
  presets: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  preset: { padding: '6px 14px', borderRadius: 20, border: '1px solid #e5e7eb', cursor: 'pointer', background: '#fff', color: '#6b7280', fontSize: 12, fontWeight: 600 },
  presetActivo: { background: '#7c3aed', color: '#fff', border: '1px solid #7c3aed' },
  campoF: { display: 'flex', flexDirection: 'column', gap: 4 },
  labelF: { fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' },
  inputF: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 },

  tabs: { display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
  tab: { padding: '10px 18px', borderRadius: 10, border: '1px solid #e5e7eb', cursor: 'pointer', background: '#fff', color: '#6b7280', fontSize: 13, fontWeight: 600 },
  tabActivo: { background: '#1a1a2e', color: '#fff', border: '1px solid #1a1a2e' },

  chip: { padding: '6px 12px', borderRadius: 20, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#6b7280' },
  chipActivo: { background: '#7c3aed', color: '#fff', border: '1px solid #7c3aed' },

  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 18 },
  h4: { fontSize: 14, color: '#374151', margin: '16px 0 10px', fontWeight: 700 },

  tablaR: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', borderBottom: '2px solid #e5e7eb', background: '#f9fafb' },
  td: { padding: '8px 10px', color: '#374151' },

  btn: { padding: '9px 16px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 },
  btnSec: { padding: '6px 12px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  btnLink: { padding: '4px 10px', background: 'transparent', color: '#7c3aed', border: '1px solid #c4b5fd', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 },

  cargando: { textAlign: 'center', padding: 60, color: '#7c3aed', fontSize: 14 },
  error: { background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: 14, borderRadius: 10, fontSize: 13 }
};

export default ModuloReportes;
