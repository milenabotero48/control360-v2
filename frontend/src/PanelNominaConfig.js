// ═══════════════════════════════════════════════════════════════════════════════
// PanelNominaConfig.js — Parámetros de nómina y cierre contable
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PROVISIONES-001 · EGRESO-INTELIGENTE-001
//
// DOS AJUSTES QUE CAMBIAN LAS CIFRAS
// ----------------------------------
// 1. EXONERACIÓN DE APORTES (art. 114-1 E.T.)
//    Si la empresa está exonerada, no aporta salud (8,5%), SENA (2%) ni
//    ICBF (3%) por los empleados que ganen menos de 10 SMMLV. Son ~13,5
//    puntos porcentuales sobre la nómina: sobre 15 millones mensuales, cerca
//    de $2 millones de diferencia.
//
//    El sistema NO puede determinar esto solo — depende de la naturaleza
//    jurídica de la empresa y de su situación tributaria. Por eso esta
//    pantalla explica el beneficio, dice quiénes pueden acogerse, y pide
//    explícitamente que se confirme con el contador antes de activarlo.
//
// 2. CIERRE DE PERÍODO
//    Marca hasta qué fecha la contabilidad está cerrada. A partir de ahí no
//    se pueden registrar egresos con fecha anterior sin reabrir el período.
//    Nace de un hallazgo real: un CxP con fecha de agosto aparecía dentro del
//    informe de julio.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(n || 0);

export default function PanelNominaConfig({ user }) {
  const [config, setConfig] = useState(null);
  const [paramsNomina, setParams] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState('');

  const [exonerada, setExonerada] = useState(true);
  const [confirmado, setConfirmado] = useState(false);
  const [periodoCerrado, setPeriodoCerrado] = useState('');

  const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

  useEffect(() => {
    (async () => {
      try {
        const [c, p] = await Promise.all([
          axios.get(`${API}/configuracion`, { headers: headers() }).catch(() => ({ data: {} })),
          axios.get(`${API}/empleados/config`, { headers: headers() }).catch(() => ({ data: null })),
        ]);
        setConfig(c.data || {});
        setParams(p.data);
        setExonerada(c.data?.empresaExoneradaAportes !== false);
        setConfirmado(c.data?.exoneracionConfirmadaConContador === true);
        setPeriodoCerrado(c.data?.periodoCerradoHasta || '');
      } catch { }
      setCargando(false);
    })();
  }, []);

  const guardarExoneracion = async () => {
    setGuardando(true); setMensaje('');
    try {
      await axios.put(`${API}/configuracion/nomina`,
        { empresaExoneradaAportes: exonerada, confirmadoConContador: confirmado },
        { headers: headers() });
      setMensaje('✅ Guardado. Las provisiones se recalculan con este criterio.');
    } catch (e) {
      setMensaje('✖ ' + (e.response?.data?.error || e.message));
    }
    setGuardando(false);
  };

  const guardarPeriodo = async () => {
    setGuardando(true); setMensaje('');
    try {
      await axios.put(`${API}/configuracion/periodo-cerrado`,
        { periodoCerradoHasta: periodoCerrado || null }, { headers: headers() });
      setMensaje(periodoCerrado
        ? `✅ Contabilidad cerrada hasta ${periodoCerrado}.`
        : '✅ Cierre de período eliminado.');
    } catch (e) {
      setMensaje('✖ ' + (e.response?.data?.error || e.message));
    }
    setGuardando(false);
  };

  if (cargando) return <div style={{ padding: 30, color: '#64748b', fontSize: 13 }}>⏳ Cargando parámetros...</div>;

  const smmlv = paramsNomina?.parametros?.smmlv || 0;
  const tope = smmlv * 10;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ═══════════════════════════════════════════════════════════════════════
          EXONERACIÓN DE APORTES
          ═══════════════════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={S.cardTitle}>
          <span style={{ ...S.acento, background: '#7c3aed' }} />
          Exoneración de aportes parafiscales y salud
        </div>

        {/* Explicación del beneficio */}
        <div style={{
          background: 'linear-gradient(135deg,#faf5ff,#eef2ff)', border: '1px solid #ddd6fe',
          borderRadius: 12, padding: '16px 18px', marginBottom: 16
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: '#5b21b6', marginBottom: 8 }}>
            💡 Puede que tu empresa tenga derecho a este beneficio
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: '#4c1d95', lineHeight: 1.7 }}>
            El <strong>artículo 114-1 del Estatuto Tributario</strong> (modificado por la Ley 1819 de 2016)
            exonera a ciertos empleadores de pagar tres aportes sobre los empleados que ganen{' '}
            <strong>menos de 10 salarios mínimos</strong> {smmlv > 0 && <>({fmt(tope)} en {paramsNomina?.parametros?.anio})</>}:
          </p>

          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 14 }}>
            {[
              { l: 'Salud (EPS)', p: '8,5%' },
              { l: 'SENA', p: '2%' },
              { l: 'ICBF', p: '3%' },
            ].map(x => (
              <div key={x.l} style={{
                background: '#fff', border: '1px solid #ddd6fe', borderRadius: 9,
                padding: '8px 14px', textAlign: 'center'
              }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: '#7c3aed' }}>{x.p}</div>
                <div style={{ fontSize: 10.5, color: '#6b21a8', fontWeight: 600 }}>{x.l}</div>
              </div>
            ))}
            <div style={{
              background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 9,
              padding: '8px 14px', display: 'flex', alignItems: 'center'
            }}>
              <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
                <strong>13,5% en total</strong><br />
                <span style={{ color: '#94a3b8' }}>de ahorro sobre la nómina</span>
              </div>
            </div>
          </div>

          <div style={{ background: '#fff', borderRadius: 10, padding: '13px 16px', fontSize: 12, color: '#475569', lineHeight: 1.7 }}>
            <strong style={{ color: '#5b21b6' }}>¿Quiénes pueden acogerse?</strong>
            <ul style={{ margin: '7px 0 0', paddingLeft: 20 }}>
              <li>Sociedades y personas jurídicas que sean <strong>contribuyentes declarantes del impuesto de renta</strong> (una SAS típica lo es).</li>
              <li>Personas naturales empleadoras, siempre que tengan <strong>dos o más trabajadores</strong>.</li>
            </ul>

            <strong style={{ color: '#5b21b6', display: 'block', marginTop: 12 }}>¿Quiénes NO?</strong>
            <ul style={{ margin: '7px 0 0', paddingLeft: 20 }}>
              <li>Entidades no contribuyentes del impuesto de renta.</li>
              <li>Personas naturales con un solo empleado.</li>
              <li>Por los empleados que ganen 10 SMMLV o más — para ellos se aportan todos los conceptos.</li>
            </ul>

            <div style={{ marginTop: 12, paddingTop: 11, borderTop: '1px dashed #e2e8f0' }}>
              <strong style={{ color: '#5b21b6' }}>Lo que NO se exonera nunca:</strong> pensión (12%),
              ARL (según clase de riesgo) y Caja de Compensación (4%). Esos se siguen pagando completos.
            </div>
          </div>

          {/* Advertencia profesional */}
          <div style={{
            background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10,
            padding: '12px 15px', marginTop: 13, fontSize: 12, color: '#92400e', lineHeight: 1.65
          }}>
            <strong>⚠️ Consultalo con tu contador antes de activarlo.</strong> Esta es una decisión
            tributaria, no una preferencia del sistema. Depende de la naturaleza jurídica de tu empresa
            y de su situación frente al impuesto de renta, y el sistema no tiene cómo determinarlo solo.
            Activarlo sin tener derecho genera un pasivo con la UGPP; no activarlo teniendo derecho te
            hace pagar de más. Tu contador lo resuelve en un minuto.
          </div>
        </div>

        {/* El switch */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 14, padding: '15px 18px',
          background: exonerada ? '#f0fdf4' : '#f8fafc',
          border: `2px solid ${exonerada ? '#86efac' : '#e2e8f0'}`,
          borderRadius: 12, marginBottom: 14
        }}>
          <input type="checkbox" id="exonerada" checked={exonerada}
            onChange={e => setExonerada(e.target.checked)}
            style={{ width: 21, height: 21, cursor: 'pointer', marginTop: 2, flexShrink: 0 }} />
          <label htmlFor="exonerada" style={{ cursor: 'pointer', flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: exonerada ? '#15803d' : '#475569' }}>
              Mi empresa está exonerada de salud, SENA e ICBF
            </div>
            <div style={{ fontSize: 12, color: exonerada ? '#166534' : '#64748b', marginTop: 4, lineHeight: 1.55 }}>
              {exonerada
                ? 'Las provisiones se calculan SIN estos tres aportes para los empleados que ganen menos de 10 SMMLV. El aporte patronal queda en ~19% (pensión + ARL + caja).'
                : 'Las provisiones se calculan CON todos los aportes. El aporte patronal queda en ~32,5%.'}
            </div>
          </label>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 11, padding: '11px 16px',
          background: '#f8fafc', borderRadius: 10, marginBottom: 14
        }}>
          <input type="checkbox" id="confirmado" checked={confirmado}
            onChange={e => setConfirmado(e.target.checked)}
            style={{ width: 17, height: 17, cursor: 'pointer', flexShrink: 0 }} />
          <label htmlFor="confirmado" style={{ cursor: 'pointer', fontSize: 12, color: '#475569', lineHeight: 1.5 }}>
            Confirmé este criterio con mi contador
            <span style={{ color: '#94a3b8' }}> — queda registrado en la auditoría junto con la fecha y el usuario.</span>
          </label>
        </div>

        {!confirmado && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 9,
            padding: '10px 14px', marginBottom: 14, fontSize: 11.5, color: '#991b1b', lineHeight: 1.55
          }}>
            Podés guardar sin confirmar, pero quedará marcado como <strong>sin validación contable</strong>.
            Es un dato que afecta cifras tributarias: vale la pena cerrarlo bien.
          </div>
        )}

        <button onClick={guardarExoneracion} disabled={guardando} style={S.btnPrimary}>
          {guardando ? 'Guardando...' : 'Guardar criterio de exoneración'}
        </button>

        {config?.exoneracionActualizadaEn && (
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 10 }}>
            Última actualización: {String(config.exoneracionActualizadaEn).slice(0, 16).replace('T', ' ')}
            {config.exoneracionActualizadaPor && ` · ${config.exoneracionActualizadaPor}`}
            {config.exoneracionConfirmadaConContador
              ? ' · ✓ confirmado con contador'
              : ' · ⚠️ sin confirmar con contador'}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          CIERRE DE PERÍODO
          ═══════════════════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={S.cardTitle}>
          <span style={{ ...S.acento, background: '#dc2626' }} />
          Cierre de período contable
        </div>

        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#475569', lineHeight: 1.7 }}>
          Al cerrar un período, el sistema <strong>alerta</strong> cuando alguien intente registrar un egreso
          con fecha anterior a esa. Sirve para proteger los meses cuyo estado de resultados ya se emitió
          o ya se declaró.
        </p>

        <div style={{
          background: '#f8fafc', borderRadius: 10, padding: '12px 15px', marginBottom: 16,
          fontSize: 11.5, color: '#64748b', lineHeight: 1.6
        }}>
          <strong style={{ color: '#334155' }}>Por qué hace falta:</strong> en el informe de julio de 2026
          apareció un movimiento con fecha del 2 de agosto. Errores así no se ven a simple vista en cientos
          de registros, pero mueven las cifras de un mes que ya se dio por cerrado.
        </div>

        <div style={{ display: 'flex', gap: 11, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={S.label}>Contabilidad cerrada hasta</label>
            <input type="date" style={S.input} value={periodoCerrado}
              onChange={e => setPeriodoCerrado(e.target.value)} />
          </div>
          <button onClick={guardarPeriodo} disabled={guardando} style={S.btnPrimary}>
            {guardando ? 'Guardando...' : periodoCerrado ? '🔒 Cerrar período' : 'Quitar cierre'}
          </button>
          {periodoCerrado && (
            <button onClick={() => setPeriodoCerrado('')} style={S.btnSecondary}>
              Limpiar
            </button>
          )}
        </div>

        {config?.periodoCerradoHasta && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 9,
            padding: '10px 14px', fontSize: 12, color: '#991b1b'
          }}>
            🔒 Actualmente cerrado hasta <strong>{config.periodoCerradoHasta}</strong>
            {config.periodoCerradoPor && <span style={{ color: '#b91c1c' }}> · por {config.periodoCerradoPor}</span>}
          </div>
        )}
      </div>

      {mensaje && (
        <div style={{
          background: mensaje.startsWith('✅') ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${mensaje.startsWith('✅') ? '#bbf7d0' : '#fecaca'}`,
          borderRadius: 10, padding: '12px 16px', fontSize: 12.5,
          color: mensaje.startsWith('✅') ? '#15803d' : '#991b1b'
        }}>{mensaje}</div>
      )}
    </div>
  );
}

const S = {
  card: { background: '#fff', borderRadius: 16, padding: '20px 24px', border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(15,23,42,0.06)' },
  cardTitle: { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 800, color: '#0f172a', marginBottom: 16 },
  acento: { width: 4, height: 18, borderRadius: 4, display: 'inline-block' },
  label: { fontSize: 12, fontWeight: 700, color: '#374151' },
  input: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  btnPrimary: { padding: '10px 20px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnSecondary: { padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
