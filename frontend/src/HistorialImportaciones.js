// ═══════════════════════════════════════════════════════════════════════════
// ✅ VENC-IMPORT-LOTE-001 (2026-08-08) — Historial de importaciones
// Ubicación: frontend/src/HistorialImportaciones.js
// ───────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE:
//   Importar una base era una acción a ciegas y sin retorno. Si el archivo
//   estaba mal, la suscriptora se enteraba días después —viendo cifras raras—
//   y arreglarlo exigía un script de limpieza corriendo contra producción.
//   Así fue como una cuenta terminó con 7.961 vencimientos para 2.440 clientes.
//
//   Esta pantalla muestra las últimas 5 cargas con lo que realmente entró, y
//   permite deshacer una completa. La reversión es en dos tiempos:
//     1. SIMULACIÓN — dice exactamente qué se borraría, sin tocar nada.
//     2. APLICAR — pide PIN de admin y motivo escrito.
//
//   Y nunca borra registros con gestión comercial encima: si a un cliente ya
//   lo llamaron o le facturaron, ese registro sobrevive a la reversión. Deshacer
//   una carga no puede borrar el trabajo que se hizo después sobre ella.
// ═══════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import ModalPin from './ModalPin';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

const C = {
  tinta: '#1a1a2e', violeta: '#7c3aed', verde: '#10b981',
  rojo: '#dc2626', ambar: '#f59e0b', gris: '#6b7280', borde: '#eceaf3',
};

const S = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(15,10,35,0.62)', zIndex: 3000,
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, overflowY: 'auto',
  },
  modal: {
    background: '#faf9fc', borderRadius: 18, width: '100%', maxWidth: 780,
    boxShadow: '0 24px 70px rgba(15,10,35,0.35)', marginTop: 28, overflow: 'hidden',
  },
  head: {
    background: 'linear-gradient(135deg,#1a1a2e,#3b2a63)', padding: '18px 22px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  },
  h3: { margin: 0, fontSize: 17, fontWeight: 800, color: '#fff' },
  sub: { margin: '4px 0 0', fontSize: 12.5, color: 'rgba(255,255,255,0.78)', lineHeight: 1.5 },
  cerrar: {
    background: 'rgba(255,255,255,0.14)', border: 'none', color: '#fff', width: 32, height: 32,
    borderRadius: 9, cursor: 'pointer', fontSize: 17, lineHeight: 1, flexShrink: 0,
  },
  body: { padding: 18, display: 'flex', flexDirection: 'column', gap: 12 },
  lote: (revertido) => ({
    background: revertido ? '#f4f4f6' : '#fff', borderRadius: 14, padding: '14px 16px',
    border: `1px solid ${C.borde}`, opacity: revertido ? 0.72 : 1,
  }),
  loteHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  archivo: { fontSize: 14, fontWeight: 800, color: C.tinta, margin: 0, wordBreak: 'break-all' },
  meta: { fontSize: 11.5, color: C.gris, margin: '3px 0 0' },
  pills: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 11 },
  pill: (bg, color) => ({
    background: bg, color, fontSize: 11.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
  }),
  btn: (bg, color, borde) => ({
    background: bg, color, border: borde ? `1px solid ${borde}` : 'none', borderRadius: 9,
    padding: '8px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  }),
  caja: (bg, borde, color) => ({
    background: bg, border: `1px solid ${borde}`, borderRadius: 11, padding: '12px 14px',
    fontSize: 12.5, color, lineHeight: 1.6, marginTop: 11,
  }),
};

const fechaBonita = (iso) => {
  if (!iso) return '';
  const [f, h] = String(iso).split('T');
  return `${f} · ${(h || '').slice(0, 5)}`;
};

export default function HistorialImportaciones({ onCerrar, onCambio }) {
  const [lotes, setLotes] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [simulacion, setSimulacion] = useState({});   // { loteId: plan }
  const [ocupado, setOcupado] = useState(null);       // loteId en proceso
  const [pinPara, setPinPara] = useState(null);       // loteId esperando PIN
  const [detalle, setDetalle] = useState(null);       // loteId con errores abiertos

  const cargar = useCallback(async () => {
    setCargando(true); setError(null);
    try {
      const r = await fetch(`${API}/vencimientos/importaciones?limite=5`, { headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo cargar el historial');
      setLotes(await r.json());
    } catch (e) { setError(e.message); }
    finally { setCargando(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Paso 1 — simulación. Nunca se ofrece "borrar" sin haber mostrado antes
  // qué se va a borrar.
  const simular = async (id) => {
    setOcupado(id);
    try {
      const r = await fetch(`${API}/vencimientos/importaciones/${id}/revertir`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ aplicar: false }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'No se pudo simular');
      setSimulacion(s => ({ ...s, [id]: data }));
    } catch (e) { setError(e.message); }
    finally { setOcupado(null); }
  };

  // Paso 2 — aplicar, con PIN + motivo (los pide ModalPin).
  const revertir = async (id, pin, motivo) => {
    setOcupado(id);
    try {
      const r = await fetch(`${API}/vencimientos/importaciones/${id}/revertir`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ aplicar: true, pin, motivo }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'No se pudo revertir');
      setPinPara(null);
      setSimulacion(s => { const n = { ...s }; delete n[id]; return n; });
      await cargar();
      if (onCambio) onCambio();
    } catch (e) { setError(e.message); throw e; }
    finally { setOcupado(null); }
  };

  return (
    <div style={S.overlay} onClick={(e) => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div style={S.modal}>
        <div style={S.head}>
          <div>
            <h3 style={S.h3}>🗂 Historial de importaciones</h3>
            <p style={S.sub}>Las últimas 5 cargas. Puedes deshacer una completa si el archivo estaba mal.</p>
          </div>
          <button onClick={onCerrar} style={S.cerrar} aria-label="Cerrar">✕</button>
        </div>

        <div style={S.body}>
          {cargando && <p style={{ textAlign: 'center', color: C.gris, fontSize: 13 }}>Cargando…</p>}

          {error && (
            <div style={S.caja('#fef2f2', '#fca5a5', '#991b1b')}>⚠️ {error}</div>
          )}

          {!cargando && !lotes.length && (
            <div style={S.caja('#f7f5fd', C.borde, C.gris)}>
              Todavía no hay importaciones registradas. Las cargas que hagas desde ahora quedarán aquí,
              con la opción de deshacerlas.
            </div>
          )}

          {lotes.map(l => {
            const plan = simulacion[l.id];
            const empresas = Object.entries(l.empresas || {});
            const noReconocidas = Object.entries(l.empresasNoReconocidas || {});
            return (
              <div key={l.id} style={S.lote(l.revertido)}>
                <div style={S.loteHead}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={S.archivo}>📄 {l.archivo}</p>
                    <p style={S.meta}>
                      {fechaBonita(l.fecha)} · {l.usuarioNombre || 'sistema'} · {l.totalFilas} filas leídas
                    </p>
                  </div>
                  {l.revertido ? (
                    <span style={S.pill('#e5e7eb', '#4b5563')}>↩ Revertida</span>
                  ) : l.reversible ? (
                    <button
                      onClick={() => (plan ? setPinPara(l.id) : simular(l.id))}
                      disabled={ocupado === l.id}
                      style={S.btn(plan ? C.rojo : '#fff', plan ? '#fff' : C.rojo, plan ? null : '#fca5a5')}
                    >
                      {ocupado === l.id ? 'Procesando…' : plan ? '🔐 Confirmar reversión' : '↩ Deshacer esta carga'}
                    </button>
                  ) : null}
                </div>

                <div style={S.pills}>
                  <span style={S.pill('rgba(16,185,129,0.12)', '#047857')}>
                    {l.vencimientosCreados} vencimientos
                  </span>
                  <span style={S.pill('rgba(124,58,237,0.10)', '#6d28d9')}>
                    {l.clientesNuevos} clientes nuevos
                  </span>
                  <span style={S.pill('rgba(59,130,246,0.10)', '#1d4ed8')}>
                    {l.prospectosCreados} prospectos
                  </span>
                  {l.vencimientosOmitidos > 0 && (
                    <span style={S.pill('#f3f4f6', '#4b5563')}>
                      {l.vencimientosOmitidos} omitidos (ya existían)
                    </span>
                  )}
                  {l.porVerificar > 0 && (
                    <span style={S.pill('rgba(245,158,11,0.14)', '#b45309')}>
                      ☎️ {l.porVerificar} teléfonos por verificar
                    </span>
                  )}
                  {l.totalErrores > 0 && (
                    <button onClick={() => setDetalle(detalle === l.id ? null : l.id)}
                            style={{ ...S.pill('rgba(220,38,38,0.10)', '#b91c1c'), border: 'none', cursor: 'pointer' }}>
                      {l.totalErrores} filas rechazadas ▾
                    </button>
                  )}
                </div>

                {empresas.length > 0 && (
                  <p style={{ ...S.meta, marginTop: 9 }}>
                    Empresas: {empresas.map(([n, c]) => `${n} (${c})`).join(' · ')}
                  </p>
                )}

                {noReconocidas.length > 0 && (
                  <div style={S.caja('#fffbeb', '#fde68a', '#92400e')}>
                    ⚠️ El archivo nombró empresas que no existen en tu cuenta:{' '}
                    <strong>{noReconocidas.map(([n, c]) => `"${n}" (${c} filas)`).join(', ')}</strong>.
                    Esas filas quedaron con la empresa por defecto. Créalas en Configuración de Empresas
                    o corrige el texto en el archivo.
                  </div>
                )}

                {detalle === l.id && (
                  <div style={S.caja('#fef2f2', '#fecaca', '#991b1b')}>
                    <strong>Filas que no entraron:</strong>
                    <ul style={{ margin: '7px 0 0', paddingLeft: 18 }}>
                      {(l.errores || []).slice(0, 12).map((e, i) => (
                        <li key={i}>Fila {e.fila}: {e.error}</li>
                      ))}
                    </ul>
                    {l.totalErrores > 12 && (
                      <p style={{ margin: '7px 0 0' }}>…y {l.totalErrores - 12} más.</p>
                    )}
                  </div>
                )}

                {l.revertido && l.revertidoMotivo && (
                  <p style={{ ...S.meta, marginTop: 9 }}>
                    Revertida el {fechaBonita(l.revertidoEn)} — motivo: “{l.revertidoMotivo}”
                  </p>
                )}

                {/* Resultado de la simulación: lo que se borraría y, sobre todo,
                    lo que NO se borraría y por qué. */}
                {plan && !l.revertido && (
                  <div style={S.caja('#fff7ed', '#fed7aa', '#9a3412')}>
                    <strong>Si confirmas, se borrarían:</strong>
                    <ul style={{ margin: '7px 0 9px', paddingLeft: 18 }}>
                      <li>{plan.vencimientos.borrar} vencimientos</li>
                      <li>{plan.prospectos.borrar} prospectos</li>
                      <li>{plan.clientes.borrar} clientes creados por esta carga</li>
                    </ul>
                    {(plan.vencimientos.conservar + plan.prospectos.conservar + plan.clientes.conservar) > 0 && (
                      <>
                        <strong>Se conservan</strong> {plan.vencimientos.conservar} vencimientos,{' '}
                        {plan.prospectos.conservar} prospectos y {plan.clientes.conservar} clientes:
                        ya tienen gestión comercial encima (llamada registrada, orden asociada o ciclo cerrado).
                        Deshacer una importación nunca borra el trabajo hecho después.
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {pinPara && (
        <ModalPin
          accion="revertir_importacion"
          titulo="Revertir importación completa"
          advertencia="Se borrarán los registros que creó ese archivo y no tienen gestión encima. La acción queda en auditoría y no se puede deshacer."
          requiereMotivo
          minMotivo={10}
          textoBoton="↩ Revertir importación"
          onConfirmar={(pin, motivo) => revertir(pinPara, pin, motivo)}
          onCancelar={() => setPinPara(null)}
        />
      )}
    </div>
  );
}
