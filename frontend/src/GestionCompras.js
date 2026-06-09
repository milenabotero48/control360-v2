import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = v => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);
const hoy = () => new Date().toISOString().slice(0, 10);

// ─── Estilos base ─────────────────────────────────────────────────────────────
const S = {
  wrap:        { padding: '24px', maxWidth: 1100, margin: '0 auto', fontFamily: "'Inter', sans-serif" },
  header:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  titulo:      { fontSize: 22, fontWeight: 800, color: '#1e293b', margin: 0 },
  subtitulo:   { fontSize: 13, color: '#64748b', marginTop: 2 },
  btnPrimario: { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 20px', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  btnSecundario:{ background: '#f1f5f9', color: '#374151', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 20px', fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  btnVerde:    { background: '#16a34a', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 20px', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  btnRojo:     { background: '#dc2626', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 20px', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  card:        { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 24, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
  label:       { fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 4, display: 'block', textTransform: 'uppercase', letterSpacing: '0.5px' },
  input:       { width: '100%', border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '9px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box', color: '#1e293b' },
  select:      { width: '100%', border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '9px 12px', fontSize: 14, outline: 'none', boxSizing: 'border-box', color: '#1e293b', background: '#fff' },
  row2:        { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 },
  row3:        { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 },
  field:       { display: 'flex', flexDirection: 'column' },
  badge:       (color) => ({ background: color + '18', color, borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 700 }),
  pasoActivo:  { background: '#7c3aed', color: '#fff', borderRadius: '50%', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13 },
  pasoInact:   { background: '#e2e8f0', color: '#94a3b8', borderRadius: '50%', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13 },
  pasoDone:    { background: '#16a34a', color: '#fff', borderRadius: '50%', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13 },
  tabla:       { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:          { padding: '10px 12px', background: '#f8fafc', color: '#64748b', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid #e2e8f0', textAlign: 'left' },
  td:          { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', color: '#1e293b', verticalAlign: 'middle' },
  alerta:      { background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#92400e', marginBottom: 16 },
  exito:       { background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '16px', fontSize: 14, color: '#166534', marginBottom: 16 },
  error:       { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#991b1b', marginBottom: 16 },
};

// ─── PASOS del wizard ─────────────────────────────────────────────────────────
const PASOS = [
  { num: 1, label: 'Origen' },
  { num: 2, label: 'Cabecera' },
  { num: 3, label: 'Mapeo' },
  { num: 4, label: 'Retenciones' },
  { num: 5, label: 'Confirmar' },
];

const TIPOS_RETENCION = [
  { value: 'retefuente', label: 'Retefuente', pctDefault: 3.5 },
  { value: 'reteiva',    label: 'ReteIVA',    pctDefault: 15 },
  { value: 'reteica',    label: 'ReteICA',    pctDefault: 0.414 },
];

// ─── Componente principal ────────────────────────────────────────────────────
export default function GestionCompras({ user }) {
  const token   = localStorage.getItem('token');
  const headers = { Authorization: 'Bearer ' + token };

  // Vista: 'lista' | 'nueva' | 'detalle'
  const [vista, setVista]           = useState('lista');
  const [compras, setCompras]       = useState([]);
  const [cargando, setCargando]     = useState(false);
  const [error, setError]           = useState('');
  const [exito, setExito]           = useState('');
  const [detalle, setDetalle]       = useState(null);

  // Wizard
  const [paso, setPaso]             = useState(1);
  const [origen, setOrigen]         = useState('xml'); // 'xml' | 'manual'
  const [xmlTexto, setXmlTexto]     = useState('');
  const [xmlNombre, setXmlNombre]   = useState('');
  const [parseando, setParseando]   = useState(false);
  const xmlRef                      = useRef(null);

  // Datos cabecera
  const [cabecera, setCabecera]     = useState({
    proveedorId: '', proveedorNombre: '', proveedorNit: '',
    numeroFactura: '', fechaFactura: hoy(),
    subtotal: 0, totalIVA: 0, totalBruto: 0
  });

  // Lineas
  const [lineas, setLineas]         = useState([]);

  // Mapeo: modal de asignación
  const [lineaMapeo, setLineaMapeo] = useState(null); // índice de la linea en mapeo
  const [buscarProd, setBuscarProd] = useState('');
  const [productos, setProductos]   = useState([]);
  const [modoCrear, setModoCrear]   = useState(false);
  const [prodNuevo, setProdNuevo]   = useState({ nombre: '', precioCosto: 0, precioVenta: 0, stock: 0 });
  const [guardandoProd, setGuardandoProd] = useState(false);

  // Retenciones
  const [retenciones, setRetenciones] = useState([]);

  // Resumen financiero
  const [netoPagarManual, setNetoPagarManual] = useState('');
  const [cajas, setCajas]           = useState([]);
  const [cajaId, setCajaId]         = useState('');
  const [formaPago, setFormaPago]   = useState('Contado');
  const [notas, setNotas]           = useState('');
  const [proveedores, setProveedores] = useState([]);
  const [guardando, setGuardando]   = useState(false);
  const [alertasMargen, setAlertasMargen] = useState([]);

  useEffect(() => { cargarLista(); cargarProductos(); cargarCajas(); cargarProveedores(); }, []);

  const cargarLista = async () => {
    setCargando(true);
    try {
      const r = await axios.get(`${API}/compras`, { headers });
      setCompras(r.data || []);
    } catch (e) { setError('Error al cargar compras'); }
    setCargando(false);
  };

  const cargarProductos = async () => {
    try {
      const r = await axios.get(`${API}/products`, { headers });
      setProductos(r.data || []);
    } catch {}
  };

  const cargarCajas = async () => {
    try {
      const r = await axios.get(`${API}/cajas`, { headers });
      setCajas(r.data || []);
    } catch {}
  };

  const cargarProveedores = async () => {
    try {
      const r = await axios.get(`${API}/proveedores`, { headers });
      setProveedores(r.data || []);
    } catch {}
  };

  const resetWizard = () => {
    setPaso(1); setOrigen('xml'); setXmlTexto(''); setXmlNombre('');
    setCabecera({ proveedorId:'', proveedorNombre:'', proveedorNit:'', numeroFactura:'', fechaFactura: hoy(), subtotal:0, totalIVA:0, totalBruto:0 });
    setLineas([]); setRetenciones([]); setNetoPagarManual('');
    setCajaId(''); setFormaPago('Contado'); setNotas('');
    setError(''); setExito(''); setAlertasMargen([]);
  };

  // ── Subir XML ───────────────────────────────────────────────────────────────
  const subirXML = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xml')) {
      setError('El archivo debe ser .xml'); return;
    }
    setXmlNombre(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setXmlTexto(ev.target.result || '');
    reader.readAsText(file, 'UTF-8');
  };

  const parsearXML = async () => {
    if (!xmlTexto.trim()) { setError('Sube un archivo XML primero'); return; }
    setParseando(true); setError('');
    try {
      const r = await axios.post(`${API}/compras/parsear-xml`, { xml: xmlTexto }, { headers });
      const d = r.data;
      setCabecera({
        proveedorId: '',
        proveedorNombre: d.cabecera.nombreProveedor || '',
        proveedorNit: d.cabecera.nitProveedor || '',
        numeroFactura: d.cabecera.numeroFactura || '',
        fechaFactura: d.cabecera.fechaFactura || hoy(),
        subtotal: d.cabecera.totalBruto || 0,
        totalIVA: d.cabecera.totalIVA || 0,
        totalBruto: (d.cabecera.totalBruto || 0) + (d.cabecera.totalIVA || 0),
        netoPagarXML: d.cabecera.netoPagarXML || 0
      });
      setLineas(d.lineas || []);
      setNetoPagarManual(String(d.cabecera.netoPagarXML || ''));
      setPaso(2);
    } catch (e) {
      setError(e.response?.data?.error || 'Error al parsear XML. Verifica que sea una factura DIAN válida.');
    }
    setParseando(false);
  };

  // ── Agregar linea manual ────────────────────────────────────────────────────
  const agregarLineaManual = () => {
    setLineas(prev => [...prev, {
      idx: prev.length,
      descripcionXML: '',
      productoId: null, productoNombre: '',
      cantidad: 1, precioUnitario: 0, subtotal: 0, ivaVal: 0, mapeado: false
    }]);
  };

  const actualizarLinea = (idx, campo, valor) => {
    setLineas(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const upd = { ...l, [campo]: valor };
      if (campo === 'cantidad' || campo === 'precioUnitario') {
        upd.subtotal = (Number(upd.cantidad) || 0) * (Number(upd.precioUnitario) || 0);
      }
      return upd;
    }));
  };

  const eliminarLinea = (idx) => {
    setLineas(prev => prev.filter((_, i) => i !== idx));
  };

  // ── Recalcular totales ──────────────────────────────────────────────────────
  const calcularTotales = () => {
    const subtotal       = lineas.reduce((s, l) => s + (Number(l.subtotal) || 0), 0);
    const totalIVA       = lineas.reduce((s, l) => s + (Number(l.ivaVal) || 0), 0);
    const totalBruto     = subtotal + totalIVA;
    const totalReten     = retenciones.reduce((s, r) => s + (Number(r.valor) || 0), 0);
    const netoCalculado  = totalBruto - totalReten;
    return { subtotal, totalIVA, totalBruto, totalReten, netoCalculado };
  };

  const netoPagarFinal = () => {
    const manual = parseFloat(netoPagarManual);
    if (!isNaN(manual) && manual > 0) return manual;
    return calcularTotales().netoCalculado;
  };

  // ── Mapeo de productos ──────────────────────────────────────────────────────
  const abrirMapeo = (idx) => { setLineaMapeo(idx); setBuscarProd(''); setModoCrear(false); };
  const cerrarMapeo = () => { setLineaMapeo(null); setBuscarProd(''); setModoCrear(false); };

  const asignarProducto = (prod) => {
    setLineas(prev => prev.map((l, i) => {
      if (i !== lineaMapeo) return l;
      return {
        ...l,
        productoId: prod.id,
        productoNombre: prod.nombre,
        precioUnitario: prod.precioCosto || l.precioUnitario,
        subtotal: (Number(l.cantidad) || 0) * (Number(prod.precioCosto || l.precioUnitario) || 0),
        mapeado: true
      };
    }));
    cerrarMapeo();
  };

  const crearYAsignarProducto = async () => {
    if (!prodNuevo.nombre.trim()) { setError('Nombre requerido'); return; }
    setGuardandoProd(true);
    try {
      const r = await axios.post(`${API}/products`, {
        nombre: prodNuevo.nombre.trim(),
        precioCosto: Number(prodNuevo.precioCosto) || 0,
        precioVenta: Number(prodNuevo.precioVenta) || 0,
        stock: 0,
        tipo: 'simple',
        activo: true
      }, { headers });
      const nuevo = r.data;
      await cargarProductos();
      asignarProducto({ id: nuevo.id || nuevo._id, nombre: prodNuevo.nombre.trim(), precioCosto: Number(prodNuevo.precioCosto) || 0 });
      setProdNuevo({ nombre: '', precioCosto: 0, precioVenta: 0, stock: 0 });
    } catch (e) {
      setError(e.response?.data?.error || 'Error al crear producto');
    }
    setGuardandoProd(false);
  };

  // ── Retenciones ─────────────────────────────────────────────────────────────
  const agregarRetencion = () => {
    setRetenciones(prev => [...prev, { tipo: 'retefuente', base: calcularTotales().subtotal, pct: 3.5, valor: 0 }]);
  };

  const actualizarRetencion = (idx, campo, valor) => {
    setRetenciones(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const upd = { ...r, [campo]: valor };
      if (campo === 'base' || campo === 'pct') {
        upd.valor = Math.round((Number(upd.base) || 0) * (Number(upd.pct) || 0) / 100);
      }
      if (campo === 'valor') {
        upd.valor = Number(valor) || 0;
      }
      return upd;
    }));
  };

  const eliminarRetencion = (idx) => setRetenciones(prev => prev.filter((_, i) => i !== idx));

  // ── Confirmar compra ────────────────────────────────────────────────────────
  const confirmarCompra = async () => {
    setError('');
    const sinMapear = lineas.filter(l => !l.productoId);
    if (sinMapear.length > 0) {
      setError(`Hay ${sinMapear.length} linea(s) sin asignar producto. Mapéalas antes de confirmar.`);
      return;
    }
    if (!cabecera.proveedorNombre.trim()) { setError('El nombre del proveedor es obligatorio'); return; }

    setGuardando(true);
    try {
      const tots = calcularTotales();
      const payload = {
        proveedorId: cabecera.proveedorId || '',
        proveedorNombre: cabecera.proveedorNombre,
        proveedorNit: cabecera.proveedorNit || '',
        numeroFactura: cabecera.numeroFactura || '',
        fechaFactura: cabecera.fechaFactura || hoy(),
        lineas,
        retenciones,
        subtotal: tots.subtotal,
        totalIVA: tots.totalIVA,
        totalBruto: tots.totalBruto,
        totalRetenciones: tots.totalReten,
        netoPagar: netoPagarFinal(),
        formaPago,
        cajaId: formaPago === 'Contado' ? cajaId : '',
        notas,
        origenXML: origen === 'xml',
        xmlNombre
      };

      // Guardar borrador primero
      const r1 = await axios.post(`${API}/compras`, payload, { headers });
      const compraId = r1.data.id;

      // Confirmar (aplica efectos)
      const r2 = await axios.post(`${API}/compras/${compraId}/confirmar`, {}, { headers });

      if (r2.data.alertasMargen?.length > 0) {
        setAlertasMargen(r2.data.alertasMargen);
      }

      setExito(`✅ ${r2.data.mensaje}`);
      setTimeout(() => { setVista('lista'); cargarLista(); resetWizard(); }, 2500);
    } catch (e) {
      setError(e.response?.data?.error || 'Error al confirmar compra');
    }
    setGuardando(false);
  };

  const prodsFiltrados = productos.filter(p =>
    !buscarProd || p.nombre?.toLowerCase().includes(buscarProd.toLowerCase()) ||
    p.codigo?.toLowerCase().includes(buscarProd.toLowerCase())
  );

  const tots = calcularTotales();
  const todasMapeadas = lineas.length > 0 && lineas.every(l => !!l.productoId);

  // ── Render ──────────────────────────────────────────────────────────────────
  if (vista === 'lista') return (
    <div style={S.wrap}>
      <div style={S.header}>
        <div>
          <h2 style={S.titulo}>🛒 Compras</h2>
          <p style={S.subtitulo}>Registro de compras a proveedores · Actualiza inventario automáticamente</p>
        </div>
        <button style={S.btnPrimario} onClick={() => { resetWizard(); setVista('nueva'); }}>
          + Nueva Compra
        </button>
      </div>

      {error && <div style={S.error}>{error}</div>}

      {cargando ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#94a3b8' }}>Cargando compras...</div>
      ) : compras.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🛒</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>Sin compras registradas</div>
          <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 6 }}>Registra tu primera compra subiendo el XML de la factura DIAN</div>
          <button style={{ ...S.btnPrimario, marginTop: 20 }} onClick={() => { resetWizard(); setVista('nueva'); }}>
            + Registrar compra
          </button>
        </div>
      ) : (
        <div style={S.card}>
          <table style={S.tabla}>
            <thead>
              <tr>
                {['N° Compra','Proveedor','Factura','Fecha','Total','Estado','Origen'].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compras.map(c => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => { setDetalle(c); setVista('detalle'); }}>
                  <td style={{ ...S.td, fontWeight: 700, color: '#7c3aed' }}>{c.numero}</td>
                  <td style={S.td}>{c.proveedorNombre || '—'}</td>
                  <td style={S.td}>{c.numeroFactura || '—'}</td>
                  <td style={S.td}>{c.fechaFactura || '—'}</td>
                  <td style={{ ...S.td, fontWeight: 700, color: '#16a34a' }}>{fmt(c.netoPagar)}</td>
                  <td style={S.td}>
                    <span style={S.badge(c.estado === 'confirmada' ? '#16a34a' : '#d97706')}>
                      {c.estado === 'confirmada' ? '✅ Confirmada' : '⏳ Borrador'}
                    </span>
                  </td>
                  <td style={S.td}>
                    <span style={S.badge(c.origenXML ? '#0284c7' : '#6b7280')}>
                      {c.origenXML ? '📄 XML DIAN' : '✏️ Manual'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // ── Vista detalle ───────────────────────────────────────────────────────────
  if (vista === 'detalle' && detalle) return (
    <div style={S.wrap}>
      <div style={S.header}>
        <div>
          <h2 style={S.titulo}>Compra {detalle.numero}</h2>
          <p style={S.subtitulo}>{detalle.proveedorNombre} · {detalle.fechaFactura}</p>
        </div>
        <button style={S.btnSecundario} onClick={() => setVista('lista')}>← Volver</button>
      </div>
      <div style={S.card}>
        <div style={S.row3}>
          <div style={S.field}><label style={S.label}>Proveedor</label><span style={{ fontSize: 15, fontWeight: 700 }}>{detalle.proveedorNombre}</span><span style={{ fontSize: 12, color: '#64748b' }}>NIT: {detalle.proveedorNit || '—'}</span></div>
          <div style={S.field}><label style={S.label}>Factura</label><span style={{ fontSize: 15 }}>{detalle.numeroFactura || '—'}</span></div>
          <div style={S.field}><label style={S.label}>Neto pagado</label><span style={{ fontSize: 18, fontWeight: 800, color: '#16a34a' }}>{fmt(detalle.netoPagar)}</span></div>
        </div>
        <table style={{ ...S.tabla, marginTop: 16 }}>
          <thead><tr><th style={S.th}>Producto</th><th style={S.th}>Cant.</th><th style={S.th}>P. Costo</th><th style={S.th}>Subtotal</th></tr></thead>
          <tbody>
            {(detalle.lineas || []).map((l, i) => (
              <tr key={i}>
                <td style={S.td}><div style={{ fontWeight: 600 }}>{l.productoNombre || l.descripcionXML}</div><div style={{ fontSize: 11, color: '#94a3b8' }}>{l.descripcionXML !== l.productoNombre ? l.descripcionXML : ''}</div></td>
                <td style={S.td}>{l.cantidad}</td>
                <td style={S.td}>{fmt(l.precioUnitario)}</td>
                <td style={{ ...S.td, fontWeight: 700 }}>{fmt(l.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <div style={{ color: '#64748b', fontSize: 13 }}>Subtotal: {fmt(detalle.subtotal)}</div>
          <div style={{ color: '#64748b', fontSize: 13 }}>IVA: {fmt(detalle.totalIVA)}</div>
          {(detalle.retenciones || []).map((r, i) => (
            <div key={i} style={{ color: '#dc2626', fontSize: 13 }}>− {r.tipo}: {fmt(r.valor)}</div>
          ))}
          <div style={{ fontSize: 18, fontWeight: 800, color: '#16a34a', marginTop: 8 }}>Neto: {fmt(detalle.netoPagar)}</div>
        </div>
      </div>
    </div>
  );

  // ── Vista nueva — Wizard ────────────────────────────────────────────────────
  return (
    <div style={S.wrap}>
      <div style={S.header}>
        <div>
          <h2 style={S.titulo}>Nueva Compra</h2>
          <p style={S.subtitulo}>Registra una factura de proveedor y actualiza tu inventario</p>
        </div>
        <button style={S.btnSecundario} onClick={() => { setVista('lista'); resetWizard(); }}>✕ Cancelar</button>
      </div>

      {/* Indicador de pasos */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28, flexWrap: 'wrap' }}>
        {PASOS.map((p, i) => (
          <React.Fragment key={p.num}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={paso > p.num ? S.pasoDone : paso === p.num ? S.pasoActivo : S.pasoInact}>
                {paso > p.num ? '✓' : p.num}
              </span>
              <span style={{ fontSize: 13, fontWeight: paso === p.num ? 700 : 400, color: paso === p.num ? '#7c3aed' : '#94a3b8' }}>
                {p.label}
              </span>
            </div>
            {i < PASOS.length - 1 && <div style={{ flex: 1, height: 1, background: '#e2e8f0', minWidth: 20 }} />}
          </React.Fragment>
        ))}
      </div>

      {error && <div style={S.error}>{error}<button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>✕</button></div>}
      {exito && <div style={S.exito}>{exito}</div>}

      {alertasMargen.length > 0 && (
        <div style={S.alerta}>
          ⚠️ <strong>Alerta de margen:</strong> {alertasMargen.length} producto(s) tienen el margen reducido con el nuevo precio de costo.
          {alertasMargen.map(a => (
            <div key={a.productoId} style={{ marginTop: 4, fontSize: 12 }}>
              {a.nombre}: costo {fmt(a.costoPrevio)} → {fmt(a.costoNuevo)} | margen {a.margenPrevio}% → {a.margenNuevo}%
            </div>
          ))}
        </div>
      )}

      {/* ═══ PASO 1 — Origen ═══ */}
      {paso === 1 && (
        <div style={S.card}>
          <h3 style={{ fontWeight: 800, marginBottom: 20, color: '#1e293b' }}>¿Cómo vas a ingresar la factura?</h3>
          <div style={{ display: 'flex', gap: 16, marginBottom: 28 }}>
            {[
              { val: 'xml', icon: '📄', titulo: 'Subir XML DIAN', desc: 'La factura electrónica del proveedor. El sistema la lee automáticamente.' },
              { val: 'manual', icon: '✏️', titulo: 'Ingresar manual', desc: 'Digita los datos de la factura tú mismo.' }
            ].map(op => (
              <div key={op.val} onClick={() => setOrigen(op.val)} style={{ flex: 1, border: `2px solid ${origen === op.val ? '#7c3aed' : '#e2e8f0'}`, borderRadius: 12, padding: 20, cursor: 'pointer', background: origen === op.val ? '#faf5ff' : '#fff', transition: 'all 0.15s' }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>{op.icon}</div>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b', marginBottom: 6 }}>{op.titulo}</div>
                <div style={{ fontSize: 13, color: '#64748b' }}>{op.desc}</div>
              </div>
            ))}
          </div>

          {origen === 'xml' && (
            <div>
              <div style={{ border: '2px dashed #c4b5fd', borderRadius: 12, padding: 32, textAlign: 'center', background: '#faf5ff', cursor: 'pointer' }}
                onClick={() => xmlRef.current?.click()}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>📂</div>
                <div style={{ fontWeight: 700, color: '#7c3aed', fontSize: 15 }}>
                  {xmlNombre ? xmlNombre : 'Haz clic para seleccionar el XML'}
                </div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Formato: .xml · Factura electrónica DIAN UBL 2.1</div>
                <input ref={xmlRef} type="file" accept=".xml" style={{ display: 'none' }} onChange={subirXML} />
              </div>
              {xmlNombre && (
                <div style={{ marginTop: 16, textAlign: 'center' }}>
                  <button style={S.btnPrimario} onClick={parsearXML} disabled={parseando}>
                    {parseando ? '⏳ Leyendo XML...' : '🔍 Leer factura'}
                  </button>
                </div>
              )}
            </div>
          )}

          {origen === 'manual' && (
            <div style={{ textAlign: 'center' }}>
              <button style={S.btnPrimario} onClick={() => { setLineas([{ idx: 0, descripcionXML: '', productoId: null, productoNombre: '', cantidad: 1, precioUnitario: 0, subtotal: 0, ivaVal: 0, mapeado: false }]); setPaso(2); }}>
                Continuar →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ═══ PASO 2 — Cabecera ═══ */}
      {paso === 2 && (
        <div style={S.card}>
          <h3 style={{ fontWeight: 800, marginBottom: 20, color: '#1e293b' }}>Datos de la factura</h3>
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Proveedor *</label>
              <input style={S.input} value={cabecera.proveedorNombre}
                onChange={e => setCabecera(p => ({ ...p, proveedorNombre: e.target.value }))}
                placeholder="Nombre del proveedor" list="lista-proveedores" />
              <datalist id="lista-proveedores">
                {proveedores.map(p => <option key={p.id} value={p.nombre} />)}
              </datalist>
            </div>
            <div style={S.field}>
              <label style={S.label}>NIT Proveedor</label>
              <input style={S.input} value={cabecera.proveedorNit}
                onChange={e => setCabecera(p => ({ ...p, proveedorNit: e.target.value }))}
                placeholder="900.XXX.XXX-X" />
            </div>
          </div>
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>N° Factura</label>
              <input style={S.input} value={cabecera.numeroFactura}
                onChange={e => setCabecera(p => ({ ...p, numeroFactura: e.target.value }))}
                placeholder="FE-001, SETP..." />
            </div>
            <div style={S.field}>
              <label style={S.label}>Fecha factura *</label>
              <input type="date" style={S.input} value={cabecera.fechaFactura}
                onChange={e => setCabecera(p => ({ ...p, fechaFactura: e.target.value }))} />
            </div>
          </div>

          {origen === 'xml' && cabecera.totalBruto > 0 && (
            <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '12px 16px', fontSize: 13 }}>
              📄 XML leído: Subtotal {fmt(cabecera.subtotal)} · IVA {fmt(cabecera.totalIVA)} · Total bruto {fmt(cabecera.totalBruto)}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <button style={S.btnSecundario} onClick={() => setPaso(1)}>← Atrás</button>
            <button style={S.btnPrimario} onClick={() => {
              if (!cabecera.proveedorNombre.trim()) { setError('El nombre del proveedor es obligatorio'); return; }
              setError(''); setPaso(3);
            }}>Continuar →</button>
          </div>
        </div>
      )}

      {/* ═══ PASO 3 — Mapeo de productos ═══ */}
      {paso === 3 && (
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <h3 style={{ fontWeight: 800, color: '#1e293b', margin: 0 }}>
              Productos comprados
              <span style={{ ...S.badge('#7c3aed'), marginLeft: 10 }}>{lineas.filter(l => l.productoId).length}/{lineas.length} asignados</span>
            </h3>
            {origen === 'manual' && (
              <button style={S.btnSecundario} onClick={agregarLineaManual}>+ Agregar línea</button>
            )}
          </div>

          <div style={{ ...S.alerta, display: todasMapeadas ? 'none' : 'block' }}>
            💡 Cada línea de la factura debe asignarse a un producto de tu catálogo. Si no existe, puedes crearlo desde aquí.
          </div>

          <table style={S.tabla}>
            <thead>
              <tr>
                <th style={S.th}>Descripción en factura</th>
                <th style={S.th}>Cant.</th>
                <th style={S.th}>P. Unitario</th>
                <th style={S.th}>Subtotal</th>
                <th style={S.th}>Producto catálogo</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {lineas.map((l, i) => (
                <tr key={i} style={{ background: l.productoId ? '#f0fdf4' : '#fff' }}>
                  <td style={S.td}>
                    {origen === 'manual'
                      ? <input style={{ ...S.input, fontSize: 12 }} value={l.descripcionXML}
                          onChange={e => actualizarLinea(i, 'descripcionXML', e.target.value)}
                          placeholder="Descripción del producto" />
                      : <span style={{ fontSize: 13 }}>{l.descripcionXML}</span>
                    }
                  </td>
                  <td style={S.td}>
                    <input style={{ ...S.input, width: 70, textAlign: 'center' }} type="number" min="0.01" step="0.01"
                      value={l.cantidad} onChange={e => actualizarLinea(i, 'cantidad', e.target.value)} />
                  </td>
                  <td style={S.td}>
                    <input style={{ ...S.input, width: 110 }} type="number" min="0"
                      value={l.precioUnitario} onChange={e => actualizarLinea(i, 'precioUnitario', e.target.value)} />
                  </td>
                  <td style={{ ...S.td, fontWeight: 700 }}>{fmt(l.subtotal)}</td>
                  <td style={S.td}>
                    {l.productoId
                      ? <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={S.badge('#16a34a')}>✓ {l.productoNombre}</span>
                          <button onClick={() => abrirMapeo(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#7c3aed' }}>cambiar</button>
                        </div>
                      : <button style={{ ...S.btnSecundario, fontSize: 12, padding: '6px 12px' }} onClick={() => abrirMapeo(i)}>
                          🔗 Asignar producto
                        </button>
                    }
                  </td>
                  <td style={S.td}>
                    {origen === 'manual' && (
                      <button onClick={() => eliminarLinea(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 16 }}>✕</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <button style={S.btnSecundario} onClick={() => setPaso(2)}>← Atrás</button>
            <button style={{ ...S.btnPrimario, opacity: todasMapeadas ? 1 : 0.5 }}
              onClick={() => { if (!todasMapeadas) { setError('Asigna todos los productos antes de continuar'); return; } setError(''); setPaso(4); }}>
              Continuar →
            </button>
          </div>

          {/* Modal mapeo */}
          {lineaMapeo !== null && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 500, maxWidth: '95vw', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                  <h3 style={{ margin: 0, fontWeight: 800, color: '#1e293b' }}>Asignar producto</h3>
                  <button onClick={cerrarMapeo} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#94a3b8' }}>✕</button>
                </div>
                <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#64748b', marginBottom: 16 }}>
                  📄 En factura: <strong>{lineas[lineaMapeo]?.descripcionXML}</strong>
                </div>

                {!modoCrear ? (
                  <>
                    <input style={{ ...S.input, marginBottom: 12 }} placeholder="Buscar en catálogo..." value={buscarProd} onChange={e => setBuscarProd(e.target.value)} />
                    <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 12 }}>
                      {prodsFiltrados.length === 0
                        ? <div style={{ textAlign: 'center', padding: 20, color: '#94a3b8', fontSize: 13 }}>Sin resultados</div>
                        : prodsFiltrados.slice(0, 30).map(p => (
                            <div key={p.id} onClick={() => asignarProducto(p)}
                              style={{ padding: '10px 14px', borderRadius: 8, cursor: 'pointer', border: '1px solid #e2e8f0', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                              onMouseEnter={e => e.currentTarget.style.background = '#faf5ff'}
                              onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                              <div>
                                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.nombre}</div>
                                <div style={{ fontSize: 11, color: '#94a3b8' }}>Costo: {fmt(p.precioCosto)} · Stock: {p.stock || 0}</div>
                              </div>
                              <span style={{ color: '#7c3aed', fontWeight: 700, fontSize: 12 }}>Seleccionar →</span>
                            </div>
                          ))
                      }
                    </div>
                    <button style={{ ...S.btnSecundario, width: '100%' }} onClick={() => setModoCrear(true)}>
                      + No está en catálogo — Crear nuevo producto
                    </button>
                  </>
                ) : (
                  <>
                    <div style={{ ...S.alerta, marginBottom: 16 }}>Creando producto nuevo en tu catálogo</div>
                    <div style={S.field} ><label style={S.label}>Nombre *</label>
                      <input style={{ ...S.input, marginBottom: 12 }} value={prodNuevo.nombre}
                        onChange={e => setProdNuevo(p => ({ ...p, nombre: e.target.value }))}
                        placeholder={lineas[lineaMapeo]?.descripcionXML || ''} />
                    </div>
                    <div style={S.row2}>
                      <div style={S.field}><label style={S.label}>Precio costo</label>
                        <input type="number" style={S.input} value={prodNuevo.precioCosto}
                          onChange={e => setProdNuevo(p => ({ ...p, precioCosto: e.target.value }))} />
                      </div>
                      <div style={S.field}><label style={S.label}>Precio venta</label>
                        <input type="number" style={S.input} value={prodNuevo.precioVenta}
                          onChange={e => setProdNuevo(p => ({ ...p, precioVenta: e.target.value }))} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                      <button style={S.btnSecundario} onClick={() => setModoCrear(false)}>← Buscar existente</button>
                      <button style={S.btnVerde} onClick={crearYAsignarProducto} disabled={guardandoProd}>
                        {guardandoProd ? 'Creando...' : '✓ Crear y asignar'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ PASO 4 — Retenciones ═══ */}
      {paso === 4 && (
        <div style={S.card}>
          <h3 style={{ fontWeight: 800, marginBottom: 6, color: '#1e293b' }}>Retenciones practicadas</h3>
          <p style={{ fontSize: 13, color: '#64748b', marginBottom: 20 }}>
            Las retenciones las practica tu empresa al proveedor. El neto a pagar se calcula automáticamente pero puedes editarlo.
          </p>

          {retenciones.length === 0 && (
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: '20px', textAlign: 'center', marginBottom: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 14, marginBottom: 12 }}>Sin retenciones aplicadas</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>Si no practicas retenciones a este proveedor, puedes continuar sin agregar ninguna.</div>
            </div>
          )}

          {retenciones.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 80px 120px 32px', gap: 10, alignItems: 'end', marginBottom: 12 }}>
              <div style={S.field}>
                <label style={S.label}>Tipo</label>
                <select style={S.select} value={r.tipo} onChange={e => actualizarRetencion(i, 'tipo', e.target.value)}>
                  {TIPOS_RETENCION.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div style={S.field}>
                <label style={S.label}>Base ($)</label>
                <input type="number" style={S.input} value={r.base}
                  onChange={e => actualizarRetencion(i, 'base', e.target.value)} />
              </div>
              <div style={S.field}>
                <label style={S.label}>%</label>
                <input type="number" style={S.input} value={r.pct} step="0.001"
                  onChange={e => actualizarRetencion(i, 'pct', e.target.value)} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Valor ($)</label>
                <input type="number" style={{ ...S.input, fontWeight: 700, color: '#dc2626' }} value={r.valor}
                  onChange={e => actualizarRetencion(i, 'valor', e.target.value)} />
              </div>
              <button onClick={() => eliminarRetencion(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 18, paddingBottom: 4 }}>✕</button>
            </div>
          ))}

          <button style={{ ...S.btnSecundario, marginBottom: 24 }} onClick={agregarRetencion}>
            + Agregar retención
          </button>

          {/* Resumen financiero */}
          <div style={{ background: '#f8fafc', borderRadius: 12, padding: '20px 24px', marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Resumen</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#64748b' }}>
                <span>Subtotal</span><span>{fmt(tots.subtotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#64748b' }}>
                <span>IVA</span><span>{fmt(tots.totalIVA)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#64748b', borderTop: '1px solid #e2e8f0', paddingTop: 6 }}>
                <span>Total bruto</span><span style={{ fontWeight: 700 }}>{fmt(tots.totalBruto)}</span>
              </div>
              {retenciones.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#dc2626' }}>
                  <span>− {TIPOS_RETENCION.find(t => t.value === r.tipo)?.label || r.tipo}</span>
                  <span>− {fmt(r.valor)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#64748b', borderTop: '1px solid #e2e8f0', paddingTop: 6 }}>
                <span>Neto calculado</span><span style={{ fontWeight: 700 }}>{fmt(tots.netoCalculado)}</span>
              </div>
            </div>
            {/* Neto editable */}
            <div style={{ marginTop: 16, borderTop: '2px solid #7c3aed', paddingTop: 14 }}>
              <label style={{ ...S.label, color: '#7c3aed' }}>Neto a pagar (editable)</label>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>Si el valor a pagar difiere del calculado, edítalo aquí</div>
              <input type="number" style={{ ...S.input, fontSize: 18, fontWeight: 800, color: '#16a34a', textAlign: 'right' }}
                value={netoPagarManual || tots.netoCalculado}
                onChange={e => setNetoPagarManual(e.target.value)} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <button style={S.btnSecundario} onClick={() => setPaso(3)}>← Atrás</button>
            <button style={S.btnPrimario} onClick={() => { setError(''); setPaso(5); }}>Continuar →</button>
          </div>
        </div>
      )}

      {/* ═══ PASO 5 — Confirmar ═══ */}
      {paso === 5 && (
        <div style={S.card}>
          <h3 style={{ fontWeight: 800, marginBottom: 20, color: '#1e293b' }}>Confirmar compra</h3>

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Forma de pago</label>
              <select style={S.select} value={formaPago} onChange={e => setFormaPago(e.target.value)}>
                <option value="Contado">Contado (pago inmediato)</option>
                <option value="Crédito">A crédito (queda como CxP)</option>
                <option value="Transferencia">Transferencia</option>
                <option value="Cheque">Cheque</option>
              </select>
            </div>
            {(formaPago === 'Contado' || formaPago === 'Transferencia') && (
              <div style={S.field}>
                <label style={S.label}>Caja / Cuenta</label>
                <select style={S.select} value={cajaId} onChange={e => setCajaId(e.target.value)}>
                  <option value="">— Seleccionar —</option>
                  {cajas.map(c => (
                    <option key={c.id} value={c.id}>{c.nombre} · {fmt(c.saldo)}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div style={S.field}>
            <label style={S.label}>Notas (opcional)</label>
            <textarea style={{ ...S.input, height: 70, resize: 'vertical' }}
              placeholder="Observaciones de la compra..."
              value={notas} onChange={e => setNotas(e.target.value)} />
          </div>

          {/* Resumen final */}
          <div style={{ background: '#faf5ff', border: '2px solid #c4b5fd', borderRadius: 14, padding: 20, marginTop: 20 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: '#7c3aed', marginBottom: 14 }}>Resumen de la compra</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
              <div><span style={{ color: '#64748b' }}>Proveedor:</span> <strong>{cabecera.proveedorNombre}</strong></div>
              <div><span style={{ color: '#64748b' }}>Factura:</span> <strong>{cabecera.numeroFactura || '—'}</strong></div>
              <div><span style={{ color: '#64748b' }}>Fecha:</span> <strong>{cabecera.fechaFactura}</strong></div>
              <div><span style={{ color: '#64748b' }}>Productos:</span> <strong>{lineas.length} línea(s)</strong></div>
              <div><span style={{ color: '#64748b' }}>Forma pago:</span> <strong>{formaPago}</strong></div>
              <div><span style={{ color: '#64748b' }}>Origen:</span> <strong>{origen === 'xml' ? '📄 XML DIAN' : '✏️ Manual'}</strong></div>
            </div>
            <div style={{ borderTop: '1px solid #c4b5fd', marginTop: 16, paddingTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 15, color: '#7c3aed', fontWeight: 700 }}>Neto a pagar:</span>
              <span style={{ fontSize: 24, fontWeight: 900, color: '#16a34a' }}>{fmt(netoPagarFinal())}</span>
            </div>
          </div>

          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 16px', marginTop: 16, fontSize: 12, color: '#1d4ed8' }}>
            <strong>Al confirmar:</strong> el inventario se actualizará automáticamente · Se creará un egreso en finanzas
            {formaPago !== 'Crédito' ? ' · Se descontará de la caja seleccionada' : ' · Quedará registrado como cuenta por pagar'}
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <button style={S.btnSecundario} onClick={() => setPaso(4)}>← Atrás</button>
            <button style={{ ...S.btnVerde, flex: 1, fontSize: 16, padding: '14px' }}
              onClick={confirmarCompra} disabled={guardando}>
              {guardando ? '⏳ Procesando...' : '✅ Confirmar compra'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
