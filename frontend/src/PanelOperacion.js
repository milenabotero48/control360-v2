// ============================================================
// Control360 — Panel gerencial de operación (OPER-GERENCIAL-001)
// Ubicación: frontend/src/PanelOperacion.js
// ============================================================
// Resumen del mes para gerencia: cuántas órdenes se elaboran por
// día y cuántos clientes se atienden, en qué punto del flujo está
// cada orden (sin ejecutar, recogida, taller, por entregar, en ruta,
// cobro, cartera), cuánto tarda cada proceso (mediana, promedio,
// máximo), el ciclo completo y las órdenes más demoradas.
//
// Datos: GET /api/dashboards/operacion?mes=YYYY-MM (caché 5 min).
// Solo lectura. Sin librerías de gráficos: SVG propio, liviano y
// responsive. En móvil las filas se vuelven tarjetas.
// ============================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const COLOR = {
  sin_ejecutar: '#6366f1', recogida: '#f59e0b', taller: '#8b5cf6', por_entregar: '#0284c7',
  en_ruta: '#059669', cobro: '#ea580c', cartera: '#dc2626', completada: '#16a34a', anulada: '#9ca3af'
};
const ICONO = {
  sin_ejecutar: '🗓', recogida: '🚚', taller: '🔧', por_entregar: '📦', en_ruta: '🛵', cobro: '💵', cartera: '📒', completada: '✅', anulada: '⛔'
};

const fmtN = (n) => (Number(n) || 0).toLocaleString('es-CO');
const fmtCop = (n) => `$${fmtN(Math.round(Number(n) || 0))}`;
const fmtHoras = (h) => {
  const n = Number(h) || 0;
  if (n === 0) return '—';
  if (n < 1) return `${Math.round(n * 60)} min`;
  if (n < 48) return `${(n % 1 === 0 ? String(n) : n.toFixed(1)).replace('.', ',')} h`;
  return `${(n / 24).toFixed(1).replace('.', ',')} d`;
};
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const mesLabel = (mes) => {
  const [y, m] = mes.split('-').map(Number);
  return cap(new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('es-CO', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
};
const diaLabel = (f) => {
  const [y, m, d] = f.split('-').map(Number);
  return cap(new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }));
};
const mesActualCO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const moverMes = (mes, delta) => {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const useIsMobile = () => {
  const [mob, setMob] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMob(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mob;
};

export default function PanelOperacion() {
  const isMobile = useIsMobile();
  const [mes, setMes] = useState(mesActualCO);
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [verDias, setVerDias] = useState(false);
  const headers = useMemo(() => ({ Authorization: `Bearer ${localStorage.getItem('token')}` }), []);

  const cargar = useCallback(async (m) => {
    setCargando(true); setError('');
    try {
      const r = await axios.get(`${API}/dashboards/operacion`, { params: { mes: m }, headers });
      setData(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'No se pudo cargar la operación del mes');
    } finally { setCargando(false); }
  }, [headers]);

  useEffect(() => { cargar(mes); }, [mes, cargar]);

  const esActual = mes === mesActualCO();
  const t = data?.totales;
  const ant = data?.anterior;
  const delta = (a, b) => (b === 0 || b === undefined || b === null) ? null : Math.round(((a - b) / b) * 100);

  return (
    <div style={S.wrap}>
      {/* Encabezado */}
      <div style={S.header}>
        <div>
          <div style={S.titulo}>📈 Operación del mes</div>
          <div style={S.sub}>Órdenes elaboradas, clientes atendidos, estado del flujo y tiempos por proceso</div>
        </div>
        <div style={S.nav}>
          <button style={S.navBtn} onClick={() => setMes(moverMes(mes, -1))} aria-label="Mes anterior">‹</button>
          <span style={S.navMes}>{mesLabel(mes)}</span>
          <button style={{ ...S.navBtn, opacity: esActual ? 0.35 : 1 }} disabled={esActual} onClick={() => setMes(moverMes(mes, 1))} aria-label="Mes siguiente">›</button>
        </div>
      </div>

      {error && <div style={S.error}>⚠ {error}</div>}
      {cargando && !data && <div style={S.cargando}>Calculando la operación del mes…</div>}

      {data && t && (
        <div style={{ opacity: cargando ? 0.6 : 1, transition: 'opacity .2s' }}>
          {/* KPIs */}
          <div style={{ ...S.kpis, gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)' }}>
            <Kpi color="#6366f1" etiqueta="Órdenes elaboradas" valor={fmtN(t.ordenes)} pie={`${t.promedioDiario} por día · ${fmtCop(t.valorTotal)}`} delta={delta(t.ordenes, ant?.ordenes)} />
            <Kpi color="#0284c7" etiqueta="Clientes atendidos" valor={fmtN(t.clientes)} pie={`${t.diasConActividad} día(s) con actividad`} delta={delta(t.clientes, ant?.clientes)} />
            <Kpi color="#16a34a" etiqueta="Completadas" valor={fmtN(t.completadas)} pie={`${t.cumplimiento}% de cumplimiento`} delta={delta(t.completadas, ant?.completadas)} />
            <Kpi color="#f59e0b" etiqueta="En curso" valor={fmtN(t.enCurso)} pie={`${fmtN(t.anuladas)} anulada(s)`} />
            <Kpi color="#8b5cf6" etiqueta="Ciclo completo" valor={fmtHoras(t.cicloMedianaHoras)} pie={`mediana · promedio ${fmtHoras(t.cicloPromedioHoras)}`} delta={ant?.cicloMedianaHoras ? delta(t.cicloMedianaHoras, ant.cicloMedianaHoras) : null} invertir />
          </div>

          <div style={{ ...S.dosCol, gridTemplateColumns: isMobile ? '1fr' : '1.35fr 1fr' }}>
            {/* Órdenes por día */}
            <div style={S.card}>
              <div style={S.cardTitulo}>Órdenes por día <span style={S.cardSub}>creadas vs. completadas</span></div>
              <GraficoDias porDia={data.porDia} isMobile={isMobile} />
              <div style={S.leyenda}>
                <span><i style={{ ...S.dot, background: '#6366f1' }} /> Creadas</span>
                <span><i style={{ ...S.dot, background: '#16a34a' }} /> Completadas</span>
                <span><i style={{ ...S.dot, background: '#9ca3af' }} /> Anuladas</span>
              </div>
            </div>

            {/* Embudo */}
            <div style={S.card}>
              <div style={S.cardTitulo}>¿Dónde están las órdenes? <span style={S.cardSub}>estado actual</span></div>
              <Embudo embudo={data.embudo} total={t.ordenes} />
            </div>
          </div>

          <div style={{ ...S.dosCol, gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
            {/* Tiempos por proceso */}
            <div style={S.card}>
              <div style={S.cardTitulo}>Cuánto tarda cada proceso <span style={S.cardSub}>mediana · promedio · máximo</span></div>
              <Tiempos tiempos={data.tiempos} />
            </div>

            {/* Más demoradas */}
            <div style={S.card}>
              <div style={S.cardTitulo}>Órdenes más demoradas <span style={S.cardSub}>tiempo en su estado actual</span></div>
              {!data.demoradas.length ? (
                <div style={S.vacio}>🎉 Ninguna orden del mes está detenida.</div>
              ) : data.demoradas.map(d => (
                <div key={d.id} style={S.filaDem}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800, color: '#111827' }}>{d.numeroOrden} <span style={{ fontWeight: 500, color: '#6b7280' }}>· {d.clienteNombre}</span></div>
                    <div style={{ fontSize: 12, color: COLOR[d.proceso], fontWeight: 700 }}>{ICONO[d.proceso]} {data.embudo.find(e => e.id === d.proceso)?.label}{d.responsable ? <span style={{ color: '#9ca3af', fontWeight: 500 }}> · {d.responsable}</span> : null}</div>
                  </div>
                  <span style={{ ...S.chipTiempo, background: d.horas > 72 ? '#fef2f2' : d.horas > 24 ? '#fffbeb' : '#f0fdf4', color: d.horas > 72 ? '#b91c1c' : d.horas > 24 ? '#b45309' : '#15803d' }}>{fmtHoras(d.horas)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Detalle por día */}
          <div style={S.card}>
            <button onClick={() => setVerDias(v => !v)} style={S.toggleDias}>
              {verDias ? '▾' : '▸'} Detalle día por día
              <span style={S.cardSub}>{data.porDia.filter(d => d.creadas).length} días con órdenes</span>
            </button>
            {verDias && (
              isMobile ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                  {[...data.porDia].reverse().filter(d => d.creadas || d.completadas || d.anuladas).map(d => (
                    <div key={d.fecha} style={S.diaCard}>
                      <div style={{ fontWeight: 800 }}>{diaLabel(d.fecha)}</div>
                      <div style={{ display: 'flex', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span style={{ color: '#6366f1', fontWeight: 700 }}>{d.creadas} elaboradas</span>
                        <span style={{ color: '#0284c7' }}>{d.clientes} clientes</span>
                        <span style={{ color: '#16a34a' }}>{d.completadas} completadas</span>
                        {d.anuladas > 0 && <span style={{ color: '#9ca3af' }}>{d.anuladas} anuladas</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ overflowX: 'auto', marginTop: 10 }}>
                  <table style={S.tabla}>
                    <thead><tr>{['Día', 'Elaboradas', 'Clientes', 'Completadas', 'Anuladas'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {[...data.porDia].reverse().filter(d => d.creadas || d.completadas || d.anuladas).map(d => (
                        <tr key={d.fecha} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <td style={{ ...S.td, fontWeight: 700 }}>{diaLabel(d.fecha)}</td>
                          <td style={{ ...S.td, color: '#6366f1', fontWeight: 800 }}>{d.creadas}</td>
                          <td style={S.td}>{d.clientes}</td>
                          <td style={{ ...S.td, color: '#16a34a', fontWeight: 700 }}>{d.completadas}</td>
                          <td style={{ ...S.td, color: '#9ca3af' }}>{d.anuladas || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>

          <div style={S.pie}>
            Comparado con {mesLabel(ant.mes)}: {fmtN(ant.ordenes)} órdenes · {fmtN(ant.clientes)} clientes · {fmtN(ant.completadas)} completadas · ciclo {fmtHoras(ant.cicloMedianaHoras)}. Las órdenes internas y de producción no se cuentan.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Subcomponentes ──────────────────────────────────────────
function Kpi({ color, etiqueta, valor, pie, delta, invertir }) {
  const bueno = delta === null || delta === undefined ? null : (invertir ? delta <= 0 : delta >= 0);
  return (
    <div style={{ ...S.kpi, borderTop: `4px solid ${color}` }}>
      <div style={S.kpiEt}>{etiqueta}</div>
      <div style={{ ...S.kpiVal, color }}>{valor}</div>
      <div style={S.kpiPie}>
        {pie}
        {delta !== null && delta !== undefined && (
          <span style={{ ...S.delta, color: bueno ? '#15803d' : '#b91c1c', background: bueno ? '#f0fdf4' : '#fef2f2' }}>{delta > 0 ? '+' : ''}{delta}%</span>
        )}
      </div>
    </div>
  );
}

function GraficoDias({ porDia, isMobile }) {
  const dias = porDia || [];
  if (!dias.length) return <div style={S.vacio}>Sin datos.</div>;
  const W = 640, H = 170, padL = 26, padB = 26, padT = 8;
  const max = Math.max(1, ...dias.map(d => Math.max(d.creadas, d.completadas)));
  const n = dias.length;
  const ancho = (W - padL) / n;
  const barW = Math.max(3, ancho * 0.62);
  const y = (v) => padT + (H - padB - padT) * (1 - v / max);
  const cada = n > 20 ? (isMobile ? 7 : 3) : (isMobile ? 3 : 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Órdenes por día">
      {[0, 0.5, 1].map(f => (
        <g key={f}>
          <line x1={padL} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="#f1f5f9" />
          <text x={padL - 4} y={y(max * f) + 4} fontSize="9" fill="#9ca3af" textAnchor="end">{Math.round(max * f)}</text>
        </g>
      ))}
      {dias.map((d, i) => {
        const x = padL + i * ancho + (ancho - barW) / 2;
        return (
          <g key={d.fecha}>
            <title>{`${diaLabel(d.fecha)}: ${d.creadas} elaboradas · ${d.clientes} clientes · ${d.completadas} completadas${d.anuladas ? ` · ${d.anuladas} anuladas` : ''}`}</title>
            <rect x={x} y={y(d.creadas)} width={barW} height={Math.max(0, y(0) - y(d.creadas))} rx="2" fill="#6366f1" opacity={d.creadas ? 0.9 : 0} />
            <rect x={x} y={y(d.completadas)} width={barW * 0.5} height={Math.max(0, y(0) - y(d.completadas))} rx="2" fill="#16a34a" opacity={d.completadas ? 1 : 0} />
            {d.anuladas > 0 && <circle cx={x + barW / 2} cy={y(0) + 5} r="2.2" fill="#9ca3af" />}
            {(i % cada === 0) && <text x={x + barW / 2} y={H - 8} fontSize="9" fill="#6b7280" textAnchor="middle">{Number(d.fecha.slice(-2))}</text>}
          </g>
        );
      })}
      <line x1={padL} x2={W} y1={y(0)} y2={y(0)} stroke="#e5e7eb" />
    </svg>
  );
}

function Embudo({ embudo, total }) {
  const items = (embudo || []).filter(e => e.cantidad > 0);
  if (!items.length) return <div style={S.vacio}>Sin órdenes este mes.</div>;
  return (
    <div>
      <div style={S.barraEmbudo}>
        {items.map(e => (
          <div key={e.id} title={`${e.label}: ${e.cantidad}`} style={{ width: `${(e.cantidad / total) * 100}%`, background: COLOR[e.id] || '#9ca3af' }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {items.map(e => (
          <div key={e.id} style={S.filaEmbudo}>
            <span style={{ ...S.dot, background: COLOR[e.id], width: 10, height: 10 }} />
            <span style={{ flex: 1, fontSize: 13, color: '#374151' }}>{ICONO[e.id]} {e.label}</span>
            <span style={{ fontSize: 11.5, color: '#9ca3af' }}>{fmtCop(e.valor)}</span>
            <span style={{ fontWeight: 800, color: COLOR[e.id], minWidth: 34, textAlign: 'right' }}>{e.cantidad}</span>
            <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 36, textAlign: 'right' }}>{Math.round((e.cantidad / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tiempos({ tiempos }) {
  const filas = (tiempos || []).filter(t => t.ordenes > 0);
  if (!filas.length) return <div style={S.vacio}>Aún no hay órdenes con recorrido este mes.</div>;
  const max = Math.max(1, ...filas.map(t => t.promedioHoras));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {filas.map(t => (
        <div key={t.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span style={{ color: '#374151', fontWeight: 700 }}>{ICONO[t.id]} {t.label} <span style={{ color: '#9ca3af', fontWeight: 500 }}>· {t.ordenes} orden(es)</span></span>
            <span style={{ fontWeight: 800, color: COLOR[t.id] }}>{fmtHoras(t.medianaHoras)}</span>
          </div>
          <div style={S.pista}>
            <div style={{ width: `${Math.min(100, (t.promedioHoras / max) * 100)}%`, background: COLOR[t.id], opacity: 0.25, height: '100%', position: 'absolute', left: 0, top: 0, borderRadius: 6 }} />
            <div style={{ width: `${Math.min(100, (t.medianaHoras / max) * 100)}%`, background: COLOR[t.id], height: '100%', position: 'absolute', left: 0, top: 0, borderRadius: 6 }} />
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>promedio {fmtHoras(t.promedioHoras)} · máximo {fmtHoras(t.maxHoras)}</div>
        </div>
      ))}
      <div style={{ fontSize: 11, color: '#9ca3af' }}>La mediana es el tiempo típico; el promedio sube cuando hay órdenes muy demoradas.</div>
    </div>
  );
}

const S = {
  wrap: { marginBottom: 24 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 },
  titulo: { fontSize: 18, fontWeight: 800, color: '#111827' },
  sub: { fontSize: 12.5, color: '#6b7280', marginTop: 2 },
  nav: { display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 4 },
  navBtn: { border: 'none', background: '#f3f4f6', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 18, color: '#374151' },
  navMes: { fontWeight: 800, fontSize: 13.5, color: '#111827', minWidth: 140, textAlign: 'center' },
  error: { background: '#fef2f2', color: '#991b1b', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 12 },
  cargando: { color: '#9ca3af', fontSize: 13, padding: 20, textAlign: 'center' },
  kpis: { display: 'grid', gap: 12, marginBottom: 14 },
  kpi: { background: '#fff', borderRadius: 12, padding: '14px 16px', boxShadow: '0 2px 8px rgba(0,0,0,0.05)' },
  kpiEt: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 },
  kpiVal: { fontSize: 28, fontWeight: 800, marginTop: 4, lineHeight: 1.1 },
  kpiPie: { fontSize: 11.5, color: '#6b7280', marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  delta: { fontSize: 11, fontWeight: 800, borderRadius: 6, padding: '1px 6px' },
  dosCol: { display: 'grid', gap: 14, marginBottom: 14 },
  card: { background: '#fff', borderRadius: 12, padding: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', minWidth: 0 },
  cardTitulo: { fontSize: 14, fontWeight: 800, color: '#111827', marginBottom: 12, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' },
  cardSub: { fontSize: 11.5, fontWeight: 500, color: '#9ca3af' },
  leyenda: { display: 'flex', gap: 14, fontSize: 11.5, color: '#6b7280', marginTop: 8, flexWrap: 'wrap' },
  dot: { display: 'inline-block', width: 8, height: 8, borderRadius: 3, marginRight: 5, verticalAlign: 'middle' },
  barraEmbudo: { display: 'flex', height: 16, borderRadius: 8, overflow: 'hidden', background: '#f3f4f6' },
  filaEmbudo: { display: 'flex', alignItems: 'center', gap: 8 },
  pista: { position: 'relative', height: 10, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden' },
  filaDem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 },
  chipTiempo: { fontWeight: 800, fontSize: 12.5, borderRadius: 8, padding: '4px 10px', whiteSpace: 'nowrap' },
  vacio: { color: '#9ca3af', fontSize: 13, padding: '14px 0' },
  toggleDias: { border: 'none', background: 'transparent', fontSize: 14, fontWeight: 800, color: '#111827', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline', padding: 0 },
  diaCard: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', padding: '8px 10px', background: '#f9fafb', borderRadius: 8, flexWrap: 'wrap', fontSize: 13 },
  tabla: { width: '100%', borderCollapse: 'collapse', minWidth: 420 },
  th: { padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', background: '#f9fafb' },
  td: { padding: '8px 10px', fontSize: 13 },
  pie: { fontSize: 11.5, color: '#9ca3af', marginTop: 4 }
};
// FIN PanelOperacion.js
