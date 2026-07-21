import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

// ─────────────────────────────────────────────────────────────────────────────
// PANEL MAESTRO DE SUSCRIPTORES — solo super-admin (Milena)
//
// - Portero propio: al montar llama GET /api/superadmin/verificar.
//   Si responde 403, muestra "acceso restringido" — el componente es seguro
//   aunque alguien adivine la ruta, porque el backend valida la marca
//   superAdmin directamente en Firestore en cada petición.
// - Lista todos los suscriptores (admins) con plan, estado, vencimiento,
//   sub-usuarios y módulos.
// - Editar plan: plan + estado + fechas + notas → colección `suscripciones`.
// - Editar módulos: el switch de QR/IA y demás, sin tocar Firebase a mano.
//   Convención del sistema: lista vacía = TODOS los módulos.
// ─────────────────────────────────────────────────────────────────────────────

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

// Catálogo de módulos conocidos (claves reales del sistema, en minúscula).
// Si un suscriptor tiene claves fuera de este catálogo, se muestran y se
// CONSERVAN — el editor nunca elimina claves desconocidas en silencio.
const CATALOGO_MODULOS = [
  { key: 'ordenes',      label: 'Órdenes de servicio' },
  { key: 'cotizaciones', label: 'Cotizaciones' },
  { key: 'clientes',     label: 'Clientes' },
  { key: 'productos',    label: 'Productos' },
  { key: 'inventarios',  label: 'Inventarios' },
  { key: 'logistica',    label: 'Logística' },
  { key: 'taller',       label: 'Taller' },
  { key: 'caja',         label: 'Caja y Transferencias' },
  { key: 'egresos',      label: 'Egresos' },
  { key: 'compras',      label: 'Compras' },
  { key: 'cxc',          label: 'Cuentas por Cobrar' },
  { key: 'cxp',          label: 'Cuentas por Pagar' },
  { key: 'eri',          label: 'ERI' },
  { key: 'reportes',     label: 'Reportes' },
  { key: 'qr',           label: 'QR Activos ⭐ (solo invitados)' },
  { key: 'llamadas_ia',  label: 'Llamadas IA — Lucy ⭐ (solo invitados)' },
 { key: 'anny_ia',      label: 'WhatsApp IA Anny ⭐ (solo invitados)' },
];

const ESTADO_UI = {
  trial:      { txt: 'Prueba',     bg: '#eef2ff', col: '#5b5bd6' },
  activo:     { txt: 'Activo',     bg: '#e9f9ef', col: '#16a34a' },
  suspendido: { txt: 'Suspendido', bg: '#fde8e8', col: '#dc2626' },
};

const hoyMas = (dias) => {
  const d = new Date(Date.now() + dias * 86400000);
  return d.toISOString().slice(0, 10);
};

const PanelSuscriptores = () => {
  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  const [acceso, setAcceso] = useState('verificando'); // verificando | ok | denegado
  const [suscriptores, setSuscriptores] = useState([]);
  const [planes, setPlanes] = useState({});
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [exito, setExito] = useState('');

  // Modal de plan
  const [editPlan, setEditPlan] = useState(null); // suscriptor en edición
  const [formPlan, setFormPlan] = useState({ plan: '', estado: 'trial', fechaInicio: '', fechaVencimiento: '', notas: '' });

  // Modal de módulos
  const [editMods, setEditMods] = useState(null);
  const [modsSel, setModsSel] = useState([]);

  // ✅ LUCY-MINUTOS-001: tope de minutos de Lucy por suscriptor
  const [editMinutos, setEditMinutos] = useState(null);
  const [minutosCfg, setMinutosCfg] = useState(null);
  const [minutosVal, setMinutosVal] = useState('');

  const [guardando, setGuardando] = useState(false);

  // ─── Cargar lista ──────────────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setCargando(true);
    setError('');
    try {
      const res = await axios.get(`${API}/superadmin/suscriptores`, { headers });
      setSuscriptores(res.data.suscriptores || []);
      setPlanes(res.data.planes || {});
    } catch (e) {
      setError(e.response?.data?.error || 'Error al cargar suscriptores');
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Portero: verificar super-admin al montar ─────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        await axios.get(`${API}/superadmin/verificar`, { headers });
        setAcceso('ok');
        cargar();
      } catch {
        setAcceso('denegado');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flashExito = (msg) => {
    setExito(msg);
    setTimeout(() => setExito(''), 3500);
  };

  // ─── Abrir modal de plan ───────────────────────────────────────────────────
  const abrirPlan = (s) => {
    setFormPlan({
      plan: s.plan || 'empresa',
      estado: s.estado || 'trial',
      fechaInicio: s.fechaInicio || new Date().toISOString().slice(0, 10),
      fechaVencimiento: s.fechaVencimiento || hoyMas(14),
      notas: s.notas || ''
    });
    setEditPlan(s);
  };

  const guardarPlan = async () => {
    if (!formPlan.fechaVencimiento) { setError('La fecha de vencimiento es obligatoria'); return; }
    setGuardando(true);
    setError('');
    try {
      await axios.put(`${API}/superadmin/suscriptores/${editPlan.adminId}/plan`, formPlan, { headers });
      setEditPlan(null);
      flashExito('Suscripción guardada');
      cargar();
    } catch (e) {
      setError(e.response?.data?.error || 'Error al guardar la suscripción');
    } finally {
      setGuardando(false);
    }
  };

  // ─── ✅ LUCY-MINUTOS-001: tope de minutos de Lucy por suscriptor ───────────
  // Antes el tope vivía solo en la variable de entorno (120 min iguales para
  // todos) y solo se cambiaba tocando la base de datos a mano. Ahora se
  // asigna por suscriptor desde aquí, según el plan que se le venda.
  const abrirMinutos = async (s) => {
    setEditMinutos(s);
    setMinutosCfg(null);
    setMinutosVal('');
    try {
      const r = await axios.get(`${API}/llamadas-ia/superadmin/config/${s.adminId}`, { headers });
      setMinutosCfg(r.data);
      setMinutosVal(String(r.data.topeMinutosMes ?? ''));
    } catch (e) {
      setError(e.response?.data?.error || 'No se pudo leer la configuración de Lucy');
    }
  };

  const guardarMinutos = async () => {
    const tope = Number(minutosVal);
    if (!Number.isFinite(tope) || tope < 0) { setError('El tope debe ser un número mayor o igual a 0'); return; }
    setGuardando(true);
    setError('');
    try {
      await axios.put(`${API}/llamadas-ia/superadmin/config/${editMinutos.adminId}`,
        { topeMinutosMes: tope }, { headers });
      setEditMinutos(null);
      flashExito(`Tope de Lucy actualizado a ${tope} min/mes`);
    } catch (e) {
      setError(e.response?.data?.error || 'Error al guardar el tope de minutos');
    } finally {
      setGuardando(false);
    }
  };

  // ─── Abrir modal de módulos ────────────────────────────────────────────────
  const abrirMods = (s) => {
    setModsSel(s.modulos || []);
    setEditMods(s);
  };

  const toggleMod = (key) => {
    setModsSel(prev => prev.includes(key) ? prev.filter(m => m !== key) : [...prev, key]);
  };

  const guardarMods = async () => {
    setGuardando(true);
    setError('');
    try {
      await axios.put(`${API}/superadmin/suscriptores/${editMods.adminId}/modulos`, { modulos: modsSel }, { headers });
      setEditMods(null);
      flashExito('Módulos actualizados');
      cargar();
    } catch (e) {
      setError(e.response?.data?.error || 'Error al actualizar módulos');
    } finally {
      setGuardando(false);
    }
  };

  // ─── Estilos ───────────────────────────────────────────────────────────────
  const st = {
    page: { padding: '24px 16px', maxWidth: 1100, margin: '0 auto', fontFamily: 'inherit' },
    h1: { fontSize: 22, fontWeight: 800, color: '#14142b', margin: 0 },
    sub: { color: '#6b6b85', fontSize: 13, marginTop: 4 },
    alertErr: { background: '#fde8e8', color: '#dc2626', padding: '10px 14px', borderRadius: 10, fontSize: 13, margin: '14px 0' },
    alertOk: { background: '#e9f9ef', color: '#16a34a', padding: '10px 14px', borderRadius: 10, fontSize: 13, margin: '14px 0' },
    card: { background: '#fff', border: '1.5px solid #e8e8f4', borderRadius: 14, padding: 18, marginTop: 14 },
    rowTop: { display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'flex-start' },
    nombre: { fontWeight: 700, fontSize: 15, color: '#14142b' },
    email: { color: '#6b6b85', fontSize: 12.5 },
    badge: (e) => ({ display: 'inline-block', padding: '3px 11px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, background: e.bg, color: e.col }),
    datos: { display: 'flex', flexWrap: 'wrap', gap: '8px 22px', marginTop: 12, fontSize: 13, color: '#3d3d5c' },
    dato: { display: 'flex', flexDirection: 'column' },
    datoL: { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em', color: '#9a9ab5', fontWeight: 600 },
    datoV: { fontWeight: 600, marginTop: 2 },
    chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 },
    chip: { background: '#f6f6fc', border: '1px solid #e8e8f4', borderRadius: 99, padding: '3px 10px', fontSize: 11.5, color: '#3d3d5c' },
    chipQR: { background: '#f3eefe', border: '1px solid #ddd0fb', borderRadius: 99, padding: '3px 10px', fontSize: 11.5, color: '#8b5cf6', fontWeight: 700 },
    btns: { display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' },
    btn: { background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', border: 'none', borderRadius: 10, padding: '9px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
    btnGhost: { background: '#fff', color: '#14142b', border: '1.5px solid #e8e8f4', borderRadius: 10, padding: '8px 15px', fontWeight: 600, fontSize: 13, cursor: 'pointer' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(20,20,43,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 },
    modal: { background: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto' },
    label: { display: 'block', fontSize: 12, fontWeight: 700, color: '#3d3d5c', margin: '14px 0 5px' },
    input: { width: '100%', padding: '10px 12px', border: '1.5px solid #e8e8f4', borderRadius: 10, fontSize: 14, boxSizing: 'border-box' },
    aviso: { background: '#fff8e6', border: '1px solid #f3d98a', color: '#8a6d1a', borderRadius: 10, padding: '9px 12px', fontSize: 12, marginTop: 12 },
    modRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid #f1f1f8', fontSize: 13.5, cursor: 'pointer' },
  };

  // ─── Estados de acceso ─────────────────────────────────────────────────────
  if (acceso === 'verificando') {
    return <div style={{ ...st.page, color: '#6b6b85' }}>Verificando acceso…</div>;
  }
  if (acceso === 'denegado') {
    return (
      <div style={st.page}>
        <div style={st.alertErr}>Acceso restringido. Este panel es exclusivo del administrador de la plataforma.</div>
      </div>
    );
  }

  // ─── Render principal ──────────────────────────────────────────────────────
  return (
    <div style={st.page}>
      <h1 style={st.h1}>Panel de Suscriptores</h1>
      <p style={st.sub}>Administra planes, vencimientos y módulos de cada suscriptor de Control360.</p>

      {error && <div style={st.alertErr}>{error}</div>}
      {exito && <div style={st.alertOk}>✓ {exito}</div>}
      {cargando && <div style={{ color: '#6b6b85', marginTop: 14 }}>Cargando…</div>}

      {!cargando && suscriptores.map((s) => {
        const e = ESTADO_UI[s.estado] || { txt: 'Sin plan', bg: '#f1f1f8', col: '#6b6b85' };
        const venceTxt = s.fechaVencimiento
          ? `${s.fechaVencimiento}${s.diasRestantes !== null ? ` · ${s.diasRestantes >= 0 ? `${s.diasRestantes} días` : `vencido hace ${Math.abs(s.diasRestantes)} días`}` : ''}`
          : '—';
        const venceColor = s.diasRestantes === null ? '#3d3d5c' : s.diasRestantes < 0 ? '#dc2626' : s.diasRestantes <= 5 ? '#d97706' : '#16a34a';

        return (
          <div key={s.adminId} style={st.card}>
            <div style={st.rowTop}>
              <div>
                <div style={st.nombre}>
                  {s.empresa || s.nombre || s.email}
                  {s.superAdmin && <span style={{ marginLeft: 8, fontSize: 11, color: '#8b5cf6', fontWeight: 700 }}>★ Plataforma</span>}
                </div>
                <div style={st.email}>{s.nombre} · {s.email}</div>
              </div>
              <span style={st.badge(e)}>{e.txt}</span>
            </div>

            <div style={st.datos}>
              <div style={st.dato}>
                <span style={st.datoL}>Plan</span>
                <span style={st.datoV}>{s.planNombre || 'Sin asignar'}</span>
              </div>
              <div style={st.dato}>
                <span style={st.datoL}>Vence</span>
                <span style={{ ...st.datoV, color: venceColor }}>{venceTxt}</span>
              </div>
              <div style={st.dato}>
                <span style={st.datoL}>Sub-usuarios</span>
                <span style={st.datoV}>{s.subUsuarios}</span>
              </div>
              <div style={st.dato}>
                <span style={st.datoL}>Login</span>
                <span style={{ ...st.datoV, color: s.activo ? '#16a34a' : '#dc2626' }}>{s.activo ? 'Habilitado' : 'Desactivado'}</span>
              </div>
            </div>

            <div style={st.chips}>
              {(s.modulos || []).length === 0
                ? <span style={st.chip}>Todos los módulos</span>
                : s.modulos.map(m => (
                    <span key={m} style={m === 'qr' ? st.chipQR : st.chip}>
                      {CATALOGO_MODULOS.find(c => c.key === m)?.label.replace(' ⭐ (solo invitados)', ' ⭐') || m}
                    </span>
                  ))}
            </div>

            <div style={st.btns}>
              <button style={st.btn} onClick={() => abrirPlan(s)}>
                {s.plan ? 'Editar plan' : 'Asignar plan'}
              </button>
              <button style={st.btnGhost} onClick={() => abrirMods(s)}>Módulos</button>
              {/* ✅ LUCY-MINUTOS-001: solo si el suscriptor tiene Lucy activa */}
              {(s.modulos || []).includes('llamadas_ia') && (
                <button style={st.btnGhost} onClick={() => abrirMinutos(s)}>📞 Minutos Lucy</button>
              )}
            </div>
          </div>
        );
      })}

      {!cargando && suscriptores.length === 0 && !error && (
        <div style={{ ...st.card, color: '#6b6b85', textAlign: 'center' }}>No hay suscriptores registrados todavía.</div>
      )}

      {/* ─── ✅ LUCY-MINUTOS-001 · MODAL: MINUTOS DE LUCY ─── */}
      {editMinutos && (
        <div style={st.overlay} onClick={() => !guardando && setEditMinutos(null)}>
          <div style={st.modal} onClick={(ev) => ev.stopPropagation()}>
            <h2 style={{ ...st.h1, fontSize: 17 }}>📞 Minutos de Lucy — {editMinutos.empresa || editMinutos.nombre || editMinutos.email}</h2>

            {!minutosCfg ? (
              <div style={{ color: '#6b6b85', fontSize: 13, marginTop: 14 }}>Cargando configuración...</div>
            ) : (
              <>
                <div style={{ background: '#f7f7fb', borderRadius: 10, padding: '12px 14px', marginTop: 14, fontSize: 13, color: '#3d3d5c' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span>Consumido este mes</span>
                    <strong>{minutosCfg.minutosConsumidosMes || 0} min</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Tope actual</span>
                    <strong>{minutosCfg.topeMinutosMes} min/mes</strong>
                  </div>
                </div>

                <label style={st.label}>Tope de minutos por mes</label>
                <input type="number" min="0" style={st.input} value={minutosVal}
                  onChange={e => setMinutosVal(e.target.value)} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {[60, 120, 300, 600].map(v => (
                    <button key={v} style={{ ...st.btnGhost, padding: '5px 10px', fontSize: 11.5 }}
                      onClick={() => setMinutosVal(String(v))}>{v} min</button>
                  ))}
                </div>
                <div style={{ color: '#6b6b85', fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
                  Cuando el suscriptor llega a su tope, Lucy deja de llamar por ese mes y queda registrado.
                  El consumo se reinicia solo cada mes — cambiar el tope no borra el histórico.
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                  <button style={st.btn} onClick={guardarMinutos} disabled={guardando}>
                    {guardando ? 'Guardando...' : 'Guardar tope'}
                  </button>
                  <button style={st.btnGhost} onClick={() => setEditMinutos(null)} disabled={guardando}>Cancelar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ─── MODAL: PLAN ─── */}
      {editPlan && (
        <div style={st.overlay} onClick={() => !guardando && setEditPlan(null)}>
          <div style={st.modal} onClick={(ev) => ev.stopPropagation()}>
            <h2 style={{ ...st.h1, fontSize: 17 }}>Suscripción — {editPlan.empresa || editPlan.nombre || editPlan.email}</h2>

            <label style={st.label}>Plan</label>
            <select style={st.input} value={formPlan.plan} onChange={e => setFormPlan({ ...formPlan, plan: e.target.value })}>
              {Object.entries(planes).map(([k, p]) => (
                <option key={k} value={k}>{p.nombre} — ${Number(p.precio).toLocaleString('es-CO')}/mes</option>
              ))}
            </select>

            <label style={st.label}>Estado</label>
            <select style={st.input} value={formPlan.estado} onChange={e => setFormPlan({ ...formPlan, estado: e.target.value })}>
              <option value="trial">Prueba (trial)</option>
              <option value="activo">Activo (pagando)</option>
              <option value="suspendido">Suspendido</option>
            </select>

            <label style={st.label}>Fecha de inicio</label>
            <input type="date" style={st.input} value={formPlan.fechaInicio} onChange={e => setFormPlan({ ...formPlan, fechaInicio: e.target.value })} />

            <label style={st.label}>Fecha de vencimiento *</label>
            <input type="date" style={st.input} value={formPlan.fechaVencimiento} onChange={e => setFormPlan({ ...formPlan, fechaVencimiento: e.target.value })} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button style={{ ...st.btnGhost, padding: '5px 10px', fontSize: 11.5 }} onClick={() => setFormPlan({ ...formPlan, fechaVencimiento: hoyMas(14) })}>+14 días</button>
              <button style={{ ...st.btnGhost, padding: '5px 10px', fontSize: 11.5 }} onClick={() => setFormPlan({ ...formPlan, fechaVencimiento: hoyMas(30) })}>+1 mes</button>
              <button style={{ ...st.btnGhost, padding: '5px 10px', fontSize: 11.5 }} onClick={() => setFormPlan({ ...formPlan, fechaVencimiento: hoyMas(365) })}>+1 año</button>
            </div>

            <label style={st.label}>Notas</label>
            <input type="text" style={st.input} placeholder="Ej: pagó por Nequi, cliente referido…" value={formPlan.notas} onChange={e => setFormPlan({ ...formPlan, notas: e.target.value })} />

            {formPlan.estado === 'suspendido' && (
              <div style={st.aviso}>En esta versión la suspensión es informativa: aún no bloquea el ingreso del suscriptor. El bloqueo automático llega en la siguiente iteración.</div>
            )}

            <div style={{ ...st.btns, justifyContent: 'flex-end' }}>
              <button style={st.btnGhost} disabled={guardando} onClick={() => setEditPlan(null)}>Cancelar</button>
              <button style={st.btn} disabled={guardando} onClick={guardarPlan}>{guardando ? 'Guardando…' : 'Guardar suscripción'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: MÓDULOS ─── */}
      {editMods && (
        <div style={st.overlay} onClick={() => !guardando && setEditMods(null)}>
          <div style={st.modal} onClick={(ev) => ev.stopPropagation()}>
            <h2 style={{ ...st.h1, fontSize: 17 }}>Módulos — {editMods.empresa || editMods.nombre || editMods.email}</h2>
            <p style={{ ...st.sub, marginTop: 6 }}>Lo que no esté activo no aparece en el menú del suscriptor.</p>

            {CATALOGO_MODULOS.map(m => (
              <label key={m.key} style={st.modRow}>
                <input type="checkbox" checked={modsSel.includes(m.key)} onChange={() => toggleMod(m.key)} />
                <span style={m.key === 'qr' ? { color: '#8b5cf6', fontWeight: 700 } : {}}>{m.label}</span>
              </label>
            ))}

            {/* Claves existentes fuera del catálogo: se muestran y se conservan */}
            {modsSel.filter(m => !CATALOGO_MODULOS.some(c => c.key === m)).map(m => (
              <label key={m} style={st.modRow}>
                <input type="checkbox" checked onChange={() => toggleMod(m)} />
                <span style={{ color: '#6b6b85' }}>{m} <em style={{ fontSize: 11 }}>(clave personalizada)</em></span>
              </label>
            ))}

            {modsSel.length === 0 && (
              <div style={st.aviso}>Lista vacía = el suscriptor ve <b>TODOS</b> los módulos (convención del sistema). Si quieres restringir, marca solo los que aplican.</div>
            )}

            <div style={{ ...st.btns, justifyContent: 'flex-end' }}>
              <button style={st.btnGhost} disabled={guardando} onClick={() => setEditMods(null)}>Cancelar</button>
              <button style={st.btn} disabled={guardando} onClick={guardarMods}>{guardando ? 'Guardando…' : 'Guardar módulos'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PanelSuscriptores;
