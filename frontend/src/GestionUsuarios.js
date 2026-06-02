import React, { useState, useEffect } from 'react';
import axios from 'axios';

// ─────────────────────────────────────────────────────────────────────────────
// Cambios Ola 1:
//   1) Campo PIN (4 dígitos) editable en el modal de usuario.
//      - Botón "Ver PIN" trae el PIN actual desde el backend.
//      - Solo Admin y Tesorería usan PIN para acciones sensibles (se muestra
//        un aviso al lado del campo según el rol seleccionado).
//   2) Auditoría con filtros: módulo (dropdown), N° documento, usuario,
//      desde/hasta (zona horaria Colombia, manejada en backend).
//   3) Filtro "limpiar todo" + recargar.
//   4) Sin cambios visuales/branding en el resto de la UI.
// ─────────────────────────────────────────────────────────────────────────────

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const ROLES = [
  { value: 'admin',      label: 'Administrador',  emoji: '👑', color: '#7c3aed' },
  { value: 'comercial',  label: 'Comercial',       emoji: '💼', color: '#0284c7' },
  { value: 'mensajero',  label: 'Mensajero',       emoji: '🚚', color: '#0891b2' },
  { value: 'taller',     label: 'Taller',          emoji: '🔧', color: '#b45309' },
  { value: 'tesoreria',  label: 'Tesorería',       emoji: '💰', color: '#047857' },
  { value: 'visor',      label: 'Visor',           emoji: '👁️', color: '#6b7280' },
];

const ROLES_CON_PIN = ['admin', 'tesoreria'];

const MODULOS_DISPONIBLES = [
  { key: 'dashboard',    label: 'Dashboard',         emoji: '📊' },
  { key: 'ordenes',      label: 'Órdenes',           emoji: '📋' },
  { key: 'cotizaciones', label: 'Cotizaciones',      emoji: '📄' },
  { key: 'clientes',     label: 'Clientes',          emoji: '👥' },
  { key: 'productos',    label: 'Productos',         emoji: '📦' },
  { key: 'proveedores',  label: 'Proveedores',       emoji: '🏭' },
  { key: 'logistica',    label: 'Logística',         emoji: '🗺️' },
  { key: 'taller',       label: 'Taller',            emoji: '🔧' },
  { key: 'qr',           label: 'QR / Hojas de Vida',emoji: '🔲' },
  { key: 'egresos',      label: 'Egresos',           emoji: '💸' },
  { key: 'caja',         label: 'Caja',              emoji: '🏦' },
  { key: 'cxc',          label: 'CxC',               emoji: '💳' },
  { key: 'cxp',          label: 'CxP',               emoji: '📋' },
  { key: 'reportes',     label: 'Reportes',          emoji: '📉' },
  { key: 'auditoria',    label: 'Auditoría',         emoji: '🔍' },
  { key: 'usuarios',     label: 'Usuarios',          emoji: '👤' },
  { key: 'empresas',     label: 'Mi Empresa',        emoji: '🏢' },
];

const MODULOS_POR_ROL = {
  admin:      MODULOS_DISPONIBLES.map(m => m.key),
  comercial:  ['dashboard', 'ordenes', 'cotizaciones', 'clientes', 'productos', 'cxc', 'reportes'],
  mensajero:  ['dashboard', 'logistica', 'ordenes', 'clientes', 'productos', 'caja'],
  taller:     ['dashboard', 'taller', 'productos', 'reportes'],
  tesoreria:  ['dashboard', 'caja', 'egresos', 'cxc', 'cxp', 'clientes', 'ordenes', 'reportes'],
  visor:      ['dashboard', 'reportes'],
};

const FORM_VACIO = {
  nombre: '', email: '', codigo: '', password: '', pin: '',
  role: 'comercial', modulos: MODULOS_POR_ROL['comercial'], activo: true
};

const FILTROS_VACIOS = {
  modulo: '',
  documento: '',
  usuarioId: '',
  desde: '',
  hasta: ''
};

const GestionUsuarios = ({ user }) => {
  const [usuarios, setUsuarios]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [mostrarForm, setMostrarForm]   = useState(false);
  const [editando, setEditando]         = useState(null);
  const [form, setForm]                 = useState(FORM_VACIO);
  const [guardando, setGuardando]       = useState(false);
  const [error, setError]               = useState('');
  const [exito, setExito]               = useState('');
  const [verPassword, setVerPassword]   = useState(false);
  const [verPin, setVerPin]             = useState(false);
  const [tabActiva, setTabActiva]       = useState('usuarios'); // 'usuarios' | 'auditoria'
  const [mostrarInactivos, setMostrarInactivos] = useState(false); // PAQUETE B: ocultar inactivos por defecto

  // Auditoría
  const [auditoria, setAuditoria]       = useState([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [filtros, setFiltros]           = useState(FILTROS_VACIOS);
  const [modulosFiltro, setModulosFiltro] = useState([]);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // ─── CARGAR USUARIOS ────────────────────────────────────────────────────────
  const cargarUsuarios = async () => {
    try {
      setLoading(true);
      const res = await axios.get(`${API}/users`, { headers });
      setUsuarios(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      setError('Error al cargar usuarios');
    } finally {
      setLoading(false);
    }
  };

  // ─── CARGAR LISTA DE MÓDULOS PARA EL DROPDOWN DE AUDITORÍA ──────────────────
  const cargarModulosFiltro = async () => {
    try {
      const res = await axios.get(`${API}/users/auditoria/modulos`, { headers });
      setModulosFiltro(Array.isArray(res.data) ? res.data : []);
    } catch { setModulosFiltro([]); }
  };

  // ─── CARGAR AUDITORÍA con filtros ───────────────────────────────────────────
  const cargarAuditoria = async () => {
    try {
      setLoadingAudit(true);
      const params = new URLSearchParams();
      params.append('limite', '200');
      if (filtros.modulo)    params.append('modulo', filtros.modulo);
      if (filtros.documento) params.append('documento', filtros.documento);
      if (filtros.usuarioId) params.append('usuarioId', filtros.usuarioId);
      if (filtros.desde)     params.append('desde', filtros.desde);
      if (filtros.hasta)     params.append('hasta', filtros.hasta);

      const res = await axios.get(`${API}/users/auditoria/log?${params.toString()}`, { headers });
      setAuditoria(Array.isArray(res.data) ? res.data : []);
    } catch {
      setAuditoria([]);
    } finally {
      setLoadingAudit(false);
    }
  };

  useEffect(() => { cargarUsuarios(); cargarModulosFiltro(); }, []);

  useEffect(() => {
    if (tabActiva === 'auditoria') cargarAuditoria();
    // eslint-disable-next-line
  }, [tabActiva]);

  // ─── CAMBIO DE ROL → precargar módulos ─────────────────────────────────────
  const handleRolChange = (nuevoRol) => {
    setForm(prev => ({ ...prev, role: nuevoRol, modulos: MODULOS_POR_ROL[nuevoRol] || ['dashboard'] }));
  };

  // ─── TOGGLE MÓDULO ──────────────────────────────────────────────────────────
  const toggleModulo = (key) => {
    setForm(prev => ({
      ...prev,
      modulos: prev.modulos.includes(key)
        ? prev.modulos.filter(m => m !== key)
        : [...prev.modulos, key]
    }));
  };

  // ─── ABRIR FORMULARIO NUEVO ─────────────────────────────────────────────────
  const abrirNuevo = () => {
    setEditando(null);
    setForm(FORM_VACIO);
    setVerPin(false);
    setError('');
    setExito('');
    setMostrarForm(true);
  };

  // ─── ABRIR FORMULARIO EDITAR ────────────────────────────────────────────────
  const abrirEditar = async (usuario) => {
    setEditando(usuario.id);
    setVerPin(false);

    // El PIN no viene en el listado por seguridad. Lo pedimos al backend
    // solo cuando se abre el modal de edición (admin lo necesita para
    // mostrarlo si lo desea con "Ver PIN").
    let pinActual = '';
    try {
      const r = await axios.get(`${API}/users/${usuario.id}/pin`, { headers });
      pinActual = r.data?.pin || '';
    } catch { pinActual = ''; }

    setForm({
      nombre:   usuario.nombre || '',
      email:    usuario.email || '',
      codigo:   usuario.codigo || '',
      password: '',
      pin:      pinActual,
      role:     usuario.role || 'comercial',
      modulos:  usuario.modulos || MODULOS_POR_ROL['comercial'],
      activo:   usuario.activo !== false
    });
    setError('');
    setExito('');
    setMostrarForm(true);
  };

  // ─── GUARDAR ────────────────────────────────────────────────────────────────
  const guardar = async () => {
    setError('');
    if (!form.nombre || !form.email || !form.codigo || (!editando && !form.password)) {
      setError('Completa todos los campos obligatorios');
      return;
    }
    if (form.modulos.length === 0) {
      setError('Selecciona al menos un módulo');
      return;
    }
    // Validación PIN: si se digitó algo, debe tener exactamente 4 dígitos.
    if (form.pin && !/^\d{4}$/.test(form.pin)) {
      setError('El PIN debe ser de 4 dígitos numéricos');
      return;
    }
    try {
      setGuardando(true);
      if (editando) {
        await axios.put(`${API}/users/${editando}`, form, { headers });
        setExito('Usuario actualizado correctamente ✓');
      } else {
        await axios.post(`${API}/users`, form, { headers });
        setExito('Usuario creado correctamente ✓');
      }
      await cargarUsuarios();
      setTimeout(() => { setMostrarForm(false); setExito(''); }, 1500);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al guardar usuario');
    } finally {
      setGuardando(false);
    }
  };

  // ─── DESACTIVAR ─────────────────────────────────────────────────────────────
  const desactivar = async (id, nombre) => {
    if (!window.confirm(`¿Desactivar al usuario ${nombre}? Podrás reactivarlo después.`)) return;
    try {
      await axios.delete(`${API}/users/${id}`, { headers });
      setExito(`Usuario ${nombre} desactivado`);
      await cargarUsuarios();
      setTimeout(() => setExito(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al desactivar');
    }
  };

  // ─── HELPERS UI ─────────────────────────────────────────────────────────────
  const getRol = (value) => ROLES.find(r => r.value === value) || { label: value, emoji: '👤', color: '#666' };

  const formatFecha = (fecha) => {
    if (!fecha) return '—';
    try {
      // Forzar zona Colombia para que coincida con lo que el usuario digita.
      return new Date(fecha).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    } catch { return '—'; }
  };

  const rolActualUsaPin = ROLES_CON_PIN.includes(form.role);

  return (
    <div style={s.wrapper}>

      {/* ── HEADER ── */}
      <div style={s.pageHeader}>
        <div>
          <h2 style={s.pageTitle}>👥 Gestión de Usuarios</h2>
          <p style={s.pageSubtitle}>Administra el equipo y sus permisos de acceso</p>
        </div>
        <button onClick={abrirNuevo} style={s.btnPrimario}>+ Nuevo Usuario</button>
      </div>

      {error  && <div style={s.alertError}>{error}</div>}
      {exito  && <div style={s.alertExito}>{exito}</div>}

      {/* ── TABS ── */}
      <div style={s.tabs}>
        <button onClick={() => setTabActiva('usuarios')}
          style={{ ...s.tab, ...(tabActiva === 'usuarios' ? s.tabActiva : {}) }}>👥 Usuarios</button>
        <button onClick={() => setTabActiva('auditoria')}
          style={{ ...s.tab, ...(tabActiva === 'auditoria' ? s.tabActiva : {}) }}>🔍 Auditoría</button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: USUARIOS
      ══════════════════════════════════════════════════════════════════════ */}
      {tabActiva === 'usuarios' && (
        <>
          {loading ? (
            <div style={s.loadingBox}>Cargando usuarios...</div>
          ) : (() => {
            // PAQUETE B: filtrar usuarios desactivados (excepto si toggle está activo)
            const usuariosVisibles = mostrarInactivos
              ? usuarios
              : usuarios.filter(u => u.activo !== false);
            const inactivosCount = usuarios.filter(u => u.activo === false).length;

            return (
              <>
                {/* Toggle para mostrar inactivos */}
                {inactivosCount > 0 && (
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: '#f9fafb', border: '1px solid #e5e7eb',
                    borderRadius: 10, padding: '10px 14px', marginBottom: 14
                  }}>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>
                      Mostrando <strong>{usuariosVisibles.length}</strong> usuarios activos
                      {inactivosCount > 0 && !mostrarInactivos && (
                        <span style={{ color: '#9ca3af', marginLeft: 8 }}>
                          · {inactivosCount} inactivo(s) oculto(s)
                        </span>
                      )}
                    </span>
                    <button onClick={() => setMostrarInactivos(!mostrarInactivos)} style={{
                      background: mostrarInactivos ? '#7c3aed' : '#fff',
                      color: mostrarInactivos ? '#fff' : '#7c3aed',
                      border: '1px solid #7c3aed',
                      borderRadius: 8, padding: '6px 14px',
                      cursor: 'pointer', fontSize: 12, fontWeight: 700
                    }}>
                      {mostrarInactivos ? '✓ Mostrando inactivos' : 'Mostrar inactivos'}
                    </button>
                  </div>
                )}

                <div style={s.grid}>
                  {usuariosVisibles.length === 0 && (
                    <div style={s.emptyBox}>
                      <p>{mostrarInactivos ? 'No hay usuarios creados aún.' : 'No hay usuarios activos.'}</p>
                      <button onClick={abrirNuevo} style={s.btnPrimario}>+ Crear primer usuario</button>
                    </div>
                  )}
                  {usuariosVisibles.map(u => {
                    const rol = getRol(u.role);
                    const usaPin = ROLES_CON_PIN.includes(u.role);
                    return (
                      <div key={u.id} style={{ ...s.card, opacity: u.activo === false ? 0.5 : 1 }}>
                    <div style={s.cardHeader}>
                      <div style={{ ...s.avatar, background: rol.color }}>{rol.emoji}</div>
                      <div style={s.cardInfo}>
                        <h3 style={s.cardNombre}>{u.nombre}</h3>
                        <span style={{ ...s.badge, background: rol.color }}>{rol.label}</span>
                      </div>
                      {u.activo === false && <span style={s.badgeInactivo}>INACTIVO</span>}
                    </div>
                    <div style={s.cardDatos}>
                      <div style={s.dato}><span style={s.datoLabel}>Email</span><span>{u.email}</span></div>
                      <div style={s.dato}><span style={s.datoLabel}>Código</span><span style={s.codigo}>{u.codigo}</span></div>
                      <div style={s.dato}>
                        <span style={s.datoLabel}>PIN autorización</span>
                        <span style={{ ...s.codigo, background: usaPin ? (u.tienePin ? '#dcfce7' : '#fee2e2') : '#f3f4f6', color: usaPin ? (u.tienePin ? '#16a34a' : '#dc2626') : '#9ca3af' }}>
                          {usaPin ? (u.tienePin ? '✓ Configurado' : '✗ Sin configurar') : 'No aplica'}
                        </span>
                      </div>
                      <div style={s.dato}>
                        <span style={s.datoLabel}>Módulos</span>
                        <span style={s.numModulos}>{(u.modulos || []).length} activos</span>
                      </div>
                    </div>
                    <div style={s.modChips}>
                      {(u.modulos || []).slice(0, 5).map(m => {
                        const mod = MODULOS_DISPONIBLES.find(x => x.key === m);
                        return mod ? <span key={m} style={s.chip}>{mod.emoji} {mod.label}</span> : null;
                      })}
                      {(u.modulos || []).length > 5 && (
                        <span style={s.chipMas}>+{(u.modulos || []).length - 5} más</span>
                      )}
                    </div>
                    <div style={s.cardAcciones}>
                      <button onClick={() => abrirEditar(u)} style={s.btnEditar}>✏️ Editar</button>
                      {u.activo !== false && u.role !== 'admin' && (
                        <button onClick={() => desactivar(u.id, u.nombre)} style={s.btnDesactivar}>🚫 Desactivar</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
              </>
            );
          })()}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TAB: AUDITORÍA con filtros completos
      ══════════════════════════════════════════════════════════════════════ */}
      {tabActiva === 'auditoria' && (
        <>
          <div style={s.filtrosBox}>
            <div style={s.filtrosFila}>
              <div style={s.filtroCampo}>
                <label style={s.filtroLabel}>Módulo</label>
                <select style={s.filtroInput}
                  value={filtros.modulo}
                  onChange={e => setFiltros({ ...filtros, modulo: e.target.value })}>
                  <option value="">Todos</option>
                  {modulosFiltro.map(m => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div style={s.filtroCampo}>
                <label style={s.filtroLabel}>N° de documento</label>
                <input type="text" style={s.filtroInput}
                  placeholder="Ej: OS-0341, EGR-012"
                  value={filtros.documento}
                  onChange={e => setFiltros({ ...filtros, documento: e.target.value })} />
              </div>
              <div style={s.filtroCampo}>
                <label style={s.filtroLabel}>Usuario</label>
                <select style={s.filtroInput}
                  value={filtros.usuarioId}
                  onChange={e => setFiltros({ ...filtros, usuarioId: e.target.value })}>
                  <option value="">Todos</option>
                  {usuarios.map(u => (
                    <option key={u.id} value={u.id}>{u.nombre}</option>
                  ))}
                </select>
              </div>
              <div style={s.filtroCampo}>
                <label style={s.filtroLabel}>Desde</label>
                <input type="date" style={s.filtroInput}
                  value={filtros.desde}
                  onChange={e => setFiltros({ ...filtros, desde: e.target.value })} />
              </div>
              <div style={s.filtroCampo}>
                <label style={s.filtroLabel}>Hasta</label>
                <input type="date" style={s.filtroInput}
                  value={filtros.hasta}
                  onChange={e => setFiltros({ ...filtros, hasta: e.target.value })} />
              </div>
            </div>
            <div style={s.filtrosAcciones}>
              <button onClick={cargarAuditoria} style={s.btnFiltrar}>🔍 Filtrar</button>
              <button onClick={() => { setFiltros(FILTROS_VACIOS); setTimeout(cargarAuditoria, 50); }} style={s.btnLimpiar}>
                Limpiar
              </button>
              <span style={s.contador}>
                {loadingAudit ? 'Cargando...' : `${auditoria.length} registros`}
              </span>
            </div>
          </div>

          <div style={s.auditBox}>
            {loadingAudit ? (
              <div style={s.loadingBox}>Cargando auditoría...</div>
            ) : auditoria.length === 0 ? (
              <div style={s.emptyBox}>No hay registros con esos filtros.</div>
            ) : (
              <table style={s.tabla}>
                <thead>
                  <tr>
                    {['Fecha', 'Usuario', 'Acción', 'Módulo', 'Documento', 'Descripción'].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {auditoria.map((log, i) => (
                    <tr key={log.id || i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                      <td style={s.td}>{formatFecha(log.fecha)}</td>
                      <td style={s.td}>{log.usuarioNombre || '—'}</td>
                      <td style={s.td}><span style={s.accionBadge}>{log.accion}</span></td>
                      <td style={s.td}>{log.modulo}</td>
                      <td style={s.td}>{log.documento || '—'}</td>
                      <td style={s.td}>{log.descripcion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MODAL: FORMULARIO CREAR / EDITAR
      ══════════════════════════════════════════════════════════════════════ */}
      {mostrarForm && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalHeader}>
              <h3 style={s.modalTitulo}>{editando ? '✏️ Editar Usuario' : '➕ Nuevo Usuario'}</h3>
              <button onClick={() => setMostrarForm(false)} style={s.btnCerrar}>✕</button>
            </div>

            {error && <div style={s.alertError}>{error}</div>}
            {exito && <div style={s.alertExito}>{exito}</div>}

            <div style={s.modalBody}>

              {/* Fila: nombre + email */}
              <div style={s.fila2}>
                <div style={s.campo}>
                  <label style={s.label}>Nombre completo *</label>
                  <input style={s.input} placeholder="Ej: Carlos Pérez"
                    value={form.nombre}
                    onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} />
                </div>
                <div style={s.campo}>
                  <label style={s.label}>Email *</label>
                  <input style={s.input} type="email" placeholder="carlos@empresa.com"
                    value={form.email}
                    onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                    disabled={!!editando} />
                </div>
              </div>

              {/* Fila: código + contraseña */}
              <div style={s.fila2}>
                <div style={s.campo}>
                  <label style={s.label}>Código *</label>
                  <input style={s.input} placeholder="Ej: 0220"
                    maxLength={10}
                    value={form.codigo}
                    onChange={e => setForm(p => ({ ...p, codigo: e.target.value }))} />
                  <small style={s.hint}>Identificador interno del usuario</small>
                </div>
                <div style={s.campo}>
                  <label style={s.label}>{editando ? 'Nueva contraseña (opcional)' : 'Contraseña *'}</label>
                  <div style={s.passWrap}>
                    <input style={{ ...s.input, paddingRight: '44px' }}
                      type={verPassword ? 'text' : 'password'}
                      placeholder={editando ? 'Dejar vacío para no cambiar' : 'Mínimo 6 caracteres'}
                      value={form.password}
                      onChange={e => setForm(p => ({ ...p, password: e.target.value }))} />
                    <button type="button" onClick={() => setVerPassword(!verPassword)} style={s.eyeBtn}>
                      {verPassword ? '🙈' : '👁️'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Fila: PIN — solo aplica para Admin y Tesorería */}
              <div style={s.campo}>
                <label style={s.label}>
                  PIN de autorización (4 dígitos)
                  {rolActualUsaPin
                    ? <span style={s.pinAviso}>Requerido para autorizar acciones sensibles (anular órdenes, cuadre de caja, desbloqueo de cartera)</span>
                    : <span style={s.pinAvisoSec}>Solo se usa para roles Administrador o Tesorería</span>
                  }
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ ...s.passWrap, flex: '0 0 200px' }}>
                    <input
                      style={{ ...s.input, paddingRight: '44px', letterSpacing: '8px', fontSize: '18px', textAlign: 'center', fontFamily: 'monospace' }}
                      type={verPin ? 'text' : 'password'}
                      placeholder="0000"
                      maxLength={4}
                      inputMode="numeric"
                      value={form.pin}
                      disabled={!rolActualUsaPin}
                      onChange={e => {
                        const soloDigitos = e.target.value.replace(/\D/g, '').slice(0, 4);
                        setForm(p => ({ ...p, pin: soloDigitos }));
                      }}
                    />
                    <button type="button" onClick={() => setVerPin(!verPin)} style={s.eyeBtn}>
                      {verPin ? '🙈' : '👁️'}
                    </button>
                  </div>
                  {form.pin && (
                    <small style={s.hint}>
                      {form.pin.length === 4 ? '✓ Listo' : `Faltan ${4 - form.pin.length} dígitos`}
                    </small>
                  )}
                  {editando && rolActualUsaPin && !form.pin && (
                    <small style={{ ...s.hint, color: '#dc2626' }}>
                      Sin PIN: este usuario no podrá autorizar acciones sensibles
                    </small>
                  )}
                </div>
              </div>

              {/* Rol */}
              <div style={s.campo}>
                <label style={s.label}>Rol *</label>
                <div style={s.rolesGrid}>
                  {ROLES.map(r => (
                    <button key={r.value} type="button"
                      onClick={() => handleRolChange(r.value)}
                      style={{
                        ...s.rolBtn,
                        background: form.role === r.value ? r.color : '#f3f4f6',
                        color:      form.role === r.value ? '#fff' : '#374151',
                        border:     form.role === r.value ? `2px solid ${r.color}` : '2px solid transparent',
                      }}>
                      <span style={{ fontSize: '20px' }}>{r.emoji}</span>
                      <span style={{ fontSize: '12px', fontWeight: 600 }}>{r.label}</span>
                    </button>
                  ))}
                </div>
                <small style={s.hint}>Al seleccionar un rol se precargan los módulos recomendados. Puedes ajustarlos abajo.</small>
              </div>

              {/* Módulos */}
              <div style={s.campo}>
                <label style={s.label}>Módulos activos ({form.modulos.length} seleccionados)</label>
                <div style={s.modulosGrid}>
                  {MODULOS_DISPONIBLES.map(m => {
                    const activo = form.modulos.includes(m.key);
                    return (
                      <button key={m.key} type="button"
                        onClick={() => toggleModulo(m.key)}
                        style={{
                          ...s.modBtn,
                          background: activo ? '#ede9fe' : '#f9fafb',
                          color:      activo ? '#6d28d9' : '#6b7280',
                          border:     activo ? '2px solid #7c3aed' : '2px solid #e5e7eb',
                          fontWeight: activo ? 700 : 400,
                        }}>
                        <span>{m.emoji}</span> {m.label}
                        {activo && <span style={s.checkMod}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Estado activo */}
              {editando && (
                <div style={s.campoRow}>
                  <label style={s.label}>Estado del usuario</label>
                  <div style={s.toggleWrap}>
                    <button type="button"
                      onClick={() => setForm(p => ({ ...p, activo: !p.activo }))}
                      style={{
                        ...s.toggleBtn,
                        background: form.activo ? '#10b981' : '#ef4444',
                      }}>
                      {form.activo ? '✓ Activo' : '✗ Inactivo'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div style={s.modalFooter}>
              <button onClick={() => setMostrarForm(false)} style={s.btnCancelar}>Cancelar</button>
              <button onClick={guardar} disabled={guardando} style={s.btnGuardar}>
                {guardando ? 'Guardando...' : editando ? '💾 Guardar cambios' : '✅ Crear usuario'}
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
  wrapper:      { padding: '32px', maxWidth: '1400px', margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  pageHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' },
  pageTitle:    { margin: 0, fontSize: '26px', fontWeight: 700, color: '#111' },
  pageSubtitle: { margin: '4px 0 0', color: '#6b7280', fontSize: '14px' },
  btnPrimario:  { padding: '12px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' },

  alertError:   { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px' },
  alertExito:   { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px' },

  tabs:         { display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: '2px solid #e5e7eb', paddingBottom: '0' },
  tab:          { padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 600, color: '#6b7280', borderBottom: '2px solid transparent', marginBottom: '-2px' },
  tabActiva:    { color: '#7c3aed', borderBottom: '2px solid #7c3aed' },

  loadingBox:   { textAlign: 'center', padding: '60px', color: '#9ca3af', fontSize: '16px' },
  emptyBox:     { textAlign: 'center', padding: '60px', color: '#9ca3af', background: '#fff', borderRadius: '12px' },

  grid:         { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' },
  card:         { background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', overflow: 'hidden', transition: 'box-shadow 0.2s' },
  cardHeader:   { display: 'flex', alignItems: 'center', gap: '14px', padding: '20px 20px 12px' },
  avatar:       { width: '48px', height: '48px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', flexShrink: 0 },
  cardInfo:     { flex: 1 },
  cardNombre:   { margin: '0 0 6px', fontSize: '16px', fontWeight: 700, color: '#111' },
  badge:        { padding: '3px 10px', borderRadius: '20px', color: '#fff', fontSize: '11px', fontWeight: 700 },
  badgeInactivo:{ background: '#ef4444', color: '#fff', padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700 },
  cardDatos:    { padding: '0 20px 12px', display: 'flex', flexDirection: 'column', gap: '6px' },
  dato:         { display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#374151' },
  datoLabel:    { color: '#9ca3af', fontWeight: 600 },
  codigo:       { background: '#f3f4f6', padding: '2px 10px', borderRadius: '4px', fontFamily: 'monospace', fontWeight: 700 },
  numModulos:   { background: '#ede9fe', color: '#7c3aed', padding: '2px 10px', borderRadius: '4px', fontWeight: 700, fontSize: '12px' },
  modChips:     { padding: '8px 20px 12px', display: 'flex', flexWrap: 'wrap', gap: '6px' },
  chip:         { background: '#f3f4f6', color: '#6b7280', padding: '3px 10px', borderRadius: '20px', fontSize: '11px' },
  chipMas:      { background: '#ede9fe', color: '#7c3aed', padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700 },
  cardAcciones: { padding: '12px 20px 20px', display: 'flex', gap: '10px', borderTop: '1px solid #f3f4f6' },
  btnEditar:    { flex: 1, padding: '8px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnDesactivar:{ flex: 1, padding: '8px', background: '#fef2f2', color: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },

  // Filtros auditoría
  filtrosBox:    { background: '#fff', borderRadius: '12px', padding: '16px 20px', marginBottom: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  filtrosFila:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '12px' },
  filtroCampo:   { display: 'flex', flexDirection: 'column', gap: '4px' },
  filtroLabel:   { fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' },
  filtroInput:   { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: '6px', fontSize: '13px', outline: 'none', background: '#fff' },
  filtrosAcciones: { display: 'flex', alignItems: 'center', gap: '10px' },
  btnFiltrar:    { padding: '8px 18px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnLimpiar:    { padding: '8px 14px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' },
  contador:      { marginLeft: 'auto', fontSize: '12px', color: '#6b7280' },

  // Auditoría tabla
  auditBox:     { background: '#fff', borderRadius: '12px', overflow: 'auto', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
  tabla:        { width: '100%', borderCollapse: 'collapse' },
  th:           { background: '#f9fafb', padding: '12px 16px', textAlign: 'left', fontSize: '12px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' },
  td:           { padding: '12px 16px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #f3f4f6' },
  accionBadge:  { background: '#ede9fe', color: '#7c3aed', padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 700 },

  // Modal
  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' },
  modal:        { background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '720px', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  modalHeader:  { padding: '24px 24px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  modalTitulo:  { margin: 0, fontSize: '20px', fontWeight: 700, color: '#111' },
  btnCerrar:    { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', fontSize: '16px', color: '#6b7280' },
  modalBody:    { padding: '24px', overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' },
  modalFooter:  { padding: '16px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: '12px' },

  fila2:        { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  campo:        { display: 'flex', flexDirection: 'column', gap: '6px' },
  campoRow:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  label:        { fontSize: '13px', fontWeight: 700, color: '#374151', display: 'flex', flexDirection: 'column', gap: '2px' },
  hint:         { fontSize: '11px', color: '#9ca3af', marginTop: '2px' },
  pinAviso:     { fontSize: '11px', fontWeight: 500, color: '#7c3aed', marginTop: '2px' },
  pinAvisoSec:  { fontSize: '11px', fontWeight: 500, color: '#9ca3af', marginTop: '2px', fontStyle: 'italic' },
  input:        { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', outline: 'none', transition: 'border 0.2s', width: '100%', boxSizing: 'border-box' },
  passWrap:     { position: 'relative' },
  eyeBtn:       { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px' },

  rolesGrid:    { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' },
  rolBtn:       { padding: '12px 8px', borderRadius: '10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', transition: 'all 0.15s' },

  modulosGrid:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px' },
  modBtn:       { padding: '8px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s', position: 'relative' },
  checkMod:     { marginLeft: 'auto', fontWeight: 900, color: '#7c3aed' },

  toggleWrap:   { display: 'flex', alignItems: 'center' },
  toggleBtn:    { padding: '8px 20px', border: 'none', borderRadius: '20px', cursor: 'pointer', color: '#fff', fontWeight: 700, fontSize: '13px' },

  btnCancelar:  { padding: '10px 24px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 },
  btnGuardar:   { padding: '10px 28px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' },
};

export default GestionUsuarios;

