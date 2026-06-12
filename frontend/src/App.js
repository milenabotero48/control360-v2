import React, { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';
import DashboardComercial from './DashboardComercial';
import DashboardMensajero from './DashboardMensajero';
import DashboardTesoreria from './DashboardTesoreria';
import DashboardTaller from './DashboardTaller';
import GestionLogistica from './GestionLogistica';
import GestionTaller from './GestionTaller';
import ConfigEmpresas from './ConfigEmpresas';
import GestionUsuarios from './GestionUsuarios';
import GestionClientes from './GestionClientes';
import GestionProductos from './GestionProductos';
import GestionOrdenes from './GestionOrdenes';
import GestionCotizaciones from './GestionCotizaciones';
import ModuloERI from './ModuloERI';   // Ola 3
import ModuloReportes from './ModuloReportes'; // Ola 3 Bloque 2
import CampanaAlertas from './CampanaAlertas'; // Ola 3 Bloque 3
import GestionCaja from './GestionCaja';
import GestionEgresos from './GestionEgresos';
import GestionCxC from './GestionCxC';
import GestionCxP from './GestionCxP';
import GestionProveedores from './GestionProveedores';
import GestionQR from './GestionQR';
import GestionCompras from './GestionCompras';
import PanelSuscriptores from './PanelSuscriptores'; // Panel Maestro (solo superAdmin)
import ModuloComercial from './ModuloComercial'; // Fase 3: Telemercadeo

// ─── NAV POR GRUPOS Y ROL ────────────────────────────────────────────────────
// ─── MAPA COMPLETO DE MÓDULOS ─────────────────────────────────────────────────
// key del menú → módulo que debe estar activo en user.modulos
const TODOS_LOS_MODULOS = [
  { key: 'admin',       label: 'Dashboard',     icon: '⊞',  modulo: 'dashboard' },
  { key: 'ordenes',     label: 'Órdenes',       icon: '📋', modulo: 'ordenes' },
  { key: 'cotizaciones',label: 'Cotizaciones',  icon: '💬', modulo: 'cotizaciones' },
  { key: 'clientes',    label: 'Clientes',      icon: '👥', modulo: 'clientes' },
  { key: 'comercial',   label: 'Telemercadeo',  icon: '📞', modulo: 'comercial' },
  { key: 'productos',   label: 'Productos',     icon: '📦', modulo: 'productos' },
  { key: 'proveedores', label: 'Proveedores',   icon: '🏭', modulo: 'proveedores' },
  { key: 'logistica',   label: 'Logística',     icon: '🚚', modulo: 'logistica' },
  { key: 	'taller',      	label: 	'Taller',        	icon:  '🔧',   modulo:    'taller' },
     { key: 	'qr',          	label: 	'QR Activos',    	icon: 	'📲', modulo: 'qr' },
  { key: 'caja',        label: 'Caja',          icon: '💰', modulo: 'caja' },
  { key: 'egresos',     label: 'Egresos',       icon: '💸', modulo: 'egresos' },
  { key: 'compras',     label: 'Compras',       icon: '🛒', modulo: 'compras' },
  { key: 'cxc',         label: 'CxC',           icon: '💳', modulo: 'cxc' },
  { key: 'cxp',         label: 'CxP',           icon: '📋', modulo: 'cxp' },
  { key: 'eri',         label: 'ERI',           icon: '📈', modulo: 'eri' },
  { key: 'reportes',    label: 'Reportes',      icon: '📉', modulo: 'reportes' },
  { key: 'config',      label: 'Mi Empresa',    icon: '🏢', modulo: 'mi_empresa' },
  { key: 'usuarios',    label: 'Usuarios',      icon: '👤', modulo: 'usuarios' },
];

// Grupos por rol — define la estructura del sidebar
const NAV_GRUPOS = {
  admin: [
    { grupo: 'Principal',      modulos: ['admin'] },
    { grupo: 'Operaciones',    modulos: ['ordenes', 'cotizaciones', 'clientes', 'comercial', 'productos', 'proveedores'] },
    { grupo: 'Ejecución',      modulos: ['logistica', 'taller', 'qr'] },
    { grupo: 'Finanzas',       modulos: ['caja', 'egresos', 'compras', 'cxc', 'cxp', 'eri', 'reportes'] },
    { grupo: 'Configuración',  modulos: ['config', 'usuarios'] },
  ],
  comercial: [
    { grupo: 'Principal',      modulos: ['admin'] },
    { grupo: 'Operaciones',    modulos: ['comercial', 'ordenes', 'cotizaciones', 'clientes', 'productos'] },
  ],
  mensajero: [
    { grupo: 'Principal',  modulos: ['admin'] },
    { grupo: 'Mi Trabajo', modulos: ['logistica', 'ordenes', 'clientes', 'productos'] },
  ],
  taller: [
    { grupo: 'Principal',      modulos: ['admin'] },
    { grupo: 'Mi Trabajo',     modulos: ['taller', 'productos'] },
  ],
  tesoreria: [
    { grupo: 'Principal',      modulos: ['admin'] },
    { grupo: 'Finanzas',       modulos: ['caja', 'egresos', 'cxc', 'cxp'] },
    { grupo: 'Operaciones',    modulos: ['clientes', 'ordenes'] },
  ],
  visor: [
    { grupo: 'Principal',      modulos: ['admin'] },
  ],
};

// Construir grupos filtrados por módulos activos del usuario
const buildGrupos = (role, userModulos, esSuperAdmin = false) => {
  const modulosActivos = userModulos || [];
  const tieneModulosPersonalizados = modulosActivos.length > 0;

  // ✅ FIX: si el usuario tiene módulos personalizados (ej: comercial con egresos, caja, etc.)
  // usar siempre NAV_GRUPOS['admin'] como base para que todos los módulos sean accesibles
  // Si no tiene módulos personalizados → usar el grupo de su rol (comportamiento original)
  const grupos = (tieneModulosPersonalizados && role !== 'admin')
    ? NAV_GRUPOS['admin']
    : (NAV_GRUPOS[role] || NAV_GRUPOS['visor']);

  const resultado = grupos.map(g => ({
    grupo: g.grupo,
    items: g.modulos
      .map(key => TODOS_LOS_MODULOS.find(m => m.key === key))
      .filter(item => {
        if (!item) return false;
        // Admin sin módulos definidos → ver todo
        if (role === 'admin' && !tieneModulosPersonalizados) return true;
        // Cualquier rol con módulos definidos → filtrar por lista
        if (tieneModulosPersonalizados) {
          return modulosActivos.includes(item.modulo) ||
                 modulosActivos.includes(item.key) ||
                 modulosActivos.includes(item.label?.toLowerCase());
        }
        // Rol sin módulos definidos → comportamiento original por rol
        return true;
      })
  })).filter(g => g.items.length > 0);

  // Grupo Plataforma: SOLO para el super-admin (Milena). No vive en
  // NAV_GRUPOS para que ningún otro admin lo vea jamás. La visibilidad
  // viene de auth.js, pero la seguridad real la valida el backend en
  // Firestore en cada petición de /api/superadmin.
  if (esSuperAdmin === true) {
    resultado.push({
      grupo: 'Plataforma',
      items: [{ key: 'suscriptores', label: 'Suscriptores', icon: '🛰️', modulo: 'suscriptores' }]
    });
  }

  return resultado;
};

const BOTTOM_NAV = {
  admin:     ['admin', 'ordenes', 'logistica', 'caja'],
  comercial: ['admin', 'comercial', 'ordenes', 'clientes'],
  mensajero: ['logistica', 'ordenes', 'clientes', 'productos'],
  taller:    ['taller', 'productos'],
  tesoreria: ['admin', 'caja', 'egresos', 'cxc'],
  visor:     ['admin'],
};

const DASHBOARD_INICIAL = {
  admin: 'admin', comercial: 'admin', mensajero: 'admin',
  taller: 'taller', tesoreria: 'admin', visor: 'admin',
};

const PAGINAS_PRONTO = [];

// ─── LOGO SVG ────────────────────────────────────────────────────────────────
const LogoControl360 = ({ width = 160, height = 48 }) => (
  <svg viewBox="0 0 200 60" width={width} height={height} style={{ display: 'block' }}>
    <circle cx="30" cy="30" r="22" fill="none" stroke="white" strokeWidth="1.5" opacity="0.2"/>
    <circle cx="30" cy="30" r="14" fill="none" stroke="white" strokeWidth="1.5" opacity="0.35"/>
    <path d="M 16 30 A 14 14 0 1 1 44 30" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
    <circle cx="30" cy="30" r="4" fill="white"/>
    <line x1="19" y1="30" x2="26" y2="30" stroke="rgba(255,255,255,0.7)" strokeWidth="1.8" strokeLinecap="round"/>
    <circle cx="44" cy="30" r="3" fill="rgba(255,255,255,0.6)"/>
    <circle cx="16" cy="30" r="3" fill="rgba(255,255,255,0.6)"/>
    <circle cx="30" cy="16" r="3" fill="rgba(255,255,255,0.6)"/>
    <text x="60" y="25" fontFamily="Segoe UI, Arial, sans-serif" fontSize="18" fontWeight="700" fill="white">Control</text>
    <text x="133" y="25" fontFamily="Segoe UI, Arial, sans-serif" fontSize="18" fontWeight="900" fill="#a78bfa">360</text>
    <text x="60" y="40" fontFamily="Segoe UI, Arial, sans-serif" fontSize="7" fill="rgba(255,255,255,0.35)" letterSpacing="2.5">SISTEMA OPERATIVO EMPRESARIAL</text>
  </svg>
);

const getIniciales = (nombre, email) => {
  if (nombre) {
    const p = nombre.trim().split(' ');
    if (p.length >= 2) return (p[0][0] + p[1][0]).toUpperCase();
    return p[0].substring(0, 2).toUpperCase();
  }
  return (email || 'U').substring(0, 2).toUpperCase();
};

// ─── CSS GLOBAL ───────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; }

  .c360-sidebar {
    width: 230px;
    min-height: 100vh;
    background: linear-gradient(160deg, #1e1b4b 0%, #312e81 100%);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    z-index: 100;
    transition: transform 0.25s ease;
  }

  .c360-mob-topbar { display: none !important; }
  .c360-bottomnav  { display: none !important; }
  .c360-sb-close   { display: none !important; }
  /* Ola 3 Bloque 3: header desktop visible en >768px */
  .c360-desk-topbar { display: flex !important; }

  @media (max-width: 768px) {
    .c360-desk-topbar { display: none !important; }
    .c360-sidebar {
      position: fixed !important;
      top: 0; left: 0;
      /* Ola 3: 100dvh evita que el pie del menú (Salir) quede oculto tras la
         barra del navegador en iOS/Android. 100vh queda como respaldo. */
      height: 100vh !important;
      height: 100dvh !important;
      transform: translateX(-100%);
      z-index: 300;
      padding-bottom: env(safe-area-inset-bottom);
    }
    .c360-sb-close { display: flex !important; }
    .c360-sidebar.open {
      transform: translateX(0);
    }
    .c360-mob-topbar {
      display: flex !important;
      height: 56px;
      background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%);
      align-items: center;
      padding: 0 16px;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 50;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      flex-shrink: 0;
    }
    .c360-bottomnav {
      display: flex !important;
      height: 60px;
      background: #fff;
      border-top: 0.5px solid #e5e7eb;
      align-items: stretch;
      justify-content: space-around;
      position: sticky;
      bottom: 0;
      z-index: 50;
      flex-shrink: 0;
    }
  }

  .sb-btn:hover {
    background: rgba(255,255,255,0.08) !important;
    color: #fff !important;
  }

  .c360-sidebar nav::-webkit-scrollbar { width: 3px; }
  .c360-sidebar nav::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
`;

// ─── COMPONENTE PRINCIPAL ─────────────────────────────────────────────────────
export default function AppRoot() {
  const [user, setUser]                   = useState(null);
  const [currentPage, setCurrentPage]     = useState('admin');
  const [sidebarOpen, setSidebarOpen]     = useState(false);
  const [empresaActiva, setEmpresaActiva] = useState(null);
  const [alertasCxC, setAlertasCxC]       = useState(0);

  useEffect(() => {
    // Inyectar CSS global
    if (!document.getElementById('c360-css')) {
      const el = document.createElement('style');
      el.id = 'c360-css';
      el.textContent = GLOBAL_CSS;
      document.head.appendChild(el);
    }
    // Cargar usuario
    const saved = localStorage.getItem('user');
    if (saved) {
      const u = JSON.parse(saved);
      setUser(u);
      setCurrentPage(DASHBOARD_INICIAL[u.role] || 'admin');
    }
    // Cargar empresa activa
    const emp = localStorage.getItem('empresaActiva');
    if (emp) { try { setEmpresaActiva(JSON.parse(emp)); } catch(e) {} }
  }, []);

  // Cargar alertas cobranza
  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem('token');
    const cargarAlertas = async () => {
      try {
        const res = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:5000/api'}/cxc/gestiones/todas`, { headers: { Authorization: `Bearer ${token}` } });
        const gestiones = await res.json();
        const hoyStr = new Date().toISOString().split('T')[0];
        const porCliente = {};
        (Array.isArray(gestiones) ? gestiones : []).forEach(g => {
          if (!g.proximoSeguimiento) return;
          if (!porCliente[g.clienteId] || g.proximoSeguimiento > porCliente[g.clienteId].proximoSeguimiento) porCliente[g.clienteId] = g;
        });
        const count = Object.values(porCliente).filter(g => g.proximoSeguimiento <= hoyStr).length;
        setAlertasCxC(count);
      } catch { setAlertasCxC(0); }
    };
    cargarAlertas();
    const interval = setInterval(cargarAlertas, 60000);
    return () => clearInterval(interval);
  }, [user]);

  const handleLoginSuccess = (userData) => {
    setUser(userData);
    setCurrentPage(DASHBOARD_INICIAL[userData.role] || 'admin');
  };

  const handleLogout = () => {
    ['token','user','empresaActiva'].forEach(k => localStorage.removeItem(k));
    setUser(null);
    setCurrentPage('admin');
  };

  const navigate = (key) => {
    if (PAGINAS_PRONTO.includes(key)) return;
    setCurrentPage(key);
    setSidebarOpen(false);
  };

  if (!user) return <Login onLoginSuccess={handleLoginSuccess} />;

  const grupos      = buildGrupos(user.role, user.modulos, user.superAdmin === true);
  const bnKeys      = BOTTOM_NAV[user.role] || ['admin'];
  const todosItems  = grupos.flatMap(g => g.items);
  const bnItems     = bnKeys.map(k => todosItems.find(i => i.key === k)).filter(Boolean);
  const iniciales   = getIniciales(user.nombre, user.email);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'Segoe UI', sans-serif", background: '#f5f7fb' }}>

      {/* Overlay móvil */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200 }}
        />
      )}

      {/* ══ SIDEBAR ══ */}
      <aside className={`c360-sidebar${sidebarOpen ? ' open' : ''}`}>

        {/* Logo Control360 + cerrar (móvil) */}
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <LogoControl360 width={150} height={44} />
          <button className="c360-sb-close" onClick={() => setSidebarOpen(false)} aria-label="Cerrar menú"
            style={{ width: 34, height: 34, borderRadius: 8, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', cursor: 'pointer', fontSize: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            ✕
          </button>
        </div>

        {/* Empresa activa */}
        {empresaActiva && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)' }}>
            {empresaActiva.logoUrl
              ? <img src={empresaActiva.logoUrl} alt="logo" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'contain', background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
              : <span style={{ fontSize: 18, flexShrink: 0 }}>🏢</span>
            }
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#e9d5ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{empresaActiva.name}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>NIT {empresaActiva.nit}</div>
            </div>
          </div>
        )}

        {/* Menú */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {grupos.map(g => (
            <div key={g.grupo}>
              <div style={{ padding: '14px 16px 4px', fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '1.5px', textTransform: 'uppercase' }}>
                {g.grupo}
              </div>
              {g.items.map(item => {
                const activo = currentPage === item.key;
                return (
                  <button
                    key={item.key}
                    className="sb-btn"
                    onClick={() => navigate(item.key)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                      padding: '9px 16px', border: 'none', background: 'transparent',
                      color: activo ? '#fff' : 'rgba(255,255,255,0.65)',
                      fontSize: 13, fontWeight: 500,
                      cursor: item.pronto ? 'default' : 'pointer',
                      borderLeft: activo ? '3px solid #a78bfa' : '3px solid transparent',
                      backgroundColor: activo ? 'rgba(167,139,250,0.2)' : 'transparent',
                      opacity: item.pronto ? 0.45 : 1,
                      transition: 'background 0.15s, color 0.15s',
                    }}
                  >
                    <span style={{ fontSize: 15, width: 20, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
                    <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
                    {item.key === 'cxc' && alertasCxC > 0 && (
                      <span style={{ background: '#dc2626', color: '#fff', borderRadius: '50%', minWidth: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, padding: '0 5px' }}>
                        {alertasCxC}
                      </span>
                    )}
                    {item.pronto && (
                      <span style={{ fontSize: 9, background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)', padding: '1px 6px', borderRadius: 10 }}>
                        pronto
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Footer usuario + salir */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(167,139,250,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#c4b5fd', flexShrink: 0 }}>
            {iniciales}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.nombre || user.email}</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'capitalize' }}>{user.role}</div>
          </div>
          <button onClick={handleLogout} title="Cerrar sesión" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.75)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
            ⏏ Salir
          </button>
        </div>
      </aside>

      {/* ══ ÁREA PRINCIPAL ══ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: '100vh' }}>

        {/* Topbar móvil (oculto en desktop por CSS) */}
        <header className="c360-mob-topbar">
          <button
            onClick={() => setSidebarOpen(true)}
            style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, padding: 0 }}
          >
            {[0,1,2].map(i => <span key={i} style={{ display: 'block', width: 16, height: 1.5, background: '#fff', borderRadius: 2 }} />)}
          </button>
          <div style={{ flex: 1 }}>
            <LogoControl360 width={130} height={38} />
          </div>
          {/* Ola 3 Bloque 3: campana de alertas en móvil */}
          {['admin', 'taller', 'tesoreria', 'comercial'].includes(user.role) && <CampanaAlertas />}
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(167,139,250,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#c4b5fd' }}>
            {iniciales}
          </div>
        </header>

        {/* Header desktop — Ola 3 Bloque 3 (mejora UX) */}
        <header className="c360-desk-topbar" style={{
          display: 'none',  // Por defecto oculto; CSS lo muestra en desktop (ver más abajo)
          padding: '10px 24px',
          background: '#fff',
          borderBottom: '1px solid #e5e7eb',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexShrink: 0
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1a2e' }}>
              {(() => {
                const h = new Date().getHours();
                const saludo = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
                return `${saludo}, ${user.nombre || user.email}`;
              })()}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>
              {new Date().toLocaleDateString('es-CO', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                timeZone: 'America/Bogota'
              })}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Campana de alertas — solo admin, taller, tesoreria, comercial */}
            {['admin', 'taller', 'tesoreria', 'comercial'].includes(user.role) && <CampanaAlertas />}
            <button onClick={handleLogout} title="Cerrar sesión" style={{
              background: '#f3f4f6', color: '#374151',
              border: '1px solid #e5e7eb', borderRadius: 8,
              padding: '8px 14px', cursor: 'pointer',
              fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 6
            }}>
              ⏏ Salir
            </button>
          </div>
        </header>

        {/* Módulo activo */}
        <main style={{ flex: 1 }}>
          {currentPage === 'admin' && user?.role === 'admin'      && <Dashboard user={user} />}
          {currentPage === 'admin' && user?.role === 'comercial'  && <DashboardComercial user={user} />}
          {currentPage === 'admin' && user?.role === 'mensajero'  && <DashboardMensajero user={user} />}
          {currentPage === 'admin' && user?.role === 'tesoreria'  && <DashboardTesoreria user={user} />}
          {currentPage === 'admin' && user?.role === 'taller'     && <DashboardTaller user={user} />}
          {currentPage === 'admin' && user?.role === 'visor'      && <Dashboard user={user} />}
          {currentPage === 'logistica'       && <GestionLogistica user={user} />}
                            {currentPage === 'taller'       && <GestionTaller user={user} />}
          {currentPage === 'config'       && user.role === 'admin' && <ConfigEmpresas user={user} />}
          {currentPage === 'usuarios'     && user.role === 'admin' && <GestionUsuarios user={user} />}
          {currentPage === 'clientes'     && <GestionClientes user={user} />}
          {currentPage === 'productos'    && <GestionProductos user={user} />}
          {currentPage === 'ordenes'      && <GestionOrdenes user={user} />}
          {currentPage === 'cotizaciones' && <GestionCotizaciones user={user} />}
          {currentPage === 'comercial'    && <ModuloComercial user={user} />}
          {currentPage === 'egresos'      && <GestionEgresos user={user} />}
          {currentPage === 'compras'      && <GestionCompras user={user} />}
          {currentPage === 'caja'         && <GestionCaja user={user} />}
          {currentPage === 'cxc'          && <GestionCxC user={user} />}
          {currentPage === 'cxp'          && <GestionCxP user={user} />}
          {currentPage === 'proveedores'  && <GestionProveedores user={user} />}
          {currentPage === 'qr'           && <GestionQR user={user} />}
          {currentPage === 'eri'          && user.role === 'admin' && <ModuloERI user={user} />}
          {currentPage === 'reportes'     && user.role === 'admin' && <ModuloReportes user={user} />}
          {currentPage === 'suscriptores' && user?.superAdmin === true && <PanelSuscriptores user={user} />}
        </main>

        {/* Bottom nav móvil (oculto en desktop por CSS) */}
        <nav className="c360-bottomnav">
          {bnItems.map(item => {
            const activo = currentPage === item.key;
            return (
              <button key={item.key} onClick={() => navigate(item.key)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, background: activo ? 'rgba(124,58,237,0.06)' : 'transparent', border: 'none', cursor: 'pointer', padding: '6px 4px' }}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
                <span style={{ fontSize: 9, fontWeight: 600, color: activo ? '#7c3aed' : '#9ca3af', lineHeight: 1 }}>{item.label}</span>
              </button>
            );
          })}
          <button onClick={() => setSidebarOpen(true)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 4px' }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>☰</span>
            <span style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', lineHeight: 1 }}>Más</span>
          </button>
        </nav>
      </div>
    </div>
  );
}

// build fix 
