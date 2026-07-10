// ============================================================
// Control360 — WhatsApp IA Anny Dashboard
// Ubicación: frontend/src/VencimientosAnny.js
// Uso: Importar en GestionVencimientos.js
// ============================================================

import React, { useState, useEffect } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

export default function VencimientosAnny() {
  const [metricas, setMetricas] = useState(null);
  const [conversaciones, setConversaciones] = useState([]);
  const [casos, setCasos] = useState([]);
  const [config, setConfig] = useState(null);
  // FIX ANNY-GATE-002: null = aún no se sabe. El dashboard SOLO se
  // muestra cuando activo === true (fail-closed). Antes el gate era
  // `activo === false`, y si /api/anny/config fallaba (404 porque la
  // ruta no estaba montada en server.js), activo quedaba en null y
  // TODOS los suscriptores veían el dashboard completo.
  const [activo, setActivo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('metricas'); // metricas | conversaciones | casos
  const [diasAntes, setDiasAntes] = useState(30);
  const [horaEnvio, setHoraEnvio] = useState('09:00');
  const [guardando, setGuardando] = useState(false);

  // ============================================================
  // Cargar datos
  // FIX ANNY-GATE-002: primero se consulta /config validando res.ok.
  // Si el endpoint falla (404/500/red) o responde activo:false, se
  // corta ahí: activo=false, no se golpean los demás endpoints y el
  // suscriptor ve el aviso "módulo no activo" — nunca el dashboard.
  // ============================================================
  useEffect(() => {
    cargarDatos();
    const interval = setInterval(cargarDatos, 30000); // Actualizar cada 30s
    return () => clearInterval(interval);
  }, []);

  const cargarDatos = async () => {
    try {
      const res = await fetch(`${API}/anny/config`, { headers: authHeaders() });

      // FIX ANNY-GATE-002: si el backend no responde OK, fail-closed
      if (!res.ok) {
        setActivo(false);
        setLoading(false);
        return;
      }

      const cfg = await res.json();
      setConfig(cfg);
      setActivo(cfg?.activo === true);

      if (cfg) {
        setDiasAntes(cfg.diasAntes || 30);
        setHoraEnvio(cfg.horaEnvio || '09:00');
      }

      if (cfg?.activo !== true) {
        setLoading(false);
        return; // módulo no activo: no pedir el resto
      }

      const [m, c, cas] = await Promise.all([
        fetch(`${API}/anny/metricas`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/anny/conversaciones?limit=20`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/anny/casos-escalados?estado=pendiente`, { headers: authHeaders() }).then(r => r.json()),
      ]);

      setMetricas(m);
      setConversaciones(Array.isArray(c) ? c : []);
      setCasos(Array.isArray(cas) ? cas : []);
    } catch (err) {
      console.error('Error cargando datos Anny:', err);
      // FIX ANNY-GATE-002: ante cualquier error, fail-closed
      setActivo(false);
    } finally {
      setLoading(false);
    }
  };

  const actualizarConfig = async () => {
    setGuardando(true);
    try {
      const res = await fetch(`${API}/anny/config`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          diasAntes: Number(diasAntes),
          horaEnvio
        })
      });

      if (res.ok) {
        await cargarDatos();
        alert('✅ Configuración actualizada');
      }
    } catch (err) {
      console.error('Error actualizando:', err);
      alert('❌ Error guardando');
    } finally {
      setGuardando(false);
    }
  };

  const marcarCasoResuelto = async (caseId) => {
    try {
      const res = await fetch(`${API}/anny/casos/${caseId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          estado: 'RESUELTO',
          notas: 'Resuelto desde dashboard'
        })
      });

      if (res.ok) {
        await cargarDatos();
      }
    } catch (err) {
      console.error('Error marcando resuelto:', err);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>
        Cargando Anny...
      </div>
    );
  }

  // ============================================================
  // FIX ANNY-GATE-002: gate fail-closed. Solo se pasa de aquí si
  // activo === true (confirmado por el backend contra el array
  // `modulos` del suscriptor). null, false o error = bloqueado.
  // Mismo mensaje/patrón visual que Lucy (LlamadasIA.js).
  // ============================================================
  if (activo !== true) {
    return (
      <div style={{ padding: '12px 12px 80px', maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 12, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32 }}>🤖</div>
          <div style={{ fontWeight: 800, color: '#1a1a2e', marginTop: 8, fontSize: 15 }}>WhatsApp IA Anny no está activo</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, maxWidth: 360, marginLeft: 'auto', marginRight: 'auto' }}>
            Este módulo se activa manualmente por nuestro equipo. Si te interesa automatizar la atención de vencimientos por WhatsApp, contáctanos.
          </div>
        </div>
      </div>
    );
  }

  const pendientes = casos.filter(c => c.estado === 'PENDIENTE');

  return (
    <div style={{ padding: 20 }}>
      {/* HEADER */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#1a1a2e', marginBottom: 6 }}>
          🤖 WhatsApp IA Anny
        </h1>
        <p style={{ fontSize: 13, color: '#9ca3af' }}>
          {config?.activo ? '🟢 ACTIVO' : '⚪ INACTIVO'} • Número: {config?.whatsappNumber || 'No configurado'}
        </p>
      </div>

      {/* TABS */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #e5e7eb' }}>
        {[
          { id: 'metricas', label: '📊 Métricas' },
          { id: 'conversaciones', label: '💬 Conversaciones' },
          { id: 'casos', label: '⚠️ Casos Escalados', badge: pendientes.length }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '12px 16px',
              border: 'none',
              background: activeTab === tab.id ? '#7c3aed' : 'transparent',
              color: activeTab === tab.id ? '#fff' : '#6b7280',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              borderRadius: '8px 8px 0 0',
              position: 'relative'
            }}
          >
            {tab.label}
            {tab.badge ? (
              <span style={{
                position: 'absolute',
                top: -8,
                right: -8,
                background: '#dc2626',
                color: '#fff',
                width: 24,
                height: 24,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 800
              }}>
                {tab.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* =============== TAB: MÉTRICAS =============== */}
      {activeTab === 'metricas' && (
        <div>
          {/* Cards de métricas */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 24 }}>
            <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', marginBottom: 8 }}>
                Automáticas
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#15803d' }}>
                {metricas?.respuestas_automaticas || 0}
              </div>
            </div>

            <div style={{ background: '#dbeafe', border: '1px solid #60a5fa', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', marginBottom: 8 }}>
                IA (Claude)
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#0369a1' }}>
                {metricas?.respuestas_ia || 0}
              </div>
            </div>

            <div style={{ background: '#fed7aa', border: '1px solid #fbbf24', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', textTransform: 'uppercase', marginBottom: 8 }}>
                Escalados
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#b45309' }}>
                {metricas?.casos_escalados || 0}
              </div>
            </div>

            <div style={{ background: '#e9d5ff', border: '1px solid #d8b4fe', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6d28d9', textTransform: 'uppercase', marginBottom: 8 }}>
                Total hoy
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#6d28d9' }}>
                {metricas?.total || 0}
              </div>
            </div>
          </div>

          {/* Configuración */}
          <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', marginBottom: 16 }}>
              ⚙️ Configuración
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
                  Días antes de recordar
                </label>
                <input
                  type="number"
                  value={diasAntes}
                  onChange={e => setDiasAntes(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid #d1d5db',
                    borderRadius: 8,
                    fontSize: 13
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
                  Hora de envío
                </label>
                <input
                  type="time"
                  value={horaEnvio}
                  onChange={e => setHoraEnvio(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid #d1d5db',
                    borderRadius: 8,
                    fontSize: 13
                  }}
                />
              </div>
            </div>

            <button
              onClick={actualizarConfig}
              disabled={guardando}
              style={{
                width: '100%',
                padding: '12px 0',
                border: 'none',
                borderRadius: 8,
                background: '#7c3aed',
                color: '#fff',
                fontWeight: 700,
                fontSize: 13,
                cursor: 'pointer',
                opacity: guardando ? 0.6 : 1
              }}
            >
              {guardando ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      )}

      {/* =============== TAB: CONVERSACIONES =============== */}
      {activeTab === 'conversaciones' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {conversaciones.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>
              Sin conversaciones aún
            </div>
          ) : (
            conversaciones.map((conv, i) => (
              <div key={i} style={{
                background: '#f9fafb',
                border: '1px solid #e5e7eb',
                borderRadius: 10,
                padding: 14,
                borderLeft: '4px solid #7c3aed'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#1a1a2e' }}>
                    {conv.nombreCliente || conv.telefono}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>
                    {new Date(conv.createdAt).toLocaleString()}
                  </div>
                </div>

                <div style={{ background: '#fff', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                    <strong>Cliente:</strong> {conv.mensajeCliente}
                  </div>
                  <div style={{ fontSize: 12, color: '#15803d' }}>
                    <strong>Anny:</strong> {conv.respuestaAgente}
                  </div>
                </div>

                <div style={{
                  display: 'inline-block',
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '4px 8px',
                  borderRadius: 6,
                  background: conv.escalado ? '#fed7aa' : '#dcfce7',
                  color: conv.escalado ? '#b45309' : '#15803d'
                }}>
                  {conv.escalado ? '⚠️ Escalado' : '✓ Automático'}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* =============== TAB: CASOS ESCALADOS =============== */}
      {activeTab === 'casos' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {pendientes.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>
              ✅ Sin casos pendientes
            </div>
          ) : (
            pendientes.map((caso, i) => (
              <div key={i} style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 10,
                padding: 14,
                borderLeft: '4px solid #dc2626'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#1a1a2e' }}>
                      {caso.nombreCliente}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                      {new Date(caso.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '4px 10px',
                    borderRadius: 6,
                    background: '#fee2e2',
                    color: '#b91c1c'
                  }}>
                    {caso.tipo}
                  </div>
                </div>

                <div style={{ background: '#fff', borderRadius: 6, padding: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>
                    {caso.mensajeCliente}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => marcarCasoResuelto(caso.id)}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      border: 'none',
                      borderRadius: 6,
                      background: '#dcfce7',
                      color: '#15803d',
                      fontWeight: 700,
                      fontSize: 12,
                      cursor: 'pointer'
                    }}
                  >
                    ✓ Resuelto
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
