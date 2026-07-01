import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { exportarExcel } from './exportExcel';

// ─── HOOK RESPONSIVE ──────────────────────────────────────────────────────────
const useIsMobile = () => {
  const [mob, setMob] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMob(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mob;
};

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const fmtDate = (ts) => {
  if (!ts) return '—';
  // Si es timestamp Firestore { _seconds } o { seconds }
  if (ts && ts._seconds) return new Date(ts._seconds * 1000).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota' });
  if (ts && ts.seconds)  return new Date(ts.seconds  * 1000).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota' });
  const s = String(ts);
  // Si es solo fecha YYYY-MM-DD: agregar T05:00:00Z (mediodía Colombia = UTC-5)
  // para que NO se interprete como UTC medianoche y quede el día anterior en CO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(s + 'T12:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota' });
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota' });
};
const genId = (prefix) => `${prefix}-${String(Math.floor(Math.random() * 9000) + 1000)}`;

const CATEGORIAS_DEFAULT = ['Insumos taller', 'Transporte / Combustible', 'Arriendo', 'Servicios públicos', 'Papelería', 'Mantenimiento', 'Nómina', 'Marketing', 'Impuestos', 'Compra de Mercancia', 'Otros'];

// ════════════════════════════════════════════════════════════════════════════
// ComboTercero — combobox de tercero/proveedor (Ola 3)
// ────────────────────────────────────────────────────────────────────────────
// Escribe y filtra en vivo entre los proveedores registrados; acepta texto
// libre para terceros ocasionales; y permite crear el proveedor inline sin
// salir del formulario. Reutilizable después en Compras y CxP.
// ════════════════════════════════════════════════════════════════════════════
const ComboTercero = ({ proveedores, valor, proveedorId, onChange, onCrear }) => {
  const [texto, setTexto]       = useState(valor || '');
  const [abierto, setAbierto]   = useState(false);
  const [creando, setCreando]   = useState(false);

  useEffect(() => { setTexto(valor || ''); }, [valor]);

  const q = (texto || '').toLowerCase().trim();
  const filtrados = q
    ? proveedores.filter(p => (p.nombre || '').toLowerCase().includes(q) || (p.nit || '').includes(q))
    : proveedores;
  const coincideExacto = proveedores.some(p => (p.nombre || '').toLowerCase() === q);

  const elegir = (p) => {
    onChange(p.nombre, p.id);
    setTexto(p.nombre);
    setAbierto(false);
  };

  const crearNuevo = async () => {
    if (!q || creando) return;
    setCreando(true);
    const ok = await onCrear(texto.trim());
    setCreando(false);
    if (ok) setAbierto(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 9, fontSize: 14, boxSizing: 'border-box' }}
        value={texto}
        placeholder="Escribe para buscar o digitar el tercero..."
        onChange={e => {
          setTexto(e.target.value);
          // Texto libre: vale como tercero aunque no esté registrado.
          onChange(e.target.value, '');
          setAbierto(true);
        }}
        onFocus={() => setAbierto(true)}
        onBlur={() => setTimeout(() => setAbierto(false), 180)}
      />
      {proveedorId && <span style={{ position: 'absolute', right: 10, top: 11, fontSize: 12, color: '#16a34a' }}>✓ registrado</span>}
      {abierto && (filtrados.length > 0 || (q && !coincideExacto)) && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.12)', zIndex: 200, maxHeight: 220, overflow: 'auto', marginTop: 4 }}>
          {filtrados.slice(0, 30).map(p => (
            <div key={p.id} onMouseDown={() => elegir(p)}
              style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f9fafb' }}
              onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
              onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
              {p.nombre}{p.nit ? <span style={{ color: '#9ca3af', fontSize: 11 }}> · NIT {p.nit}</span> : ''}
            </div>
          ))}
          {q && !coincideExacto && (
            <div onMouseDown={crearNuevo}
              style={{ padding: '10px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#0284c7', background: '#f0f9ff' }}>
              {creando ? 'Creando...' : `➕ Crear proveedor "${texto.trim()}"`}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Egreso provisional — para mensajeros
const EgresoProvisional = ({ mensajeros, cajas, formasPagoConfig, onCrear, onCerrar }) => {
  const [mensajeroId, setMensajeroId] = useState('');
  const [concepto, setConcepto]       = useState('');
  const [monto, setMonto]             = useState('');
  const [cajaId, setCajaId]           = useState('');
  const [guardando, setGuardando]     = useState(false);
  const [error, setError]             = useState('');

  const guardar = async () => {
    if (!mensajeroId || !concepto || !monto || !cajaId) return setError('Todos los campos son requeridos');
    setGuardando(true);
    await onCrear({ mensajeroId, concepto, monto: Number(monto), cajaId, tipo: 'provisional', cuadrado: false });
    setGuardando(false);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 440 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>💵 Egreso Provisional</h3>
          <button onClick={onCerrar} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>⚠️ {error}</div>}
          <div style={S.field}>
            <label style={S.label}>Mensajero *</label>
            <select style={S.select} value={mensajeroId} onChange={e => setMensajeroId(e.target.value)}>
              <option value="">— Seleccionar —</option>
              {mensajeros.map(m => <option key={m.id} value={m.id}>{m.nombre}</option>)}
            </select>
          </div>
          <div style={S.field}>
            <label style={S.label}>Concepto *</label>
            <input style={S.input} placeholder="Ej: Gasolina moto" value={concepto} onChange={e => setConcepto(e.target.value)} />
          </div>
          <div style={S.field}>
            <label style={S.label}>Monto *</label>
            <input type="number" style={S.input} placeholder="0" value={monto} onChange={e => setMonto(e.target.value)} />
          </div>
          <div style={S.field}>
            <label style={S.label}>Sale de caja *</label>
            <select style={S.select} value={cajaId} onChange={e => setCajaId(e.target.value)}>
              <option value="">— Seleccionar caja —</option>
              {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </div>
          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: 10, fontSize: 12, color: '#92400e' }}>
            💡 El mensajero verá este valor en su cuadre. Al cuadrar, la diferencia regresa a caja.
          </div>
        </div>
        <div style={S.modalFooter}>
          <button onClick={onCerrar} style={S.btnSecondary}>Cancelar</button>
          <button onClick={guardar} disabled={guardando} style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}>
            {guardando ? 'Guardando...' : '💵 Entregar dinero'}
          </button>
        </div>
      </div>
    </div>
  );
};
const FORMAS_PAGO_DEFAULT = ['Efectivo', 'Transferencia', 'Nequi', 'Datafono'];
const PORCENTAJES_IVA = [{ label: '19%', val: 19 }, { label: '8%', val: 8 }, { label: '0%', val: 0 }];
const PORCENTAJES_RETEN = [{ label: '2.5% Compras', val: 2.5 }, { label: '4% Servicios', val: 4 }, { label: 'Otro %', val: null }];

// ─────────────────────────────────────────────────────────────────────────────
// MODAL CUADRAR DEFINITIVO (Ola 2)
// ─────────────────────────────────────────────────────────────────────────────
// Cuando Maykol vuelve de hacer un mandado de Orden Interna, trae:
//   - La factura del proveedor (puede subir foto/PDF)
//   - El vuelto en efectivo
//   - El gasto real (puede ser distinto del provisional)
//
// Tesorería o Admin abren este modal, registran el valor real, suben la
// factura, escriben su PIN y el sistema:
//   - Crea el egreso definitivo
//   - Ajusta caja (suma vuelto o resta diferencia)
//   - Marca el provisional como cuadrado
//   - Libera la Orden Interna para que pueda cerrarse
//
// Backend: POST /api/egresos/:provisionalId/cuadrar-definitivo (ya en Ola 1).
// ─────────────────────────────────────────────────────────────────────────────
const ModalCuadrarDefinitivo = ({ provisional, cajas, onCuadrado, onCerrar }) => {
  const [valorReal, setValorReal] = useState(String(provisional.monto || ''));
  const [proveedor, setProveedor] = useState(provisional.proveedor || '');
  const [notas, setNotas]         = useState('');
  const [cajaId, setCajaId]       = useState(provisional.cajaId || (cajas[0]?.id || ''));
  const [formaPago, setFormaPago] = useState(provisional.formaPago || 'Efectivo');
  const [pin, setPin]             = useState('');
  const [verPin, setVerPin]       = useState(false);
  const [facturaAdjunta, setFacturaAdjunta] = useState('');
  const [subiendo, setSubiendo]   = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError]         = useState('');

  const base = Number(provisional.monto) || 0;
  const real = Number(valorReal) || 0;
  const diferencia = base - real; // positiva = vuelto / negativa = falta


// ✅ COMPRESIÓN DE IMÁGENES antes de subir a Cloudinary (ahorra ~70% de espacio)
const comprimirImagen = (file, maxWidth, quality) => {
  maxWidth = maxWidth || 1200;
  quality = quality || 0.82;
  return new Promise(function(resolve) {
    if (file.size < 300 * 1024) { resolve(file); return; }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = function() {
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      canvas.width = w; canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(function(blob) {
        resolve(new File([blob], 'foto.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', quality);
    };
    img.src = URL.createObjectURL(file);
  });
};

  const subirFactura = async (file) => {
    if (!file) return;
    setSubiendo(true);
    try {
      const fileComp = await comprimirImagen(file, 1200, 0.82);
      const fd = new FormData();
      fd.append('file', fileComp);
      fd.append('upload_preset', 'control360');
      const r = await fetch('https://api.cloudinary.com/v1_1/dk8hposft/image/upload', { method: 'POST', body: fd });
      const data = await r.json();
      if (data.secure_url) setFacturaAdjunta(data.secure_url);
      else setError('No se pudo subir la factura');
    } catch { setError('Error al subir factura'); }
    setSubiendo(false);
  };

  const confirmar = async () => {
    setError('');
    if (!real || real < 0) return setError('Valor real inválido');
    if (!cajaId) return setError('Selecciona una caja');
    if (!/^\d{4}$/.test(pin)) return setError('PIN debe ser de 4 dígitos');
    try {
      setGuardando(true);
      await axios.post(`${API}/egresos/${provisional.id}/cuadrar-definitivo`, {
        valorReal: real, proveedor, notas, cajaId, formaPago,
        facturaAdjunta, pin
      }, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
      onCuadrado();
    } catch (e) {
      setError(e.response?.data?.error || 'Error al cuadrar');
    } finally { setGuardando(false); }
  };

  const sty = {
    overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 },
    modal:      { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.35)', fontFamily: "'Segoe UI', sans-serif" },
    header:     { display: 'flex', gap: 14, alignItems: 'flex-start', padding: '22px 24px 14px', borderBottom: '1px solid #f3f4f6', background: 'linear-gradient(135deg, #fef3c7 0%, #fff 100%)' },
    iconCircle: { width: 44, height: 44, borderRadius: '50%', background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 },
    title:      { margin: 0, fontSize: 17, fontWeight: 700, color: '#111' },
    subtitle:   { margin: '4px 0 0', fontSize: 13, color: '#6b7280', lineHeight: 1.4 },
    body:       { padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 16 },
    campo:      { display: 'flex', flexDirection: 'column', gap: 6 },
    label:      { fontSize: 13, fontWeight: 700, color: '#374151', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' },
    sub:        { fontSize: 11, fontWeight: 400, color: '#9ca3af' },
    input:      { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 14, outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
    fila2:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
    resumen:    { padding: 14, borderRadius: 8, background: '#f9fafb', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 },
    resumRow:   { display: 'flex', justifyContent: 'space-between' },
    resumTotal: { display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15, paddingTop: 8, borderTop: '1px dashed #d1d5db' },
    pinWrap:    { position: 'relative', width: 180 },
    eyeBtn:     { position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 },
    footer:     { padding: '14px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 10, background: '#fafafa' },
    btnCancel:  { padding: '10px 20px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
    btnOk:      { padding: '10px 22px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
    alert:      { padding: '10px 14px', background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', borderRadius: 8, fontSize: 13, fontWeight: 500, margin: '12px 24px 0' },
    fotoBox:    { border: '2px dashed #d1d5db', borderRadius: 8, padding: 16, textAlign: 'center', cursor: 'pointer', background: '#fafafa' }
  };

  return (
    <div style={sty.overlay} onClick={() => !guardando && onCerrar()}>
      <div style={sty.modal} onClick={e => e.stopPropagation()}>
        <div style={sty.header}>
          <div style={sty.iconCircle}>💵</div>
          <div style={{ flex: 1 }}>
            <h3 style={sty.title}>Cuadrar egreso provisional</h3>
            <p style={sty.subtitle}>
              {provisional.numero} · OI {provisional.numeroOrdenInterna} · Mensajero: {provisional.mensajeroNombre || '—'}
            </p>
          </div>
        </div>

        {error && <div style={sty.alert}>⚠ {error}</div>}

        <div style={sty.body}>
          <div style={sty.fila2}>
            <div style={sty.campo}>
              <label style={sty.label}>Valor entregado al mensajero</label>
              <input style={{ ...sty.input, background: '#f3f4f6', fontWeight: 700 }} value={fmt(base)} disabled />
            </div>
            <div style={sty.campo}>
              <label style={sty.label}>Valor real gastado <span style={{ color: '#dc2626' }}>*</span></label>
              <input
                style={sty.input}
                type="number"
                value={valorReal}
                onChange={e => setValorReal(e.target.value)}
                disabled={guardando}
                placeholder="0"
              />
            </div>
          </div>

          <div style={sty.resumen}>
            <div style={sty.resumRow}><span>Entregado</span><span>{fmt(base)}</span></div>
            <div style={sty.resumRow}><span>Gastó realmente</span><span>{fmt(real)}</span></div>
            <div style={sty.resumTotal}>
              {diferencia > 0
                ? <><span style={{ color: '#16a34a' }}>↩ Vuelto a caja</span><span style={{ color: '#16a34a' }}>{fmt(diferencia)}</span></>
                : diferencia < 0
                  ? <><span style={{ color: '#dc2626' }}>↑ Gasto adicional (sale de caja)</span><span style={{ color: '#dc2626' }}>{fmt(Math.abs(diferencia))}</span></>
                  : <><span style={{ color: '#6b7280' }}>= Cuadre exacto</span><span style={{ color: '#6b7280' }}>$0</span></>
              }
            </div>
          </div>

          <div style={sty.fila2}>
            <div style={sty.campo}>
              <label style={sty.label}>Proveedor</label>
              <input style={sty.input} value={proveedor} onChange={e => setProveedor(e.target.value)} placeholder="Nombre del proveedor" disabled={guardando} />
            </div>
            <div style={sty.campo}>
              <label style={sty.label}>Caja afectada <span style={{ color: '#dc2626' }}>*</span></label>
              <select style={sty.input} value={cajaId} onChange={e => setCajaId(e.target.value)} disabled={guardando}>
                <option value="">— Seleccionar —</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({fmt(c.saldo)})</option>)}
              </select>
            </div>
          </div>

          <div style={sty.campo}>
            <label style={sty.label}>
              Factura del proveedor
              <span style={sty.sub}>Opcional pero recomendado</span>
            </label>
            {facturaAdjunta ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, background: '#f0fdf4', borderRadius: 8 }}>
                <img src={facturaAdjunta} alt="factura" style={{ height: 50, borderRadius: 4 }} />
                <span style={{ fontSize: 13, color: '#16a34a', flex: 1 }}>✓ Factura adjuntada</span>
                <button onClick={() => setFacturaAdjunta('')} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 13 }}>Quitar</button>
              </div>
            ) : (
              <label style={sty.fotoBox}>
                <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => subirFactura(e.target.files[0])} disabled={subiendo || guardando} />
                <div style={{ fontSize: 13, color: '#6b7280' }}>
                  {subiendo ? '⏳ Subiendo...' : '📎 Adjuntar foto o PDF de la factura'}
                </div>
              </label>
            )}
          </div>

          <div style={sty.campo}>
            <label style={sty.label}>Notas</label>
            <input style={sty.input} value={notas} onChange={e => setNotas(e.target.value)} placeholder="Ej: Compra de soldadura para taller" disabled={guardando} />
          </div>

          <div style={sty.campo}>
            <label style={sty.label}>
              PIN de autorización <span style={{ color: '#dc2626' }}>*</span>
              <span style={sty.sub}>Solo Admin o Tesorería</span>
            </label>
            <div style={sty.pinWrap}>
              <input
                type={verPin ? 'text' : 'password'}
                style={{ ...sty.input, paddingRight: 44, fontSize: 22, textAlign: 'center', letterSpacing: 10, fontFamily: 'monospace' }}
                inputMode="numeric" maxLength={4}
                placeholder="0000"
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                disabled={guardando}
              />
              <button type="button" onClick={() => setVerPin(!verPin)} style={sty.eyeBtn} disabled={guardando}>
                {verPin ? '🙈' : '👁️'}
              </button>
            </div>
          </div>
        </div>

        <div style={sty.footer}>
          <button onClick={onCerrar} style={sty.btnCancel} disabled={guardando}>Cancelar</button>
          <button
            onClick={confirmar}
            style={{ ...sty.btnOk, opacity: guardando || !real || pin.length !== 4 ? 0.5 : 1, cursor: guardando ? 'not-allowed' : 'pointer' }}
            disabled={guardando || !real || pin.length !== 4}
          >
            {guardando ? 'Cuadrando...' : '✓ Confirmar cuadre'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Calcular totales ─────────────────────────────────────────────────────────
const calcularTotales = (monto, ivaPct, retenPct) => {
  const base = Number(monto) || 0;
  const ivaVal = Math.round(base * (Number(ivaPct) || 0) / 100);
  const retenVal = Math.round(base * (Number(retenPct) || 0) / 100);
  const totalPagar = base + ivaVal - retenVal;
  return { base, ivaVal, retenVal, totalPagar };
};

// ─── Modal Nuevo / Editar ─────────────────────────────────────────────────────
function ModalEgreso({ egreso, empresas, cajas, formasPago, formasPagoConfig, categoriasList, onSave, onClose }) {
  const [form, setForm] = useState({
    concepto: '', proveedor: '', categoria: (categoriasList || CATEGORIAS_DEFAULT)[0],
    monto: '', ivaPct: 0, retenPct: 0, retenManual: '',
    formaPago: '', cajaId: '', cajaLabel: '',
    pagarAhora: false, notas: '',
    fecha: new Date().toISOString().slice(0, 10),
    ...(egreso || {})
  });
  const [saving, setSaving] = useState(false);
  const [retenPersonalizada, setRetenPersonalizada] = useState(false);
  const [productosCompra, setProductosCompra] = useState(egreso?.productosCompra || []);
  const [productosDisponibles, setProductosDisponibles] = useState([]);
  const [alertasMargen, setAlertasMargen] = useState([]);
  const [proveedores, setProveedores] = useState([]);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    const token = localStorage.getItem('token');
    fetch(`${API}/proveedores`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setProveedores(Array.isArray(data) ? data.filter(p => p.activo !== false) : []))
      .catch(() => {});
  }, []);

  const esCompra = form.categoria === 'Compra de Mercancia';

  useEffect(() => {
    if (esCompra && productosDisponibles.length === 0) {
      const token = localStorage.getItem('token');
      fetch(`${API}/products`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => setProductosDisponibles((Array.isArray(data) ? data : []).filter(p => p.activo !== false && p.tipo !== 'servicio' && p.tipo !== 'combo')))
        .catch(() => {});
    }
  }, [esCompra]);

  // Monto base: si es compra se calcula de la tabla de productos
  const montoBase = esCompra && productosCompra.length > 0
    ? productosCompra.reduce((s, p) => s + (Number(p.precioUnitario) || 0) * (Number(p.cantidad) || 1), 0)
    : Number(form.monto) || 0;

  const montoParaCalculo = esCompra ? montoBase : Number(form.monto) || 0;

  const { base, ivaVal, retenVal, totalPagar } = calcularTotales(montoParaCalculo, form.ivaPct, retenPersonalizada ? form.retenManual : form.retenPct);

  const handleFormaPago = (nombre) => {
    const conf = (formasPagoConfig || []).find(f => f.nombre === nombre);
    const caja = conf?.cajaId ? cajas.find(c => c.id === conf.cajaId) : null;
    set('formaPago', nombre);
    set('cajaId', caja?.id || '');
    set('cajaLabel', caja?.nombre || '');
  };

  const handleSubmit = async () => {
    if (!form.concepto.trim()) return alert('El concepto es requerido');
    if (esCompra && productosCompra.length === 0) return alert('Agrega al menos un producto a la compra');
    if (!esCompra && (!form.monto || Number(form.monto) <= 0)) return alert('El monto es requerido');
    if (form.pagarAhora && !form.cajaId && form.formaPago !== 'Cuenta por Pagar') return alert('Selecciona la forma de pago para pagar ahora');
    setSaving(true);
    const retenPctFinal = retenPersonalizada ? Number(form.retenManual) || 0 : Number(form.retenPct) || 0;
    const res = await onSave({
      ...form,
      monto: base,
      ivaPct: Number(form.ivaPct) || 0,
      ivaVal,
      retenPct: retenPctFinal,
      retenVal,
      totalPagar,
      productosCompra: esCompra ? productosCompra : [],
    });
    if (res?.alertasMargen?.length > 0) setAlertasMargen(res.alertasMargen);
    else setSaving(false);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 600 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>{egreso ? '✏️ Editar Egreso' : '➕ Nuevo Egreso'}</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>

          {/* Fila 1: Concepto + Proveedor */}
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Concepto *</label>
              <input style={S.input} value={form.concepto} onChange={e => set('concepto', e.target.value)} placeholder="Ej: Compra gas CO2" />
            </div>
            <div style={S.field}>
              <label style={S.label}>Tercero / Proveedor</label>
              {/* Ola 3: combobox — busca entre los proveedores registrados,
                  acepta texto libre para terceros ocasionales y permite crear
                  el proveedor sin salir del egreso. Con 200 proveedores el
                  select cerrado era inusable. */}
              <ComboTercero
                proveedores={proveedores}
                valor={form.proveedor}
                proveedorId={form.proveedorId || ''}
                onChange={(nombre, id) => { set('proveedor', nombre); set('proveedorId', id || ''); }}
                onCrear={async (nombre) => {
                  try {
                    const token = localStorage.getItem('token');
                    const r = await fetch(`${API}/proveedores`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ nombre })
                    });
                    const data = await r.json();
                    if (!r.ok) throw new Error(data.error || 'Error creando proveedor');
                    setProveedores(p => [...p, data]);
                    set('proveedor', data.nombre);
                    set('proveedorId', data.id);
                    return true;
                  } catch { return false; }
                }}
              />
            </div>
          </div>

          {/* Fila 2: Categoría + Fecha */}
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Categoría *</label>
              <select style={S.select} value={form.categoria} onChange={e => set('categoria', e.target.value)}>
                {(categoriasList || form._categorias || CATEGORIAS_DEFAULT).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={S.field}>
              <label style={S.label}>Fecha *</label>
              <input type="date" style={S.input} value={form.fecha} onChange={e => set('fecha', e.target.value)} />
            </div>
          </div>

          {/* Tabla productos — solo para compra de mercancía */}
          {esCompra && (
            <div style={S.field}>
              <label style={S.label}>Productos comprados *</label>
              <select style={S.select} onChange={e => {
                const prod = productosDisponibles.find(p => p.id === e.target.value);
                if (!prod) return;
                const yaExiste = productosCompra.find(p => p.productoId === prod.id);
                if (yaExiste) return;
                setProductosCompra(prev => [...prev, { productoId: prod.id, nombre: prod.nombre, codigo: prod.codigo, cantidad: 1, precioUnitario: prod.precioCosto || 0 }]);
                e.target.value = '';
              }}>
                <option value="">+ Agregar producto...</option>
                {productosDisponibles.map(p => <option key={p.id} value={p.id}>{p.codigo} — {p.nombre}</option>)}
              </select>

              {productosCompra.length > 0 && (
                <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        {['Producto', 'Cant.', 'Precio unit.', 'Subtotal', ''].map(h => (
                          <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {productosCompra.map((p, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 10px', fontWeight: 600 }}>{p.nombre}</td>
                          <td style={{ padding: '8px 6px' }}>
                            <input type="number" min="1" value={p.cantidad}
                              onChange={e => setProductosCompra(prev => prev.map((x, j) => j === i ? { ...x, cantidad: Number(e.target.value) || 1 } : x))}
                              style={{ ...S.input, width: 60, padding: '5px 8px' }} />
                          </td>
                          <td style={{ padding: '8px 6px' }}>
                            <input type="number" min="0" value={p.precioUnitario}
                              onChange={e => setProductosCompra(prev => prev.map((x, j) => j === i ? { ...x, precioUnitario: Number(e.target.value) || 0 } : x))}
                              style={{ ...S.input, width: 100, padding: '5px 8px' }} />
                          </td>
                          <td style={{ padding: '8px 10px', fontWeight: 700, color: '#16a34a' }}>
                            {new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format((p.precioUnitario || 0) * (p.cantidad || 1))}
                          </td>
                          <td style={{ padding: '8px 6px' }}>
                            <button onClick={() => setProductosCompra(prev => prev.filter((_, j) => j !== i))}
                              style={{ background: '#fef2f2', border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', color: '#dc2626', fontSize: 12 }}>✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ padding: '8px 12px', background: '#f9fafb', display: 'flex', justifyContent: 'flex-end', fontWeight: 700, fontSize: 14 }}>
                    Subtotal compra: <span style={{ color: '#16a34a', marginLeft: 8 }}>
                      {new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(montoBase)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Alertas de margen */}
          {alertasMargen.length > 0 && (
            <div style={{ background: '#fffbeb', border: '2px solid #fcd34d', borderRadius: 10, padding: 16, marginBottom: 8 }}>
              <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 10 }}>⚠️ El costo de estos productos aumentó — revisa el precio de venta:</div>
              {alertasMargen.map((a, i) => (
                <div key={i} style={{ background: '#fff', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{a.nombre}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                    Costo: <span style={{ color: '#dc2626' }}>${a.costoPrevio.toLocaleString('es-CO')} → ${a.costoNuevo.toLocaleString('es-CO')}</span>
                    &nbsp;·&nbsp; Margen: <span style={{ color: '#dc2626' }}>{a.margenPrevio}% → {a.margenNuevo}%</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#374151', marginTop: 4 }}>
                    Precio venta actual: <strong>${a.precioVenta.toLocaleString('es-CO')}</strong>
                  </div>
                </div>
              ))}
              <button onClick={() => { setAlertasMargen([]); setSaving(false); onClose(); }}
                style={{ padding: '8px 20px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13, marginTop: 4 }}>
                ✓ Entendido — ajustaré precios en Productos
              </button>
            </div>
          )}

          {/* Monto — oculto si es compra (se calcula automáticamente) */}
          {!esCompra && (
            <div style={S.field}>
              <label style={S.label}>Monto base *</label>
              <input type="number" style={{ ...S.input, fontSize: 16, fontWeight: 700 }} value={form.monto}
                onChange={e => set('monto', e.target.value)} placeholder="0" min="0" />
            </div>
          )}

          {/* IVA */}
          <div style={S.field}>
            <label style={S.label}>IVA del proveedor <span style={{ fontWeight: 400, color: '#9ca3af' }}>(opcional)</span></label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PORCENTAJES_IVA.map(p => (
                <button key={p.val} type="button" onClick={() => set('ivaPct', p.val)} style={{
                  padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  background: form.ivaPct === p.val ? '#0284c7' : '#f3f4f6',
                  color: form.ivaPct === p.val ? '#fff' : '#374151',
                  border: form.ivaPct === p.val ? '2px solid #0284c7' : '2px solid transparent',
                }}>{p.label}</button>
              ))}
            </div>
            {Number(form.ivaPct) > 0 && (
              <div style={{ fontSize: 12, color: '#0284c7', marginTop: 4, fontWeight: 600 }}>
                IVA ({form.ivaPct}%): {fmt(ivaVal)} → se registra como IVA descontable (CXP)
              </div>
            )}
          </div>

          {/* Retención */}
          <div style={S.field}>
            <label style={S.label}>Retención practicada <span style={{ fontWeight: 400, color: '#9ca3af' }}>(opcional)</span></label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PORCENTAJES_RETEN.map(p => (
                <button key={p.label} type="button" onClick={() => {
                  if (p.val === null) { setRetenPersonalizada(true); set('retenPct', 0); }
                  else { setRetenPersonalizada(false); set('retenPct', p.val); }
                }} style={{
                  padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  background: (p.val !== null && form.retenPct === p.val && !retenPersonalizada) || (p.val === null && retenPersonalizada) ? '#7c3aed' : '#f3f4f6',
                  color: (p.val !== null && form.retenPct === p.val && !retenPersonalizada) || (p.val === null && retenPersonalizada) ? '#fff' : '#374151',
                  border: '2px solid transparent',
                }}>{p.label}</button>
              ))}
            </div>
            {retenPersonalizada && (
              <input type="number" min="0" max="100" step="0.1" style={{ ...S.input, marginTop: 8, maxWidth: 160 }}
                placeholder="% manual" value={form.retenManual}
                onChange={e => set('retenManual', e.target.value)} />
            )}
            {retenVal > 0 && (
              <div style={{ fontSize: 12, color: '#7c3aed', marginTop: 4, fontWeight: 600 }}>
                Retención ({retenPersonalizada ? form.retenManual : form.retenPct}%): {fmt(retenVal)} → se registra como Retefuente (CXP)
              </div>
            )}
          </div>

          {/* Total a pagar */}
          {Number(form.monto) > 0 && (
            <div style={{ background: '#f0fdf4', border: '2px solid #86efac', borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
                <span>Monto base</span><span>{fmt(base)}</span>
              </div>
              {ivaVal > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#0284c7', marginBottom: 4 }}>
                <span>+ IVA ({form.ivaPct}%)</span><span>{fmt(ivaVal)}</span>
              </div>}
              {retenVal > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#7c3aed', marginBottom: 4 }}>
                <span>− Retención</span><span>({fmt(retenVal)})</span>
              </div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 16, borderTop: '1px solid #86efac', paddingTop: 8, marginTop: 4 }}>
                <span>Total a pagar</span><span style={{ color: '#16a34a' }}>{fmt(totalPagar)}</span>
              </div>
            </div>
          )}

          {/* Botón Cuenta por Pagar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => {
              const esCxp = form.formaPago === 'Cuenta por Pagar';
              set('formaPago', esCxp ? '' : 'Cuenta por Pagar');
              set('pagarAhora', false);
              set('cajaId', ''); set('cajaLabel', '');
            }} style={{
              padding: '9px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, border: 'none',
              background: form.formaPago === 'Cuenta por Pagar' ? '#7c3aed' : '#f3f4f6',
              color: form.formaPago === 'Cuenta por Pagar' ? '#fff' : '#374151',
            }}>📋 Cuenta por Pagar</button>
          </div>

          {form.formaPago === 'Cuenta por Pagar' && (
            <div style={{ background: '#ede9fe', border: '1px solid #c4b5fd', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#6d28d9' }}>
              📋 Esta compra quedará en <strong>Cuentas por Pagar</strong>. Cuando pagues al proveedor, regístralo desde el módulo <strong>CxP</strong>.
            </div>
          )}

          {/* Pagar ahora — oculto si es Cuenta por Pagar */}
          {form.formaPago !== 'Cuenta por Pagar' && (
          <div style={{ ...S.field, marginBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <input type="checkbox" id="pagarAhora" checked={form.pagarAhora}
                onChange={e => set('pagarAhora', e.target.checked)}
                style={{ width: 18, height: 18, cursor: 'pointer' }} />
              <label htmlFor="pagarAhora" style={{ ...S.label, cursor: 'pointer', margin: 0 }}>
                Pagar ahora (registrar en caja)
              </label>
            </div>
            {form.pagarAhora && (
              <div>
                <label style={S.label}>Forma de pago *</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                  {(formasPago || FORMAS_PAGO_DEFAULT).filter(f => f !== 'Cuenta por Pagar').map(f => (
                    <button key={f} type="button" onClick={() => handleFormaPago(f)} style={{
                      padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                      background: form.formaPago === f ? '#16a34a' : '#f3f4f6',
                      color: form.formaPago === f ? '#fff' : '#374151',
                      border: form.formaPago === f ? '2px solid #16a34a' : '2px solid transparent',
                    }}>{f}</button>
                  ))}
                </div>
                {form.cajaLabel && <div style={{ fontSize: 12, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>✅ Caja: {form.cajaLabel}</div>}
                {form.pagarAhora && form.formaPago && !form.cajaId && (
                  <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6, fontWeight: 600 }}>⚠️ Sin caja asignada. Ve a Mi Empresa → Formas de pago.</div>
                )}
              </div>
            )}
          </div>
          )}

          {/* Notas */}
          <div style={{ ...S.field, marginTop: 14 }}>
            <label style={S.label}>Notas internas</label>
            <textarea style={{ ...S.input, height: 56, resize: 'vertical' }} value={form.notas}
              onChange={e => set('notas', e.target.value)} placeholder="Observaciones..." />
          </div>
        </div>
        <div style={S.modalFooter}>
          <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
          <button onClick={handleSubmit} disabled={saving} style={S.btnPrimary}>
            {saving ? 'Guardando...' : egreso ? 'Guardar cambios' : form.pagarAhora ? `✅ Crear y pagar ${fmt(totalPagar)}` : 'Crear egreso'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal Pagar ──────────────────────────────────────────────────────────────
function ModalPagar({ egreso, cajas, formasPago, formasPagoConfig, onPagar, onClose }) {
  const [formaPago, setFormaPago] = useState('');
  const [cajaId, setCajaId]       = useState('');
  const [cajaLabel, setCajaLabel] = useState('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  const totalPagar = egreso.totalPagar || Number(egreso.monto) || 0;

  const handleFormaPago = (nombre) => {
    const conf = (formasPagoConfig || []).find(f => f.nombre === nombre);
    const caja = conf?.cajaId ? cajas.find(c => c.id === conf.cajaId) : null;
    setFormaPago(nombre); setCajaId(caja?.id || ''); setCajaLabel(caja?.nombre || '');
  };

  const confirmar = async () => {
    if (!formaPago) return setError('Selecciona la forma de pago');
    if (!cajaId) return setError('Sin caja asignada. Configúrala en Mi Empresa → Formas de pago.');
    setSaving(true);
    await onPagar({ cajaId, formaPago });
    setSaving(false);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 460 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>💳 Registrar Pago</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 16, marginBottom: 20 }}>
            <div style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>{egreso.concepto}</div>
            {egreso.ivaVal > 0 && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Base: {fmt(egreso.monto)} + IVA: {fmt(egreso.ivaVal)}{egreso.retenVal > 0 ? ` − Ret: ${fmt(egreso.retenVal)}` : ''}</div>}
            <div style={{ fontSize: 24, fontWeight: 800, color: '#15803d', marginTop: 4 }}>{fmt(totalPagar)}</div>
          </div>
          <div style={S.field}>
            <label style={S.label}>Forma de pago *</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(formasPago || FORMAS_PAGO_DEFAULT).map(f => (
                <button key={f} type="button" onClick={() => handleFormaPago(f)} style={{
                  padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  background: formaPago === f ? '#16a34a' : '#f3f4f6',
                  color: formaPago === f ? '#fff' : '#374151',
                  border: formaPago === f ? '2px solid #16a34a' : '2px solid transparent',
                }}>{f}</button>
              ))}
            </div>
            {cajaLabel && <div style={{ fontSize: 12, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>✅ Caja: {cajaLabel}</div>}
            {formaPago && !cajaId && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6, fontWeight: 600 }}>⚠️ Sin caja asignada. Ve a Mi Empresa → Formas de pago.</div>}
          </div>
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12, fontWeight: 600 }}>⚠️ {error}</div>}
          <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: 12, fontSize: 12, color: '#92400e' }}>
            ⚠️ Una vez pagado, solo podrá editarse con contraseña admin. Queda en auditoría.
          </div>
        </div>
        <div style={S.modalFooter}>
          <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
          <button onClick={confirmar} disabled={saving} style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#16a34a,#15803d)' }}>
            {saving ? 'Procesando...' : '✅ Confirmar pago'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal Anular Egreso Pagado ──────────────────────────────────────────────────
// Permite anular egresos PAGADOS: requiere PIN admin + motivo.
// Revierte el dinero a la caja automáticamente.
function ModalAnularEgreso({ egreso, onAnular, onClose }) {
  const [paso, setPaso]     = useState('auth');
  const [pin, setPin]       = useState('');
  const [motivo, setMotivo] = useState('');
  const [anulando, setAnulando] = useState(false);
  const [errorAuth, setErrorAuth] = useState('');

  const verificarPin = async () => {
    if (!pin.trim()) { setErrorAuth('Ingresa tu PIN'); return; }
    if (!motivo.trim()) { setErrorAuth('El motivo es obligatorio'); return; }
    if (motivo.trim().length < 10) { setErrorAuth('Describe más el motivo (mínimo 10 caracteres)'); return; }
    setAnulando(true); setErrorAuth('');
    try {
      await onAnular(pin, motivo);
      setPaso('confirmado');
    } catch (e) {
      setErrorAuth(e.response?.data?.error || e.message || 'Error al anular');
    }
    setAnulando(false);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: paso === 'confirmado' ? 460 : 520 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>🚨 Anular Egreso Pagado</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>
          {paso === 'auth' ? (
            <>
              <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 13, color: '#991b1b' }}>
                🚨 <strong>ACCIÓN CRÍTICA:</strong> Al anular este egreso, se reversa el dinero a la caja {egreso.cajaId}. Esta acción queda en auditoría permanente.
              </div>
              <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>EGRESO A ANULAR:</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{egreso.numero} · {egreso.concepto}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626', marginTop: 4 }}>Monto: {fmt(egreso.totalPagar || egreso.monto)}</div>
              </div>
              {errorAuth && <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#991b1b', marginBottom: 12 }}>{errorAuth}</div>}
              <div style={S.field}>
                <label style={S.label}>PIN admin *</label>
                <input type="password" style={S.input} value={pin} onChange={e => setPin(e.target.value)} placeholder="0000" maxLength="4" onKeyDown={e => e.key === 'Enter' && verificarPin()} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Motivo de anulación *</label>
                <textarea style={{ ...S.input, height: 80, resize: 'vertical' }} value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Explica por qué se anula este egreso (mínimo 10 caracteres)..." />
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{motivo.length} caracteres</div>
              </div>
              <div style={S.modalFooter}>
                <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
                <button onClick={verificarPin} disabled={anulando}
                  style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#dc2626,#b91c1c)' }}>
                  {anulando ? 'Verificando...' : '🔐 Continuar →'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 10, padding: 16, textAlign: 'center', marginBottom: 20 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#166534' }}>Egreso anulado correctamente</div>
                <div style={{ fontSize: 12, color: '#4b5563', marginTop: 6 }}>
                  El monto {fmt(egreso.totalPagar || egreso.monto)} ha sido reversado a la caja.<br/>
                  La acción está registrada en auditoría.
                </div>
              </div>
              <div style={S.modalFooter}>
                <button onClick={onClose} style={S.btnPrimary}>Cerrar</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Modal Editar Pagado ──────────────────────────────────────────────────────
function ModalEditarPagado({ egreso, onSave, onClose }) {
  const [paso, setPaso]     = useState('auth');
  const [pwd, setPwd]       = useState('');
  const [motivo, setMotivo] = useState('');
  const [form, setForm]     = useState({ ...egreso });
  const [saving, setSaving] = useState(false);
  const [errorAuth, setErrorAuth] = useState('');
  const [verificando, setVerificando] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const verificarPassword = async () => {
    if (!pwd.trim()) { setErrorAuth('Ingresa tu contrasena'); return; }
    if (!motivo.trim()) { setErrorAuth('El motivo es obligatorio'); return; }
    setVerificando(true); setErrorAuth('');
    try {
      const token = localStorage.getItem('token');
      await axios.post(`${API}/users/verificar-password`,
        { password: pwd },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setPaso('editar');
    } catch (e) {
      setErrorAuth(e.response?.data?.error || 'Contrasena incorrecta');
    }
    setVerificando(false);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: paso === 'auth' ? 420 : 560 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>🔐 Editar Egreso Pagado</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>
          {paso === 'auth' ? (
            <>
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 13, color: '#991b1b' }}>
                🚨 Este egreso ya fue <strong>PAGADO</strong>. Editarlo requiere contraseña de administrador y queda en auditoría.
              </div>
              {errorAuth && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#991b1b', marginBottom: 12 }}>{errorAuth}</div>}
              <div style={S.field}>
                <label style={S.label}>Contraseña admin *</label>
                <input type="password" style={S.input} value={pwd} onChange={e => setPwd(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === 'Enter' && verificarPassword()} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Motivo de edición *</label>
                <textarea style={{ ...S.input, height: 72, resize: 'vertical' }} value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Explica por qué se edita este egreso..." />
              </div>
              <div style={S.modalFooter}>
                <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
                <button onClick={verificarPassword} disabled={verificando}
                  style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#dc2626,#b91c1c)' }}>
                  {verificando ? 'Verificando...' : 'Continuar →'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ background: '#fef3c7', borderRadius: 8, padding: 10, fontSize: 12, color: '#92400e', marginBottom: 14 }}>
                ✏️ Motivo: <strong>{motivo}</strong>
              </div>
              <div style={S.row2}>
                <div style={S.field}><label style={S.label}>Concepto</label><input style={S.input} value={form.concepto || ''} onChange={e => set('concepto', e.target.value)} /></div>
                <div style={S.field}><label style={S.label}>Monto</label><input type="number" style={S.input} value={form.monto || ''} onChange={e => set('monto', e.target.value)} /></div>
              </div>
              <div style={S.field}><label style={S.label}>Notas</label><textarea style={{ ...S.input, height: 56, resize: 'vertical' }} value={form.notas || ''} onChange={e => set('notas', e.target.value)} /></div>
              <div style={S.modalFooter}>
                <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
                <button onClick={async () => { setSaving(true); await onSave(form, motivo); setSaving(false); }} disabled={saving}
                  style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#dc2626,#b91c1c)' }}>
                  {saving ? 'Guardando...' : '🔐 Guardar con auditoría'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Imprimir comprobante ─────────────────────────────────────────────────────
const imprimirEgreso = (eg, empresa) => {
  const fmt2 = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
  const totalPagar = eg.totalPagar || Number(eg.monto) || 0;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Comprobante ${eg.numero}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: Arial, sans-serif; font-size: 11px; padding: 12mm; color: #333; max-width: 148mm; margin: 0 auto; }
    .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 12px; }
    .empresa-nombre { font-size: 15px; font-weight: bold; color: #1e1b4b; }
    .empresa-nit { font-size: 10px; color: #666; margin-top: 2px; }
    .title { font-size: 13px; font-weight: bold; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: 1px; }
    .numero { font-size: 18px; font-weight: 900; color: #4c1d95; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 12px 0; }
    .item { display: flex; flex-direction: column; gap: 2px; }
    .item-label { font-size: 9px; font-weight: 700; color: #999; text-transform: uppercase; }
    .item-value { font-size: 12px; color: #111; font-weight: 600; }
    .montos { margin: 14px 0; }
    .monto-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
    .monto-total { display: flex; justify-content: space-between; padding: 8px 0; font-size: 16px; font-weight: 900; border-top: 2px solid #4c1d95; color: #4c1d95; margin-top: 4px; }
    .estado { display: inline-block; padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 11px; }
    .firma { margin-top: 24px; display: flex; justify-content: space-between; }
    .firma-box { text-align: center; width: 45%; }
    .firma-linea { border-top: 1px solid #333; padding-top: 6px; margin-top: 32px; font-size: 10px; color: #666; }
    .footer { text-align: center; margin-top: 16px; padding-top: 10px; border-top: 1px dashed #ccc; font-size: 9px; color: #999; }
    @media print { body { padding: 8mm; } }
  </style></head><body>
  <div class="header">
    <div class="empresa-nombre">${empresa?.name || empresa?.nombre || 'EMPRESA'}</div>
    <div class="empresa-nit">NIT: ${empresa?.nit || '—'} | ${empresa?.address || ''}</div>
    <div class="title">Comprobante de Egreso</div>
    <div class="numero">${eg.numero || 'EGR-?'}</div>
  </div>
  <div style="text-align:center;margin-bottom:12px">
    <span class="estado" style="background:${eg.estado === 'PAGADO' ? '#dcfce7' : '#fef3c7'};color:${eg.estado === 'PAGADO' ? '#166534' : '#92400e'}">
      ${eg.estado === 'PAGADO' ? '✅ PAGADO' : '⏳ PENDIENTE'}
    </span>
  </div>
  <div class="grid">
    <div class="item"><span class="item-label">Fecha</span><span class="item-value">${new Date((eg.fecha || eg.createdAt) + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' })}</span></div>
    <div class="item"><span class="item-label">Categoría</span><span class="item-value">${eg.categoria || '—'}</span></div>
    <div class="item"><span class="item-label">Concepto</span><span class="item-value">${eg.concepto}</span></div>
    <div class="item"><span class="item-label">Proveedor</span><span class="item-value">${eg.proveedor || '—'}</span></div>
    <div class="item"><span class="item-label">Forma de pago</span><span class="item-value">${eg.formaPago || '—'}</span></div>
    <div class="item"><span class="item-label">N° Comprobante</span><span class="item-value">${eg.numero || '—'}</span></div>
  </div>
  <div class="montos">
    <div class="monto-row"><span>Valor base</span><span>${fmt2(eg.monto)}</span></div>
    ${eg.ivaVal > 0 ? `<div class="monto-row" style="color:#0284c7"><span>+ IVA (${eg.ivaPct}%)</span><span>${fmt2(eg.ivaVal)}</span></div>` : ''}
    ${eg.retenVal > 0 ? `<div class="monto-row" style="color:#7c3aed"><span>− Retención (${eg.retenPct}%)</span><span>(${fmt2(eg.retenVal)})</span></div>` : ''}
    <div class="monto-total"><span>TOTAL PAGADO</span><span>${fmt2(totalPagar)}</span></div>
  </div>
  ${eg.notas ? `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:8px;font-size:10px;margin-bottom:12px">📝 ${eg.notas}</div>` : ''}
  <div class="firma">
    <div class="firma-box"><div class="firma-linea">Elaborado por<br/>${eg.creadoPor || ''}</div></div>
    <div class="firma-box"><div class="firma-linea">Recibido por<br/>&nbsp;</div></div>
  </div>
  <div class="footer">Control360 · Sistema operativo para empresas de servicios<br/>Este comprobante es válido como soporte contable del egreso ${eg.numero}</div>
  </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 500);
};

// ─── Principal ────────────────────────────────────────────────────────────────
export default function GestionEgresos({ user }) {
  const isMobile = useIsMobile();
  const [egresos, setEgresos]     = useState([]);
  const [cajas, setCajas]         = useState([]);
  const [empresas, setEmpresas]   = useState([]);
  const [categorias, setCategorias] = useState(CATEGORIAS_DEFAULT);
  const [categoriasMeta, setCategoriasMeta] = useState([]);  // Ola 3: array de { nombre, tipoERI, lineaServicioId }
  const [formasPago, setFormasPago] = useState(FORMAS_PAGO_DEFAULT);
  const [formasPagoConfig, setFormasPagoConfig] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [modal, setModal]         = useState(null);
  const [selected, setSelected]   = useState(null);
  const [modalProvisional, setModalProvisional] = useState(false);
  const [mensajeros, setMensajeros] = useState([]);
  const [filtros, setFiltros]     = useState({ estado: 'todos', categoria: 'todos', busca: '', desde: '', hasta: '' });
  // Ola 2: pestañas + cuadre definitivo
  const [tab, setTab]                             = useState('todos');
  const [provisionalACuadrar, setProvisionalACuadrar] = useState(null);

  useEffect(() => { cargarDatos(); }, []);

  const getHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

  const cargarDatos = async () => {
    setLoading(true);
    try {
      const h = getHeaders();
      const [eRes, cRes, empRes, configRes, usersRes] = await Promise.all([
        axios.get(`${API}/egresos`, { headers: h }).catch(() => ({ data: [] })),
        axios.get(`${API}/cajas`, { headers: h }).catch(() => ({ data: [] })),
        axios.get(`${API}/companies`, { headers: h }).catch(() => ({ data: [] })),
        axios.get(`${API}/configuracion`, { headers: h }).catch(() => ({ data: {} })),
        axios.get(`${API}/users`, { headers: h }).catch(() => ({ data: [] })),
      ]);
      setEgresos(Array.isArray(eRes.data) ? eRes.data : []);
      setCajas(Array.isArray(cRes.data) ? cRes.data : []);
      setEmpresas(Array.isArray(empRes.data) ? empRes.data : []);
      setMensajeros((Array.isArray(usersRes.data) ? usersRes.data : []).filter(u => u.role === 'mensajero' && u.activo !== false));
      const catsActivas = (configRes.data?.categoriasEgresos || []).filter(c => c.activa);
      const cats = catsActivas.map(c => c.nombre);
      if (cats.length > 0) setCategorias(cats);
      // Ola 3: mapa categoría → tipoERI (para mostrar y guardar)
      setCategoriasMeta(catsActivas);
      const fps = (configRes.data?.formasPago || []).filter(f => f.activa).map(f => f.nombre);
      if (fps.length > 0) setFormasPago(fps);
      setFormasPagoConfig(configRes.data?.formasPago || []);
    } catch { }
    setLoading(false);
  };

  // Buscar empresa por caja
  const empresaDeCaja = (cajaId) => {
    const caja = cajas.find(c => c.id === cajaId);
    if (!caja) return empresas[0];
    return empresas.find(e => e.id === caja.empresaId) || empresas[0];
  };

  const crearEgreso = async (form) => {
    const nuevo = {
      ...form,
      numero: genId('EGR'),
      estado: form.pagarAhora ? 'PAGADO' : 'PENDIENTE',
      monto: Number(form.monto),
      totalPagar: form.totalPagar,
      ivaVal: form.ivaVal || 0,
      ivaPct: form.ivaPct || 0,
      retenVal: form.retenVal || 0,
      retenPct: form.retenPct || 0,
      creadoPor: user?.email || '',
    };
    try {
      const res = await axios.post(`${API}/egresos`, nuevo, { headers: getHeaders() });
      setEgresos(p => [{ ...nuevo, id: res.data?.id || 'local-' + Date.now() }, ...p]);
      if (res.data?.alertasMargen?.length > 0) {
        setModal(null);
        return res.data;
      }
    } catch {
      setEgresos(p => [{ id: 'local-' + Date.now(), ...nuevo, createdAt: new Date().toISOString() }, ...p]);
    }
    setModal(null);
    return {};
  };

  const editarEgreso = async (form) => {
    try {
      await axios.put(`${API}/egresos/${selected.id}`, { ...form, monto: Number(form.monto) }, { headers: getHeaders() });
      setEgresos(p => p.map(e => e.id === selected.id ? { ...e, ...form, monto: Number(form.monto) } : e));
      setModal(null); setSelected(null);
    } catch (e) {
      alert('No se pudo editar: ' + (e.response?.data?.error || e.message));
    }
  };

  const pagarEgreso = async ({ cajaId, formaPago }) => {
    const eg = selected;
    const totalPagar = eg.totalPagar || Number(eg.monto) || 0;
    // FIX BUG C: el backend define POST (no PUT) para /pagar. El PUT daba 404
    // silencioso (catch vacío) y el UI mostraba PAGADO falsamente. Ahora:
    // 1) Usamos POST (coincide con backend)
    // 2) Esperamos respuesta antes de actualizar UI
    // 3) Si falla, mostramos el error real
    try {
      await axios.post(`${API}/egresos/${eg.id}/pagar`, { cajaId, formaPago, totalPagar }, { headers: getHeaders() });
      setEgresos(p => p.map(e => e.id === eg.id ? { ...e, estado: 'PAGADO', cajaId, formaPago, pagadoEn: new Date().toISOString() } : e));
      setCajas(p => p.map(c => c.id === cajaId ? { ...c, saldo: (c.saldo || 0) - totalPagar } : c));
      setModal(null); setSelected(null);
    } catch (e) {
      alert('No se pudo pagar el egreso: ' + (e.response?.data?.error || e.message));
    }
  };

  const editarPagado = async (form, motivo) => {
    const update = { ...form, monto: Number(form.monto), motivoEdicion: motivo, editadoPor: user?.email };
    // FIX: el backend define POST (no PUT) para /editar-pagado. Mismo bug
    // que pagarEgreso. Ahora espera respuesta, si falla muestra error.
    try {
      await axios.post(`${API}/egresos/${selected.id}/editar-pagado`, update, { headers: getHeaders() });
      setEgresos(p => p.map(e => e.id === selected.id ? { ...e, ...update } : e));
      setModal(null); setSelected(null);
    } catch (e) {
      alert('No se pudo editar el egreso: ' + (e.response?.data?.error || e.message));
    }
  };

  const anularEgreso = async (pin, motivo) => {
    try {
      const totalMonto = selected.totalPagar || selected.monto;
      await axios.post(`${API}/egresos/${selected.id}/anular`, { pin, motivo }, { headers: getHeaders() });
      // Actualizar estado a ANULADO y reversar dinero a caja
      setEgresos(p => p.map(e => e.id === selected.id ? { ...e, estado: 'ANULADO', motvoAnulacion: motivo, anuladoEn: new Date().toISOString() } : e));
      setCajas(p => p.map(c => c.id === selected.cajaId ? { ...c, saldo: (c.saldo || 0) + Number(totalMonto) } : c));
      setModal(null); setSelected(null);
    } catch (e) {
      throw e; // Propagar error para que el modal lo muestre
    }
  };

  const egresosFiltered = egresos.filter(e => {
    if (filtros.estado !== 'todos' && e.estado !== filtros.estado) return false;
    if (filtros.categoria !== 'todos' && e.categoria !== filtros.categoria) return false;
    if (filtros.busca && !e.concepto?.toLowerCase().includes(filtros.busca.toLowerCase()) && !e.proveedor?.toLowerCase().includes(filtros.busca.toLowerCase())) return false;
    if (filtros.desde && e.fecha && e.fecha < filtros.desde) return false;
    if (filtros.hasta && e.fecha && e.fecha > filtros.hasta) return false;
    return true;
  });

  const totalPendiente = egresosFiltered.filter(e => e.estado === 'PENDIENTE').reduce((a, e) => {
    const total = e.totalPagar || Number(e.monto) || 0;
    const pagado = Number(e.montoPagado) || 0;
    return a + Math.max(0, total - pagado);
  }, 0);
  const totalPagado = egresosFiltered.filter(e => e.estado === 'PAGADO').reduce((a, e) => a + (e.totalPagar || Number(e.monto) || 0), 0);
  const totalIvaDescontable = egresosFiltered.filter(e => e.estado === 'PAGADO').reduce((a, e) => a + (Number(e.ivaVal) || 0), 0);
  const totalRetenciones = egresosFiltered.filter(e => e.estado === 'PAGADO').reduce((a, e) => a + (Number(e.retenVal) || 0), 0);

  const setF = (k, v) => setFiltros(f => ({ ...f, [k]: v }));

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>⏳ Cargando egresos...</div>;

  return (
    <div style={S.page}>
      <div style={S.pageHeader}>
        <div>
          <h2 style={S.pageTitle}>📤 Egresos</h2>
          <p style={S.pageSubtitle}>Gastos operativos · IVA descontable · Retenciones · Auditoría</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => exportarExcel(egresosFiltered, [
            { key: 'numero', label: 'N°' }, { key: 'fecha', label: 'Fecha' },
            { key: 'concepto', label: 'Concepto' }, { key: 'proveedor', label: 'Proveedor' },
            { key: 'categoria', label: 'Categoría' }, { key: 'formaPago', label: 'Forma Pago' },
            { key: 'monto', label: 'Base' }, { key: 'ivaPct', label: 'IVA %' },
            { key: 'ivaVal', label: 'IVA $' }, { key: 'retenPct', label: 'Ret %' },
            { key: 'retenVal', label: 'Ret $' }, { key: 'totalPagar', label: 'Total pagado' },
            { key: 'estado', label: 'Estado' },
          ], 'egresos')} style={{ ...S.btnSecondary, fontSize: 12 }}>
            📥 Exportar Excel
          </button>
          {mensajeros.length > 0 && (
            <button onClick={() => setModalProvisional(true)} style={{ ...S.btnSecondary, fontSize: 12, background: '#fffbeb', color: '#d97706', border: '1px solid #fcd34d' }}>
              💵 Egreso provisional
            </button>
          )}
          <button onClick={() => { setSelected(null); setModal('nuevo'); }} style={S.btnPrimary}>+ Nuevo egreso</button>
        </div>
      </div>

      {/* ── Pestañas (Ola 2) ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e5e7eb' }}>
        <button onClick={() => setTab('todos')}
          style={{
            padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: 600,
            color: tab === 'todos' ? '#7c3aed' : '#6b7280',
            borderBottom: tab === 'todos' ? '2px solid #7c3aed' : '2px solid transparent',
            marginBottom: -2
          }}>
          📤 Todos los egresos
        </button>
        <button onClick={() => setTab('provisionales')}
          style={{
            padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: 600,
            color: tab === 'provisionales' ? '#d97706' : '#6b7280',
            borderBottom: tab === 'provisionales' ? '2px solid #d97706' : '2px solid transparent',
            marginBottom: -2,
            display: 'flex', alignItems: 'center', gap: 6
          }}>
          💵 Provisionales pendientes
          {(() => {
            const pend = egresos.filter(e => e.tipo === 'provisional' && e.cuadrado === false).length;
            return pend > 0 ? <span style={{ background: '#d97706', color: '#fff', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>{pend}</span> : null;
          })()}
        </button>
      </div>

      {/* ── VISTA PROVISIONALES (Ola 2) ──────────────────────────────────────── */}
      {tab === 'provisionales' && (() => {
        const provisionales = egresos
          .filter(e => e.tipo === 'provisional' && e.cuadrado === false)
          .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        return (
          <div>
            <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', padding: '14px 18px', borderRadius: 10, marginBottom: 16, fontSize: 13, color: '#92400e' }}>
              <strong>¿Qué son los egresos provisionales?</strong> Cuando un mensajero sale a hacer un mandado de Orden Interna (compra de insumos, gastos varios) le entregas un valor estimado. Al regresar con la factura real y el vuelto, cuadras aquí el egreso definitivo. La Orden Interna no se puede cerrar sin el cuadre completo.
            </div>

            {provisionales.length === 0 ? (
              <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', color: '#9ca3af' }}>
                <div style={{ fontSize: 48, marginBottom: 10 }}>✅</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>No hay egresos provisionales pendientes</div>
                <div style={{ fontSize: 13, marginTop: 6 }}>Todos los mandados han sido cuadrados.</div>
              </div>
            ) : (
              <div style={{ background: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Fecha', 'N° Egreso', 'OI', 'Mensajero', 'Concepto', 'Entregado', 'Caja', 'Acción'].map(h =>
                        <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {provisionales.map((eg, i) => (
                      <tr key={eg.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa', borderTop: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '12px 16px', fontSize: 13 }}>{fmtDate(eg.createdAt?.seconds ? new Date(eg.createdAt.seconds * 1000).toISOString() : eg.fecha)}</td>
                        <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: '#d97706' }}>{eg.numero}</td>
                        <td style={{ padding: '12px 16px', fontSize: 13, fontFamily: 'monospace' }}>{eg.numeroOrdenInterna || '—'}</td>
                        <td style={{ padding: '12px 16px', fontSize: 13 }}>{eg.mensajeroNombre || '—'}</td>
                        <td style={{ padding: '12px 16px', fontSize: 13 }}>{eg.concepto}</td>
                        <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700 }}>{fmt(eg.monto)}</td>
                        <td style={{ padding: '12px 16px', fontSize: 12, color: '#6b7280' }}>
                          {cajas.find(c => c.id === eg.cajaId)?.nombre || '—'}
                        </td>
                        <td style={{ padding: '12px 16px' }}>
                          <button onClick={() => setProvisionalACuadrar(eg)}
                            style={{ padding: '6px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                            ✓ Cuadrar definitivo
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── VISTA NORMAL: TODOS LOS EGRESOS ──────────────────────────────────── */}
      {tab === 'todos' && <>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        <div style={{ ...S.kpiCard, borderLeft: '4px solid #f59e0b' }}>
          <div style={S.kpiLabel}>⏳ Pendiente pago</div>
          <div style={{ ...S.kpiValue, color: '#d97706' }}>{fmt(totalPendiente)}</div>
          <div style={S.kpiSub}>{egresosFiltered.filter(e => e.estado === 'PENDIENTE').length} egreso(s)</div>
        </div>
        <div style={{ ...S.kpiCard, borderLeft: '4px solid #22c55e' }}>
          <div style={S.kpiLabel}>✅ Pagado</div>
          <div style={{ ...S.kpiValue, color: '#16a34a' }}>{fmt(totalPagado)}</div>
          <div style={S.kpiSub}>{egresosFiltered.filter(e => e.estado === 'PAGADO').length} egreso(s)</div>
        </div>
        <div style={{ ...S.kpiCard, borderLeft: '4px solid #0284c7' }}>
          <div style={S.kpiLabel}>🔵 IVA descontable</div>
          <div style={{ ...S.kpiValue, color: '#0284c7' }}>{fmt(totalIvaDescontable)}</div>
          <div style={S.kpiSub}>Del período filtrado</div>
        </div>
        <div style={{ ...S.kpiCard, borderLeft: '4px solid #7c3aed' }}>
          <div style={S.kpiLabel}>🟣 Retenciones practicadas</div>
          <div style={{ ...S.kpiValue, color: '#7c3aed' }}>{fmt(totalRetenciones)}</div>
          <div style={S.kpiSub}>CXP Retefuente</div>
        </div>
      </div>

      {/* Filtros */}
      <div style={S.filtrosRow}>
        <input style={{ ...S.input, maxWidth: 240 }} placeholder="🔍 Concepto / proveedor" value={filtros.busca} onChange={e => setF('busca', e.target.value)} />
        <select style={{ ...S.select, maxWidth: 160 }} value={filtros.estado} onChange={e => setF('estado', e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="PENDIENTE">Pendiente</option>
          <option value="PAGADO">Pagado</option>
        </select>
        <select style={{ ...S.select, maxWidth: 180 }} value={filtros.categoria} onChange={e => setF('categoria', e.target.value)}>
          <option value="todos">Todas las categorías</option>
          {categorias.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="date" style={{ ...S.input, maxWidth: 150 }} value={filtros.desde} onChange={e => setF('desde', e.target.value)} title="Desde" />
        <input type="date" style={{ ...S.input, maxWidth: 150 }} value={filtros.hasta} onChange={e => setF('hasta', e.target.value)} title="Hasta" />
        {(filtros.desde || filtros.hasta || filtros.busca || filtros.estado !== 'todos' || filtros.categoria !== 'todos') && (
          <button onClick={() => setFiltros({ estado: 'todos', categoria: 'todos', busca: '', desde: '', hasta: '' })}
            style={{ padding: '8px 14px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>✕ Limpiar</button>
        )}
      </div>

      {/* Tabla / Tarjetas */}
      {isMobile ? (
        /* ── MÓVIL: tarjetas ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {egresosFiltered.length === 0 && (
            <div style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>No hay egresos con los filtros seleccionados</div>
          )}
          {egresosFiltered.map(eg => {
            const esPagado = eg.estado === 'PAGADO';
            return (
              <div key={eg.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 14, borderLeft: `4px solid ${esPagado ? '#22c55e' : '#f59e0b'}` }}>
                {/* Cabecera: número + estado */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={S.badge}>{eg.numero || 'EGR-?'}</span>
                  <span style={{ ...S.estadoBadge, background: esPagado ? '#dcfce7' : '#fef3c7', color: esPagado ? '#166534' : '#92400e', border: `1px solid ${esPagado ? '#bbf7d0' : '#fde68a'}` }}>
                    {esPagado ? '✅ PAGADO' : '⏳ PENDIENTE'}
                  </span>
                </div>
                {/* Concepto */}
                <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b', marginBottom: 2 }}>{eg.concepto}</div>
                {eg.proveedor && <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{eg.proveedor}</div>}
                {/* Categoría + Fecha */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span style={S.tag}>{eg.categoria}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>📅 {fmtDate(eg.fecha || eg.createdAt)}</span>
                </div>
                {/* Montos */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
                  <div style={{ background: '#f8fafc', borderRadius: 6, padding: '6px 8px' }}>
                    <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>BASE</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{fmt(eg.monto)}</div>
                  </div>
                  <div style={{ background: '#f8fafc', borderRadius: 6, padding: '6px 8px' }}>
                    <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>TOTAL</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: '#1e293b' }}>{fmt(eg.totalPagar || eg.monto)}</div>
                  </div>
                  {eg.ivaVal > 0 && (
                    <div style={{ background: '#eff6ff', borderRadius: 6, padding: '6px 8px' }}>
                      <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>IVA</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#0284c7' }}>{fmt(eg.ivaVal)}</div>
                    </div>
                  )}
                  {eg.retenVal > 0 && (
                    <div style={{ background: '#faf5ff', borderRadius: 6, padding: '6px 8px' }}>
                      <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>RETENCIÓN</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed' }}>{fmt(eg.retenVal)}</div>
                    </div>
                  )}
                </div>
                {/* Acciones */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {eg.estado === 'PENDIENTE' && <>
                    <button onClick={() => { setSelected(eg); setModal('editar'); }} style={{ ...S.actionBtn, flex: 1 }}>✏️ Editar</button>
                    <button onClick={() => { setSelected(eg); setModal('pagar'); }} style={{ ...S.actionBtn, flex: 1, background: '#dcfce7', color: '#166534' }}>💳 Pagar</button>
                  </>}
                  {esPagado && user?.role === 'admin' && (
                    <button onClick={() => { setSelected(eg); setModal('editarPagado'); }} style={{ ...S.actionBtn, background: '#fee2e2', color: '#991b1b' }}>🔐 Editar</button>
                  )}
                  <button onClick={() => imprimirEgreso(eg, empresaDeCaja(eg.cajaId))} style={S.actionBtn} title="Imprimir">🖨️</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── DESKTOP: tabla ── */
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr style={S.thead}>
                {['N°', 'Concepto', 'Proveedor', 'Categoría', 'Fecha', 'Base', 'IVA', 'Retención', 'Total', 'Estado', 'Acciones'].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {egresosFiltered.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>No hay egresos con los filtros seleccionados</td></tr>
              )}
              {egresosFiltered.map(eg => (
                <tr key={eg.id} style={S.tr}>
                  <td style={S.td}><span style={S.badge}>{eg.numero || 'EGR-?'}</span></td>
                  <td style={S.td}><div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{eg.concepto}</div></td>
                  <td style={S.td}><span style={{ fontSize: 13, color: '#475569' }}>{eg.proveedor || '—'}</span></td>
                  <td style={S.td}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                      <span style={S.tag}>{eg.categoria}</span>
                      {(() => {
                        const meta = categoriasMeta.find(c => c.nombre === eg.categoria);
                        if (!meta) return null;
                        const tipo = meta.tipoERI || 'gasto_operativo';
                        const labels = {
                          'costo_servicio':       { l: '💰 Costo servicio', bg: '#fef3c7', c: '#92400e' },
                          'gasto_personal':       { l: '👥 Personal',        bg: '#fce7f3', c: '#9f1239' },
                          'gasto_operativo':      { l: '⚙️ Operativo',       bg: '#e0e7ff', c: '#3730a3' },
                          'gasto_fijo':           { l: '🏠 Fijo',            bg: '#dbeafe', c: '#1e40af' },
                          'gasto_administrativo': { l: '📋 Administrativo',  bg: '#f3e8ff', c: '#6b21a8' },
                          'gasto_financiero':     { l: '🏦 Financiero',      bg: '#fee2e2', c: '#991b1b' },
                          'gasto_fiscal':         { l: '📑 Fiscal',          bg: '#fef2f2', c: '#dc2626' },
                        };
                        const cfg = labels[tipo] || labels['gasto_operativo'];
                        return <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 6, background: cfg.bg, color: cfg.c }}>{cfg.l}</span>;
                      })()}
                    </div>
                  </td>
                  <td style={S.td}><span style={{ fontSize: 12, color: '#64748b' }}>{fmtDate(eg.fecha || eg.createdAt)}</span></td>
                  <td style={S.td}><span style={{ fontSize: 13 }}>{fmt(eg.monto)}</span></td>
                  <td style={S.td}>{eg.ivaVal > 0 ? <span style={{ fontSize: 12, color: '#0284c7', fontWeight: 600 }}>{fmt(eg.ivaVal)}</span> : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                  <td style={S.td}>{eg.retenVal > 0 ? <span style={{ fontSize: 12, color: '#7c3aed', fontWeight: 600 }}>{fmt(eg.retenVal)}</span> : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                  <td style={{ ...S.td, fontWeight: 700, color: '#1e293b', fontSize: 14 }}>{fmt(eg.totalPagar || eg.monto)}</td>
                  <td style={S.td}>
                    <span style={{ ...S.estadoBadge, background: eg.estado === 'PAGADO' ? '#dcfce7' : eg.estado === 'ANULADO' ? '#f3f4f6' : '#fef3c7', color: eg.estado === 'PAGADO' ? '#166534' : eg.estado === 'ANULADO' ? '#6b7280' : '#92400e', border: `1px solid ${eg.estado === 'PAGADO' ? '#bbf7d0' : eg.estado === 'ANULADO' ? '#d1d5db' : '#fde68a'}` }}>
                      {eg.estado === 'PAGADO' ? '✅ PAGADO' : eg.estado === 'ANULADO' ? '❌ ANULADO' : '⏳ PENDIENTE'}
                    </span>
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    {eg.estado === 'PENDIENTE' && <>
                      <button onClick={() => { setSelected(eg); setModal('editar'); }} style={S.actionBtn}>✏️</button>
                      <button onClick={() => { setSelected(eg); setModal('pagar'); }} style={{ ...S.actionBtn, background: '#dcfce7', color: '#166534' }}>💳 Pagar</button>
                    </>}
                    {eg.estado === 'PAGADO' && user?.role === 'admin' && (
                      <>
                        <button onClick={() => { setSelected(eg); setModal('editarPagado'); }} style={{ ...S.actionBtn, background: '#fee2e2', color: '#991b1b' }}>✏️ Editar</button>
                        <button onClick={() => { setSelected(eg); setModal('anular'); }} style={{ ...S.actionBtn, background: '#fecaca', color: '#7f1d1d', fontWeight: 700 }}>🚨 Anular</button>
                      </>
                    )}
                    <button onClick={() => imprimirEgreso(eg, empresaDeCaja(eg.cajaId))} style={S.actionBtn} title="Imprimir">🖨️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>}
      {/* ── Fin vista normal ─────────────────────────────────────────────── */}

      {modal === 'nuevo' && <ModalEgreso empresas={empresas} cajas={cajas} formasPago={formasPago} formasPagoConfig={formasPagoConfig} categoriasList={categorias} onSave={crearEgreso} onClose={() => setModal(null)} />}
      {modal === 'editar' && selected && <ModalEgreso egreso={{ ...selected, _categorias: categorias }} empresas={empresas} cajas={cajas} formasPago={formasPago} formasPagoConfig={formasPagoConfig} categoriasList={categorias} onSave={editarEgreso} onClose={() => { setModal(null); setSelected(null); }} />}
      {modal === 'pagar' && selected && <ModalPagar egreso={selected} cajas={cajas} formasPago={formasPago} formasPagoConfig={formasPagoConfig} onPagar={pagarEgreso} onClose={() => { setModal(null); setSelected(null); }} />}
      {modal === 'editarPagado' && selected && <ModalEditarPagado egreso={selected} onSave={editarPagado} onClose={() => { setModal(null); setSelected(null); }} />}
      {modal === 'anular' && selected && <ModalAnularEgreso egreso={selected} onAnular={anularEgreso} onClose={() => { setModal(null); setSelected(null); }} />}
      {modalProvisional && <EgresoProvisional mensajeros={mensajeros} cajas={cajas} formasPagoConfig={formasPagoConfig} onCrear={async (data) => { await crearEgreso(data); setModalProvisional(false); }} onCerrar={() => setModalProvisional(false)} />}

      {/* Ola 2: modal de cuadre provisional → definitivo */}
      {provisionalACuadrar && (
        <ModalCuadrarDefinitivo
          provisional={provisionalACuadrar}
          cajas={cajas}
          onCuadrado={async () => { setProvisionalACuadrar(null); await cargarDatos(); }}
          onCerrar={() => setProvisionalACuadrar(null)}
        />
      )}
    </div>
  );
}

const S = {
  page: { padding: '24px 32px', maxWidth: 1400, margin: '0 auto' },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  pageTitle: { margin: 0, fontSize: 26, fontWeight: 800, color: '#1e293b' },
  pageSubtitle: { margin: '4px 0 0', fontSize: 13, color: '#64748b' },
  kpiCard: { background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  kpiLabel: { fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 6 },
  kpiValue: { fontSize: 22, fontWeight: 800 },
  kpiSub: { fontSize: 11, color: '#94a3b8', marginTop: 4 },
  filtrosRow: { display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' },
  tableWrap: { background: '#fff', borderRadius: 14, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' },
  thead: { background: '#f8fafc' },
  th: { padding: '12px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e2e8f0' },
  tr: { borderBottom: '1px solid #f1f5f9' },
  td: { padding: '11px 12px', verticalAlign: 'middle' },
  badge: { background: '#ede9fe', color: '#6d28d9', borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700 },
  tag: { background: '#f1f5f9', color: '#475569', borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 600 },
  estadoBadge: { borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 700 },
  actionBtn: { padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#f1f5f9', color: '#475569', marginRight: 4 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal: { background: '#fff', borderRadius: 16, maxWidth: 580, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxHeight: '92vh', overflowY: 'auto' },
  modalHeader: { padding: '20px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' },
  closeBtn: { background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8', padding: 4 },
  modalBody: { padding: '16px 24px' },
  modalFooter: { padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: 700, color: '#374151' },
  input: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  select: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  btnPrimary: { padding: '10px 20px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnSecondary: { padding: '10px 20px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};

