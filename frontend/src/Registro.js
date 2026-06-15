// ============================================================
// Control360 — Registro de suscriptores (público)
// Ubicación: frontend/src/Registro.js
// Ruta: /registro (pública — no requiere auth)
// ============================================================

import React, { useState } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const PLANES = [
  {
    key:    'punto_venta',
    nombre: 'Punto de Venta',
    precio: '$50.000',
    desc:   'Para tiendas y comercios con productos y servicios sencillos.',
    items:  ['Dashboard y clientes','Órdenes de servicio','Cotizaciones','Caja con cierre diario','Egresos','Proveedores','1 usuario (admin)'],
  },
  {
    key:    'independiente',
    nombre: 'Independiente',
    precio: '$75.000',
    desc:   'Para quien maneja solo su empresa y necesita orden total.',
    popular: true,
    items:  ['Todo lo de Punto de Venta','Productos e inventario','CxC (cartera)','CxP','Reportes del negocio','Hasta 3 usuarios'],
  },
  {
    key:    'empresa',
    nombre: 'Empresa',
    precio: '$100.000',
    desc:   'Para operaciones con equipo: mensajeros, taller y varios roles.',
    items:  ['Todo lo de Independiente','Logística con rutas y evidencias','Taller con control por etapas','Telemercadeo y vencimientos','Usuarios ilimitados por rol','Rendimiento del equipo y alertas'],
  },
];

export default function Registro({ onRegistroExitoso }) {
  const [planSel, setPlanSel] = useState('empresa');
  const [paso,    setPaso]    = useState(1); // 1=elegir plan · 2=datos
  const [form,    setForm]    = useState({ nombre:'', empresa:'', email:'', password:'', confirmar:'', nit:'', telefono:'', ciudad:'' });
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const validar = () => {
    if (!form.nombre.trim()) return 'Ingresa tu nombre completo';
    if (!form.email.trim())  return 'Ingresa tu email';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'Email inválido';
    if (form.password.length < 8) return 'La contraseña debe tener mínimo 8 caracteres';
    if (form.password !== form.confirmar) return 'Las contraseñas no coinciden';
    return null;
  };

  const registrar = async () => {
    const err = validar();
    if (err) { setError(err); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/registro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, plan: planSel, email: form.email.trim().toLowerCase() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al registrarse');
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      if (onRegistroExitoso) onRegistroExitoso(data.user);
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  const inp = {
    width: '100%', padding: '11px 12px', borderRadius: 10,
    border: '1.5px solid #e5e7eb', fontSize: 14, outline: 'none',
    fontFamily: 'inherit', boxSizing: 'border-box',
  };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#0D1B2A 0%,#1e1b4b 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 16px 64px' }}>

      {/* Logo */}
      <div style={{ marginBottom: 28, textAlign: 'center' }}>
        <div style={{ fontSize: 28, fontWeight: 900, color: '#fff', fontFamily: 'sans-serif', letterSpacing: -1 }}>
          Control<span style={{ color: '#a78bfa' }}>360</span>
        </div>
        <div style={{ fontSize: 12, color: '#8b7fb8', marginTop: 4 }}>El sistema operativo de tu empresa</div>
      </div>

      {paso === 1 ? (
        /* ─── PASO 1: ELEGIR PLAN ─── */
        <div style={{ width: '100%', maxWidth: 860 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 800, margin: '0 0 6px' }}>Empieza gratis 14 días</h1>
            <p style={{ color: '#8b7fb8', fontSize: 13, margin: 0 }}>Sin tarjeta de crédito. Cancela cuando quieras.</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginBottom: 24 }}>
            {PLANES.map(p => (
              <div key={p.key} onClick={() => setPlanSel(p.key)} style={{
                background: planSel === p.key ? '#fff' : 'rgba(255,255,255,0.07)',
                borderRadius: 16, padding: '20px 18px', cursor: 'pointer',
                border: planSel === p.key ? '2.5px solid #a78bfa' : '2px solid rgba(255,255,255,0.1)',
                transition: 'all .2s', position: 'relative',
              }}>
                {p.popular && (
                  <div style={{ position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)', background: '#7c3aed', color: '#fff', fontSize: 10, fontWeight: 800, padding: '3px 12px', borderRadius: 99, letterSpacing: 1, whiteSpace: 'nowrap' }}>
                    ⭐ MÁS POPULAR
                  </div>
                )}
                <div style={{ fontWeight: 800, fontSize: 16, color: planSel === p.key ? '#1a1a2e' : '#fff', marginBottom: 4 }}>{p.nombre}</div>
                <div style={{ fontSize: 11, color: planSel === p.key ? '#6b7280' : '#8b7fb8', marginBottom: 12, lineHeight: 1.4 }}>{p.desc}</div>
                <div style={{ fontFamily: 'monospace', fontSize: 24, fontWeight: 900, color: planSel === p.key ? '#7c3aed' : '#a78bfa', marginBottom: 14 }}>
                  {p.precio}<span style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af' }}>/mes</span>
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {p.items.map((item, i) => (
                    <li key={i} style={{ fontSize: 12, color: planSel === p.key ? '#374151' : '#c4b5fd', padding: '3px 0', display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                      <span style={{ color: '#4ade80', flexShrink: 0 }}>✓</span>{item}
                    </li>
                  ))}
                </ul>
                {planSel === p.key && (
                  <div style={{ marginTop: 14, textAlign: 'center', background: '#7c3aed', color: '#fff', borderRadius: 8, padding: '8px 0', fontSize: 12, fontWeight: 800 }}>✓ Plan seleccionado</div>
                )}
              </div>
            ))}
          </div>

          <div style={{ textAlign: 'center' }}>
            <button onClick={() => setPaso(2)} style={{
              background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 12,
              padding: '14px 48px', fontSize: 15, fontWeight: 800, cursor: 'pointer',
            }}>
              Continuar con {PLANES.find(p => p.key === planSel)?.nombre} →
            </button>
            <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>
              ¿Ya tienes cuenta? <a href="/login" style={{ color: '#a78bfa', fontWeight: 700 }}>Ingresar</a>
            </div>
          </div>
        </div>

      ) : (
        /* ─── PASO 2: DATOS DE LA EMPRESA ─── */
        <div style={{ width: '100%', maxWidth: 460 }}>
          <div style={{ background: '#fff', borderRadius: 18, padding: '28px 28px 32px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>

            {/* Header del formulario */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              <button onClick={() => setPaso(1)} style={{ border: 'none', background: '#f3f4f6', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 14, color: '#6b7280' }}>←</button>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: '#1a1a2e' }}>Crea tu cuenta</div>
                <div style={{ fontSize: 11, color: '#7c3aed', fontWeight: 700 }}>
                  Plan {PLANES.find(p => p.key === planSel)?.nombre} · 14 días gratis
                </div>
              </div>
            </div>

            {/* Datos personales */}
            <div style={{ fontSize: 10, fontWeight: 800, color: '#9ca3af', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>Datos de acceso</div>

            <input placeholder="Nombre completo *" value={form.nombre} onChange={e => set('nombre', e.target.value)} style={{ ...inp, marginBottom: 8 }} />
            <input placeholder="Email *" type="email" value={form.email} onChange={e => set('email', e.target.value)} style={{ ...inp, marginBottom: 8 }} />
            <input placeholder="Contraseña (mínimo 8 caracteres) *" type="password" value={form.password} onChange={e => set('password', e.target.value)} style={{ ...inp, marginBottom: 8 }} />
            <input placeholder="Confirmar contraseña *" type="password" value={form.confirmar} onChange={e => set('confirmar', e.target.value)} style={{ ...inp, marginBottom: 18 }} />

            {/* Datos de la empresa */}
            <div style={{ fontSize: 10, fontWeight: 800, color: '#9ca3af', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>Datos de tu empresa (opcionales)</div>

            <input placeholder="Nombre de la empresa" value={form.empresa} onChange={e => set('empresa', e.target.value)} style={{ ...inp, marginBottom: 8 }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <input placeholder="NIT" value={form.nit} onChange={e => set('nit', e.target.value)} style={inp} />
              <input placeholder="Teléfono" value={form.telefono} onChange={e => set('telefono', e.target.value)} style={inp} />
            </div>
            <input placeholder="Ciudad" value={form.ciudad} onChange={e => set('ciudad', e.target.value)} style={{ ...inp, marginBottom: 18 }} />

            {error && (
              <div style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 8, padding: '10px 12px', fontSize: 12, fontWeight: 600, marginBottom: 14 }}>
                {error}
              </div>
            )}

            <button onClick={registrar} disabled={loading} style={{
              width: '100%', border: 'none', borderRadius: 12, padding: '14px 0',
              background: loading ? '#c4b5fd' : '#7c3aed', color: '#fff',
              fontWeight: 800, fontSize: 15, cursor: 'pointer',
            }}>
              {loading ? 'Creando tu cuenta...' : 'Empezar 14 días gratis 🚀'}
            </button>

            <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>
              Al registrarte aceptas nuestros <a href="/terminos" style={{ color: '#7c3aed' }}>Términos de uso</a>.
              Sin tarjeta de crédito. Sin contratos.
            </div>
          </div>

          <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: '#6b7280' }}>
            ¿Ya tienes cuenta? <a href="/login" style={{ color: '#a78bfa', fontWeight: 700 }}>Ingresar</a>
          </div>
        </div>
      )}
    </div>
  );
}
