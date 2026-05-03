import React, { useState, useEffect } from 'react';
import axios from 'axios';

const ConfigEmpresas = ({ user }) => {
  const [empresas, setEmpresas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editando, setEditando] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    nit: '',
    address: '',
    phone: '',
    cellphone: '',
    email: '',
    iva: ''
  });
  const [errores, setErrores] = useState({});
  const token = localStorage.getItem('token');

  useEffect(() => {
    cargarEmpresas();
  }, [token]);

  const cargarEmpresas = async () => {
    try {
      const response = await axios.get('http://localhost:5000/api/companies', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setEmpresas(response.data || []);
    } catch (error) {
      console.error('Error:', error);
    }
    setLoading(false);
  };

  const validar = () => {
    const nuevosErrores = {};

    if (!formData.name.trim()) nuevosErrores.name = 'Nombre requerido';
    if (!/^\d{8,}$/.test(formData.nit)) nuevosErrores.nit = 'NIT: mínimo 8 dígitos';
    if (!formData.address.trim()) nuevosErrores.address = 'Dirección requerida';
    if (!/^\d{7,}$/.test(formData.phone)) nuevosErrores.phone = 'Teléfono: solo números';
    if (!/^\d{10}$/.test(formData.cellphone)) nuevosErrores.cellphone = 'Celular: 10 dígitos';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) nuevosErrores.email = 'Email inválido';
    if (!/^\d+$/.test(formData.iva) || parseInt(formData.iva) < 0 || parseInt(formData.iva) > 100) {
      nuevosErrores.iva = 'IVA: número entre 0-100';
    }

    setErrores(nuevosErrores);
    return Object.keys(nuevosErrores).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validar()) return;

    try {
      if (editando) {
        await axios.put(`http://localhost:5000/api/companies/${editando}`, formData, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.post('http://localhost:5000/api/companies', formData, {
          headers: { Authorization: `Bearer ${token}` }
        });
      }
      setFormData({ name: '', nit: '', address: '', phone: '', cellphone: '', email: '', iva: '' });
      setEditando(null);
      cargarEmpresas();
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleEditar = (empresa) => {
    setEditando(empresa.id);
    setFormData({
      name: empresa.name?.stringValue || '',
      nit: empresa.nit?.stringValue || '',
      address: empresa.address?.stringValue || '',
      phone: empresa.phone?.stringValue || '',
      cellphone: empresa.cellphone?.stringValue || '',
      email: empresa.email?.stringValue || '',
      iva: empresa.iva?.integerValue || ''
    });
  };

  const handleEliminar = async (id) => {
    if (window.confirm('¿Eliminar empresa?')) {
      try {
        await axios.delete(`http://localhost:5000/api/companies/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        cargarEmpresas();
      } catch (error) {
        console.error('Error:', error);
      }
    }
  };

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}>Cargando...</div>;

  return (
    <div style={{ padding: '40px', maxWidth: '1200px', margin: '0 auto' }}>
      <h2>⚙️ Configurar Empresas</h2>
      <p style={{ color: '#999', marginBottom: '30px' }}>Máximo 2 empresas por usuario</p>

      <div style={{ background: 'white', padding: '30px', borderRadius: '8px', marginBottom: '30px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <h3 style={{ margin: '0 0 20px 0' }}>{editando ? 'Editar' : 'Nueva'} Empresa</h3>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginBottom: '20px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '600' }}>Nombre Empresa *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: errores.name ? '2px solid #dc3545' : '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
              {errores.name && <p style={{ color: '#dc3545', fontSize: '12px', margin: '5px 0 0 0' }}>{errores.name}</p>}
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '600' }}>NIT *</label>
              <input
                type="text"
                value={formData.nit}
                onChange={(e) => setFormData({ ...formData, nit: e.target.value.replace(/\D/g, '') })}
                placeholder="88273572"
                style={{
                  width: '100%',
                  padding: '10px',
                  border: errores.nit ? '2px solid #dc3545' : '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
              {errores.nit && <p style={{ color: '#dc3545', fontSize: '12px', margin: '5px 0 0 0' }}>{errores.nit}</p>}
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '600' }}>Dirección *</label>
              <input
                type="text"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: errores.address ? '2px solid #dc3545' : '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
              {errores.address && <p style={{ color: '#dc3545', fontSize: '12px', margin: '5px 0 0 0' }}>{errores.address}</p>}
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '600' }}>Teléfono *</label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value.replace(/\D/g, '') })}
                placeholder="3226686"
                style={{
                  width: '100%',
                  padding: '10px',
                  border: errores.phone ? '2px solid #dc3545' : '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
              {errores.phone && <p style={{ color: '#dc3545', fontSize: '12px', margin: '5px 0 0 0' }}>{errores.phone}</p>}
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '600' }}>Celular *</label>
              <input
                type="text"
                value={formData.cellphone}
                onChange={(e) => setFormData({ ...formData, cellphone: e.target.value.replace(/\D/g, '') })}
                placeholder="3148361622"
                style={{
                  width: '100%',
                  padding: '10px',
                  border: errores.cellphone ? '2px solid #dc3545' : '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
              {errores.cellphone && <p style={{ color: '#dc3545', fontSize: '12px', margin: '5px 0 0 0' }}>{errores.cellphone}</p>}
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '600' }}>Email *</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: errores.email ? '2px solid #dc3545' : '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
              {errores.email && <p style={{ color: '#dc3545', fontSize: '12px', margin: '5px 0 0 0' }}>{errores.email}</p>}
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: '600' }}>IVA (%) *</label>
              <input
                type="text"
                value={formData.iva}
                onChange={(e) => setFormData({ ...formData, iva: e.target.value.replace(/\D/g, '') })}
                placeholder="19"
                style={{
                  width: '100%',
                  padding: '10px',
                  border: errores.iva ? '2px solid #dc3545' : '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px'
                }}
              />
              {errores.iva && <p style={{ color: '#dc3545', fontSize: '12px', margin: '5px 0 0 0' }}>{errores.iva}</p>}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="submit"
              style={{
                padding: '12px 30px',
                background: '#667eea',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              {editando ? 'Actualizar' : 'Crear'} Empresa
            </button>
            {editando && (
              <button
                type="button"
                onClick={() => {
                  setEditando(null);
                  setFormData({ name: '', nit: '', address: '', phone: '', cellphone: '', email: '', iva: '' });
                  setErrores({});
                }}
                style={{
                  padding: '12px 30px',
                  background: '#999',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: '600'
                }}
              >
                Cancelar
              </button>
            )}
          </div>
        </form>
      </div>

      <div style={{ background: 'white', padding: '30px', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <h3 style={{ margin: '0 0 20px 0' }}>Empresas Registradas ({empresas.length}/2)</h3>
        {empresas.length === 0 ? (
          <p style={{ color: '#999' }}>Sin empresas registradas</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
            {empresas.map((empresa) => (
              <div key={empresa.id} style={{
                background: '#f9f9f9',
                padding: '20px',
                borderRadius: '8px',
                border: '1px solid #eee'
              }}>
                <h4 style={{ margin: '0 0 10px 0', color: '#333' }}>{empresa.name?.stringValue}</h4>
                <p style={{ margin: '5px 0', fontSize: '13px' }}><strong>NIT:</strong> {empresa.nit?.stringValue}</p>
                <p style={{ margin: '5px 0', fontSize: '13px' }}><strong>Dirección:</strong> {empresa.address?.stringValue}</p>
                <p style={{ margin: '5px 0', fontSize: '13px' }}><strong>Teléfono:</strong> {empresa.phone?.stringValue}</p>
                <p style={{ margin: '5px 0', fontSize: '13px' }}><strong>Celular:</strong> {empresa.cellphone?.stringValue}</p>
                <p style={{ margin: '5px 0', fontSize: '13px' }}><strong>Email:</strong> {empresa.email?.stringValue}</p>
                <p style={{ margin: '5px 0 15px 0', fontSize: '13px' }}><strong>IVA:</strong> {empresa.iva?.integerValue}%</p>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    onClick={() => handleEditar(empresa)}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: '#0066cc',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: '600'
                    }}
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => handleEliminar(empresa.id)}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: '#dc3545',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: '600'
                    }}
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ConfigEmpresas;