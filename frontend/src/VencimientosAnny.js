// ============================================================
// Control360 — WhatsApp IA Anny Dashboard
// Ubicación: frontend/src/VencimientosAnny.js
// Uso: Importar en GestionVencimientos.js
// FIX ANNY-GATE-002: gate fail-closed (solo muestra si activo===true)
// FIX ANNY-QR-001: sección Conexión WhatsApp (Baileys) con QR
// ============================================================

import React, { useState, useEffect, useRef } from 'react';

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
  // muestra cuando activo === true (fail-closed).
  const [activo, setActivo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('metricas'); // metricas | conversaciones | casos
  const [diasAntes, setDiasAntes] = useState(30);
  const [horaEnvio, setHoraEnvio] = useState('09:00');
  const [guardando, setGuardando] = useState(false);

  // FIX ANNY-QR-001: estado de conexión WhatsApp
  const [conexion, setConexion] = useState({ estado: 'desconectado', numero: null });
  const [qrImg, setQrImg] = useState(null);
  const [conectando, setConectando] = useState(false);
  const pollRef = useRef(null);

  // ============================================================
  // Cargar datos
  // FIX ANNY-GATE-002: primero /config validando res.ok. Si falla
  // (404/500/red) o activo:false → fail-closed, aviso bloqueado.
  // ============================================================
  useEffect(() => {
    cargarDatos();
    const interval = setInterval(cargarDatos, 30000); // Actualizar cada 30s
    return () => {
      clearInterval(interval);
      if (pollRef.current) clearInterval(pollRef.current); // FIX ANNY-QR-001
    };
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

      const [m, c, cas, est] = await Promise.all([
        fetch(`${API}/anny/metricas`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/anny/conversaciones?limit=20`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/anny/casos-escalados?estado=pendiente`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/anny/estado`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null), // FIX ANNY-QR-001
      ]);

      setMetricas(m);
      setConversaciones(Array.isArray(c) ? c : []);
      setCasos(Array.isArray(cas) ? cas : []);
      if (est) setConexion(est);
    } catch (err) {
      console.error('Error cargando datos Anny:', err);
      // FIX ANNY-GATE-002: ante cualquier error, fail-closed
      setActivo(false);
    } finally {
      setLoading(false);
    }
  };

  // ============================================================
  // FIX ANNY-QR-001: conectar WhatsApp — genera QR y hace polling
  // hasta que el celular lo escanee (estado 'conectado')
  // ============================================================
  const conectarWhatsApp = async () => {
    setConectando(true);
    setQrImg(null);
    try {
      const res = await fetch(`${API}/anny/conectar`, { method: 'POST', headers: authHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`❌ ${err.error || 'Error iniciando conexión'}`);
        setConectando(false);
        return;
      }

      // Polling cada 3s: pedir QR / detectar conexión
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${API}/anny/qr`, { headers: authHeaders() });
          if (!r.ok) return;
          const data = await r.json();

          if (data.estado === 'conectado') {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setQrImg(null);
            setConectando(false);
            const est = await fetch(`${API}/anny/estado`, { headers: authHeaders() }).then(x => x.ok ? x.json() : null);
            if (est) setConexion(est);
            alert('✅ WhatsApp conectado');
          } else if (data.qr) {
            setQrImg(data.qr);
            setConexion(prev => ({ ...prev, estado: data.estado }));
          }
        } catch (e) {
          console.error('Error polling QR:', e);
        }
      }, 3000);
    } catch (err) {
      console.error('Error conectando:', err);
      setConectando(false);
    }
  };

  const desconectarWhatsApp = async () => {
    if (!window.confirm('¿Desconectar WhatsApp? Anny dejará de responder mensajes y tendrás que escanear el QR de nuevo para reconectar.')) return;
    try {
      const res = await fetch(`${API}/anny/desconectar`, { method: 'POST', headers: authHeaders() });
      if (res.ok) {
        setConexion({ estado: 'desconectado', numero: null });
        setQrImg(null);
        alert('✅ WhatsApp desconectado');
      }
    } catch (err) {
      console.error('Error desconectando:', err);
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
  const conectado = conexion.estado === 'conectado';

  return (
    <div style={{ padding: 20 }}>
      {/* HEADER */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: '#1a1a2e', marginBottom: 6 }}>
          🤖 WhatsApp IA Anny
        </h1>
        <p style={{ fontSize: 13, color: '#9ca3af' }}>
          {conectado ? '🟢 CONECTADO' : '⚪ DESCONECTADO'} • Número: {conexion.numero || config?.whatsappNumber || 'No configurado'}
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
          {/* FIX ANNY-QR-001: Conexión WhatsApp */}
          <div style={{ background: conectado ? '#f0fdf4' : '#fefce8', border: `1px solid ${conectado ? '#86efac' : '#fde047'}`, borderRadius: 12, padding: 20, marginBottom: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', marginBottom: 12 }}>
              📱 Conexión WhatsApp
            </h3>

            {conectado ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ fontSize: 13, color: '#15803d', fontWeight: 700 }}>
                  🟢 Conectado — {conexion.numero}
                </div>
                <button
                  onClick={desconectarWhatsApp}
                  style={{ padding: '10px 16px', border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', color: '#b91c1c', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                >
                  Desconectar
                </button>
              </div>
            ) : qrImg ? (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12 }}>
                  Escanea este QR desde el celular de la línea de WhatsApp:
                </div>
                <img src={qrImg} alt="QR WhatsApp" style={{ width: 240, height: 240, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }} />
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 12, lineHeight: 1.5 }}>
                  WhatsApp → ⋮ Menú → <strong>Dispositivos vinculados</strong> → <strong>Vincular un dispositivo</strong><br />
                  El QR se renueva automáticamente. Esta pantalla detectará cuando conectes.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280', maxWidth: 480, lineHeight: 1.5 }}>
                  Anny necesita vincularse a una línea de WhatsApp como dispositivo adicional.
                  Al conectar se genera un código QR que escaneas desde el celular de esa línea.
                </div>
                <button
                  onClick={conectarWhatsApp}
                  disabled={conectando}
                  style={{ padding: '12px 20px', border: 'none', borderRadius: 8, background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: conectando ? 0.6 : 1 }}
                >
                  {conectando ? 'Generando QR...' : '📱 Conectar WhatsApp'}
                </button>
              </div>
            )}
          </div>

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
                    {conv.createdAt?.seconds ? new Date(conv.createdAt.seconds * 1000).toLocaleString() : ''}
                  </div>
                </div>

                <div style={{ background: '#fff', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                  {conv.mensajeCliente ? (
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                      <strong>Cliente:</strong> {conv.mensajeCliente}
                    </div>
                  ) : null}
                  {conv.respuestaAgente ? (
                    <div style={{ fontSize: 12, color: conv.respondidoPor === 'ADMIN_MANUAL' ? '#0369a1' : '#15803d' }}>
                      <strong>{conv.respondidoPor === 'ADMIN_MANUAL' ? 'Tú:' : 'Anny:'}</strong> {conv.respuestaAgente}
                    </div>
                  ) : null}
                </div>

                <div style={{
                  display: 'inline-block',
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '4px 8px',
                  borderRadius: 6,
                  background: conv.respondidoPor === 'ADMIN_MANUAL' ? '#dbeafe' : conv.escalado ? '#fed7aa' : '#dcfce7',
                  color: conv.respondidoPor === 'ADMIN_MANUAL' ? '#0369a1' : conv.escalado ? '#b45309' : '#15803d'
                }}>
                  {conv.respondidoPor === 'ADMIN_MANUAL' ? '👤 Manual' : conv.escalado ? '⚠️ Escalado' : '✓ Automático'}
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
                      {caso.createdAt?.seconds ? new Date(caso.createdAt.seconds * 1000).toLocaleString() : ''}
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
// FIN VencimientosAnny.js
