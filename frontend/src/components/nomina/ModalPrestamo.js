// ═══════════════════════════════════════════════════════════════════════════════
// ModalPrestamo.js — Crear o corregir un préstamo de nómina
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PRESTAMO-001
//
// Quien atiende solo escribe lo que no puede saber el sistema: a quién, cuánto y
// de qué caja sale. Todo lo demás se calcula y se muestra ANTES de guardar:
//   · los datos del trabajador y su salario del contrato
//   · la fecha en que se descuenta (15 o 30 de la quincena que sigue)
//   · si sale en efectivo o por transferencia (según la caja elegida)
//   · el cupo de descuento de esa quincena y lo que ya tiene comprometido
//
// El tope ADVIERTE, no bloquea: si se pasa, hay que marcar la confirmación y
// escribir el motivo, que queda en el comprobante y en auditoría.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { S, Aviso, CampoPin, API, headers, api, fmt, hoyISO, errorDe } from './nominaUI';

const fechaCorta = (iso) => {
  const f = String(iso || '').slice(0, 10);
  if (f.length !== 10) return '—';
  return new Date(f + 'T12:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
};

const esEfectivo = (caja) => (caja?.tipo || 'Efectivo').toLowerCase().includes('efectivo');

const ModalPrestamo = ({ prestamo, empleados = [], cajas = [], empresas = [], onGuardado, onCerrar }) => {
  const editando = !!prestamo;
  const activos = useMemo(() => empleados.filter(e => e.activo !== false), [empleados]);

  const [form, setForm] = useState({
    empleadoId: prestamo?.empleadoId || '',
    valor: prestamo ? String(prestamo.valor) : '',
    cajaId: prestamo?.cajaId || '',
    empresaId: prestamo?.empresaId || (empresas.length === 1 ? empresas[0].id : ''),
    fechaSolicitud: prestamo?.fechaSolicitud || hoyISO(),
    notas: prestamo?.notas || ''
  });
  const [sim, setSim] = useState(null);
  const [simError, setSimError] = useState('');
  const [confirmo, setConfirmo] = useState(false);
  const [motivoExceso, setMotivoExceso] = useState('');
  const [motivo, setMotivo] = useState('');
  const [pin, setPin] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const caja = cajas.find(c => c.id === form.cajaId);
  const valorNum = Math.round(Number(form.valor) || 0);

  // Simulación en vivo: fecha de descuento + tope. No guarda nada.
  useEffect(() => {
    if (!form.empleadoId || !(valorNum > 0)) { setSim(null); setSimError(''); return; }
    let vivo = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.post('/prestamos-nomina/simular', {
          empleadoId: form.empleadoId, valor: valorNum,
          fechaSolicitud: form.fechaSolicitud, excluirId: prestamo?.id
        });
        if (vivo) { setSim(r.data); setSimError(''); }
      } catch (e) {
        if (vivo) { setSim(null); setSimError(errorDe(e, 'No se pudo calcular el descuento')); }
      }
    }, 350);
    return () => { vivo = false; clearTimeout(t); };
  }, [form.empleadoId, valorNum, form.fechaSolicitud, prestamo?.id]);

  const excedido = sim?.tope?.excedido === true;
  useEffect(() => { if (!excedido) { setConfirmo(false); setMotivoExceso(''); } }, [excedido]);

  const guardar = async () => {
    setError('');
    if (!form.empleadoId) return setError('Selecciona al trabajador');
    if (!(valorNum > 0)) return setError('Escribe el valor del préstamo');
    if (!form.cajaId) return setError('Selecciona la caja o el banco de donde sale el dinero');
    if (empresas.length > 0 && !form.empresaId) return setError('Selecciona la empresa que presta');
    if (excedido && !confirmo) return setError('Confirma que quieres prestar por encima del máximo de descuento');
    if (excedido && motivoExceso.trim().length < 10) return setError('Escribe el motivo del exceso (mínimo 10 caracteres)');
    if (editando && motivo.trim().length < 10) return setError('Explica por qué corriges el préstamo (mínimo 10 caracteres)');
    if (editando && pin.length !== 4) return setError('El PIN debe tener 4 dígitos');

    setGuardando(true);
    try {
      const exceso = excedido ? { confirmoExceso: true, motivoExceso: motivoExceso.trim() } : {};
      let r;
      if (editando) {
        r = await axios.put(`${API}/prestamos-nomina/${prestamo.id}`, {
          valor: valorNum, cajaId: form.cajaId, empresaId: form.empresaId, notas: form.notas,
          motivo: motivo.trim(), pin, ...exceso
        }, { headers: headers() });
      } else {
        r = await api.post('/prestamos-nomina', { ...form, valor: valorNum, ...exceso });
      }
      onGuardado(r.data, editando);
    } catch (e) {
      const d = e.response?.data;
      if (e.response?.status === 409 && d?.codigo === 'TOPE_EXCEDIDO') {
        // Alguien más prestó mientras tanto: se muestra la advertencia actualizada.
        setSim(s => ({ ...(s || {}), tope: d.tope, advertencia: d.advertencia, fechaDescuento: d.fechaDescuento || s?.fechaDescuento }));
        setError('El cupo cambió mientras llenabas el formulario. Revisa la advertencia y confirma de nuevo.');
      } else {
        setError(errorDe(e, 'No se pudo guardar el préstamo'));
      }
      setGuardando(false);
    }
  };

  const emp = sim?.empleado || activos.find(x => x.id === form.empleadoId);

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && !guardando && onCerrar()}>
      <div style={S.modal(640)}>
        <div style={S.modalHeader}>
          <div>
            <h3 style={S.modalTitle}>{editando ? `Corregir préstamo ${prestamo.numero}` : '💵 Nuevo préstamo de nómina'}</h3>
            <p style={S.cardSub}>
              {editando
                ? 'Conserva su número. Cada cambio queda en el historial con tu motivo.'
                : 'Se descuenta de la nómina en la quincena que sigue, sin intereses.'}
            </p>
          </div>
          <button onClick={onCerrar} style={S.closeBtn} disabled={guardando}>×</button>
        </div>

        <div style={S.modalBody}>
          <div style={S.field}>
            <label style={S.label}>Trabajador *</label>
            <select style={S.input} value={form.empleadoId} disabled={editando}
              onChange={e => set('empleadoId', e.target.value)}>
              <option value="">Selecciona…</option>
              {activos.map(e => <option key={e.id} value={e.id}>{e.nombre} · {e.documento}</option>)}
            </select>
          </div>

          {emp && (
            <div style={{ ...S.card, background: '#f8fafc', padding: '12px 15px', marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a' }}>{emp.nombre}</div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                {emp.tipoDocumento || 'CC'} {emp.documento}{emp.cargo ? ` · ${emp.cargo}` : ''} · Salario del contrato <b>{fmt(emp.salario)}</b>
              </div>
            </div>
          )}

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Valor del préstamo *</label>
              <input style={S.input} type="number" min="0" inputMode="numeric" value={form.valor}
                placeholder="50000" onChange={e => set('valor', e.target.value)} />
              {sim?.valorEnLetras && valorNum > 0 && (
                <span style={{ fontSize: 11, color: '#64748b', textTransform: 'capitalize' }}>{sim.valorEnLetras}</span>
              )}
            </div>
            <div style={S.field}>
              <label style={S.label}>Fecha de solicitud</label>
              <input style={S.input} type="date" value={form.fechaSolicitud} disabled={editando}
                onChange={e => set('fechaSolicitud', e.target.value)} />
            </div>
          </div>

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>¿De dónde sale el dinero? *</label>
              <select style={S.input} value={form.cajaId} onChange={e => set('cajaId', e.target.value)}>
                <option value="">Selecciona…</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.tipo || 'Efectivo'})</option>)}
              </select>
              {caja && (
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  Se entrega en <b>{esEfectivo(caja) ? 'efectivo' : 'transferencia'}</b>
                </span>
              )}
            </div>
            <div style={S.field}>
              <label style={S.label}>Empresa que presta {empresas.length > 0 ? '*' : ''}</label>
              <select style={S.input} value={form.empresaId} onChange={e => set('empresaId', e.target.value)}>
                <option value="">{empresas.length > 0 ? 'Selecciona…' : 'Sin empresas registradas'}</option>
                {empresas.map(c => <option key={c.id} value={c.id}>{c.name || c.nombre}{c.nit ? ` · NIT ${c.nit}` : ''}</option>)}
              </select>
            </div>
          </div>

          {sim?.fechaDescuento && (
            <div style={{ ...S.card, background: '#eff6ff', border: '1px solid #bfdbfe', padding: '12px 15px', marginBottom: 14 }}>
              <div style={{ fontSize: 12.5, color: '#1e40af' }}>
                📅 Se descuenta en el pago del <b>{fechaCorta(sim.fechaDescuento)}</b>
              </div>
              {sim.tope && (
                <div style={{ fontSize: 11.5, color: '#475569', marginTop: 4 }}>
                  Máximo de descuento en esa quincena: <b>{fmt(sim.tope.cupoQuincena)}</b>
                  {' · '}Ya comprometido: <b>{fmt(sim.tope.comprometidoPrevio)}</b>
                  {' · '}Con este: <b>{fmt(sim.tope.totalConEste)}</b>
                </div>
              )}
            </div>
          )}
          {simError && <Aviso nivel="grave" style={{ marginBottom: 14 }}>{simError}</Aviso>}

          {excedido && (
            <div style={{ marginBottom: 14 }}>
              <Aviso nivel="media" titulo="Supera el máximo de descuento de la quincena">
                {sim.advertencia}
              </Aviso>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: '#92400e', margin: '10px 2px 8px', cursor: 'pointer' }}>
                <input type="checkbox" checked={confirmo} onChange={e => setConfirmo(e.target.checked)} style={{ marginTop: 3 }} />
                <span>Entiendo la advertencia y quiero prestar de todas formas.</span>
              </label>
              {confirmo && (
                <div style={S.field}>
                  <label style={S.label}>Motivo del exceso *</label>
                  <textarea style={{ ...S.input, height: 60, resize: 'vertical', fontFamily: 'inherit' }}
                    value={motivoExceso} onChange={e => setMotivoExceso(e.target.value)}
                    placeholder="Ej: calamidad doméstica, autorizado por gerencia" />
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>Queda en el préstamo y en auditoría.</span>
                </div>
              )}
            </div>
          )}

          <div style={S.field}>
            <label style={S.label}>Notas (opcional)</label>
            <input style={S.input} value={form.notas} onChange={e => set('notas', e.target.value)} />
          </div>

          {editando && (
            <>
              <div style={S.field}>
                <label style={S.label}>¿Por qué se corrige? *</label>
                <textarea style={{ ...S.input, height: 60, resize: 'vertical', fontFamily: 'inherit' }}
                  value={motivo} onChange={e => setMotivo(e.target.value)}
                  placeholder="Ej: se digitó 80.000 y el trabajador recibió 50.000" />
              </div>
              <CampoPin value={pin} onChange={setPin} accion="La corrección" />
            </>
          )}

          {error && <Aviso nivel="grave" style={{ marginTop: 4 }}>{error}</Aviso>}

          <div style={S.modalFooter}>
            <button onClick={onCerrar} style={S.btnSecondary} disabled={guardando}>Cancelar</button>
            <button onClick={guardar} style={{ ...S.btnPrimary, opacity: guardando ? 0.6 : 1 }} disabled={guardando}>
              {guardando ? 'Guardando…' : editando ? 'Guardar corrección' : 'Generar comprobante'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModalPrestamo;
