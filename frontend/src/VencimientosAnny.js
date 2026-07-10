// ============================================================
// Control360 — WhatsApp IA Anny Dashboard
// Ubicación: frontend/src/VencimientosAnny.js
// FIX ANNY-GATE-002 + ANNY-QR-001 + ANNY-LEARN-002 + ANNY-UI-001
// FIX ANNY-PEDIDOS-001: pestaña 🛒 Pedidos + aviso configurable
// FIX ANNY-VENC-001: ronda de vencimientos + días configurables
// ============================================================

import React, { useState, useEffect, useRef } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

export default function VencimientosAnny() {
  const [metricas, setMetricas] = useState(null);
  const [casos, setCasos] = useState([]);
  const [config, setConfig] = useState(null);
  const [activo, setActivo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('metricas'); // metricas | conversaciones | pedidos | casos | entrenamiento
  const [diasAntes, setDiasAntes] = useState(30);
  const [horaEnvio, setHoraEnvio] = useState('09:00');
  const [guardando, setGuardando] = useState(false);

  // FIX ANNY-PEDIDOS-001 / ANNY-VENC-001: configuración extendida
  const [notificarPedidosA, setNotificarPedidosA] = useState('');
  const [diasRonda, setDiasRonda] = useState('');
  const [topeRonda, setTopeRonda] = useState(60);

  // FIX ANNY-QR-001: conexión WhatsApp
  const [conexion, setConexion] = useState({ estado: 'desconectado', numero: null });
  const [qrImg, setQrImg] = useState(null);
  const [conectando, setConectando] = useState(false);
  const pollRef = useRef(null);

  // FIX ANNY-LEARN-002: entrenamiento
  const [respuestas, setRespuestas] = useState({});
  const [formKey, setFormKey] = useState(null);
  const [formPatrones, setFormPatrones] = useState('');
  const [formRespuesta, setFormRespuesta] = useState('');
  const [guardandoResp, setGuardandoResp] = useState(false);

  // FIX ANNY-UI-001: chats agrupados
  const [chats, setChats] = useState([]);
  const [chatAbierto, setChatAbierto] = useState(null);
  const [hilo, setHilo] = useState([]);
  const [cargandoHilo, setCargandoHilo] = useState(false);

  // FIX ANNY-PEDIDOS-001: bandeja de pedidos
  const [pedidos, setPedidos] = useState([]);

  // FIX ANNY-VENC-001: ronda de vencimientos
  const [enviandoRonda, setEnviandoRonda] = useState(false);

  useEffect(() => {
    cargarDatos();
    const interval = setInterval(cargarDatos, 30000);
    return () => {
      clearInterval(interval);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (!chatAbierto) return;
    cargarHilo(chatAbierto);
    const t = setInterval(() => cargarHilo(chatAbierto), 15000);
    return () => clearInterval(t);
  }, [chatAbierto]);

  const cargarDatos = async () => {
    try {
      const res = await fetch(`${API}/anny/config`, { headers: authHeaders() });

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
        setNotificarPedidosA(cfg.notificarPedidosA || '');
        setDiasRonda(cfg.diasRondaVencimientos || '');
        setTopeRonda(cfg.topeDiarioRonda || 60);
      }

      if (cfg?.activo !== true) {
        setLoading(false);
        return;
      }

      const [m, ch, cas, est, resp, ped] = await Promise.all([
        fetch(`${API}/anny/metricas`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/anny/chats`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
        fetch(`${API}/anny/casos-escalados?estado=pendiente`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/anny/estado`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null),
        fetch(`${API}/anny/respuestas`, { headers: authHeaders() }).then(r => r.ok ? r.json() : {}),
        fetch(`${API}/anny/pedidos?estado=todos`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []), // FIX ANNY-PEDIDOS-001
      ]);

      setMetricas(m);
      setChats(Array.isArray(ch) ? ch : []);
      setCasos(Array.isArray(cas) ? cas : []);
      if (est) setConexion(est);
      if (resp && typeof resp === 'object') setRespuestas(resp);
      setPedidos(Array.isArray(ped) ? ped : []);
    } catch (err) {
      console.error('Error cargando datos Anny:', err);
      setActivo(false);
    } finally {
      setLoading(false);
    }
  };

  const cargarHilo = async (telefono) => {
    setCargandoHilo(true);
    try {
      const r = await fetch(`${API}/anny/chats/${telefono}`, { headers: authHeaders() });
      if (r.ok) {
        const data = await r.json();
        setHilo(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Error cargando hilo:', err);
    } finally {
      setCargandoHilo(false);
    }
  };

  // ============================================================
  // FIX ANNY-QR-001: conexión WhatsApp
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

  // ============================================================
  // FIX ANNY-VENC-001: ronda de vencimientos manual
  // ============================================================
  const enviarRondaAhora = async () => {
    if (!window.confirm(`¿Enviar ronda de vencimientos AHORA?\n\nSe enviarán máximo ${topeRonda} mensajes (1 cada 45 segundos) a clientes con equipos vencidos sin gestionar. Cada cliente recibe máximo una ronda cada 12 días.`)) return;

    setEnviandoRonda(true);
    try {
      const res = await fetch(`${API}/anny/vencimientos/ronda`, { method: 'POST', headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        alert(`📤 ${data.mensaje || `Ronda iniciada: ${data.encolados} mensajes en cola.`}`);
      } else {
        alert(`❌ ${data.mensaje || data.error || 'Error iniciando la ronda'}`);
      }
    } catch (err) {
      console.error('Error iniciando ronda:', err);
      alert('❌ Error iniciando la ronda');
    } finally {
      setEnviandoRonda(false);
    }
  };

  // ============================================================
  // FIX ANNY-PEDIDOS-001: gestión de pedidos
  // ============================================================
  const actualizarPedido = async (id, estado) => {
    try {
      const res = await fetch(`${API}/anny/pedidos/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ estado })
      });
      if (res.ok) await cargarDatos();
    } catch (err) {
      console.error('Error actualizando pedido:', err);
    }
  };

  // ============================================================
  // FIX ANNY-LEARN-002: entrenamiento
  // ============================================================
  const abrirFormNueva = () => {
    setFormKey('nueva');
    setFormPatrones('');
    setFormRespuesta('');
  };

  const editarRespuesta = (key) => {
    const r = respuestas[key];
    if (!r) return;
    setFormKey(key);
    setFormPatrones((r.patrones || []).join(', '));
    setFormRespuesta(r.respuesta || '');
  };

  const ensenarAnny = (caso) => {
    setFormKey('nueva');
    setFormPatrones((caso.mensajeCliente || '').toLowerCase());
    setFormRespuesta(caso.respuestaAdmin || '');
    setActiveTab('entrenamiento');
  };

  const guardarRespuesta = async () => {
    const patrones = formPatrones.split(',').map(p => p.trim()).filter(p => p.length > 1);
    if (patrones.length === 0 || !formRespuesta.trim()) {
      alert('Agrega al menos un patrón (frase del cliente) y la respuesta de Anny');
      return;
    }

    setGuardandoResp(true);
    try {
      const key = formKey === 'nueva' ? `custom_${Date.now()}` : formKey;
      const res = await fetch(`${API}/anny/respuestas`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ key, patrones, respuesta: formRespuesta.trim(), tipo: 'CUSTOM' })
      });

      if (res.ok) {
        setFormKey(null);
        await cargarDatos();
        alert('✅ Anny aprendió esta respuesta — ya la usa en WhatsApp');
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`❌ ${err.error || 'Error guardando'}`);
      }
    } catch (err) {
      console.error('Error guardando respuesta:', err);
      alert('❌ Error guardando');
    } finally {
      setGuardandoResp(false);
    }
  };

  const eliminarRespuesta = async (key) => {
    if (!window.confirm('¿Eliminar esta respuesta? Anny dejará de usarla.')) return;
    try {
      const res = await fetch(`${API}/anny/respuestas/${key}`, { method: 'DELETE', headers: authHeaders() });
      if (res.ok) await cargarDatos();
    } catch (err) {
      console.error('Error eliminando respuesta:', err);
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
          horaEnvio,
          notificarPedidosA,
          diasRondaVencimientos: diasRonda,
          topeDiarioRonda: Number(topeRonda)
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
  const pedidosNuevos = pedidos.filter(p => p.estado === 'NUEVO');
  const conectado = conexion.estado === 'conectado';
  const listaRespuestas = Object.entries(respuestas || {});
  const chatActual = chats.find(c => c.telefono === chatAbierto);

  const fmtFecha = (createdAt) =>
    createdAt?.seconds ? new Date(createdAt.seconds * 1000).toLocaleString() : '';
  const fmtHora = (createdAt) =>
    createdAt?.seconds ? new Date(createdAt.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const inputStyle = { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 };

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
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
        {[
          { id: 'metricas', label: '📊 Métricas' },
          { id: 'conversaciones', label: '💬 Conversaciones' },
          { id: 'pedidos', label: '🛒 Pedidos', badge: pedidosNuevos.length },
          { id: 'casos', label: '⚠️ Casos Escalados', badge: pendientes.length },
          { id: 'entrenamiento', label: '🧠 Entrenamiento' }
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
          {/* Conexión WhatsApp */}
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

          {/* FIX ANNY-VENC-001: Ronda de vencimientos */}
          <div style={{ background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 12, padding: 20, marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ maxWidth: 520 }}>
                <h3 style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', marginBottom: 6 }}>
                  📤 Ronda de vencimientos
                </h3>
                <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
                  Envía recordatorio a clientes con equipos <strong>vencidos sin gestionar</strong>.
                  Automática los días {diasRonda || '(configura los días abajo)'} a las {horaEnvio}, o dispárala ahora.
                  Tope: {topeRonda}/día, 1 mensaje cada 45s, máximo una ronda cada 12 días por cliente.
                </div>
              </div>
              <button
                onClick={enviarRondaAhora}
                disabled={enviandoRonda || !conectado}
                style={{ padding: '12px 20px', border: 'none', borderRadius: 8, background: conectado ? '#2563eb' : '#9ca3af', color: '#fff', fontWeight: 700, fontSize: 13, cursor: conectado ? 'pointer' : 'not-allowed', opacity: enviandoRonda ? 0.6 : 1 }}
              >
                {enviandoRonda ? 'Iniciando...' : '📤 Enviar ronda ahora'}
              </button>
            </div>
          </div>

          {/* Cards de métricas */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
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

            <div style={{ background: '#fce7f3', border: '1px solid #f9a8d4', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#be185d', textTransform: 'uppercase', marginBottom: 8 }}>
                🛒 Pedidos hoy
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#be185d' }}>
                {metricas?.pedidos || 0}
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
                <label style={labelStyle}>Días antes de recordar</label>
                <input type="number" value={diasAntes} onChange={e => setDiasAntes(e.target.value)} style={inputStyle} />
              </div>

              <div>
                <label style={labelStyle}>Hora de envío</label>
                <input type="time" value={horaEnvio} onChange={e => setHoraEnvio(e.target.value)} style={inputStyle} />
              </div>

              {/* FIX ANNY-PEDIDOS-001 */}
              <div>
                <label style={labelStyle}>📲 WhatsApp para avisos de venta (pedidos)</label>
                <input
                  type="text"
                  value={notificarPedidosA}
                  onChange={e => setNotificarPedidosA(e.target.value)}
                  placeholder="ej: 3117762773"
                  style={inputStyle}
                />
              </div>

              {/* FIX ANNY-VENC-001 */}
              <div>
                <label style={labelStyle}>📤 Días de ronda de vencimientos (del mes)</label>
                <input
                  type="text"
                  value={diasRonda}
                  onChange={e => setDiasRonda(e.target.value)}
                  placeholder="ej: 1,20 (separados por coma)"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Tope de mensajes por ronda/día</label>
                <input
                  type="number"
                  value={topeRonda}
                  onChange={e => setTopeRonda(e.target.value)}
                  min={10}
                  max={150}
                  style={inputStyle}
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
        <div>
          {chatAbierto ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <button
                  onClick={() => { setChatAbierto(null); setHilo([]); }}
                  style={{ padding: '8px 14px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
                >
                  ‹ Volver
                </button>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: '#1a1a2e' }}>
                    {chatActual?.nombreCliente || chatAbierto}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{chatAbierto}</div>
                </div>
              </div>

              <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, maxHeight: 520, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {cargandoHilo && hilo.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Cargando conversación...</div>
                ) : hilo.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Sin mensajes</div>
                ) : (
                  hilo.map((c, i) => (
                    <React.Fragment key={c.id || i}>
                      {c.mensajeCliente ? (
                        <div style={{ alignSelf: 'flex-start', maxWidth: '75%', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px 12px 12px 4px', padding: '8px 12px' }}>
                          <div style={{ fontSize: 13, color: '#374151' }}>{c.mensajeCliente}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>{fmtHora(c.createdAt)}</div>
                        </div>
                      ) : null}
                      {c.respuestaAgente ? (
                        <div style={{
                          alignSelf: 'flex-end',
                          maxWidth: '75%',
                          background: c.respondidoPor === 'ADMIN_MANUAL' ? '#dbeafe' : c.respondidoPor === 'NOTIFICACION_SISTEMA' ? '#fef9c3' : '#ede9fe',
                          border: `1px solid ${c.respondidoPor === 'ADMIN_MANUAL' ? '#93c5fd' : c.respondidoPor === 'NOTIFICACION_SISTEMA' ? '#fde047' : '#ddd6fe'}`,
                          borderRadius: '12px 12px 4px 12px',
                          padding: '8px 12px'
                        }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: c.respondidoPor === 'ADMIN_MANUAL' ? '#0369a1' : c.respondidoPor === 'NOTIFICACION_SISTEMA' ? '#a16207' : '#6d28d9', marginBottom: 2 }}>
                            {c.respondidoPor === 'ADMIN_MANUAL' ? '👤 Tú' : c.respondidoPor === 'NOTIFICACION_SISTEMA' ? '🔔 Sistema' : '🤖 Anny'}
                          </div>
                          <div style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap' }}>{c.respuestaAgente}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, textAlign: 'right' }}>{fmtHora(c.createdAt)}</div>
                        </div>
                      ) : null}
                    </React.Fragment>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {chats.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>
                  Sin conversaciones aún
                </div>
              ) : (
                chats.map((chat) => (
                  <div
                    key={chat.telefono}
                    onClick={() => setChatAbierto(chat.telefono)}
                    style={{
                      background: '#f9fafb',
                      border: '1px solid #e5e7eb',
                      borderRadius: 10,
                      padding: 14,
                      borderLeft: `4px solid ${chat.escalado ? '#f59e0b' : '#7c3aed'}`,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#1a1a2e' }}>
                        {chat.nombreCliente || chat.telefono}
                        {chat.escalado ? <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fed7aa', color: '#b45309' }}>⚠️ Escalado</span> : null}
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 480 }}>
                        {chat.ultimoTexto}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtFecha(chat.ultimaFecha)}</div>
                      <div style={{ fontSize: 11, color: '#7c3aed', fontWeight: 700, marginTop: 4 }}>
                        {chat.mensajes} mensaje{chat.mensajes === 1 ? '' : 's'} ›
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* =============== TAB: PEDIDOS (FIX ANNY-PEDIDOS-001) =============== */}
      {activeTab === 'pedidos' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {pedidos.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>
              Sin pedidos aún — cuando Anny cierre una venta con datos completos, aparecerá aquí
            </div>
          ) : (
            pedidos.map((p) => (
              <div key={p.id} style={{
                background: p.estado === 'NUEVO' ? '#fdf2f8' : '#f9fafb',
                border: `1px solid ${p.estado === 'NUEVO' ? '#f9a8d4' : '#e5e7eb'}`,
                borderRadius: 10,
                padding: 16,
                borderLeft: `4px solid ${p.estado === 'NUEVO' ? '#ec4899' : p.estado === 'ORDEN_CREADA' ? '#16a34a' : '#9ca3af'}`
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 14, color: '#1a1a2e' }}>
                      🛒 {p.producto || 'Pedido'}{p.cantidad > 1 ? ` x${p.cantidad}` : ''}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{fmtFecha(p.createdAt)}</div>
                  </div>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: p.estado === 'NUEVO' ? '#fce7f3' : p.estado === 'ORDEN_CREADA' ? '#dcfce7' : '#f3f4f6',
                    color: p.estado === 'NUEVO' ? '#be185d' : p.estado === 'ORDEN_CREADA' ? '#15803d' : '#6b7280'
                  }}>
                    {p.estado === 'NUEVO' ? '🆕 Nuevo' : p.estado === 'ORDEN_CREADA' ? '✓ Orden creada' : 'Descartado'}
                  </div>
                </div>

                <div style={{ background: '#fff', borderRadius: 8, padding: 12, fontSize: 12, color: '#374151', lineHeight: 1.7, marginBottom: 10 }}>
                  <div>💰 <strong>Total:</strong> {p.total || '—'}</div>
                  <div>👤 <strong>Cliente:</strong> {p.nombreCliente || '—'} — {p.telefonoContacto || p.telefono || '—'}</div>
                  <div>🪪 <strong>Cédula/NIT:</strong> {p.cedulaNit || '—'}</div>
                  <div>📧 <strong>Correo:</strong> {p.correo || '—'}</div>
                  <div>📍 <strong>Dirección:</strong> {p.direccion || '—'}{p.barrio ? `, ${p.barrio}` : ''}</div>
                  <div>📅 <strong>Fecha:</strong> {p.fecha || '—'}</div>
                </div>

                {p.estado === 'NUEVO' ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => actualizarPedido(p.id, 'ORDEN_CREADA')}
                      style={{ flex: 1, padding: '10px 12px', border: 'none', borderRadius: 6, background: '#dcfce7', color: '#15803d', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                    >
                      ✓ Ya creé la orden
                    </button>
                    <button
                      onClick={() => actualizarPedido(p.id, 'DESCARTADO')}
                      style={{ padding: '10px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#6b7280', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                    >
                      Descartar
                    </button>
                  </div>
                ) : null}
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
                      {fmtFecha(caso.createdAt)}
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
                  <button
                    onClick={() => ensenarAnny(caso)}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      border: 'none',
                      borderRadius: 6,
                      background: '#ede9fe',
                      color: '#6d28d9',
                      fontWeight: 700,
                      fontSize: 12,
                      cursor: 'pointer'
                    }}
                  >
                    🧠 Enseñar a Anny
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* =============== TAB: ENTRENAMIENTO =============== */}
      {activeTab === 'entrenamiento' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 12, color: '#6b7280', maxWidth: 520, lineHeight: 1.5 }}>
              Estas son las respuestas que Anny usa al instante (sin IA). Los <strong>patrones</strong> son
              frases que escribe el cliente; si el mensaje contiene alguna, Anny responde con tu texto.
              La IA también las usa como base de conocimiento para preguntas más elaboradas.
            </div>
            <button
              onClick={abrirFormNueva}
              style={{ padding: '10px 16px', border: 'none', borderRadius: 8, background: '#7c3aed', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
            >
              + Nueva respuesta
            </button>
          </div>

          {formKey !== null && (
            <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', marginBottom: 12 }}>
                {formKey === 'nueva' ? '🧠 Enseñar nueva respuesta a Anny' : '✏️ Editar respuesta'}
              </h3>

              <label style={labelStyle}>Frases del cliente (separadas por coma)</label>
              <input
                type="text"
                value={formPatrones}
                onChange={e => setFormPatrones(e.target.value)}
                placeholder="ej: extintor del carro, extintor de carro, extintor vehicular"
                style={{ ...inputStyle, marginBottom: 12 }}
              />

              <label style={labelStyle}>Respuesta de Anny</label>
              <textarea
                value={formRespuesta}
                onChange={e => setFormRespuesta(e.target.value)}
                rows={4}
                placeholder="ej: Para el extintor de tu carro es una recarga ABC 5 lb: $19.000. ¿Te lo recogemos a domicilio?"
                style={{ ...inputStyle, marginBottom: 12, fontFamily: 'inherit', resize: 'vertical' }}
              />

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={guardarRespuesta}
                  disabled={guardandoResp}
                  style={{ flex: 1, padding: '12px 0', border: 'none', borderRadius: 8, background: '#7c3aed', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: guardandoResp ? 0.6 : 1 }}
                >
                  {guardandoResp ? 'Guardando...' : '✓ Guardar — Anny la usa de inmediato'}
                </button>
                <button
                  onClick={() => setFormKey(null)}
                  style={{ padding: '12px 20px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', color: '#6b7280', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {listaRespuestas.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>
                Sin respuestas configuradas aún
              </div>
            ) : (
              listaRespuestas.map(([key, r]) => (
                <div key={key} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, borderLeft: '4px solid #7c3aed' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {(r.patrones || []).map((p, idx) => (
                      <span key={idx} style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: '#ede9fe', color: '#6d28d9' }}>
                        {p}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap', marginBottom: 10 }}>
                    {r.respuesta}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => editarRespuesta(key)}
                      style={{ padding: '6px 14px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', color: '#374151', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                    >
                      ✏️ Editar
                    </button>
                    <button
                      onClick={() => eliminarRespuesta(key)}
                      style={{ padding: '6px 14px', border: '1px solid #fecaca', borderRadius: 6, background: '#fef2f2', color: '#b91c1c', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                    >
                      🗑 Eliminar
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
// FIN VencimientosAnny.js
