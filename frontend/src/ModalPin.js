// ═════════════════════════════════════════════════════════════════════════════
// ModalPin.js — Modal ÚNICO de autorización por PIN (Control360)
// ─────────────────────────────────────────────────────────────────────────────
// FIX PIN-UNICO-001
//
// Reemplaza a los modales sueltos que cada módulo tenía (uno pedía "PIN", otro
// pedía "contraseña", otro validaba contra un endpoint distinto). Desde ahora
// TODA acción sensible del sistema usa este mismo componente, y por tanto
// el MISMO PIN: el del usuario logueado (Gestión de Usuarios → "Mi PIN").
//
// Contrato importante (lo que evita el bug anterior):
//   El modal valida contra /users/verificar-pin SOLO para dar feedback
//   inmediato al usuario, pero DEVUELVE el PIN al componente padre, que está
//   OBLIGADO a enviarlo en el body de la petición real. El backend vuelve a
//   validar. Nunca se autoriza con una simple bandera local.
//
// Uso:
//   <ModalPin
//     accion="anular_egreso"
//     titulo="Anular egreso pagado"
//     advertencia="El dinero se devolverá a la caja. Queda en auditoría."
//     requiereMotivo
//     minMotivo={10}
//     onConfirmar={(pin, motivo) => anular(pin, motivo)}   // ← envía pin al backend
//     onCancelar={() => setModal(null)}
//   />
// ═════════════════════════════════════════════════════════════════════════════

import React, { useState } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

// Etiquetas legibles por acción — deben coincidir con MATRIZ_ACCIONES del
// backend (routes/_autorizacion.js). Solo son texto de UI.
export const ACCIONES = {
  cuadrar_egreso:       'Cuadrar egreso provisional',
  editar_egreso_pagado: 'Editar egreso ya pagado',
  anular_egreso:        'Anular egreso pagado',
  anular_orden:         'Anular orden de servicio',
  validar_pago:         'Validar pago electrónico',
  autorizar_cartera:    'Autorizar cliente bloqueado por cartera',
};

const S = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000, padding: 16 },
  card: { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' },
  head: { background: 'linear-gradient(135deg,#dc2626,#b91c1c)', padding: '18px 22px' },
  h3: { margin: 0, fontSize: 17, fontWeight: 800, color: '#fff' },
  sub: { margin: '4px 0 0', fontSize: 12.5, color: 'rgba(255,255,255,0.85)' },
  body: { padding: '20px 22px' },
  aviso: { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 14px', marginBottom: 18, fontSize: 13, color: '#991b1b', lineHeight: 1.5 },
  label: { fontSize: 13, fontWeight: 700, color: '#374151' },
  pinInput: (err) => ({ padding: '14px', border: err ? '2px solid #dc2626' : '2px solid #e5e7eb', borderRadius: 10, fontSize: 24, textAlign: 'center', letterSpacing: 12, outline: 'none', fontWeight: 800, width: '100%', boxSizing: 'border-box' }),
  textarea: { padding: '10px 12px', border: '2px solid #e5e7eb', borderRadius: 10, fontSize: 14, outline: 'none', height: 74, resize: 'vertical', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' },
  err: { fontSize: 13, color: '#dc2626', fontWeight: 600, marginTop: 6 },
  ayuda: { fontSize: 12, color: '#6b7280', marginTop: 10, lineHeight: 1.5 },
  fila: { display: 'flex', gap: 10, marginTop: 18 },
  btnGris: { flex: 1, padding: '11px', background: '#f3f4f6', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  btnRojo: (on) => ({ flex: 1, padding: '11px', background: on ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: 9, cursor: on ? 'pointer' : 'not-allowed', fontWeight: 700, fontSize: 14 }),
  campo: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 },
};

export default function ModalPin({
  accion,
  titulo,
  advertencia = '',
  detalle = null,            // nodo React opcional (resumen del documento afectado)
  requiereMotivo = false,
  minMotivo = 0,
  textoBoton = '🔐 Autorizar',
  onConfirmar,               // (pin, motivo) => Promise|void
  onCancelar,
}) {
  const [pin, setPin] = useState('');
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState('');
  const [codigo, setCodigo] = useState('');
  const [verificando, setVerificando] = useState(false);

  const listo = pin.length === 4 && (!requiereMotivo || motivo.trim().length >= minMotivo);

  const confirmar = async () => {
    if (pin.length !== 4) return setError('El PIN es de 4 dígitos');
    if (requiereMotivo && motivo.trim().length < Math.max(1, minMotivo)) {
      return setError(minMotivo > 1
        ? `El motivo debe tener al menos ${minMotivo} caracteres`
        : 'El motivo es obligatorio');
    }

    setVerificando(true); setError(''); setCodigo('');
    try {
      const token = localStorage.getItem('token');
      // Pre-validación: feedback inmediato + registro en auditoría.
      await axios.post(
        `${API}/users/verificar-pin`,
        { pin, accion },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // ✅ Clave: se ENTREGA el PIN al padre para que lo mande al backend real.
      await onConfirmar(pin, motivo.trim());
    } catch (e) {
      const d = (e && e.response && e.response.data) || {};
      setError(d.error || 'No se pudo verificar el PIN');
      setCodigo(d.codigo || '');
      if (d.codigo === 'PIN_INCORRECTO') setPin('');
    } finally {
      setVerificando(false);
    }
  };

  return (
    <div style={S.overlay}>
      <div style={S.card}>
        <div style={S.head}>
          <h3 style={S.h3}>🔐 {titulo || ACCIONES[accion] || 'Autorización requerida'}</h3>
          <p style={S.sub}>Usa tu PIN personal de 4 dígitos</p>
        </div>

        <div style={S.body}>
          {detalle}
          {advertencia ? <div style={S.aviso}>⚠️ {advertencia}</div> : null}

          <div style={S.campo}>
            <label style={S.label}>PIN (4 dígitos)</label>
            <input
              type="password" inputMode="numeric" maxLength={4} autoFocus
              value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError(''); }}
              onKeyDown={e => { if (e.key === 'Enter' && listo) confirmar(); }}
              placeholder="••••"
              style={S.pinInput(!!error)}
            />
          </div>

          {requiereMotivo && (
            <div style={S.campo}>
              <label style={S.label}>Motivo *</label>
              <textarea
                style={S.textarea}
                value={motivo}
                onChange={e => { setMotivo(e.target.value); setError(''); }}
                placeholder="Explica por qué realizas esta acción..."
              />
            </div>
          )}

          {error && <div style={S.err}>⚠️ {error}</div>}

          {codigo === 'SIN_PIN' && (
            <div style={S.ayuda}>
              💡 Tu usuario aún no tiene PIN. Un administrador puede asignarlo en{' '}
              <strong>Gestión de Usuarios → editar usuario → PIN</strong>. Si eres
              admin, usa el botón <strong>“Mi PIN”</strong> en esa misma pantalla.
            </div>
          )}
          {codigo === 'ROL_NO_AUTORIZADO' && (
            <div style={S.ayuda}>
              💡 Esta acción está reservada a otros roles. Pídele a un
              administrador que la autorice desde su usuario.
            </div>
          )}

          <div style={S.fila}>
            <button onClick={onCancelar} style={S.btnGris} disabled={verificando}>Cancelar</button>
            <button onClick={confirmar} disabled={!listo || verificando} style={S.btnRojo(listo && !verificando)}>
              {verificando ? 'Verificando...' : textoBoton}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
