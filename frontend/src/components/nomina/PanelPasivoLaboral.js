// ═══════════════════════════════════════════════════════════════════════════════
// PanelPasivoLaboral.js — Cuánto se le debe a los empleados, hoy
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PASIVO-001
//
// La pestaña que cierra el ciclo. Antes el módulo mostraba solo el pasivo
// CAUSADO, que nunca bajaba: se consignaban las cesantías en febrero y el saldo
// seguía completo. Acá se ve el pasivo REAL — causado menos pagado — y desde acá
// se registran los pagos que lo descargan.
//
// Muestra tres cosas y en este orden, porque es el orden en que importan:
//   1. Alertas que exigen acción (preavisos vencidos, meses sin causar)
//   2. Saldo por concepto, con el botón de pago al lado
//   3. Saldo por empleado, con la opción de liquidar
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useCallback } from 'react';
import { S, Aviso, api, fmt, errorDe, COLOR_CONCEPTO } from './nominaUI';
import ModalPagoPrestaciones from './ModalPagoPrestaciones';
import ModalLiquidacion from './ModalLiquidacion';
import ModalRetroactivas from './ModalRetroactivas';
import ModalPagoPILA from './ModalPagoPILA';
// ✅ NOMINA-ACTA-REIMPRESION-001: el acta se puede volver a imprimir cuando
// haga falta — copia para el trabajador, para el contador, o si se perdió.
import { imprimirActaLiquidacion } from './actaLiquidacion';
import ModalAnularLiquidacion from './ModalAnularLiquidacion';

const PanelPasivoLaboral = ({ empleados = [], cajas = [], empresas = [], onCambio }) => {
  const [saldo, setSaldo] = useState(null);
  const [catalogos, setCatalogos] = useState(null);
  const [alertas, setAlertas] = useState(null);
  const [pila, setPila] = useState(null);
  const [liquidaciones, setLiquidaciones] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [exito, setExito] = useState('');

  const cargar = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, c, a, p, l] = await Promise.all([
        api.get('/prestaciones/saldo'),
        api.get('/prestaciones/catalogos'),
        api.get('/prestaciones/alertas').catch(() => ({ data: null })),
        api.get('/prestaciones/pila').catch(() => ({ data: null })),
        api.get('/prestaciones/liquidaciones').catch(() => ({ data: null })),
      ]);
      setSaldo(s.data); setCatalogos(c.data); setAlertas(a.data); setPila(p.data);
      setLiquidaciones(l.data);
    } catch (e) { setError(errorDe(e, 'No se pudo cargar el pasivo laboral')); }
    setLoading(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const tras = (mensaje) => {
    setModal(null);
    setExito(mensaje);
    setTimeout(() => setExito(''), 6000);
    cargar();
    onCambio && onCambio();
  };

  const empleadosActivos = empleados.filter(e => e.activo !== false);
  const empleadoDe = (id) => empleados.find(e => e.id === id);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>⏳ Cargando pasivo laboral…</div>;
  if (error) return <Aviso nivel="grave">{error}</Aviso>;

  const conceptos = saldo?.conceptos || [];
  const hayPasivo = (saldo?.total || 0) > 0;

  return (
    <div>
      {exito && <Aviso nivel="info" style={{ marginBottom: 16 }}>✅ {exito}</Aviso>}

      {/* ═══════════════════════════════════════════════════════════════════
          ✅ CLARIDAD — cómo leer esta pantalla
          ───────────────────────────────────────────────────────────────────
          Acá conviven cuatro números que se parecen y significan cosas
          distintas. Decirlo una vez arriba evita la duda cada vez.
          ═══════════════════════════════════════════════════════════════ */}
      <details style={{ marginBottom: 16 }}>
        <summary style={{
          cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: '#4f46e5',
          padding: '9px 14px', background: '#eef2ff', borderRadius: 9,
          border: '1px solid #c7d2fe', listStyle: 'none',
        }}>
          Cómo leer esta pantalla
        </summary>
        <div style={{
          ...S.card, marginTop: 9, background: '#f8fafc', fontSize: 12.5,
          color: '#475569', lineHeight: 1.7,
        }}>
          {[
            ['Causado', 'Lo que se acumuló mes a mes como gasto y como deuda. Nunca baja: es la historia.'],
            ['Pagado', 'Lo que ya se entregó — consignaciones al fondo, primas, liquidaciones.'],
            ['Saldo', 'Causado menos pagado. Es lo que realmente le debés hoy a tus empleados.'],
            ['Costo de liquidar', 'Otra cosa. Lo calcula el botón Liquidar y casi nunca coincide con el saldo, porque el mes se causa completo aunque el retiro sea a mitad.'],
          ].map(([t, d]) => (
            <div key={t} style={{ marginBottom: 7 }}>
              <strong style={{ color: '#0f172a' }}>{t}.</strong> {d}
            </div>
          ))}
          <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px solid #e2e8f0', fontSize: 12 }}>
            <strong style={{ color: '#0f172a' }}>Los intereses a las cesantías</strong> son el 12% <em>anual</em>.
            En los primeros meses del año se ven pequeños comparados con las cesantías — eso es
            correcto: crecen con el saldo y llegan al 12% al completar el año.
          </div>
        </div>
      </details>

      {/* ── 1 · ALERTAS ─────────────────────────────────────────────────── */}
      {alertas?.alertas?.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {alertas.alertas.slice(0, 6).map(a => (
            <Aviso key={a.id} nivel={a.nivel} titulo={a.titulo} style={{ marginBottom: 9 }}>
              {a.texto}
              {a.tipo === 'provision_faltante' && (
                <div style={{ marginTop: 8 }}>
                  <button style={S.btnMini}
                    onClick={() => setModal({ tipo: 'retroactivas', empleado: empleadoDe(a.empleadoId) })}>
                    Causar los meses faltantes
                  </button>
                </div>
              )}
              {a.tipo === 'obligacion_laboral' && (
                <div style={{ marginTop: 8 }}>
                  <button style={S.btnMini} onClick={() => setModal({ tipo: 'pago', concepto: a.concepto })}>
                    Registrar el pago
                  </button>
                </div>
              )}
            </Aviso>
          ))}
        </div>
      )}

      {/* ── 2 · SALDO TOTAL ─────────────────────────────────────────────── */}
      <div style={{
        background: hayPasivo
          ? 'linear-gradient(135deg,#4f46e5,#4338ca)'
          : 'linear-gradient(135deg,#16a34a,#15803d)',
        borderRadius: 16, padding: '22px 26px', color: '#fff', marginBottom: 16,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontSize: 11.5, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            Le debés a tus empleados
          </div>
          <div style={{ fontSize: 34, fontWeight: 800, marginTop: 5, lineHeight: 1.1 }}>{fmt(saldo?.total)}</div>
          <div style={{ fontSize: 12, opacity: 0.85, marginTop: 7, lineHeight: 1.55, maxWidth: 520 }}>
            Causado {fmt(saldo?.causadoTotal)} · pagado {fmt(saldo?.pagadoTotal)}.
            Es plata que ya es del trabajador aunque todavía esté en tu cuenta.
          </div>
        </div>
        <button onClick={() => setModal({ tipo: 'pago' })}
          style={{
            padding: '12px 22px', background: 'rgba(255,255,255,0.18)', color: '#fff',
            border: '1.5px solid rgba(255,255,255,0.35)', borderRadius: 10,
            fontSize: 13.5, fontWeight: 700, cursor: 'pointer',
          }}>
          Registrar un pago
        </button>
      </div>

      {/* ── 3 · POR CONCEPTO ────────────────────────────────────────────── */}
      <div style={S.grid(215)}>
        {conceptos.map(c => {
          const color = COLOR_CONCEPTO[c.clave] || '#7c3aed';
          const pct = c.causado > 0 ? Math.round((c.pagado / c.causado) * 100) : 0;
          return (
            <div key={c.clave} style={S.kpi(color)}>
              <div style={S.kpiLabel}>{c.etiqueta}</div>
              <div style={S.kpiValue(color)}>{fmt(c.saldo)}</div>
              <div style={S.kpiHint}>PUC {c.cuentaPUC} · causado {fmt(c.causado)}</div>
              <div style={{ height: 5, background: '#f1f5f9', borderRadius: 3, marginTop: 9, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color, opacity: 0.55 }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 9 }}>
                <span style={{ fontSize: 10.5, color: '#94a3b8' }}>{pct}% pagado</span>
                {c.saldo > 0 && (
                  <button style={S.btnMini} onClick={() => setModal({ tipo: 'pago', concepto: c.clave })}>Pagar</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 4 · SEGURIDAD SOCIAL (Fase 3) ───────────────────────────────── */}
      {pila && (
        <div style={{ ...S.card, marginTop: 16, borderLeft: `4px solid ${pila.causacionActiva ? '#dc2626' : '#cbd5e1'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <h4 style={S.cardTitle}>
                Planilla PILA
                <span style={{
                  marginLeft: 9, fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20,
                  background: pila.causacionActiva ? '#fef2f2' : '#f1f5f9',
                  color: pila.causacionActiva ? '#991b1b' : '#64748b',
                }}>
                  {pila.causacionActiva ? 'CAUSACIÓN ACTIVA' : 'CAUSACIÓN APAGADA'}
                </span>
              </h4>
              <p style={{ ...S.cardSub, marginTop: 6 }}>{pila.nota}</p>
            </div>
            {pila.causacionActiva && (
              <div style={{ textAlign: 'right' }}>
                <div style={S.kpiLabel}>Total a consignar</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#dc2626', marginTop: 3 }}>
                  {fmt(pila.totalAPagar)}
                </div>
                {pila.totalAPagar > 0 && (
                  <button onClick={() => setModal({ tipo: 'pila' })}
                    style={{ ...S.btnPeligro, marginTop: 9, padding: '9px 18px', fontSize: 12.5 }}>
                    Pagar la planilla
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Las dos bolsas de la planilla. Separarlas importa: una es plata de
              la empresa, la otra es plata del trabajador que se está guardando. */}
          {pila.causacionActiva && (
            <div style={{ ...S.grid(230), marginTop: 14 }}>
              <div style={{ background: '#fef2f2', borderRadius: 11, padding: '13px 15px', border: '1px solid #fecaca' }}>
                <div style={{ ...S.kpiLabel, color: '#991b1b' }}>Retenido al trabajador</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#b91c1c', marginTop: 4 }}>
                  {fmt(pila.retencionEmpleado?.saldo)}
                </div>
                <div style={{ fontSize: 11, color: '#991b1b', opacity: 0.8, marginTop: 5, lineHeight: 1.5 }}>
                  Salud, pensión y FSP descontados del pago. <strong>Esta plata no es tuya</strong>:
                  está en tu caja hasta que consignes.
                </div>
              </div>
              <div style={{ background: '#fffbeb', borderRadius: 11, padding: '13px 15px', border: '1px solid #fde68a' }}>
                <div style={{ ...S.kpiLabel, color: '#92400e' }}>Aportes patronales</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#b45309', marginTop: 4 }}>
                  {fmt(pila.patronal?.saldo)}
                </div>
                <div style={{ fontSize: 11, color: '#92400e', opacity: 0.8, marginTop: 5, lineHeight: 1.5 }}>
                  Pensión, caja de compensación y ARL a cargo de la empresa. Costo propio,
                  ya causado como gasto.
                </div>
              </div>
            </div>
          )}

          {pila.notaQuincenal && (
            <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 12, lineHeight: 1.6, paddingTop: 11, borderTop: '1px solid #f1f5f9' }}>
              <strong style={{ color: '#475569' }}>Nómina quincenal:</strong> {pila.notaQuincenal}
            </div>
          )}

          {!pila.causacionActiva && (pila.calculadoSinCausar > 0 || pila.retencionEmpleado?.retenidoSinCausar > 0) && (
            <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 11, lineHeight: 1.6 }}>
              Informativo, calculado pero no causado como pasivo:
              aportes patronales {fmt(pila.calculadoSinCausar)} ·
              retenido al trabajador {fmt(pila.retencionEmpleado?.retenidoSinCausar)}.
              Se activa desde <strong>Ajustes</strong>, siguiendo el procedimiento de corte.
            </div>
          )}
        </div>
      )}

      {/* ── 5 · POR EMPLEADO ────────────────────────────────────────────── */}
      <div style={{ ...S.card, marginTop: 16, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px 12px' }}>
          <h4 style={S.cardTitle}>Pasivo por empleado</h4>
          {/* ✅ FIX: el subtítulo prometía "qué cuesta terminar el contrato" y
              el número mostrado es otra cosa — lo PROVISIONADO. Casi nunca
              coinciden: el mes se causa completo aunque el retiro sea a mitad,
              y los intereses se sobreprovisionan el primer año. El costo real
              de terminar sale al abrir Liquidar. */}
          <p style={S.cardSub}>
            Lo <strong>provisionado</strong> a la fecha, no lo que cuesta liquidar.
            El costo real de terminar un contrato lo calcula el botón <strong>Liquidar</strong>,
            que compara ambos y te dice si alcanza.
          </p>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                <th style={S.th}>Empleado</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Cesantías</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Intereses</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Prima</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Vacaciones</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Total</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {/* ✅ FIX NOMINA-EMPLEADO-INVISIBLE-001
                  La tabla se armaba solo con quienes YA tienen provisiones. El
                  empleado que más necesita causarlas —el que no tiene ninguna—
                  era justamente el que no aparecía, y sin fila no había botón
                  de Retroactivas para arreglarlo. Ahora se listan todos los
                  activos, con ceros si no tienen nada causado. */}
              {(() => {
                const conPasivo = saldo?.porEmpleado || [];
                const cero = { cesantias: 0, interesesCesantias: 0, prima: 0, vacaciones: 0 };
                const faltantes = empleadosActivos
                  .filter(emp => !conPasivo.some(e => e.empleadoId === emp.id))
                  .map(emp => ({
                    empleadoId: emp.id, nombre: emp.nombre, saldo: cero,
                    total: 0, periodos: 0, sinProvisiones: true,
                  }));
                return [...conPasivo, ...faltantes];
              })().map(e => {
                const emp = empleadoDe(e.empleadoId);
                return (
                  <tr key={e.empleadoId}>
                    <td style={S.td}>
                      <div style={{ fontWeight: 700, color: '#0f172a' }}>{e.nombre || '—'}</div>
                      <div style={{ fontSize: 10.5, color: e.sinProvisiones ? '#b45309' : '#94a3b8', marginTop: 2 }}>
                        {e.sinProvisiones
                          ? 'Sin provisiones causadas'
                          : `${e.periodos} mes(es) · ${e.primerPeriodo} a ${e.ultimoPeriodo}`}
                      </div>
                    </td>
                    <td style={S.tdNum}>{fmt(e.saldo.cesantias)}</td>
                    <td style={S.tdNum}>{fmt(e.saldo.interesesCesantias)}</td>
                    <td style={S.tdNum}>{fmt(e.saldo.prima)}</td>
                    <td style={S.tdNum}>{fmt(e.saldo.vacaciones)}</td>
                    <td style={{ ...S.tdNum, fontSize: 13.5, fontWeight: 800, color: '#4f46e5' }}>{fmt(e.total)}</td>
                    <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {emp && emp.activo !== false && (
                        <>
                          <button style={{ ...S.btnMini, marginRight: 5 }}
                            onClick={() => setModal({ tipo: 'retroactivas', empleado: emp })}>
                            Retroactivas
                          </button>
                          <button style={{ ...S.btnMini, color: '#b91c1c', borderColor: '#fecaca', background: '#fef2f2' }}
                            onClick={() => setModal({ tipo: 'liquidar', empleado: emp })}>
                            Liquidar
                          </button>
                        </>
                      )}
                      {emp && emp.activo === false && (
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>retirado</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {(!saldo?.porEmpleado || saldo.porEmpleado.length === 0) && (
                <tr>
                  <td colSpan={7} style={{ ...S.td, textAlign: 'center', color: '#94a3b8', padding: 30 }}>
                    Todavía no hay provisiones causadas. Causalas en la pestaña <strong>Provisiones</strong>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── LIQUIDACIONES REALIZADAS ────────────────────────────────────── */}
      {/* ✅ NOMINA-ACTA-REIMPRESION-001: el acta ya no vive solo en el momento
          de confirmar. Se puede reimprimir cuando haga falta. */}
      {liquidaciones?.liquidaciones?.length > 0 && (
        <div style={{ ...S.card, marginTop: 16, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '18px 20px 12px' }}>
            <h4 style={S.cardTitle}>Liquidaciones realizadas</h4>
            <p style={S.cardSub}>
              Volvé a imprimir el acta cuando la necesites: copia para el trabajador,
              para el contador, o si se perdió el papel.
            </p>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead>
                <tr>
                  <th style={S.th}>N°</th>
                  <th style={S.th}>Empleado</th>
                  <th style={S.th}>Retiro</th>
                  <th style={S.th}>Motivo</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Neto</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Acta</th>
                </tr>
              </thead>
              <tbody>
                {liquidaciones.liquidaciones.map(l => (
                  <tr key={l.id}>
                    <td style={S.td}>{l.numero}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: '#0f172a' }}>{l.acta.nombre}</td>
                    <td style={S.td}>{l.fechaRetiro}</td>
                    <td style={S.td}>{l.acta.motivoEtiqueta}</td>
                    <td style={S.tdNum}>{fmt(l.netoAPagar)}</td>
                    <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button style={{ ...S.btnMini, marginRight: 5 }}
                        onClick={() => imprimirActaLiquidacion({
                          liquidacion: l.acta,
                          empleado: {
                            nombre: l.acta.nombre, documento: l.acta.documento,
                            cargo: l.acta.cargo, tipoDocumento: l.acta.tipoDocumento,
                          },
                          empresa: empresas[0] || {},
                          numero: l.numero,
                        })}>
                        Imprimir
                      </button>
                      {/* ✅ NOMINA-ANULAR-LIQUIDACION-001: no es "editar" — se
                          anula con motivo y se rehace. El acta que el trabajador
                          firmó no puede cambiar en silencio. */}
                      <button style={{ ...S.btnMini, color: '#b91c1c', borderColor: '#fecaca', background: '#fef2f2' }}
                        onClick={() => setModal({ tipo: 'anular', liquidacion: l })}>
                        Corregir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 6 · HISTORIAL DE PAGOS ──────────────────────────────────────── */}
      {saldo?.pagosRecientes?.length > 0 && (
        <div style={{ ...S.card, marginTop: 16, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '18px 20px 12px' }}>
            <h4 style={S.cardTitle}>Pagos que descargaron el pasivo</h4>
            <p style={S.cardSub}>Ninguno de estos es gasto: el gasto ya se causó mes a mes.</p>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={S.th}>Fecha</th>
                  <th style={S.th}>N°</th>
                  <th style={S.th}>Concepto</th>
                  <th style={S.th}>Beneficiario</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Monto</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>A gasto</th>
                </tr>
              </thead>
              <tbody>
                {saldo.pagosRecientes.map(p => (
                  <tr key={p.id}>
                    <td style={S.td}>{p.fecha}</td>
                    <td style={S.td}>{p.numero}</td>
                    <td style={S.td}>{p.conceptoEtiqueta} · <span style={{ color: '#94a3b8' }}>{p.tipoPagoEtiqueta}</span></td>
                    <td style={S.td}>{p.beneficiario || '—'}</td>
                    <td style={S.tdNum}>{fmt(p.monto)}</td>
                    <td style={{ ...S.tdNum, color: p.excedenteGasto > 0 ? '#dc2626' : '#94a3b8' }}>
                      {p.excedenteGasto > 0 ? fmt(p.excedenteGasto) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── MODALES ─────────────────────────────────────────────────────── */}
      {modal?.tipo === 'pago' && (
        <ModalPagoPrestaciones
          catalogos={catalogos} saldo={saldo} empleados={empleadosActivos}
          cajas={cajas} empresas={empresas} conceptoInicial={modal.concepto}
          onListo={(r) => tras(r.mensaje)} onCerrar={() => setModal(null)} />
      )}
      {modal?.tipo === 'liquidar' && modal.empleado && (
        <ModalLiquidacion
          empleado={modal.empleado} catalogos={catalogos} empresas={empresas}
          onListo={(r) => tras(r.mensaje)} onCerrar={() => setModal(null)} />
      )}
      {modal?.tipo === 'retroactivas' && modal.empleado && (
        <ModalRetroactivas
          empleado={modal.empleado}
          onListo={(r) => tras(r.mensaje)} onCerrar={() => setModal(null)} />
      )}
      {modal?.tipo === 'anular' && modal.liquidacion && (
        <ModalAnularLiquidacion
          liquidacion={modal.liquidacion}
          onListo={(r) => tras(r.mensaje)} onCerrar={() => setModal(null)} />
      )}
      {modal?.tipo === 'pila' && (
        <ModalPagoPILA
          pila={pila} cajas={cajas} empresas={empresas}
          onListo={(r) => tras(r.mensaje)} onCerrar={() => setModal(null)} />
      )}
    </div>
  );
};

export default PanelPasivoLaboral;
