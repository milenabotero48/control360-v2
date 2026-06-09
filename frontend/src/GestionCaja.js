import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { exportarExcel } from './exportExcel';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const fmt = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const fmtDate = (ts) => {
  if (!ts) return '—';
  let d;
  if (ts?.toDate) d = ts.toDate();
  else if (ts?._seconds) d = new Date(ts._seconds * 1000);
  else d = new Date(ts);
  return isNaN(d) ? '—' : d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const TIPOS_CAJA = ['Efectivo', 'Banco', 'Nequi/Daviplata', 'Datafono', 'Mensajero', 'Otro'];

// ─── Modal Crear/Editar Caja ─────────────────────────────────────────────────
function ModalCaja({ caja, empresas, onSave, onClose }) {
  const [form, setForm] = useState({
    nombre: '', tipo: 'Efectivo', saldo: 0, empresaId: empresas[0]?.id || '',
    responsable: '', numeroCuenta: '', banco: '', notas: '', activa: true,
    ...(caja || {})
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.nombre.trim()) return alert('El nombre de la caja es requerido');
    if (!form.empresaId) return alert('Selecciona la empresa');
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 520 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>{caja ? '✏️ Editar Caja' : '➕ Nueva Caja'}</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>
          <div style={S.field}>
            <label style={S.label}>Nombre de la caja *</label>
            <input style={S.input} value={form.nombre} onChange={e => set('nombre', e.target.value)} placeholder="Ej: Efectivo Oficina, Banco Bancolombia Corriente..." />
          </div>
          <div style={S.field}>
              <label style={S.label}>Tipo *</label>
              <select style={S.select} value={form.tipo} onChange={e => set('tipo', e.target.value)}>
                {TIPOS_CAJA.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

          {form.tipo === 'Banco' && (
            <div style={S.row2}>
              <div style={S.field}>
                <label style={S.label}>Banco</label>
                <input style={S.input} value={form.banco || ''} onChange={e => set('banco', e.target.value)} placeholder="Bancolombia, Davivienda..." />
              </div>
              <div style={S.field}>
                <label style={S.label}>N° Cuenta</label>
                <input style={S.input} value={form.numeroCuenta || ''} onChange={e => set('numeroCuenta', e.target.value)} placeholder="000-000000-00" />
              </div>
            </div>
          )}

          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Responsable</label>
              <input style={S.input} value={form.responsable || ''} onChange={e => set('responsable', e.target.value)} placeholder="Nombre del responsable" />
            </div>
            <div style={S.field}>
              <label style={S.label}>Saldo inicial {caja ? '(⚠️ edita con cuidado)' : ''}</label>
              <input type="number" style={S.input} value={form.saldo} onChange={e => set('saldo', e.target.value)} min="0" />
            </div>
          </div>

          <div style={S.field}>
            <label style={S.label}>Notas internas</label>
            <textarea style={{ ...S.input, height: 56, resize: 'vertical' }} value={form.notas || ''} onChange={e => set('notas', e.target.value)} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="checkbox" id="activa" checked={form.activa} onChange={e => set('activa', e.target.checked)} style={{ width: 16, height: 16 }} />
            <label htmlFor="activa" style={{ fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>Caja activa</label>
          </div>
        </div>
        <div style={S.modalFooter}>
          <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} style={S.btnPrimary}>
            {saving ? 'Guardando...' : caja ? 'Guardar cambios' : 'Crear caja'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal Traslado entre Cajas ──────────────────────────────────────────────
function ModalTraslado({ cajas, onTraslado, onClose }) {
  const [cajaOrigenId, setCajaOrigenId] = useState('');
  const [cajaDestinoId, setCajaDestinoId] = useState('');
  const [monto, setMonto] = useState('');
  const [concepto, setConcepto] = useState('');
  const [saving, setSaving] = useState(false);

  const cajaOrigen = cajas.find(c => c.id === cajaOrigenId);
  const cajaDestino = cajas.find(c => c.id === cajaDestinoId);

  const handleTraslado = async () => {
    if (!cajaOrigenId || !cajaDestinoId) return alert('Selecciona origen y destino');
    if (cajaOrigenId === cajaDestinoId) return alert('Origen y destino no pueden ser iguales');
    if (!monto || Number(monto) <= 0) return alert('Ingresa un monto válido');
    if (cajaOrigen && Number(monto) > cajaOrigen.saldo) return alert(`Saldo insuficiente. Disponible: ${fmt(cajaOrigen.saldo)}`);
    setSaving(true);
    await onTraslado({ cajaOrigenId, cajaDestinoId, monto: Number(monto), concepto: concepto || `Traslado de ${cajaOrigen?.nombre} a ${cajaDestino?.nombre}` });
    setSaving(false);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 480 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>🔄 Traslado entre Cajas</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12, color: '#0369a1' }}>
            💡 Un traslado mueve dinero entre tus cajas. <strong>No es un ingreso ni un egreso</strong> — no afecta el resultado de la empresa.
          </div>
          <div style={S.field}>
            <label style={S.label}>Sale de (caja origen) *</label>
            <select style={S.select} value={cajaOrigenId} onChange={e => setCajaOrigenId(e.target.value)}>
              <option value="">— Seleccionar —</option>
              {cajas.filter(c => c.activa).map(c => <option key={c.id} value={c.id}>{c.nombre} ({fmt(c.saldo)})</option>)}
            </select>
            {cajaOrigen && <div style={{ fontSize: 11, color: '#16a34a', marginTop: 4 }}>Disponible: {fmt(cajaOrigen.saldo)}</div>}
          </div>
          <div style={{ textAlign: 'center', fontSize: 22, color: '#94a3b8', margin: '2px 0' }}>⬇️</div>
          <div style={S.field}>
            <label style={S.label}>Entra a (caja destino) *</label>
            <select style={S.select} value={cajaDestinoId} onChange={e => setCajaDestinoId(e.target.value)}>
              <option value="">— Seleccionar —</option>
              {cajas.filter(c => c.activa && c.id !== cajaOrigenId).map(c => <option key={c.id} value={c.id}>{c.nombre} ({fmt(c.saldo)})</option>)}
            </select>
          </div>
          <div style={S.field}>
            <label style={S.label}>Monto *</label>
            <input type="number" style={S.input} value={monto} onChange={e => setMonto(e.target.value)} placeholder="0" min="0" />
          </div>
          <div style={S.field}>
            <label style={S.label}>Concepto (opcional)</label>
            <input style={S.input} value={concepto} onChange={e => setConcepto(e.target.value)} placeholder="Ej: Depósito a banco, Fondo para mensajero..." />
          </div>
          {cajaOrigen && cajaDestino && monto && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 14, fontSize: 13 }}>
              <div style={{ fontWeight: 700, color: '#166534', marginBottom: 6 }}>Resumen del traslado:</div>
              <div style={{ color: '#dc2626' }}>📤 Sale de: <strong>{cajaOrigen.nombre}</strong></div>
              <div style={{ color: '#16a34a', marginTop: 4 }}>📥 Entra a: <strong>{cajaDestino.nombre}</strong></div>
              <div style={{ fontWeight: 800, fontSize: 18, color: '#1e293b', marginTop: 8 }}>{fmt(monto)}</div>
            </div>
          )}
        </div>
        <div style={S.modalFooter}>
          <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
          <button onClick={handleTraslado} disabled={saving} style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#0284c7,#0369a1)' }}>
            {saving ? 'Procesando...' : '🔄 Confirmar traslado'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal Movimiento Manual — CTRL-005 ──────────────────────────────────────
function ModalMovimiento({ cajas, onSave, onClose, ordenesPendientes = [] }) {
  const [form, setForm] = useState({ 
    cajaId: '', 
    tipo: 'ingreso', 
    monto: '', 
    concepto: '', 
    notas: '',
    metodoPago: 'EFECTIVO',
    ordenIds: [],
    comprobante: null,
    mensajeroId: ''
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleOrdenesChange = (selectedIds) => {
    set('ordenIds', selectedIds);
    if (selectedIds.length > 0) {
      const total = ordenesPendientes
        .filter(o => selectedIds.includes(o.id))
        .reduce((sum, o) => sum + (Number(o.cxcSaldo) || 0), 0);
      set('monto', total.toString());
    }
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 500 }}>
        <div style={S.modalHeader}>
          <h3 style={S.modalTitle}>💰 Movimiento de Caja</h3>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>
        <div style={S.modalBody}>
          
          {/* TIPO: Ingreso/Egreso */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            {[{ v: 'ingreso', label: '📥 Ingreso', color: '#16a34a', bg: '#dcfce7' }, { v: 'egreso', label: '📤 Egreso', color: '#dc2626', bg: '#fee2e2' }].map(op => (
              <button key={op.v} onClick={() => set('tipo', op.v)} style={{
                padding: 14, borderRadius: 10, border: `2px solid ${form.tipo === op.v ? op.color : '#e2e8f0'}`,
                background: form.tipo === op.v ? op.bg : '#f8fafc', color: form.tipo === op.v ? op.color : '#64748b',
                fontWeight: 700, fontSize: 14, cursor: 'pointer'
              }}>{op.label}</button>
            ))}
          </div>

          {/* CAJA */}
          <div style={S.field}>
            <label style={S.label}>Caja *</label>
            <select style={S.select} value={form.cajaId} onChange={e => set('cajaId', e.target.value)}>
              <option value="">— Seleccionar —</option>
              {cajas.filter(c => c.activa).map(c => <option key={c.id} value={c.id}>{c.nombre} ({fmt(c.saldo)})</option>)}
            </select>
          </div>

          {/* MONTO */}
          <div style={S.row2}>
            <div style={S.field}>
              <label style={S.label}>Monto *</label>
              <input type="number" style={S.input} value={form.monto} onChange={e => set('monto', e.target.value)} placeholder="0" min="0" />
            </div>
            
            {/* MÉTODO PAGO (solo si es ingreso) */}
            {form.tipo === 'ingreso' && (
              <div style={S.field}>
                <label style={S.label}>Método de pago *</label>
                <select style={S.select} value={form.metodoPago} onChange={e => set('metodoPago', e.target.value)}>
                  <option value="EFECTIVO">💵 Efectivo</option>
                  <option value="TRANSFERENCIA">🏦 Transferencia</option>
                  <option value="CHEQUE">📄 Cheque</option>
                  <option value="DATAFONO">💳 Datáfono</option>
                </select>
              </div>
            )}
          </div>

          {/* CONCEPTO */}
          <div style={S.field}>
            <label style={S.label}>Concepto *</label>
            <input style={S.input} value={form.concepto} onChange={e => set('concepto', e.target.value)} placeholder="Descripción del movimiento" />
          </div>

          {/* ÓRDENES PENDIENTES (si es ingreso) */}
          {form.tipo === 'ingreso' && ordenesPendientes.length > 0 && (
            <div style={S.field}>
              <label style={S.label}>Órdenes a pagar (opcional)</label>
              <div style={{ 
                maxHeight: 120, 
                overflowY: 'auto', 
                border: '1px solid #e2e8f0', 
                borderRadius: 8, 
                padding: 8,
                backgroundColor: '#f8fafc'
              }}>
                {ordenesPendientes.map(o => (
                  <label key={o.id} style={{ display: 'flex', alignItems: 'center', padding: 8, cursor: 'pointer' }}>
                    <input 
                      type="checkbox" 
                      checked={form.ordenIds.includes(o.id)}
                      onChange={e => {
                        const newIds = e.target.checked 
                          ? [...form.ordenIds, o.id]
                          : form.ordenIds.filter(id => id !== o.id);
                        handleOrdenesChange(newIds);
                      }}
                      style={{ marginRight: 8, width: 18, height: 18, cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: 13, color: '#475569' }}>
                      Orden #{o.numero} - {o.cliente} - {fmt(o.cxcSaldo)}
                    </span>
                  </label>
                ))}
              </div>
              {form.ordenIds.length > 0 && (
                <span style={{ fontSize: 12, color: '#16a34a', marginTop: 6, display: 'block' }}>
                  ✅ {form.ordenIds.length} orden(es) se marcarán como PAGADA
                </span>
              )}
            </div>
          )}

          {/* COMPROBANTE (si es TRANSFERENCIA) */}
          {form.tipo === 'ingreso' && form.metodoPago === 'TRANSFERENCIA' && (
            <div style={S.field}>
              <label style={S.label}>Comprobante de transferencia (foto)</label>
              <input 
                type="file" 
                accept="image/*" 
                style={S.input}
                onChange={e => set('comprobante', e.target.files?.[0] || null)}
              />
              {form.comprobante && <span style={{ fontSize: 12, color: '#16a34a' }}>✅ Archivo seleccionado</span>}
            </div>
          )}

          {/* MENSAJERO (si hay ordenIds) */}
          {form.ordenIds.length > 0 && (
            <div style={S.field}>
              <label style={S.label}>Mensajero que entrega dinero (opcional)</label>
              <input 
                style={S.input} 
                value={form.mensajeroId} 
                onChange={e => set('mensajeroId', e.target.value)} 
                placeholder="Nombre del mensajero (ej: Maykol)"
              />
            </div>
          )}

          {/* NOTAS */}
          <div style={S.field}>
            <label style={S.label}>Notas</label>
            <textarea style={{ ...S.input, height: 56, resize: 'vertical' }} value={form.notas} onChange={e => set('notas', e.target.value)} />
          </div>

        </div>

        <div style={S.modalFooter}>
          <button onClick={onClose} style={S.btnSecondary}>Cancelar</button>
          <button onClick={async () => {
            if (!form.cajaId || !form.monto || !form.concepto.trim()) {
              return alert('Caja, monto y concepto son requeridos');
            }
            if (form.tipo === 'ingreso' && !form.metodoPago) {
              return alert('Método de pago es requerido para ingresos');
            }
            setSaving(true);
            await onSave(form);
            setSaving(false);
          }} disabled={saving} style={S.btnPrimary}>{saving ? 'Guardando...' : 'Registrar movimiento'}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Principal ───────────────────────────────────────────────────────────────
export default function GestionCaja({ user }) {
  const [tab, setTab] = useState('cajas');
  const [cajas, setCajas] = useState([]);
  const [movimientos, setMovimientos] = useState([]);
  const [ordenesPendientes, setOrdenesPendientes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(null);
  const [filtroCaja, setFiltroCaja] = useState('todas');
  const [filtroDesde, setFiltroDesde] = useState('');
  const [filtroHasta, setFiltroHasta] = useState('');

  useEffect(() => { 
    cargarDatos();
    cargarOrdenesPendientes();
  }, []);

  const getHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

  const cargarOrdenesPendientes = async () => {
    try {
      const h = getHeaders();
      const { data } = await axios.get(`${API}/orders?cxcEstado=DEBE`, { headers: h });
      setOrdenesPendientes(data || []);
    } catch (e) {
      console.error('Error cargando órdenes pendientes:', e);
    }
  };

  const cargarDatos = async () => {
    setLoading(true);
    try {
      const h = getHeaders();
      const [cRes, mRes] = await Promise.all([
        axios.get(`${API}/cajas`, { headers: h }),
        axios.get(`${API}/cajas/movimientos/todos`, { headers: h }),
      ]);
      setCajas(cRes.data || []);
      setMovimientos(mRes.data || []);
    } catch (e) {
      console.error('Error cargando caja:', e);
    }
    setLoading(false);
  };

  const guardarCaja = async (form) => {
    const data = { ...form, saldo: Number(form.saldo) };
    if (selected) {
      try { await axios.put(`${API}/cajas/${selected.id}`, data, { headers: getHeaders() }); } catch { }
      setCajas(p => p.map(c => c.id === selected.id ? { ...c, ...data } : c));
    } else {
      try {
        const res = await axios.post(`${API}/cajas`, data, { headers: getHeaders() });
        setCajas(p => [...p, res.data]);
      } catch {
        setCajas(p => [...p, { id: 'local-' + Date.now(), ...data }]);
      }
    }
    setModal(null); setSelected(null);
  };

  const toggleActiva = async (caja) => {
    const update = { activa: !caja.activa };
    try { await axios.put(`${API}/cajas/${caja.id}`, update, { headers: getHeaders() }); } catch { }
    setCajas(p => p.map(c => c.id === caja.id ? { ...c, ...update } : c));
  };

  const hacerTraslado = async ({ cajaOrigenId, cajaDestinoId, monto, concepto }) => {
    const origen = cajas.find(c => c.id === cajaOrigenId);
    const destino = cajas.find(c => c.id === cajaDestinoId);
    try {
      await axios.post(`${API}/cajas/traslado`, { cajaOrigenId, cajaDestinoId, monto, concepto }, { headers: getHeaders() });
    } catch { }
    setCajas(p => p.map(c => {
      if (c.id === cajaOrigenId) return { ...c, saldo: (c.saldo || 0) - monto };
      if (c.id === cajaDestinoId) return { ...c, saldo: (c.saldo || 0) + monto };
      return c;
    }));
    const now = new Date().toISOString();
    setMovimientos(p => [
      { id: 'ts-' + Date.now(), tipo: 'traslado_salida', cajaId: cajaOrigenId, cajaDestinoId, monto, concepto, createdAt: now },
      { id: 'te-' + Date.now(), tipo: 'traslado_entrada', cajaId: cajaDestinoId, cajaOrigenId, monto, concepto, createdAt: now },
      ...p
    ]);
    setModal(null);
  };

 const registrarMovimiento = async (form) => {
  try {
    // ✅ VALIDACIONES OBLIGATORIAS
    if (!form.cajaId || !form.monto || !form.concepto.trim()) {
      return alert('Caja, monto y concepto son requeridos');
    }
    if (form.tipo === 'ingreso' && !form.metodoPago) {
      return alert('Método de pago es requerido para ingresos');
    }

    // Si es ingreso, envía a /ingresos (CTRL-005)
    if (form.tipo === 'ingreso') {
      await axios.post(`${API}/cajas/ingresos`, {
        cajaId: form.cajaId,
        monto: form.monto,
        concepto: form.concepto,
        metodoPago: form.metodoPago,
        ordenIds: form.ordenIds,
        mensajeroId: form.mensajeroId,
        comprobante: form.comprobante
      }, { headers: getHeaders() });
    } else {
      
        // Si es egreso, POST a /egresos (ruta existente)
        await axios.post(`${API}/cajas/egresos`, {
          cajaId: form.cajaId,
          monto: form.monto,
          concepto: form.concepto,
          notas: form.notas
        }, { headers: getHeaders() });
      }
      
      // Recargar cajas y órdenes
      await cargarDatos();
      await cargarOrdenesPendientes();
      setModal(null);
      alert('Movimiento registrado correctamente');
    } catch (e) {
      console.error('Error registrando movimiento:', e);
      alert('Error: ' + (e.response?.data?.error || e.message || 'Error desconocido'));
    }
  };

  const movFiltrados = movimientos.filter(m => {
    if (filtroCaja !== 'todas' && m.cajaId !== filtroCaja) return false;
    if (filtroDesde && m.createdAt && new Date(m.createdAt) < new Date(filtroDesde)) return false;
    if (filtroHasta && m.createdAt && new Date(m.createdAt) > new Date(filtroHasta + 'T23:59:59')) return false;
    return true;
  });
  const totalSaldo = cajas.filter(c => c.activa).reduce((a, c) => a + Number(c.saldo || 0), 0);

  const iconTipo = (tipo) => ({ ingreso: '📥', egreso: '📤', traslado_salida: '🔄↗', traslado_entrada: '🔄↘', ajuste: '⚖️' }[tipo] || '💰');
  const colorTipo = (tipo) => ['ingreso', 'traslado_entrada'].includes(tipo) ? '#16a34a' : '#dc2626';
  const esPositivo = (tipo) => ['ingreso', 'traslado_entrada'].includes(tipo);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>⏳ Cargando cajas...</div>;

  return (
    <div style={S.page}>
      <div style={S.pageHeader}>
        <div>
          <h2 style={S.pageTitle}>🏦 Caja</h2>
          <p style={S.pageSubtitle}>Saldos · Movimientos · Traslados entre cajas</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {tab === 'movimientos' && (
            <>
              <button onClick={async () => {
                try {
                  if (!filtroDesde || !filtroHasta) {
                    return alert('Selecciona rango de fechas para exportar');
                  }
                  
                  const h = getHeaders();
                  const { data } = await axios.get(`${API}/cajas/movimientos/exportar`, {
                    params: {
                      fechaDesde: filtroDesde,
                      fechaHasta: filtroHasta,
                      cajaId: filtroCaja !== 'todas' ? filtroCaja : null
                    },
                    headers: h
                  });
                  
                  exportarExcel(data.movimientos, `Movimientos_${filtroDesde}_${filtroHasta}`);
                  alert(`✅ Exportados ${data.totalRegistros} movimientos`);
                } catch (e) {
                  console.error('Error exportando:', e);
                  alert('Error al exportar: ' + e.message);
                }
              }} style={{ ...S.actionBtn, fontSize: 12, padding: '8px 14px' }}>
                📥 Exportar
              </button>
              <button onClick={() => setModal('movimiento')} style={S.btnPrimary}>+ Movimiento manual</button>
            </>
          )}
          {tab === 'traslados' && (
            <button onClick={() => setModal('traslado')} style={{ ...S.btnPrimary, background: 'linear-gradient(135deg,#0284c7,#0369a1)' }}>🔄 Nuevo traslado</button>
          )}
        </div>
      </div>

      {/* KPIs por caja */}
      <div style={S.kpiRow}>
        {cajas.filter(c => c.activa).map(c => (
          <div key={c.id} style={{ ...S.kpiCard, borderLeft: `4px solid ${c.tipo === 'Banco' ? '#3b82f6' : c.tipo === 'Mensajero' ? '#f59e0b' : '#22c55e'}` }}>
            <div style={S.kpiLabel}>{c.tipo === 'Banco' ? '🏦' : c.tipo === 'Mensajero' ? '🚚' : c.tipo === 'Nequi/Daviplata' ? '📱' : '💵'} {c.nombre}</div>
            <div style={{ ...S.kpiValue, color: Number(c.saldo) < 0 ? '#dc2626' : '#1e293b' }}>{fmt(c.saldo)}</div>
            <div style={S.kpiSub}>{c.responsable || '—'}</div>
          </div>
        ))}
        <div style={{ ...S.kpiCard, borderLeft: '4px solid #6366f1', background: '#f5f3ff' }}>
          <div style={S.kpiLabel}>💼 Total general</div>
          <div style={{ ...S.kpiValue, color: '#4f46e5' }}>{fmt(totalSaldo)}</div>
          <div style={S.kpiSub}>{cajas.filter(c => c.activa).length} cajas activas</div>
        </div>
      </div>

      {/* Filtros — solo en movimientos */}
      {tab === 'movimientos' && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select style={{ ...S.select, maxWidth: 220 }} value={filtroCaja} onChange={e => setFiltroCaja(e.target.value)}>
            <option value="todas">Todas las cajas</option>
            {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
          <input type="date" style={{ ...S.input, maxWidth: 160 }} value={filtroDesde} onChange={e => setFiltroDesde(e.target.value)} title="Desde" />
          <input type="date" style={{ ...S.input, maxWidth: 160 }} value={filtroHasta} onChange={e => setFiltroHasta(e.target.value)} title="Hasta" />
          {(filtroDesde || filtroHasta || filtroCaja !== 'todas') && (
            <button onClick={() => { setFiltroDesde(''); setFiltroHasta(''); setFiltroCaja('todas'); }} style={{ padding: '8px 14px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>✕ Limpiar</button>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={S.tabs}>
        {[{ key: 'cajas', label: '🏦 Mis Cajas' }, { key: 'movimientos', label: '📋 Movimientos' }, { key: 'traslados', label: '🔄 Traslados entre cajas' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            ...S.tabBtn,
            background: tab === t.key ? '#fff' : 'transparent',
            color: tab === t.key ? '#4f46e5' : '#64748b',
            borderBottom: tab === t.key ? '2px solid #4f46e5' : '2px solid transparent',
            fontWeight: tab === t.key ? 700 : 500,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'cajas' && (
        <div>
          {cajas.filter(c => c.activa).length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🏦</div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>No hay cajas configuradas</div>
              <div style={{ fontSize: 13 }}>Ve a <strong>Mi Empresa → Cajas</strong> para crear tus cajas</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16, marginTop: 16 }}>
              {cajas.filter(c => c.activa).map(caja => (
                <div key={caja.id} style={{
                  background: '#fff', borderRadius: 14, padding: '20px 22px',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.08)', border: '1px solid #e2e8f0',
                  borderLeft: `4px solid ${caja.tipo === 'Banco' ? '#3b82f6' : caja.tipo === 'Mensajero' ? '#f59e0b' : caja.tipo === 'Nequi/Daviplata' ? '#a855f7' : '#22c55e'}`
                }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                    {caja.tipo === 'Banco' ? '🏦' : caja.tipo === 'Mensajero' ? '🚚' : caja.tipo === 'Nequi/Daviplata' ? '📱' : '💵'} {caja.tipo}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#1e293b', marginBottom: 2 }}>{caja.nombre}</div>
                  {caja.banco && <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>{caja.banco}{caja.numeroCuenta ? ` · ${caja.numeroCuenta}` : ''}</div>}
                  <div style={{ fontSize: 28, fontWeight: 900, color: Number(caja.saldo) < 0 ? '#dc2626' : '#1e293b', margin: '10px 0 6px' }}>
                    {fmt(caja.saldo)}
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>Responsable: {caja.responsable || '—'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab Movimientos */}
      {tab === 'movimientos' && (
        <div style={{ ...S.tableWrap, marginTop: 16 }}>
          <table style={S.table}>
            <thead>
              <tr style={S.thead}>
                <th style={S.th}>Fecha</th>
                <th style={S.th}>Concepto</th>
                <th style={S.th}>Caja</th>
                <th style={S.th}>Tipo</th>
                <th style={S.th}>Monto</th>
                <th style={S.th}>Referencia</th>
              </tr>
            </thead>
            <tbody>
              {movFiltrados.filter(m => !['traslado_salida', 'traslado_entrada'].includes(m.tipo)).length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Sin movimientos registrados</td></tr>
              )}
              {movFiltrados.filter(m => !['traslado_salida', 'traslado_entrada'].includes(m.tipo)).map(mv => {
                const caja = cajas.find(c => c.id === mv.cajaId);
                return (
                  <tr key={mv.id} style={S.tr}>
                    <td style={S.td}><span style={{ fontSize: 12, color: '#64748b' }}>{fmtDate(mv.createdAt)}</span></td>
                    <td style={S.td}><span style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{mv.concepto}</span></td>
                    <td style={S.td}><span style={{ fontSize: 12, color: '#475569' }}>{caja?.nombre || '—'}</span></td>
                    <td style={S.td}><span style={{ fontSize: 12, color: colorTipo(mv.tipo) }}>{iconTipo(mv.tipo)} {mv.tipo}</span></td>
                    <td style={{ ...S.td, fontWeight: 700, color: esPositivo(mv.tipo) ? '#16a34a' : '#dc2626', fontSize: 14 }}>
                      {esPositivo(mv.tipo) ? '+' : '-'}{fmt(mv.monto)}
                    </td>
                    <td style={S.td}><span style={{ fontSize: 11, color: '#94a3b8' }}>{mv.referencia || '—'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Tab Traslados */}
      {tab === 'traslados' && (
        <div style={{ ...S.tableWrap, marginTop: 16 }}>
          <div style={{ padding: '12px 16px', background: '#f0f9ff', borderBottom: '1px solid #e0f2fe', fontSize: 12, color: '#0369a1' }}>
            💡 Los traslados mueven dinero entre cajas. <strong>No suman ni restan al resultado de la empresa</strong> — solo cambian de bolsillo.
          </div>
          <table style={S.table}>
            <thead>
              <tr style={S.thead}>
                <th style={S.th}>Fecha</th>
                <th style={S.th}>Concepto</th>
                <th style={S.th}>Sale de</th>
                <th style={S.th}>Entra a</th>
                <th style={S.th}>Monto</th>
              </tr>
            </thead>
            <tbody>
              {movimientos.filter(m => m.tipo === 'traslado_salida').length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Sin traslados registrados</td></tr>
              )}
              {movimientos.filter(m => m.tipo === 'traslado_salida').map(mv => {
                const origen = cajas.find(c => c.id === mv.cajaId);
                const destino = cajas.find(c => c.id === mv.cajaDestinoId);
                return (
                  <tr key={mv.id} style={S.tr}>
                    <td style={S.td}><span style={{ fontSize: 12, color: '#64748b' }}>{fmtDate(mv.createdAt)}</span></td>
                    <td style={S.td}><span style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{mv.concepto}</span></td>
                    <td style={S.td}><span style={{ fontSize: 12, color: '#dc2626' }}>📤 {origen?.nombre || '—'}</span></td>
                    <td style={S.td}><span style={{ fontSize: 12, color: '#16a34a' }}>📥 {destino?.nombre || '—'}</span></td>
                    <td style={{ ...S.td, fontWeight: 700, color: '#1e293b', fontSize: 14 }}>{fmt(mv.monto)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modales */}
      {modal === 'traslado' && <ModalTraslado cajas={cajas} onTraslado={hacerTraslado} onClose={() => setModal(null)} />}
      {modal === 'movimiento' && (
        <ModalMovimiento 
          cajas={cajas} 
          ordenesPendientes={ordenesPendientes || []}
          onSave={registrarMovimiento} 
          onClose={() => setModal(null)} 
        />
      )}
    </div>
  );
}

const S = {
  page: { padding: '24px 32px', maxWidth: 1300, margin: '0 auto' },
  pageHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  pageTitle: { margin: 0, fontSize: 26, fontWeight: 800, color: '#1e293b' },
  pageSubtitle: { margin: '4px 0 0', fontSize: 13, color: '#64748b' },
  kpiRow: { display: 'flex', gap: 14, marginBottom: 20, flexWrap: 'wrap' },
  kpiCard: { background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', minWidth: 150, flex: '1 1 150px' },
  kpiLabel: { fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 6 },
  kpiValue: { fontSize: 20, fontWeight: 800 },
  kpiSub: { fontSize: 11, color: '#94a3b8', marginTop: 4 },
  tabs: { display: 'flex', borderBottom: '1px solid #e2e8f0', marginBottom: 0 },
  tabBtn: { padding: '10px 20px', border: 'none', cursor: 'pointer', fontSize: 13, transition: 'all 0.15s', background: 'transparent' },
  tableWrap: { background: '#fff', borderRadius: 14, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' },
  thead: { background: '#f8fafc' },
  th: { padding: '12px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #e2e8f0' },
  tr: { borderBottom: '1px solid #f1f5f9' },
  td: { padding: '12px 14px', verticalAlign: 'middle' },
  actionBtn: { padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#f1f5f9', color: '#475569', marginRight: 6 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal: { background: '#fff', borderRadius: 16, maxWidth: 580, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxHeight: '90vh', overflowY: 'auto' },
  modalHeader: { padding: '20px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { margin: 0, fontSize: 18, fontWeight: 800, color: '#1e293b' },
  closeBtn: { background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8', padding: 4 },
  modalBody: { padding: '20px 24px' },
  modalFooter: { padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: 700, color: '#374151' },
  input: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  select: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  btnPrimary: { padding: '10px 20px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnSecondary: { padding: '10px 20px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
