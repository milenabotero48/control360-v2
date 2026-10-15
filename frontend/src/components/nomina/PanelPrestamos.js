// ═══════════════════════════════════════════════════════════════════════════════
// PanelPrestamos.js — Pestaña "Préstamos" del módulo de Empleados
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PRESTAMO-001
//
// Aquí vive el control de los préstamos de quincena: cuáles están pendientes de
// descuento, cuáles ya se descontaron en nómina y cuáles se anularon. El dinero
// se mueve por debajo con el egreso-anticipo que la nómina ya cruza sola, así
// que en Egresos y en Caja solo se ve el movimiento: nadie lo registra dos veces.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { S, Aviso, CampoPin, API, headers, api, fmt, errorDe } from './nominaUI';
import ModalPrestamo from './ModalPrestamo';
import { imprimirComprobantePrestamo } from './comprobantePrestamo';

const fechaCorta = (iso) => {
  const f = String(iso || '').slice(0, 10);
  if (f.length !== 10) return '—';
  const [a, m, d] = f.split('-');
  return `${d}/${m}/${a}`;
};

const ESTADOS = {
  ACTIVO:     { etiqueta: 'Pendiente de descuento', bg: '#fef3c7', color: '#92400e' },
  DESCONTADO: { etiqueta: 'Descontado en nómina',   bg: '#dcfce7', color: '#166534' },
  ANULADO:    { etiqueta: 'Anulado',                bg: '#fee2e2', color: '#991b1b' },
};

const Chip = ({ estado }) => {
  const e = ESTADOS[estado] || ESTADOS.ACTIVO;
  return (
    <span style={{ background: e.bg, color: e.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {e.etiqueta}
    </span>
  );
};

// ─── Anular ────────────────────────────────────────────────────────────────
const ModalAnularPrestamo = ({ prestamo, onListo, onCerrar }) => {
  const [motivo, setMotivo] = useState('');
  const [pin, setPin] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const anular = async () => {
    setError('');
    if (motivo.trim().length < 10) return setError('Explica el motivo con un poco más de detalle (mínimo 10 caracteres)');
    if (pin.length !== 4) return setError('El PIN debe tener 4 dígitos');
    setGuardando(true);
    try {
      const r = await api.post(`/prestamos-nomina/${prestamo.id}/anular`, { motivo: motivo.trim(), pin });
      onListo(r.data);
    } catch (e) { setError(errorDe(e, 'No se pudo anular el préstamo')); setGuardando(false); }
  };

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && !guardando && onCerrar()}>
      <div style={S.modal(520)}>
        <div style={S.modalHeader}>
          <div>
            <h3 style={S.modalTitle}>Anular {prestamo.numero}</h3>
            <p style={S.cardSub}>{prestamo.empleadoNombre} · {fmt(prestamo.valor)} · se descontaba el {fechaCorta(prestamo.fechaDescuento)}</p>
          </div>
          <button onClick={onCerrar} style={S.closeBtn} disabled={guardando}>×</button>
        </div>
        <div style={S.modalBody}>
          <Aviso nivel="media" titulo="No se borra: se anula">
            El dinero vuelve a la caja, el comprobante queda visible como ANULADO con tu motivo y tu usuario,
            y su número no se reutiliza. Un préstamo anulado ya no se descuenta en la nómina.
          </Aviso>
          <div style={{ ...S.field, marginTop: 14 }}>
            <label style={S.label}>¿Por qué se anula? *</label>
            <textarea style={{ ...S.input, height: 70, resize: 'vertical', fontFamily: 'inherit' }}
              value={motivo} onChange={e => setMotivo(e.target.value)}
              placeholder="Ej: se digitó al trabajador equivocado" />
          </div>
          <CampoPin value={pin} onChange={setPin} accion="La anulación" />
          {error && <Aviso nivel="grave">{error}</Aviso>}
          <div style={S.modalFooter}>
            <button onClick={onCerrar} style={S.btnSecondary} disabled={guardando}>Cancelar</button>
            <button onClick={anular} style={{ ...S.btnPeligro, opacity: guardando ? 0.6 : 1 }} disabled={guardando}>
              {guardando ? 'Anulando…' : 'Anular préstamo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Tope de descuento ─────────────────────────────────────────────────────
const ConfigTope = ({ esAdmin }) => {
  const [abierto, setAbierto] = useState(false);
  const [cfg, setCfg] = useState({ modoTope: 'legal', porcentaje: 20 });
  const [msg, setMsg] = useState('');
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    api.get('/prestamos-nomina/config').then(r => setCfg(r.data)).catch(() => { });
  }, []);

  const guardar = async () => {
    setGuardando(true); setMsg('');
    try {
      await axios.put(`${API}/prestamos-nomina/config`, cfg, { headers: headers() });
      setMsg('✓ Guardado');
    } catch (e) { setMsg(errorDe(e, 'No se pudo guardar')); }
    setGuardando(false);
  };

  return (
    <div style={{ ...S.card, padding: '14px 18px' }}>
      <button onClick={() => setAbierto(a => !a)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13.5, fontWeight: 800, color: '#0f172a' }}>
        ⚙️ Tope de descuento por quincena {abierto ? '▾' : '▸'}
      </button>
      {abierto && (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: '#334155', marginBottom: 10, cursor: esAdmin ? 'pointer' : 'default' }}>
            <input type="radio" disabled={!esAdmin} checked={cfg.modoTope === 'legal'} onChange={() => setCfg(c => ({ ...c, modoTope: 'legal' }))} style={{ marginTop: 3 }} />
            <span>
              <b>Legal</b> — la quinta parte de lo que el salario del contrato excede el mínimo, repartida por quincena.
              A quien gana el mínimo no le queda cupo, y el sistema siempre advertirá.
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: '#334155', marginBottom: 10, cursor: esAdmin ? 'pointer' : 'default', flexWrap: 'wrap' }}>
            <input type="radio" disabled={!esAdmin} checked={cfg.modoTope === 'porcentaje'} onChange={() => setCfg(c => ({ ...c, modoTope: 'porcentaje' }))} />
            <span><b>Porcentaje fijo</b> del salario del contrato:</span>
            <input type="number" min="1" max="100" disabled={!esAdmin || cfg.modoTope !== 'porcentaje'}
              value={cfg.porcentaje} onChange={e => setCfg(c => ({ ...c, porcentaje: e.target.value }))}
              style={{ ...S.input, width: 80, padding: '6px 9px' }} /> %
          </label>
          <Aviso nivel="info">
            El tope solo <b>advierte</b>: si un préstamo lo supera, se puede prestar de todas formas con una
            confirmación y un motivo. Valida con tu abogado laboral qué modo te conviene.
          </Aviso>
          {esAdmin ? (
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
              <button onClick={guardar} disabled={guardando} style={{ ...S.btnPrimary, opacity: guardando ? 0.6 : 1 }}>Guardar</button>
              {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') ? '#16a34a' : '#dc2626' }}>{msg}</span>}
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 11.5, color: '#94a3b8' }}>Solo el administrador puede cambiar el tope.</div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Panel ─────────────────────────────────────────────────────────────────
const PanelPrestamos = ({ user, empleados = [], cajas = [], empresas = [] }) => {
  const esAdmin = user?.role === 'admin';
  const [lista, setLista] = useState([]);
  const [resumen, setResumen] = useState({ total: 0, activos: 0, valorPendiente: 0 });
  const [filtroEstado, setFiltroEstado] = useState('');
  const [filtroEmpleado, setFiltroEmpleado] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);       // { tipo: 'nuevo' | 'editar' | 'anular', prestamo? }
  const [ultimo, setUltimo] = useState(null);     // recién creado: ofrece imprimir

  const cargar = useCallback(async () => {
    setCargando(true); setError('');
    try {
      const q = new URLSearchParams();
      if (filtroEstado) q.set('estado', filtroEstado);
      if (filtroEmpleado) q.set('empleadoId', filtroEmpleado);
      const r = await api.get(`/prestamos-nomina${q.toString() ? `?${q}` : ''}`);
      setLista(r.data.prestamos || []);
      setResumen(r.data.resumen || { total: 0, activos: 0, valorPendiente: 0 });
    } catch (e) { setError(errorDe(e, 'No se pudieron cargar los préstamos')); }
    setCargando(false);
  }, [filtroEstado, filtroEmpleado]);

  useEffect(() => { cargar(); }, [cargar]);

  const alGuardar = (p, editado) => {
    setModal(null);
    setUltimo(editado ? null : p);
    cargar();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h3 style={{ ...S.cardTitle, fontSize: 17 }}>💵 Préstamos de nómina</h3>
          <p style={S.cardSub}>Lo que se presta en la quincena y se descuenta en la siguiente. Cada uno genera su comprobante para firmar.</p>
        </div>
        <button style={S.btnPrimary} onClick={() => setModal({ tipo: 'nuevo' })} disabled={empleados.length === 0}>
          + Nuevo préstamo
        </button>
      </div>

      {ultimo && (
        <Aviso nivel="info" titulo={`✅ ${ultimo.numero} generado`} style={{ marginBottom: 14 }}>
          Imprime el comprobante y pide la firma del trabajador antes de entregar el dinero.{' '}
          <button onClick={() => imprimirComprobantePrestamo({ prestamo: ultimo })}
            style={{ ...S.btnMini, marginLeft: 6, background: '#4f46e5', color: '#fff', border: 'none' }}>🖨️ Imprimir ahora</button>
          <button onClick={() => setUltimo(null)} style={{ ...S.btnMini, marginLeft: 6 }}>Cerrar</button>
        </Aviso>
      )}

      <div style={{ ...S.grid(200), marginBottom: 14 }}>
        <div style={S.kpi('#d97706')}>
          <div style={S.kpiLabel}>Pendientes de descuento</div>
          <div style={S.kpiValue('#d97706')}>{resumen.activos}</div>
        </div>
        <div style={S.kpi('#4f46e5')}>
          <div style={S.kpiLabel}>Valor por descontar</div>
          <div style={S.kpiValue('#4f46e5')}>{fmt(resumen.valorPendiente)}</div>
          <div style={S.kpiHint}>Se cruza solo en la nómina de cada trabajador</div>
        </div>
      </div>

      <ConfigTope esAdmin={esAdmin} />

      <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 10, padding: '14px 16px', flexWrap: 'wrap', borderBottom: '1px solid #f1f5f9' }}>
          <select style={{ ...S.input, width: 'auto', minWidth: 170 }} value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
            <option value="">Todos los estados</option>
            {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v.etiqueta}</option>)}
          </select>
          <select style={{ ...S.input, width: 'auto', minWidth: 200 }} value={filtroEmpleado} onChange={e => setFiltroEmpleado(e.target.value)}>
            <option value="">Todos los trabajadores</option>
            {empleados.map(e => <option key={e.id} value={e.id}>{e.nombre}</option>)}
          </select>
        </div>

        {error && <div style={{ padding: 14 }}><Aviso nivel="grave">{error}</Aviso></div>}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>
                <th style={S.th}>N°</th>
                <th style={S.th}>Solicitud</th>
                <th style={S.th}>Trabajador</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Valor</th>
                <th style={S.th}>Se descuenta</th>
                <th style={S.th}>Entrega</th>
                <th style={S.th}>Estado</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {cargando && <tr><td style={S.td} colSpan={8}>Cargando…</td></tr>}
              {!cargando && lista.length === 0 && (
                <tr><td style={{ ...S.td, textAlign: 'center', padding: 28, color: '#94a3b8' }} colSpan={8}>
                  Todavía no hay préstamos registrados.
                </td></tr>
              )}
              {!cargando && lista.map(p => (
                <tr key={p.id} style={{ opacity: p.estado === 'ANULADO' ? 0.55 : 1 }}>
                  <td style={{ ...S.td, fontWeight: 800, color: '#b45309', whiteSpace: 'nowrap' }}>{p.numero}</td>
                  <td style={S.td}>{fechaCorta(p.fechaSolicitud)}</td>
                  <td style={S.td}>
                    <div style={{ fontWeight: 700, color: '#0f172a' }}>{p.empleadoNombre}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{p.empleadoDocumento}</div>
                  </td>
                  <td style={S.tdNum}>{fmt(p.valor)}</td>
                  <td style={S.td}>
                    {fechaCorta(p.fechaDescuento)}
                    {p.descontadoEnNomina && <div style={{ fontSize: 10.5, color: '#16a34a' }}>en {p.descontadoEnNomina}</div>}
                    {p.excesoConfirmado && <div style={{ fontSize: 10.5, color: '#b45309' }} title={p.excesoConfirmado.motivo}>⚠️ superó el tope</div>}
                  </td>
                  <td style={S.td}>{p.formaEntrega}</td>
                  <td style={S.td}><Chip estado={p.estado} /></td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    <button style={S.btnMini} onClick={() => imprimirComprobantePrestamo({ prestamo: p })}>🖨️ Imprimir</button>
                    {esAdmin && p.estado === 'ACTIVO' && (
                      <>
                        <button style={{ ...S.btnMini, marginLeft: 5 }} onClick={() => setModal({ tipo: 'editar', prestamo: p })}>✏️ Editar</button>
                        <button style={{ ...S.btnMini, marginLeft: 5, color: '#b91c1c' }} onClick={() => setModal({ tipo: 'anular', prestamo: p })}>🚫 Anular</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (modal.tipo === 'nuevo' || modal.tipo === 'editar') && (
        <ModalPrestamo prestamo={modal.prestamo || null} empleados={empleados} cajas={cajas} empresas={empresas}
          onGuardado={alGuardar} onCerrar={() => setModal(null)} />
      )}
      {modal?.tipo === 'anular' && (
        <ModalAnularPrestamo prestamo={modal.prestamo}
          onListo={() => { setModal(null); cargar(); }} onCerrar={() => setModal(null)} />
      )}
    </div>
  );
};

export default PanelPrestamos;
