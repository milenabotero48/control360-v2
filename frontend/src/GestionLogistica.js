import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import NuevaOrden from './NuevaOrden';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
// Ola 3 fix: la fecha puede venir como plana "YYYY-MM-DD" o como ISO completo
// "YYYY-MM-DDTHH:mm:ss.000Z". Detectar y parsear correctamente en ambos casos.
const fmtFecha = (f) => {
  if (!f) return '—';
  try {
    const esSoloFecha = /^\d{4}-\d{2}-\d{2}$/.test(String(f));
    const d = new Date(esSoloFecha ? f + 'T05:00:00.000Z' : f);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', timeZone: 'America/Bogota' });
  } catch { return '—'; }
};
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

const EstadoBadge = ({ estado, orden }) => {
  let cfg = ESTADO_CONFIG[estado] || { label: estado, color: '#6b7280', bg: '#f3f4f6' };
  // Ola 2.5: si la orden ya está pagada, el estado "entrega_cobranza" se muestra
  // como "Entrega Final" para reflejar que no hay cobro pendiente.
  if (estado === 'entrega_cobranza' && orden && orden.pagado === true) {
    cfg = { label: 'Entrega Final', color: '#16a34a', bg: '#f0fdf4' };
  }
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
                      {/* ✅ INTERNA-DIR-001 */}{o.direccionTarea || o.sucursalDireccion || o.clienteDireccion || '—'}
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
  // Ola 3: resultado EXPLÍCITO del cobro en la entrega. Antes, avanzar sin
  // digitar nada se interpretaba como "pagó efectivo el total" (pago fantasma).
  // Ahora el mensajero DEBE decir qué pasó: 'pago' o 'no_pago' (→ CxC).
  const [resultadoCobro, setResultadoCobro] = useState('');
  const [formasPago, setFormasPago]       = useState(['Efectivo', 'Transferencia', 'Nequi', 'Datafono']);
  const [fotoUrl, setFotoUrl]             = useState('');
  const [fotoTransUrl, setFotoTransUrl]   = useState('');
  const [subiendoFoto, setSubiendoFoto]   = useState(false);

  // Ola 2.5: cobranza avanzada por orden (selección, abono parcial, retenciones)
  const [cobroPorOrden, setCobroPorOrden] = useState({}); // { ordenId: { selected, monto, retenciones[] } }
  const [retencionesCat, setRetencionesCat] = useState([]); // catálogo del admin
  const [agregandoRetIdx, setAgregandoRetIdx] = useState(null); // { ordenId, retId | 'custom' }
  const [guardando, setGuardando]         = useState(false);
  const [error, setError]                 = useState('');
  const [items, setItems]                 = useState(orden.items ? [...orden.items] : []);
  const [productosDisp, setProductosDisp] = useState([]);
  const [buscarProd, setBuscarProd]       = useState('');
  const fotoRef = useRef(null);
  const fotoTransRef = useRef(null);

  // Ola 2.5: préstamos pendientes que el cliente debe devolver al recibir
  const [prestamosCliente, setPrestamosCliente] = useState([]); // [{id, numeroExtintor, fechaSalida, ordenSalidaNumero}]
  const [prestamosRecogidos, setPrestamosRecogidos] = useState({}); // { prestamoId: bool }

  useEffect(() => {
    // Cargar formas de pago desde configuración
    fetch(`${API}/configuracion`, { headers })
      .then(r => r.json())
      .then(d => {
        const fps = (d?.formasPago || []).filter(f => f.activa && f.nombre !== 'Cuenta por Pagar' && f.nombre !== 'A crédito (CxC)').map(f => f.nombre);
        if (fps.length > 0) setFormasPago(fps);
        // Ola 2.5: catálogo de retenciones activas
        const rets = (d?.retenciones || []).filter(r => r.activo);
        setRetencionesCat(rets);
      }).catch(() => {});

    // Ola 2.5: inicializar el estado de cobro por orden
    if ((orden.ordenesACobrar || []).length > 0) {
      const init = {};
      (orden.ordenesACobrar || []).forEach(o => {
        init[o.ordenId || o.id] = {
          selected: true,           // por defecto todas seleccionadas
          monto: String(o.saldo || 0), // por defecto cobra el total
          retenciones: []
        };
      });
      setCobroPorOrden(init);
    }

    // Cargar productos disponibles
    fetch(`${API}/products`, { headers })
      .then(r => r.json())
      .then(d => setProductosDisp((Array.isArray(d) ? d : []).filter(p => p.activo !== false && p.tipo !== 'insumo')))
      .catch(() => {});

    // ✅ PRESTAMO-ENTREGA-001: cargar los préstamos del cliente al ir a entregar.
    // Ahora se filtra por clienteId en el BACKEND (más eficiente: no descarga
    // todos los préstamos del tenant para filtrarlos aquí). El mensajero ve
    // exactamente cuántos y cuáles extintores debe recoger de este cliente.
    if (orden.clienteId && ['en_ruta_entrega', 'entrega_cobranza'].includes(orden.estado)) {
      fetch(`${API}/logistica/extintores-prestamo?clienteId=${orden.clienteId}`, { headers })
        .then(r => r.json())
        .then(d => {
          const lista = Array.isArray(d) ? d : [];
          setPrestamosCliente(lista);
        })
        .catch(() => {});
    }
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


// ✅ COMPRESIÓN DE IMÁGENES antes de subir a Cloudinary (ahorra ~70% de espacio)
const comprimirImagen = (file, maxWidth = 1200, quality = 0.82) => {
  return new Promise((resolve) => {
    if (file.size < 300 * 1024) { resolve(file); return; } // < 300KB = no comprimir
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxWidth) { height = Math.round(height * maxWidth / width); width = maxWidth; }
      canvas.width = width; canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
      }, 'image/jpeg', quality);
    };
    img.src = URL.createObjectURL(file);
  });
};

  const subirFoto = async (file, setter) => {
    setSubiendoFoto(true);
    setError('');

    // ✅ GPS-FOTO-001: el timeout nativo de getCurrentPosition NO cubre el caso
    // en que el permiso de ubicación queda pendiente de respuesta del usuario
    // (típico en iPhone): la promesa no se resuelve NI se rechaza, y la foto
    // "se queda pensando" para siempre. Envolvemos el GPS en un Promise.race
    // con un tope DURO de 4s que siempre gana. Con o sin GPS, la foto sube.
    // Además, GPS y compresión corren EN PARALELO (antes eran secuenciales).
    const obtenerGPS = () => new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      let resuelto = false;
      const finalizar = (val) => { if (!resuelto) { resuelto = true; resolve(val); } };
      // Tope duro: pase lo que pase, a los 4s seguimos sin GPS
      const topeDuro = setTimeout(() => finalizar(null), 4000);
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(topeDuro); finalizar({ lat: pos.coords.latitude, lng: pos.coords.longitude, timestamp: new Date().toISOString() }); },
        () => { clearTimeout(topeDuro); finalizar(null); },
        { timeout: 4000, enableHighAccuracy: false }
      );
    });

    // GPS y compresión en paralelo — no esperamos uno para empezar el otro
    let gpsData = null;
    let fileComprimido;
    try {
      [gpsData, fileComprimido] = await Promise.all([
        obtenerGPS(),
        comprimirImagen(file, 1200, 0.82)
      ]);
    } catch {
      // Si la compresión falla, subir el original antes que bloquear la entrega
      fileComprimido = file;
    }

    // Aviso claro en vez de spinner mudo cuando no hay ubicación
    if (!gpsData) setError('Subiendo sin ubicación (GPS no disponible)…');

    const formData = new FormData();
    formData.append('file', fileComprimido);
    formData.append('upload_preset', CLOUDINARY_PRESET);
    formData.append('folder', 'control360/logistica');
    if (gpsData) formData.append('context', `lat=${gpsData.lat}|lng=${gpsData.lng}`);

    try {
      // ✅ GPS-FOTO-001: timeout de subida — si Cloudinary tarda demasiado,
      // avisar y permitir reintentar en vez de dejar la pantalla colgada.
      const controller = new AbortController();
      const abortSubida = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(CLOUDINARY_URL, { method: 'POST', body: formData, signal: controller.signal });
      clearTimeout(abortSubida);
      const data = await res.json();
      if (!data.secure_url) throw new Error('respuesta sin URL');
      setter(data.secure_url);
      if (gpsData) setter._gps = gpsData;
      setError(''); // limpiar el aviso de "sin ubicación" si la subida fue bien
    } catch (e) {
      setError(e.name === 'AbortError'
        ? 'La subida tardó demasiado. Revisa tu señal e intenta de nuevo.'
        : 'No se pudo subir la foto. Intenta de nuevo.');
    }
    setSubiendoFoto(false);
  };

  // ── Ola 3: el frontend YA NO calcula el siguiente estado ──────────────────
  // El backend tiene la máquina de estados única (orders.js). Este modal solo
  // dice "avanzar" (nuevoEstado: 'auto') y el backend decide el paso legal.
  // Esto elimina el bug de pantallas sin refrescar que retrocedían órdenes.
  const esCobranza = orden.tipoOrden === 'cxc' || orden.lugarAtencion === 'cobranza';
  const ESTADOS_MODAL = ['programada', 'en_ruta_recogida', 'despacho', 'en_ruta_entrega'];
  const puedeAvanzar = ESTADOS_MODAL.includes(orden.estado);

  const necesitaFotoRecogida = orden.estado === 'en_ruta_recogida';
  const necesitaFotoEntrega  = orden.estado === 'en_ruta_entrega';
  const necesitaExtintor     = orden.estado === 'en_ruta_recogida';
  const necesitaCobro        = orden.estado === 'en_ruta_entrega' || orden.estado === 'en_ruta_recogida';
  const puedeEditarItems     = ['en_ruta_recogida', 'en_ruta_entrega'].includes(orden.estado);
  // El paso de entrega exige resultado de cobro explícito (si no está pagada).
  const exigeResultadoCobro  = orden.estado === 'en_ruta_entrega' && !orden.pagado && !esCobranza;

  const handleAvanzar = async () => {
    if (!puedeAvanzar) return setError('No hay siguiente estado disponible');

    // ── Ola 3: resultado del cobro OBLIGATORIO al entregar ───────────────────
    if (exigeResultadoCobro && !resultadoCobro) {
      setError('⛔ Indica el resultado del cobro: ¿el cliente pagó o queda en CxC?');
      return;
    }
    if (exigeResultadoCobro && resultadoCobro === 'pago' && !formaPago) {
      setError('⛔ Selecciona la forma de pago.');
      return;
    }

    // ✅ CTRL-002: Detectar si falta foto (en lugar de bloquear)
    let deficiencia = null;
    let nuevoAdvertencia = null;

    // ── Foto recolección/entrega — ALERTA (no bloquea, queda como deficiencia)
    if (necesitaFotoRecogida && !fotoUrl) {
      deficiencia = 'foto_recogida_faltante';
      nuevoAdvertencia = '⚠️ Foto de recogida faltante — afectará tu evaluación de performance';
    }
    if (necesitaFotoEntrega && !fotoUrl) {
      deficiencia = 'foto_entrega_faltante';
      nuevoAdvertencia = '⚠️ Foto de entrega faltante — afectará tu evaluación de performance';
    }

    // ── Foto pago electrónico — BLOQUEA (SaaS-ready: cualquier forma que no sea
    // Efectivo ni CxC. Si mañana el admin agrega "Bold" o "Daviplata", pedirá foto.)
    // ✅ EFECTIVO-PALABRA-002: es efectivo si el NOMBRE contiene "efectivo"
    // (MAY EFECTIVO, EFECTIVO SAS, EFECTIVO SALA DE VENTAS...). Antes solo
    // reconocía "Efectivo" exacto, así que las otras cajas de efectivo pedían
    // comprobante que no existe. El efectivo se entrega en el cuadre, sin foto.
    const esEfectivoFP = (formaPago || '').toLowerCase().includes('efectivo');
    const esPagoVirtual = formaPago &&
      !esEfectivoFP &&
      formaPago !== 'A crédito (CxC)' &&
      formaPago !== 'A crédito' &&
      formaPago !== 'CXC' &&
      formaPago !== 'Cuenta por Pagar';
    const hayCobroVirtual = esPagoVirtual &&
      (Number(cobro) > 0 || esCobranza || (exigeResultadoCobro && resultadoCobro === 'pago'));
    if (hayCobroVirtual && !fotoTransUrl) {
      setError(`⛔ Pago por ${formaPago} requiere foto del comprobante (obligatoria).`);
      return;
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
      // Ola 2.5: si es cobranza, construir ordenesCobradas con monto y retenciones por orden
      let ordenesCobradasPayload;
      if (esCobranza && Object.keys(cobroPorOrden).length > 0) {
        ordenesCobradasPayload = (orden.ordenesACobrar || [])
          .filter(o => {
            const d = cobroPorOrden[o.ordenId || o.id];
            return d && d.selected && (Number(d.monto) > 0 || (d.retenciones || []).length > 0);
          })
          .map(o => {
            const key = o.ordenId || o.id;
            const d = cobroPorOrden[key];
            const retTotal = (d.retenciones || []).reduce((s, r) => s + (Number(r.valor) || 0), 0);
            return {
              ordenId: key,
              numeroOrden: o.numeroOrden,
              monto: Number(d.monto) || 0,
              retenciones: d.retenciones || [],
              retencionTotal: retTotal
            };
          });
      }

      // Ola 2.5: IDs de préstamos que el mensajero está marcando como recogidos
      const prestamosDevueltosIds = Object.entries(prestamosRecogidos)
        .filter(([_, recogido]) => recogido)
        .map(([id]) => id);

      // ── Ola 3: cobro y forma de pago según el resultado EXPLÍCITO ──────────
      let cobroFinal, formaPagoFinal;
      if (exigeResultadoCobro) {
        if (resultadoCobro === 'no_pago') {
          // El cliente NO pagó → el backend la clasifica como crédito y al
          // cuadrar pasa a CxC. Nada de montos inventados.
          cobroFinal = undefined;
          formaPagoFinal = 'A crédito (CxC)';
        } else {
          // Pagó: si no digitó monto, se cobra el total de la orden.
          cobroFinal = Number(cobro) > 0 ? cobro : String(orden.total || 0);
          formaPagoFinal = formaPago;
        }
      } else {
        cobroFinal = Number(cobro) > 0 ? cobro : undefined;
        formaPagoFinal = (Number(cobro) > 0 || esCobranza) ? formaPago : undefined;
      }

      await onAvanzar(orden.id, {
        nuevoEstado: 'auto', // el backend calcula el paso legal (máquina única)
        nota,
        extintorPrestamo: necesitaExtintor ? extintor : undefined,
        fotoUrl: fotoUrl || null,
        cobro: cobroFinal,
        formaPago: formaPagoFinal,
        fotoTransferenciaUrl: fotoTransUrl || undefined,
        items: puedeEditarItems ? items : undefined,
        deficiencia: deficiencia || null,
        ordenesCobradas: ordenesCobradasPayload,
        prestamosDevueltosIds: prestamosDevueltosIds.length > 0 ? prestamosDevueltosIds : undefined,
      });
      setPinDesbloqueado(false);
    } catch (e) {
      setError(e.response?.data?.error || 'Error al avanzar estado');
      setPinDesbloqueado(false);
    }
    setGuardando(false);
  };

  if (!puedeAvanzar) return (
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

          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <EstadoBadge estado={orden.estado} orden={orden} />
            <span style={{ color: '#16a34a', fontWeight: 700 }}>→ Siguiente paso del flujo</span>
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

          {/* Ola 2.5: Préstamos del cliente a recoger en la entrega */}
          {['en_ruta_entrega', 'entrega_cobranza'].includes(orden.estado) && prestamosCliente.length > 0 && (
            <div style={{
              marginBottom: 14, padding: '12px 14px',
              background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 20 }}>🔁</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#78350f' }}>
                    Extintores de préstamo a recoger ({prestamosCliente.length})
                  </div>
                  <div style={{ fontSize: 11, color: '#92400e' }}>
                    Marca los que el cliente te devuelve al entregar
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {prestamosCliente.map(p => {
                  const recogido = prestamosRecogidos[p.id];
                  return (
                    <label key={p.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', borderRadius: 6,
                      background: recogido ? '#dcfce7' : '#fff',
                      border: recogido ? '1px solid #86efac' : '1px solid #e5e7eb',
                      cursor: 'pointer'
                    }}>
                      <input type="checkbox" checked={!!recogido}
                        onChange={e => setPrestamosRecogidos(prev => ({ ...prev, [p.id]: e.target.checked }))}
                        style={{ width: 18, height: 18, cursor: 'pointer' }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: recogido ? '#15803d' : '#78350f' }}>
                          {p.numeroExtintor}
                        </div>
                        <div style={{ fontSize: 10, color: '#6b7280' }}>
                          {p.numeroOrden ? `De orden ${p.numeroOrden} · ` : ''}
                          {p.fechaSalida ? `Desde ${new Date(p.fechaSalida).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}` : ''}
                        </div>
                      </div>
                      {recogido && <span style={{ fontSize: 16, color: '#16a34a' }}>✓</span>}
                    </label>
                  );
                })}
              </div>
              {/* Resumen */}
              {(() => {
                const totalRecogidos = Object.values(prestamosRecogidos).filter(Boolean).length;
                const faltantes = prestamosCliente.length - totalRecogidos;
                if (faltantes > 0) {
                  return (
                    <div style={{
                      marginTop: 8, padding: '6px 10px',
                      background: '#fef2f2', borderRadius: 6,
                      fontSize: 11, color: '#991b1b', fontWeight: 600
                    }}>
                      ⚠ Faltan {faltantes} préstamo(s) por recoger. Si no los traes, la orden quedará marcada como PENDIENTE — Recoger préstamos.
                    </div>
                  );
                }
                return (
                  <div style={{
                    marginTop: 8, padding: '6px 10px',
                    background: '#f0fdf4', borderRadius: 6,
                    fontSize: 11, color: '#15803d', fontWeight: 600
                  }}>
                    ✓ Recogiste todos los préstamos pendientes
                  </div>
                );
              })()}
            </div>
          )}

          {/* Foto obligatoria */}
          {(necesitaFotoRecogida || necesitaFotoEntrega) && (
            <div style={{ marginBottom: 14 }}>
              <label style={s.label}>{necesitaFotoRecogida ? 'Foto del equipo recogido *' : 'Foto de la entrega *'}</label>
              {/* ✅ FOTO-GALERIA-001: sin capture — el celular ofrece Cámara O Galería */}
              <input ref={fotoRef} type="file" accept="image/*" style={{ display: 'none' }}
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
                      <input type="number" min="1" inputMode="numeric" value={item.cantidad}
                        onChange={e => {
                          // ✅ LOGISTICA-UX-001: permitir el campo vacío mientras
                          // el usuario borra para escribir otro número. Antes
                          // Number('')||1 lo forzaba a 1 al instante y no dejaba
                          // borrar. Se normaliza a 1 solo al salir del campo.
                          const raw = e.target.value;
                          setItems(prev => prev.map((x, i) => i === idx ? { ...x, cantidad: raw === '' ? '' : (Number(raw) || '') } : x));
                        }}
                        onBlur={e => {
                          const val = Number(e.target.value);
                          setItems(prev => prev.map((x, i) => i === idx ? { ...x, cantidad: val >= 1 ? val : 1 } : x));
                        }}
                        style={{ width: 64, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 15, textAlign: 'center' }} />
                      <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700, minWidth: 70, textAlign: 'right' }}>
                        {new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format((item.precioUnitario || 0) * (item.cantidad || 1))}
                      </span>
                      <button onClick={() => setItems(prev => prev.filter((_, i) => i !== idx))}
                        style={{ background: '#fef2f2', border: 'none', borderRadius: 4, padding: '3px 7px', cursor: 'pointer', color: '#dc2626', fontSize: 12 }}>✕</button>
                    </div>
                  </div>
                ))}
                {/* ✅ LOGISTICA-IVA-002: mostrar el desglose IGUAL que la orden.
                    El mensajero debe cobrar el TOTAL con IVA, no el subtotal.
                    Antes el modal solo sumaba los productos (sin IVA) y el
                    mensajero veía/cobraba de menos. Se usa el IVA guardado en la
                    orden; si la editó (agregó/quitó ítems), se recalcula proporcional. */}
                {(() => {
                  const ivaOrden = Number(orden.ivaValor) || 0;
                  const subtotalOrden = Number(orden.subtotal) || 0;
                  // Proporción de IVA sobre el subtotal original (para reflejar ediciones)
                  const pctIva = subtotalOrden > 0 ? (ivaOrden / subtotalOrden) : 0;
                  const ivaCalc = Math.round(totalItems * pctIva);
                  const totalConIva = totalItems + ivaCalc;
                  if (ivaOrden > 0) {
                    return (
                      <>
                        <div style={{ padding: '4px 12px', display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280' }}>
                          <span>Subtotal:</span>
                          <span>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(totalItems)}</span>
                        </div>
                        <div style={{ padding: '4px 12px', display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280' }}>
                          <span>IVA:</span>
                          <span>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(ivaCalc)}</span>
                        </div>
                        <div style={{ padding: '8px 12px', background: '#f9fafb', display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 15, borderTop: '1px solid #e5e7eb' }}>
                          <span>Total a cobrar:</span>
                          <span style={{ color: '#16a34a' }}>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(totalConIva)}</span>
                        </div>
                      </>
                    );
                  }
                  return (
                    <div style={{ padding: '8px 12px', background: '#f9fafb', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 14 }}>
                      <span>Total orden:</span>
                      <span style={{ color: '#16a34a' }}>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(totalItems)}</span>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Cobro — en recogida Y en entrega */}
         {necesitaCobro && (
            <>
              {esCobranza && (orden.ordenesACobrar || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <label style={s.label}>📋 Órdenes a cobrar</label>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                    Marca cuáles paga el cliente y cuánto. Puedes registrar abonos parciales y retenciones por orden.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {(orden.ordenesACobrar || []).map((o, i) => {
                      const key = o.ordenId || o.id;
                      const data = cobroPorOrden[key] || { selected: true, monto: String(o.saldo || 0), retenciones: [] };
                      const montoNum = Number(data.monto) || 0;
                      const retTotal = (data.retenciones || []).reduce((s, r) => s + (Number(r.valor) || 0), 0);
                      const aplicado = montoNum + retTotal;
                      const excede = aplicado > (o.saldo || 0) + 1;

                      return (
                        <div key={key} style={{
                          border: data.selected ? '2px solid #0284c7' : '1px solid #e5e7eb',
                          borderRadius: 10, padding: '10px 12px',
                          background: data.selected ? '#f0f9ff' : '#fafafa',
                          opacity: data.selected ? 1 : 0.6
                        }}>
                          {/* Cabecera fila */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <input type="checkbox" checked={!!data.selected}
                              onChange={e => setCobroPorOrden(p => ({ ...p, [key]: { ...data, selected: e.target.checked } }))}
                              style={{ width: 18, height: 18, cursor: 'pointer' }} />
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <code style={{ fontSize: 12, color: '#0284c7', fontWeight: 700 }}>{o.numeroOrden}</code>
                                <span style={{ fontSize: 12, color: '#6b7280' }}>Saldo: <strong style={{ color: '#dc2626' }}>{fmt(o.saldo)}</strong></span>
                              </div>
                              {o.numeroFactura && <div style={{ fontSize: 11, color: '#9ca3af' }}>Factura {o.numeroFactura}</div>}
                            </div>
                          </div>

                          {data.selected && (
                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #cbd5e1' }}>
                              {/* Monto a cobrar */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', minWidth: 120 }}>💵 Efectivo recibido</label>
                                <input type="number" min={0} max={o.saldo}
                                  style={{ ...s.input, flex: 1, fontSize: 13, padding: '6px 10px' }}
                                  value={data.monto}
                                  onChange={e => setCobroPorOrden(p => ({ ...p, [key]: { ...data, monto: e.target.value } }))} />
                                <button type="button" onClick={() => setCobroPorOrden(p => ({ ...p, [key]: { ...data, monto: String(o.saldo) } }))}
                                  style={{ padding: '6px 10px', fontSize: 11, background: '#e0f2fe', color: '#0284c7', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
                                  Todo
                                </button>
                              </div>

                              {/* Retenciones */}
                              {(data.retenciones || []).map((r, ri) => (
                                <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 10px', background: '#fef3c7', borderRadius: 6, fontSize: 12 }}>
                                  <span style={{ flex: 1 }}>🧾 {r.etiqueta} {r.porcentaje !== null ? `(${r.porcentaje}%)` : ''}</span>
                                  <span style={{ fontWeight: 700, color: '#92400e' }}>{fmt(r.valor)}</span>
                                  <button type="button"
                                    onClick={() => setCobroPorOrden(p => ({ ...p, [key]: { ...data, retenciones: data.retenciones.filter((_, ii) => ii !== ri) } }))}
                                    style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 14 }}>✕</button>
                                </div>
                              ))}

                              {/* Agregar retención */}
                              {retencionesCat.length > 0 && (
                                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                                  {retencionesCat.map(ret => (
                                    <button key={ret.id} type="button"
                                      onClick={() => {
                                        if (ret.tipo === 'custom') {
                                          const pct = window.prompt('Porcentaje de retención (%):');
                                          if (!pct || isNaN(Number(pct))) return;
                                          const valor = Math.round((o.saldo || 0) * Number(pct) / 100);
                                          setCobroPorOrden(p => ({ ...p, [key]: { ...data, retenciones: [...data.retenciones, { tipoId: ret.id, etiqueta: ret.etiqueta + ` ${pct}%`, porcentaje: Number(pct), base: o.saldo, valor }] } }));
                                        } else {
                                          const valor = Math.round((o.saldo || 0) * (ret.porcentaje || 0) / 100);
                                          setCobroPorOrden(p => ({ ...p, [key]: { ...data, retenciones: [...data.retenciones, { tipoId: ret.id, etiqueta: ret.etiqueta, porcentaje: ret.porcentaje, base: o.saldo, valor }] } }));
                                        }
                                      }}
                                      style={{ padding: '4px 10px', fontSize: 11, background: '#fff', border: '1px solid #fcd34d', borderRadius: 6, cursor: 'pointer', color: '#92400e', fontWeight: 600 }}>
                                      + {ret.etiqueta}{ret.porcentaje !== null ? ` ${ret.porcentaje}%` : ''}
                                    </button>
                                  ))}
                                </div>
                              )}

                              {/* Resumen aplicación */}
                              <div style={{ marginTop: 10, padding: '8px 10px', background: '#fff', borderRadius: 6, fontSize: 12 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280' }}>
                                  <span>Aplicado al saldo:</span>
                                  <strong style={{ color: excede ? '#dc2626' : '#16a34a' }}>{fmt(aplicado)}</strong>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280', marginTop: 2 }}>
                                  <span>Saldo restante:</span>
                                  <strong style={{ color: (o.saldo - aplicado) > 0 ? '#b45309' : '#16a34a' }}>{fmt(Math.max(0, o.saldo - aplicado))}</strong>
                                </div>
                                {excede && <div style={{ color: '#dc2626', marginTop: 4, fontSize: 11 }}>⚠ Excede el saldo de la orden</div>}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Total general */}
                    {(() => {
                      const totalEfectivo = Object.values(cobroPorOrden).filter(d => d.selected).reduce((s, d) => s + (Number(d.monto) || 0), 0);
                      const totalRetencion = Object.values(cobroPorOrden).filter(d => d.selected).reduce((s, d) => s + (d.retenciones || []).reduce((ss, r) => ss + (Number(r.valor) || 0), 0), 0);
                      return (
                        <div style={{ background: '#0284c7', color: '#fff', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                            <span>Efectivo a recibir</span>
                            <strong>{fmt(totalEfectivo)}</strong>
                          </div>
                          {totalRetencion > 0 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, opacity: 0.85 }}>
                              <span>Retención total</span>
                              <span>{fmt(totalRetencion)}</span>
                            </div>
                          )}
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.3)' }}>
                            <span>TOTAL APLICADO</span>
                            <span>{fmt(totalEfectivo + totalRetencion)}</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}

              {/* Ola 2.5: si la orden ya está pagada, mostrar banner y omitir campos de cobro */}
              {!esCobranza && orden.pagado && (
                <div style={{
                  marginBottom: 14, padding: '12px 14px',
                  background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8,
                  display: 'flex', alignItems: 'center', gap: 10
                }}>
                  <span style={{ fontSize: 22 }}>✅</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#166534' }}>
                      Orden PAGADA — Solo entregar
                    </div>
                    <div style={{ fontSize: 11, color: '#15803d', marginTop: 2 }}>
                      Forma: {orden.formaPago || '—'} · Monto: ${(orden.total || 0).toLocaleString('es-CO')}
                      {orden.pagoVirtualPendienteValidar && ' · ⏳ Pendiente validar por Admin/Tesorería'}
                    </div>
                  </div>
                </div>
              )}

              {/* ── Ola 3: RESULTADO DEL COBRO — obligatorio al entregar ────────
                  El mensajero declara qué pasó. "No pagó" manda la orden a
                  cartera (CxC) al cuadrar — ya no se inventan pagos. */}
              {exigeResultadoCobro && (
                <div style={{ marginBottom: 14 }}>
                  <label style={s.label}>Resultado del cobro <span style={{ color: '#dc2626' }}>*</span></label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button type="button"
                      onClick={() => { setResultadoCobro('pago'); if (!cobro) setCobro(String(orden.total || 0)); }}
                      style={{
                        padding: '14px 8px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                        border: resultadoCobro === 'pago' ? '2px solid #16a34a' : '1px solid #e5e7eb',
                        background: resultadoCobro === 'pago' ? '#f0fdf4' : '#fff',
                        color: resultadoCobro === 'pago' ? '#166534' : '#374151'
                      }}>
                      💵 El cliente PAGÓ
                    </button>
                    <button type="button"
                      onClick={() => { setResultadoCobro('no_pago'); setCobro(''); }}
                      style={{
                        padding: '14px 8px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                        border: resultadoCobro === 'no_pago' ? '2px solid #b45309' : '1px solid #e5e7eb',
                        background: resultadoCobro === 'no_pago' ? '#fffbeb' : '#fff',
                        color: resultadoCobro === 'no_pago' ? '#92400e' : '#374151'
                      }}>
                      📋 NO pagó → CxC
                    </button>
                  </div>
                  {resultadoCobro === 'no_pago' && (
                    <div style={{ marginTop: 8, padding: '10px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
                      La orden quedará en <strong>Cuentas por Cobrar</strong> con el saldo completo de {fmt(orden.total)}. No suma al cuadre del mensajero.
                    </div>
                  )}
                </div>
              )}

              {/* Monto cobrado general (NO cobranza — sigue funcionando igual) */}
              {!esCobranza && !orden.pagado && (!exigeResultadoCobro || resultadoCobro === 'pago') && (
                <div style={{ marginBottom: 14 }}>
                <label style={s.label}>
                    {orden.estado === 'en_ruta_recogida' ? 'Cobro en recogida' : 'Monto cobrado'}
                    <span style={{ fontWeight: 400, color: '#9ca3af' }}> (opcional en recogida)</span>
                </label>
                <input type="number" style={s.input} value={cobro} onChange={e => setCobro(e.target.value)} placeholder="0" />
                {/* Ola 2.5: si la orden NO está pagada todavía y NO es CxC, ofrecer marcar pago en este paso */}
                {!esCobranza && Number(cobro) === 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
                    💡 Si el cliente ya pagó (electrónico o efectivo), digita el monto aquí y selecciona la forma de pago. La orden quedará marcada como pagada.
                  </div>
                )}
              </div>
              )}

              {/* Forma de pago — visible cuando hay cobro, es cobranza o declaró pago */}
              {(Number(cobro) > 0 || esCobranza || (exigeResultadoCobro && resultadoCobro === 'pago')) && (
                <div style={{ marginBottom: 14 }}>
                  <label style={s.label}>Forma de pago</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {formasPago.map(f => (
                      <button key={f} type="button" onClick={() => setFormaPago(f)} style={{
                        padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, border: 'none',
                        background: formaPago === f ? '#0284c7' : '#f3f4f6',
                        color: formaPago === f ? '#fff' : '#374151',
                      }}>{f}</button>
                    ))}
                  </div>
                  {/* Foto comprobante: cualquier pago que no sea efectivo ni CxC */}
                  {formaPago && !(formaPago || '').toLowerCase().includes('efectivo') && formaPago !== 'A crédito (CxC)' && formaPago !== 'A crédito' && formaPago !== 'CXC' && formaPago !== 'Cuenta por Pagar' && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 700, marginBottom: 6 }}>
                        * Foto del comprobante obligatoria para {formaPago}
                      </div>
                      {/* ✅ FOTO-GALERIA-001: sin capture — el celular ofrece Cámara O Galería */}
                      <input ref={fotoTransRef} type="file" accept="image/*" style={{ display: 'none' }}
                        onChange={e => e.target.files[0] && subirFoto(e.target.files[0], setFotoTransUrl)} />
                      {fotoTransUrl ? (
                        <div style={{ position: 'relative' }}>
                          <img src={fotoTransUrl} alt="comprobante" style={{ width: '100%', borderRadius: 8, maxHeight: 150, objectFit: 'cover' }} />
                          <button onClick={() => setFotoTransUrl('')} style={{ position: 'absolute', top: 6, right: 6, background: '#dc2626', color: '#fff', border: 'none', borderRadius: '50%', width: 24, height: 24, cursor: 'pointer', fontSize: 12 }}>✕</button>
                        </div>
                      ) : (
                        <button onClick={() => fotoTransRef.current?.click()} disabled={subiendoFoto}
                          style={{ width: '100%', padding: '10px', border: '2px dashed #dc2626', borderRadius: 8, background: '#fef2f2', cursor: 'pointer', fontSize: 13, color: '#991b1b', fontWeight: 600 }}>
                          📷 Tomar foto del comprobante
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
            style={{ padding: '16px', background: guardando || subiendoFoto ? '#9ca3af' : 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 12, cursor: guardando || subiendoFoto ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 16, width: '100%' }}>
            {guardando ? 'Guardando...' : '▶️ Avanzar estado'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── ✅ LOGISTICA-CUADRE-001: MODAL HISTÓRICO DE ARQUEOS ──────────────────────
// Consulta los cuadres pasados de un mensajero con su detalle congelado.
// Responde "¿cuánto cuadró Henry el día X?" con evidencia firmada e inmutable.
const ModalHistorialCuadres = ({ mensajeroId, mensajeroNombre, headers, onCerrar }) => {
  const [arqueos, setArqueos] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get(`${API}/logistica/cuadres-historial?mensajeroId=${mensajeroId}`, { headers })
      .then(r => setArqueos(r.data?.arqueos || []))
      .catch(e => setError(e.response?.data?.error || 'Error al cargar el histórico'));
  }, [mensajeroId]);

  const fmtFechaHora = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 620 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>📋 Histórico de cuadres — {mensajeroNombre}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>Arqueos firmados e inmutables</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={{ ...s.modalBody, maxHeight: '70vh', overflowY: 'auto' }}>
          {error && <div style={s.alertError}>{error}</div>}
          {arqueos === null && !error && <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>Cargando...</div>}
          {arqueos && arqueos.length === 0 && (
            <div style={s.empty}><p style={{ fontSize: 40 }}>📭</p><p>Aún no hay cuadres registrados para este mensajero</p></div>
          )}
          {arqueos && arqueos.map((a, i) => (
            <div key={a.id || i} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', marginBottom: 10, background: a.descuadre !== 0 ? '#fffbeb' : '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{fmtFechaHora(a.fecha)}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Autorizó: {a.autorizadoPorEmail || '—'}</div>
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 13 }}>
                <span>Esperado: <strong>{fmt(a.efectivoEsperado)}</strong></span>
                <span>Recibido: <strong>{fmt(a.efectivoRecibido)}</strong></span>
                {a.virtualIngresado > 0 && <span style={{ color: '#1d4ed8' }}>Virtual: {fmt(a.virtualIngresado)}</span>}
              </div>
              {a.descuadre !== 0 && (
                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                  background: a.descuadre < 0 ? '#fef2f2' : '#eff6ff',
                  color: a.descuadre < 0 ? '#dc2626' : '#1d4ed8' }}>
                  {a.descuadre < 0 ? '⚠️ Faltante' : '↑ Sobrante'} de {fmt(Math.abs(a.descuadre))}
                  {a.motivoDescuadre ? ` — ${a.motivoDescuadre}` : ''}
                </div>
              )}
              {(a.ordenesCuadradas || []).length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
                  {a.ordenesCuadradas.length} orden(es): {a.ordenesCuadradas.map(o => o.numeroOrden).join(', ')}
                </div>
              )}
            </div>
          ))}
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
  // ✅ LOGISTICA-CUADRE-001: monto realmente recibido + motivo si hay descuadre.
  // Antes se asumía que el mensajero SIEMPRE entregaba el total exacto; ahora
  // se puede registrar lo que entregó de verdad y queda huella del faltante.
  const [montoRecibido, setMontoRecibido] = useState('');
  const [motivoDescuadre, setMotivoDescuadre] = useState('');

  useEffect(() => {
    axios.get(`${API}/logistica/cuadre/${mensajeroId}`, { headers })
      .then(r => {
        setCuadre(r.data);
        // Prellenar con lo esperado; el admin ajusta si el mensajero entregó otra cifra
        setMontoRecibido(String(r.data?.totalAEntregar || 0));
      })
      .catch(() => setError('Error al cargar cuadre'));
  }, [mensajeroId]);

  const esperado = cuadre?.totalAEntregar || 0;
  const recibidoNum = Number(montoRecibido) || 0;
  const descuadre = recibidoNum - esperado; // <0 faltante, >0 sobrante
  const hayDescuadre = cuadre && Math.abs(descuadre) > 0;

  const handleConfirmar = async () => {
    if (pin.length !== 4) return setError('Ingresa el PIN de 4 dígitos');
    // ✅ Opción (c): si hay descuadre, exigir motivo antes de confirmar
    if (hayDescuadre && !motivoDescuadre.trim()) {
      return setError(`Hay un ${descuadre < 0 ? 'faltante' : 'sobrante'} de ${fmt(Math.abs(descuadre))}. Escribe el motivo para dejar constancia.`);
    }
    setGuardando(true); setError('');
    try {
      await onConfirmar({
        pin,
        montoRecibido: recibidoNum,
        motivoDescuadre: motivoDescuadre.trim() || undefined,
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

              {/* ✅ LOGISTICA-CUADRE-002: DETALLE DE RUTA — todas las órdenes del
                  mensajero con su estado. Para que el admin vea qué está
                  haciendo cada uno y ubique cualquier error sin ir a ciegas. */}
              {cuadre.rutaDetalle?.length > 0 && (
                <div style={{ marginBottom: 16, border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '8px 12px', background: '#f8fafc', fontSize: 12, fontWeight: 800, color: '#475569', display: 'flex', justifyContent: 'space-between' }}>
                    <span>📋 ÓRDENES DE LA RUTA ({cuadre.rutaDetalle.length})</span>
                    <span>{cuadre.rutaDetalle.filter(o => o.cobrado).length} cobradas · {cuadre.rutaDetalle.filter(o => !o.cobrado).length} pendientes</span>
                  </div>
                  <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {cuadre.rutaDetalle.map((o, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid #f1f5f9', fontSize: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 700, color: '#334155' }}>{o.numeroOrden} · {o.clienteNombre}</div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 6, background: o.cobrado ? '#dcfce7' : '#fef9c3', color: o.cobrado ? '#15803d' : '#a16207' }}>{o.estadoLabel}</span>
                            {o.formaPago && <span style={{ fontSize: 10, color: '#94a3b8' }}>{o.formaPago}</span>}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          {o.cobrado
                            ? <span style={{ fontWeight: 800, color: '#16a34a' }}>{fmt(o.montoRecaudado)}</span>
                            : <span style={{ fontWeight: 600, color: '#cbd5e1' }}>sin cobro</span>}
                          {o.total > 0 && o.montoRecaudado !== o.total && (
                            <div style={{ fontSize: 10, color: '#94a3b8' }}>de {fmt(o.total)}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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

              {/* Ola 3: órdenes entregadas SIN pago → pasan a CxC al confirmar.
                  No suman al cuadre: son visibilidad de cartera para el Admin. */}
              {cuadre.ordenesSinPago?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <label style={s.label}>Entregadas sin pago — quedan en CxC</label>
                  <div style={{ border: '1px solid #fcd34d', borderRadius: 8, background: '#fffbeb', overflow: 'hidden' }}>
                    {cuadre.ordenesSinPago.map((o, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #fde68a' }}>
                        <div>
                          <code style={{ fontSize: 12, color: '#92400e' }}>{o.numeroOrden}</code>
                          <span style={{ fontSize: 13, marginLeft: 8 }}>{o.clienteNombre}</span>
                        </div>
                        <span style={{ fontWeight: 700, color: '#b45309', fontSize: 13 }}>{fmt(o.monto)} → CxC</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#92400e', marginTop: 4 }}>
                    Al confirmar el cuadre, estas órdenes pasan a Cuentas por Cobrar con su saldo completo.
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

              {/* ✅ LOGISTICA-CUADRE-001: monto realmente recibido + descuadre.
                  Deja registrar lo que el mensajero entregó de verdad; si no
                  coincide con lo esperado, exige motivo y queda en el arqueo. */}
              <div style={{ marginBottom: 14, padding: '12px 14px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                <label style={s.label}>💵 Monto en efectivo recibido</label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
                  <input type="number" inputMode="numeric" value={montoRecibido}
                    onChange={e => setMontoRecibido(e.target.value)}
                    style={{ ...s.input, width: 160, fontSize: 16, fontWeight: 700 }}
                    placeholder="0" />
                  <span style={{ fontSize: 12, color: '#6b7280' }}>Esperado: <strong>{fmt(esperado)}</strong></span>
                </div>
                {hayDescuadre && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{
                      padding: '8px 12px', borderRadius: 8, marginBottom: 8, fontWeight: 700, fontSize: 13,
                      background: descuadre < 0 ? '#fef2f2' : '#eff6ff',
                      color: descuadre < 0 ? '#dc2626' : '#1d4ed8',
                      border: `1px solid ${descuadre < 0 ? '#fecaca' : '#bfdbfe'}`
                    }}>
                      {descuadre < 0 ? '⚠️ Faltante' : '↑ Sobrante'} de {fmt(Math.abs(descuadre))}
                    </div>
                    <input value={motivoDescuadre} onChange={e => setMotivoDescuadre(e.target.value)}
                      style={{ ...s.input, width: '100%' }}
                      placeholder="Motivo del descuadre (obligatorio) — quedará en el arqueo" />
                  </div>
                )}
              </div>

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

// Hook reactivo — detecta móvil y se actualiza al rotar o redimensionar.
// Reemplaza el useState estático que se "congelaba" al montar el componente.
const useIsMobile = () => {
  const [mob, setMob] = useState(() => window.innerWidth < 1024);
  useEffect(() => {
    const h = () => setMob(window.innerWidth < 1024);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return mob;
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
  const isMobile = useIsMobile(); // ← reactivo, nunca se congela
  const [modalCuadre, setModalCuadre]   = useState(null);
  const [modalHistorial, setModalHistorial] = useState(null); // ✅ LOGISTICA-CUADRE-001
  const [mostrarNuevaOrden, setMostrarNuevaOrden] = useState(false);
  const [buscarExt, setBuscarExt]       = useState('');
  const [filtroExtEstado, setFiltroExtEstado] = useState('prestado');
  const [exito, setExito]               = useState('');
  const [error, setError]               = useState('');
  // Mini-Ola 2.6: catálogo de sectores
  const [sectores, setSectores]         = useState([]);
  // Mini-Ola 2.6: modal Reasignar (solo admin)
  const [modalReasignar, setModalReasignar] = useState(null);
  // Mini-Ola 2.6: modal Asignar Sector (cuando llega orden sin sector)
  const [modalAsignarSector, setModalAsignarSector] = useState(null);
  // Modal detalle orden (ver info completa desde logística)
  const [modalDetalleOrden, setModalDetalleOrden] = useState(null);

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
          axios.get(`${API}/users/mensajeros`, { headers }), // solo mensajeros — accesible para comercial
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

  // Mini-Ola 2.6: cargar catálogo de sectores
  useEffect(() => {
    axios.get(`${API}/configuracion`, { headers })
      .then(r => setSectores((r.data?.sectores || []).filter(s => s.activo)))
      .catch(() => setSectores([]));
    // eslint-disable-next-line
  }, [token]);

  // Mini-Ola 2.6: agrupar órdenes por sector
  const ordenesPorSector = (() => {
    const grupos = {};
    sectores.forEach(s => { grupos[s.id] = { sector: s, ordenes: [] }; });
    grupos['_sin_asignar'] = { sector: { id: '_sin_asignar', etiqueta: 'Sin Asignar', color: '#9ca3af' }, ordenes: [] };
    ordenes.forEach(o => {
      const sid = o.sectorId || '_sin_asignar';
      if (grupos[sid]) grupos[sid].ordenes.push(o);
      else grupos['_sin_asignar'].ordenes.push(o);
    });
    return Object.values(grupos).filter(g => g.ordenes.length > 0);
  })();

  // Mini-Ola 2.6: helper para reasignar (admin)
  const reasignarOrden = async (ordenId, nuevoMensajeroId) => {
    try {
      const mens = mensajeros.find(m => m.id === nuevoMensajeroId);
      if (!mens) return;
      await axios.post(`${API}/logistica/asignar`, {
        mensajeroId: nuevoMensajeroId,
        mensajeroNombre: mens.nombre,
        mensajeroCelular: mens.celular || '',
        ordenIds: [ordenId],
        forzarReasignar: true
      }, { headers });
      toast(`✅ Orden reasignada a ${mens.nombre}`);
      setModalReasignar(null);
      cargar();
    } catch (e) {
      setError(e.response?.data?.error || 'Error al reasignar');
    }
  };

  // Mini-Ola 2.6: asignar sector a orden desde Logística
  const asignarSectorOrden = async (ordenId, sectorId) => {
    try {
      await axios.put(`${API}/logistica/orden/${ordenId}/asignar-sector`,
        { sectorId }, { headers });
      toast(`✅ Sector asignado`);
      setModalAsignarSector(null);
      cargar();
    } catch (e) {
      setError(e.response?.data?.error || 'Error al asignar sector');
    }
  };

  const toast = (msg) => { setExito(msg); setTimeout(() => setExito(''), 3000); };

  const asignarRuta = async (data) => {
    try {
      const res = await axios.post(`${API}/logistica/asignar`, data, { headers });
      toast(`✅ ${data.ordenIds.length} órdenes asignadas a ${data.mensajeroNombre}`);
      setModalAsignar(false);
      await cargar();
      // Abrir WhatsApp con la ruta
      if (res.data?.whatsappUrl) window.open(res.data.whatsappUrl, '_blank');
    } catch (e) {
      // Mini-Ola 2.6: manejar bloqueo de doble asignación
      const resp = e.response?.data;
      if (e.response?.status === 409 && resp?.conflictos) {
        if (resp.requiereConfirmacion) {
          // Admin → mostrar lista y pedir confirmación
          const lista = resp.conflictos.map(c => `• ${c.numeroOrden} (asignada a ${c.mensajeroActual})`).join('\n');
          if (window.confirm(`Hay ${resp.conflictos.length} orden(es) ya asignada(s):\n\n${lista}\n\n¿Reasignar a ${data.mensajeroNombre}?`)) {
            return asignarRuta({ ...data, forzarReasignar: true });
          }
        } else {
          // No-admin: rechazo
          setError(`No puedes reasignar. ${resp.conflictos.length} orden(es) ya asignadas a otros mensajeros. Pide al admin que reasigne.`);
        }
      } else {
        setError(resp?.error || 'Error al asignar');
      }
    }
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
        {isMensajero && (
          <button onClick={() => setMostrarNuevaOrden(true)} style={{ ...s.btnPri, background: 'linear-gradient(135deg,#16a34a,#15803d)' }}>
            + Nueva Orden
          </button>
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
              {ordenes.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
                  {isMensajero ? 'No tienes órdenes asignadas hoy' : 'No hay órdenes pendientes de logística'}
                </div>
              ) : ordenesPorSector.map(({ sector, ordenes: ordsGrupo }) => (
                <div key={sector.id} style={{ marginBottom: 24 }}>
                  {/* Cabecera del sector */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 16px',
                    background: sector.color || '#6b7280',
                    color: '#fff', borderRadius: isMobile ? 10 : '10px 10px 0 0',
                    fontWeight: 700, fontSize: 14, marginBottom: isMobile ? 8 : 0
                  }}>
                    📍 {sector.etiqueta}
                    <span style={{ background: 'rgba(255,255,255,0.25)', padding: '2px 10px', borderRadius: 10, fontSize: 12 }}>
                      {ordsGrupo.length} {ordsGrupo.length === 1 ? 'orden' : 'órdenes'}
                    </span>
                  </div>

                  {/* MÓVIL: tarjetas */}
                  {(isMobile || isMensajero) ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {ordsGrupo.map(o => (
                        <div key={o.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 16, borderLeft: `4px solid ${sector.color || '#6b7280'}` }}>
                          {/* Fila superior: orden + estado + total */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <code style={{ fontSize: 13, fontWeight: 800, color: '#1e1b4b', background: '#f5f3ff', padding: '2px 8px', borderRadius: 6 }}>{o.numeroOrden}</code>
                              <EstadoBadge estado={o.estado} orden={o} />
                            </div>
                            <span style={{ fontSize: 16, fontWeight: 800, color: '#16a34a' }}>{fmt(o.total)}</span>
                          </div>

                          {/* Empresa */}
                          <div style={{ fontSize: 15, fontWeight: 800, color: '#111', marginBottom: 2 }}>{o.clienteNombre}</div>

                          {/* Sucursal */}
                          {o.sucursalNombre && (
                            <div style={{ fontSize: 12, color: '#7c3aed', fontWeight: 600, marginBottom: 4 }}>🏢 {o.sucursalNombre}</div>
                          )}

                          {/* Dirección → abre Google Maps */}
                          {(o.direccionTarea || o.sucursalDireccion || o.clienteDireccion || o.clienteDireccionPrincipal) && (
                            <a href={`https://maps.google.com/?q=${encodeURIComponent(o.direccionTarea || o.sucursalDireccion || o.clienteDireccion || o.clienteDireccionPrincipal)}`}
                              target="_blank" rel="noreferrer"
                              style={{ display: 'block', fontSize: 13, color: '#2563eb', marginBottom: 4, textDecoration: 'none' }}>
                              📍 {o.sucursalDireccion || o.clienteDireccion || o.clienteDireccionPrincipal}
                            </a>
                          )}

                          {/* Teléfono → llamada directa */}
                          {o.clienteCelular && (
                            <a href={`tel:${o.clienteCelular}`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#16a34a', fontWeight: 700, marginBottom: 6, textDecoration: 'none' }}>
                              📞 {o.clienteCelular}
                            </a>
                          )}

                          {/* Fecha y tipo de servicio */}
                          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                            📅 {fmtFecha(o.fechaProgramada)} · <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>{o.lugarAtencion || 'servicio'}</span>
                          </div>

                          {/* Resumen de items */}
                          {Array.isArray(o.items) && o.items.length > 0 && (
                            <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>Servicios / Productos</div>
                              {o.items.slice(0, 4).map((it, i) => (
                                <div key={i} style={{ fontSize: 12, color: '#374151', marginBottom: 2 }}>
                                  • {it.cantidad > 1 ? `${it.cantidad}x ` : ''}{it.nombre}
                                </div>
                              ))}
                              {o.items.length > 4 && (
                                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>+{o.items.length - 4} más...</div>
                              )}
                            </div>
                          )}

                          {/* Botones */}
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => setModalDetalleOrden(o)}
                              style={{ flex: '0 0 auto', padding: '12px 14px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                              👁 Ver
                            </button>
                            <button onClick={() => setModalAvanzar(o)}
                              style={{ flex: 1, padding: '12px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 15, fontWeight: 800 }}>
                              ▶️ Avanzar
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                  <table style={{ ...s.tabla, borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
                    <thead>
                      <tr style={s.theadRow}>
                        {['Orden', 'Cliente', 'Dirección', 'Fecha', 'Servicio', 'Total', 'Mensajero', 'Estado', 'Acciones'].map(h => (
                          <th key={h} style={s.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ordsGrupo.map((o, i) => {
                        const tieneAsignado = o.mensajeroId && o.mensajeroId !== '';
                        return (
                          <tr key={o.id} style={{
                            background: i % 2 === 0 ? '#fff' : '#f9fafb',
                            borderBottom: '1px solid #f3f4f6',
                            borderLeft: tieneAsignado ? `3px solid ${sector.color || '#6b7280'}` : 'none'
                          }}>
                            <td style={s.td}><code style={{ fontSize: 12 }}>{o.numeroOrden}</code></td>
                            <td style={s.td}>
                              <div>
                                <strong style={{ fontSize: 13 }}>{o.clienteNombre}</strong>
                                {o.sucursalNombre && <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 1 }}>🏢 {o.sucursalNombre}</div>}
                              </div>
                            </td>
                            <td style={{ ...s.td, fontSize: 12, color: '#374151' }}>
                              {(o.direccionTarea || o.sucursalDireccion || o.clienteDireccion || o.clienteDireccionPrincipal)
                                ? <a href={`https://maps.google.com/?q=${encodeURIComponent(o.direccionTarea || o.sucursalDireccion || o.clienteDireccion || o.clienteDireccionPrincipal)}`} target="_blank" rel="noreferrer" style={{ color: '#2563eb', textDecoration: 'none' }}>
                                    📍 {o.sucursalDireccion || o.clienteDireccion || o.clienteDireccionPrincipal}
                                  </a>
                                : <span style={{ color: '#9ca3af' }}>—</span>
                              }
                              {o.clienteCelular && <div style={{ marginTop: 2 }}><a href={`tel:${o.clienteCelular}`} style={{ fontSize: 11, color: '#16a34a', textDecoration: 'none' }}>📞 {o.clienteCelular}</a></div>}
                            </td>
                            <td style={s.td}><span style={{ fontSize: 12 }}>{fmtFecha(o.fechaProgramada)}</span></td>
                            <td style={s.td}><span style={{ fontSize: 12, color: '#6b7280' }}>{o.lugarAtencion || 'servicio'}</span></td>
                            <td style={{ ...s.td, fontWeight: 700, color: '#16a34a' }}>{fmt(o.total)}</td>
                            <td style={s.td}>
                              {tieneAsignado ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 10, background: '#dcfce7', color: '#15803d', fontSize: 11, fontWeight: 700 }}>
                                  🚚 {o.mensajeroNombre}
                                </span>
                              ) : (
                                <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>Sin asignar</span>
                              )}
                            </td>
                            <td style={s.td}><EstadoBadge estado={o.estado} orden={o} /></td>
                            <td style={s.td}>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <button onClick={() => setModalDetalleOrden(o)}
                                  style={{ padding: '5px 10px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                  👁 Ver
                                </button>
                                <button onClick={() => setModalAvanzar(o)}
                                  style={{ padding: '5px 12px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                  ▶️ Avanzar
                                </button>
                                {/* Mini-Ola 2.6: asignar sector si no tiene */}
                                {!isMensajero && !o.sectorId && (
                                  <button onClick={() => setModalAsignarSector(o)}
                                    style={{ padding: '5px 10px', background: '#fef3c7', color: '#92400e', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
                                    📍 Sector
                                  </button>
                                )}
                                {/* Mini-Ola 2.6: reasignar (admin) */}
                                {isAdmin && tieneAsignado && (
                                  <button onClick={() => setModalReasignar(o)}
                                    style={{ padding: '5px 10px', background: '#fff7ed', color: '#c2410c', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
                                    🔄 Reasignar
                                  </button>
                                )}
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
                        );
                      })}
                    </tbody>
                  </table>
                  )} {/* fin ternario móvil/desktop */}
                </div>
              ))}
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
                      {/* ✅ LOGISTICA-CUADRE-001: consultar arqueos pasados de este mensajero */}
                      <button onClick={() => setModalHistorial({ mensajeroId: m.mensajeroId, mensajeroNombre: m.mensajeroNombre })}
                        style={{ padding: '8px 14px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                        📋 Histórico
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
          ordenes={ordenes.filter(o => ['programada', 'despacho', 'en_ruta_entrega', 'entrega_cobranza'].includes(o.estado))}
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

      {/* ✅ LOGISTICA-CUADRE-001: histórico de arqueos consultable */}
      {modalHistorial && (
        <ModalHistorialCuadres
          mensajeroId={modalHistorial.mensajeroId}
          mensajeroNombre={modalHistorial.mensajeroNombre}
          headers={headers}
          onCerrar={() => setModalHistorial(null)}
        />
      )}

      {/* Mini-Ola 2.6: Modal Reasignar (solo admin) */}
      {/* NUEVA ORDEN desde Logística (mensajero o comercial en móvil) */}
      {mostrarNuevaOrden && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.5)', overflow: 'auto' }}>
          <NuevaOrden
            user={user}
            onCreada={() => { setMostrarNuevaOrden(false); cargar(); }}
            onCancelar={() => setMostrarNuevaOrden(false)}
          />
        </div>
      )}

      {modalReasignar && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 }}
             onClick={() => setModalReasignar(null)}>
          <div style={{ background: '#fff', borderRadius: 14, maxWidth: 440, width: '100%', padding: 24 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: '#111' }}>🔄 Reasignar orden</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
              <code style={{ fontSize: 12, color: '#c2410c' }}>{modalReasignar.numeroOrden}</code> · {modalReasignar.clienteNombre}
              <br />
              Actualmente asignada a <strong>{modalReasignar.mensajeroNombre}</strong>
            </p>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 6 }}>Nuevo mensajero</label>
            <select id="reasignarMens" style={{ ...s.select, width: '100%', padding: '10px 12px', borderRadius: 8 }} defaultValue="">
              <option value="">— Selecciona —</option>
              {mensajeros.filter(m => m.id !== modalReasignar.mensajeroId).map(m => (
                <option key={m.id} value={m.id}>{m.nombre}</option>
              ))}
            </select>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button onClick={() => setModalReasignar(null)}
                style={{ padding: '8px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                Cancelar
              </button>
              <button onClick={() => {
                const v = document.getElementById('reasignarMens').value;
                if (!v) { setError('Selecciona un mensajero'); return; }
                reasignarOrden(modalReasignar.id, v);
              }}
                style={{ padding: '8px 20px', background: '#c2410c', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                🔄 Reasignar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mini-Ola 2.6: Modal Asignar Sector */}
      {modalAsignarSector && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 }}
             onClick={() => setModalAsignarSector(null)}>
          <div style={{ background: '#fff', borderRadius: 14, maxWidth: 440, width: '100%', padding: 24 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700, color: '#111' }}>📍 Asignar sector</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
              <code style={{ fontSize: 12, color: '#c2410c' }}>{modalAsignarSector.numeroOrden}</code> · {modalAsignarSector.clienteNombre}
              <br />
              {modalAsignarSector.sucursalNombre && <span style={{ fontStyle: 'italic' }}>Sucursal: {modalAsignarSector.sucursalNombre}</span>}
            </p>
            <div style={{ background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontSize: 12, color: '#1e3a8a' }}>
              💡 El sector se grabará en {modalAsignarSector.sucursalId ? 'esta sucursal' : 'este cliente'} para futuras órdenes.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {sectores.map(sec => (
                <button key={sec.id} onClick={() => asignarSectorOrden(modalAsignarSector.id, sec.id)}
                  style={{
                    padding: '12px 14px', background: sec.color || '#6b7280',
                    color: '#fff', border: 'none', borderRadius: 8,
                    cursor: 'pointer', fontWeight: 700, fontSize: 13
                  }}>
                  📍 {sec.etiqueta}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
              <button onClick={() => setModalAsignarSector(null)}
                style={{ padding: '8px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal detalle orden — vista completa desde Logística */}
      {modalDetalleOrden && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 1100, padding: 0 }}
             onClick={() => setModalDetalleOrden(null)}>
          <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 640, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 -8px 40px rgba(0,0,0,0.2)' }}
               onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <code style={{ fontSize: 14, fontWeight: 800, color: '#7c3aed', background: '#f5f3ff', padding: '2px 10px', borderRadius: 6 }}>{modalDetalleOrden.numeroOrden}</code>
                <span style={{ marginLeft: 10 }}><EstadoBadge estado={modalDetalleOrden.estado} orden={modalDetalleOrden} /></span>
              </div>
              <button onClick={() => setModalDetalleOrden(null)} style={s.btnCerrar}>✕</button>
            </div>
            {/* Body */}
            <div style={{ padding: '16px' }}>
              {/* Datos del cliente */}
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 8 }}>Datos del cliente</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#111', marginBottom: 4 }}>{modalDetalleOrden.clienteNombre}</div>
                {modalDetalleOrden.clienteNit && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>NIT: {modalDetalleOrden.clienteNit}</div>}
                {modalDetalleOrden.sucursalNombre && (
                  <div style={{ fontSize: 13, color: '#7c3aed', fontWeight: 600, marginBottom: 4 }}>🏢 {modalDetalleOrden.sucursalNombre}</div>
                )}
                {(modalDetalleOrden.sucursalDireccion || modalDetalleOrden.clienteDireccion || modalDetalleOrden.clienteDireccionPrincipal) && (
                  <a href={`https://maps.google.com/?q=${encodeURIComponent(modalDetalleOrden.sucursalDireccion || modalDetalleOrden.clienteDireccion || modalDetalleOrden.clienteDireccionPrincipal)}`}
                     target="_blank" rel="noreferrer"
                     style={{ display: 'block', fontSize: 13, color: '#2563eb', marginBottom: 4, textDecoration: 'none' }}>
                    📍 {modalDetalleOrden.sucursalDireccion || modalDetalleOrden.clienteDireccion || modalDetalleOrden.clienteDireccionPrincipal}
                  </a>
                )}
                {modalDetalleOrden.clienteCelular && (
                  <a href={`tel:${modalDetalleOrden.clienteCelular}`}
                     style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 14, color: '#16a34a', fontWeight: 700, textDecoration: 'none' }}>
                    📞 {modalDetalleOrden.clienteCelular}
                  </a>
                )}
              </div>

              {/* Info de la orden */}
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 8 }}>Info de la orden</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Fecha programada</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>📅 {fmtFecha(modalDetalleOrden.fechaProgramada)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Tipo de servicio</div>
                    <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'capitalize' }}>{modalDetalleOrden.lugarAtencion || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Mensajero</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{modalDetalleOrden.mensajeroNombre || 'Sin asignar'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Total</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: '#16a34a' }}>{fmt(modalDetalleOrden.total)}</div>
                  </div>
                </div>
                {modalDetalleOrden.notas && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
                    💬 {modalDetalleOrden.notas}
                  </div>
                )}
              </div>

              {/* Productos / Servicios */}
              {Array.isArray(modalDetalleOrden.items) && modalDetalleOrden.items.length > 0 && (
                <div style={{ background: '#f8fafc', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 8 }}>Productos / Servicios</div>
                  {modalDetalleOrden.items.map((it, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: i < modalDetalleOrden.items.length - 1 ? '1px solid #e5e7eb' : 'none' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                          {it.cantidad > 1 ? <span style={{ background: '#ede9fe', color: '#7c3aed', borderRadius: 4, padding: '1px 6px', fontSize: 11, marginRight: 6 }}>{it.cantidad}x</span> : null}
                          {it.nombre}
                        </div>
                        {it.notas && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>📝 {it.notas}</div>}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#16a34a', marginLeft: 12 }}>{fmt((it.precioUnitario || 0) * (it.cantidad || 1))}</div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10, paddingTop: 10, borderTop: '2px solid #e5e7eb' }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: '#16a34a' }}>Total: {fmt(modalDetalleOrden.total)}</span>
                  </div>
                </div>
              )}

              {/* Botón avanzar desde el modal de detalle */}
              <button onClick={() => { setModalDetalleOrden(null); setModalAvanzar(modalDetalleOrden); }}
                style={{ width: '100%', padding: '14px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 12, cursor: 'pointer', fontSize: 15, fontWeight: 800 }}>
                ▶️ Avanzar esta orden
              </button>
            </div>
          </div>
        </div>
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
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 1000, padding: '0' },
  modal:      { background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 780, maxHeight: '95vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 -8px 40px rgba(0,0,0,0.2)' },
  modalHeader:{ padding: '16px 16px 12px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 },
  modalTitulo:{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' },
  btnCerrar:  { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16, color: '#6b7280', flexShrink: 0 },
  modalBody:  { padding: '12px 16px', overflow: 'auto', flex: 1 },
  modalFooter:{ padding: '12px 16px', borderTop: '1px solid #f3f4f6', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 },
  btnCancelar:{ padding: '14px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 12, cursor: 'pointer', fontWeight: 600, width: '100%', fontSize: 15 },
  label:      { fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 6, display: 'block' },
  input:      { padding: '9px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', color: '#111', background: '#fff', width: '100%', boxSizing: 'border-box' },
};

export default GestionLogistica;

