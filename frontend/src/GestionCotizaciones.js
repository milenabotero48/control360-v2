import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const formatCOP = (v) => {
  if (!v && v !== 0) return '$0';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', minimumFractionDigits: 0
  }).format(v);
};

const hoy = () => new Date().toISOString().split('T')[0];

const fechaLegible = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
};

const diasRestantes = (fechaVenc) => {
  if (!fechaVenc) return null;
  const hoyMs = new Date().setHours(0,0,0,0);
  const vencMs = new Date(fechaVenc + 'T00:00:00').getTime();
  return Math.ceil((vencMs - hoyMs) / 86400000);
};

const ESTADO_CONFIG = {
  pendiente:  { label: 'Pendiente',   color: '#f59e0b', bg: '#fffbeb', dot: '#f59e0b' },
  aprobada:   { label: 'Aprobada',    color: '#10b981', bg: '#ecfdf5', dot: '#10b981' },
  rechazada:  { label: 'Rechazada',   color: '#ef4444', bg: '#fef2f2', dot: '#ef4444' },
  cancelada:  { label: 'Cancelada',   color: '#6b7280', bg: '#f9fafb', dot: '#6b7280' },
  convertida: { label: 'Aprobada',    color: '#8b5cf6', bg: '#f5f3ff', dot: '#8b5cf6' },
};

const NOTAS_PREDEFINIDAS = [
  { key: 'tipoEmpresa',    label: 'Tipo de empresa',    texto: 'Pertenecemos al régimen común.' },
  { key: 'vigencia',       label: 'Vigencia',           texto: 'La presente oferta tiene una validez de 15 días a partir de la fecha de emisión.' },
  { key: 'entrega',        label: 'Tiempo de entrega',  texto: 'Tiempo de entrega: 1 día hábil.' },
  { key: 'formaPago',      label: 'Forma de pago',      texto: 'Pago anticipado por transferencia bancaria.' },
  { key: 'datosBancarios', label: 'Datos bancarios',    texto: '' },
  { key: 'garantia',       label: 'Garantía',           texto: 'Garantía de 1 año por recarga de extintores.' },
  { key: 'norma',          label: 'Norma técnica',      texto: 'Recargamos extintores en cumplimiento de la norma NTC 2885 con anillo de verificación.' },
  { key: 'observaciones',  label: 'Observaciones',      texto: '' },
];

const INTRO_DEFAULT = `agradece la oportunidad que nos brinda de presentar nuestra cotización y ponernos a su entera disposición. Somos una empresa dedicada a la fabricación y comercialización de equipos contra incendio y señalización empresarial con amplia experiencia en el mercado a nivel nacional. Atendiendo su amable solicitud, presentamos a su consideración la siguiente oferta:`;

const ITEM_VACIO = { productoId: '', nombre: '', descripcion: '', cantidad: 1, precioUnit: 0, descuento: 0, notas: '' };

// ─── COMPONENTE PRINCIPAL ─────────────────────────────────────────────────────
const GestionCotizaciones = ({ user }) => {
  const [vista, setVista]               = useState('lista');       // lista | form | detalle | pdf
  const [cotizaciones, setCotizaciones] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [buscar, setBuscar]             = useState('');
  const [filtroEstado, setFiltroEstado] = useState('');
  const [filtroDesde, setFiltroDesde]   = useState('');
  const [filtroHasta, setFiltroHasta]   = useState('');
  const [cotActual, setCotActual]       = useState(null);
  const [clientes, setClientes]         = useState([]);
  const [productos, setProductos]       = useState([]);
  const [empresas, setEmpresas]         = useState([]);
  const [guardando, setGuardando]       = useState(false);
  const [error, setError]               = useState('');
  const [exito, setExito]               = useState('');
  const [modalConfirm, setModalConfirm] = useState(null);
  const [enviandoPDF, setEnviandoPDF]   = useState(false);

  const isAdmin     = user?.role === 'admin';
  const isComercial = user?.role === 'comercial' || isAdmin;
  const token       = localStorage.getItem('token');
  const headers     = { Authorization: `Bearer ${token}` };

  // ─── FORM STATE ────────────────────────────────────────────────────────────
  const FORM_VACIO = {
    clienteId: '', clienteNombre: '', clienteNit: '', clienteCelular: '',
    clienteEmail: '', clienteDireccion: '',
    empresaId: '', empresaNombre: '', empresaNit: '', empresaTel: '',
    empresaDireccion: '', empresaEmail: '', empresaLogo: '', empresaIva: false,
    numero: '', fecha: hoy(), validezDias: 15,
    introTexto: INTRO_DEFAULT,
    items: [{ ...ITEM_VACIO }],
    descuentoGlobal: 0,
    notas: NOTAS_PREDEFINIDAS.map(n => ({ ...n, activa: ['vigencia','norma','garantia'].includes(n.key), texto: n.texto })),
    notaLibre: '',
    creadoPor: user?.nombre || user?.email || '',
    creadoPorId: user?.uid || '',
  };
  const [form, setForm] = useState(FORM_VACIO);

  // ─── CARGA INICIAL ─────────────────────────────────────────────────────────
  useEffect(() => {
    cargarTodo();
  }, []);

  const cargarTodo = async () => {
    setLoading(true);
    try {
      const [rCot, rCli, rPro, rEmp] = await Promise.all([
        axios.get(`${API}/cotizaciones`, { headers }).catch(() => ({ data: [] })),
        axios.get(`${API}/clients`, { headers }).catch(() => ({ data: [] })),
        axios.get(`${API}/products`, { headers }).catch(() => ({ data: [] })),
        axios.get(`${API}/companies`, { headers }).catch(() => ({ data: [] })),
      ]);
      setCotizaciones(Array.isArray(rCot.data) ? rCot.data : []);
      setClientes(Array.isArray(rCli.data) ? rCli.data : []);
      setProductos(Array.isArray(rPro.data) ? rPro.data : []);
      setEmpresas(Array.isArray(rEmp.data) ? rEmp.data : []);
    } catch (e) {
      setError('Error cargando datos');
    }
    setLoading(false);
  };

  // ─── HELPERS FORM ──────────────────────────────────────────────────────────
  const seleccionarCliente = (clienteId) => {
    const c = clientes.find(x => x.id === clienteId);
    if (!c) return;
    // Buscar empresa del cliente
    const emp = empresas.find(e => e.id === c.empresaId);
    setForm(f => ({
      ...f,
      clienteId: c.id,
      clienteNombre: c.nombre,
      clienteNit: c.nit || '',
      clienteCelular: c.celular || '',
      clienteEmail: c.emailLegal || '',
      clienteDireccion: c.direccionPrincipal || '',
      empresaId: emp?.id || c.empresaId || '',
      empresaNombre: emp?.nombre || c.empresaNombre || '',
      empresaNit: emp?.nit || '',
      empresaTel: emp?.telefono || emp?.celular || '',
      empresaDireccion: emp?.direccion || '',
      empresaEmail: emp?.email || '',
      empresaLogo: emp?.logoUrl || '',
      empresaIva: (emp?.iva ?? 0) > 0,
      notas: f.notas.map(n => {
        if (n.key === 'tipoEmpresa') return { ...n, texto: `Pertenecemos al régimen común NIT ${emp?.nit || ''}.` };
        if (n.key === 'datosBancarios') return { ...n, texto: emp?.datosBancarios || `Por transferencia bancaria a nombre de ${emp?.nombre || ''}.` };
        return n;
      }),
    }));
  };

  const agregarItem = () => setForm(f => ({ ...f, items: [...f.items, { ...ITEM_VACIO }] }));

  const eliminarItem = (idx) => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));

  const actualizarItem = (idx, campo, valor) => {
    setForm(f => ({
      ...f,
      items: f.items.map((it, i) => {
        if (i !== idx) return it;
        const updated = { ...it, [campo]: valor };
        if (campo === 'productoId') {
          const p = productos.find(x => x.id === valor);
          if (p) {
            updated.nombre = p.nombre;
            updated.precioUnit = p.precioVenta || 0;
            updated.descripcion = p.descripcion || '';
          }
        }
        return updated;
      })
    }));
  };

  const toggleNota = (key) => setForm(f => ({
    ...f,
    notas: f.notas.map(n => n.key === key ? { ...n, activa: !n.activa } : n)
  }));

  const editarNota = (key, texto) => setForm(f => ({
    ...f,
    notas: f.notas.map(n => n.key === key ? { ...n, texto } : n)
  }));

  // ─── CÁLCULOS ──────────────────────────────────────────────────────────────
  const calcTotales = (items, descGlobal, conIva) => {
    const subtotal = items.reduce((acc, it) => {
      const base = (Number(it.cantidad) || 0) * (Number(it.precioUnit) || 0);
      const desc = base * ((Number(it.descuento) || 0) / 100);
      return acc + base - desc;
    }, 0);
    const descG = subtotal * ((Number(descGlobal) || 0) / 100);
    const baseIva = subtotal - descG;
    const iva = conIva ? baseIva * 0.19 : 0;
    const total = baseIva + iva;
    return { subtotal, descG, baseIva, iva, total };
  };

  const totales = calcTotales(form.items, form.descuentoGlobal, form.empresaIva);

  // ─── GUARDAR ───────────────────────────────────────────────────────────────
  const generarNumero = () => {
    const max = cotizaciones.reduce((acc, c) => {
      const n = parseInt((c.numero || '').replace('COT-', '')) || 0;
      return n > acc ? n : acc;
    }, 0);
    return `COT-${String(max + 1).padStart(4, '0')}`;
  };

  const guardarCotizacion = async () => {
    if (!form.clienteId) return setError('Selecciona un cliente');
    if (form.items.length === 0 || !form.items[0].nombre) return setError('Agrega al menos un producto');
    setGuardando(true);
    setError('');
    try {
      const vencimiento = new Date(form.fecha);
      vencimiento.setDate(vencimiento.getDate() + Number(form.validezDias));
      // Garantizar que los items siempre tengan valores numéricos
      const itemsSanitizados = form.items.map(it => ({
        ...it,
        nombre:     it.nombre || '',
        descripcion: it.descripcion || '',
        cantidad:   Number(it.cantidad)   || 1,
        precioUnit: Number(it.precioUnit) || 0,
        descuento:  Number(it.descuento)  || 0,
        notas:      it.notas || '',
      }));

      const payload = {
        ...form,
        items: itemsSanitizados,
        numero: cotActual?.numero || generarNumero(),
        estado: cotActual?.estado || 'pendiente',
        fechaVencimiento: vencimiento.toISOString().split('T')[0],
        totales,
        updatedAt: new Date().toISOString(),
        createdAt: cotActual?.createdAt || new Date().toISOString(),
      };
      if (cotActual?.id) {
        await axios.put(`${API}/cotizaciones/${cotActual.id}`, payload, { headers });
        setExito('Cotización actualizada');
      } else {
        const r = await axios.post(`${API}/cotizaciones`, payload, { headers });
        setCotActual({ ...payload, id: r.data.id });
      }
      await cargarTodo();
      setVista('detalle');
    } catch (e) {
      setError('Error guardando cotización');
    }
    setGuardando(false);
  };

  // ─── CAMBIAR ESTADO ────────────────────────────────────────────────────────
  const cambiarEstado = async (cot, nuevoEstado, motivo = '') => {
    try {
      // Al aprobar: crear orden automáticamente en el mismo paso
      const crearOrden = nuevoEstado === 'aprobada' || nuevoEstado === 'convertida';
      const ordenId = crearOrden ? `OS-${Date.now()}` : (cot.ordenId || '');

      const payload = {
        estado: nuevoEstado === 'aprobada' ? 'convertida' : nuevoEstado,
        motivo,
        ordenId,
        updatedAt: new Date().toISOString(),
      };

      await axios.put(`${API}/cotizaciones/${cot.id}`, { ...cot, ...payload }, { headers });

      if (crearOrden) {
        // Mapear items al formato que espera orders.js (precioUnitario, no precioUnit)
        const itemsParaOrden = (cot.items || []).map(it => ({
          productoId:     it.productoId || '',
          nombre:         it.nombre     || '',
          categoria:      it.categoria  || '',
          cantidad:       Number(it.cantidad)    || 1,
          precioUnitario: Number(it.precioUnit)  || 0,   // ← orders.js usa precioUnitario
          descuento:      Number(it.descuento)   || 0,
          notas:          it.notas || '',
        }));

        // Recalcular totales correctamente
        const subtotalOrden = itemsParaOrden.reduce((acc, it) => {
          return acc + it.precioUnitario * it.cantidad * (1 - it.descuento / 100);
        }, 0);
        const ivaOrden = cot.empresaIva ? subtotalOrden * 0.19 : 0;
        const totalOrden = subtotalOrden + ivaOrden;

        const ordenPayload = {
          tipoOrden:        'servicio',
          clienteId:        cot.clienteId,
          clienteNombre:    cot.clienteNombre,
          clienteNit:       cot.clienteNit       || '',
          clienteCelular:   cot.clienteCelular   || '',
          empresaId:        cot.empresaId        || '',
          empresaNombre:    cot.empresaNombre    || '',
          items:            itemsParaOrden,
          cotizacionId:     cot.id,
          cotizacionNumero: cot.numero,
          createdAt:        new Date().toISOString(),
          creadoPor:        user?.nombre || user?.email,
        };
        await axios.post(`${API}/orders`, ordenPayload, { headers }).catch(() => {});
      }

      setExito('✅ Cotización aprobada — Orden creada automáticamente');
      await cargarTodo();
      setVista('lista');
      setModalConfirm(null);
    } catch (e) {
      setError('Error actualizando estado');
    }
  };

  // ─── CLONAR ────────────────────────────────────────────────────────────────
  const clonarCotizacion = (cot) => {
    setForm({
      ...cot,
      numero: '',
      fecha: hoy(),
      estado: 'pendiente',
      createdAt: '',
      id: undefined,
    });
    setCotActual(null);
    setVista('form');
  };

  // ─── ABRIR EDITAR ──────────────────────────────────────────────────────────
  const abrirEditar = (cot) => {
    setForm({ ...FORM_VACIO, ...cot });
    setCotActual(cot);
    setVista('form');
  };

  const abrirDetalle = (cot) => {
    setCotActual(cot);
    setVista('detalle');
  };

  const abrirNueva = () => {
    setForm(FORM_VACIO);
    setCotActual(null);
    setVista('form');
  };

  // ─── FILTROS ───────────────────────────────────────────────────────────────
  const cotFiltradas = cotizaciones.filter(c => {
    const txt = buscar.toLowerCase();
    const matchTxt = !txt || c.numero?.toLowerCase().includes(txt) || c.clienteNombre?.toLowerCase().includes(txt);
    const matchEst = !filtroEstado || c.estado === filtroEstado;
    const fechaStr = c.fecha || (c.createdAt?._seconds ? new Date(c.createdAt._seconds * 1000).toISOString().split('T')[0] : c.createdAt ? new Date(c.createdAt).toISOString().split('T')[0] : null);
    const matchDesde = !filtroDesde || (fechaStr && fechaStr >= filtroDesde);
    const matchHasta = !filtroHasta || (fechaStr && fechaStr <= filtroHasta);
    return matchTxt && matchEst && matchDesde && matchHasta;
  });

  // ─── NOTIFICACIONES ────────────────────────────────────────────────────────
  useEffect(() => {
    if (exito) { const t = setTimeout(() => setExito(''), 3500); return () => clearTimeout(t); }
  }, [exito]);
  useEffect(() => {
    if (error) { const t = setTimeout(() => setError(''), 4000); return () => clearTimeout(t); }
  }, [error]);

  // ─── RENDER PRINCIPAL ──────────────────────────────────────────────────────
  if (loading) return (
    <div style={s.loadWrap}>
      <div style={s.spinner} />
      <p style={{ color: '#6b7280', marginTop: 12 }}>Cargando cotizaciones...</p>
    </div>
  );

  return (
    <div style={s.wrap}>
      {/* Toast */}
      {exito && <div style={s.toastOk}>{exito}</div>}
      {error && <div style={s.toastErr}>{error}</div>}

      {/* Modal confirmación */}
      {modalConfirm && <ModalConfirm {...modalConfirm} onClose={() => setModalConfirm(null)} />}

      {vista === 'lista'   && <VistaLista cotizaciones={cotFiltradas} buscar={buscar} setBuscar={setBuscar}
                                filtroEstado={filtroEstado} setFiltroEstado={setFiltroEstado}
                                filtroDesde={filtroDesde} setFiltroDesde={setFiltroDesde}
                                filtroHasta={filtroHasta} setFiltroHasta={setFiltroHasta}
                                onNueva={isComercial ? abrirNueva : null} onDetalle={abrirDetalle}
                                isAdmin={isAdmin} isComercial={isComercial} />}

      {vista === 'form'    && <VistaForm form={form} setForm={setForm} cotActual={cotActual}
                                clientes={clientes} productos={productos} totales={totales}
                                onSelCliente={seleccionarCliente} onAgregarItem={agregarItem}
                                onEliminarItem={eliminarItem} onActualizarItem={actualizarItem}
                                onToggleNota={toggleNota} onEditarNota={editarNota}
                                onGuardar={guardarCotizacion} guardando={guardando}
                                onCancelar={() => setVista(cotActual ? 'detalle' : 'lista')}
                                user={user} />}

      {vista === 'detalle' && cotActual && <VistaDetalle cot={cotActual} isAdmin={isAdmin} isComercial={isComercial}
                                onEditar={() => abrirEditar(cotActual)}
                                onClonar={() => clonarCotizacion(cotActual)}
                                onVolver={() => setVista('lista')}
                                onCambiarEstado={(est, mot) => cambiarEstado(cotActual, est, mot)}
                                setModalConfirm={setModalConfirm}
                                onImprimir={() => setVista('pdf')}
                                enviandoPDF={enviandoPDF} setEnviandoPDF={setEnviandoPDF}
                                setExito={setExito} setError={setError} />}

      {vista === 'pdf'     && cotActual && <VistaPDF cot={cotActual} onVolver={() => setVista('detalle')} />}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// VISTA LISTA
// ═══════════════════════════════════════════════════════════════════════════════
const VistaLista = ({ cotizaciones, buscar, setBuscar, filtroEstado, setFiltroEstado, filtroDesde, setFiltroDesde, filtroHasta, setFiltroHasta, onNueva, onDetalle, isAdmin, isComercial }) => {
  const stats = {
    total:      cotizaciones.length,
    pendientes: cotizaciones.filter(c => c.estado === 'pendiente').length,
    aprobadas:  cotizaciones.filter(c => c.estado === 'aprobada' || c.estado === 'convertida').length,
    valor:      cotizaciones.filter(c => c.estado !== 'rechazada' && c.estado !== 'cancelada')
                            .reduce((a, c) => a + (c.totales?.total || 0), 0),
  };

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.pageHeader}>
        <div>
          <h1 style={s.pageTitle}>Cotizaciones</h1>
          <p style={s.pageSubtitle}>Propuestas comerciales y seguimiento</p>
        </div>
        {isComercial && (
          <button onClick={onNueva} style={s.btnPrimary}>
            <span style={{ fontSize: 18 }}>+</span> Nueva Cotización
          </button>
        )}
      </div>

      {/* KPIs */}
      <div style={s.kpiGrid}>
        <KpiCard label="Total" valor={stats.total} icon="📋" color="#667eea" />
        <KpiCard label="Pendientes" valor={stats.pendientes} icon="⏳" color="#f59e0b" />
        <KpiCard label="Aprobadas" valor={stats.aprobadas} icon="✅" color="#10b981" />
        <KpiCard label="Valor Pipeline" valor={`${new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 }).format(stats.valor)}`} icon="💰" color="#8b5cf6" prefix="$" />
      </div>

      {/* Filtros */}
      <div style={s.filtrosBar}>
        <input value={buscar} onChange={e => setBuscar(e.target.value)}
          placeholder="🔍 Buscar por número o cliente..."
          style={s.searchInput} />
        <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)} style={s.select}>
          <option value="">Todos los estados</option>
          {Object.entries(ESTADO_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <input type="date" style={{ ...s.select, maxWidth: 150 }} value={filtroDesde}
          onChange={e => setFiltroDesde(e.target.value)} title="Desde" />
        <input type="date" style={{ ...s.select, maxWidth: 150 }} value={filtroHasta}
          onChange={e => setFiltroHasta(e.target.value)} title="Hasta" />
        {(filtroDesde || filtroHasta) && (
          <button onClick={() => { setFiltroDesde(''); setFiltroHasta(''); }}
            style={{ padding: '8px 14px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
            ✕ Limpiar fechas
          </button>
        )}
      </div>

      {/* Tabla */}
      {cotizaciones.length === 0 ? (
        <div style={s.emptyState}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
          <h3 style={{ color: '#374151', margin: '0 0 8px' }}>Sin cotizaciones aún</h3>
          <p style={{ color: '#9ca3af', margin: 0 }}>Crea tu primera cotización para empezar</p>
        </div>
      ) : (
        <div style={s.card}>
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Número</th>
                  <th style={s.th}>Cliente</th>
                  <th style={s.th}>Empresa</th>
                  <th style={s.th}>Fecha</th>
                  <th style={s.th}>Vence</th>
                  <th style={s.th}>Total</th>
                  <th style={s.th}>Estado</th>
                  <th style={s.th}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {cotizaciones.map(c => {
                  const est = ESTADO_CONFIG[c.estado] || ESTADO_CONFIG.pendiente;
                  const dias = diasRestantes(c.fechaVencimiento);
                  const vencida = c.estado === 'pendiente' && dias !== null && dias < 0;
                  return (
                    <tr key={c.id} style={s.tr} onClick={() => onDetalle(c)}>
                      <td style={s.td}>
                        <span style={{ fontWeight: 700, color: '#667eea' }}>{c.numero}</span>
                        {c.ordenId && <div style={{ fontSize: 11, color: '#10b981', marginTop: 2 }}>→ {c.ordenId}</div>}
                      </td>
                      <td style={s.td}>
                        <div style={{ fontWeight: 600, color: '#111827' }}>{c.clienteNombre}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{c.clienteNit}</div>
                      </td>
                      <td style={{ ...s.td, fontSize: 13, color: '#6b7280' }}>{c.empresaNombre}</td>
                      <td style={{ ...s.td, fontSize: 13 }}>{fechaLegible(c.fecha)}</td>
                      <td style={s.td}>
                        {c.fechaVencimiento ? (
                          <span style={{ fontSize: 12, color: vencida ? '#ef4444' : dias <= 3 ? '#f59e0b' : '#6b7280', fontWeight: vencida ? 700 : 400 }}>
                            {vencida ? '⚠️ Vencida' : `${dias}d`}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ ...s.td, fontWeight: 700, color: '#111827' }}>{formatCOP(c.totales?.total)}</td>
                      <td style={s.td}>
                        <span style={{ ...s.badge, background: est.bg, color: est.color }}>
                          <span style={{ ...s.dot, background: est.dot }} />
                          {est.label}{c.estado === 'convertida' && c.ordenId ? ` · ${c.ordenNumero || c.ordenId}` : ''}
                        </span>
                      </td>
                      <td style={s.td} onClick={e => e.stopPropagation()}>
                        <button onClick={() => onDetalle(c)} style={s.btnIcon} title="Ver detalle">👁️</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={s.tableFooter}>{cotizaciones.length} cotización{cotizaciones.length !== 1 ? 'es' : ''}</div>
        </div>
      )}
    </div>
  );
};

// ─── BUSCADOR CLIENTE ─────────────────────────────────────────────────────────
const BuscadorCliente = ({ clientes, clienteId, onSeleccionar }) => {
  const [query, setQuery]     = useState('');
  const [abierto, setAbierto] = useState(false);
  const ref                   = useRef();

  const clienteActual = clientes.find(c => c.id === clienteId);
  const filtrados = query.length < 1 ? clientes.slice(0, 8) :
    clientes.filter(c =>
      c.nombre?.toLowerCase().includes(query.toLowerCase()) ||
      c.nit?.toString().includes(query)
    ).slice(0, 10);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const seleccionar = (c) => { onSeleccionar(c.id); setQuery(''); setAbierto(false); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <input
          value={abierto ? query : (clienteActual ? clienteActual.nombre : '')}
          onChange={e => { setQuery(e.target.value); setAbierto(true); }}
          onFocus={() => setAbierto(true)}
          placeholder="🔍 Buscar cliente por nombre o NIT..."
          style={{ ...s.input, paddingRight: clienteActual ? 36 : 12 }}
        />
        {clienteActual && (
          <button onClick={() => { onSeleccionar(''); setQuery(''); }}
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#9ca3af' }}>
            ✕
          </button>
        )}
      </div>
      {abierto && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 999, maxHeight: 280, overflowY: 'auto', marginTop: 4 }}>
          {filtrados.length === 0
            ? <div style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 13 }}>Sin resultados para "{query}"</div>
            : filtrados.map(c => (
              <div key={c.id} onClick={() => seleccionar(c)}
                style={{ padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                onMouseEnter={e => e.currentTarget.style.background = '#f5f3ff'}
                onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{c.nombre}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  {c.nit && `NIT: ${c.nit}`}{c.celular && ` · 📱 ${c.celular}`}{c.empresaNombre && ` · ${c.empresaNombre}`}
                </div>
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// VISTA FORM
// ═══════════════════════════════════════════════════════════════════════════════
const VistaForm = ({ form, setForm, cotActual, clientes, productos, totales, onSelCliente,
  onAgregarItem, onEliminarItem, onActualizarItem, onToggleNota, onEditarNota,
  onGuardar, guardando, onCancelar, user }) => {

  const [tabActiva, setTabActiva] = useState('datos'); // datos | items | notas

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.pageHeader}>
        <div>
          <button onClick={onCancelar} style={s.btnBack}>← Volver</button>
          <h1 style={s.pageTitle}>{cotActual ? `Editar ${cotActual.numero}` : 'Nueva Cotización'}</h1>
        </div>
        <button onClick={onGuardar} disabled={guardando} style={s.btnPrimary}>
          {guardando ? '⏳ Guardando...' : cotActual ? '💾 Actualizar' : '✅ Crear Cotización'}
        </button>
      </div>

      {/* Tabs */}
      <div style={s.tabsBar}>
        {[
          { key: 'datos', label: '📋 Datos generales' },
          { key: 'items', label: `📦 Productos (${form.items.length})` },
          { key: 'notas', label: '📝 Notas y condiciones' },
        ].map(t => (
          <button key={t.key} onClick={() => setTabActiva(t.key)}
            style={{ ...s.tab, ...(tabActiva === t.key ? s.tabActivo : {}) }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Datos generales */}
      {tabActiva === 'datos' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* Cliente */}
          <div style={{ ...s.card, gridColumn: '1 / -1' }}>
            <div style={s.cardTitle}>👤 Cliente</div>
            <div style={s.formGrid2}>
              <div>
                <label style={s.label}>Cliente *</label>
                <BuscadorCliente
                  clientes={clientes}
                  clienteId={form.clienteId}
                  onSeleccionar={onSelCliente}
                />
              </div>
              <div>
                <label style={s.label}>Empresa facturadora</label>
                <input value={form.empresaNombre} readOnly style={{ ...s.input, background: '#f9fafb', color: '#6b7280' }} placeholder="Se auto-completa al seleccionar cliente" />
              </div>
              {form.clienteId && (
                <>
                  <div>
                    <label style={s.label}>NIT / Cédula</label>
                    <input value={form.clienteNit} readOnly style={{ ...s.input, background: '#f9fafb' }} />
                  </div>
                  <div>
                    <label style={s.label}>Celular</label>
                    <input value={form.clienteCelular} readOnly style={{ ...s.input, background: '#f9fafb' }} />
                  </div>
                  <div style={{ gridColumn: '1/-1' }}>
                    <label style={s.label}>Dirección</label>
                    <input value={form.clienteDireccion} readOnly style={{ ...s.input, background: '#f9fafb' }} />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Datos de la cotización */}
          <div style={s.card}>
            <div style={s.cardTitle}>📋 Datos de la cotización</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={s.label}>Fecha</label>
                <input type="date" value={form.fecha}
                  onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} style={s.input} />
              </div>
              <div>
                <label style={s.label}>Validez (días)</label>
                <input type="number" value={form.validezDias} min={1}
                  onChange={e => setForm(f => ({ ...f, validezDias: e.target.value }))} style={s.input} />
              </div>
              <div>
                <label style={s.label}>Descuento global (%)</label>
                <input type="number" value={form.descuentoGlobal} min={0} max={100}
                  onChange={e => setForm(f => ({ ...f, descuentoGlobal: e.target.value }))} style={s.input} />
              </div>
              <div style={s.ivaRow}>
                <span style={s.label}>IVA (19%)</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ ...s.toggle, background: form.empresaIva ? '#667eea' : '#e5e7eb' }}
                    onClick={() => setForm(f => ({ ...f, empresaIva: !f.empresaIva }))}>
                    <div style={{ ...s.toggleThumb, transform: form.empresaIva ? 'translateX(20px)' : 'translateX(2px)' }} />
                  </div>
                  <span style={{ fontSize: 13, color: form.empresaIva ? '#667eea' : '#9ca3af', fontWeight: 600 }}>
                    {form.empresaIva ? 'Aplicar IVA' : 'Sin IVA'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Texto intro */}
          <div style={s.card}>
            <div style={s.cardTitle}>✍️ Texto de introducción</div>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 10px' }}>Aparecerá en el PDF antes de la tabla de productos. Editable.</p>
            <textarea value={form.introTexto}
              onChange={e => setForm(f => ({ ...f, introTexto: e.target.value }))}
              rows={7} style={{ ...s.input, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }} />
          </div>

          {/* Resumen financiero */}
          <div style={{ ...s.card, gridColumn: '1/-1' }}>
            <div style={s.cardTitle}>💰 Resumen financiero</div>
            <div style={s.resumenGrid}>
              <ResumenFila label="Subtotal" valor={totales.subtotal} />
              {totales.descG > 0 && <ResumenFila label={`Descuento (${form.descuentoGlobal}%)`} valor={-totales.descG} color="#ef4444" />}
              {form.empresaIva && <ResumenFila label="IVA (19%)" valor={totales.iva} />}
              <div style={s.resumenTotal}>
                <span>TOTAL</span>
                <span>{formatCOP(totales.total)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Items */}
      {tabActiva === 'items' && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={s.cardTitle}>📦 Productos y servicios</div>
            <button onClick={onAgregarItem} style={s.btnSecondary}>+ Agregar ítem</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {form.items.map((item, idx) => (
              <ItemRow key={idx} item={item} idx={idx} productos={productos}
                onUpdate={onActualizarItem} onDelete={onEliminarItem}
                canDelete={form.items.length > 1} />
            ))}
          </div>

          {/* Totales */}
          <div style={{ ...s.resumenGrid, marginTop: 24, borderTop: '2px solid #f3f4f6', paddingTop: 16 }}>
            <ResumenFila label="Subtotal" valor={totales.subtotal} />
            {totales.descG > 0 && <ResumenFila label={`Descuento (${form.descuentoGlobal}%)`} valor={-totales.descG} color="#ef4444" />}
            {form.empresaIva && <ResumenFila label="IVA (19%)" valor={totales.iva} />}
            <div style={s.resumenTotal}>
              <span>TOTAL</span>
              <span>{formatCOP(totales.total)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Notas */}
      {tabActiva === 'notas' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={s.card}>
            <div style={s.cardTitle}>📝 Secciones de la cotización</div>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>
              Activa o desactiva las secciones que aparecerán en el PDF. Puedes editar el texto de cada una.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {form.notas.map(n => (
                <NotaRow key={n.key} nota={n}
                  onToggle={() => onToggleNota(n.key)}
                  onEditar={(txt) => onEditarNota(n.key, txt)} />
              ))}
            </div>
          </div>

          <div style={s.card}>
            <div style={s.cardTitle}>📌 Nota libre adicional</div>
            <textarea value={form.notaLibre}
              onChange={e => setForm(f => ({ ...f, notaLibre: e.target.value }))}
              rows={4} placeholder="Escribe aquí cualquier nota adicional que no esté en las secciones anteriores..."
              style={{ ...s.input, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
        </div>
      )}
    </div>
  );
};

// ─── ITEM ROW ─────────────────────────────────────────────────────────────────
const ItemRow = ({ item, idx, productos, onUpdate, onDelete, canDelete }) => {
  const [expanded, setExpanded] = useState(false);
  const subtotal = (Number(item.cantidad) || 0) * (Number(item.precioUnit) || 0) * (1 - (Number(item.descuento) || 0) / 100);

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1fr auto auto', gap: 8, padding: '12px 16px', alignItems: 'center', background: '#fafafa' }}>
        {/* Nombre/Producto */}
        <div>
          <select value={item.productoId}
            onChange={e => onUpdate(idx, 'productoId', e.target.value)}
            style={{ ...s.inputSm, marginBottom: 4 }}>
            <option value="">— Seleccionar producto —</option>
            {productos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <input value={item.nombre} onChange={e => onUpdate(idx, 'nombre', e.target.value)}
            placeholder="O escribe descripción libre..." style={s.inputSm} />
        </div>
        {/* Descripción */}
        <input value={item.descripcion} onChange={e => onUpdate(idx, 'descripcion', e.target.value)}
          placeholder="Descripción" style={s.inputSm} />
        {/* Cantidad */}
        <input type="number" value={item.cantidad} min={1}
          onChange={e => onUpdate(idx, 'cantidad', e.target.value)}
          style={{ ...s.inputSm, textAlign: 'center' }} />
        {/* Precio */}
        <input type="number" value={item.precioUnit} min={0}
          onChange={e => onUpdate(idx, 'precioUnit', e.target.value)}
          style={{ ...s.inputSm, textAlign: 'right' }} />
        {/* Descuento */}
        <input type="number" value={item.descuento} min={0} max={100}
          onChange={e => onUpdate(idx, 'descuento', e.target.value)}
          placeholder="%" style={{ ...s.inputSm, textAlign: 'center' }} />
        {/* Total */}
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', textAlign: 'right', minWidth: 80 }}>
          {formatCOP(subtotal)}
        </div>
        {/* Acciones */}
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setExpanded(!expanded)} style={s.btnIconSm} title="Notas">
            {expanded ? '🔼' : '📝'}
          </button>
          {canDelete && <button onClick={() => onDelete(idx)} style={{ ...s.btnIconSm, color: '#ef4444' }} title="Eliminar">✕</button>}
        </div>
      </div>
      {/* Campo notas expandible */}
      {expanded && (
        <div style={{ padding: '8px 16px 12px', background: '#fffbeb', borderTop: '1px solid #fde68a' }}>
          <label style={{ fontSize: 12, color: '#92400e', fontWeight: 600, display: 'block', marginBottom: 4 }}>
            📝 Notas del ítem (aparecen en el PDF)
          </label>
          <input value={item.notas} onChange={e => onUpdate(idx, 'notas', e.target.value)}
            placeholder="Ej: Chaleco talla M, incluye domicilio, color rojo..."
            style={{ ...s.inputSm, width: '100%', background: '#fff' }} />
        </div>
      )}
    </div>
  );
};

// ─── NOTA ROW ─────────────────────────────────────────────────────────────────
const NotaRow = ({ nota, onToggle, onEditar }) => (
  <div style={{ border: `1px solid ${nota.activa ? '#667eea' : '#e5e7eb'}`, borderRadius: 10, padding: '12px 16px', background: nota.activa ? '#f5f3ff' : '#fafafa', transition: 'all 0.2s' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: nota.activa ? 10 : 0 }}>
      <div style={{ ...s.toggle, background: nota.activa ? '#667eea' : '#e5e7eb', flexShrink: 0 }} onClick={onToggle}>
        <div style={{ ...s.toggleThumb, transform: nota.activa ? 'translateX(20px)' : 'translateX(2px)' }} />
      </div>
      <span style={{ fontWeight: 600, fontSize: 14, color: nota.activa ? '#667eea' : '#6b7280' }}>{nota.label}</span>
    </div>
    {nota.activa && (
      <textarea value={nota.texto} onChange={e => onEditar(e.target.value)}
        rows={2} style={{ ...s.input, resize: 'vertical', fontFamily: 'inherit', fontSize: 13, marginTop: 4 }} />
    )}
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
// VISTA DETALLE
// ═══════════════════════════════════════════════════════════════════════════════
const VistaDetalle = ({ cot, isAdmin, isComercial, onEditar, onClonar, onVolver,
  onCambiarEstado, setModalConfirm, onImprimir, enviandoPDF, setEnviandoPDF, setExito, setError }) => {

  const est = ESTADO_CONFIG[cot.estado] || ESTADO_CONFIG.pendiente;
  const dias = diasRestantes(cot.fechaVencimiento);
  const puedeEditar = isComercial && (cot.estado === 'pendiente' || cot.estado === 'aprobada');
  const puedeConvertir = isComercial && cot.estado !== 'convertida' && cot.estado !== 'cancelada';

  const handleWhatsApp = () => {
    const tel = cot.clienteCelular?.replace(/\D/g, '');
    if (!tel) return setError('El cliente no tiene celular registrado');
    const items = (cot.items || []).map((it, i) =>
      `  ${i+1}. ${it.nombre} x${it.cantidad} — ${formatCOP((Number(it.precioUnit)||0) * (Number(it.cantidad)||0))}`
    ).join('\n');
    const msg = encodeURIComponent(
      `Hola *${cot.clienteNombre}*, cordial saludo.\n\n` +
      `*${cot.empresaNombre}* le hace llegar la cotización *${cot.numero}*:\n\n` +
      `${items}\n\n` +
      `*TOTAL: ${formatCOP(cot.totales?.total)}*\n` +
      `Vigencia: ${cot.validezDias || 15} días\n\n` +
      `Para *APROBAR* esta cotización, responda este mensaje con la palabra *APRUEBO* y procederemos a programar el servicio.\n\n` +
      `Cualquier inquietud con gusto la atendemos.\n` +
      `_${cot.creadoPor} — ${cot.empresaNombre}_`
    );
    window.open(`https://wa.me/57${tel}?text=${msg}`, '_blank');
    setExito('Abriendo WhatsApp...');
  };

  const handleEmail = () => {
    if (!cot.clienteEmail) return setError('El cliente no tiene email registrado');
    const sub = encodeURIComponent(`Cotización ${cot.numero} - ${cot.empresaNombre}`);
    const body = encodeURIComponent(`Estimado(a) ${cot.clienteNombre},\n\nAdjuntamos la cotización ${cot.numero} por valor de ${formatCOP(cot.totales?.total)}.\n\nQuedamos atentos a su respuesta.\n\nCordialmente,\n${cot.creadoPor}`);
    window.open(`mailto:${cot.clienteEmail}?subject=${sub}&body=${body}`);
    setExito('Abriendo cliente de correo...');
  };

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.pageHeader}>
        <div>
          <button onClick={onVolver} style={s.btnBack}>← Volver</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
            <h1 style={{ ...s.pageTitle, margin: 0 }}>{cot.numero}</h1>
            <span style={{ ...s.badge, ...{ background: est.bg, color: est.color, fontSize: 13, padding: '4px 12px' } }}>
              <span style={{ ...s.dot, background: est.dot }} />{est.label}
            </span>
          </div>
          <p style={s.pageSubtitle}>{cot.clienteNombre} — {fechaLegible(cot.fecha)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {puedeEditar && <button onClick={onEditar} style={s.btnSecondary}>✏️ Editar</button>}
          <button onClick={onClonar} style={s.btnSecondary}>🔁 Clonar</button>
          <button onClick={onImprimir} style={s.btnSecondary}>📄 Ver PDF</button>
          <button onClick={handleWhatsApp} style={{ ...s.btnSecondary, background: '#dcfce7', color: '#16a34a', border: '1px solid #86efac' }}>
            📱 WhatsApp
          </button>
          <button onClick={handleEmail} style={{ ...s.btnSecondary, background: '#dbeafe', color: '#2563eb', border: '1px solid #93c5fd' }}>
            📧 Email
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 }}>
        {/* Col izquierda */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Info cliente/empresa */}
          <div style={s.card}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div>
                <div style={s.cardTitle}>👤 Cliente</div>
                <p style={s.detInfo}><strong>{cot.clienteNombre}</strong></p>
                <p style={s.detInfo}>NIT: {cot.clienteNit}</p>
                <p style={s.detInfo}>📱 {cot.clienteCelular}</p>
                {cot.clienteEmail && <p style={s.detInfo}>✉️ {cot.clienteEmail}</p>}
                {cot.clienteDireccion && <p style={s.detInfo}>📍 {cot.clienteDireccion}</p>}
              </div>
              <div>
                <div style={s.cardTitle}>🏢 Empresa facturadora</div>
                <p style={s.detInfo}><strong>{cot.empresaNombre}</strong></p>
                <p style={s.detInfo}>NIT: {cot.empresaNit}</p>
                <p style={s.detInfo}>📞 {cot.empresaTel}</p>
                {cot.empresaEmail && <p style={s.detInfo}>✉️ {cot.empresaEmail}</p>}
              </div>
            </div>
          </div>

          {/* Tabla productos */}
          <div style={s.card}>
            <div style={s.cardTitle}>📦 Productos y servicios</div>
            <table style={{ ...s.table, marginTop: 8 }}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>#</th>
                  <th style={s.th}>Descripción</th>
                  <th style={{ ...s.th, textAlign: 'center' }}>Cant</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Precio Unit</th>
                  <th style={{ ...s.th, textAlign: 'center' }}>Desc</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {(cot.items || []).map((it, idx) => {
                  const sub = (Number(it.cantidad)||0) * (Number(it.precioUnit)||0) * (1 - (Number(it.descuento)||0)/100);
                  return (
                    <React.Fragment key={idx}>
                      <tr style={s.tr}>
                        <td style={{ ...s.td, color: '#9ca3af', fontSize: 12 }}>{idx+1}</td>
                        <td style={s.td}>
                          <div style={{ fontWeight: 600 }}>{it.nombre}</div>
                          {it.descripcion && <div style={{ fontSize: 12, color: '#6b7280' }}>{it.descripcion}</div>}
                        </td>
                        <td style={{ ...s.td, textAlign: 'center' }}>{it.cantidad}</td>
                        <td style={{ ...s.td, textAlign: 'right' }}>{formatCOP(it.precioUnit)}</td>
                        <td style={{ ...s.td, textAlign: 'center', color: it.descuento > 0 ? '#ef4444' : '#9ca3af' }}>
                          {it.descuento > 0 ? `${it.descuento}%` : '—'}
                        </td>
                        <td style={{ ...s.td, textAlign: 'right', fontWeight: 700 }}>{formatCOP(sub)}</td>
                      </tr>
                      {it.notas && (
                        <tr style={{ background: '#fffbeb' }}>
                          <td colSpan={6} style={{ ...s.td, fontSize: 12, color: '#92400e', paddingTop: 4, paddingBottom: 4 }}>
                            📝 {it.notas}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Notas activas */}
          {(cot.notas || []).some(n => n.activa && n.texto) && (
            <div style={s.card}>
              <div style={s.cardTitle}>📋 Condiciones y observaciones</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                {(cot.notas || []).filter(n => n.activa && n.texto).map(n => (
                  <div key={n.key} style={{ borderLeft: '3px solid #667eea', paddingLeft: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#667eea', marginBottom: 2 }}>{n.label}</div>
                    <div style={{ fontSize: 13, color: '#374151' }}>{n.texto}</div>
                  </div>
                ))}
                {cot.notaLibre && (
                  <div style={{ borderLeft: '3px solid #f59e0b', paddingLeft: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', marginBottom: 2 }}>Notas adicionales</div>
                    <div style={{ fontSize: 13, color: '#374151' }}>{cot.notaLibre}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Col derecha */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Totales */}
          <div style={s.card}>
            <div style={s.cardTitle}>💰 Resumen financiero</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <ResumenFila label="Subtotal" valor={cot.totales?.subtotal} />
              {cot.totales?.descG > 0 && <ResumenFila label="Descuento" valor={-cot.totales.descG} color="#ef4444" />}
              {cot.empresaIva && <ResumenFila label="IVA (19%)" valor={cot.totales?.iva} />}
              <div style={{ height: 1, background: '#e5e7eb', margin: '4px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 18, color: '#667eea' }}>
                <span>TOTAL</span>
                <span>{formatCOP(cot.totales?.total)}</span>
              </div>
            </div>
          </div>

          {/* Vencimiento */}
          <div style={s.card}>
            <div style={s.cardTitle}>📅 Vigencia</div>
            <div style={{ marginTop: 8, fontSize: 13, color: '#374151' }}>
              <p style={{ margin: '0 0 4px' }}>Emitida: <strong>{fechaLegible(cot.fecha)}</strong></p>
              <p style={{ margin: '0 0 4px' }}>Vence: <strong>{fechaLegible(cot.fechaVencimiento)}</strong></p>
              {dias !== null && cot.estado === 'pendiente' && (
                <p style={{ margin: 0, color: dias < 0 ? '#ef4444' : dias <= 3 ? '#f59e0b' : '#10b981', fontWeight: 600 }}>
                  {dias < 0 ? `⚠️ Vencida hace ${Math.abs(dias)} días` : `✅ ${dias} días restantes`}
                </p>
              )}
            </div>
          </div>

          {/* Acciones de estado */}
          {puedeConvertir && (
            <div style={s.card}>
              <div style={s.cardTitle}>⚡ Acciones</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {cot.estado === 'pendiente' && (
                  <button onClick={() => setModalConfirm({
                    titulo: '✅ Aprobar cotización',
                    mensaje: `¿El cliente aprobó ${cot.numero}? Se creará la orden automáticamente.`,
                    confirmLabel: '✅ Sí, aprobar y crear orden',
                    confirmColor: '#10b981',
                    onConfirm: () => onCambiarEstado('aprobada'),
                  })} style={{ ...s.btnPrimary, background: '#10b981', justifyContent: 'center' }}>
                    ✅ Aprobar → Crear Orden
                  </button>
                )}
                {cot.estado === 'pendiente' && (
                  <button onClick={() => setModalConfirm({
                    titulo: '❌ Rechazar cotización',
                    mensaje: `¿El cliente rechazó la cotización ${cot.numero}?`,
                    confirmLabel: 'Sí, rechazar',
                    confirmColor: '#ef4444',
                    onConfirm: () => onCambiarEstado('rechazada'),
                  })} style={{ ...s.btnSecondary, color: '#ef4444', border: '1px solid #fca5a5', background: '#fef2f2', justifyContent: 'center' }}>
                    ❌ Marcar como Rechazada
                  </button>
                )}
                {cot.estado !== 'cancelada' && cot.estado !== 'convertida' && (
                  <button onClick={() => setModalConfirm({
                    titulo: 'Cancelar cotización',
                    mensaje: '¿Seguro que deseas cancelar esta cotización?',
                    confirmLabel: 'Cancelar cotización',
                    confirmColor: '#6b7280',
                    onConfirm: () => onCambiarEstado('cancelada'),
                  })} style={{ ...s.btnSecondary, color: '#6b7280', justifyContent: 'center' }}>
                    Cancelar cotización
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Info creación */}
          <div style={{ ...s.card, background: '#f9fafb' }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              <p style={{ margin: '0 0 4px' }}>Creada por: <strong>{cot.creadoPor}</strong></p>
              {cot.createdAt && <p style={{ margin: '0 0 4px' }}>Fecha: <strong>{new Date(cot.createdAt).toLocaleDateString('es-CO')}</strong></p>}
              {cot.ordenId && <p style={{ margin: 0, color: '#8b5cf6', fontWeight: 700 }}>Orden generada: {cot.ordenId}</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// VISTA PDF (impresión)
// ═══════════════════════════════════════════════════════════════════════════════
const VistaPDF = ({ cot, onVolver }) => {
  const printRef = useRef();
  const [logoUrl, setLogoUrl] = useState(cot.empresaLogo || '');

  // Cargar logo directo desde Firestore igual que DetalleOrden
  useEffect(() => {
    if (cot.empresaId) {
      const token = localStorage.getItem('token');
      axios.get(`http://localhost:5000/api/companies/${cot.empresaId}`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => {
        const logo = r.data?.logo || r.data?.logoUrl || cot.empresaLogo || '';
        setLogoUrl(logo);
      }).catch(() => {
        setLogoUrl(cot.empresaLogo || '');
      });
    }
  }, [cot.empresaId]);

  const handlePrint = () => {
    const content = printRef.current?.innerHTML;
    if (!content) return;
    const win = window.open('', '_blank');
    win.document.write(`
      <html><head><title>Cotización ${cot.numero}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; font-size: 13px; color: #222; padding: 20px; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #667eea; }
        .logo { max-height: 80px; max-width: 200px; }
        .empresa-info { text-align: right; font-size: 11px; color: #555; }
        .empresa-nombre { font-size: 15px; font-weight: 700; color: #222; margin-bottom: 4px; }
        .titulo { text-align: center; font-size: 22px; font-weight: 800; color: #667eea; margin: 20px 0 4px; }
        .subtitulo { text-align: center; font-size: 12px; color: #888; margin-bottom: 20px; }
        .destinatario { margin-bottom: 16px; }
        .destinatario strong { font-size: 14px; }
        .intro { font-size: 12px; color: #444; line-height: 1.6; margin-bottom: 20px; padding: 12px; background: #f9f9f9; border-left: 3px solid #667eea; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        th { background: #667eea; color: white; padding: 8px 10px; font-size: 12px; text-align: left; }
        td { padding: 8px 10px; border-bottom: 1px solid #eee; font-size: 12px; }
        .nota-item { font-size: 11px; color: #888; padding: 3px 10px 6px; border-bottom: 1px solid #eee; }
        .totales { margin-left: auto; width: 260px; }
        .tot-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
        .tot-total { display: flex; justify-content: space-between; padding: 8px 0; font-size: 17px; font-weight: 800; color: #667eea; border-top: 2px solid #667eea; margin-top: 6px; }
        .condiciones { margin-top: 24px; }
        .cond-item { margin-bottom: 10px; }
        .cond-label { font-size: 11px; font-weight: 700; color: #667eea; text-transform: uppercase; margin-bottom: 2px; }
        .cond-texto { font-size: 12px; color: #444; }
        .firma { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 12px; }
        .footer { margin-top: 30px; text-align: center; font-size: 10px; color: #aaa; border-top: 1px solid #eee; padding-top: 10px; }
        @media print { body { padding: 0; } }
      </style></head><body>${content}</body></html>
    `);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); win.close(); }, 500);
  };

  const { subtotal, descG, iva, total } = cot.totales || {};

  return (
    <div style={s.page}>
      <div style={s.pageHeader}>
        <button onClick={onVolver} style={s.btnBack}>← Volver</button>
        <button onClick={handlePrint} style={s.btnPrimary}>🖨️ Imprimir / Guardar PDF</button>
      </div>

      {/* Preview del PDF */}
      <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 4px 24px rgba(0,0,0,0.1)', maxWidth: 800, margin: '0 auto', overflow: 'hidden' }}>
        <div ref={printRef}>
          {/* Header empresa */}
          <div className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '24px 32px 16px', borderBottom: '3px solid #667eea' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {logoUrl
                ? <img
                    src={logoUrl}
                    alt="Logo"
                    style={{ maxHeight: 90, maxWidth: 220, objectFit: 'contain', display: 'block' }}
                    onError={e => { e.target.style.display = 'none'; setLogoUrl(''); }}
                  />
                : <div style={{ fontSize: 20, fontWeight: 800, color: '#667eea' }}>{cot.empresaNombre}</div>
              }
            </div>
            <div style={{ textAlign: 'right', fontSize: 12, color: '#555' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#222', marginBottom: 4 }}>{cot.empresaNombre}</div>
              <div>NIT: {cot.empresaNit}</div>
              <div>Tel: {cot.empresaTel}</div>
              <div>{cot.empresaDireccion}</div>
              <div>{cot.empresaEmail}</div>
            </div>
          </div>

          <div style={{ padding: '0 32px 32px' }}>
            {/* Título */}
            <div style={{ textAlign: 'center', margin: '20px 0 8px' }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: '#667eea' }}>COTIZACIÓN</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#333' }}>{cot.numero}</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{fechaLegible(cot.fecha)}</div>
            </div>

            {/* Destinatario */}
            <div style={{ margin: '16px 0', padding: '12px 0', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>SEÑORES:</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{cot.clienteNombre}</div>
              {cot.clienteNit && <div style={{ fontSize: 12, color: '#555' }}>NIT: {cot.clienteNit}</div>}
              {cot.clienteCelular && <div style={{ fontSize: 12, color: '#555' }}>{cot.clienteCelular}</div>}
            </div>

            {/* Saludo + intro */}
            <div style={{ margin: '16px 0', fontSize: 13, color: '#444', lineHeight: 1.7, padding: '12px 16px', background: '#f9f9f9', borderLeft: '3px solid #667eea', borderRadius: 4 }}>
              <strong>Cordial saludo,</strong><br /><br />
              <strong>{cot.empresaNombre}</strong> {cot.introTexto}
            </div>

            {/* Tabla productos */}
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
              <thead>
                <tr style={{ background: '#667eea', color: 'white' }}>
                  <th style={{ padding: '9px 12px', textAlign: 'left', fontSize: 12 }}>#</th>
                  <th style={{ padding: '9px 12px', textAlign: 'left', fontSize: 12 }}>Descripción</th>
                  <th style={{ padding: '9px 12px', textAlign: 'center', fontSize: 12 }}>Cant</th>
                  <th style={{ padding: '9px 12px', textAlign: 'right', fontSize: 12 }}>Precio Unit</th>
                  <th style={{ padding: '9px 12px', textAlign: 'center', fontSize: 12 }}>IVA</th>
                  <th style={{ padding: '9px 12px', textAlign: 'right', fontSize: 12 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {(cot.items || []).map((it, idx) => {
                  const sub = (Number(it.cantidad)||0) * (Number(it.precioUnit)||0) * (1 - (Number(it.descuento)||0)/100);
                  return (
                    <React.Fragment key={idx}>
                      <tr style={{ borderBottom: '1px solid #eee', background: idx % 2 === 0 ? '#fafafa' : '#fff' }}>
                        <td style={{ padding: '8px 12px', fontSize: 12, color: '#888' }}>{idx+1}</td>
                        <td style={{ padding: '8px 12px', fontSize: 12 }}>
                          <strong>{it.nombre}</strong>
                          {it.descripcion && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{it.descripcion}</div>}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'center', fontSize: 12 }}>{it.cantidad}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontSize: 12 }}>{formatCOP(it.precioUnit)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'center', fontSize: 12 }}>{cot.empresaIva ? '19%' : '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontSize: 12, fontWeight: 700 }}>{formatCOP(sub)}</td>
                      </tr>
                      {it.notas && (
                        <tr style={{ background: '#fffbeb' }}>
                          <td colSpan={6} style={{ padding: '4px 12px 8px', fontSize: 11, color: '#92400e' }}>
                            📝 {it.notas}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>

            {/* Totales */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}>
              <div style={{ width: 260 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13, borderBottom: '1px solid #eee' }}>
                  <span style={{ color: '#555' }}>SubTotal</span>
                  <span style={{ fontWeight: 600 }}>{formatCOP(subtotal)}</span>
                </div>
                {descG > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13, borderBottom: '1px solid #eee' }}>
                    <span style={{ color: '#ef4444' }}>Descuento</span>
                    <span style={{ color: '#ef4444', fontWeight: 600 }}>-{formatCOP(descG)}</span>
                  </div>
                )}
                {cot.empresaIva && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13, borderBottom: '1px solid #eee' }}>
                    <span style={{ color: '#555' }}>IVA (19%)</span>
                    <span style={{ fontWeight: 600 }}>{formatCOP(iva)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', fontSize: 18, fontWeight: 800, color: '#667eea', borderTop: '2px solid #667eea', marginTop: 4 }}>
                  <span>TOTAL</span>
                  <span>{formatCOP(total)}</span>
                </div>
              </div>
            </div>

            {/* Condiciones */}
            {(cot.notas || []).some(n => n.activa && n.texto) && (
              <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
                {(cot.notas || []).filter(n => n.activa && n.texto).map(n => (
                  <div key={n.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#667eea', textTransform: 'uppercase', marginBottom: 2 }}>{n.label}</div>
                    <div style={{ fontSize: 12, color: '#444' }}>{n.texto}</div>
                  </div>
                ))}
                {cot.notaLibre && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', marginBottom: 2 }}>Observaciones</div>
                    <div style={{ fontSize: 12, color: '#444' }}>{cot.notaLibre}</div>
                  </div>
                )}
              </div>
            )}

            {/* Firma */}
            <div style={{ marginTop: 40, paddingTop: 16, borderTop: '1px solid #ddd' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{cot.creadoPor}</div>
              <div style={{ fontSize: 12, color: '#666' }}>{cot.empresaNombre}</div>
            </div>

            {/* Footer */}
            <div style={{ marginTop: 24, textAlign: 'center', fontSize: 11, color: '#aaa', borderTop: '1px solid #eee', paddingTop: 10 }}>
              Elaborado con Control360 | Sistema operativo para empresas de servicios
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTES PEQUEÑOS
// ═══════════════════════════════════════════════════════════════════════════════
const KpiCard = ({ label, valor, icon, color, prefix = '' }) => (
  <div style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', gap: 14 }}>
    <div style={{ width: 44, height: 44, borderRadius: 10, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{icon}</div>
    <div>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{prefix}{valor}</div>
      <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 500 }}>{label}</div>
    </div>
  </div>
);

const ResumenFila = ({ label, valor, color = '#374151' }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color, padding: '2px 0' }}>
    <span style={{ color: '#6b7280' }}>{label}</span>
    <span style={{ fontWeight: 600, color }}>{formatCOP(Math.abs(valor))}{valor < 0 ? '' : ''}</span>
  </div>
);

const ModalConfirm = ({ titulo, mensaje, confirmLabel, confirmColor, onConfirm, onClose }) => (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
    <div style={{ background: '#fff', borderRadius: 16, padding: 32, maxWidth: 420, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 18, color: '#111827' }}>{titulo}</h3>
      <p style={{ margin: '0 0 24px', color: '#6b7280', fontSize: 14, lineHeight: 1.6 }}>{mensaje}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={s.btnSecondary}>Cancelar</button>
        <button onClick={onConfirm} style={{ ...s.btnPrimary, background: confirmColor }}>
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
// ESTILOS
// ═══════════════════════════════════════════════════════════════════════════════
const s = {
  wrap:        { minHeight: '100vh', background: '#f5f7fb' },
  page:        { maxWidth: 1100, margin: '0 auto', padding: '24px 20px' },
  loadWrap:    { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh' },
  spinner:     { width: 40, height: 40, border: '3px solid #e5e7eb', borderTop: '3px solid #667eea', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },

  pageHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16, flexWrap: 'wrap' },
  pageTitle:   { fontSize: 26, fontWeight: 800, color: '#111827', margin: '0 0 2px' },
  pageSubtitle:{ fontSize: 14, color: '#6b7280', margin: 0 },
  btnBack:     { background: 'none', border: 'none', color: '#667eea', fontSize: 14, fontWeight: 600, cursor: 'pointer', padding: '0 0 6px', display: 'block' },

  kpiGrid:     { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 },

  filtrosBar:  { display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  searchInput: { flex: 1, minWidth: 200, padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 14, outline: 'none', background: '#fff' },
  select:      { padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 14, background: '#fff', cursor: 'pointer' },

  card:        { background: '#fff', borderRadius: 14, padding: '20px 24px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)', marginBottom: 0 },
  cardTitle:   { fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 14 },

  table:       { width: '100%', borderCollapse: 'collapse' },
  thead:       { background: '#f9fafb' },
  th:          { padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#6b7280', textAlign: 'left', textTransform: 'uppercase', letterSpacing: '0.5px' },
  tr:          { borderBottom: '1px solid #f3f4f6', cursor: 'pointer', transition: 'background 0.15s' },
  td:          { padding: '12px 14px', fontSize: 14, verticalAlign: 'middle' },
  tableFooter: { padding: '10px 14px', fontSize: 12, color: '#9ca3af', borderTop: '1px solid #f3f4f6', textAlign: 'right' },

  badge:       { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 },
  dot:         { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },

  emptyState:  { textAlign: 'center', padding: '60px 20px', background: '#fff', borderRadius: 14, boxShadow: '0 1px 6px rgba(0,0,0,0.06)' },

  tabsBar:     { display: 'flex', gap: 4, background: '#fff', borderRadius: 12, padding: 4, boxShadow: '0 1px 6px rgba(0,0,0,0.06)', marginBottom: 20 },
  tab:         { flex: 1, padding: '10px 16px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#6b7280', background: 'transparent', transition: 'all 0.2s' },
  tabActivo:   { background: 'linear-gradient(135deg, #667eea, #764ba2)', color: '#fff', boxShadow: '0 2px 8px rgba(102,126,234,0.3)' },

  formGrid2:   { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  label:       { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 },
  input:       { width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box', transition: 'border 0.2s' },
  inputSm:     { width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' },

  ivaRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid #f3f4f6' },
  toggle:      { width: 44, height: 24, borderRadius: 12, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleThumb: { position: 'absolute', top: 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', transition: 'transform 0.2s' },

  resumenGrid: { display: 'flex', flexDirection: 'column', gap: 6 },
  resumenTotal:{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 18, color: '#667eea', borderTop: '2px solid #667eea', paddingTop: 10, marginTop: 6 },

  detInfo:     { margin: '2px 0', fontSize: 13, color: '#374151' },

  btnPrimary:  { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', boxShadow: '0 2px 8px rgba(102,126,234,0.3)', whiteSpace: 'nowrap' },
  btnSecondary:{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  btnIcon:     { background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: '4px 6px', borderRadius: 6 },
  btnIconSm:   { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '3px 5px', borderRadius: 4 },

  toastOk:     { position: 'fixed', top: 80, right: 24, background: '#10b981', color: '#fff', padding: '12px 20px', borderRadius: 10, fontWeight: 600, fontSize: 14, zIndex: 2000, boxShadow: '0 4px 16px rgba(16,185,129,0.3)' },
  toastErr:    { position: 'fixed', top: 80, right: 24, background: '#ef4444', color: '#fff', padding: '12px 20px', borderRadius: 10, fontWeight: 600, fontSize: 14, zIndex: 2000, boxShadow: '0 4px 16px rgba(239,68,68,0.3)' },
};

export default GestionCotizaciones;
