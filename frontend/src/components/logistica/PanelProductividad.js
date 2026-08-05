import React, { useState, useEffect } from 'react';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════════════════════
// ✅ LOGISTICA-PROD-001 — PANEL DE PRODUCTIVIDAD DE MENSAJEROS
// ─────────────────────────────────────────────────────────────────────────────
// Resumen mensual que ve el coordinador/gerente al entrar a Logística:
// cuántas vueltas hizo cada mensajero, cuánto recaudó y qué tan completa dejó
// la evidencia fotográfica. Es un tablero de LECTURA — no dispara acciones.
//
// El dato de fotos es informativo a propósito: sirve para conversar con el
// equipo, no para castigar. Por eso se muestra como % de cumplimiento y no
// como una alerta roja.
//
// Diseño: tira horizontal scrollable en móvil (los mensajeros abren la app en
// el celular) y grid auto-ajustable en desktop. Cero media queries: el grid
// con auto-fit resuelve ambos casos solo.
// ═══════════════════════════════════════════════════════════════════════════════

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

// Últimos 12 meses como opciones del selector (etiqueta legible en español).
const opcionesMeses = () => {
  const out = [];
  const base = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const valor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const etiqueta = d.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
    out.push({ valor, etiqueta: etiqueta.charAt(0).toUpperCase() + etiqueta.slice(1) });
  }
  return out;
};

// Paleta del podio — oro / plata / bronce para los tres primeros del ranking.
const MEDALLAS = ['🥇', '🥈', '🥉'];
const ACENTOS = ['#f59e0b', '#94a3b8', '#b45309'];

// ── Dona SVG de cumplimiento fotográfico ────────────────────────────────────
// Un anillo lee mucho mejor que un "68%" suelto: el ojo capta la proporción sin
// tener que interpretar el número. Verde ≥80, ámbar ≥50, rojo debajo.
// SVG puro, sin librerías: pesa nada y escala nítido en cualquier pantalla.
const DonaFoto = ({ pct, size = 52 }) => {
  const r = (size - 7) / 2;
  const circ = 2 * Math.PI * r;
  const color = pct >= 80 ? '#16a34a' : pct >= 50 ? '#d97706' : '#dc2626';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0, display: 'block' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef0f4" strokeWidth="6" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${(circ * pct) / 100} ${circ}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .4s ease' }}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: 13, fontWeight: 800, fill: color }}>
        {pct}%
      </text>
    </svg>
  );
};

const PanelProductividad = ({ headers, isMobile }) => {
  const meses = opcionesMeses();
  const [mes, setMes]           = useState(meses[0].valor);
  const [data, setData]         = useState(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo]       = useState('');
  const [colapsado, setColapsado] = useState(false);

  useEffect(() => {
    let vivo = true;
    setCargando(true); setFallo('');
    axios.get(`${API}/logistica/productividad?mes=${mes}`, { headers })
      .then(r => { if (vivo) setData(r.data); })
      // Un panel vacío por error de red y uno vacío por falta de datos son
      // problemas distintos: mostrarlos igual manda a buscar donde no es.
      .catch(e => { if (vivo) { setData(null); setFallo(e.response?.data?.error || 'No se pudo cargar la productividad'); } })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mes]);

  const lista = data?.mensajeros || [];
  const maxVueltas = Math.max(1, ...lista.map(m => m.vueltas));

  return (
    <div style={st.wrap}>
      {/* Cabecera: título + selector de mes + colapsar */}
      <div style={st.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={st.titulo}>📊 Productividad del equipo</span>
          {data?.totales && !colapsado && (
            <span style={st.resumenChip}>
              {data.totales.vueltas} vueltas · {fmt(data.totales.recaudado)}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select value={mes} onChange={e => setMes(e.target.value)} style={st.selectMes}>
            {meses.map(m => <option key={m.valor} value={m.valor}>{m.etiqueta}</option>)}
          </select>
          <button onClick={() => setColapsado(c => !c)} style={st.btnColapsar}
            title={colapsado ? 'Mostrar panel' : 'Ocultar panel'}>
            {colapsado ? '▼' : '▲'}
          </button>
        </div>
      </div>

      {!colapsado && (
        <>
          {cargando ? (
            <div style={st.vacio}>Cargando productividad...</div>
          ) : fallo ? (
            <div style={{ ...st.vacio, color: '#dc2626' }}>⚠️ {fallo}</div>
          ) : lista.length === 0 ? (
            <div style={st.vacio}>Sin actividad registrada en este mes</div>
          ) : (
            <div style={isMobile ? st.tira : st.grid}>
              {lista.map((m, i) => (
                <div key={m.mensajeroId} style={{
                  ...st.card,
                  ...(isMobile ? st.cardTira : {}),
                  borderTop: `3px solid ${ACENTOS[i] || '#e2e8f0'}`
                }}>
                  {/* Nombre + medalla de posición */}
                  <div style={st.cardHead}>
                    <span style={st.medalla}>{MEDALLAS[i] || `#${i + 1}`}</span>
                    <span style={st.nombre}>{m.mensajeroNombre}</span>
                  </div>

                  {/* Métrica principal + dona de evidencia, lado a lado */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 10 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={st.vueltas}>{m.vueltas}</span>
                        <span style={st.vueltasLabel}>vueltas</span>
                      </div>
                      <div style={st.recaudo}>{fmt(m.recaudado)}</div>
                      <div style={st.recaudoLabel}>recaudado</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <DonaFoto pct={m.pctFoto} />
                      <div style={st.donaLabel}>📷 con foto</div>
                    </div>
                  </div>

                  {/* Barra comparativa contra el mejor del mes */}
                  <div style={st.barraFondo}>
                    <div style={{
                      ...st.barra,
                      width: `${Math.round((m.vueltas / maxVueltas) * 100)}%`,
                      background: ACENTOS[i] || '#7c3aed'
                    }} />
                  </div>

                  {m.sinFoto > 0 && (
                    <div style={st.notaFoto}>
                      ⚠️ {m.sinFoto} {m.sinFoto === 1 ? 'vuelta' : 'vueltas'} sin foto
                    </div>
                  )}

                  {/* Desglose del estado de sus órdenes */}
                  <div style={st.chips}>
                    {m.enCurso > 0 && <span style={{ ...st.chip, background: '#eff6ff', color: '#1d4ed8' }}>{m.enCurso} en curso</span>}
                    {m.entregadas > 0 && <span style={{ ...st.chip, background: '#f0fdf4', color: '#15803d' }}>{m.entregadas} entregadas</span>}
                    {m.aCxC > 0 && <span style={{ ...st.chip, background: '#fffbeb', color: '#92400e' }}>{m.aCxC} a CxC</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const st = {
  wrap:        { background: '#fff', borderRadius: 14, boxShadow: '0 2px 10px rgba(0,0,0,0.06)', padding: '14px 16px', marginBottom: 20 },
  header:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 },
  titulo:      { fontSize: 15, fontWeight: 800, color: '#111' },
  resumenChip: { fontSize: 12, fontWeight: 700, color: '#7c3aed', background: '#f5f3ff', padding: '3px 10px', borderRadius: 20 },
  selectMes:   { padding: '7px 10px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#374151', background: '#fff', outline: 'none', cursor: 'pointer' },
  btnColapsar: { width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', cursor: 'pointer', fontSize: 11, color: '#6b7280', flexShrink: 0 },
  vacio:       { textAlign: 'center', padding: 24, color: '#9ca3af', fontSize: 13 },

  // Desktop: grid que se auto-ajusta al ancho disponible.
  grid:        { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 },
  // Móvil: tira horizontal deslizable — no se aplasta con 4+ mensajeros.
  tira:        { display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 6, WebkitOverflowScrolling: 'touch' },
  cardTira:    { flex: '0 0 76%', minWidth: 210, scrollSnapAlign: 'start' },

  card:        { background: '#fcfcfd', border: '1px solid #eef0f4', borderRadius: 12, padding: '12px 14px', boxSizing: 'border-box' },
  cardHead:    { display: 'flex', alignItems: 'center', gap: 7 },
  medalla:     { fontSize: 15, fontWeight: 800, color: '#64748b', flexShrink: 0 },
  nombre:      { fontSize: 13, fontWeight: 800, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  vueltas:     { fontSize: 28, fontWeight: 800, color: '#111', lineHeight: 1 },
  vueltasLabel:{ fontSize: 12, color: '#9ca3af', fontWeight: 600 },
  recaudo:     { fontSize: 15, fontWeight: 800, color: '#16a34a', marginTop: 8, lineHeight: 1.1 },
  recaudoLabel:{ fontSize: 10, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  donaLabel:   { fontSize: 10, color: '#9ca3af', fontWeight: 700, marginTop: 3 },
  barraFondo:  { height: 5, background: '#f1f5f9', borderRadius: 20, overflow: 'hidden', margin: '12px 0 0' },
  barra:       { height: '100%', borderRadius: 20, transition: 'width .3s ease' },
  notaFoto:    { fontSize: 11, color: '#b45309', marginTop: 8, fontWeight: 600 },
  chips:       { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10 },
  chip:        { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 },
};

export default PanelProductividad;
