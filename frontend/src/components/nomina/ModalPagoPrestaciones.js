// ═══════════════════════════════════════════════════════════════════════════════
// ModalPagoPrestaciones.js — Registrar un pago que DESCARGA el pasivo laboral
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PASIVO-001
//
// La pantalla que faltaba. Antes, para pagar la prima o consignar las cesantías
// había que digitarlas como un egreso con categoría "Nómina" — y eso contaba el
// gasto DOS VECES en el ERI, porque la provisión ya lo había causado mes a mes.
//
// Acá el pago no es gasto: descarga el pasivo. El preview muestra exactamente
// contra qué meses se va a aplicar antes de confirmar, porque este asiento toca
// el balance y el usuario tiene derecho a verlo antes de firmarlo.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useCallback } from 'react';
import { S, Aviso, CampoPin, api, fmt, hoyISO, errorDe, COLOR_CONCEPTO } from './nominaUI';

const ModalPagoPrestaciones = ({ catalogos, saldo, empleados = [], cajas = [], empresas = [], conceptoInicial, onListo, onCerrar }) => {
  const [form, setForm] = useState({
    concepto: conceptoInicial || 'cesantias',
    tipoPago: '',
    monto: '',
    empleadoId: '',
    cajaId: '',
    formaPago: '',
    empresaId: empresas[0]?.id || '',
    fecha: hoyISO(),
    beneficiario: '',
    notas: '',
    pin: '',
  });
  const [preview, setPreview] = useState(null);
  const [cargandoPreview, setCargandoPreview] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const conceptos = catalogos?.conceptos || [];
  const tiposPago = (catalogos?.tiposPago || []).filter(t => t.id !== 'liquidacion_contrato');
  const tiposValidos = tiposPago.filter(t => t.conceptos?.includes(form.concepto));
  const tipoActual = tiposPago.find(t => t.id === form.tipoPago);

  // El saldo disponible del concepto elegido — el techo natural del pago
  const saldoConcepto = form.empleadoId
    ? (saldo?.porEmpleado || []).find(e => e.empleadoId === form.empleadoId)?.saldo?.[form.concepto] || 0
    : saldo?.porConcepto?.[form.concepto] || 0;

  // Si el tipo de pago actual deja de ser válido al cambiar de concepto, se limpia
  useEffect(() => {
    if (form.tipoPago && !tiposValidos.some(t => t.id === form.tipoPago)) set('tipoPago', '');
    if (!form.tipoPago && tiposValidos.length === 1) set('tipoPago', tiposValidos[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.concepto, catalogos]);

  const pedirPreview = useCallback(async () => {
    const monto = Number(form.monto) || 0;
    if (monto <= 0) { setPreview(null); return; }
    setCargandoPreview(true);
    try {
      const r = await api.post('/prestaciones/pagar/preview', {
        concepto: form.concepto, monto, empleadoId: form.empleadoId || undefined,
      });
      setPreview(r.data);
    } catch (e) { setPreview(null); setError(errorDe(e, 'No se pudo calcular la aplicación del pago')); }
    setCargandoPreview(false);
  }, [form.concepto, form.monto, form.empleadoId]);

  // Debounce: el usuario está digitando el monto, no hay que pegarle al backend
  // en cada tecla.
  useEffect(() => {
    const t = setTimeout(pedirPreview, 450);
    return () => clearTimeout(t);
  }, [pedirPreview]);

  const guardar = async () => {
    setError('');
    if (!form.tipoPago) return setError('Elegí el tipo de pago');
    if ((Number(form.monto) || 0) <= 0) return setError('El monto debe ser mayor a cero');
    if (!form.cajaId) return setError('Indicá desde qué caja o banco sale el pago');
    if (form.pin.length !== 4) return setError('El PIN debe tener 4 dígitos');

    setGuardando(true);
    try {
      const r = await api.post('/prestaciones/pagar', {
        ...form, monto: Number(form.monto),
        empleadoId: form.empleadoId || undefined,
      });
      onListo(r.data);
    } catch (e) { setError(errorDe(e, 'No se pudo registrar el pago')); }
    setGuardando(false);
  };

  const color = COLOR_CONCEPTO[form.concepto] || '#7c3aed';

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onCerrar()}>
      <div style={S.modal(660)}>
        <div style={S.modalHeader}>
          <div>
            <h3 style={S.modalTitle}>Pagar prestaciones sociales</h3>
            <p style={S.cardSub}>
              Este pago <strong>no es gasto</strong>: descarga el pasivo que ya se causó mes a mes.
            </p>
          </div>
          <button onClick={onCerrar} style={S.closeBtn}>×</button>
        </div>

        <div style={S.modalBody}>
          {/* ── Concepto ─────────────────────────────────────────────────── */}
          <div style={S.field}>
            <label style={S.label}>¿Qué estás pagando? *</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
              {conceptos.map(c => {
                const activo = form.concepto === c.clave;
                const s = saldo?.porConcepto?.[c.clave] || 0;
                return (
                  <button key={c.clave} type="button"
                    onClick={() => { set('concepto', c.clave); setPreview(null); }}
                    style={{
                      padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                      border: activo ? `2px solid ${COLOR_CONCEPTO[c.clave]}` : '2px solid transparent',
                      background: activo ? `${COLOR_CONCEPTO[c.clave]}14` : '#f1f5f9',
                      color: activo ? COLOR_CONCEPTO[c.clave] : '#475569', textAlign: 'left',
                    }}>
                    <div>{c.etiqueta}</div>
                    <div style={{ fontSize: 10.5, fontWeight: 600, opacity: 0.8, marginTop: 2 }}>
                      PUC {c.cuentaPUC} · saldo {fmt(s)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Tipo de pago ─────────────────────────────────────────────── */}
          <div style={S.field}>
            <label style={S.label}>Tipo de pago *</label>
            <select style={S.input} value={form.tipoPago} onChange={e => set('tipoPago', e.target.value)}>
              <option value="">Seleccioná…</option>
              {tiposValidos.map(t => <option key={t.id} value={t.id}>{t.etiqueta}</option>)}
            </select>
            {tipoActual && (
              <span style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.5 }}>
                {tipoActual.descripcion}
                {tipoActual.fundamento && <><br /><em>{tipoActual.fundamento}</em></>}
              </span>
            )}
          </div>

          {/* ── Empleado y monto ─────────────────────────────────────────── */}
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Empleado</label>
              <select style={S.input} value={form.empleadoId} onChange={e => set('empleadoId', e.target.value)}>
                <option value="">Todos (pago consolidado)</option>
                {empleados.map(e => <option key={e.id} value={e.id}>{e.nombre}</option>)}
              </select>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>
                Dejalo en "Todos" para una consignación global al fondo.
              </span>
            </div>
            <div style={S.field}>
              <label style={S.label}>Monto pagado *</label>
              <input type="number" min="0" step="1" style={S.input}
                value={form.monto} onChange={e => set('monto', e.target.value)} placeholder="0" />
              <button type="button" onClick={() => set('monto', String(Math.round(saldoConcepto)))}
                style={{ ...S.btnMini, marginTop: 4, alignSelf: 'flex-start' }}>
                Usar el saldo completo · {fmt(saldoConcepto)}
              </button>
            </div>
          </div>

          {/* ── Preview de aplicación ────────────────────────────────────── */}
          {cargandoPreview && (
            <div style={{ fontSize: 12.5, color: '#94a3b8', padding: '8px 0' }}>Calculando aplicación…</div>
          )}
          {preview && !cargandoPreview && (
            <div style={{ ...S.card, background: '#f8fafc', padding: '15px 17px', marginBottom: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>
                Cómo se va a aplicar
              </div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 11, lineHeight: 1.55 }}>
                Se descarga desde el mes más antiguo hacia el más reciente: la obligación más vieja
                es la primera que se vuelve exigible.
              </div>

              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 11 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Descarga pasivo</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color }}>{fmt(preview.aplicado)}</div>
                </div>
                {preview.sobrante > 0 && (
                  <div>
                    <div style={{ fontSize: 10.5, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Va a gasto</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#dc2626' }}>{fmt(preview.sobrante)}</div>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 10.5, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Saldo después</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a' }}>{fmt(preview.saldoDespues)}</div>
                </div>
              </div>

              {preview.aplicaciones?.length > 0 && (
                <div style={{ maxHeight: 170, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 9, background: '#fff' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={S.th}>Mes</th>
                        <th style={S.th}>Empleado</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Se aplica</th>
                        <th style={{ ...S.th, textAlign: 'center' }}>Queda</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.aplicaciones.map((a, i) => (
                        <tr key={i}>
                          <td style={S.td}>{a.periodo}</td>
                          <td style={S.td}>{a.empleadoNombre || '—'}</td>
                          <td style={S.tdNum}>{fmt(a.aplicar)}</td>
                          <td style={{ ...S.td, textAlign: 'center' }}>
                            {a.quedaSaldada
                              ? <span style={{ color: '#16a34a', fontWeight: 700 }}>saldado</span>
                              : <span style={{ color: '#d97706', fontWeight: 700 }}>{fmt(a.causado - a.aplicadoDespues)}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {(preview.avisos || []).map((a, i) => (
                <Aviso key={i} nivel={a.nivel} style={{ marginTop: 10 }}>{a.texto}</Aviso>
              ))}
            </div>
          )}

          {/* ── Datos del pago ───────────────────────────────────────────── */}
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
                placeholder="Transferencia, Nequi…" />
            </div>
          </div>

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Fecha del pago</label>
              <input type="date" style={S.input} value={form.fecha} onChange={e => set('fecha', e.target.value)} />
            </div>
            <div style={S.field}>
              <label style={S.label}>Beneficiario</label>
              <input style={S.input} value={form.beneficiario} onChange={e => set('beneficiario', e.target.value)}
                placeholder="Fondo de cesantías, empleado…" />
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
              placeholder="Referencia de la consignación, planilla…" />
          </div>

          <CampoPin value={form.pin} onChange={v => set('pin', v)} accion="El pago" />

          {error && <Aviso nivel="grave" style={{ marginTop: 4 }}>{error}</Aviso>}

          <div style={S.modalFooter}>
            <button onClick={onCerrar} style={S.btnSecondary} disabled={guardando}>Cancelar</button>
            <button onClick={guardar} style={{ ...S.btnPago, opacity: guardando ? 0.6 : 1 }} disabled={guardando}>
              {guardando ? 'Registrando…' : `Registrar pago de ${fmt(Number(form.monto) || 0)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModalPagoPrestaciones;
