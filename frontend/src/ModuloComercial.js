// ============================================================
// Control360 — Módulo Comercial (Fase 3) — Frontend
// Ubicación: frontend/src/ModuloComercial.js
// ------------------------------------------------------------
// Vistas:
//   · Mi Día      → cola de llamadas priorizada + meta en vivo (vendedora y admin)
//   · Prospectos  → gestión, importación CSV, asignación (solo admin)
//   · Métricas    → desempeño por vendedora + motivos descarte (solo admin)
// Sin dependencias nuevas: importación por CSV (consistente con exportExcel.js)
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const MOTIVOS_DESCARTE = [
  { value: 'precio',            label: 'Precio' },
  { value: 'ya_tiene_proveedor',label: 'Ya tiene proveedor' },
  { value: 'cerro',             label: 'Negocio cerró' },
  { value: 'no_aplica',         label: 'No necesita el servicio' },
  { value: 'otro',              label: 'Otro' },
];

const ETIQUETA_ESTADO = {
  NUEVO:        { txt: 'Nuevo',        bg: '#ede9fe', color: '#7c3aed' },
  EN_GESTION:   { txt: 'En gestión',   bg: '#dbeafe', color: '#1d4ed8' },
  REPROGRAMADO: { txt: 'Reprogramado', bg: '#fef3c7', color: '#b45309' },
  CONVERTIDO:   { txt: 'Convertido ✓', bg: '#dcfce7', color: '#15803d' },
  DESCARTADO:   { txt: 'Descartado',   bg: '#fee2e2', color: '#b91c1c' },
  SIN_CONTACTO: { txt: 'Sin contacto', bg: '#f3f4f6', color: '#6b7280' },
};

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

const telBonito = (t) => {
  if (!t) return '';
  const s = String(t).replace(/^57/, '');
  return s.length === 10 ? `${s.slice(0,3)} ${s.slice(3,6)} ${s.slice(6)}` : s;
};

export default function ModuloComercial({ user, onNavegar }) {
  const esAdmin = user?.role === 'admin';
  const [tab, setTab] = useState('midia');

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: '0 auto' }}>
      {/* Encabezado */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#1a1a2e' }}>📞 Telemercadeo</h1>
          <div style={{ fontSize: 12, color: '#6b7280' }}>Pipeline comercial y gestión de llamadas</div>
        </div>
        {esAdmin && (
          <div style={{ display: 'flex', gap: 6, background: '#fff', padding: 4, borderRadius: 10, border: '1px solid #e5e7eb' }}>
            {[['midia','Mi Día'],['prospectos','Prospectos'],['metricas','Métricas']].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: tab === k ? '#7c3aed' : 'transparent', color: tab === k ? '#fff' : '#6b7280',
              }}>{l}</button>
            ))}
          </div>
        )}
      </div>

      {tab === 'midia'      && <MiDia user={user} onNavegar={onNavegar} />}
      {tab === 'prospectos' && esAdmin && <Prospectos user={user} />}
      {tab === 'metricas'   && esAdmin && <Metricas user={user} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// VISTA 1 — MI DÍA (vendedora y admin)
// ════════════════════════════════════════════════════════════════════════════
function MiDia({ user, onNavegar }) {
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [prospectoActivo, setProspectoActivo] = useState(null); // abre modal
  // Ola 3: el comercial también crea prospectos (quedan asignados a él)
  const [mostrarNuevoP, setMostrarNuevoP] = useState(false);
  const [nuevoP, setNuevoP] = useState({ nombre: '', empresa: '', telefono: '', sucursal: '', notas: '' });
  const [agendaAbierta, setAgendaAbierta] = useState(false);

  const crearProspectoMiDia = async () => {
    if (!nuevoP.nombre || !nuevoP.telefono) return alert('Nombre y teléfono son requeridos');
    const res = await fetch(`${API}/comercial/prospectos`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(nuevoP),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.error || 'Error creando prospecto');
    setNuevoP({ nombre: '', empresa: '', telefono: '', sucursal: '', notas: '' });
    setMostrarNuevoP(false);
    cargar();
  };

  const cargar = useCallback(async () => {
    try {
      const res = await fetch(`${API}/comercial/mi-dia`, { headers: authHeaders() });
      const json = await res.json();
      setData(json);
    } catch (e) { console.error(e); }
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  if (cargando) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Cargando tu día...</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: '#b91c1c' }}>No se pudo cargar. Intenta de nuevo.</div>;

  const { cola = {}, meta = {}, totalPendientes = 0 } = data;
  const pct = Math.min(meta.porcentaje ?? 0, 100);

  return (
    <div>
      {/* Barra de meta diaria (R-COM-08) */}
      {meta.objetivo > 0 && (
        <div style={{ background: 'linear-gradient(135deg,#1e1b4b,#312e81)', borderRadius: 14, padding: '16px 18px', color: '#fff', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }}>Meta de hoy</div>
            <div style={{ fontSize: 22, fontWeight: 900 }}>
              {meta.realizadas} <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.7 }}>/ {meta.objetivo} llamadas</span>
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 99, height: 10, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 99, background: pct >= 100 ? '#4ade80' : '#a78bfa', transition: 'width .4s' }} />
          </div>
          <div style={{ fontSize: 11, marginTop: 6, opacity: 0.75 }}>
            {pct >= 100 ? '🎉 ¡Meta cumplida! Cada llamada extra suma.' : `${meta.porcentaje}% — te faltan ${Math.max(meta.objetivo - meta.realizadas, 0)} llamadas`}
          </div>
        </div>
      )}

      {totalPendientes === 0 && (
        <div style={{ background: '#fff', borderRadius: 14, padding: 40, textAlign: 'center', border: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 36 }}>✅</div>
          <div style={{ fontWeight: 700, color: '#1a1a2e', marginTop: 6 }}>No tienes llamadas pendientes</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Pídele al administrador que cargue o te asigne prospectos.</div>
        </div>
      )}

      {/* Ola 3: botón Nuevo prospecto + Ventas de hoy */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button onClick={() => setMostrarNuevoP(true)} style={{ border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', background: '#7c3aed', color: '#fff' }}>
          ➕ Nuevo prospecto
        </button>
      </div>

      {(data.ventasHoy || []).length > 0 && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 14, padding: '14px 16px', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#15803d', marginBottom: 8 }}>🎉 Ventas de hoy ({data.ventasHoy.length})</div>
          {data.ventasHoy.map(v => (
            <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #dcfce7', fontSize: 13 }}>
              <span style={{ fontWeight: 700, color: '#1a1a2e' }}>{v.nombre}</span>
              <span style={{ color: '#15803d', fontWeight: 700, fontSize: 12 }}>Cliente creado ✓</span>
            </div>
          ))}
        </div>
      )}

      <Seccion titulo="⏰ Reprogramadas para hoy" sub="Te pidieron que llamaras — respeta la hora acordada" lista={cola.reprogramados} conHora
        onLlamar={setProspectoActivo} />
      <Seccion titulo="🔁 Reintentos" sub="No contestaron antes — nuevo intento hoy" lista={cola.reintentos}
        onLlamar={setProspectoActivo} />
      <Seccion titulo="🆕 Prospectos nuevos" sub="Primera llamada" lista={cola.nuevos}
        onLlamar={setProspectoActivo} />

      {/* Ola 3: agenda de llamadas futuras — para que "el martes 9am" no se
          sienta perdido: vive aquí hasta que llegue su día. */}
      {(data.agendaProxima || []).length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 16px', marginTop: 4 }}>
          <button onClick={() => setAgendaAbierta(a => !a)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, width: '100%', textAlign: 'left' }}>
            <span style={{ fontWeight: 800, fontSize: 14, color: '#1a1a2e' }}>📅 Agenda próxima ({data.agendaProxima.length})</span>
            <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>llamadas programadas para los próximos días {agendaAbierta ? '▲' : '▼'}</span>
          </button>
          {agendaAbierta && data.agendaProxima.map(a => (
            <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13, flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontWeight: 700, color: '#1a1a2e' }}>{a.nombre}</span>
                {a.notas && <span style={{ color: '#9ca3af', fontSize: 12 }}> · {a.notas}</span>}
              </div>
              <span style={{ fontWeight: 700, color: '#b45309', fontSize: 12, whiteSpace: 'nowrap' }}>{a.fecha}{a.hora ? ` · ${a.hora}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      {mostrarNuevoP && (
        <div onClick={() => setMostrarNuevoP(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 400, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 480, padding: '18px 18px 24px' }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#1a1a2e', marginBottom: 12 }}>➕ Nuevo prospecto</div>
            {[['nombre', 'Nombre *'], ['empresa', 'Empresa'], ['telefono', 'Teléfono *'], ['sucursal', 'Sucursal'], ['notas', 'Notas']].map(([k, l]) => (
              <input key={k} value={nuevoP[k]} onChange={e => setNuevoP(s => ({ ...s, [k]: e.target.value }))} placeholder={l}
                style={{ width: '100%', padding: '10px 11px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box', marginBottom: 8 }} />
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button onClick={() => setMostrarNuevoP(false)} style={{ flex: 1, border: 'none', borderRadius: 10, padding: '12px', fontWeight: 700, cursor: 'pointer', background: '#f3f4f6', color: '#374151' }}>Cancelar</button>
              <button onClick={crearProspectoMiDia} style={{ flex: 1, border: 'none', borderRadius: 10, padding: '12px', fontWeight: 700, cursor: 'pointer', background: '#7c3aed', color: '#fff' }}>Guardar — queda a mi nombre</button>
            </div>
          </div>
        </div>
      )}

      {prospectoActivo && (
        <ModalLlamada prospecto={prospectoActivo} onCerrar={(huboCambio) => {
          setProspectoActivo(null);
          if (huboCambio) cargar();
        }} onCrearOrden={(cli) => {
          // Cliente recién convertido → orden de servicio sin salir a buscarlo.
          sessionStorage.setItem('c360_orden_prefill', JSON.stringify(cli));
          if (onNavegar) onNavegar('ordenes');
        }} />
      )}
    </div>
  );
}

function Seccion({ titulo, sub, lista = [], conHora, onLlamar }) {
  if (!lista.length) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e' }}>{titulo}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', marginLeft: 8 }}>{lista.length}</span>
        <div style={{ fontSize: 11, color: '#9ca3af' }}>{sub}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {lista.map(p => (
          <div key={p.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.nombre}</div>
                {p.empresa && <div style={{ fontSize: 11, color: '#6b7280' }}>{p.empresa}</div>}
              </div>
              {conHora && p.proximaLlamada?.hora && (
                <span style={{ background: '#fef3c7', color: '#b45309', fontWeight: 800, fontSize: 12, padding: '3px 9px', borderRadius: 8, flexShrink: 0 }}>
                  🕒 {p.proximaLlamada.hora}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <a href={`tel:+${p.telefono}`} style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed', textDecoration: 'none' }}>
                📱 {telBonito(p.telefono)}
              </a>
              {p.sucursal && <span style={{ fontSize: 11, color: '#9ca3af' }}>📍 {p.sucursal}</span>}
              {(p.totalLlamadas || 0) > 0 && <span style={{ fontSize: 10, color: '#9ca3af' }}>({p.totalLlamadas} llamada{p.totalLlamadas > 1 ? 's' : ''} previas)</span>}
            </div>
            {p.notas && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6, background: '#f9fafb', borderRadius: 6, padding: '5px 8px' }}>📝 {p.notas}</div>}
            <button onClick={() => onLlamar(p)} style={{
              marginTop: 10, width: '100%', border: 'none', borderRadius: 9, padding: '9px 0',
              background: '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer',
            }}>
              ☎ Registrar llamada
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MODAL — REGISTRAR LLAMADA (formulario de 4 toques + captura de equipos)
// ════════════════════════════════════════════════════════════════════════════
function ModalLlamada({ prospecto, onCerrar, onCrearOrden }) {
  const [resultado, setResultado] = useState(null);
  const [notas, setNotas] = useState('');
  const [fecha, setFecha] = useState('');
  const [hora, setHora] = useState('');
  const [motivo, setMotivo] = useState('');
  const [capturar, setCapturar] = useState(false);
  const [equipos, setEquipos] = useState([{ equipo: '', cantidad: 1, sucursal: '', fechaUltimaRecarga: '' }]);
  // Ola 3: al aceptar, se VERIFICAN los datos completos del cliente — nace
  // con el esquema oficial (visible y editable en Clientes) y listo para la
  // orden de servicio.
  const [cliNombre, setCliNombre] = useState(prospecto.nombre || '');
  const [cliNit, setCliNit] = useState(prospecto.nit || '');
  const [emailNuevo, setEmailNuevo] = useState('');
  const [direccionNueva, setDireccionNueva] = useState('');
  const [cliContacto, setCliContacto] = useState('');
  const [empresas, setEmpresas] = useState([]);
  const [empresaFac, setEmpresaFac] = useState(null);
  const [clienteCreado, setClienteCreado] = useState(null);

  // Empresas facturadoras (si hay una sola, queda seleccionada sola)
  useEffect(() => {
    fetch(`${API}/companies`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        const lista = Array.isArray(d) ? d : [];
        setEmpresas(lista);
        if (lista.length === 1) setEmpresaFac(lista[0]);
      })
      .catch(() => {});
  }, []);
  const [guardando, setGuardando] = useState(false);
  const [exito, setExito] = useState(null);
  const [error, setError] = useState(null);

  const RESULTADOS = [
    { value: 'acepta',      label: '✅ Acepta el servicio', bg: '#dcfce7', color: '#15803d' },
    { value: 'reprogramar', label: '📅 Llamar después',     bg: '#fef3c7', color: '#b45309' },
    { value: 'no_contesto', label: '📵 No contestó',        bg: '#f3f4f6', color: '#6b7280' },
    { value: 'no_interesa', label: '❌ No le interesa',     bg: '#fee2e2', color: '#b91c1c' },
  ];

  const guardar = async () => {
    setError(null);
    if (!resultado) return setError('Selecciona el resultado de la llamada');
    if (resultado === 'reprogramar' && !fecha) return setError('Indica la fecha de la próxima llamada');
    if (resultado === 'no_interesa' && !motivo) return setError('Indica el motivo');
    if (resultado === 'acepta') {
      if (!cliNombre.trim()) return setError('Verifica el nombre / razón social del cliente');
      if (!empresaFac) return setError('Selecciona la empresa que factura');
    }

    setGuardando(true);
    try {
      const body = {
        resultado, notas: notas || null,
        proximaLlamada: resultado === 'reprogramar' ? { fecha, hora: hora || null } : undefined,
        motivoDescarte: resultado === 'no_interesa' ? motivo : undefined,
        equiposCapturados: capturar ? equipos.filter(e => e.equipo) : undefined,
      };
      const res = await fetch(`${API}/comercial/prospectos/${prospecto.id}/llamada`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al registrar');

      // Si aceptó → convertir a cliente automáticamente
      if (resultado === 'acepta') {
        const resC = await fetch(`${API}/comercial/prospectos/${prospecto.id}/convertir`, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({
            nombre: cliNombre.trim(),
            nit: cliNit || null,
            email: emailNuevo || null,
            direccion: direccionNueva || null,
            contacto: cliContacto || null,
            empresaId: empresaFac?.id || '',
            empresaNombre: empresaFac?.name || '',
          }),
        });
        const jsonC = await resC.json();
        if (!resC.ok) throw new Error(jsonC.error || 'Llamada registrada, pero falló la conversión');
        setClienteCreado(jsonC.cliente || { id: jsonC.clienteId, nombre: cliNombre.trim().toUpperCase() });
        setExito('🎉 ¡Venta! El cliente quedó creado y visible en el módulo Clientes.');
        setGuardando(false);
        return; // el éxito de venta muestra botones — no se cierra solo
      } else {
        setExito('✓ Llamada registrada');
      }
      setTimeout(() => onCerrar(true), 1400);
    } catch (e) {
      setError(e.message);
      setGuardando(false);
    }
  };

  const setEq = (i, campo, valor) => {
    setEquipos(eqs => eqs.map((e, idx) => idx === i ? { ...e, [campo]: valor } : e));
  };

  const inputStyle = { width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' };

  return (
    <div onClick={() => !guardando && onCerrar(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 400, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 520, maxHeight: '92vh', overflowY: 'auto', padding: '18px 18px 24px' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#1a1a2e' }}>{prospecto.nombre}</div>
            <a href={`tel:+${prospecto.telefono}`} style={{ fontSize: 13, fontWeight: 700, color: '#7c3aed', textDecoration: 'none' }}>📱 {telBonito(prospecto.telefono)}</a>
          </div>
          <button onClick={() => onCerrar(false)} style={{ border: 'none', background: '#f3f4f6', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>

        {exito ? (
          <div>
            <div style={{ background: '#dcfce7', color: '#15803d', borderRadius: 10, padding: '16px 14px', fontWeight: 700, fontSize: 14, textAlign: 'center' }}>{exito}</div>
            {clienteCreado && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={() => onCerrar(true)} style={{ flex: 1, border: 'none', borderRadius: 10, padding: '13px', fontWeight: 700, cursor: 'pointer', background: '#f3f4f6', color: '#374151', fontSize: 13 }}>
                  Cerrar
                </button>
                <button onClick={() => { onCerrar(true); onCrearOrden && onCrearOrden(clienteCreado); }} style={{ flex: 2, border: 'none', borderRadius: 10, padding: '13px', fontWeight: 800, cursor: 'pointer', background: 'linear-gradient(135deg,#15803d,#16a34a)', color: '#fff', fontSize: 13 }}>
                  🧾 Crear orden de servicio ahora
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Resultado */}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>¿Cómo terminó la llamada?</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              {RESULTADOS.map(r => (
                <button key={r.value} onClick={() => setResultado(r.value)} style={{
                  border: resultado === r.value ? `2px solid ${r.color}` : '2px solid transparent',
                  background: r.bg, color: r.color, borderRadius: 10, padding: '12px 8px',
                  fontWeight: 800, fontSize: 12.5, cursor: 'pointer',
                }}>{r.label}</button>
              ))}
            </div>

            {/* Campos condicionales */}
            {resultado === 'reprogramar' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Fecha *</div>
                  <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Hora (si la pidió)</div>
                  <input type="time" value={hora} onChange={e => setHora(e.target.value)} style={inputStyle} />
                </div>
              </div>
            )}

            {resultado === 'no_interesa' && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Motivo *</div>
                <select value={motivo} onChange={e => setMotivo(e.target.value)} style={inputStyle}>
                  <option value="">— Selecciona —</option>
                  {MOTIVOS_DESCARTE.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            )}

            {resultado === 'acepta' && (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#15803d', marginBottom: 8 }}>✅ Se creará como CLIENTE — verifica sus datos:</div>
                <input placeholder="Nombre / Razón social *" value={cliNombre} onChange={e => setCliNombre(e.target.value)} style={{ ...inputStyle, marginBottom: 6, fontWeight: 700 }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                  <input placeholder="NIT / CC" value={cliNit} onChange={e => setCliNit(e.target.value)} style={{ ...inputStyle, marginBottom: 0 }} />
                  <input placeholder="Contacto / Responsable" value={cliContacto} onChange={e => setCliContacto(e.target.value)} style={{ ...inputStyle, marginBottom: 0 }} />
                </div>
                <input placeholder="Dirección" value={direccionNueva} onChange={e => setDireccionNueva(e.target.value)} style={{ ...inputStyle, marginBottom: 6 }} />
                <input placeholder="Correo electrónico" value={emailNuevo} onChange={e => setEmailNuevo(e.target.value)} style={{ ...inputStyle, marginBottom: 8 }} />
                <div style={{ fontSize: 11, fontWeight: 800, color: '#15803d', marginBottom: 5 }}>¿Quién factura? *</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {empresas.map(e => (
                    <button key={e.id} type="button" onClick={() => setEmpresaFac(e)} style={{
                      border: empresaFac?.id === e.id ? '2px solid #15803d' : '1px solid #d1d5db',
                      background: empresaFac?.id === e.id ? '#dcfce7' : '#fff',
                      color: empresaFac?.id === e.id ? '#15803d' : '#374151',
                      borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    }}>🏢 {e.name}</button>
                  ))}
                  {!empresas.length && <span style={{ fontSize: 12, color: '#9ca3af' }}>Cargando empresas...</span>}
                </div>
              </div>
            )}

            {/* Captura de equipos (enriquecimiento de base) */}
            <button onClick={() => setCapturar(!capturar)} style={{
              width: '100%', border: '1px dashed #c4b5fd', background: capturar ? '#f5f3ff' : '#fff',
              color: '#7c3aed', borderRadius: 10, padding: '9px 0', fontWeight: 700, fontSize: 12, cursor: 'pointer', marginBottom: 10,
            }}>
              {capturar ? '▾' : '▸'} Capturar extintores y fechas de recarga
            </button>
            {capturar && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>Pregunta: <em>"¿Cuántos extintores tiene, en qué sedes y cuándo fue la última recarga?"</em></div>
                {equipos.map((e, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 6, marginBottom: 6, background: '#f9fafb', borderRadius: 8, padding: 8 }}>
                    <input placeholder="Equipo (ej: ABC 10 lbs)" value={e.equipo} onChange={ev => setEq(i, 'equipo', ev.target.value)} style={inputStyle} />
                    <input type="number" min="1" placeholder="Cant." value={e.cantidad} onChange={ev => setEq(i, 'cantidad', ev.target.value)} style={inputStyle} />
                    <input placeholder="Sucursal (opcional)" value={e.sucursal} onChange={ev => setEq(i, 'sucursal', ev.target.value)} style={inputStyle} />
                    <input type="date" title="Última recarga" value={e.fechaUltimaRecarga} onChange={ev => setEq(i, 'fechaUltimaRecarga', ev.target.value)} style={inputStyle} />
                  </div>
                ))}
                <button onClick={() => setEquipos([...equipos, { equipo: '', cantidad: 1, sucursal: '', fechaUltimaRecarga: '' }])}
                  style={{ border: 'none', background: '#ede9fe', color: '#7c3aed', borderRadius: 8, padding: '6px 12px', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
                  + Otro equipo
                </button>
              </div>
            )}

            {/* Notas */}
            <textarea placeholder="Notas de la llamada (opcional)" value={notas} onChange={e => setNotas(e.target.value)} rows={2}
              style={{ ...inputStyle, resize: 'vertical', marginBottom: 12 }} />

            {error && <div style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>{error}</div>}

            <button onClick={guardar} disabled={guardando} style={{
              width: '100%', border: 'none', borderRadius: 10, padding: '13px 0',
              background: guardando ? '#c4b5fd' : '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer',
            }}>
              {guardando ? 'Guardando...' : 'Guardar llamada'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// VISTA 2 — PROSPECTOS (solo admin): lista, filtros, importación, asignación
// ════════════════════════════════════════════════════════════════════════════
function Prospectos({ user }) {
  const [lista, setLista] = useState([]);
  const [vendedoras, setVendedoras] = useState([]);
  const [filtroEstado, setFiltroEstado] = useState('');
  const [cargando, setCargando] = useState(true);
  const [importando, setImportando] = useState(false);
  const [msgImport, setMsgImport] = useState(null);
  const [mostrarNuevo, setMostrarNuevo] = useState(false);
  const [nuevo, setNuevo] = useState({ nombre: '', empresa: '', telefono: '', sucursal: '', notas: '' });
  // Ola 3: importador de VENCIMIENTOS — la puerta para cargar TUS clientes
  // con sus fechas de recarga. Con fecha → vencimiento (+1 año, arma la cola
  // del mes solo). Sin fecha → prospecto. Re-importar el mismo archivo
  // ENRIQUECE lo existente (modo actualizar) — nunca duplica ni borra gestión.
  const [empresasFact, setEmpresasFact] = useState([]);
  const [empresaImport, setEmpresaImport] = useState(null);
  const [importandoV, setImportandoV] = useState(false);
  const [msgImportV, setMsgImportV] = useState(null);

  useEffect(() => {
    fetch(`${API}/companies`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        const l = Array.isArray(d) ? d : [];
        setEmpresasFact(l);
        if (l.length === 1) setEmpresaImport(l[0]);
      }).catch(() => {});
  }, []);

  const plantillaVencimientos = () => {
    const csv = '\uFEFFnombre;nit;telefono;sucursal;equipo;cantidad;fechaUltimaRecarga;email;direccion\n' +
      'INVERSIONES EJEMPLO SAS;900123456;3101234567;Sede Norte;Extintor ABC 10 LB;4;2025-08-15;compras@ejemplo.com;Calle 1 # 2-3\n' +
      'TIENDA SIN FECHA;;3209876543;;Extintor CO2;1;;;\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'plantilla_vencimientos.csv'; a.click();
  };

  const importarVencimientos = async (file) => {
    if (!empresaImport) { setMsgImportV('✗ Selecciona primero la empresa que factura'); return; }
    setImportandoV(true); setMsgImportV(null);
    try {
      const texto = (await file.text()).replace(/^\uFEFF/, '');
      const lineas = texto.split(/\r?\n/).filter(l => l.trim());
      if (lineas.length < 2) throw new Error('El archivo está vacío o solo tiene encabezado');
      const sep = lineas[0].includes(';') ? ';' : ',';
      const headers = lineas[0].split(sep).map(h => h.trim().toLowerCase());
      const idx = (n) => headers.findIndex(h => h.includes(n));
      // Acepta tus columnas de siempre: celular o teléfono, razón social o nombre
      const iNom = Math.max(idx('nombre'), idx('razon')), iNit = idx('nit'),
            iTel = Math.max(idx('tel'), idx('celular')), iSuc = idx('sucursal'),
            iEq = idx('equipo'), iCant = idx('cantidad'), iFecha = idx('fecha'),
            iEmail = Math.max(idx('email'), idx('correo')), iDir = idx('direcc');
      if (iNom < 0 || iTel < 0) throw new Error('Se requieren columnas de nombre y teléfono/celular. Descarga la plantilla.');

      const filas = lineas.slice(1).map(l => {
        const c = l.split(sep);
        const v = (i) => (i >= 0 ? (c[i] || '').trim() : '');
        return {
          nombre: v(iNom), nit: v(iNit), telefono: v(iTel), sucursal: v(iSuc) || null,
          equipo: v(iEq) || null, cantidad: v(iCant) || null,
          fechaUltimaRecarga: v(iFecha) || null, email: v(iEmail) || null, direccion: v(iDir) || null,
        };
      }).filter(f => f.nombre || f.telefono);

      const res = await fetch(`${API}/vencimientos/importar`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ filas, empresaId: empresaImport.id, empresaNombre: empresaImport.name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al importar');
      setMsgImportV(`✓ ${json.vencimientosCreados} vencimientos · ${json.clientesNuevos} clientes nuevos · ${json.prospectosCreados} prospectos nuevos · ${json.prospectosActualizados || 0} actualizados${json.errores?.length ? ` · ${json.errores.length} filas con error` : ''}`);
      cargar();
    } catch (e) {
      setMsgImportV(`✗ ${e.message}`);
    }
    setImportandoV(false);
  };

  const cargar = useCallback(async () => {
    try {
      const [resP, resU] = await Promise.all([
        fetch(`${API}/comercial/prospectos`, { headers: authHeaders() }),
        fetch(`${API}/users`, { headers: authHeaders() }),
      ]);
      const ps = await resP.json();
      const us = await resU.json();
      setLista(Array.isArray(ps) ? ps : []);
      const usuarios = Array.isArray(us) ? us : (us.usuarios || []);
      setVendedoras(usuarios.filter(u => u.role === 'comercial' || u.rol === 'comercial'));
    } catch (e) { console.error(e); }
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // ─── Importación CSV (Excel → Guardar como CSV) ───
  const importarCSV = async (file) => {
    setImportando(true); setMsgImport(null);
    try {
      const texto = (await file.text()).replace(/^\uFEFF/, '');
      const lineas = texto.split(/\r?\n/).filter(l => l.trim());
      if (lineas.length < 2) throw new Error('El archivo está vacío o solo tiene encabezado');

      const sep = lineas[0].includes(';') ? ';' : ',';
      const headers = lineas[0].split(sep).map(h => h.trim().toLowerCase());
      const idx = (n) => headers.findIndex(h => h.includes(n));
      const iNombre = idx('nombre'), iEmpresa = idx('empresa'), iTel = idx('tel'), iSuc = idx('sucursal'), iNotas = idx('nota');
      if (iNombre < 0 || iTel < 0) throw new Error('El archivo debe tener columnas "nombre" y "telefono". Descarga la plantilla.');

      const filas = lineas.slice(1).map(l => {
        const c = l.split(sep);
        return {
          nombre: c[iNombre]?.trim(),
          empresa: iEmpresa >= 0 ? c[iEmpresa]?.trim() : null,
          telefono: c[iTel]?.trim(),
          sucursal: iSuc >= 0 ? c[iSuc]?.trim() : null,
          notas: iNotas >= 0 ? c[iNotas]?.trim() : null,
        };
      }).filter(f => f.nombre || f.telefono);

      const res = await fetch(`${API}/comercial/prospectos/importar`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ filas }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al importar');
      setMsgImport(`✓ ${json.creados} prospectos creados · ${json.duplicados} duplicados omitidos${json.errores?.length ? ` · ${json.errores.length} filas con error` : ''}`);
      cargar();
    } catch (e) {
      setMsgImport(`✗ ${e.message}`);
    }
    setImportando(false);
  };

  const descargarPlantilla = () => {
    const csv = '\uFEFFnombre;empresa;telefono;sucursal;notas\nCarlos Pérez;Ferretería El Tornillo;3101234567;Sede Norte;Cliente referido\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'plantilla_prospectos.csv'; a.click();
  };

  const asignar = async (prospectoId, vendedoraId) => {
    await fetch(`${API}/comercial/prospectos/${prospectoId}`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ asignadoA: vendedoraId || null }),
    });
    cargar();
  };

  const crearProspecto = async () => {
    if (!nuevo.nombre || !nuevo.telefono) return alert('Nombre y teléfono son requeridos');
    const res = await fetch(`${API}/comercial/prospectos`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(nuevo),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.error || 'Error');
    setNuevo({ nombre: '', empresa: '', telefono: '', sucursal: '', notas: '' });
    setMostrarNuevo(false);
    cargar();
  };

  const resumen = {};
  lista.forEach(p => { resumen[p.estado] = (resumen[p.estado] || 0) + 1; });
  const visibles = filtroEstado ? lista.filter(p => p.estado === filtroEstado) : lista;
  const inputStyle = { width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box', marginBottom: 8 };

  if (cargando) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Cargando prospectos...</div>;

  return (
    <div>
      {/* Chips de resumen + filtro */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <Chip activo={!filtroEstado} onClick={() => setFiltroEstado('')} bg="#1e1b4b" color="#fff">Todos {lista.length}</Chip>
        {Object.entries(ETIQUETA_ESTADO).map(([k, v]) => resumen[k] ? (
          <Chip key={k} activo={filtroEstado === k} onClick={() => setFiltroEstado(filtroEstado === k ? '' : k)} bg={v.bg} color={v.color}>
            {v.txt} {resumen[k]}
          </Chip>
        ) : null)}
      </div>

      {/* ── Ola 3: IMPORTAR VENCIMIENTOS — la puerta para TUS clientes ──
          Con fecha de última recarga → crea el vencimiento y arma la cola del
          mes. Sin fecha → cae como prospecto. Re-importar el mismo archivo
          ACTUALIZA (enriquece NIT/datos) sin duplicar ni borrar gestión. */}
      <div style={{ background: '#fff', border: '2px solid #c4b5fd', borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: '#1a1a2e' }}>📥 Importar vencimientos (clientes con fecha de recarga)</div>
        <div style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 10px' }}>
          Sube tu base de clientes con la <strong>fecha de última recarga</strong>: el sistema calcula el vencimiento, arma la cola de llamadas del mes y vincula a los clientes existentes. Las filas sin fecha quedan como prospectos. Re-importar <strong>actualiza sin duplicar</strong>.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>¿Quién factura?</span>
          {empresasFact.map(e => (
            <button key={e.id} type="button" onClick={() => setEmpresaImport(e)} style={{
              border: empresaImport?.id === e.id ? '2px solid #7c3aed' : '1px solid #d1d5db',
              background: empresaImport?.id === e.id ? '#f5f3ff' : '#fff',
              color: empresaImport?.id === e.id ? '#5b21b6' : '#374151',
              borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}>🏢 {e.name}</button>
          ))}
          <label style={{ background: importandoV || !empresaImport ? '#9ca3af' : '#16a34a', color: '#fff', borderRadius: 9, padding: '9px 14px', fontWeight: 700, fontSize: 12, cursor: importandoV || !empresaImport ? 'not-allowed' : 'pointer' }}>
            {importandoV ? 'Importando...' : '⬆ Importar vencimientos'}
            <input type="file" accept=".csv" hidden disabled={importandoV || !empresaImport}
              onChange={e => { if (e.target.files[0]) importarVencimientos(e.target.files[0]); e.target.value = ''; }} />
          </label>
          <button onClick={plantillaVencimientos} style={{ background: '#fff', border: '1px solid #d1d5db', color: '#374151', borderRadius: 9, padding: '9px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            ⬇ Plantilla vencimientos
          </button>
        </div>
        {msgImportV && <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: msgImportV.startsWith('✓') ? '#15803d' : '#b91c1c' }}>{msgImportV}</div>}
      </div>

      {/* Acciones */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ background: '#7c3aed', color: '#fff', borderRadius: 9, padding: '9px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
          {importando ? 'Importando...' : '⬆ Importar prospectos (números fríos)'}
          <input type="file" accept=".csv" hidden disabled={importando}
            onChange={e => { if (e.target.files[0]) importarCSV(e.target.files[0]); e.target.value = ''; }} />
        </label>
        <button onClick={descargarPlantilla} style={{ background: '#fff', border: '1px solid #d1d5db', color: '#374151', borderRadius: 9, padding: '9px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
          ⬇ Plantilla
        </button>
        <button onClick={() => setMostrarNuevo(!mostrarNuevo)} style={{ background: '#fff', border: '1px solid #c4b5fd', color: '#7c3aed', borderRadius: 9, padding: '9px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
          + Nuevo prospecto
        </button>
      </div>

      {msgImport && (
        <div style={{ background: msgImport.startsWith('✓') ? '#dcfce7' : '#fee2e2', color: msgImport.startsWith('✓') ? '#15803d' : '#b91c1c', borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 600, marginBottom: 12 }}>
          {msgImport}
        </div>
      )}

      {mostrarNuevo && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, marginBottom: 12, maxWidth: 420 }}>
          <input placeholder="Nombre *" value={nuevo.nombre} onChange={e => setNuevo({ ...nuevo, nombre: e.target.value })} style={inputStyle} />
          <input placeholder="Empresa" value={nuevo.empresa} onChange={e => setNuevo({ ...nuevo, empresa: e.target.value })} style={inputStyle} />
          <input placeholder="Teléfono *" value={nuevo.telefono} onChange={e => setNuevo({ ...nuevo, telefono: e.target.value })} style={inputStyle} />
          <input placeholder="Sucursal" value={nuevo.sucursal} onChange={e => setNuevo({ ...nuevo, sucursal: e.target.value })} style={inputStyle} />
          <input placeholder="Notas" value={nuevo.notas} onChange={e => setNuevo({ ...nuevo, notas: e.target.value })} style={inputStyle} />
          <button onClick={crearProspecto} style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Guardar</button>
        </div>
      )}

      {/* Lista */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 10 }}>
        {visibles.map(p => {
          const et = ETIQUETA_ESTADO[p.estado] || ETIQUETA_ESTADO.NUEVO;
          return (
            <div key={p.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: '#1a1a2e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.nombre}</div>
                  {p.empresa && <div style={{ fontSize: 11, color: '#6b7280' }}>{p.empresa}</div>}
                  <div style={{ fontSize: 12, color: '#7c3aed', fontWeight: 700, marginTop: 2 }}>📱 {telBonito(p.telefono)}</div>
                </div>
                <span style={{ background: et.bg, color: et.color, fontWeight: 800, fontSize: 10, padding: '4px 8px', borderRadius: 8, height: 'fit-content', flexShrink: 0 }}>{et.txt}</span>
              </div>
              {p.motivoDescarte && <div style={{ fontSize: 10.5, color: '#b91c1c', marginTop: 4 }}>Motivo: {MOTIVOS_DESCARTE.find(m => m.value === p.motivoDescarte)?.label || p.motivoDescarte}</div>}
              {!['CONVERTIDO', 'DESCARTADO'].includes(p.estado) && (
                <select value={p.asignadoA || ''} onChange={e => asignar(p.id, e.target.value)} style={{ width: '100%', marginTop: 8, padding: '7px 8px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 11.5, color: '#374151' }}>
                  <option value="">— Sin asignar (la ven todas) —</option>
                  {vendedoras.map(v => <option key={v.id || v.uid} value={v.id || v.uid}>{v.nombre || v.email}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
      {!visibles.length && <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No hay prospectos{filtroEstado ? ' en este estado' : ' — importa tu base con el botón de arriba'}.</div>}
    </div>
  );
}

function Chip({ children, activo, onClick, bg, color }) {
  return (
    <button onClick={onClick} style={{
      border: activo ? `2px solid ${color}` : '2px solid transparent',
      background: bg, color, borderRadius: 99, padding: '5px 12px',
      fontWeight: 800, fontSize: 11, cursor: 'pointer',
    }}>{children}</button>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// VISTA 3 — MÉTRICAS (solo admin) + configuración de meta diaria
// ════════════════════════════════════════════════════════════════════════════
function Metricas({ user }) {
  const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const [desde, setDesde] = useState(hoy.slice(0, 8) + '01');
  const [hasta, setHasta] = useState(hoy);
  const [data, setData] = useState(null);
  const [vendedoras, setVendedoras] = useState([]);
  const [metasEdit, setMetasEdit] = useState({});

  const cargar = useCallback(async () => {
    try {
      const [resM, resU] = await Promise.all([
        fetch(`${API}/comercial/metricas?desde=${desde}&hasta=${hasta}`, { headers: authHeaders() }),
        fetch(`${API}/users`, { headers: authHeaders() }),
      ]);
      setData(await resM.json());
      const us = await resU.json();
      const usuarios = Array.isArray(us) ? us : (us.usuarios || []);
      setVendedoras(usuarios.filter(u => u.role === 'comercial' || u.rol === 'comercial'));
    } catch (e) { console.error(e); }
  }, [desde, hasta]);

  useEffect(() => { cargar(); }, [cargar]);

  const guardarMeta = async (vendedoraId) => {
    const meta = Number(metasEdit[vendedoraId]);
    if (!meta || meta < 1) return alert('Meta inválida');
    const res = await fetch(`${API}/comercial/meta/${vendedoraId}`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ metaLlamadasDiarias: meta }),
    });
    if (res.ok) { alert('Meta guardada ✓'); cargar(); }
  };

  const inputStyle = { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12.5 };

  return (
    <div>
      {/* Rango de fechas */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Periodo:</span>
        <input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={inputStyle} />
        <span style={{ color: '#9ca3af' }}>→</span>
        <input type="date" value={hasta} onChange={e => setHasta(e.target.value)} style={inputStyle} />
      </div>

      {/* Tarjetas por vendedora */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 18 }}>
        {(data?.vendedoras || []).map(v => (
          <div key={v.vendedoraId} style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: '#1a1a2e', marginBottom: 10 }}>👤 {v.nombre}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Stat label="Llamadas" valor={v.totalLlamadas} />
              <Stat label="Promedio/día" valor={v.promedioDiario} />
              <Stat label="Tasa contacto" valor={`${v.tasaContacto}%`} />
              <Stat label="Conversiones" valor={v.conversiones} destacado />
              <Stat label="Tasa conversión" valor={`${v.tasaConversion}%`} />
              <Stat label="Cumplim. meta" valor={v.cumplimientoMeta != null ? `${v.cumplimientoMeta}%` : '—'}
                alerta={v.cumplimientoMeta != null && v.cumplimientoMeta < 80} />
            </div>
          </div>
        ))}
        {!data?.vendedoras?.length && (
          <div style={{ gridColumn: '1/-1', padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
            Aún no hay llamadas registradas en este periodo.
          </div>
        )}
      </div>

      {/* Motivos de descarte */}
      {data?.motivosDescarte && Object.keys(data.motivosDescarte).length > 0 && (
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 16, marginBottom: 18, maxWidth: 420 }}>
          <div style={{ fontWeight: 800, fontSize: 13, color: '#1a1a2e', marginBottom: 8 }}>📊 Motivos de descarte (inteligencia de mercado)</div>
          {Object.entries(data.motivosDescarte).map(([m, n]) => (
            <div key={m} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0', borderBottom: '1px solid #f3f4f6' }}>
              <span style={{ color: '#374151' }}>{MOTIVOS_DESCARTE.find(x => x.value === m)?.label || m}</span>
              <span style={{ fontWeight: 800, color: '#b91c1c' }}>{n}</span>
            </div>
          ))}
        </div>
      )}

      {/* Configuración de metas */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 16, maxWidth: 480 }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: '#1a1a2e', marginBottom: 4 }}>🎯 Meta diaria por vendedora</div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>La vendedora ve su progreso en vivo en "Mi Día"</div>
        {vendedoras.map(v => {
          const id = v.id || v.uid;
          return (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: '#374151' }}>{v.nombre || v.email}</div>
              <input type="number" min="1" placeholder={v.metaLlamadasDiarias || 'ej: 200'}
                value={metasEdit[id] ?? ''} onChange={e => setMetasEdit({ ...metasEdit, [id]: e.target.value })}
                style={{ ...inputStyle, width: 90 }} />
              <button onClick={() => guardarMeta(id)} style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 12px', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>Guardar</button>
            </div>
          );
        })}
        {!vendedoras.length && <div style={{ fontSize: 12, color: '#9ca3af' }}>Crea primero el usuario de la vendedora (rol comercial) en Usuarios.</div>}
      </div>
    </div>
  );
}

function Stat({ label, valor, destacado, alerta }) {
  return (
    <div style={{ background: destacado ? '#f0fdf4' : alerta ? '#fef2f2' : '#f9fafb', borderRadius: 10, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 900, color: destacado ? '#15803d' : alerta ? '#b91c1c' : '#1a1a2e' }}>{valor}</div>
    </div>
  );
}
