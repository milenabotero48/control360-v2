import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = v => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);
const hoyStr = () => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().split('T')[0];
};

const TIPOS = [
  { value: 'oficina',   label: 'Oficina',   estado: 'completada', color: '#16a34a' },
  { value: 'domicilio', label: 'Domicilio', estado: 'programada', color: '#0284c7' },
  { value: 'taller',    label: 'Taller',    estado: 'en_taller',  color: '#7c3aed' },
  { value: 'despacho',  label: 'Despacho',  estado: 'despacho',   color: '#d97706' },
  { value: 'cobranza',  label: 'Cobranza',  estado: 'programada', color: '#dc2626' },
  { value: 'interna',   label: 'Interna',   estado: 'programada', color: '#6b7280' },
  { value: 'produccion', label: 'Producción', estado: 'programada', color: '#0891b2' },
];

const generarHtmlOrden = (orden, empresa, tipo = 'carta') => {
  const esTirilla = tipo === 'tirilla';
  const fmtFecha = f => f ? new Date(f + 'T00:00:00').toLocaleDateString('es-CO') : new Date().toLocaleDateString('es-CO');
  const filas = (orden.items || []).map(it => {
    const sub = (it.precioUnitario || 0) * (it.cantidad || 1) * (1 - (it.descuento || 0) / 100);
    if (esTirilla) return '<tr><td>' + it.nombre + (it.notas ? ' (' + it.notas + ')' : '') + '</td><td style="text-align:right">' + it.cantidad + '</td><td style="text-align:right">' + fmt(sub) + '</td></tr>';
    return '<tr><td style="padding:8px 10px;border-bottom:1px solid #f3f4f6">' + it.nombre + '<br/><span style="font-size:11px;color:#9ca3af">' + (it.categoria || '') + (it.notas ? ' \u00b7 ' + it.notas : '') + '</span></td><td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:center">' + it.cantidad + '</td><td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right">' + fmt(it.precioUnitario) + '</td><td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right;color:#dc2626">' + (it.descuento > 0 ? it.descuento + '%' : '\u2014') + '</td><td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700;color:#16a34a">' + fmt(sub) + '</td></tr>';
  }).join('');

  if (esTirilla) return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}@page{size:58mm auto;margin:0}body{font-family:monospace;font-size:13px;width:58mm;color:#000;background:#fff;padding:2mm}h1{font-size:15px;text-align:center;font-weight:900;margin-bottom:2px}p{text-align:center;font-size:12px}table{width:100%;border-collapse:collapse}th{border-top:2px solid #000;border-bottom:1px dashed #000;padding:3px 0;font-size:12px;font-weight:900}td{padding:2px 0;font-size:12px}.total{border-top:2px solid #000;font-weight:bold;font-size:14px}img.logo{width:50mm;max-width:100%;height:auto;object-fit:contain;display:block;margin:0 auto 4px}@media print{body{width:58mm;padding:0}}</style></head><body>' + (empresa && empresa.logo ? '<img src="' + empresa.logo + '" class="logo"/>' : '') + '<h1>' + (empresa && empresa.name ? empresa.name : 'ORDEN DE SERVICIO') + '</h1><p>NIT: ' + (empresa && empresa.nit ? empresa.nit : '') + '</p><p>' + (empresa && empresa.phone ? empresa.phone : '') + '</p><p style="margin:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:3px 0">' + orden.numeroOrden + ' \u00b7 ' + fmtFecha(orden.fechaProgramada) + '</p><p style="text-align:left;margin:4px 0"><b>Cliente:</b> ' + orden.clienteNombre + '</p>' + (orden.sucursalNombre ? '<p style="text-align:left"><b>Sede:</b> ' + orden.sucursalNombre + '</p>' : '') + '<p style="text-align:left"><b>Pago:</b> ' + (orden.formaPago || '\u2014') + '</p><table><thead><tr><th style="text-align:left">Descripci\u00f3n</th><th>Cant</th><th>Total</th></tr></thead><tbody>' + filas + '</tbody></table><table><tr class="total"><td colspan="2">TOTAL</td><td style="text-align:right">' + fmt(orden.total) + '</td></tr></table>' + (orden.notasOrden ? '<p style="margin-top:6px;text-align:left">Nota: ' + orden.notasOrden + '</p>' : '') + '<p style="margin-top:8px;border-top:1px dashed #000;padding-top:4px">Gracias por su preferencia</p></body></html>';

  const ivaPct2 = empresa && empresa.iva ? empresa.iva : 0;
  const subtotalOrden = orden.subtotal || Math.round((orden.total || 0) / (1 + ivaPct2 / 100));
  const ivaOrden = orden.ivaValor || Math.round((orden.total || 0) - subtotalOrden);
  const filasIva = ivaPct2 > 0
    ? '<tr style="background:#f9fafb"><td colspan="4" style="padding:8px 10px;text-align:right;color:#6b7280">Subtotal</td><td style="padding:8px 10px;text-align:right;color:#6b7280">' + fmt(subtotalOrden) + '</td></tr><tr style="background:#f9fafb"><td colspan="4" style="padding:8px 10px;text-align:right;color:#6b7280">IVA (' + ivaPct2 + '%)</td><td style="padding:8px 10px;text-align:right;color:#6b7280">' + fmt(ivaOrden) + '</td></tr>'
    : '';

  const filasCobranza = (orden.ordenesACobrar && orden.ordenesACobrar.length > 0)
    ? '<div style="margin-top:24px;padding:16px;background:#fef2f2;border-radius:10px"><div style="font-size:14px;font-weight:700;color:#dc2626;margin-bottom:10px;border-bottom:2px solid #fca5a5;padding-bottom:6px">ORDENES A COBRAR</div><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#fca5a5"><th style="padding:8px 10px;text-align:left;color:#7f1d1d">Orden</th><th style="padding:8px 10px;text-align:right;color:#7f1d1d">Saldo pendiente</th></tr></thead><tbody>'
      + (orden.ordenesACobrar || []).map(o => '<tr style="border-bottom:1px solid #fecaca"><td style="padding:8px 10px">' + (o.numeroOrden || '') + '</td><td style="padding:8px 10px;text-align:right;font-weight:700;color:#dc2626">' + fmt(o.saldo || 0) + '</td></tr>').join('')
      + '</tbody><tfoot><tr style="background:#fee2e2"><td style="padding:10px;font-weight:800;color:#7f1d1d">Total a cobrar</td><td style="padding:10px;text-align:right;font-size:16px;font-weight:900;color:#dc2626">' + fmt(orden.montoCobrar || 0) + '</td></tr></tfoot></table></div>'
    : '';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + orden.numeroOrden + '</title><style>body{font-family:"Segoe UI",sans-serif;margin:0;padding:0;color:#111;background:#fff}@media print{body{padding:0}}</style></head><body><div style="max-width:780px;margin:0 auto;padding:32px"><div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #7c3aed;padding-bottom:20px;margin-bottom:24px"><div>' + (empresa && empresa.logo ? '<img src="' + empresa.logo + '" style="height:60px;object-fit:contain;margin-bottom:8px"/>' : '<div style="font-size:22px;font-weight:900;color:#7c3aed">' + (empresa && empresa.name ? empresa.name : '') + '</div>') + '<div style="font-size:13px;color:#6b7280">' + (empresa && empresa.address ? empresa.address : '') + '</div><div style="font-size:13px;color:#6b7280">' + (empresa && empresa.phone ? empresa.phone : '') + ' \u00b7 ' + (empresa && empresa.email ? empresa.email : '') + '</div><div style="font-size:13px;color:#6b7280">NIT: ' + (empresa && empresa.nit ? empresa.nit : '') + '</div></div><div style="text-align:right"><div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px">Orden de Servicio</div><div style="font-size:28px;font-weight:900;color:#7c3aed">' + orden.numeroOrden + '</div><div style="font-size:13px;color:#6b7280">Fecha: ' + fmtFecha(orden.fechaProgramada) + '</div>' + (orden.numeroFactura ? '<div style="font-size:13px;color:#111;font-weight:700;margin-top:4px">Factura: ' + orden.numeroFactura + '</div>' : '') + '</div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px"><div style="background:#f9fafb;border-radius:10px;padding:14px 16px"><div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-bottom:8px">Cliente</div><div style="font-size:16px;font-weight:700">' + orden.clienteNombre + '</div>' + (orden.clienteNit ? '<div style="font-size:12px;color:#6b7280">NIT: ' + orden.clienteNit + '</div>' : '') + (orden.clienteCelular ? '<div style="font-size:12px;color:#6b7280">Tel: ' + orden.clienteCelular + '</div>' : '') + (orden.sucursalDireccion ? '<div style="font-size:12px;color:#6b7280">Dir: ' + orden.sucursalDireccion + '</div>' : (orden.clienteDireccionPrincipal ? '<div style="font-size:12px;color:#6b7280">Dir: ' + orden.clienteDireccionPrincipal + '</div>' : '')) + (orden.sucursalNombre ? '<div style="font-size:12px;color:#6b7280;margin-top:4px">Sede: ' + orden.sucursalNombre + '</div>' : '') + '</div><div style="background:#f9fafb;border-radius:10px;padding:14px 16px"><div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-bottom:8px">Detalle</div><div style="font-size:13px;color:#374151"><b>Forma de pago:</b> ' + (orden.formaPago || '\u2014') + '</div>' + (orden.extintorPrestamo ? '<div style="font-size:13px;color:#374151;margin-top:4px"><b>Extintor pr\u00e9stamo:</b> ' + orden.extintorPrestamo + '</div>' : '') + (orden.notasOrden ? '<div style="font-size:13px;color:#374151;margin-top:4px"><b>Notas:</b> ' + orden.notasOrden + '</div>' : '') + '</div></div><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#7c3aed;color:#fff"><th style="padding:10px;text-align:left">Producto / Servicio</th><th style="padding:10px;text-align:center">Cant.</th><th style="padding:10px;text-align:right">Precio</th><th style="padding:10px;text-align:right">Desc.</th><th style="padding:10px;text-align:right">Subtotal</th></tr></thead><tbody>' + filas + '</tbody><tfoot>' + filasIva + '<tr style="background:#f9fafb"><td colspan="4" style="padding:10px;text-align:right;font-weight:700">TOTAL</td><td style="padding:10px;text-align:right;font-size:18px;font-weight:900;color:#16a34a">' + fmt(orden.total) + '</td></tr></tfoot></table>' + filasCobranza + '<div style="margin-top:32px;font-size:11px;color:#9ca3af;text-align:center;border-top:1px solid #f3f4f6;padding-top:16px">Documento generado por Control360 \u00b7 Sistema Operativo Empresarial</div></div></body></html>';
};

const NuevaOrden = ({ user, onCreada, onCancelar, ordenEditar = null }) => {
  const esEdicion = !!ordenEditar;
  const token = localStorage.getItem('token');
  const headers = { Authorization: 'Bearer ' + token };

  const [clientes, setClientes]           = useState([]);
  const [productos, setProductos]         = useState([]);
  const [empresas, setEmpresas]           = useState([]);
  const [mensajeros, setMensajeros]       = useState([]);
  const [trabajadores, setTrabajadores]   = useState([]);
  const [formasPagoConfig, setFormasPago] = useState([]);
  const [sectores, setSectores]           = useState([]); // Mini-Ola 2.6
  const [cxcCliente, setCxcCliente]       = useState([]);
  const [clienteSel, setClienteSel]       = useState(null);
  const [sucursalSel, setSucursalSel]     = useState(null);
  const [empresaSel, setEmpresaSel]       = useState(null);
  const [tipoServicio, setTipoServicio]   = useState('oficina');
  const [formaPago, setFormaPago]         = useState('');
  // Ola 2.5: Comprobante de pago adelantado (cliente ya pagó antes del servicio)
  const [pagoAdelantado, setPagoAdelantado] = useState(false);
  const [fotoComprobante, setFotoComprobante] = useState('');
  const [subiendoComprobante, setSubiendoComprobante] = useState(false);
  const fotoComprobanteRef = useRef(null);
  const [items, setItems]                 = useState([]);
  const [alertaTaller, setAlertaTaller]   = useState(false);
  const [buscarCliente, setBuscarCliente] = useState('');
  const [buscarProd, setBuscarProd]       = useState('');
  const [notas, setNotas]                 = useState('');
  const [numeroFactura, setNumeroFactura] = useState('');
  const [clientePideFactura, setClientePideFactura] = useState(false);
  const [extintorPrestamo, setExtintor]   = useState('');
  const [fechaProgramada, setFecha]       = useState(hoyStr());
  const [mensajeroId, setMensajeroId]     = useState('');
  const [mensajeroNombre, setMensajeroNombre] = useState('');
  const [mostrarFormCliente, setMostrarFormCliente] = useState(false);
  const [guardando, setGuardando]         = useState(false);
  const [error, setError]                 = useState('');
  const [ordenCreada, setOrdenCreada]     = useState(null);
  const [bloqueo, setBloqueo]             = useState(null);
  const [mostrarModalBloqueo, setMostrarModalBloqueo] = useState(false);
  const [pinDesbloqueado, setPinDesbloqueado] = useState(false);
  const prodRef = useRef(null);

  // Ola 2.5: subir comprobante de pago adelantado a Cloudinary
  const CLOUDINARY_URL = 'https://api.cloudinary.com/v1_1/dk8hposft/image/upload';
  const CLOUDINARY_PRESET = 'control360';
  const subirComprobante = async (file) => {
    setSubiendoComprobante(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_PRESET);
    formData.append('folder', 'control360/comprobantes');
    try {
      const res = await fetch(CLOUDINARY_URL, { method: 'POST', body: formData });
      const data = await res.json();
      setFotoComprobante(data.secure_url);
    } catch {
      setError('Error al subir comprobante');
    }
    setSubiendoComprobante(false);
  };

  // Helper: detecta si una forma de pago es virtual (todo lo que no sea Efectivo ni CxC)
  const esFormaPagoVirtual = (fp) => fp && fp !== 'Efectivo' &&
    fp !== 'A crédito (CxC)' && fp !== 'A crédito' && fp !== 'CXC' && fp !== 'Cuenta por Pagar';
  const esFormaPagoCxC = (fp) => fp === 'A crédito (CxC)' || fp === 'A crédito' || fp === 'CXC' || fp === 'Cuenta por Pagar';

  useEffect(() => {
    cargarClientes(); cargarProductos(); cargarEmpresas(); cargarMensajeros(); cargarFormasPago();
  }, []);

  useEffect(() => {
    if (!ordenEditar || empresas.length === 0) return;
    setClienteSel({ id: ordenEditar.clienteId, nombre: ordenEditar.clienteNombre, nit: ordenEditar.clienteNit, celular: ordenEditar.clienteCelular, empresaId: ordenEditar.empresaId });
    const emp = empresas.find(e => e.id === ordenEditar.empresaId);
    if (emp) setEmpresaSel(emp);
    setItems((ordenEditar.items || []).map(it => ({ ...it, precioUnitario: it.precioUnitario ?? it.precioUnit ?? 0 })));
    setFormaPago(ordenEditar.formaPago || '');
    setNotas(ordenEditar.notasOrden || '');
    setNumeroFactura(ordenEditar.numeroFactura || '');
    setExtintor(ordenEditar.extintorPrestamo || '');
    setTipoServicio(ordenEditar.lugarAtencion || 'oficina');
    setFecha(ordenEditar.fechaProgramada || hoyStr());
    setMensajeroId(ordenEditar.mensajeroId || '');
    setMensajeroNombre(ordenEditar.mensajeroNombre || '');
  }, [ordenEditar, empresas]);

  const cargarClientes = async () => {
    try { const r = await axios.get(API + '/clients', { headers }); setClientes((Array.isArray(r.data) ? r.data : []).filter(c => c.activo !== false)); } catch { setClientes([]); }
  };
  const cargarProductos = async () => {
    try { const r = await axios.get(API + '/products', { headers }); setProductos((Array.isArray(r.data) ? r.data : []).filter(p => p.activo !== false)); } catch { setProductos([]); }
  };
  const cargarEmpresas = async () => {
    try { const r = await axios.get(API + '/companies', { headers }); setEmpresas(Array.isArray(r.data) ? r.data : []); } catch { setEmpresas([]); }
  };
  const cargarMensajeros = async () => {
    try {
      const r = await axios.get(API + '/users', { headers });
      const users = Array.isArray(r.data) ? r.data : [];
      setMensajeros(users.filter(u => u.role === 'mensajero' && u.activo !== false));
      setTrabajadores(users.filter(u => ['mensajero', 'taller'].includes(u.role) && u.activo !== false));
    } catch { setMensajeros([]); setTrabajadores([]); }
  };
  const cargarFormasPago = async () => {
    try {
      const r = await axios.get(API + '/configuracion', { headers });
      setFormasPago((r.data && r.data.formasPago ? r.data.formasPago : []).filter(f => f.activa));
      // Mini-Ola 2.6: catálogo de sectores
      setSectores((r.data && r.data.sectores ? r.data.sectores : []).filter(s => s.activo));
    } catch { setFormasPago([]); setSectores([]); }
  };
  const cargarCxcCliente = async (clienteId) => {
    try { const r = await axios.get(API + '/cxc', { headers }); const cli = (r.data && r.data.clientes ? r.data.clientes : []).find(c => c.clienteId === clienteId); setCxcCliente(cli ? cli.ordenes || [] : []); } catch { setCxcCliente([]); }
  };
  const verificarBloqueo = async (clienteId) => {
    try { const r = await axios.get(API + '/cxc/verificar/' + clienteId, { headers }); setBloqueo(r.data && r.data.bloqueado ? r.data : null); } catch { setBloqueo(null); }
  };

  const seleccionarCliente = (c) => {
    setClienteSel(c); setSucursalSel(null); setBuscarCliente('');
    setPinDesbloqueado(false);
    if (c.empresaId) { const emp = empresas.find(e => e.id === c.empresaId); if (emp) setEmpresaSel(emp); }
    verificarBloqueo(c.id);
    if (tipoServicio === 'cobranza') cargarCxcCliente(c.id);
  };

  const clientesFiltrados = clientes.filter(c =>
    (c.nombre && c.nombre.toUpperCase().includes(buscarCliente.toUpperCase())) ||
    (c.nit && c.nit.includes(buscarCliente)) ||
    (c.celular && c.celular.includes(buscarCliente))
  ).slice(0, 8);

  const productosFiltrados = productos.filter(p =>
    (p.nombre && p.nombre.toUpperCase().includes(buscarProd.toUpperCase())) ||
    (p.codigo && p.codigo.toUpperCase().includes(buscarProd.toUpperCase()))
  ).slice(0, 20);

  const agregarProducto = (prod) => {
    const yaExiste = items.find(i => i.productoId === prod.id);
    if (yaExiste) { setItems(prev => prev.map(i => i.productoId === prod.id ? { ...i, cantidad: i.cantidad + 1 } : i)); }
    else { setItems(prev => [...prev, { productoId: prod.id, nombre: prod.nombre, codigo: prod.codigo, categoria: prod.categoria || '', cantidad: 1, precioUnitario: prod.precioVenta || 0, descuento: 0, notas: '', codigoQR: '' }]); }
    setBuscarProd('');
  };

  const editarItem = (idx, campo, valor) => {
    setItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      if (campo === 'precioUnitario' || campo === 'descuento') return { ...item, [campo]: valor === '' ? '' : Number(valor) };
      if (campo === 'cantidad') return { ...item, [campo]: Number(valor) || 1 };
      return { ...item, [campo]: valor };
    }));
  };
  const eliminarItem = (idx) => setItems(prev => prev.filter((_, i) => i !== idx));

  const subtotal = items.reduce((s, it) => s + (Number(it.precioUnitario) || 0) * (Number(it.cantidad) || 1) * (1 - (Number(it.descuento) || 0) / 100), 0);
  const ivaPct   = (empresaSel && empresaSel.iva) ? empresaSel.iva : 0;
  const ivaValor = Math.round(subtotal * ivaPct / 100);
  const total    = Math.round(subtotal + ivaValor);

  const tipoInfo = TIPOS.find(t => t.value === tipoServicio) || TIPOS[0];
  const necesitaLogistica = ['domicilio', 'taller', 'despacho', 'cobranza'].includes(tipoServicio);

  const crearOrden = async (forzar = false) => {
    const esInternaOProd = tipoServicio === 'interna' || tipoServicio === 'produccion';

    if (!forzar && tipoServicio === 'oficina') {
      const mods = user?.modulos || [];
      const tieneTaller = mods.length === 0 || mods.includes('taller');
      if (tieneTaller) {
        const tieneRecargaSinCambio = items.some(item => {
          const cat = (item.categoria || '').toLowerCase();
          const esRecarga = cat.includes('recarga') || cat.includes('mantenimiento') || cat.includes('hidrost');
          return esRecarga && !item.esCambio;
        });
        if (tieneRecargaSinCambio) {
          setAlertaTaller(true);
          return;
        }
      }
    }

    if (!esInternaOProd && !clienteSel) return setError('Selecciona un cliente');
    if (!esInternaOProd && tipoServicio !== 'cobranza' && !empresaSel) return setError('Selecciona la empresa que factura');
    if (esInternaOProd && !mensajeroId) return setError('Selecciona el trabajador a asignar');
    if (tipoServicio !== 'interna' && tipoServicio !== 'cobranza' && items.length === 0) return setError('Agrega al menos un producto');
    if (tipoServicio === 'interna' && !notas.trim()) return setError('Describe qué debe hacer el mensajero en el campo "¿Qué debe hacer?"');
    if (tipoServicio === 'produccion' && items.length === 0) return setError('Agrega al menos un equipo a producir');
    if (!esInternaOProd && tipoServicio !== 'cobranza' && !formaPago) return setError('Selecciona la forma de pago');
    // Ola 2.5: si marcó "cliente ya pagó" exige el comprobante
    if (pagoAdelantado && !fotoComprobante) {
      return setError('Marcaste que el cliente ya pagó. Sube la foto o PDF del comprobante, o desmarca la casilla.');
    }
    setGuardando(true); setError('');
    try {
      const res = await axios.post(API + '/orders', {
        tipoOrden: tipoServicio === 'cobranza' ? 'cxc'
          : tipoServicio === 'interna' ? 'interna'
          : tipoServicio === 'produccion' ? 'produccion' : 'servicio',
        lugarAtencion: tipoServicio,
        clienteId: esInternaOProd ? null : clienteSel.id,
        clienteNombre: esInternaOProd ? '' : clienteSel.nombre,
        clienteNit: esInternaOProd ? '' : clienteSel.nit,
        clienteCelular: esInternaOProd ? '' : clienteSel.celular,
        sucursalId: sucursalSel ? sucursalSel.id : null, sucursalNombre: sucursalSel ? sucursalSel.nombre : '', sucursalDireccion: sucursalSel ? sucursalSel.direccion : '',
        empresaId: esInternaOProd ? '' : (empresaSel ? empresaSel.id : ''),
        empresaNombre: esInternaOProd ? '' : (empresaSel ? empresaSel.name : ''),
        items, fechaProgramada,
        mensajeroId: mensajeroId || null, mensajeroNombre,
        trabajadorAsignadoId: esInternaOProd ? (mensajeroId || null) : null,
        trabajadorAsignadoNombre: esInternaOProd ? mensajeroNombre : '',
        ordenesACobrar: tipoServicio === 'cobranza' ? cxcCliente.map(o => ({ ordenId: o.id, numeroOrden: o.numeroOrden, saldo: o.saldoPendiente })) : undefined,
        montoCobrar: tipoServicio === 'cobranza' ? cxcCliente.reduce((s, o) => s + o.saldoPendiente, 0) : 0,
        notasOrden: notas, formaPago: esInternaOProd ? '' : formaPago,
        numeroFactura, extintorPrestamo, total,
        requiereFactura: esInternaOProd ? false : ((empresaSel?.iva > 0) || clientePideFactura),
        clienteDireccionPrincipal: esInternaOProd ? '' : (clienteSel?.direccionPrincipal || ''),
        clienteTelefono: esInternaOProd ? '' : (clienteSel?.celular || ''),
        // Ola 2.5: comprobante de pago adelantado
        fotoTransferenciaUrl: pagoAdelantado ? fotoComprobante : undefined,
        pagoAdelantado: pagoAdelantado,
        pagado: pagoAdelantado ? true : undefined,
        pagoVirtualPendienteValidar: pagoAdelantado ? true : undefined,
      }, { headers });
      setOrdenCreada({ ...res.data, items, clienteNombre: esInternaOProd ? 'TAREA INTERNA' : clienteSel.nombre, clienteNit: esInternaOProd ? '' : clienteSel.nit, clienteCelular: esInternaOProd ? '' : clienteSel.celular, sucursalNombre: sucursalSel ? sucursalSel.nombre : '', formaPago, notasOrden: notas, extintorPrestamo, numeroFactura, fechaProgramada, total, ordenesACobrar: tipoServicio === 'cobranza' ? cxcCliente.map(o => ({ ordenId: o.id, numeroOrden: o.numeroOrden, saldo: o.saldoPendiente })) : [], montoCobrar: tipoServicio === 'cobranza' ? cxcCliente.reduce((s, o) => s + o.saldoPendiente, 0) : 0 });
    } catch (err) { setError((err.response && err.response.data && err.response.data.error) ? err.response.data.error : 'Error al crear la orden'); }
    finally { setGuardando(false); }
  };

  const guardarEdicion = async () => {
    if (!clienteSel) return setError('Selecciona un cliente');
    if (items.length === 0) return setError('Agrega al menos un producto');
    setGuardando(true); setError('');
    try {
      await axios.put(API + '/orders/' + ordenEditar.id, { items, fechaProgramada, mensajeroId, mensajeroNombre, notasOrden: notas, formaPago, numeroFactura, extintorPrestamo }, { headers });
      if (onCreada) onCreada('edicion');
    } catch (e) { setError((e.response && e.response.data && e.response.data.error) ? e.response.data.error : 'Error actualizando orden'); }
    setGuardando(false);
  };

  const imprimir = (tipo) => {
    const html = generarHtmlOrden(ordenCreada, empresaSel, tipo);
    const win = window.open('', '_blank');
    win.document.write(html); win.document.close(); win.focus();
    setTimeout(() => win.print(), 600);
  };

  const enviarWhatsApp = () => {
    const msg = ordenCreada.numeroOrden + ' — ' + (empresaSel ? empresaSel.name : '') + '\n\nCliente: ' + ordenCreada.clienteNombre + '\nTotal: ' + fmt(ordenCreada.total) + '\nForma de pago: ' + ordenCreada.formaPago + (ordenCreada.notasOrden ? '\nNota: ' + ordenCreada.notasOrden : '') + '\n\nGracias por su preferencia.';
    const cel = clienteSel && clienteSel.celular ? clienteSel.celular.replace(/\D/g, '') : '';
    window.open(cel ? 'https://wa.me/57' + cel + '?text=' + encodeURIComponent(msg) : 'https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
  };

  if (ordenCreada) {
    return (
      <div style={s.overlay}>
        <div style={{ ...s.modal, maxWidth: 500 }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid #f3f4f6' }}>
            <div style={{ fontSize: 13, color: '#16a34a', fontWeight: 700 }}>✅ Orden creada exitosamente</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#111', marginTop: 2 }}>{ordenCreada.numeroOrden}</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>{ordenCreada.clienteNombre} · {fmt(ordenCreada.total)}</div>
          </div>
          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#374151', fontWeight: 600 }}>¿Qué deseas hacer?</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <button onClick={() => imprimir('carta')} style={s.btnAccionModal}>🖨️ Carta / Media carta<br/><span style={{ fontSize: 11, fontWeight: 400 }}>Full color con membrete</span></button>
              <button onClick={() => imprimir('tirilla')} style={{ ...s.btnAccionModal, background: '#f9fafb', borderColor: '#374151', color: '#374151' }}>🧾 Tirilla 58mm<br/><span style={{ fontSize: 11, fontWeight: 400 }}>Blanco y negro · POS</span></button>
              <button onClick={enviarWhatsApp} style={{ ...s.btnAccionModal, background: '#f0fdf4', borderColor: '#25D366', color: '#15803d' }}>💬 WhatsApp<br/><span style={{ fontSize: 11, fontWeight: 400 }}>Enviar al cliente</span></button>
              <button onClick={() => { if (onCreada) onCreada(tipoServicio); }} style={{ ...s.btnAccionModal, background: '#f9fafb', borderColor: '#e5e7eb', color: '#6b7280' }}>✕ Cerrar<br/><span style={{ fontSize: 11, fontWeight: 400 }}>Volver al listado</span></button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mostrarFormCliente) {
    return (
      <div style={s.overlay}>
        <div style={{ ...s.modal, maxWidth: 460 }}>
          <div style={{ ...s.modalHeader }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>+ Nuevo cliente rápido</h3>
            <button onClick={() => setMostrarFormCliente(false)} style={s.btnCerrar}>✕</button>
          </div>
          <MiniFormCliente token={token} empresas={empresas} onCreado={(c) => { seleccionarCliente(c); setMostrarFormCliente(false); cargarClientes(); }} onCancelar={() => setMostrarFormCliente(false)} />
        </div>
      </div>
    );
  }

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>{esEdicion ? '✏️ Editar ' + (ordenEditar && ordenEditar.numeroOrden ? ordenEditar.numeroOrden : '') : '+ Nueva Orden de Servicio'}</h3>
            {clienteSel && <div style={{ fontSize: 12, color: '#7c3aed', marginTop: 2 }}>{clienteSel.nombre} · {empresaSel && empresaSel.name ? empresaSel.name : ''}</div>}
          </div>
          <button onClick={onCancelar} style={s.btnCerrar}>✕</button>
        </div>

        {error && <div style={s.alertError}>{error}</div>}
        {bloqueo && bloqueo.bloqueado && !pinDesbloqueado && (
          <div style={{ background: '#fef2f2', borderTop: '3px solid #dc2626', padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 800 }}>🔴 Cliente bloqueado por cartera vencida</div>
              <div style={{ fontSize: 13, color: '#374151', marginTop: 2 }}>
                Mora de <strong>{bloqueo.diasVencido} días</strong> · Valor adeudado: <strong style={{ color: '#dc2626' }}>{fmt(bloqueo.totalPendiente)}</strong>
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Solo un administrador puede autorizar este servicio</div>
            </div>
            <button onClick={() => setMostrarModalBloqueo(true)}
              style={{ padding: '8px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap' }}>
              🔐 Autorizar
            </button>
          </div>
        )}
        {bloqueo && bloqueo.bloqueado && pinDesbloqueado && (
          <div style={{ background: '#f0fdf4', borderTop: '3px solid #16a34a', padding: '10px 20px', fontSize: 13, color: '#16a34a', fontWeight: 700 }}>
            ✅ Autorizado — mora {bloqueo.diasVencido} días · {fmt(bloqueo.totalPendiente)} pendiente
          </div>
        )}

        <div style={s.modalBody}>
          <div style={s.grid2}>

            <div style={s.columna}>
              {(tipoServicio === 'interna' || tipoServicio === 'produccion') ? (
                <div style={s.seccion}>
                  <label style={s.label}>
                    {tipoServicio === 'produccion' ? 'Producción interna' : 'Tarea interna'}
                    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#0891b2', background: '#ecfeff', padding: '2px 8px', borderRadius: 10 }}>
                      No es venta · sin cliente · sin factura
                    </span>
                  </label>
                  <div style={{ marginTop: 10 }}>
                    <label style={s.label}>Asignar a *</label>
                    <select
                      style={s.input}
                      value={mensajeroId}
                      onChange={e => { setMensajeroId(e.target.value); const m = trabajadores.find(x => x.id === e.target.value); setMensajeroNombre(m ? m.nombre : ''); }}>
                      <option value="">Selecciona el trabajador...</option>
                      {trabajadores.map(m => (
                        <option key={m.id} value={m.id}>{m.nombre} {m.role ? `(${m.role})` : ''}</option>
                      ))}
                    </select>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
                      {tipoServicio === 'produccion'
                        ? 'Ej: Técnico de taller → recargar 10 extintores de cambio. Quedan en bodega como stock.'
                        : 'Ej: Mensajero → comprar resma de papel. Es una diligencia, sin inventario.'}
                    </div>
                  </div>
                  {tipoServicio === 'interna' && (
                    <div style={{ marginTop: 10 }}>
                      <label style={s.label}>Dirección <span style={{ fontWeight: 400, color: '#9ca3af' }}>(opcional)</span></label>
                      <input
                        style={{ ...s.input, marginBottom: 8 }}
                        placeholder="Ej: Calle 5 # 23-10, Centro Comercial Unicentro..."
                        value={notas.startsWith('DIR:') ? notas.split('\n')[0].replace('DIR:', '').trim() : ''}
                        onChange={e => {
                          const dir = e.target.value;
                          const resto = notas.includes('\n') ? notas.split('\n').slice(1).join('\n') : (notas.startsWith('DIR:') ? '' : notas);
                          setNotas(dir ? `DIR: ${dir}\n${resto}` : resto);
                        }}
                      />
                      <label style={s.label}>¿Qué debe hacer? *</label>
                      <textarea
                        style={{ ...s.input, height: 70, resize: 'vertical', fontFamily: 'inherit' }}
                        placeholder="Ej: Recoger vinilo de Jhonny Publicidad, comprar resma de papel carta..."
                        value={notas.includes('\n') ? notas.split('\n').slice(1).join('\n') : (notas.startsWith('DIR:') ? '' : notas)}
                        onChange={e => {
                          const tarea = e.target.value;
                          const dir = notas.startsWith('DIR:') ? notas.split('\n')[0] : '';
                          setNotas(dir ? `${dir}\n${tarea}` : tarea);
                        }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {tipoServicio !== 'cobranza' && <div style={s.seccion}>
                    <label style={s.label}>Empresa que factura *</label>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {empresas.map(e => (
                        <button key={e.id} type="button" onClick={() => setEmpresaSel(e)} style={{ padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, background: empresaSel && empresaSel.id === e.id ? '#7c3aed' : '#f3f4f6', color: empresaSel && empresaSel.id === e.id ? '#fff' : '#374151', border: empresaSel && empresaSel.id === e.id ? '2px solid #7c3aed' : '2px solid transparent' }}>🏢 {e.name}</button>
                      ))}
                    </div>
                  </div>}

                  <div style={s.seccion}>
                    <label style={s.label}>Cliente *</label>
                    {clienteSel ? (
                      <div style={s.clienteCard}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: '#111' }}>{clienteSel.nombre}</div>
                          <div style={{ fontSize: 12, color: '#6b7280' }}>{clienteSel.nit ? 'NIT: ' + clienteSel.nit : ''} {clienteSel.celular ? '· ' + clienteSel.celular : ''}</div>
                        </div>
                        <button onClick={() => { setClienteSel(null); setSucursalSel(null); setBloqueo(null); setCxcCliente([]); }} style={s.btnCambiar}>Cambiar</button>
                      </div>
                    ) : (
                      <div style={{ position: 'relative' }}>
                        <div style={s.searchWrap}>
                          <span style={{ color: '#9ca3af' }}>🔍</span>
                          <input style={s.searchInput} placeholder="Nombre, NIT o celular..." value={buscarCliente} onChange={e => { setBuscarCliente(e.target.value); cargarClientes(e.target.value); }} autoFocus />
                        </div>
                        {buscarCliente && (
                          <div style={s.dropdown}>
                            {clientesFiltrados.length === 0 ? (
                              <div style={{ padding: '12px 14px', color: '#6b7280', fontSize: 13 }}>
                                No encontrado — <button onClick={() => setMostrarFormCliente(true)} style={{ color: '#7c3aed', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>+ Crear cliente</button>
                              </div>
                            ) : clientesFiltrados.map(c => (
                              <div key={c.id} style={s.dropItem} onClick={() => seleccionarCliente(c)}>
                                <strong style={{ fontSize: 13 }}>{c.nombre}</strong>
                                <span style={{ fontSize: 12, color: '#9ca3af' }}>{c.nit ? ' · NIT: ' + c.nit : ''} {c.celular ? '· ' + c.celular : ''}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}

              {clienteSel && clienteSel.sucursales && clienteSel.sucursales.length > 0 && (
                <div style={s.seccion}>
                  <label style={s.label}>Sede</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ ...s.sucOpt, border: !sucursalSel ? '2px solid #7c3aed' : '2px solid #e5e7eb', background: !sucursalSel ? '#ede9fe' : '#f9fafb' }} onClick={() => setSucursalSel(null)}>
                      <strong style={{ fontSize: 13 }}>Sede principal</strong>
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>{clienteSel.direccionPrincipal}</span>
                      {/* Mini-Ola 2.6: sector del cliente */}
                      {clienteSel.sectorId && (() => {
                        const sec = sectores.find(s => s.id === clienteSel.sectorId);
                        if (!sec) return null;
                        return (
                          <span style={{ display: 'inline-block', marginTop: 4, padding: '2px 8px', borderRadius: 10, background: sec.color || '#6b7280', color: '#fff', fontSize: 10, fontWeight: 700 }}>
                            📍 {sec.etiqueta}
                          </span>
                        );
                      })()}
                    </div>
                    {clienteSel.sucursales.map((suc, i) => (
                      <div key={i} style={{ ...s.sucOpt, border: sucursalSel && sucursalSel.id === suc.id ? '2px solid #7c3aed' : '2px solid #e5e7eb', background: sucursalSel && sucursalSel.id === suc.id ? '#ede9fe' : '#f9fafb' }} onClick={() => setSucursalSel(suc)}>
                        <strong style={{ fontSize: 13 }}>{suc.nombre}</strong>
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>{suc.direccion} · {suc.encargado}</span>
                        {/* Mini-Ola 2.6: sector de la sucursal */}
                        {suc.sectorId && (() => {
                          const sec = sectores.find(s => s.id === suc.sectorId);
                          if (!sec) return null;
                          return (
                            <span style={{ display: 'inline-block', marginTop: 4, padding: '2px 8px', borderRadius: 10, background: sec.color || '#6b7280', color: '#fff', fontSize: 10, fontWeight: 700 }}>
                              📍 {sec.etiqueta}
                            </span>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tipoServicio === 'cobranza' && clienteSel && cxcCliente.length > 0 && (
                <div style={s.seccion}>
                  <label style={s.label}>Órdenes a cobrar</label>
                  <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: 12, fontSize: 13 }}>
                    {cxcCliente.map(o => (
                      <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #fee2e2' }}>
                        <span style={{ color: '#374151' }}>{o.numeroOrden}</span>
                        <span style={{ fontWeight: 700, color: '#dc2626' }}>{fmt(o.saldoPendiente)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontWeight: 800 }}>
                      <span>Total a cobrar:</span>
                      <span style={{ color: '#dc2626' }}>{fmt(cxcCliente.reduce((s, o) => s + o.saldoPendiente, 0))}</span>
                    </div>
                  </div>
                </div>
              )}

              {!(tipoServicio === 'interna' || tipoServicio === 'produccion') && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={s.seccion}>
                  {(() => {
                    const conIva = empresaSel?.iva > 0;
                    const facturaActiva = conIva || clientePideFactura;
                    return (
                      <>
                        <label style={s.label}>
                          N° Factura
                          {conIva
                            ? <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: '#0284c7', background: '#e0f2fe', padding: '2px 8px', borderRadius: 10 }}>Obligatorio — empresa con IVA</span>
                            : <span style={{ fontWeight: 400, color: '#9ca3af' }}> (opcional)</span>
                          }
                        </label>

                        {!conIva && (
                          <button
                            type="button"
                            onClick={() => { setClientePideFactura(!clientePideFactura); if (clientePideFactura) setNumeroFactura(''); }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              background: clientePideFactura ? '#7c3aed' : '#f3f4f6',
                              color: clientePideFactura ? '#fff' : '#6b7280',
                              border: 'none', borderRadius: 8,
                              padding: '8px 12px', fontSize: 12, fontWeight: 700,
                              cursor: 'pointer', marginBottom: 8, width: '100%'
                            }}>
                            <span style={{
                              width: 16, height: 16, borderRadius: '50%',
                              background: clientePideFactura ? '#fff' : '#cbd5e1',
                              display: 'inline-block'
                            }} />
                            {clientePideFactura ? '✓ El cliente pide factura' : '+ Crear factura (el cliente la pidió)'}
                          </button>
                        )}

                        {facturaActiva && (
                          <>
                            <input
                              style={{ ...s.input, borderColor: !numeroFactura ? '#f59e0b' : '#e5e7eb' }}
                              placeholder="FE-0001"
                              value={numeroFactura}
                              onChange={e => setNumeroFactura(e.target.value)}
                            />
                            {!numeroFactura && (
                              <div style={{ fontSize: 11, color: '#d97706', fontWeight: 600, marginTop: 4 }}>
                                ⚠️ Sin N° de factura la orden quedará "Facturar" hasta digitarlo
                              </div>
                            )}
                          </>
                        )}
                      </>
                    );
                  })()}
                </div>
                <div style={s.seccion}>
                  <label style={s.label}>Extintor préstamo <span style={{ fontWeight: 400, color: '#9ca3af' }}>(opc.)</span></label>
                  <input style={s.input} placeholder="#001, #002..." value={extintorPrestamo} onChange={e => setExtintor(e.target.value)} />
                </div>
              </div>
              )}

              {necesitaLogistica && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div style={s.seccion}>
                    <label style={s.label}>Fecha programada</label>
                    <input type="date" style={s.input} value={fechaProgramada} onChange={e => setFecha(e.target.value)} />
                  </div>
                  <div style={s.seccion}>
                    <label style={s.label}>Mensajero</label>
                    <select style={s.input} value={mensajeroId} onChange={e => { setMensajeroId(e.target.value); const m = mensajeros.find(x => x.id === e.target.value); setMensajeroNombre(m ? m.nombre : ''); }}>
                      <option value="">Sin asignar</option>
                      {mensajeros.map(m => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                    </select>
                  </div>
                </div>
              )}

              {(tipoServicio === 'interna' || tipoServicio === 'produccion') && (
                <div style={s.seccion}>
                  <label style={s.label}>Fecha programada</label>
                  <input type="date" style={s.input} value={fechaProgramada} onChange={e => setFecha(e.target.value)} />
                </div>
              )}

              <div style={s.seccion}>
                <label style={s.label}>Notas <span style={{ fontWeight: 400, color: '#9ca3af' }}>(opcional)</span></label>
                <textarea style={{ ...s.input, height: 60, resize: 'vertical', fontFamily: 'inherit' }} placeholder="Instrucciones especiales..." value={notas} onChange={e => setNotas(e.target.value)} />
              </div>
            </div>

            <div style={s.columna}>
              <div style={s.seccion}>
                <label style={s.label}>Tipo de servicio</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                  {TIPOS.filter(t => {
                    // modulosTenant: modulos del admin del tenant (que modulos tiene
                    // contratados el suscriptor). Determina que tipos de orden existen.
                    // user.modulos solo controla el menu de navegacion del usuario.
                    // Fallback: si no hay modulosTenant usar modulos del usuario.
                    const mods = user?.modulosTenant || user?.modulos || [];
                    // Si no tiene módulos definidos (admin principal) → mostrar todos
                    if (mods.length === 0) return true;
                    // Tipos que requieren módulo específico del TENANT
                    if (t.value === 'taller')     return mods.includes('taller');
                    if (t.value === 'despacho')   return mods.includes('logistica');
                    if (t.value === 'domicilio')  return mods.includes('logistica');
                    if (t.value === 'cobranza')   return mods.includes('cxc');
                    if (t.value === 'produccion') return mods.includes('taller');
                    if (t.value === 'interna')    return mods.includes('logistica') || mods.includes('taller');
                    return true; // oficina siempre visible
                  }).map(t => (
                    <button key={t.value} type="button" onClick={() => { setTipoServicio(t.value); if (t.value === 'cobranza' && clienteSel) cargarCxcCliente(clienteSel.id); }} style={{ padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, background: tipoServicio === t.value ? t.color : '#f3f4f6', color: tipoServicio === t.value ? '#fff' : '#374151', border: tipoServicio === t.value ? '2px solid ' + t.color : '2px solid transparent', transition: 'all 0.15s' }}>{t.label}</button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Estado inicial: <strong style={{ color: tipoInfo.color }}>{tipoInfo.estado.replace('_', ' ')}</strong></div>
              </div>

              {!(tipoServicio === 'interna' || tipoServicio === 'produccion' || tipoServicio === 'cobranza') && (
                <div style={s.seccion}>
                  <label style={s.label}>Forma de pago *</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                    {formasPagoConfig.map(f => (
                      <button key={f.nombre} type="button" onClick={() => {
                        setFormaPago(f.nombre);
                        // Reset comprobante al cambiar forma de pago
                        setPagoAdelantado(false);
                        setFotoComprobante('');
                      }} style={{ padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, background: formaPago === f.nombre ? '#0284c7' : '#f3f4f6', color: formaPago === f.nombre ? '#fff' : '#374151', border: formaPago === f.nombre ? '2px solid #0284c7' : '2px solid transparent' }}>{f.nombre}</button>
                    ))}
                  </div>

                  {/* Ola 2.5: Aviso CxC */}
                  {esFormaPagoCxC(formaPago) && (() => {
                    const modsT = user?.modulosTenant || user?.modulos || [];
                    const tieneLogistica = modsT.length === 0 || modsT.includes('logistica');
                    return (
                      <div style={{
                        marginTop: 10, padding: '10px 14px',
                        background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8,
                        fontSize: 12, color: '#78350f', display: 'flex', gap: 10, alignItems: 'flex-start'
                      }}>
                        <span style={{ fontSize: 18 }}>💳</span>
                        <div>
                          <strong>Estás creando una orden sin pago inmediato.</strong>
                          <br />
                          {tieneLogistica
                            ? 'Si el cliente decide pagar al recoger o al recibir el servicio, el mensajero puede registrar el pago desde Logística. La orden quedará marcada como pagada y NO se permitirá cobrar de nuevo.'
                            : 'Para registrar el pago o abono cuando el cliente cancele, dirígete al módulo CxC.'}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Ola 2.5: Comprobante de pago adelantado para formas virtuales */}
                  {esFormaPagoVirtual(formaPago) && (
                    <div style={{
                      marginTop: 10, padding: '12px 14px',
                      background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 8
                    }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#1e3a8a' }}>
                        <input type="checkbox" checked={pagoAdelantado}
                          onChange={e => {
                            setPagoAdelantado(e.target.checked);
                            if (!e.target.checked) setFotoComprobante('');
                          }}
                          style={{ width: 16, height: 16, cursor: 'pointer' }} />
                        El cliente ya pagó por {formaPago} (cargar comprobante)
                      </label>

                      {pagoAdelantado && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 11, color: '#1e3a8a', marginBottom: 6 }}>
                            📎 Sube la foto o PDF del comprobante. Quedará pendiente de validación por Admin/Tesorería.
                          </div>
                          <input ref={fotoComprobanteRef} type="file" accept="image/*,application/pdf,.pdf"
                            style={{ display: 'none' }}
                            onChange={e => e.target.files[0] && subirComprobante(e.target.files[0])} />
                          {fotoComprobante ? (
                            <div style={{ position: 'relative' }}>
                              {fotoComprobante.includes('.pdf') || fotoComprobante.includes('/pdf') ? (
                                <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ fontSize: 24 }}>📄</span>
                                  <div>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: '#166534' }}>PDF cargado</div>
                                    <a href={fotoComprobante} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#0284c7' }}>Ver documento</a>
                                  </div>
                                </div>
                              ) : (
                                <img src={fotoComprobante} alt="comprobante"
                                  style={{ width: '100%', maxHeight: 200, objectFit: 'contain', borderRadius: 6, background: '#fff' }} />
                              )}
                              <button type="button" onClick={() => setFotoComprobante('')}
                                style={{ position: 'absolute', top: 6, right: 6, background: '#dc2626', color: '#fff', border: 'none', borderRadius: '50%', width: 26, height: 26, cursor: 'pointer', fontSize: 13 }}>✕</button>
                            </div>
                          ) : (
                            <button type="button" onClick={() => fotoComprobanteRef.current?.click()}
                              disabled={subiendoComprobante}
                              style={{ width: '100%', padding: '10px', border: '2px dashed #93c5fd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#1e3a8a', fontWeight: 600 }}>
                              {subiendoComprobante ? 'Subiendo...' : '📎 Cargar foto o PDF del comprobante'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div style={s.seccion}>
                <label style={s.label}>
                  {tipoServicio === 'produccion' ? 'Equipos a producir (sin precio)' : 'Productos / servicios'}
                </label>
                <div style={{ position: 'relative' }}>
                  {tipoServicio !== 'interna' && <div style={s.searchWrap}>
                    <span style={{ color: '#9ca3af' }}>🔍</span>
                    <input ref={prodRef} style={s.searchInput} placeholder="Buscar por nombre o código..." value={buscarProd} onChange={e => setBuscarProd(e.target.value)} />
                  </div>}
                  {buscarProd && productosFiltrados.length > 0 && (
                    <div style={s.dropdown}>
                      {productosFiltrados.map(p => (
                        <div key={p.id} style={s.dropItem} onClick={() => agregarProducto(p)}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div><code style={{ fontSize: 11, color: '#9ca3af' }}>{p.codigo}</code><strong style={{ marginLeft: 8, fontSize: 13 }}>{p.nombre}</strong><span style={{ marginLeft: 8, fontSize: 11, color: '#9ca3af' }}>{p.categoria}</span></div>
                            {tipoServicio !== 'produccion' && <strong style={{ color: '#16a34a', fontSize: 13 }}>{fmt(p.precioVenta)}</strong>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {items.length > 0 && (
                  <div style={{ marginTop: 10, overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 480 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb' }}>
                          {(tipoServicio === 'produccion'
                            ? ['Producto', 'Cant.', 'Notas', '']
                            : ['Producto', 'Cant.', 'Precio', 'Desc.%', 'Notas', 'Total', '']
                          ).map(h => (
                            <th key={h} style={{ padding: '8px 8px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '8px 8px' }}>
                              <div style={{ fontWeight: 600, fontSize: 12 }}>{item.nombre}</div>
                              <div style={{ fontSize: 10, color: '#9ca3af' }}>{item.categoria}</div>
                            </td>
                            <td style={{ padding: '8px 4px' }}><input type="number" min="1" value={item.cantidad} onChange={e => editarItem(idx, 'cantidad', parseInt(e.target.value) || 1)} style={{ ...s.inputPeq, width: 48 }} /></td>
                            <td style={{ padding: '8px 4px' }}>{tipoServicio !== 'produccion' && <input type="number" min="0" value={item.precioUnitario === 0 ? '' : item.precioUnitario} placeholder="0" onChange={e => editarItem(idx, 'precioUnitario', e.target.value === '' ? 0 : Number(e.target.value))} style={{ ...s.inputPeq, width: 78 }} />}</td>
                            <td style={{ padding: '8px 4px' }}>{tipoServicio !== 'produccion' && <input type="number" min="0" max="100" value={item.descuento} onChange={e => editarItem(idx, 'descuento', parseFloat(e.target.value) || 0)} style={{ ...s.inputPeq, width: 48 }} />}</td>
                            <td style={{ padding: '8px 4px' }}>
                              <input type="text" value={item.notas} placeholder="Detalle..." onChange={e => editarItem(idx, 'notas', e.target.value)} style={{ ...s.inputPeq, width: 100 }} />
                              {(() => {
                                const cat = (item.categoria || '').toLowerCase();
                                const esRecarga = cat.includes('recarga') || cat.includes('mantenimiento');
                                // ✅ FIX: solo mostrar si tiene módulo qr activo
                                const tieneQR = (user?.modulos || []).length === 0 || (user?.modulos || []).includes('qr');
                                if (!esRecarga || !tieneQR) return null;
                                const activo = !!item.esCambio;
                                return (
                                  <div style={{ marginTop: 6 }}>
                                    <button
                                      type="button"
                                      onClick={() => editarItem(idx, 'esCambio', !activo)}
                                      style={{
                                        display: 'flex', alignItems: 'center', gap: 6,
                                        background: activo ? '#7c3aed' : '#f3f4f6',
                                        color: activo ? '#fff' : '#6b7280',
                                        border: 'none', borderRadius: 20,
                                        padding: '4px 10px', fontSize: 11, fontWeight: 700,
                                        cursor: 'pointer', width: '100%'
                                      }}>
                                      <span style={{
                                        width: 14, height: 14, borderRadius: '50%',
                                        background: activo ? '#fff' : '#cbd5e1',
                                        display: 'inline-block'
                                      }} />
                                      {activo ? '✓ ES CAMBIO' : 'Es cambio?'}
                                    </button>
                                    {activo && (
                                      <input
                                        type="text"
                                        value={item.codigoQR || ''}
                                        placeholder="ID QR del equipo de cambio"
                                        onChange={e => editarItem(idx, 'codigoQR', e.target.value.toUpperCase())}
                                        style={{ ...s.inputPeq, width: 100, marginTop: 4, borderColor: '#7c3aed' }}
                                      />
                                    )}
                                  </div>
                                );
                              })()}
                            </td>
                            <td style={{ padding: '8px 8px', fontWeight: 700, color: '#16a34a', whiteSpace: 'nowrap' }}>{tipoServicio !== 'produccion' && fmt((Number(item.precioUnitario) || 0) * (Number(item.cantidad) || 1) * (1 - (Number(item.descuento) || 0) / 100))}</td>
                            <td style={{ padding: '8px 4px' }}><button onClick={() => eliminarItem(idx)} style={{ background: '#fef2f2', border: 'none', borderRadius: 4, padding: '3px 7px', cursor: 'pointer', color: '#dc2626', fontSize: 12 }}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 8, padding: '10px 12px', background: '#f9fafb', borderRadius: 8, fontSize: 13 }}>
                      {tipoServicio !== 'produccion' && <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280', marginBottom: 4 }}><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
                        {ivaPct > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6b7280', marginBottom: 4 }}><span>IVA ({ivaPct}%)</span><span>{fmt(ivaValor)}</span></div>}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 15, borderTop: '1px solid #e5e7eb', paddingTop: 6 }}><span>TOTAL</span><span style={{ color: '#16a34a' }}>{fmt(total)}</span></div>
                      </>}
                      {tipoServicio === 'produccion' && (
                        <div style={{ color: '#6b7280', fontSize: 12, fontStyle: 'italic', textAlign: 'center' }}>
                          Orden interna — sin costo para el cliente
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={s.modalFooter}>
          <button onClick={onCancelar} style={s.btnCancelar}>Cancelar</button>
          {alertaTaller && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: '#fff', borderRadius: 16, padding: 24, maxWidth: 400, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
                <div style={{ fontSize: 40, textAlign: 'center', marginBottom: 12 }}>⚠️</div>
                <h3 style={{ textAlign: 'center', fontSize: 17, fontWeight: 800, marginBottom: 8 }}>Extintor irá al taller</h3>
                <p style={{ fontSize: 13, color: '#6b7280', textAlign: 'center', lineHeight: 1.5, marginBottom: 20 }}>
                  Tienes productos de recarga/mantenimiento sin marcar como <strong>"Es cambio"</strong>. El extintor pasará al proceso de taller.<br/><br/>
                  Si el cliente solo viene a recoger un extintor ya listo, márcalo como <strong>cambio</strong> para que vaya directo a entrega.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button onClick={() => { setAlertaTaller(false); crearOrden(true); }}
                    style={{ padding: '13px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                    ✅ Sí, el extintor va al taller
                  </button>
                  <button onClick={() => setAlertaTaller(false)}
                    style={{ padding: '13px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
                    ← Volver y marcar como cambio
                  </button>
                </div>
              </div>
            </div>
          )}
          <button onClick={esEdicion ? guardarEdicion : crearOrden}
            disabled={guardando || (bloqueo?.bloqueado && !pinDesbloqueado)}
            style={{ padding: '11px 28px', background: bloqueo?.bloqueado && !pinDesbloqueado ? '#9ca3af' : 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 9, cursor: (guardando || (bloqueo?.bloqueado && !pinDesbloqueado)) ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 14, opacity: guardando ? 0.7 : 1 }}>
            {guardando ? 'Guardando...' : esEdicion ? '💾 Guardar cambios' : '✅ Crear orden'}
          </button>
        </div>
      </div>

      {/* MODAL PIN AUTORIZACIÓN */}
      {mostrarModalBloqueo && (
        <ModalPinBloqueo
          bloqueo={bloqueo}
          empresas={empresas}
          clienteNombre={clienteSel?.nombre}
          onAutorizado={() => { setPinDesbloqueado(true); setMostrarModalBloqueo(false); }}
          onCancelar={() => setMostrarModalBloqueo(false)}
        />
      )}
    </div>
  );
};

const ModalPinBloqueo = ({ bloqueo, empresas, clienteNombre, onAutorizado, onCancelar }) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [verificando, setVerificando] = useState(false);
  const fmt2 = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

  const verificar = async () => {
    if (pin.length !== 4) return setError('Ingresa los 4 dígitos del PIN');
    setVerificando(true); setError('');
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('http://localhost:5000/api/companies/verificar-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (data.autorizado) { onAutorizado(); }
      else { setError('PIN incorrecto'); setPin(''); }
    } catch { setError('Error al verificar PIN'); }
    setVerificando(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        <div style={{ background: 'linear-gradient(135deg,#dc2626,#b91c1c)', padding: '20px 24px' }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#fff' }}>🔐 Autorización requerida</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>Solo un administrador puede continuar</p>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '14px 16px', marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>{clienteNombre}</div>
            <div style={{ fontSize: 13, color: '#374151', marginTop: 6 }}>
              ⏰ Mora: <strong style={{ color: '#dc2626' }}>{bloqueo?.diasVencido} días</strong>
            </div>
            <div style={{ fontSize: 13, color: '#374151', marginTop: 4 }}>
              💰 Valor adeudado: <strong style={{ color: '#dc2626' }}>{fmt2(bloqueo?.totalPendiente)}</strong>
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>⚠️ Está a punto de prestar un servicio a un cliente con cartera vencida</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>PIN de administrador (4 dígitos)</label>
            <input
              type="password" inputMode="numeric" maxLength={4}
              value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && verificar()}
              placeholder="••••"
              autoFocus
              style={{ padding: '14px', border: error ? '2px solid #dc2626' : '2px solid #e5e7eb', borderRadius: 10, fontSize: 24, textAlign: 'center', letterSpacing: 12, outline: 'none', fontWeight: 800 }}
            />
            {error && <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 600 }}>⚠️ {error}</div>}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onCancelar}
              style={{ flex: 1, padding: '11px', background: '#f3f4f6', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
              Cancelar
            </button>
            <button onClick={verificar} disabled={verificando || pin.length !== 4}
              style={{ flex: 1, padding: '11px', background: pin.length === 4 ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: 9, cursor: pin.length === 4 ? 'pointer' : 'not-allowed', fontWeight: 700, fontSize: 14 }}>
              {verificando ? 'Verificando...' : '🔐 Autorizar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const MiniFormCliente = ({ token, empresas, onCreado, onCancelar }) => {
  const headers = { Authorization: 'Bearer ' + token };
  const [form, setForm] = useState({ nombre: '', nit: '', celular: '', email: '', direccionPrincipal: '', empresaId: empresas.length > 0 ? empresas[0].id : '' });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const guardar = async () => {
    if (!form.nombre.trim()) return setError('Nombre requerido');
    if (!form.empresaId) return setError('Selecciona la empresa');
    if (!form.celular || form.celular.length < 10) return setError('Celular debe tener 10 dígitos');
    setGuardando(true); setError('');
    try {
      const payload = { ...form, nombre: form.nombre.toUpperCase().trim(), nit: form.nit.replace(/\D/g, ''), celular: form.celular.replace(/\D/g, ''), activo: true };
      const API2 = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
      const res = await axios.post(API2 + '/clients', payload, { headers });
      onCreado({ ...payload, id: res.data.id || res.data.clienteId });
    } catch (e) { setError((e.response && e.response.data && e.response.data.error) ? e.response.data.error : 'Error al crear cliente'); }
    setGuardando(false);
  };

  const campos = [
    { key: 'nombre',            label: 'Nombre / Razón social *', placeholder: 'NOMBRE EN MAYÚSCULAS', tipo: 'text' },
    { key: 'nit',               label: 'NIT / Cédula',            placeholder: 'Solo números',          tipo: 'text' },
    { key: 'celular',           label: 'Celular *',               placeholder: '10 dígitos',            tipo: 'text' },
    { key: 'email',             label: 'Email',                   placeholder: 'correo@empresa.com',    tipo: 'email' },
    { key: 'direccionPrincipal',label: 'Dirección',               placeholder: 'Calle 123 # 45-67',     tipo: 'text' },
  ];

  return (
    <div style={{ padding: '16px 24px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <div style={{ color: '#dc2626', fontSize: 13, fontWeight: 600 }}>⚠️ {error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Empresa que factura *</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {empresas.map(e => <button key={e.id} type="button" onClick={() => set('empresaId', e.id)} style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer', background: form.empresaId === e.id ? '#7c3aed' : '#f3f4f6', color: form.empresaId === e.id ? '#fff' : '#374151', border: 'none' }}>{e.name}</button>)}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {campos.map(f => (
          <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: f.key === 'direccionPrincipal' ? '1 / -1' : 'auto' }}>
            <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{f.label}</label>
            <input type={f.tipo} style={{ padding: '9px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', color: '#111' }}
              placeholder={f.placeholder} value={form[f.key]}
              onChange={e => set(f.key, f.key === 'nombre' ? e.target.value.toUpperCase() : (f.key === 'nit' || f.key === 'celular') ? e.target.value.replace(/\D/g, '') : e.target.value)} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
        <button onClick={onCancelar} style={{ padding: '9px 20px', background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>Cancelar</button>
        <button onClick={guardar} disabled={guardando} style={{ padding: '9px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>{guardando ? 'Creando...' : '✅ Crear y seleccionar'}</button>
      </div>
    </div>
  );
};

const s = {
  overlay:       { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal:         { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 1100, maxHeight: '95vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  modalHeader:   { padding: '16px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 },
  modalBody:     { flex: 1, overflow: 'auto', padding: '16px 20px' },
  modalFooter:   { padding: '14px 20px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 12, flexShrink: 0 },
  btnCerrar:     { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16, color: '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  btnCancelar:   { padding: '11px 22px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  alertError:    { background: '#fef2f2', borderLeft: '4px solid #dc2626', color: '#dc2626', padding: '10px 16px', fontSize: 13, fontWeight: 600, flexShrink: 0 },
  grid2:         { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 },
  columna:       { display: 'flex', flexDirection: 'column', gap: 14 },
  seccion:       { display: 'flex', flexDirection: 'column', gap: 6 },
  label:         { fontSize: 13, fontWeight: 700, color: '#374151' },
  input:         { padding: '9px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', color: '#111', background: '#fff', width: '100%', boxSizing: 'border-box' },
  inputPeq:      { padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, outline: 'none', background: '#fff', boxSizing: 'border-box' },
  searchWrap:    { display: 'flex', alignItems: 'center', gap: 8, border: '2px solid #e5e7eb', borderRadius: 8, padding: '0 10px', background: '#fff' },
  searchInput:   { flex: 1, border: 'none', outline: 'none', fontSize: 13, padding: '9px 4px', background: 'transparent', color: '#111' },
  dropdown:      { position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 100, maxHeight: 220, overflowY: 'auto' },
  dropItem:      { padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #f9fafb' },
  clienteCard:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f0fdf4', border: '2px solid #86efac', borderRadius: 8, padding: '10px 14px' },
  btnCambiar:    { fontSize: 12, color: '#6b7280', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' },
  sucOpt:        { padding: '8px 12px', borderRadius: 8, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 },
  btnAccionModal:{ padding: 14, border: '2px solid #7c3aed', borderRadius: 10, background: '#ede9fe', color: '#7c3aed', cursor: 'pointer', fontWeight: 700, fontSize: 13, textAlign: 'center' },
};

export default NuevaOrden;