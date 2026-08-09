// ═══════════════════════════════════════════════════════════════════════════════
// GestionVehiculos.js — Maestro de vehículos de la empresa
// ─────────────────────────────────────────────────────────────────────────────
// EGRESO-VEHICULO-001
//
// POR QUÉ ESTA PANTALLA
// ---------------------
// En julio 2026 la empresa gastó $1.206.682 en "Transporte / Combustible" y
// $733.900 en "fletes" — casi 2 millones — sin forma de saber a qué vehículo
// correspondía cada peso. La pregunta "¿cuál de mis vehículos se está comiendo
// la plata?" no tenía respuesta posible.
//
// POR QUÉ UN MAESTRO Y NO UN CAMPO LIBRE
// --------------------------------------
// El mismo error que produjo cuatro variantes de "Señalización" en el ERI se
// repetiría con las placas: "WGY123", "wgy-123" y "WGY 123" contarían como
// tres vehículos distintos. Aquí la placa se normaliza y se valida antes de
// guardarse, así que eso no puede pasar.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(n || 0);

const TIPOS = ['Automóvil', 'Camioneta', 'Camión', 'Motocicleta', 'Furgón', 'Remolque', 'Otro'];

const ICONO_TIPO = {
  'Automóvil': '🚗', 'Camioneta': '🛻', 'Camión': '🚚',
  'Motocicleta': '🏍️', 'Furgón': '🚐', 'Remolque': '🚛', 'Otro': '🚙'
};

// Mismo criterio que el backend — la placa se limpia mientras se escribe
const normalizarPlaca = (p) => String(p || '').toUpperCase().replace(/[\s\-._]/g, '').trim();
const PLACA_VALIDA = /^([A-Z]{3}\d{3}|[A-Z]{3}\d{2}[A-Z]|[A-Z]{3}\d{2}|R\d{5})$/;

// ═════════════════════════════════════════════════════════════════════════════
// Modal de alta / edición
// ═════════════════════════════════════════════════════════════════════════════
function ModalVehiculo({ vehiculo, conductores, onGuardar, onCerrar }) {
  const [form, setForm] = useState({
    placa: '', tipo: 'Camioneta', marca: '', modelo: '',
    conductorId: '', conductorNombre: '', notas: '',
    ...(vehiculo || {})
  });
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const placaNorm = normalizarPlaca(form.placa);
  const placaOk = PLACA_VALIDA.test(placaNorm);

  const guardar = async () => {
    if (!placaOk) { setError('La placa no tiene un formato válido'); return; }
    setGuardando(true); setError('');
    try {
      await onGuardar({ ...form, placa: placaNorm });
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'No se pudo guardar');
      setGuardando(false);
    }
  };

  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>{vehiculo ? '✏️ Editar vehículo' : '🚚 Nuevo vehículo'}</h3>
          <button onClick={onCerrar} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>

          <div style={S.field}>
            <label style={S.label}>Placa *</label>
            <input
              style={{
                ...S.input, fontSize: 20, fontWeight: 900, letterSpacing: 3,
                textAlign: 'center', fontFamily: 'monospace',
                borderColor: form.placa ? (placaOk ? '#16a34a' : '#dc2626') : '#e2e8f0'
              }}
              value={form.placa}
              onChange={e => { set('placa', e.target.value.toUpperCase()); setError(''); }}
              placeholder="WGY123" maxLength={8} />
            <div style={{ fontSize: 11, marginTop: 5, color: form.placa ? (placaOk ? '#16a34a' : '#dc2626') : '#94a3b8' }}>
              {!form.placa
                ? 'Vehículo: 3 letras + 3 números (WGY123) · Moto: ABC12D · Remolque: R12345'
                : placaOk
                  ? `✓ Se guardará como ${placaNorm}`
                  : `✗ "${placaNorm}" no corresponde a un formato de placa colombiana`}
            </div>
          </div>

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Tipo *</label>
              <select style={S.select} value={form.tipo} onChange={e => set('tipo', e.target.value)}>
                {TIPOS.map(t => <option key={t} value={t}>{ICONO_TIPO[t]} {t}</option>)}
              </select>
            </div>
            <div style={S.field}>
              <label style={S.label}>Conductor asignado</label>
              <select style={S.select} value={form.conductorId || ''}
                onChange={e => {
                  const c = conductores.find(x => x.id === e.target.value);
                  set('conductorId', e.target.value);
                  set('conductorNombre', c ? (c.nombre || c.email || '') : '');
                }}>
                <option value="">— Sin asignar —</option>
                {conductores.map(c => (
                  <option key={c.id} value={c.id}>{c.nombre || c.email}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Marca</label>
              <input style={S.input} value={form.marca || ''} onChange={e => set('marca', e.target.value)} placeholder="Chevrolet, Renault..." />
            </div>
            <div style={S.field}>
              <label style={S.label}>Modelo / año</label>
              <input style={S.input} value={form.modelo || ''} onChange={e => set('modelo', e.target.value)} placeholder="2019" />
            </div>
          </div>

          <div style={S.field}>
            <label style={S.label}>Notas</label>
            <textarea style={{ ...S.input, height: 56, resize: 'vertical' }} value={form.notas || ''}
              onChange={e => set('notas', e.target.value)} placeholder="Observaciones, vencimiento de SOAT..." />
          </div>

          {error && (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 13px', fontSize: 12.5, color: '#991b1b', marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={S.modalFooter}>
            <button onClick={onCerrar} style={S.btnSecondary}>Cancelar</button>
            <button onClick={guardar} disabled={guardando || !placaOk} style={{ ...S.btnPrimary, opacity: placaOk ? 1 : .5 }}>
              {guardando ? 'Guardando...' : vehiculo ? 'Guardar cambios' : 'Registrar vehículo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PANTALLA PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
export default function GestionVehiculos({ user }) {
  const [vehiculos, setVehiculos] = useState([]);
  const [conductores, setConductores] = useState([]);
  const [consumo, setConsumo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [verInactivos, setVerInactivos] = useState(false);
  const [rango, setRango] = useState(() => {
    const hoy = new Date();
    const ini = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    const iso = d => d.toLocaleDateString('en-CA');
    return { desde: iso(ini), hasta: iso(fin) };
  });

  const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

  const cargar = async () => {
    setLoading(true);
    try {
      const [vRes, uRes] = await Promise.all([
        axios.get(`${API}/vehiculos`, { headers: headers() }).catch(() => ({ data: [] })),
        axios.get(`${API}/users`, { headers: headers() }).catch(() => ({ data: [] })),
      ]);
      setVehiculos(Array.isArray(vRes.data) ? vRes.data : []);
      setConductores((Array.isArray(uRes.data) ? uRes.data : []).filter(u => u.activo !== false));
    } catch { }
    setLoading(false);
  };

  useEffect(() => { cargar(); }, []);

  useEffect(() => {
    (async () => {
      try {
        const p = new URLSearchParams();
        if (rango.desde) p.set('desde', rango.desde);
        if (rango.hasta) p.set('hasta', rango.hasta);
        const r = await axios.get(`${API}/vehiculos/consumo?${p}`, { headers: headers() });
        setConsumo(r.data);
      } catch { setConsumo(null); }
    })();
  }, [rango.desde, rango.hasta, vehiculos.length]);

  const crear = async (data) => {
    const r = await axios.post(`${API}/vehiculos`, data, { headers: headers() });
    setVehiculos(p => [...p, r.data]);
    setModal(null);
  };

  const editar = async (data) => {
    const r = await axios.put(`${API}/vehiculos/${modal.vehiculo.id}`, data, { headers: headers() });
    setVehiculos(p => p.map(v => v.id === modal.vehiculo.id ? { ...v, ...r.data } : v));
    setModal(null);
  };

  const desactivar = async (v) => {
    if (!window.confirm(
      `¿Dar de baja el vehículo ${v.placa}?\n\n` +
      `No se borra: los gastos históricos siguen asociados a esta placa. ` +
      `Solo deja de aparecer al registrar egresos nuevos.`
    )) return;
    await axios.delete(`${API}/vehiculos/${v.id}`, { headers: headers() });
    setVehiculos(p => p.map(x => x.id === v.id ? { ...x, activo: false } : x));
  };

  const visibles = useMemo(
    () => vehiculos.filter(v => verInactivos ? true : v.activo !== false),
    [vehiculos, verInactivos]
  );

  const consumoDe = (id) => (consumo?.vehiculos || []).find(x => x.vehiculoId === id);
  const maxConsumo = Math.max(...(consumo?.vehiculos || []).map(v => v.total), 1);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>⏳ Cargando vehículos...</div>;

  return (
    <div style={S.page}>
      <div style={S.pageHeader}>
        <div>
          <h2 style={S.pageTitle}>🚚 Vehículos</h2>
          <p style={S.pageSubtitle}>Maestro de placas · Control de gasto por vehículo</p>
        </div>
        <button onClick={() => setModal({ tipo: 'nuevo' })} style={S.btnPrimary}>+ Nuevo vehículo</button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          MENSAJE EXPLICATIVO — por qué esta pantalla importa
          ═══════════════════════════════════════════════════════════════════ */}
      {vehiculos.length === 0 ? (
        <div style={{
          background: 'linear-gradient(135deg,#eef2ff,#faf5ff)',
          border: '1px solid #c7d2fe', borderRadius: 16, padding: '28px 32px', marginBottom: 22
        }}>
          <div style={{ fontSize: 34, marginBottom: 12 }}>🚚</div>
          <h3 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 800, color: '#312e81' }}>
            Registrá acá los vehículos de la empresa
          </h3>
          <p style={{ margin: '0 0 14px', fontSize: 13.5, color: '#4338ca', lineHeight: 1.65, maxWidth: 720 }}>
            Cada placa que cargues acá aparecerá como opción al registrar un gasto de combustible,
            mantenimiento, peajes o fletes. Eso permite <strong>discriminar el gasto por vehículo</strong> y
            responder la pregunta que hoy no tiene respuesta: <em>¿cuál de mis vehículos se está comiendo la plata?</em>
          </p>
          <div style={{
            background: '#fff', borderRadius: 12, padding: '14px 18px', fontSize: 12.5,
            color: '#475569', lineHeight: 1.7, maxWidth: 720, border: '1px solid #e0e7ff'
          }}>
            <strong style={{ color: '#312e81' }}>Por qué importa para el ERI:</strong> mientras el gasto vehicular
            sea un solo bloque sin atribuir, el estado de resultados te dice <em>cuánto</em> gastaste pero no
            <em> en qué</em>. Con las placas cargadas podés detectar un consumo anormal, comparar costo por
            vehículo y decidir con datos si conviene reparar, vender o reemplazar una unidad.
            <br /><br />
            <strong style={{ color: '#312e81' }}>Y por qué un maestro y no escribir la placa a mano:</strong> si
            cada quien la digita libre, <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 }}>WGY123</code>,
            <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, marginLeft: 4 }}>wgy-123</code> y
            <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, marginLeft: 4 }}>WGY 123</code> quedan
            como tres vehículos distintos y el reporte no sirve. Acá la placa se valida y se normaliza una sola vez.
          </div>
          <button onClick={() => setModal({ tipo: 'nuevo' })}
            style={{ ...S.btnPrimary, marginTop: 18, padding: '11px 24px', fontSize: 14 }}>
            + Registrar el primer vehículo
          </button>
        </div>
      ) : (
        <div style={{
          background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12,
          padding: '12px 16px', marginBottom: 18, fontSize: 12.5, color: '#1e40af', lineHeight: 1.6
        }}>
          Al registrar un egreso de combustible, mantenimiento o fletes vas a poder elegir la placa.
          Así el gasto queda atribuido y el ERI muestra el costo real de cada vehículo.
        </div>
      )}

      {/* ── Indicador de trazabilidad ────────────────────────────────────── */}
      {consumo && (consumo.totalGeneral > 0) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
          background: '#fff', borderRadius: 14, padding: '16px 20px', marginBottom: 18,
          border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(15,23,42,0.06)'
        }}>
          <div style={{ textAlign: 'center', minWidth: 92 }}>
            <div style={{
              fontSize: 34, fontWeight: 900, lineHeight: 1,
              color: consumo.trazabilidad >= 80 ? '#16a34a' : consumo.trazabilidad >= 50 ? '#d97706' : '#dc2626'
            }}>{consumo.trazabilidad}%</div>
            <div style={{ fontSize: 9.5, color: '#94a3b8', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 3 }}>
              Trazabilidad
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 240, fontSize: 12.5, color: '#475569', lineHeight: 1.6 }}>
            De <strong>{fmt(consumo.totalGeneral)}</strong> en gastos de vehículo del período,{' '}
            <strong style={{ color: '#16a34a' }}>{fmt(consumo.totalAsignado)}</strong> tiene placa asignada.
            {consumo.sinAsignar?.total > 0 && (
              <> Quedan <strong style={{ color: '#dc2626' }}>{fmt(consumo.sinAsignar.total)}</strong> en{' '}
              {consumo.sinAsignar.cantidad} egreso(s) sin atribuir — se pueden asignar editando cada egreso.</>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="date" style={{ ...S.input, padding: '7px 10px' }} value={rango.desde}
              onChange={e => setRango(r => ({ ...r, desde: e.target.value }))} />
            <span style={{ color: '#cbd5e1' }}>→</span>
            <input type="date" style={{ ...S.input, padding: '7px 10px' }} value={rango.hasta}
              onChange={e => setRango(r => ({ ...r, hasta: e.target.value }))} />
          </div>
        </div>
      )}

      {/* ── Tarjetas de vehículos ────────────────────────────────────────── */}
      {visibles.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 12.5, color: '#64748b', fontWeight: 600 }}>
              {visibles.length} vehículo(s)
            </span>
            <button onClick={() => setVerInactivos(v => !v)} style={{ ...S.btnSecondary, padding: '6px 13px', fontSize: 11.5 }}>
              {verInactivos ? '👁 Ocultar dados de baja' : '👁 Ver dados de baja'}
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: 14 }}>
            {visibles.map(v => {
              const c = consumoDe(v.id);
              const inactivo = v.activo === false;
              return (
                <div key={v.id} style={{
                  background: '#fff', borderRadius: 14, padding: '16px 18px',
                  border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(15,23,42,0.06)',
                  opacity: inactivo ? .55 : 1
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div>
                      {/* Placa con estética de placa real */}
                      <span style={{
                        fontFamily: 'monospace', fontSize: 15, fontWeight: 900, letterSpacing: '.1em',
                        background: '#0f172a', color: '#fbbf24', padding: '5px 12px',
                        borderRadius: 6, border: '2px solid #334155', display: 'inline-block'
                      }}>{v.placa}</span>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 7 }}>
                        {ICONO_TIPO[v.tipo] || '🚙'} {v.tipo}
                        {v.marca ? ` · ${v.marca}` : ''}{v.modelo ? ` ${v.modelo}` : ''}
                      </div>
                      {v.conductorNombre && (
                        <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 3 }}>
                          👤 {v.conductorNombre}
                        </div>
                      )}
                    </div>
                    {inactivo && (
                      <span style={{ fontSize: 9.5, fontWeight: 800, background: '#f1f5f9', color: '#94a3b8', borderRadius: 20, padding: '3px 9px' }}>
                        DE BAJA
                      </span>
                    )}
                  </div>

                  {/* Consumo del período */}
                  <div style={{ background: '#f8fafc', borderRadius: 10, padding: '11px 13px', marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                      <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                        Gasto del período
                      </span>
                      <strong style={{ fontSize: 15, color: c?.total ? '#0f172a' : '#cbd5e1' }}>
                        {fmt(c?.total || 0)}
                      </strong>
                    </div>
                    <div style={{ height: 7, background: '#e2e8f0', borderRadius: 5, overflow: 'hidden' }}>
                      <div style={{
                        width: `${((c?.total || 0) / maxConsumo) * 100}%`, height: '100%',
                        background: 'linear-gradient(90deg,#6366f1,#4f46e5)', borderRadius: 5
                      }} />
                    </div>
                    {c?.egresos > 0 && (
                      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 6 }}>
                        {c.egresos} movimiento(s) · promedio {fmt(c.promedioPorEgreso)}
                      </div>
                    )}
                    {!c?.total && (
                      <div style={{ fontSize: 10.5, color: '#cbd5e1', marginTop: 6 }}>
                        Sin gastos registrados en este período
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 7 }}>
                    <button onClick={() => setModal({ tipo: 'editar', vehiculo: v })}
                      style={{ ...S.btnSecondary, flex: 1, padding: '7px 12px', fontSize: 12 }}>✏️ Editar</button>
                    {!inactivo && (
                      <button onClick={() => desactivar(v)}
                        style={{ ...S.btnSecondary, padding: '7px 12px', fontSize: 12, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                        Dar de baja
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Egresos sin placa asignada ───────────────────────────────────── */}
      {consumo?.sinAsignar?.cantidad > 0 && (
        <div style={{
          background: '#fff', borderRadius: 14, padding: '16px 20px', marginTop: 20,
          border: '1px solid #fee2e2', borderLeft: '4px solid #dc2626'
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>
            ⚠️ {consumo.sinAsignar.cantidad} gasto(s) de vehículo sin placa asignada
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 1.55 }}>
            Suman <strong style={{ color: '#dc2626' }}>{fmt(consumo.sinAsignar.total)}</strong>.
            Podés asignarles la placa desde Egresos → Editar, y el consumo se recalcula solo.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 220, overflowY: 'auto' }}>
            {consumo.sinAsignar.detalle.slice(0, 15).map(d => (
              <div key={d.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 12, padding: '6px 10px', background: '#f8fafc', borderRadius: 7
              }}>
                <span style={{ color: '#475569' }}>
                  <strong style={{ color: '#7c3aed' }}>{d.numero}</strong> · {d.fecha} · {d.concepto}
                  <span style={{ color: '#cbd5e1' }}> · {d.categoria}</span>
                </span>
                <strong style={{ color: '#0f172a' }}>{fmt(d.valor)}</strong>
              </div>
            ))}
            {consumo.sinAsignar.cantidad > 15 && (
              <div style={{ fontSize: 11, color: '#cbd5e1', padding: '4px 10px' }}>
                +{consumo.sinAsignar.cantidad - 15} más
              </div>
            )}
          </div>
        </div>
      )}

      {modal?.tipo === 'nuevo' && (
        <ModalVehiculo conductores={conductores} onGuardar={crear} onCerrar={() => setModal(null)} />
      )}
      {modal?.tipo === 'editar' && (
        <ModalVehiculo vehiculo={modal.vehiculo} conductores={conductores} onGuardar={editar} onCerrar={() => setModal(null)} />
      )}
    </div>
  );
}

const S = {
  page: { padding: '24px 32px', maxWidth: 1400, margin: '0 auto' },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 },
  pageTitle: { margin: 0, fontSize: 26, fontWeight: 800, color: '#1e293b' },
  pageSubtitle: { margin: '4px 0 0', fontSize: 13, color: '#64748b' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal: { background: '#fff', borderRadius: 16, maxWidth: 520, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxHeight: '92vh', overflowY: 'auto' },
  modalHeader: { padding: '20px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' },
  closeBtn: { background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8', padding: 4 },
  modalBody: { padding: '16px 24px' },
  modalFooter: { padding: '4px 0 8px', display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: 700, color: '#374151' },
  input: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  select: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  btnPrimary: { padding: '10px 20px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnSecondary: { padding: '10px 20px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
