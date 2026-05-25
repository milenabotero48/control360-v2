import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';
const CLOUDINARY_CLOUD = 'dk8hposft';
const CLOUDINARY_PRESET = 'control360';

const ConfigEmpresas = ({ user }) => {
  const [empresas, setEmpresas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [editando, setEditando] = useState(null);
  const [logoPreview, setLogoPreview] = useState(null);
  const [logoFile, setLogoFile] = useState(null);
  const [mensaje, setMensaje] = useState(null);
  const fileInputRef = useRef();

  const [formData, setFormData] = useState({
    name: '', nit: '', address: '', phone: '',
    cellphone: '', email: '', iva: ''
  });
  const [errores, setErrores] = useState({});
  const token = localStorage.getItem('token');

  useEffect(() => { cargarEmpresas(); }, []);

  const cargarEmpresas = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API}/companies`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setEmpresas(response.data || []);
    } catch (error) {
      console.error('Error cargando empresas:', error);
    }
    setLoading(false);
  };

  const mostrarMensaje = (texto, tipo = 'success') => {
    setMensaje({ texto, tipo });
    setTimeout(() => setMensaje(null), 3500);
  };

  const handleLogo = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      mostrarMensaje('Solo se permiten archivos PNG o JPG', 'error');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      mostrarMensaje('El logo no puede superar 2MB', 'error');
      return;
    }
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  };

  const subirLogoCloudinary = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_PRESET);
    formData.append('folder', 'control360/logos');

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
      { method: 'POST', body: formData }
    );
    const data = await response.json();
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
      let logoUrl = logoPreview && logoPreview.startsWith('http') ? logoPreview : '';

      if (logoFile) {
        mostrarMensaje('⏳ Subiendo logo...', 'success');
        logoUrl = await subirLogoCloudinary(logoFile);
      }

     console.log('logoUrl antes de enviar:', logoUrl);
const payload = {
  ...formData,
  iva: parseInt(formData.iva),
  logo: logoUrl
};
console.log('payload completo:', JSON.stringify(payload).substring(0, 200));

      if (editando) {
        await axios.put(`${API}/companies/${editando}`, payload, {
          headers: { Authorization: `Bearer ${token}` }
        });
        mostrarMensaje('✅ Empresa actualizada correctamente');
      } else {
        await axios.post(`${API}/companies`, payload, {
          headers: { Authorization: `Bearer ${token}` }
        });
        mostrarMensaje('✅ Empresa creada correctamente');
      }

      resetForm();
      cargarEmpresas();
    } catch (error) {
      const msg = error.response?.data?.error || error.message || 'Error al guardar';
      mostrarMensaje(`❌ ${msg}`, 'error');
    }
    setGuardando(false);
  };

  const handleEditar = (empresa) => {
    setEditando(empresa.id);
    setFormData({
      name: empresa.name || '',
      nit: empresa.nit || '',
      address: empresa.address || '',
      phone: empresa.phone || '',
      cellphone: empresa.cellphone || '',
      email: empresa.email || '',
      iva: empresa.iva?.toString() || ''
    });
    setLogoPreview(empresa.logo || null);
    setLogoFile(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleEliminar = async (id) => {
    if (!window.confirm('¿Estás segura de eliminar esta empresa?')) return;
    try {
      await axios.delete(`${API}/companies/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      mostrarMensaje('Empresa eliminada');
      cargarEmpresas();
    } catch (error) {
      mostrarMensaje('Error al eliminar', 'error');
    }
  };

  const resetForm = () => {
    setFormData({ name: '', nit: '', address: '', phone: '', cellphone: '', email: '', iva: '' });
    setEditando(null);
    setLogoPreview(null);
    setLogoFile(null);
    setErrores({});
  };

  const campo = (label, key, tipo = 'text', placeholder = '') => (
    <div style={styles.campo}>
      <label style={styles.label}>{label} *</label>
      <input
        type={tipo}
        value={formData[key]}
        placeholder={placeholder}
        onChange={(e) => {
          let val = e.target.value;
          if (['nit', 'phone', 'cellphone', 'iva'].includes(key)) val = val.replace(/\D/g, '');
          setFormData({ ...formData, [key]: val });
          if (errores[key]) setErrores({ ...errores, [key]: null });
        }}
        style={{ ...styles.input, ...(errores[key] ? styles.inputError : {}) }}
      />
      {errores[key] && <span style={styles.error}>{errores[key]}</span>}
    </div>
  );

  if (loading) return (
    <div style={styles.loading}>
      <div style={styles.spinner} />
      <p style={{ color: '#667eea', marginTop: 12 }}>Cargando empresas...</p>
    </div>
  );

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.titulo}>⚙️ Configurar Empresas</h2>
          <p style={styles.subtitulo}>Máximo 2 empresas por usuario</p>
        </div>
        <div style={styles.badge}>{empresas.length}/2 empresas</div>
      </div>

      {mensaje && (
        <div style={{
          ...styles.mensaje,
          background: mensaje.tipo === 'error' ? '#fff0f0' : '#f0fff4',
          borderColor: mensaje.tipo === 'error' ? '#dc3545' : '#28a745',
          color: mensaje.tipo === 'error' ? '#dc3545' : '#28a745'
        }}>
          {mensaje.texto}
        </div>
      )}

      {(empresas.length < 2 || editando) && (
        <div style={styles.card}>
          <h3 style={styles.cardTitulo}>
            {editando ? '✏️ Editar Empresa' : '➕ Nueva Empresa'}
          </h3>
          <form onSubmit={handleSubmit}>
            <div style={styles.logoSection}>
              <div style={styles.logoBox} onClick={() => fileInputRef.current.click()}>
                {logoPreview
                  ? <img src={logoPreview} alt="Logo" style={styles.logoImg} />
                  : <div style={styles.logoPlaceholder}>
                      <span style={{ fontSize: 32 }}>🏢</span>
                      <span style={{ fontSize: 12, color: '#999', marginTop: 6 }}>Click para subir logo</span>
                      <span style={{ fontSize: 11, color: '#bbb' }}>PNG o JPG · máx 2MB</span>
                    </div>
                }
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                onChange={handleLogo}
                style={{ display: 'none' }}
              />
              {logoPreview && (
                <button
                  type="button"
                  onClick={() => { setLogoPreview(null); setLogoFile(null); }}
                  style={styles.btnQuitarLogo}
                >
                  Quitar logo
                </button>
              )}
            </div>

            <div style={styles.grid}>
              {campo('Nombre Empresa', 'name')}
              {campo('NIT', 'nit', 'text', '88273572')}
              {campo('Dirección', 'address')}
              {campo('Teléfono', 'phone', 'text', '6022226686')}
              {campo('Celular', 'cellphone', 'text', '3148361622')}
              {campo('Email', 'email', 'email', 'empresa@correo.com')}
              {campo('IVA (%)', 'iva', 'text', '19')}
            </div>

            <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
              <button
                type="submit"
                disabled={guardando}
                style={{ ...styles.btnPrimario, opacity: guardando ? 0.7 : 1 }}
              >
                {guardando ? 'Guardando...' : (editando ? '💾 Actualizar Empresa' : '✅ Crear Empresa')}
              </button>
              {editando && (
                <button type="button" onClick={resetForm} style={styles.btnSecundario}>
                  Cancelar
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      <div style={styles.card}>
        <h3 style={styles.cardTitulo}>🏢 Empresas Registradas ({empresas.length}/2)</h3>
        {empresas.length === 0 ? (
          <div style={styles.empty}>
            <span style={{ fontSize: 48 }}>🏗️</span>
            <p style={{ color: '#999', marginTop: 12 }}>Aún no hay empresas registradas</p>
          </div>
        ) : (
          <div style={styles.gridEmpresas}>
            {empresas.map((empresa) => (
              <div key={empresa.id} style={styles.empresaCard}>
                <div style={styles.empresaHeader}>
                  {empresa.logo
                    ? <img src={empresa.logo} alt="Logo" style={styles.empresaLogo} />
                    : <div style={styles.empresaLogoPlaceholder}>🏢</div>
                  }
                  <div>
                    <h4 style={styles.empresaNombre}>{empresa.name}</h4>
                    <span style={styles.empresaBadge}>NIT: {empresa.nit}</span>
                  </div>
                </div>
                <div style={styles.empresaDatos}>
                  <div style={styles.dato}><span style={styles.datoLabel}>📍 Dirección</span><span>{empresa.address}</span></div>
                  <div style={styles.dato}><span style={styles.datoLabel}>📞 Teléfono</span><span>{empresa.phone}</span></div>
                  <div style={styles.dato}><span style={styles.datoLabel}>📱 Celular</span><span>{empresa.cellphone}</span></div>
                  <div style={styles.dato}><span style={styles.datoLabel}>✉️ Email</span><span>{empresa.email}</span></div>
                  <div style={styles.dato}><span style={styles.datoLabel}>💰 IVA</span><span>{empresa.iva}%</span></div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                  <button onClick={() => handleEditar(empresa)} style={styles.btnEditar}>✏️ Editar</button>
                  <button onClick={() => handleEliminar(empresa.id)} style={styles.btnEliminar}>🗑️ Eliminar</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const styles = {
  container: { padding: '32px', maxWidth: 1100, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  titulo: { margin: 0, fontSize: 24, fontWeight: 700, color: '#1a1a2e' },
  subtitulo: { margin: '4px 0 0 0', color: '#888', fontSize: 14 },
  badge: { background: '#667eea', color: 'white', padding: '6px 16px', borderRadius: 20, fontSize: 14, fontWeight: 600 },
  card: { background: 'white', padding: 28, borderRadius: 12, marginBottom: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.08)' },
  cardTitulo: { margin: '0 0 20px 0', fontSize: 17, fontWeight: 700, color: '#1a1a2e' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18 },
  campo: { display: 'flex', flexDirection: 'column' },
  label: { fontSize: 13, fontWeight: 600, color: '#444', marginBottom: 6 },
  input: { padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, outline: 'none' },
  inputError: { borderColor: '#dc3545' },
  error: { color: '#dc3545', fontSize: 11, marginTop: 4 },
  btnPrimario: { padding: '12px 28px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  btnSecundario: { padding: '12px 28px', background: '#f0f0f0', color: '#555', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  logoSection: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 },
  logoBox: { width: 120, height: 120, border: '2px dashed #ccc', borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', background: '#fafafa' },
  logoImg: { width: '100%', height: '100%', objectFit: 'contain' },
  logoPlaceholder: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  btnQuitarLogo: { padding: '6px 12px', background: '#fff0f0', color: '#dc3545', border: '1px solid #dc3545', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  gridEmpresas: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 },
  empresaCard: { background: '#f8f9ff', border: '1px solid #e8ecff', borderRadius: 10, padding: 20 },
  empresaHeader: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 },
  empresaLogo: { width: 56, height: 56, objectFit: 'contain', borderRadius: 8, border: '1px solid #eee' },
  empresaLogoPlaceholder: { width: 56, height: 56, background: '#e8ecff', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 },
  empresaNombre: { margin: 0, fontSize: 15, fontWeight: 700, color: '#1a1a2e' },
  empresaBadge: { fontSize: 12, color: '#667eea', fontWeight: 600 },
  empresaDatos: { display: 'flex', flexDirection: 'column', gap: 6 },
  dato: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#555' },
  datoLabel: { fontWeight: 600, color: '#888', marginRight: 8 },
  btnEditar: { flex: 1, padding: '8px', background: '#0066cc', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  btnEliminar: { flex: 1, padding: '8px', background: '#dc3545', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  mensaje: { padding: '12px 18px', borderRadius: 8, border: '1px solid', marginBottom: 20, fontWeight: 600, fontSize: 14 },
  empty: { textAlign: 'center', padding: '40px 0' },
  loading: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200 },
  spinner: { width: 36, height: 36, border: '3px solid #e0e0e0', borderTop: '3px solid #667eea', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
};

export default ConfigEmpresas;
