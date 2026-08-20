// ═══════════════════════════════════════════════════════════════════════════════
// ModalRetroactivas.js — Causar meses anteriores de un empleado, de una vez
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PASIVO-001
//
// EL PROBLEMA: al registrar a alguien que ya venía trabajando, había que ir mes
// por mes cambiando el período y dándole "Causar" — y cada clic tocaba además a
// todos los demás empleados de ese mes.
//
// EL DETALLE QUE NADIE VE VENIR: la causación retroactiva usa el salario ACTUAL.
// Si el trabajador tuvo aumentos, los meses viejos quedan sobrevalorados. Por eso
// esta pantalla permite cargar los tramos de salario históricos.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState } from 'react';
import { S, Aviso, api, fmt, hoyISO, errorDe } from './nominaUI';

const ModalRetroactivas = ({ empleado, onListo, onCerrar }) => {
  const [desde, setDesde] = useState(String(empleado.fechaInicio || '').slice(0, 10) || '');
  const [hasta, setHasta] = useState(hoyISO());
  const [tramos, setTramos] = useState([]);
  const [resultado, setResultado] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const agregarTramo = () => setTramos(t => [...t, { desde: '', salario: '' }]);
  const setTramo = (i, k, v) => setTramos(t => t.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const quitarTramo = (i) => setTramos(t => t.filter((_, j) => j !== i));

  const causar = async () => {
    setError('');
    if (!desde) return setError('Indicá desde qué mes causar');
    setGuardando(true);
    try {
      const r = await api.post('/prestaciones/retroactivas', {
        empleadoId: empleado.id, desde, hasta,
        salariosHistoricos: tramos
          .filter(t => t.desde && Number(t.salario) > 0)
          .map(t => ({ desde: t.desde.slice(0, 7), salario: Number(t.salario) })),
      });
      setResultado(r.data);
    } catch (e) { setError(errorDe(e, 'No se pudieron causar las provisiones')); }
    setGuardando(false);
  };

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onCerrar()}>
      <div style={S.modal(620)}>
        <div style={S.modalHeader}>
          <div>
            <h3 style={S.modalTitle}>Causar provisiones retroactivas</h3>
            <p style={S.cardSub}>{empleado.nombre} · ingreso {empleado.fechaInicio || '—'}</p>
          </div>
          <button onClick={onCerrar} style={S.closeBtn}>×</button>
        </div>

        <div style={S.modalBody}>
          {!resultado ? (
            <>
              <Aviso nivel="info" style={{ marginBottom: 16 }}>
                Se causan solo los meses que <strong>todavía no tienen provisión</strong>. Si repetís la
                operación no se duplica nada. Las horas extras de cada mes se toman de los
                comprobantes de nómina que ya existan.
              </Aviso>

              <div style={S.row2}>
                <div style={S.field}>
                  <label style={S.label}>Desde *</label>
                  <input type="date" style={S.input} value={desde} onChange={e => setDesde(e.target.value)} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>Hasta</label>
                  <input type="date" style={S.input} value={hasta} onChange={e => setHasta(e.target.value)} />
                </div>
              </div>

              <div style={{ ...S.card, background: '#f8fafc', marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <h4 style={{ ...S.cardTitle, fontSize: 13.5 }}>Salarios históricos</h4>
                    <p style={{ ...S.cardSub, fontSize: 11.5 }}>
                      Opcional. Sin esto, todos los meses se causan con el salario actual
                      ({fmt(empleado.salario)}) — y si hubo aumentos, los meses viejos quedan inflados.
                    </p>
                  </div>
                  <button type="button" onClick={agregarTramo} style={S.btnMini}>+ Agregar tramo</button>
                </div>

                {tramos.map((t, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 11 }}>
                    <div style={{ ...S.field, marginBottom: 0, flex: 1 }}>
                      <label style={{ ...S.label, fontSize: 11 }}>Vigente desde</label>
                      <input type="month" style={S.input} value={t.desde} onChange={e => setTramo(i, 'desde', e.target.value)} />
                    </div>
                    <div style={{ ...S.field, marginBottom: 0, flex: 1 }}>
                      <label style={{ ...S.label, fontSize: 11 }}>Salario</label>
                      <input type="number" min="0" style={S.input} value={t.salario} onChange={e => setTramo(i, 'salario', e.target.value)} />
                    </div>
                    <button type="button" onClick={() => quitarTramo(i)}
                      style={{ ...S.btnMini, color: '#dc2626', padding: '9px 11px' }}>×</button>
                  </div>
                ))}
              </div>

              {error && <Aviso nivel="grave" style={{ marginBottom: 10 }}>{error}</Aviso>}

              <div style={S.modalFooter}>
                <button onClick={onCerrar} style={S.btnSecondary} disabled={guardando}>Cancelar</button>
                <button onClick={causar} style={{ ...S.btnPago, opacity: guardando ? 0.6 : 1 }} disabled={guardando}>
                  {guardando ? 'Causando…' : 'Causar el rango'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{
                background: 'linear-gradient(135deg,#7c3aed,#6d28d9)', borderRadius: 14,
                padding: '18px 22px', color: '#fff', marginBottom: 16,
              }}>
                <div style={{ fontSize: 11.5, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>
                  {resultado.mesesCausados} mes(es) causados
                </div>
                <div style={{ fontSize: 27, fontWeight: 800, marginTop: 4 }}>{fmt(resultado.totalPrestaciones)}</div>
                <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 6 }}>
                  Gasto reconocido en cada mes correspondiente y pasivo acumulado en el balance.
                </div>
              </div>

              {(resultado.avisos || []).map((a, i) => (
                <Aviso key={i} nivel={a.nivel} style={{ marginBottom: 10 }}>{a.texto}</Aviso>
              ))}

              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={S.th}>Mes</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Días</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Extras</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Provisión</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.creadas.map(c => (
                      <tr key={c.periodo}>
                        <td style={S.td}>{c.periodo}</td>
                        <td style={S.tdNum}>{c.dias}</td>
                        <td style={S.tdNum}>{c.extras > 0 ? fmt(c.extras) : '—'}</td>
                        <td style={S.tdNum}>{fmt(c.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {resultado.omitidos?.length > 0 && (
                <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 11, lineHeight: 1.6 }}>
                  <strong>Omitidos:</strong> {resultado.omitidos.map(o => `${o.periodo} (${o.razon})`).join(' · ')}
                </div>
              )}

              <div style={S.modalFooter}>
                <button onClick={() => onListo(resultado)} style={S.btnPrimary}>Listo</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModalRetroactivas;
