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
    incluirPrimaSemestreAnterior: false,
    empresaId: empresas[0]?.id || '',
    notas: '',
    pin: '',
  });
  // ✅ NOMINA-DEDUCCIONES-001 · el motor siempre aceptó estas listas, pero el
  // modal no tenía dónde escribirlas. Sin ellas no se podía descontar un
  // préstamo de nómina ni sumar una bonificación de retiro.
  const [otrasDeducciones, setOtrasDeducciones] = useState([]);
  const [otrosDevengados, setOtrosDevengados] = useState([]);
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
        incluirPrimaSemestreAnterior: form.incluirPrimaSemestreAnterior,
        otrasDeducciones: otrasDeducciones.filter(d => d.concepto && Number(d.valor) > 0),
        otrosDevengados: otrosDevengados.filter(d => d.concepto && Number(d.valor) > 0),
      });
      setData(r.data);
    } catch (e) { setError(errorDe(e, 'No se pudo calcular la liquidación')); setData(null); }
    setCargando(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empleado.id, form.fechaRetiro, form.motivo, form.diasVacacionesPendientes,
      form.fechaUltimasVacaciones, form.salarioBaseIndemnizacion, form.diasSalarioPendiente,
      form.fechaFinObra, form.incluirPrimaSemestreAnterior, otrasDeducciones, otrosDevengados]);

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
        incluirPrimaSemestreAnterior: form.incluirPrimaSemestreAnterior,
        otrasDeducciones: otrasDeducciones.filter(d => d.concepto && Number(d.valor) > 0),
        otrosDevengados: otrosDevengados.filter(d => d.concepto && Number(d.valor) > 0),
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

          {/* ═══════════════════════════════════════════════════════════════════
              ✅ FIX NOMINA-DIAS-PENDIENTES-001 — sale del acordeón
              ───────────────────────────────────────────────────────────────
              Estaba escondido en "Ajustes finos" con el valor por defecto
              equivocado: proponía los días TRABAJADOS del mes, no los que
              faltan por pagar. Con nómina quincenal eso es pagar 15 días de
              más. Es un campo que hay que mirar sí o sí, no esconderlo.
              ═══════════════════════════════════════════════════════════════ */}
          {data?.salarioPendiente && (
            <div style={{
              ...S.card, marginBottom: 14, padding: '14px 16px',
              background: '#eff6ff', border: '1px solid #bfdbfe',
            }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ ...S.field, marginBottom: 0, width: 130 }}>
                  <label style={S.label}>Días de salario por pagar</label>
                  <input type="number" min="0" max="30" style={S.input}
                    value={form.diasSalarioPendiente !== '' ? form.diasSalarioPendiente : data.salarioPendiente.dias}
                    onChange={e => set('diasSalarioPendiente', e.target.value)} />
                </div>
                <div style={{ flex: 1, minWidth: 220, fontSize: 11.5, color: '#1e40af', lineHeight: 1.6, paddingBottom: 4 }}>
                  {data.salarioPendiente.explica}
                  {data.salarioPendiente.ultimoPagado === 0 && (
                    <div style={{ marginTop: 5, fontWeight: 700 }}>
                      ⚠️ Revisá este número antes de confirmar: si pagás quincenal y ya cobró
                      la quincena, acá van solo los días posteriores.
                    </div>
                  )}
                </div>
              </div>
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
                  <label style={S.label}>Últimas vacaciones pagadas</label>
                  <input type="date" style={S.input} value={form.fechaUltimasVacacionesPagadas || ''}
                    onChange={e => set('fechaUltimasVacacionesPagadas', e.target.value)} />
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>Informativo, para tu control.</span>
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

          {/* ✅ NOMINA-ANTICIPOS-LIQUIDACION-001 — plata ya entregada */}
          {data?.anticipos && (data.anticipos.pendientes.length > 0 || data.anticipos.sospechosos.length > 0) && (
            <div style={{ ...S.card, marginBottom: 14, borderLeft: '4px solid #d97706' }}>
              <h4 style={{ ...S.cardTitle, marginBottom: 3 }}>Plata que ya se le entregó</h4>
              <p style={{ ...S.cardSub, marginBottom: 11 }}>
                Última oportunidad de recuperarla: el contrato termina hoy.
              </p>

              {data.anticipos.pendientes.length > 0 && (
                <div style={{ marginBottom: 11 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#15803d', marginBottom: 6 }}>
                    ✓ Se descuentan automáticamente · {fmt(data.anticipos.totalPendientes)}
                  </div>
                  {data.anticipos.pendientes.map(a => (
                    <div key={a.egresoId} style={{
                      display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12,
                      padding: '6px 11px', background: '#f0fdf4', borderRadius: 7, marginBottom: 4, color: '#166534',
                    }}>
                      <span>{a.numero} · {a.fecha} · {a.concepto}</span>
                      <strong style={{ whiteSpace: 'nowrap' }}>{fmt(a.valor)}</strong>
                    </div>
                  ))}
                </div>
              )}

              {data.anticipos.sospechosos.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#991b1b', marginBottom: 6 }}>
                    ⚠️ NO se descuentan · {fmt(data.anticipos.totalSospechosos)}
                  </div>
                  {data.anticipos.sospechosos.map(a => (
                    <div key={a.egresoId} style={{
                      display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12,
                      padding: '6px 11px', background: '#fef2f2', borderRadius: 7, marginBottom: 4, color: '#991b1b',
                    }}>
                      <span>{a.numero} · {a.fecha} · {a.concepto} <em>({a.categoria})</em></span>
                      <strong style={{ whiteSpace: 'nowrap' }}>{fmt(a.valor)}</strong>
                    </div>
                  ))}
                  <div style={{ fontSize: 11.5, color: '#991b1b', marginTop: 7, lineHeight: 1.6 }}>
                    Están a nombre de {empleado.nombre} pero <strong>nadie los marcó como anticipo</strong>,
                    así que el sistema no los puede cruzar. Andá a Egresos, editalos, marcá "Sí, es un
                    anticipo" y enlazalos al empleado — o descontalos a mano abajo.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ✅ NOMINA-DEDUCCIONES-001 — préstamos, embargos, bonificaciones */}
          {(() => {
            const Lista = ({ titulo, ayuda, items, setItems, color }) => (
              <div style={{ ...S.card, background: '#f8fafc', marginBottom: 14, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <h4 style={{ ...S.cardTitle, fontSize: 13 }}>{titulo}</h4>
                    <p style={{ ...S.cardSub, fontSize: 11.5 }}>{ayuda}</p>
                  </div>
                  <button type="button" style={S.btnMini}
                    onClick={() => setItems(x => [...x, { concepto: '', valor: '' }])}>
                    + Agregar
                  </button>
                </div>
                {items.map((it, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10 }}>
                    <div style={{ ...S.field, marginBottom: 0, flex: 2 }}>
                      <input style={S.input} placeholder="Concepto" value={it.concepto}
                        onChange={e => setItems(x => x.map((y, j) => j === i ? { ...y, concepto: e.target.value } : y))} />
                    </div>
                    <div style={{ ...S.field, marginBottom: 0, flex: 1 }}>
                      <input type="number" min="0" style={S.input} placeholder="0" value={it.valor}
                        onChange={e => setItems(x => x.map((y, j) => j === i ? { ...y, valor: e.target.value } : y))} />
                    </div>
                    <button type="button" style={{ ...S.btnMini, color, padding: '9px 11px' }}
                      onClick={() => setItems(x => x.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
              </div>
            );
            return (
              <>
                <Lista
                  titulo="Otras deducciones" color="#dc2626"
                  ayuda="Préstamos de nómina, embargos, libranzas, dotación no devuelta."
                  items={otrasDeducciones} setItems={setOtrasDeducciones} />
                <Lista
                  titulo="Otros devengados" color="#16a34a"
                  ayuda="Bonificaciones, comisiones pendientes, acuerdos de retiro."
                  items={otrosDevengados} setItems={setOtrosDevengados} />
              </>
            );
          })()}

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

                {/* ✅ NOMINA-PRIMA-SEMESTRE-001 — la prima del semestre cerrado.
                    El sistema no sabe si ya se pagó (venció el 30 de junio o el
                    20 de diciembre), así que la calcula y deja que el usuario
                    decida. Sin esta casilla quedaba invisible: no aparecía en
                    ninguna parte de la liquidación aunque se la siguieran
                    debiendo al trabajador. */}
                {L.primaSemestreAnterior && (
                  <div style={{
                    marginTop: 12, padding: '12px 15px', borderRadius: 10,
                    background: form.incluirPrimaSemestreAnterior ? '#f5f3ff' : '#fffbeb',
                    border: `1px solid ${form.incluirPrimaSemestreAnterior ? '#c4b5fd' : '#fde68a'}`,
                    display: 'flex', gap: 11, alignItems: 'flex-start',
                  }}>
                    <input type="checkbox" id="primaSemAnt"
                      checked={form.incluirPrimaSemestreAnterior}
                      onChange={e => set('incluirPrimaSemestreAnterior', e.target.checked)}
                      style={{ width: 18, height: 18, cursor: 'pointer', marginTop: 2, flexShrink: 0 }} />
                    <label htmlFor="primaSemAnt" style={{ cursor: 'pointer', flex: 1, minWidth: 0 }}>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between', gap: 10,
                        fontSize: 12.5, fontWeight: 800,
                        color: form.incluirPrimaSemestreAnterior ? '#6d28d9' : '#92400e',
                      }}>
                        <span>Prima del semestre anterior · {fmtNum(L.primaSemestreAnterior.dias)} días</span>
                        <span style={{ whiteSpace: 'nowrap' }}>{fmt(L.primaSemestreAnterior.valor)}</span>
                      </div>
                      <div style={{
                        fontSize: 11.5, marginTop: 5, lineHeight: 1.55,
                        color: form.incluirPrimaSemestreAnterior ? '#5b21b6' : '#92400e',
                      }}>
                        Venció el {L.primaSemestreAnterior.vencio}. Marcala solo si <strong>no se la pagaste</strong>.
                      </div>
                    </label>
                  </div>
                )}
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
