import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { exportarExcel } from './exportExcel';
// ✅ EGRESO-VISUAL-001 · EGRESO-INTELIGENTE-001 · EGRESO-RECLASIFICAR-001
import EgresosGraficas from './EgresosGraficas';
import { validarEgreso, norm as normTxt } from './utils/validacionEgresos';

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
// ✅ EGRESO-NUM-002: eliminado genId(). El frontend pintaba un consecutivo
// ALEATORIO (ej. EGR-5325) que nunca se guardaba: el backend genera el número
// real de forma atómica en counters/{userId}_egresos (ej. EGR-0012). Al
// refrescar aparecía el correcto y parecía un bug de consecutivo. Ahora el
// número lo manda siempre el backend en la respuesta.

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
  // ✅ EGRESO-PROV-001: OI opcional — un anticipo puede ser una vuelta suelta
  const [numeroOrdenInterna, setOI]   = useState('');
  const [guardando, setGuardando]     = useState(false);
  const [error, setError]             = useState('');

  const guardar = async () => {
    if (!mensajeroId || !concepto || !monto || !cajaId) return setError('Mensajero, concepto, monto y caja son requeridos');
    setGuardando(true);
    // ✅ EGRESO-PROV-001: antes solo se enviaba mensajeroId/concepto/monto/cajaId.
    // Faltaban mensajeroNombre (la columna salía "—") y formaPago. La caja se
    // resuelve por su forma de pago configurada para que el movimiento cuadre.
    const cajaSel  = (cajas || []).find(c => c.id === cajaId);
    const confPago = (formasPagoConfig || []).find(f => f.cajaId === cajaId);
    await onCrear({
      mensajeroId,
      mensajeroNombre: (mensajeros || []).find(m => m.id === mensajeroId)?.nombre || '',
      concepto,
      monto: Number(monto),
      totalPagar: Number(monto),
      cajaId,
      formaPago: confPago?.nombre || cajaSel?.nombre || 'Efectivo',
      numeroOrdenInterna: numeroOrdenInterna.trim(),
      tipo: 'provisional',
      cuadrado: false
    });
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
          <div style={S.field}>
            <label style={S.label}>Orden Interna (opcional)</label>
            <input style={S.input} placeholder="Ej: OS-0475 — dejar vacío si es una vuelta suelta"
              value={numeroOrdenInterna} onChange={e => setOI(e.target.value)} />
          </div>
          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: 10, fontSize: 12, color: '#92400e' }}>
            💡 Esto es un <strong>anticipo</strong>, no un gasto: la plata sale de caja ya, pero no cuenta
            en el ERI ni en la utilidad. Cuando el mensajero traiga la factura, registra el egreso normal
            (con IVA y retención) y elige <strong>"Legalizar comprobante provisional"</strong>.
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
function ModalEgreso({ egreso, empresas, cajas, formasPago, formasPagoConfig, categoriasList, provisionales, provisionalInicial, onSave, onClose, categoriasMeta = [], vehiculos = [], egresosRecientes = [], empleados = [], onNavegar }) {
  const [form, setForm] = useState({
    concepto: '', proveedor: '', categoria: (categoriasList || CATEGORIAS_DEFAULT)[0],
    monto: '', ivaPct: 0, retenPct: 0, retenManual: '',
    formaPago: '', cajaId: '', cajaLabel: '',
    pagarAhora: false, notas: '',
    // ✅ EGRESO-PROV-001: legalización de un anticipo entregado al mensajero
    provisionalId: provisionalInicial?.id || '', pinLegal: '',
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

  // ✅ EGRESO-VEHICULO-001: el selector de placa solo aparece cuando la
  // categoría corresponde a un gasto de vehículo. Se evalúa sobre el texto
  // normalizado para que funcione con las categorías que el usuario creó a
  // mano ("fletes", "gasolina", "Transporte / Combustible"...).
  const esGastoDeVehiculo = useMemo(
    () => /combustible|gasolina|acpm|diesel|transporte|vehiculo|peaje|parqueadero|flete|llanta|lavado|soat|tecnomecanic|mantenimiento/
      .test(normTxt(form.categoria)),
    [form.categoria]
  );

  // ✅ NOMINA-PROVISIONES-001: detecta si la categoría elegida es de personal,
  // para avisar que la nómina se digita en su propio módulo. Se apoya en
  // tipoERI (el dato bueno) y cae a heurística de nombre si la categoría fue
  // creada a mano sin clasificación contable.
  const esCategoriaDePersonal = useMemo(() => {
    if (!form.categoria) return false;
    const meta = categoriasMeta.find(c => normTxt(c.nombre) === normTxt(form.categoria));
    if (meta?.tipoERI === 'gasto_personal') return true;
    return /nomina|salario|sueldo|quincena|prestacion(?!es de servicio)|cesantia|prima|liquidacion/
      .test(normTxt(form.categoria));
  }, [form.categoria, categoriasMeta]);

  // ═══════════════════════════════════════════════════════════════════════════
  // ✅ NOMINA-PROVISIONES-001 — Detección de empleado en el tercero
  // ─────────────────────────────────────────────────────────────────────────
  // Si el proveedor o el concepto coinciden con un empleado registrado, el
  // sistema lo detecta y ofrece marcar el egreso como ANTICIPO DE NÓMINA.
  //
  // Es la inteligencia que evita el problema de julio 2026: pagos al mismo
  // empleado quedaban unos en "Nómina" y otros en "anticipos de nomina",
  // y ninguno se cruzaba contra la liquidación. Al enlazarlo acá, el anticipo
  // se descuenta automáticamente en el comprobante de nómina del período.
  // ═══════════════════════════════════════════════════════════════════════════
  const empleadoDetectado = useMemo(() => {
    if (form.esComprobanteNomina) return null;
    const texto = `${normTxt(form.proveedor)} ${normTxt(form.concepto)}`;
    if (texto.trim().length < 5) return null;
    return (empleados || []).find(emp => {
      const n = normTxt(emp.nombre);
      return n.length >= 5 && texto.includes(n);
    }) || null;
  }, [form.proveedor, form.concepto, form.esComprobanteNomina, empleados]);

  // Al detectar el empleado, se preselecciona para que el usuario solo tenga
  // que confirmar si es o no un anticipo.
  useEffect(() => {
    if (empleadoDetectado && !form.empleadoId) {
      setForm(f => ({
        ...f,
        empleadoId: empleadoDetectado.id,
        empleadoNombre: empleadoDetectado.nombre,
        empleadoDocumento: empleadoDetectado.documento
      }));
    }
  }, [empleadoDetectado]);

  // ✅ EGRESO-INTELIGENTE-001: validación en vivo, mientras se digita.
  // Es la misma función que corre el backend al guardar, así que lo que la
  // persona ve es exactamente lo que el sistema va a registrar.
  const alertasDigitacion = useMemo(() => {
    if (!form.categoria && !form.monto) return [];
    const meta = categoriasMeta.find(c => normTxt(c.nombre) === normTxt(form.categoria)) || null;
    const base = Number(form.monto) || 0;
    const ivaCalc = Math.round(base * (Number(form.ivaPct) || 0) / 100);
    const retenCalc = Math.round(base * (Number(form.retenPct) || 0) / 100);
    return validarEgreso(
      {
        ...form,
        monto: base,
        ivaVal: ivaCalc,
        retenVal: retenCalc,
        totalPagar: base + ivaCalc - retenCalc,
        productosCompra
      },
      {
        categoriaMeta: meta,
        categoriasValidas: categoriasList || [],
        egresosRecientes,
        empleados
      }
    ).alertas;
  }, [form, categoriasMeta, categoriasList, egresosRecientes, productosCompra, empleados]);

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

  // ══════════════════════════════════════════════════════════════════════════
  // ✅ EGRESO-PROV-001 — LEGALIZAR COMPROBANTE PROVISIONAL
  // El anticipo ya sacó la plata de caja. Al legalizar, este egreso queda como
  // el gasto real (con IVA y retención) y a caja solo se mueve la DIFERENCIA.
  // ══════════════════════════════════════════════════════════════════════════
  const listaProv    = (provisionales || []).filter(p => p.legalizado !== true && p.anulado !== true);
  const provSel      = listaProv.find(p => p.id === form.provisionalId) || null;
  const esLegalizar  = !!form.provisionalId;
  const baseAnticipo = provSel ? (Number(provSel.totalPagar || provSel.monto) || 0) : 0;
  const diferenciaLegal = baseAnticipo - totalPagar; // >0 vuelto · <0 falta

  const activarLegalizacion = (id) => {
    setForm(f => {
      const prov = listaProv.find(p => p.id === id);
      return {
        ...f,
        provisionalId: id,
        pagarAhora: false,
        formaPago: id ? 'Legaliza anticipo' : '',
        cajaId:    id ? (prov?.cajaId || f.cajaId) : '',
        cajaLabel: id ? ((cajas || []).find(c => c.id === prov?.cajaId)?.nombre || '') : ''
      };
    });
  };

  const handleSubmit = async () => {
    if (!form.concepto.trim()) return alert('El concepto es requerido');
    // ✅ EGRESO-PROV-001: la legalización mueve plata en caja → exige PIN
    if (esLegalizar) {
      if (!/^\d{4}$/.test(String(form.pinLegal || ''))) return alert('El PIN debe ser de 4 dígitos');
      if (!form.cajaId) return alert('Selecciona la caja donde se ajusta la diferencia');
    }
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
      // ✅ EGRESO-PROV-001: el backend espera `pin` (no `pinLegal`)
      provisionalId: form.provisionalId || undefined,
      pin: esLegalizar ? form.pinLegal : undefined,
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
              <label style={S.label}>Fecha del pago *</label>
              <input type="date" style={S.input} value={form.fecha} onChange={e => set('fecha', e.target.value)} />
            </div>
          </div>

          {/* ═══════════════════════════════════════════════════════════════════
              ✅ CAUSACION-001 — ¿A qué mes corresponde este gasto?
              ───────────────────────────────────────────────────────────────
              Un gasto pertenece al mes en que ocurrió el hecho economico, no
              al mes en que sale la plata. Si la mensajeria de julio se paga en
              agosto, es costo de JULIO: si no, julio queda con margen inflado
              y agosto carga un costo que no le toca.

              Se muestra solo si el usuario lo pide, porque en la mayoria de
              los casos las dos fechas son la misma.
              ═════════════════════════════════════════════════════════════ */}
          <div style={{ marginBottom: 14 }}>
            {!form._otroPeriodo && (!form.fechaCausacion || form.fechaCausacion === form.fecha) ? (
              <button type="button"
                onClick={() => { set('_otroPeriodo', true); set('fechaCausacion', form.fecha); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontSize: 12, color: '#6366f1', fontWeight: 600, textDecoration: 'underline'
                }}>
                Este gasto corresponde a otro mes
              </button>
            ) : (
              <div style={{
                background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 11, padding: 13
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: '#1e40af', marginBottom: 6 }}>
                  📅 ¿A qué mes corresponde este gasto?
                </div>
                <div style={{ fontSize: 11.5, color: '#1e40af', lineHeight: 1.6, marginBottom: 10 }}>
                  El <strong>estado de resultados</strong> lo va a contar en esta fecha, y el
                  <strong> flujo de efectivo</strong> en la fecha del pago. Sirve para un servicio
                  prestado en un mes y pagado al siguiente.
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div style={{ ...S.field, marginBottom: 0 }}>
                    <label style={{ ...S.label, fontSize: 11 }}>Fecha de causación</label>
                    <input type="date" style={S.input}
                      value={form.fechaCausacion || form.fecha}
                      onChange={e => set('fechaCausacion', e.target.value)} />
                  </div>
                  <button type="button"
                    onClick={() => { set('_otroPeriodo', false); set('fechaCausacion', ''); }}
                    style={{ ...S.btnSecondary, padding: '9px 14px', fontSize: 12 }}>
                    Usar la misma fecha
                  </button>
                </div>
                {form.fechaCausacion && form.fechaCausacion !== form.fecha && (
                  <div style={{ fontSize: 11, color: '#1e40af', marginTop: 9, background: '#fff', borderRadius: 7, padding: '7px 10px' }}>
                    Va al estado de resultados de <strong>{String(form.fechaCausacion).slice(0, 7)}</strong> y
                    sale de caja en <strong>{String(form.fecha).slice(0, 7)}</strong>.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ═══════════════════════════════════════════════════════════════════
              ✅ NOMINA-PROVISIONES-001 — Desvío al módulo de nómina
              ───────────────────────────────────────────────────────────────
              PROBLEMA QUE RESUELVE
              Un pago de nómina registrado como egreso simple pierde todo:
              no calcula horas extras, no separa el auxilio de transporte, no
              aplica las deducciones de ley, no cruza los anticipos del período
              y no causa las prestaciones sociales. Es exactamente como se
              venía haciendo, y es lo que dejó $2,2 millones mensuales fuera
              del estado de resultados.

              Como el digitador no tiene por qué saber que el flujo cambió, el
              sistema se lo dice en el momento en que elige la categoría.
              No bloquea: hay pagos de personal que SÍ van acá (PILA,
              parafiscales, liquidaciones puntuales).
              ═════════════════════════════════════════════════════════════ */}
          {esCategoriaDePersonal && !form.esAnticipoNomina && !egreso && (
            <div style={{
              background: 'linear-gradient(135deg,#eef2ff,#faf5ff)',
              border: '2px solid #c7d2fe', borderRadius: 12, padding: 15, marginBottom: 14
            }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#312e81', marginBottom: 7 }}>
                🧾 La nómina se registra desde Empleados → Nómina
              </div>
              <div style={{ fontSize: 11.5, color: '#4338ca', lineHeight: 1.65, marginBottom: 12 }}>
                Allá el sistema calcula el <strong>salario proporcional a los días trabajados</strong>,
                las <strong>horas extras y recargos</strong> según la reforma laboral, el
                <strong> auxilio de transporte</strong>, las <strong>deducciones de ley</strong> (salud y pensión),
                y <strong>descuenta automáticamente los anticipos</strong> que el empleado pidió en el período.
                Además causa las prestaciones sociales como pasivo.
                <br /><br />
                Si lo registrás acá como un egreso simple, se pierde todo ese desglose y las
                prestaciones no se causan — que es justo lo que hacía que el ERI mostrara
                la nómina por debajo de lo que cuesta.
              </div>

              {onNavegar && (
                <button type="button" onClick={() => { onClose(); onNavegar('empleados'); }}
                  style={{
                    padding: '9px 18px', borderRadius: 9, border: 'none', cursor: 'pointer',
                    fontSize: 12.5, fontWeight: 700, color: '#fff',
                    background: 'linear-gradient(135deg,#6366f1,#4f46e5)'
                  }}>
                  Ir a Empleados → Nómina →
                </button>
              )}

              <div style={{
                background: '#fff', borderRadius: 9, padding: '10px 13px', marginTop: 11,
                fontSize: 11, color: '#64748b', lineHeight: 1.6
              }}>
                <strong style={{ color: '#334155' }}>Sí registrá acá:</strong> pagos de seguridad social
                (planilla PILA), parafiscales, aportes a la caja de compensación, liquidaciones
                definitivas o cualquier pago de personal que no sea la nómina del período.
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              ✅ NOMINA-PROVISIONES-001 — ¿Es un anticipo de nómina?
              ───────────────────────────────────────────────────────────────
              Aparece cuando el tercero coincide con un empleado registrado.
              La pregunta se hace UNA vez, en el momento correcto: cuando la
              información todavía se puede clasificar bien.
              ═════════════════════════════════════════════════════════════ */}
          {empleadoDetectado && (
            <div style={{
              background: form.esAnticipoNomina ? '#f0fdf4' : '#fffbeb',
              border: `2px solid ${form.esAnticipoNomina ? '#86efac' : '#fcd34d'}`,
              borderRadius: 12, padding: 14, marginBottom: 14
            }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: form.esAnticipoNomina ? '#15803d' : '#92400e', marginBottom: 6 }}>
                👤 {empleadoDetectado.nombre} es un empleado registrado
              </div>
              <div style={{ fontSize: 11.5, color: form.esAnticipoNomina ? '#166534' : '#a16207', lineHeight: 1.6, marginBottom: 12 }}>
                ¿Este pago es un <strong>anticipo de nómina</strong> (un préstamo contra la quincena)?
                <br />
                Si lo es, <strong>no es un gasto</strong>: es una cuenta por cobrar que se descuenta
                automáticamente al liquidar la nómina del período. Si lo registrás como gasto y después
                pagás el salario completo, el gasto queda contado dos veces.
              </div>

              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                <button type="button"
                  onClick={() => {
                    set('esAnticipoNomina', true);
                    set('empleadoId', empleadoDetectado.id);
                    set('empleadoNombre', empleadoDetectado.nombre);
                    set('empleadoDocumento', empleadoDetectado.documento);
                    // El anticipo pertenece a la familia de personal
                    const catAnticipo = (categoriasList || []).find(c => /anticipo/i.test(c));
                    if (catAnticipo) set('categoria', catAnticipo);
                  }}
                  style={{
                    padding: '9px 17px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                    border: form.esAnticipoNomina ? '2px solid #16a34a' : '2px solid transparent',
                    background: form.esAnticipoNomina ? '#16a34a' : '#fff',
                    color: form.esAnticipoNomina ? '#fff' : '#374151'
                  }}>
                  ✓ Sí, es un anticipo de nómina
                </button>
                <button type="button"
                  onClick={() => {
                    set('esAnticipoNomina', false);
                    set('empleadoId', '');
                    set('empleadoNombre', '');
                    set('empleadoDocumento', '');
                  }}
                  style={{
                    padding: '9px 17px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                    border: form.esAnticipoNomina === false ? '2px solid #64748b' : '2px solid transparent',
                    background: form.esAnticipoNomina === false ? '#475569' : '#fff',
                    color: form.esAnticipoNomina === false ? '#fff' : '#374151'
                  }}>
                  No, es otro tipo de pago
                </button>
              </div>

              {form.esAnticipoNomina && (
                <div style={{
                  background: '#fff', borderRadius: 9, padding: '10px 13px', marginTop: 11,
                  fontSize: 11.5, color: '#166534', lineHeight: 1.55
                }}>
                  ✅ Quedará enlazado a <strong>{empleadoDetectado.nombre}</strong>. Cuando generes el
                  comprobante de nómina del período desde <strong>Empleados → Nómina</strong>, este
                  anticipo aparecerá automáticamente y se descontará del neto a pagar.
                </div>
              )}

              {/* Permite corregir si detectó al empleado equivocado */}
              {form.esAnticipoNomina && (empleados || []).length > 1 && (
                <div style={{ ...S.field, marginTop: 11, marginBottom: 0 }}>
                  <label style={{ ...S.label, fontSize: 11 }}>¿Otro empleado?</label>
                  <select style={S.select} value={form.empleadoId || ''}
                    onChange={e => {
                      const emp = (empleados || []).find(x => x.id === e.target.value);
                      set('empleadoId', e.target.value);
                      set('empleadoNombre', emp ? emp.nombre : '');
                      set('empleadoDocumento', emp ? emp.documento : '');
                    }}>
                    {(empleados || []).filter(e => e.activo !== false).map(e => (
                      <option key={e.id} value={e.id}>{e.nombre} · {e.documento}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              ✅ EGRESO-VEHICULO-001 — Selector de vehículo
              ───────────────────────────────────────────────────────────────
              Aparece automáticamente cuando la categoría huele a gasto de
              vehículo (combustible, mantenimiento, peajes, fletes...). No se
              muestra siempre para no estorbar en los otros 25 tipos de egreso.
              ═════════════════════════════════════════════════════════════ */}
          {esGastoDeVehiculo && (
            <div style={S.field}>
              <label style={S.label}>
                Vehículo / Placa
                {(vehiculos || []).length === 0 && (
                  <span style={{ fontWeight: 400, color: '#dc2626', marginLeft: 6 }}>
                    · no tenés vehículos registrados todavía
                  </span>
                )}
              </label>
              {(vehiculos || []).length > 0 ? (
                <select style={S.select} value={form.vehiculoId || ''}
                  onChange={e => {
                    const v = (vehiculos || []).find(x => x.id === e.target.value);
                    set('vehiculoId', e.target.value);
                    set('vehiculoPlaca', v ? v.placa : '');
                  }}>
                  <option value="">— Sin asignar —</option>
                  {(vehiculos || []).filter(v => v.activo !== false).map(v => (
                    <option key={v.id} value={v.id}>
                      {v.placa} · {v.tipo}{v.conductorNombre ? ` · ${v.conductorNombre}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{
                  background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
                  padding: '9px 12px', fontSize: 12, color: '#92400e', lineHeight: 1.5
                }}>
                  Registrá tus vehículos en <strong>Configuración → Vehículos</strong> para poder saber
                  cuánto consume cada placa. Sin eso, el gasto de combustible queda como un solo
                  bloque que no se puede atribuir.
                </div>
              )}
            </div>
          )}

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

          {/* ✅ EGRESO-PROV-001 — Legalizar comprobante provisional */}
          {!egreso && listaProv.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button type="button" onClick={() => activarLegalizacion(esLegalizar ? '' : listaProv[0].id)} style={{
                padding: '9px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, border: 'none',
                background: esLegalizar ? '#d97706' : '#f3f4f6',
                color: esLegalizar ? '#fff' : '#374151',
              }}>💵 Legalizar comprobante provisional ({listaProv.length})</button>

              {esLegalizar && (
                <div style={{ background: '#fffbeb', border: '2px solid #fcd34d', borderRadius: 10, padding: 14, marginTop: 10 }}>
                  <div style={S.field}>
                    <label style={S.label}>Comprobante a legalizar *</label>
                    <select style={S.select} value={form.provisionalId} onChange={e => activarLegalizacion(e.target.value)}>
                      {listaProv.map(pv => (
                        <option key={pv.id} value={pv.id}>
                          {pv.numero} · {pv.mensajeroNombre || 'sin mensajero'} · {pv.concepto} · {fmt(pv.totalPagar || pv.monto)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ background: '#fff', borderRadius: 8, padding: 12, fontSize: 13, marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, color: '#6b7280' }}>
                      <span>Anticipo entregado</span><span>{fmt(baseAnticipo)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, color: '#6b7280' }}>
                      <span>Gasto real (con IVA y retención)</span><span>{fmt(totalPagar)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, borderTop: '1px solid #e5e7eb', paddingTop: 8, marginTop: 4,
                      color: diferenciaLegal > 0 ? '#16a34a' : diferenciaLegal < 0 ? '#dc2626' : '#6b7280' }}>
                      <span>{diferenciaLegal > 0 ? '↩ Vuelto a caja' : diferenciaLegal < 0 ? '↪ Sale de caja' : '✓ Cuadra exacto'}</span>
                      <span>{fmt(Math.abs(diferenciaLegal))}</span>
                    </div>
                  </div>

                  <div style={S.field}>
                    <label style={S.label}>Caja del ajuste *</label>
                    <select style={S.select} value={form.cajaId}
                      onChange={e => { const c = (cajas || []).find(x => x.id === e.target.value); set('cajaId', e.target.value); set('cajaLabel', c?.nombre || ''); }}>
                      <option value="">— Seleccionar caja —</option>
                      {(cajas || []).map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                    </select>
                  </div>

                  <div style={{ ...S.field, marginBottom: 0 }}>
                    <label style={S.label}>PIN (Admin / Tesorería) *</label>
                    <input type="password" inputMode="numeric" maxLength={4} style={S.input} placeholder="••••"
                      value={form.pinLegal} onChange={e => set('pinLegal', e.target.value.replace(/\D/g, ''))} />
                  </div>

                  <div style={{ fontSize: 12, color: '#92400e', marginTop: 10 }}>
                    ⚠️ La plata del anticipo <strong>ya salió de caja</strong>. Aquí solo se mueve la diferencia.
                  </div>
                </div>
              )}
            </div>
          )}

          {form.formaPago === 'Cuenta por Pagar' && (
            <div style={{ background: '#ede9fe', border: '1px solid #c4b5fd', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#6d28d9' }}>
              📋 Esta compra quedará en <strong>Cuentas por Pagar</strong>. Cuando pagues al proveedor, regístralo desde el módulo <strong>CxP</strong>.
            </div>
          )}

          {/* Pagar ahora — oculto si es Cuenta por Pagar o si legaliza un anticipo */}
          {/* ✅ EGRESO-PROV-001: legalizar NO es pagar. La plata ya salió. */}
          {form.formaPago !== 'Cuenta por Pagar' && !esLegalizar && (
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

          {/* ═════════════════════════════════════════════════════════════════
              ✅ EGRESO-INTELIGENTE-001 — Alertas de digitación
              ───────────────────────────────────────────────────────────────
              Se muestran justo antes del botón de guardar, donde la persona
              todavía puede corregir sin esfuerzo. No bloquean: si la persona
              sabe lo que hace, guarda igual y queda la marca.
              ═════════════════════════════════════════════════════════════ */}
          {alertasDigitacion.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{
                fontSize: 11, fontWeight: 800, color: '#64748b', marginBottom: 8,
                textTransform: 'uppercase', letterSpacing: '.05em'
              }}>
                Revisión automática
              </div>
              <PanelAlertas alertas={alertasDigitacion} />
            </div>
          )}
        </div>
        <div style={S.modalFooter}>
          <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
          <button
            onClick={() => {
              // Si hay errores graves, se pide una confirmación explícita.
              // La persona puede seguir — pero de forma consciente, no por descuido.
              const graves = alertasDigitacion.filter(a => a.severidad === 'grave');
              if (graves.length > 0) {
                const ok = window.confirm(
                  `⚠️ Se detectaron ${graves.length} posible(s) error(es) contable(s):\n\n` +
                  graves.map(g => `• ${g.titulo}`).join('\n') +
                  `\n\n¿Guardar de todas formas?\nQuedará marcado para revisión posterior.`
                );
                if (!ok) return;
              }
              handleSubmit();
            }}
            disabled={saving}
            style={{
              ...S.btnPrimary,
              background: alertasDigitacion.some(a => a.severidad === 'grave')
                ? 'linear-gradient(135deg,#f59e0b,#d97706)'
                : S.btnPrimary.background
            }}>
            {saving ? 'Guardando...' : egreso ? 'Guardar cambios'
              : esLegalizar ? `💵 Legalizar ${provSel?.numero || ''}`
              : form.pagarAhora ? `✅ Crear y pagar ${fmt(totalPagar)}` : 'Crear egreso'}
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

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-INTELIGENTE-001 — PanelAlertas
// ─────────────────────────────────────────────────────────────────────────────
// Muestra las observaciones del motor de reglas mientras la persona digita.
//
// CRITERIO: advertir, no bloquear. Un digitador bloqueado no corrige el dato —
// busca el atajo (registrar todo en "Otros") y el problema se vuelve invisible.
// Explicamos QUÉ está mal y POR QUÉ importa; la persona decide.
// ═════════════════════════════════════════════════════════════════════════════
const ESTILO_SEVERIDAD = {
  grave: { bg: '#fef2f2', bd: '#fecaca', tx: '#991b1b', ic: '🚨', et: 'Error probable' },
  media: { bg: '#fffbeb', bd: '#fde68a', tx: '#92400e', ic: '⚠️', et: 'Revisar' },
  leve:  { bg: '#f0f9ff', bd: '#bae6fd', tx: '#075985', ic: '💡', et: 'Sugerencia' }
};

function PanelAlertas({ alertas = [], compacto = false }) {
  if (!alertas.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
      {alertas.map((a, i) => {
        const s = ESTILO_SEVERIDAD[a.severidad] || ESTILO_SEVERIDAD.leve;
        return (
          <div key={a.id + i} style={{
            background: s.bg, border: `1px solid ${s.bd}`, borderRadius: 10,
            padding: compacto ? '9px 11px' : '11px 13px'
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ fontSize: 14, lineHeight: 1.2 }}>{s.ic}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12.5, fontWeight: 800, color: s.tx,
                  display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap'
                }}>
                  {a.titulo}
                  <span style={{
                    fontSize: 9, fontWeight: 800, background: s.tx, color: s.bg,
                    borderRadius: 20, padding: '2px 7px', textTransform: 'uppercase', letterSpacing: '.04em'
                  }}>{s.et}</span>
                </div>
                {a.detalle && (
                  <div style={{ fontSize: 11.5, color: s.tx, opacity: .88, marginTop: 4, lineHeight: 1.5 }}>
                    {a.detalle}
                  </div>
                )}
                {a.sugerencia && (
                  <div style={{ fontSize: 11, color: s.tx, opacity: .75, marginTop: 4, fontStyle: 'italic' }}>
                    → {a.sugerencia}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-EDICION-002 — ModalHistorial
// ─────────────────────────────────────────────────────────────────────────────
// Muestra el rastro completo de un egreso: quién lo tocó, cuándo, qué campo,
// de qué valor a qué valor y por qué.
//
// Sin esto, la auditoría se guardaba pero nadie podía consultarla — que es casi
// lo mismo que no tenerla. Una corrección solo es defendible ante una revisión
// si se puede mostrar el antes y el después.
// ═════════════════════════════════════════════════════════════════════════════
const ETIQUETA_CAMPO = {
  concepto: 'Concepto', proveedor: 'Proveedor', categoria: 'Categoría',
  monto: 'Base', ivaVal: 'IVA', retenVal: 'Retención', totalPagar: 'Total pagado',
  fecha: 'Fecha', formaPago: 'Forma de pago', cajaId: 'Caja', notas: 'Notas',
  vehiculoPlaca: 'Vehículo', empleadoNombre: 'Empleado', esAnticipoNomina: 'Anticipo de nómina'
};

function ModalHistorial({ egreso, onClose }) {
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/egresos/${egreso.id}/historial`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        });
        setDatos(r.data);
      } catch { setDatos({ eventos: [] }); }
      setCargando(false);
    })();
  }, [egreso.id]);

  const esMonetario = (k) => ['monto', 'ivaVal', 'retenVal', 'totalPagar'].includes(k);
  const pinta = (k, v) => {
    if (v === undefined || v === null || v === '') return '—';
    if (esMonetario(k)) return fmt(v);
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    return String(v);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 660 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>📜 Historial · {egreso.numero}</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>

          <div style={{ background: '#f8fafc', borderRadius: 10, padding: '11px 14px', marginBottom: 16, fontSize: 12, color: '#475569', lineHeight: 1.6 }}>
            <strong>{egreso.concepto}</strong> · {egreso.proveedor || 'sin tercero'} · {fmt(egreso.totalPagar || egreso.monto)}
          </div>

          {cargando ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>⏳ Cargando historial...</div>
          ) : (
            <>
              {/* Reclasificación en lote, si aplica */}
              {datos?.reclasificacion && (
                <div style={{
                  background: datos.reclasificacion.revertido ? '#f1f5f9' : '#eef2ff',
                  border: `1px solid ${datos.reclasificacion.revertido ? '#e2e8f0' : '#c7d2fe'}`,
                  borderRadius: 10, padding: '12px 14px', marginBottom: 14, fontSize: 12, lineHeight: 1.6
                }}>
                  <strong style={{ color: '#4338ca' }}>🔀 Reclasificado en lote</strong>
                  {datos.reclasificacion.revertido && <span style={{ color: '#94a3b8' }}> · revertido</span>}
                  <div style={{ color: '#475569', marginTop: 4 }}>
                    "{datos.reclasificacion.categoriaAnterior}" → "{datos.reclasificacion.categoriaNueva}"
                    <br />Motivo: {datos.reclasificacion.motivo}
                    <br /><span style={{ color: '#94a3b8' }}>
                      {datos.reclasificacion.por} · {String(datos.reclasificacion.en).slice(0, 16).replace('T', ' ')}
                      {' · '}Lote {datos.reclasificacion.loteId}
                    </span>
                  </div>
                </div>
              )}

              {(datos?.eventos || []).length === 0 ? (
                <div style={{ padding: 26, textAlign: 'center', color: '#cbd5e1', fontSize: 12.5 }}>
                  Este egreso no ha tenido modificaciones registradas.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {datos.eventos.map(ev => {
                    const critico = /CRITICO|ANULAD/i.test(ev.accion);
                    return (
                      <div key={ev.id} style={{
                        borderLeft: `3px solid ${critico ? '#dc2626' : '#cbd5e1'}`,
                        paddingLeft: 13, paddingBottom: 4
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                          <strong style={{ fontSize: 12.5, color: critico ? '#991b1b' : '#334155' }}>
                            {ev.accion.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase())}
                          </strong>
                          <span style={{ fontSize: 11, color: '#94a3b8' }}>
                            {String(ev.fecha).slice(0, 16).replace('T', ' ')}
                          </span>
                        </div>
                        <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>{ev.usuario}</div>
                        {ev.motivo && (
                          <div style={{ fontSize: 11.5, color: '#92400e', background: '#fffbeb', borderRadius: 6, padding: '5px 9px', marginTop: 6 }}>
                            Motivo: {ev.motivo}
                          </div>
                        )}

                        {/* Antes y después, campo por campo */}
                        {ev.camposCambiados?.length > 0 && ev.anterior && ev.nuevo && (
                          <div style={{ marginTop: 8, background: '#f8fafc', borderRadius: 8, padding: '8px 11px' }}>
                            {ev.camposCambiados
                              .filter(k => ETIQUETA_CAMPO[k])
                              .map(k => (
                                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, padding: '2px 0' }}>
                                  <span style={{ color: '#64748b', minWidth: 92 }}>{ETIQUETA_CAMPO[k]}</span>
                                  <span style={{ flex: 1, textAlign: 'right' }}>
                                    <span style={{ color: '#dc2626', textDecoration: 'line-through' }}>{pinta(k, ev.anterior[k])}</span>
                                    <span style={{ color: '#cbd5e1', margin: '0 6px' }}>→</span>
                                    <strong style={{ color: '#16a34a' }}>{pinta(k, ev.nuevo[k])}</strong>
                                  </span>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          <div style={S.modalFooter}>
            <button onClick={onClose} style={S.btnSecondary}>Cerrar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-RECLASIFICAR-001 — ModalLotes
// ─────────────────────────────────────────────────────────────────────────────
// Lista las reclasificaciones masivas hechas y permite revertir cualquiera.
// Es la red de seguridad que hace que mover 200 registros no dé miedo.
// ═════════════════════════════════════════════════════════════════════════════
function ModalLotes({ onCerrar, onRevertido }) {
  const [lotes, setLotes] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [revirtiendo, setRevirtiendo] = useState(null);
  const [pin, setPin] = useState('');
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState('');

  const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/egresos/lotes`, { headers: headers() });
        setLotes(Array.isArray(r.data) ? r.data : []);
      } catch { setLotes([]); }
      setCargando(false);
    })();
  }, []);

  const revertir = async (lote) => {
    if (!/^\d{4}$/.test(pin)) { setError('El PIN es de 4 dígitos'); return; }
    setError('');
    try {
      await axios.post(`${API}/egresos/reclasificar-lote/${lote.loteId}/revertir`,
        { pin, motivo }, { headers: headers() });
      setLotes(p => p.map(l => l.loteId === lote.loteId ? { ...l, revertido: true } : l));
      setRevirtiendo(null); setPin(''); setMotivo('');
      onRevertido && onRevertido();
    } catch (e) {
      setError(e.response?.data?.error || 'No se pudo revertir');
    }
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 700 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>🔀 Reclasificaciones hechas</h3>
          <button onClick={onCerrar} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '11px 14px', marginBottom: 16, fontSize: 12, color: '#1e40af', lineHeight: 1.6 }}>
            Cada reclasificación masiva queda como un lote reversible. Al revertir, cada egreso
            vuelve a la categoría que tenía antes — no a una categoría genérica.
          </div>

          {cargando ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>⏳ Cargando...</div>
          ) : lotes.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: '#cbd5e1', fontSize: 12.5 }}>
              Todavía no se ha hecho ninguna reclasificación masiva.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {lotes.map(l => (
                <div key={l.loteId} style={{
                  background: l.revertido ? '#f8fafc' : '#fff',
                  border: `1px solid ${l.revertido ? '#e2e8f0' : '#c7d2fe'}`,
                  borderRadius: 11, padding: '13px 16px', opacity: l.revertido ? .65 : 1
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 230 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a' }}>
                        → {l.categoriaNueva}
                        {l.revertido && <span style={{ fontSize: 10, fontWeight: 700, background: '#f1f5f9', color: '#94a3b8', borderRadius: 20, padding: '2px 8px', marginLeft: 8 }}>REVERTIDO</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 4 }}>
                        Desde: {l.origenes.map(o => `${o.categoria} (${o.cantidad})`).join(' · ')}
                      </div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                        {l.por} · {String(l.en).slice(0, 16).replace('T', ' ')}
                      </div>
                      <div style={{ fontSize: 11.5, color: '#92400e', background: '#fffbeb', borderRadius: 6, padding: '5px 9px', marginTop: 6 }}>
                        {l.motivo}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 18, fontWeight: 900, color: '#4338ca' }}>{l.cantidad}</div>
                      <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700 }}>EGRESOS</div>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: '#334155', marginTop: 3 }}>{fmt(l.valor)}</div>
                    </div>
                  </div>

                  {!l.revertido && (
                    revirtiendo === l.loteId ? (
                      <div style={{ marginTop: 12, paddingTop: 11, borderTop: '1px dashed #e2e8f0' }}>
                        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                          <div style={{ flex: 1, minWidth: 160 }}>
                            <label style={{ ...S.label, fontSize: 11 }}>Motivo de la reversión</label>
                            <input style={{ ...S.input, width: '100%' }} value={motivo}
                              onChange={e => setMotivo(e.target.value)} placeholder="Mínimo 10 caracteres" />
                          </div>
                          <div style={{ width: 110 }}>
                            <label style={{ ...S.label, fontSize: 11 }}>PIN</label>
                            <input type="password" inputMode="numeric" maxLength={4}
                              style={{ ...S.input, width: '100%', textAlign: 'center', letterSpacing: 6, fontWeight: 800 }}
                              value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" />
                          </div>
                          <button onClick={() => revertir(l)}
                            style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#dc2626,#b91c1c)', padding: '9px 16px', fontSize: 12 }}>
                            Confirmar
                          </button>
                          <button onClick={() => { setRevirtiendo(null); setError(''); }} style={{ ...S.btnSecondary, padding: '9px 14px', fontSize: 12 }}>
                            Cancelar
                          </button>
                        </div>
                        {error && <div style={{ fontSize: 11.5, color: '#991b1b', marginTop: 7 }}>{error}</div>}
                      </div>
                    ) : (
                      <button onClick={() => { setRevirtiendo(l.loteId); setError(''); }}
                        style={{ ...S.btnSecondary, marginTop: 11, padding: '7px 14px', fontSize: 11.5, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                        ↩ Revertir este lote
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={S.modalFooter}>
            <button onClick={onCerrar} style={S.btnSecondary}>Cerrar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-RECLASIFICAR-001 — ModalReclasificar
// ─────────────────────────────────────────────────────────────────────────────
// Cambia la categoría de N egresos en una sola operación, con PIN, motivo y
// auditoría. No toca valores: la plata que salió es la misma, cambia dónde se
// clasifica. Por eso no requiere ajustar caja ni inventario.
//
// Nace de un hallazgo concreto: en julio 2026 había 56 egresos de personal mal
// repartidos entre "Nómina" y "anticipos de nomina", cruzados en ambos
// sentidos. Corregirlos de a uno son 56 PIN y 56 chances de equivocarse.
// ═════════════════════════════════════════════════════════════════════════════
function ModalReclasificar({ egresos, categoriasList, onConfirmar, onClose }) {
  const [paso, setPaso]         = useState('revisar');
  const [destino, setDestino]   = useState('');
  const [motivo, setMotivo]     = useState('');
  const [pin, setPin]           = useState('');
  const [error, setError]       = useState('');
  const [guardando, setGuardando] = useState(false);

  const valorTotal = egresos.reduce((a, e) => a + (Number(e.totalPagar || e.monto) || 0), 0);

  // Desglose de las categorías de origen — es lo que le da confianza al usuario
  // de que está moviendo lo que cree que está moviendo.
  const origenes = useMemo(() => {
    const m = {};
    for (const e of egresos) {
      const c = e.categoria || 'Sin categoría';
      if (!m[c]) m[c] = { categoria: c, cantidad: 0, valor: 0 };
      m[c].cantidad += 1;
      m[c].valor += Number(e.totalPagar || e.monto) || 0;
    }
    return Object.values(m).sort((a, b) => b.valor - a.valor);
  }, [egresos]);

  const yaEnDestino = egresos.filter(e => normTxt(e.categoria) === normTxt(destino)).length;
  const aplicables  = egresos.length - yaEnDestino;

  const continuar = () => {
    if (!destino) { setError('Seleccioná la categoría destino'); return; }
    if (aplicables === 0) { setError('Todos los egresos ya están en esa categoría'); return; }
    setError(''); setPaso('confirmar');
  };

  const ejecutar = async () => {
    if (!/^\d{4}$/.test(pin)) { setError('El PIN es de 4 dígitos'); return; }
    if (motivo.trim().length < 10) { setError('Explicá la reclasificación (mínimo 10 caracteres)'); return; }
    setGuardando(true); setError('');
    try {
      await onConfirmar({ ids: egresos.map(e => e.id), categoriaDestino: destino, motivo: motivo.trim(), pin });
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'No se pudo reclasificar');
      setGuardando(false);
    }
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 620 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>🔀 Reclasificar {egresos.length} egreso(s)</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>

          {paso === 'revisar' ? (
            <>
              <div style={{
                background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
                padding: 12, marginBottom: 16, fontSize: 12, color: '#1e40af', lineHeight: 1.55
              }}>
                Esta operación cambia <strong>solo la categoría</strong>. No modifica valores, ni la caja,
                ni el inventario. Queda registrada con un identificador de lote y se puede <strong>revertir completa</strong>.
              </div>

              {/* Resumen de lo seleccionado */}
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: 12, marginBottom: 16, border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#475569', marginBottom: 9, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  Categorías de origen
                </div>
                {origenes.map(o => (
                  <div key={o.categoria} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid #f1f5f9'
                  }}>
                    <span style={{ color: '#334155' }}>
                      {o.categoria} <span style={{ color: '#94a3b8' }}>· {o.cantidad}</span>
                    </span>
                    <strong style={{ color: '#0f172a' }}>{fmt(o.valor)}</strong>
                  </div>
                ))}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', paddingTop: 9, marginTop: 3,
                  fontSize: 13, fontWeight: 800, color: '#0f172a'
                }}>
                  <span>Total seleccionado</span><span>{fmt(valorTotal)}</span>
                </div>
              </div>

              <div style={S.field}>
                <label style={S.label}>Mover todo a la categoría *</label>
                <select style={S.select} value={destino} onChange={e => { setDestino(e.target.value); setError(''); }}>
                  <option value="">— Seleccionar categoría destino —</option>
                  {categoriasList.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 5 }}>
                  Solo aparecen categorías del catálogo. Si necesitás una nueva, creála primero en Configuración.
                </div>
              </div>

              {destino && (
                <div style={{
                  background: aplicables > 0 ? '#f0fdf4' : '#fef2f2',
                  border: `1px solid ${aplicables > 0 ? '#dcfce7' : '#fee2e2'}`,
                  borderRadius: 10, padding: '10px 13px', fontSize: 12,
                  color: aplicables > 0 ? '#15803d' : '#991b1b', marginBottom: 14
                }}>
                  Se reclasificarán <strong>{aplicables}</strong> egreso(s) a <strong>{destino}</strong>.
                  {yaEnDestino > 0 && <> {yaEnDestino} ya estaba(n) en esa categoría y se omitirá(n).</>}
                </div>
              )}

              {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, color: '#991b1b', marginBottom: 12 }}>{error}</div>}

              <div style={S.modalFooter}>
                <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
                <button onClick={continuar} style={S.btnPrimary}>Continuar →</button>
              </div>
            </>
          ) : (
            <>
              <div style={{
                background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
                padding: 13, marginBottom: 16, fontSize: 12.5, color: '#991b1b', lineHeight: 1.55
              }}>
                🔐 Vas a reclasificar <strong>{aplicables} egreso(s)</strong> por <strong>{fmt(valorTotal)}</strong> a
                la categoría <strong>{destino}</strong>. Requiere tu PIN y queda en auditoría.
              </div>

              <div style={S.field}>
                <label style={S.label}>Motivo de la reclasificación *</label>
                <textarea style={{ ...S.input, height: 72, resize: 'vertical' }} value={motivo}
                  onChange={e => { setMotivo(e.target.value); setError(''); }}
                  placeholder="Ej: Unificación de las categorías de personal según auditoría del ERI de julio" />
                <div style={{ fontSize: 11, color: motivo.trim().length >= 10 ? '#16a34a' : '#94a3b8', marginTop: 4 }}>
                  {motivo.trim().length}/10 caracteres mínimos
                </div>
              </div>

              <div style={S.field}>
                <label style={S.label}>PIN admin (4 dígitos) *</label>
                <input type="password" inputMode="numeric" maxLength={4}
                  style={{ ...S.input, textAlign: 'center', letterSpacing: 10, fontWeight: 800, fontSize: 20 }}
                  value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError(''); }}
                  placeholder="••••" onKeyDown={e => e.key === 'Enter' && ejecutar()} />
              </div>

              {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, color: '#991b1b', marginBottom: 12 }}>{error}</div>}

              <div style={S.modalFooter}>
                <button onClick={() => { setPaso('revisar'); setError(''); }} style={S.btnSecondary}>← Volver</button>
                <button onClick={ejecutar} disabled={guardando}
                  style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#dc2626,#b91c1c)' }}>
                  {guardando ? 'Reclasificando...' : `🔐 Reclasificar ${aplicables}`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Modal Editar Pagado ──────────────────────────────────────────────────────
// FIX PIN-UNICO-001: este modal pedia la CONTRASENA de login y llamaba a
// /users/verificar-password, mientras el backend /egresos/:id/editar-pagado
// exigia `pin` en el body — y el frontend nunca lo enviaba. El flujo estaba
// roto y ademas usaba una credencial distinta a la del resto del sistema.
// Ahora usa el MISMO PIN de 4 digitos que anular, cuadrar y validar pago.
function ModalEditarPagado({ egreso, onSave, onClose, categoriasList = [], categoriasMeta = [], vehiculos = [], empleados = [] }) {
  const [paso, setPaso]     = useState('auth');
  const [pin, setPin]       = useState('');
  const [motivo, setMotivo] = useState('');
  const [form, setForm]     = useState({ ...egreso });
  const [saving, setSaving] = useState(false);
  const [errorAuth, setErrorAuth] = useState('');
  const [verificando, setVerificando] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // ✅ EGRESO-EDICION-002: total recalculado en vivo — la persona ve el efecto
  // de su corrección sobre la caja ANTES de confirmarla.
  const totalOriginal = Number(egreso?.totalPagar || egreso?.monto) || 0;
  const totalRecalculado = Math.round(
    (Number(form.monto) || 0) + (Number(form.ivaVal) || 0) - (Number(form.retenVal) || 0)
  );

  // ✅ FIX NOMINA-ANTICIPO-EDICION-001: misma detección que en el alta —
  // si el tercero coincide con un empleado registrado, se puede marcar el
  // egreso como anticipo también desde la edición.
  const empleadoDetectado = useMemo(() => {
    if (form.esComprobanteNomina) return null;
    const texto = `${normTxt(form.proveedor)} ${normTxt(form.concepto)}`;
    if (texto.trim().length < 5) return null;
    return (empleados || []).find(emp => {
      const n = normTxt(emp.nombre);
      return n.length >= 5 && texto.includes(n);
    }) || null;
  }, [form.proveedor, form.concepto, form.esComprobanteNomina, empleados]);

  // ✅ EGRESO-INTELIGENTE-001: validación en vivo sobre el egreso corregido
  const alertasEdicion = useMemo(() => {
    const meta = categoriasMeta.find(c => normTxt(c.nombre) === normTxt(form.categoria)) || null;
    return validarEgreso(
      { ...form, totalPagar: totalRecalculado },
      { categoriaMeta: meta, categoriasValidas: categoriasList }
    ).alertas;
  }, [form, categoriasMeta, categoriasList, totalRecalculado]);

  const verificarPinAdmin = async () => {
    if (!/^\d{4}$/.test(pin)) { setErrorAuth('El PIN es de 4 digitos'); return; }
    if (!motivo.trim()) { setErrorAuth('El motivo es obligatorio'); return; }
    if (motivo.trim().length < 10) { setErrorAuth('Explicá la corrección con un poco más de detalle (mínimo 10 caracteres)'); return; }
    setVerificando(true); setErrorAuth('');
    try {
      const token = localStorage.getItem('token');
      // Pre-validacion (feedback + auditoria). El PIN se vuelve a enviar y a
      // validar en el POST /editar-pagado — nunca se autoriza solo con la UI.
      await axios.post(`${API}/users/verificar-pin`,
        { pin, accion: 'editar_egreso_pagado', documento: egreso?.numero || null },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setPaso('editar');
    } catch (e) {
      setErrorAuth(e.response?.data?.error || 'PIN incorrecto');
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
                🚨 Este egreso ya fue <strong>PAGADO</strong>. Editarlo requiere tu <strong>PIN de administrador</strong> (el mismo de anular y validar pagos) y queda en auditoría.
              </div>
              {errorAuth && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#991b1b', marginBottom: 12 }}>{errorAuth}</div>}
              <div style={S.field}>
                <label style={S.label}>PIN admin (4 dígitos) *</label>
                <input type="password" inputMode="numeric" maxLength={4} style={{ ...S.input, textAlign: 'center', letterSpacing: 10, fontWeight: 800, fontSize: 20 }}
                  value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setErrorAuth(''); }}
                  placeholder="••••" onKeyDown={e => e.key === 'Enter' && verificarPinAdmin()} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Motivo de edición *</label>
                <textarea style={{ ...S.input, height: 72, resize: 'vertical' }} value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Explica por qué se edita este egreso..." />
              </div>
              <div style={S.modalFooter}>
                <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
                <button onClick={verificarPinAdmin} disabled={verificando}
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

              {/* ✅ EGRESO-EDICION-002: el formulario ahora expone TODOS los
                  campos que el backend acepta. Antes solo mostraba concepto,
                  monto y notas — por eso era imposible corregir una categoría
                  mal asignada o sacar un IVA que no correspondía, aunque el
                  endpoint sí lo permitiera. */}

              <div style={S.row2}>
                <div style={S.field}>
                  <label style={S.label}>Concepto</label>
                  <input style={S.input} value={form.concepto || ''} onChange={e => set('concepto', e.target.value)} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>Fecha del pago</label>
                  <input type="date" style={S.input} value={form.fecha || ''} onChange={e => set('fecha', e.target.value)} />
                </div>
              </div>

              {/* ✅ CAUSACION-001: reasignar un gasto ya pagado al mes que le
                  corresponde, sin mover la salida de caja. Es lo que corrige
                  el caso de un servicio prestado en un mes y pagado al siguiente. */}
              <div style={{
                background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 11,
                padding: 13, marginBottom: 14
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: '#1e40af', marginBottom: 5 }}>
                  📅 ¿A qué mes corresponde este gasto?
                </div>
                <div style={{ fontSize: 11.5, color: '#1e40af', lineHeight: 1.6, marginBottom: 10 }}>
                  El estado de resultados lo cuenta en esta fecha; el flujo de efectivo,
                  en la del pago. Cambiala si el gasto pertenece a otro período.
                </div>
                <div style={{ ...S.field, marginBottom: 0, maxWidth: 200 }}>
                  <label style={{ ...S.label, fontSize: 11 }}>Fecha de causación</label>
                  <input type="date" style={S.input}
                    value={form.fechaCausacion || form.fecha || ''}
                    onChange={e => set('fechaCausacion', e.target.value)} />
                </div>
                {form.fechaCausacion && form.fechaCausacion !== form.fecha && (
                  <div style={{ fontSize: 11, color: '#1e40af', marginTop: 9, background: '#fff', borderRadius: 7, padding: '7px 10px' }}>
                    Estado de resultados: <strong>{String(form.fechaCausacion).slice(0, 7)}</strong> ·
                    Salida de caja: <strong>{String(form.fecha || '').slice(0, 7)}</strong>
                  </div>
                )}
              </div>

              <div style={S.row2}>
                <div style={S.field}>
                  <label style={S.label}>Categoría</label>
                  <select style={S.select} value={form.categoria || ''} onChange={e => set('categoria', e.target.value)}>
                    <option value="">— Seleccionar —</option>
                    {(categoriasList || []).map(c => <option key={c} value={c}>{c}</option>)}
                    {/* Si la categoría actual no está en el catálogo la mostramos
                        igual, para no perderla silenciosamente al editar. */}
                    {form.categoria && !(categoriasList || []).includes(form.categoria) && (
                      <option value={form.categoria}>⚠️ {form.categoria} (fuera del catálogo)</option>
                    )}
                  </select>
                </div>
                <div style={S.field}>
                  <label style={S.label}>Proveedor / Tercero</label>
                  <input style={S.input} value={form.proveedor || ''} onChange={e => set('proveedor', e.target.value)} />
                </div>
              </div>

              {/* ═══════════════════════════════════════════════════════════════
                  ✅ FIX NOMINA-ANTICIPO-EDICION-001 — marcar como anticipo
                  ───────────────────────────────────────────────────────────
                  Este bloque existía solo al CREAR el egreso. Si el digitador
                  no marcaba la casilla en ese momento, el egreso quedaba como
                  gasto suelto para siempre: al editarlo no había forma de
                  corregirlo, aunque el backend sí aceptaba el campo.
                  Se vio en un caso real: dos anticipos al mismo técnico, uno
                  marcado y otro no. El de $100.000 nunca se cruzó y estuvo a
                  punto de perderse al liquidarle el contrato.
                  ═══════════════════════════════════════════════════════════ */}
              {empleadoDetectado && (
                <div style={{
                  background: form.esAnticipoNomina ? '#f0fdf4' : '#fffbeb',
                  border: `2px solid ${form.esAnticipoNomina ? '#86efac' : '#fcd34d'}`,
                  borderRadius: 12, padding: 14, marginBottom: 14
                }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: form.esAnticipoNomina ? '#15803d' : '#92400e', marginBottom: 6 }}>
                    👤 {empleadoDetectado.nombre} es un empleado registrado
                  </div>
                  <div style={{ fontSize: 11.5, color: form.esAnticipoNomina ? '#166534' : '#a16207', lineHeight: 1.6, marginBottom: 12 }}>
                    ¿Este pago es un <strong>anticipo de nómina</strong>?
                    <br />
                    Si lo es, <strong>no es gasto</strong>: es plata que se le prestó y se descuenta
                    sola de la quincena o de la liquidación. Sin marcarlo, no se cruza con nada
                    y hay que acordarse de descontarlo a mano.
                  </div>

                  {egreso?.cruzadoEnNomina === true ? (
                    <div style={{ background: '#fff', borderRadius: 9, padding: '10px 13px', fontSize: 11.5, color: '#166534', lineHeight: 1.55 }}>
                      🔒 Este anticipo <strong>ya fue cruzado</strong> en un comprobante o liquidación.
                      No se puede desmarcar desde acá.
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                        <button type="button"
                          onClick={() => {
                            set('esAnticipoNomina', true);
                            set('empleadoId', empleadoDetectado.id);
                            set('empleadoNombre', empleadoDetectado.nombre);
                            set('empleadoDocumento', empleadoDetectado.documento);
                          }}
                          style={{
                            padding: '9px 17px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                            border: form.esAnticipoNomina ? '2px solid #16a34a' : '2px solid transparent',
                            background: form.esAnticipoNomina ? '#16a34a' : '#fff',
                            color: form.esAnticipoNomina ? '#fff' : '#374151'
                          }}>
                          ✓ Sí, es un anticipo de nómina
                        </button>
                        <button type="button"
                          onClick={() => {
                            set('esAnticipoNomina', false);
                            set('empleadoId', ''); set('empleadoNombre', ''); set('empleadoDocumento', '');
                          }}
                          style={{
                            padding: '9px 17px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                            border: form.esAnticipoNomina === false ? '2px solid #64748b' : '2px solid transparent',
                            background: form.esAnticipoNomina === false ? '#475569' : '#fff',
                            color: form.esAnticipoNomina === false ? '#fff' : '#374151'
                          }}>
                          No, es otro tipo de pago
                        </button>
                      </div>

                      {form.esAnticipoNomina && (
                        <div style={{ background: '#fff', borderRadius: 9, padding: '10px 13px', marginTop: 11, fontSize: 11.5, color: '#166534', lineHeight: 1.55 }}>
                          ✅ Queda enlazado a <strong>{form.empleadoNombre || empleadoDetectado.nombre}</strong>.
                          Se descontará solo en el próximo comprobante de nómina o en la liquidación.
                        </div>
                      )}

                      {form.esAnticipoNomina && (empleados || []).length > 1 && (
                        <div style={{ ...S.field, marginTop: 11, marginBottom: 0 }}>
                          <label style={{ ...S.label, fontSize: 11 }}>¿Otro empleado?</label>
                          <select style={S.select} value={form.empleadoId || ''}
                            onChange={e => {
                              const emp = (empleados || []).find(x => x.id === e.target.value);
                              set('empleadoId', e.target.value);
                              set('empleadoNombre', emp ? emp.nombre : '');
                              set('empleadoDocumento', emp ? emp.documento : '');
                            }}>
                            {(empleados || []).map(e => (
                              <option key={e.id} value={e.id}>{e.nombre} · {e.documento}</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Valores — con recálculo del total en vivo */}
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#475569', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  Valores
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                  <div style={{ ...S.field, marginBottom: 0 }}>
                    <label style={S.label}>Base</label>
                    <input type="number" style={S.input} value={form.monto ?? ''} onChange={e => set('monto', e.target.value)} />
                  </div>
                  <div style={{ ...S.field, marginBottom: 0 }}>
                    <label style={S.label}>IVA $</label>
                    <input type="number" style={S.input} value={form.ivaVal ?? 0} onChange={e => set('ivaVal', e.target.value)} />
                  </div>
                  <div style={{ ...S.field, marginBottom: 0 }}>
                    <label style={S.label}>Retención $</label>
                    <input type="number" style={S.input} value={form.retenVal ?? 0} onChange={e => set('retenVal', e.target.value)} />
                  </div>
                </div>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  borderTop: '1px dashed #cbd5e1', paddingTop: 9, fontSize: 13
                }}>
                  <span style={{ color: '#64748b', fontWeight: 600 }}>Total pagado (base + IVA − retención)</span>
                  <strong style={{ color: '#0f172a', fontSize: 15 }}>{fmt(totalRecalculado)}</strong>
                </div>
                {totalRecalculado !== totalOriginal && (
                  <div style={{ fontSize: 11, color: '#b45309', marginTop: 7, background: '#fffbeb', borderRadius: 6, padding: '6px 9px' }}>
                    ⚠️ El total cambia de <strong>{fmt(totalOriginal)}</strong> a <strong>{fmt(totalRecalculado)}</strong>.
                    El saldo de la caja se ajustará automáticamente en {fmt(Math.abs(totalOriginal - totalRecalculado))}.
                  </div>
                )}
              </div>

              {/* ✅ EGRESO-VEHICULO-001: permite asignar placa a gastos ya
                  registrados — así se recupera la trazabilidad del histórico. */}
              {(vehiculos || []).length > 0 && (
                <div style={S.field}>
                  <label style={S.label}>Vehículo (para gastos de combustible / mantenimiento)</label>
                  <select style={S.select} value={form.vehiculoId || ''}
                    onChange={e => {
                      const v = (vehiculos || []).find(x => x.id === e.target.value);
                      set('vehiculoId', e.target.value);
                      set('vehiculoPlaca', v ? v.placa : '');
                    }}>
                    <option value="">— Sin vehículo —</option>
                    {(vehiculos || []).filter(v => v.activo !== false).map(v => (
                      <option key={v.id} value={v.id}>
                        {v.placa} · {v.tipo}{v.conductorNombre ? ` · ${v.conductorNombre}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div style={S.field}>
                <label style={S.label}>Notas</label>
                <textarea style={{ ...S.input, height: 56, resize: 'vertical' }} value={form.notas || ''} onChange={e => set('notas', e.target.value)} />
              </div>

              {/* ✅ EGRESO-INTELIGENTE-001: las mismas reglas del alta corren
                  al editar. Si la corrección arregla el problema, la alerta
                  desaparece en vivo — el usuario ve que quedó bien. */}
              <PanelAlertas alertas={alertasEdicion} compacto />

              <div style={S.modalFooter}>
                <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
                <button onClick={async () => { setSaving(true); await onSave(form, motivo, pin); setSaving(false); }} disabled={saving}
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
export default function GestionEgresos({ user, onNavegar }) {
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
  // ✅ EGRESO-VEHICULO-001: se agrega `vehiculo` al filtro
  const [filtros, setFiltros]     = useState({ estado: 'todos', categoria: 'todos', vehiculo: 'todos', busca: '', desde: '', hasta: '' });
  // Ola 2: pestañas + cuadre definitivo
  const [tab, setTab]                             = useState('todos');
  const [provisionalACuadrar, setProvisionalACuadrar] = useState(null);
  // ✅ EGRESO-PROV-001: anticipo preseleccionado al abrir "nuevo egreso"
  const [provisionalALegalizar, setProvisionalALegalizar] = useState(null);

  // ✅ EGRESO-VISUAL-001 · EGRESO-RECLASIFICAR-001 · EGRESO-VEHICULO-001
  const [vehiculos, setVehiculos]           = useState([]);
  const [consumoVehiculos, setConsumoVehiculos] = useState(null);
  const [ingresosPeriodo, setIngresosPeriodo]   = useState(0);
  const [ingresosPorMes, setIngresosPorMes]     = useState({});
  const [seleccionados, setSeleccionados]   = useState([]);   // ids para reclasificar en lote
  const [modalReclasificar, setModalReclasificar] = useState(false);
  const [ordenes, setOrdenes]               = useState([]);   // ventas, para Ingresos vs Gastos
  // ✅ NOMINA-PROVISIONES-001: para detectar si el tercero es un empleado
  const [empleados, setEmpleados]           = useState([]);
  // ✅ EGRESO-EDICION-002 · EGRESO-RECLASIFICAR-001 · EGRESO-INTELIGENTE-001
  const [modalHistorial, setModalHistorial] = useState(null);
  const [modalLotes, setModalLotes]         = useState(false);
  const [revisandoHistoricos, setRevisando] = useState(false);

  useEffect(() => { cargarDatos(); }, []);

  const getHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

  // ✅ EGRESO-PROV-001: un anticipo está PENDIENTE si no fue legalizado.
  // Se revisan las dos banderas: `legalizado` (nueva) y `cuadrado` (Ola 2),
  // para que los documentos históricos se comporten igual que los nuevos.
  const esAnticipoPendiente = (e) =>
    e.tipo === 'provisional' && e.legalizado !== true && e.cuadrado !== true && e.anulado !== true;

  const cargarDatos = async () => {
    setLoading(true);
    try {
      const h = getHeaders();
      const [eRes, cRes, empRes, configRes, usersRes, vehRes, ordRes, emplRes] = await Promise.all([
        axios.get(`${API}/egresos`, { headers: h }).catch(() => ({ data: [] })),
        axios.get(`${API}/cajas`, { headers: h }).catch(() => ({ data: [] })),
        axios.get(`${API}/companies`, { headers: h }).catch(() => ({ data: [] })),
        axios.get(`${API}/configuracion`, { headers: h }).catch(() => ({ data: {} })),
        axios.get(`${API}/users`, { headers: h }).catch(() => ({ data: [] })),
        // ✅ EGRESO-VEHICULO-001 · si el endpoint aún no existe, degrada a lista vacía
        axios.get(`${API}/vehiculos`, { headers: h }).catch(() => ({ data: [] })),
        // ✅ EGRESO-VISUAL-001 · órdenes para el comparativo Ingresos vs Gastos
        axios.get(`${API}/orders`, { headers: h }).catch(() => ({ data: [] })),
        // ✅ NOMINA-PROVISIONES-001 · empleados, para detectar anticipos
        axios.get(`${API}/empleados`, { headers: h }).catch(() => ({ data: [] })),
      ]);
      setEgresos(Array.isArray(eRes.data) ? eRes.data : []);
      setVehiculos(Array.isArray(vehRes.data) ? vehRes.data : []);
      setEmpleados(Array.isArray(emplRes.data) ? emplRes.data : []);

      // ✅ EGRESO-VISUAL-001: ingresos agrupados por mes para la gráfica de
      // evolución. Se calcula acá y no en el backend para no agregar otra
      // consulta: las órdenes ya se traen para el resto del módulo.
      const listaOrdenes = Array.isArray(ordRes.data) ? ordRes.data : (ordRes.data?.orders || []);
      setOrdenes(listaOrdenes);
      const porMes = {};
      for (const o of listaOrdenes) {
        if (o.anulada === true || o.estado === 'ANULADA') continue;
        const f = String(o.fecha || o.fechaCreacion || o.createdAt || '').slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(f)) continue;
        porMes[f] = (porMes[f] || 0) + (Number(o.total || o.totalOrden || o.valorTotal) || 0);
      }
      setIngresosPorMes(porMes);
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
      // ✅ EGRESO-NUM-002: sin `numero` — lo asigna el backend
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
      // ✅ EGRESO-NUM-002: pintamos el documento que devuelve el backend
      // (numero, estado y banderas reales), no el objeto local optimista.
      const creado = { ...nuevo, ...(res.data || {}), id: res.data?.id || 'local-' + Date.now() };
      setEgresos(p => [creado, ...p]);

      // ✅ EGRESO-PROV-001: si legalizó un anticipo, recargamos para que el
      // comprobante salga de "Provisionales pendientes" y la caja quede al día.
      if (nuevo.provisionalId) {
        const L = res.data?.legalizacion;
        if (L) {
          alert(
            `✅ ${creado.numero} legaliza el anticipo ${L.provisionalNumero}\n\n` +
            `Anticipo entregado: ${fmt(L.base)}\n` +
            `Gasto real: ${fmt(L.real)}\n` +
            (L.diferencia > 0 ? `Vuelto reintegrado a caja: ${fmt(L.diferencia)}`
             : L.diferencia < 0 ? `Salida adicional de caja: ${fmt(Math.abs(L.diferencia))}`
             : 'Sin diferencia: el anticipo cuadró exacto.')
          );
        }
        await cargarDatos();
      }

      if (res.data?.alertasMargen?.length > 0) {
        setModal(null);
        return res.data;
      }
    } catch (e) {
      // ✅ EGRESO-PROV-001: una legalización NUNCA debe fingir éxito local —
      // mueve plata en caja. Si falla, se muestra el error y no se pinta nada.
      const msg = e.response?.data?.error || e.message;
      if (nuevo.provisionalId) { alert('No se pudo legalizar: ' + msg); setModal(null); return {}; }
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

  // FIX PIN-UNICO-001: el body ahora incluye `pin`. Antes el backend lo exigia
  // y el frontend no lo mandaba -> siempre respondia "PIN requerido".
  const editarPagado = async (form, motivo, pin) => {
    // ✅ EGRESO-EDICION-002: se envían explícitamente los campos editables.
    // Antes se hacía spread de todo el formulario, lo que mandaba también
    // campos internos (numero, userId, createdAt, calidad...) que el backend
    // ignora pero que ensucian el payload. Ahora es una lista cerrada.
    const update = {
      concepto:  form.concepto,
      proveedor: form.proveedor,
      categoria: form.categoria,
      fecha:     form.fecha,
      // ✅ CAUSACION-001: el mes al que pertenece el gasto, independiente del pago
      fechaCausacion: form.fechaCausacion || form.fecha,
      monto:     Number(form.monto) || 0,
      ivaVal:    Number(form.ivaVal) || 0,
      ivaPct:    Number(form.ivaPct) || 0,
      retenVal:  Number(form.retenVal) || 0,
      retenPct:  Number(form.retenPct) || 0,
      formaPago: form.formaPago,
      cajaId:    form.cajaId,
      empresaId: form.empresaId,
      notas:     form.notas,
      vehiculoId:    form.vehiculoId || '',
      vehiculoPlaca: form.vehiculoPlaca || '',
      // ✅ FIX NOMINA-ANTICIPO-EDICION-001: el backend siempre aceptó estos
      // campos, pero la lista cerrada del payload no los incluía. Un anticipo
      // mal registrado no se podía corregir nunca.
      esAnticipoNomina:  form.esAnticipoNomina === true,
      empleadoId:        form.empleadoId || '',
      empleadoNombre:    form.empleadoNombre || '',
      empleadoDocumento: form.empleadoDocumento || '',
      motivoEdicion: motivo,
      editadoPor: user?.email,
      pin
    };
    // FIX: el backend define POST (no PUT) para /editar-pagado. Mismo bug
    // que pagarEgreso. Ahora espera respuesta, si falla muestra error.
    try {
      const res = await axios.post(`${API}/egresos/${selected.id}/editar-pagado`, update, { headers: getHeaders() });
      // El PIN no debe quedar guardado en el estado de la lista.
      const { pin: _omitirPin, ...updateUI } = update;
      // El backend devuelve el totalPagar recalculado y la marca de calidad:
      // se toman de la respuesta para que la tabla quede igual que la BD.
      setEgresos(p => p.map(e => e.id === selected.id
        ? { ...e, ...updateUI, totalPagar: res.data?.totalPagar ?? e.totalPagar, calidad: res.data?.calidad ?? e.calidad }
        : e));
      setModal(null); setSelected(null);
      // Si la caja cambió de saldo, hay que refrescar para no mostrar un saldo viejo
      await cargarDatos();
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
    // ✅ EGRESO-VEHICULO-001: 'sin' aísla los gastos que todavía no tienen placa
    if (filtros.vehiculo === 'sin' && e.vehiculoId) return false;
    if (filtros.vehiculo !== 'todos' && filtros.vehiculo !== 'sin' && e.vehiculoId !== filtros.vehiculo) return false;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // ✅ EGRESO-VISUAL-001 — Datos derivados para el panel de análisis
  // ═══════════════════════════════════════════════════════════════════════════

  // Ingresos del mismo período que los egresos filtrados. Se usa el rango de
  // fechas del filtro; si no hay rango, se toma todo.
  const ingresosDelPeriodo = useMemo(() => {
    return ordenes.reduce((a, o) => {
      if (o.anulada === true || o.estado === 'ANULADA') return a;
      const f = String(o.fecha || o.fechaCreacion || o.createdAt || '').slice(0, 10);
      if (filtros.desde && f && f < filtros.desde) return a;
      if (filtros.hasta && f && f > filtros.hasta) return a;
      return a + (Number(o.total || o.totalOrden || o.valorTotal) || 0);
    }, 0);
  }, [ordenes, filtros.desde, filtros.hasta]);

  // Etiqueta legible del período — se usa en los títulos de las gráficas
  const etiquetaPeriodo = useMemo(() => {
    if (filtros.desde && filtros.hasta) {
      const d = new Date(filtros.desde + 'T00:00:00');
      const h = new Date(filtros.hasta + 'T00:00:00');
      const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      // Mismo mes completo → "de julio 2026"
      if (d.getMonth() === h.getMonth() && d.getFullYear() === h.getFullYear()) {
        return `de ${MESES_L[d.getMonth()]} ${d.getFullYear()}`;
      }
      return `del ${filtros.desde} al ${filtros.hasta}`;
    }
    if (filtros.desde) return `desde ${filtros.desde}`;
    if (filtros.hasta) return `hasta ${filtros.hasta}`;
    return 'del histórico';
  }, [filtros.desde, filtros.hasta]);

  // Consumo por vehículo — se recarga cuando cambia el rango de fechas
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (filtros.desde) params.set('desde', filtros.desde);
        if (filtros.hasta) params.set('hasta', filtros.hasta);
        const res = await axios.get(`${API}/vehiculos/consumo?${params}`, { headers: getHeaders() });
        if (vivo) setConsumoVehiculos(res.data);
      } catch {
        if (vivo) setConsumoVehiculos({ vehiculos: [], sinAsignar: { total: 0, cantidad: 0, detalle: [] }, trazabilidad: 100, totalGeneral: 0 });
      }
    })();
    return () => { vivo = false; };
  }, [filtros.desde, filtros.hasta]);

  // ═══════════════════════════════════════════════════════════════════════════
  // ✅ EGRESO-INTELIGENTE-001 — Auditoría de calidad del período (en cliente)
  // ─────────────────────────────────────────────────────────────────────────
  // Se corre localmente sobre los egresos ya cargados: no agrega una llamada
  // más y responde al instante cuando cambia el filtro. El backend tiene el
  // mismo cálculo en /api/egresos/calidad para usos server-side.
  // ═══════════════════════════════════════════════════════════════════════════
  const auditoriaCalidad = useMemo(() => {
    const validos = egresosFiltered.filter(e => e.anulado !== true);
    const porRegla = {};
    let conAlerta = 0, graves = 0;

    for (const e of validos) {
      const meta = categoriasMeta.find(c => normTxt(c.nombre) === normTxt(e.categoria)) || null;
      const r = validarEgreso(e, {
        categoriaMeta: meta,
        categoriasValidas: categorias,
        egresosRecientes: validos
      });
      if (!r.alertas.length) continue;
      conAlerta += 1;
      graves += r.conteo.graves;
      for (const a of r.alertas) {
        if (!porRegla[a.id]) porRegla[a.id] = { ...a, cantidad: 0, valor: 0, egresos: [] };
        porRegla[a.id].cantidad += 1;
        porRegla[a.id].valor += Number(e.totalPagar || e.monto) || 0;
        if (porRegla[a.id].egresos.length < 50) porRegla[a.id].egresos.push(e);
      }
    }

    const peso = { grave: 0, media: 1, leve: 2 };
    return {
      total: validos.length,
      conAlerta,
      graves,
      puntaje: validos.length > 0 ? Math.round((validos.length - conAlerta) / validos.length * 100) : 100,
      ranking: Object.values(porRegla).sort((a, b) =>
        peso[a.severidad] - peso[b.severidad] || b.cantidad - a.cantidad)
    };
  }, [egresosFiltered, categoriasMeta, categorias]);

  // ═══════════════════════════════════════════════════════════════════════════
  // ✅ EGRESO-RECLASIFICAR-001 — Selección múltiple
  // ═══════════════════════════════════════════════════════════════════════════
  const toggleSeleccion = (id) =>
    setSeleccionados(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const seleccionarTodos = () => {
    const ids = egresosFiltered.filter(e => e.anulado !== true).map(e => e.id);
    setSeleccionados(p => p.length === ids.length ? [] : ids);
  };

  const egresosSeleccionados = useMemo(
    () => egresosFiltered.filter(e => seleccionados.includes(e.id)),
    [egresosFiltered, seleccionados]
  );

  const reclasificarLote = async ({ ids, categoriaDestino, motivo, pin }) => {
    const res = await axios.post(`${API}/egresos/reclasificar-lote`,
      { ids, categoriaDestino, motivo, pin }, { headers: getHeaders() });
    const d = res.data;
    setEgresos(p => p.map(e => ids.includes(e.id) ? { ...e, categoria: d.categoriaDestino } : e));
    setSeleccionados([]);
    setModalReclasificar(false);
    alert(
      `✅ Reclasificación completa\n\n` +
      `${d.reclasificados} egreso(s) por ${fmt(d.valorTotal)} → "${d.categoriaDestino}"\n` +
      (d.omitidos?.length ? `${d.omitidos.length} omitido(s)\n` : '') +
      `\nLote: ${d.loteId}\nSe puede revertir completo desde Auditoría.`
    );
    await cargarDatos();
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>⏳ Cargando egresos...</div>;

  return (
    <div style={S.page}>
      <div style={S.pageHeader}>
        <div>
          <h2 style={S.pageTitle}>📤 Egresos</h2>
          <p style={S.pageSubtitle}>Gastos operativos · IVA descontable · Retenciones · Auditoría</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => exportarExcel(egresosFiltered.map(e => ({
            ...e,
            // Campos derivados para el Excel — se calculan acá porque el
            // exportador solo lee propiedades planas del objeto.
            _anticipo: e.esAnticipoNomina ? (e.cruzadoEnNomina ? 'Sí · cruzado' : 'Sí · pendiente') : '',
            _calidad: e.calidad?.cantidad ? e.calidad.resumen : ''
          })), [
            { key: 'numero', label: 'N°' }, { key: 'fecha', label: 'Fecha' },
            { key: 'concepto', label: 'Concepto' }, { key: 'proveedor', label: 'Proveedor' },
            { key: 'categoria', label: 'Categoría' }, { key: 'formaPago', label: 'Forma Pago' },
            { key: 'monto', label: 'Base' }, { key: 'ivaPct', label: 'IVA %' },
            { key: 'ivaVal', label: 'IVA $' }, { key: 'retenPct', label: 'Ret %' },
            { key: 'retenVal', label: 'Ret $' }, { key: 'totalPagar', label: 'Total pagado' },
            { key: 'estado', label: 'Estado' },
            // ✅ EGRESO-VEHICULO-001 · EGRESO-INTELIGENTE-001 · NOMINA-PROVISIONES-001
            // El Excel es el soporte que se le entrega al contador: tiene que
            // llevar la misma información que ve el usuario en pantalla.
            { key: 'vehiculoPlaca', label: 'Placa' },
            { key: 'empleadoNombre', label: 'Empleado' },
            { key: '_anticipo', label: 'Anticipo nómina' },
            { key: '_calidad', label: 'Observaciones' },
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

        {/* ✅ EGRESO-VISUAL-001: panel de análisis. Se pone SEGUNDO y no primero
            a propósito — quien entra a Egresos suele venir a digitar, no a
            analizar. El análisis está a un clic, no en el camino. */}
        <button onClick={() => setTab('analisis')}
          style={{
            padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: 600,
            color: tab === 'analisis' ? '#4f46e5' : '#6b7280',
            borderBottom: tab === 'analisis' ? '2px solid #4f46e5' : '2px solid transparent',
            marginBottom: -2
          }}>
          📊 Análisis
        </button>

        {/* ✅ EGRESO-INTELIGENTE-001: revisión de calidad. El badge muestra
            cuántos egresos tienen observaciones — si está en rojo, el estado
            de resultados de ese mes no es confiable todavía. */}
        <button onClick={() => setTab('calidad')}
          style={{
            padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: 600,
            color: tab === 'calidad' ? '#dc2626' : '#6b7280',
            borderBottom: tab === 'calidad' ? '2px solid #dc2626' : '2px solid transparent',
            marginBottom: -2,
            display: 'flex', alignItems: 'center', gap: 6
          }}>
          🔍 Revisión
          {auditoriaCalidad.conAlerta > 0 && (
            <span style={{
              background: auditoriaCalidad.graves > 0 ? '#dc2626' : '#d97706',
              color: '#fff', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 700
            }}>{auditoriaCalidad.conAlerta}</span>
          )}
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
            const pend = egresos.filter(esAnticipoPendiente).length; // ✅ EGRESO-PROV-001
            return pend > 0 ? <span style={{ background: '#d97706', color: '#fff', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>{pend}</span> : null;
          })()}
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          ✅ EGRESO-VISUAL-001 — PESTAÑA ANÁLISIS
          ─────────────────────────────────────────────────────────────────────
          Responde de un vistazo "¿por dónde se me está yendo la plata?".
          Usa el MISMO filtro de fechas de la tabla, para que lo que se ve en
          la gráfica y lo que se ve en el listado sean siempre lo mismo.
          ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'analisis' && (
        <div>
          {/* Selector de período rápido */}
          <div style={{
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
            background: '#fff', borderRadius: 12, padding: '12px 16px', marginBottom: 16,
            border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(15,23,42,0.06)'
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>Período:</span>
            <input type="date" style={{ ...S.input, padding: '7px 10px' }} value={filtros.desde} onChange={e => setF('desde', e.target.value)} />
            <span style={{ color: '#cbd5e1' }}>→</span>
            <input type="date" style={{ ...S.input, padding: '7px 10px' }} value={filtros.hasta} onChange={e => setF('hasta', e.target.value)} />
            {[
              { l: 'Este mes', d: 0 },
              { l: 'Mes pasado', d: 1 },
            ].map(op => (
              <button key={op.l} onClick={() => {
                const hoy = new Date();
                const ini = new Date(hoy.getFullYear(), hoy.getMonth() - op.d, 1);
                const fin = new Date(hoy.getFullYear(), hoy.getMonth() - op.d + 1, 0);
                const iso = (x) => x.toLocaleDateString('en-CA');
                setFiltros(f => ({ ...f, desde: iso(ini), hasta: iso(fin) }));
              }} style={{ ...S.btnSecondary, padding: '7px 14px', fontSize: 12 }}>{op.l}</button>
            ))}
            <button onClick={() => setFiltros(f => ({ ...f, desde: '', hasta: '' }))}
              style={{ ...S.btnSecondary, padding: '7px 14px', fontSize: 12 }}>Todo</button>
          </div>

          <EgresosGraficas
            egresos={egresosFiltered}
            egresosTodos={egresos}
            ingresosPeriodo={ingresosDelPeriodo}
            ingresosPorMes={ingresosPorMes}
            categoriasMeta={categoriasMeta}
            consumoVehiculos={consumoVehiculos}
            etiquetaPeriodo={etiquetaPeriodo}
            isMobile={isMobile}
            onVerCategoria={(d) => { setF('categoria', d.label); setTab('todos'); }}
          />
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          ✅ EGRESO-INTELIGENTE-001 — PESTAÑA REVISIÓN DE CALIDAD
          ─────────────────────────────────────────────────────────────────────
          Antes de creerle al estado de resultados, esta pantalla responde
          "¿qué tan confiable es la información de este mes?". Agrupa por tipo
          de problema para poder corregir en lote, no de a uno.
          ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'calidad' && (
        <div>
          {/* Puntaje */}
          <div style={{
            background: '#fff', borderRadius: 16, padding: '20px 24px', marginBottom: 16,
            border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(15,23,42,0.06)',
            display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap'
          }}>
            <div style={{ textAlign: 'center', minWidth: 108 }}>
              <div style={{
                fontSize: 46, fontWeight: 900, lineHeight: 1,
                color: auditoriaCalidad.puntaje >= 90 ? '#16a34a'
                     : auditoriaCalidad.puntaje >= 70 ? '#d97706' : '#dc2626'
              }}>{auditoriaCalidad.puntaje}%</div>
              <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 4 }}>
                Sin observaciones
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', marginBottom: 5 }}>
                Confiabilidad de la información {etiquetaPeriodo}
              </div>
              <div style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.6 }}>
                De <strong>{auditoriaCalidad.total}</strong> egresos revisados,{' '}
                <strong style={{ color: auditoriaCalidad.conAlerta ? '#dc2626' : '#16a34a' }}>
                  {auditoriaCalidad.conAlerta}
                </strong>{' '}
                tienen alguna observación
                {auditoriaCalidad.graves > 0 && <>, de los cuales <strong style={{ color: '#dc2626' }}>{auditoriaCalidad.graves}</strong> son errores contables probables</>}.
                {auditoriaCalidad.conAlerta === 0 && ' Toda la información del período está limpia.'}
              </div>
            </div>

            {/* ✅ EGRESO-INTELIGENTE-001: revisión retroactiva.
                Esta pantalla evalúa en vivo, pero los egresos anteriores al
                motor de reglas no tienen la marca guardada, así que no muestran
                el ícono de alerta en el listado. Este botón corre el motor sobre
                el histórico y deja la marca. No modifica ningún valor. */}
            {user?.role === 'admin' && (
              <button
                onClick={async () => {
                  if (!window.confirm(
                    'Revisar los egresos del período con el motor de reglas.\n\n' +
                    'Esto NO modifica ningún valor: solo evalúa cada egreso y guarda las observaciones ' +
                    'para que aparezcan marcadas en el listado.\n\n' +
                    'Sirve para los egresos registrados antes de que existieran las validaciones.'
                  )) return;
                  setRevisando(true);
                  try {
                    const r = await axios.post(`${API}/egresos/calidad/marcar-historicos`,
                      { desde: filtros.desde || undefined, hasta: filtros.hasta || undefined, soloFaltantes: false },
                      { headers: getHeaders() });
                    alert(`✅ ${r.data.mensaje}\n\nLimpios: ${r.data.limpios}\nCon observaciones: ${r.data.conAlerta}` +
                          (r.data.graves ? `\nGraves: ${r.data.graves}` : ''));
                    await cargarDatos();
                  } catch (e) {
                    alert('No se pudo completar la revisión: ' + (e.response?.data?.error || e.message));
                  }
                  setRevisando(false);
                }}
                disabled={revisandoHistoricos}
                style={{ ...S.btnSecondary, padding: '9px 16px', fontSize: 12, whiteSpace: 'nowrap' }}>
                {revisandoHistoricos ? 'Revisando...' : '🔄 Revisar el histórico'}
              </button>
            )}
          </div>

          {/* Ranking de problemas */}
          {auditoriaCalidad.ranking.length === 0 ? (
            <div style={{
              background: '#f0fdf4', border: '1px solid #dcfce7', borderRadius: 16,
              padding: 40, textAlign: 'center', color: '#15803d', fontSize: 14, fontWeight: 600
            }}>
              ✅ No se detectaron problemas de digitación en este período.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {auditoriaCalidad.ranking.map(r => {
                const s = ESTILO_SEVERIDAD[r.severidad] || ESTILO_SEVERIDAD.leve;
                return (
                  <div key={r.id} style={{
                    background: '#fff', borderRadius: 14, border: '1px solid #f1f5f9',
                    borderLeft: `4px solid ${s.tx}`, padding: '15px 18px',
                    boxShadow: '0 1px 3px rgba(15,23,42,0.06)'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 240 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {s.ic} {r.titulo}
                          <span style={{
                            fontSize: 9, fontWeight: 800, background: s.bg, color: s.tx,
                            border: `1px solid ${s.bd}`, borderRadius: 20, padding: '2px 8px',
                            textTransform: 'uppercase', letterSpacing: '.04em'
                          }}>{s.et}</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 6, lineHeight: 1.55 }}>{r.detalle}</div>
                        {r.sugerencia && (
                          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 4, fontStyle: 'italic' }}>→ {r.sugerencia}</div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right', minWidth: 130 }}>
                        <div style={{ fontSize: 22, fontWeight: 900, color: s.tx }}>{r.cantidad}</div>
                        <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase' }}>egreso(s)</div>
                        <div style={{ fontSize: 12.5, fontWeight: 800, color: '#334155', marginTop: 4 }}>{fmt(r.valor)}</div>
                      </div>
                    </div>

                    {/* Acción directa: seleccionar todos los afectados y reclasificar */}
                    <div style={{ marginTop: 12, paddingTop: 11, borderTop: '1px solid #f8fafc', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => { setSeleccionados(r.egresos.map(e => e.id)); setTab('todos'); }}
                        style={{ ...S.btnSecondary, padding: '6px 13px', fontSize: 11.5 }}>
                        👁 Ver los {Math.min(r.cantidad, 50)} egresos
                      </button>
                      {r.egresos.length > 1 && (
                        <button
                          onClick={() => { setSeleccionados(r.egresos.map(e => e.id)); setModalReclasificar(true); }}
                          style={{ ...S.btnSecondary, padding: '6px 13px', fontSize: 11.5, background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe' }}>
                          🔀 Reclasificar en lote
                        </button>
                      )}
                    </div>

                    {/* Muestra de los primeros afectados */}
                    <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {r.egresos.slice(0, 8).map(e => (
                        <span key={e.id} style={{
                          fontSize: 10.5, background: '#f8fafc', border: '1px solid #f1f5f9',
                          borderRadius: 6, padding: '3px 8px', color: '#64748b'
                        }}>
                          {e.numero} · {fmt(e.totalPagar || e.monto)}
                        </span>
                      ))}
                      {r.cantidad > 8 && (
                        <span style={{ fontSize: 10.5, color: '#cbd5e1', padding: '3px 4px' }}>
                          +{r.cantidad - 8} más
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── VISTA PROVISIONALES (Ola 2) ──────────────────────────────────────── */}
      {tab === 'provisionales' && (() => {
        const provisionales = egresos
          .filter(esAnticipoPendiente) // ✅ EGRESO-PROV-001
          .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        return (
          <div>
            <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', padding: '14px 18px', borderRadius: 10, marginBottom: 16, fontSize: 13, color: '#92400e' }}>
              {/* ✅ EGRESO-PROV-001 */}
              <strong>¿Qué son los egresos provisionales?</strong> Son <strong>anticipos</strong>: le entregas plata al mensajero
              para un mandado. Sale de caja de una vez, pero <strong>no cuenta como gasto</strong> (no suma al ERI ni a la utilidad).
              Cuando vuelve con la factura, presiona <strong>"Legalizar con factura"</strong>: se abre el formulario normal de egreso —
              con IVA, retención y proveedor — y a caja solo se mueve la diferencia (vuelto o faltante). El anticipo no se borra:
              queda cerrado y enlazado al egreso definitivo.
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
                          {/* ✅ EGRESO-PROV-001: ruta principal — legalizar con
                              el formulario completo (IVA / retención / proveedor) */}
                          <button onClick={() => { setProvisionalALegalizar(eg); setModal('nuevo'); }}
                            style={{ padding: '6px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                            ✓ Legalizar con factura
                          </button>
                          {/* Ruta rápida heredada (Ola 2): sin IVA ni retención */}
                          <button onClick={() => setProvisionalACuadrar(eg)} title="Cuadre rápido sin IVA ni retención"
                            style={{ padding: '6px 10px', marginLeft: 6, background: '#f3f4f6', color: '#6b7280', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                            ⚡ Rápido
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
        {/* ✅ EGRESO-VEHICULO-001: filtro por placa. La opción "sin placa" es la
            más útil: aísla de una vez los gastos que falta atribuir. */}
        {vehiculos.length > 0 && (
          <select style={{ ...S.select, maxWidth: 190 }} value={filtros.vehiculo} onChange={e => setF('vehiculo', e.target.value)}>
            <option value="todos">Todos los vehículos</option>
            <option value="sin">⚠️ Sin placa asignada</option>
            {vehiculos.filter(v => v.activo !== false).map(v => (
              <option key={v.id} value={v.id}>{v.placa} · {v.tipo}</option>
            ))}
          </select>
        )}
        <input type="date" style={{ ...S.input, maxWidth: 150 }} value={filtros.desde} onChange={e => setF('desde', e.target.value)} title="Desde" />
        <input type="date" style={{ ...S.input, maxWidth: 150 }} value={filtros.hasta} onChange={e => setF('hasta', e.target.value)} title="Hasta" />
        {(filtros.desde || filtros.hasta || filtros.busca || filtros.estado !== 'todos' || filtros.categoria !== 'todos' || filtros.vehiculo !== 'todos') && (
          <button onClick={() => setFiltros({ estado: 'todos', categoria: 'todos', vehiculo: 'todos', busca: '', desde: '', hasta: '' })}
            style={{ padding: '8px 14px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>✕ Limpiar</button>
        )}

        {/* ✅ EGRESO-RECLASIFICAR-001: acceso al historial de lotes */}
        {user?.role === 'admin' && (
          <button onClick={() => setModalLotes(true)}
            style={{ ...S.btnSecondary, padding: '8px 14px', fontSize: 12, marginLeft: 'auto' }}
            title="Ver y revertir reclasificaciones masivas">
            🔀 Reclasificaciones
          </button>
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
              <div key={eg.id} style={{
                background: seleccionados.includes(eg.id) ? '#eef2ff' : '#fff',
                borderRadius: 12,
                border: seleccionados.includes(eg.id) ? '1px solid #c7d2fe' : '1px solid #e5e7eb',
                padding: 14, borderLeft: `4px solid ${esPagado ? '#22c55e' : '#f59e0b'}`
              }}>
                {/* Cabecera: número + estado */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    {/* ✅ EGRESO-RECLASIFICAR-001: selección múltiple también en
                        móvil. Antes solo estaba en la tabla de escritorio, así
                        que desde el celular no se podía reclasificar en lote. */}
                    {user?.role === 'admin' && (
                      <input type="checkbox"
                        checked={seleccionados.includes(eg.id)}
                        disabled={eg.anulado === true}
                        onChange={() => toggleSeleccion(eg.id)}
                        style={{ cursor: 'pointer', width: 17, height: 17, flexShrink: 0 }} />
                    )}
                    <span style={S.badge}>{eg.numero || 'EGR-?'}</span>
                    {/* Marcas de calidad y reclasificación */}
                    {eg.calidad?.graves > 0 && <span title={eg.calidad.resumen} style={{ fontSize: 12 }}>🚨</span>}
                    {eg.calidad?.graves === 0 && eg.calidad?.cantidad > 0 && <span title={eg.calidad.resumen} style={{ fontSize: 12 }}>⚠️</span>}
                    {eg.reclasificacion && eg.reclasificacion.revertido !== true && <span title="Reclasificado" style={{ fontSize: 11 }}>🔀</span>}
                  </span>
                  {/* ✅ EGRESO-PROV-001: badge de anticipo también en móvil */}
                  {esAnticipoPendiente(eg) ? (
                    <span style={{ ...S.estadoBadge, background: '#ffedd5', color: '#9a3412', border: '1px solid #fdba74' }}>💵 ANTICIPO</span>
                  ) : (
                  <span style={{ ...S.estadoBadge, background: esPagado ? '#dcfce7' : '#fef3c7', color: esPagado ? '#166534' : '#92400e', border: `1px solid ${esPagado ? '#bbf7d0' : '#fde68a'}` }}>
                    {esPagado ? '✅ PAGADO' : '⏳ PENDIENTE'}
                  </span>
                  )}
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
                    {/* ✅ EGRESO-EDICION-002: consultar el rastro de cambios.
                        La auditoría ya se guardaba, pero no había cómo verla. */}
                    <button onClick={() => setModalHistorial(eg)} style={S.actionBtn} title="Ver historial de cambios">📜</button>
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
                {/* ✅ EGRESO-RECLASIFICAR-001: selección múltiple */}
                <th style={{ ...S.th, width: 34, paddingRight: 0 }}>
                  <input type="checkbox"
                    checked={seleccionados.length > 0 && seleccionados.length === egresosFiltered.filter(e => e.anulado !== true).length}
                    onChange={seleccionarTodos}
                    title="Seleccionar todos los filtrados"
                    style={{ cursor: 'pointer', width: 15, height: 15 }} />
                </th>
                {['N°', 'Concepto', 'Proveedor', 'Categoría', 'Fecha', 'Base', 'IVA', 'Retención', 'Total', 'Estado', 'Acciones'].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {egresosFiltered.length === 0 && (
                <tr><td colSpan={12} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>No hay egresos con los filtros seleccionados</td></tr>
              )}
              {egresosFiltered.map(eg => (
                <tr key={eg.id} style={{
                  ...S.tr,
                  background: seleccionados.includes(eg.id) ? '#eef2ff' : undefined
                }}>
                  <td style={{ ...S.td, paddingRight: 0 }}>
                    <input type="checkbox"
                      checked={seleccionados.includes(eg.id)}
                      disabled={eg.anulado === true}
                      onChange={() => toggleSeleccion(eg.id)}
                      style={{ cursor: 'pointer', width: 15, height: 15 }} />
                  </td>
                  <td style={S.td}>
                    <span style={S.badge}>{eg.numero || 'EGR-?'}</span>
                    {/* ✅ EGRESO-INTELIGENTE-001: marca visible de que el egreso
                        se guardó con observaciones sin abrir nada */}
                    {eg.calidad?.graves > 0 && (
                      <span title={eg.calidad.resumen} style={{ marginLeft: 5, fontSize: 12, cursor: 'help' }}>🚨</span>
                    )}
                    {eg.calidad?.graves === 0 && eg.calidad?.cantidad > 0 && (
                      <span title={eg.calidad.resumen} style={{ marginLeft: 5, fontSize: 12, cursor: 'help' }}>⚠️</span>
                    )}
                    {/* ✅ EGRESO-RECLASIFICAR-001: marca de reclasificado */}
                    {eg.reclasificacion && eg.reclasificacion.revertido !== true && (
                      <span title={`Reclasificado desde "${eg.reclasificacion.categoriaAnterior}" · ${eg.reclasificacion.motivo}`}
                        style={{ marginLeft: 5, fontSize: 11, cursor: 'help' }}>🔀</span>
                    )}
                  </td>
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
                    {/* ✅ EGRESO-PROV-001: el ANTICIPO tiene estado propio —
                        la plata salió de caja pero todavía NO es gasto. */}
                    {esAnticipoPendiente(eg) ? (
                      <span style={{ ...S.estadoBadge, background: '#ffedd5', color: '#9a3412', border: '1px solid #fdba74' }}>💵 ANTICIPO</span>
                    ) : (
                    <span style={{ ...S.estadoBadge, background: eg.estado === 'PAGADO' ? '#dcfce7' : eg.estado === 'ANULADO' ? '#f3f4f6' : '#fef3c7', color: eg.estado === 'PAGADO' ? '#166534' : eg.estado === 'ANULADO' ? '#6b7280' : '#92400e', border: `1px solid ${eg.estado === 'PAGADO' ? '#bbf7d0' : eg.estado === 'ANULADO' ? '#d1d5db' : '#fde68a'}` }}>
                      {eg.estado === 'PAGADO' ? '✅ PAGADO' : eg.estado === 'ANULADO' ? '❌ ANULADO' : '⏳ PENDIENTE'}
                    </span>
                    )}
                  </td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    {/* ✅ EGRESO-PROV-001: un anticipo NO se paga (la plata ya
                        salió). Se legaliza registrando el egreso con factura. */}
                    {esAnticipoPendiente(eg) && (
                      <button onClick={() => { setProvisionalALegalizar(eg); setModal('nuevo'); }}
                        style={{ ...S.actionBtn, background: '#ffedd5', color: '#9a3412', fontWeight: 700 }}>💵 Legalizar</button>
                    )}
                    {!esAnticipoPendiente(eg) && eg.estado === 'PENDIENTE' && <>
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
                    {/* ✅ EGRESO-EDICION-002: consultar el rastro de cambios.
                        La auditoría ya se guardaba, pero no había cómo verla. */}
                    <button onClick={() => setModalHistorial(eg)} style={S.actionBtn} title="Ver historial de cambios">📜</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>}
      {/* ── Fin vista normal ─────────────────────────────────────────────── */}

      {/* ✅ EGRESO-INTELIGENTE-001 · EGRESO-VEHICULO-001: el modal de alta ahora
          recibe el mapa de tipoERI (para saber si una categoría es de personal),
          los vehículos (para el selector de placa) y los egresos recientes
          (para detectar pagos duplicados). */}
      {modal === 'nuevo' && <ModalEgreso empresas={empresas} cajas={cajas} formasPago={formasPago} formasPagoConfig={formasPagoConfig} categoriasList={categorias}
        categoriasMeta={categoriasMeta} vehiculos={vehiculos} egresosRecientes={egresos} empleados={empleados} onNavegar={onNavegar}
        provisionales={egresos.filter(esAnticipoPendiente)}
        provisionalInicial={provisionalALegalizar}
        onSave={crearEgreso} onClose={() => { setModal(null); setProvisionalALegalizar(null); }} />}
      {modal === 'editar' && selected && <ModalEgreso egreso={{ ...selected, _categorias: categorias }} empresas={empresas} cajas={cajas} formasPago={formasPago} formasPagoConfig={formasPagoConfig} categoriasList={categorias}
        categoriasMeta={categoriasMeta} vehiculos={vehiculos} egresosRecientes={egresos} empleados={empleados} onNavegar={onNavegar}
        onSave={editarEgreso} onClose={() => { setModal(null); setSelected(null); }} />}
      {modal === 'pagar' && selected && <ModalPagar egreso={selected} cajas={cajas} formasPago={formasPago} formasPagoConfig={formasPagoConfig} onPagar={pagarEgreso} onClose={() => { setModal(null); setSelected(null); }} />}
      {/* ✅ EGRESO-EDICION-002: se le pasan el catálogo de categorías, el mapa
          de tipoERI (para validar en vivo) y los vehículos. Sin estos props el
          modal no podía mostrar el selector de categoría — que era justamente
          el campo que hacía falta para corregir los errores de julio. */}
      {modal === 'editarPagado' && selected && (
        <ModalEditarPagado
          egreso={selected}
          categoriasList={categorias}
          categoriasMeta={categoriasMeta}
          vehiculos={vehiculos}
          empleados={empleados}
          onSave={editarPagado}
          onClose={() => { setModal(null); setSelected(null); }} />
      )}
      {modal === 'anular' && selected && <ModalAnularEgreso egreso={selected} onAnular={anularEgreso} onClose={() => { setModal(null); setSelected(null); }} />}

      {/* ✅ EGRESO-RECLASIFICAR-001 */}
      {modalReclasificar && egresosSeleccionados.length > 0 && (
        <ModalReclasificar
          egresos={egresosSeleccionados}
          categoriasList={categorias}
          onConfirmar={reclasificarLote}
          onClose={() => setModalReclasificar(false)} />
      )}

      {/* ✅ EGRESO-EDICION-002: historial de cambios de un egreso */}
      {modalHistorial && (
        <ModalHistorial egreso={modalHistorial} onClose={() => setModalHistorial(null)} />
      )}

      {/* ✅ EGRESO-RECLASIFICAR-001: lotes hechos, con opción de revertir */}
      {modalLotes && (
        <ModalLotes
          onCerrar={() => setModalLotes(false)}
          onRevertido={async () => { await cargarDatos(); }} />
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          ✅ EGRESO-RECLASIFICAR-001 — Barra flotante de selección
          ─────────────────────────────────────────────────────────────────────
          Aparece solo cuando hay egresos marcados. Muestra cuántos y por cuánto
          antes de ofrecer la acción: nadie debería reclasificar 200 registros
          sin ver primero el valor total que está moviendo.
          ═══════════════════════════════════════════════════════════════════ */}
      {seleccionados.length > 0 && tab === 'todos' && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: '#0f172a', color: '#fff', borderRadius: 14, padding: '13px 20px',
          boxShadow: '0 12px 40px rgba(15,23,42,0.35)', zIndex: 900,
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          maxWidth: 'calc(100vw - 32px)'
        }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>
              {seleccionados.length} egreso(s) seleccionado(s)
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
              Total {fmt(egresosSeleccionados.reduce((a, e) => a + (Number(e.totalPagar || e.monto) || 0), 0))}
            </div>
          </div>
          <div style={{ width: 1, height: 30, background: '#334155' }} />
          {user?.role === 'admin' && (
            <button onClick={() => setModalReclasificar(true)}
              style={{
                padding: '9px 17px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
                color: '#fff', border: 'none', borderRadius: 9, fontSize: 12.5,
                fontWeight: 700, cursor: 'pointer'
              }}>
              🔀 Reclasificar categoría
            </button>
          )}
          <button onClick={() => setSeleccionados([])}
            style={{
              padding: '9px 15px', background: 'transparent', color: '#94a3b8',
              border: '1px solid #334155', borderRadius: 9, fontSize: 12.5,
              fontWeight: 600, cursor: 'pointer'
            }}>
            Limpiar
          </button>
        </div>
      )}
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

