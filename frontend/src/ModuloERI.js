// ════════════════════════════════════════════════════════════════════════════════
// ModuloERI.js — Estado de Resultados Integral (Ola 3 — Frontend)
// ─────────────────────────────────────────────────────────────────────────────
// Vista profesional contable con 4 KPIs principales arriba, el P&G tradicional
// abajo y desglose por línea de servicio. Filtros: rango fechas (presets +
// personalizado) + selector de empresa (consolidado o individual).
// ════════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { exportarExcel } from './exportExcel';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const fmtCop = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const fmtPct = (n) => `${(n || 0).toFixed(1)}%`;
const fmtFecha = (raw) => {
  if (!raw) return '—';
  try { return new Date(raw).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }); }
  catch { return '—'; }
};

// Helpers de fecha
const hoy = () => new Date().toISOString().slice(0, 10);
const inicioMes = (offset = 0) => {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
};
const finMes = (offset = 0) => {
  const d = new Date();
  d.setMonth(d.getMonth() + offset + 1);
  d.setDate(0);
  return d.toISOString().slice(0, 10);
};
const inicioAnio = () => `${new Date().getFullYear()}-01-01`;
const finAnio = () => `${new Date().getFullYear()}-12-31`;

const ModuloERI = ({ user }) => {
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(finMes());
  const [empresaId, setEmpresaId] = useState('');
  const [empresas, setEmpresas] = useState([]);
  const [eri, setEri] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [vista, setVista] = useState('resumen'); // resumen | lineas | detalle
  const [presetActivo, setPresetActivo] = useState('mes_actual');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // ── Cargar empresas ──────────────────────────────────────────────────────
  useEffect(() => {
    axios.get(`${API}/companies`, { headers })
      .then(r => setEmpresas(Array.isArray(r.data) ? r.data : []))
      .catch(() => setEmpresas([]));
    // eslint-disable-next-line
  }, []);

  // ── Cargar ERI ───────────────────────────────────────────────────────────
  const cargarERI = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ desde, hasta });
      if (empresaId) params.append('empresaId', empresaId);
      params.append('vista', 'completa');
      const r = await axios.get(`${API}/eri?${params.toString()}`, { headers });
      setEri(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Error al cargar ERI');
    }
    setLoading(false);
    // eslint-disable-next-line
  }, [desde, hasta, empresaId]);

  useEffect(() => { cargarERI(); }, [cargarERI]);

  // ── Presets de fechas ────────────────────────────────────────────────────
  const aplicarPreset = (p) => {
    setPresetActivo(p);
    switch (p) {
      case 'mes_actual':    setDesde(inicioMes()); setHasta(hoy()); break;
      case 'mes_anterior':  setDesde(inicioMes(-1)); setHasta(finMes(-1)); break;
      case 'anio_actual':   setDesde(inicioAnio()); setHasta(hoy()); break;
      case 'anio_completo': setDesde(inicioAnio()); setHasta(finAnio()); break;
      case 'ultimos_7':     {
        const d = new Date(); d.setDate(d.getDate() - 6);
        setDesde(d.toISOString().slice(0, 10)); setHasta(hoy()); break;
      }
      case 'ultimos_30':    {
        const d = new Date(); d.setDate(d.getDate() - 29);
        setDesde(d.toISOString().slice(0, 10)); setHasta(hoy()); break;
      }
      case 'trimestre':     {
        const d = new Date(); d.setMonth(d.getMonth() - 2); d.setDate(1);
        setDesde(d.toISOString().slice(0, 10)); setHasta(hoy()); break;
      }
      default: break;
    }
  };

  // ── Exportar a Excel ─────────────────────────────────────────────────────
  const exportarERI = () => {
    if (!eri) return;
    const filas = [];
    filas.push({ s: 'PERIODO', d: 'Desde', v: eri.meta.desde });
    filas.push({ s: 'PERIODO', d: 'Hasta', v: eri.meta.hasta });
    filas.push({ s: 'PERIODO', d: 'Empresa', v: eri.meta.empresaNombre });
    filas.push({ s: '', d: '', v: '' });

    filas.push({ s: 'INGRESOS', d: 'Ingresos por servicios', v: eri.ingresos.servicios });
    filas.push({ s: 'INGRESOS', d: 'Ingresos por productos', v: eri.ingresos.productos });
    filas.push({ s: 'INGRESOS', d: '─── TOTAL INGRESOS', v: eri.ingresos.total });
    filas.push({ s: '', d: '', v: '' });

    filas.push({ s: 'COSTOS', d: 'Costo de servicios (insumos)', v: eri.costoVentas.servicios });
    filas.push({ s: 'COSTOS', d: 'Costo de venta de productos', v: eri.costoVentas.productos });
    filas.push({ s: 'COSTOS', d: '─── TOTAL COSTOS', v: eri.costoVentas.total });
    filas.push({ s: '', d: '', v: '' });

    filas.push({ s: 'UTILIDAD', d: 'Utilidad bruta servicios', v: eri.utilidadBruta.servicios });
    filas.push({ s: 'UTILIDAD', d: 'Utilidad bruta productos', v: eri.utilidadBruta.productos });
    filas.push({ s: 'UTILIDAD', d: '─── UTILIDAD BRUTA TOTAL', v: eri.utilidadBruta.total });
    filas.push({ s: 'UTILIDAD', d: 'Margen bruto %', v: eri.utilidadBruta.margen.toFixed(2) });
    filas.push({ s: '', d: '', v: '' });

    eri.porLinea.forEach(l => {
      filas.push({ s: `LÍNEA: ${l.nombre}`, d: 'Ingreso', v: l.ingresoServicio });
      filas.push({ s: `LÍNEA: ${l.nombre}`, d: 'Costo', v: l.costoServicio });
      filas.push({ s: `LÍNEA: ${l.nombre}`, d: 'Utilidad bruta', v: l.utilidadBruta });
      filas.push({ s: `LÍNEA: ${l.nombre}`, d: 'Margen %', v: l.margenPct.toFixed(2) });
      filas.push({ s: '', d: '', v: '' });
    });

    filas.push({ s: 'GASTOS', d: 'Personal (nómina)', v: eri.gastos.personal });
    filas.push({ s: 'GASTOS', d: 'Operativos', v: eri.gastos.operativos });
    filas.push({ s: 'GASTOS', d: 'Fijos', v: eri.gastos.fijos });
    filas.push({ s: 'GASTOS', d: 'Administrativos', v: eri.gastos.administrativos });
    filas.push({ s: 'GASTOS', d: 'Financieros', v: eri.gastos.financieros });
    filas.push({ s: 'GASTOS', d: 'Fiscales', v: eri.gastos.fiscales });
    filas.push({ s: 'GASTOS', d: '─── TOTAL GASTOS', v: eri.gastos.total });
    filas.push({ s: '', d: '', v: '' });

    filas.push({ s: 'RESULTADO', d: 'Utilidad Operativa', v: eri.utilidadOperativa.valor });
    filas.push({ s: 'RESULTADO', d: 'Margen Operativo %', v: eri.utilidadOperativa.margen.toFixed(2) });
    filas.push({ s: 'RESULTADO', d: 'Utilidad antes de impuestos', v: eri.utilidadAntesImpuestos.valor });
    filas.push({ s: 'RESULTADO', d: '═══ UTILIDAD NETA', v: eri.utilidadNeta.valor });
    filas.push({ s: 'RESULTADO', d: 'Margen Neto %', v: eri.utilidadNeta.margen.toFixed(2) });

    exportarExcel(filas, [
      { label: 'Sección', key: 's' },
      { label: 'Concepto', key: 'd' },
      { label: 'Valor', key: 'v' }
    ], `ERI_${eri.meta.desde}_a_${eri.meta.hasta}`);
  };

  // ── Imprimir ─────────────────────────────────────────────────────────────
  const imprimirERI = () => {
    if (!eri) return;
    const html = construirHtmlImprimir(eri);
    const w = window.open('', '_blank');
    if (!w) { alert('Permite ventanas emergentes para imprimir.'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 300);
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={s.wrapper}>
      {/* HEADER */}
      <div style={s.pageHeader}>
        <div>
          <h2 style={s.pageTitle}>📊 ERI — Estado de Resultados Integral</h2>
          <p style={s.pageSubtitle}>P&G en tiempo real · {eri?.meta?.empresaNombre || 'Cargando...'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={imprimirERI} disabled={!eri} style={{ ...s.btn, background: '#0284c7', color: '#fff' }}>🖨 Imprimir</button>
          <button onClick={exportarERI} disabled={!eri} style={{ ...s.btn, background: '#16a34a', color: '#fff' }}>📊 Exportar Excel</button>
        </div>
      </div>

      {/* FILTROS */}
      <div style={s.filtros}>
        <div style={s.presets}>
          {[
            { v: 'mes_actual',    l: 'Mes actual' },
            { v: 'mes_anterior',  l: 'Mes anterior' },
            { v: 'trimestre',     l: 'Último trimestre' },
            { v: 'anio_actual',   l: 'Año (YTD)' },
            { v: 'anio_completo', l: 'Año completo' },
            { v: 'ultimos_7',     l: 'Últimos 7 días' },
            { v: 'ultimos_30',    l: 'Últimos 30 días' },
          ].map(p => (
            <button key={p.v} onClick={() => aplicarPreset(p.v)}
              style={{ ...s.preset, ...(presetActivo === p.v ? s.presetActivo : {}) }}>
              {p.l}
            </button>
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
              <option value="">Consolidado (todas)</option>
              {empresas.map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* MENSAJES */}
      {loading && <div style={s.cargando}>Calculando ERI...</div>}
      {error && <div style={s.error}>⚠ {error}</div>}

      {/* CONTENIDO */}
      {eri && !loading && (
        <>
          {/* KPIs principales */}
          <div style={s.kpisGrid}>
            <KPI icon="💵" label="Ingresos totales" value={fmtCop(eri.ingresos.total)} sub={`${eri.meta.cantidadOrdenes} órdenes`} color="#0284c7" />
            <KPI icon="💎" label="Utilidad bruta" value={fmtCop(eri.utilidadBruta.total)} sub={fmtPct(eri.utilidadBruta.margen)} color="#16a34a" />
            <KPI icon="⚙️" label="Utilidad operativa" value={fmtCop(eri.utilidadOperativa.valor)} sub={fmtPct(eri.utilidadOperativa.margen)} color={eri.utilidadOperativa.valor >= 0 ? '#7c3aed' : '#dc2626'} />
            <KPI icon="🏆" label="Utilidad NETA" value={fmtCop(eri.utilidadNeta.valor)} sub={fmtPct(eri.utilidadNeta.margen)} color={eri.utilidadNeta.valor >= 0 ? '#16a34a' : '#dc2626'} grande />
          </div>

          {/* TABS de vista */}
          <div style={s.tabs}>
            {[
              { v: 'resumen', l: '📑 ERI Resumen' },
              { v: 'lineas',  l: '🎯 Por línea de servicio' },
              { v: 'detalle', l: '📋 Detalle (órdenes/egresos)' },
            ].map(t => (
              <button key={t.v} onClick={() => setVista(t.v)}
                style={{ ...s.tab, ...(vista === t.v ? s.tabActivo : {}) }}>
                {t.l}
              </button>
            ))}
          </div>

          {/* VISTA RESUMEN — ERI contable tradicional */}
          {vista === 'resumen' && <VistaResumen eri={eri} />}

          {/* VISTA POR LÍNEA */}
          {vista === 'lineas' && <VistaLineas eri={eri} />}

          {/* VISTA DETALLE */}
          {vista === 'detalle' && <VistaDetalle eri={eri} />}
        </>
      )}
    </div>
  );
};

// ─── Sub-componentes ─────────────────────────────────────────────────────────

const KPI = ({ icon, label, value, sub, color, grande }) => (
  <div style={{
    ...s.kpi,
    border: `2px solid ${color}`,
    background: grande ? `linear-gradient(135deg, ${color}15 0%, #fff 100%)` : '#fff'
  }}>
    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
      {icon} {label}
    </div>
    <div style={{ fontSize: grande ? 24 : 20, fontWeight: 800, color, marginTop: 8 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{sub}</div>}
  </div>
);

const VistaResumen = ({ eri }) => (
  <div style={s.card}>
    <table style={s.tablaERI}>
      <tbody>
        <Fila label="INGRESOS POR SERVICIOS" tipo="seccion" />
        <Fila label="Servicios de mano de obra" valor={eri.ingresos.servicios} />

        <Fila label="INGRESOS POR PRODUCTOS" tipo="seccion" />
        <Fila label="Venta de productos" valor={eri.ingresos.productos} />

        <Fila label="TOTAL INGRESOS" valor={eri.ingresos.total} tipo="total" />

        <Fila label="(-) COSTO DE VENTAS" tipo="seccion" />
        <Fila label="Costo de insumos (servicios)" valor={-eri.costoVentas.servicios} />
        <Fila label="Costo de venta de productos" valor={-eri.costoVentas.productos} />

        <Fila label="UTILIDAD BRUTA" valor={eri.utilidadBruta.total} tipo="utilidad"
          margen={eri.utilidadBruta.margen} />

        <Fila label="(-) GASTOS OPERATIVOS" tipo="seccion" />
        {eri.gastos.personal > 0 &&         <Fila label="Personal (nómina)" valor={-eri.gastos.personal} />}
        {eri.gastos.operativos > 0 &&       <Fila label="Operativos" valor={-eri.gastos.operativos} />}
        {eri.gastos.fijos > 0 &&            <Fila label="Fijos (arriendo, servicios)" valor={-eri.gastos.fijos} />}
        {eri.gastos.administrativos > 0 &&  <Fila label="Administrativos" valor={-eri.gastos.administrativos} />}

        <Fila label="UTILIDAD OPERATIVA" valor={eri.utilidadOperativa.valor} tipo="utilidad"
          margen={eri.utilidadOperativa.margen} />

        {eri.gastos.financieros > 0 && (
          <>
            <Fila label="(-) GASTOS FINANCIEROS" tipo="seccion" />
            <Fila label="Comisiones bancarias / intereses" valor={-eri.gastos.financieros} />
            <Fila label="UTILIDAD ANTES DE IMPUESTOS" valor={eri.utilidadAntesImpuestos.valor} tipo="utilidad" />
          </>
        )}

        {eri.gastos.fiscales > 0 && (
          <>
            <Fila label="(-) IMPUESTOS" tipo="seccion" />
            <Fila label="Fiscales" valor={-eri.gastos.fiscales} />
          </>
        )}

        <Fila label="UTILIDAD NETA" valor={eri.utilidadNeta.valor} tipo="neta"
          margen={eri.utilidadNeta.margen} />
      </tbody>
    </table>

    {/* Desglose ingresos por empresa */}
    {eri.ingresos.porEmpresa && eri.ingresos.porEmpresa.length > 1 && (
      <div style={{ marginTop: 24 }}>
        <h4 style={{ fontSize: 14, color: '#374151', marginBottom: 12 }}>💼 Ingresos por empresa</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {eri.ingresos.porEmpresa.map(emp => (
            <div key={emp.empresaId} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{emp.empresaNombre}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#0284c7', marginTop: 4 }}>{fmtCop(emp.monto)}</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                {emp.cantidadOrdenes} órdenes · {fmtPct(emp.porcentaje)} del total
              </div>
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
);

const Fila = ({ label, valor, margen, tipo }) => {
  const colores = {
    seccion: { bg: '#f3f4f6', color: '#374151', weight: 700, size: 12 },
    total:   { bg: '#eff6ff', color: '#1e3a8a', weight: 800, size: 14 },
    utilidad:{ bg: '#f0fdf4', color: '#15803d', weight: 800, size: 14 },
    neta:    { bg: '#7c3aed', color: '#fff',    weight: 900, size: 16 }
  };
  const c = colores[tipo] || { bg: '#fff', color: '#111', weight: 400, size: 13 };
  return (
    <tr style={{ background: c.bg }}>
      <td style={{ padding: '8px 14px', color: c.color, fontWeight: c.weight, fontSize: c.size, borderBottom: '1px solid #e5e7eb' }}>
        {label}
        {margen !== undefined && (
          <span style={{ marginLeft: 12, fontSize: 11, color: c.color, opacity: 0.85, fontWeight: 600 }}>
            ({fmtPct(margen)})
          </span>
        )}
      </td>
      <td style={{ padding: '8px 14px', textAlign: 'right', color: valor < 0 ? '#dc2626' : c.color, fontWeight: c.weight, fontSize: c.size, borderBottom: '1px solid #e5e7eb', fontFamily: 'monospace' }}>
        {valor !== undefined ? fmtCop(Math.abs(valor)) : ''}
      </td>
    </tr>
  );
};

const VistaLineas = ({ eri }) => {
  const lineas = eri.porLinea || [];
  if (lineas.length === 0) {
    return <div style={{ ...s.card, textAlign: 'center', color: '#9ca3af', padding: 40 }}>
      Sin movimientos por línea en este período
    </div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
      {lineas.map(l => (
        <div key={l.id} style={{ ...s.card, padding: 0, overflow: 'hidden' }}>
          <div style={{ background: l.color, color: '#fff', padding: '14px 18px', fontWeight: 700 }}>
            🎯 {l.nombre}
          </div>
          <div style={{ padding: 18 }}>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Ingreso</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#0284c7' }}>{fmtCop(l.ingresoServicio)}</div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Costo directo</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#dc2626' }}>− {fmtCop(l.costoServicio)}</div>
            </div>
            <div style={{ paddingTop: 12, borderTop: '2px solid #e5e7eb' }}>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Utilidad bruta</div>
              <div style={{ fontSize: 24, fontWeight: 900, color: l.utilidadBruta >= 0 ? '#16a34a' : '#dc2626' }}>
                {fmtCop(l.utilidadBruta)}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                Margen: <strong style={{ color: l.margenPct >= 30 ? '#16a34a' : l.margenPct >= 0 ? '#f59e0b' : '#dc2626' }}>
                  {fmtPct(l.margenPct)}
                </strong>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const VistaDetalle = ({ eri }) => (
  <div>
    {/* Órdenes */}
    <div style={s.card}>
      <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>
        📦 Órdenes ({eri.detalleOrdenes?.length || 0})
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={s.tablaDetalle}>
          <thead>
            <tr>
              <th style={s.thd}>Orden</th>
              <th style={s.thd}>Fecha</th>
              <th style={s.thd}>Cliente</th>
              <th style={s.thd}>Empresa</th>
              <th style={s.thd}>Pago</th>
              <th style={{ ...s.thd, textAlign: 'right' }}>Servicios</th>
              <th style={{ ...s.thd, textAlign: 'right' }}>Productos</th>
              <th style={{ ...s.thd, textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {(eri.detalleOrdenes || []).map(o => (
              <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={s.tdd}><code style={{ fontSize: 11 }}>{o.numeroOrden}</code></td>
                <td style={s.tdd}>{fmtFecha(o.fecha)}</td>
                <td style={s.tdd}>{o.clienteNombre}</td>
                <td style={s.tdd}>{o.empresaNombre || '—'}</td>
                <td style={s.tdd}>{o.formaPago || '—'}</td>
                <td style={{ ...s.tdd, textAlign: 'right' }}>{fmtCop(o.ingresoServicios)}</td>
                <td style={{ ...s.tdd, textAlign: 'right' }}>{fmtCop(o.ingresoProductos)}</td>
                <td style={{ ...s.tdd, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtCop(o.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>

    {/* Egresos */}
    <div style={{ ...s.card, marginTop: 20 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>
        💸 Egresos ({eri.detalleEgresos?.length || 0})
      </h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={s.tablaDetalle}>
          <thead>
            <tr>
              <th style={s.thd}>Numero</th>
              <th style={s.thd}>Fecha</th>
              <th style={s.thd}>Concepto</th>
              <th style={s.thd}>Categoría</th>
              <th style={s.thd}>Tipo ERI</th>
              <th style={{ ...s.thd, textAlign: 'right' }}>Monto</th>
            </tr>
          </thead>
          <tbody>
            {(eri.detalleEgresos || []).map(e => (
              <tr key={e.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={s.tdd}><code style={{ fontSize: 11 }}>{e.numero}</code></td>
                <td style={s.tdd}>{fmtFecha(e.fecha)}</td>
                <td style={s.tdd}>{e.concepto}</td>
                <td style={s.tdd}>{e.categoria}</td>
                <td style={s.tdd}>{labelTipoERI(e.tipoERI)}</td>
                <td style={{ ...s.tdd, textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{fmtCop(e.monto)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);

const labelTipoERI = (t) => ({
  'costo_servicio':       '💰 Costo servicio',
  'gasto_personal':       '👥 Personal',
  'gasto_operativo':      '⚙️ Operativo',
  'gasto_fijo':           '🏠 Fijo',
  'gasto_administrativo': '📋 Administrativo',
  'gasto_financiero':     '🏦 Financiero',
  'gasto_fiscal':         '📑 Fiscal',
}[t] || t);

// ─── HTML para imprimir ──────────────────────────────────────────────────────
const construirHtmlImprimir = (eri) => `
<html>
<head>
  <title>ERI ${eri.meta.desde} a ${eri.meta.hasta}</title>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', sans-serif; padding: 24px; color: #111; }
    h1 { color: #7c3aed; margin-bottom: 4px; }
    .meta { color: #6b7280; font-size: 12px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td { padding: 7px 12px; border-bottom: 1px solid #e5e7eb; }
    td:last-child { text-align: right; font-family: monospace; }
    .seccion { background: #f3f4f6; font-weight: 700; color: #374151; font-size: 11px; text-transform: uppercase; }
    .total { background: #eff6ff; font-weight: 800; color: #1e3a8a; font-size: 14px; }
    .utilidad { background: #f0fdf4; font-weight: 800; color: #15803d; font-size: 14px; }
    .neta { background: #7c3aed; color: #fff; font-weight: 900; font-size: 16px; }
    .footer { margin-top: 32px; color: #9ca3af; font-size: 10px; text-align: center; }
  </style>
</head>
<body>
  <h1>📊 Estado de Resultados Integral</h1>
  <div class="meta">
    Período: ${eri.meta.desde} al ${eri.meta.hasta}<br>
    ${eri.meta.empresaNombre}<br>
    Calculado: ${new Date(eri.meta.calculadoEn).toLocaleString('es-CO')}
  </div>

  <table>
    <tr class="seccion"><td>INGRESOS POR SERVICIOS</td><td></td></tr>
    <tr><td>Servicios de mano de obra</td><td>${fmtCop(eri.ingresos.servicios)}</td></tr>
    <tr class="seccion"><td>INGRESOS POR PRODUCTOS</td><td></td></tr>
    <tr><td>Venta de productos</td><td>${fmtCop(eri.ingresos.productos)}</td></tr>
    <tr class="total"><td>TOTAL INGRESOS</td><td>${fmtCop(eri.ingresos.total)}</td></tr>

    <tr class="seccion"><td>(-) COSTO DE VENTAS</td><td></td></tr>
    <tr><td>Costo de insumos (servicios)</td><td>− ${fmtCop(eri.costoVentas.servicios)}</td></tr>
    <tr><td>Costo de venta de productos</td><td>− ${fmtCop(eri.costoVentas.productos)}</td></tr>
    <tr class="utilidad"><td>UTILIDAD BRUTA (${fmtPct(eri.utilidadBruta.margen)})</td><td>${fmtCop(eri.utilidadBruta.total)}</td></tr>

    <tr class="seccion"><td>(-) GASTOS OPERATIVOS</td><td></td></tr>
    ${eri.gastos.personal > 0       ? `<tr><td>Personal (nómina)</td><td>− ${fmtCop(eri.gastos.personal)}</td></tr>` : ''}
    ${eri.gastos.operativos > 0     ? `<tr><td>Operativos</td><td>− ${fmtCop(eri.gastos.operativos)}</td></tr>` : ''}
    ${eri.gastos.fijos > 0          ? `<tr><td>Fijos</td><td>− ${fmtCop(eri.gastos.fijos)}</td></tr>` : ''}
    ${eri.gastos.administrativos > 0? `<tr><td>Administrativos</td><td>− ${fmtCop(eri.gastos.administrativos)}</td></tr>` : ''}
    <tr class="utilidad"><td>UTILIDAD OPERATIVA (${fmtPct(eri.utilidadOperativa.margen)})</td><td>${fmtCop(eri.utilidadOperativa.valor)}</td></tr>

    ${eri.gastos.financieros > 0 ? `<tr><td>(-) Gastos financieros</td><td>− ${fmtCop(eri.gastos.financieros)}</td></tr>` : ''}
    ${eri.gastos.fiscales > 0 ? `<tr><td>(-) Impuestos</td><td>− ${fmtCop(eri.gastos.fiscales)}</td></tr>` : ''}

    <tr class="neta"><td>UTILIDAD NETA (${fmtPct(eri.utilidadNeta.margen)})</td><td>${fmtCop(eri.utilidadNeta.valor)}</td></tr>
  </table>

  <div class="footer">Generado por Control360 — ${new Date().toLocaleString('es-CO')}</div>
</body>
</html>
`;

// ─── ESTILOS ─────────────────────────────────────────────────────────────────
const s = {
  wrapper:    { padding: '24px 32px', maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 },
  pageTitle:  { margin: 0, fontSize: 26, fontWeight: 700, color: '#111' },
  pageSubtitle:{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 },
  btn:        { padding: '9px 16px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 },

  filtros: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 14 },
  presets: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  preset:  { padding: '6px 14px', borderRadius: 20, border: '1px solid #e5e7eb', cursor: 'pointer', background: '#fff', color: '#6b7280', fontSize: 12, fontWeight: 600 },
  presetActivo: { background: '#7c3aed', color: '#fff', border: '1px solid #7c3aed' },
  campoF:  { display: 'flex', flexDirection: 'column', gap: 4 },
  labelF:  { fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' },
  inputF:  { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 },

  kpisGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 20 },
  kpi:      { borderRadius: 12, padding: 18 },

  tabs:     { display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
  tab:      { padding: '10px 18px', borderRadius: 10, border: '1px solid #e5e7eb', cursor: 'pointer', background: '#fff', color: '#6b7280', fontSize: 13, fontWeight: 600 },
  tabActivo:{ background: '#1a1a2e', color: '#fff', border: '1px solid #1a1a2e' },

  card:     { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 },
  tablaERI: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },

  tablaDetalle: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  thd:      { padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', borderBottom: '2px solid #e5e7eb', background: '#f9fafb' },
  tdd:      { padding: '7px 10px', color: '#374151' },

  cargando: { textAlign: 'center', padding: 60, color: '#7c3aed', fontSize: 14 },
  error:    { background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: 14, borderRadius: 10, marginBottom: 16, fontSize: 13 }
};

export default ModuloERI;

