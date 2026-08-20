// ═══════════════════════════════════════════════════════════════════════════════
// GestionEmpleados.js — Empleados, provisiones de prestaciones y nómina
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PROVISIONES-001
//
// POR QUÉ ESTA PANTALLA
// ---------------------
// El ERI de julio 2026 mostraba $15.440.975 de nómina. Faltaban entre $2,5 y
// $2,8 millones MENSUALES de prestaciones sociales que nunca se causaron:
// entre $30 y $34 millones al año de gasto real fuera del estado de resultados.
//
// Y los anticipos se registraban como gasto, cuando en realidad son una cuenta
// por cobrar al empleado que debe cruzarse contra la nómina del período.
//
// TRES PESTAÑAS, TRES PROBLEMAS:
//   1. Empleados   → quién trabaja, con qué contrato y cuánto cuesta DE VERDAD
//   2. Provisiones → causar el pasivo mensual (lo que faltaba en el ERI)
//   3. Nómina      → comprobante que cruza los anticipos sin duplicar el gasto
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
// ✅ NOMINA-PROVISIONES-001: parámetros que cambian el cálculo del costo laboral
import PanelNominaConfig from './PanelNominaConfig';
// ✅ NOMINA-PASIVO-001 / NOMINA-LIQUIDACION-001: el cierre del ciclo vive en su
// propia carpeta. Este archivo ya pasaba de 1.200 líneas; meterle acá el pago
// del pasivo y la liquidación lo volvía inmanejable.
import PanelPasivoLaboral from './components/nomina/PanelPasivoLaboral';
// ✅ NOMINA-COLILLA-001: la colilla que el trabajador firma. Antes había que
// volver a digitarla en Excel, y ahí se colaban los errores de transcripción.
import { imprimirComprobanteNomina } from './components/nomina/comprobanteNomina';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(n || 0);
const pct = (n) => `${Number(n || 0).toFixed(2).replace(/\.00$/, '')}%`;

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ═════════════════════════════════════════════════════════════════════════════
// Modal de empleado
// ═════════════════════════════════════════════════════════════════════════════
function ModalEmpleado({ empleado, config, onGuardar, onCerrar }) {
  const [form, setForm] = useState({
    nombre: '', documento: '', tipoDocumento: 'CC', cargo: '',
    tipoContrato: 'indefinido', salario: '',
    fechaInicio: new Date().toISOString().slice(0, 10), fechaFin: '',
    claseRiesgoARL: 'III', tarifaARLPersonalizada: '', auxilioTransporteManual: '',
    eps: '', fondoPension: '', fondoCesantias: '', caja: '',
    email: '', telefono: '', notas: '',
    ...(empleado || {})
  });
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const tipo = (config?.tiposContrato || []).find(t => t.id === form.tipoContrato);
  const P = config?.parametros;

  // ─── Vista previa del costo real, en vivo ────────────────────────────────
  // Esta es la parte pedagógica: el suscriptor ve que un empleado no cuesta
  // su salario, cuesta ~1,6 veces su salario.
  const preview = useMemo(() => {
    const sal = Number(form.salario) || 0;
    if (!sal || !P || !tipo) return null;

    const aux = tipo.aplicaAuxilioTransporte
      ? (form.auxilioTransporteManual !== '' && form.auxilioTransporteManual !== null
          ? Number(form.auxilioTransporteManual)
          : (sal <= P.smmlv * 2 ? P.auxilioTransporte : 0))
      : 0;

    const baseConAux = sal + aux;
    const prest = {};
    let totalPrest = 0;
    if (tipo.generaPrestaciones && config?.prestaciones) {
      for (const [k, cfg] of Object.entries(config.prestaciones)) {
        const base = cfg.incluyeAuxilio ? baseConAux : sal;
        const v = Math.round(base * cfg.pct / 100);
        prest[k] = { ...cfg, valor: v };
        totalPrest += v;
      }
    }

    let totalSS = 0;
    const ss = {};
    if (tipo.generaSeguridadSocialPatronal && config?.seguridadSocial) {
      let baseAportes = tipo.baseSeguridadSocialPct ? Math.round(sal * tipo.baseSeguridadSocialPct / 100) : sal;
      baseAportes = Math.max(baseAportes, P.smmlv);
      const exonera = sal < P.smmlv * (config.seguridadSocial.topeExoneracionSMMLV || 10);
      for (const [k, cfg] of Object.entries(config.seguridadSocial.patronal || {})) {
        const ex = exonera && cfg.exonerable;
        const v = ex ? 0 : Math.round(baseAportes * cfg.pct / 100);
        ss[k] = { ...cfg, valor: v, exonerado: ex };
        totalSS += v;
      }
      const arl = (config.clasesRiesgoARL || {})[form.claseRiesgoARL];
      if (arl) {
        // Si el suscriptor registró la tarifa real que le asignó su ARL, se usa
        // esa; si no, la inicial de la clase.
        const custom = Number(form.tarifaARLPersonalizada);
        const tarifa = (form.tarifaARLPersonalizada !== '' && form.tarifaARLPersonalizada != null && isFinite(custom) && custom > 0)
          ? custom : arl.pct;
        const v = Math.round(baseAportes * tarifa / 100);
        ss.arl = { etiqueta: `ARL · ${arl.etiqueta}`, pct: tarifa, valor: v, exonerado: false };
        totalSS += v;
      }
    }

    const costo = baseConAux + totalPrest + totalSS;
    return {
      salario: sal, auxilio: aux, baseConAux,
      prestaciones: prest, totalPrest, ss, totalSS,
      costo, factor: sal > 0 ? (costo / sal) : 0
    };
  }, [form.salario, form.tipoContrato, form.claseRiesgoARL, form.tarifaARLPersonalizada, form.auxilioTransporteManual, config, tipo, P]);

  const guardar = async () => {
    if (!form.nombre?.trim())    { setError('El nombre es obligatorio'); return; }
    if (!form.documento?.trim()) { setError('El documento es obligatorio'); return; }
    if (!form.fechaInicio)       { setError('La fecha de inicio es obligatoria'); return; }
    if (!(Number(form.salario) > 0)) { setError('El salario debe ser mayor a cero'); return; }
    if (tipo?.requiereFechaFin && !form.fechaFin) {
      setError('Un contrato a término fijo requiere fecha de terminación'); return;
    }
    setGuardando(true); setError('');
    try { await onGuardar(form); }
    catch (e) { setError(e.response?.data?.error || e.message || 'No se pudo guardar'); setGuardando(false); }
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 780 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>{empleado ? '✏️ Editar empleado' : '👤 Nuevo empleado'}</h3>
          <button onClick={onCerrar} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <div style={S.field}>
              <label style={S.label}>Nombre completo *</label>
              <input style={S.input} value={form.nombre} onChange={e => set('nombre', e.target.value)} />
            </div>
            <div style={S.field}>
              <label style={S.label}>Tipo doc.</label>
              <select style={S.select} value={form.tipoDocumento} onChange={e => set('tipoDocumento', e.target.value)}>
                {['CC', 'CE', 'TI', 'PPT', 'PEP', 'NIT'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={S.field}>
              <label style={S.label}>Documento *</label>
              <input style={S.input} value={form.documento} onChange={e => set('documento', e.target.value)} />
            </div>
          </div>

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Cargo</label>
              <input style={S.input} value={form.cargo} onChange={e => set('cargo', e.target.value)} placeholder="Técnico de recargas" />
            </div>
            <div style={S.field}>
              <label style={S.label}>Tipo de contrato *</label>
              <select style={S.select} value={form.tipoContrato} onChange={e => set('tipoContrato', e.target.value)}>
                {(config?.tiposContrato || []).map(t => <option key={t.id} value={t.id}>{t.etiqueta}</option>)}
              </select>
            </div>
          </div>

          {/* Explicación del tipo de contrato elegido — evita el error de
              calcularle prestaciones a un contratista */}
          {tipo && (
            <div style={{
              background: tipo.generaPrestaciones ? '#f0fdf4' : '#fffbeb',
              border: `1px solid ${tipo.generaPrestaciones ? '#dcfce7' : '#fde68a'}`,
              borderRadius: 10, padding: '11px 14px', marginBottom: 14,
              fontSize: 12, color: tipo.generaPrestaciones ? '#15803d' : '#92400e', lineHeight: 1.6
            }}>
              <strong>{tipo.generaPrestaciones ? '✓ Genera prestaciones sociales' : '⚠️ NO genera prestaciones sociales'}</strong>
              <div style={{ marginTop: 4 }}>{tipo.descripcion}</div>
              {tipo.advertencia && (
                <div style={{ marginTop: 7, paddingTop: 7, borderTop: '1px dashed currentColor', opacity: .9 }}>
                  {tipo.advertencia}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div style={S.field}>
              <label style={S.label}>Salario mensual *</label>
              <input type="number" style={{ ...S.input, fontWeight: 700 }} value={form.salario}
                onChange={e => set('salario', e.target.value)} placeholder={String(P?.smmlv || '')} />
              {P && (
                <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                  Mínimo {P.anio}: {fmt(P.smmlv)}
                  {Number(form.salario) > 0 && ` · equivale a ${(Number(form.salario) / P.smmlv).toFixed(2)} SMMLV`}
                </div>
              )}

              {/* ═══════════════════════════════════════════════════════════
                  ✅ NOMINA-SALARIO-HISTORICO-001 — desde cuándo rige
                  ───────────────────────────────────────────────────────────
                  Aparece solo si el salario cambió respecto al guardado. El
                  historial se arma solo: nadie tiene que acordarse de anotarlo.
                  Importa para dos cosas — causar provisiones retroactivas con
                  el salario de cada mes, y liquidar con el promedio cuando el
                  art. 253 lo exige.
                  ═══════════════════════════════════════════════════════════ */}
              {empleado && Number(form.salario) > 0
                && Number(form.salario) !== Number(empleado.salario) && (
                <div style={{
                  background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 9,
                  padding: '10px 12px', marginTop: 9,
                }}>
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: '#1e40af', marginBottom: 6 }}>
                    {Number(form.salario) > Number(empleado.salario) ? 'Aumento' : 'Cambio'} de {fmt(Math.abs(Number(form.salario) - Number(empleado.salario)))}
                  </div>
                  <label style={{ ...S.label, fontSize: 11 }}>¿Desde qué fecha rige?</label>
                  <input type="date" style={{ ...S.input, marginTop: 3 }}
                    value={form.vigenciaSalarioDesde || new Date().toLocaleDateString('en-CA')}
                    onChange={e => set('vigenciaSalarioDesde', e.target.value)} />
                  <div style={{ fontSize: 10.5, color: '#1e40af', marginTop: 6, lineHeight: 1.5 }}>
                    Queda registrado que antes ganaba {fmt(empleado.salario)}. Un aumento en los
                    últimos 3 meses obliga a liquidar las cesantías sobre el promedio del año
                    (art. 253 CST) — el sistema lo aplica solo.
                  </div>
                </div>
              )}

              {/* Historial ya registrado */}
              {empleado?.historialSalarios?.length > 0 && (
                <details style={{ marginTop: 9 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 700, color: '#4f46e5' }}>
                    Historial de salario ({empleado.historialSalarios.length} tramo(s))
                  </summary>
                  <div style={{ marginTop: 7 }}>
                    {empleado.historialSalarios.map((h, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between', fontSize: 11.5,
                        padding: '5px 10px', background: '#f8fafc', borderRadius: 6, marginBottom: 3, color: '#475569',
                      }}>
                        <span>Desde {h.desde}</span>
                        <strong>{fmt(h.salario)}</strong>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
            <div style={S.field}>
              <label style={S.label}>Fecha de inicio *</label>
              <input type="date" style={S.input} value={form.fechaInicio} onChange={e => set('fechaInicio', e.target.value)} />
            </div>
            <div style={S.field}>
              <label style={S.label}>
                Fecha de terminación {tipo?.requiereFechaFin && <span style={{ color: '#dc2626' }}>*</span>}
              </label>
              <input type="date" style={S.input} value={form.fechaFin || ''} onChange={e => set('fechaFin', e.target.value)} />
              <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                {tipo?.requiereFechaFin ? 'Obligatoria en término fijo' : 'Dejar vacía si sigue vigente'}
              </div>
            </div>
          </div>

          {tipo?.generaSeguridadSocialPatronal && (
            <div style={S.row2}>
              {/* ✅ La clase de ARL es POR TRABAJADOR, no por empresa.
                  La auxiliar comercial puede ser clase I y el mensajero que
                  manipula cilindros clase IV, en la misma empresa y con el
                  mismo salario. La asigna la ARL según la actividad del cargo. */}
              <div style={S.field}>
                <label style={S.label}>Clase de riesgo ARL</label>
                <select style={S.select} value={form.claseRiesgoARL} onChange={e => set('claseRiesgoARL', e.target.value)}>
                  {Object.entries(config?.clasesRiesgoARL || {}).map(([k, v]) => (
                    <option key={k} value={k}>{v.etiqueta} — {pct(v.pct)}</option>
                  ))}
                </select>
                <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                  {(config?.clasesRiesgoARL || {})[form.claseRiesgoARL]?.ejemplo}
                </div>

                {/* Tarifa real asignada por la ARL — puede diferir de la inicial */}
                {(() => {
                  const cl = (config?.clasesRiesgoARL || {})[form.claseRiesgoARL];
                  if (!cl) return null;
                  const v = Number(form.tarifaARLPersonalizada);
                  const fuera = form.tarifaARLPersonalizada !== '' && form.tarifaARLPersonalizada != null
                    && isFinite(v) && v > 0 && cl.min != null && (v < cl.min || v > cl.max);
                  return (
                    <div style={{ marginTop: 9 }}>
                      <label style={{ ...S.label, fontSize: 11, color: '#64748b' }}>
                        Tarifa real de tu ARL (opcional)
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
                        <input type="number" step="0.001" style={{ ...S.input, width: 110, borderColor: fuera ? '#fca5a5' : '#e2e8f0' }}
                          value={form.tarifaARLPersonalizada ?? ''}
                          onChange={e => set('tarifaARLPersonalizada', e.target.value)}
                          placeholder={String(cl.pct)} />
                        <span style={{ fontSize: 13, color: '#64748b', fontWeight: 700 }}>%</span>
                      </div>
                      <div style={{ fontSize: 10.5, color: fuera ? '#dc2626' : '#94a3b8', marginTop: 4, lineHeight: 1.5 }}>
                        {fuera
                          ? `⚠️ ${v}% está fuera del rango legal de esta clase (${cl.min}% a ${cl.max}%). Verificá la carta de la ARL.`
                          : cl.min != null
                            ? `Dejalo vacío para usar la tarifa inicial (${pct(cl.pct)}). Rango legal de la clase: ${cl.min}% a ${cl.max}% — la ARL puede moverte dentro de él según tu siniestralidad.`
                            : `Dejalo vacío para usar la tarifa inicial (${pct(cl.pct)}).`}
                      </div>
                    </div>
                  );
                })()}
              </div>
              {tipo?.aplicaAuxilioTransporte && (
                <div style={S.field}>
                  <label style={S.label}>Auxilio de transporte (opcional)</label>
                  <input type="number" style={S.input} value={form.auxilioTransporteManual ?? ''}
                    onChange={e => set('auxilioTransporteManual', e.target.value)}
                    placeholder="Automático" />
                  <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                    Se calcula solo si gana hasta 2 SMMLV. Llenalo solo para forzar otro valor.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── VISTA PREVIA DEL COSTO REAL ─────────────────────────────── */}
          {preview && (
            <div style={{
              background: '#f8fafc', border: '1px solid #e2e8f0',
              borderRadius: 12, padding: 16, marginBottom: 14
            }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#475569', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Lo que este empleado cuesta de verdad
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0' }}>
                <span style={{ color: '#475569' }}>Salario</span>
                <strong>{fmt(preview.salario)}</strong>
              </div>
              {preview.auxilio > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0' }}>
                  <span style={{ color: '#475569' }}>Auxilio de transporte</span>
                  <strong>{fmt(preview.auxilio)}</strong>
                </div>
              )}

              {preview.totalPrest > 0 && (
                <>
                  <div style={{ fontSize: 10.5, fontWeight: 800, color: '#7c3aed', marginTop: 10, marginBottom: 4, textTransform: 'uppercase' }}>
                    Prestaciones sociales (pasivo que se acumula)
                  </div>
                  {Object.values(preview.prestaciones).map((p, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: '#64748b' }}>
                      <span>{p.etiqueta} <span style={{ color: '#cbd5e1' }}>{pct(p.pct)}</span></span>
                      <span>{fmt(p.valor)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '5px 0', borderTop: '1px dashed #cbd5e1', marginTop: 4, fontWeight: 700, color: '#7c3aed' }}>
                    <span>Total prestaciones</span><span>{fmt(preview.totalPrest)}</span>
                  </div>
                </>
              )}

              {preview.totalSS > 0 && (
                <>
                  <div style={{ fontSize: 10.5, fontWeight: 800, color: '#0284c7', marginTop: 10, marginBottom: 4, textTransform: 'uppercase' }}>
                    Aportes a cargo de la empresa
                  </div>
                  {Object.values(preview.ss).map((s, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: s.exonerado ? '#cbd5e1' : '#64748b' }}>
                      <span>{s.etiqueta} <span style={{ color: '#cbd5e1' }}>{pct(s.pct)}</span></span>
                      <span>{s.exonerado ? 'exonerado' : fmt(s.valor)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '5px 0', borderTop: '1px dashed #cbd5e1', marginTop: 4, fontWeight: 700, color: '#0284c7' }}>
                    <span>Total aportes</span><span>{fmt(preview.totalSS)}</span>
                  </div>
                </>
              )}

              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                background: '#0f172a', color: '#fff', borderRadius: 10, padding: '12px 15px', marginTop: 12
              }}>
                <div>
                  <div style={{ fontSize: 10, opacity: .8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                    Costo mensual real
                  </div>
                  <div style={{ fontSize: 19, fontWeight: 900 }}>{fmt(preview.costo)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, opacity: .8, fontWeight: 700 }}>FACTOR</div>
                  <div style={{ fontSize: 17, fontWeight: 900, color: '#fbbf24' }}>{preview.factor.toFixed(2)}x</div>
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 7, lineHeight: 1.5 }}>
                Cada peso de salario le cuesta a la empresa {preview.factor.toFixed(2)} pesos.
                {preview.totalPrest > 0 && ' Las prestaciones no salen de caja este mes, pero sí son gasto del mes: se acumulan como pasivo hasta que se paguen.'}
              </div>
            </div>
          )}

          {/* Afiliaciones */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={S.field}><label style={S.label}>EPS</label><input style={S.input} value={form.eps} onChange={e => set('eps', e.target.value)} /></div>
            <div style={S.field}><label style={S.label}>Fondo de pensión</label><input style={S.input} value={form.fondoPension} onChange={e => set('fondoPension', e.target.value)} /></div>
            <div style={S.field}><label style={S.label}>Fondo de cesantías</label><input style={S.input} value={form.fondoCesantias} onChange={e => set('fondoCesantias', e.target.value)} /></div>
            <div style={S.field}><label style={S.label}>Caja de compensación</label><input style={S.input} value={form.caja} onChange={e => set('caja', e.target.value)} /></div>
            <div style={S.field}><label style={S.label}>Teléfono</label><input style={S.input} value={form.telefono} onChange={e => set('telefono', e.target.value)} /></div>
            <div style={S.field}><label style={S.label}>Email</label><input style={S.input} value={form.email} onChange={e => set('email', e.target.value)} /></div>
          </div>

          {error && (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 13px', fontSize: 12.5, color: '#991b1b', marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={S.modalFooter}>
            <button onClick={onCerrar} style={S.btnSecondary}>Cancelar</button>
            <button onClick={guardar} disabled={guardando} style={S.btnPrimary}>
              {guardando ? 'Guardando...' : empleado ? 'Guardar cambios' : 'Registrar empleado'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Modal de comprobante de nómina
// ─────────────────────────────────────────────────────────────────────────────
// Al elegir el empleado, el sistema trae automáticamente los anticipos que
// pidió durante el período y los descuenta. Ese cruce es lo que impide que el
// gasto se duplique.
// ═════════════════════════════════════════════════════════════════════════════
function ModalNomina({ empleados, config, cajas, empresas, onGenerado, onCerrar }) {
  const hoy = new Date();
  const [form, setForm] = useState({
    empleadoId: '',
    desde: new Date(hoy.getFullYear(), hoy.getMonth(), 1).toLocaleDateString('en-CA'),
    hasta: new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toLocaleDateString('en-CA'),
    diasTrabajados: 30,
    cajaId: '', formaPago: 'Transferencia', empresaId: '', notas: ''
  });
  const [horas, setHoras] = useState({});
  const [otrosDevengados, setOtrosDev] = useState([]);
  const [otrasDeducciones, setOtrasDed] = useState([]);
  const [preview, setPreview] = useState(null);
  const [cargandoPreview, setCargando] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [paso, setPaso] = useState('datos');
  const [generando, setGenerando] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });
  const empleado = empleados.find(e => e.id === form.empleadoId);

  // Recalcular en vivo
  useEffect(() => {
    if (!form.empleadoId) { setPreview(null); return; }
    let vivo = true;
    const t = setTimeout(async () => {
      setCargando(true);
      try {
        const r = await axios.post(`${API}/empleados/nomina/preview`, {
          empleadoId: form.empleadoId, desde: form.desde, hasta: form.hasta,
          diasTrabajados: Number(form.diasTrabajados), horas,
          otrosDevengados, otrasDeducciones
        }, { headers: headers() });
        if (vivo) setPreview(r.data);
      } catch (e) {
        if (vivo) setError(e.response?.data?.error || 'No se pudo calcular');
      }
      if (vivo) setCargando(false);
    }, 350);
    return () => { vivo = false; clearTimeout(t); };
  }, [form.empleadoId, form.desde, form.hasta, form.diasTrabajados, horas, otrosDevengados, otrasDeducciones]);

  const generar = async () => {
    if (!/^\d{4}$/.test(pin)) { setError('El PIN es de 4 dígitos'); return; }
    if (!form.cajaId) { setError('Seleccioná la caja de donde sale el pago'); return; }
    setGenerando(true); setError('');
    try {
      const r = await axios.post(`${API}/empleados/nomina/comprobante`, {
        ...form, diasTrabajados: Number(form.diasTrabajados),
        horas, otrosDevengados, otrasDeducciones, pin
      }, { headers: headers() });
      onGenerado(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'No se pudo generar el comprobante');
      setGenerando(false);
    }
  };

  const conceptosHoras = config?.conceptosHoras || {};
  const anticipos = (preview?.deducciones || []).find(d => d.clave === 'anticipos');

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 900 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>🧾 Comprobante de nómina</h3>
          <button onClick={onCerrar} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>

          {paso === 'datos' ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 12 }}>
                <div style={S.field}>
                  <label style={S.label}>Empleado *</label>
                  <select style={S.select} value={form.empleadoId} onChange={e => { set('empleadoId', e.target.value); setError(''); }}>
                    <option value="">— Seleccionar —</option>
                    {empleados.filter(e => e.activo !== false).map(e => (
                      <option key={e.id} value={e.id}>{e.nombre} · {e.documento}</option>
                    ))}
                  </select>
                </div>
                <div style={S.field}>
                  <label style={S.label}>Desde</label>
                  <input type="date" style={S.input} value={form.desde} onChange={e => set('desde', e.target.value)} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>Hasta</label>
                  <input type="date" style={S.input} value={form.hasta} onChange={e => set('hasta', e.target.value)} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>Días</label>
                  <input type="number" min="0" max="30" style={S.input} value={form.diasTrabajados}
                    onChange={e => set('diasTrabajados', e.target.value)} />
                </div>
              </div>

              {/* ✅ NOMINA-QUINCENAL-001 — atajos de período.
                  Muchos suscriptores pagan quincenal. Fijar las fechas y los días
                  a mano invita a equivocarse: 31 días en un mes de 31, o 16 días
                  en la segunda quincena. La nómina colombiana usa mes comercial
                  de 30 días, así que las dos quincenas son de 15 y punto. */}
              {(() => {
                const mesRef = String(form.hasta || form.desde || '').slice(0, 7) ||
                  new Date().toLocaleDateString('en-CA').slice(0, 7);
                const preset = (etiqueta, dia1, dia2, dias) => (
                  <button key={etiqueta} type="button"
                    onClick={() => setForm(f => ({
                      ...f,
                      desde: `${mesRef}-${dia1}`,
                      hasta: `${mesRef}-${dia2}`,
                      diasTrabajados: dias,
                    }))}
                    style={{
                      padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
                      fontSize: 12, fontWeight: 700, border: '1px solid #e2e8f0',
                      background: (form.desde === `${mesRef}-${dia1}` && form.hasta === `${mesRef}-${dia2}`)
                        ? '#4f46e5' : '#f8fafc',
                      color: (form.desde === `${mesRef}-${dia1}` && form.hasta === `${mesRef}-${dia2}`)
                        ? '#fff' : '#475569',
                    }}>{etiqueta}</button>
                );
                return (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: '#64748b' }}>Período:</span>
                      {preset('1ª quincena (1–15)', '01', '15', 15)}
                      {preset('2ª quincena (16–30)', '16', '30', 15)}
                      {preset('Mes completo', '01', '30', 30)}
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>
                      La nómina se liquida sobre mes comercial de 30 días. Las dos quincenas
                      suman lo mismo que un mes completo: salud, pensión y Fondo de Solidaridad
                      se calculan sobre la base mensual y se prorratean.
                    </div>
                  </div>
                );
              })()}

              {empleado && (
                <div style={{
                  background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
                  padding: '10px 14px', marginBottom: 14, fontSize: 12, color: '#1e40af'
                }}>
                  <strong>{empleado.nombre}</strong> · {empleado.cargo || 'sin cargo'} ·{' '}
                  {(config?.tiposContrato || []).find(t => t.id === empleado.tipoContrato)?.etiqueta} ·
                  salario {fmt(empleado.salario)}
                </div>
              )}

              {/* Horas extras y recargos */}
              {empleado && (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: '#475569', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                    Horas extras y recargos
                  </div>
                  <div style={{ fontSize: 10.5, color: '#94a3b8', marginBottom: 10 }}>
                    Jornada nocturna desde las 7 p.m. (Ley 2466 de 2025). Valor hora ordinaria:{' '}
                    <strong>{fmt(preview?.horasExtras?.valorHoraOrdinaria || 0)}</strong> sobre {config?.horasMes || 220} h/mes.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 10 }}>
                    {Object.entries(conceptosHoras).map(([clave, cfg]) => (
                      <div key={clave} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="number" min="0" style={{ ...S.input, width: 62, padding: '6px 8px' }}
                          value={horas[clave] || ''} placeholder="0"
                          onChange={e => setHoras(h => ({ ...h, [clave]: e.target.value }))} />
                        <span style={{ fontSize: 11, color: '#475569', lineHeight: 1.3 }}>
                          {cfg.etiqueta}<br />
                          <span style={{ color: '#94a3b8', fontSize: 10 }}>+{cfg.pct}%</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ─── ANTICIPOS DETECTADOS ─────────────────────────────────── */}
              {anticipos && (
                <div style={{
                  background: '#fffbeb', border: '2px solid #fcd34d', borderRadius: 12,
                  padding: 14, marginBottom: 14
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: '#92400e', marginBottom: 6 }}>
                    💵 {anticipos.detalle.length} anticipo(s) del período — se descuentan automáticamente
                  </div>
                  <div style={{ fontSize: 11, color: '#a16207', marginBottom: 10, lineHeight: 1.55 }}>
                    Estos son los préstamos que el empleado pidió durante la quincena.
                    <strong> No son un gasto adicional</strong>: eran una cuenta por cobrar y acá se cruzan.
                    Al generar el comprobante quedan marcados como cruzados y dejan de contar aparte.
                  </div>
                  {anticipos.detalle.map(a => (
                    <div key={a.egresoId} style={{
                      display: 'flex', justifyContent: 'space-between', fontSize: 12,
                      background: '#fff', borderRadius: 7, padding: '6px 11px', marginBottom: 4
                    }}>
                      <span style={{ color: '#78350f' }}>
                        <strong>{a.numero}</strong> · {a.fecha} · {a.concepto}
                      </span>
                      <strong style={{ color: '#92400e' }}>{fmt(a.valor)}</strong>
                    </div>
                  ))}
                </div>
              )}

              {/* ─── LIQUIDACIÓN EN VIVO ──────────────────────────────────── */}
              {preview && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                  <div style={{ background: '#f0fdf4', border: '1px solid #dcfce7', borderRadius: 12, padding: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#15803d', marginBottom: 9, textTransform: 'uppercase' }}>Devengado</div>
                    {preview.devengados.map((d, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: '#166534' }}>
                        <span>{d.etiqueta}</span><span>{fmt(d.valor)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 800, color: '#15803d', borderTop: '1px solid #bbf7d0', marginTop: 6, paddingTop: 6 }}>
                      <span>Total</span><span>{fmt(preview.totalDevengado)}</span>
                    </div>
                  </div>

                  <div style={{ background: '#fef2f2', border: '1px solid #fee2e2', borderRadius: 12, padding: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#b91c1c', marginBottom: 9, textTransform: 'uppercase' }}>Deducciones</div>
                    {preview.deducciones.map((d, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: '#991b1b' }}>
                        <span>{d.etiqueta}</span><span>{fmt(d.valor)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 800, color: '#b91c1c', borderTop: '1px solid #fecaca', marginTop: 6, paddingTop: 6 }}>
                      <span>Total</span><span>{fmt(preview.totalDeducciones)}</span>
                    </div>
                  </div>
                </div>
              )}

              {preview && (
                <>
                  <div style={{
                    background: 'linear-gradient(135deg,#4f46e5,#4338ca)', color: '#fff',
                    borderRadius: 12, padding: '15px 20px', marginBottom: 14,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12
                  }}>
                    <div>
                      <div style={{ fontSize: 10.5, opacity: .85, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                        Neto a pagar · sale de caja
                      </div>
                      <div style={{ fontSize: 25, fontWeight: 900 }}>{fmt(preview.netoAPagar)}</div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 11, opacity: .9, lineHeight: 1.7 }}>
                      <div>Costo real para la empresa: <strong>{fmt(preview.costoTotalEmpleador)}</strong></div>
                      <div style={{ opacity: .8 }}>
                        + {fmt(preview.provision.totalPrestaciones)} prestaciones
                        · + {fmt(preview.provision.totalSeguridadSocial)} aportes
                      </div>
                    </div>
                  </div>

                  {preview.advertencias?.length > 0 && preview.advertencias.map((a, i) => (
                    <div key={i} style={{
                      background: a.nivel === 'grave' ? '#fef2f2' : '#fffbeb',
                      border: `1px solid ${a.nivel === 'grave' ? '#fecaca' : '#fde68a'}`,
                      borderRadius: 9, padding: '10px 13px', marginBottom: 10,
                      fontSize: 12, color: a.nivel === 'grave' ? '#991b1b' : '#92400e', lineHeight: 1.55
                    }}>
                      {a.nivel === 'grave' ? '🚨' : '⚠️'} {a.texto}
                    </div>
                  ))}
                </>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div style={S.field}>
                  <label style={S.label}>Caja *</label>
                  <select style={S.select} value={form.cajaId} onChange={e => set('cajaId', e.target.value)}>
                    <option value="">— Seleccionar —</option>
                    {(cajas || []).map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </div>
                <div style={S.field}>
                  <label style={S.label}>Forma de pago</label>
                  <select style={S.select} value={form.formaPago} onChange={e => set('formaPago', e.target.value)}>
                    {['Transferencia', 'Efectivo', 'Nequi', 'Cheque'].map(f => <option key={f}>{f}</option>)}
                  </select>
                </div>
                <div style={S.field}>
                  <label style={S.label}>Empresa</label>
                  <select style={S.select} value={form.empresaId} onChange={e => set('empresaId', e.target.value)}>
                    <option value="">— Principal —</option>
                    {(empresas || []).map(e => <option key={e.id} value={e.id}>{e.name || e.nombre}</option>)}
                  </select>
                </div>
              </div>

              {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 13px', fontSize: 12.5, color: '#991b1b', marginBottom: 12 }}>{error}</div>}

              <div style={S.modalFooter}>
                <button onClick={onCerrar} style={S.btnSecondary}>Cancelar</button>
                <button onClick={() => { if (!preview) { setError('Seleccioná un empleado'); return; } setError(''); setPaso('confirmar'); }}
                  disabled={!preview || cargandoPreview} style={S.btnPrimary}>
                  {cargandoPreview ? 'Calculando...' : 'Continuar →'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 12.5, color: '#991b1b', lineHeight: 1.6 }}>
                🔐 Vas a generar el comprobante de nómina de <strong>{empleado?.nombre}</strong> por{' '}
                <strong>{fmt(preview?.netoAPagar)}</strong>.
                {preview?.totalAnticipos > 0 && (
                  <> Se cruzarán <strong>{fmt(preview.totalAnticipos)}</strong> en anticipos, que quedarán marcados y dejarán de contar como gasto aparte.</>
                )}
                {' '}Sale de caja y queda en auditoría.
              </div>

              <div style={S.field}>
                <label style={S.label}>PIN admin (4 dígitos) *</label>
                <input type="password" inputMode="numeric" maxLength={4}
                  style={{ ...S.input, textAlign: 'center', letterSpacing: 10, fontWeight: 800, fontSize: 20 }}
                  value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError(''); }}
                  placeholder="••••" onKeyDown={e => e.key === 'Enter' && generar()} />
              </div>

              <div style={S.field}>
                <label style={S.label}>Notas</label>
                <textarea style={{ ...S.input, height: 56, resize: 'vertical' }} value={form.notas}
                  onChange={e => set('notas', e.target.value)} />
              </div>

              {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 13px', fontSize: 12.5, color: '#991b1b', marginBottom: 12 }}>{error}</div>}

              <div style={S.modalFooter}>
                <button onClick={() => { setPaso('datos'); setError(''); }} style={S.btnSecondary}>← Volver</button>
                <button onClick={generar} disabled={generando}
                  style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#16a34a,#15803d)' }}>
                  {generando ? 'Generando...' : `🧾 Generar comprobante ${fmt(preview?.netoAPagar)}`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PANTALLA PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
export default function GestionEmpleados({ user }) {
  const [tab, setTab] = useState('empleados');
  const [empleados, setEmpleados] = useState([]);
  const [config, setConfig] = useState(null);
  const [cajas, setCajas] = useState([]);
  const [empresas, setEmpresas] = useState([]);
  const [provisiones, setProvisiones] = useState(null);
  const [anticipos, setAnticipos] = useState(null);
  // ✅ NOMINA-COLILLA-REIMPRESION-001
  const [comprobantes, setComprobantes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [verInactivos, setVerInactivos] = useState(false);
  const [causando, setCausando] = useState(false);

  const hoy = new Date();
  const [periodo, setPeriodo] = useState({ anio: hoy.getFullYear(), mes: hoy.getMonth() + 1 });

  const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

  const cargar = async () => {
    setLoading(true);
    try {
      const [eRes, cRes, cajRes, empRes] = await Promise.all([
        axios.get(`${API}/empleados`, { headers: headers() }).catch(() => ({ data: [] })),
        axios.get(`${API}/empleados/config?anio=${periodo.anio}`, { headers: headers() }).catch(() => ({ data: null })),
        axios.get(`${API}/cajas`, { headers: headers() }).catch(() => ({ data: [] })),
        axios.get(`${API}/companies`, { headers: headers() }).catch(() => ({ data: [] })),
      ]);
      setEmpleados(Array.isArray(eRes.data) ? eRes.data : []);
      setConfig(cRes.data);
      setCajas(Array.isArray(cajRes.data) ? cajRes.data : []);
      setEmpresas(Array.isArray(empRes.data) ? empRes.data : []);
    } catch { }
    setLoading(false);
  };

  useEffect(() => { cargar(); }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/empleados/provisiones?anio=${periodo.anio}&mes=${periodo.mes}`, { headers: headers() });
        setProvisiones(r.data);
      } catch { setProvisiones(null); }
    })();
  }, [periodo.anio, periodo.mes, empleados.length]);

  useEffect(() => {
    (async () => {
      try {
        const ini = `${periodo.anio}-${String(periodo.mes).padStart(2, '0')}-01`;
        const fin = `${periodo.anio}-${String(periodo.mes).padStart(2, '0')}-31`;
        const r = await axios.get(`${API}/empleados/anticipos?desde=${ini}&hasta=${fin}`, { headers: headers() });
        setAnticipos(r.data);
      } catch { setAnticipos(null); }
      // ✅ NOMINA-COLILLA-REIMPRESION-001: comprobantes ya emitidos del período
      try {
        const c = await axios.get(
          `${API}/empleados/nomina/comprobantes?anio=${periodo.anio}&mes=${periodo.mes}`,
          { headers: headers() });
        setComprobantes(c.data?.comprobantes || []);
      } catch { setComprobantes([]); }
    })();
  }, [periodo.anio, periodo.mes, modal]);

  const crear = async (data) => {
    const r = await axios.post(`${API}/empleados`, data, { headers: headers() });
    setEmpleados(p => [...p, r.data]);
    setModal(null);
    if (r.data.avisos?.length) alert('Empleado creado con observaciones:\n\n' + r.data.avisos.join('\n\n'));
  };

  const editar = async (data) => {
    const r = await axios.put(`${API}/empleados/${modal.empleado.id}`, data, { headers: headers() });
    setEmpleados(p => p.map(e => e.id === modal.empleado.id ? { ...e, ...r.data } : e));
    setModal(null);
  };

  const causarProvisiones = async () => {
    const total = provisiones?.totales?.prestaciones || 0;
    if (!window.confirm(
      `¿Causar la provisión de prestaciones de ${MESES[periodo.mes - 1]} ${periodo.anio}?\n\n` +
      `${provisiones?.empleadosVigentes || 0} empleado(s) · ${fmt(total)}\n\n` +
      `Esto NO mueve caja. Registra el gasto del mes y la obligación acumulada (pasivo).\n` +
      `Es lo que hace que el estado de resultados refleje el costo real de la nómina.`
    )) return;
    setCausando(true);
    try {
      const r = await axios.post(`${API}/empleados/provisiones/causar`,
        { anio: periodo.anio, mes: periodo.mes }, { headers: headers() });
      alert(`✅ ${r.data.mensaje}\n\n${r.data.causadas} empleado(s) causados.` +
            (r.data.omitidos?.length ? `\n${r.data.omitidos.length} omitido(s).` : ''));
      const p = await axios.get(`${API}/empleados/provisiones?anio=${periodo.anio}&mes=${periodo.mes}`, { headers: headers() });
      setProvisiones(p.data);
    } catch (e) {
      alert('No se pudo causar: ' + (e.response?.data?.error || e.message));
    }
    setCausando(false);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ✅ NOMINA-REVERTIR-UI-001 — deshacer la causación de un mes
  // ───────────────────────────────────────────────────────────────────────────
  // El endpoint existía desde el principio pero nunca tuvo botón: una provisión
  // mal causada quedaba mal para siempre. Y se necesita más de lo que parece —
  // para corregir un cálculo, para rehacer un mes con el salario bien, o para
  // volver a causarlo con la causación de aportes ya activa.
  //
  // No borra: marca las provisiones como revertidas y deja el rastro con motivo
  // y usuario. Después se puede volver a causar el mismo mes.
  // ═══════════════════════════════════════════════════════════════════════════
  const [revirtiendo, setRevirtiendo] = useState(false);

  const revertirProvisiones = async () => {
    const motivo = window.prompt(
      `Revertir la provisión de ${MESES[periodo.mes - 1]} ${periodo.anio}\n\n` +
      `Las provisiones de ese mes quedan anuladas y el pasivo baja. Después podés volver a causarlo.\n\n` +
      `¿Por qué se revierte? (mínimo 10 caracteres, queda en auditoría)`
    );
    if (motivo === null) return;
    if (motivo.trim().length < 10) {
      alert('Explicá el motivo con un poco más de detalle. Queda registrado en la auditoría.');
      return;
    }
    const pin = window.prompt('PIN de administrador (4 dígitos)');
    if (!pin) return;

    setRevirtiendo(true);
    try {
      const r = await axios.post(
        `${API}/empleados/provisiones/${periodo.anio}/${periodo.mes}/revertir`,
        { pin, motivo }, { headers: headers() });
      alert(
        `✅ Revertidas ${r.data.revertidas} provisión(es) por ${fmt(r.data.total)}.\n\n` +
        `Ya podés volver a causar ${MESES[periodo.mes - 1]} con los valores corregidos.`
      );
      const p = await axios.get(`${API}/empleados/provisiones?anio=${periodo.anio}&mes=${periodo.mes}`, { headers: headers() });
      setProvisiones(p.data);
    } catch (e) {
      alert('No se pudo revertir: ' + (e.response?.data?.error || e.message));
    }
    setRevirtiendo(false);
  };

  const visibles = useMemo(
    () => empleados.filter(e => verInactivos ? true : e.activo !== false),
    [empleados, verInactivos]
  );

  const etiquetaContrato = (id) => (config?.tiposContrato || []).find(t => t.id === id)?.etiqueta || id;

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>⏳ Cargando empleados...</div>;

  const TABS = [
    { k: 'empleados', l: '👥 Empleados', c: '#4f46e5' },
    { k: 'provisiones', l: '📊 Provisiones', c: '#7c3aed' },
    // ✅ NOMINA-PASIVO-001: acá se paga lo causado y se liquidan contratos.
    // Sin esta pestaña el pasivo del balance solo crecía.
    { k: 'pasivo', l: '🏦 Pasivo laboral', c: '#4338ca' },
    { k: 'nomina', l: '🧾 Nómina', c: '#16a34a' },
    // ✅ NOMINA-PROVISIONES-001: la exoneración vive acá y no en Mi Empresa
    // porque es donde el suscriptor está pensando en costo laboral.
    { k: 'ajustes', l: '⚙️ Ajustes', c: '#64748b' },
  ];

  return (
    <div style={S.page}>
      <div style={S.pageHeader}>
        <div>
          <h2 style={S.pageTitle}>👥 Empleados y Nómina</h2>
          <p style={S.pageSubtitle}>Contratos · Provisiones de prestaciones · Comprobantes de pago</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {tab === 'nomina' && empleados.length > 0 && (
            <button onClick={() => setModal({ tipo: 'nomina' })}
              style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#16a34a,#15803d)' }}>
              🧾 Nuevo comprobante
            </button>
          )}
          <button onClick={() => setModal({ tipo: 'nuevo' })} style={S.btnPrimary}>+ Nuevo empleado</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e5e7eb', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            padding: '10px 22px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: 600, color: tab === t.k ? t.c : '#6b7280',
            borderBottom: tab === t.k ? `2px solid ${t.c}` : '2px solid transparent', marginBottom: -2
          }}>{t.l}</button>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB 1 · EMPLEADOS
          ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'empleados' && (
        <div>
          {empleados.length === 0 ? (
            <div style={{
              background: 'linear-gradient(135deg,#eef2ff,#faf5ff)', border: '1px solid #c7d2fe',
              borderRadius: 16, padding: '28px 32px'
            }}>
              <div style={{ fontSize: 34, marginBottom: 12 }}>👥</div>
              <h3 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 800, color: '#312e81' }}>
                Registrá acá los empleados de la empresa
              </h3>
              <p style={{ margin: '0 0 14px', fontSize: 13.5, color: '#4338ca', lineHeight: 1.65, maxWidth: 760 }}>
                Con el <strong>tipo de contrato</strong>, el <strong>salario</strong> y las <strong>fechas de inicio y
                terminación</strong>, el sistema calcula automáticamente las provisiones mensuales de prestaciones
                sociales — que son un <strong>pasivo</strong>, no un pago.
              </p>
              <div style={{
                background: '#fff', borderRadius: 12, padding: '14px 18px', fontSize: 12.5,
                color: '#475569', lineHeight: 1.7, maxWidth: 760, border: '1px solid #e0e7ff'
              }}>
                <strong style={{ color: '#312e81' }}>Por qué esto arregla el ERI:</strong> las cesantías, los intereses
                a las cesantías, la prima y las vacaciones se van causando mes a mes aunque se paguen después.
                Sin causarlas, el estado de resultados subestima el costo de la nómina en un{' '}
                <strong>21,83% del salario base</strong>. En julio de 2026 eso significó entre $2,5 y $2,8 millones
                fuera del informe.
                <br /><br />
                <strong style={{ color: '#312e81' }}>Y el tipo de contrato importa:</strong> un contratista por
                prestación de servicios <em>no</em> genera prestaciones. Calculárselas sería un error contable —
                y pagárselas configuraría contrato realidad.
              </div>
              <button onClick={() => setModal({ tipo: 'nuevo' })}
                style={{ ...S.btnPrimary, marginTop: 18, padding: '11px 24px', fontSize: 14 }}>
                + Registrar el primer empleado
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 12.5, color: '#64748b', fontWeight: 600 }}>{visibles.length} empleado(s)</span>
                <button onClick={() => setVerInactivos(v => !v)} style={{ ...S.btnSecondary, padding: '6px 13px', fontSize: 11.5 }}>
                  {verInactivos ? '👁 Ocultar retirados' : '👁 Ver retirados'}
                </button>
              </div>

              <div style={S.tableWrap}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['Empleado', 'Documento', 'Cargo', 'Contrato', 'Salario', 'Ingreso', 'ARL', 'Acciones'].map(h => (
                        <th key={h} style={S.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map(e => {
                      const t = (config?.tiposContrato || []).find(x => x.id === e.tipoContrato);
                      return (
                        <tr key={e.id} style={{ borderBottom: '1px solid #f1f5f9', opacity: e.activo === false ? .55 : 1 }}>
                          <td style={S.td}>
                            <div style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>{e.nombre}</div>
                            {e.activo === false && <span style={{ fontSize: 10, color: '#94a3b8' }}>Retirado {e.fechaFin}</span>}
                          </td>
                          <td style={S.td}><span style={{ fontSize: 12.5, color: '#64748b' }}>{e.tipoDocumento} {e.documento}</span></td>
                          <td style={S.td}><span style={{ fontSize: 12.5, color: '#475569' }}>{e.cargo || '—'}</span></td>
                          <td style={S.td}>
                            <span style={{
                              fontSize: 11, fontWeight: 700, borderRadius: 20, padding: '3px 9px',
                              background: t?.generaPrestaciones ? '#dcfce7' : '#fef3c7',
                              color: t?.generaPrestaciones ? '#166534' : '#92400e'
                            }}>{etiquetaContrato(e.tipoContrato)}</span>
                          </td>
                          <td style={S.td}><strong style={{ fontSize: 13 }}>{fmt(e.salario)}</strong></td>
                          <td style={S.td}><span style={{ fontSize: 12, color: '#64748b' }}>{e.fechaInicio}</span></td>
                          <td style={S.td}><span style={{ fontSize: 12, color: '#64748b' }}>{e.claseRiesgoARL}</span></td>
                          <td style={S.td}>
                            <button onClick={() => setModal({ tipo: 'editar', empleado: e })} style={S.actionBtn}>✏️</button>
                            {e.activo !== false && (
                              <button onClick={async () => {
                                const f = window.prompt('Fecha de retiro (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
                                if (!f) return;
                                await axios.delete(`${API}/empleados/${e.id}`, { headers: headers(), data: { fechaRetiro: f } });
                                setEmpleados(p => p.map(x => x.id === e.id ? { ...x, activo: false, fechaFin: f } : x));
                              }} style={{ ...S.actionBtn, background: '#fef2f2', color: '#991b1b' }}>Retirar</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB 2 · PROVISIONES
          ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'provisiones' && (
        <div>
          <div style={{
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
            background: '#fff', borderRadius: 12, padding: '12px 16px', marginBottom: 16, border: '1px solid #f1f5f9'
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>Período:</span>
            <select style={{ ...S.select, padding: '7px 10px' }} value={periodo.mes}
              onChange={e => setPeriodo(p => ({ ...p, mes: Number(e.target.value) }))}>
              {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select style={{ ...S.select, padding: '7px 10px' }} value={periodo.anio}
              onChange={e => setPeriodo(p => ({ ...p, anio: Number(e.target.value) }))}>
              {(config?.aniosDisponibles || [2026]).map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            {provisiones?.parametros?.estimado && (
              <span style={{ fontSize: 11, color: '#b45309', background: '#fffbeb', padding: '5px 10px', borderRadius: 7 }}>
                ⚠️ Sin parámetros de {provisiones.parametros.anio}; se usan los de {provisiones.parametros.anioBase}
              </span>
            )}
          </div>

          {!provisiones || provisiones.empleadosVigentes === 0 ? (
            <div style={{ background: '#fff', borderRadius: 16, padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              No hay empleados vigentes en {MESES[periodo.mes - 1]} {periodo.anio}.
            </div>
          ) : (
            <>
              {/* KPIs */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 14, marginBottom: 16 }}>
                {[
                  { l: 'Devengado del mes', v: provisiones.totales.devengado, c: '#0284c7', s: `${provisiones.empleadosVigentes} empleado(s)` },
                  { l: 'Prestaciones a causar', v: provisiones.totales.prestaciones, c: '#7c3aed', s: 'Gasto + pasivo' },
                  { l: 'Aportes patronales', v: provisiones.totales.seguridadSocial, c: '#d97706', s: provisiones.empresaExonerada ? 'Con exoneración' : 'Sin exoneración' },
                  { l: 'Costo total del mes', v: provisiones.totales.costoTotal, c: '#dc2626', s: `Factor ${provisiones.totales.factorPromedio.toFixed(2)}x · salario + prestaciones + aportes` },
                ].map(k => (
                  <div key={k.l} style={{ background: '#fff', borderRadius: 12, padding: '15px 18px', borderLeft: `4px solid ${k.c}`, boxShadow: '0 1px 3px rgba(15,23,42,0.06)' }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, marginBottom: 5 }}>{k.l}</div>
                    <div style={{ fontSize: 20, fontWeight: 900, color: k.c }}>{fmt(k.v)}</div>
                    <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>{k.s}</div>
                  </div>
                ))}
              </div>

              {/* Acción de causar */}
              <div style={{
                background: provisiones.yaCausadoEsteMes > 0 ? '#f0fdf4' : '#fffbeb',
                border: `1px solid ${provisiones.yaCausadoEsteMes > 0 ? '#dcfce7' : '#fde68a'}`,
                borderRadius: 14, padding: '16px 20px', marginBottom: 16,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap'
              }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: provisiones.yaCausadoEsteMes > 0 ? '#15803d' : '#92400e', marginBottom: 5 }}>
                    {provisiones.yaCausadoEsteMes > 0
                      ? `✅ ${MESES[periodo.mes - 1]} ya tiene ${provisiones.yaCausadoEsteMes} provisión(es) causada(s)`
                      : `⚠️ Las provisiones de ${MESES[periodo.mes - 1]} todavía no se han causado`}
                  </div>
                  <div style={{ fontSize: 12, color: '#78350f', lineHeight: 1.6, opacity: .9 }}>
                    Causar la provisión registra el gasto del mes <strong>y</strong> la obligación acumulada.
                    No mueve caja: es el asiento que faltaba para que el ERI muestre el costo real de la nómina.
                  </div>
                </div>
                {user?.role === 'admin' && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {/* ✅ NOMINA-REVERTIR-UI-001: solo aparece si hay algo que
                        revertir. Deshacer un mes ya causado es la única forma de
                        corregir un cálculo o de rehacerlo con otros parámetros. */}
                    {provisiones.yaCausadoEsteMes > 0 && (
                      <button onClick={revertirProvisiones} disabled={revirtiendo || causando}
                        style={{
                          padding: '11px 18px', borderRadius: 8, cursor: 'pointer',
                          fontSize: 13, fontWeight: 700, background: '#fef2f2',
                          color: '#b91c1c', border: '1px solid #fecaca',
                        }}>
                        {revirtiendo ? 'Revirtiendo...' : '↩ Revertir el mes'}
                      </button>
                    )}
                    <button onClick={causarProvisiones} disabled={causando || revirtiendo}
                      style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#7c3aed,#6d28d9)', padding: '11px 22px' }}>
                      {causando ? 'Causando...' : `📊 Causar ${fmt(provisiones.totales.prestaciones)}`}
                    </button>
                  </div>
                )}
              </div>

              {/* Desglose por concepto + pasivo acumulado */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div style={{ background: '#fff', borderRadius: 14, padding: '16px 20px', border: '1px solid #f1f5f9' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0f172a', marginBottom: 12 }}>
                    Provisión del mes por concepto
                  </div>
                  {Object.entries(config?.prestaciones || {}).map(([k, cfg]) => (
                    <div key={k} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 3 }}>
                        {/* ✅ NOMINA-INTERESES-001: los intereses ya NO son un
                            1% plano. Se calculan sobre las cesantías acumuladas
                            del año (12% anual proporcional), así que mostrar
                            "1%" al lado del valor confundía: el número no
                            cuadraba con el porcentaje. */}
                        <span style={{ color: '#475569' }}>
                          {cfg.etiqueta}{' '}
                          <span style={{ color: '#cbd5e1' }}>
                            {k === 'interesesCesantias' ? '12% anual' : pct(cfg.pct)}
                          </span>
                        </span>
                        <strong style={{ color: '#0f172a' }}>{fmt(provisiones.porConcepto[k])}</strong>
                      </div>
                      <div style={{ fontSize: 10, color: '#94a3b8' }}>
                        {k === 'interesesCesantias'
                          ? 'Sobre las cesantías acumuladas del año. Arranca bajo en enero y crece cada mes.'
                          : cfg.base}
                      </div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 900, color: '#7c3aed', borderTop: '2px solid #f1f5f9', paddingTop: 10, marginTop: 6 }}>
                    <span>Total del mes</span><span>{fmt(provisiones.totales.prestaciones)}</span>
                  </div>
                </div>

                <div style={{ background: '#fff', borderRadius: 14, padding: '16px 20px', border: '1px solid #f1f5f9' }}>
                  {/* ✅ CLARIDAD: en esta pantalla conviven dos números que se
                      confunden todo el tiempo — lo que se causa ESTE MES y lo
                      acumulado de TODOS los meses. Vale la pena decirlo. */}
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>
                    Pasivo pendiente <span style={{ fontWeight: 600, color: '#94a3b8' }}>· acumulado de todos los meses</span>
                  </div>
                  {/* ✅ FIX NOMINA-PASIVO-001: este número ahora es NETO —
                      causado menos pagado. Antes solo sumaba lo causado y nunca
                      bajaba: al consignar cesantías en febrero o pagar la prima
                      en junio, el saldo seguía completo y el balance mostraba
                      una deuda que la empresa ya no tenía. */}
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12, lineHeight: 1.5 }}>
                    Lo que le debés a tus empleados hoy: causado menos pagado.
                    Los pagos se registran en <strong>Pasivo laboral</strong>.
                  </div>
                  {Object.entries(config?.prestaciones || {}).map(([k, cfg]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0', color: '#475569' }}>
                      <span>{cfg.etiqueta}</span>
                      <span>{fmt(provisiones.pasivoAcumulado[k])}</span>
                    </div>
                  ))}
                  <div style={{
                    background: '#fef2f2', borderRadius: 10, padding: '12px 15px', marginTop: 12,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: '#991b1b', textTransform: 'uppercase' }}>Total pasivo</span>
                    <strong style={{ fontSize: 18, color: '#b91c1c' }}>{fmt(provisiones.pasivoAcumulado.total)}</strong>
                  </div>
                </div>
              </div>

              {/* Detalle por empleado */}
              <div style={S.tableWrap}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['Empleado', 'Contrato', 'Días', 'Base', 'Prestaciones', 'Aportes', 'Costo total', 'Estado'].map(h => (
                        <th key={h} style={S.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {provisiones.detalle.map(d => (
                      <tr key={d.empleadoId} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={S.td}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{d.nombre}</div>
                          <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{d.cargo}</div>
                        </td>
                        <td style={S.td}><span style={{ fontSize: 11.5, color: '#64748b' }}>{d.tipoContratoEtiqueta}</span></td>
                        <td style={S.td}><span style={{ fontSize: 12.5 }}>{d.diasTrabajados}</span></td>
                        <td style={S.td}><span style={{ fontSize: 12.5 }}>{fmt(d.baseConAuxilio)}</span></td>
                        <td style={S.td}>
                          {d.aplicaProvision
                            ? <strong style={{ fontSize: 12.5, color: '#7c3aed' }}>{fmt(d.totalPrestaciones)}</strong>
                            : <span title={d.motivoNoAplica} style={{ fontSize: 11, color: '#94a3b8', cursor: 'help' }}>No aplica ⓘ</span>}
                        </td>
                        <td style={S.td}><span style={{ fontSize: 12.5, color: '#d97706' }}>{fmt(d.totalSeguridadSocial)}</span></td>
                        <td style={S.td}><strong style={{ fontSize: 12.5 }}>{fmt(d.costoTotalEmpleador)}</strong></td>
                        <td style={S.td}>
                          {d.yaCausada
                            ? <span style={{ fontSize: 10.5, fontWeight: 700, background: '#dcfce7', color: '#166534', borderRadius: 20, padding: '3px 9px' }}>Causada</span>
                            : d.aplicaProvision
                              ? <span style={{ fontSize: 10.5, fontWeight: 700, background: '#fef3c7', color: '#92400e', borderRadius: 20, padding: '3px 9px' }}>Pendiente</span>
                              : <span style={{ fontSize: 10.5, color: '#cbd5e1' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB 3 · NÓMINA
          ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'nomina' && (
        <div>
          <div style={{
            background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12,
            padding: '14px 18px', marginBottom: 18, fontSize: 12.5, color: '#1e40af', lineHeight: 1.65
          }}>
            <strong>Cómo funciona el comprobante de nómina.</strong> Al elegir el empleado, el sistema trae
            automáticamente los <strong>anticipos que pidió durante el período</strong> y los descuenta.
            El anticipo nunca fue un gasto: era una cuenta por cobrar al empleado, y acá se cruza.
            Así el gasto del mes es el devengado completo, y de caja solo sale el neto — sin duplicar nada.
          </div>

          {anticipos && anticipos.totalGeneral > 0 && (
            <div style={{ background: '#fff', borderRadius: 14, padding: '16px 20px', marginBottom: 16, border: '1px solid #fde68a', borderLeft: '4px solid #d97706' }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>
                💵 Anticipos pendientes de cruce · {fmt(anticipos.totalGeneral)}
              </div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 12 }}>
                Se descontarán automáticamente al generar el comprobante de cada empleado.
              </div>
              {anticipos.empleados.map(g => (
                <div key={g.empleadoId} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 12.5, padding: '7px 12px', background: '#f8fafc', borderRadius: 8, marginBottom: 5
                }}>
                  <span style={{ color: '#475569' }}>
                    <strong>{g.nombre || 'Sin nombre'}</strong>
                    <span style={{ color: '#94a3b8' }}> · {g.cantidad} anticipo(s)</span>
                  </span>
                  <strong style={{ color: '#d97706' }}>{fmt(g.total)}</strong>
                </div>
              ))}
              {anticipos.sinEmpleadoAsignado?.length > 0 && (
                <div style={{
                  background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 9,
                  padding: '10px 13px', marginTop: 10, fontSize: 11.5, color: '#991b1b', lineHeight: 1.55
                }}>
                  ⚠️ Hay {anticipos.sinEmpleadoAsignado.length} anticipo(s) marcados pero <strong>sin empleado asignado</strong>.
                  No se pueden cruzar hasta que se les asigne el empleado desde Egresos → Editar.
                </div>
              )}
            </div>
          )}

          {empleados.length === 0 ? (
            <div style={{ background: '#fff', borderRadius: 16, padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              Registrá primero los empleados para poder generar comprobantes de nómina.
            </div>
          ) : (
            <div style={{ background: '#fff', borderRadius: 16, padding: 32, textAlign: 'center', border: '1px solid #f1f5f9' }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>🧾</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#334155', marginBottom: 6 }}>
                Generá el comprobante de nómina del período
              </div>
              <div style={{ fontSize: 12.5, color: '#94a3b8', marginBottom: 18, maxWidth: 500, margin: '0 auto 18px' }}>
                Incluye salario, horas extras según la reforma laboral, auxilio de transporte,
                deducciones de ley y el cruce automático de anticipos.
              </div>
              <button onClick={() => setModal({ tipo: 'nomina' })}
                style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#16a34a,#15803d)', padding: '11px 24px', fontSize: 14 }}>
                🧾 Nuevo comprobante de nómina
              </button>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════
              ✅ NOMINA-COLILLA-REIMPRESION-001 — comprobantes ya emitidos
              ───────────────────────────────────────────────────────────────
              El detalle siempre estuvo guardado en el comprobante, pero no
              había pantalla que lo mostrara: para reimprimir una colilla
              tocaba volver a digitarla en Excel. Ahí fue donde se cambiaron
              los valores de la prima y las vacaciones.
              ═══════════════════════════════════════════════════════════════ */}
          {comprobantes.length > 0 && (
            <div style={{ ...S.tableWrap, marginTop: 18 }}>
              <div style={{ padding: '18px 20px 12px' }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>
                  Comprobantes emitidos · {MESES[periodo.mes - 1]} {periodo.anio}
                </div>
                <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 4 }}>
                  Volvé a imprimir la colilla cuando la necesites. No hace falta rehacerla.
                </div>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={S.th}>N°</th>
                    <th style={S.th}>Empleado</th>
                    <th style={S.th}>Período</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Devengado</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Neto pagado</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Colilla</th>
                  </tr>
                </thead>
                <tbody>
                  {comprobantes.map(c => (
                    <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={S.td}><span style={{ fontSize: 12.5 }}>{c.numero}</span></td>
                      <td style={S.td}>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a' }}>{c.empleadoNombre}</span>
                      </td>
                      <td style={S.td}>
                        <span style={{ fontSize: 12, color: '#64748b' }}>
                          {c.periodo?.desde || '—'} a {c.periodo?.hasta || '—'}
                          {c.periodo?.diasTrabajados != null && ` · ${c.periodo.diasTrabajados} días`}
                        </span>
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', fontSize: 12.5 }}>{fmt(c.totalDevengado)}</td>
                      <td style={{ ...S.td, textAlign: 'right', fontSize: 13, fontWeight: 800, color: '#15803d' }}>
                        {fmt(c.netoAPagar)}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right' }}>
                        <button style={S.actionBtn}
                          onClick={() => imprimirComprobanteNomina({
                            liquidacion: c.colilla,
                            empleado: {
                              nombre: c.colilla.nombre, documento: c.colilla.documento,
                              cargo: c.colilla.cargo,
                            },
                            empresa: empresas[0] || {},
                            numero: c.numero,
                          })}>
                          🖨 Imprimir
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB · PASIVO LABORAL — ✅ NOMINA-PASIVO-001
          ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'pasivo' && (
        <PanelPasivoLaboral
          empleados={empleados} cajas={cajas} empresas={empresas}
          onCambio={cargar} />
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          TAB 4 · AJUSTES
          ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'ajustes' && <PanelNominaConfig user={user} />}

      {modal?.tipo === 'nuevo' && <ModalEmpleado config={config} onGuardar={crear} onCerrar={() => setModal(null)} />}
      {modal?.tipo === 'editar' && <ModalEmpleado empleado={modal.empleado} config={config} onGuardar={editar} onCerrar={() => setModal(null)} />}
      {modal?.tipo === 'nomina' && (
        <ModalNomina
          empleados={empleados} config={config} cajas={cajas} empresas={empresas}
          onGenerado={(r) => {
            setModal(null);
            // ✅ NOMINA-COLILLA-001: se ofrece imprimir en el momento. El
            // trabajador firma el recibido y esa copia queda en su carpeta.
            const imprimir = window.confirm(
              `✅ Comprobante ${r.numero} generado\n\n` +
              `Devengado: ${fmt(r.liquidacion.totalDevengado)}\n` +
              `Neto pagado: ${fmt(r.liquidacion.netoAPagar)}\n` +
              (r.anticiposCruzados > 0 ? `Anticipos cruzados: ${r.anticiposCruzados} por ${fmt(r.totalAnticiposCruzados)}\n` : '') +
              `\nCosto real para la empresa: ${fmt(r.liquidacion.costoTotalEmpleador)}\n\n` +
              `¿Imprimir la colilla para que el trabajador firme el recibido?`
            );
            if (imprimir) {
              const emp = empleados.find(e => e.id === r.liquidacion?.empleadoId) || {};
              imprimirComprobanteNomina({
                liquidacion: r.liquidacion,
                empleado: emp,
                empresa: empresas[0] || {},
                numero: r.numero,
              });
            }
            cargar();
          }}
          onCerrar={() => setModal(null)} />
      )}
    </div>
  );
}

const S = {
  page: { padding: '24px 32px', maxWidth: 1500, margin: '0 auto' },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 },
  pageTitle: { margin: 0, fontSize: 26, fontWeight: 800, color: '#1e293b' },
  pageSubtitle: { margin: '4px 0 0', fontSize: 13, color: '#64748b' },
  tableWrap: { background: '#fff', borderRadius: 14, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'auto' },
  th: { padding: '12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' },
  td: { padding: '11px 12px', verticalAlign: 'middle' },
  actionBtn: { padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#f1f5f9', color: '#475569', marginRight: 4 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal: { background: '#fff', borderRadius: 16, maxWidth: 580, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxHeight: '92vh', overflowY: 'auto' },
  modalHeader: { padding: '20px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' },
  closeBtn: { background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8', padding: 4 },
  modalBody: { padding: '16px 24px 20px' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: 700, color: '#374151' },
  input: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  select: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  btnPrimary: { padding: '10px 20px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnSecondary: { padding: '10px 20px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
