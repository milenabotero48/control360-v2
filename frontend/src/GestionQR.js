import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const token = () => localStorage.getItem('token');
const auth = () => ({ headers: { Authorization: `Bearer ${token()}` } });
const fmtFecha = f => { if (!f) return '—'; try { return new Date(f).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
const QR_PUBLIC_URL = window.location.origin + '/qr-public.html?c=';

// ─── ESTILOS ──────────────────────────────────────────────────────────────────
const s = {
  page: { padding: '20px', maxWidth: 1200, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 },
  titulo: { margin: 0, fontSize: 22, fontWeight: 800, color: '#1e1b4b' },
  subtitulo: { margin: '2px 0 0', fontSize: 13, color: '#6b7280' },
  tabs: { display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 10, padding: 4, marginBottom: 24, flexWrap: 'wrap' },
  tab: a => ({ padding: '8px 16px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, background: a ? '#fff' : 'transparent', color: a ? '#7c3aed' : '#6b7280', boxShadow: a ? '0 1px 4px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.15s' }),
  card: { background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', border: '1px solid #f1f5f9', marginBottom: 16 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 },
  btn: (c = '#7c3aed') => ({ padding: '9px 18px', borderRadius: 8, border: 'none', background: c, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }),
  btnOutline: { padding: '8px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  btnSm: (c = '#7c3aed') => ({ padding: '5px 12px', borderRadius: 6, border: 'none', background: c, color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }),
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, color: '#1f2937', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, color: '#1f2937', outline: 'none', background: '#fff', boxSizing: 'border-box' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' },
  mHeader: { padding: '18px 22px 14px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  mTitulo: { margin: 0, fontSize: 17, fontWeight: 800, color: '#1e1b4b' },
  mBody: { padding: '18px 22px' },
  mFooter: { padding: '14px 22px', borderTop: '1px solid #f1f5f9', display: 'flex', gap: 10, justifyContent: 'flex-end' },
  btnX: { background: '#f3f4f6', border: 'none', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 15 },
  badge: (c, b) => ({ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: b, color: c }),
  alertOk: { background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12 },
  alertErr: { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12 },
  alertWarn: { background: '#fffbeb', color: '#d97706', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', fontSize: 13 },
  sep: { height: 1, background: '#f1f5f9', margin: '14px 0' },
  secTit: { fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' },
  checkbox: (activo) => ({ width: 20, height: 20, borderRadius: 5, border: `2px solid ${activo ? '#7c3aed' : '#d1d5db'}`, background: activo ? '#7c3aed' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, fontSize: 12, color: '#fff' }),
};

// ─── GENERADOR QR CANVAS ──────────────────────────────────────────────────────
// Usa la API pública de QR code
const QRImg = ({ value, size = 100 }) => (
  <img
    src={`https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(value)}&bgcolor=ffffff&color=1a1a2e&margin=2`}
    alt={value} width={size} height={size}
    style={{ borderRadius: 6, display: 'block' }}
  />
);

// ─── MODAL DETALLE / EDITAR QR ────────────────────────────────────────────────
const ModalDetalleQR = ({ equipo, clientes, onGuardar, onCerrar }) => {
  const [form, setForm] = useState({
    tipo: equipo.tipo || '',
    capacidad: equipo.capacidad || '',
    ubicacion: equipo.ubicacion || '',
    notas: equipo.notas || '',
    ph: equipo.ph || '',
    presion: equipo.presion || '',
    fechaPH: equipo.fechaPH ? equipo.fechaPH.split('T')[0] : '',
    fechaUltimaRecarga: equipo.fechaUltimaRecarga ? equipo.fechaUltimaRecarga.split('T')[0] : '',
    proximaRecarga: equipo.proximaRecarga ? equipo.proximaRecarga.split('T')[0] : '',
    proximoMantenimiento: equipo.proximoMantenimiento ? equipo.proximoMantenimiento.split('T')[0] : '',
    clienteId: equipo.clienteId || '',
    clienteNombre: equipo.propietario || '',
    tipoIntervencion: 'Actualización manual',
    observaciones: '',
  });
  const [tab, setTab] = useState('info');
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleGuardar = async () => {
    setGuardando(true); setErr('');
    try { await onGuardar(equipo.codigoQR, form); }
    catch (e) { setErr(e.response?.data?.error || 'Error al guardar'); }
    setGuardando(false);
  };

  const urlPublica = QR_PUBLIC_URL + equipo.codigoQR;

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 640 }}>
        <div style={s.mHeader}>
          <div>
            <h3 style={s.mTitulo}>📲 {equipo.codigoQR}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>{equipo.tipo} — {equipo.capacidad} {equipo.propietario ? `· ${equipo.propietario}` : '· Sin propietario'}</p>
          </div>
          <button onClick={onCerrar} style={s.btnX}>✕</button>
        </div>
        <div style={s.mBody}>
          {err && <div style={s.alertErr}>{err}</div>}

          {/* Tabs */}
          <div style={{ ...s.tabs, marginBottom: 16 }}>
            {['info', 'historial'].map(t => (
              <button key={t} onClick={() => setTab(t)} style={s.tab(tab === t)}>
                {t === 'info' ? '✏️ Editar' : '📋 Historial'}
              </button>
            ))}
          </div>

          {tab === 'info' && (
            <div>
              {/* QR + URL */}
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16, padding: 14, background: '#f9fafb', borderRadius: 10 }}>
                <QRImg value={urlPublica} size={90} />
                <div style={{ flex: 1 }}>
                  <p style={s.secTit}>URL pública</p>
                  <p style={{ fontSize: 11, color: '#6b7280', wordBreak: 'break-all', marginBottom: 8 }}>{urlPublica}</p>
                  <button onClick={() => { navigator.clipboard.writeText(urlPublica); }} style={s.btnSm()}>Copiar URL</button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><label style={s.label}>Tipo</label><input style={s.input} value={form.tipo} onChange={e => set('tipo', e.target.value)} placeholder="ABC, CO2, BC..." /></div>
                <div><label style={s.label}>Capacidad</label><input style={s.input} value={form.capacidad} onChange={e => set('capacidad', e.target.value)} placeholder="5 LBS, 10 LBS..." /></div>
                <div><label style={s.label}>Fecha última recarga</label><input type="date" style={s.input} value={form.fechaUltimaRecarga} onChange={e => set('fechaUltimaRecarga', e.target.value)} /></div>
                <div><label style={s.label}>Próxima recarga</label><input type="date" style={s.input} value={form.proximaRecarga} onChange={e => set('proximaRecarga', e.target.value)} /></div>
                {equipo.requierePH && <>
                  <div><label style={s.label}>Fecha PH</label><input type="date" style={s.input} value={form.fechaPH} onChange={e => set('fechaPH', e.target.value)} /></div>
                  <div><label style={s.label}>Próx. mantenimiento</label><input type="date" style={s.input} value={form.proximoMantenimiento} onChange={e => set('proximoMantenimiento', e.target.value)} /></div>
                  <div><label style={s.label}>PH registrado</label><input style={s.input} value={form.ph} onChange={e => set('ph', e.target.value)} placeholder="Valor PH" /></div>
                  <div><label style={s.label}>Presión (PSI)</label><input style={s.input} value={form.presion} onChange={e => set('presion', e.target.value)} placeholder="Presión" /></div>
                </>}
                <div style={{ gridColumn: '1/-1' }}><label style={s.label}>Ubicación</label><input style={s.input} value={form.ubicacion} onChange={e => set('ubicacion', e.target.value)} placeholder="Ej: Oficina, Bodega, Av. Sexta..." /></div>
                <div style={{ gridColumn: '1/-1' }}><label style={s.label}>Notas</label><input style={s.input} value={form.notas} onChange={e => set('notas', e.target.value)} placeholder="Observaciones del equipo..." /></div>
                <div style={{ gridColumn: '1/-1' }}><label style={s.label}>Observaciones de esta edición</label><input style={s.input} value={form.observaciones} onChange={e => set('observaciones', e.target.value)} placeholder="¿Por qué se edita? (queda en historial)" /></div>
              </div>

              {/* Cambio propietario */}
              <div style={s.sep} />
              <p style={s.secTit}>Propietario actual: {equipo.propietario || 'Sin asignar'}</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={s.label}>Cliente</label>
                  <select style={s.select} value={form.clienteId} onChange={e => {
                    const cli = clientes.find(c => c.id === e.target.value);
                    set('clienteId', e.target.value);
                    set('clienteNombre', cli?.nombre || '');
                  }}>
                    <option value="">Sin propietario (equipo de cambio)</option>
                    {clientes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {tab === 'historial' && (
            <div>
              {(equipo.historial || []).length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280' }}>Sin historial registrado</div>
              ) : (
                [...(equipo.historial || [])].reverse().map((h, i) => (
                  <div key={i} style={{ padding: '12px 14px', background: '#f9fafb', borderRadius: 10, marginBottom: 8, borderLeft: '3px solid #7c3aed' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#1e1b4b' }}>{h.tipo || 'Intervención'}</span>
                      <span style={{ fontSize: 11, color: '#6b7280' }}>{fmtFecha(h.fecha)}</span>
                    </div>
                    <p style={{ fontSize: 12, color: '#374151', margin: 0 }}>👤 {h.tecnico || '—'}</p>
                    {h.numeroOrden && <p style={{ fontSize: 12, color: '#7c3aed', margin: '2px 0 0' }}>📋 {h.numeroOrden}</p>}
                    {h.observaciones && <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0', fontStyle: 'italic' }}>{h.observaciones}</p>}
                    {h.pasos?.length > 0 && <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>{h.pasos.map((p, j) => <span key={j} style={s.badge('#7c3aed', '#ede9fe')}>{p}</span>)}</div>}
                    {h.cambioPropietario && <p style={{ fontSize: 11, color: '#f59e0b', margin: '4px 0 0' }}>🔄 {h.propietarioAnterior || 'Sin dueño'} → {h.propietarioNuevo || 'Sin dueño'}</p>}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div style={s.mFooter}>
          <button onClick={onCerrar} style={s.btnOutline}>Cancelar</button>
          {tab === 'info' && <button onClick={handleGuardar} disabled={guardando} style={s.btn()}>{guardando ? 'Guardando...' : '💾 Guardar cambios'}</button>}
        </div>
      </div>
    </div>
  );
};

// ─── MODAL IMPRIMIR ETIQUETAS ─────────────────────────────────────────────────
const ModalImprimirEtiquetas = ({ equipos, onImprimir, onCerrar }) => {
  const [seleccionados, setSeleccionados] = useState([]);
  const [imprimiendo, setImprimiendo] = useState(false);

  const toggle = (codigo) => {
    if (seleccionados.includes(codigo)) {
      setSeleccionados(prev => prev.filter(c => c !== codigo));
    } else if (seleccionados.length < 9) {
      setSeleccionados(prev => [...prev, codigo]);
    }
  };

  const handleImprimir = async () => {
    if (seleccionados.length === 0) return;
    setImprimiendo(true);
    try {
      await onImprimir(seleccionados);
      // Imprimir hoja de etiquetas
      imprimirHoja(seleccionados.map(c => equipos.find(e => e.codigoQR === c)).filter(Boolean));
    } catch (e) { }
    setImprimiendo(false);
  };

  const imprimirHoja = (items) => {
    // ── PAQUETE C: agrupar por número de orden para indicador "1 de N" ──
    // Cuando una orden tiene varios extintores, ej. OS-0030 con 3 equipos,
    // el sistema muestra "1 de 3", "2 de 3", "3 de 3" en cada etiqueta.
    const conteoPorOrden = {};
    items.forEach(eq => {
      const ord = eq.numeroOrden || '_SIN_ORDEN_';
      conteoPorOrden[ord] = (conteoPorOrden[ord] || 0) + 1;
    });
    // Asignar posición (1 de N) ordenando por codigoQR dentro de cada orden
    const indicePorEquipo = {};
    Object.keys(conteoPorOrden).forEach(ord => {
      const equiposDeOrden = items
        .filter(eq => (eq.numeroOrden || '_SIN_ORDEN_') === ord)
        .sort((a, b) => (a.codigoQR || '').localeCompare(b.codigoQR || ''));
      equiposDeOrden.forEach((eq, idx) => {
        indicePorEquipo[eq.codigoQR] = idx + 1;
      });
    });

    const filas = items.map(eq => {
      const totalOrden = conteoPorOrden[eq.numeroOrden || '_SIN_ORDEN_'];
      const indice = indicePorEquipo[eq.codigoQR] || 1;
      // Solo mostrar "X de N" si hay más de 1 equipo en la orden
      const indicador = totalOrden > 1 ? `${indice}/${totalOrden}` : '';
      // Nombre completo (no truncar) — el CSS permite 2 líneas con wrap
      const propietario = (eq.propietario || 'SIN DUEÑO').toUpperCase();
      // Línea de orden + indicador
      const lineaOrden = eq.numeroOrden
        ? (indicador ? `${eq.numeroOrden} • ${indicador}` : eq.numeroOrden)
        : eq.codigoQR;

      return `
      <div class="etiqueta">
        <div class="qr-wrap">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=60x60&data=${encodeURIComponent(QR_PUBLIC_URL + eq.codigoQR)}&bgcolor=ffffff&color=1a1a2e&margin=1" width="60" height="60" />
        </div>
        <div class="info">
          <div class="propietario">${propietario}</div>
          <div class="id-equipo">ID: ${eq.codigoQR}</div>
          <div class="tipo">${eq.tipo || ''} ${eq.capacidad || ''}</div>
          <div class="orden">${lineaOrden}</div>
        </div>
      </div>
    `;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: Arial, sans-serif; background: #fff; }
      .hoja { display: grid; grid-template-columns: repeat(3, 32mm); grid-template-rows: repeat(3, 25mm); gap: 2mm; padding: 10mm; }
      .etiqueta { width: 32mm; height: 25mm; border: 0.5px solid #ccc; border-radius: 2mm; display: flex; align-items: center; gap: 1mm; padding: 1mm; overflow: hidden; }
      .qr-wrap { flex-shrink: 0; }
      .info { flex: 1; overflow: hidden; line-height: 1.15; }
      /* PAQUETE C: nombre completo en hasta 2 líneas */
      .propietario {
        font-size: 5.5px;
        font-weight: 800;
        color: #1a1a2e;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }
      .id-equipo { font-size: 5px; color: #1a1a2e; font-weight: 700; font-family: monospace; margin-top: 1px; }
      .tipo { font-size: 5px; color: #374151; margin-top: 1px; }
      .orden { font-size: 5px; color: #6b7280; margin-top: 1px; font-family: monospace; font-weight: 600; }
      @media print { body { padding: 0; } }
    </style></head><body>
    <div class="hoja">${filas}</div>
    </body></html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 600);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 680 }}>
        <div style={s.mHeader}>
          <div>
            <h3 style={s.mTitulo}>🖨️ Imprimir Etiquetas QR</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Selecciona hasta 9 equipos (hoja 3x3 de 32x25mm)</p>
          </div>
          <button onClick={onCerrar} style={s.btnX}>✕</button>
        </div>
        <div style={s.mBody}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{seleccionados.length}/9 seleccionados</span>
            {seleccionados.length > 0 && <button onClick={() => setSeleccionados([])} style={s.btnOutline}>Limpiar</button>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflow: 'auto' }}>
            {equipos.map(eq => (
              <div key={eq.codigoQR}
                onClick={() => toggle(eq.codigoQR)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: `2px solid ${seleccionados.includes(eq.codigoQR) ? '#7c3aed' : '#e5e7eb'}`, background: seleccionados.includes(eq.codigoQR) ? '#ede9fe' : '#fafafa', transition: 'all 0.1s' }}>
                <div style={s.checkbox(seleccionados.includes(eq.codigoQR))}>
                  {seleccionados.includes(eq.codigoQR) && '✓'}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#1e1b4b' }}>{eq.codigoQR}</span>
                    {eq.qrImpreso && <span style={s.badge('#16a34a', '#f0fdf4')}>✅ Impreso</span>}
                    {eq.vencido && <span style={s.badge('#dc2626', '#fef2f2')}>⚠️ Vencido</span>}
                  </div>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>{eq.tipo} — {eq.capacidad} {eq.propietario ? `· ${eq.propietario}` : ''}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>{eq.numeroOrden || '—'}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Preview etiqueta */}
          {seleccionados.length > 0 && (
            <div style={{ marginTop: 16, padding: 14, background: '#f9fafb', borderRadius: 10 }}>
              <p style={{ ...s.secTit, marginBottom: 12 }}>Vista previa de etiqueta (32x25mm)</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 128, height: 100, border: '1px dashed #d1d5db', borderRadius: 6, padding: 4, background: '#fff' }}>
                <QRImg value={QR_PUBLIC_URL + seleccionados[0]} size={72} />
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <p style={{ fontSize: 6.5, fontWeight: 800, color: '#1a1a2e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {equipos.find(e => e.codigoQR === seleccionados[0])?.propietario || 'SIN DUEÑO'}
                  </p>
                  <p style={{ fontSize: 6, color: '#374151', marginTop: 1 }}>
                    {equipos.find(e => e.codigoQR === seleccionados[0])?.tipo} — {equipos.find(e => e.codigoQR === seleccionados[0])?.capacidad}
                  </p>
                  <p style={{ fontSize: 5.5, color: '#9ca3af', marginTop: 1, fontFamily: 'monospace' }}>
                    {equipos.find(e => e.codigoQR === seleccionados[0])?.numeroOrden || seleccionados[0]}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
        <div style={s.mFooter}>
          <button onClick={onCerrar} style={s.btnOutline}>Cancelar</button>
          <button onClick={handleImprimir} disabled={seleccionados.length === 0 || imprimiendo} style={s.btn(seleccionados.length === 0 ? '#9ca3af' : '#1e1b4b')}>
            {imprimiendo ? 'Procesando...' : `🖨️ Imprimir ${seleccionados.length} etiqueta${seleccionados.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── MODAL CREAR QR MANUAL ────────────────────────────────────────────────────
const ModalNuevoQR = ({ clientes, tiposQR, onGuardar, onCerrar }) => {
  const [form, setForm] = useState({ tipo: 'ABC', capacidad: '', clienteId: '', clienteNombre: '', ubicacion: '', notas: '', requierePH: false, cantidad: 1 });
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleGuardar = async () => {
    if (!form.tipo) return setErr('El tipo es obligatorio');
    if (!form.capacidad) return setErr('La capacidad es obligatoria');
    setGuardando(true); setErr('');
    try { await onGuardar(form); }
    catch (e) { setErr(e.response?.data?.error || 'Error al crear'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 500 }}>
        <div style={s.mHeader}><h3 style={s.mTitulo}>➕ Nuevo QR Manual</h3><button onClick={onCerrar} style={s.btnX}>✕</button></div>
        <div style={s.mBody}>
          {err && <div style={s.alertErr}>{err}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={s.label}>Tipo *</label>
              <select style={s.select} value={form.tipo} onChange={e => { set('tipo', e.target.value); set('requierePH', e.target.value === 'CO2'); }}>
                {(tiposQR && tiposQR.length > 0 ? tiposQR : ['ABC', 'BC', 'CO2', 'Agua', 'Polvo']).map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={s.label}>Capacidad *</label>
              <input style={s.input} value={form.capacidad} onChange={e => set('capacidad', e.target.value)} placeholder="5 LBS, 10 LBS, 20 LBS..." />
            </div>
            <div>
              <label style={s.label}>Cantidad a generar</label>
              <input type="number" min={1} max={50} style={s.input} value={form.cantidad} onChange={e => set('cantidad', parseInt(e.target.value) || 1)} />
              {form.cantidad > 1 && <p style={{ fontSize: 11, color: '#7c3aed', marginTop: 4 }}>Se generarán {form.cantidad} QR con las mismas características</p>}
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={s.label}>Propietario (cliente)</label>
              <select style={s.select} value={form.clienteId} onChange={e => {
                const cli = clientes.find(c => c.id === e.target.value);
                set('clienteId', e.target.value);
                set('clienteNombre', cli?.nombre || '');
              }}>
                <option value="">Sin propietario (equipo de cambio)</option>
                {clientes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={s.label}>Ubicación</label>
              <input style={s.input} value={form.ubicacion} onChange={e => set('ubicacion', e.target.value)} placeholder="Oficina, Bodega, Av. Sexta..." />
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={s.label}>Notas</label>
              <input style={s.input} value={form.notas} onChange={e => set('notas', e.target.value)} placeholder="Observaciones..." />
            </div>
          </div>
        </div>
        <div style={s.mFooter}>
          <button onClick={onCerrar} style={s.btnOutline}>Cancelar</button>
          <button onClick={handleGuardar} disabled={guardando} style={s.btn()}>{guardando ? 'Creando...' : '✅ Crear QR'}</button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
export default function GestionQR({ user }) {
  const esAdmin = user?.role === 'admin';
  const [tab, setTab] = useState('equipos');
  const [equipos, setEquipos] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [config, setConfig] = useState({ categoriasQR: [], imagenPromo: null, duracionPromo: 4 });
  const [cargando, setCargando] = useState(true);
  const [buscar, setBuscar] = useState('');
  const [filtroImpreso, setFiltroImpreso] = useState('todos');
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');

  // Modales
  const [modalDetalle, setModalDetalle] = useState(null);
  const [modalImprimir, setModalImprimir] = useState(false);
  const [modalNuevo, setModalNuevo] = useState(false);

  const notif = (msg, tipo = 'ok') => {
    if (tipo === 'ok') { setOk(msg); setTimeout(() => setOk(''), 3000); }
    else { setErr(msg); setTimeout(() => setErr(''), 4000); }
  };

  const cargar = useCallback(async () => {
    try {
      setCargando(true);
      const [resQR, resCli, resCfg] = await Promise.all([
        axios.get(`${API}/qr`, auth()),
        axios.get(`${API}/clients`, auth()),
        axios.get(`${API}/qr/config/get`, auth()),
      ]);
      setEquipos(Array.isArray(resQR.data) ? resQR.data : []);
      setClientes(Array.isArray(resCli.data) ? resCli.data : []);
      setConfig(resCfg.data || {});
    } catch (e) { notif('Error al cargar', 'err'); }
    finally { setCargando(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // ── Filtros ──
  const equiposFiltrados = equipos.filter(e => {
    const term = buscar.toUpperCase();
    const coincide = !buscar || e.codigoQR?.toUpperCase().includes(term) || e.propietario?.toUpperCase().includes(term) || e.tipo?.toUpperCase().includes(term) || e.numeroOrden?.toUpperCase().includes(term);
    const impreso = filtroImpreso === 'todos' ? true : filtroImpreso === 'si' ? e.qrImpreso : !e.qrImpreso;
    return coincide && impreso;
  });

  // ── Acciones ──
  const handleGuardarQR = async (codigo, datos) => {
    await axios.put(`${API}/qr/${codigo}`, datos, auth());
    notif('QR actualizado ✅');
    setModalDetalle(null);
    cargar();
  };

  const handleCrearQR = async (datos) => {
    const cantidad = datos.cantidad || 1;
    for (let i = 0; i < cantidad; i++) {
      await axios.post(`${API}/qr`, datos, auth());
    }
    notif(`${cantidad} QR creado${cantidad !== 1 ? 's' : ''} ✅`);
    setModalNuevo(false);
    cargar();
  };

  const handleImprimir = async (codigos) => {
    await axios.post(`${API}/qr/imprimir`, { codigos }, auth());
    notif(`${codigos.length} QR marcados como impresos ✅`);
    cargar();
  };

  // ── Guardar config ──
  const [guardandoCfg, setGuardandoCfg] = useState(false);
  const [imagenPromoLocal, setImagenPromoLocal] = useState(null);
  const fileRef = useRef();

  const handleSubirImagen = async (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result;
      // Subir a Cloudinary
      try {
        const formData = new FormData();
        formData.append('file', base64);
        formData.append('upload_preset', 'control360');
        formData.append('folder', 'control360/qr-promo');
        const res = await fetch('https://api.cloudinary.com/v1_1/dk8hposft/image/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.secure_url) {
          setConfig(p => ({ ...p, imagenPromo: data.secure_url }));
          notif('Imagen subida ✅');
        }
      } catch (e) { notif('Error al subir imagen', 'err'); }
    };
    reader.readAsDataURL(file);
  };

  const handleGuardarConfig = async () => {
    setGuardandoCfg(true);
    try {
      await axios.put(`${API}/qr/config/save`, config, auth());
      notif('Configuración guardada ✅');
    } catch (e) { notif('Error al guardar', 'err'); }
    setGuardandoCfg(false);
  };

  const CATEGORIAS_DISPONIBLES = [
    'recargas y mantenimiento', 'recargas', 'mantenimiento',
    'extintores', 'prueba hidrostatica', 'botiquines'
  ];

  const toggleCategoria = (cat) => {
    const cats = config.categoriasQR || [];
    if (cats.includes(cat)) {
      setConfig(p => ({ ...p, categoriasQR: cats.filter(c => c !== cat) }));
    } else {
      setConfig(p => ({ ...p, categoriasQR: [...cats, cat] }));
    }
  };

  return (
    <div style={s.page}>
      {/* Notificaciones */}
      {ok && <div style={{ ...s.alertOk, position: 'fixed', top: 20, right: 20, zIndex: 9999, maxWidth: 360, boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }}>{ok}</div>}
      {err && <div style={{ ...s.alertErr, position: 'fixed', top: 20, right: 20, zIndex: 9999, maxWidth: 360, boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }}>{err}</div>}

      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.titulo}>📲 QR Activos</h1>
          <p style={s.subtitulo}>Gestión de equipos, etiquetas y configuración</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {esAdmin && <button onClick={() => setModalNuevo(true)} style={s.btn()}>+ Nuevo QR</button>}
          <button onClick={() => setModalImprimir(true)} style={s.btn('#1e1b4b')}>🖨️ Imprimir etiquetas</button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ ...s.grid3, marginBottom: 20 }}>
        <div style={{ ...s.card, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#7c3aed' }}>{equipos.length}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Total QR generados</div>
        </div>
        <div style={{ ...s.card, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#dc2626' }}>{equipos.filter(e => e.vencido).length}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Extintores vencidos</div>
        </div>
        <div style={{ ...s.card, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#16a34a' }}>{equipos.filter(e => e.qrImpreso).length}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Etiquetas impresas</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={s.tabs}>
        {[{ key: 'equipos', label: '📋 Equipos' }, { key: 'config', label: '⚙️ Configuración' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={s.tab(tab === t.key)}>{t.label}</button>
        ))}
      </div>

      {/* ── TAB EQUIPOS ── */}
      {tab === 'equipos' && (
        <div>
          {/* Filtros */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <input style={{ ...s.input, maxWidth: 280 }} placeholder="Buscar código, propietario, tipo..." value={buscar} onChange={e => setBuscar(e.target.value)} />
            <select style={{ ...s.select, maxWidth: 180 }} value={filtroImpreso} onChange={e => setFiltroImpreso(e.target.value)}>
              <option value="todos">Todos</option>
              <option value="no">Sin imprimir</option>
              <option value="si">Ya impresos</option>
            </select>
          </div>

          {cargando ? (
            <div style={{ textAlign: 'center', padding: 48, color: '#6b7280' }}>Cargando equipos...</div>
          ) : equiposFiltrados.length === 0 ? (
            <div style={{ ...s.card, textAlign: 'center', padding: 48 }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>📲</div>
              <p style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>Sin QR generados aún</p>
              <p style={{ fontSize: 13, color: '#6b7280' }}>Los QR se generan automáticamente cuando se crean órdenes con productos de las categorías configuradas</p>
            </div>
          ) : (
            <div style={s.grid2}>
              {equiposFiltrados.map(eq => (
                <div key={eq.codigoQR} style={{ ...s.card, cursor: 'pointer', transition: 'box-shadow 0.15s', borderLeft: eq.vencido ? '4px solid #dc2626' : eq.alertaVencimiento ? '4px solid #f59e0b' : '4px solid #7c3aed' }}
                  onClick={() => setModalDetalle(eq)}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    {/* QR mini */}
                    <div style={{ flexShrink: 0 }}>
                      <QRImg value={QR_PUBLIC_URL + eq.codigoQR} size={64} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                        <span style={{ fontWeight: 800, fontSize: 13, color: '#1e1b4b' }}>{eq.codigoQR}</span>
                        {eq.vencido && <span style={s.badge('#dc2626', '#fef2f2')}>⚠️ Vencido</span>}
                        {eq.alertaVencimiento && !eq.vencido && <span style={s.badge('#d97706', '#fffbeb')}>⏰ {eq.diasParaVencer}d</span>}
                        {eq.qrImpreso && <span style={s.badge('#16a34a', '#f0fdf4')}>✅ Impreso</span>}
                      </div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 2px' }}>{eq.propietario || <em style={{ color: '#9ca3af' }}>Sin propietario</em>}</p>
                      <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>{eq.tipo} — {eq.capacidad}</p>
                      {eq.ubicacion && <p style={{ fontSize: 11, color: '#9ca3af', margin: '2px 0 0' }}>📍 {eq.ubicacion}</p>}
                      <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>📅 Recarga: {fmtFecha(eq.fechaUltimaRecarga)}</span>
                        <span style={{ fontSize: 11, color: eq.vencido ? '#dc2626' : '#16a34a', fontWeight: 600 }}>⏳ Vence: {fmtFecha(eq.proximaRecarga)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB CONFIG ── */}
      {tab === 'config' && esAdmin && (
        <div>
          {/* Imagen promo */}
          <div style={s.card}>
            <p style={s.secTit}>📸 Imagen publicitaria (splash)</p>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>Esta imagen aparece durante unos segundos cuando alguien escanea un QR. Cámbiala mensualmente con tus promociones.</p>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {config.imagenPromo ? (
                <div style={{ position: 'relative' }}>
                  <img src={config.imagenPromo} alt="Promo" style={{ width: 160, height: 100, objectFit: 'cover', borderRadius: 10, border: '1px solid #e5e7eb' }} />
                  <button onClick={() => setConfig(p => ({ ...p, imagenPromo: null }))} style={{ position: 'absolute', top: -8, right: -8, background: '#dc2626', color: '#fff', border: 'none', borderRadius: '50%', width: 22, height: 22, cursor: 'pointer', fontSize: 12 }}>✕</button>
                </div>
              ) : (
                <div style={{ width: 160, height: 100, borderRadius: 10, border: '2px dashed #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13, cursor: 'pointer' }} onClick={() => fileRef.current?.click()}>
                  + Subir imagen
                </div>
              )}
              <div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleSubirImagen(e.target.files[0])} />
                <button onClick={() => fileRef.current?.click()} style={s.btnOutline}>📤 {config.imagenPromo ? 'Cambiar imagen' : 'Subir imagen'}</button>
                <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>PNG o JPG, máx 2MB. Recomendado: 1080x720px</p>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ ...s.label, margin: 0 }}>Duración (seg):</label>
                  <input type="number" min={2} max={10} style={{ ...s.input, width: 70 }} value={config.duracionPromo || 4} onChange={e => setConfig(p => ({ ...p, duracionPromo: parseInt(e.target.value) || 4 }))} />
                </div>
              </div>
            </div>
          </div>
{/* Tipos de extintor */}
          <div style={s.card}>
            <p style={s.secTit}>🧯 Tipos de extintor</p>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>Tipos disponibles al crear un QR manual. Agrega o elimina según los equipos que manejas.</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {(config.tiposQR || ['ABC', 'BC', 'CO2', 'Agua', 'Polvo']).map(tipo => (
                <div key={tipo} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 20, background: '#ede9fe', border: '1.5px solid #7c3aed' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#7c3aed' }}>{tipo}</span>
                  <button onClick={() => setConfig(p => ({ ...p, tiposQR: (p.tiposQR || ['ABC', 'BC', 'CO2', 'Agua', 'Polvo']).filter(t => t !== tipo) }))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7c3aed', fontSize: 14, padding: '0 2px', lineHeight: 1 }}>✕</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="nuevo-tipo-input"
                style={{ ...s.input, maxWidth: 200 }}
                placeholder="Ej: PQS, K, Haloclean..."
                onKeyDown={e => {
                  if (e.key === 'Enter' && e.target.value.trim()) {
                    const nuevo = e.target.value.trim().toUpperCase();
                    if (!(config.tiposQR || []).includes(nuevo)) {
                      setConfig(p => ({ ...p, tiposQR: [...(p.tiposQR || ['ABC', 'BC', 'CO2', 'Agua', 'Polvo']), nuevo] }));
                    }
                    e.target.value = '';
                  }
                }}
              />
              <button onClick={() => {
                const input = document.getElementById('nuevo-tipo-input');
                if (input?.value?.trim()) {
                  const nuevo = input.value.trim().toUpperCase();
                  if (!(config.tiposQR || []).includes(nuevo)) {
                    setConfig(p => ({ ...p, tiposQR: [...(p.tiposQR || ['ABC', 'BC', 'CO2', 'Agua', 'Polvo']), nuevo] }));
                  }
                  input.value = '';
                }
              }} style={s.btn()}>+ Agregar</button>
            </div>
          </div>
          {/* Categorías */}
          <div style={s.card}>
            <p style={s.secTit}>🏷️ Categorías que generan QR automático</p>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>Cuando una orden incluya productos de estas categorías, se generará un QR automáticamente.</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {CATEGORIAS_DISPONIBLES.map(cat => {
                const activo = (config.categoriasQR || []).includes(cat);
                return (
                  <button key={cat} onClick={() => toggleCategoria(cat)} style={{ padding: '7px 14px', borderRadius: 20, border: `2px solid ${activo ? '#7c3aed' : '#e5e7eb'}`, background: activo ? '#ede9fe' : '#fff', color: activo ? '#7c3aed' : '#6b7280', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    {activo ? '✓ ' : ''}{cat}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={handleGuardarConfig} disabled={guardandoCfg} style={s.btn()}>
              {guardandoCfg ? 'Guardando...' : '💾 Guardar configuración'}
            </button>
          </div>
        </div>
      )}

      {/* ═══ MODALES ═══ */}
      {modalDetalle && (
        <ModalDetalleQR equipo={modalDetalle} clientes={clientes} onGuardar={handleGuardarQR} onCerrar={() => setModalDetalle(null)} />
      )}
      {modalImprimir && (
        <ModalImprimirEtiquetas equipos={equiposFiltrados} onImprimir={handleImprimir} onCerrar={() => setModalImprimir(false)} />
      )}
    {modalNuevo && (
        <ModalNuevoQR clientes={clientes} tiposQR={config.tiposQR} onGuardar={handleCrearQR} onCerrar={() => setModalNuevo(false)} />
      )}
    </div>
  );
}

