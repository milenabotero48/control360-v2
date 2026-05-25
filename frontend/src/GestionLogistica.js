import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const fmtFecha = f => f ? new Date(f + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) : '—';
const hoy = () => new Date().toISOString().split('T')[0];

// ─── ESTADO BADGE ─────────────────────────────────────────────────────────────
const ESTADO_CONFIG = {
  programada:       { label: 'Programada',      color: '#6366f1', bg: '#eef2ff' },
  en_ruta_recogida: { label: 'En Ruta Recogida', color: '#f59e0b', bg: '#fffbeb' },
  en_taller:        { label: 'En Taller',        color: '#8b5cf6', bg: '#f5f3ff' },
  despacho:         { label: 'Despacho',         color: '#d97706', bg: '#fef3c7' },
  en_ruta_entrega:  { label: 'En Ruta Entrega',  color: '#059669', bg: '#ecfdf5' },
  entrega_cobranza: { label: 'Entrega/Cobranza', color: '#ea580c', bg: '#fff7ed' },
};

const EstadoBadge = ({ estado }) => {
  const cfg = ESTADO_CONFIG[estado] || { label: estado, color: '#6b7280', bg: '#f3f4f6' };
  return <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color }}>{cfg.label}</span>;
};

// ─── MODAL ASIGNAR RUTA ───────────────────────────────────────────────────────
const ModalAsignar = ({ ordenes, mensajeros, onAsignar, onCerrar }) => {
  const [mensajeroId, setMensajeroId]   = useState('');
  const [seleccionadas, setSeleccionadas] = useState({});
  const [guardando, setGuardando]       = useState(false);
  const [error, setError]               = useState('');

  const mensajeroSel = mensajeros.find(m => m.id === mensajeroId);
  const idsSeleccionados = Object.keys(seleccionadas).filter(k => seleccionadas[k]);
  const totalSeleccionado = ordenes.filter(o => seleccionadas[o.id]).reduce((s, o) => s + (o.total || 0), 0);
  const todasSeleccionadas = ordenes.length > 0 && idsSeleccionados.length === ordenes.length;

  const toggleTodas = () => {
    if (todasSeleccionadas) setSeleccionadas({});
    else { const n = {}; ordenes.forEach(o => { n[o.id] = true; }); setSeleccionadas(n); }
  };

  const handleAsignar = async () => {
    if (!mensajeroId) return setError('Selecciona un mensajero');
    if (idsSeleccionados.length === 0) return setError('Selecciona al menos una orden');
    setGuardando(true); setError('');
    try {
      await onAsignar({
        mensajeroId,
        mensajeroNombre: mensajeroSel?.nombre || '',
        mensajeroCelular: mensajeroSel?.celular || '',
        ordenIds: idsSeleccionados
      });
    } catch (e) { setError(e.response?.data?.error || 'Error al asignar'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 720 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>🚚 Asignar Ruta</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>Selecciona mensajero y órdenes</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}

          {/* Mensajero */}
          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>Mensajero *</label>
            <select style={s.input} value={mensajeroId} onChange={e => setMensajeroId(e.target.value)}>
              <option value="">— Seleccionar mensajero —</option>
              {mensajeros.map(m => <option key={m.id} value={m.id}>{m.nombre} {m.celular ? `· ${m.celular}` : ''}</option>)}
            </select>
          </div>

          {/* Resumen selección */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label style={s.label}>Órdenes a asignar</label>
            {idsSeleccionados.length > 0 && (
              <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 700 }}>
                {idsSeleccionados.length} órdenes · {fmt(totalSeleccionado)}
              </span>
            )}
          </div>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ ...s.th, width: 40 }}>
                    <input type="checkbox" checked={todasSeleccionadas} onChange={toggleTodas} style={{ width: 15, height: 15 }} />
                  </th>
                  {['Orden', 'Cliente', 'Dirección', 'Fecha', 'Total', 'Estado'].map(h => <th key={h} style={s.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {ordenes.map((o, i) => (
                  <tr key={o.id} onClick={() => setSeleccionadas(p => ({ ...p, [o.id]: !p[o.id] }))}
                    style={{ background: seleccionadas[o.id] ? '#f0fdf4' : i % 2 === 0 ? '#fff' : '#f9fafb', cursor: 'pointer' }}>
                    <td style={{ ...s.td, textAlign: 'center' }}>
                      <input type="checkbox" checked={!!seleccionadas[o.id]} onChange={() => {}} style={{ width: 15, height: 15 }} />
                    </td>
                    <td style={s.td}><code style={{ fontSize: 12 }}>{o.numeroOrden}</code></td>
                    <td style={s.td}><strong style={{ fontSize: 13 }}>{o.clienteNombre}</strong></td>
                    <td style={{ ...s.td, fontSize: 12, color: '#6b7280', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.sucursalDireccion || o.clienteDireccion || '—'}
                    </td>
                    <td style={s.td}><span style={{ fontSize: 12 }}>{fmtFecha(o.fechaProgramada)}</span></td>
                    <td style={{ ...s.td, fontWeight: 700, color: '#16a34a' }}>{fmt(o.total)}</td>
                    <td style={s.td}><EstadoBadge estado={o.estado} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnCancelar}>Cancelar</button>
          <button onClick={handleAsignar} disabled={guardando || !mensajeroId || idsSeleccionados.length === 0}
            style={{ padding: '10px 24px', background: idsSeleccionados.length > 0 ? 'linear-gradient(135deg,#667eea,#764ba2)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 700 }}>
            {guardando ? 'Asignando...' : `🚚 Asignar ${idsSeleccionados.length > 0 ? `(${idsSeleccionados.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── MODAL AVANZAR ESTADO (Mensajero) ────────────────────────────────────────
const ModalAvanzarEstado = ({ orden, headers, onAvanzar, onCerrar }) => {
  const [pinDesbloqueado, setPinDesbloqueado] = useState(false);
  const [advertencia, setAdvertencia] = useState(null);
  const [nota, setNota]                   = useState('');
  const [extintor, setExtintor]           = useState(orden.extintorPrestamo || '');
  const [cobro, setCobro]                 = useState('');
  const [formaPago, setFormaPago]         = useState('Efectivo');
  const [formasPago, setFormasPago]       = useState(['Efectivo', 'Transferencia', 'Nequi', 'Datafono']);
  const [fotoUrl, setFotoUrl]             = useState('');
  const [fotoTransUrl, setFotoTransUrl]   = useState('');
  const [subiendoFoto, setSubiendoFoto]   = useState(false);
  const [guardando, setGuardando]         = useState(false);
  const [error, setError]                 = useState('');
  const [items, setItems]                 = useState(orden.items ? [...orden.items] : []);
  const [productosDisp, setProductosDisp] = useState([]);
  const [buscarProd, setBuscarProd]       = useState('');
  const fotoRef = useRef(null);
  const fotoTransRef = useRef(null);

  useEffect(() => {
    // Cargar formas de pago desde configuración
    fetch(`${API}/configuracion`, { headers })
      .then(r => r.json())
      .then(d => {
        const fps = (d?.formasPago || []).filter(f => f.activa && f.nombre !== 'Cuenta por Pagar' && f.nombre !== 'A crédito (CxC)').map(f => f.nombre);
        if (fps.length > 0) setFormasPago(fps);
      }).catch(() => {});

    // Cargar productos disponibles
    fetch(`${API}/products`, { headers })
      .then(r => r.json())
      .then(d => setProductosDisp((Array.isArray(d) ? d : []).filter(p => p.activo !== false && p.tipo !== 'insumo')))
      .catch(() => {});
  }, []);

  const agregarProducto = (prod) => {
    const yaExiste = items.find(i => i.productoId === prod.id);
    if (yaExiste) {
      setItems(prev => prev.map(i => i.productoId === prod.id ? { ...i, cantidad: i.cantidad + 1 } : i));
    } else {
      setItems(prev => [...prev, { productoId: prod.id, nombre: prod.nombre, cantidad: 1, precioUnitario: prod.precioVenta || 0, descuento: 0, notas: '' }]);
    }
    setBuscarProd('');
  };

  const totalItems = items.reduce((s, it) => s + (it.precioUnitario || 0) * (it.cantidad || 1) * (1 - (it.descuento || 0) / 100), 0);

  const CLOUDINARY_URL = 'https://api.cloudinary.com/v1_1/dk8hposft/image/upload';
  const CLOUDINARY_PRESET = 'control360';

  const subirFoto = async (file, setter) => {
    setSubiendoFoto(true);

    // Capturar GPS en el momento de la foto
    let gpsData = null;
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 })
      );
      gpsData = { lat: pos.coords.latitude, lng: pos.coords.longitude, timestamp: new Date().toISOString() };
    } catch { /* GPS no disponible */ }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_PRESET);
    formData.append('folder', 'control360/logistica');
    if (gpsData) formData.append('context', `lat=${gpsData.lat}|lng=${gpsData.lng}`);

    try {
      const res = await fetch(CLOUDINARY_URL, { method: 'POST', body: formData });
      const data = await res.json();
      setter(data.secure_url);
      // Guardar GPS para enviarlo al backend
      if (gpsData) setter._gps = gpsData;
    } catch { setError('Error al subir foto'); }
    setSubiendoFoto(false);
  };

  // Determinar siguiente estado
 const esCobranza = orden.tipoOrden === 'cxc' || orden.lugarAtencion === 'cobranza';
  const siguienteEstado = {
    programada: esCobranza ? 'en_ruta_recogida' : 'en_ruta_recogida',
    en_ruta_recogida: esCobranza ? 'entrega_cobranza' : 'en_taller',
    despacho: 'en_ruta_entrega',
    en_ruta_entrega: 'entrega_cobranza',
  }[orden.estado];

  const necesitaFotoRecogida = orden.estado === 'en_ruta_recogida';
  const necesitaFotoEntrega  = orden.estado === 'en_ruta_entrega';
  const necesitaExtintor     = orden.estado === 'en_ruta_recogida';
  const necesitaCobro        = orden.estado === 'en_ruta_entrega' || orden.estado === 'en_ruta_recogida';
  const puedeEditarItems     = ['en_ruta_recogida', 'en_ruta_entrega'].includes(orden.estado);

  const handleAvanzar = async () => {
    if (!siguienteEstado) return setError('No hay siguiente estado disponible');

    // ✅ CTRL-002: Detectar si falta foto (en lugar de bloquear)
    let deficiencia = null;
    let nuevoAdvertencia = null;

    if (necesitaFotoRecogida && !fotoUrl) {
      deficiencia = 'foto_recogida_faltante';
      nuevoAdvertencia = '⚠️ Foto de recogida faltante — afectará tu evaluación de performance';
    }
    if (necesitaFotoEntrega && !fotoUrl) {
      deficiencia = 'foto_entrega_faltante';
      nuevoAdvertencia = '⚠️ Foto de entrega faltante — afectará tu evaluación de performance';
    }

    // ✅ Si hay deficiencia y NO está desbloqueado, mostrar warning
    if (deficiencia && !pinDesbloqueado) {
      setAdvertencia(nuevoAdvertencia);
      setPinDesbloqueado(true);
      return;
    }

    setGuardando(true);
    setError('');
    setAdvertencia(null);
    try {
      await onAvanzar(orden.id, {
        nuevoEstado: siguienteEstado,
        nota,
        extintorPrestamo: necesitaExtintor ? extintor : undefined,
        fotoUrl: fotoUrl || null, // ✅ Permitir null
        cobro: Number(cobro) > 0 ? cobro : undefined,
        formaPago: Number(cobro) > 0 ? formaPago : undefined,
        fotoTransferenciaUrl: fotoTransUrl || undefined,
        items: puedeEditarItems ? items : undefined,
        deficiencia: deficiencia || null, // ✅ Registrar deficiencia
      });
      setPinDesbloqueado(false);
    } catch (e) {
      setError(e.response?.data?.error || 'Error al avanzar estado');
      setPinDesbloqueado(false);
    }
    setGuardando(false);
  };

  if (!siguienteEstado) return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 400, padding: 24, textAlign: 'center' }}>
        <p style={{ fontSize: 16, color: '#374151' }}>Esta orden no tiene siguiente estado disponible.</p>
        <button onClick={onCerrar} style={{ ...s.btnCancelar, marginTop: 16 }}>Cerrar</button>
      </div>
    </div>
  );

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 500 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>▶️ Avanzar Orden</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>{orden.numeroOrden} — {orden.clienteNombre}</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}

          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
            <EstadoBadge estado={orden.estado} /> → <EstadoBadge estado={siguienteEstado} />
          </div>

          {/* Alerta QR sin asignar — solo en despacho */}
          {orden.estado === 'despacho' && (() => {
            const itemsSinQR = (orden.items || []).filter(item =>
              (item.notas || '').toLowerCase() === 'cambio' && !item.codigoQR
            );
            if (itemsSinQR.length === 0) return null;
            return (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
                <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#92400e' }}>
                  ⚠️ {itemsSinQR.length} equipo{itemsSinQR.length !== 1 ? 's' : ''} de cambio sin QR asignado
                </p>
                {itemsSinQR.map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, flex: 1, color: '#374151' }}>📦 {item.nombre}</span>
                    <input
                      type="text"
                      placeholder="ID QR (EXT-000001)"
                      defaultValue={item.codigoQR || ''}
                      onChange={e => {
                        const val = e.target.value.toUpperCase();
                        item.codigoQR = val;
                      }}
                      style={{ padding: '6px 10px', borderRadius: 7, border: '1.5px solid #7c3aed', fontSize: 12, width: 140, outline: 'none' }}
                    />
                  </div>
                ))}
                <p style={{ margin: '8px 0 0', fontSize: 11, color: '#92400e' }}>
                  Digita el ID del equipo que vas a entregar para ligarlo al cliente
                </p>
              </div>
            );
          })()}

          {/* Extintor préstamo — solo en recogida */}
          {necesitaExtintor && (
            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>Extintor en préstamo <span style={{ fontWeight: 400, color: '#9ca3af' }}>(que dejas al cliente)</span></label>
              <input style={s.input} placeholder="#001, 1x10LBS, etc." value={extintor}
                onChange={e => setExtintor(e.target.value)} />
            </div>
          )}

          {/* Foto obligatoria */}
          {(necesitaFotoRecogida || necesitaFotoEntrega) && (
            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>{necesitaFotoRecogida ? 'Foto del equipo recogido *' : 'Foto de la entrega *'}</label>
              <input ref={fotoRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                onChange={e => e.target.files[0] && subirFoto(e.target.files[0], setFotoUrl)} />
              {fotoUrl ? (
                <div style={{ position: 'relative' }}>
                  <img src={fotoUrl} alt="foto" style={{ width: '100%', borderRadius: 8, maxHeight: 200, objectFit: 'cover' }} />
                  <button onClick={() => setFotoUrl('')} style={{ position: 'absolute', top: 6, right: 6, background: '#dc2626', color: '#fff', border: 'none', borderRadius: '50%', width: 24, height: 24, cursor: 'pointer', fontSize: 12 }}>✕</button>
                </div>
              ) : (
                <button onClick={() => fotoRef.current?.click()} disabled={subiendoFoto}
                  style={{ width: '100%', padding: '16px', border: '2px dashed #e5e7eb', borderRadius: 8, background: '#f9fafb', cursor: 'pointer', fontSize: 13, color: '#6b7280', fontWeight: 600 }}>
                  {subiendoFoto ? '⏳ Subiendo...' : '📷 Tomar / Cargar foto'}
                </button>
              )}
            </div>
          )}

          {/* Editar productos de la orden */}
          {puedeEditarItems && (
            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>Productos de la orden <span style={{ fontWeight: 400, color: '#9ca3af' }}>(edita si hay cambios)</span></label>

              {/* Buscador para agregar productos */}
              <div style={{ position: 'relative', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #e5e7eb', borderRadius: 8, padding: '0 10px', background: '#fff' }}>
                  <span style={{ color: '#9ca3af', fontSize: 13 }}>🔍</span>
                  <input style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13, padding: '8px 4px' }}
                    placeholder="Agregar producto..." value={buscarProd}
                    onChange={e => setBuscarProd(e.target.value)} />
                </div>
                {buscarProd && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 100, maxHeight: 160, overflowY: 'auto' }}>
                    {productosDisp.filter(p => p.nombre?.toLowerCase().includes(buscarProd.toLowerCase()) || p.codigo?.toLowerCase().includes(buscarProd.toLowerCase())).slice(0, 8).map(p => (
                      <div key={p.id} onClick={() => agregarProducto(p)}
                        style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between' }}>
                        <span>{p.nombre}</span>
                        <span style={{ color: '#16a34a', fontWeight: 700 }}>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(p.precioVenta || 0)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Lista de items */}
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                {items.map((item, idx) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f3f4f6' }}>
                    <span style={{ fontSize: 13, flex: 1 }}>{item.nombre}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ fontSize: 12, color: '#6b7280' }}>Cant:</label>
                      <input type="number" min="1" value={item.cantidad}
                        onChange={e => setItems(prev => prev.map((x, i) => i === idx ? { ...x, cantidad: Number(e.target.value) || 1 } : x))}
                        style={{ width: 50, padding: '4px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13 }} />
                      <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700, minWidth: 70, textAlign: 'right' }}>
                        {new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format((item.precioUnitario || 0) * (item.cantidad || 1))}
                      </span>
                      <button onClick={() => setItems(prev => prev.filter((_, i) => i !== idx))}
                        style={{ background: '#fef2f2', border: 'none', borderRadius: 4, padding: '3px 7px', cursor: 'pointer', color: '#dc2626', fontSize: 12 }}>✕</button>
                    </div>
                  </div>
                ))}
                <div style={{ padding: '8px 12px', background: '#f9fafb', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 14 }}>
                  <span>Total orden:</span>
                  <span style={{ color: '#16a34a' }}>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(totalItems)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Cobro — en recogida Y en entrega */}
         {necesitaCobro && (
            <>
              {esCobranza && (orden.ordenesACobrar || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <label style={s.label}>Órdenes a cobrar</label>
                  <div style={{ border: '1px solid #fca5a5', borderRadius: 8, overflow: 'hidden' }}>
                    {(orden.ordenesACobrar || []).map((o, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #fee2e2', background: '#fff' }}>
                        <code style={{ fontSize: 12 }}>{o.numeroOrden}</code>
                        <span style={{ fontWeight: 700, color: '#dc2626' }}>{fmt(o.saldo)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: '#fef2f2', fontWeight: 800 }}>
                      <span>Total a cobrar:</span>
                      <span style={{ color: '#dc2626' }}>{fmt(orden.montoCobrar || 0)}</span>
                    </div>
                  </div>
                </div>
              )}
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>
                  {esCobranza ? 'Monto cobrado' : orden.estado === 'en_ruta_recogida' ? 'Cobro en recogida' : 'Monto cobrado'}
                  <span style={{ fontWeight: 400, color: '#9ca3af' }}>{esCobranza ? ' (lo que le pagaron)' : ' (opcional en recogida)'}</span>
                </label>
                <input type="number" style={s.input} value={cobro} onChange={e => setCobro(e.target.value)} placeholder={esCobranza ? String(orden.montoCobrar || 0) : '0'} />
              </div>
              {Number(cobro) > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <label style={s.label}>Forma de pago</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {['Efectivo', 'Transferencia', 'Nequi', 'Datafono'].map(f => (
                      <button key={f} type="button" onClick={() => setFormaPago(f)} style={{
                        padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, border: 'none',
                        background: formaPago === f ? '#0284c7' : '#f3f4f6',
                        color: formaPago === f ? '#fff' : '#374151',
                      }}>{f}</button>
                    ))}
                  </div>
                  {(formaPago === 'Transferencia' || formaPago === 'Nequi') && (
                    <div style={{ marginTop: 10 }}>
                      <input ref={fotoTransRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                        onChange={e => e.target.files[0] && subirFoto(e.target.files[0], setFotoTransUrl)} />
                      {fotoTransUrl ? (
                        <div style={{ position: 'relative' }}>
                          <img src={fotoTransUrl} alt="comprobante" style={{ width: '100%', borderRadius: 8, maxHeight: 150, objectFit: 'cover' }} />
                          <button onClick={() => setFotoTransUrl('')} style={{ position: 'absolute', top: 6, right: 6, background: '#dc2626', color: '#fff', border: 'none', borderRadius: '50%', width: 24, height: 24, cursor: 'pointer', fontSize: 12 }}>✕</button>
                        </div>
                      ) : (
                        <button onClick={() => fotoTransRef.current?.click()} disabled={subiendoFoto}
                          style={{ width: '100%', padding: '10px', border: '2px dashed #e5e7eb', borderRadius: 8, background: '#f9fafb', cursor: 'pointer', fontSize: 13, color: '#6b7280' }}>
                          📷 Foto comprobante
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <div style={{ marginBottom: 14 }}>
            <label style={s.label}>Nota <span style={{ fontWeight: 400, color: '#9ca3af' }}>(opcional)</span></label>
            <textarea style={{ ...s.input, height: 56, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Observaciones..." value={nota} onChange={e => setNota(e.target.value)} />
          </div>
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnCancelar}>Cancelar</button>
          <button onClick={handleAvanzar} disabled={guardando || subiendoFoto}
            style={{ padding: '10px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 700 }}>
            {guardando ? 'Guardando...' : '▶️ Avanzar estado'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── MODAL CUADRE ─────────────────────────────────────────────────────────────
const ModalCuadre = ({ mensajeroId, mensajeroNombre, headers, onConfirmar, onCerrar }) => {
  const [cuadre, setCuadre]     = useState(null);
  const [pin, setPin]           = useState('');
  const [extDevueltos, setExtDevueltos] = useState({});
  const [guardando, setGuardando] = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    axios.get(`${API}/logistica/cuadre/${mensajeroId}`, { headers })
      .then(r => setCuadre(r.data))
      .catch(() => setError('Error al cargar cuadre'));
  }, [mensajeroId]);

  const handleConfirmar = async () => {
    if (pin.length !== 4) return setError('Ingresa el PIN de 4 dígitos');
    setGuardando(true); setError('');
    try {
      await onConfirmar({
        pin,
        montoRecibido: cuadre?.totalAEntregar || 0,
        extintoresDevueltos: Object.keys(extDevueltos).filter(k => extDevueltos[k])
      });
    } catch (e) { setError(e.response?.data?.error || 'Error al confirmar cuadre'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 560 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>💰 Cuadre — {mensajeroNombre}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>Recepción de dinero y extintores</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={s.alertError}>{error}</div>}
          {!cuadre ? <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>Cargando...</div> : (
            <>
              {/* Resumen */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
                <div style={s.kpi}><span style={s.kpiLabel}>Cobros clientes</span><span style={{ fontWeight: 800, color: '#16a34a', fontSize: 16 }}>{fmt(cuadre.totalCobrado)}</span></div>
                <div style={s.kpi}><span style={s.kpiLabel}>Gastos previos</span><span style={{ fontWeight: 800, color: '#dc2626', fontSize: 16 }}>{fmt(cuadre.totalProvisional)}</span></div>
                <div style={{ ...s.kpi, background: '#f0fdf4', border: '1px solid #86efac' }}><span style={s.kpiLabel}>Total a entregar</span><span style={{ fontWeight: 800, color: '#16a34a', fontSize: 18 }}>{fmt(cuadre.totalAEntregar)}</span></div>
              </div>

              {/* Órdenes cobradas */}
              {cuadre.ordenesCobro?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <label style={s.label}>Cobros del día</label>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                    {cuadre.ordenesCobro.map((o, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                        <div>
                          <code style={{ fontSize: 12, color: '#6b7280' }}>{o.numeroOrden}</code>
                          <span style={{ fontSize: 13, marginLeft: 8 }}>{o.clienteNombre}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {o.fotoTransferencia && <a href={o.fotoTransferencia} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#0284c7' }}>📷 Ver</a>}
                          <span style={{ fontWeight: 700, color: '#16a34a' }}>{fmt(o.monto)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Extintores pendientes */}
              {cuadre.extintoresPendientes?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <label style={s.label}>Extintores préstamo a devolver</label>
                  <div style={{ border: '1px solid #fcd34d', borderRadius: 8, background: '#fffbeb', overflow: 'hidden' }}>
                    {cuadre.extintoresPendientes.map((e, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #fde68a' }}>
                        <div>
                          <strong style={{ fontSize: 13 }}>{e.numeroExtintor}</strong>
                          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>— {e.clienteNombre}</span>
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!extDevueltos[e.id]}
                            onChange={ev => setExtDevueltos(p => ({ ...p, [e.id]: ev.target.checked }))}
                            style={{ width: 16, height: 16 }} />
                          <span style={{ fontSize: 12, fontWeight: 600 }}>Devuelto</span>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* PIN */}
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>PIN de autorización *</label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input type="password" inputMode="numeric" maxLength={4} value={pin}
                    onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    style={{ ...s.input, width: 120, fontSize: 20, letterSpacing: 8, textAlign: 'center' }}
                    placeholder="••••" autoFocus />
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Ingresa el PIN de administrador para confirmar</span>
                </div>
              </div>
            </>
          )}
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnCancelar}>Cancelar</button>
          <button onClick={handleConfirmar} disabled={guardando || pin.length !== 4}
            style={{ padding: '10px 24px', background: pin.length === 4 ? 'linear-gradient(135deg,#16a34a,#15803d)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 700 }}>
            {guardando ? 'Confirmando...' : '✅ Confirmar cuadre'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
const GestionLogistica = ({ user }) => {
  const [tab, setTab]                   = useState('ordenes');
  const [ordenes, setOrdenes]           = useState([]);
  const [mensajeros, setMensajeros]     = useState([]);
  const [resumenMens, setResumenMens]   = useState([]);
  const [extintores, setExtintores]     = useState([]);
  const [loading, setLoading]           = useState(true);
  const [modalAsignar, setModalAsignar] = useState(false);
  const [modalAvanzar, setModalAvanzar] = useState(null);
  const [modalCuadre, setModalCuadre]   = useState(null);
  const [buscarExt, setBuscarExt]       = useState('');
  const [filtroExtEstado, setFiltroExtEstado] = useState('prestado');
  const [exito, setExito]               = useState('');
  const [error, setError]               = useState('');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };
  const isMensajero = user?.role === 'mensajero';
  const isAdmin = user?.role === 'admin' || user?.role === 'tesoreria';
  const modoSolo = !isMensajero && mensajeros.length === 0;

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = isMensajero ? `${API}/logistica/mis-ordenes` : `${API}/logistica/ordenes`;
      const resOrdenes = await axios.get(endpoint, { headers });
      setOrdenes(Array.isArray(resOrdenes.data) ? resOrdenes.data : []);

      if (!isMensajero) {
        const [resMensajeros, resResumen, resExt] = await Promise.all([
          axios.get(`${API}/users`, { headers }),
          axios.get(`${API}/logistica/resumen-mensajeros`, { headers }),
          axios.get(`${API}/logistica/extintores-prestamo?estado=${filtroExtEstado}&buscar=${buscarExt}`, { headers })
        ]);
        const mens = (Array.isArray(resMensajeros.data) ? resMensajeros.data : [])
          .filter(u => u.role === 'mensajero' && u.activo !== false);
        setMensajeros(mens);
        setResumenMens(Array.isArray(resResumen.data) ? resResumen.data : []);
        setExtintores(Array.isArray(resExt.data) ? resExt.data : []);
      }
    } catch (e) { setError('Error al cargar logística'); }
    setLoading(false);
  }, [token, isMensajero, filtroExtEstado, buscarExt]);

  useEffect(() => { cargar(); }, [cargar]);

  const toast = (msg) => { setExito(msg); setTimeout(() => setExito(''), 3000); };

  const asignarRuta = async (data) => {
    const res = await axios.post(`${API}/logistica/asignar`, data, { headers });
    toast(`✅ ${data.ordenIds.length} órdenes asignadas a ${data.mensajeroNombre}`);
    setModalAsignar(false);
    await cargar();
    // Abrir WhatsApp con la ruta
    if (res.data?.whatsappUrl) window.open(res.data.whatsappUrl, '_blank');
  };

  const avanzarEstado = async (ordenId, datos) => {
    await axios.put(`${API}/logistica/orden/${ordenId}/estado`, datos, { headers });
    toast('✅ Estado actualizado');
    setModalAvanzar(null);
    await cargar();
  };

  const confirmarCuadre = async (datos) => {
    await axios.post(`${API}/logistica/cuadre/${modalCuadre.mensajeroId}/confirmar`, datos, { headers });
    toast('✅ Cuadre confirmado');
    setModalCuadre(null);
    await cargar();
  };

  const devolverExtintor = async (id) => {
    await axios.put(`${API}/logistica/extintores-prestamo/${id}/devolver`, {}, { headers });
    toast('✅ Extintor marcado como devuelto');
    await cargar();
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={s.wrapper}>
      {/* HEADER */}
      <div style={s.pageHeader}>
        <div>
          <h2 style={s.pageTitle}>🚚 Logística</h2>
          <p style={s.pageSubtitle}>{isMensajero ? 'Mi ruta del día' : 'Gestión de rutas y mensajeros'}</p>
        </div>
        {!isMensajero && (
          <button onClick={() => setModalAsignar(true)} style={s.btnPri}>+ Asignar Ruta</button>
        )}
      </div>

      {exito && <div style={s.alertOk}>{exito}</div>}
      {error && <div style={s.alertError}>{error}</div>}

      {/* TABS — solo admin/coordinador */}
      {!isMensajero && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {[
            { key: 'ordenes', label: '📋 Órdenes pendientes' },
            { key: 'mensajeros', label: '👥 Mensajeros' },
            { key: 'extintores', label: '🧯 Extintores préstamo' },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding: '9px 18px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13, border: 'none',
              background: tab === t.key ? '#7c3aed' : '#f3f4f6',
              color: tab === t.key ? '#fff' : '#374151',
            }}>{t.label}</button>
          ))}
        </div>
      )}

      {loading ? <div style={s.loading}>Cargando logística...</div> : (

        <>
          {/* ── ÓRDENES (Admin + Mensajero) ── */}
          {(tab === 'ordenes' || isMensajero) && (
            <div style={s.tableWrap}>
              <table style={s.tabla}>
                <thead>
                  <tr style={s.theadRow}>
                    {['Orden', 'Cliente', 'Dirección', 'Fecha', 'Servicio', 'Total', 'Mensajero', 'Estado', 'Acciones'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ordenes.length === 0 && (
                    <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
                      {isMensajero ? 'No tienes órdenes asignadas hoy' : 'No hay órdenes pendientes de logística'}
                    </td></tr>
                  )}
                  {ordenes.map((o, i) => (
                    <tr key={o.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
                      <td style={s.td}><code style={{ fontSize: 12 }}>{o.numeroOrden}</code></td>
                      <td style={s.td}><strong style={{ fontSize: 13 }}>{o.clienteNombre}</strong></td>
                      <td style={{ ...s.td, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: '#6b7280' }}>
                        {o.sucursalDireccion || o.clienteDireccion || '—'}
                      </td>
                      <td style={s.td}><span style={{ fontSize: 12 }}>{fmtFecha(o.fechaProgramada)}</span></td>
                      <td style={s.td}><span style={{ fontSize: 12, color: '#6b7280' }}>{o.lugarAtencion || 'servicio'}</span></td>
                      <td style={{ ...s.td, fontWeight: 700, color: '#16a34a' }}>{fmt(o.total)}</td>
                      <td style={s.td}><span style={{ fontSize: 12 }}>{o.mensajeroNombre || <span style={{ color: '#9ca3af' }}>Sin asignar</span>}</span></td>
                      <td style={s.td}><EstadoBadge estado={o.estado} /></td>
                      <td style={s.td}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button onClick={() => setModalAvanzar(o)}
                            style={{ padding: '5px 12px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                            ▶️ Avanzar
                          </button>
                          {(o.fotoRecogida || o.fotoEntrega) && (
                            <button onClick={() => {
                              const fotos = [o.fotoRecogida, o.fotoEntrega].filter(Boolean);
                              fotos.forEach(f => window.open(f, '_blank'));
                            }} style={{ padding: '5px 10px', background: '#f0fdf4', color: '#16a34a', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                              📷 Fotos
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── RESUMEN MENSAJEROS ── */}
          {tab === 'mensajeros' && !isMensajero && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {resumenMens.length === 0 && <div style={s.empty}><p style={{ fontSize: 40 }}>👥</p><p>No hay mensajeros activos hoy</p></div>}
              {resumenMens.map((m, i) => (
                <div key={i} style={s.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{m.mensajeroNombre}</div>
                      <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
                        {m.totalOrdenes} órdenes · {m.enRuta} en ruta · {m.completadas} entregadas
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>Recaudado</div>
                        <div style={{ fontWeight: 700, color: '#16a34a', fontSize: 16 }}>{fmt(m.totalRecaudado)}</div>
                      </div>
                      <button onClick={() => setModalCuadre({ mensajeroId: m.mensajeroId, mensajeroNombre: m.mensajeroNombre })}
                        style={{ padding: '8px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                        💰 Cuadrar
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── EXTINTORES PRÉSTAMO ── */}
          {tab === 'extintores' && !isMensajero && (
            <div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                <div style={s.searchWrap}>
                  <span>🔍</span>
                  <input style={s.searchInput} placeholder="Buscar por extintor o cliente..."
                    value={buscarExt} onChange={e => setBuscarExt(e.target.value)} />
                </div>
                <select style={{ padding: '9px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}
                  value={filtroExtEstado} onChange={e => setFiltroExtEstado(e.target.value)}>
                  <option value="prestado">En préstamo</option>
                  <option value="devuelto">Devueltos</option>
                  <option value="todos">Todos</option>
                </select>
              </div>

              <div style={s.tableWrap}>
                <table style={s.tabla}>
                  <thead>
                    <tr style={s.theadRow}>
                      {['Extintor', 'Cliente', 'Dirección', 'Orden', 'Fecha salida', 'Estado', 'Acciones'].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {extintores.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No hay registros</td></tr>}
                    {extintores.map((e, i) => (
                      <tr key={e.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
                        <td style={s.td}><strong style={{ color: '#7c3aed', fontSize: 14 }}>{e.numeroExtintor}</strong></td>
                        <td style={s.td}><span style={{ fontSize: 13 }}>{e.clienteNombre}</span></td>
                        <td style={{ ...s.td, fontSize: 12, color: '#6b7280', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.clienteDireccion || '—'}</td>
                        <td style={s.td}><code style={{ fontSize: 12 }}>{e.numeroOrden}</code></td>
                        <td style={s.td}><span style={{ fontSize: 12 }}>{e.fechaSalida ? new Date(e.fechaSalida).toLocaleDateString('es-CO') : '—'}</span></td>
                        <td style={s.td}>
                          <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: e.estado === 'prestado' ? '#fef2f2' : '#f0fdf4', color: e.estado === 'prestado' ? '#dc2626' : '#16a34a' }}>
                            {e.estado === 'prestado' ? '⏳ En préstamo' : '✅ Devuelto'}
                          </span>
                        </td>
                        <td style={s.td}>
                          {e.estado === 'prestado' && (
                            <button onClick={() => devolverExtintor(e.id)}
                              style={{ padding: '4px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                              ✅ Devuelto
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Vista mensajero — su cuadre del día */}
          {isMensajero && (
            <div style={{ marginTop: 20 }}>
              <button onClick={() => setModalCuadre({ mensajeroId: user.id, mensajeroNombre: user.nombre })}
                style={{ padding: '12px 24px', background: 'linear-gradient(135deg,#16a34a,#15803d)', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
                💰 Ver mi cuadre del día
              </button>
            </div>
          )}
        </>
      )}

      {/* MODALES */}
      {modalAsignar && (
        <ModalAsignar
          ordenes={ordenes.filter(o => ['programada', 'despacho'].includes(o.estado))}
          mensajeros={mensajeros}
          onAsignar={asignarRuta}
          onCerrar={() => setModalAsignar(false)}
        />
      )}
      {modalAvanzar && (
        <ModalAvanzarEstado
          orden={modalAvanzar}
          headers={headers}
          onAvanzar={avanzarEstado}
          onCerrar={() => setModalAvanzar(null)}
        />
      )}
      {modalCuadre && (
        <ModalCuadre
          mensajeroId={modalCuadre.mensajeroId}
          mensajeroNombre={modalCuadre.mensajeroNombre}
          headers={headers}
          onConfirmar={confirmarCuadre}
          onCerrar={() => setModalCuadre(null)}
        />
      )}
    </div>
  );
};

// ─── ESTILOS ──────────────────────────────────────────────────────────────────
const s = {
  wrapper:    { padding: '24px 32px', maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  pageTitle:  { margin: 0, fontSize: 26, fontWeight: 700, color: '#111' },
  pageSubtitle:{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 },
  btnPri:     { padding: '10px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 },
  alertOk:    { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  alertError: { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  loading:    { textAlign: 'center', padding: 60, color: '#9ca3af' },
  empty:      { textAlign: 'center', padding: 60, color: '#9ca3af', background: '#fff', borderRadius: 12 },
  card:       { background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' },
  tableWrap:  { background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.07)', overflow: 'hidden' },
  tabla:      { width: '100%', borderCollapse: 'collapse' },
  theadRow:   { background: '#f8fafc', borderBottom: '2px solid #e5e7eb' },
  th:         { padding: '12px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' },
  td:         { padding: '11px 14px', fontSize: 14, color: '#374151', borderBottom: '1px solid #f3f4f6' },
  kpi:        { background: '#f9fafb', borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 },
  kpiLabel:   { fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' },
  searchWrap: { display: 'flex', alignItems: 'center', background: '#fff', border: '2px solid #e5e7eb', borderRadius: 8, padding: '0 12px', flex: 1, maxWidth: 340 },
  searchInput:{ flex: 1, border: 'none', outline: 'none', fontSize: 13, padding: '9px 8px', background: 'transparent' },
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal:      { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 780, maxHeight: '95vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  modalHeader:{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 },
  modalTitulo:{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111' },
  btnCerrar:  { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16, color: '#6b7280', flexShrink: 0 },
  modalBody:  { padding: '16px 20px', overflow: 'auto', flex: 1 },
  modalFooter:{ padding: '14px 20px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 12, flexShrink: 0 },
  btnCancelar:{ padding: '10px 22px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 600 },
  label:      { fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 6, display: 'block' },
  input:      { padding: '9px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', color: '#111', background: '#fff', width: '100%', boxSizing: 'border-box' },
};

export default GestionLogistica;
