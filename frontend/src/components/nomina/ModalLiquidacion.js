// ═══════════════════════════════════════════════════════════════════════════════
// ModalLiquidacion.js — Terminación de contrato: "¿cuánto cuesta hoy?"
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-LIQUIDACION-001
//
// Antes, retirar a un empleado era marcarlo inactivo. Su provisión acumulada
// quedaba huérfana en el balance y la indemnización se calculaba en una hoja
// aparte, si es que se calculaba.
//
// Esta pantalla hace lo que ningún competidor de gama media resuelve bien:
// mostrar el costo REAL de terminar un contrato ANTES de firmarlo, separando
// lo que ya está provisionado de lo que va a doler.
//
// LA SEPARACIÓN QUE IMPORTA
//   · Prestaciones  → ya causadas. Descargan el pasivo. No son gasto nuevo.
//   · Indemnización → nunca se provisiona. Es gasto del mes del despido.
// Confundirlas deja el pasivo corto y el resultado inflado.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useCallback } from 'react';
import { S, Aviso, CampoPin, api, fmt, fmtNum, hoyISO, errorDe } from './nominaUI';

const ModalLiquidacion = ({ empleado, catalogos, empresas = [], onListo, onCerrar }) => {
  const [form, setForm] = useState({
    fechaRetiro: hoyISO(),
    motivo: 'sin_justa_causa',
    diasVacacionesPendientes: '',
    fechaUltimasVacaciones: '',
    salarioBaseIndemnizacion: '',
    diasSalarioPendiente: '',
    fechaFinObra: '',
    empresaId: empresas[0]?.id || '',
    notas: '',
    pin: '',
  });
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const [confirmando, setConfirmando] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const motivos = catalogos?.motivosTerminacion || [];
  const motivoActual = motivos.find(m => m.id === form.motivo);

  const cargarPreview = useCallback(async () => {
    if (!form.fechaRetiro) return;
    setCargando(true); setError('');
    try {
      const r = await api.post(`/prestaciones/liquidacion/${empleado.id}/preview`, {
        fechaRetiro: form.fechaRetiro,
        motivo: form.motivo,
        diasVacacionesPendientes: form.diasVacacionesPendientes || undefined,
        fechaUltimasVacaciones: form.fechaUltimasVacaciones || undefined,
        salarioBaseIndemnizacion: form.salarioBaseIndemnizacion || undefined,
        diasSalarioPendiente: form.diasSalarioPendiente || undefined,
        fechaFinObra: form.fechaFinObra || undefined,
      });
      setData(r.data);
    } catch (e) { setError(errorDe(e, 'No se pudo calcular la liquidación')); setData(null); }
    setCargando(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empleado.id, form.fechaRetiro, form.motivo, form.diasVacacionesPendientes,
      form.fechaUltimasVacaciones, form.salarioBaseIndemnizacion, form.diasSalarioPendiente, form.fechaFinObra]);

  useEffect(() => {
    const t = setTimeout(cargarPreview, 400);
    return () => clearTimeout(t);
  }, [cargarPreview]);

  const confirmar = async () => {
    setError('');
    if (form.pin.length !== 4) return setError('El PIN debe tener 4 dígitos');
    setGuardando(true);
    try {
      const r = await api.post(`/prestaciones/liquidacion/${empleado.id}`, {
        ...form,
        diasVacacionesPendientes: form.diasVacacionesPendientes || undefined,
        fechaUltimasVacaciones: form.fechaUltimasVacaciones || undefined,
        salarioBaseIndemnizacion: form.salarioBaseIndemnizacion || undefined,
        diasSalarioPendiente: form.diasSalarioPendiente || undefined,
        fechaFinObra: form.fechaFinObra || undefined,
      });
      onListo(r.data);
    } catch (e) { setError(errorDe(e, 'No se pudo liquidar el contrato')); }
    setGuardando(false);
  };

  const L = data?.liquidacion;
  const C = data?.comparacion;
  const pre = data?.preaviso;
  const esFijo = empleado.tipoContrato === 'fijo';
  const esObra = empleado.tipoContrato === 'obra_labor';

  const Fila = ({ label, valor, sub, negativo, destacado }) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
      padding: '9px 0', borderBottom: '1px solid #f1f5f9',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: destacado ? 800 : 600, color: '#334155' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      <div style={{
        fontSize: destacado ? 15 : 13, fontWeight: 800, whiteSpace: 'nowrap',
        color: negativo ? '#dc2626' : (destacado ? '#0f172a' : '#334155'),
      }}>
        {negativo ? '−' : ''}{fmt(Math.abs(valor || 0))}
      </div>
    </div>
  );

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onCerrar()}>
      <div style={S.modal(760)}>
        <div style={S.modalHeader}>
          <div>
            <h3 style={S.modalTitle}>Liquidar contrato · {empleado.nombre}</h3>
            <p style={S.cardSub}>
              {empleado.cargo ? `${empleado.cargo} · ` : ''}Ingreso {empleado.fechaInicio || '—'}
              {esFijo && empleado.fechaFin ? ` · vence ${empleado.fechaFin}` : ''}
            </p>
          </div>
          <button onClick={onCerrar} style={S.closeBtn}>×</button>
        </div>

        <div style={S.modalBody}>
          {/* ── Preaviso de término fijo ─────────────────────────────────── */}
          {pre && (pre.preavisoVencido || pre.enVentana || pre.vencido) && (
            <Aviso nivel={pre.preavisoVencido || pre.vencido ? 'grave' : 'media'}
              titulo="Preaviso de término fijo · art. 46 CST" style={{ marginBottom: 14 }}>
              {pre.mensaje}
            </Aviso>
          )}

          {/* ── Parámetros ───────────────────────────────────────────────── */}
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Fecha de retiro *</label>
              <input type="date" style={S.input} value={form.fechaRetiro}
                onChange={e => set('fechaRetiro', e.target.value)} />
            </div>
            <div style={S.field}>
              <label style={S.label}>Motivo de terminación *</label>
              <select style={S.input} value={form.motivo} onChange={e => set('motivo', e.target.value)}>
                {motivos.map(m => <option key={m.id} value={m.id}>{m.etiqueta}</option>)}
              </select>
            </div>
          </div>

          {motivoActual && (
            <div style={{ fontSize: 11.5, color: '#64748b', marginTop: -6, marginBottom: 14, lineHeight: 1.55 }}>
              {motivoActual.descripcion}
              {motivoActual.generaIndemnizacion && (
                <strong style={{ color: '#dc2626' }}> · Genera indemnización del art. 64 CST.</strong>
              )}
            </div>
          )}

          <details style={{ marginBottom: 14 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: '#4f46e5', padding: '6px 0' }}>
              Ajustes finos (vacaciones, salario pendiente, base de indemnización)
            </summary>
            <div style={{ paddingTop: 10 }}>
              <div style={S.row2}>
                <div style={S.field}>
                  <label style={S.label}>Últimas vacaciones disfrutadas</label>
                  <input type="date" style={S.input} value={form.fechaUltimasVacaciones}
                    onChange={e => set('fechaUltimasVacaciones', e.target.value)} />
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>Si está vacío, se cuenta desde el ingreso.</span>
                </div>
                <div style={S.field}>
                  <label style={S.label}>Días de vacaciones a compensar</label>
                  <input type="number" min="0" style={S.input} value={form.diasVacacionesPendientes}
                    onChange={e => set('diasVacacionesPendientes', e.target.value)} placeholder="Automático" />
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>Solo si querés fijarlos a mano.</span>
                </div>
              </div>
              <div style={S.row2}>
                <div style={S.field}>
                  <label style={S.label}>Días de salario pendientes</label>
                  <input type="number" min="0" max="30" style={S.input} value={form.diasSalarioPendiente}
                    onChange={e => set('diasSalarioPendiente', e.target.value)} placeholder="Automático" />
                </div>
                <div style={S.field}>
                  <label style={S.label}>Base para la indemnización</label>
                  <input type="number" min="0" style={S.input} value={form.salarioBaseIndemnizacion}
                    onChange={e => set('salarioBaseIndemnizacion', e.target.value)} placeholder="Salario actual" />
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>
                    Si hay comisiones o extras habituales, usá el promedio del último año.
                  </span>
                </div>
              </div>
              {esObra && (
                <div style={S.field}>
                  <label style={S.label}>Fecha estimada de terminación de la obra</label>
                  <input type="date" style={S.input} value={form.fechaFinObra}
                    onChange={e => set('fechaFinObra', e.target.value)} />
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>
                    Sin ella se aplica el mínimo legal de 15 días.
                  </span>
                </div>
              )}
            </div>
          </details>

          {cargando && <div style={{ fontSize: 12.5, color: '#94a3b8', padding: '10px 0' }}>Calculando liquidación…</div>}

          {/* ── Resultado ────────────────────────────────────────────────── */}
          {L && !cargando && (
            <>
              <div style={{ ...S.card, marginBottom: 14 }}>
                <h4 style={{ ...S.cardTitle, marginBottom: 3 }}>Prestaciones causadas</h4>
                <p style={{ ...S.cardSub, marginBottom: 10 }}>
                  Esto el empleado ya se lo ganó. Descarga el pasivo — no es gasto nuevo.
                </p>
                {Object.entries(L.prestaciones || {}).map(([k, p]) => (
                  <Fila key={k} label={p.etiqueta} valor={p.valor}
                    sub={`${p.dias != null ? `${fmtNum(p.dias)} días · ` : ''}${p.explica || ''}`} />
                ))}
                <Fila label="Total prestaciones" valor={L.totalPrestaciones} destacado />
              </div>

              {(L.salarioPendiente > 0 || L.auxilioPendiente > 0 || L.indemnizacion) && (
                <div style={{ ...S.card, marginBottom: 14, borderLeft: '4px solid #dc2626' }}>
                  <h4 style={{ ...S.cardTitle, marginBottom: 3 }}>Gasto nuevo del período</h4>
                  <p style={{ ...S.cardSub, marginBottom: 10 }}>
                    Esto no estaba provisionado. Golpea el resultado del mes en que liquidás.
                  </p>
                  {L.salarioPendiente > 0 && (
                    <Fila label={`Salario pendiente (${L.diasSalarioPendiente} días)`} valor={L.salarioPendiente} />
                  )}
                  {L.auxilioPendiente > 0 && (
                    <Fila label="Auxilio de transporte pendiente" valor={L.auxilioPendiente} />
                  )}
                  {L.indemnizacion && L.indemnizacion.valor > 0 && (
                    <Fila
                      label={`Indemnización · ${fmtNum(L.indemnizacion.dias, 2)} días`}
                      valor={L.indemnizacion.valor}
                      sub={`${L.indemnizacion.formula} — ${L.indemnizacion.fundamento}`}
                      destacado />
                  )}
                  {L.indemnizacion && L.indemnizacion.aplica && L.indemnizacion.valor === 0 && (
                    <Aviso nivel="info">{L.indemnizacion.formula}</Aviso>
                  )}
                </div>
              )}

              {L.deducciones?.length > 0 && (
                <div style={{ ...S.card, marginBottom: 14 }}>
                  <h4 style={{ ...S.cardTitle, marginBottom: 10 }}>Deducciones</h4>
                  {L.deducciones.map((d, i) => (
                    <Fila key={i} label={d.etiqueta} valor={d.valor} sub={d.fundamento} negativo />
                  ))}
                  <Fila label="Total deducciones" valor={L.totalDeducciones} negativo destacado />
                </div>
              )}

              <div style={{
                background: 'linear-gradient(135deg,#4f46e5,#4338ca)', borderRadius: 14,
                padding: '18px 22px', color: '#fff', marginBottom: 14,
              }}>
                <div style={{ fontSize: 11.5, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  Neto a pagar al empleado
                </div>
                <div style={{ fontSize: 30, fontWeight: 800, marginTop: 5, lineHeight: 1.1 }}>
                  {fmt(L.netoAPagar)}
                </div>
                <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 7, lineHeight: 1.55 }}>
                  Queda como Cuenta por Pagar a nombre de {empleado.nombre}. El dinero sale cuando
                  la pagues desde el módulo CxP.
                </div>
              </div>

              {/* ── Contraste con lo provisionado ─────────────────────────── */}
              {C && (
                <div style={{ ...S.card, background: '#f8fafc', marginBottom: 14 }}>
                  <h4 style={{ ...S.cardTitle, marginBottom: 3 }}>¿Alcanza lo provisionado?</h4>
                  <p style={{ ...S.cardSub, marginBottom: 11 }}>
                    La prueba de fuego de si venías causando bien.
                  </p>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={S.th}>Concepto</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Liquidación</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Provisionado</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Falta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {C.porConcepto.map(c => (
                        <tr key={c.clave}>
                          <td style={S.td}>{c.etiqueta}</td>
                          <td style={S.tdNum}>{fmt(c.liquidacion)}</td>
                          <td style={S.tdNum}>{fmt(c.pasivo)}</td>
                          <td style={{ ...S.tdNum, color: c.faltante > 0 ? '#dc2626' : '#16a34a' }}>
                            {c.faltante > 0 ? fmt(c.faltante) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {C.gastoAdicionalPorDefectoDeProvision > 0 && (
                    <Aviso nivel="media" style={{ marginTop: 11 }}>
                      Faltan <strong>{fmt(C.gastoAdicionalPorDefectoDeProvision)}</strong> de provisión.
                      Esa diferencia entra como gasto de este mes.
                    </Aviso>
                  )}
                </div>
              )}

              {(L.avisos || []).map((a, i) => (
                <Aviso key={i} nivel={a.nivel} style={{ marginBottom: 10 }}>{a.texto}</Aviso>
              ))}
            </>
          )}

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
              placeholder="Acta de terminación, acuerdo…" />
          </div>

          {error && <Aviso nivel="grave" style={{ marginBottom: 10 }}>{error}</Aviso>}

          {/* ── Confirmación en dos pasos: esto retira al empleado ───────── */}
          {!confirmando ? (
            <div style={S.modalFooter}>
              <button onClick={onCerrar} style={S.btnSecondary}>Cerrar</button>
              <button onClick={() => setConfirmando(true)} style={S.btnPeligro} disabled={!L || cargando}>
                Liquidar y retirar a {empleado.nombre?.split(' ')[0]}
              </button>
            </div>
          ) : (
            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 16, marginTop: 18 }}>
              <Aviso nivel="grave" titulo="Esta acción retira al empleado" style={{ marginBottom: 14 }}>
                Se genera la Cuenta por Pagar, se descarga el pasivo provisionado y {empleado.nombre} queda
                inactivo con fecha de retiro {form.fechaRetiro}. Queda registrado en auditoría.
              </Aviso>
              <CampoPin value={form.pin} onChange={v => set('pin', v)} accion="La liquidación" />
              <div style={S.modalFooter}>
                <button onClick={() => setConfirmando(false)} style={S.btnSecondary} disabled={guardando}>Volver</button>
                <button onClick={confirmar} style={{ ...S.btnPeligro, opacity: guardando ? 0.6 : 1 }} disabled={guardando}>
                  {guardando ? 'Liquidando…' : `Confirmar liquidación de ${fmt(L?.netoAPagar || 0)}`}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModalLiquidacion;
