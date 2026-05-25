import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const soloNumeros = (val) => val.replace(/\D/g, '');
const mayusculas = (val) => val.toUpperCase();

const FORM_VACIO = {
  nombre: '', nit: '', tipoDocumento: 'NIT',
  telefono: '', celular: '',
  emailLegal: '', emailsAdicionales: [],
  direccionPrincipal: '', ciudad: '', departamento: '',
  empresaId: '', empresaNombre: '',
  sucursales: [], notas: ''
};

const SUCURSAL_VACIA = { nombre: '', direccion: '', ciudad: '', telefono: '', encargado: '' };

// ─── COMPONENTE PRINCIPAL ─────────────────────────────────────────────────────
const GestionClientes = ({ user, empresas = [] }) => {
  const [clientes, setClientes]           = useState([]);
  const [loading, setLoading]             = useState(true);
  const [buscar, setBuscar]               = useState('');
  const [filtroEmpresa, setFiltroEmpresa] = useState('');
  const [mostrarForm, setMostrarForm]     = useState(false);
  const [editandoId, setEditandoId]       = useState(null);
  const [form, setForm]                   = useState(FORM_VACIO);
  const [tabForm, setTabForm]             = useState('datos'); // datos | sucursales | emails | notas
  const [guardando, setGuardando]         = useState(false);
  const [error, setError]                 = useState('');
  const [exito, setExito]                 = useState('');
  const [alerta, setAlerta]               = useState(null); // {tipo, mensaje, similares, clienteExistente}
  const [emailNuevo, setEmailNuevo]       = useState('');
  const [verDetalle, setVerDetalle]       = useState(null);
  const [verInactivos, setVerInactivos]   = useState(false);

  const isAdmin = user?.role === 'admin';
  const [mostrarImportCli, setMostrarImportCli] = useState(false);
  const [previstaImportCli, setPrevistaImportCli] = useState([]);
  const [importandoCli, setImportandoCli] = useState(false);
  const [resultadoCli, setResultadoCli] = useState(null);
  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // ─── CARGAR EMPRESAS DESDE FIRESTORE SI NO VIENEN POR PROP ───────────────
  const [empresasDisponibles, setEmpresasDisponibles] = useState(empresas);

  useEffect(() => {
    const t = localStorage.getItem('token');
    if (!t) return;
    axios.get(`${API}/companies`, { headers: { Authorization: `Bearer ${t}` } })
      .then(r => setEmpresasDisponibles(Array.isArray(r.data) ? r.data : []))
      .catch(() => setEmpresasDisponibles([]));
  }, [token]);

  // ─── CARGAR CLIENTES ──────────────────────────────────────────────────────
  const cargarClientes = useCallback(async () => {
    try {
      setLoading(true);
      let url = `${API}/clients?`;
      if (filtroEmpresa) url += `empresaId=${filtroEmpresa}&`;
      if (buscar) url += `buscar=${encodeURIComponent(buscar)}&`;
      if (isAdmin && verInactivos) url += `activo=todos&`;
      const res = await axios.get(url, { headers });
      setClientes(Array.isArray(res.data) ? res.data : []);
    } catch {
      setError('Error al cargar clientes');
    } finally {
      setLoading(false);
    }
  }, [filtroEmpresa, buscar, verInactivos]);

  useEffect(() => { cargarClientes(); }, [cargarClientes]);

  // ─── VERIFICAR DUPLICADOS ─────────────────────────────────────────────────
  const verificarDuplicados = async () => {
    if (!form.nit && !form.nombre) return true;
    try {
      const res = await axios.post(`${API}/clients/verificar`, {
        nit: form.nit, nombre: form.nombre
      }, { headers });
      const data = res.data;

      if (data.nitDuplicado) {
        setAlerta({
          tipo: 'nit',
          mensaje: `Ya existe un cliente con ese NIT: ${data.clienteExistente?.nombre}`,
          clienteExistente: data.clienteExistente
        });
        return false;
      }
      if (data.nombreSimilar && !editandoId) {
        setAlerta({
          tipo: 'nombre',
          mensaje: `Se encontraron clientes con nombre similar:`,
          similares: data.similares
        });
        return false;
      }
      return true;
    } catch { return true; }
  };

  // ─── ABRIR FORMULARIO NUEVO ───────────────────────────────────────────────
  const abrirNuevo = () => {
    setEditandoId(null);
    setForm(FORM_VACIO);
    setTabForm('datos');
    setAlerta(null);
    setError('');
    setExito('');
    setMostrarForm(true);
  };

  // ─── ABRIR FORMULARIO EDITAR ──────────────────────────────────────────────
  const abrirEditar = (cliente) => {
    setEditandoId(cliente.id);
    setForm({
      nombre: cliente.nombre || '',
      nit: cliente.nit || '',
      tipoDocumento: cliente.tipoDocumento || 'NIT',
      telefono: cliente.telefono || '',
      celular: cliente.celular || '',
      emailLegal: cliente.emailLegal || '',
      emailsAdicionales: cliente.emailsAdicionales || [],
      direccionPrincipal: cliente.direccionPrincipal || '',
      ciudad: cliente.ciudad || '',
      departamento: cliente.departamento || '',
      empresaId: cliente.empresaId || '',
      empresaNombre: cliente.empresaNombre || '',
      sucursales: cliente.sucursales || [],
      notas: cliente.notas || ''
    });
    setTabForm('datos');
    setAlerta(null);
    setError('');
    setExito('');
    setMostrarForm(true);
  };

  // ─── GUARDAR ─────────────────────────────────────────────────────────────
  const guardar = async (forzar = false) => {
    setError('');
    setAlerta(null);

    if (!form.nombre.trim()) { setError('El nombre es obligatorio'); return; }
    if (!form.empresaId) { setError('Debes seleccionar a qué empresa pertenece este cliente'); return; }
    if (form.celular && form.celular.length !== 10) { setError('El celular debe tener 10 dígitos'); return; }

    if (!forzar && !editandoId) {
      const ok = await verificarDuplicados();
      if (!ok) return;
    }

    try {
      setGuardando(true);
      const payload = { ...form, confirmarDuplicado: forzar };
      if (editandoId) {
        await axios.put(`${API}/clients/${editandoId}`, payload, { headers });
        setExito('Cliente actualizado correctamente ✓');
      } else {
        await axios.post(`${API}/clients`, payload, { headers });
        setExito('Cliente creado correctamente ✓');
      }
      await cargarClientes();
      setTimeout(() => { setMostrarForm(false); setExito(''); }, 1500);
    } catch (err) {
      const msg = err.response?.data?.error || 'Error al guardar';
      if (err.response?.status === 409) {
        setAlerta({ tipo: 'nit', mensaje: msg, clienteExistente: err.response.data.clienteExistente });
      } else {
        setError(msg);
      }
    } finally {
      setGuardando(false);
    }
  };

  // ─── SUCURSALES ───────────────────────────────────────────────────────────
  const agregarSucursal = () => {
    setForm(p => ({ ...p, sucursales: [...p.sucursales, { ...SUCURSAL_VACIA }] }));
  };

  const editarSucursal = (idx, campo, valor) => {
    setForm(p => {
      const suc = [...p.sucursales];
      suc[idx] = { ...suc[idx], [campo]: campo === 'telefono' ? soloNumeros(valor) : campo === 'nombre' ? mayusculas(valor) : valor };
      return { ...p, sucursales: suc };
    });
  };

  const eliminarSucursal = (idx) => {
    setForm(p => ({ ...p, sucursales: p.sucursales.filter((_, i) => i !== idx) }));
  };

  // ─── EMAILS ADICIONALES ───────────────────────────────────────────────────
  const agregarEmail = () => {
    if (!emailNuevo || !emailNuevo.includes('@')) { setError('Email inválido'); return; }
    if (form.emailsAdicionales.includes(emailNuevo)) { setError('Ese email ya está agregado'); return; }
    setForm(p => ({ ...p, emailsAdicionales: [...p.emailsAdicionales, emailNuevo] }));
    setEmailNuevo('');
    setError('');
  };

  const eliminarEmail = (email) => {
    setForm(p => ({ ...p, emailsAdicionales: p.emailsAdicionales.filter(e => e !== email) }));
  };

  // ─── DESACTIVAR ───────────────────────────────────────────────────────────
  const desactivar = async (id, nombre) => {
    if (!window.confirm(`¿Desactivar cliente ${nombre}?`)) return;
    try {
      await axios.delete(`${API}/clients/${id}`, { headers });
      setExito(`Cliente ${nombre} desactivado`);
      await cargarClientes();
      setTimeout(() => setExito(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al desactivar');
    }
  };

  const reactivar = async (id, nombre) => {
    if (!window.confirm(`¿Reactivar cliente ${nombre}?`)) return;
    try {
      await axios.put(`${API}/clients/${id}`, { activo: true }, { headers });
      setExito(`Cliente ${nombre} reactivado ✓`);
      await cargarClientes();
      setTimeout(() => setExito(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al reactivar');
    }
  };

  const exportarClientes = async () => {
    try {
      const res = await axios.get(API + '/clients', { headers });
      const clis = Array.isArray(res.data) ? res.data : [];
      if (!clis.length) { setError('No hay clientes para exportar'); return; }
      const cols = ['nombre','nit','tipoDocumento','celular','telefono','emailLegal','direccionPrincipal','ciudad','departamento','empresaNombre','notas'];
      const nl = String.fromCharCode(10);
      const filas = clis.map(function(c) {
        return cols.map(function(k) { return '"' + String(c[k] == null ? '' : c[k]).replace(/"/g, '""') + '"'; }).join(',');
      });
      const csv = [cols.join(',')].concat(filas).join(nl);
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'clientes_' + new Date().toISOString().split('T')[0] + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      setExito(clis.length + ' clientes exportados');
      setTimeout(function() { setExito(''); }, 3000);
    } catch (err) { setError('Error al exportar clientes'); }
  };

  const leerCSVClientes = (file) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result;
      const nl = String.fromCharCode(10);
      const lineas = text.split(nl).filter(l => l.trim());
      if (lineas.length < 2) return;
      const hdrs = lineas[0].split(',').map(h => h.replace(/"/g, '').trim());
      const datos = lineas.slice(1).map(linea => {
        const vals = [];
        let inside = false, cur = '';
        for (let ch of linea + ',') {
          if (ch === '"') { inside = !inside; }
          else if (ch === ',' && !inside) { vals.push(cur.trim()); cur = ''; }
          else { cur += ch; }
        }
        const obj = {};
        hdrs.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
        return obj;
      }).filter(d => d.nombre && d.nombre.trim());
      setPrevistaImportCli(datos);
    };
    reader.readAsText(file, 'UTF-8');
  };

  const importarClientes = async () => {
    if (!previstaImportCli.length) return;
    try {
      setImportandoCli(true);
      let creados = 0, errores = [];
      for (const c of previstaImportCli) {
        try {
          await axios.post(API + '/clients', {
            nombre: (c.nombre || '').toUpperCase().trim(),
            nit: c.nit || '',
            tipoDocumento: c.tipoDocumento || 'NIT',
            celular: c.celular || '',
            telefono: c.telefono || '',
            emailLegal: c.emailLegal || '',
            direccionPrincipal: c.direccionPrincipal || '',
            ciudad: c.ciudad || '',
            departamento: c.departamento || '',
            empresaId: empresasDisponibles.find(e => e.name === c.empresaNombre)?.id || '',
            empresaNombre: c.empresaNombre || '',
            notas: c.notas || '',
            confirmarDuplicado: true
          }, { headers });
          creados++;
        } catch(e) { errores.push(c.nombre); }
      }
      setResultadoCli({ creados, errores });
      await cargarClientes();
    } finally { setImportandoCli(false); }
  };

  const empresaColor = (empresaId) => {
    if (!empresaId) return '#6b7280';
    const e = empresasDisponibles.find(x => x.id === empresaId);
    if (!e) return '#6b7280';
    const nombre = (e.name || '').toUpperCase();
    if (nombre.includes('SUR')) return '#dc2626';
    if (nombre.includes('VALLE')) return '#0284c7';
    return '#7c3aed';
  };

  const empresaLabel = (empresaId, cliente = null) => {
    if (!empresaId) return 'Sin empresa';
    const e = empresasDisponibles.find(x => x.id === empresaId);
    if (e) return e.name || empresaId;
    // Fallback: usar empresaNombre guardado en el cliente
    if (cliente && cliente.empresaNombre) return cliente.empresaNombre;
    return empresaId;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════
  const clientesMostrados = verInactivos ? clientes : clientes.filter(c => c.activo !== false);

  return (
    <div style={s.wrapper}>

      {/* ── HEADER ── */}
      <div style={s.pageHeader}>
        <div>
          <h2 style={s.pageTitle}>👥 Clientes</h2>
          <p style={s.pageSubtitle}>Base de clientes centralizada y sincronizada</p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          {isAdmin && <button onClick={exportarClientes} style={s.btnSecundario}>📤 Exportar CSV</button>}
          {isAdmin && <button onClick={() => setMostrarImportCli(true)} style={s.btnSecundario}>📥 Importar</button>}
          <button onClick={abrirNuevo} style={s.btnPrimario}>+ Nuevo Cliente</button>
        </div>
      </div>

      {/* ── ALERTAS GLOBALES ── */}
      {error && <div style={s.alertError}>{error}</div>}
      {exito && <div style={s.alertExito}>{exito}</div>}

      {/* ── FILTROS ── */}
      <div style={s.filtros}>
        <div style={s.searchWrap}>
          <span style={s.searchIcon}>🔍</span>
          <input
            style={s.searchInput}
            placeholder="Buscar por nombre, NIT o email..."
            value={buscar}
            onChange={e => setBuscar(e.target.value)}
          />
          {buscar && <button onClick={() => setBuscar('')} style={s.clearBtn}>✕</button>}
        </div>
        <select
          style={s.select}
          value={filtroEmpresa}
          onChange={e => setFiltroEmpresa(e.target.value)}
        >
          <option value="">Todas las empresas</option>
          {empresasDisponibles.map(e => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </div>

      {/* ── CONTADOR ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <p style={{ ...s.contador, margin: 0 }}>{clientesMostrados.length} cliente{clientesMostrados.length !== 1 ? 's' : ''} encontrado{clientesMostrados.length !== 1 ? 's' : ''}</p>
        {isAdmin && (
          <button onClick={() => setVerInactivos(v => !v)}
            style={{ fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: verInactivos ? '#dc2626' : '#9ca3af', fontWeight: 600 }}>
            ● {verInactivos ? 'Ocultando inactivos' : 'Ver inactivos'}
          </button>
        )}
      </div>

      {/* ── LISTA CLIENTES ── */}
      {loading ? (
        <div style={s.loadingBox}>Cargando clientes...</div>
      ) : clientesMostrados.length === 0 ? (
        <div style={s.emptyBox}>
          <p style={{ fontSize: '48px', margin: '0 0 12px' }}>👥</p>
          <p>No hay clientes aún</p>
          <button onClick={abrirNuevo} style={s.btnPrimario}>+ Crear primer cliente</button>
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.tabla}>
            <thead>
              <tr style={s.theadRow}>
                {['NIT', 'Nombre', 'Teléfono', 'Dirección', 'Empresa', 'Acciones'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clientesMostrados.map((c, i) => (
                <tr key={c.id}
                  onClick={() => setVerDetalle(c)}
                  style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', opacity: c.activo === false ? 0.5 : 1, cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f0f4ff'}
                  onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#f9fafb'}
                >
                  <td style={s.td}><code style={{ fontSize: 13, color: '#6b7280', fontFamily: 'monospace' }}>{c.nit || '—'}</code></td>
                  <td style={s.td}>
                    <strong style={{ color: '#111', fontSize: 14 }}>{c.nombre}</strong>
                    {c.sucursales?.length > 0 && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: '#9ca3af' }}>{c.sucursales.length} sede{c.sucursales.length !== 1 ? 's' : ''}</span>
                    )}
                  </td>
                  <td style={s.td}>{c.celular || c.telefono || '—'}</td>
                  <td style={{ ...s.td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.direccionPrincipal || '—'}
                    {c.ciudad && <span style={{ color: '#9ca3af', fontSize: 12 }}> · {c.ciudad}</span>}
                  </td>
                  <td style={s.td}>
                    <span style={{ background: empresaColor(c.empresaId), color: '#fff', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {empresaLabel(c.empresaId, c)}
                    </span>
                  </td>
                  <td style={s.td} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => abrirEditar(c)} style={s.btnEditar}>✏️</button>
                      {c.activo !== false && isAdmin && (
                        <button onClick={() => desactivar(c.id, c.nombre)} style={s.btnDesactivar}>🚫</button>
                      )}
                      {c.activo === false && isAdmin && (
                        <button onClick={() => reactivar(c.id, c.nombre)} style={s.btnActivar}>✅</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MODAL DETALLE
      ══════════════════════════════════════════════════════════════════════ */}
      {verDetalle && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalHeader}>
              <h3 style={s.modalTitulo}>👥 {verDetalle.nombre}</h3>
              <button onClick={() => setVerDetalle(null)} style={s.btnCerrar}>✕</button>
            </div>
            <div style={s.modalBody}>
              <div style={s.detalleGrid}>
                <div style={s.detalleItem}><span style={s.detalleLabel}>NIT</span><span>{verDetalle.nit || '—'}</span></div>
                <div style={s.detalleItem}><span style={s.detalleLabel}>Empresa</span><span>{empresaLabel(verDetalle.empresaId, verDetalle)}</span></div>
                <div style={s.detalleItem}><span style={s.detalleLabel}>Celular</span><span>{verDetalle.celular || '—'}</span></div>
                <div style={s.detalleItem}><span style={s.detalleLabel}>Teléfono</span><span>{verDetalle.telefono || '—'}</span></div>
                <div style={s.detalleItem}><span style={s.detalleLabel}>Email facturación</span><span>{verDetalle.emailLegal || '—'}</span></div>
                <div style={s.detalleItem}><span style={s.detalleLabel}>Ciudad</span><span>{verDetalle.ciudad || '—'}</span></div>
                <div style={s.detalleItem}><span style={s.detalleLabel}>Dirección principal</span><span>{verDetalle.direccionPrincipal || '—'}</span></div>
              </div>

              {verDetalle.emailsAdicionales?.length > 0 && (
                <div style={s.seccion}>
                  <p style={s.seccionTitulo}>📨 Emails para copias</p>
                  {verDetalle.emailsAdicionales.map((e, i) => (
                    <span key={i} style={s.emailChip}>{e}</span>
                  ))}
                </div>
              )}

              {verDetalle.sucursales?.length > 0 && (
                <div style={s.seccion}>
                  <p style={s.seccionTitulo}>🏢 Sucursales</p>
                  {verDetalle.sucursales.map((suc, i) => (
                    <div key={i} style={s.sucursalCard}>
                      <strong>{suc.nombre}</strong>
                      <span style={s.sucursalDato}>📍 {suc.direccion} {suc.ciudad && `— ${suc.ciudad}`}</span>
                      {suc.telefono && <span style={s.sucursalDato}>📞 {suc.telefono}</span>}
                      {suc.encargado && <span style={s.sucursalDato}>👤 {suc.encargado}</span>}
                    </div>
                  ))}
                </div>
              )}

              {verDetalle.notas && (
                <div style={s.seccion}>
                  <p style={s.seccionTitulo}>📝 Notas</p>
                  <p style={s.notasTexto}>{verDetalle.notas}</p>
                </div>
              )}
            </div>
            <div style={s.modalFooter}>
              <button onClick={() => { setVerDetalle(null); abrirEditar(verDetalle); }} style={s.btnPrimario}>✏️ Editar</button>
              <button onClick={() => setVerDetalle(null)} style={s.btnCancelar}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MODAL FORMULARIO CREAR / EDITAR
      ══════════════════════════════════════════════════════════════════════ */}
      {mostrarForm && (
        <div style={s.overlay}>
          <div style={s.modal}>
            {/* Header */}
            <div style={s.modalHeader}>
              <h3 style={s.modalTitulo}>{editandoId ? '✏️ Editar Cliente' : '➕ Nuevo Cliente'}</h3>
              <button onClick={() => setMostrarForm(false)} style={s.btnCerrar}>✕</button>
            </div>

            {/* Alerta duplicado */}
            {alerta && (
              <div style={s.alertaBox}>
                <p style={{ margin: '0 0 8px', fontWeight: 700 }}>⚠️ {alerta.mensaje}</p>
                {alerta.tipo === 'nit' && alerta.clienteExistente && (
                  <div style={s.clienteExistenteBox}>
                    <strong>{alerta.clienteExistente.nombre}</strong>
                    <span> — NIT: {alerta.clienteExistente.nit}</span>
                  </div>
                )}
                {alerta.tipo === 'nombre' && alerta.similares?.map((s2, i) => (
                  <div key={i} style={s.clienteExistenteBox}>
                    <strong>{s2.nombre}</strong>{s2.nit && <span> — NIT: {s2.nit}</span>}
                  </div>
                ))}
                {alerta.tipo === 'nombre' && (
                  <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                    <button onClick={() => { setAlerta(null); guardar(true); }} style={s.btnGuardar}>Es un cliente diferente, guardar igual</button>
                    <button onClick={() => setAlerta(null)} style={s.btnCancelar}>Cancelar</button>
                  </div>
                )}
              </div>
            )}

            {error && <div style={{ ...s.alertError, margin: '0 24px' }}>{error}</div>}
            {exito && <div style={{ ...s.alertExito, margin: '0 24px' }}>{exito}</div>}

            {/* Tabs del formulario */}
            <div style={s.formTabs}>
              {[
                { key: 'datos', label: '📋 Datos' },
                { key: 'sucursales', label: `🏢 Sucursales (${form.sucursales.length})` },
                { key: 'emails', label: `📨 Emails (${form.emailsAdicionales.length})` },
                { key: 'notas', label: '📝 Notas' }
              ].map(t => (
                <button key={t.key} onClick={() => setTabForm(t.key)} style={{
                  ...s.formTab, ...(tabForm === t.key ? s.formTabActiva : {})
                }}>{t.label}</button>
              ))}
            </div>

            <div style={s.modalBody}>

              {/* ── TAB DATOS ── */}
              {tabForm === 'datos' && (
                <div style={s.formGrid}>
                  {/* Empresa — campo crítico primero */}
                  <div style={{ ...s.campo, gridColumn: '1 / -1' }}>
                    <label style={s.label}>Empresa que factura * <span style={s.hint2}>(define el membrete en cotizaciones y facturas)</span></label>
                    <div style={s.empresasBtns}>
                      {empresasDisponibles.length === 0 ? (
                        <div style={{ fontSize: 13, color: '#dc2626', padding: '8px 0' }}>
                          ⚠️ No se pudieron cargar las empresas. Recarga la página.
                        </div>
                      ) : empresasDisponibles.map(e => (
                        <button key={e.id} type="button"
                          onClick={() => setForm(p => ({ ...p, empresaId: e.id, empresaNombre: e.name }))}
                          style={{
                            ...s.empresaBtn,
                            background: form.empresaId === e.id ? '#7c3aed' : '#f3f4f6',
                            color: form.empresaId === e.id ? '#fff' : '#374151',
                            border: form.empresaId === e.id ? '2px solid #7c3aed' : '2px solid transparent'
                          }}
                        >
                          🏢 {e.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Nombre */}
                  <div style={{ ...s.campo, gridColumn: '1 / -1' }}>
                    <label style={s.label}>Nombre / Razón social *</label>
                    <input style={s.input} placeholder="NOMBRE EN MAYÚSCULAS AUTOMÁTICO"
                      value={form.nombre}
                      onChange={e => setForm(p => ({ ...p, nombre: mayusculas(e.target.value) }))}
                    />
                  </div>

                  {/* Tipo doc + NIT */}
                  <div style={s.campo}>
                    <label style={s.label}>Tipo documento</label>
                    <select style={s.input} value={form.tipoDocumento}
                      onChange={e => setForm(p => ({ ...p, tipoDocumento: e.target.value }))}>
                      <option value="NIT">NIT</option>
                      <option value="CC">Cédula</option>
                      <option value="CE">Cédula Extranjería</option>
                      <option value="PAS">Pasaporte</option>
                    </select>
                  </div>
                  <div style={s.campo}>
                    <label style={s.label}>Número documento</label>
                    <input style={s.input} placeholder="Solo números"
                      value={form.nit}
                      onChange={e => setForm(p => ({ ...p, nit: soloNumeros(e.target.value) }))}
                    />
                  </div>

                  {/* Teléfono + Celular */}
                  <div style={s.campo}>
                    <label style={s.label}>Teléfono</label>
                    <input style={s.input} placeholder="Solo números"
                      value={form.telefono}
                      onChange={e => setForm(p => ({ ...p, telefono: soloNumeros(e.target.value) }))}
                    />
                  </div>
                  <div style={s.campo}>
                    <label style={s.label}>Celular (10 dígitos)</label>
                    <input style={s.input} placeholder="3001234567" maxLength={10}
                      value={form.celular}
                      onChange={e => setForm(p => ({ ...p, celular: soloNumeros(e.target.value) }))}
                    />
                  </div>

                  {/* Email legal */}
                  <div style={{ ...s.campo, gridColumn: '1 / -1' }}>
                    <label style={s.label}>Email legal (facturación)</label>
                    <input style={s.input} type="email" placeholder="facturacion@empresa.com"
                      value={form.emailLegal}
                      onChange={e => setForm(p => ({ ...p, emailLegal: e.target.value }))}
                    />
                  </div>

                  {/* Dirección principal */}
                  <div style={{ ...s.campo, gridColumn: '1 / -1' }}>
                    <label style={s.label}>Dirección principal (sede administrativa / facturación)</label>
                    <input style={s.input} placeholder="Calle 10 #25-30"
                      value={form.direccionPrincipal}
                      onChange={e => setForm(p => ({ ...p, direccionPrincipal: e.target.value }))}
                    />
                  </div>

                  {/* Ciudad + Departamento */}
                  <div style={s.campo}>
                    <label style={s.label}>Ciudad</label>
                    <input style={s.input} placeholder="Cali"
                      value={form.ciudad}
                      onChange={e => setForm(p => ({ ...p, ciudad: e.target.value }))}
                    />
                  </div>
                  <div style={s.campo}>
                    <label style={s.label}>Departamento</label>
                    <input style={s.input} placeholder="Valle del Cauca"
                      value={form.departamento}
                      onChange={e => setForm(p => ({ ...p, departamento: e.target.value }))}
                    />
                  </div>
                </div>
              )}

              {/* ── TAB SUCURSALES ── */}
              {tabForm === 'sucursales' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <p style={{ margin: 0, color: '#6b7280', fontSize: '13px' }}>
                      Cada sucursal es una sede física donde se realiza el trabajo
                    </p>
                    <button onClick={agregarSucursal} style={s.btnSecundario}>+ Agregar sucursal</button>
                  </div>

                  {form.sucursales.length === 0 ? (
                    <div style={s.emptySeccion}>
                      <p>🏢</p>
                      <p>No hay sucursales. Agrégalas si el cliente tiene varias sedes.</p>
                    </div>
                  ) : (
                    form.sucursales.map((suc, idx) => (
                      <div key={idx} style={s.sucursalForm}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                          <strong style={{ color: '#7c3aed' }}>Sucursal {idx + 1}</strong>
                          <button onClick={() => eliminarSucursal(idx)} style={s.btnEliminar}>🗑️ Eliminar</button>
                        </div>
                        <div style={s.formGrid}>
                          <div style={{ ...s.campo, gridColumn: '1 / -1' }}>
                            <label style={s.label}>Nombre sucursal</label>
                            <input style={s.input} placeholder="SEDE NORTE"
                              value={suc.nombre}
                              onChange={e => editarSucursal(idx, 'nombre', e.target.value)}
                            />
                          </div>
                          <div style={{ ...s.campo, gridColumn: '1 / -1' }}>
                            <label style={s.label}>Dirección</label>
                            <input style={s.input} placeholder="Cra 5 #20-10"
                              value={suc.direccion}
                              onChange={e => editarSucursal(idx, 'direccion', e.target.value)}
                            />
                          </div>
                          <div style={s.campo}>
                            <label style={s.label}>Ciudad</label>
                            <input style={s.input} placeholder="Palmira"
                              value={suc.ciudad}
                              onChange={e => editarSucursal(idx, 'ciudad', e.target.value)}
                            />
                          </div>
                          <div style={s.campo}>
                            <label style={s.label}>Teléfono</label>
                            <input style={s.input} placeholder="Solo números"
                              value={suc.telefono}
                              onChange={e => editarSucursal(idx, 'telefono', e.target.value)}
                            />
                          </div>
                          <div style={{ ...s.campo, gridColumn: '1 / -1' }}>
                            <label style={s.label}>Encargado</label>
                            <input style={s.input} placeholder="Nombre del responsable en esta sede"
                              value={suc.encargado}
                              onChange={e => editarSucursal(idx, 'encargado', e.target.value)}
                            />
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* ── TAB EMAILS ── */}
              {tabForm === 'emails' && (
                <div>
                  <p style={{ color: '#6b7280', fontSize: '13px', marginBottom: '16px' }}>
                    Agrega los correos adicionales donde el cliente quiere recibir copias de facturas y cotizaciones.
                  </p>
                  <div style={s.emailAdd}>
                    <input style={{ ...s.input, flex: 1 }} type="email"
                      placeholder="correo@cliente.com"
                      value={emailNuevo}
                      onChange={e => setEmailNuevo(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && agregarEmail()}
                    />
                    <button onClick={agregarEmail} style={s.btnSecundario}>+ Agregar</button>
                  </div>
                  <div style={s.emailLista}>
                    {form.emailsAdicionales.length === 0 ? (
                      <div style={s.emptySeccion}><p>📨</p><p>No hay emails adicionales</p></div>
                    ) : (
                      form.emailsAdicionales.map((email, i) => (
                        <div key={i} style={s.emailItem}>
                          <span>📧 {email}</span>
                          <button onClick={() => eliminarEmail(email)} style={s.btnEliminar}>✕</button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* ── TAB NOTAS ── */}
              {tabForm === 'notas' && (
                <div style={s.campo}>
                  <label style={s.label}>Notas del cliente</label>
                  <textarea
                    style={{ ...s.input, height: '180px', resize: 'vertical', fontFamily: 'inherit' }}
                    placeholder="Observaciones, condiciones especiales, contactos adicionales, historial relevante..."
                    value={form.notas}
                    onChange={e => setForm(p => ({ ...p, notas: e.target.value }))}
                  />
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={s.modalFooter}>
              <button onClick={() => setMostrarForm(false)} style={s.btnCancelar}>Cancelar</button>
              <button onClick={() => guardar(false)} disabled={guardando} style={s.btnGuardar}>
                {guardando ? 'Guardando...' : editandoId ? '💾 Guardar cambios' : '✅ Crear cliente'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* MODAL IMPORTAR CLIENTES */}
      {mostrarImportCli && (
        <div style={s.overlay}>
          <div style={{ ...s.modal, maxWidth: '700px' }}>
            <div style={s.modalHeader}>
              <h3 style={s.modalTitulo}>📥 Importar Clientes desde CSV</h3>
              <button onClick={() => { setMostrarImportCli(false); setPrevistaImportCli([]); setResultadoCli(null); }} style={s.btnCerrar}>✕</button>
            </div>
            <div style={s.modalBody}>
              {/* Descargar plantilla */}
              <div style={{ background: '#ede9fe', borderRadius: '10px', padding: '16px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ color: '#7c3aed' }}>Paso 1 — Descarga la plantilla Excel</strong>
                  <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#6b7280' }}>Llena la hoja "MIS CLIENTES" y guarda como CSV UTF-8</p>
                </div>
                <a href="/plantilla_clientes.xlsx" download="plantilla_clientes_control360.xlsx" style={{ padding: '10px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', borderRadius: '8px', textDecoration: 'none', fontWeight: 700, fontSize: '13px' }}>
                  ⬇️ Descargar plantilla
                </a>
              </div>

              {/* Subir CSV */}
              {!resultadoCli && (
                <div style={{ background: '#f9fafb', border: '2px dashed #e5e7eb', borderRadius: '10px', padding: '24px', textAlign: 'center', marginBottom: '16px' }}>
                  <p style={{ margin: '0 0 12px', fontWeight: 700, color: '#374151' }}>Paso 2 — Sube tu archivo CSV</p>
                  <input type="file" accept=".csv,.txt" id="fileImportCli" style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files && e.target.files[0]; if (f) leerCSVClientes(f); e.target.value = ''; }} />
                  <label htmlFor="fileImportCli" style={{ padding: '12px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>
                    📂 Seleccionar CSV
                  </label>
                </div>
              )}

              {/* Vista previa */}
              {previstaImportCli.length > 0 && !resultadoCli && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <strong>{previstaImportCli.length} clientes listos para importar</strong>
                    <button onClick={importarClientes} disabled={importandoCli} style={{ padding: '10px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>
                      {importandoCli ? 'Importando...' : 'Importar ' + previstaImportCli.length + ' clientes'}
                    </button>
                  </div>
                  <div style={{ maxHeight: '250px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead><tr style={{ background: '#f9fafb' }}>
                        {['Nombre','NIT','Celular','Ciudad','Empresa'].map(h => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: '11px', textTransform: 'uppercase' }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {previstaImportCli.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                            <td style={{ padding: '8px 12px', fontWeight: 600 }}>{c.nombre}</td>
                            <td style={{ padding: '8px 12px' }}>{c.nit}</td>
                            <td style={{ padding: '8px 12px' }}>{c.celular}</td>
                            <td style={{ padding: '8px 12px' }}>{c.ciudad}</td>
                            <td style={{ padding: '8px 12px', fontSize: '11px', color: '#7c3aed' }}>{c.empresaNombre}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Resultado */}
              {resultadoCli && (
                <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '10px', padding: '20px' }}>
                  <h4 style={{ margin: '0 0 12px', color: '#16a34a' }}>✅ Importación completada</h4>
                  <div style={{ fontSize: '14px' }}>
                    <strong style={{ fontSize: '28px', color: '#16a34a' }}>{resultadoCli.creados}</strong> clientes creados
                    {resultadoCli.errores?.length > 0 && (
                      <span style={{ marginLeft: '16px', color: '#dc2626' }}> | {resultadoCli.errores.length} con errores (duplicados)</span>
                    )}
                  </div>
                  <button onClick={() => { setMostrarImportCli(false); setPrevistaImportCli([]); setResultadoCli(null); }} style={{ marginTop: '16px', padding: '10px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700 }}>
                    Ver lista de clientes
                  </button>
                </div>
              )}
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
  btnSecundario:{ padding: '10px 18px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnEliminar:  { padding: '6px 12px', background: '#fef2f2', color: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' },

  alertError:   { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px' },
  alertExito:   { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px' },
  alertaBox:    { background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', padding: '16px 24px', margin: '0 0 0 0', fontSize: '14px' },
  clienteExistenteBox: { background: '#fff', border: '1px solid #e5e7eb', padding: '8px 12px', borderRadius: '6px', marginTop: '6px', fontSize: '13px' },

  filtros:      { display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' },
  searchWrap:   { display: 'flex', alignItems: 'center', flex: 1, minWidth: '280px', background: '#fff', border: '2px solid #e5e7eb', borderRadius: '8px', padding: '0 12px' },
  searchIcon:   { fontSize: '16px', marginRight: '8px' },
  searchInput:  { flex: 1, border: 'none', outline: 'none', fontSize: '14px', padding: '10px 0', background: 'transparent' },
  clearBtn:     { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '16px' },
  select:       { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', outline: 'none', background: '#fff', cursor: 'pointer' },
  contador:     { color: '#9ca3af', fontSize: '13px', marginBottom: '16px' },

  loadingBox:   { textAlign: 'center', padding: '60px', color: '#9ca3af' },
  emptyBox:     { textAlign: 'center', padding: '60px', color: '#9ca3af', background: '#fff', borderRadius: '12px' },
  emptySeccion: { textAlign: 'center', padding: '40px', color: '#9ca3af', background: '#f9fafb', borderRadius: '8px', fontSize: '14px' },

  tableWrap:    { background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.07)', overflow: 'hidden' },
  tabla:        { width: '100%', borderCollapse: 'collapse' },
  theadRow:     { background: '#f8fafc', borderBottom: '2px solid #e5e7eb' },
  th:           { padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' },
  td:           { padding: '12px 16px', fontSize: 14, color: '#374151', borderBottom: '1px solid #f3f4f6' },

  grid:         { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' },
  card:         { background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', overflow: 'hidden' },
  cardTop:      { padding: '16px 20px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', borderBottom: '1px solid #f3f4f6' },
  cardNombreWrap: { flex: 1 },
  cardNombre:   { margin: '0 0 4px', fontSize: '15px', fontWeight: 700, color: '#111' },
  cardNit:      { fontSize: '12px', color: '#9ca3af', fontFamily: 'monospace' },
  empresaBadge: { padding: '4px 10px', borderRadius: '20px', color: '#fff', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 },
  cardDatos:    { padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: '6px' },
  dato:         { display: 'flex', gap: '8px', fontSize: '13px', color: '#374151', alignItems: 'flex-start' },
  emailText:    { wordBreak: 'break-all', fontSize: '12px' },
  notasPreview: { margin: '0 20px 12px', padding: '8px 12px', background: '#f9fafb', borderRadius: '6px', fontSize: '12px', color: '#6b7280', fontStyle: 'italic' },
  cardAcciones: { padding: '12px 20px', display: 'flex', gap: '8px', borderTop: '1px solid #f3f4f6' },
  btnVer:       { flex: 1, padding: '8px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' },
  btnEditar:    { flex: 1, padding: '8px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '12px' },
  btnDesactivar:{ padding: '8px 12px', background: '#fef2f2', color: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' },
  btnActivar:   { padding: '8px 12px', background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 700 },

  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' },
  modal:        { background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '780px', maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  modalHeader:  { padding: '20px 24px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 },
  modalTitulo:  { margin: 0, fontSize: '18px', fontWeight: 700, color: '#111' },
  btnCerrar:    { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', fontSize: '16px', color: '#6b7280' },
  modalBody:    { padding: '20px 24px', overflow: 'auto', flex: 1 },
  modalFooter:  { padding: '14px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: '12px', flexShrink: 0 },

  formTabs:     { display: 'flex', borderBottom: '2px solid #f3f4f6', padding: '0 24px', flexShrink: 0 },
  formTab:      { padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#9ca3af', borderBottom: '2px solid transparent', marginBottom: '-2px' },
  formTabActiva:{ color: '#7c3aed', borderBottom: '2px solid #7c3aed' },

  formGrid:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  campo:        { display: 'flex', flexDirection: 'column', gap: '6px' },
  label:        { fontSize: '13px', fontWeight: 700, color: '#374151' },
  hint2:        { fontSize: '11px', color: '#9ca3af', fontWeight: 400 },
  input:        { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', outline: 'none', width: '100%', boxSizing: 'border-box' },

  empresasBtns: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  empresaBtn:   { padding: '12px 20px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: 600, transition: 'all 0.15s' },

  sucursalForm: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px', marginBottom: '12px' },

  emailAdd:     { display: 'flex', gap: '10px', marginBottom: '16px' },
  emailLista:   { display: 'flex', flexDirection: 'column', gap: '8px' },
  emailItem:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f9fafb', padding: '10px 14px', borderRadius: '8px', fontSize: '13px' },
  emailChip:    { display: 'inline-block', background: '#ede9fe', color: '#7c3aed', padding: '4px 12px', borderRadius: '20px', fontSize: '12px', margin: '4px' },

  detalleGrid:  { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' },
  detalleItem:  { display: 'flex', flexDirection: 'column', gap: '4px' },
  detalleLabel: { fontSize: '11px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' },
  seccion:      { marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #f3f4f6' },
  seccionTitulo:{ margin: '0 0 10px', fontWeight: 700, color: '#374151', fontSize: '14px' },
  sucursalCard: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' },
  sucursalDato: { color: '#6b7280', fontSize: '12px' },
  notasTexto:   { background: '#f9fafb', padding: '12px', borderRadius: '8px', fontSize: '13px', color: '#374151', lineHeight: '1.6', margin: 0 },

  btnCancelar:  { padding: '10px 24px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 },
  btnGuardar:   { padding: '10px 28px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' },
};

export default GestionClientes;
