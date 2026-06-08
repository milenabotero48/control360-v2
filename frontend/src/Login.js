import React, { useState } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const Login = ({ onLoginSuccess }) => {
  const [vista, setVista] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [nuevaPassword, setNuevaPassword] = useState('');
  const [confirmarPassword, setConfirmarPassword] = useState('');

  const token = new URLSearchParams(window.location.search).get('token');

  React.useEffect(() => {
    if (token) setVista('reset');
  }, [token]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await axios.post(`${API}/auth/login`, { email, password });
      const tk = response.data.token;
      const userData = response.data.user;
      localStorage.setItem('token', tk);
      localStorage.setItem('user', JSON.stringify(userData));
      onLoginSuccess(userData);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al iniciar sesion');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setMensaje('');
    try {
      await axios.post(`${API}/auth/forgot-password`, { email });
      setMensaje('Si el email existe recibiras un correo con el enlace.');
    } catch {
      setError('Error al enviar el correo. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (nuevaPassword !== confirmarPassword) {
      setError('Las contrasenas no coinciden');
      return;
    }
    if (nuevaPassword.length < 6) {
      setError('La contrasena debe tener al menos 6 caracteres');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await axios.post(`${API}/auth/reset-password`, { token, nuevaPassword });
      setMensaje('Contrasena actualizada correctamente. Ya puedes iniciar sesion.');
      setTimeout(() => {
        window.location.href = window.location.pathname;
      }, 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al restablecer contrasena');
    } finally {
      setLoading(false);
    }
  };

  const Logo = () => (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
      <svg viewBox="0 0 80 80" width="80" height="80">
        <defs>
          <linearGradient id="loginGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#667eea"/>
            <stop offset="100%" stopColor="#764ba2"/>
          </linearGradient>
        </defs>
        <rect width="80" height="80" rx="20" fill="url(#loginGrad)"/>
        <circle cx="40" cy="40" r="26" fill="none" stroke="white" strokeWidth="1.5" opacity="0.25"/>
        <circle cx="40" cy="40" r="17" fill="none" stroke="white" strokeWidth="1.5" opacity="0.4"/>
        <path d="M 22 40 A 18 18 0 1 1 58 40" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"/>
        <circle cx="40" cy="40" r="5" fill="white"/>
        <line x1="26" y1="40" x2="35" y2="40" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round"/>
        <circle cx="58" cy="40" r="3.5" fill="rgba(255,255,255,0.7)"/>
        <circle cx="22" cy="40" r="3.5" fill="rgba(255,255,255,0.7)"/>
        <circle cx="40" cy="22" r="3.5" fill="rgba(255,255,255,0.7)"/>
      </svg>
    </div>
  );

  if (vista === 'forgot') return (
    <div style={S.container}>
      <div style={S.card}>
        <Logo />
        <h1 style={S.title}>Control<span style={{ color: '#667eea' }}>360</span></h1>
        <p style={S.subtitle}>Recuperar contrasena</p>
        {mensaje ? (
          <div style={S.success}>{mensaje}</div>
        ) : (
          <form onSubmit={handleForgot} style={S.form}>
            <div style={S.inputGroup}>
              <label style={S.label}>Email registrado</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="tu@email.com" style={S.input} required />
            </div>
            {error && <div style={S.error}>{error}</div>}
            <button type="submit" disabled={loading}
              style={{ ...S.button, opacity: loading ? 0.7 : 1 }}>
              {loading ? 'Enviando...' : 'Enviar enlace'}
            </button>
          </form>
        )}
        <button onClick={() => { setVista('login'); setError(''); setMensaje(''); }}
          style={S.link}>Volver al login</button>
        <p style={S.footer}>Control360 v2</p>
      </div>
    </div>
  );

  if (vista === 'reset') return (
    <div style={S.container}>
      <div style={S.card}>
        <Logo />
        <h1 style={S.title}>Control<span style={{ color: '#667eea' }}>360</span></h1>
        <p style={S.subtitle}>Nueva contrasena</p>
        {mensaje ? (
          <div style={S.success}>{mensaje}</div>
        ) : (
          <form onSubmit={handleReset} style={S.form}>
            <div style={S.inputGroup}>
              <label style={S.label}>Nueva contrasena</label>
              <input type="password" value={nuevaPassword}
                onChange={e => setNuevaPassword(e.target.value)}
                placeholder="Minimo 6 caracteres" style={S.input} required />
            </div>
            <div style={S.inputGroup}>
              <label style={S.label}>Confirmar contrasena</label>
              <input type="password" value={confirmarPassword}
                onChange={e => setConfirmarPassword(e.target.value)}
                placeholder="Repite la contrasena" style={S.input} required />
            </div>
            {error && <div style={S.error}>{error}</div>}
            <button type="submit" disabled={loading}
              style={{ ...S.button, opacity: loading ? 0.7 : 1 }}>
              {loading ? 'Guardando...' : 'Guardar contrasena'}
            </button>
          </form>
        )}
        <p style={S.footer}>Control360 v2</p>
      </div>
    </div>
  );

  return (
    <div style={S.container}>
      <div style={S.card}>
        <Logo />
        <h1 style={S.title}>Control<span style={{ color: '#667eea' }}>360</span></h1>
        <p style={S.subtitle}>Sistema operativo para empresas de servicios</p>
        <form onSubmit={handleLogin} style={S.form}>
          <div style={S.inputGroup}>
            <label style={S.label}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="tu@email.com" style={S.input} required />
          </div>
          <div style={S.inputGroup}>
            <label style={S.label}>Contrasena</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" style={S.input} required />
          </div>
          {error && <div style={S.error}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{ ...S.button, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
        <button onClick={() => { setVista('forgot'); setError(''); setMensaje(''); }}
          style={S.link}>
          Olvide mi contrasena
        </button>
        <p style={S.footer}>Control360 v2 · Acceso restringido</p>
      </div>
    </div>
  );
};

const S = {
  container:  { display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', fontFamily: "'Segoe UI', sans-serif" },
  card:       { background: 'white', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', padding: '48px 40px', width: '100%', maxWidth: '400px', textAlign: 'center' },
  title:      { fontSize: 28, fontWeight: 800, margin: '0 0 8px 0', color: '#1a1a2e' },
  subtitle:   { fontSize: 13, color: '#888', margin: '0 0 32px 0' },
  form:       { display: 'flex', flexDirection: 'column', gap: 18, textAlign: 'left' },
  inputGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label:      { fontSize: 13, fontWeight: 600, color: '#444' },
  input:      { padding: '12px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box', width: '100%' },
  button:     { padding: '13px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 8 },
  link:       { background: 'none', border: 'none', color: '#667eea', cursor: 'pointer', fontSize: 13, marginTop: 16, textDecoration: 'underline' },
  error:      { background: '#fff0f0', color: '#dc3545', padding: '10px 14px', borderRadius: 8, fontSize: 13, border: '1px solid #f5c6cb' },
  success:    { background: '#f0fff4', color: '#155724', padding: '10px 14px', borderRadius: 8, fontSize: 13, border: '1px solid #c3e6cb' },
  footer:     { fontSize: 11, color: '#bbb', marginTop: 24 }
};

export default Login;