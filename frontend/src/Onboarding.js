// ============================================================
// Control360 — Onboarding para nuevos suscriptores
// Ubicación: frontend/src/Onboarding.js
// ------------------------------------------------------------
// Aparece solo la primera vez que el admin ingresa.
// Se marca como visto en localStorage — no vuelve a aparecer.
// 4 pasos simples con botones que navegan al módulo correcto.
// No toca ningún módulo existente.
// ============================================================

import React, { useState } from 'react';

const PASOS = [
  {
    icono: '🏢',
    titulo: 'Configura tu empresa',
    desc: 'Agrega el nombre, logo, NIT y datos de contacto de tu empresa. Aparecerá en tus órdenes y cotizaciones.',
    accion: 'Ir a Mi Empresa',
    key: 'config',
    color: '#7c3aed',
  },
  {
    icono: '📦',
    titulo: 'Crea tu catálogo de productos',
    desc: 'Agrega los servicios y productos que ofreces con sus precios. Los seleccionarás al crear una orden.',
    accion: 'Ir a Productos',
    key: 'productos',
    color: '#0369a1',
  },
  {
    icono: '📋',
    titulo: 'Crea tu primera orden',
    desc: 'Registra tu primer cliente y su orden de servicio. Así arranca el flujo completo de tu operación.',
    accion: 'Crear primera orden',
    key: 'ordenes',
    color: '#15803d',
  },
  {
    icono: '👥',
    titulo: 'Invita a tu equipo',
    desc: 'Crea usuarios para tu mensajero, técnico de taller o equipo comercial. Cada uno ve solo lo que necesita.',
    accion: 'Ir a Usuarios',
    key: 'usuarios',
    color: '#b45309',
  },
];

export default function Onboarding({ user, onTerminar, onNavegar }) {
  const [paso, setPaso] = useState(0);

  const terminar = () => {
    localStorage.setItem(`c360_onboarding_${user?.id || 'done'}`, 'done');
    if (onTerminar) onTerminar();
  };

  const irA = (key) => {
    terminar();
    if (onNavegar) onNavegar(key);
  };

  const p = PASOS[paso];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,15,30,0.75)',
      zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460,
        padding: '28px 28px 24px', boxShadow: '0 24px 80px rgba(0,0,0,0.3)',
      }}>

        {/* Encabezado */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>
            Paso {paso + 1} de {PASOS.length}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 16 }}>
            {PASOS.map((_, i) => (
              <div key={i} style={{
                height: 4, width: i === paso ? 24 : 8, borderRadius: 99,
                background: i <= paso ? p.color : '#e5e7eb', transition: 'all .3s',
              }} />
            ))}
          </div>
          <div style={{ fontSize: 40, marginBottom: 10 }}>{p.icono}</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#1a1a2e', marginBottom: 8 }}>{p.titulo}</div>
          <div style={{ fontSize: 13.5, color: '#6b7280', lineHeight: 1.6 }}>{p.desc}</div>
        </div>

        {/* Botones */}
        <button onClick={() => irA(p.key)} style={{
          width: '100%', border: 'none', borderRadius: 12, padding: '13px 0',
          background: p.color, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer', marginBottom: 10,
        }}>
          {p.accion} →
        </button>

        <div style={{ display: 'flex', gap: 8 }}>
          {paso < PASOS.length - 1 ? (
            <>
              <button onClick={() => setPaso(paso + 1)} style={{
                flex: 1, border: '1.5px solid #e5e7eb', borderRadius: 10, padding: '10px 0',
                background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}>
                Siguiente →
              </button>
              <button onClick={terminar} style={{
                border: 'none', borderRadius: 10, padding: '10px 14px',
                background: '#f3f4f6', color: '#9ca3af', fontWeight: 600, fontSize: 12, cursor: 'pointer',
              }}>
                Omitir
              </button>
            </>
          ) : (
            <button onClick={terminar} style={{
              flex: 1, border: '1.5px solid #e5e7eb', borderRadius: 10, padding: '10px 0',
              background: '#fff', color: '#374151', fontWeight: 700, fontSize: 13, cursor: 'pointer',
            }}>
              ¡Listo, explorar el sistema!
            </button>
          )}
        </div>

        {/* Tip final */}
        <div style={{ marginTop: 14, fontSize: 11.5, color: '#9ca3af', textAlign: 'center', lineHeight: 1.5 }}>
          Puedes volver a esta guía desde el menú en cualquier momento.<br/>
          ¿Necesitas ayuda? Usa el botón de WhatsApp 💬
        </div>
      </div>
    </div>
  );
}
