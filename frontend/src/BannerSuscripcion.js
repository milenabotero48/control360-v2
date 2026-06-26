// ============================================================
// Control360 — Banner de alerta de suscripción
// Ubicación: frontend/src/BannerSuscripcion.js
// ------------------------------------------------------------
// Aparece automáticamente cuando la suscripción del tenant
// está a 4 días o menos de vencer, o ya venció.
// No toca CampanaAlertas ni el sidebar — es independiente.
// ============================================================

import React, { useState, useEffect } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const LANDING_PLANES = 'https://tucontrol360.com/#planes';
const ADMIN_WHATSAPP = '573234152442';

const PRECIO_PLAN = {
  punto_venta:   '$50.000',
  independiente: '$75.000',
  empresa:       '$100.000',
};

const NOMBRE_PLAN = {
  punto_venta:   'Punto de Venta',
  independiente: 'Independiente',
  empresa:       'Empresa',
};

export default function BannerSuscripcion({ user }) {
  const [info,     setInfo]     = useState(null);  // { dias, plan, fechaVencimiento }
  const [abierto,  setAbierto]  = useState(false); // modal con datos de pago
  const [cerrado,  setCerrado]  = useState(false); // el usuario cerró el banner esta sesión

  // Solo admin ve el banner
  const esAdmin = user?.role === 'admin';

  useEffect(() => {
    if (!esAdmin) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    const verificar = async () => {
      try {
        const res = await fetch(`${API}/auth/suscripcion-estado`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        // Mostrar banner si quedan 4 días o menos (o ya venció)
        if (data.dias !== null && data.dias <= 4) setInfo(data);
      } catch (e) { /* silencioso */ }
    };

    verificar();
    // Re-verificar cada hora
    const t = setInterval(verificar, 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [esAdmin]);

  if (!info || cerrado) return null;

  const { dias, plan, fechaVencimiento } = info;
  const vencido  = dias < 0;
  const urgente  = dias <= 1 && !vencido;

  // Colores según urgencia
  const bg     = vencido ? '#fef2f2' : urgente ? '#fff8e6' : '#fefce8';
  const border = vencido ? '#fca5a5' : urgente ? '#fcd34d' : '#fde68a';
  const color  = vencido ? '#b91c1c' : urgente ? '#92400e' : '#854d0e';
  const icono  = vencido ? '⛔' : urgente ? '🔴' : '⚠️';

  const textoDias = vencido
    ? `Tu suscripción venció hace ${Math.abs(dias)} día(s)`
    : dias === 0
    ? 'Tu suscripción vence HOY'
    : `Tu suscripción vence en ${dias} día(s)`;

  const msgWA = encodeURIComponent(
    `Hola Sandra, acabo de realizar el pago de mi suscripción Control360 — Plan ${NOMBRE_PLAN[plan] || plan}. Te adjunto el comprobante.`
  );

  return (
    <>
      {/* ─── Banner principal ─── */}
      <div style={{
        background: bg, borderBottom: `2px solid ${border}`,
        padding: '10px 16px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
        position: 'sticky', top: 0, zIndex: 200,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>{icono}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color }}>
            {textoDias}
            {fechaVencimiento && !vencido && ` (${fechaVencimiento})`}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          <button onClick={() => setAbierto(true)} style={{
            background: color, color: '#fff', border: 'none', borderRadius: 8,
            padding: '7px 12px', fontSize: 12, fontWeight: 800, cursor: 'pointer',
          }}>
            💳 Ver datos de pago
          </button>
          <a href={LANDING_PLANES} target="_blank" rel="noreferrer" style={{
            background: 'transparent', color, border: `1.5px solid ${border}`,
            borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700,
            textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
          }}>
            ⬆ Actualizar plan
          </a>
          {!vencido && (
            <button onClick={() => setCerrado(true)} style={{
              background: 'transparent', border: 'none', color, cursor: 'pointer',
              fontSize: 16, padding: '4px 6px', fontWeight: 700,
            }}>✕</button>
          )}
        </div>
      </div>

      {/* ─── Modal con datos de pago ─── */}
      {abierto && (
        <div onClick={() => setAbierto(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 16, padding: '24px 24px 28px',
            width: '100%', maxWidth: 420, maxHeight: '90vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: '#1a1a2e' }}>💳 Renovar suscripción</div>
              <button onClick={() => setAbierto(false)} style={{ border: 'none', background: '#f3f4f6', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>

            {/* Info del plan */}
            <div style={{ background: '#f5f3ff', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>TU PLAN ACTUAL</div>
              <div style={{ fontWeight: 800, fontSize: 15, color: '#7c3aed' }}>{NOMBRE_PLAN[plan] || plan}</div>
              <div style={{ fontSize: 13, color: '#374151', marginTop: 2 }}>
                Valor mensual: <strong>{PRECIO_PLAN[plan] || 'Ver planes'}</strong>
              </div>
            </div>

            {/* Datos bancarios */}
            <div style={{ background: '#f9fafb', borderRadius: 10, padding: '14px 16px', marginBottom: 16, border: '1px solid #e5e7eb' }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#374151', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>Datos para la transferencia</div>
              {[
                ['Entidad',       process.env.REACT_APP_BANCO_ENTIDAD  || 'Bancolombia'],
                ['Tipo de cuenta',process.env.REACT_APP_BANCO_TIPO     || 'Ahorros'],
                ['Número',        process.env.REACT_APP_BANCO_NUMERO   || '82986178216'],
                ['Titular',       process.env.REACT_APP_BANCO_NOMBRE   || 'Milena Botero'],
                ['CC',            process.env.REACT_APP_BANCO_CC       || '37390112'],
              ].map(([label, valor]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>{label}</span>
                  <span style={{ fontWeight: 700, color: '#1a1a2e' }}>{valor}</span>
                </div>
              ))}
            </div>

            {/* Instrucción */}
            <div style={{ background: '#fff8e6', borderRadius: 10, padding: '12px 14px', marginBottom: 16, border: '1px solid #fde68a', fontSize: 12.5, color: '#78350f', lineHeight: 1.6 }}>
              📌 Realiza la transferencia y envíanos el comprobante por WhatsApp. Tu cuenta se activa en menos de 2 horas hábiles.
            </div>

            {/* Botones */}
            <a href={`https://wa.me/${ADMIN_WHATSAPP}?text=${msgWA}`} target="_blank" rel="noreferrer" style={{
              display: 'block', textAlign: 'center', background: '#25D366', color: '#fff',
              borderRadius: 10, padding: '13px 0', fontWeight: 800, fontSize: 14,
              textDecoration: 'none', marginBottom: 10,
            }}>
              📱 Enviar comprobante por WhatsApp
            </a>
            <a href={LANDING_PLANES} target="_blank" rel="noreferrer" style={{
              display: 'block', textAlign: 'center', background: '#f5f3ff', color: '#7c3aed',
              borderRadius: 10, padding: '12px 0', fontWeight: 700, fontSize: 13,
              textDecoration: 'none', border: '1.5px solid #c4b5fd',
            }}>
              ⬆ Actualizar mi plan
            </a>
          </div>
        </div>
      )}
    </>
  );
}
