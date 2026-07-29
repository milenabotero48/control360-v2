// ============================================================
// Control360 — Módulo Anny (contenedor)
// Ubicación: frontend/src/components/anny/ModuloAnny.js
// ============================================================
// Reemplaza a VencimientosAnny.js (1.179 líneas, monolito).
// El nombre anterior no describía lo que hacía: este panel es la
// consola completa de Anny, no solo vencimientos.
//
// FIX ANNY-GATE-002: respeta el gate del módulo anny_ia
// FIX ANNY-QR-001: conexión WhatsApp por QR (Baileys)
// FIX ANNY-KPI-022: los indicadores llevan su consecuencia al
//   lado. "1 escalado" no mueve a nadie; "1 escalado · 8 min
//   esperando" sí. "3 pedidos" tampoco; "3 pedidos · $412.000
//   en juego" sí.
// FIX ANNY-BORRADOR-015: la bandeja de pedidos muestra qué falta
//   antes de poder facturar y permite completarlo ahí mismo.
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import { API, authHeaders, C, fmtEspera, fmtMoneda, sumarPedidos } from './annyUI';
// FIX ANNY-ESTADO-025: getEstado del backend devuelve
//   { estado: 'conectado'|'desconectado'|'reconectando', numero }
//   NO devuelve un booleano `conectado`. Leer estado.conectado daba
//   undefined y el panel mostraba "Desconectado" con la sesión activa;
//   además el QR nunca se ocultaba tras vincular. Se centraliza la
//   lectura en un solo helper para no repetir el error.
import AnnyConversaciones from './AnnyConversaciones';
import AnnyEntrenamiento from './AnnyEntrenamiento';

// FIX ANNY-ESTADO-025: única fuente de verdad de la conexión.
const estaConectado = (e) => String(e?.estado || '').toLowerCase() === 'conectado';

// ✅ ANNY-PREFILL-021: `onNavegar` ya venía desde GestionVencimientos, pero el
// componente no lo declaraba y se perdía. Se usa para saltar a Órdenes.
export default function ModuloAnny({ onNavegar }) {
  const [activo, setActivo] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [consumo, setConsumo] = useState(null); // ✅ ANNY-CONSUMO-026
  const [tab, setTab] = useState('conversaciones');

  const [estado, setEstado] = useState(null);
  const [metricas, setMetricas] = useState(null);
  const [casos, setCasos] = useState([]);
  const [pedidos, setPedidos] = useState([]);

  const [qr, setQr] = useState(null);
  const [conectando, setConectando] = useState(false);

  // ── Gate del módulo ───────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/anny/config`, { headers: authHeaders() });
        const cfg = r.ok ? await r.json() : { activo: false };
        setActivo(cfg.activo !== false);
      } catch (e) {
        setActivo(false);
      } finally {
        setCargando(false);
      }
    })();
  }, []);

  // ── Carga de datos del encabezado ─────────────────────────
  const cargarResumen = useCallback(async () => {
    try {
      const [m, c, p, e, cons] = await Promise.all([
        fetch(`${API}/anny/metricas`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null),
        fetch(`${API}/anny/casos-escalados?estado=pendiente`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
        fetch(`${API}/anny/pedidos?estado=todos`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
        fetch(`${API}/anny/estado`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null),
        // ✅ ANNY-CONSUMO-026
        fetch(`${API}/anny/consumo`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null)
      ]);
      setMetricas(m);
      setCasos(Array.isArray(c) ? c : []);
      setPedidos(Array.isArray(p) ? p : []);
      setEstado(e);
      setConsumo(cons); // ✅ ANNY-CONSUMO-026
    } catch (err) { /* silencioso */ }
  }, []);

  useEffect(() => { if (activo) cargarResumen(); }, [activo, cargarResumen]);

  // ── Conexión WhatsApp ─────────────────────────────────────
  const conectar = async () => {
    setConectando(true);
    setQr(null);
    try {
      await fetch(`${API}/anny/conectar`, { method: 'POST', headers: authHeaders() });
      let intentos = 0;
      const timer = setInterval(async () => {
        intentos += 1;
        try {
          const r = await fetch(`${API}/anny/qr`, { headers: authHeaders() });
          const d = r.ok ? await r.json() : {};
          if (d.qr) setQr(d.qr);

          const est = await fetch(`${API}/anny/estado`, { headers: authHeaders() }).then(x => x.ok ? x.json() : null);
          if (estaConectado(est)) {
            setEstado(est);
            setQr(null);
            clearInterval(timer);
            setConectando(false);
          }
        } catch (e) { /* reintenta */ }

        if (intentos > 40) { clearInterval(timer); setConectando(false); }
      }, 3000);
    } catch (e) {
      setConectando(false);
    }
  };

  const desconectar = async () => {
    if (!window.confirm('¿Desconectar WhatsApp? Anny dejará de responder.')) return;
    try {
      await fetch(`${API}/anny/desconectar`, { method: 'POST', headers: authHeaders() });
      setEstado(null);
    } catch (e) { /* silencioso */ }
  };

  // ── Derivados para los KPI ────────────────────────────────
  const casoMasViejo = casos.reduce((min, c) => {
    const ts = (c.createdAt?.seconds || 0) * 1000;
    return ts && (!min || ts < min) ? ts : min;
  }, null);

  const pedidosPendientes = pedidos.filter(p => ['NUEVO', 'BORRADOR', 'EN_REVISION'].includes(p.estado));
  const valorEnJuego = sumarPedidos(pedidosPendientes);

  const totalAtendidas = metricas
    ? (metricas.respuestas_automaticas || 0) + (metricas.respuestas_ia || 0)
    : 0;
  const totalHoy = totalAtendidas + (metricas?.casos_escalados || 0);
  const pctSinHumano = totalHoy > 0 ? Math.round((totalAtendidas / totalHoy) * 100) : 0;

  // ══════════════════════════════════════════════════════════
  if (cargando) return <p style={S.vacio}>Cargando módulo…</p>;

  if (activo === false) {
    return (
      <div style={S.bloqueado}>
        <p style={S.bloqueadoTitulo}>WhatsApp IA Anny no está activo</p>
        <p style={S.bloqueadoTexto}>
          Este módulo es premium. Contacta al equipo de Control360 para activarlo en tu cuenta.
        </p>
      </div>
    );
  }

  return (
    <div style={S.contenedor}>
      {/* ─── Encabezado ─── */}
      <div style={S.header}>
        <div style={S.headerIzq}>
          <div style={S.avatar}>A</div>
          <div>
            <p style={S.nombre}>Anny</p>
            <p style={S.conexion}>
              <span style={{ ...S.punto, background: estaConectado(estado) ? C.ok : (estado?.estado === 'reconectando' ? C.warn : C.textMuted) }} />
              {estaConectado(estado)
                ? `Conectado${estado.numero ? ` · ${estado.numero}` : ''}`
                : (estado?.estado === 'reconectando' ? 'Reconectando…' : 'Desconectado')}
            </p>
          </div>
        </div>

        <div style={S.headerDer}>
          {casos.length > 0 && (
            <span style={S.badgeUrgente}>
              {casos.length} sin atender
            </span>
          )}
          {estaConectado(estado)
            ? <button onClick={desconectar} style={S.btnSec}>Desconectar</button>
            : <button onClick={conectar} disabled={conectando} style={S.btnPrim}>
                {conectando ? 'Generando QR…' : 'Conectar WhatsApp'}
              </button>}
        </div>
      </div>

      {qr && (
        <div style={S.qrCaja}>
          <img src={qr} alt="Código QR para vincular WhatsApp" style={{ width: 220, height: 220 }} />
          <p style={S.qrTexto}>
            Abre WhatsApp en el celular de Anny → Dispositivos vinculados → Vincular dispositivo.
          </p>
        </div>
      )}

      {/* ─── KPI con contexto ─── */}
      <div style={S.kpis}>
        <div style={{ ...S.kpi, background: casos.length ? C.dangerBg : C.surface1 }}>
          <p style={{ ...S.kpiLabel, color: casos.length ? C.dangerText : C.textSec }}>
            Escalados sin atender
          </p>
          <p style={{ ...S.kpiValor, color: casos.length ? C.dangerText : C.text }}>
            {casos.length}
          </p>
          <p style={{ ...S.kpiPie, color: casos.length ? C.dangerText : C.textSec }}>
            {casos.length && casoMasViejo ? `${fmtEspera(casoMasViejo)} esperando` : 'Todo al día'}
          </p>
        </div>

        <div style={S.kpi}>
          <p style={S.kpiLabel}>Pedidos por validar</p>
          <p style={S.kpiValor}>{pedidosPendientes.length}</p>
          <p style={S.kpiPie}>
            {valorEnJuego > 0 ? `${fmtMoneda(valorEnJuego)} en juego` : 'Sin pedidos pendientes'}
          </p>
        </div>

        <div style={S.kpi}>
          <p style={S.kpiLabel}>Resueltas sin humano</p>
          <p style={S.kpiValor}>{pctSinHumano}%</p>
          <p style={S.kpiPie}>{totalHoy} conversaciones hoy</p>
        </div>

        {/* ✅ ANNY-CONSUMO-026: lo que va consumiendo este suscriptor en el
            mes. Es la cifra con la que se le factura el módulo. */}
        <div style={S.kpi}>
          <p style={S.kpiLabel}>Mensajes del mes</p>
          <p style={S.kpiValor}>{consumo ? consumo.mensajes.toLocaleString('es-CO') : '—'}</p>
          <p style={S.kpiPie}>
            {consumo
              ? `${consumo.imagenes} fotos · ${consumo.audios} audios${consumo.costoUSD ? ` · US$${consumo.costoUSD.toFixed(2)}` : ''}`
              : 'Cargando…'}
          </p>
        </div>
      </div>

      {/* Aviso de tope: el freno avisa ANTES de que el cliente note que
          Anny dejó de analizar fotos. */}
      {consumo?.limites?.imagenesMes > 0 && consumo.imagenes >= consumo.limites.imagenesMes * 0.8 && (
        <div style={{
          background: consumo.imagenes >= consumo.limites.imagenesMes ? '#fee2e2' : '#fef3c7',
          color: consumo.imagenes >= consumo.limites.imagenesMes ? '#b91c1c' : '#92400e',
          borderRadius: 9, padding: '9px 12px', fontSize: 12.5, fontWeight: 700, marginBottom: 12,
        }}>
          {consumo.imagenes >= consumo.limites.imagenesMes
            ? `⛔ Tope de fotos del mes alcanzado (${consumo.imagenes}/${consumo.limites.imagenesMes}). Las fotos nuevas se escalan a un asesor.`
            : `⚠️ Vas en ${consumo.imagenes} de ${consumo.limites.imagenesMes} fotos del mes.`}
        </div>
      )}

      {/* ─── Pestañas ─── */}
      <div style={S.tabs}>
        {[
          { id: 'conversaciones', label: 'Conversaciones' },
          { id: 'pedidos', label: `Pedidos${pedidosPendientes.length ? ` (${pedidosPendientes.length})` : ''}` },
          { id: 'casos', label: `Escalados${casos.length ? ` (${casos.length})` : ''}` },
          { id: 'entrenamiento', label: 'Entrenamiento' },
          { id: 'config', label: 'Configuración' }
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={tab === t.id ? S.tabActiva : S.tab}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── Contenido ─── */}
      {tab === 'conversaciones' && <AnnyConversaciones />}
      {tab === 'entrenamiento' && <AnnyEntrenamiento />}
      {tab === 'pedidos' && <Pedidos pedidos={pedidos} onCambio={cargarResumen} onNavegar={onNavegar} />}
      {tab === 'casos' && <Casos casos={casos} onCambio={cargarResumen} />}
      {tab === 'config' && <Configuracion />}
    </div>
  );
}

// ============================================================
// Bandeja de pedidos — FIX ANNY-BORRADOR-015
// ============================================================
function Pedidos({ pedidos, onCambio, onNavegar }) {
  const [trabajando, setTrabajando] = useState(null);
  const [errorAccion, setErrorAccion] = useState(null); // ✅ ANNY-PEDIDOS-020

  // ✅ ANNY-PREFILL-021: abre Nueva Orden ya diligenciada con los datos del
  // pedido. Se reutiliza el endpoint /prellenado (que ya existía sin usarse)
  // y el canal `c360_orden_prefill` que Telemercadeo ya emplea.
  // El pedido NO se cierra aquí: se cierra cuando la orden se crea de verdad.
  const crearOrden = async (pedidoId) => {
    setTrabajando(pedidoId);
    setErrorAccion(null);
    try {
      const res = await fetch(`${API}/anny/pedidos/${pedidoId}/prellenado`, { headers: authHeaders() });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'No se pudo preparar la orden');

      const pre = json.prellenado || {};
      sessionStorage.setItem('c360_orden_prefill', JSON.stringify({
        // Campos que NuevaOrden ya entendía
        id: pre.clienteId || null,
        nombre: pre.nombreCliente || '',
        nit: pre.cedulaNit || '',
        celular: pre.telefono || '',
        empresaId: pre.empresaId || '',
        // ✅ ANNY-PREFILL-021 — contexto del pedido
        origen: 'ANNY',
        pedidoId,
        direccion: pre.direccion || '',
        barrio: pre.barrio || '',
        sucursal: pre.sucursal || '',
        productoTexto: pre.producto || '',
        totalAcordado: pre.total || '',
        fechaAcordada: pre.fecha || '',
        itemsSugeridos: pre.itemsSugeridos || [],
        coincidenciaParcial: !!pre.coincidenciaParcial,
        datosPendientes: json.datosPendientes || [],
        clienteNuevo: !pre.clienteId,
      }));

      if (onNavegar) onNavegar('ordenes');
      else setErrorAccion('Abre el módulo Órdenes: la orden quedó lista para diligenciar.');
    } catch (e) {
      setErrorAccion(e.message || 'No se pudo preparar la orden');
    } finally {
      setTrabajando(null);
    }
  };

  // ✅ FIX ANNY-PEDIDOS-020: antes el error se tragaba en silencio
  // (`catch (e) { }` sin mirar res.ok). Si el backend rechazaba la petición,
  // el botón quedaba mudo y parecía que "no pasa nada". Ahora se muestra.
  const actualizar = async (id, estado) => {
    setTrabajando(id);
    setErrorAccion(null);
    try {
      const res = await fetch(`${API}/anny/pedidos/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ estado })
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `No se pudo actualizar (error ${res.status})`);
      }
      onCambio();
    } catch (e) {
      setErrorAccion(e.message || 'No se pudo actualizar el pedido');
    }
    finally { setTrabajando(null); }
  };

  if (!pedidos.length) return <p style={S.vacio}>Anny todavía no ha registrado pedidos.</p>;

  return (
    <div>
      {/* ✅ ANNY-PEDIDOS-020: el error ya no se traga en silencio */}
      {errorAccion && (
        <div style={{
          background: '#fee2e2', color: '#b91c1c', borderRadius: 8,
          padding: '9px 12px', fontSize: 12.5, fontWeight: 700, marginBottom: 12,
        }}>
          ⚠️ {errorAccion}
        </div>
      )}
      {pedidos.map(p => {
        const pendientes = p.datosPendientes || [];
        const cerrado = ['ORDEN_CREADA', 'DESCARTADO'].includes(p.estado);
        return (
          <div key={p.id} style={{ ...S.tarjeta, opacity: cerrado ? 0.6 : 1 }}>
            <div style={S.tarjetaCabecera}>
              <div style={{ minWidth: 0 }}>
                <p style={S.tarjetaTitulo}>{p.nombreCliente || p.telefono}</p>
                <p style={S.tarjetaMeta}>{p.producto || 'Sin detalle'} · {p.total || 'sin valor'}</p>
              </div>
              <span style={S.badgeEstado}>{p.estado}</span>
            </div>

            {pendientes.length > 0 && (
              <div style={S.avisoPendiente}>
                Falta antes de facturar: {pendientes.join(', ')}
              </div>
            )}

            <p style={S.tarjetaTexto}>
              {p.direccion || 'Sin dirección'}{p.barrio ? `, ${p.barrio}` : ''}
              {p.sucursal ? ` · sede ${p.sucursal}` : ''}
            </p>

            {/* ✅ FIX ANNY-PEDIDOS-020: el botón mandaba a EN_REVISION incluso
                cuando el pedido YA estaba en EN_REVISION — pulsarlo no cambiaba
                nada y parecía roto. Ahora cada estado ofrece su paso siguiente
                real: revisar → orden creada → cerrado. */}
            {!cerrado && (
              <>
                <div style={S.tarjetaAcciones}>
                  {p.estado === 'EN_REVISION' ? (
                    // ✅ ANNY-PREFILL-021: en vez de pedirle a la admin que
                    // marque a mano "ya creé la orden" (que se puede marcar sin
                    // haberla creado), se abre Nueva Orden diligenciada y el
                    // pedido se cierra solo cuando la orden existe de verdad.
                    <button
                      onClick={() => crearOrden(p.id)}
                      disabled={trabajando === p.id}
                      style={S.btnPrim}
                    >
                      {trabajando === p.id ? 'Preparando…' : '🧾 Crear orden con estos datos'}
                    </button>
                  ) : (
                    <button
                      onClick={() => actualizar(p.id, 'EN_REVISION')}
                      disabled={trabajando === p.id}
                      style={S.btnPrim}
                    >
                      {trabajando === p.id ? 'Guardando…' : 'Marcar listo para orden'}
                    </button>
                  )}
                  <button
                    onClick={() => actualizar(p.id, 'DESCARTADO')}
                    disabled={trabajando === p.id}
                    style={S.btnSec}
                  >
                    Descartar
                  </button>
                </div>
                {p.estado === 'EN_REVISION' && (
                  <p style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 6 }}>
                    Se abre Nueva Orden con estos datos. Valida la forma de pago y el tipo de servicio antes de guardar.
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Casos escalados
// ============================================================
function Casos({ casos, onCambio }) {
  const [trabajando, setTrabajando] = useState(null);

  const resolver = async (id) => {
    setTrabajando(id);
    try {
      await fetch(`${API}/anny/casos/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ estado: 'RESUELTO' })
      });
      onCambio();
    } catch (e) { /* silencioso */ }
    finally { setTrabajando(null); }
  };

  if (!casos.length) return <p style={S.vacio}>Sin casos pendientes. Anny está resolviendo sola.</p>;

  return (
    <div>
      {casos.map(c => {
        const ts = (c.createdAt?.seconds || 0) * 1000;
        return (
          <div key={c.id} style={{ ...S.tarjeta, borderColor: C.danger }}>
            <div style={S.tarjetaCabecera}>
              <div style={{ minWidth: 0 }}>
                <p style={S.tarjetaTitulo}>{c.nombreCliente || c.telefono}</p>
                <p style={{ ...S.tarjetaMeta, color: C.dangerText }}>
                  {c.tipo || 'OTRO'}{ts ? ` · ${fmtEspera(ts)} esperando` : ''}
                </p>
              </div>
              <button onClick={() => resolver(c.id)} disabled={trabajando === c.id} style={S.btnPrim}>
                Resolver
              </button>
            </div>
            <p style={S.tarjetaTexto}>{c.mensajeCliente}</p>
            {c.razon && <p style={S.tarjetaRazon}>Motivo: {c.razon}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Configuración operativa (la del suscriptor).
// El PERFIL DE NEGOCIO no se edita aquí: lo configura la
// SuperAdmin desde el Panel de Suscriptores (ANNY-CFG-010).
// ============================================================
function Configuracion() {
  const [cfg, setCfg] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState(null);
  const [ronda, setRonda] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/anny/config`, { headers: authHeaders() });
        const d = r.ok ? await r.json() : {};
        setCfg({
          diasAntes: d.diasAntes ?? 30,
          horaEnvio: d.horaEnvio || '09:00',
          notificarPedidosA: d.notificarPedidosA || '',
          diasRondaVencimientos: d.diasRondaVencimientos || '',
          topeDiarioRonda: d.topeDiarioRonda ?? 60
        });
      } catch (e) { setCfg({}); }
    })();
  }, []);

  const guardar = async () => {
    setGuardando(true);
    setMsg(null);
    try {
      const r = await fetch(`${API}/anny/config`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(cfg)
      });
      setMsg(r.ok ? { ok: true, texto: 'Configuración guardada.' } : { ok: false, texto: 'No se pudo guardar.' });
    } catch (e) {
      setMsg({ ok: false, texto: 'Error de conexión.' });
    } finally {
      setGuardando(false);
    }
  };

  const lanzarRonda = async () => {
    if (!window.confirm('¿Enviar la ronda de vencimientos ahora? Se envía 1 mensaje cada 45 segundos.')) return;
    setRonda('enviando');
    try {
      const r = await fetch(`${API}/anny/vencimientos/ronda`, { method: 'POST', headers: authHeaders() });
      const d = await r.json();
      setRonda(d.mensaje || (d.ok ? 'Ronda iniciada.' : d.error));
    } catch (e) {
      setRonda('Error de conexión.');
    }
  };

  if (!cfg) return <p style={S.vacio}>Cargando configuración…</p>;

  const campo = (label, key, tipo = 'text', ayuda = '') => (
    <div style={{ marginBottom: 14 }}>
      <label style={S.label}>{label}</label>
      <input
        type={tipo}
        value={cfg[key] ?? ''}
        onChange={e => setCfg(c => ({ ...c, [key]: e.target.value }))}
        style={S.input}
      />
      {ayuda && <p style={S.ayuda}>{ayuda}</p>}
    </div>
  );

  return (
    <div style={S.tarjeta}>
      <div style={S.gridConfig}>
        {campo('Días antes de recordar', 'diasAntes', 'number')}
        {campo('Hora de envío', 'horaEnvio', 'time')}
        {campo('WhatsApp para avisos', 'notificarPedidosA', 'text', 'Aquí llegan los pedidos nuevos y los escalamientos urgentes.')}
        {campo('Días de ronda del mes', 'diasRondaVencimientos', 'text', 'Separados por coma. Ejemplo: 5, 20')}
        {campo('Tope de mensajes por ronda', 'topeDiarioRonda', 'number', 'Entre 10 y 150. Protege el número de bloqueos.')}
      </div>

      {msg && (
        <div style={{
          ...S.mensaje,
          background: msg.ok ? C.okBg : C.dangerBg,
          color: msg.ok ? C.okText : C.dangerText
        }}>
          {msg.texto}
        </div>
      )}

      <div style={S.tarjetaAcciones}>
        <button onClick={guardar} disabled={guardando} style={S.btnPrim}>
          {guardando ? 'Guardando…' : 'Guardar cambios'}
        </button>
        <button onClick={lanzarRonda} style={S.btnSec}>Enviar ronda ahora</button>
      </div>

      {ronda && <p style={S.ayuda}>{ronda === 'enviando' ? 'Iniciando ronda…' : ronda}</p>}
    </div>
  );
}

// ============================================================
const S = {
  contenedor: { padding: '4px 0' },

  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  headerIzq: { display: 'flex', alignItems: 'center', gap: 11 },
  avatar: {
    width: 36, height: 36, borderRadius: 10, background: C.accentBg, color: C.accentText,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600
  },
  nombre: { margin: 0, fontSize: 16, fontWeight: 600, color: C.text },
  conexion: { margin: '2px 0 0', fontSize: 12, color: C.textSec, display: 'flex', alignItems: 'center', gap: 6 },
  punto: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block' },
  headerDer: { display: 'flex', alignItems: 'center', gap: 8 },
  badgeUrgente: { fontSize: 12, padding: '5px 11px', borderRadius: 8, background: C.dangerBg, color: C.dangerText },

  qrCaja: {
    background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12,
    padding: 20, marginBottom: 16, textAlign: 'center'
  },
  qrTexto: { margin: '10px 0 0', fontSize: 12, color: C.textSec, lineHeight: 1.6 },

  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 16 },
  kpi: { background: C.surface1, borderRadius: 10, padding: '13px 15px' },
  kpiLabel: { margin: 0, fontSize: 12, color: C.textSec },
  kpiValor: { margin: '3px 0 0', fontSize: 25, fontWeight: 600, color: C.text },
  kpiPie: { margin: 0, fontSize: 12, color: C.textSec },

  tabs: { display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap', borderBottom: `1px solid ${C.border}` },
  tab: {
    fontSize: 13, padding: '9px 13px', cursor: 'pointer', background: 'transparent',
    border: 'none', borderBottom: '2px solid transparent', color: C.textSec
  },
  tabActiva: {
    fontSize: 13, padding: '9px 13px', cursor: 'pointer', background: 'transparent',
    border: 'none', borderBottom: `2px solid ${C.accent}`, color: C.text, fontWeight: 600
  },

  tarjeta: { background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 15, marginBottom: 10 },
  tarjetaCabecera: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 9 },
  tarjetaTitulo: { margin: 0, fontSize: 14, fontWeight: 600, color: C.text },
  tarjetaMeta: { margin: '2px 0 0', fontSize: 12, color: C.textSec },
  tarjetaTexto: { margin: '0 0 10px', fontSize: 13, lineHeight: 1.6, color: C.textSec },
  tarjetaRazon: { margin: 0, fontSize: 12, color: C.textMuted },
  tarjetaAcciones: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  badgeEstado: { fontSize: 11, padding: '3px 9px', borderRadius: 8, background: C.surface1, color: C.textSec, flexShrink: 0 },
  avisoPendiente: { background: C.warnBg, color: C.warnText, borderRadius: 8, padding: '8px 11px', fontSize: 12, marginBottom: 10 },

  gridConfig: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' },
  label: { display: 'block', fontSize: 12, color: C.textSec, marginBottom: 4 },
  input: {
    width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '8px 10px',
    border: `1px solid ${C.border}`, borderRadius: 8, outline: 'none', color: C.text
  },
  ayuda: { margin: '5px 0 0', fontSize: 11, color: C.textMuted, lineHeight: 1.5 },
  mensaje: { borderRadius: 8, padding: '9px 12px', fontSize: 13, margin: '0 0 12px' },

  btnPrim: {
    fontSize: 12, padding: '7px 13px', borderRadius: 8, cursor: 'pointer',
    background: C.accent, border: `1px solid ${C.accent}`, color: '#fff'
  },
  btnSec: {
    fontSize: 12, padding: '7px 13px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: `1px solid ${C.border}`, color: C.textSec
  },

  bloqueado: { background: C.surface1, borderRadius: 12, padding: 28, textAlign: 'center' },
  bloqueadoTitulo: { margin: 0, fontSize: 15, fontWeight: 600, color: C.text },
  bloqueadoTexto: { margin: '6px 0 0', fontSize: 13, color: C.textSec, lineHeight: 1.6 },

  vacio: { padding: '28px 14px', textAlign: 'center', fontSize: 13, color: C.textMuted }
};
// FIN ModuloAnny.js (rev. ANNY-ESTADO-025)
