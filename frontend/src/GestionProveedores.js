import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

const FORM_VACIO = { nombre: '', nit: '', telefono: '', email: '', direccion: '', notas: '' };

const GestionProveedores = ({ user }) => {
  const [proveedores, setProveedores] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [buscar, setBuscar]           = useState('');
  const [modal, setModal]             = useState(false);
  const [editando, setEditando]       = useState(null);
  const [form, setForm]               = useState(FORM_VACIO);
  const [guardando, setGuardando]     = useState(false);
  const [error, setError]             = useState('');
  const [exito, setExito]             = useState('');
  const [verInactivos, setVerInactivos] = useState(false);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };
  const isAdmin = user?.role === 'admin';

  const cargar = useCallback(async () => {
    try {
      setLoading(true);
      const res = await axios.get(`${API}/proveedores`, { headers });
      setProveedores(Array.isArray(res.data) ? res.data : []);
    } catch { setProveedores([]); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { cargar(); }, [cargar]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const abrirNuevo = () => { setEditando(null); setForm(FORM_VACIO); setError(''); setModal(true); };
  const abrirEditar = (p) => { setEditando(p.id); setForm({ nombre: p.nombre || '', nit: p.nit || '', telefono: p.telefono || '', email: p.email || '', direccion: p.direccion || '', notas: p.notas || '' }); setError(''); setModal(true); };

  const guardar = async () => {
    if (!form.nombre.trim()) return setError('Nombre requerido');
    setGuardando(true); setError('');
    try {
      if (editando) {
        await axios.put(`${API}/proveedores/${editando}`, form, { headers });
      } else {
        await axios.post(`${API}/proveedores`, form, { headers });
      }
      await cargar();
      setModal(false);
      setExito(editando ? 'Proveedor actualizado ✓' : 'Proveedor creado ✓');
      setTimeout(() => setExito(''), 3000);
    } catch (e) { setError(e.response?.data?.error || 'Error al guardar'); }
    setGuardando(false);
  };

  const desactivar = async (id, nombre) => {
    if (!window.confirm(`¿Desactivar a ${nombre}?`)) return;
    await axios.delete(`${API}/proveedores/${id}`, { headers });
    await cargar();
  };

  const exportarCSV = () => {
    const cols = ['Nombre', 'NIT', 'Teléfono', 'Email', 'Dirección'];
    const rows = proveedoresMostrados.map(p => [p.nombre, p.nit, p.telefono, p.email, p.direccion].join(';'));
    const csv = [cols.join(';'), ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `proveedores_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  };

  const proveedoresMostrados = (verInactivos ? proveedores : proveedores.filter(p => p.activo !== false))
    .filter(p => !buscar || p.nombre?.toLowerCase().includes(buscar.toLowerCase()) || p.nit?.includes(buscar));

  return (
    <div style={s.wrapper}>
      {/* HEADER */}
      <div style={s.header}>
        <div>
          <h2 style={s.titulo}>🏭 Proveedores</h2>
          <p style={s.subtitulo}>Base de proveedores centralizada</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={exportarCSV} style={s.btnSec}>📥 Exportar CSV</button>
          <button onClick={abrirNuevo} style={s.btnPri}>+ Nuevo Proveedor</button>
        </div>
      </div>

      {exito && <div style={s.alertOk}>{exito}</div>}

      {/* FILTROS */}
      <div style={s.filtros}>
        <div style={s.searchWrap}>
          <span>🔍</span>
          <input style={s.searchInput} placeholder="Buscar por nombre o NIT..."
            value={buscar} onChange={e => setBuscar(e.target.value)} />
          {buscar && <button onClick={() => setBuscar('')} style={s.clearBtn}>✕</button>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: 1 }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{proveedoresMostrados.length} proveedor{proveedoresMostrados.length !== 1 ? 'es' : ''}</span>
          {isAdmin && <button onClick={() => setVerInactivos(v => !v)} style={{ fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: verInactivos ? '#dc2626' : '#9ca3af', fontWeight: 600 }}>
            ● {verInactivos ? 'Ocultando inactivos' : 'Ver inactivos'}
          </button>}
        </div>
      </div>

      {/* TABLA */}
      {loading ? <div style={s.loading}>Cargando proveedores...</div> :
       proveedoresMostrados.length === 0 ? (
        <div style={s.empty}>
          <p style={{ fontSize: 48, margin: '0 0 12px' }}>🏭</p>
          <p>No hay proveedores aún</p>
          <button onClick={abrirNuevo} style={s.btnPri}>+ Crear primer proveedor</button>
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.tabla}>
            <thead>
              <tr style={s.theadRow}>
                {['Nombre', 'NIT', 'Teléfono', 'Email', 'Dirección', 'Acciones'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {proveedoresMostrados.map((p, i) => (
                <tr key={p.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', opacity: p.activo === false ? 0.5 : 1 }}>
                  <td style={s.td}><strong style={{ fontSize: 14, color: '#111' }}>{p.nombre}</strong></td>
                  <td style={s.td}><code style={{ fontSize: 12, color: '#6b7280' }}>{p.nit || '—'}</code></td>
                  <td style={s.td}>{p.telefono || '—'}</td>
                  <td style={s.td}>{p.email || '—'}</td>
                  <td style={{ ...s.td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.direccion || '—'}</td>
                  <td style={s.td}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => abrirEditar(p)} style={s.btnEditar}>✏️</button>
                      {isAdmin && p.activo !== false && <button onClick={() => desactivar(p.id, p.nombre)} style={s.btnDes}>🚫</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* MODAL */}
      {modal && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalHeader}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{editando ? '✏️ Editar Proveedor' : '+ Nuevo Proveedor'}</h3>
              <button onClick={() => setModal(false)} style={s.btnCerrar}>✕</button>
            </div>
            <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {error && <div style={s.alertError}>{error}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={s.campo}>
                  <label style={s.label}>Nombre / Razón social *</label>
                  <input style={s.input} placeholder="NOMBRE EN MAYÚSCULAS" value={form.nombre}
                    onChange={e => set('nombre', e.target.value.toUpperCase())} />
                </div>
                <div style={s.campo}>
                  <label style={s.label}>NIT / Cédula</label>
                  <input style={s.input} placeholder="Solo números" value={form.nit}
                    onChange={e => set('nit', e.target.value.replace(/\D/g, ''))} />
                </div>
                <div style={s.campo}>
                  <label style={s.label}>Teléfono</label>
                  <input style={s.input} placeholder="Solo números" value={form.telefono}
                    onChange={e => set('telefono', e.target.value.replace(/\D/g, ''))} />
                </div>
                <div style={s.campo}>
                  <label style={s.label}>Email</label>
                  <input type="email" style={s.input} placeholder="correo@proveedor.com" value={form.email}
                    onChange={e => set('email', e.target.value)} />
                </div>
              </div>
              <div style={s.campo}>
                <label style={s.label}>Dirección</label>
                <input style={s.input} placeholder="Calle 123 # 45-67" value={form.direccion}
                  onChange={e => set('direccion', e.target.value)} />
              </div>
              <div style={s.campo}>
                <label style={s.label}>Notas</label>
                <textarea style={{ ...s.input, height: 60, resize: 'vertical', fontFamily: 'inherit' }}
                  placeholder="Observaciones..." value={form.notas}
                  onChange={e => set('notas', e.target.value)} />
              </div>
            </div>
            <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setModal(false)} style={s.btnCancelar}>Cancelar</button>
              <button onClick={guardar} disabled={guardando} style={s.btnPri}>
                {guardando ? 'Guardando...' : editando ? '💾 Guardar cambios' : '✅ Crear proveedor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const s = {
  wrapper:    { padding: '32px', maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  titulo:     { margin: 0, fontSize: 26, fontWeight: 700, color: '#111' },
  subtitulo:  { margin: '4px 0 0', color: '#6b7280', fontSize: 14 },
  filtros:    { display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' },
  searchWrap: { display: 'flex', alignItems: 'center', background: '#fff', border: '2px solid #e5e7eb', borderRadius: 8, padding: '0 12px', flex: 1, maxWidth: 360 },
  searchInput:{ flex: 1, border: 'none', outline: 'none', fontSize: 14, padding: '10px 8px', background: 'transparent' },
  clearBtn:   { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' },
  loading:    { textAlign: 'center', padding: 60, color: '#9ca3af' },
  empty:      { textAlign: 'center', padding: 60, color: '#9ca3af', background: '#fff', borderRadius: 12 },
  tableWrap:  { background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.07)', overflow: 'hidden' },
  tabla:      { width: '100%', borderCollapse: 'collapse' },
  theadRow:   { background: '#f8fafc', borderBottom: '2px solid #e5e7eb' },
  th:         { padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' },
  td:         { padding: '12px 16px', fontSize: 14, color: '#374151', borderBottom: '1px solid #f3f4f6' },
  btnPri:     { padding: '10px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 },
  btnSec:     { padding: '10px 18px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  btnEditar:  { padding: '5px 12px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 },
  btnDes:     { padding: '5px 10px', background: '#fef2f2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  alertOk:    { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  alertError: { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13 },
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal:      { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  modalHeader:{ padding: '20px 24px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  btnCerrar:  { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16, color: '#6b7280' },
  btnCancelar:{ padding: '10px 22px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },
  campo:      { display: 'flex', flexDirection: 'column', gap: 6 },
  label:      { fontSize: 13, fontWeight: 700, color: '#374151' },
  input:      { padding: '9px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', color: '#111', background: '#fff' },
};

export default GestionProveedores;

