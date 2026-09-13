// ============================================================
// Control360 — Validación de pagos en lote (PAGO-LOTE-004)
// Ubicación: frontend/src/ValidacionPagosLote.js
// ============================================================
// Tesorería abre el extracto del banco, ve la lista de pagos
// electrónicos pendientes y decide fila por fila:
//   ✅ Aprobar    → forma exacta + caja destino (obligatoria)
//   ✖ No aprobar → motivo (prellenado, editable) → la orden pasa a CxC
//   —  Pendiente  → no se toca
// Un solo PIN confirma la tanda. El backend procesa cada orden por
// la MISMA función que el botón individual (candado de caja incluido)
// y devuelve el resultado fila por fila.
//
// Mobile first: en pantalla angosta cada pago es una tarjeta con
// controles grandes y la barra de acción queda fija abajo. En
// escritorio, la misma información en filas. Nunca una tabla que
// desborde.
// ============================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const FORMAS_DEFAULT = ['Transferencia', 'Nequi', 'Daviplata', 'Datafono'];
const MOTIVO_DEFAULT = 'No se refleja el pago en el banco';
const MAX_LOTE = 50;

const fmt = (n) => `$${(Number(n) || 0).toLocaleString('es-CO')}`;
const fmtFecha = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
};
const esEfectivoOCredito = (f) => {
  const s = String(f || '').toLowerCase();
  return s.includes('efectivo') || s.includes('crédito') || s.includes('credito') || s === 'cxc' || s.includes('cuenta por pagar');
};

const useIsMobile = () => {
  const [mob, setMob] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMob(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mob;
};

export default function ValidacionPagosLote({ onCerrar, onProcesado }) {
  const isMobile = useIsMobile();
  const headers = useMemo(() => ({ Authorization: `Bearer ${localStorage.getItem('token')}` }), []);

  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [pendientes, setPendientes] = useState([]);
  const [cajas, setCajas] = useState([]);
  const [formasPago, setFormasPago] = useState(FORMAS_DEFAULT);
  const [mapeoFormaCaja, setMapeoFormaCaja] = useState({}); // nombreForma(lower) -> cajaId
  // decisiones[id] = { accion: 'aprobar'|'rechazar'|null, forma, cajaId, motivo }
  const [decisiones, setDecisiones] = useState({});
  const [pin, setPin] = useState('');
  const [pedirPin, setPedirPin] = useState(false);
  const [procesando, setProcesando] = useState(false);
  const [resultado, setResultado] = useState(null);

  // ── Carga ─────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setCargando(true);
    setError('');
    try {
      const [rp, rc, rcfg] = await Promise.all([
        axios.get(`${API}/orders/pagos-pendientes-validacion`, { headers }),
        axios.get(`${API}/cajas`, { headers }).catch(() => ({ data: [] })),
        axios.get(`${API}/configuracion`, { headers }).catch(() => ({ data: {} }))
      ]);
      const lista = rp.data.pendientes || [];
      const noEfectivo = (rc.data || []).filter(c =>
        c.activa !== false && !((c.tipo || '').toLowerCase().includes('efectivo') || (c.nombre || '').toLowerCase().includes('efectivo'))
      );
      const cfg = rcfg.data || {};
      const activas = (cfg.formasPago || []).filter(f => f.activa).map(f => f.nombre).filter(f => !esEfectivoOCredito(f));
      const mapeo = {};
      (cfg.formasPago || []).forEach(f => { if (f.cajaId && f.nombre) mapeo[String(f.nombre).toLowerCase()] = f.cajaId; });
      Object.entries(cfg.mapeoCajas || {}).forEach(([k, v]) => { if (v) mapeo[String(k).toLowerCase()] = v; });

      setPendientes(lista);
      setCajas(noEfectivo);
      setFormasPago(activas.length ? activas : FORMAS_DEFAULT);
      setMapeoFormaCaja(mapeo);

      // Preselección por fila: forma declarada; caja sugerida por el cuadre →
      // caja mapeada a esa forma → única caja no efectivo → vacío.
      const ini = {};
      for (const p of lista) {
        const forma = p.formaPago && !esEfectivoOCredito(p.formaPago) ? p.formaPago : '';
        let cajaId = '';
        if (p.cajaSugeridaId && noEfectivo.some(c => c.id === p.cajaSugeridaId)) cajaId = p.cajaSugeridaId;
        else if (forma && mapeo[forma.toLowerCase()] && noEfectivo.some(c => c.id === mapeo[forma.toLowerCase()])) cajaId = mapeo[forma.toLowerCase()];
        else if (noEfectivo.length === 1) cajaId = noEfectivo[0].id;
        ini[p.id] = { accion: null, forma, cajaId, motivo: MOTIVO_DEFAULT };
      }
      setDecisiones(ini);
    } catch (e) {
      setError(e.response?.data?.error || 'No se pudo cargar la lista de pagos pendientes');
    } finally {
      setCargando(false);
    }
  }, [headers]);

  useEffect(() => { cargar(); }, [cargar]);

  // ── Decisiones ────────────────────────────────────────────
  const setDec = (id, patch) => setDecisiones(d => ({ ...d, [id]: { ...(d[id] || {}), ...patch } }));

  const cambiarForma = (id, forma) => {
    const d = decisiones[id] || {};
    const mapeada = mapeoFormaCaja[String(forma).toLowerCase()];
    const cajaId = mapeada && cajas.some(c => c.id === mapeada) ? mapeada : d.cajaId;
    setDec(id, { forma, cajaId });
  };

  const marcarTodas = (accion) => {
    setDecisiones(d => {
      const n = { ...d };
      for (const p of pendientes) n[p.id] = { ...(n[p.id] || {}), accion };
      return n;
    });
  };

  const aAprobar = pendientes.filter(p => decisiones[p.id]?.accion === 'aprobar');
  const aRechazar = pendientes.filter(p => decisiones[p.id]?.accion === 'rechazar');
  const totalAprobar = aAprobar.reduce((s, p) => s + p.total, 0);
  const sinCaja = aAprobar.filter(p => !decisiones[p.id]?.cajaId);
  const sinMotivo = aRechazar.filter(p => String(decisiones[p.id]?.motivo || '').trim().length < 5);
  const seleccionadas = aAprobar.length + aRechazar.length;
  const bloqueo = seleccionadas === 0 ? 'Marca al menos un pago'
    : seleccionadas > MAX_LOTE ? `Máximo ${MAX_LOTE} por tanda`
    : sinCaja.length ? `${sinCaja.length} aprobación(es) sin caja destino`
    : sinMotivo.length ? `${sinMotivo.length} rechazo(s) sin motivo`
    : null;

  // ── Envío ─────────────────────────────────────────────────
  const confirmar = async () => {
    setError('');
    if (!/^\d{4}$/.test(pin)) { setError('El PIN debe ser de 4 dígitos'); return; }
    const items = [...aAprobar, ...aRechazar].map(p => {
      const d = decisiones[p.id];
      return d.accion === 'aprobar'
        ? { ordenId: p.id, numeroOrden: p.numeroOrden, aprobado: true, cajaId: d.cajaId, formaPagoConfirmada: d.forma || undefined }
        : { ordenId: p.id, numeroOrden: p.numeroOrden, aprobado: false, motivo: String(d.motivo || '').trim() };
    });
    try {
      setProcesando(true);
      const r = await axios.post(`${API}/orders/validar-pagos-lote`, { pin, items }, { headers });
      setResultado(r.data);
      setPedirPin(false);
      setPin('');
      if (typeof onProcesado === 'function') onProcesado(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'No se pudo procesar la tanda');
    } finally {
      setProcesando(false);
    }
  };

  const cerrarResultado = async () => {
    setResultado(null);
    await cargar();
  };

  // ── Render ────────────────────────────────────────────────
  return (
    <div style={S.overlay}>
      <div style={{ ...S.panel, ...(isMobile ? S.panelMovil : {}) }}>
        <div style={S.header}>
          <div>
            <div style={S.titulo}>Validar pagos en lote</div>
            <div style={S.sub}>{cargando ? 'Cargando…' : `${pendientes.length} pendiente(s) · ${fmt(pendientes.reduce((s, p) => s + p.total, 0))}`}</div>
          </div>
          <button onClick={onCerrar} style={S.btnCerrar} aria-label="Cerrar">✕</button>
        </div>

        {error && <div style={S.alertError}>⚠ {error}</div>}

        {!cargando && pendientes.length > 0 && !resultado && (
          <div style={S.acciones}>
            <button onClick={() => marcarTodas('aprobar')} style={S.btnMini}>✅ Aprobar todas</button>
            <button onClick={() => marcarTodas(null)} style={S.btnMini}>Limpiar</button>
            <span style={{ fontSize: 11.5, color: '#6b7280', marginLeft: 'auto' }}>Revisa contra el extracto antes de marcar</span>
          </div>
        )}

        <div style={S.lista}>
          {cargando && <div style={S.vacio}>Cargando pagos pendientes…</div>}
          {!cargando && !pendientes.length && !resultado && <div style={S.vacio}>🎉 No hay pagos pendientes de validar.</div>}

          {resultado && (
            <div style={S.resultado}>
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>Tanda procesada</div>
              <div style={{ fontSize: 13, color: '#374151' }}>
                ✅ {resultado.resumen.aprobadas} aprobados ({fmt(resultado.resumen.montoAprobado)}) · ✖ {resultado.resumen.rechazadas} rechazados
                {resultado.resumen.fallidas > 0 && <> · ⚠️ {resultado.resumen.fallidas} con error</>}
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {resultado.resultados.map(r => (
                  <div key={r.ordenId} style={{ ...S.filaRes, background: r.ok ? (r.aprobado ? '#f0fdf4' : '#fff7ed') : '#fef2f2' }}>
                    <span style={{ fontWeight: 700 }}>{r.numeroOrden || r.ordenId}</span>
                    <span style={{ fontSize: 12.5 }}>
                      {r.ok ? (r.aprobado ? `Aprobado → ${r.estado}${r.caja?.tipo === 'sin_caja' ? ' · ⚠ sin caja asignada' : ''}` : 'Rechazado → CxC') : `Error: ${r.error}`}
                    </span>
                  </div>
                ))}
              </div>
              <button onClick={cerrarResultado} style={{ ...S.btnPrimario, marginTop: 14, width: '100%' }}>Volver a la lista</button>
            </div>
          )}

          {!cargando && !resultado && pendientes.map(p => {
            const d = decisiones[p.id] || {};
            const esAprobar = d.accion === 'aprobar';
            const esRechazar = d.accion === 'rechazar';
            return (
              <div key={p.id} style={{ ...S.card, borderColor: esAprobar ? '#86efac' : esRechazar ? '#fca5a5' : '#e5e7eb', background: esAprobar ? '#f0fdf4' : esRechazar ? '#fff5f5' : '#fff' }}>
                <div style={S.cardTop}>
                  <div style={{ minWidth: 0 }}>
                    <div style={S.orden}>{p.numeroOrden} <span style={S.cliente}>· {p.clienteNombre}</span></div>
                    <div style={S.meta}>
                      {p.formaPago || 'Electrónico'} · {fmtFecha(p.fechaPago)}{p.pagadoPorNombre ? ` · ${p.pagadoPorNombre}` : ''}
                      {p.pagoReportadoAnny && !p.pagoReportadoAnny.validado && <span style={S.tagAnny}> Anny recibió soporte</span>}
                    </div>
                  </div>
                  <div style={S.monto}>{fmt(p.total)}</div>
                </div>

                <div style={S.cardMid}>
                  {p.fotoTransferenciaUrl
                    ? <a href={p.fotoTransferenciaUrl} target="_blank" rel="noreferrer" style={S.linkFoto}>📸 Ver comprobante</a>
                    : <span style={S.sinFoto}>⚠ Sin foto del comprobante</span>}
                  <div style={S.toggle}>
                    <button onClick={() => setDec(p.id, { accion: esAprobar ? null : 'aprobar' })} style={{ ...S.tBtn, ...(esAprobar ? S.tBtnOk : {}) }}>✅ Aprobar</button>
                    <button onClick={() => setDec(p.id, { accion: esRechazar ? null : 'rechazar' })} style={{ ...S.tBtn, ...(esRechazar ? S.tBtnNo : {}) }}>✖ No aprobar</button>
                  </div>
                </div>

                {esAprobar && (
                  <div style={S.cardCampos}>
                    <label style={S.campo}>
                      <span style={S.label}>Forma exacta</span>
                      <select value={d.forma || ''} onChange={e => cambiarForma(p.id, e.target.value)} style={S.select}>
                        <option value="">— como se declaró —</option>
                        {[...new Set([d.forma, ...formasPago].filter(Boolean))].map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </label>
                    <label style={S.campo}>
                      <span style={S.label}>Caja destino *</span>
                      <select value={d.cajaId || ''} onChange={e => setDec(p.id, { cajaId: e.target.value })} style={{ ...S.select, borderColor: d.cajaId ? '#d1d5db' : '#f59e0b' }}>
                        <option value="">— elegir caja —</option>
                        {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                      </select>
                    </label>
                  </div>
                )}

                {esRechazar && (
                  <div style={S.cardCampos}>
                    <label style={{ ...S.campo, flex: 1 }}>
                      <span style={S.label}>Motivo (la orden pasa a CxC)</span>
                      <input value={d.motivo || ''} onChange={e => setDec(p.id, { motivo: e.target.value })} style={S.select} maxLength={140} />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {!cargando && pendientes.length > 0 && !resultado && (
          <div style={S.barra}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>
                {aAprobar.length > 0 && <span style={{ color: '#15803d' }}>{aAprobar.length} aprobar · {fmt(totalAprobar)}</span>}
                {aAprobar.length > 0 && aRechazar.length > 0 && ' · '}
                {aRechazar.length > 0 && <span style={{ color: '#b91c1c' }}>{aRechazar.length} rechazar</span>}
                {seleccionadas === 0 && <span style={{ color: '#6b7280', fontWeight: 600 }}>Nada marcado</span>}
              </div>
              {bloqueo && seleccionadas > 0 && <div style={{ fontSize: 11.5, color: '#b45309' }}>{bloqueo}</div>}
            </div>
            {!pedirPin ? (
              <button disabled={!!bloqueo} onClick={() => { setError(''); setPedirPin(true); }} style={{ ...S.btnPrimario, opacity: bloqueo ? 0.5 : 1 }}>
                Confirmar tanda
              </button>
            ) : (
              <div style={S.pinBox}>
                <input
                  type="password" inputMode="numeric" maxLength={4} placeholder="PIN"
                  value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && confirmar()}
                  style={S.pinInput} autoFocus
                />
                <button disabled={procesando} onClick={confirmar} style={S.btnPrimario}>{procesando ? 'Procesando…' : 'Aplicar'}</button>
                <button disabled={procesando} onClick={() => { setPedirPin(false); setPin(''); }} style={S.btnMini}>Cancelar</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 },
  panel: { background: '#f8fafc', borderRadius: 14, width: '100%', maxWidth: 860, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' },
  panelMovil: { maxHeight: '100dvh', height: '100dvh', borderRadius: 0 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: '#fff', borderBottom: '1px solid #e5e7eb' },
  titulo: { fontSize: 16, fontWeight: 800, color: '#111827' },
  sub: { fontSize: 12.5, color: '#6b7280', marginTop: 2 },
  btnCerrar: { border: 'none', background: '#f1f5f9', borderRadius: 8, width: 34, height: 34, cursor: 'pointer', fontSize: 15 },
  alertError: { background: '#fef2f2', color: '#991b1b', padding: '8px 16px', fontSize: 13 },
  acciones: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 16px', background: '#fff', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' },
  btnMini: { border: '1px solid #d1d5db', background: '#fff', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, cursor: 'pointer', color: '#374151' },
  lista: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
  vacio: { textAlign: 'center', color: '#6b7280', padding: 30, fontSize: 14 },
  card: { background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 12, padding: 12 },
  cardTop: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' },
  orden: { fontWeight: 800, fontSize: 14, color: '#111827', wordBreak: 'break-word' },
  cliente: { fontWeight: 600, color: '#374151' },
  meta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  tagAnny: { background: '#f1ebfe', color: '#5b21b6', borderRadius: 6, padding: '1px 6px', fontSize: 11, marginLeft: 4 },
  monto: { fontWeight: 800, fontSize: 16, color: '#16a34a', whiteSpace: 'nowrap' },
  cardMid: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
  linkFoto: { fontSize: 12.5, color: '#1d4ed8', fontWeight: 600, textDecoration: 'none' },
  sinFoto: { fontSize: 12, color: '#b45309' },
  toggle: { display: 'flex', gap: 6 },
  tBtn: { border: '1.5px solid #d1d5db', background: '#fff', borderRadius: 9, padding: '8px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', color: '#374151', minHeight: 40 },
  tBtnOk: { background: '#16a34a', borderColor: '#16a34a', color: '#fff' },
  tBtnNo: { background: '#dc2626', borderColor: '#dc2626', color: '#fff' },
  cardCampos: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  campo: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 160px', minWidth: 0 },
  label: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 },
  select: { border: '1px solid #d1d5db', borderRadius: 8, padding: '9px 10px', fontSize: 14, background: '#fff', width: '100%', minHeight: 40 },
  barra: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#fff', borderTop: '1px solid #e5e7eb', flexWrap: 'wrap', position: 'sticky', bottom: 0 },
  btnPrimario: { background: '#0f766e', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 18px', fontWeight: 800, fontSize: 14, cursor: 'pointer', minHeight: 44 },
  pinBox: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  pinInput: { width: 90, border: '1.5px solid #0f766e', borderRadius: 10, padding: '10px 12px', fontSize: 18, letterSpacing: 6, textAlign: 'center', minHeight: 44 },
  resultado: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14 },
  filaRes: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 10px', borderRadius: 8, flexWrap: 'wrap' }
};
// FIN ValidacionPagosLote.js
