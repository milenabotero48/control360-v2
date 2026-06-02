import React, { useState } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const Login = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await axios.post(`${API}/auth/login`, { email, password });
      const token = response.data.token;
      const userData = response.data.user;
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(userData));
      onLoginSuccess(userData);
    } catch (err) {
      const msg = err.response?.data?.error || 'Error al iniciar sesión';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>

        {/* LOGO SVG */}
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

        <h1 style={styles.title}>Control<span style={{ color: '#667eea' }}>360</span></h1>
        <p style={styles.subtitle}>Sistema operativo para empresas de servicios</p>

        <form onSubmit={handleLogin} style={styles.form}>
          <div style={styles.inputGroup}>
            <label style={styles.label}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              style={styles.input}
              required
            />
          </div>
          <div style={styles.inputGroup}>
            <label style={styles.label}>Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={styles.input}
              required
            />
          </div>
          {error && <div style={styles.error}>⚠️ {error}</div>}
          <button type="submit" disabled={loading}
            style={{ ...styles.button, opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>

        <p style={styles.footer}>Control360 v2 · Acceso restringido</p>
      </div>
    </div>
  );
};

const styles = {
  container:  { display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', fontFamily: "'Segoe UI', sans-serif" },
  card:       { background: 'white', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', padding: '48px 40px', width: '100%', maxWidth: '400px', textAlign: 'center' },
  title:      { fontSize: 28, fontWeight: 800, margin: '0 0 8px 0', color: '#1a1a2e' },
  subtitle:   { fontSize: 13, color: '#888', margin: '0 0 32px 0' },
  form:       { display: 'flex', flexDirection: 'column', gap: 18, textAlign: 'left' },
  inputGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label:      { fontSize: 13, fontWeight: 600, color: '#444' },
  input:      { padding: '12px 14px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box', width: '100%' },
  button:     { padding: '13px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 8 },
  error:      { background: '#fff0f0', color: '#dc3545', padding: '10px 14px', borderRadius: 8, fontSize: 13, border: '1px solid #f5c6cb' },
  footer:     { fontSize: 11, color: '#bbb', marginTop: 24 }
};

export default Login;

