// ============================================================
// Control360 — Anny · Palabras clave y avisos internos
// Ubicación: frontend/src/AnnyDiccionario.js
// ============================================================
// ✅ ANNY-DICC-049 — Diccionario de palabras clave
//   El catálogo habla en lenguaje de inventario ("RECARGA ABC 5 LB")
//   y el cliente escribe "cuánto vale recargar el del carro". Este
//   panel construye el puente entre los dos. NUNCA guarda el precio:
//   solo la referencia al producto. El precio se lee vivo del
//   catálogo, así una subida de tarifas no obliga a tocar nada aquí.
//
// ✅ ANNY-GRUPO-051 — Grupo de avisos internos
//   Escalados y comprobantes de pago van a un grupo de WhatsApp en
//   vez de a un solo celular.
//
// Componente aislado a propósito: no toca VencimientosAnny.js más
// allá de montarse como una pestaña.
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

const card = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 20,
  marginBottom: 20,
};

const label = {
  display: 'block',
  fontSize: 11,
  fontWeight: 800,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  marginBottom: 6,
};

const input = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  fontSize: 13,
  boxSizing: 'border-box',
};

const btnPrimario = {
  padding: '10px 16px',
  border: 'none',
  borderRadius: 8,
  background: '#7c3aed',
  color: '#fff',
  fontWeight: 700,
  fontSize: 12,
  cursor: 'pointer',
};

const chip = {
  fontSize: 11,
  fontWeight: 700,
  padding: '3px 10px',
  borderRadius: 999,
  background: '#ede9fe',
  color: '#6d28d9',
};

export default function AnnyDiccionario() {
  const [entradas, setEntradas] = useState([]);
  const [catalogo, setCatalogo] = useState([]);
  const [cargando, setCargando] = useState(true);

  const [productoId, setProductoId] = useState('');
  const [palabras, setPalabras] = useState('');
  const [buscarProd, setBuscarProd] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [avisos, setAvisos] = useState([]);

  const [frase, setFrase] = useState('');
  const [prueba, setPrueba] = useState(null);
  const [probando, setProbando] = useState(false);

  const [grupos, setGrupos] = useState([]);
  const [grupoSel, setGrupoSel] = useState('');
  const [cargandoGrupos, setCargandoGrupos] = useState(false);
  const [guardandoGrupo, setGuardandoGrupo] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [rDicc, rCfg] = await Promise.all([
        fetch(`${API}/anny/diccionario`, { headers: authHeaders() }),
        fetch(`${API}/anny/config`, { headers: authHeaders() }),
      ]);
      const dicc = await rDicc.json();
      const cfg = await rCfg.json();
      setEntradas(dicc.entradas || []);
      setCatalogo(dicc.catalogo || []);
      setGrupoSel(cfg.notificarGrupoJid || '');
    } catch (err) {
      console.error('Error cargando diccionario:', err);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async () => {
    if (!productoId) return alert('Elegí a qué producto del catálogo apuntan estas palabras');
    const lista = palabras.split(',').map(p => p.trim()).filter(Boolean);
    if (!lista.length) return alert('Escribí al menos una palabra clave');

    setGuardando(true);
    setAvisos([]);
    try {
      const r = await fetch(`${API}/anny/diccionario/${productoId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ palabras: lista }),
      });
      const data = await r.json();
      if (!r.ok) return alert(data.error || 'No se pudo guardar');
      setAvisos(data.avisos || []);
      setProductoId('');
      setPalabras('');
      setBuscarProd('');
      await cargar();
    } catch (err) {
      alert('Error de conexión: ' + err.message);
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async (id, nombre) => {
    if (!window.confirm(`¿Quitar las palabras clave de "${nombre}"?\n\nAnny dejará de reconocer esas frases y volverá a depender de encontrar el producto por su nombre exacto.`)) return;
    try {
      await fetch(`${API}/anny/diccionario/${id}`, { method: 'DELETE', headers: authHeaders() });
      await cargar();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const editar = (e) => {
    setProductoId(e.productoId);
    setPalabras((e.palabras || []).join(', '));
    setBuscarProd('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const probar = async () => {
    if (!frase.trim()) return;
    setProbando(true);
    try {
      const r = await fetch(`${API}/anny/diccionario/probar`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ frase }),
      });
      setPrueba(await r.json());
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setProbando(false);
    }
  };

  const cargarGrupos = async () => {
    setCargandoGrupos(true);
    try {
      const r = await fetch(`${API}/anny/grupos`, { headers: authHeaders() });
      const data = await r.json();
      setGrupos(data.grupos || []);
      if (!(data.grupos || []).length) {
        alert('No se encontraron grupos.\n\nRevisá que Anny esté conectada y que el número esté dentro del grupo.');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setCargandoGrupos(false);
    }
  };

  const guardarGrupo = async () => {
    setGuardandoGrupo(true);
    try {
      const r = await fetch(`${API}/anny/config`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ notificarGrupoJid: grupoSel }),
      });
      if (!r.ok) {
        const d = await r.json();
        return alert(d.error || 'No se pudo guardar');
      }
      alert(grupoSel
        ? '✅ Listo. Los escalados y los comprobantes de pago llegan a ese grupo.'
        : '✅ Grupo desactivado. Los avisos vuelven al número del asesor.');
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setGuardandoGrupo(false);
    }
  };

  const catalogoFiltrado = buscarProd.trim()
    ? catalogo.filter(p => p.nombre.toLowerCase().includes(buscarProd.trim().toLowerCase()))
    : catalogo;

  const prodElegido = catalogo.find(p => p.id === productoId);
  const huerfanas = entradas.filter(e => e.huerfana).length;

  if (cargando) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Cargando…</div>;
  }

  return (
    <div>
      {/* ── Explicación ─────────────────────────────────── */}
      <div style={{ ...card, background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
        <div style={{ fontSize: 13, color: '#4c1d95', lineHeight: 1.6 }}>
          <strong>Por qué existe esta pestaña.</strong> Tu catálogo dice{' '}
          <em>"RECARGA EXTINTOR ABC 5 LB"</em>. Tu cliente escribe{' '}
          <em>"cuánto vale recargar el del carro"</em>. Anny no relacionaba las dos cosas y terminaba
          escalando una venta que ya tenía ganada.
          <br /><br />
          Acá enlazás <strong>cómo habla el cliente</strong> con <strong>el producto del catálogo</strong>.
          El precio no se escribe nunca aquí: Anny lo lee del catálogo en cada mensaje. Si mañana subís
          la recarga en Inventario, Anny cotiza el valor nuevo sin que toques nada.
        </div>
      </div>

      {/* ── Grupo de avisos ─────────────────────────────── */}
      <div style={card}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', marginTop: 0, marginBottom: 6 }}>
          📢 Grupo de avisos internos
        </h3>
        <p style={{ fontSize: 12, color: '#6b7280', marginTop: 0, marginBottom: 14, lineHeight: 1.5 }}>
          Los casos escalados y los comprobantes de pago llegan a este grupo. Un aviso que ven varias
          personas se atiende; uno que llega a un solo celular se pierde cuando esa persona está manejando.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 280px' }}>
            <label style={label}>Grupo</label>
            <select
              value={grupoSel}
              onChange={e => setGrupoSel(e.target.value)}
              style={input}
            >
              <option value="">— Sin grupo (avisar al número del asesor) —</option>
              {grupoSel && !grupos.some(g => g.jid === grupoSel) && (
                <option value={grupoSel}>Grupo configurado actualmente</option>
              )}
              {grupos.map(g => (
                <option key={g.jid} value={g.jid}>
                  {g.nombre} ({g.participantes} participantes)
                </option>
              ))}
            </select>
          </div>
          <button onClick={cargarGrupos} disabled={cargandoGrupos}
            style={{ ...btnPrimario, background: '#fff', color: '#7c3aed', border: '1px solid #ddd6fe' }}>
            {cargandoGrupos ? 'Buscando…' : '🔄 Buscar mis grupos'}
          </button>
          <button onClick={guardarGrupo} disabled={guardandoGrupo} style={btnPrimario}>
            {guardandoGrupo ? 'Guardando…' : '✓ Guardar'}
          </button>
        </div>
      </div>

      {/* ── Alta / edición ──────────────────────────────── */}
      <div style={card}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', marginTop: 0, marginBottom: 14 }}>
          🔑 {prodElegido ? `Palabras clave de "${prodElegido.nombre}"` : 'Enlazar palabras clave a un producto'}
        </h3>

        {!prodElegido && (
          <>
            <label style={label}>1 · Buscá el producto en tu catálogo</label>
            <input
              type="text"
              value={buscarProd}
              onChange={e => setBuscarProd(e.target.value)}
              placeholder="ej: recarga, extintor, señalización…"
              style={{ ...input, marginBottom: 10 }}
            />
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 16 }}>
              {catalogoFiltrado.length === 0 ? (
                <div style={{ padding: 16, fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                  {catalogo.length === 0
                    ? 'Tu catálogo no tiene productos activos con precio. Cargalos en Inventario primero.'
                    : 'Ningún producto coincide con esa búsqueda.'}
                </div>
              ) : (
                catalogoFiltrado.slice(0, 60).map(p => (
                  <div
                    key={p.id}
                    onClick={() => setProductoId(p.id)}
                    style={{
                      padding: '10px 12px',
                      borderBottom: '1px solid #f3f4f6',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: '#1a1a2e' }}>{p.nombre}</span>
                    <span style={{ color: '#059669', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      ${Number(p.precio).toLocaleString('es-CO')}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {prodElegido && (
          <div style={{
            background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8,
            padding: '10px 12px', marginBottom: 16, display: 'flex',
            justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap'
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#065f46' }}>
              {prodElegido.nombre} — ${Number(prodElegido.precio).toLocaleString('es-CO')}
            </span>
            <button
              onClick={() => { setProductoId(''); setPalabras(''); }}
              style={{ border: 'none', background: 'transparent', color: '#047857', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              Cambiar producto
            </button>
          </div>
        )}

        <label style={label}>
          {prodElegido ? '2 · ' : ''}Frases con las que el cliente lo pide (separadas por coma)
        </label>
        <input
          type="text"
          value={palabras}
          onChange={e => setPalabras(e.target.value)}
          placeholder="ej: del carro, extintor del carro, 5 libras, recargar el del carro"
          style={{ ...input, marginBottom: 6 }}
        />
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 14, lineHeight: 1.5 }}>
          Mínimo 4 caracteres cada una. Escribilas como las escribe el cliente, sin tildes ni mayúsculas —
          Anny las compara igual. Si dos productos comparten una frase, gana la más específica.
        </div>

        {avisos.length > 0 && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, marginBottom: 14 }}>
            {avisos.map((a, i) => (
              <div key={i} style={{ fontSize: 12, color: '#92400e', marginBottom: i < avisos.length - 1 ? 6 : 0 }}>⚠️ {a}</div>
            ))}
          </div>
        )}

        <button onClick={guardar} disabled={guardando} style={{ ...btnPrimario, width: '100%', padding: '12px 0', fontSize: 13, opacity: guardando ? 0.6 : 1 }}>
          {guardando ? 'Guardando…' : '✓ Guardar — Anny las usa en el próximo mensaje'}
        </button>
      </div>

      {/* ── Banco de pruebas ────────────────────────────── */}
      <div style={card}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', marginTop: 0, marginBottom: 6 }}>
          🧪 Probalo antes de confiar
        </h3>
        <p style={{ fontSize: 12, color: '#6b7280', marginTop: 0, marginBottom: 12 }}>
          Escribí una frase tal como la mandaría un cliente y mirá qué precio resolvería Anny.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={frase}
            onChange={e => setFrase(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && probar()}
            placeholder="ej: buenas, cuanto vale recargar el extintor del carro?"
            style={{ ...input, flex: '1 1 280px' }}
          />
          <button onClick={probar} disabled={probando} style={btnPrimario}>
            {probando ? 'Probando…' : 'Probar'}
          </button>
        </div>

        {prueba && (
          <div style={{
            marginTop: 14, padding: 14, borderRadius: 8,
            background: prueba.encontrado ? '#ecfdf5' : '#fef2f2',
            border: `1px solid ${prueba.encontrado ? '#a7f3d0' : '#fecaca'}`,
          }}>
            {prueba.encontrado ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#065f46', marginBottom: 8 }}>
                  ✅ Anny responde con este precio
                </div>
                {prueba.resueltos.map((r, i) => (
                  <div key={i} style={{ fontSize: 13, color: '#065f46', marginBottom: 4 }}>
                    reconoció <strong>"{r.coincidio}"</strong> → {r.nombre}:{' '}
                    <strong>${Number(r.precio).toLocaleString('es-CO')}</strong>
                  </div>
                ))}
              </>
            ) : (
              <div style={{ fontSize: 13, color: '#991b1b', lineHeight: 1.5 }}>
                ❌ Ninguna palabra clave coincide. Con esta frase Anny tendría que buscar el producto
                por su nombre en el catálogo, y si no lo encuentra, escala.
                <br />
                <strong>Agregá esa frase</strong> al producto que corresponda.
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Lista ───────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e', margin: 0 }}>
          Productos con palabras clave ({entradas.length})
        </h3>
        {huerfanas > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999, background: '#fef2f2', color: '#991b1b' }}>
            {huerfanas} apuntan a productos inactivos
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {entradas.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: 30, fontSize: 13 }}>
            Todavía no hay palabras clave. Empezá por los 10 productos que más te preguntan.
          </div>
        ) : (
          entradas.map(e => (
            <div
              key={e.productoId}
              style={{
                background: '#f9fafb',
                border: '1px solid #e5e7eb',
                borderRadius: 10,
                padding: 14,
                borderLeft: `4px solid ${e.huerfana ? '#ef4444' : '#7c3aed'}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#1a1a2e' }}>{e.nombre}</span>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => editar(e)} style={{ border: 'none', background: 'transparent', color: '#7c3aed', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Editar</button>
                  <button onClick={() => eliminar(e.productoId, e.nombre)} style={{ border: 'none', background: 'transparent', color: '#ef4444', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Quitar</button>
                </div>
              </div>

              {e.huerfana && (
                <div style={{ fontSize: 11, color: '#991b1b', marginBottom: 8 }}>
                  ⚠️ Este producto ya no está activo en el catálogo. Anny no puede cotizarlo y va a escalar.
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {e.palabras.map((p, i) => <span key={i} style={chip}>{p}</span>)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
