// ============================================================
// Control360 — Pantalla de cuenta suspendida (SUSCRIPCION-BLOQUEO-001)
// Ubicación: frontend/src/SuscripcionSuspendida.js
// ============================================================
// Se muestra a pantalla completa cuando el backend responde
// 402 SUSCRIPCION_SUSPENDIDA o cuando /auth/suscripcion-estado
// dice `bloqueada: true`. No se puede cerrar.
//   · Admin del tenant: datos de pago + WhatsApp con el comprobante.
//   · Sub-usuarios: "contacta al administrador de tu empresa".
// Cada 60 s (y con el botón "Ya pagué, verificar") vuelve a
// consultar el estado; cuando la plataforma registra el pago, la
// app se restablece sola.
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const ADMIN_WHATSAPP = '573234152442';
const LANDING_PLANES = 'https://tucontrol360.com/#planes';

const PRECIO_PLAN = { punto_venta: '$50.000', independiente: '$75.000', empresa: '$100.000' };
const NOMBRE_PLAN = { punto_venta: 'Punto de Venta', independiente: 'Independiente', empresa: 'Empresa' };

const DATOS_PAGO = [
  ['Entidad',        process.env.REACT_APP_BANCO_ENTIDAD || 'Bancolombia'],
  ['Tipo de cuenta', process.env.REACT_APP_BANCO_TIPO    || 'Ahorros'],
  ['Número',         process.env.REACT_APP_BANCO_NUMERO  || '82986178216'],
  ['Titular',        process.env.REACT_APP_BANCO_NOMBRE  || 'Milena Botero'],
  ['CC',             process.env.REACT_APP_BANCO_CC      || '37390112'],
];

export default function SuscripcionSuspendida({ user, info, onRestablecida, onSalir }) {
  const [verificando, setVerificando] = useState(false);
  const [mensaje, setMensaje] = useState('');
  const [copiado, setCopiado] = useState('');
  const esAdmin = user?.role === 'admin';
  const plan = info?.plan;

  const verificar = useCallback(async (manual = false) => {
    if (manual) { setVerificando(true); setMensaje(''); }
    try {
      const r = await fetch(`${API}/auth/suscripcion-estado`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
      const d = r.ok ? await r.json() : null;
      if (d && d.bloqueada === false) { onRestablecida(); return; }
      if (manual) setMensaje('Aún no vemos el pago registrado. Si ya enviaste el comprobante, en unos minutos se activa.');
    } catch (e) {
      if (manual) setMensaje('No se pudo verificar en este momento. Intenta de nuevo.');
    } finally { if (manual) setVerificando(false); }
  }, [onRestablecida]);

  useEffect(() => {
    const t = setInterval(() => verificar(false), 60 * 1000);
    return () => clearInterval(t);
  }, [verificar]);

  const copiar = async (label, valor) => {
    try { await navigator.clipboard.writeText(String(valor)); setCopiado(label); setTimeout(() => setCopiado(''), 1500); } catch (e) { /* sin permiso */ }
  };

  const empresa = user?.empresa || user?.nombre || '';
  const msgWA = encodeURIComponent(`Hola Sandra, acabo de realizar el pago de mi suscripción Control360 — Plan ${NOMBRE_PLAN[plan] || plan || ''}. Te adjunto el comprobante. Empresa: ${empresa}`);
  const venceTxt = info?.fechaVencimiento ? new Date(`${info.fechaVencimiento}T12:00:00-05:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  return (
    <div style={S.fondo}>
      <div style={S.tarjeta}>
        <div style={S.marca}>
          <span style={S.logo}>◎</span>
          <span><b>Control</b> 360</span>
        </div>

        <div style={S.icono}>🔒</div>
        <h1 style={S.titulo}>Tu cuenta está suspendida</h1>
        <p style={S.texto}>
          {info?.motivo && !/vencida/i.test(info.motivo)
            ? info.motivo
            : <>La suscripción de <b>{empresa || 'tu empresa'}</b>{venceTxt ? <> venció el <b>{venceTxt}</b></> : ' venció'} y no hemos recibido el pago. Para proteger tu información, el acceso queda en pausa hasta ponerte al día.</>}
        </p>

        {esAdmin ? (
          <>
            <div style={S.planBox}>
              <div>
                <div style={S.planEt}>Tu plan</div>
                <div style={S.planNombre}>{NOMBRE_PLAN[plan] || plan || 'Sin plan'}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={S.planEt}>Valor mensual</div>
                <div style={S.planValor}>{PRECIO_PLAN[plan] || '—'}</div>
              </div>
            </div>

            <div style={S.pagoBox}>
              <div style={S.pagoTitulo}>Datos para la transferencia <span style={{ fontWeight: 500, color: '#9ca3af' }}>· toca para copiar</span></div>
              {DATOS_PAGO.map(([label, valor]) => (
                <button key={label} onClick={() => copiar(label, valor)} style={S.pagoFila}>
                  <span style={{ color: '#6b7280' }}>{label}</span>
                  <span style={{ fontWeight: 700, color: '#111827' }}>{copiado === label ? '✓ copiado' : valor}</span>
                </button>
              ))}
            </div>

            <a href={`https://wa.me/${ADMIN_WHATSAPP}?text=${msgWA}`} target="_blank" rel="noreferrer" style={S.btnWA}>
              📱 Enviar comprobante por WhatsApp
            </a>
            <div style={S.nota}>Apenas validemos tu pago, la app se restablece en pocos minutos. No tienes que hacer nada más: esta pantalla se cierra sola.</div>
          </>
        ) : (
          <div style={S.subUsuario}>
            <div style={{ fontWeight: 800, color: '#111827', marginBottom: 4 }}>Contacta al administrador de tu empresa</div>
            <div>La renovación la gestiona el administrador de {empresa || 'tu empresa'}. Cuando quede al día, podrás seguir trabajando normalmente.</div>
          </div>
        )}

        {mensaje && <div style={S.mensaje}>{mensaje}</div>}

        <div style={S.acciones}>
          <button onClick={() => verificar(true)} disabled={verificando} style={S.btnVerificar}>
            {verificando ? 'Verificando…' : '↻ Ya pagué, verificar ahora'}
          </button>
          {esAdmin && <a href={LANDING_PLANES} target="_blank" rel="noreferrer" style={S.link}>Ver planes</a>}
          <button onClick={onSalir} style={S.link}>Cerrar sesión</button>
        </div>
      </div>
    </div>
  );
}

const S = {
  fondo: { position: 'fixed', inset: 0, zIndex: 3000, background: 'linear-gradient(160deg, #1a1a2e 0%, #2d2a5a 60%, #4c1d95 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflowY: 'auto', fontFamily: "'Segoe UI', sans-serif" },
  tarjeta: { background: '#fff', borderRadius: 18, width: '100%', maxWidth: 480, padding: '28px 24px 22px', boxShadow: '0 30px 80px rgba(0,0,0,0.35)', margin: 'auto' },
  marca: { display: 'flex', alignItems: 'center', gap: 8, color: '#4c1d95', fontSize: 15, letterSpacing: 0.5 },
  logo: { display: 'inline-flex', width: 26, height: 26, borderRadius: '50%', background: '#4c1d95', color: '#fff', alignItems: 'center', justifyContent: 'center', fontSize: 14 },
  icono: { fontSize: 42, textAlign: 'center', margin: '18px 0 6px' },
  titulo: { fontSize: 22, fontWeight: 800, color: '#111827', textAlign: 'center', margin: '0 0 8px' },
  texto: { fontSize: 14, color: '#4b5563', textAlign: 'center', lineHeight: 1.55, margin: '0 0 18px' },
  planBox: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f5f3ff', borderRadius: 12, padding: '12px 14px', marginBottom: 12 },
  planEt: { fontSize: 10.5, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  planNombre: { fontWeight: 800, fontSize: 15, color: '#5b21b6' },
  planValor: { fontWeight: 800, fontSize: 18, color: '#5b21b6' },
  pagoBox: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 12, padding: '12px 14px', marginBottom: 14 },
  pagoTitulo: { fontSize: 11, fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  pagoFila: { width: '100%', display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13.5, background: 'transparent', border: 'none', borderBottomStyle: 'solid', cursor: 'pointer', textAlign: 'left' },
  btnWA: { display: 'block', textAlign: 'center', background: '#25D366', color: '#fff', borderRadius: 12, padding: '14px 0', fontWeight: 800, fontSize: 15, textDecoration: 'none' },
  nota: { fontSize: 12.5, color: '#6b7280', textAlign: 'center', marginTop: 10, lineHeight: 1.5 },
  subUsuario: { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '14px 16px', fontSize: 13.5, color: '#78350f', lineHeight: 1.5 },
  mensaje: { background: '#eff6ff', color: '#1e40af', borderRadius: 10, padding: '10px 12px', fontSize: 13, marginTop: 12, textAlign: 'center' },
  acciones: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 16 },
  btnVerificar: { width: '100%', background: '#111827', color: '#fff', border: 'none', borderRadius: 12, padding: '13px 0', fontWeight: 800, fontSize: 14, cursor: 'pointer' },
  link: { background: 'transparent', border: 'none', color: '#6b7280', fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline', padding: 4 }
};
// FIN SuscripcionSuspendida.js
