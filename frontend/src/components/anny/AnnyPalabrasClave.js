// ============================================================
// Control360 — Anny · Palabras clave
// Ubicación: frontend/src/components/anny/AnnyPalabrasClave.js
// ============================================================
// ✅ ANNY-DICC-049
// El catálogo habla en lenguaje de inventario ("RECARGA ABC 5 LB")
// y el cliente escribe "cuánto vale recargar el del carro". Anny no
// relacionaba las dos cosas y terminaba escalando la venta.
//
// Aquí se enlaza cómo habla el cliente con el producto del catálogo.
// NUNCA se guarda el precio: solo la referencia al producto. El
// precio se lee vivo del catálogo en cada mensaje, así una subida
// de tarifas no obliga a tocar nada de esta pantalla.
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import { API, authHeaders, C } from './annyUI';

export default function AnnyPalabrasClave() {
  const [entradas, setEntradas] = useState([]);
  const [catalogo, setCatalogo] = useState([]);
  const [cargando, setCargando] = useState(true);

  const [productoId, setProductoId] = useState('');
  const [palabras, setPalabras] = useState('');
  const [buscar, setBuscar] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState(null);
  const [avisos, setAvisos] = useState([]);

  const [frase, setFrase] = useState('');
  const [prueba, setPrueba] = useState(null);
  const [probando, setProbando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const r = await fetch(`${API}/anny/diccionario`, { headers: authHeaders() });
      const d = r.ok ? await r.json() : {};
      setEntradas(d.entradas || []);
      setCatalogo(d.catalogo || []);
    } catch (e) {
      setMsg({ ok: false, texto: 'No se pudo cargar el diccionario.' });
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async () => {
    const lista = palabras.split(',').map(p => p.trim()).filter(Boolean);
    if (!productoId) return setMsg({ ok: false, texto: 'Elegí primero el producto del catálogo.' });
    if (!lista.length) return setMsg({ ok: false, texto: 'Escribí al menos una frase.' });

    setGuardando(true);
    setMsg(null);
    setAvisos([]);
    try {
      const r = await fetch(`${API}/anny/diccionario/${productoId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ palabras: lista })
      });
      const d = await r.json();
      if (!r.ok) {
        setAvisos(d.avisos || []);
        return setMsg({ ok: false, texto: d.error || 'No se pudo guardar.' });
      }
      setAvisos(d.avisos || []);
      setMsg({ ok: true, texto: `Listo. Anny reconoce ${d.palabras.length} frase(s) para "${d.nombre}".` });
      setProductoId('');
      setPalabras('');
      setBuscar('');
      await cargar();
    } catch (e) {
      setMsg({ ok: false, texto: 'Error de conexión.' });
    } finally {
      setGuardando(false);
    }
  };

  const quitar = async (id, nombre) => {
    if (!window.confirm(`¿Quitar las frases de "${nombre}"?\n\nAnny volverá a depender de encontrar el producto por su nombre exacto.`)) return;
    try {
      await fetch(`${API}/anny/diccionario/${id}`, { method: 'DELETE', headers: authHeaders() });
      await cargar();
    } catch (e) {
      setMsg({ ok: false, texto: 'No se pudo quitar.' });
    }
  };

  const editar = (e) => {
    setProductoId(e.productoId);
    setPalabras((e.palabras || []).join(', '));
    setBuscar('');
    setMsg(null);
  };

  const probar = async () => {
    if (!frase.trim()) return;
    setProbando(true);
    try {
      const r = await fetch(`${API}/anny/diccionario/probar`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ frase })
      });
      setPrueba(await r.json());
    } catch (e) {
      setPrueba(null);
      setMsg({ ok: false, texto: 'Error de conexión.' });
    } finally {
      setProbando(false);
    }
  };

  if (cargando) return <p style={P.vacio}>Cargando…</p>;

  const filtrado = buscar.trim()
    ? catalogo.filter(p => p.nombre.toLowerCase().includes(buscar.trim().toLowerCase()))
    : catalogo;

  const elegido = catalogo.find(p => p.id === productoId);
  const huerfanas = entradas.filter(e => e.huerfana).length;

  return (
    <div>
      {/* ─── Qué es esto ─── */}
      <div style={P.nota}>
        Tu catálogo dice <strong>RECARGA EXTINTOR ABC 5 LB</strong>. Tu cliente escribe{' '}
        <strong>“cuánto vale recargar el del carro”</strong>. Aquí se enlazan las dos cosas.
        El precio no se escribe nunca en esta pantalla: Anny lo lee del catálogo en cada mensaje.
      </div>

      {msg && (
        <div style={{
          ...P.mensaje,
          background: msg.ok ? C.okBg : C.dangerBg,
          color: msg.ok ? C.okText : C.dangerText
        }}>
          {msg.texto}
        </div>
      )}

      {/* ─── Alta / edición ─── */}
      <div style={P.tarjeta}>
        <h4 style={P.titulo}>
          {elegido ? `Frases para “${elegido.nombre}”` : 'Enlazar frases a un producto'}
        </h4>

        {!elegido && (
          <>
            <label style={P.label}>1 · Buscá el producto en tu catálogo</label>
            <input
              type="text"
              value={buscar}
              onChange={e => setBuscar(e.target.value)}
              placeholder="recarga, extintor, señalización…"
              style={P.input}
            />
            <div style={P.lista}>
              {filtrado.length === 0 ? (
                <p style={P.vacio}>
                  {catalogo.length === 0
                    ? 'Tu catálogo no tiene productos activos con precio. Cargalos en Inventario primero.'
                    : 'Ningún producto coincide.'}
                </p>
              ) : (
                filtrado.slice(0, 60).map(p => (
                  <button key={p.id} onClick={() => setProductoId(p.id)} style={P.item}>
                    <span style={{ color: C.text, textAlign: 'left' }}>{p.nombre}</span>
                    <span style={{ color: C.okText, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      ${Number(p.precio).toLocaleString('es-CO')}
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        )}

        {elegido && (
          <div style={P.elegido}>
            <span>
              {elegido.nombre} — <strong>${Number(elegido.precio).toLocaleString('es-CO')}</strong>
            </span>
            <button
              onClick={() => { setProductoId(''); setPalabras(''); }}
              style={P.linkBtn}
            >
              Cambiar
            </button>
          </div>
        )}

        <label style={P.label}>{elegido ? '2 · ' : ''}Frases con las que el cliente lo pide</label>
        <input
          type="text"
          value={palabras}
          onChange={e => setPalabras(e.target.value)}
          placeholder="del carro, extintor del carro, 5 libras, recargar el del carro"
          style={P.input}
        />
        <p style={P.ayuda}>
          Separadas por coma, mínimo 4 caracteres cada una. Escribilas como las escribe el cliente —
          las tildes y las mayúsculas no importan. Si dos productos comparten una frase, gana la más específica.
        </p>

        {avisos.length > 0 && (
          <div style={P.avisos}>
            {avisos.map((a, i) => <p key={i} style={P.avisoLinea}>{a}</p>)}
          </div>
        )}

        <button onClick={guardar} disabled={guardando} style={P.btnPrim}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </div>

      {/* ─── Banco de pruebas ─── */}
      <div style={P.tarjeta}>
        <h4 style={P.titulo}>Probalo antes de confiar</h4>
        <p style={P.ayuda}>
          Escribí una frase tal como la mandaría un cliente y mirá qué precio resolvería Anny.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <input
            type="text"
            value={frase}
            onChange={e => setFrase(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && probar()}
            placeholder="buenas, cuánto vale recargar el extintor del carro?"
            style={{ ...P.input, flex: '1 1 260px', marginBottom: 0 }}
          />
          <button onClick={probar} disabled={probando} style={P.btnSec}>
            {probando ? 'Probando…' : 'Probar'}
          </button>
        </div>

        {prueba && (
          <div style={{
            ...P.resultado,
            background: prueba.encontrado ? C.okBg : C.warnBg,
            color: prueba.encontrado ? C.okText : C.warnText
          }}>
            {prueba.encontrado ? (
              prueba.resueltos.map((r, i) => (
                <p key={i} style={P.resultadoLinea}>
                  Reconoce <strong>“{r.coincidio}”</strong> → {r.nombre}:{' '}
                  <strong>${Number(r.precio).toLocaleString('es-CO')}</strong>
                </p>
              ))
            ) : (
              <p style={P.resultadoLinea}>
                Ninguna frase coincide. Con este mensaje Anny tiene que encontrar el producto por su
                nombre en el catálogo, y si no lo logra, escala. Agregá esta frase al producto que corresponda.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ─── Lista ─── */}
      <div style={P.encabezadoLista}>
        <h4 style={{ ...P.titulo, margin: 0 }}>Productos con frases ({entradas.length})</h4>
        {huerfanas > 0 && (
          <span style={P.badgeAlerta}>{huerfanas} apuntan a productos inactivos</span>
        )}
      </div>

      {entradas.length === 0 ? (
        <p style={P.vacio}>
          Todavía no hay frases cargadas. Empezá por los productos que más te preguntan.
        </p>
      ) : (
        entradas.map(e => (
          <div
            key={e.productoId}
            style={{
              ...P.tarjeta,
              borderLeft: `3px solid ${e.huerfana ? C.danger : C.accent}`,
              padding: '13px 15px'
            }}
          >
            <div style={P.filaCabecera}>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{e.nombre}</span>
              <span style={{ display: 'flex', gap: 12 }}>
                <button onClick={() => editar(e)} style={P.linkBtn}>Editar</button>
                <button onClick={() => quitar(e.productoId, e.nombre)} style={{ ...P.linkBtn, color: C.dangerText }}>Quitar</button>
              </span>
            </div>

            {e.huerfana && (
              <p style={P.huerfana}>
                Este producto ya no está activo en el catálogo. Anny no puede cotizarlo y va a escalar.
              </p>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {e.palabras.map((p, i) => <span key={i} style={P.chip}>{p}</span>)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── Estilos: mismo lenguaje visual que ModuloAnny ────────────
const P = {
  nota: {
    background: C.accentBg, color: C.accentText, borderRadius: 10,
    padding: '11px 14px', fontSize: 12, lineHeight: 1.6, marginBottom: 12
  },
  mensaje: { borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 12 },
  tarjeta: {
    background: C.surface2, border: `1px solid ${C.border}`,
    borderRadius: 12, padding: 15, marginBottom: 10
  },
  titulo: { margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: C.text },
  label: { display: 'block', fontSize: 12, color: C.textSec, marginBottom: 4 },
  input: {
    width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '8px 10px',
    border: `1px solid ${C.border}`, borderRadius: 8, outline: 'none',
    color: C.text, marginBottom: 10
  },
  ayuda: { margin: '0 0 4px', fontSize: 11, color: C.textMuted, lineHeight: 1.5 },
  lista: {
    maxHeight: 210, overflowY: 'auto', border: `1px solid ${C.border}`,
    borderRadius: 8, marginBottom: 14
  },
  item: {
    width: '100%', display: 'flex', justifyContent: 'space-between', gap: 12,
    padding: '9px 12px', fontSize: 13, background: 'transparent',
    border: 'none', borderBottom: `1px solid ${C.surface1}`, cursor: 'pointer'
  },
  elegido: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 10, flexWrap: 'wrap', background: C.okBg, color: C.okText,
    borderRadius: 8, padding: '9px 12px', fontSize: 13, marginBottom: 14
  },
  avisos: { background: C.warnBg, borderRadius: 8, padding: '9px 12px', margin: '4px 0 10px' },
  avisoLinea: { margin: '0 0 4px', fontSize: 12, color: C.warnText, lineHeight: 1.5 },
  btnPrim: {
    fontSize: 12, padding: '8px 15px', borderRadius: 8, cursor: 'pointer',
    background: C.accent, border: `1px solid ${C.accent}`, color: '#fff', marginTop: 6
  },
  btnSec: {
    fontSize: 12, padding: '8px 15px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: `1px solid ${C.border}`, color: C.textSec
  },
  linkBtn: {
    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
    fontSize: 12, color: C.accentText
  },
  resultado: { borderRadius: 8, padding: '10px 12px', marginTop: 12 },
  resultadoLinea: { margin: '0 0 4px', fontSize: 13, lineHeight: 1.6 },
  encabezadoLista: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 10, flexWrap: 'wrap', margin: '18px 0 10px'
  },
  badgeAlerta: {
    fontSize: 11, padding: '3px 9px', borderRadius: 8,
    background: C.dangerBg, color: C.dangerText
  },
  filaCabecera: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 10, flexWrap: 'wrap', marginBottom: 8
  },
  huerfana: { margin: '0 0 8px', fontSize: 11, color: C.dangerText },
  chip: {
    fontSize: 11, padding: '3px 9px', borderRadius: 8,
    background: C.accentBg, color: C.accentText
  },
  vacio: { padding: '24px 14px', textAlign: 'center', fontSize: 13, color: C.textMuted }
};
// FIN AnnyPalabrasClave.js
