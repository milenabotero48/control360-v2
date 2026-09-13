// ============================================================
// Control360 — Anny · Simulador de conversación (ANNY-V3-SIM)
// Ubicación: frontend/src/components/anny/AnnySimulador.js
// ============================================================
// El suscriptor conversa con SU Anny antes de conectar el número
// (o para revisar cómo responde tras cambiar entrenamiento o
// palabras clave). Usa POST /api/anny/test: pasa por el motor
// real — catálogo, diccionario, base de conocimiento, etapas —
// y muestra en cada turno la etapa, los datos capturados y de
// dónde salió el precio.
//
// El teléfono simulado es ficticio: no toca clientes ni órdenes
// reales, pero SÍ deja registro en chatsAnny (se puede borrar
// reiniciando con otro número).
// ============================================================

import React, { useState, useRef, useEffect } from 'react';
import { API, authHeaders, C } from './annyUI';

const ETAPA_ET = {
  INICIO: 'Inicio', NECESIDAD: 'Entendiendo la necesidad', COTIZACION: 'Cotizado — esperando decisión',
  CIERRE: 'Cerrando — faltan datos', CIERRE_LISTO: 'Cierre listo', CONFIRMADO: 'Pedido confirmado',
  POSTVENTA: 'Postventa', TRAMITE: 'Trámite (misión sin venta)'
};
const SEL_ET = {
  diccionario: 'precio por palabra clave', filtrado: 'catálogo filtrado', ambiguo: 'ambiguo: preguntó antes de cotizar',
  ninguno: 'sin producto en catálogo', no_necesario: 'sin catálogo (ya cotizado)', sin_venta: 'misión sin venta'
};

function nuevoTelefono() { return `5799${String(Date.now()).slice(-8)}`; }

export default function AnnySimulador() {
  const [telefono, setTelefono] = useState(nuevoTelefono);
  const [mision, setMision] = useState('ATENCION');
  const [texto, setTexto] = useState('');
  const [turnos, setTurnos] = useState([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const finRef = useRef(null);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turnos]);

  const enviar = async () => {
    const msg = texto.trim();
    if (!msg || enviando) return;
    setEnviando(true);
    setError('');
    setTurnos(t => [...t, { rol: 'cliente', texto: msg }]);
    setTexto('');
    try {
      const r = await fetch(`${API}/anny/test`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ telefono, mensaje: msg, nombreCliente: 'Cliente simulado', mision })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error del servidor');
      setTurnos(t => [...t, {
        rol: 'anny',
        texto: d.respuesta || (d.tipo === 'PAUSADA_POR_ADMIN' ? '(Anny está pausada en este chat)' : `(sin respuesta — ${d.tipo || d.error || ''})`),
        meta: { tipo: d.tipo, etapa: d.etapa, slots: d.slots, seleccion: d.seleccion, aviso: d.avisoEscalamiento || d.avisoPago || null }
      }]);
    } catch (e) {
      setError(e.message);
    } finally {
      setEnviando(false);
    }
  };

  const reiniciar = () => { setTelefono(nuevoTelefono()); setTurnos([]); setError(''); };
  const ultimo = [...turnos].reverse().find(t => t.rol === 'anny')?.meta;

  return (
    <div style={S.wrap}>
      <div style={S.chat}>
        <div style={S.barra}>
          <span style={{ fontWeight: 700, color: C.text }}>🧪 Simulador</span>
          <select value={mision} onChange={e => setMision(e.target.value)} style={S.select}>
            {['ATENCION', 'COBRANZA', 'CONFIRMACION_VENTA', 'REACTIVACION'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <button onClick={reiniciar} style={S.btnGhost}>Nueva conversación</button>
        </div>
        <div style={S.mensajes}>
          {!turnos.length && (
            <div style={S.vacio}>
              Escribe como lo haría un cliente: <i>"hola cuanto vale recargar el del carro"</i>. Cada respuesta pasa por el motor real de Anny con tu catálogo, tus palabras clave y tu entrenamiento.
            </div>
          )}
          {turnos.map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: t.rol === 'cliente' ? 'flex-end' : 'flex-start' }}>
              <div style={t.rol === 'cliente' ? S.burbujaCliente : S.burbujaAnny}>
                {t.texto}
                {t.meta?.aviso && <div style={S.aviso}>Aviso interno: {t.meta.aviso.split('\n')[0]}</div>}
              </div>
            </div>
          ))}
          {enviando && <div style={{ ...S.burbujaAnny, color: C.textMuted }}>escribiendo…</div>}
          <div ref={finRef} />
        </div>
        {error && <div style={S.error}>{error}</div>}
        <div style={S.entrada}>
          <input
            value={texto}
            onChange={e => setTexto(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && enviar()}
            placeholder="Mensaje del cliente…"
            style={S.input}
            disabled={enviando}
          />
          <button onClick={enviar} disabled={enviando || !texto.trim()} style={S.btn}>Enviar</button>
        </div>
      </div>

      <div style={S.panel}>
        <div style={S.panelTitulo}>Qué ve el motor</div>
        {!ultimo ? (
          <div style={{ color: C.textMuted, fontSize: 12.5 }}>Aquí aparece la etapa, los datos capturados y de dónde salió el precio.</div>
        ) : (
          <>
            <Dato k="Etapa" v={ETAPA_ET[ultimo.etapa] || ultimo.etapa || '—'} />
            <Dato k="Resultado" v={ultimo.tipo} />
            {ultimo.seleccion && <Dato k="Precio" v={`${SEL_ET[ultimo.seleccion.modo] || ultimo.seleccion.modo}${ultimo.seleccion.familia ? ` · ${ultimo.seleccion.familia}` : ''}${ultimo.seleccion.productos ? ` · ${ultimo.seleccion.productos} producto(s)` : ''}`} />}
            <div style={{ ...S.panelTitulo, marginTop: 14 }}>Datos capturados</div>
            {ultimo.slots && Object.keys(ultimo.slots).filter(k => ultimo.slots[k]).length ? (
              Object.entries(ultimo.slots).filter(([, v]) => v).map(([k, v]) => (
                <Dato key={k} k={k} v={Array.isArray(v) ? v.map(i => `${i.cantidad}x ${i.nombre}${i.precio ? ` ($${Number(i.precio).toLocaleString('es-CO')})` : ' (sin precio)'}`).join(', ') : String(v)} />
              ))
            ) : <div style={{ color: C.textMuted, fontSize: 12.5 }}>Ninguno todavía.</div>}
            <div style={{ color: C.textMuted, fontSize: 11.5, marginTop: 14 }}>
              Si el precio salió como "catálogo filtrado" y Anny acertó, vincula esa frase en Palabras clave para que sea determinístico. Si salió "ambiguo", el cliente tiene que aclarar recarga o nuevo antes de la cifra.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Dato({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '4px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ color: C.textSec, minWidth: 90 }}>{k}</span>
      <span style={{ color: C.text, fontWeight: 600, wordBreak: 'break-word' }}>{v}</span>
    </div>
  );
}

const S = {
  wrap: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(240px, 1fr)', gap: 14 },
  chat: { background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, display: 'flex', flexDirection: 'column', minHeight: 460, overflow: 'hidden' },
  barra: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' },
  select: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '5px 8px', fontSize: 12.5, background: '#fff' },
  btnGhost: { marginLeft: 'auto', border: `1px solid ${C.border}`, background: '#fff', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, cursor: 'pointer', color: C.textSec },
  mensajes: { flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', background: C.surface1 },
  vacio: { color: C.textMuted, fontSize: 13, padding: 10, textAlign: 'center' },
  burbujaCliente: { background: '#DCF8C6', color: C.text, padding: '8px 11px', borderRadius: '12px 12px 2px 12px', maxWidth: '78%', fontSize: 13.5, whiteSpace: 'pre-wrap' },
  burbujaAnny: { background: '#fff', color: C.text, padding: '8px 11px', borderRadius: '12px 12px 12px 2px', maxWidth: '78%', fontSize: 13.5, border: `1px solid ${C.border}`, whiteSpace: 'pre-wrap' },
  aviso: { marginTop: 6, fontSize: 11, color: C.warnText, background: C.warnBg, borderRadius: 6, padding: '3px 6px' },
  entrada: { display: 'flex', gap: 8, padding: 10, borderTop: `1px solid ${C.border}` },
  input: { flex: 1, border: `1px solid ${C.border}`, borderRadius: 10, padding: '9px 12px', fontSize: 13.5, outline: 'none' },
  btn: { background: C.accent, color: '#fff', border: 'none', borderRadius: 10, padding: '9px 16px', fontWeight: 700, cursor: 'pointer', fontSize: 13 },
  error: { color: C.dangerText, background: C.dangerBg, fontSize: 12.5, padding: '6px 12px' },
  panel: { background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, alignSelf: 'start' },
  panelTitulo: { fontSize: 12, fontWeight: 700, color: C.accentText, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }
};
// FIN AnnySimulador.js
