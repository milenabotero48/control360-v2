// ============================================================
// Control360 — Llamadas IA (Lucy)
// Vista: resumen del mes + lista de llamadas, cierres resaltados
// en verde con acceso directo a "Crear orden" (mismo patrón que
// Telemercadeo → NuevaOrden.js, usando sessionStorage).
//
// NO TOCA NADA EXISTENTE — componente nuevo, importado y montado
// como pestaña dentro de GestionVencimientos.js.
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
  const [activa, setActiva] = useState(null); // null = aún no se sabe, true/false una vez cargado
  const [filtroResultado, setFiltroResultado] = useState('');
  const [detalle, setDetalle] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch(`${API}/llamadas-ia/resumen`, { headers: authHeaders() }),
        fetch(`${API}/llamadas-ia`, { headers: authHeaders() }),
        fetch(`${API}/llamadas-ia/config`, { headers: authHeaders() }),
      ]);
      const [res, lst, cfg] = await Promise.all([r1.json(), r2.json(), r3.json()]);
      setResumen(res);
      setLista(Array.isArray(lst) ? lst : []);
      setActiva(!!cfg?.activo);
    } catch (e) { console.error(e); }
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const listaFiltrada = filtroResultado
    ? lista.filter(l => l.resultado === filtroResultado)
    : lista;

  // ─── Llevar el cierre de Lucy a NuevaOrden — MISMO mecanismo que
  // ModuloComercial.js usa al convertir un prospecto: sessionStorage con
  // la key 'c360_orden_prefill' y navegación vía la prop onNavegar('ordenes').
  // NuevaOrden.js SOLO lee { id, nombre, nit, celular, empresaId } y solo
  // funciona si el cliente YA EXISTE en `clients` (requiere cli.id). Si
  // Lucy cerró con un cliente nuevo que el backend no pudo resolver,
  // no hay id todavía — se avisa en vez de fingir que funciona.
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
      empresaId: '', // la empresa facturadora se elige en NuevaOrden — no viene del prefill de Telemercadeo tampoco
    };
    sessionStorage.setItem('c360_orden_prefill', JSON.stringify(prefill));
    if (onNavegar) onNavegar('ordenes');
  };

  const inp = { width: '100%', padding: '9px 10px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' };

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

  return (
    <div style={{ padding: '12px 12px 80px', maxWidth: 1100, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#1a1a2e' }}>☎️ Llamadas IA — Lucy</h1>
          <div style={{ fontSize: 11, color: '#6b7280' }}>Seguimiento automático de vencimientos por voz</div>
        </div>
      </div>

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
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Lucy llama automáticamente el día 2 de cada mes</div>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 800, fontSize: 13, color: '#1a1a2e' }}>
                      {reg.datosCierre?.nombreCompleto || telBonito(reg.telefono) || 'Sin nombre'}
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
                  {detalle.datosCierre?.nombreCompleto || telBonito(detalle.telefono)}
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
                <button onClick={() => crearOrdenDesdeCierre(detalle)}
                  style={{ width: '100%', marginTop: 10, background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 0', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  + Crear orden con estos datos
                </button>
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
    </div>
  );
}
