import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const ESTADOS = {
  programada:       { label: 'Programada',       color: '#6366f1', bg: '#eef2ff',  siguiente: 'en_ruta_recogida' },
  en_ruta_recogida: { label: 'En Ruta Recogida', color: '#f59e0b', bg: '#fffbeb',  siguiente: 'en_taller' },
  en_taller:        { label: 'En Taller',         color: '#8b5cf6', bg: '#f5f3ff',  siguiente: 'facturado' },
  listo_entregar:   { label: 'Listo para Entregar', color: '#0891b2', bg: '#ecfeff', siguiente: 'completada' },
  facturado:        { label: 'Facturado',          color: '#0284c7', bg: '#e0f2fe',  siguiente: 'despacho' },
  despacho:         { label: 'Despacho',           color: '#d97706', bg: '#fef3c7',  siguiente: 'en_ruta_entrega' },
  en_ruta_entrega:  { label: 'En Ruta Entrega',   color: '#059669', bg: '#ecfdf5',  siguiente: 'entrega_cobranza' },
  entrega_cobranza: { label: 'Entrega Cobranza',  color: '#dc2626', bg: '#fef2f2',  siguiente: 'cuadre_dinero' },
  reparacion_proceso: { label: 'Reparación en Proceso', color: '#e11d48', bg: '#ffe4e8', siguiente: 'facturado' },
  cuadre_dinero:    { label: 'Completada',         color: '#16a34a', bg: '#f0fdf4',  siguiente: null },
  completada:       { label: 'Completada',         color: '#16a34a', bg: '#f0fdf4',  siguiente: null },
  cxc:              { label: 'Cuenta por Cobrar',  color: '#b45309', bg: '#fffbeb',  siguiente: null },
  anulada:          { label: 'Anulada',           color: '#dc2626', bg: '#fef2f2',  siguiente: null },
};

const formatCOP = (v) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);
const formatFecha = (f) => { if (!f) return '—'; try { return new Date(f).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return '—'; } };
const formatFechaCorta = (f) => { if (!f) return '—'; try { return new Date(f).toLocaleDateString('es-CO'); } catch { return '—'; } };

const FORMAS_DEFAULT = ['Efectivo', 'Transferencia', 'Nequi', 'Daviplata', 'Datafono', 'A crédito (CxC)'];

const DetalleOrden = ({ user, ordenId, onVolver }) => {
  const [orden, setOrden]               = useState(null);
  const [empresa, setEmpresa]           = useState(null);
  const [loading, setLoading]           = useState(true);
  const [cambiandoEstado, setCambiando] = useState(false);
  const [notasEstado, setNotasEstado]   = useState('');
const [numeroFactura, setNumeroFactura] = useState('');
  const [error, setError]               = useState('');
  const [exito, setExito]               = useState('');
  // Pago inline — sin modal separado
  const [mostrarPago, setMostrarPago]   = useState(false);
const [configCerts, setConfigCerts]   = useState([]);
  const [mostrarListaCerts, setMostrarListaCerts] = useState(false);
  const [formaPago, setFormaPago]       = useState('');
  const [montoPago, setMontoPago]       = useState('');
  const [registrandoPago, setRegPago]   = useState(false);
  const [formasPago, setFormasPago]     = useState(FORMAS_DEFAULT);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };
  const isAdmin = user?.role === 'admin';

  useEffect(() => { cargarOrden(); cargarFormasPago(); cargarConfigCerts(); }, [ordenId]);

  const cargarOrden = async () => {
    try {
      setLoading(true);
      const res = await axios.get(`${API}/orders/${ordenId}`, { headers });
      setOrden(res.data);
      if (res.data.empresaId) {
        const empRes = await axios.get(`${API}/companies/${res.data.empresaId}`, { headers }).catch(() => null);
        if (empRes) setEmpresa(empRes.data);
      }
    } catch { setError('Error cargando orden'); }
    finally { setLoading(false); }
  };
const cargarConfigCerts = async () => {
    try {
      const res = await axios.get(`${API}/companies/certificados/config`, { headers });
      setConfigCerts(res.data.categorias || []);
    } catch { }
  };
  const cargarFormasPago = async () => {
    try {
      const res = await axios.get(`${API}/configuracion`, { headers });
      const activas = (res.data.formasPago || []).filter(f => f.activa).map(f => f.nombre);
      if (activas.length > 0) setFormasPago(activas);
    } catch { /* usa defaults */ }
  };

 const cambiarEstado = async (nuevoEstado) => {
  try {
    setCambiando(true);
    const res = await axios.put(`${API}/orders/${ordenId}/estado`, {
      nuevoEstado,
      notas: notasEstado,
      // Siempre enviamos el N° de factura si está digitado. El backend decide
      // si lo necesita y avanza en cascada automáticamente.
      numeroFactura: numeroFactura || undefined
    }, { headers });
    // El backend pudo encadenar varios estados (cascada automática).
    const estadoReal = res.data?.estado || nuevoEstado;
    setExito(`Estado: ${ESTADOS[estadoReal]?.label || estadoReal}`);
    setNotasEstado('');
    setNumeroFactura('');
      await cargarOrden();
      setTimeout(() => setExito(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Error cambiando estado');
    } finally { setCambiando(false); }
  };

  // ── Pago simplificado: un solo clic, sin modal extra ──────────────────────
  const registrarPago = async () => {
    if (!formaPago) return setError('Selecciona la forma de pago');
    try {
      setRegPago(true);
      const monto = parseFloat(montoPago) || orden.total;
      const res = await axios.post(`${API}/orders/${ordenId}/pago`, {
        montoPagado: monto,
        formaPago,
        // Si ya hay N° de factura digitado, lo enviamos: el backend registra
        // el pago Y avanza la orden en cascada automáticamente.
        numeroFactura: numeroFactura || undefined
      }, { headers });

      const caja = res.data.caja;
      if (caja?.tipo === 'cxc') {
        setExito('✅ Pago registrado — CxC creada');
      } else if (caja?.tipo === 'duplicado') {
        setExito('ℹ️ Esta orden ya estaba pagada (no se duplicó)');
      } else if (caja?.tipo === 'caja') {
        setExito('✅ Pago registrado — Dinero ingresó a caja automáticamente');
      } else if (caja?.tipo === 'sin_caja') {
        setExito('✅ Pago registrado — ⚠️ Configura el mapeo de cajas en Mi Empresa');
      } else {
        setExito('✅ Pago registrado');
      }

      setMostrarPago(false);
      setFormaPago('');
      setMontoPago('');
      await cargarOrden();
      setTimeout(() => setExito(''), 5000);
    } catch (err) {
      if (err.response?.status === 409) {
        setError(err.response?.data?.error || 'Esta orden ya está pagada o se cobra en el cuadre del mensajero.');
        await cargarOrden();
      } else {
        setError(err.response?.data?.error || 'Error registrando pago');
      }
    } finally { setRegPago(false); }
  };

  const anularOrden = async () => {
    const motivo = window.prompt('Motivo de anulación (obligatorio):');
    if (!motivo?.trim()) return;
    if (!window.confirm('¿Confirma anular esta orden?')) return;
    try {
      await axios.put(`${API}/orders/${ordenId}/estado`, { nuevoEstado: 'anulada', notas: 'ANULADA: ' + motivo }, { headers });
      setExito('Orden anulada');
      await cargarOrden();
    } catch (err) {
      setError(err.response?.data?.error || 'Error al anular');
    }
  };

  const enviarWhatsApp = () => {
    const cel = orden.clienteCelular?.replace(/\D/g, '');
    if (!cel) { setError('El cliente no tiene celular registrado'); return; }
    const msg = `Hola ${orden.clienteNombre}, le informamos sobre su orden ${orden.numeroOrden}.\n\nEstado: ${ESTADOS[orden.estado]?.label}\nTotal: ${formatCOP(orden.total)}\n\nGracias por preferirnos.\n${empresa?.name || ''}`;
    window.open(`https://wa.me/57${cel}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  const imprimirOrden = (formato = 'carta') => {
    const contenido = generarHTMLImpresion(orden, empresa, formato);
    const ventana = window.open('', '_blank');
    ventana.document.write(contenido);
    ventana.document.close();
    ventana.focus();
    setTimeout(() => { ventana.print(); }, 500);
  };

 const imprimirCertificado = (configCat = null) => {
    const contenido = generarHTMLCertificadoDinamico(orden, empresa, configCat);
    const ventana = window.open('', '_blank');
    ventana.document.write(contenido);
    ventana.document.close();
    ventana.focus();
    setTimeout(() => { ventana.print(); }, 500);
  };

  // Obtener certificados disponibles para esta orden
  const certsDisponibles = () => {
    if (!configCerts.length) return [];
    return configCerts.filter(cat => {
      if (!cat.activo) return false;
      const catNorm = (cat.categoriaProducto || '').toLowerCase();
      return (orden.items || []).some(item => {
        const itemCat = (item.categoria || '').toLowerCase();
        return itemCat.includes(catNorm) || catNorm.includes(itemCat);
      });
    });
  };

  if (loading) return <div style={{ padding: '60px', textAlign: 'center', color: '#9ca3af' }}>Cargando orden...</div>;
  if (!orden) return <div style={{ padding: '60px', textAlign: 'center', color: '#dc2626' }}>Orden no encontrada</div>;

  const est = ESTADOS[orden.estado] || { label: orden.estado, color: '#666', bg: '#f3f4f6' };

  // Espejo EXACTO de construirFlujo() del backend (orders.js). El frontend NO
  // decide el flujo: solo necesita saber qué etiqueta mostrar en el botón. El
  // backend es la autoridad y puede encadenar en cascada. Mismos valores aquí.
  const getSiguienteEstado = () => {
    const norm = (l) => {
      const x = (l || 'domicilio').toLowerCase();
      if (x === 'oficina_rapida') return 'oficina';
      if (x === 'oficina_taller') return 'taller';
      return x;
    };
    const lugar = norm(orden.lugarAtencion);
    const F = !!orden.requiereFactura;
    // ¿La orden lleva equipos de taller? Define venta vs servicio.
    const T = typeof orden.tieneEquipoTaller === 'boolean'
      ? orden.tieneEquipoTaller
      : (orden.items || []).some(it => {
          const c = (it.categoria || '').toLowerCase();
          return ['recarga','mantenimiento','hidrostatica','hidrostática'].some(k => c.includes(k));
        });

    const domicilioServicio = F
      ? { programada: 'en_ruta_recogida', en_ruta_recogida: 'en_taller',
          en_taller: 'facturado', facturado: 'en_ruta_entrega',
          en_ruta_entrega: 'entrega_cobranza', entrega_cobranza: 'cuadre_dinero' }
      : { programada: 'en_ruta_recogida', en_ruta_recogida: 'en_taller',
          en_taller: 'en_ruta_entrega',
          en_ruta_entrega: 'entrega_cobranza', entrega_cobranza: 'cuadre_dinero' };
    // VENTA a domicilio: NO recoge, NO va a taller. Solo entrega y cobra.
    const domicilioVenta = { programada: 'en_ruta_entrega',
          en_ruta_entrega: 'entrega_cobranza', entrega_cobranza: 'cuadre_dinero' };

    const flujos = {
      oficina: F ? { facturado: 'completada' } : {},
      taller: F
        ? { en_taller: 'facturado', facturado: 'listo_entregar', listo_entregar: 'completada' }
        : { en_taller: 'listo_entregar', listo_entregar: 'completada' },
      despacho: F
        ? { despacho: 'facturado', facturado: 'en_ruta_entrega',
            en_ruta_entrega: 'entrega_cobranza', entrega_cobranza: 'cuadre_dinero' }
        : { despacho: 'en_ruta_entrega',
            en_ruta_entrega: 'entrega_cobranza', entrega_cobranza: 'cuadre_dinero' },
      domicilio: T ? domicilioServicio : domicilioVenta,
      cobranza: { programada: 'en_ruta_recogida',
            en_ruta_recogida: 'entrega_cobranza', entrega_cobranza: 'cuadre_dinero' },
      interna: { programada: 'completada' },
      produccion: { programada: 'en_taller', en_taller: 'completada' }
    };

    const flujo = flujos[lugar] || flujos.domicilio;
    return flujo[orden.estado] ?? null;
  };

  const siguienteEstado = getSiguienteEstado();

  // Ocultar "Pasar a Cuadre Dinero" si es oficina_rapida y ya está pagado
  // El cuadre es solo para mensajero que cobró efectivo en campo
  const mostrarSiguienteEstado = siguienteEstado &&
    orden.estado !== 'anulada' &&
    !(orden.lugarAtencion === 'oficina_rapida' && orden.pagado && siguienteEstado === 'cuadre_dinero');

  return (
    <div style={s.wrapper}>
      {/* HEADER */}
      <div style={s.pageHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button onClick={onVolver} style={s.btnBack}>← Volver</button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <h2 style={s.pageTitle}>{orden.numeroOrden}</h2>
              <span style={{ ...s.estadoBadge, background: est.bg, color: est.color }}>{est.label}</span>
              {orden.prioridad === 'urgente' && <span style={s.urgBadge}>🔴 URGENTE</span>}
              {orden.prioridad === 'alta' && <span style={{ ...s.urgBadge, background: '#fffbeb', color: '#d97706' }}>🟡 ALTA</span>}
              {orden.pagado && <span style={{ ...s.estadoBadge, background: '#f0fdf4', color: '#16a34a' }}>✅ PAGADO</span>}
              {orden.requiereFactura && <span style={{ ...s.estadoBadge, background: '#fef3c7', color: '#d97706' }}>📄 FACTURA DIAN</span>}
            </div>
            <p style={s.pageSubtitle}>{orden.clienteNombre} {orden.sucursalNombre && `— ${orden.sucursalNombre}`}</p>
          </div>
        </div>

        <div style={s.acciones}>
          {isAdmin && orden.estado !== 'cuadre_dinero' && orden.estado !== 'anulada' && (
            <button onClick={anularOrden} style={{ ...s.btnImprimir, background: '#dc2626' }}>🚫 Anular</button>
          )}
          <button onClick={enviarWhatsApp} style={s.btnWa}>📱 WhatsApp</button>
          <button onClick={() => imprimirOrden('carta')} style={s.btnImprimir}>🖨️ Imprimir</button>
          <button onClick={() => imprimirOrden('pos')} style={s.btnImprimir}>🧾 POS</button>
          {(orden.generaCertificado || certsDisponibles().length > 0) && (
            <div style={{ position: 'relative' }}>
              <button onClick={() => setMostrarListaCerts(!mostrarListaCerts)} style={s.btnCert}>
                📜 Certificado {certsDisponibles().length > 1 ? `(${certsDisponibles().length})` : ''}
              </button>
              {mostrarListaCerts && (
                <div style={{ position: 'absolute', top: '100%', right: 0, background: '#fff', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', border: '1px solid #e5e7eb', zIndex: 100, minWidth: 220, padding: 8 }}>
                  {certsDisponibles().length === 0 ? (
                    <div onClick={() => { imprimirCertificado(); setMostrarListaCerts(false); }}
                      style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 13, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 8 }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      📜 Certificado de Mantenimiento
                    </div>
                  ) : (
                    certsDisponibles().map(cat => (
                      <div key={cat.id}
                        onClick={() => { imprimirCertificado(cat); setMostrarListaCerts(false); }}
                        style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 13, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 8 }}
                        onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        📄 {cat.nombreDocumento}
                        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>{cat.norma}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <div style={s.alertError}>{error} <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626' }}>✕</button></div>}
      {exito && <div style={s.alertExito}>{exito}</div>}

      <div style={s.grid2}>
        {/* COLUMNA IZQUIERDA */}
        <div>
          {/* Info básica */}
          <div style={s.card}>
            <h3 style={s.cardTitulo}>📋 Información</h3>
            <div style={s.infoGrid}>
              <div style={s.infoItem}><span style={s.infoLabel}>Empresa</span><strong style={{ color: '#7c3aed' }}>{orden.empresaNombre}</strong></div>
              <div style={s.infoItem}><span style={s.infoLabel}>Tipo</span><span>{orden.tipoOrden}</span></div>
              <div style={s.infoItem}><span style={s.infoLabel}>Atención</span><span>{orden.lugarAtencion || '—'}</span></div>
              <div style={s.infoItem}><span style={s.infoLabel}>Fecha programada</span><span>{formatFechaCorta(orden.fechaProgramada)}{orden.horaProgramada && ` — ${orden.horaProgramada}`}</span></div>
              <div style={s.infoItem}><span style={s.infoLabel}>Mensajero</span><span>{orden.mensajeroNombre || <em style={{ color: '#9ca3af' }}>Sin asignar</em>}</span></div>
              <div style={s.infoItem}><span style={s.infoLabel}>Creado por</span><span>{orden.creadoPorNombre}</span></div>
{orden.numeroFactura && <div style={s.infoItem}><span style={s.infoLabel}>📄 N° Factura</span><strong style={{ color: '#0284c7' }}>{orden.numeroFactura}</strong></div>}
              {orden.notasOrden && <div style={{ ...s.infoItem, gridColumn: '1/-1' }}><span style={s.infoLabel}>📝 Notas</span><span style={{ color: '#374151', fontStyle: 'italic' }}>{orden.notasOrden}</span></div>}
            </div>
          </div>

          {/* Productos */}
          <div style={s.card}>
            <h3 style={s.cardTitulo}>📦 Productos / Servicios</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Producto', 'Cant.', 'Precio', 'Desc.', 'Notas', 'Total'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(orden.items || []).map((item, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontWeight: 600 }}>{item.nombre}</div>
                      <div style={{ fontSize: '11px', color: '#9ca3af' }}>{item.categoria}</div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>{item.cantidad}</td>
                    <td style={{ padding: '10px 12px' }}>{formatCOP(item.precioUnitario)}</td>
                    <td style={{ padding: '10px 12px', color: item.descuento > 0 ? '#dc2626' : '#9ca3af' }}>{item.descuento > 0 ? `-${item.descuento}%` : '—'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      {item.notas ? <span style={{ background: '#ede9fe', color: '#7c3aed', padding: '2px 8px', borderRadius: '4px', fontSize: '12px' }}>{item.notas}</span> : <span style={{ color: '#9ca3af' }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 700, color: '#16a34a' }}>{formatCOP(item.subtotalItem)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totales */}
            <div style={{ padding: '12px', background: '#f9fafb', borderRadius: '0 0 8px 8px' }}>
              <div style={s.totalRow}><span style={{ color: '#6b7280' }}>Subtotal</span><span>{formatCOP(orden.subtotal)}</span></div>
              {orden.ivaPct > 0 && <div style={s.totalRow}><span style={{ color: '#6b7280' }}>IVA ({orden.ivaPct}%)</span><span>{formatCOP(orden.ivaValor)}</span></div>}
              <div style={{ ...s.totalRow, fontWeight: 800, fontSize: '16px', borderTop: '2px solid #e5e7eb', paddingTop: '8px', marginTop: '4px' }}>
                <span>TOTAL</span><strong style={{ color: '#16a34a' }}>{formatCOP(orden.total)}</strong>
              </div>
              {orden.pagado && (
                <div style={{ marginTop: '8px', padding: '8px 12px', background: '#f0fdf4', borderRadius: '6px', fontSize: '13px', color: '#16a34a', display: 'flex', justifyContent: 'space-between' }}>
                  <span>✅ Pagado — {orden.formaPago}</span>
                  <strong>{formatCOP(orden.montoPagado)}</strong>
                </div>
              )}
            </div>
          </div>

          {/* Certificado */}
          {orden.generaCertificado && (
            <div style={s.card}>
              <h3 style={s.cardTitulo}>📜 Certificado de Mantenimiento</h3>
             {orden.certificadoGenerado ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ color: '#16a34a', fontWeight: 700 }}>✅ Certificado generado</div>
                    <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>Generado: {formatFechaCorta(orden.certificadoFecha)}</div>
                    {orden.alertaRenovacion && <div style={{ fontSize: '12px', color: '#f59e0b', marginTop: '2px' }}>⏰ Alerta renovación: {formatFechaCorta(orden.alertaRenovacion)}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {/* Botón imprimir con lista dinámica */}
                    <div style={{ position: 'relative' }}>
                      <button onClick={() => setMostrarListaCerts(v => !v)} style={s.btnCert}>
                        🖨️ Imprimir {certsDisponibles().length > 1 ? `(${certsDisponibles().length})` : ''}
                      </button>
                      {mostrarListaCerts && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, background: '#fff', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', border: '1px solid #e5e7eb', zIndex: 100, minWidth: 220, padding: 8 }}>
                          {certsDisponibles().length === 0 ? (
                            <div onClick={() => { imprimirCertificado(); setMostrarListaCerts(false); }}
                              style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 13, borderRadius: 7 }}
                              onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                              📜 Certificado de Mantenimiento
                            </div>
                          ) : (
                            certsDisponibles().map(cat => (
                              <div key={cat.id}
                                onClick={() => { imprimirCertificado(cat); setMostrarListaCerts(false); }}
                                style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 13, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 8 }}
                                onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                                📄 {cat.nombreDocumento}
                                <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>{cat.norma}</span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                    <button onClick={() => {
                      const cel = orden.clienteCelular?.replace(/\D/g, '');
                      const msg = `Hola ${orden.clienteNombre}, adjuntamos el certificado correspondiente a la orden ${orden.numeroOrden}.`;
                      window.open(`https://wa.me/57${cel}?text=${encodeURIComponent(msg)}`, '_blank');
                    }} style={s.btnWa}>📱 Enviar</button>
                  </div>
                </div>
              ) : (
                <div style={{ color: '#9ca3af', fontSize: '14px' }}>
                  ⏳ El certificado se generará automáticamente al completar el cuadre de dinero
                </div>
              )}
            </div>
          )}

          {/* GALERÍA DE FOTOS */}
          {(() => {
            const todasFotos = [
  ...(orden.fotoRecogida ? [{ url: orden.fotoRecogida, tipo: '📦 Recogida' }] : []),
  ...(orden.tallerPasos || []).filter(p => p.foto).map(p => ({ url: p.foto, tipo: `🔧 Taller — ${p.pasoNombre || ''}` })),
  ...(orden.tallerDefectos || []).filter(d => d.foto).map(d => ({ url: d.foto, tipo: `⚠️ Defecto — ${d.descripcion?.substring(0, 30) || ''}` })),
  ...(orden.fotoEntrega ? [{ url: orden.fotoEntrega, tipo: '✅ Entrega' }] : []),
  ...(orden.fotoTransferencia ? [{ url: orden.fotoTransferencia, tipo: '📄 Comprobante pago' }] : []),
];
            if (todasFotos.length === 0) return null;
            return (
              <div style={s.card}>
                <h3 style={s.cardTitulo}>📷 Galería de Fotos ({todasFotos.length})</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
                  {todasFotos.map((foto, i) => (
                    <div key={i} style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb', cursor: 'pointer' }}
                      onClick={() => window.open(foto.url, '_blank')}>
                      <img src={foto.url} alt={foto.tipo}
                        style={{ width: '100%', height: 100, objectFit: 'cover', display: 'block' }}
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                      <div style={{ padding: '4px 8px', fontSize: 11, color: '#6b7280', background: '#f9fafb', fontWeight: 600 }}>
                        {foto.tipo}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>

        {/* COLUMNA DERECHA */}
        <div>
          {/* ── PAGO — inline, sin modal ──────────────────────────────────── */}
          {!orden.pagado && orden.estado !== 'anulada' && (
            <div style={s.card}>
              <h3 style={s.cardTitulo}>💰 Pago</h3>
              {!mostrarPago ? (
                <div>
                  <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                    Total a cobrar: <strong style={{ color: '#111', fontSize: 16 }}>{formatCOP(orden.total)}</strong>
                  </div>
                  <button onClick={() => setMostrarPago(true)} style={s.btnPrimario}>
                    + Registrar pago
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                    Total: <strong style={{ color: '#16a34a', fontSize: 16 }}>{formatCOP(orden.total)}</strong>
                  </div>

                  {/* Formas de pago como botones visuales */}
                  <div style={s.campo}>
                    <label style={s.label}>Forma de pago *</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {formasPago.map(f => (
                        <button key={f} onClick={() => setFormaPago(f)} style={{
                          padding: '8px 14px', borderRadius: 8, border: '2px solid',
                          borderColor: formaPago === f ? '#667eea' : '#e5e7eb',
                          background: formaPago === f ? '#eef2ff' : '#f9fafb',
                          color: formaPago === f ? '#4f46e5' : '#374151',
                          fontWeight: formaPago === f ? 700 : 500,
                          fontSize: 13, cursor: 'pointer'
                        }}>{f}</button>
                      ))}
                    </div>
                  </div>

                  {/* Monto — solo si difiere del total */}
                  <div style={s.campo}>
                    <label style={s.label}>Monto recibido <span style={{ color: '#9ca3af', fontWeight: 400 }}>(opcional — por defecto el total)</span></label>
                    <input type="number" style={s.input} placeholder={orden.total?.toString()}
                      value={montoPago} onChange={e => setMontoPago(e.target.value)} />
                  </div>

                  {/* Aviso CxC */}
                  {(formaPago === 'A crédito (CxC)' || formaPago === 'A crédito') && (
                    <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: 10, fontSize: 12, color: '#92400e', marginBottom: 12 }}>
                      ⚠️ Esta orden quedará en Cuentas por Cobrar. No afecta caja.
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={registrarPago} disabled={registrandoPago || !formaPago} style={{ ...s.btnPrimario, opacity: !formaPago ? 0.5 : 1 }}>
                      {registrandoPago ? 'Registrando...' : '✅ Confirmar pago'}
                    </button>
                    <button onClick={() => { setMostrarPago(false); setFormaPago(''); setMontoPago(''); }} style={s.btnSecundario}>Cancelar</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── ESTADO ───────────────────────────────────────────────────── */}
          <div style={s.card}>
            <h3 style={s.cardTitulo}>🔄 Estado de la orden</h3>

            {/* Historial */}
            <div style={{ marginBottom: '20px' }}>
              {(orden.historialEstados || []).map((h, i) => {
                const estInfo = ESTADOS[h.estado] || { label: h.estado, color: '#666' };
                return (
                  <div key={i} style={s.historialItem}>
                    <div style={{ ...s.historialDot, background: estInfo.color }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: estInfo.color, fontSize: '13px' }}>{estInfo.label}</div>
                      <div style={{ fontSize: '11px', color: '#9ca3af' }}>{h.usuarioNombre} — {formatFechaCorta(h.fecha)}</div>
                      {h.notas && <div style={{ fontSize: '12px', color: '#6b7280', fontStyle: 'italic' }}>{h.notas}</div>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Siguiente estado */}
           {mostrarSiguienteEstado && (
  <>
  {(orden.estado === 'facturado' || (orden.estado === 'despacho' && orden.requiereFactura)) && (
  <div style={{ marginBottom: '12px' }}>
    <label style={{ ...s.label, marginBottom: 6, display: 'block' }}>
      📄 N° Factura DIAN
      {orden.requiereFactura && <span style={{ marginLeft: 6, fontSize: 11, color: '#d97706', fontWeight: 700 }}>obligatorio</span>}
    </label>
    <input style={{ ...s.input }}
      placeholder="FE-0001..."
      value={numeroFactura}
      onChange={e => setNumeroFactura(e.target.value)}
    />
  </div>
)}
    <input style={{ ...s.input, marginBottom: '12px' }}
      placeholder="Notas del cambio (opcional)..."
      value={notasEstado}
      onChange={e => setNotasEstado(e.target.value)}
    />
               {(() => {
    // Bloqueo de factura: aplica cuando la orden requiere factura Y el
    // siguiente paso sale del estado 'facturado' o entra a él (cualquier
    // flujo, no solo despacho). Resuelve tu bug de domicilio IVA 19%.
    const cruzaFactura = orden.requiereFactura &&
      (orden.estado === 'facturado' || siguienteEstado === 'facturado'
       || siguienteEstado === 'completada' || siguienteEstado === 'en_ruta_entrega'
       || siguienteEstado === 'listo_entregar')
      && !numeroFactura && !orden.numeroFactura;
    // Etiqueta especial: cuando el equipo de taller espera que el cliente venga
    const labelBoton = orden.estado === 'listo_entregar'
      ? '✓ Cliente recogió el equipo'
      : `→ Pasar a ${ESTADOS[siguienteEstado]?.label || siguienteEstado}`;
    return (
      <>
        {cruzaFactura && (
          <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#dc2626', fontWeight: 600, marginBottom: 8 }}>
            ⚠️ Debes ingresar el N° de factura DIAN antes de continuar
          </div>
        )}
        <button
          onClick={() => cambiarEstado(siguienteEstado)}
          disabled={cambiandoEstado || cruzaFactura}
          style={{ ...s.btnEstado, background: cruzaFactura ? '#9ca3af' : (ESTADOS[siguienteEstado]?.color || '#7c3aed') }}>
          {cambiandoEstado ? 'Actualizando...' : labelBoton}
        </button>
      </>
    );
  })()}
              </>
            )}

            {!mostrarSiguienteEstado && orden.estado !== 'anulada'
              && (orden.estado === 'cuadre_dinero' || orden.estado === 'completada') && (
              <div style={{ padding: '12px', background: '#f0fdf4', borderRadius: '8px', color: '#16a34a', fontWeight: 700, textAlign: 'center' }}>
                ✅ Orden completada
              </div>
            )}
            {!mostrarSiguienteEstado && orden.estado === 'cxc' && (
              <div style={{ padding: '12px', background: '#fffbeb', borderRadius: '8px', color: '#b45309', fontWeight: 700, textAlign: 'center' }}>
                💳 Orden en Cuenta por Cobrar
              </div>
            )}
          </div>

          {/* Cliente info */}
          <div style={s.card}>
            <h3 style={s.cardTitulo}>👥 Cliente</h3>
            <div style={s.infoGrid}>
              <div style={s.infoItem}><span style={s.infoLabel}>Nombre</span><strong>{orden.clienteNombre}</strong></div>
              {orden.clienteNit && <div style={s.infoItem}><span style={s.infoLabel}>NIT/CC</span><span>{orden.clienteNit}</span></div>}
              {orden.clienteCelular && (
                <div style={s.infoItem}>
                  <span style={s.infoLabel}>Celular</span>
                  <a href={`tel:${orden.clienteCelular}`} style={{ color: '#7c3aed', fontWeight: 600 }}>{orden.clienteCelular}</a>
                </div>
              )}
              {orden.sucursalDireccion && <div style={s.infoItem}><span style={s.infoLabel}>Dirección</span><span>{orden.sucursalDireccion}</span></div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── GENERADOR HTML IMPRESIÓN ORDEN ──────────────────────────────────────────
const generarHTMLImpresion = (orden, empresa, formato) => {
  const isPos = formato === 'pos';
  const ancho = isPos ? '80mm' : '148mm';
  const items = (orden.items || []).map(item => `
    <tr>
      <td>${item.nombre}${item.notas ? `<br/><small style="color:#666">${item.notas}</small>` : ''}</td>
      <td style="text-align:center">${item.cantidad}</td>
      <td style="text-align:right">${formatCOP(item.precioUnitario)}</td>
      ${item.descuento > 0 ? `<td style="text-align:center;color:#dc2626">-${item.descuento}%</td>` : '<td></td>'}
      <td style="text-align:right;font-weight:bold">${formatCOP(item.subtotalItem)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>${orden.numeroOrden}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: ${isPos ? '10px' : '11px'}; width: ${ancho}; margin: 0 auto; padding: ${isPos ? '4mm' : '8mm'}; }
    .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 8px; }
    .empresa-logo { font-size: ${isPos ? '14px' : '18px'}; font-weight: bold; color: #4c1d95; }
    .empresa-datos { font-size: ${isPos ? '9px' : '10px'}; color: #666; margin-top: 4px; }
    .orden-num { font-size: ${isPos ? '16px' : '20px'}; font-weight: bold; margin: 8px 0; }
    .cliente-box { background: #f5f5f5; padding: 6px; border-radius: 4px; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th { background: #f0f0f0; padding: 4px 6px; text-align: left; font-size: ${isPos ? '9px' : '10px'}; }
    td { padding: 4px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
    .totales { border-top: 2px solid #333; padding-top: 6px; }
    .total-final { font-size: ${isPos ? '14px' : '16px'}; font-weight: bold; color: #16a34a; }
    .footer { text-align: center; margin-top: 12px; padding-top: 8px; border-top: 1px dashed #ccc; font-size: ${isPos ? '8px' : '9px'}; color: #999; }
    .notas { background: #fffbeb; border: 1px solid #fcd34d; padding: 6px; border-radius: 4px; margin-bottom: 8px; font-size: ${isPos ? '9px' : '10px'}; }
    .pago-box { background: #f0fdf4; border: 1px solid #86efac; padding: 6px; border-radius: 4px; margin-top: 6px; font-size: ${isPos ? '9px' : '10px'}; }
    @media print { body { width: ${ancho}; } }
  </style></head><body>
  <div class="header">
    ${empresa?.logo ? `<img src="${empresa.logo}" style="height:${isPos ? '40px' : '55px'};object-fit:contain;margin-bottom:4px" /><br/>` : ''}
    <div class="empresa-logo">${empresa?.name || 'EXTINTORES'}</div>
    <div class="empresa-datos">
      NIT: ${empresa?.nit || ''} | Tel: ${empresa?.cellphone || empresa?.phone || ''}<br/>
      ${empresa?.address || ''} | ${empresa?.email || ''}
    </div>
  </div>
  <div style="text-align:center">
    <div class="orden-num">${orden.numeroOrden}</div>
    <div style="font-size:${isPos ? '9px' : '10px'};color:#666">${formatFecha(orden.fechaProgramada)}</div>
  </div>
  <div class="cliente-box">
    <strong>${orden.clienteNombre}</strong><br/>
    ${orden.clienteNit ? `NIT: ${orden.clienteNit}<br/>` : ''}
    ${orden.sucursalDireccion || ''}<br/>
    ${orden.clienteCelular || ''}
  </div>
  ${orden.notasOrden ? `<div class="notas">📝 ${orden.notasOrden}</div>` : ''}
  <table>
    <thead><tr><th>Descripción</th><th>Cant</th><th>Precio</th><th>Desc</th><th>Total</th></tr></thead>
    <tbody>${items}</tbody>
  </table>
  <div class="totales">
    <div style="display:flex;justify-content:space-between"><span>Subtotal:</span><span>${formatCOP(orden.subtotal)}</span></div>
    ${orden.ivaPct > 0 ? `<div style="display:flex;justify-content:space-between"><span>IVA (${orden.ivaPct}%):</span><span>${formatCOP(orden.ivaValor)}</span></div>` : ''}
    <div class="total-final" style="display:flex;justify-content:space-between;margin-top:4px"><span>TOTAL:</span><span>${formatCOP(orden.total)}</span></div>
  </div>
  ${orden.pagado ? `<div class="pago-box">✅ PAGADO — ${orden.formaPago} — ${formatCOP(orden.montoPagado)}</div>` : ''}
  <div class="footer">
    Elaborado con Control360 | 📞 3148361622<br/>
    <em>Sistema operativo para empresas de servicios</em>
  </div>
  </body></html>`;
};

// ─── GENERADOR HTML CERTIFICADO ──────────────────────────────────────────────
const generarHTMLCertificadoDinamico = (orden, empresa, configCat = null) => {
  const fechaServicio = new Date(orden.fechaProgramada || new Date()).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  const proximoAño = new Date(orden.fechaProgramada || new Date());
  proximoAño.setFullYear(proximoAño.getFullYear() + 1);
  const fechaProxima = proximoAño.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });

  const nombreDoc = configCat?.nombreDocumento || 'Certificado de Mantenimiento de Extintores';
  const norma = configCat?.norma || 'NTC 2885';
  const texto = configCat?.texto || 'Por medio del presente documento certificamos que se realizaron los servicios a los equipos relacionados a continuación.';
  const contenido = configCat?.contenido || '';

  // Filtrar items según categoría si hay config
  const items = configCat
    ? (orden.items || []).filter(item => {
        const itemCat = (item.categoria || '').toLowerCase();
        const catNorm = (configCat.categoriaProducto || '').toLowerCase();
        return itemCat.includes(catNorm) || catNorm.includes(itemCat);
      })
    : (orden.items || []).filter(i => {
        const cat = (i.categoria || '').toLowerCase();
        return cat.includes('recarga') || cat.includes('mantenimiento');
      });

  const filas = items.map((item, i) => `
    <tr>
      <td style="text-align:center;padding:6px 8px;border:1px solid #ddd">${i + 1}</td>
      <td style="padding:6px 8px;border:1px solid #ddd">${item.nombre}</td>
      <td style="text-align:center;padding:6px 8px;border:1px solid #ddd">${item.cantidad}</td>
      <td style="text-align:center;padding:6px 8px;border:1px solid #ddd">—</td>
      <td style="text-align:center;padding:6px 8px;border:1px solid #ddd">${fechaServicio}</td>
      <td style="text-align:center;padding:6px 8px;border:1px solid #ddd;color:#dc2626;font-weight:bold">${fechaProxima}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>${nombreDoc} — ${orden.numeroOrden}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 11px; padding: 15mm; color: #333; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #4c1d95; padding-bottom: 12px; margin-bottom: 16px; }
    .empresa-info h1 { font-size: 16px; color: #4c1d95; text-transform: uppercase; }
    .empresa-info p { font-size: 10px; color: #666; margin-top: 2px; }
    .cert-num { text-align: right; font-size: 10px; color: #666; }
    .cert-titulo { text-align: center; margin: 16px 0; }
    .cert-titulo h2 { font-size: 18px; color: #1e1b4b; text-transform: uppercase; }
    .cert-titulo p { font-size: 11px; color: #6b7280; margin-top: 4px; }
    .saludo { margin: 16px 0; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 10px; }
    th { background: #ede9fe; color: #4c1d95; padding: 6px 8px; font-size: 10px; border: 1px solid #ddd; }
    .normativa { margin: 16px 0; background: #f9fafb; border-left: 4px solid #4c1d95; padding: 12px; font-size: 10px; line-height: 1.6; }
    .firma { margin-top: 32px; display: flex; justify-content: space-between; }
    .firma-box { text-align: center; width: 45%; }
    .firma-linea { border-top: 1px solid #333; margin-bottom: 4px; padding-top: 6px; }
    .footer { text-align: center; margin-top: 24px; padding-top: 12px; border-top: 2px dashed #ccc; font-size: 9px; color: #9ca3af; }
    @media print { body { padding: 10mm; } }
  </style></head><body>
  <div class="header">
    <div class="empresa-info">
      ${empresa?.logo ? `<img src="${empresa.logo}" style="height:70px;object-fit:contain;margin-bottom:8px"/><br/>` : ''}
      <h1>${empresa?.name || ''}</h1>
      <p>NIT: ${empresa?.nit || ''} | Tel: ${empresa?.cellphone || empresa?.phone || ''}</p>
      <p>${empresa?.address || ''}</p>
      <p>${empresa?.email || ''}</p>
    </div>
    <div class="cert-num">
      <p><strong>CERT-${orden.numeroOrden}</strong></p>
      <p>Fecha: ${fechaServicio}</p>
      <p>OS: ${orden.numeroOrden}</p>
    </div>
  </div>
  <div class="cert-titulo">
    <h2>${nombreDoc}</h2>
    ${norma ? `<p>Según ${norma}</p>` : ''}
  </div>
  <div class="saludo">
    <p>Estimados señores:</p>
    <p><strong>${orden.clienteNombre}</strong>${orden.clienteNit ? ` — NIT: ${orden.clienteNit}` : ''}</p>
    <br/>
    <p>${texto}</p>
  </div>
  ${filas ? `
  <table>
    <thead><tr><th>#</th><th>Descripción</th><th>Unidades</th><th>N° Serie</th><th>Fecha servicio</th><th>Próximo servicio</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>` : ''}
  ${contenido ? `<div class="normativa"><strong>Características / Servicios realizados:</strong><br/>${contenido.replace(/\n/g, '<br/>')}</div>` : ''}
  <div class="firma">
    <div class="firma-box"><div style="height:40px"></div><div class="firma-linea"><strong>${empresa?.name || ''}</strong><br/><span style="font-size:9px;color:#666">Empresa prestadora</span></div></div>
    <div class="firma-box"><div style="height:40px"></div><div class="firma-linea"><strong>Técnico responsable</strong><br/><span style="font-size:9px;color:#666">Firma autorizada</span></div></div>
  </div>
  <div class="footer">Documento generado por <strong>Control360</strong></div>
  </body></html>`;
};

const generarHTMLCertificado = (orden, empresa) => {
  const fechaServicio = formatFecha(orden.fechaProgramada || new Date().toISOString());
  const proximoAño = new Date(orden.fechaProgramada || new Date());
  proximoAño.setFullYear(proximoAño.getFullYear() + 1);
  const fechaProxima = formatFecha(proximoAño.toISOString());

  const itemsRecarga = (orden.items || []).filter(i => {
    const cat = (i.categoria || '').toLowerCase();
    return cat.includes('recarga') || cat.includes('mantenimiento');
  });
  const itemsPH = (orden.items || []).filter(i => {
    const cat = (i.categoria || '').toLowerCase();
    return cat.includes('prueba') || cat.includes('hidrost') || cat.includes(' ph');
  });

  const filaRecarga = (item, i) => `
    <tr>
      <td style="text-align:center">${i + 1}</td>
      <td>${item.nombre}</td>
      <td style="text-align:center">${item.cantidad}</td>
      <td style="text-align:center">—</td>
      <td style="text-align:center">${fechaServicio}</td>
      <td style="text-align:center;color:#dc2626;font-weight:bold">${fechaProxima}</td>
    </tr>`;

  const filaPH = (item, i) => `
    <tr>
      <td style="text-align:center">${i + 1}</td>
      <td>${item.nombre}</td>
      <td style="text-align:center">${item.cantidad}</td>
      <td style="text-align:center">—</td>
      <td style="text-align:center">${fechaServicio}</td>
      <td style="text-align:center;color:#dc2626;font-weight:bold">${formatFecha(new Date(new Date(orden.fechaProgramada || new Date()).setFullYear(new Date(orden.fechaProgramada || new Date()).getFullYear() + 5)).toISOString())}</td>
    </tr>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Certificado ${orden.numeroOrden}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 11px; padding: 15mm; color: #333; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #4c1d95; padding-bottom: 12px; margin-bottom: 16px; }
    .empresa-info h1 { font-size: 16px; color: #4c1d95; text-transform: uppercase; }
    .empresa-info p { font-size: 10px; color: #666; margin-top: 2px; }
    .cert-num { text-align: right; font-size: 10px; color: #666; }
    .cert-titulo { text-align: center; margin: 16px 0; }
    .cert-titulo h2 { font-size: 18px; color: #1e1b4b; letter-spacing: 1px; text-transform: uppercase; }
    .cert-titulo p { font-size: 11px; color: #6b7280; margin-top: 4px; }
    .saludo { margin: 16px 0; line-height: 1.6; }
    .seccion { margin: 16px 0; }
    .seccion h3 { background: #1e1b4b; color: white; padding: 6px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 0; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #ede9fe; color: #4c1d95; padding: 6px 8px; font-size: 10px; text-align: left; font-weight: bold; border: 1px solid #ddd; }
    td { padding: 6px 8px; border: 1px solid #ddd; font-size: 10px; }
    tr:nth-child(even) td { background: #f9f9f9; }
    .normativa { margin: 16px 0; background: #f9fafb; border-left: 4px solid #4c1d95; padding: 12px; font-size: 10px; line-height: 1.6; }
    .firma { margin-top: 32px; display: flex; justify-content: space-between; }
    .firma-box { text-align: center; width: 45%; }
    .firma-linea { border-top: 1px solid #333; margin-bottom: 4px; padding-top: 6px; }
    .footer { text-align: center; margin-top: 24px; padding-top: 12px; border-top: 2px dashed #ccc; font-size: 9px; color: #9ca3af; }
    @media print { body { padding: 10mm; } }
  </style></head><body>
  <div class="header">
    <div class="empresa-info">
      ${empresa?.logo ? `<img src="${empresa.logo}" style="height:70px;object-fit:contain;margin-bottom:8px" /><br/>` : ''}
      <h1>${empresa?.name || 'EXTINTORES DEL SUR'}</h1>
      <p>NIT: ${empresa?.nit || ''} | Tel: ${empresa?.cellphone || empresa?.phone || ''}</p>
      <p>${empresa?.address || ''}</p>
      <p>${empresa?.email || ''}</p>
    </div>
    <div class="cert-num">
      <p><strong>CERT-${orden.numeroOrden}</strong></p>
      <p>Fecha: ${fechaServicio}</p>
      <p>OS: ${orden.numeroOrden}</p>
    </div>
  </div>
  <div class="cert-titulo">
    <h2>Certificado de Mantenimiento de Extintores</h2>
    <p>Según Norma Técnica Colombiana NTC 2885 — Extintores Portátiles Contra Incendio</p>
  </div>
  <div class="saludo">
    <p>Estimados señores:</p>
    <p><strong>${orden.clienteNombre}</strong>${orden.clienteNit ? ` — NIT: ${orden.clienteNit}` : ''}</p>
    ${orden.sucursalDireccion ? `<p>${orden.sucursalDireccion}</p>` : ''}
    <br/>
    <p>Por medio del presente documento certificamos que se realizaron los servicios de mantenimiento a los extintores portátiles contra incendio relacionados a continuación, en cumplimiento de la Norma Técnica Colombiana <strong>NTC 2885</strong>.</p>
  </div>
  ${itemsRecarga.length > 0 ? `
  <div class="seccion">
    <h3>🔧 Recargas y Mantenimiento Realizados</h3>
    <table>
      <thead><tr><th>#</th><th>Descripción</th><th>Unidades</th><th>N° Serie</th><th>Fecha servicio</th><th>Próxima recarga</th></tr></thead>
      <tbody>${itemsRecarga.map((item, i) => filaRecarga(item, i)).join('')}</tbody>
    </table>
  </div>` : ''}
  ${itemsPH.length > 0 ? `
  <div class="seccion">
    <h3>🧪 Pruebas Hidrostáticas</h3>
    <table>
      <thead><tr><th>#</th><th>Descripción</th><th>Unidades</th><th>N° Serie</th><th>Fecha</th><th>Próxima PH (5 años)</th></tr></thead>
      <tbody>${itemsPH.map((item, i) => filaPH(item, i)).join('')}</tbody>
    </table>
  </div>` : ''}
  <div class="normativa">
    <strong>Servicios realizados incluyen:</strong><br/>
    • Inspección visual interna y externa • Limpieza de válvulas y mecanismos<br/>
    • Cambio de empaques y sellos • Recarga del agente extintor e impulsor<br/>
    • Prueba de hermeticidad • Rotulado según NTC 2885
  </div>
  <div class="firma">
    <div class="firma-box"><div style="height:40px"></div><div class="firma-linea"><strong>${empresa?.name || ''}</strong><br/><span style="font-size:9px;color:#666">Empresa prestadora</span></div></div>
    <div class="firma-box"><div style="height:40px"></div><div class="firma-linea"><strong>Técnico responsable</strong><br/><span style="font-size:9px;color:#666">Mantenimiento de extintores</span></div></div>
  </div>
  <div class="footer">Documento generado por <strong>Control360</strong> | 📞 3148361622</div>
  </body></html>`;
};

// ─── ESTILOS ──────────────────────────────────────────────────────────────────
const s = {
  wrapper:      { padding: '32px', maxWidth: '1400px', margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  pageHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' },
  pageTitle:    { margin: 0, fontSize: '24px', fontWeight: 800, color: '#111' },
  pageSubtitle: { margin: '4px 0 0', color: '#6b7280', fontSize: '14px' },
  btnBack:      { background: 'none', border: 'none', color: '#7c3aed', cursor: 'pointer', fontSize: '14px', fontWeight: 600, padding: 0 },
  estadoBadge:  { padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 700 },
  urgBadge:     { padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, background: '#fef2f2', color: '#dc2626' },
  acciones:     { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  btnWa:        { padding: '10px 16px', background: '#25d366', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnImprimir:  { padding: '10px 16px', background: '#374151', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnCert:      { padding: '10px 16px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnPrimario:  { padding: '10px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' },
  btnSecundario:{ padding: '10px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 },
  btnEstado:    { width: '100%', padding: '12px', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' },
  alertError:   { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' },
  alertExito:   { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' },
  grid2:        { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '20px' },
  card:         { background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', padding: '20px', marginBottom: '16px' },
  cardTitulo:   { margin: '0 0 16px', fontSize: '16px', fontWeight: 700, color: '#111' },
  infoGrid:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' },
  infoItem:     { display: 'flex', flexDirection: 'column', gap: '2px' },
  infoLabel:    { fontSize: '11px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' },
  totalRow:     { display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '4px 0' },
  historialItem:{ display: 'flex', gap: '12px', paddingBottom: '12px', marginBottom: '12px', borderBottom: '1px solid #f3f4f6' },
  historialDot: { width: '10px', height: '10px', borderRadius: '50%', marginTop: '4px', flexShrink: 0 },
  input:        { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', outline: 'none', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' },
  campo:        { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' },
  label:        { fontSize: '13px', fontWeight: 700, color: '#374151' },
};

export default DetalleOrden;
