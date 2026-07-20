// ============================================================
// Control360 — Llamadas IA (Lucy)
// Vista: resumen del mes + lista de llamadas, cierres resaltados
// en verde con acceso directo a "Crear orden" (mismo patrón que
// Telemercadeo → NuevaOrden.js, usando sessionStorage).
//
// ✅ FIX LUCY-ELEVEN-004 (2026-07-19) — controles de operación
// (pedido de Sandra, mismo patrón que Anny):
//   · "Lanzar ahora": corre el motor SOLO para este tenant, ya.
//   · "Programar": elige día y hora (hora Colombia) — el backend
//     ejecuta la corrida automáticamente a esa hora.
//   · "Llamada de prueba": Lucy llama a un número puntual con
//     datos de ejemplo (validar guion/voz sin clientes reales).
//   · Barra de consumo: minutos usados vs tope del mes.
// Solo visible para rol admin (los sub-usuarios ven la lista).
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

const RESULTADOS = {
  cerrada:           { label: 'Cierre confirmado', bg: '#dcfce7', color: '#15803d', icon: '✅' },
  reagendada:        { label: 'Reagendada',         bg: '#e0f2fe', color: '#0369a1', icon: '📅' },
  inactivo_cliente:  { label: 'Cliente inactivo',   bg: '#f3f4f6', color: '#6b7280', icon: '🚫' },
  escalado_asesor:   { label: 'Escalado a asesor',  bg: '#fff8e6', color: '#b45309', icon: '👤' },
  no_interesado:     { label: 'No interesado',      bg: '#fee2e2', color: '#b91c1c', icon: '✕' },
  sin_respuesta:     { label: 'No contestó',        bg: '#f3f4f6', color: '#6b7280', icon: '📵' },
};
const EN_CURSO = { label: 'En curso', bg: '#ede9fe', color: '#7c3aed', icon: '☎' };

const telBonito = (t) => {
  if (!t) return '';
  const s = String(t).replace(/^57/, '');
  return s.length === 10 ? `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}` : s;
};

const formatFecha = (d) => {
  if (!d?.seconds) return '';
  const f = new Date(d.seconds * 1000);
  return f.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export default function LlamadasIA({ user, onNavegar }) {
  const [lista, setLista] = useState([]);
  const [resumen, setResumen] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [activa, setActiva] = useState(null);
  const [config, setConfig] = useState(null); // { topeMinutosMes, minutosConsumidosMes }
  const [filtroResultado, setFiltroResultado] = useState('');
  const [detalle, setDetalle] = useState(null);

  // FIX LUCY-ELEVEN-004: estado de los controles de operación
  const [programadas, setProgramadas] = useState([]);
  const [modalProgramar, setModalProgramar] = useState(false);
  const [modalPrueba, setModalPrueba] = useState(false);
  const [progFecha, setProgFecha] = useState('');
  const [progHora, setProgHora] = useState('09:00');
  const [telPrueba, setTelPrueba] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState(null); // { tipo: 'ok'|'error', texto }

  const esAdmin = user?.role === 'admin' || user?.superAdmin;

  const mostrarAviso = (tipo, texto) => {
    setAviso({ tipo, texto });
    setTimeout(() => setAviso(null), 6000);
  };

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const [r1, r2, r3, r4] = await Promise.all([
        fetch(`${API}/llamadas-ia/resumen`, { headers: authHeaders() }),
        fetch(`${API}/llamadas-ia`, { headers: authHeaders() }),
        fetch(`${API}/llamadas-ia/config`, { headers: authHeaders() }),
        fetch(`${API}/llamadas-ia/programadas`, { headers: authHeaders() }),
      ]);
      const [res, lst, cfg, prog] = await Promise.all([r1.json(), r2.json(), r3.json(), r4.json()]);
      setResumen(res);
      setLista(Array.isArray(lst) ? lst : []);
      setActiva(!!cfg?.activo);
      setConfig(cfg);
      setProgramadas(Array.isArray(prog) ? prog.filter(p => p.estado === 'pendiente') : []);
    } catch (e) { console.error(e); }
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // ─── Acciones de operación (FIX LUCY-ELEVEN-004) ───────────────────────────
  const lanzarAhora = async () => {
    if (!window.confirm('¿Lanzar las llamadas de vencimientos de TU empresa ahora? Lucy llamará a los clientes pendientes de este mes.')) return;
    setOcupado(true);
    try {
      const r = await fetch(`${API}/llamadas-ia/ejecutar-motor`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({}) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error al lanzar el motor');
      mostrarAviso('ok', `Motor ejecutado: ${data.llamadasLanzadas || 0} llamada(s) lanzada(s)${data.omitidasPorTope ? ` · ${data.omitidasPorTope} omitida(s) por tope de minutos` : ''}`);
      cargar();
    } catch (e) { mostrarAviso('error', e.message); }
    setOcupado(false);
  };

  const programarCorrida = async () => {
    if (!progFecha || !progHora) { mostrarAviso('error', 'Elige fecha y hora'); return; }
    setOcupado(true);
    try {
      const r = await fetch(`${API}/llamadas-ia/programar`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ fecha: progFecha, hora: progHora }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error al programar');
      mostrarAviso('ok', `Corrida programada para el ${progFecha} a las ${progHora} (hora Colombia)`);
      setModalProgramar(false);
      setProgFecha('');
      cargar();
    } catch (e) { mostrarAviso('error', e.message); }
    setOcupado(false);
  };

  const cancelarProgramada = async (id) => {
    if (!window.confirm('¿Cancelar esta corrida programada?')) return;
    try {
      const r = await fetch(`${API}/llamadas-ia/programadas/${id}`, { method: 'DELETE', headers: authHeaders() });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error al cancelar');
      cargar();
    } catch (e) { mostrarAviso('error', e.message); }
  };

  const lanzarPrueba = async () => {
    const tel = telPrueba.replace(/\D/g, '');
    if (tel.length !== 10 || !tel.startsWith('3')) { mostrarAviso('error', 'Escribe un celular colombiano de 10 dígitos'); return; }
    setOcupado(true);
    try {
      const r = await fetch(`${API}/llamadas-ia/llamada-prueba`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ telefono: tel }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error al lanzar la prueba');
      mostrarAviso('ok', data.mensaje || 'Llamada de prueba lanzada — tu teléfono sonará en unos segundos');
      setModalPrueba(false);
      setTelPrueba('');
      cargar();
    } catch (e) { mostrarAviso('error', e.message); }
    setOcupado(false);
  };

  const listaFiltrada = filtroResultado
    ? lista.filter(l => l.resultado === filtroResultado)
    : lista;

  // ─── Llevar el cierre de Lucy a NuevaOrden — MISMO mecanismo que
  // ModuloComercial.js (sessionStorage 'c360_orden_prefill' + onNavegar).
  const crearOrdenDesdeCierre = (registro) => {
    if (!registro.clienteId) {
      alert('Este cliente todavía no existe en Control360. Créalo primero en el módulo Clientes con los datos de abajo, y luego genera la orden desde allí.');
      return;
    }
    const dc = registro.datosCierre || {};
    const prefill = {
      id: registro.clienteId,
      nombre: (dc.nombreCompleto || '').toUpperCase(),
      nit: dc.nit || '',
      celular: dc.celular || registro.telefono || '',
      empresaId: '',
    };
    sessionStorage.setItem('c360_orden_prefill', JSON.stringify(prefill));
    if (onNavegar) onNavegar('ordenes');
  };

  const inp = { width: '100%', padding: '9px 10px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' };
  const btnAccion = { border: 'none', borderRadius: 10, padding: '10px 16px', fontWeight: 800, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' };

  // ─── Estado: Lucy no activada para este tenant ─────────────────────────────
  if (activa === false) {
    return (
      <div style={{ padding: '12px 12px 80px', maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 12, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32 }}>☎️</div>
          <div style={{ fontWeight: 800, color: '#1a1a2e', marginTop: 8, fontSize: 15 }}>Llamadas IA (Lucy) no está activa</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, maxWidth: 360, marginLeft: 'auto', marginRight: 'auto' }}>
            Este módulo se activa manualmente por nuestro equipo. Si te interesa automatizar el seguimiento de vencimientos con llamadas, contáctanos.
          </div>
        </div>
      </div>
    );
  }

  const pctConsumo = config?.topeMinutosMes
    ? Math.min(100, Math.round(((config.minutosConsumidosMes || 0) / config.topeMinutosMes) * 100))
    : 0;

  return (
    <div style={{ padding: '12px 12px 80px', maxWidth: 1100, margin: '0 auto' }}>

      {/* Header + controles de operación */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1a1a2e' }}>☎️ Llamadas IA — Lucy</h1>
          <div style={{ fontSize: 11, color: '#6b7280' }}>Seguimiento automático de vencimientos por voz</div>
        </div>
        {esAdmin && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={lanzarAhora} disabled={ocupado}
              style={{ ...btnAccion, background: '#1a1a2e', color: '#fff', opacity: ocupado ? 0.6 : 1 }}>
              📞 Lanzar ahora
            </button>
            <button onClick={() => setModalProgramar(true)} disabled={ocupado}
              style={{ ...btnAccion, background: '#e0f2fe', color: '#0369a1' }}>
              🗓 Programar
            </button>
            <button onClick={() => setModalPrueba(true)} disabled={ocupado}
              style={{ ...btnAccion, background: '#fff8e6', color: '#b45309' }}>
              🧪 Llamada de prueba
            </button>
          </div>
        )}
      </div>

      {/* Aviso de resultado de acciones */}
      {aviso && (
        <div style={{
          background: aviso.tipo === 'ok' ? '#dcfce7' : '#fee2e2',
          color: aviso.tipo === 'ok' ? '#15803d' : '#b91c1c',
          borderRadius: 10, padding: '10px 14px', fontSize: 12.5, fontWeight: 700, marginBottom: 12,
        }}>
          {aviso.texto}
        </div>
      )}

      {/* Barra de consumo de minutos (FIX LUCY-ELEVEN-004) */}
      {config?.topeMinutosMes ? (
        <div style={{ background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 12, padding: '10px 14px', marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 6 }}>
            <span style={{ fontWeight: 700, color: '#374151' }}>Minutos del mes</span>
            <span style={{ color: pctConsumo >= 90 ? '#b91c1c' : '#6b7280', fontWeight: 700 }}>
              {config.minutosConsumidosMes || 0} / {config.topeMinutosMes} min
            </span>
          </div>
          <div style={{ background: '#f3f4f6', borderRadius: 99, height: 8, overflow: 'hidden' }}>
            <div style={{ width: `${pctConsumo}%`, height: '100%', borderRadius: 99, background: pctConsumo >= 90 ? '#ef4444' : pctConsumo >= 70 ? '#f59e0b' : '#22c55e', transition: 'width .3s' }} />
          </div>
        </div>
      ) : null}

      {/* Corridas programadas pendientes */}
      {esAdmin && programadas.length > 0 && (
        <div style={{ background: '#eff6ff', border: '1.5px solid #bfdbfe', borderRadius: 12, padding: '10px 14px', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 11, color: '#1d4ed8', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
            🗓 Corridas programadas
          </div>
          {programadas.map(p => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, padding: '4px 0' }}>
              <span style={{ color: '#1e3a8a', fontWeight: 700 }}>
                {p.fechaHora?.replace('T', ' · ')} (hora Colombia)
              </span>
              <button onClick={() => cancelarProgramada(p.id)}
                style={{ border: 'none', background: 'transparent', color: '#b91c1c', fontWeight: 700, fontSize: 11.5, cursor: 'pointer' }}>
                Cancelar
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tarjetas resumen */}
      {resumen && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 8, marginBottom: 14 }}>
          <div style={{ background: '#f9fafb', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: '#6b7280' }}>Total llamadas</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#1a1a2e' }}>{resumen.total || 0}</div>
          </div>
          <div style={{ background: '#dcfce7', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: '#15803d' }}>Cierres</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#15803d' }}>{resumen.cerrada || 0}</div>
          </div>
          <div style={{ background: '#e0f2fe', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: '#0369a1' }}>Reagendadas</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#0369a1' }}>{resumen.reagendada || 0}</div>
          </div>
          <div style={{ background: '#fff8e6', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: '#b45309' }}>Escaladas</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#b45309' }}>{resumen.escalado_asesor || 0}</div>
          </div>
          <div style={{ background: '#f3f4f6', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: '#6b7280' }}>No contestó</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#6b7280' }}>{resumen.sin_respuesta || 0}</div>
          </div>
        </div>
      )}

      {/* Filtros por resultado */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button onClick={() => setFiltroResultado('')} style={{ border: `2px solid ${!filtroResultado ? '#1a1a2e' : 'transparent'}`, background: !filtroResultado ? '#1a1a2e' : '#fff', color: !filtroResultado ? '#fff' : '#374151', borderRadius: 99, padding: '5px 14px', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
          Todas
        </button>
        {Object.entries(RESULTADOS).map(([k, v]) => (
          <button key={k} onClick={() => setFiltroResultado(filtroResultado === k ? '' : k)} style={{ border: `2px solid ${filtroResultado === k ? v.color : 'transparent'}`, background: v.bg, color: v.color, borderRadius: 99, padding: '5px 14px', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
            {v.icon} {v.label}
          </button>
        ))}
      </div>

      {/* Lista de llamadas */}
      {cargando ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Cargando...</div>
      ) : listaFiltrada.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 40, textAlign: 'center', border: '1.5px solid #e5e7eb' }}>
          <div style={{ fontSize: 32 }}>☎️</div>
          <div style={{ fontWeight: 700, color: '#1a1a2e', marginTop: 8 }}>Sin llamadas todavía</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Lucy llama automáticamente los primeros días hábiles de cada mes — o usa "Lanzar ahora"</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {listaFiltrada.map(reg => {
            const esCierre = reg.resultado === 'cerrada';
            const r = RESULTADOS[reg.resultado] || (reg.estado === 'en_curso' ? EN_CURSO : RESULTADOS.sin_respuesta);
            return (
              <div key={reg.id} onClick={() => setDetalle(reg)}
                style={{
                  background: esCierre ? '#f0fdf4' : '#fff',
                  border: esCierre ? '2px solid #4ade80' : '1.5px solid #e5e7eb',
                  borderRadius: 12, padding: '12px 14px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
                }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 800, fontSize: 13, color: '#1a1a2e' }}>
                      {reg.esPrueba ? '🧪 Llamada de prueba' : (reg.datosCierre?.nombreCompleto || telBonito(reg.telefono) || 'Sin nombre')}
                    </span>
                    <span style={{ background: r.bg, color: r.color, fontWeight: 800, fontSize: 10, padding: '2px 9px', borderRadius: 8 }}>
                      {r.icon} {r.label}
                    </span>
                    {reg.intento > 1 && (
                      <span style={{ background: '#f3f4f6', color: '#6b7280', fontWeight: 700, fontSize: 10, padding: '2px 8px', borderRadius: 8 }}>
                        Intento {reg.intento}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#6b7280' }}>
                    {telBonito(reg.telefono)}{reg.duracionSegundos ? ` · ${Math.round(reg.duracionSegundos / 60)} min` : ''} · {formatFecha(reg.createdAt)}
                  </div>
                </div>
                {esCierre && (
                  <button onClick={(e) => { e.stopPropagation(); crearOrdenDesdeCierre(reg); }}
                    style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontWeight: 700, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    + Crear orden
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal detalle — incluye transcripción para auditoría del suscriptor */}
      {detalle && (
        <div onClick={() => setDetalle(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 400, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 540, maxHeight: '85vh', overflowY: 'auto', padding: '18px 18px 28px' }}>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: '#1a1a2e' }}>
                  {detalle.esPrueba ? '🧪 Llamada de prueba' : (detalle.datosCierre?.nombreCompleto || telBonito(detalle.telefono))}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{formatFecha(detalle.createdAt)}</div>
              </div>
              <button onClick={() => setDetalle(null)} style={{ border: 'none', background: '#f3f4f6', borderRadius: 8, width: 30, height: 30, cursor: 'pointer' }}>✕</button>
            </div>

            {detalle.datosCierre && (
              <div style={{ background: '#f0fdf4', border: '1.5px solid #4ade80', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 11, color: '#15803d', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  ✅ Datos recolectados por Lucy
                </div>
                {[
                  ['Empresa', detalle.datosCierre.empresa],
                  ['NIT', detalle.datosCierre.nit],
                  ['Dirección', detalle.datosCierre.direccion],
                  ['Barrio', detalle.datosCierre.barrio],
                  ['Celular', telBonito(detalle.datosCierre.celular)],
                  ['Email', detalle.datosCierre.email],
                  ['Tipo de servicio', detalle.datosCierre.tipoServicio],
                  ['Día acordado', detalle.datosCierre.diaAcordado],
                  ['Franja horaria', detalle.datosCierre.franjaHoraria],
                ].filter(([, v]) => v).map(([label, valor]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0' }}>
                    <span style={{ color: '#374151' }}>{label}</span>
                    <span style={{ fontWeight: 700, color: '#1a1a2e' }}>{valor}</span>
                  </div>
                ))}
                {!detalle.esPrueba && (
                  <button onClick={() => crearOrdenDesdeCierre(detalle)}
                    style={{ width: '100%', marginTop: 10, background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 0', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                    + Crear orden con estos datos
                  </button>
                )}
              </div>
            )}

            {detalle.resumenIA && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 11, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  🤖 Resumen de la llamada
                </div>
                <div style={{ background: '#f5f3ff', borderRadius: 10, padding: '12px 14px', fontSize: 12.5, color: '#374151', lineHeight: 1.6 }}>
                  {detalle.resumenIA}
                </div>
              </div>
            )}

            {detalle.transcripcion && (
              <div>
                <div style={{ fontWeight: 800, fontSize: 11, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  📝 Transcripción completa
                </div>
                <div style={{ background: '#f9fafb', borderRadius: 10, padding: '12px 14px', fontSize: 12.5, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {detalle.transcripcion}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Programar (FIX LUCY-ELEVEN-004) */}
      {modalProgramar && (
        <div onClick={() => setModalProgramar(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 380, padding: '20px 18px' }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#1a1a2e', marginBottom: 4 }}>🗓 Programar llamadas</div>
            <div style={{ fontSize: 11.5, color: '#6b7280', marginBottom: 14 }}>
              Lucy llamará a los clientes con vencimientos pendientes de tu empresa el día y hora que elijas (hora Colombia).
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 4 }}>Fecha</label>
              <input type="date" value={progFecha} onChange={e => setProgFecha(e.target.value)} style={inp} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 4 }}>Hora</label>
              <input type="time" value={progHora} onChange={e => setProgHora(e.target.value)} style={inp} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setModalProgramar(false)} style={{ ...btnAccion, flex: 1, background: '#f3f4f6', color: '#374151' }}>Cancelar</button>
              <button onClick={programarCorrida} disabled={ocupado} style={{ ...btnAccion, flex: 1, background: '#0369a1', color: '#fff', opacity: ocupado ? 0.6 : 1 }}>Programar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Llamada de prueba (FIX LUCY-ELEVEN-004) */}
      {modalPrueba && (
        <div onClick={() => setModalPrueba(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 380, padding: '20px 18px' }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#1a1a2e', marginBottom: 4 }}>🧪 Llamada de prueba</div>
            <div style={{ fontSize: 11.5, color: '#6b7280', marginBottom: 14 }}>
              Lucy llamará al número que indiques con datos de ejemplo. Ideal para validar la voz y el guion antes de llamar clientes reales. No afecta vencimientos ni métricas.
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 4 }}>Celular (10 dígitos)</label>
              <input type="tel" value={telPrueba} onChange={e => setTelPrueba(e.target.value)} placeholder="3001234567" style={inp} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setModalPrueba(false)} style={{ ...btnAccion, flex: 1, background: '#f3f4f6', color: '#374151' }}>Cancelar</button>
              <button onClick={lanzarPrueba} disabled={ocupado} style={{ ...btnAccion, flex: 1, background: '#b45309', color: '#fff', opacity: ocupado ? 0.6 : 1 }}>📞 Llamarme</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
