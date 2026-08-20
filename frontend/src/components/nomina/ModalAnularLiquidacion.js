// ═══════════════════════════════════════════════════════════════════════════════
// ModalAnularLiquidacion.js — Corregir una liquidación ya hecha
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-ANULAR-LIQUIDACION-001
//
// No edita: ANULA y deja rehacer.
//
// Una liquidación es un documento que el trabajador firmó. Si se pudiera editar
// en silencio, el papel firmado diría una cosa y el sistema otra, sin rastro de
// qué cambió ni por qué. Anular deja el registro anulado con motivo y usuario, y
// la liquidación corregida nace con su propio número.
//
// El caso que lo destapó: la fecha de ingreso del trabajador estaba mal por
// cinco días y la liquidación quedó corta, sin forma de arreglarla.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState } from 'react';
import { S, Aviso, CampoPin, api, fmt, errorDe } from './nominaUI';

const ModalAnularLiquidacion = ({ liquidacion, onListo, onCerrar }) => {
  const [motivo, setMotivo] = useState('');
  const [pin, setPin] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const anular = async () => {
    setError('');
    if (motivo.trim().length < 10) return setError('Explicá la corrección con un poco más de detalle');
    if (pin.length !== 4) return setError('El PIN debe tener 4 dígitos');
    setGuardando(true);
    try {
      const r = await api.post(`/prestaciones/liquidacion/${liquidacion.id}/anular`, { motivo, pin });
      onListo(r.data);
    } catch (e) { setError(errorDe(e, 'No se pudo anular la liquidación')); }
    setGuardando(false);
  };

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onCerrar()}>
      <div style={S.modal(560)}>
        <div style={S.modalHeader}>
          <div>
            <h3 style={S.modalTitle}>Corregir liquidación {liquidacion.numero}</h3>
            <p style={S.cardSub}>
              {liquidacion.acta?.nombre} · {fmt(liquidacion.netoAPagar)} · retiro {liquidacion.fechaRetiro}
            </p>
          </div>
          <button onClick={onCerrar} style={S.closeBtn}>×</button>
        </div>

        <div style={S.modalBody}>
          <Aviso nivel="media" titulo="No se edita: se anula y se rehace" style={{ marginBottom: 14 }}>
            El acta que el trabajador firmó no puede cambiar en silencio. Esta liquidación queda
            anulada con tu motivo y tu usuario, y la corregida nace con su propio número.
          </Aviso>

          <div style={{ ...S.card, background: '#f8fafc', marginBottom: 14, padding: '14px 16px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>
              Qué se deshace
            </div>
            {[
              'Las provisiones vuelven a su saldo anterior',
              'Los anticipos quedan pendientes de cruce otra vez',
              'La cuenta por pagar se anula',
              `${liquidacion.acta?.nombre?.split(' ')[0] || 'El empleado'} vuelve a quedar activo`,
            ].map((t, i) => (
              <div key={i} style={{ fontSize: 12, color: '#475569', padding: '3px 0' }}>· {t}</div>
            ))}
          </div>

          <Aviso nivel="grave" style={{ marginBottom: 14 }}>
            Si ya le pagaste la cuenta por pagar, primero revertí ese pago desde <strong>CxP</strong>.
            Si no, la caja queda descuadrada.
          </Aviso>

          <div style={S.field}>
            <label style={S.label}>¿Por qué se corrige? *</label>
            <textarea style={{ ...S.input, height: 76, resize: 'vertical', fontFamily: 'inherit' }}
              value={motivo} onChange={e => setMotivo(e.target.value)}
              placeholder="Ej: la fecha de ingreso estaba mal, entró el 13 de junio y no el 18" />
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              Queda en auditoría junto a tu usuario y la fecha.
            </span>
          </div>

          <CampoPin value={pin} onChange={setPin} accion="La anulación" />

          {error && <Aviso nivel="grave" style={{ marginTop: 4 }}>{error}</Aviso>}

          <div style={S.modalFooter}>
            <button onClick={onCerrar} style={S.btnSecondary} disabled={guardando}>Cancelar</button>
            <button onClick={anular} style={{ ...S.btnPeligro, opacity: guardando ? 0.6 : 1 }} disabled={guardando}>
              {guardando ? 'Anulando…' : 'Anular y poder rehacerla'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModalAnularLiquidacion;
