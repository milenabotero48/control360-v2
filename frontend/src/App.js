import React, { useState, useEffect } from 'react';
import Login from './Login';

function App() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const savedUser = localStorage.getItem('user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  if (!user) {
    return <Login onLoginSuccess={setUser} />;
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1>Control360</h1>
        <button onClick={handleLogout} style={styles.logoutBtn}>
          Cerrar sesión
        </button>
      </div>

      <div style={styles.dashboard}>
        <h2>Bienvenido, {user.email}</h2>
        <p>Dashboard en construcción...</p>
        
        <div style={styles.grid}>
          <div style={styles.card}>
            <h3>📋 Órdenes</h3>
            <p>Gestionar órdenes de servicio</p>
          </div>
          <div style={styles.card}>
            <h3>👥 Clientes</h3>
            <p>Base de datos de clientes</p>
          </div>
          <div style={styles.card}>
            <h3>📦 Productos</h3>
            <p>Catálogo de productos</p>
          </div>
          <div style={styles.card}>
            <h3>🎯 Cotizaciones</h3>
            <p>Crear y aprobar cotizaciones</p>
          </div>
          <div style={styles.card}>
            <h3>🚚 Logística</h3>
            <p>Rastreo de entregas</p>
          </div>
          <div style={styles.card}>
            <h3>🔧 Taller</h3>
            <p>Gestión de reparaciones</p>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif',
    background: '#f5f5f5',
    minHeight: '100vh'
  },
  header: {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    padding: '20px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  logoutBtn: {
    padding: '10px 20px',
    background: 'rgba(255, 255, 255, 0.2)',
    color: 'white',
    border: '1px solid white',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px'
  },
  dashboard: {
    padding: '40px',
    maxWidth: '1200px',
    margin: '0 auto'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: '20px',
    marginTop: '30px'
  },
  card: {
    background: 'white',
    padding: '20px',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
    cursor: 'pointer',
    transition: 'transform 0.2s'
  }
};

export default App;