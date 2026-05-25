import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const CLOUDINARY_CLOUD = 'dk8hposft';
const CLOUDINARY_PRESET = 'control360';

// ─── TIPOS ERI para categorías ────────────────────────────────────────────────
const TIPOS_ERI = [
  { value: 'costo_operativo', label: 'Costo operativo' },
  { value: 'gasto_operativo', label: 'Gasto operativo' },
  { value: 'gasto_fijo',      label: 'Gasto fijo' },
  { value: 'gasto_personal',  label: 'Gasto personal' },
  { value: 'gasto_fiscal',    label: 'Gasto fiscal' },
];

const TIPOS_CAJA = ['Efectivo', 'Banco', 'Nequi/Daviplata', 'Datafono', 'Mensajero', 'Otro'];

// ════════════════════════════════════════════════════════════════════════════════
// PESTAÑA 1: EMPRESAS (código original intacto, solo extraído como componente)
// ════════════════════════════════════════════════════════════════════════════════
const TabEmpresas = ({ token }) => {
  const [empresas, setEmpresas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [editando, setEditando] = useState(null);
  const [logoPreview, setLogoPreview] = useState(null);
  const [logoFile, setLogoFile] = useState(null);
  const [mensaje, setMensaje] = useState(null);
  const fileInputRef = useRef();
  const [formData, setFormData] = useState({ name: '', nit: '', address: '', phone: '', cellphone: '', email: '', iva: '', pinAutorizacion: '' });
  const [errores, setErrores] = useState({});

  useEffect(() => { cargarEmpresas(); }, []);

  const cargarEmpresas = async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/companies`, { headers: { Authorization: `Bearer ${token}` } });
      setEmpresas(r.data || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const mostrarMensaje = (texto, tipo = 'success') => {
    setMensaje({ texto, tipo });
    setTimeout(() => setMensaje(null), 3500);
  };

  const handleLogo = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) return mostrarMensaje('Solo PNG o JPG', 'error');
    if (file.size > 2 * 1024 * 1024) return mostrarMensaje('Máximo 2MB', 'error');
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  };

  const subirLogoCloudinary = async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', CLOUDINARY_PRESET);
    fd.append('folder', 'control360/logos');
    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`, { method: 'POST', body: fd });
    const data = await r.json();
    if (!data.secure_url) throw new Error('Error subiendo imagen');
    return data.secure_url;
  };

  const validar = () => {
    const e = {};
    if (!formData.name.trim()) e.name = 'Nombre requerido';
    if (!/^\d{8,}$/.test(formData.nit)) e.nit = 'Mínimo 8 dígitos numéricos';
    if (!formData.address.trim()) e.address = 'Dirección requerida';
    if (!/^\d{7,}$/.test(formData.phone)) e.phone = 'Mínimo 7 dígitos';
    if (!/^\d{10}$/.test(formData.cellphone)) e.cellphone = 'Exactamente 10 dígitos';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) e.email = 'Email inválido';
    const iva = parseInt(formData.iva);
    if (isNaN(iva) || iva < 0 || iva > 100) e.iva = 'Número entre 0 y 100';
    setErrores(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validar()) return;
    setGuardando(true);
    try {
      let logoUrl = logoPreview?.startsWith('http') ? logoPreview : '';
      if (logoFile) { mostrarMensaje('⏳ Subiendo logo...'); logoUrl = await subirLogoCloudinary(logoFile); }
      const payload = { ...formData, iva: parseInt(formData.iva), logo: logoUrl };
      const h = { Authorization: `Bearer ${token}` };
      if (editando) {
        await axios.put(`${API}/companies/${editando}`, payload, { headers: h });
        mostrarMensaje('✅ Empresa actualizada');
      } else {
        await axios.post(`${API}/companies`, payload, { headers: h });
        mostrarMensaje('✅ Empresa creada');
      }
      resetForm(); cargarEmpresas();
    } catch (err) {
      mostrarMensaje(`❌ ${err.response?.data?.error || err.message}`, 'error');
    }
    setGuardando(false);
  };

  const handleEditar = (emp) => {
    setEditando(emp.id);
    setFormData({ name: emp.name || '', nit: emp.nit || '', address: emp.address || '', phone: emp.phone || '', cellphone: emp.cellphone || '', email: emp.email || '', iva: emp.iva?.toString() || '', pinAutorizacion: emp.pinAutorizacion || '' });
    setLogoPreview(emp.logo || null); setLogoFile(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleEliminar = async (id) => {
    if (!window.confirm('¿Eliminar esta empresa?')) return;
    try {
      await axios.delete(`${API}/companies/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      mostrarMensaje('Empresa eliminada'); cargarEmpresas();
    } catch { mostrarMensaje('Error al eliminar', 'error'); }
  };

  const resetForm = () => { setFormData({ name: '', nit: '', address: '', phone: '', cellphone: '', email: '', iva: '', pinAutorizacion: '' }); setEditando(null); setLogoPreview(null); setLogoFile(null); setErrores({}); };

  const campo = (label, key, tipo = 'text', placeholder = '') => (
    <div style={S.campo}>
      <label style={S.label}>{label} *</label>
      <input type={tipo} value={formData[key]} placeholder={placeholder}
        onChange={(e) => { let val = e.target.value; if (['nit','phone','cellphone','iva'].includes(key)) val = val.replace(/\D/g,''); setFormData({...formData,[key]:val}); if(errores[key]) setErrores({...errores,[key]:null}); }}
        style={{ ...S.input, ...(errores[key] ? { borderColor: '#dc3545' } : {}) }} />
      {errores[key] && <span style={{ color: '#dc3545', fontSize: 11, marginTop: 4 }}>{errores[key]}</span>}
    </div>
  );

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#667eea' }}>Cargando...</div>;

  return (
    <div>
      {mensaje && <div style={{ padding: '12px 18px', borderRadius: 8, border: '1px solid', marginBottom: 20, fontWeight: 600, fontSize: 14, background: mensaje.tipo === 'error' ? '#fff0f0' : '#f0fff4', borderColor: mensaje.tipo === 'error' ? '#dc3545' : '#28a745', color: mensaje.tipo === 'error' ? '#dc3545' : '#28a745' }}>{mensaje.texto}</div>}

      {(empresas.length < 2 || editando) && (
        <div style={S.card}>
          <h3 style={S.cardTitulo}>{editando ? '✏️ Editar Empresa' : '➕ Nueva Empresa'}</h3>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
              <div style={{ width: 120, height: 120, border: '2px dashed #ccc', borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', background: '#fafafa' }} onClick={() => fileInputRef.current.click()}>
                {logoPreview ? <img src={logoPreview} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}><span style={{ fontSize: 32 }}>🏢</span><span style={{ fontSize: 12, color: '#999' }}>Click para subir</span><span style={{ fontSize: 11, color: '#bbb' }}>PNG/JPG · 2MB</span></div>}
              </div>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" onChange={handleLogo} style={{ display: 'none' }} />
              {logoPreview && <button type="button" onClick={() => { setLogoPreview(null); setLogoFile(null); }} style={{ padding: '6px 12px', background: '#fff0f0', color: '#dc3545', border: '1px solid #dc3545', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Quitar logo</button>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18 }}>
              {campo('Nombre Empresa', 'name')}{campo('NIT', 'nit', 'text', '88273572')}{campo('Dirección', 'address')}{campo('Teléfono', 'phone', 'text', '6022226686')}{campo('Celular', 'cellphone', 'text', '3148361622')}{campo('Email', 'email', 'email', 'empresa@correo.com')}{campo('IVA (%)', 'iva', 'text', '19')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>PIN de autorización <span style={{ fontWeight: 400, color: '#9ca3af' }}>(4 dígitos)</span></label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input id="pinInput" type="password" maxLength={4} inputMode="numeric"
                    style={{ padding: '9px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 18, outline: 'none', letterSpacing: 8, textAlign: 'center', width: 120 }}
                    placeholder="••••"
                    value={formData.pinAutorizacion || ''}
                    onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); setFormData(f => ({ ...f, pinAutorizacion: v })); }} />
                  <button type="button" onClick={() => {
                    const input = document.getElementById('pinInput');
                    input.type = input.type === 'password' ? 'text' : 'password';
                  }} style={{ padding: '8px 14px', background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151', fontWeight: 600 }}>
                    👁️ Ver PIN
                  </button>
                </div>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>Usado para autorizar órdenes a clientes bloqueados por cartera</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
              <button type="submit" disabled={guardando} style={{ ...S.btnPrimario, opacity: guardando ? 0.7 : 1 }}>{guardando ? 'Guardando...' : editando ? '💾 Actualizar' : '✅ Crear Empresa'}</button>
              {editando && <button type="button" onClick={resetForm} style={S.btnSecundario}>Cancelar</button>}
            </div>
          </form>
        </div>
      )}

      <div style={S.card}>
        <h3 style={S.cardTitulo}>🏢 Empresas Registradas ({empresas.length}/2)</h3>
        {empresas.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}><span style={{ fontSize: 48 }}>🏗️</span><p style={{ color: '#999', marginTop: 12 }}>Aún no hay empresas</p></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
            {empresas.map(emp => (
              <div key={emp.id} style={{ background: '#f8f9ff', border: '1px solid #e8ecff', borderRadius: 10, padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                  {emp.logo ? <img src={emp.logo} alt="Logo" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 8, border: '1px solid #eee' }} /> : <div style={{ width: 56, height: 56, background: '#e8ecff', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>🏢</div>}
                  <div><h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1a1a2e' }}>{emp.name}</h4><span style={{ fontSize: 12, color: '#667eea', fontWeight: 600 }}>NIT: {emp.nit}</span></div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#555', marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontWeight: 600, color: '#888' }}>📍 Dirección</span><span>{emp.address}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontWeight: 600, color: '#888' }}>📞 Teléfono</span><span>{emp.phone}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontWeight: 600, color: '#888' }}>✉️ Email</span><span>{emp.email}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontWeight: 600, color: '#888' }}>💰 IVA</span><span>{emp.iva}%</span></div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => handleEditar(emp)} style={{ flex: 1, padding: 8, background: '#0066cc', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>✏️ Editar</button>
                  <button onClick={() => handleEliminar(emp.id)} style={{ flex: 1, padding: 8, background: '#dc3545', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>🗑️ Eliminar</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// PESTAÑA 2: FORMAS DE PAGO
// ════════════════════════════════════════════════════════════════════════════════
const TabFormasPago = ({ token, cajas }) => {
  const [formas, setFormas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState(null);
  const [nueva, setNueva] = useState({ nombre: '', tipo: 'fisico', cajaId: '', activa: true });
  const [agregando, setAgregando] = useState(false);

  useEffect(() => { cargar(); }, []);

  const cargar = async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/configuracion`, { headers: { Authorization: `Bearer ${token}` } });
      setFormas(r.data.formasPago || []);
    } catch { }
    setLoading(false);
  };

  const mostrarMsg = (texto, tipo = 'success') => { setMensaje({ texto, tipo }); setTimeout(() => setMensaje(null), 3000); };

  const guardar = async (lista) => {
    setGuardando(true);
    try {
      await axios.put(`${API}/configuracion/formas-pago`, { formasPago: lista }, { headers: { Authorization: `Bearer ${token}` } });
      setFormas(lista);
      mostrarMsg('✅ Formas de pago guardadas');
    } catch { mostrarMsg('❌ Error al guardar', 'error'); }
    setGuardando(false);
  };

  const agregarForma = () => {
    if (!nueva.nombre.trim()) return mostrarMsg('Nombre requerido', 'error');
    const lista = [...formas, { ...nueva, nombre: nueva.nombre.trim(), orden: formas.length + 1 }];
    guardar(lista);
    setNueva({ nombre: '', tipo: 'fisico', cajaId: '', activa: true });
    setAgregando(false);
  };

  const toggleActiva = (idx) => {
    const lista = formas.map((f, i) => i === idx ? { ...f, activa: !f.activa } : f);
    guardar(lista);
  };

  const actualizarCaja = (idx, cajaId) => {
    const lista = formas.map((f, i) => i === idx ? { ...f, cajaId } : f);
    guardar(lista);
  };

  const eliminar = (idx) => {
    if (!window.confirm('¿Eliminar esta forma de pago?')) return;
    guardar(formas.filter((_, i) => i !== idx));
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#667eea' }}>Cargando...</div>;

  return (
    <div>
      {mensaje && <div style={{ ...S.msg, background: mensaje.tipo === 'error' ? '#fff0f0' : '#f0fff4', borderColor: mensaje.tipo === 'error' ? '#dc3545' : '#28a745', color: mensaje.tipo === 'error' ? '#dc3545' : '#28a745' }}>{mensaje.texto}</div>}

      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#1a1a2e' }}>💳 Formas de pago</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#888' }}>Se usan en Órdenes, Egresos, Logística y Caja</p>
          </div>
          <button onClick={() => setAgregando(true)} style={S.btnPrimario}>+ Agregar</button>
        </div>

        {agregando && (
          <div style={{ background: '#f8f9ff', border: '1px solid #e8ecff', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div style={S.campo}>
                <label style={S.label}>Nombre *</label>
                <input style={S.input} value={nueva.nombre} onChange={e => setNueva(p => ({ ...p, nombre: e.target.value }))} placeholder="Ej: Nequi, Cheque..." />
              </div>
              <div style={S.campo}>
                <label style={S.label}>Tipo</label>
                <select style={S.input} value={nueva.tipo} onChange={e => setNueva(p => ({ ...p, tipo: e.target.value }))}>
                  <option value="fisico">Físico</option>
                  <option value="digital">Digital</option>
                  <option value="credito">Crédito</option>
                </select>
              </div>
              <div style={S.campo}>
                <label style={S.label}>Caja destino</label>
                <select style={S.input} value={nueva.cajaId} onChange={e => setNueva(p => ({ ...p, cajaId: e.target.value }))}>
                  <option value="">— Sin asignar —</option>
                  {cajas.filter(c => c.activa).map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={agregarForma} style={S.btnPrimario}>Agregar</button>
              <button onClick={() => setAgregando(false)} style={S.btnSecundario}>Cancelar</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {formas.map((f, idx) => {
            const cajaAsignada = cajas.find(c => c.id === f.cajaId);
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: f.activa ? '#fff' : '#f8f8f8', border: '1px solid #e2e8f0', borderRadius: 8, opacity: f.activa ? 1 : 0.6 }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{f.nombre}</span>
                  <span style={{ marginLeft: 8, fontSize: 11, background: '#f1f5f9', color: '#64748b', borderRadius: 20, padding: '2px 8px' }}>{f.tipo}</span>
                </div>
                <div style={{ flex: 1 }}>
                  <select style={{ ...S.input, fontSize: 12, padding: '6px 10px' }} value={f.cajaId || ''} onChange={e => actualizarCaja(idx, e.target.value)}>
                    <option value="">— Sin caja asignada —</option>
                    {cajas.filter(c => c.activa).map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                  {cajaAsignada && <div style={{ fontSize: 11, color: '#16a34a', marginTop: 2 }}>✅ → {cajaAsignada.nombre}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => toggleActiva(idx)} style={{ padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: f.activa ? '#fef3c7' : '#dcfce7', color: f.activa ? '#92400e' : '#166534' }}>
                    {f.activa ? 'Desactivar' : 'Activar'}
                  </button>
                  <button onClick={() => eliminar(idx)} style={{ padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: '#fee2e2', color: '#991b1b' }}>🗑️</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// PESTAÑA 3: CATEGORÍAS DE EGRESOS
// ════════════════════════════════════════════════════════════════════════════════
const TabCategorias = ({ token }) => {
  const [categorias, setCategorias] = useState([]);
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState(null);
  const [nueva, setNueva] = useState({ nombre: '', tipoERI: 'gasto_operativo', activa: true });
  const [agregando, setAgregando] = useState(false);

  useEffect(() => { cargar(); }, []);

  const cargar = async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/configuracion`, { headers: { Authorization: `Bearer ${token}` } });
      setCategorias(r.data.categoriasEgresos || []);
    } catch { }
    setLoading(false);
  };

  const mostrarMsg = (texto, tipo = 'success') => { setMensaje({ texto, tipo }); setTimeout(() => setMensaje(null), 3000); };

  const guardar = async (lista) => {
    setGuardando(true);
    try {
      await axios.put(`${API}/configuracion/categorias`, { categoriasEgresos: lista }, { headers: { Authorization: `Bearer ${token}` } });
      setCategorias(lista);
      mostrarMsg('✅ Categorías guardadas');
    } catch { mostrarMsg('❌ Error al guardar', 'error'); }
    setGuardando(false);
  };

  const agregar = () => {
    if (!nueva.nombre.trim()) return mostrarMsg('Nombre requerido', 'error');
    const lista = [...categorias, { ...nueva, nombre: nueva.nombre.trim(), orden: categorias.length + 1 }];
    guardar(lista);
    setNueva({ nombre: '', tipoERI: 'gasto_operativo', activa: true });
    setAgregando(false);
  };

  const toggleActiva = (idx) => guardar(categorias.map((c, i) => i === idx ? { ...c, activa: !c.activa } : c));
  const editarNombre = (idx, nombre) => guardar(categorias.map((c, i) => i === idx ? { ...c, nombre } : c));
  const editarTipo = (idx, tipoERI) => guardar(categorias.map((c, i) => i === idx ? { ...c, tipoERI } : c));
  const eliminar = (idx) => { if (!window.confirm('¿Eliminar categoría?')) return; guardar(categorias.filter((_, i) => i !== idx)); };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#667eea' }}>Cargando...</div>;

  return (
    <div>
      {mensaje && <div style={{ ...S.msg, background: mensaje.tipo === 'error' ? '#fff0f0' : '#f0fff4', borderColor: mensaje.tipo === 'error' ? '#dc3545' : '#28a745', color: mensaje.tipo === 'error' ? '#dc3545' : '#28a745' }}>{mensaje.texto}</div>}

      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#1a1a2e' }}>📂 Categorías de Egresos</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#888' }}>Se usan en Egresos y en el ERI futuro para agrupar gastos</p>
          </div>
          <button onClick={() => setAgregando(true)} style={S.btnPrimario}>+ Agregar</button>
        </div>

        {agregando && (
          <div style={{ background: '#f8f9ff', border: '1px solid #e8ecff', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div style={S.campo}>
                <label style={S.label}>Nombre *</label>
                <input style={S.input} value={nueva.nombre} onChange={e => setNueva(p => ({ ...p, nombre: e.target.value }))} placeholder="Ej: Empaques, Uniformes..." />
              </div>
              <div style={S.campo}>
                <label style={S.label}>Tipo ERI</label>
                <select style={S.input} value={nueva.tipoERI} onChange={e => setNueva(p => ({ ...p, tipoERI: e.target.value }))}>
                  {TIPOS_ERI.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={agregar} style={S.btnPrimario}>Agregar</button>
              <button onClick={() => setAgregando(false)} style={S.btnSecundario}>Cancelar</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {categorias.map((cat, idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: cat.activa ? '#fff' : '#f8f8f8', border: '1px solid #e2e8f0', borderRadius: 8, opacity: cat.activa ? 1 : 0.6 }}>
              <input style={{ ...S.input, flex: 1, fontSize: 13, padding: '6px 10px' }} value={cat.nombre}
                onChange={e => editarNombre(idx, e.target.value)}
                onBlur={() => guardar(categorias)} />
              <select style={{ ...S.input, fontSize: 12, padding: '6px 10px', minWidth: 160 }} value={cat.tipoERI || 'gasto_operativo'} onChange={e => editarTipo(idx, e.target.value)}>
                {TIPOS_ERI.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => toggleActiva(idx)} style={{ padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: cat.activa ? '#fef3c7' : '#dcfce7', color: cat.activa ? '#92400e' : '#166534' }}>
                  {cat.activa ? 'Desactivar' : 'Activar'}
                </button>
                <button onClick={() => eliminar(idx)} style={{ padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: '#fee2e2', color: '#991b1b' }}>🗑️</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// PESTAÑA 4: CAJAS
// ════════════════════════════════════════════════════════════════════════════════
const TabCajas = ({ token, onCajasChange, empresas = [] }) => {
  const [cajas, setCajas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editando, setEditando] = useState(null);
  const [mensaje, setMensaje] = useState(null);
  const [form, setForm] = useState({ nombre: '', tipo: 'Efectivo', saldo: 0, responsable: '', banco: '', tipoCuenta: '', numeroCuenta: '', titularCuenta: '', usarParaCobros: false, empresaId: '', notas: '', activa: true });
  const [guardando, setGuardando] = useState(false);

  useEffect(() => { cargar(); }, []);

  const getH = () => ({ Authorization: `Bearer ${token}` });
  const mostrarMsg = (texto, tipo = 'success') => { setMensaje({ texto, tipo }); setTimeout(() => setMensaje(null), 3000); };

  const cargar = async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/cajas`, { headers: getH() });
      setCajas(r.data || []);
      if (onCajasChange) onCajasChange(r.data || []);
    } catch { }
    setLoading(false);
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const abrirNueva = () => { setEditando(null); setForm({ nombre: '', tipo: 'Efectivo', saldo: 0, responsable: '', banco: '', tipoCuenta: '', numeroCuenta: '', titularCuenta: '', usarParaCobros: false, empresaId: '', notas: '', activa: true }); setModal(true); };
  const abrirEditar = (caja) => { setEditando(caja.id); setForm({ ...caja }); setModal(true); };

  const guardar = async () => {
    if (!form.nombre.trim()) return mostrarMsg('Nombre requerido', 'error');
    setGuardando(true);
    try {
      if (editando) {
        await axios.put(`${API}/cajas/${editando}`, { ...form, saldo: Number(form.saldo) }, { headers: getH() });
        mostrarMsg('✅ Caja actualizada');
      } else {
        await axios.post(`${API}/cajas`, { ...form, saldo: Number(form.saldo) }, { headers: getH() });
        mostrarMsg('✅ Caja creada');
      }
      setModal(false); cargar();
    } catch (e) { mostrarMsg(`❌ ${e.response?.data?.error || 'Error'}`, 'error'); }
    setGuardando(false);
  };

  const desactivarEliminar = async (caja) => {
    const accion = `¿${caja.activa ? 'Desactivar' : 'Eliminar'} la caja "${caja.nombre}"?`;
    if (!window.confirm(accion)) return;
    try {
      const r = await axios.delete(`${API}/cajas/${caja.id}`, { headers: getH() });
      mostrarMsg(`✅ ${r.data.mensaje}`);
      cargar();
    } catch (e) { mostrarMsg(`❌ ${e.response?.data?.error || 'Error'}`, 'error'); }
  };

  const fmt = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#667eea' }}>Cargando...</div>;

  return (
    <div>
      {mensaje && <div style={{ ...S.msg, background: mensaje.tipo === 'error' ? '#fff0f0' : '#f0fff4', borderColor: mensaje.tipo === 'error' ? '#dc3545' : '#28a745', color: mensaje.tipo === 'error' ? '#dc3545' : '#28a745' }}>{mensaje.texto}</div>}

      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#1a1a2e' }}>🏦 Cajas</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#888' }}>Efectivo, bancos, mensajeros · Se usan en Egresos y Órdenes</p>
          </div>
          <button onClick={abrirNueva} style={S.btnPrimario}>+ Nueva caja</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
          {cajas.filter(c => c.activa).map(caja => (
            <div key={caja.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '18px 20px', borderLeft: `4px solid ${caja.tipo === 'Banco' ? '#3b82f6' : caja.tipo === 'Mensajero' ? '#f59e0b' : '#22c55e'}` }}>
              <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>{caja.tipo}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#1e293b', marginBottom: 4 }}>{caja.nombre}</div>
              {caja.banco && <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{caja.banco} · {caja.tipoCuenta || ''} · {caja.numeroCuenta}</div>}
              {caja.titularCuenta && <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Titular: {caja.titularCuenta}</div>}
              {caja.usarParaCobros && <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 700, marginBottom: 4 }}>✅ Usada para cobros</div>}
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>Responsable: {caja.responsable || '—'}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => abrirEditar(caja)} style={{ flex: 1, padding: '7px', background: '#f1f5f9', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#475569' }}>✏️ Editar</button>
                <button onClick={() => desactivarEliminar(caja)} style={{ flex: 1, padding: '7px', background: '#fee2e2', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#991b1b' }}>⏸ Desactivar</button>
              </div>
            </div>
          ))}

          {/* Card nueva caja */}
          <button onClick={abrirNueva} style={{ background: '#f8fafc', border: '2px dashed #cbd5e1', borderRadius: 12, padding: 20, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#94a3b8', minHeight: 160 }}>
            <div style={{ fontSize: 32 }}>➕</div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Nueva caja</div>
            <div style={{ fontSize: 12 }}>Efectivo, banco, mensajero...</div>
          </button>
        </div>
      </div>

      {/* Modal */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, maxWidth: 520, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ padding: '20px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{editando ? '✏️ Editar Caja' : '➕ Nueva Caja'}</h3>
              <button onClick={() => setModal(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}>✕</button>
            </div>
            <div style={{ padding: 24 }}>
              <div style={S.campo}>
                <label style={S.label}>Nombre *</label>
                <input style={S.input} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej: Efectivo Oficina, Banco Bancolombia..." />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                <div style={S.campo}>
                  <label style={S.label}>Tipo</label>
                  <select style={S.input} value={form.tipo} onChange={e => set('tipo', e.target.value)}>
                    {TIPOS_CAJA.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div style={S.campo}>
                  <label style={S.label}>Responsable</label>
                  <input style={S.input} value={form.responsable || ''} onChange={e => set('responsable', e.target.value)} placeholder="Nombre responsable" />
                </div>
              </div>
              {form.tipo === 'Banco' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                    <div style={S.campo}><label style={S.label}>Banco</label><input style={S.input} value={form.banco || ''} onChange={e => set('banco', e.target.value)} placeholder="Bancolombia..." /></div>
                    <div style={S.campo}>
                      <label style={S.label}>Tipo de cuenta</label>
                      <select style={S.input} value={form.tipoCuenta || ''} onChange={e => set('tipoCuenta', e.target.value)}>
                        <option value="">— Seleccionar —</option>
                        <option value="Ahorros">Ahorros</option>
                        <option value="Corriente">Corriente</option>
                      </select>
                    </div>
                    <div style={S.campo}><label style={S.label}>N° Cuenta</label><input style={S.input} value={form.numeroCuenta || ''} onChange={e => set('numeroCuenta', e.target.value)} /></div>
                    <div style={S.campo}><label style={S.label}>Titular de la cuenta</label><input style={S.input} value={form.titularCuenta || ''} onChange={e => set('titularCuenta', e.target.value)} placeholder="Nombre del titular..." /></div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                    <div style={S.campo}>
                      <label style={S.label}>Empresa asociada</label>
                      <select style={S.input} value={form.empresaId || ''} onChange={e => set('empresaId', e.target.value)}>
                        <option value="">— Seleccionar empresa —</option>
                        {empresas.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 22 }}>
                      <input type="checkbox" id="usarParaCobros" checked={form.usarParaCobros || false}
                        onChange={e => set('usarParaCobros', e.target.checked)}
                        style={{ width: 18, height: 18, cursor: 'pointer' }} />
                      <label htmlFor="usarParaCobros" style={{ ...S.label, cursor: 'pointer', margin: 0 }}>
                        Usar para cobros (CxC y cotizaciones)
                      </label>
                    </div>
                  </div>
                  {form.usarParaCobros && (
                    <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#16a34a' }}>
                      ✅ Esta cuenta aparecerá en estados de cuenta CxC y cotizaciones para indicar al cliente dónde pagar.
                    </div>
                  )}
                </>
              )}
              <div style={S.campo}>
                <label style={S.label}>Saldo inicial {editando ? '(⚠️ edita con cuidado)' : ''}</label>
                <input type="number" style={S.input} value={form.saldo} onChange={e => set('saldo', e.target.value)} min="0" />
              </div>
              <div style={S.campo}>
                <label style={S.label}>Notas</label>
                <textarea style={{ ...S.input, height: 56, resize: 'vertical' }} value={form.notas || ''} onChange={e => set('notas', e.target.value)} />
              </div>
            </div>
            <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setModal(false)} style={S.btnSecundario}>Cancelar</button>
              <button onClick={guardar} disabled={guardando} style={S.btnPrimario}>{guardando ? 'Guardando...' : editando ? 'Guardar cambios' : 'Crear caja'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// TAB CERTIFICADOS
// ═══════════════════════════════════════════════════════════════════════════════
const TabCertificados = ({ token }) => {
  const headers = { Authorization: `Bearer ${token}` };
  const [categorias, setCategorias] = useState([]);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState(null);

  useEffect(() => {
    axios.get(`${API}/companies/certificados/config`, { headers })
      .then(({ data }) => setCategorias(data.categorias || []))
      .catch(() => {});
  }, []);

  const notif = (texto, tipo = 'success') => {
    setMensaje({ texto, tipo });
    setTimeout(() => setMensaje(null), 3000);
  };

  const agregarCategoria = () => {
    setCategorias(prev => [...prev, {
      id: `cat_${Date.now()}`,
      nombreDocumento: '',
      categoriaProducto: '',
      norma: '',
      texto: '',
      contenido: '',
      activo: true
    }]);
  };

  const eliminarCategoria = (id) => {
    setCategorias(prev => prev.filter(c => c.id !== id));
  };

  const updateCat = (id, campo, valor) => {
    setCategorias(prev => prev.map(c => c.id === id ? { ...c, [campo]: valor } : c));
  };

  const handleGuardar = async () => {
    setGuardando(true);
    try {
      await axios.put(`${API}/companies/certificados/config`, { categorias }, { headers });
      notif('✅ Configuración guardada');
    } catch (e) {
      notif(e.response?.data?.error || 'Error al guardar', 'error');
    }
    setGuardando(false);
  };

  return (
    <div>
      {mensaje && (
        <div style={{ ...S.msg, background: mensaje.tipo === 'error' ? '#fff0f0' : '#f0fff4', borderColor: mensaje.tipo === 'error' ? '#dc3545' : '#28a745', color: mensaje.tipo === 'error' ? '#dc3545' : '#28a745' }}>
          {mensaje.texto}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1a1a2e' }}>Documentos por categoría</p>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Cada categoría genera su propio certificado o ficha técnica automáticamente</p>
        </div>
        <button onClick={agregarCategoria} style={S.btnPrimario}>+ Agregar documento</button>
      </div>

      {categorias.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', padding: 48 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📜</div>
          <p style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>Sin documentos configurados</p>
          <p style={{ fontSize: 13, color: '#6b7280' }}>Agrega un documento para cada categoría de servicio</p>
          <button onClick={agregarCategoria} style={{ ...S.btnPrimario, marginTop: 16 }}>+ Agregar primer documento</button>
        </div>
      ) : (
        categorias.map((cat, idx) => (
          <div key={cat.id} style={{ ...S.card, border: cat.activo ? '1.5px solid #e5e7eb' : '1.5px dashed #e5e7eb', opacity: cat.activo ? 1 : 0.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20, fontWeight: 800, color: '#667eea' }}>#{idx + 1}</span>
                <div>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#1a1a2e' }}>{cat.nombreDocumento || 'Sin nombre'}</p>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Categoría: {cat.categoriaProducto || 'Sin definir'}</p>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={cat.activo} onChange={e => updateCat(cat.id, 'activo', e.target.checked)} />
                  Activo
                </label>
                <button onClick={() => eliminarCategoria(cat.id)}
                  style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  🗑️ Eliminar
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div style={S.campo}>
                <label style={S.label}>Nombre del documento *</label>
                <input style={S.input} value={cat.nombreDocumento}
                  onChange={e => updateCat(cat.id, 'nombreDocumento', e.target.value)}
                  placeholder="Ej: Certificado de Mantenimiento, Ficha Técnica..." />
              </div>
              <div style={S.campo}>
                <label style={S.label}>Categoría del producto *</label>
                <input style={S.input} value={cat.categoriaProducto}
                  onChange={e => updateCat(cat.id, 'categoriaProducto', e.target.value.toLowerCase())}
                  placeholder="Ej: recarga y mantenimiento, ph, botiquines..." />
                <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>Debe coincidir con la categoría del producto</span>
              </div>
              <div style={S.campo}>
                <label style={S.label}>Norma aplicable</label>
                <input style={S.input} value={cat.norma}
                  onChange={e => updateCat(cat.id, 'norma', e.target.value)}
                  placeholder="Ej: NTC 2885, NFPA 10, Res. 705..." />
              </div>
            </div>

            <div style={S.campo}>
              <label style={S.label}>Texto principal del documento</label>
              <textarea style={{ ...S.input, minHeight: 90, resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }}
                value={cat.texto}
                onChange={e => updateCat(cat.id, 'texto', e.target.value)}
                placeholder="Texto que aparece en el cuerpo del certificado/ficha..." />
            </div>

            <div style={S.campo}>
              <label style={S.label}>Características / Servicios realizados</label>
              <textarea style={{ ...S.input, minHeight: 90, resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }}
                value={cat.contenido}
                onChange={e => updateCat(cat.id, 'contenido', e.target.value)}
                placeholder="Ej: Inspección visual • Limpieza de válvulas • Recarga del agente..." />
            </div>
          </div>
        ))
      )}

      {categorias.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button onClick={handleGuardar} disabled={guardando} style={S.btnPrimario}>
            {guardando ? 'Guardando...' : '💾 Guardar configuración'}
          </button>
        </div>
      )}
    </div>
  );
};

const ConfigEmpresas = ({ user }) => {
  const [tab, setTab] = useState('empresas');
  const [cajas, setCajas] = useState([]);
  const [empresas, setEmpresas] = useState([]);
  const token = localStorage.getItem('token');

  useEffect(() => {
    axios.get(`${API}/companies`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setEmpresas(r.data || [])).catch(() => {});
  }, [token]);

  const TABS = [
    { key: 'empresas',      label: '🏢 Empresas' },
    { key: 'formasPago',    label: '💳 Formas de pago' },
    { key: 'categorias',    label: '📂 Categorías de egresos' },
    { key: 'cajas',         label: '🏦 Cajas' },
    { key: 'certificados',  label: '📜 Certificados' },
  ];

  return (
    <div style={{ padding: '32px', maxWidth: 1100, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>⚙️ Mi Empresa</h2>
          <p style={{ margin: '4px 0 0', color: '#888', fontSize: 14 }}>Configuración general del sistema</p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '2px solid #e2e8f0', marginBottom: 24, gap: 0 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '12px 24px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: tab === t.key ? 700 : 500,
            color: tab === t.key ? '#667eea' : '#64748b',
            borderBottom: tab === t.key ? '2px solid #667eea' : '2px solid transparent',
            marginBottom: -2, background: 'transparent', transition: 'all 0.15s'
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'empresas'   && <TabEmpresas token={token} />}
      {tab === 'formasPago' && <TabFormasPago token={token} cajas={cajas} />}
      {tab === 'categorias' && <TabCategorias token={token} />}
    {tab === 'cajas'         && <TabCajas token={token} onCajasChange={setCajas} empresas={empresas} />}
      {tab === 'certificados'  && <TabCertificados token={token} empresas={empresas} />}
    </div>
  );
};

// ─── Estilos compartidos ──────────────────────────────────────────────────────
const S = {
  card:        { background: 'white', padding: 28, borderRadius: 12, marginBottom: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.08)' },
  cardTitulo:  { margin: '0 0 20px 0', fontSize: 17, fontWeight: 700, color: '#1a1a2e' },
  campo:       { display: 'flex', flexDirection: 'column', marginBottom: 14 },
  label:       { fontSize: 13, fontWeight: 600, color: '#444', marginBottom: 6 },
  input:       { padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, outline: 'none', color: '#1e293b', background: '#fff' },
  btnPrimario: { padding: '10px 24px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  btnSecundario:{ padding: '10px 24px', background: '#f0f0f0', color: '#555', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  msg:         { padding: '12px 18px', borderRadius: 8, border: '1px solid', marginBottom: 20, fontWeight: 600, fontSize: 14 },
};

export default ConfigEmpresas;
