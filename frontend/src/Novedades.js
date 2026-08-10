// ═══════════════════════════════════════════════════════════════════════════════
// Novedades.js — Campanita de novedades, banner y publicación
// ─────────────────────────────────────────────────────────────────────────────
// NOVEDADES-001
//
// TRES COMPONENTES, TRES MOMENTOS
//
//   CampanaNovedades  → siempre visible en la cabecera, con punto rojo si hay
//                       algo sin leer. No interrumpe.
//   BannerNovedad     → solo para lo crítico sin leer (un cambio que altera
//                       cómo se trabaja). Ocupa espacio hasta que se lea.
//   PanelNovedades    → donde el superadmin publica y mide el alcance.
//
// POR QUÉ ESTA SEPARACIÓN
// Si todo interrumpe, nada interrumpe: el usuario aprende a cerrar sin leer.
// Reservando el banner para lo verdaderamente importante, cuando aparece se lee.
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useRef, useMemo } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

// ─── Markdown mínimo → JSX ───────────────────────────────────────────────────
// Mismo subconjunto que soporta el correo: negrita, viñetas y párrafos.
function TextoRico({ texto, size = 13 }) {
  const bloques = useMemo(() => {
    const lineas = String(texto || '').split('\n');
    const out = [];
    let lista = [];

    const cerrarLista = () => {
      if (lista.length) { out.push({ tipo: 'lista', items: lista }); lista = []; }
    };

    for (const l of lineas) {
      const t = l.trim();
      if (/^[·\-*]\s+/.test(t)) { lista.push(t.replace(/^[·\-*]\s+/, '')); continue; }
      cerrarLista();
      if (t) out.push({ tipo: 'p', texto: t });
    }
    cerrarLista();
    return out;
  }, [texto]);

  // Convierte **negrita** en <strong>
  const negrita = (s) => s.split(/(\*\*[^*]+\*\*)/g).map((parte, i) =>
    parte.startsWith('**') && parte.endsWith('**')
      ? <strong key={i} style={{ color: '#0f172a' }}>{parte.slice(2, -2)}</strong>
      : <span key={i}>{parte}</span>
  );

  return (
    <div>
      {bloques.map((b, i) => b.tipo === 'lista' ? (
        <ul key={i} style={{ margin: '7px 0', paddingLeft: 19 }}>
          {b.items.map((it, j) => (
            <li key={j} style={{ fontSize: size, color: '#475569', lineHeight: 1.65, marginBottom: 3 }}>
              {negrita(it)}
            </li>
          ))}
        </ul>
      ) : (
        <p key={i} style={{ margin: '0 0 9px', fontSize: size, color: '#475569', lineHeight: 1.65 }}>
          {negrita(b.texto)}
        </p>
      ))}
    </div>
  );
}

const fechaCorta = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const hoy = new Date();
  const dias = Math.floor((hoy - d) / 86400000);
  if (dias === 0) return 'Hoy';
  if (dias === 1) return 'Ayer';
  if (dias < 7) return `Hace ${dias} días`;
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
};

// ═════════════════════════════════════════════════════════════════════════════
// 1 · CAMPANITA
// ═════════════════════════════════════════════════════════════════════════════
export function CampanaNovedades({ onNavegar }) {
  const [abierto, setAbierto] = useState(false);
  const [data, setData] = useState({ sinLeer: 0, novedades: [], tipos: {} });
  const [expandida, setExpandida] = useState(null);
  const ref = useRef(null);

  const cargar = async () => {
    try {
      const r = await axios.get(`${API}/novedades`, { headers: headers() });
      setData(r.data);
    } catch { }
  };

  useEffect(() => {
    cargar();
    // Se refresca cada 10 minutos: una novedad no es urgente al segundo
    const t = setInterval(cargar, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const marcarLeida = async (id) => {
    try {
      await axios.post(`${API}/novedades/${id}/leer`, {}, { headers: headers() });
      setData(d => ({
        ...d,
        sinLeer: Math.max(0, d.sinLeer - 1),
        novedades: d.novedades.map(n => n.id === id ? { ...n, leida: true } : n)
      }));
    } catch { }
  };

  const marcarTodas = async () => {
    try {
      await axios.post(`${API}/novedades/leer-todas`, {}, { headers: headers() });
      setData(d => ({ ...d, sinLeer: 0, banner: null, novedades: d.novedades.map(n => ({ ...n, leida: true })) }));
    } catch { }
  };

  const abrir = (n) => {
    setExpandida(expandida === n.id ? null : n.id);
    if (!n.leida) marcarLeida(n.id);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setAbierto(a => !a)}
        title="Novedades"
        style={{
          position: 'relative', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 19, padding: '6px 8px', lineHeight: 1
        }}>
        🎁
        {data.sinLeer > 0 && (
          <span style={{
            position: 'absolute', top: 1, right: 1, background: '#dc2626', color: '#fff',
            borderRadius: 20, minWidth: 17, height: 17, fontSize: 10, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
            border: '2px solid #fff'
          }}>{data.sinLeer > 9 ? '9+' : data.sinLeer}</span>
        )}
      </button>

      {abierto && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 8, width: 400, maxWidth: '92vw',
          background: '#fff', borderRadius: 14, boxShadow: '0 18px 50px rgba(15,23,42,0.22)',
          border: '1px solid #f1f5f9', zIndex: 1200, maxHeight: '72vh', overflowY: 'auto'
        }}>
          <div style={{
            padding: '14px 18px', borderBottom: '1px solid #f1f5f9',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            position: 'sticky', top: 0, background: '#fff', borderRadius: '14px 14px 0 0'
          }}>
            <strong style={{ fontSize: 14, color: '#0f172a' }}>Novedades</strong>
            {data.sinLeer > 0 && (
              <button onClick={marcarTodas} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 11.5, color: '#6366f1', fontWeight: 700
              }}>Marcar todas como leídas</button>
            )}
          </div>

          {data.novedades.length === 0 ? (
            <div style={{ padding: 34, textAlign: 'center', color: '#cbd5e1', fontSize: 12.5 }}>
              No hay novedades por ahora
            </div>
          ) : (
            <div>
              {data.novedades.map(n => {
                const t = data.tipos?.[n.tipo] || { etiqueta: 'Novedad', icono: '📌', color: '#64748b' };
                const abierta = expandida === n.id;
                return (
                  <div key={n.id}
                    onClick={() => abrir(n)}
                    style={{
                      padding: '13px 18px', borderBottom: '1px solid #f8fafc', cursor: 'pointer',
                      background: n.leida ? '#fff' : '#f8faff',
                      borderLeft: n.leida ? '3px solid transparent' : `3px solid ${t.color}`
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 9 }}>
                      <span style={{
                        fontSize: 9.5, fontWeight: 800, color: t.color, textTransform: 'uppercase',
                        letterSpacing: '.05em', display: 'flex', alignItems: 'center', gap: 4
                      }}>{t.icono} {t.etiqueta}</span>
                      <span style={{ fontSize: 10.5, color: '#cbd5e1', whiteSpace: 'nowrap' }}>
                        {fechaCorta(n.publicadaEn)}
                      </span>
                    </div>

                    <div style={{
                      fontSize: 13, fontWeight: n.leida ? 600 : 800, color: '#0f172a',
                      marginTop: 4, lineHeight: 1.4
                    }}>{n.titulo}</div>

                    {n.fechaLimite && (
                      <div style={{ fontSize: 11, color: t.color, fontWeight: 700, marginTop: 3 }}>
                        📅 Fecha límite: {n.fechaLimite}
                      </div>
                    )}

                    {abierta && (
                      <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px dashed #e2e8f0' }}>
                        <TextoRico texto={n.cuerpo} size={12.5} />
                        {n.accion?.modulo && onNavegar && (
                          <button onClick={(e) => { e.stopPropagation(); setAbierto(false); onNavegar(n.accion.modulo); }}
                            style={{
                              marginTop: 6, padding: '7px 15px', borderRadius: 8, border: 'none',
                              cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#fff',
                              background: `linear-gradient(135deg, ${t.color}, ${t.color}dd)`
                            }}>
                            {n.accion.texto} →
                          </button>
                        )}
                      </div>
                    )}

                    {!abierta && (
                      <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 3 }}>
                        Clic para ver el detalle
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 2 · BANNER — solo para lo crítico sin leer
// ═════════════════════════════════════════════════════════════════════════════
export function BannerNovedad({ onNavegar }) {
  const [novedad, setNovedad] = useState(null);
  const [expandido, setExpandido] = useState(false);
  const [tipos, setTipos] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/novedades`, { headers: headers() });
        setNovedad(r.data.banner || null);
        setTipos(r.data.tipos || {});
      } catch { }
    })();
  }, []);

  if (!novedad) return null;
  const t = tipos[novedad.tipo] || { etiqueta: 'Importante', icono: '⚠️', color: '#dc2626' };

  const cerrar = async () => {
    try { await axios.post(`${API}/novedades/${novedad.id}/leer`, {}, { headers: headers() }); } catch { }
    setNovedad(null);
  };

  return (
    <div style={{
      background: `linear-gradient(135deg, ${t.color}0f, ${t.color}06)`,
      border: `1px solid ${t.color}44`, borderLeft: `4px solid ${t.color}`,
      borderRadius: 12, padding: '13px 17px', margin: '0 0 16px'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 9.5, fontWeight: 800, color: t.color, textTransform: 'uppercase',
            letterSpacing: '.06em', marginBottom: 4
          }}>{t.icono} {t.etiqueta}</div>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', lineHeight: 1.35 }}>
            {novedad.titulo}
          </div>
          {novedad.fechaLimite && (
            <div style={{ fontSize: 11.5, color: t.color, fontWeight: 700, marginTop: 4 }}>
              📅 Fecha límite: {novedad.fechaLimite}
            </div>
          )}

          {expandido && (
            <div style={{ marginTop: 10 }}>
              <TextoRico texto={novedad.cuerpo} size={12.5} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button onClick={() => setExpandido(v => !v)}
              style={{
                padding: '7px 14px', borderRadius: 8, border: `1px solid ${t.color}55`,
                background: '#fff', color: t.color, cursor: 'pointer', fontSize: 12, fontWeight: 700
              }}>
              {expandido ? 'Ver menos' : 'Ver detalle'}
            </button>
            {novedad.accion?.modulo && onNavegar && (
              <button onClick={() => { cerrar(); onNavegar(novedad.accion.modulo); }}
                style={{
                  padding: '7px 15px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  fontSize: 12, fontWeight: 700, color: '#fff',
                  background: `linear-gradient(135deg, ${t.color}, ${t.color}dd)`
                }}>
                {novedad.accion.texto} →
              </button>
            )}
          </div>
        </div>

        <button onClick={cerrar} title="Entendido"
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 17, color: '#94a3b8', padding: 2 }}>
          ✕
        </button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 3 · PANEL DE PUBLICACIÓN — solo superadmin
// ═════════════════════════════════════════════════════════════════════════════
export function PanelNovedades() {
  const [tab, setTab] = useState('publicar');
  const [form, setForm] = useState({
    tipo: 'nueva_funcion', titulo: '', cuerpo: '',
    critico: false, enviarCorreo: false, soloConEmpleados: false,
    accionTexto: '', accionModulo: ''
  });
  const [historial, setHistorial] = useState({ novedades: [], tipos: {}, totalSuscriptores: 0 });
  const [calendario, setCalendario] = useState(null);
  const [publicando, setPublicando] = useState(false);
  const [mensaje, setMensaje] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const cargar = async () => {
    try {
      const [h, c] = await Promise.all([
        axios.get(`${API}/novedades/admin`, { headers: headers() }),
        axios.get(`${API}/novedades/calendario`, { headers: headers() }).catch(() => ({ data: null }))
      ]);
      setHistorial(h.data);
      setCalendario(c.data);
    } catch { }
  };

  useEffect(() => { cargar(); }, []);

  const publicar = async () => {
    if (!form.titulo.trim()) { setMensaje('✖ El título es obligatorio'); return; }
    if (!form.cuerpo.trim())  { setMensaje('✖ El contenido es obligatorio'); return; }

    const confirmar = form.enviarCorreo
      ? window.confirm(
          `Vas a publicar esta novedad Y enviarla por correo a ${form.soloConEmpleados ? 'los suscriptores con empleados cargados' : `los ${historial.totalSuscriptores} suscriptores activos`}.\n\n` +
          `"${form.titulo}"\n\nEl correo no se puede deshacer. ¿Continuar?`)
      : true;
    if (!confirmar) return;

    setPublicando(true); setMensaje('');
    try {
      const r = await axios.post(`${API}/novedades`, {
        tipo: form.tipo, titulo: form.titulo, cuerpo: form.cuerpo,
        critico: form.critico, enviarCorreo: form.enviarCorreo,
        soloConEmpleados: form.soloConEmpleados,
        accion: form.accionTexto ? { texto: form.accionTexto, modulo: form.accionModulo } : null
      }, { headers: headers() });

      // ✅ NOVEDADES-DIAGNOSTICO-001: si el correo falla, la novedad igual se
      // publica en la aplicación. Antes eso se informaba con un escueto
      // "enviado a 0 de N" y no había forma de saber POR QUÉ no salió.
      const c = r.data.correo;
      if (!form.enviarCorreo) {
        setMensaje('✅ Publicada en la aplicación (sin envío por correo)');
      } else if (!c) {
        setMensaje('✅ Publicada, pero no se recibió respuesta del envío de correo');
      } else if (c.total === 0) {
        setMensaje('⚠️ Publicada, pero no hay destinatarios: ningún suscriptor activo tiene correo registrado' +
          (form.soloConEmpleados ? ', o ninguno tiene empleados cargados (quitá ese filtro y probá de nuevo)' : ''));
      } else if (c.ok === 0) {
        const detalle = (c.errores || []).map(e => e.error).filter(Boolean)[0] || 'sin detalle';
        setMensaje(`⚠️ Publicada, pero NINGÚN correo salió (0 de ${c.total}). Motivo: ${detalle}`);
      } else if (c.fallidos > 0) {
        setMensaje(`✅ Publicada · correo enviado a ${c.ok} de ${c.total} · ${c.fallidos} fallido(s)`);
      } else {
        setMensaje(`✅ Publicada · correo enviado a los ${c.ok} suscriptores`);
      }
      setForm({ tipo: 'nueva_funcion', titulo: '', cuerpo: '', critico: false, enviarCorreo: false, soloConEmpleados: false, accionTexto: '', accionModulo: '' });
      await cargar();
    } catch (e) {
      setMensaje('✖ ' + (e.response?.data?.error || e.message));
    }
    setPublicando(false);
  };

  // ✅ NOVEDADES-PRUEBA-001
  const enviarPrueba = async () => {
    if (!form.titulo.trim() || !form.cuerpo.trim()) {
      setMensaje('✖ Completá el título y el contenido antes de mandar la prueba');
      return;
    }
    setPublicando(true); setMensaje('');
    try {
      const r = await axios.post(`${API}/novedades`, {
        modoPrueba: true,
        tipo: form.tipo, titulo: form.titulo, cuerpo: form.cuerpo,
        accion: form.accionTexto ? { texto: form.accionTexto, modulo: form.accionModulo } : null
      }, { headers: headers() });
      setMensaje('✅ ' + r.data.mensaje);
    } catch (e) {
      setMensaje('✖ ' + (e.response?.data?.error || e.message));
    }
    setPublicando(false);
  };

  const despublicar = async (id) => {
    if (!window.confirm('¿Quitar esta novedad de la vista de los suscriptores?\n\nNo se borra: solo deja de aparecer.')) return;
    try {
      await axios.delete(`${API}/novedades/${id}`, { headers: headers() });
      await cargar();
    } catch (e) { alert(e.response?.data?.error || e.message); }
  };

  const generarCalendario = async (simular) => {
    try {
      const r = await axios.post(`${API}/novedades/calendario/generar`, { simular }, { headers: headers() });
      alert(simular
        ? `Simulación: se publicarían ${r.data.generadas} aviso(s).\n\n` +
          (r.data.creadas || []).map(c => '· ' + (c.titulo || c.id)).join('\n') +
          ((r.data.omitidas || []).length ? `\n\nOmitidos: ${r.data.omitidas.length} (ya publicados)` : '')
        : `✅ ${r.data.generadas} aviso(s) publicado(s).`);
      if (!simular) await cargar();
    } catch (e) { alert(e.response?.data?.error || e.message); }
  };

  const TIPOS_UI = historial.tipos || {};
  const MODULOS = [
    { k: '', l: '— Sin botón —' },
    { k: 'empleados', l: 'Empleados' }, { k: 'vehiculos', l: 'Vehículos' },
    { k: 'egresos', l: 'Egresos' }, { k: 'eri', l: 'ERI' },
    { k: 'caja', l: 'Caja' }, { k: 'productos', l: 'Productos' },
    { k: 'ordenes', l: 'Órdenes' }, { k: 'reportes', l: 'Reportes' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e5e7eb', flexWrap: 'wrap' }}>
        {[
          { k: 'publicar', l: '📢 Publicar novedad' },
          { k: 'historial', l: `📜 Historial (${historial.novedades.length})` },
          { k: 'calendario', l: '📅 Calendario laboral' },
        ].map(t => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            padding: '10px 20px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 13.5, fontWeight: 600, color: tab === t.k ? '#4f46e5' : '#6b7280',
            borderBottom: tab === t.k ? '2px solid #4f46e5' : '2px solid transparent', marginBottom: -2
          }}>{t.l}</button>
        ))}
      </div>

      {/* ─── PUBLICAR ──────────────────────────────────────────────────────── */}
      {tab === 'publicar' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,380px)', gap: 20 }}>
          <div style={S.card}>
            <div style={S.row2}>
              <div style={S.field}>
                <label style={S.label}>Tipo</label>
                <select style={S.select} value={form.tipo} onChange={e => set('tipo', e.target.value)}>
                  {Object.entries(TIPOS_UI).map(([k, v]) => (
                    <option key={k} value={k}>{v.icono} {v.etiqueta}</option>
                  ))}
                </select>
              </div>
              <div style={S.field}>
                <label style={S.label}>Botón de acción (opcional)</label>
                <input style={S.input} value={form.accionTexto} onChange={e => set('accionTexto', e.target.value)}
                  placeholder="Ej: Ver mis provisiones" />
              </div>
            </div>

            {form.accionTexto && (
              <div style={S.field}>
                <label style={S.label}>¿A qué módulo lleva el botón?</label>
                <select style={S.select} value={form.accionModulo} onChange={e => set('accionModulo', e.target.value)}>
                  {MODULOS.map(m => <option key={m.k} value={m.k}>{m.l}</option>)}
                </select>
              </div>
            )}

            <div style={S.field}>
              <label style={S.label}>Título *</label>
              <input style={{ ...S.input, fontSize: 15, fontWeight: 700 }} value={form.titulo}
                onChange={e => set('titulo', e.target.value)}
                placeholder="Nuevo módulo de Empleados y Nómina" />
            </div>

            <div style={S.field}>
              <label style={S.label}>Contenido *</label>
              <textarea style={{ ...S.input, height: 210, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
                value={form.cuerpo} onChange={e => set('cuerpo', e.target.value)}
                placeholder={'Escribí acá el anuncio.\n\nPodés usar **negrita** y viñetas con · o -'} />
              <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 4 }}>
                Formato: <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 }}>**negrita**</code> ·
                viñetas empezando la línea con <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 }}>·</code> o
                <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, marginLeft: 4 }}>-</code>
              </div>
            </div>

            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 11, padding: 14, marginBottom: 14 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginBottom: 12 }}>
                <input type="checkbox" checked={form.critico} onChange={e => set('critico', e.target.checked)}
                  style={{ width: 17, height: 17, cursor: 'pointer', marginTop: 1 }} />
                <span>
                  <strong style={{ fontSize: 12.5, color: '#0f172a' }}>Mostrar como banner</strong>
                  <div style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.5, marginTop: 2 }}>
                    Aparece arriba en el dashboard hasta que la lean. Usalo solo para cambios que
                    alteran cómo se trabaja — si abusás, dejan de mirarlo.
                  </div>
                </span>
              </label>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.enviarCorreo} onChange={e => set('enviarCorreo', e.target.checked)}
                  style={{ width: 17, height: 17, cursor: 'pointer', marginTop: 1 }} />
                <span>
                  <strong style={{ fontSize: 12.5, color: '#0f172a' }}>Enviar también por correo</strong>
                  <div style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.5, marginTop: 2 }}>
                    A los {historial.totalSuscriptores} suscriptores activos, con la plantilla de Control360.
                    <strong style={{ color: '#b45309' }}> No se puede deshacer.</strong>
                  </div>
                </span>
              </label>

              {form.enviarCorreo && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 10, paddingLeft: 27 }}>
                  <input type="checkbox" checked={form.soloConEmpleados} onChange={e => set('soloConEmpleados', e.target.checked)}
                    style={{ width: 15, height: 15, cursor: 'pointer' }} />
                  <span style={{ fontSize: 11.5, color: '#475569' }}>
                    Solo a quienes tengan empleados cargados
                  </span>
                </label>
              )}
            </div>

            {mensaje && (
              <div style={{
                background: mensaje.startsWith('✅') ? '#f0fdf4' : '#fef2f2',
                border: `1px solid ${mensaje.startsWith('✅') ? '#bbf7d0' : '#fecaca'}`,
                borderRadius: 9, padding: '10px 14px', fontSize: 12.5, marginBottom: 12,
                color: mensaje.startsWith('✅') ? '#15803d' : '#991b1b'
              }}>{mensaje}</div>
            )}

            {/* ✅ NOVEDADES-PRUEBA-001: un correo masivo no se deshace. La
                prueba a la propia casilla es la única forma de ver cómo llega
                de verdad antes de que lo reciban todos. */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={publicar} disabled={publicando} style={S.btnPrimary}>
                {publicando ? 'Publicando...' : form.enviarCorreo ? '📢 Publicar y enviar correo' : '📢 Publicar'}
              </button>

              <button onClick={enviarPrueba} disabled={publicando} style={S.btnSecondary}>
                ✉️ Enviarme una prueba
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, lineHeight: 1.55 }}>
              La prueba te llega solo a vos, con <strong>[PRUEBA]</strong> en el asunto.
              No publica nada ni le llega a ningún suscriptor.
            </div>
          </div>

          {/* Vista previa */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#64748b', marginBottom: 9, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Así lo va a ver el suscriptor
            </div>
            {(() => {
              const t = TIPOS_UI[form.tipo] || { etiqueta: 'Novedad', icono: '📌', color: '#64748b' };
              return (
                <div style={{
                  background: `linear-gradient(135deg, ${t.color}0f, ${t.color}06)`,
                  border: `1px solid ${t.color}44`, borderLeft: `4px solid ${t.color}`,
                  borderRadius: 12, padding: '14px 17px'
                }}>
                  <div style={{ fontSize: 9.5, fontWeight: 800, color: t.color, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
                    {t.icono} {t.etiqueta}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', lineHeight: 1.35, marginBottom: 9 }}>
                    {form.titulo || 'Título de la novedad'}
                  </div>
                  {form.cuerpo
                    ? <TextoRico texto={form.cuerpo} size={12.5} />
                    : <div style={{ fontSize: 12.5, color: '#cbd5e1' }}>El contenido aparece acá...</div>}
                  {form.accionTexto && (
                    <button style={{
                      marginTop: 6, padding: '7px 15px', borderRadius: 8, border: 'none',
                      fontSize: 12, fontWeight: 700, color: '#fff',
                      background: `linear-gradient(135deg, ${t.color}, ${t.color}dd)`
                    }}>{form.accionTexto} →</button>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ─── HISTORIAL ─────────────────────────────────────────────────────── */}
      {tab === 'historial' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {historial.novedades.length === 0 ? (
            <div style={{ ...S.card, textAlign: 'center', color: '#cbd5e1', fontSize: 13, padding: 40 }}>
              Todavía no se ha publicado ninguna novedad.
            </div>
          ) : historial.novedades.map(n => {
            const t = TIPOS_UI[n.tipo] || { etiqueta: 'Novedad', icono: '📌', color: '#64748b' };
            return (
              <div key={n.id} style={{
                ...S.card, borderLeft: `4px solid ${t.color}`, padding: '15px 18px',
                opacity: n.publicada === false ? .55 : 1
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 250 }}>
                    <div style={{ fontSize: 9.5, fontWeight: 800, color: t.color, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                      {t.icono} {t.etiqueta}
                      {n.automatica && <span style={{ color: '#94a3b8', marginLeft: 7 }}>· automática</span>}
                      {n.publicada === false && <span style={{ color: '#94a3b8', marginLeft: 7 }}>· despublicada</span>}
                    </div>
                    <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0f172a', marginTop: 4 }}>{n.titulo}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                      {fechaCorta(n.publicadaEn)} · {n.publicadaPor}
                      {n.correoEnviado && ` · 📧 ${n.correosOk} enviado(s)${n.correosFallidos ? `, ${n.correosFallidos} fallido(s)` : ''}`}
                    </div>
                  </div>

                  <div style={{ textAlign: 'right', minWidth: 96 }}>
                    <div style={{
                      fontSize: 21, fontWeight: 900,
                      color: n.alcance >= 60 ? '#16a34a' : n.alcance >= 30 ? '#d97706' : '#dc2626'
                    }}>{n.alcance}%</div>
                    <div style={{ fontSize: 9.5, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase' }}>
                      la leyeron
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      {n.lecturas} de {historial.totalSuscriptores}
                    </div>
                  </div>
                </div>

                {n.publicada !== false && (
                  <button onClick={() => despublicar(n.id)}
                    style={{ ...S.btnSecondary, marginTop: 11, padding: '6px 13px', fontSize: 11.5, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                    Despublicar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── CALENDARIO ────────────────────────────────────────────────────── */}
      {tab === 'calendario' && (
        <div>
          <div style={{ ...S.card, marginBottom: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: '#0f172a', marginBottom: 7 }}>
              📅 Avisos automáticos del calendario laboral
            </div>
            <div style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.65, marginBottom: 14 }}>
              Todos los días a las 8:00 AM el sistema revisa si algún vencimiento laboral entra en
              ventana de aviso y publica la novedad solo. Las <strong>obligaciones legales</strong> además
              salen por correo; los recordatorios suaves se quedan en la campanita, para que el correo
              no pierda valor.
            </div>
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              <button onClick={() => generarCalendario(true)} style={S.btnSecondary}>
                👁 Simular (no publica nada)
              </button>
              <button onClick={() => generarCalendario(false)} style={S.btnPrimary}>
                ▶ Ejecutar ahora
              </button>
            </div>
          </div>

          {calendario?.enVentana?.length > 0 && (
            <div style={{ ...S.card, marginBottom: 16, borderLeft: '4px solid #d97706' }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: '#92400e', marginBottom: 9 }}>
                ⏰ En ventana de aviso hoy
              </div>
              {calendario.enVentana.map(e => (
                <div key={e.id} style={{
                  display: 'flex', justifyContent: 'space-between', fontSize: 12.5,
                  padding: '7px 11px', background: '#fffbeb', borderRadius: 8, marginBottom: 5
                }}>
                  <span style={{ color: '#78350f' }}>{e.critico ? '⚠️ ' : ''}{e.titulo}</span>
                  <strong style={{ color: '#92400e' }}>{e.urgencia}</strong>
                </div>
              ))}
            </div>
          )}

          <div style={S.card}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#0f172a', marginBottom: 12 }}>
              Calendario {calendario?.anio || ''}
            </div>
            {(calendario?.eventos || []).map(e => (
              <div key={e.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 12.5, padding: '9px 12px', borderBottom: '1px solid #f8fafc'
              }}>
                <span style={{ color: '#334155' }}>
                  {e.critico && <span style={{ color: '#dc2626', fontWeight: 800, marginRight: 5 }}>!</span>}
                  {e.titulo}
                  {e.requiere === 'empleados' && (
                    <span style={{ fontSize: 10, color: '#cbd5e1', marginLeft: 7 }}>solo con nómina</span>
                  )}
                </span>
                <strong style={{ color: '#64748b', whiteSpace: 'nowrap', marginLeft: 12 }}>{e.fechaLimite}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  card: { background: '#fff', borderRadius: 14, padding: '18px 22px', border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(15,23,42,0.06)' },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: 700, color: '#374151' },
  input: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  select: { padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, outline: 'none', color: '#1e293b', background: '#fff' },
  btnPrimary: { padding: '11px 22px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 700, cursor: 'pointer' },
  btnSecondary: { padding: '11px 20px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};

export default PanelNovedades;
