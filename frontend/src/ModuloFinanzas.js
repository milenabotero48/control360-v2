// ═══════════════════════════════════════════════════════════════════════════════
// ModuloFinanzas.js — Centro financiero del negocio
// ─────────────────────────────────────────────────────────────────────────────
// FINANZAS-ANALISIS-001
//
// POR QUÉ DEJÓ DE LLAMARSE "ERI"
// ------------------------------
// El estado de resultados es UNA de las piezas, no el módulo. Acá conviven el
// ERI, el flujo de efectivo, los indicadores y los anexos: todo lo que hace
// falta para responder no solo "cuánto gané" sino "dónde está la plata" y
// "esto está bien o mal".
//
// LO PRIMERO QUE SE VE
// --------------------
// El diagnóstico, no las tablas. Un informe que hay que interpretar solo sirve
// para quien sabe interpretarlo. Acá los hallazgos salen arriba, con la acción
// concreta al lado — el resto del módulo es el soporte de esos hallazgos.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import ModuloERI from './ModuloERI';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

const fmt = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(Math.round(Number(n) || 0));

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const LUZ = {
  bien:     { color: '#16a34a', bg: '#f0fdf4', bd: '#bbf7d0', icono: '🟢' },
  atencion: { color: '#d97706', bg: '#fffbeb', bd: '#fde68a', icono: '🟡' },
  critico:  { color: '#dc2626', bg: '#fef2f2', bd: '#fecaca', icono: '🔴' },
  neutro:   { color: '#64748b', bg: '#f8fafc', bd: '#e2e8f0', icono: '⚪' },
};

const SEVERIDAD = {
  critico: { color: '#dc2626', bg: '#fef2f2', bd: '#fecaca', et: 'Crítico',  icono: '🔴' },
  alto:    { color: '#ea580c', bg: '#fff7ed', bd: '#fed7aa', et: 'Alto',     icono: '🟠' },
  medio:   { color: '#d97706', bg: '#fffbeb', bd: '#fde68a', et: 'Medio',    icono: '🟡' },
  info:    { color: '#0284c7', bg: '#f0f9ff', bd: '#bae6fd', et: 'Informativo', icono: '🔵' },
};

// ═════════════════════════════════════════════════════════════════════════════
// Tarjeta de indicador
// ═════════════════════════════════════════════════════════════════════════════
function Indicador({ ind }) {
  const [abierto, setAbierto] = useState(false);
  const l = LUZ[ind.estado] || LUZ.neutro;

  return (
    <div
      onClick={() => setAbierto(a => !a)}
      style={{
        background: '#fff', borderRadius: 13, padding: '15px 17px', cursor: 'pointer',
        border: `1px solid ${abierto ? l.bd : '#f1f5f9'}`,
        borderLeft: `4px solid ${l.color}`,
        boxShadow: '0 1px 3px rgba(15,23,42,0.06)',
        gridColumn: ind.destacado ? 'span 2' : 'span 1'
      }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: '#64748b', fontWeight: 700, marginBottom: 4 }}>
            {ind.nombre}
            {ind.aproximado && (
              <span title="Calculado con los datos disponibles; será exacto cuando se carguen los saldos iniciales"
                style={{ color: '#cbd5e1', marginLeft: 5, cursor: 'help' }}>≈</span>
            )}
          </div>
          <div style={{ fontSize: ind.destacado ? 26 : 21, fontWeight: 900, color: l.color, lineHeight: 1.1 }}>
            {ind.display}
          </div>
          <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 4 }}>{ind.referencia}</div>
        </div>
        <span style={{ fontSize: 15 }}>{l.icono}</span>
      </div>

      {abierto && (
        <div style={{ marginTop: 12, paddingTop: 11, borderTop: '1px dashed #e2e8f0' }}>
          <div style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.65 }}>{ind.significa}</div>
          <div style={{
            fontSize: 10.5, color: '#94a3b8', marginTop: 8, fontFamily: 'monospace',
            background: '#f8fafc', padding: '6px 9px', borderRadius: 6
          }}>{ind.formula}</div>
        </div>
      )}
      {!abierto && (
        <div style={{ fontSize: 10, color: '#cbd5e1', marginTop: 7 }}>Clic para ver qué significa</div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Hallazgo del diagnóstico
// ═════════════════════════════════════════════════════════════════════════════
function Hallazgo({ h, onNavegar }) {
  const [abierto, setAbierto] = useState(h.severidad === 'critico');
  const s = SEVERIDAD[h.severidad] || SEVERIDAD.info;

  return (
    <div style={{
      background: '#fff', borderRadius: 14, border: '1px solid #f1f5f9',
      borderLeft: `4px solid ${s.color}`, overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(15,23,42,0.06)'
    }}>
      <div onClick={() => setAbierto(a => !a)}
        style={{ padding: '15px 18px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 9.5, fontWeight: 800, color: s.color, textTransform: 'uppercase',
            letterSpacing: '.06em', marginBottom: 5
          }}>{s.icono} {s.et}</div>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: '#0f172a', lineHeight: 1.35 }}>
            {h.titulo}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {h.valor !== null && h.valor !== undefined && (
            <div style={{ fontSize: 15, fontWeight: 900, color: s.color }}>{fmt(Math.abs(h.valor))}</div>
          )}
          <div style={{ fontSize: 16, color: '#cbd5e1', marginTop: 2 }}>{abierto ? '−' : '+'}</div>
        </div>
      </div>

      {abierto && (
        <div style={{ padding: '0 18px 16px' }}>
          <div style={{ background: s.bg, border: `1px solid ${s.bd}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ fontSize: 9.5, fontWeight: 800, color: s.color, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>
              Qué está pasando
            </div>
            <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.65 }}>{h.que}</div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 9.5, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>
              Por qué importa
            </div>
            <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.65 }}>{h.porque}</div>
          </div>

          <div>
            <div style={{ fontSize: 9.5, fontWeight: 800, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
              Qué podés hacer
            </div>
            {(h.hacer || []).map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 7 }}>
                <span style={{
                  flexShrink: 0, width: 18, height: 18, borderRadius: 20, background: '#f0fdf4',
                  color: '#16a34a', fontSize: 10, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1
                }}>{i + 1}</span>
                <span style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.6 }}>{a}</span>
              </div>
            ))}
          </div>

          {h.modulo && onNavegar && (
            <button onClick={() => onNavegar(h.modulo)}
              style={{
                marginTop: 12, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 700, color: '#fff',
                background: `linear-gradient(135deg, ${s.color}, ${s.color}dd)`
              }}>
              Ir a revisarlo →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Estado de flujo de efectivo
// ═════════════════════════════════════════════════════════════════════════════
function FlujoEfectivo({ datos }) {
  if (!datos) return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>⏳ Calculando...</div>;

  const { operacion, inversion, financiacion, resumen, conciliacion } = datos;
  const positivo = resumen.flujoOperacion >= 0;

  const Bloque = ({ titulo, subtitulo, entradas, salidas, flujo, nota, color }) => (
    <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #f1f5f9', padding: '18px 22px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
        <span style={{ width: 4, height: 17, background: color, borderRadius: 4 }} />
        <span style={{ fontSize: 14, fontWeight: 800, color: '#0f172a' }}>{titulo}</span>
      </div>
      <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 14, marginLeft: 13 }}>{subtitulo}</div>

      {(entradas || []).map((x, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', color: '#166534' }}>
          <span>(+) {x.concepto}</span><strong>{fmt(x.valor)}</strong>
        </div>
      ))}
      {(salidas || []).map((x, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', color: '#991b1b' }}>
          <span>(−) {x.concepto}</span><strong>{fmt(-Math.abs(x.valor))}</strong>
        </div>
      ))}

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderTop: '2px solid #f1f5f9', marginTop: 10, paddingTop: 11,
        fontSize: 14.5, fontWeight: 900,
        color: flujo >= 0 ? '#15803d' : '#b91c1c'
      }}>
        <span>= Flujo de {titulo.toLowerCase()}</span><span>{fmt(flujo)}</span>
      </div>

      {nota && (
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 10, lineHeight: 1.6, background: '#f8fafc', borderRadius: 8, padding: '9px 12px' }}>
          {nota}
        </div>
      )}
    </div>
  );

  return (
    <div>
      {/* Lectura de fondo */}
      <div style={{
        background: positivo ? 'linear-gradient(135deg,#059669,#047857)' : 'linear-gradient(135deg,#dc2626,#991b1b)',
        borderRadius: 16, padding: '20px 24px', color: '#fff', marginBottom: 18
      }}>
        <div style={{ fontSize: 10.5, opacity: .85, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>
          Flujo de la operación
        </div>
        <div style={{ fontSize: 30, fontWeight: 900, margin: '3px 0 8px' }}>{fmt(resumen.flujoOperacion)}</div>
        <div style={{ fontSize: 13, opacity: .95, lineHeight: 1.6, maxWidth: 640 }}>
          {resumen.interpretacion}
        </div>
      </div>

      <Bloque titulo="Operación" color="#059669"
        subtitulo="Lo que el negocio genera o consume por operar. Es la actividad que debería sostener la empresa."
        entradas={operacion.entradas} salidas={operacion.salidas} flujo={operacion.flujo} />

      <Bloque titulo="Inversión" color="#0284c7"
        subtitulo="Compra o venta de activos: equipos, vehículos, herramientas."
        salidas={inversion.salidas} flujo={inversion.flujo} nota={inversion.nota} />

      <Bloque titulo="Financiación" color="#7c3aed"
        subtitulo="Préstamos, aportes de socios y retiros."
        salidas={financiacion.salidas} flujo={financiacion.flujo} nota={financiacion.nota} />

      {/* Resumen */}
      <div style={{ background: '#0f172a', borderRadius: 14, padding: '18px 22px', color: '#fff', marginBottom: 18 }}>
        {[
          ['Flujo de operación', resumen.flujoOperacion],
          ['Flujo de inversión', resumen.flujoInversion],
          ['Flujo de financiación', resumen.flujoFinanciacion],
        ].map(([l, v]) => (
          <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '5px 0', color: '#cbd5e1' }}>
            <span>{l}</span><span>{fmt(v)}</span>
          </div>
        ))}
        <div style={{
          display: 'flex', justifyContent: 'space-between', fontSize: 17, fontWeight: 900,
          borderTop: '1px solid #334155', marginTop: 9, paddingTop: 11,
          color: resumen.flujoNeto >= 0 ? '#6ee7b7' : '#fca5a5'
        }}>
          <span>= Variación neta de efectivo</span><span>{fmt(resumen.flujoNeto)}</span>
        </div>
        <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 11, display: 'flex', justifyContent: 'space-between' }}>
          <span>Saldo en cajas hoy</span><strong style={{ color: '#e2e8f0' }}>{fmt(resumen.saldoCajasHoy)}</strong>
        </div>
      </div>

      {/* Conciliación — la parte que explica todo */}
      {(conciliacion?.detalle || []).length > 0 && (
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #f1f5f9', padding: '18px 22px' }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', marginBottom: 5 }}>
            ¿Por qué la utilidad no coincide con la plata?
          </div>
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 15, lineHeight: 1.6 }}>
            {conciliacion.nota}
          </div>
          {conciliacion.detalle.map((c, i) => (
            <div key={i} style={{
              background: '#f8fafc', borderRadius: 10, padding: '12px 15px', marginBottom: 9,
              borderLeft: `3px solid ${c.valor >= 0 ? '#16a34a' : '#dc2626'}`
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>{c.concepto}</span>
                <strong style={{ fontSize: 14, color: c.valor >= 0 ? '#15803d' : '#b91c1c', whiteSpace: 'nowrap' }}>
                  {fmt(c.valor)}
                </strong>
              </div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 5, lineHeight: 1.6 }}>{c.explica}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MÓDULO PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
export default function ModuloFinanzas({ user, onNavegar }) {
  const hoy = new Date();
  const [tab, setTab] = useState('resumen');
  const [rango, setRango] = useState(() => {
    const ini = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    const iso = d => d.toLocaleDateString('en-CA');
    return { desde: iso(ini), hasta: iso(fin) };
  });

  const [eri, setEri] = useState(null);
  const [analisis, setAnalisis] = useState(null);
  const [flujo, setFlujo] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    setCargando(true); setError('');
    try {
      // 1. El ERI es la fuente de las cifras
      const eriRes = await axios.get(
        `${API}/eri?desde=${rango.desde}&hasta=${rango.hasta}&vista=completa`,
        { headers: headers() });
      setEri(eriRes.data);

      // 2. Período anterior, para detectar deterioros
      const d = new Date(rango.desde + 'T00:00:00');
      const iniAnt = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const finAnt = new Date(d.getFullYear(), d.getMonth(), 0);
      const iso = x => x.toLocaleDateString('en-CA');
      let periodoAnterior = null;
      try {
        const antRes = await axios.get(
          `${API}/eri?desde=${iso(iniAnt)}&hasta=${iso(finAnt)}&vista=completa`,
          { headers: headers() });
        const a = antRes.data;
        periodoAnterior = {
          ingresos: a.ingresos?.total ?? a.totalIngresos ?? 0,
          utilidadBruta: a.utilidad?.bruta ?? a.utilidadBrutaTotal ?? 0
        };
      } catch { }

      // 3. Análisis y flujo, en paralelo
      const [anaRes, flujoRes] = await Promise.all([
        axios.post(`${API}/finanzas/analisis`,
          { eri: eriRes.data, desde: rango.desde, hasta: rango.hasta, periodoAnterior },
          { headers: headers() }),
        axios.get(`${API}/finanzas/flujo-efectivo?desde=${rango.desde}&hasta=${rango.hasta}`,
          { headers: headers() }).catch(() => ({ data: null })),
      ]);
      setAnalisis(anaRes.data);
      setFlujo(flujoRes.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'No se pudo cargar la información');
    }
    setCargando(false);
  }, [rango.desde, rango.hasta]);

  useEffect(() => { cargar(); }, [cargar]);

  const etiquetaPeriodo = useMemo(() => {
    const d = new Date(rango.desde + 'T00:00:00');
    const h = new Date(rango.hasta + 'T00:00:00');
    if (d.getMonth() === h.getMonth() && d.getFullYear() === h.getFullYear()) {
      return `${MESES[d.getMonth()]} ${d.getFullYear()}`;
    }
    return `${rango.desde} al ${rango.hasta}`;
  }, [rango]);

  const porGrupo = useMemo(() => {
    const m = {};
    for (const i of (analisis?.indicadores || [])) {
      if (!m[i.grupo]) m[i.grupo] = [];
      m[i.grupo].push(i);
    }
    return m;
  }, [analisis]);

  const diag = analisis?.diagnostico;

  const TABS = [
    { k: 'resumen',  l: '🎯 Diagnóstico', c: '#dc2626' },
    { k: 'eri',      l: '📊 Estado de Resultados', c: '#4f46e5' },
    { k: 'flujo',    l: '💵 Flujo de Efectivo', c: '#059669' },
    { k: 'indicadores', l: '📈 Indicadores', c: '#7c3aed' },
  ];

  const mesAtras = (n) => {
    const ini = new Date(hoy.getFullYear(), hoy.getMonth() - n, 1);
    const fin = new Date(hoy.getFullYear(), hoy.getMonth() - n + 1, 0);
    const iso = d => d.toLocaleDateString('en-CA');
    setRango({ desde: iso(ini), hasta: iso(fin) });
  };

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1500, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: '#1e293b' }}>📈 Finanzas</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Estado de resultados · Flujo de efectivo · Indicadores · Anexos
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" style={est.input} value={rango.desde} onChange={e => setRango(r => ({ ...r, desde: e.target.value }))} />
          <span style={{ color: '#cbd5e1' }}>→</span>
          <input type="date" style={est.input} value={rango.hasta} onChange={e => setRango(r => ({ ...r, hasta: e.target.value }))} />
          <button onClick={() => mesAtras(0)} style={est.btnSec}>Este mes</button>
          <button onClick={() => mesAtras(1)} style={est.btnSec}>Mes pasado</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e5e7eb', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            padding: '10px 20px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 13.5, fontWeight: 600, color: tab === t.k ? t.c : '#6b7280',
            borderBottom: tab === t.k ? `2px solid ${t.c}` : '2px solid transparent',
            marginBottom: -2, display: 'flex', alignItems: 'center', gap: 6
          }}>
            {t.l}
            {t.k === 'resumen' && diag?.criticos > 0 && (
              <span style={{ background: '#dc2626', color: '#fff', borderRadius: 20, padding: '1px 7px', fontSize: 10.5, fontWeight: 800 }}>
                {diag.criticos}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 11, padding: '14px 18px', fontSize: 13, color: '#991b1b', marginBottom: 16 }}>
          ✖ {error}
        </div>
      )}

      {cargando ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
          ⏳ Calculando el período de {etiquetaPeriodo}...
        </div>
      ) : (
        <>
          {/* ─── DIAGNÓSTICO ───────────────────────────────────────────────── */}
          {tab === 'resumen' && (
            <div>
              {/* Cifras del período */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 13, marginBottom: 20 }}>
                {[
                  { l: 'Ingresos', v: analisis?.base?.ingresos, c: '#0284c7' },
                  { l: 'Utilidad bruta', v: analisis?.base?.utilidadBruta, c: '#059669' },
                  { l: 'Utilidad operativa', v: analisis?.base?.utilidadOperativa, c: '#7c3aed' },
                  { l: 'Utilidad neta', v: analisis?.base?.utilidadNeta, c: '#dc2626' },
                ].map(k => (
                  <div key={k.l} style={{
                    background: '#fff', borderRadius: 13, padding: '15px 18px',
                    borderLeft: `4px solid ${(k.v ?? 0) >= 0 ? k.c : '#dc2626'}`,
                    boxShadow: '0 1px 3px rgba(15,23,42,0.06)'
                  }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, marginBottom: 5 }}>{k.l}</div>
                    <div style={{ fontSize: 20, fontWeight: 900, color: (k.v ?? 0) >= 0 ? k.c : '#dc2626' }}>
                      {fmt(k.v)}
                    </div>
                    {analisis?.base?.ingresos > 0 && (
                      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                        {((k.v ?? 0) / analisis.base.ingresos * 100).toFixed(1)}% de los ingresos
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Resumen del diagnóstico */}
              {diag && (
                <div style={{
                  background: diag.criticos > 0 ? '#fef2f2' : diag.altos > 0 ? '#fffbeb' : '#f0fdf4',
                  border: `1px solid ${diag.criticos > 0 ? '#fecaca' : diag.altos > 0 ? '#fde68a' : '#bbf7d0'}`,
                  borderRadius: 14, padding: '16px 20px', marginBottom: 18
                }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', marginBottom: 5 }}>
                    {diag.criticos > 0
                      ? `${diag.criticos} asunto${diag.criticos > 1 ? 's' : ''} que requiere${diag.criticos > 1 ? 'n' : ''} atención inmediata`
                      : diag.altos > 0
                        ? `${diag.altos} señal${diag.altos > 1 ? 'es' : ''} de alerta en ${etiquetaPeriodo}`
                        : `Los indicadores de ${etiquetaPeriodo} están en orden`}
                  </div>
                  <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.6 }}>
                    Este análisis lee tus propias cifras y señala qué revisar. Hacé clic en cada punto
                    para ver el detalle y las acciones concretas.
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {(diag?.hallazgos || []).map(h => (
                  <Hallazgo key={h.id} h={h} onNavegar={onNavegar} />
                ))}
              </div>
            </div>
          )}

          {/* ─── ESTADO DE RESULTADOS ──────────────────────────────────────── */}
          {tab === 'eri' && (
            <div style={{ margin: '-24px -32px' }}>
              <ModuloERI user={user} />
            </div>
          )}

          {/* ─── FLUJO DE EFECTIVO ─────────────────────────────────────────── */}
          {tab === 'flujo' && <FlujoEfectivo datos={flujo} />}

          {/* ─── INDICADORES ───────────────────────────────────────────────── */}
          {tab === 'indicadores' && (
            <div>
              {Object.entries(porGrupo).map(([grupo, lista]) => (
                <div key={grupo} style={{ marginBottom: 24 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase',
                    letterSpacing: '.06em', marginBottom: 11
                  }}>{grupo}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', gap: 13 }}>
                    {lista.map(i => <Indicador key={i.id} ind={i} />)}
                  </div>
                </div>
              ))}

              {(analisis?.pendientes || []).length > 0 && (
                <div style={{
                  background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 14,
                  padding: '16px 20px', marginTop: 8
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: '#475569', marginBottom: 9 }}>
                    Indicadores que todavía no se pueden calcular
                  </div>
                  {analisis.pendientes.map(p => (
                    <div key={p.id} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>{p.nombre}</div>
                      <div style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.55, marginTop: 2 }}>
                        {p.motivo} <span style={{ color: '#94a3b8' }}>— {p.comoHabilitarlo}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const est = {
  input: { padding: '8px 11px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 12.5, outline: 'none', color: '#1e293b', background: '#fff' },
  btnSec: { padding: '8px 14px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
};
