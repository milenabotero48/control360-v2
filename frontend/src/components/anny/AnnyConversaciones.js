// ============================================================
// Control360 — Anny · Consola de Conversaciones
// Ubicación: frontend/src/components/anny/AnnyConversaciones.js
// ============================================================
// FIX ANNY-UI-002: se reemplaza la lista plana de chats por una
// consola de dos columnas (lista + hilo). Antes había que entrar
// y salir de cada chat para atender un escalado.
// FIX ANNY-ESCALA-017: paginación real contra el backend v22
//   ({ chats, cursor, migrado }) en vez de traer todo de golpe.
// FIX ANNY-HUMANO-012: control de pausa desde el hilo — cuando
//   un asesor entra a atender, puede devolverle el chat a Anny.
// FIX ANNY-JERARQUIA-020: el escalado sin atender domina
//   visualmente; la conversación resuelta se apaga.
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { API, authHeaders, C, fmtHora, fmtEspera } from './annyUI';

export default function AnnyConversaciones({ onContadores }) {
  const [chats, setChats] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [cargandoLista, setCargandoLista] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [filtro, setFiltro] = useState('todos');
  const [busqueda, setBusqueda] = useState('');

  const [seleccion, setSeleccion] = useState(null);
  const [hilo, setHilo] = useState([]);
  const [cargandoHilo, setCargandoHilo] = useState(false);
  const [accionando, setAccionando] = useState(false);
  const [vistaMovil, setVistaMovil] = useState('lista');

  const finHilo = useRef(null);

  // ── Carga de la lista (primera página) ────────────────────
  const cargarChats = useCallback(async (f = filtro) => {
    setCargandoLista(true);
    try {
      const r = await fetch(`${API}/anny/chats?limit=25&filtro=${f}`, { headers: authHeaders() });
      const data = r.ok ? await r.json() : { chats: [] };
      // Compatibilidad: si el backend aún devolviera un array plano
      const lista = Array.isArray(data) ? data : (data.chats || []);
      setChats(lista);
      setCursor(Array.isArray(data) ? null : (data.cursor || null));
      if (onContadores) {
        onContadores({ escalados: lista.filter(c => c.escalado).length });
      }
    } catch (e) {
      setChats([]);
    } finally {
      setCargandoLista(false);
    }
  }, [filtro, onContadores]);

  useEffect(() => { cargarChats(filtro); }, [filtro, cargarChats]);

  // ── Paginación ────────────────────────────────────────────
  const cargarMas = async () => {
    if (!cursor || cargandoMas) return;
    setCargandoMas(true);
    try {
      const r = await fetch(`${API}/anny/chats?limit=25&filtro=${filtro}&desdeMs=${cursor}`, { headers: authHeaders() });
      const data = r.ok ? await r.json() : { chats: [] };
      setChats(prev => [...prev, ...(data.chats || [])]);
      setCursor(data.cursor || null);
    } catch (e) { /* silencioso */ }
    finally { setCargandoMas(false); }
  };

  // ── Hilo de un chat ───────────────────────────────────────
  const abrirChat = async (chat) => {
    setSeleccion(chat);
    setVistaMovil('hilo');
    setCargandoHilo(true);
    setHilo([]);
    try {
      const r = await fetch(`${API}/anny/chats/${chat.telefono}`, { headers: authHeaders() });
      setHilo(r.ok ? await r.json() : []);
    } catch (e) { setHilo([]); }
    finally { setCargandoHilo(false); }
  };

  useEffect(() => {
    if (finHilo.current) finHilo.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [hilo]);

  // ── Acciones sobre el chat ────────────────────────────────
  const cambiarPausa = async (pausar) => {
    if (!seleccion) return;
    setAccionando(true);
    try {
      await fetch(`${API}/anny/chats/${seleccion.telefono}/pausa`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ pausar, minutos: 30 })
      });
      setSeleccion(s => ({ ...s, pausada: pausar }));
    } catch (e) { /* silencioso */ }
    finally { setAccionando(false); }
  };

  const cambiarSilencio = async () => {
    if (!seleccion) return;
    const nuevo = !seleccion.silenciado;
    setAccionando(true);
    try {
      await fetch(`${API}/anny/chats/${seleccion.telefono}/silencio`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ silenciado: nuevo })
      });
      setSeleccion(s => ({ ...s, silenciado: nuevo }));
      setChats(prev => prev.map(c => c.telefono === seleccion.telefono ? { ...c, silenciado: nuevo } : c));
    } catch (e) { /* silencioso */ }
    finally { setAccionando(false); }
  };

  // ── Filtrado en memoria por búsqueda ──────────────────────
  const visibles = chats.filter(c => {
    if (!busqueda.trim()) return true;
    const q = busqueda.toLowerCase();
    return String(c.telefono).includes(q) || String(c.nombreCliente || '').toLowerCase().includes(q);
  });

  // ══════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════
  return (
    <div style={S.consola}>
      {/* ─── Columna izquierda: lista ─── */}
      <div style={{ ...S.columnaLista, ...(vistaMovil === 'hilo' ? S.ocultoMovil : {}) }}>
        <div style={S.filtros}>
          {[
            { id: 'todos', label: 'Todas' },
            { id: 'escalados', label: 'Escalados' }
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFiltro(f.id)}
              style={filtro === f.id ? S.chipActivo : S.chip}
            >
              {f.label}
            </button>
          ))}
          <input
            type="text"
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            placeholder="Buscar"
            style={S.buscador}
          />
        </div>

        <div style={S.listaScroll}>
          {cargandoLista && <p style={S.vacio}>Cargando conversaciones…</p>}

          {!cargandoLista && visibles.length === 0 && (
            <p style={S.vacio}>No hay conversaciones que coincidan.</p>
          )}

          {visibles.map(c => {
            const activo = seleccion && seleccion.telefono === c.telefono;
            const urgente = c.escalado;
            return (
              <button
                key={c.telefono}
                onClick={() => abrirChat(c)}
                style={{
                  ...S.itemChat,
                  background: urgente ? C.dangerBg : (activo ? C.surface1 : 'transparent'),
                  borderLeftColor: urgente ? C.danger : (activo ? C.accent : 'transparent')
                }}
              >
                <div style={S.itemFila}>
                  <span style={{
                    ...S.itemNombre,
                    color: urgente ? C.dangerText : (c.escalado ? C.text : C.textSec),
                    fontWeight: urgente || activo ? 600 : 500
                  }}>
                    {c.nombreCliente || c.telefono}
                  </span>
                  <span style={{ ...S.itemHora, color: urgente ? C.dangerText : C.textMuted }}>
                    {urgente ? fmtEspera(c.ultimaFechaMs) : fmtHora(c.ultimaFechaMs)}
                  </span>
                </div>
                <div style={S.itemFila}>
                  <span style={{
                    ...S.itemTexto,
                    color: urgente ? C.dangerText : C.textMuted
                  }}>
                    {urgente ? 'Escalado · esperando asesor' : (c.ultimoTexto || 'Sin mensajes')}
                  </span>
                  {c.silenciado && <span style={S.pill}>Silenciado</span>}
                </div>
              </button>
            );
          })}

          {cursor && (
            <button onClick={cargarMas} disabled={cargandoMas} style={S.cargarMas}>
              {cargandoMas ? 'Cargando…' : 'Cargar 25 más'}
            </button>
          )}
        </div>
      </div>

      {/* ─── Columna derecha: hilo ─── */}
      <div style={{ ...S.columnaHilo, ...(vistaMovil === 'lista' ? S.ocultoMovil : {}) }}>
        {!seleccion && (
          <div style={S.placeholderHilo}>
            <p style={{ margin: 0, fontSize: 14, color: C.textMuted }}>
              Selecciona una conversación para verla completa.
            </p>
          </div>
        )}

        {seleccion && (
          <>
            <div style={S.hiloHeader}>
              <button onClick={() => setVistaMovil('lista')} style={S.volverMovil}>‹</button>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={S.hiloNombre}>{seleccion.nombreCliente || seleccion.telefono}</p>
                <p style={S.hiloMeta}>
                  {seleccion.telefono}
                  {seleccion.mensajes ? ` · ${seleccion.mensajes} mensajes` : ''}
                  {seleccion.escalado ? ' · escalado' : ''}
                </p>
              </div>
              <div style={S.hiloAcciones}>
                <button onClick={cambiarSilencio} disabled={accionando} style={S.btnSec}>
                  {seleccion.silenciado ? 'Reactivar' : 'Silenciar'}
                </button>
                <button onClick={() => cambiarPausa(false)} disabled={accionando} style={S.btnPrim}>
                  Devolver a Anny
                </button>
              </div>
            </div>

            <div style={S.hiloScroll}>
              {cargandoHilo && <p style={S.vacio}>Cargando mensajes…</p>}

              {!cargandoHilo && hilo.length === 0 && (
                <p style={S.vacio}>Sin mensajes registrados en este chat.</p>
              )}

              {hilo.map((m, i) => (
                <Burbujas key={m.id || i} m={m} />
              ))}
              <div ref={finHilo} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Un registro puede contener el mensaje del cliente y la
// respuesta del agente. Se pintan como dos burbujas distintas
// para que la conversación se lea como una conversación.
// ============================================================
function Burbujas({ m }) {
  const esSistema = m.respondidoPor === 'PAUSA_ADMIN';
  const esEscalado = m.respondidoPor === 'ESCALADO_A_ADMIN';
  const esHumano = m.respondidoPor === 'ADMIN_MANUAL';
  const hora = fmtHora(m.fechaMs || (m.createdAt?.seconds || 0) * 1000);

  const autor = esHumano ? 'Asesor'
    : m.respondidoPor === 'NOTIFICACION_SISTEMA' ? `Anny · ${m.mision || 'notificación'}`
      : 'Anny';

  return (
    <>
      {m.mensajeCliente && (
        <div style={S.burbujaCliente}>
          <p style={S.burbujaTexto}>{m.mensajeCliente}</p>
          <p style={S.burbujaHora}>{hora}</p>
        </div>
      )}

      {esSistema && (
        <div style={S.evento}>
          Anny estaba pausada — el mensaje quedó registrado, sin respuesta automática.
        </div>
      )}

      {esEscalado && (
        <div style={S.eventoAlerta}>
          Caso escalado{m.tipo ? ` · ${m.tipo}` : ''}. Anny se pausó y se avisó al equipo.
        </div>
      )}

      {m.respuestaAgente && (
        <div style={esHumano ? S.burbujaHumano : S.burbujaAnny}>
          <p style={{ ...S.burbujaTexto, color: esHumano ? C.text : C.accentText }}>
            {m.respuestaAgente}
          </p>
          <p style={{ ...S.burbujaHora, color: esHumano ? C.textMuted : C.accentText }}>
            {autor} · {hora}
          </p>
        </div>
      )}
    </>
  );
}

// ============================================================
// Estilos — sin dependencias externas, coherentes con el
// resto de Control360.
// ============================================================
const S = {
  consola: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 320px) minmax(0, 1fr)',
    background: C.surface2,
    border: `1px solid ${C.border}`,
    borderRadius: 14,
    overflow: 'hidden',
    minHeight: 520
  },
  columnaLista: { borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' },
  columnaHilo: { display: 'flex', flexDirection: 'column', minHeight: 520 },
  ocultoMovil: {},

  filtros: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '10px 12px', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap'
  },
  chip: {
    fontSize: 12, padding: '4px 11px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: `1px solid ${C.border}`, color: C.textSec
  },
  chipActivo: {
    fontSize: 12, padding: '4px 11px', borderRadius: 8, cursor: 'pointer',
    background: C.text, border: `1px solid ${C.text}`, color: '#fff'
  },
  buscador: {
    flex: 1, minWidth: 100, fontSize: 12, padding: '5px 9px',
    border: `1px solid ${C.border}`, borderRadius: 8, outline: 'none', color: C.text
  },

  listaScroll: { overflowY: 'auto', maxHeight: 560 },
  itemChat: {
    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
    padding: '11px 13px', border: 'none', borderBottom: `1px solid ${C.border}`,
    borderLeft: '3px solid transparent'
  },
  itemFila: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  itemNombre: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemHora: { fontSize: 11, flexShrink: 0 },
  itemTexto: {
    fontSize: 12, marginTop: 3, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  },
  pill: {
    fontSize: 10, padding: '1px 6px', borderRadius: 6,
    background: C.surface1, color: C.textMuted, flexShrink: 0
  },
  cargarMas: {
    display: 'block', width: '100%', padding: '11px', cursor: 'pointer',
    background: 'transparent', border: 'none', fontSize: 12, color: C.textSec
  },

  placeholderHilo: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24
  },
  hiloHeader: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '11px 14px', borderBottom: `1px solid ${C.border}`
  },
  volverMovil: {
    display: 'none', background: 'transparent', border: 'none',
    fontSize: 22, cursor: 'pointer', color: C.textSec, padding: '0 4px'
  },
  hiloNombre: { margin: 0, fontSize: 14, fontWeight: 600, color: C.text },
  hiloMeta: { margin: '2px 0 0', fontSize: 12, color: C.textSec },
  hiloAcciones: { display: 'flex', gap: 6, flexShrink: 0 },
  btnSec: {
    fontSize: 12, padding: '5px 11px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: `1px solid ${C.border}`, color: C.textSec
  },
  btnPrim: {
    fontSize: 12, padding: '5px 11px', borderRadius: 8, cursor: 'pointer',
    background: C.accentBg, border: `1px solid ${C.accentBg}`, color: C.accentText
  },

  hiloScroll: {
    flex: 1, overflowY: 'auto', maxHeight: 520,
    padding: 14, display: 'flex', flexDirection: 'column', gap: 10
  },
  burbujaCliente: {
    alignSelf: 'flex-start', maxWidth: '78%', background: C.surface1,
    borderRadius: '12px 12px 12px 4px', padding: '9px 12px'
  },
  burbujaAnny: {
    alignSelf: 'flex-end', maxWidth: '78%', background: C.accentBg,
    borderRadius: '12px 12px 4px 12px', padding: '9px 12px'
  },
  burbujaHumano: {
    alignSelf: 'flex-end', maxWidth: '78%', background: C.surface1,
    border: `1px solid ${C.border}`,
    borderRadius: '12px 12px 4px 12px', padding: '9px 12px'
  },
  burbujaTexto: { margin: 0, fontSize: 13, lineHeight: 1.55, color: C.text, whiteSpace: 'pre-wrap' },
  burbujaHora: { margin: '4px 0 0', fontSize: 11, color: C.textMuted },
  evento: {
    alignSelf: 'center', maxWidth: '92%', fontSize: 12, lineHeight: 1.5,
    background: C.surface1, color: C.textSec, borderRadius: 8, padding: '7px 11px'
  },
  eventoAlerta: {
    alignSelf: 'center', maxWidth: '92%', fontSize: 12, lineHeight: 1.5,
    background: C.warnBg, color: C.warnText, borderRadius: 8, padding: '7px 11px'
  },

  vacio: { padding: '24px 14px', textAlign: 'center', fontSize: 13, color: C.textMuted }
};
// FIN AnnyConversaciones.js
