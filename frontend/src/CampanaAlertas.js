// ════════════════════════════════════════════════════════════════════════════════
// CampanaAlertas.js — Ola 3 Bloque 3
// ─────────────────────────────────────────────────────────────────────────────
// Campana 🔔 con badge de conteo. Click → panel deslizable con todas las alertas.
// Refresca automáticamente cada 60s. Permite resolver alertas.
// ════════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const COLORES_PRIORIDAD = {
  critica:     { bg: '#fef2f2', border: '#fca5a5', text: '#991b1b', icon: '🔴' },
  importante:  { bg: '#fffbeb', border: '#fcd34d', text: '#92400e', icon: '🟡' },
  informativa: { bg: '#eff6ff', border: '#93c5fd', text: '#1e3a8a', icon: '🟢' },
};

const TIPO_ICON = {
  FOTOS_FALTANTES:   '📷',
  TALLER_ATORADO:    '🔧',
  PAGO_PENDIENTE:    '💳',
  PRESTAMO_VIEJO:    '🔁',
  CXC_VENCIDO:       '💸',
  CLIENTE_FUGANDOSE: '🚪',
};

const CampanaAlertas = ({ inSidebar = false }) => {
  const [abierto, setAbierto] = useState(false);
  const [data, setData] = useState({ resumen: { total: 0 }, alertas: [] });
  const [loading, setLoading] = useState(false);
  const [resolviendo, setResolviendo] = useState(null);
  const panelRef = useRef(null);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // Cargar alertas
  const cargar = async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/alertas`, { headers });
      setData(r.data);
    } catch (e) {
      console.warn('Error cargando alertas:', e.message);
    }
    setLoading(false);
  };

  // ── OPTIMIZACIÓN OLA 3.5: refresh cada 5 minutos (antes era 60s) ──
  // Esto reduce las lecturas a Firestore 5x. Si necesitas refrescar antes,
  // está el botón "🔄 Refrescar" manual al pie del panel.
  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 5 * 60 * 1000); // 5 minutos
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, []);

  // Cerrar al click fuera
  useEffect(() => {
    const onClick = (e) => {
      if (abierto && panelRef.current && !panelRef.current.contains(e.target)) {
        setAbierto(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [abierto]);

  const resolver = async (alerta) => {
    const nota = window.prompt(`Marcar como resuelta: "${alerta.titulo}"\n\nNota opcional:`, '');
    if (nota === null) return; // canceló
    setResolviendo(`${alerta.tipo}_${alerta.referenciaId}`);
    try {
      await axios.post(`${API}/alertas/resolver`, {
        tipo: alerta.tipo, referenciaId: alerta.referenciaId, nota
      }, { headers });
      cargar();
    } catch (e) {
      alert('No se pudo resolver: ' + (e.response?.data?.error || e.message));
    }
    setResolviendo(null);
  };

  const total = data.resumen.total || 0;
  const criticas = data.resumen.criticas || 0;

  // Color del badge según gravedad
  const badgeColor = criticas > 0 ? '#dc2626' : total > 0 ? '#f59e0b' : '#9ca3af';

  return (
    <>
      {/* CAMPANA */}
      <button
        onClick={() => setAbierto(!abierto)}
        title={`${total} alertas activas`}
        style={{
          position: 'relative',
          background: inSidebar ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.15)',
          color: '#fff',
          borderRadius: 8,
          width: 36, height: 36,
          cursor: 'pointer',
          fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0
        }}
      >
        🔔
        {total > 0 && (
          <span style={{
            position: 'absolute',
            top: -4, right: -4,
            background: badgeColor, color: '#fff',
            borderRadius: 10, minWidth: 18, height: 18,
            fontSize: 10, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px',
            border: '2px solid #1a1a2e'
          }}>
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {/* PANEL DESLIZABLE */}
      {abierto && (
        <div ref={panelRef} style={{
          position: 'fixed',
          top: inSidebar ? '50%' : 60,
          left: inSidebar ? 240 : 'auto',
          right: inSidebar ? 'auto' : 20,
          transform: inSidebar ? 'translateY(-50%)' : 'none',
          width: 420, maxWidth: 'calc(100vw - 40px)',
          maxHeight: '80vh',
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          {/* Header del panel */}
          <div style={{
            padding: '14px 18px',
            borderBottom: '1px solid #e5e7eb',
            background: 'linear-gradient(135deg, #1a1a2e, #2d2d4d)',
            color: '#fff',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center'
          }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>🔔 Alertas Inteligentes</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                {data.resumen.criticas > 0 && <span style={{ color: '#fca5a5' }}>{data.resumen.criticas} críticas · </span>}
                {data.resumen.importantes > 0 && <span style={{ color: '#fcd34d' }}>{data.resumen.importantes} importantes · </span>}
                {data.resumen.informativas > 0 && <span style={{ color: '#93c5fd' }}>{data.resumen.informativas} informativas</span>}
                {total === 0 && <span>Todo en orden ✓</span>}
              </div>
            </div>
            <button onClick={() => setAbierto(false)} style={{
              background: 'rgba(255,255,255,0.1)', color: '#fff',
              border: 'none', borderRadius: 6,
              width: 26, height: 26, cursor: 'pointer'
            }}>✕</button>
          </div>

          {/* Lista de alertas */}
          <div style={{ overflowY: 'auto', flex: 1, padding: 12 }}>
            {loading && <div style={{ textAlign: 'center', padding: 20, color: '#9ca3af' }}>Cargando...</div>}

            {!loading && data.alertas.length === 0 && (
              <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
                <div style={{ fontSize: 48, marginBottom: 10 }}>✓</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#16a34a' }}>Todo en orden</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>No hay alertas activas</div>
              </div>
            )}

            {data.alertas.map((a, i) => {
              const c = COLORES_PRIORIDAD[a.prioridad];
              const cargando = resolviendo === `${a.tipo}_${a.referenciaId}`;
              return (
                <div key={i} style={{
                  background: c.bg,
                  border: `1px solid ${c.border}`,
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 8,
                  opacity: cargando ? 0.5 : 1
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ fontSize: 20, lineHeight: 1 }}>
                      {TIPO_ICON[a.tipo] || c.icon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: c.text, marginBottom: 2 }}>
                        {a.titulo}
                      </div>
                      <div style={{ fontSize: 11, color: '#4b5563', lineHeight: 1.4 }}>
                        {a.descripcion}
                      </div>
                      {a.datos && a.datos.ordenesEjemplo && a.datos.ordenesEjemplo.length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 10, color: '#6b7280' }}>
                          Órdenes: {a.datos.ordenesEjemplo.map(o => o.numeroOrden).join(', ')}
                        </div>
                      )}
                    </div>
                    <button onClick={() => resolver(a)} disabled={cargando}
                      style={{
                        background: '#fff', color: c.text,
                        border: `1px solid ${c.border}`,
                        borderRadius: 6, padding: '4px 8px',
                        fontSize: 10, fontWeight: 700, cursor: cargando ? 'wait' : 'pointer',
                        flexShrink: 0, whiteSpace: 'nowrap'
                      }}>
                      {cargando ? '...' : '✓ Resolver'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer del panel */}
          <div style={{
            padding: '10px 14px',
            borderTop: '1px solid #e5e7eb',
            background: '#f9fafb',
            fontSize: 11, color: '#6b7280',
            display: 'flex', justifyContent: 'space-between'
          }}>
            <span>Actualización automática cada 5 minutos</span>
            <button onClick={cargar} style={{
              background: 'transparent', border: 'none', color: '#7c3aed',
              cursor: 'pointer', fontSize: 11, fontWeight: 600
            }}>🔄 Refrescar</button>
          </div>
        </div>
      )}
    </>
  );
};

export default CampanaAlertas;

