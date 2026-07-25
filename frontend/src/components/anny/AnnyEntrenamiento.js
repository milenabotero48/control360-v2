// ============================================================
// Control360 — Anny · Entrenamiento (base de conocimiento)
// Ubicación: frontend/src/components/anny/AnnyEntrenamiento.js
// ============================================================
// FIX ANNY-KB-021: la pestaña deja de ser un formulario y pasa a
// ser un AUDITOR. Cada entrada se evalúa y avisa cuando:
//   · contiene precios (deben salir del catálogo, no de aquí —
//     dos fuentes de verdad garantizan contradicciones al subir
//     tarifas)
//   · mezcla varias intenciones (caso real: "extintor nuevo abc"
//     respondía con precios de recarga; son negocios distintos)
//   · trae formato de folleto (✓, viñetas, TÍTULOS:) que es de
//     donde salían los mensajes larguísimos de WhatsApp
//   · usa palabras clave demasiado cortas, que hacen match con
//     casi cualquier mensaje y se cruzan entre entradas
//
// El backend v22 devuelve los mismos avisos al guardar; aquí se
// calculan también en vivo para que la advertencia aparezca
// mientras se escribe, no después.
// ============================================================

import React, { useState, useEffect, useMemo } from 'react';
import { API, authHeaders, C } from './annyUI';

// ── Palabras que delatan mezcla de intenciones ───────────────
const INTENCIONES = [
  { id: 'venta_nueva', label: 'venta de equipo nuevo', claves: ['nuevo', 'comprar', 'compra', 'adquirir'] },
  { id: 'recarga', label: 'recarga', claves: ['recarga', 'recargar', 'vencido'] },
  { id: 'cambio', label: 'servicio de cambio', claves: ['cambio', 'cambiar'] },
  { id: 'mantenimiento', label: 'mantenimiento', claves: ['mantenimiento', 'revision', 'revisión'] }
];

function auditar(entrada) {
  const avisos = [];
  const texto = String(entrada.respuesta || '');
  const claves = entrada.patrones || [];

  if (/\$\s?\d|\d{4,}\s?(pesos|cop)?/i.test(texto) && /\$|\d{4,}/.test(texto)) {
    avisos.push({
      nivel: 'alto',
      texto: 'Contiene precios. Si suben las tarifas, esta entrada queda desactualizada sin que nadie lo note. Los precios deben salir del catálogo de productos.'
    });
  }

  const detectadas = INTENCIONES.filter(i =>
    claves.some(k => i.claves.some(c => String(k).toLowerCase().includes(c)))
  );
  if (detectadas.length > 1) {
    avisos.push({
      nivel: 'alto',
      texto: `Mezcla ${detectadas.length} intenciones distintas (${detectadas.map(d => d.label).join(', ')}). Son negocios diferentes: van en entradas separadas.`
    });
  }

  if (/[✓✅•·]/.test(texto) || /^\s*[-*]\s/m.test(texto) || /^[A-ZÁÉÍÓÚÑ ]{4,}:/m.test(texto)) {
    avisos.push({
      nivel: 'medio',
      texto: 'Tiene formato de folleto (viñetas o títulos en mayúscula). Anny lo convierte a prosa al enviarlo; mejor escribirlo directo en 2 o 3 líneas.'
    });
  }

  const cortas = claves.filter(k => String(k).trim().length <= 4);
  if (cortas.length > 0) {
    avisos.push({
      nivel: 'medio',
      texto: `Palabras clave muy cortas (${cortas.join(', ')}): hacen match con casi cualquier mensaje y se cruzan con otras entradas. Usa frases completas.`
    });
  }

  if (texto.length > 400) {
    avisos.push({ nivel: 'medio', texto: 'Respuesta muy larga para WhatsApp. Apunta a 2 o 3 líneas.' });
  }

  return avisos;
}

export default function AnnyEntrenamiento() {
  const [respuestas, setRespuestas] = useState({});
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState(null);

  const [form, setForm] = useState({ key: '', patrones: '', respuesta: '', tipo: 'CUSTOM' });

  const cargar = async () => {
    setCargando(true);
    try {
      const r = await fetch(`${API}/anny/respuestas`, { headers: authHeaders() });
      setRespuestas(r.ok ? await r.json() : {});
    } catch (e) { setRespuestas({}); }
    finally { setCargando(false); }
  };

  useEffect(() => { cargar(); }, []);

  const entradas = useMemo(() => (
    Object.entries(respuestas)
      .filter(([, v]) => v && v.respuesta)
      .map(([key, v]) => ({ key, ...v, avisos: auditar(v) }))
      .sort((a, b) => b.avisos.length - a.avisos.length)
  ), [respuestas]);

  const conProblemas = entradas.filter(e => e.avisos.length > 0).length;

  const abrirNueva = () => {
    setForm({ key: '', patrones: '', respuesta: '', tipo: 'CUSTOM' });
    setEditando('__nueva__');
    setMensaje(null);
  };

  const abrirEdicion = (e) => {
    setForm({
      key: e.key,
      patrones: (e.patrones || []).join(', '),
      respuesta: e.respuesta || '',
      tipo: e.tipo || 'CUSTOM'
    });
    setEditando(e.key);
    setMensaje(null);
  };

  const guardar = async () => {
    const key = (form.key || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!key || !form.respuesta.trim()) {
      setMensaje({ tipo: 'error', texto: 'Falta el nombre de la entrada o la respuesta.' });
      return;
    }
    setGuardando(true);
    try {
      const res = await fetch(`${API}/anny/respuestas`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          key,
          patrones: form.patrones.split(',').map(s => s.trim()).filter(Boolean),
          respuesta: form.respuesta,
          tipo: form.tipo
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setMensaje({ tipo: 'error', texto: data.error || 'No se pudo guardar.' });
      } else {
        setMensaje({
          tipo: data.avisos && data.avisos.length ? 'aviso' : 'ok',
          texto: data.avisos && data.avisos.length
            ? `Guardado, pero revisa: ${data.avisos.join(' ')}`
            : 'Entrada guardada.'
        });
        setEditando(null);
        cargar();
      }
    } catch (e) {
      setMensaje({ tipo: 'error', texto: 'Error de conexión.' });
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async (key) => {
    if (!window.confirm(`¿Eliminar la entrada "${key}"? Anny dejará de usar esta respuesta.`)) return;
    try {
      await fetch(`${API}/anny/respuestas/${key}`, { method: 'DELETE', headers: authHeaders() });
      cargar();
    } catch (e) { /* silencioso */ }
  };

  // Vista previa de la auditoría mientras se escribe
  const avisosEnVivo = useMemo(() => auditar({
    respuesta: form.respuesta,
    patrones: form.patrones.split(',').map(s => s.trim()).filter(Boolean)
  }), [form.respuesta, form.patrones]);

  return (
    <div>
      <div style={S.cabecera}>
        <div>
          <p style={S.titulo}>Qué sabe Anny</p>
          <p style={S.subtitulo}>
            {entradas.length} entradas
            {conProblemas > 0 ? ` · ${conProblemas} necesitan revisión` : ' · todas en orden'}
          </p>
        </div>
        <button onClick={abrirNueva} style={S.btnSec}>Nueva entrada</button>
      </div>

      <div style={S.nota}>
        Los precios salen del catálogo de productos, no de aquí. Esta base guarda cómo funciona
        el servicio: domicilio, horarios, medios de pago, garantía y políticas.
      </div>

      {mensaje && (
        <div style={{
          ...S.mensaje,
          background: mensaje.tipo === 'error' ? C.dangerBg : mensaje.tipo === 'aviso' ? C.warnBg : C.okBg,
          color: mensaje.tipo === 'error' ? C.dangerText : mensaje.tipo === 'aviso' ? C.warnText : C.okText
        }}>
          {mensaje.texto}
        </div>
      )}

      {editando && (
        <div style={S.editor}>
          <p style={S.editorTitulo}>
            {editando === '__nueva__' ? 'Nueva entrada' : `Editando: ${editando}`}
          </p>

          <label style={S.label}>Nombre de la entrada</label>
          <input
            value={form.key}
            onChange={e => setForm(f => ({ ...f, key: e.target.value }))}
            placeholder="servicio_de_cambio"
            style={S.input}
            disabled={editando !== '__nueva__'}
          />

          <label style={S.label}>Frases que escribe el cliente (separadas por coma)</label>
          <input
            value={form.patrones}
            onChange={e => setForm(f => ({ ...f, patrones: e.target.value }))}
            placeholder="servicio de cambio, cómo funciona el cambio"
            style={S.input}
          />

          <label style={S.label}>Respuesta de Anny</label>
          <textarea
            value={form.respuesta}
            onChange={e => setForm(f => ({ ...f, respuesta: e.target.value }))}
            placeholder="Vamos hasta donde estés, te dejamos un extintor recargado y nos llevamos el tuyo vencido."
            rows={4}
            style={{ ...S.input, resize: 'vertical', fontFamily: 'inherit' }}
          />
          <p style={S.contador}>{form.respuesta.length} caracteres · ideal menos de 350</p>

          {avisosEnVivo.map((a, i) => (
            <div key={i} style={S.avisoVivo}>{a.texto}</div>
          ))}

          <div style={S.editorAcciones}>
            <button onClick={() => setEditando(null)} style={S.btnSec}>Cancelar</button>
            <button onClick={guardar} disabled={guardando} style={S.btnPrim}>
              {guardando ? 'Guardando…' : 'Guardar entrada'}
            </button>
          </div>
        </div>
      )}

      {cargando && <p style={S.vacio}>Cargando base de conocimiento…</p>}

      {!cargando && entradas.length === 0 && (
        <p style={S.vacio}>Anny todavía no tiene entradas. Crea la primera.</p>
      )}

      {entradas.map(e => (
        <div
          key={e.key}
          style={{
            ...S.tarjeta,
            borderColor: e.avisos.some(a => a.nivel === 'alto') ? C.warn : C.border
          }}
        >
          <div style={S.tarjetaCabecera}>
            <div style={{ minWidth: 0 }}>
              <p style={S.tarjetaTitulo}>{e.key.replace(/_/g, ' ')}</p>
              <p style={S.tarjetaMeta}>
                {(e.patrones || []).length} palabras clave · {(e.respuesta || '').length} caracteres
              </p>
            </div>
            <span style={e.avisos.length ? S.badgeRevisar : S.badgeBien}>
              {e.avisos.length ? 'Revisar' : 'Bien'}
            </span>
          </div>

          <div style={S.claves}>
            {(e.patrones || []).map((p, i) => (
              <span
                key={i}
                style={{
                  ...S.clave,
                  background: String(p).trim().length <= 4 ? C.dangerBg : C.surface1,
                  color: String(p).trim().length <= 4 ? C.dangerText : C.textSec
                }}
              >
                {p}
              </span>
            ))}
          </div>

          {e.avisos.length > 0 && (
            <div style={S.bloqueAvisos}>
              {e.avisos.map((a, i) => (
                <p key={i} style={S.avisoTexto}>{a.texto}</p>
              ))}
            </div>
          )}

          <p style={S.tarjetaRespuesta}>{e.respuesta}</p>

          <div style={S.tarjetaAcciones}>
            <button onClick={() => abrirEdicion(e)} style={S.btnSec}>Editar</button>
            <button onClick={() => eliminar(e.key)} style={S.btnPeligro}>Eliminar</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const S = {
  cabecera: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  titulo: { margin: 0, fontSize: 16, fontWeight: 600, color: C.text },
  subtitulo: { margin: '2px 0 0', fontSize: 12, color: C.textSec },

  nota: {
    background: C.accentBg, color: C.accentText, borderRadius: 10,
    padding: '10px 13px', fontSize: 12, lineHeight: 1.6, marginBottom: 14
  },
  mensaje: { borderRadius: 10, padding: '10px 13px', fontSize: 13, lineHeight: 1.55, marginBottom: 14 },

  editor: {
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12,
    padding: 16, marginBottom: 16
  },
  editorTitulo: { margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: C.text },
  label: { display: 'block', fontSize: 12, color: C.textSec, margin: '10px 0 4px' },
  input: {
    width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '8px 10px',
    border: `1px solid ${C.border}`, borderRadius: 8, outline: 'none', color: C.text
  },
  contador: { margin: '5px 0 0', fontSize: 11, color: C.textMuted },
  avisoVivo: {
    marginTop: 8, background: C.warnBg, color: C.warnText,
    borderRadius: 8, padding: '8px 11px', fontSize: 12, lineHeight: 1.55
  },
  editorAcciones: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 },

  tarjeta: {
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12,
    padding: 15, marginBottom: 10
  },
  tarjetaCabecera: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 9 },
  tarjetaTitulo: { margin: 0, fontSize: 14, fontWeight: 600, color: C.text, textTransform: 'capitalize' },
  tarjetaMeta: { margin: '2px 0 0', fontSize: 12, color: C.textSec },
  badgeBien: {
    fontSize: 12, padding: '3px 10px', borderRadius: 8,
    background: C.okBg, color: C.okText, flexShrink: 0
  },
  badgeRevisar: {
    fontSize: 12, padding: '3px 10px', borderRadius: 8,
    background: C.warnBg, color: C.warnText, flexShrink: 0
  },
  claves: { display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 },
  clave: { fontSize: 12, padding: '3px 9px', borderRadius: 8 },
  bloqueAvisos: { background: C.warnBg, borderRadius: 8, padding: '9px 12px', marginBottom: 10 },
  avisoTexto: { margin: '0 0 4px', fontSize: 12, lineHeight: 1.55, color: C.warnText },
  tarjetaRespuesta: { margin: '0 0 12px', fontSize: 13, lineHeight: 1.6, color: C.textSec, whiteSpace: 'pre-wrap' },
  tarjetaAcciones: { display: 'flex', gap: 8 },

  btnSec: {
    fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: `1px solid ${C.border}`, color: C.textSec
  },
  btnPrim: {
    fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
    background: C.accent, border: `1px solid ${C.accent}`, color: '#fff'
  },
  btnPeligro: {
    fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: `1px solid ${C.border}`, color: C.dangerText
  },

  vacio: { padding: '24px 14px', textAlign: 'center', fontSize: 13, color: C.textMuted }
};
// FIN AnnyEntrenamiento.js
