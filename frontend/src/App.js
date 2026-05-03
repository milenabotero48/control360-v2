import React, { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';
import DashboardMaykol from './DashboardMaykol';
import DashboardTaller from './DashboardTaller';
import ConfigEmpresas from './ConfigEmpresas';

function App() {
  const [user, setUser] = useState(null);
  const [currentDashboard, setCurrentDashboard] = useState('admin');

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
      <header style={styles.header}>
        <h1 style={styles.logo}>Control360</h1>

        {user.role === 'admin' && (
          <button
            onClick={() => setCurrentDashboard('config')}
            style={{
              ...styles.navBtn,
              background: currentDashboard === 'config' ? '#fff' : 'transparent',
              color: currentDashboard === 'config' ? '#667eea' : '#fff'
            }}
          >
            ⚙️ Configurar
          </button>
        )}

        <div style={styles.nav}>
          <button
            onClick={() => setCurrentDashboard('admin')}
            style={{
              ...styles.navBtn,
              background: currentDashboard === 'admin' ? '#fff' : 'transparent',
              color: currentDashboard === 'admin' ? '#667eea' : '#fff'
            }}
          >
            📊 Admin
          </button>

          <button
            onClick={() => setCurrentDashboard('maykol')}
            style={{
              ...styles.navBtn,
              background: currentDashboard === 'maykol' ? '#fff' : 'transparent',
              color: currentDashboard === 'maykol' ? '#667eea' : '#fff'
            }}
          >
            🚚 Logística
          </button>

          <button
            onClick={() => setCurrentDashboard('taller')}
            style={{
              ...styles.navBtn,
              background: currentDashboard === 'taller' ? '#fff' : 'transparent',
              color: currentDashboard === 'taller' ? '#667eea' : '#fff'
            }}
          >
            🔧 Taller
          </button>
        </div>

        <div style={styles.headerRight}>
          <span style={styles.userEmail}>{user.email}</span>
          <button onClick={handleLogout} style={styles.logoutBtn}>
            Cerrar sesión
          </button>
        </div>
      </header>

      <main style={styles.main}>
        {currentDashboard === 'admin' && <Dashboard user={user} />}
        {currentDashboard === 'maykol' && <DashboardMaykol user={user} />}
        {currentDashboard === 'taller' && <DashboardTaller user={user} />}
        {currentDashboard === 'config' && user.role === 'admin' && <ConfigEmpresas user={user} />}
      </main>
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
    padding: '20px 40px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
    gap: '20px'
  },
  logo: {
    margin: 0,
    fontSize: '28px',
    fontWeight: 'bold',
    minWidth: '150px'
  },
  nav: {
    display: 'flex',
    gap: '10px',
    flex: 1
  },
  navBtn: {
    padding: '10px 20px',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '600',
    transition: 'all 0.2s'
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '20px'
  },
  userEmail: {
    fontSize: '14px',
    opacity: 0.9
  },
  logoutBtn: {
    padding: '10px 20px',
    background: 'rgba(255, 255, 255, 0.2)',
    color: 'white',
    border: '1px solid white',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    transition: 'background 0.2s'
  },
  main: {
    padding: '20px'
  }
};

export default App;