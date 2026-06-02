// ════════════════════════════════════════════════════════════════════════════════
// PanelAlertasInteligentes.js — Ola 3 Bloque 3
// ─────────────────────────────────────────────────────────────────────────────
// Vista expandida de alertas inteligentes para mostrar en los dashboards
// (Admin y Tesorería). Tiene tarjetas coloreadas + botón Resolver.
// Diferente de CampanaAlertas: aquí se ven TODAS expandidas, sin click extra.
// ═══════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const COLORES = {
  critica:     { bg: '#fef2f2', border: '#fca5a5', text: '#991b1b', accent: '#dc2626' },
  importante:  { bg: '#fffbeb', border: '#fcd34d', text: '#92400e', accent: '#f59e0b' },
  informativa: { bg: '#eff6ff', border: '#93c5fd', text: '#1e3a8a', accent: '#0284c7' },
};

const TIPO_ICON = {
  FOTOS_FALTANTES:   '📷',
  TALLER_ATORADO:    '🔧',
  PAGO_PENDIENTE:    '💳',
  PRESTAMO_VIEJO:    '🔁',
  CXC_VENCIDO:       '💸',
  CLIENTE_FUGANDOSE: '🚪',
};

const PanelAlertasInteligentes = ({ filtroTipo = null }) => {
  const [data, setData] = useState({ resumen: { total: 0 }, alertas: [] });
  const [loading, setLoading] = useState(true);
  const [resolviendo, setResolviendo] = useState(null);
  const [colapsado, setColapsado] = useState(false);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const cargar = async () => {
    try {
      const r = await axios.get(`${API}/alertas`, { headers });
      setData(r.data);
    } catch { /* silent */ }
    setLoading(false);
  };

  // ── OPTIMIZACIÓN OLA 3.5: refresh cada 5 minutos (antes era 60s) ──
  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 5 * 60 * 1000); // 5 minutos
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, []);

  const resolver = async (a) => {
    const nota = window.prompt(`Marcar como resuelta: "${a.titulo}"\n\nNota opcional:`, '');
    if (nota === null) return;
    setResolviendo(`${a.tipo}_${a.referenciaId}`);
    try {
      await axios.post(`${API}/alertas/resolver`, {
        tipo: a.tipo, referenciaId: a.referenciaId, nota
      }, { headers });
      cargar();
    } catch (e) {
      alert('No se pudo resolver: ' + (e.response?.data?.error || e.message));
    }
    setResolviendo(null);
  };

  if (loading) return null;

  // Filtrar por tipo si se especifica
  let lista = data.alertas;
  if (filtroTipo) lista = lista.filter(a => filtroTipo.includes(a.tipo));

  // Si no hay nada, no renderizamos
  if (lista.length === 0) return null;

  const criticas = lista.filter(a => a.prioridad === 'critica').length;
  const importantes = lista.filter(a => a.prioridad === 'importante').length;
  const informativas = lista.filter(a => a.prioridad === 'informativa').length;

  return (
    <div style={{
      background: '#fff',
      border: criticas > 0 ? '2px solid #fca5a5' : '1px solid #e5e7eb',
      borderRadius: 12,
      padding: 16,
      marginBottom: 20,
      boxShadow: criticas > 0 ? '0 4px 14px rgba(220, 38, 38, 0.1)' : 'none'
    }}>
      {/* Header colapsable */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        cursor: 'pointer',
        marginBottom: colapsado ? 0 : 14
      }} onClick={() => setColapsado(!colapsado)}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1a1a2e' }}>
            🔔 Alertas Inteligentes
            <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 600 }}>
              {criticas > 0 && <span style={{ color: '#dc2626' }}>· {criticas} críticas</span>}
              {importantes > 0 && <span style={{ color: '#f59e0b' }}> · {importantes} importantes</span>}
              {informativas > 0 && <span style={{ color: '#0284c7' }}> · {informativas} informativas</span>}
            </span>
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
            Problemas detectados automáticamente — resuelve para limpiarlos
          </p>
        </div>
        <button style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontSize: 14, color: '#6b7280'
        }}>{colapsado ? '▼' : '▲'}</button>
      </div>

      {!colapsado && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
          {lista.map((a, i) => {
            const c = COLORES[a.prioridad];
            const cargando = resolviendo === `${a.tipo}_${a.referenciaId}`;
            return (
              <div key={i} style={{
                background: c.bg,
                border: `1px solid ${c.border}`,
                borderLeft: `4px solid ${c.accent}`,
                borderRadius: 8,
                padding: 12,
                opacity: cargando ? 0.5 : 1
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ fontSize: 22, lineHeight: 1 }}>{TIPO_ICON[a.tipo] || '🔔'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: c.text, marginBottom: 3 }}>
                      {a.titulo}
                    </div>
                    <div style={{ fontSize: 11, color: '#4b5563', lineHeight: 1.4 }}>
                      {a.descripcion}
                    </div>
                  </div>
                  <button onClick={() => resolver(a)} disabled={cargando}
                    style={{
                      background: '#fff', color: c.text,
                      border: `1px solid ${c.border}`,
                      borderRadius: 6, padding: '4px 8px',
                      fontSize: 10, fontWeight: 700,
                      cursor: cargando ? 'wait' : 'pointer',
                      flexShrink: 0, whiteSpace: 'nowrap'
                    }}>
                    {cargando ? '...' : '✓'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PanelAlertasInteligentes;

