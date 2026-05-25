import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';
const token = () => localStorage.getItem('token');
const auth = () => ({ headers: { Authorization: `Bearer ${token()}` } });
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const fmtFecha = f => {
  if (!f) return '—';
  const d = f?.toDate ? f.toDate() : new Date(f);
  return isNaN(d) ? '—' : d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtHoras = h => h >= 24 ? `${Math.floor(h/24)}d ${h%24}h` : `${h}h`;

const s = {
  page: { padding: '20px', maxWidth: 1200, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 },
  titulo: { margin: 0, fontSize: 22, fontWeight: 800, color: '#1e1b4b' },
  subtitulo: { margin: '2px 0 0', fontSize: 13, color: '#6b7280' },
  tabs: { display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 10, padding: 4, flexWrap: 'wrap' },
  tab: a => ({ padding: '8px 16px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, background: a ? '#fff' : 'transparent', color: a ? '#7c3aed' : '#6b7280', boxShadow: a ? '0 1px 4px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.15s' }),
  card: { background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', border: '1px solid #f1f5f9' },
  cardRojo: { background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', border: '2px solid #fecaca' },
  cardAmarillo: { background: '#fffbeb', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', border: '1px solid #fde68a' },
  cardVerde: { background: '#f0fdf4', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', border: '1px solid #bbf7d0' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 },
  kpi: { textAlign: 'center', padding: '16px 12px' },
  kpiNum: { fontSize: 32, fontWeight: 900, color: '#1e1b4b', lineHeight: 1 },
  kpiLabel: { fontSize: 12, color: '#6b7280', marginTop: 4, fontWeight: 500 },
  btn: (c='#7c3aed') => ({ padding: '9px 18px', borderRadius: 8, border: 'none', background: c, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }),
  btnSm: (c='#7c3aed') => ({ padding: '6px 12px', borderRadius: 7, border: 'none', background: c, color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }),
  btnOutline: { padding: '8px 16px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 640, maxHeight: '92vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' },
  modalHeader: { padding: '20px 24px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  modalTitulo: { margin: 0, fontSize: 18, fontWeight: 800, color: '#1e1b4b' },
  modalBody: { padding: '20px 24px' },
  modalFooter: { padding: '16px 24px', borderTop: '1px solid #f1f5f9', display: 'flex', gap: 10, justifyContent: 'flex-end' },
  btnCerrar: { background: '#f3f4f6', border: 'none', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, color: '#1f2937', outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, color: '#1f2937', outline: 'none', boxSizing: 'border-box', resize: 'vertical', minHeight: 70 },
  alertError: { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12 },
  alertOk: { background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12 },
  alertWarn: { background: '#fffbeb', color: '#d97706', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', fontSize: 13 },
  badge: (c, b) => ({ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: b, color: c }),
  sep: { height: 1, background: '#f1f5f9', margin: '14px 0' },
  secTitulo: { fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' },
  chip: a => ({ padding: '5px 12px', borderRadius: 20, border: `1.5px solid ${a ? '#7c3aed' : '#e5e7eb'}`, background: a ? '#ede9fe' : '#fff', color: a ? '#7c3aed' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }),
};

const BadgeEstado = ({ horas, alerta }) => {
  if (alerta) return <span style={s.badge('#dc2626', '#fef2f2')}>🚨 {fmtHoras(horas)} — Urgente</span>;
  if (horas >= 24) return <span style={s.badge('#d97706', '#fffbeb')}>⚠️ {fmtHoras(horas)}</span>;
  return <span style={s.badge('#16a34a', '#f0fdf4')}>✅ {fmtHoras(horas)}</span>;
};

const BarraMeta = ({ completados, meta }) => {
  const pct = Math.min(100, Math.round((completados / meta) * 100));
  const color = pct >= 100 ? '#16a34a' : pct >= 60 ? '#f59e0b' : '#7c3aed';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Meta diaria: {meta} equipos</span>
        <span style={{ fontSize: 12, fontWeight: 800, color }}>{pct}%</span>
      </div>
      <div style={{ background: '#e5e7eb', borderRadius: 10, height: 12, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 10, transition: 'width 0.5s' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{completados} completados hoy</span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{Math.max(0, meta - completados)} pendientes</span>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL — PROCESO POR EQUIPO INDIVIDUAL
// ═══════════════════════════════════════════════════════════════════════════════
const ModalProcesoEquipo = ({ equipo, ordenId, numeroOrden, procesos, insumos, onGuardar, onCerrar }) => {
  const [procesoId, setProcesoId] = useState(procesos[0]?.id || '');
  const [pasosCompletados, setPasosCompletados] = useState({});
  const [insumosUsados, setInsumosUsados] = useState({});
  const [obs, setObs] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const proceso = procesos.find(p => p.id === procesoId);
  const pasos = proceso?.pasos || [];
  const todosCompletados = proceso?.modoRapido ? pasosCompletados.rapido : (pasos.length > 0 && pasos.every(p => pasosCompletados[p.id]));

  const togglePaso = id => setPasosCompletados(prev => ({ ...prev, [id]: !prev[id] }));
  const setInsumo = (pasoId, insumoId, cantidad) => setInsumosUsados(prev => ({ ...prev, [`${pasoId}_${insumoId}`]: { pasoId, insumoId, cantidad: parseFloat(cantidad) || 0 } }));

  const handleCompletar = async () => {
    if (!todosCompletados) return setError('Completa todos los pasos antes de continuar');
    setGuardando(true); setError('');
    try {
      const insumosFlat = Object.values(insumosUsados).filter(i => i.cantidad > 0);
      await onGuardar({
        equipoId: equipo.id,
        codigoQR: equipo.codigoQR,
        procesoNombre: proceso?.nombre || '',
        procesosCompletados: pasos.map(p => p.nombre),
        observaciones: obs,
        insumosUsados: insumosFlat,
        modoRapido: proceso?.modoRapido || false
      });
    } catch (e) { setError(e.response?.data?.error || 'Error al completar'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 680 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>⚙️ Proceso — {equipo.codigoQR || equipo.nombre}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              {equipo.tipo} — {equipo.capacidad} {equipo.propietario ? `· ${equipo.propietario}` : '· Sin propietario'}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#7c3aed' }}>Orden {numeroOrden}</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}

          {/* Selector proceso */}
          {procesos.length > 1 && (
            <div style={{ marginBottom: 16 }}>
              <label style={s.label}>Seleccionar proceso para este equipo</label>
              <select style={{ ...s.input }} value={procesoId} onChange={e => { setProcesoId(e.target.value); setPasosCompletados({}); }}>
                {procesos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </div>
          )}

          {/* Modo rápido */}
          {proceso?.modoRapido ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>⚡</div>
              <p style={{ fontSize: 15, fontWeight: 600, color: '#374151' }}>Modo Rápido — {proceso.nombre}</p>
              <p style={{ fontSize: 13, color: '#6b7280' }}>Marca que realizaste el proceso en este equipo</p>
              <button onClick={() => setPasosCompletados({ rapido: true })} style={{ ...s.btn('#16a34a'), marginTop: 16 }}>
                ✅ Marcar como completado
              </button>
              {pasosCompletados.rapido && <div style={{ ...s.alertOk, marginTop: 12 }}>Marcado ✅</div>}
            </div>
          ) : (
            <div>
              <p style={s.secTitulo}>Pasos — {proceso?.nombre}</p>
              {pasos.map((paso, i) => (
                <div key={paso.id} style={{ marginBottom: 10, padding: '12px 14px', borderRadius: 10, border: `1.5px solid ${pasosCompletados[paso.id] ? '#bbf7d0' : '#e5e7eb'}`, background: pasosCompletados[paso.id] ? '#f0fdf4' : '#fafafa', transition: 'all 0.2s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button onClick={() => togglePaso(paso.id)}
                      style={{ width: 28, height: 28, borderRadius: 6, border: `2px solid ${pasosCompletados[paso.id] ? '#16a34a' : '#d1d5db'}`, background: pasosCompletados[paso.id] ? '#16a34a' : '#fff', color: '#fff', fontSize: 14, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {pasosCompletados[paso.id] ? '✓' : ''}
                    </button>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', flex: 1 }}>{i + 1}. {paso.nombre}</span>
                    {paso.requiereFoto && <span style={s.badge('#7c3aed', '#ede9fe')}>📷 Foto si anomalía</span>}
                  </div>
                  {/* Insumos del paso */}
                  {paso.insumos?.length > 0 && pasosCompletados[paso.id] && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #e5e7eb' }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', margin: '0 0 8px', textTransform: 'uppercase' }}>Insumos:</p>
                      {paso.insumos.map(ins => {
                        const insumo = insumos.find(i => i.id === ins.insumoId);
                        return (
                          <div key={ins.insumoId} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                            <span style={{ fontSize: 12, flex: 1, color: '#374151' }}>{ins.insumoNombre || insumo?.nombre}</span>
                            <input type="number" min={0} defaultValue={ins.cantidadPorEquipo || 1}
                              onChange={e => setInsumo(paso.id, ins.insumoId, e.target.value)}
                              style={{ ...s.input, width: 70, textAlign: 'center' }} />
                            <span style={{ fontSize: 11, color: '#6b7280', width: 40 }}>{ins.unidad || insumo?.unidad}</span>
                            {insumo?.alerta && <span style={s.badge('#dc2626', '#fef2f2')}>⚠️ Bajo</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <label style={s.label}>Observaciones de este equipo</label>
            <textarea style={s.textarea} value={obs} onChange={e => setObs(e.target.value)}
              placeholder="Ej: Empaque reemplazado, válvula en buen estado..." />
          </div>
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnOutline}>Cancelar</button>
          <button onClick={handleCompletar} disabled={guardando || !todosCompletados}
            style={s.btn(todosCompletados ? '#16a34a' : '#9ca3af')}>
            {guardando ? 'Guardando...' : '✅ Equipo listo'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL — RECIBIR EQUIPOS
// ═══════════════════════════════════════════════════════════════════════════════
const ModalRecibir = ({ orden, onGuardar, onCerrar }) => {
  const [equipos, setEquipos] = useState(
    (orden.items || []).map(i => ({ nombre: i.nombre, cantidadEsperada: i.cantidad || 1, cantidad: i.cantidad || 1 }))
  );
  const [obs, setObs] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const completo = equipos.every(e => e.cantidad >= e.cantidadEsperada);

  const handleGuardar = async () => {
    setGuardando(true); setError('');
    try { await onGuardar({ equiposRecibidos: equipos, observaciones: obs, completo }); }
    catch (e) { setError(e.response?.data?.error || 'Error al registrar'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>📦 Recibir Equipos</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>Orden {orden.numeroOrden} — {orden.clienteNombre}</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}
          {!completo && <div style={s.alertWarn}>⚠️ Cantidades incompletas — se registrará alerta al admin</div>}
          <p style={s.secTitulo}>Verificar equipos</p>
          {equipos.map((eq, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, padding: '10px 12px', background: '#f9fafb', borderRadius: 8 }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{eq.nombre}</span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Esperados: <b>{eq.cantidadEsperada}</b></span>
              <input type="number" min={0} value={eq.cantidad}
                onChange={e => { const n = [...equipos]; n[i].cantidad = parseInt(e.target.value) || 0; setEquipos(n); }}
                style={{ ...s.input, width: 70, textAlign: 'center' }} />
              <span style={eq.cantidad >= eq.cantidadEsperada ? s.badge('#16a34a', '#f0fdf4') : s.badge('#dc2626', '#fef2f2')}>
                {eq.cantidad >= eq.cantidadEsperada ? '✅' : '❌'}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 14 }}>
            <label style={s.label}>Observaciones</label>
            <textarea style={s.textarea} value={obs} onChange={e => setObs(e.target.value)} placeholder="Ej: Faltó 1 extintor de 5 LBS..." />
          </div>
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnOutline}>Cancelar</button>
          <button onClick={handleGuardar} disabled={guardando} style={s.btn(completo ? '#16a34a' : '#f59e0b')}>
            {guardando ? 'Guardando...' : completo ? '✅ Confirmar Recepción' : '⚠️ Registrar Incompleto'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL — REGISTRAR DEFECTO
// ═══════════════════════════════════════════════════════════════════════════════
// ─── MODAL: GENERAR O ESCANEAR QR ──────────────────────────────────────────────
// El taller decide según lo que ve físicamente:
//  - Equipo NUEVO (primera vez)        → genera un QR nuevo
//  - Equipo que YA tiene QR (recarga)  → escanea/digita su QR; se le agrega
//    el servicio al historial. Mismo QR de por vida (no se duplica).
const ModalQR = ({ orden, equipo, onResolver, onCerrar }) => {
  const [modo, setModo] = useState(equipo?.codigoQRsugerido ? 'escanear' : null);
  const [codigo, setCodigo] = useState(equipo?.codigoQRsugerido || '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const confirmar = async () => {
    if (modo === 'escanear' && !codigo.trim()) {
      return setError('Escanea o digita el código QR del equipo');
    }
    setGuardando(true); setError('');
    try {
      await onResolver({ orden, equipo, modo, codigoQR: codigo.trim().toUpperCase() });
    } catch (e) {
      setError(e.response?.data?.error || 'Error al resolver el QR');
      setGuardando(false);
    }
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 460 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>🏷️ Código QR del equipo</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              {equipo?.tipo} — {equipo?.capacidad || equipo?.nombre}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#7c3aed' }}>Orden {orden.numeroOrden}</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}

          <p style={{ fontSize: 13, color: '#374151', marginBottom: 14 }}>
            ¿Este extintor ya tenía un QR pegado o es la primera vez que entra?
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              onClick={() => { setModo('escanear'); setError(''); }}
              style={{
                textAlign: 'left', padding: '12px 14px', borderRadius: 10,
                border: `2px solid ${modo === 'escanear' ? '#7c3aed' : '#e5e7eb'}`,
                background: modo === 'escanear' ? '#f5f3ff' : '#fff', cursor: 'pointer'
              }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#1e1b4b' }}>📷 Ya tiene QR (vuelve a recarga)</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                Se agrega este servicio a su historial. Mismo QR de siempre.
              </div>
            </button>

            <button
              onClick={() => { setModo('generar'); setCodigo(''); setError(''); }}
              style={{
                textAlign: 'left', padding: '12px 14px', borderRadius: 10,
                border: `2px solid ${modo === 'generar' ? '#7c3aed' : '#e5e7eb'}`,
                background: modo === 'generar' ? '#f5f3ff' : '#fff', cursor: 'pointer'
              }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#1e1b4b' }}>🆕 Equipo nuevo (primera vez)</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                Se genera un QR nuevo y se le pega al extintor.
              </div>
            </button>
          </div>

          {modo === 'escanear' && (
            <div style={{ marginTop: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Código QR del equipo</label>
              <input
                autoFocus
                value={codigo}
                onChange={e => setCodigo(e.target.value.toUpperCase())}
                placeholder="EXT-000123"
                style={{ ...s.input, marginTop: 6, borderColor: '#7c3aed' }}
              />
            </div>
          )}
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnSecundario}>Cancelar</button>
          <button
            onClick={confirmar}
            disabled={!modo || guardando}
            style={{ ...s.btnPrimario, opacity: (!modo || guardando) ? 0.5 : 1 }}>
            {guardando ? 'Procesando...' : (modo === 'generar' ? 'Generar QR' : 'Confirmar QR')}
          </button>
        </div>
      </div>
    </div>
  );
};

const ModalDefecto = ({ orden, equipoActual, onGuardar, onCerrar }) => {
  const [descripcion, setDescripcion] = useState('');
  const [costo, setCosto] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const handleGuardar = async () => {
    if (!descripcion) return setError('Describe el defecto encontrado');
    setGuardando(true); setError('');
    try {
      const res = await onGuardar({ descripcion, costoReparacion: parseFloat(costo) || 0, codigoQR: equipoActual?.codigoQR });
      if (res?.whatsappUrl) window.open(res.whatsappUrl, '_blank');
    } catch (e) { setError(e.response?.data?.error || 'Error al registrar defecto'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>🔧 Registrar Defecto</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>
              {equipoActual ? `${equipoActual.codigoQR} — ${equipoActual.tipo} ${equipoActual.capacidad}` : `Orden ${orden.numeroOrden}`}
            </p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}
          <div style={s.alertWarn}>📱 Al guardar se generará mensaje WhatsApp para el cliente</div>
          <div style={{ marginTop: 14, marginBottom: 14 }}>
            <label style={s.label}>Descripción del defecto *</label>
            <textarea style={s.textarea} value={descripcion} onChange={e => setDescripcion(e.target.value)}
              placeholder="Ej: Válvula dañada, requiere reemplazo. Cilindro con corrosión interna..." />
          </div>
          <div>
            <label style={s.label}>Costo estimado reparación (COP)</label>
            <input type="number" style={s.input} value={costo} onChange={e => setCosto(e.target.value)} placeholder="Ej: 25000" />
          </div>
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnOutline}>Cancelar</button>
          <button onClick={handleGuardar} disabled={guardando} style={s.btn('#e11d48')}>
            {guardando ? 'Guardando...' : '📱 Registrar y Notificar'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL — CONFIGURAR PROCESO
// ═══════════════════════════════════════════════════════════════════════════════
const ModalConfigProceso = ({ proceso, insumos, onGuardar, onCerrar }) => {
  const [nombre, setNombre] = useState(proceso?.nombre || '');
  const [modoRapido, setModoRapido] = useState(proceso?.modoRapido || false);
  const [pasos, setPasos] = useState(proceso?.pasos || [{ id: `p_${Date.now()}`, nombre: '', orden: 1, requiereFoto: false, insumos: [] }]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const agregarPaso = () => setPasos(prev => [...prev, { id: `p_${Date.now()}`, nombre: '', orden: prev.length + 1, requiereFoto: false, insumos: [] }]);
  const eliminarPaso = idx => setPasos(prev => prev.filter((_, i) => i !== idx));
  const updatePaso = (idx, campo, valor) => setPasos(prev => { const n = [...prev]; n[idx] = { ...n[idx], [campo]: valor }; return n; });

  const toggleInsumo = (pasoIdx, insumoId) => {
    const insumo = insumos.find(i => i.id === insumoId);
    const paso = pasos[pasoIdx];
    const existe = paso.insumos.find(i => i.insumoId === insumoId);
    if (existe) updatePaso(pasoIdx, 'insumos', paso.insumos.filter(i => i.insumoId !== insumoId));
    else updatePaso(pasoIdx, 'insumos', [...paso.insumos, { insumoId, insumoNombre: insumo?.nombre, cantidadPorEquipo: 1, unidad: insumo?.unidad }]);
  };

  const handleGuardar = async () => {
    if (!nombre) return setError('El nombre es obligatorio');
    setGuardando(true); setError('');
    try { await onGuardar({ nombre, modoRapido, pasos: modoRapido ? [] : pasos.filter(p => p.nombre) }); }
    catch (e) { setError(e.response?.data?.error || 'Error al guardar'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 700 }}>
        <div style={s.modalHeader}>
          <h3 style={s.modalTitulo}>{proceso ? '✏️ Editar Proceso' : '➕ Nuevo Proceso'}</h3>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}
          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Nombre del proceso *</label>
            <input style={s.input} value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej: Recarga ABC, Mantenimiento CO2, Revisión Anual..." />
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <button onClick={() => setModoRapido(false)} style={s.chip(!modoRapido)}>📋 Checklist completo</button>
            <button onClick={() => setModoRapido(true)} style={s.chip(modoRapido)}>⚡ Modo rápido</button>
          </div>
          {!modoRapido && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <p style={{ ...s.secTitulo, margin: 0 }}>Pasos del proceso</p>
                <button onClick={agregarPaso} style={s.btn()}>+ Agregar paso</button>
              </div>
              {pasos.map((paso, i) => (
                <div key={paso.id} style={{ marginBottom: 12, padding: '12px 14px', borderRadius: 10, border: '1.5px solid #e5e7eb', background: '#fafafa' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', width: 20 }}>{i + 1}.</span>
                    <input style={{ ...s.input, flex: 1 }} value={paso.nombre} onChange={e => updatePaso(i, 'nombre', e.target.value)} placeholder="Ej: Inspección, Lavado, Presurización..." />
                    <button onClick={() => updatePaso(i, 'requiereFoto', !paso.requiereFoto)} style={s.chip(paso.requiereFoto)}>📷</button>
                    <button onClick={() => eliminarPaso(i)} style={{ ...s.btnOutline, color: '#dc2626', borderColor: '#fecaca', padding: '6px 10px' }}>✕</button>
                  </div>
                  {insumos.length > 0 && (
                    <div>
                      <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 6px', fontWeight: 600 }}>INSUMOS:</p>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {insumos.map(ins => {
                          const activo = paso.insumos.some(i => i.insumoId === ins.id);
                          return <button key={ins.id} onClick={() => toggleInsumo(i, ins.id)} style={s.chip(activo)}>{activo ? '✓ ' : ''}{ins.nombre} ({ins.unidad})</button>;
                        })}
                      </div>
                      {paso.insumos.map(ins => (
                        <div key={ins.insumoId} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                          <span style={{ fontSize: 12, color: '#374151', flex: 1 }}>{ins.insumoNombre} — cant/equipo:</span>
                          <input type="number" min={0.1} step={0.1} defaultValue={ins.cantidadPorEquipo || 1}
                            onChange={e => { const nuevos = paso.insumos.map(i => i.insumoId === ins.insumoId ? { ...i, cantidadPorEquipo: parseFloat(e.target.value) } : i); updatePaso(i, 'insumos', nuevos); }}
                            style={{ ...s.input, width: 70, textAlign: 'center' }} />
                          <span style={{ fontSize: 11, color: '#6b7280' }}>{ins.unidad}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnOutline}>Cancelar</button>
          <button onClick={handleGuardar} disabled={guardando} style={s.btn()}>{guardando ? 'Guardando...' : proceso ? 'Guardar cambios' : 'Crear proceso'}</button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL — INSUMO
// ═══════════════════════════════════════════════════════════════════════════════
const ModalInsumo = ({ insumo, onGuardar, onCerrar }) => {
  const [form, setForm] = useState({ nombre: insumo?.nombre || '', unidad: insumo?.unidad || '', stock: insumo?.stock || 0, stockMinimo: insumo?.stockMinimo || 0 });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleGuardar = async () => {
    if (!form.nombre) return setError('El nombre es obligatorio');
    if (!form.unidad) return setError('La unidad es obligatoria');
    setGuardando(true); setError('');
    try { await onGuardar(form); }
    catch (e) { setError(e.response?.data?.error || 'Error al guardar'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 480 }}>
        <div style={s.modalHeader}>
          <h3 style={s.modalTitulo}>{insumo ? '✏️ Editar Insumo' : '➕ Nuevo Insumo'}</h3>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={s.label}>Nombre *</label>
              <input style={s.input} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej: Nitrógeno, Detergente, Empaques..." />
            </div>
            <div>
              <label style={s.label}>Unidad *</label>
              <input style={s.input} value={form.unidad} onChange={e => set('unidad', e.target.value)} placeholder="L, kg, unidades" />
            </div>
            <div>
              <label style={s.label}>Stock actual</label>
              <input type="number" style={s.input} value={form.stock} onChange={e => set('stock', e.target.value)} />
            </div>
            <div>
              <label style={s.label}>Stock mínimo</label>
              <input type="number" style={s.input} value={form.stockMinimo} onChange={e => set('stockMinimo', e.target.value)} />
            </div>
          </div>
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnOutline}>Cancelar</button>
          <button onClick={handleGuardar} disabled={guardando} style={s.btn()}>{guardando ? 'Guardando...' : insumo ? 'Guardar' : 'Crear insumo'}</button>
        </div>
      </div>
    </div>
  );
};
// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTE CONFIG TALLER
// ═══════════════════════════════════════════════════════════════════════════════
const ConfigTaller = () => {
  const [metaDiaria, setMetaDiaria] = useState(60);
  const [alertaTiempoHoras, setAlertaTiempoHoras] = useState(48);
  const [guardando, setGuardando] = useState(false);
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    axios.get(`${API}/workshop/config`, auth())
      .then(({ data }) => {
        setMetaDiaria(data.metaDiaria || 60);
        setAlertaTiempoHoras(data.alertaTiempoHoras || 48);
      }).catch(() => {});
  }, []);

  const handleGuardar = async () => {
    setGuardando(true); setOk(''); setErr('');
    try {
      await axios.put(`${API}/workshop/config`, { metaDiaria, alertaTiempoHoras }, auth());
      setOk('✅ Configuración guardada');
      setTimeout(() => setOk(''), 3000);
    } catch (e) {
      setErr(e.response?.data?.error || 'Error al guardar');
    }
    setGuardando(false);
  };

  return (
    <div>
      <div style={s.card}>
        <p style={s.secTitulo}>🎯 Metas y alertas del taller</p>
        {ok && <div style={s.alertOk}>{ok}</div>}
        {err && <div style={s.alertError}>{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={s.label}>Meta diaria de equipos</label>
            <input type="number" min={1} max={500} style={s.input}
              value={metaDiaria} onChange={e => setMetaDiaria(parseInt(e.target.value) || 1)} />
            <p style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
              Ej: 60 extintores por día. Se muestra en el dashboard de Pedro.
            </p>
          </div>
          <div>
            <label style={s.label}>Alerta de tiempo en taller (horas)</label>
            <input type="number" min={1} max={168} style={s.input}
              value={alertaTiempoHoras} onChange={e => setAlertaTiempoHoras(parseInt(e.target.value) || 48)} />
            <p style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
              Si una orden lleva más de estas horas en taller → alerta roja.
            </p>
          </div>
        </div>

        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={handleGuardar} disabled={guardando} style={s.btn()}>
            {guardando ? 'Guardando...' : '💾 Guardar configuración'}
          </button>
        </div>
      </div>
    </div>
  );
};
// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
export default function GestionTaller({ user }) {
  const esAdmin = user?.role === 'admin';
  const [tab, setTab] = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [ordenes, setOrdenes] = useState([]);
  const [procesos, setProcesos] = useState([]);
  const [insumos, setInsumos] = useState([]);
  const [alertas, setAlertas] = useState([]);
  const [equiposSinProceso, setEquiposSinProceso] = useState([]); // QR manuales pendientes

  // Modales
  const [modalRecibir, setModalRecibir] = useState(null);
  const [modalDefecto, setModalDefecto] = useState(null);
  const [modalProcesoEquipo, setModalProcesoEquipo] = useState(null); // { orden, equipo }
  const [modalQR, setModalQR] = useState(null); // { orden, equipo } — generar/escanear QR
  const [modalConfigProceso, setModalConfigProceso] = useState(null);
  const [modalInsumo, setModalInsumo] = useState(null);

  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');

  const notif = (msg, tipo = 'ok') => {
    if (tipo === 'ok') { setOk(msg); setTimeout(() => setOk(''), 3500); }
    else { setErr(msg); setTimeout(() => setErr(''), 4000); }
  };

  // ─── CARGAR DATOS ────────────────────────────────────────────────────────────
  const cargarDashboard = useCallback(async () => {
    try { const { data } = await axios.get(`${API}/workshop/dashboard`, auth()); setDashboard(data); }
    catch (e) { console.error('Dashboard taller:', e); }
  }, []);

  const cargarOrdenes = useCallback(async () => {
    try { const { data } = await axios.get(`${API}/workshop/ordenes`, auth()); setOrdenes(data); }
    catch (e) { console.error('Órdenes taller:', e); }
  }, []);

  const cargarProcesos = useCallback(async () => {
    try { const { data } = await axios.get(`${API}/workshop/procesos`, auth()); setProcesos(data); }
    catch (e) { console.error('Procesos:', e); }
  }, []);

  const cargarInsumos = useCallback(async () => {
    try { const { data } = await axios.get(`${API}/workshop/insumos`, auth()); setInsumos(data); }
    catch (e) { console.error('Insumos:', e); }
  }, []);

  const cargarAlertas = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API}/workshop/alertas?soloNoLeidas=true`, auth());
      setAlertas(data.filter(a => a.tipo !== 'listo_facturar'));
    }
    catch (e) { console.error('Alertas:', e); }
  }, []);

  const cargarEquiposSinProceso = useCallback(async () => {
    try {
      // QR creados manualmente sin proceso registrado aún
      const { data } = await axios.get(`${API}/qr?soloNoImpreso=false`, auth());
      const sinProceso = (Array.isArray(data) ? data : []).filter(e => !e.ultimaIntervencion || e.ultimaIntervencion.tipo === 'Creación automática' || e.ultimaIntervencion.tipo === 'Creación QR');
      setEquiposSinProceso(sinProceso.slice(0, 20));
    }
    catch (e) { console.error('Equipos sin proceso:', e); }
  }, []);

  useEffect(() => {
    cargarDashboard(); cargarOrdenes(); cargarProcesos(); cargarInsumos(); cargarAlertas(); cargarEquiposSinProceso();
    const interval = setInterval(() => { cargarDashboard(); cargarAlertas(); }, 60000);
    return () => clearInterval(interval);
  }, []);

  // ─── EXPANDIR EQUIPOS POR ORDEN ──────────────────────────────────────────────
  // Antes buscaba QR pre-generados. Como el QR ya NO se autogenera (para no
  // duplicar), si no hay QR ligados, se arma la lista desde los items de
  // taller de la orden. El técnico genera/escanea el QR de cada uno.
  const [equiposOrden, setEquiposOrden] = useState({});

  const esItemTallerFront = (item = {}) => {
    const cat = (item.categoria || '').toLowerCase();
    return ['recarga', 'mantenimiento', 'prueba hidrostatica', 'prueba hidrostática', 'hidrostatica', 'hidrostática']
      .some(c => cat.includes(c));
  };

  const cargarEquiposDeOrden = async (ordenId, numeroOrden) => {
    if (equiposOrden[ordenId]) return; // ya cargado
    try {
      let equipos = [];
      // 1. ¿Hay QR ya ligados a esta orden? (compatibilidad con datos viejos)
      try {
        const { data } = await axios.get(`${API}/qr`, auth());
        equipos = (Array.isArray(data) ? data : []).filter(e => e.ordenId === ordenId);
      } catch (e) { /* sin QR previos, seguimos */ }

      // 2. Si no hay QR, expandir desde los items de taller de la orden.
      if (equipos.length === 0) {
        const ord = ordenes.find(o => o.id === ordenId);
        const items = (ord?.items || []).filter(esItemTallerFront);
        equipos = [];
       const separarTipoCap = (nombre) => {
          const nom = (nombre || '').trim();
          const up = nom.toUpperCase();
          const tipos = ['ABC','BC','CO2','AGUA','ACETATO','SOLKAFLAM','HALOTRON','PQS'];
          for (const t of tipos) {
            if (up.startsWith(t + ' ') || up === t) {
              return { tipo: t, capacidad: nom.substring(t.length).trim() };
            }
          }
          return { tipo: 'ABC', capacidad: nom };
        };
        items.forEach((it, idx) => {
          const cant = it.cantidad || 1;
          const { tipo: tipoEq, capacidad: capEq } = separarTipoCap(it.nombre);
          for (let n = 0; n < cant; n++) {
            equipos.push({
              codigoQR: null,                  // aún sin QR — el taller decide
              qrPendiente: true,
              nombre: it.nombre || '',
              tipo: tipoEq,
              capacidad: capEq,
              categoria: it.categoria || '',
              esCambio: !!it.esCambio,
              codigoQRsugerido: it.codigoQR || '',  // si vino de un cambio
              procesado: false,
              _itemIdx: idx, _unidad: n + 1, _totalUnidad: cant
            });
          }
        });
      }
      setEquiposOrden(prev => ({ ...prev, [ordenId]: equipos }));
    } catch (e) { console.error('Error cargando equipos orden:', e); }
  };

  // ─── ACCIONES ÓRDENES ────────────────────────────────────────────────────────
  const handleRecibir = async (ordenId, datos) => {
    await axios.post(`${API}/workshop/ordenes/${ordenId}/recibir`, datos, auth());
    notif('Recepción registrada correctamente');
    setModalRecibir(null);
    cargarOrdenes(); cargarDashboard();
  };

  const handleDefecto = async (ordenId, datos) => {
    const { data } = await axios.post(`${API}/workshop/ordenes/${ordenId}/defecto`, datos, auth());
    notif('Defecto registrado — notificación WhatsApp generada');
    setModalDefecto(null);
    cargarOrdenes();
    return data;
  };

  // ─── RESOLVER QR (generar nuevo o escanear existente) ────────────────────────
  // El taller decide: equipo nuevo → genera QR; equipo que ya tiene QR →
  // escanea y se agrega el servicio a su historial (mismo QR de por vida).
  const handleResolverQR = async ({ orden, equipo, modo, codigoQR }) => {
    const body = {
      modo,                       // 'generar' | 'escanear'
      codigoQR: codigoQR || '',
      ordenId: orden.id,
      numeroOrden: orden.numeroOrden,
      empresaId: orden.empresaId || '',
      clienteId: orden.clienteId || null,
      clienteNombre: orden.clienteNombre || '',
      ubicacion: orden.sucursalNombre || orden.sucursalDireccion || '',
      tipo: equipo?.tipo || 'ABC',
      capacidad: equipo?.capacidad || equipo?.nombre || '',
      requierePH: (equipo?.tipo || '').toUpperCase() === 'CO2',
      tipoIntervencion: 'Recarga / Mantenimiento'
    };
    const { data } = await axios.post(`${API}/qr/resolver`, body, auth());
    notif(modo === 'escanear'
      ? `Servicio agregado al equipo ${data.codigoQR}`
      : `QR ${data.codigoQR} generado`);
    setModalQR(null);
    // Recargar la lista de equipos de esta orden para que aparezca con su QR
    setEquiposOrden(prev => { const c = { ...prev }; delete c[orden.id]; return c; });
    cargarOrdenes(); cargarDashboard();
    return data;
  };

  // ─── COMPLETAR EQUIPO INDIVIDUAL ─────────────────────────────────────────────
  const handleCompletarEquipo = async ({ ordenId, orden, equipoId, codigoQR, procesoNombre, procesosCompletados, observaciones, insumosUsados, modoRapido }) => {
    // 1. Registrar paso en la orden
    await axios.post(`${API}/workshop/ordenes/${ordenId}/paso`, {
      pasoId: `equipo_${codigoQR || equipoId}`,
      pasoNombre: `${codigoQR} — ${procesoNombre}`,
      insumosUsados,
      observaciones
    }, auth());

    // 2. Actualizar QR del equipo si tiene código
    if (codigoQR) {
      await axios.put(`${API}/qr/${codigoQR}`, {
        tipoIntervencion: procesoNombre,
        observaciones,
        pasos: procesosCompletados,
        fechaUltimaRecarga: new Date().toISOString(),
        proximaRecarga: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString(),
        ordenId,
        numeroOrden: orden.numeroOrden
      }, auth());
    }

    // 3. Verificar si todos los equipos de la orden están listos
    const equipos = equiposOrden[ordenId] || [];
    const updatedEquipos = equipos.map(e => e.codigoQR === codigoQR ? { ...e, procesado: true } : e);
    setEquiposOrden(prev => ({ ...prev, [ordenId]: updatedEquipos }));

    const todosListos = updatedEquipos.length > 0 && updatedEquipos.every(e => e.procesado);

    if (todosListos) {
      // Completar toda la orden → pasa a Facturación
      await axios.post(`${API}/workshop/ordenes/${ordenId}/completar`, {
        observacionesFinal: `Todos los equipos procesados. Último: ${codigoQR}`,
        procesosCompletados
      }, auth());
      notif(`✅ Todos los equipos listos — Orden ${orden.numeroOrden} pasa a Facturación`);
    } else {
      notif(`✅ Equipo ${codigoQR} listo`);
    }

    setModalProcesoEquipo(null);
    cargarOrdenes(); cargarDashboard(); cargarEquiposDeOrden(ordenId, orden.numeroOrden);
  };

  // ─── ACCIONES PROCESOS ───────────────────────────────────────────────────────
  const handleGuardarProceso = async (datos) => {
    if (modalConfigProceso?.id) await axios.put(`${API}/workshop/procesos/${modalConfigProceso.id}`, datos, auth());
    else await axios.post(`${API}/workshop/procesos`, datos, auth());
    notif('Proceso guardado');
    setModalConfigProceso(null);
    cargarProcesos();
  };

  const handleEliminarProceso = async id => {
    if (!window.confirm('¿Eliminar este proceso?')) return;
    await axios.delete(`${API}/workshop/procesos/${id}`, auth());
    notif('Proceso eliminado');
    cargarProcesos();
  };

  // ─── ACCIONES INSUMOS ────────────────────────────────────────────────────────
  const handleGuardarInsumo = async datos => {
    if (modalInsumo?.id) await axios.put(`${API}/workshop/insumos/${modalInsumo.id}`, datos, auth());
    else await axios.post(`${API}/workshop/insumos`, datos, auth());
    notif('Insumo guardado');
    setModalInsumo(null);
    cargarInsumos(); cargarDashboard();
  };

  const handleLeerAlerta = async id => {
    await axios.put(`${API}/workshop/alertas/${id}/leer`, {}, auth());
    cargarAlertas();
  };

 const TABS = [
    { key: 'dashboard', label: '📊 Dashboard', roles: ['admin', 'taller'] },
    { key: 'ordenes', label: '🔧 Órdenes en Taller', roles: ['admin', 'taller'] },
    { key: 'equipos_pendientes', label: `⚙️ Sin Proceso${equiposSinProceso.length > 0 ? ` (${equiposSinProceso.length})` : ''}`, roles: ['admin', 'taller'] },
    { key: 'procesos', label: '📋 Procesos', roles: ['admin'] },
    { key: 'insumos', label: '🧪 Insumos', roles: ['admin', 'taller'] },
    { key: 'alertas', label: `🔔 Alertas${alertas.length > 0 ? ` (${alertas.length})` : ''}`, roles: ['admin', 'taller'] },
    { key: 'config', label: '⚙️ Configuración', roles: ['admin'] },
  ].filter(t => t.roles.includes(user?.role));

  return (
    <div style={s.page}>
      {/* Notificaciones */}
      {ok && <div style={{ ...s.alertOk, position: 'fixed', top: 20, right: 20, zIndex: 9999, maxWidth: 380, boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }}>{ok}</div>}
      {err && <div style={{ ...s.alertError, position: 'fixed', top: 20, right: 20, zIndex: 9999, maxWidth: 380, boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }}>{err}</div>}

      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.titulo}>🔧 Taller</h1>
          <p style={s.subtitulo}>{user?.role === 'taller' ? `Hola ${user?.nombre || 'Pedro'} — ` : ''}Control de procesos y equipos</p>
        </div>
        {alertas.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: '#fef2f2', borderRadius: 10, border: '1px solid #fecaca' }}>
            <span style={{ fontSize: 18 }}>🔔</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#dc2626' }}>{alertas.length} alerta{alertas.length !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ ...s.tabs, marginBottom: 24 }}>
        {TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={s.tab(tab === t.key)}>{t.label}</button>)}
      </div>

      {/* ─── TAB DASHBOARD ─── */}
      {tab === 'dashboard' && dashboard && (
        <div>
          <div style={s.grid4}>
            <div style={s.card}><div style={s.kpi}><div style={{ ...s.kpiNum, color: '#7c3aed' }}>{dashboard.hoy.equiposCompletados}</div><div style={s.kpiLabel}>Completados hoy</div></div></div>
            <div style={s.card}><div style={s.kpi}><div style={{ ...s.kpiNum, color: '#16a34a' }}>{dashboard.mes.equiposCompletados}</div><div style={s.kpiLabel}>Este mes</div></div></div>
            <div style={s.card}><div style={s.kpi}><div style={{ ...s.kpiNum, color: '#f59e0b' }}>{dashboard.enTaller.total}</div><div style={s.kpiLabel}>En taller ahora</div></div></div>
            <div style={equiposSinProceso.length > 0 ? s.cardAmarillo : s.card}>
              <div style={s.kpi}>
                <div style={{ ...s.kpiNum, color: equiposSinProceso.length > 0 ? '#d97706' : '#6b7280' }}>{equiposSinProceso.length}</div>
                <div style={s.kpiLabel}>Sin proceso</div>
              </div>
            </div>
          </div>

          <div style={{ ...s.card, marginTop: 16 }}>
            <BarraMeta completados={dashboard.hoy.equiposCompletados} meta={dashboard.hoy.metaDiaria} />
          </div>

          {dashboard.alertas.tiempo.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p style={s.secTitulo}>🚨 Órdenes urgentes</p>
              <div style={s.grid2}>
                {dashboard.alertas.tiempo.map(a => (
                  <div key={a.id} style={s.cardRojo}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div>
                        <p style={{ margin: '0 0 4px', fontWeight: 800, color: '#dc2626' }}>{a.numeroOrden}</p>
                        <p style={{ margin: 0, fontSize: 13, color: '#374151' }}>{a.clienteNombre}</p>
                      </div>
                      <BadgeEstado horas={a.horasEnTaller} alerta={true} />
                    </div>
                    <p style={{ margin: '6px 0 0', fontSize: 12, color: '#6b7280' }}>Lleva <b>{fmtHoras(a.horasEnTaller)}</b> en taller</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {dashboard.alertas.insumos.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p style={s.secTitulo}>⚠️ Insumos con stock bajo</p>
              <div style={s.grid2}>
                {dashboard.alertas.insumos.map(ins => (
                  <div key={ins.id} style={s.cardAmarillo}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <p style={{ margin: '0 0 4px', fontWeight: 700, color: '#92400e' }}>{ins.nombre}</p>
                      <span style={s.badge('#d97706', '#fde68a')}>Stock bajo</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13 }}>Actual: <b>{ins.stock} {ins.unidad}</b> — Mínimo: {ins.stockMinimo}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.keys(dashboard.mes.porCapacidad || {}).length > 0 && (
            <div style={{ ...s.card, marginTop: 16 }}>
              <p style={{ ...s.secTitulo, marginBottom: 12 }}>📊 Producción del mes por tipo</p>
              <div style={s.grid4}>
                {Object.entries(dashboard.mes.porCapacidad).map(([tipo, cant]) => (
                  <div key={tipo} style={{ padding: '10px 14px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#7c3aed' }}>{cant}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{tipo}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── TAB ÓRDENES ─── */}
      {tab === 'ordenes' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>{ordenes.length} orden{ordenes.length !== 1 ? 'es' : ''} en taller</p>
            <button onClick={cargarOrdenes} style={s.btnOutline}>🔄 Actualizar</button>
          </div>

          {ordenes.length === 0 ? (
            <div style={{ ...s.card, textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Sin órdenes en taller</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {ordenes.map(orden => {
                const equipos = equiposOrden[orden.id] || [];
                const equiposCargados = equipos.length > 0;
                const equiposListos = equipos.filter(e => e.procesado).length;
                const totalEquipos = equipos.length;

                return (
                  <div key={orden.id} style={orden.alertaTiempo ? s.cardRojo : s.card}>
                    {/* Header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
  <span style={{ fontWeight: 800, fontSize: 15, color: '#1e1b4b' }}>{orden.numeroOrden}</span>
  <BadgeEstado horas={orden.horasEnTaller || 0} alerta={orden.alertaTiempo} />
  {orden.tieneDefectosPendientes && <span style={s.badge('#e11d48', '#ffe4e8')}>🔧 Defecto pendiente</span>}
  {orden.tallerCompletado && <span style={s.badge('#16a34a', '#f0fdf4')}>✅ Completada</span>}
  {/* ✅ NUEVO: Advertencia si hay otros productos */}
  {orden.itemsOtros > 0 && (
    <span style={s.badge('#f59e0b', '#fffbeb')} title="Orden contiene otros productos que no son de taller">
      ⚠️ {orden.itemsOtros} otros
    </span>
  )}
</div>
<p style={{ margin: '4px 0 0', fontSize: 13, fontWeight: 600, color: '#374151' }}>
  {orden.clienteNombre}
  {/* ✅ NUEVO: Subtítulo mostrando equipos de taller */}
  {orden.items && orden.items.length > 0 && (
    <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>
      · {orden.items.length} equipo{orden.items.length !== 1 ? 's' : ''} de taller
    </span>
  )}
</p>

                        <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>{orden.empresaNombre}</p>
                      </div>
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#1e1b4b' }}>{fmt(orden.total)}</p>
                    </div>

                    {/* Progreso equipos */}
                    {equiposCargados && (
                      <div style={{ marginTop: 10, padding: '8px 12px', background: '#f9fafb', borderRadius: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Equipos procesados: {equiposListos}/{totalEquipos}</span>
                          <span style={{ fontSize: 12, color: equiposListos === totalEquipos ? '#16a34a' : '#f59e0b', fontWeight: 700 }}>
                            {equiposListos === totalEquipos ? '✅ Todos listos' : `${totalEquipos - equiposListos} pendientes`}
                          </span>
                        </div>
                        <div style={{ background: '#e5e7eb', borderRadius: 6, height: 6, overflow: 'hidden' }}>
                          <div style={{ width: `${totalEquipos > 0 ? (equiposListos/totalEquipos)*100 : 0}%`, height: '100%', background: '#16a34a', borderRadius: 6, transition: 'width 0.3s' }} />
                        </div>
                      </div>
                    )}

                    {/* Lista equipos individuales */}
                    {equiposCargados && (
                      <div style={{ marginTop: 10 }}>
                        {equipos.length === 0 && (
                          <div style={s.alertWarn}>
                            Esta orden no tiene equipos de taller (recarga/mantenimiento/PH).
                            Si es una venta, no requiere proceso de taller.
                          </div>
                        )}
                        {equipos.map((eq, i) => (
                          <div key={eq.codigoQR || `pend-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: eq.procesado ? '#f0fdf4' : '#fafafa', border: `1px solid ${eq.procesado ? '#bbf7d0' : '#e5e7eb'}`, marginBottom: 6 }}>
                            <span style={{ fontSize: 18 }}>{eq.procesado ? '✅' : (eq.codigoQR ? '⏳' : '🏷️')}</span>
                            <div style={{ flex: 1 }}>
                              {eq.codigoQR
                                ? <span style={{ fontSize: 12, fontWeight: 700, color: '#1e1b4b' }}>{eq.codigoQR}</span>
                                : <span style={{ fontSize: 12, fontWeight: 700, color: '#d97706' }}>
                                    {eq._totalUnidad > 1 ? `Equipo ${eq._unidad}/${eq._totalUnidad} — ` : ''}QR pendiente
                                  </span>}
                              <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{eq.tipo} — {eq.capacidad}</span>
                            </div>
                            {!eq.codigoQR && !orden.tallerCompletado && (
                              <button
                                onClick={() => setModalQR({ orden, equipo: eq })}
                                style={s.btnSm('#7c3aed')}>
                                🏷️ Generar / Escanear QR
                              </button>
                            )}
                            {eq.codigoQR && !eq.procesado && !orden.tallerCompletado && procesos.length > 0 && (
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => setModalProcesoEquipo({ orden, equipo: eq })} style={s.btnSm()}>⚙️ Procesar</button>
                                <button onClick={() => setModalDefecto({ orden, equipo: eq })} style={s.btnSm('#e11d48')}>🔧 Defecto</button>
                              </div>
                            )}
                            {eq.procesado && <span style={s.badge('#16a34a', '#f0fdf4')}>Listo</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Acciones principales */}
                    <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {!orden.tallerRecepcion && (
                        <button onClick={() => setModalRecibir(orden)} style={s.btn('#f59e0b')}>📦 Recibir equipos</button>
                      )}

                      {orden.tallerRecepcion && !equiposCargados && !orden.tallerCompletado && (
                        <button onClick={() => cargarEquiposDeOrden(orden.id, orden.numeroOrden)} style={s.btn()}>
                          📋 Ver equipos individuales
                        </button>
                      )}

                      {orden.tallerRecepcion && !equiposCargados && !orden.tallerCompletado && procesos.length === 0 && (
                        <div style={s.alertWarn}>
                          ⚠️ No hay procesos configurados.
                          {esAdmin && <button onClick={() => { setTab('procesos'); setModalConfigProceso({}); }} style={{ marginLeft: 8, ...s.btn() }}>Crear proceso</button>}
                        </div>
                      )}

                      {orden.tallerRecepcion && !equiposCargados && !orden.tallerCompletado && procesos.length > 0 && (
                        <button onClick={() => setModalDefecto({ orden, equipo: null })} style={s.btn('#e11d48')}>🔧 Registrar defecto general</button>
                      )}

                      {orden.tallerCompletado && <span style={s.badge('#16a34a', '#f0fdf4')}>✅ En Facturación</span>}
                    </div>

                    {orden.tallerRecepcion?.observaciones && (
                      <div style={{ marginTop: 8, padding: '6px 10px', background: '#fffbeb', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
                        📝 {orden.tallerRecepcion.observaciones}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── TAB EQUIPOS SIN PROCESO ─── */}
      {tab === 'equipos_pendientes' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>{equiposSinProceso.length} equipo{equiposSinProceso.length !== 1 ? 's' : ''} pendientes de proceso</p>
            <button onClick={cargarEquiposSinProceso} style={s.btnOutline}>🔄 Actualizar</button>
          </div>

          {equiposSinProceso.length === 0 ? (
            <div style={{ ...s.card, textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Todos los equipos procesados</p>
            </div>
          ) : (
            <div style={s.grid2}>
              {equiposSinProceso.map(eq => (
                <div key={eq.codigoQR} style={s.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: 14, color: '#1e1b4b' }}>{eq.codigoQR}</span>
                      <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>{eq.tipo} — {eq.capacidad}</span>
                    </div>
                    <span style={s.badge('#d97706', '#fffbeb')}>⏳ Pendiente</span>
                  </div>
                  {eq.propietario ? (
                    <p style={{ margin: '0 0 8px', fontSize: 12, color: '#374151' }}>👤 {eq.propietario}</p>
                  ) : (
                    <p style={{ margin: '0 0 8px', fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>Sin propietario (stock/cambio)</p>
                  )}
                  {procesos.length > 0 ? (
                    <button onClick={() => setModalProcesoEquipo({ orden: { id: 'manual', numeroOrden: 'MANUAL', clienteNombre: eq.propietario || 'Sin propietario' }, equipo: eq })} style={{ ...s.btn(), width: '100%' }}>
                      ⚙️ Ejecutar proceso
                    </button>
                  ) : (
                    <div style={{ ...s.alertWarn, fontSize: 12 }}>Sin procesos configurados</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── TAB PROCESOS ─── */}
      {tab === 'procesos' && esAdmin && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>{procesos.length} proceso{procesos.length !== 1 ? 's' : ''} configurado{procesos.length !== 1 ? 's' : ''}</p>
            <button onClick={() => setModalConfigProceso({})} style={s.btn()}>+ Nuevo proceso</button>
          </div>
          {procesos.length === 0 ? (
            <div style={{ ...s.card, textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>⚙️</div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Sin procesos configurados</p>
              <button onClick={() => setModalConfigProceso({})} style={{ ...s.btn(), marginTop: 16 }}>+ Crear primer proceso</button>
            </div>
          ) : (
            <div style={s.grid2}>
              {procesos.map(p => (
                <div key={p.id} style={s.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <p style={{ margin: '0 0 4px', fontWeight: 800, fontSize: 15, color: '#1e1b4b' }}>{p.nombre}</p>
                      <span style={p.modoRapido ? s.badge('#f59e0b', '#fffbeb') : s.badge('#7c3aed', '#ede9fe')}>
                        {p.modoRapido ? '⚡ Modo rápido' : `📋 ${p.pasos?.length || 0} pasos`}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => setModalConfigProceso(p)} style={s.btnOutline}>✏️</button>
                      <button onClick={() => handleEliminarProceso(p.id)} style={{ ...s.btnOutline, color: '#dc2626', borderColor: '#fecaca' }}>🗑️</button>
                    </div>
                  </div>
                  {!p.modoRapido && p.pasos?.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      {p.pasos.map((paso, i) => (
                        <div key={paso.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#ede9fe', color: '#7c3aed', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
                          <span style={{ fontSize: 13, flex: 1 }}>{paso.nombre}</span>
                          {paso.insumos?.length > 0 && <span style={s.badge('#059669', '#ecfdf5')}>🧪 {paso.insumos.length}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── TAB INSUMOS ─── */}
      {tab === 'insumos' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>{insumos.length} insumo{insumos.length !== 1 ? 's' : ''}</p>
            {esAdmin && <button onClick={() => setModalInsumo({})} style={s.btn()}>+ Nuevo insumo</button>}
          </div>
          {insumos.length === 0 ? (
            <div style={{ ...s.card, textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🧪</div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Sin insumos registrados</p>
              {esAdmin && <button onClick={() => setModalInsumo({})} style={{ ...s.btn(), marginTop: 16 }}>+ Agregar insumo</button>}
            </div>
          ) : (
            <div style={s.grid2}>
              {insumos.map(ins => (
                <div key={ins.id} style={ins.alerta ? s.cardAmarillo : s.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <div>
                      <p style={{ margin: '0 0 4px', fontWeight: 800, fontSize: 15, color: ins.alerta ? '#92400e' : '#1e1b4b' }}>{ins.nombre}</p>
                      <p style={{ margin: 0, fontSize: 13 }}>Stock: <b style={{ fontSize: 16, color: ins.alerta ? '#dc2626' : '#1e1b4b' }}>{ins.stock}</b> {ins.unidad}</p>
                      <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Mínimo: {ins.stockMinimo} {ins.unidad}</p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                      {ins.alerta && <span style={s.badge('#d97706', '#fde68a')}>⚠️ Stock bajo</span>}
                      {esAdmin && <button onClick={() => setModalInsumo(ins)} style={s.btnOutline}>✏️ Editar</button>}
                    </div>
                  </div>
                  <div style={{ marginTop: 10, background: '#e5e7eb', borderRadius: 6, height: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, (ins.stock / Math.max(ins.stock, ins.stockMinimo * 2)) * 100)}%`, height: '100%', background: ins.alerta ? '#f59e0b' : '#16a34a', borderRadius: 6 }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── TAB ALERTAS ─── */}
      {tab === 'alertas' && (
        <div>
          {alertas.length === 0 ? (
            <div style={{ ...s.card, textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🔔</div>
              <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Sin alertas pendientes</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {alertas.map(a => (
                <div key={a.id} style={{ ...s.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderLeft: `4px solid ${a.tipo === 'insumo_bajo' ? '#f59e0b' : '#dc2626'}` }}>
                  <div>
                    <p style={{ margin: '0 0 2px', fontSize: 13, fontWeight: 700 }}>{a.mensaje}</p>
                    <p style={{ margin: 0, fontSize: 11, color: '#6b7280' }}>{fmtFecha(a.fecha)}</p>
                  </div>
                  <button onClick={() => handleLeerAlerta(a.id)} style={s.btnOutline}>✓ Leída</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
{/* ─── TAB CONFIG ─── */}
      {tab === 'config' && esAdmin && (
        <ConfigTaller />
      )}

      {/* ═══ MODALES ═══ */}
      {modalRecibir && (
        <ModalRecibir orden={modalRecibir} onGuardar={d => handleRecibir(modalRecibir.id, d)} onCerrar={() => setModalRecibir(null)} />
      )}

      {modalDefecto && (
        <ModalDefecto
          orden={modalDefecto.orden || modalDefecto}
          equipoActual={modalDefecto.equipo || null}
          onGuardar={d => handleDefecto((modalDefecto.orden || modalDefecto).id, d)}
          onCerrar={() => setModalDefecto(null)}
        />
      )}

      {modalProcesoEquipo && (
        <ModalProcesoEquipo
          equipo={modalProcesoEquipo.equipo}
          ordenId={modalProcesoEquipo.orden.id}
          numeroOrden={modalProcesoEquipo.orden.numeroOrden}
          procesos={procesos}
          insumos={insumos}
          onGuardar={datos => handleCompletarEquipo({ ordenId: modalProcesoEquipo.orden.id, orden: modalProcesoEquipo.orden, ...datos })}
          onCerrar={() => setModalProcesoEquipo(null)}
        />
      )}

      {modalQR && (
        <ModalQR
          orden={modalQR.orden}
          equipo={modalQR.equipo}
          onResolver={handleResolverQR}
          onCerrar={() => setModalQR(null)}
        />
      )}

      {modalConfigProceso !== null && (
        <ModalConfigProceso proceso={modalConfigProceso?.id ? modalConfigProceso : null} insumos={insumos} onGuardar={handleGuardarProceso} onCerrar={() => setModalConfigProceso(null)} />
      )}

      {modalInsumo !== null && (
        <ModalInsumo insumo={modalInsumo?.id ? modalInsumo : null} onGuardar={handleGuardarInsumo} onCerrar={() => setModalInsumo(null)} />
      )}
    </div>
  );
}
