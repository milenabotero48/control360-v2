// ═══════════════════════════════════════════════════════════════════════════════
// ModalPagoPILA.js — Registrar el pago de la planilla de seguridad social
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-RETENCION-001 · Fase 3
//
// SOLO SE USA CON LA CAUSACIÓN ENCENDIDA. Con el interruptor apagado (el estado
// por defecto) la PILA se digita como un egreso normal con categoría "Nómina"
// desde el módulo de Egresos, y esta pantalla no aparece.
//
// LAS DOS BOLSAS
// --------------
// En el extracto bancario la planilla es un solo débito, pero contablemente son
// dos cosas distintas:
//
//   · RETENCIÓN AL TRABAJADOR — salud, pensión y FSP que se le descontaron del
//     pago. Esa plata nunca fue de la empresa: estaba guardada.
//   · APORTES PATRONALES — pensión, caja y ARL a cargo de la empresa. Costo
//     propio, ya causado como gasto con la nómina del mes.
//
// Ninguna de las dos es gasto AL PAGAR: las dos descargan pasivo.
//
// CON NÓMINA QUINCENAL
// --------------------
// Se retiene el 15 y el 30, y se consigna una sola vez a comienzos del mes
// siguiente. El descargue va FIFO por fecha de comprobante, así que las
// quincenas más viejas se saldan primero.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState } from 'react';
import { S, Aviso, CampoPin, api, fmt, hoyISO, errorDe } from './nominaUI';

const ModalPagoPILA = ({ pila, cajas = [], empresas = [], onListo, onCerrar }) => {
  const sugerido = Math.round(pila?.totalAPagar || 0);
  const [form, setForm] = useState({
    monto: sugerido > 0 ? String(sugerido) : '',
    cajaId: '',
    formaPago: '',
    empresaId: empresas[0]?.id || '',
    fecha: hoyISO(),
    operador: '',
    notas: '',
    pin: '',
  });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const monto = Number(form.monto) || 0;
  const saldoRetencion = pila?.retencionEmpleado?.saldo || 0;
  const saldoPatronal = pila?.patronal?.saldo || 0;

  // El backend aplica primero la retención al trabajador y después los aportes
  // propios. Acá se refleja el mismo orden para que el usuario vea qué va a
  // pasar antes de confirmar.
  const aRetencion = Math.min(monto, saldoRetencion);
  const aPatronal = Math.min(Math.max(0, monto - aRetencion), saldoPatronal);
  const aGasto = Math.max(0, monto - aRetencion - aPatronal);

  const guardar = async () => {
    setError('');
    if (monto <= 0) return setError('El monto debe ser mayor a cero');
    if (!form.cajaId) return setError('Indicá desde qué caja o banco sale el pago');
    if (form.pin.length !== 4) return setError('El PIN debe tener 4 dígitos');
    setGuardando(true);
    try {
      const r = await api.post('/prestaciones/pila', { ...form, monto });
      onListo(r.data);
    } catch (e) { setError(errorDe(e, 'No se pudo registrar el pago de la planilla')); }
    setGuardando(false);
  };

  const Bolsa = ({ etiqueta, saldo, aplica, color, bg, borde, explica }) => (
    <div style={{ background: bg, border: `1px solid ${borde}`, borderRadius: 11, padding: '13px 15px' }}>
      <div style={{ ...S.kpiLabel, color }}>{etiqueta}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, marginTop: 4 }}>{fmt(aplica)}</div>
      <div style={{ fontSize: 11, color, opacity: 0.75, marginTop: 4 }}>
        de {fmt(saldo)} pendiente{aplica < saldo ? ` · queda ${fmt(saldo - aplica)}` : ''}
      </div>
      <div style={{ fontSize: 11, color, opacity: 0.8, marginTop: 6, lineHeight: 1.5 }}>{explica}</div>
    </div>
  );

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onCerrar()}>
      <div style={S.modal(660)}>
        <div style={S.modalHeader}>
          <div>
            <h3 style={S.modalTitle}>Pagar la planilla PILA</h3>
            <p style={S.cardSub}>
              Este pago <strong>no es gasto</strong>: descarga los dos pasivos que ya se causaron con la nómina.
            </p>
          </div>
          <button onClick={onCerrar} style={S.closeBtn}>×</button>
        </div>

        <div style={S.modalBody}>
          <div style={S.field}>
            <label style={S.label}>Monto de la planilla *</label>
            <input type="number" min="0" step="1" style={S.input}
              value={form.monto} onChange={e => set('monto', e.target.value)} placeholder="0" />
            {sugerido > 0 && (
              <button type="button" onClick={() => set('monto', String(sugerido))}
                style={{ ...S.btnMini, marginTop: 5, alignSelf: 'flex-start' }}>
                Usar el pendiente completo · {fmt(sugerido)}
              </button>
            )}
          </div>

          {/* Cómo se reparte, con el mismo orden que aplica el backend */}
          {monto > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0f172a', marginBottom: 3 }}>
                Cómo se reparte
              </div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 11, lineHeight: 1.55 }}>
                Se descarga primero lo retenido al trabajador. Si el pago no alcanza para todo,
                es preferible quedar debiendo plata propia que plata ajena.
              </div>
              <div style={S.grid(215)}>
                <Bolsa
                  etiqueta="1 · Retenido al trabajador" saldo={saldoRetencion} aplica={aRetencion}
                  color="#b91c1c" bg="#fef2f2" borde="#fecaca"
                  explica="Salud, pensión y FSP descontados del pago. No era plata de la empresa." />
                <Bolsa
                  etiqueta="2 · Aportes patronales" saldo={saldoPatronal} aplica={aPatronal}
                  color="#b45309" bg="#fffbeb" borde="#fde68a"
                  explica="Pensión, caja y ARL a cargo de la empresa. Ya causados como gasto." />
              </div>
              {aGasto > 0 && (
                <Aviso nivel="media" style={{ marginTop: 11 }}>
                  <strong>{fmt(aGasto)}</strong> del pago superan el pasivo causado. Ese excedente se
                  registra como gasto del período. Suele significar que falta causar algún mes,
                  o que la planilla incluye conceptos que el sistema no provisionó (intereses de mora,
                  correcciones de períodos anteriores).
                </Aviso>
              )}
              {aRetencion < saldoRetencion && monto > 0 && (
                <Aviso nivel="grave" style={{ marginTop: 11 }}>
                  Quedan <strong>{fmt(saldoRetencion - aRetencion)}</strong> retenidos al trabajador
                  sin consignar. Esa plata no es de la empresa.
                </Aviso>
              )}
            </div>
          )}

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Caja / banco *</label>
              <select style={S.input} value={form.cajaId} onChange={e => set('cajaId', e.target.value)}>
                <option value="">Seleccioná…</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} · {fmt(c.saldo)}</option>)}
              </select>
            </div>
            <div style={S.field}>
              <label style={S.label}>Forma de pago</label>
              <input style={S.input} value={form.formaPago} onChange={e => set('formaPago', e.target.value)}
                placeholder="Transferencia, PSE…" />
            </div>
          </div>

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Fecha del pago</label>
              <input type="date" style={S.input} value={form.fecha} onChange={e => set('fecha', e.target.value)} />
            </div>
            <div style={S.field}>
              <label style={S.label}>Operador</label>
              <input style={S.input} value={form.operador} onChange={e => set('operador', e.target.value)}
                placeholder="Aportes en Línea, SOI…" />
            </div>
          </div>

          {empresas.length > 1 && (
            <div style={S.field}>
              <label style={S.label}>Empresa</label>
              <select style={S.input} value={form.empresaId} onChange={e => set('empresaId', e.target.value)}>
                {empresas.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          )}

          <div style={S.field}>
            <label style={S.label}>Notas</label>
            <input style={S.input} value={form.notas} onChange={e => set('notas', e.target.value)}
              placeholder="Número de planilla, período…" />
          </div>

          <CampoPin value={form.pin} onChange={v => set('pin', v)} accion="El pago de la planilla" />

          {error && <Aviso nivel="grave" style={{ marginTop: 4 }}>{error}</Aviso>}

          <div style={S.modalFooter}>
            <button onClick={onCerrar} style={S.btnSecondary} disabled={guardando}>Cancelar</button>
            <button onClick={guardar} style={{ ...S.btnPago, opacity: guardando ? 0.6 : 1 }} disabled={guardando}>
              {guardando ? 'Registrando…' : `Registrar planilla de ${fmt(monto)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModalPagoPILA;
