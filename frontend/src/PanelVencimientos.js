// ═══════════════════════════════════════════════════════════════════════════
// ✅ VENC-KPI-001 (2026-08-08) — Panel de inteligencia comercial
// Ubicación: frontend/src/PanelVencimientos.js
// ───────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE:
//   El módulo de Vencimientos mostraba tres contadores ("445 vencido, 0 por
//   vencer, 983 vigente") y un acordeón de meses. Eso le sirve a quien va a
//   llamar, pero no a quien dirige: un gerente abre esta pantalla para saber
//   cuánta plata entra este mes y cuánta se está yendo, y esa respuesta no
//   estaba en ningún lado.
//
//   Este panel responde cuatro preguntas, en este orden:
//     1. ¿Cuántos clientes debo atender este mes y cuánto vale eso?
//     2. ¿Cuántos ya volvieron? (tasa de retorno contra el promedio histórico)
//     3. ¿Cuánto se me está yendo hoy? (vencidos sin gestionar, en pesos)
//     4. ¿Qué viene en los próximos meses? (para planear caja e inventario)
//
// SIN DEPENDENCIAS NUEVAS: las gráficas son SVG puro, el mismo patrón de
// CajaGraficas.js. Cero peso extra en el bundle.
//
// Los datos vienen de GET /api/vencimientos/estadisticas — una sola llamada.
// ═══════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const fmtPesos = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0,
}).format(n || 0);

// Cifras grandes en formato corto: $12,4 M — en una tarjeta de KPI el peso
// exacto es ruido; lo que importa es el orden de magnitud.
const fmtCorto = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1).replace('.', ',')} MM`;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000)} K`;
  return fmtPesos(v);
};

const etiquetaMes = (k) => {
  if (!k) return '';
  const [y, m] = k.split('-');
  return `${MESES_CORTO[Number(m) - 1] || m} ${String(y).slice(2)}`;
};

// ── Paleta ────────────────────────────────────────────────────────────────
const C = {
  tinta: '#1a1a2e',
  violeta: '#7c3aed',
  violetaSuave: 'rgba(124,58,237,0.10)',
  verde: '#10b981',
  verdeSuave: 'rgba(16,185,129,0.12)',
  rojo: '#dc2626',
  rojoSuave: 'rgba(220,38,38,0.10)',
  ambar: '#f59e0b',
  ambarSuave: 'rgba(245,158,11,0.12)',
  azul: '#3b82f6',
  gris: '#6b7280',
  borde: '#eceaf3',
};

const S = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18 },
  gridKpi: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(215px,1fr))', gap: 12 },
  card: {
    background: '#fff', borderRadius: 16, padding: '16px 18px',
    border: `1px solid ${C.borde}`, boxShadow: '0 1px 3px rgba(16,12,40,0.05)',
    position: 'relative', overflow: 'hidden',
  },
  cardTitulo: { fontSize: 11.5, fontWeight: 700, color: C.gris, textTransform: 'uppercase', letterSpacing: 0.4, margin: 0 },
  cardCifra: { fontSize: 30, fontWeight: 800, color: C.tinta, lineHeight: 1.1, margin: '8px 0 2px', letterSpacing: -0.6 },
  cardPie: { fontSize: 12, color: C.gris, margin: 0, lineHeight: 1.45 },
  panel: {
    background: '#fff', borderRadius: 16, padding: '18px 20px',
    border: `1px solid ${C.borde}`, boxShadow: '0 1px 3px rgba(16,12,40,0.05)',
  },
  panelTitulo: { fontSize: 14.5, fontWeight: 800, color: C.tinta, margin: 0 },
  panelSub: { fontSize: 12, color: C.gris, margin: '3px 0 14px', lineHeight: 1.5 },
  fila2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(330px,1fr))', gap: 12 },
  chip: (bg, color) => ({
    display: 'inline-block', background: bg, color, fontSize: 11, fontWeight: 700,
    padding: '3px 9px', borderRadius: 999,
  }),
  aviso: {
    display: 'flex', gap: 10, alignItems: 'flex-start', background: '#fffbeb',
    border: '1px solid #fde68a', borderRadius: 12, padding: '11px 14px',
    fontSize: 12.5, color: '#92400e', lineHeight: 1.55,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Tarjeta de KPI. `acento` pinta la barra lateral de color — es lo que hace
// que el ojo distinga de un vistazo "esto es plata que entra" de "esto es
// plata que se va", sin tener que leer.
// ═══════════════════════════════════════════════════════════════════════════
const Kpi = ({ titulo, cifra, pie, acento = C.violeta, fondo, chip }) => (
  <div style={{ ...S.card, background: fondo || '#fff' }}>
    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: acento }} />
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
      <p style={S.cardTitulo}>{titulo}</p>
      {chip}
    </div>
    <p style={{ ...S.cardCifra, color: acento === C.rojo ? C.rojo : C.tinta }}>{cifra}</p>
    <p style={S.cardPie}>{pie}</p>
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════
// Barras de venta proyectada por mes. La barra del mes en curso va sólida y
// las siguientes translúcidas: proyección no es lo mismo que realidad, y la
// gráfica debe decirlo sin una nota al pie.
// ═══════════════════════════════════════════════════════════════════════════
const GraficaProyeccion = ({ datos, mesActual }) => {
  if (!datos?.length) return <p style={S.cardPie}>Sin vencimientos futuros cargados.</p>;

  const W = 660, H = 210, padX = 46, padY = 26;
  const max = Math.max(...datos.map(d => d.ventaProyectada), 1);
  const anchoUtil = W - padX * 2;
  const paso = anchoUtil / datos.length;
  const anchoBarra = Math.min(paso * 0.55, 64);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img"
         aria-label="Venta proyectada por mes">
      {[0, 0.5, 1].map(f => (
        <line key={f} x1={padX} x2={W - padX / 2} y1={padY + (H - padY * 2) * (1 - f)}
              y2={padY + (H - padY * 2) * (1 - f)} stroke={C.borde} strokeWidth="1" />
      ))}
      {datos.map((d, i) => {
        const alto = (d.ventaProyectada / max) * (H - padY * 2);
        const x = padX + paso * i + (paso - anchoBarra) / 2;
        const y = H - padY - alto;
        const esActual = d.mes === mesActual;
        return (
          <g key={d.mes}>
            <rect x={x} y={y} width={anchoBarra} height={Math.max(alto, 2)} rx="6"
                  fill={esActual ? C.violeta : C.violetaSuave}
                  stroke={esActual ? 'none' : C.violeta} strokeWidth={esActual ? 0 : 1.2} />
            <text x={x + anchoBarra / 2} y={y - 7} textAnchor="middle"
                  fontSize="11" fontWeight="700" fill={C.tinta}>
              {fmtCorto(d.ventaProyectada)}
            </text>
            <text x={x + anchoBarra / 2} y={H - padY + 15} textAnchor="middle"
                  fontSize="11" fontWeight={esActual ? 800 : 600} fill={esActual ? C.violeta : C.gris}>
              {etiquetaMes(d.mes)}
            </text>
            <text x={x + anchoBarra / 2} y={H - padY + 28} textAnchor="middle"
                  fontSize="10" fill={C.gris}>
              {d.clientesEsperados} cli
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Retorno mes a mes: cuántos clientes de los que vencían efectivamente
// volvieron a recargar. Es EL indicador de salud del negocio de recarga —
// una base grande con retorno bajo es una base que se está evaporando.
// ═══════════════════════════════════════════════════════════════════════════
const GraficaRetorno = ({ datos, promedio }) => {
  if (!datos?.length) return <p style={S.cardPie}>Todavía no hay meses cerrados para comparar.</p>;

  const W = 660, H = 220, padX = 42, padTop = 22, padBot = 40;
  const altoUtil = H - padTop - padBot;
  const paso = (W - padX * 2) / Math.max(datos.length - 1, 1);
  const y = (pct) => padTop + altoUtil * (1 - Math.min(pct, 100) / 100);
  const puntos = datos.map((d, i) => ({ x: padX + paso * i, y: y(d.tasaRetorno), d }));
  const linea = puntos.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const area = `${linea} L${puntos[puntos.length - 1].x},${H - padBot} L${puntos[0].x},${H - padBot} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img"
         aria-label="Tasa de retorno de clientes por mes">
      <defs>
        <linearGradient id="gradRetorno" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.verde} stopOpacity="0.28" />
          <stop offset="100%" stopColor={C.verde} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {[0, 25, 50, 75, 100].map(p => (
        <g key={p}>
          <line x1={padX} x2={W - padX / 2} y1={y(p)} y2={y(p)} stroke={C.borde} strokeWidth="1" />
          <text x={padX - 8} y={y(p) + 3.5} textAnchor="end" fontSize="10" fill={C.gris}>{p}%</text>
        </g>
      ))}

      {promedio > 0 && (
        <g>
          <line x1={padX} x2={W - padX / 2} y1={y(promedio)} y2={y(promedio)}
                stroke={C.ambar} strokeWidth="1.5" strokeDasharray="5 4" />
          <text x={W - padX / 2} y={y(promedio) - 6} textAnchor="end" fontSize="10.5"
                fontWeight="700" fill={C.ambar}>
            promedio {promedio}%
          </text>
        </g>
      )}

      <path d={area} fill="url(#gradRetorno)" />
      <path d={linea} fill="none" stroke={C.verde} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

      {puntos.map((p) => (
        <g key={p.d.mes}>
          <circle cx={p.x} cy={p.y} r="4.5" fill="#fff" stroke={C.verde} strokeWidth="2.5" />
          <title>{`${etiquetaMes(p.d.mes)}: ${p.d.clientesRegresaron} de ${p.d.clientesEsperados} clientes regresaron (${p.d.tasaRetorno}%)`}</title>
          <text x={p.x} y={H - padBot + 16} textAnchor="middle" fontSize="10" fill={C.gris}>
            {etiquetaMes(p.d.mes)}
          </text>
          <text x={p.x} y={H - padBot + 29} textAnchor="middle" fontSize="10" fontWeight="700" fill={C.tinta}>
            {p.d.tasaRetorno}%
          </text>
        </g>
      ))}
    </svg>
  );
};

// Barra horizontal simple — para empresas y equipos más recargados.
const BarrasHorizontal = ({ items, etiqueta, valor, sufijo, color = C.violeta }) => {
  if (!items?.length) return <p style={S.cardPie}>Sin datos para este corte.</p>;
  const max = Math.max(...items.map(valor), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => (
        <div key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: C.tinta, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {etiqueta(it)}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 800, color, whiteSpace: 'nowrap' }}>
              {sufijo(it)}
            </span>
          </div>
          <div style={{ height: 8, background: '#f4f2f9', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${(valor(it) / max) * 100}%`, height: '100%', background: color, borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
export default function PanelVencimientos({ recargar = 0, onVerVencidos }) {
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [abierto, setAbierto] = useState(true);

  const cargar = useCallback(async () => {
    setCargando(true); setError(null);
    try {
      const r = await fetch(`${API}/vencimientos/estadisticas`, { headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo cargar el panel');
      setDatos(await r.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar, recargar]);

  if (cargando) {
    return (
      <div style={{ ...S.panel, textAlign: 'center', color: C.gris, fontSize: 13, padding: '26px 20px' }}>
        Calculando indicadores del mes…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ ...S.panel, borderColor: '#fecaca', background: '#fef2f2', color: '#991b1b', fontSize: 13 }}>
        No se pudieron cargar los indicadores: {error}
      </div>
    );
  }
  if (!datos) return null;

  const { mesActual, retornoPromedio6m, historico, proyeccion, vencidos, empresas, topEquipos, cobertura } = datos;

  const pendientes = Math.max(mesActual.clientesEsperados - mesActual.clientesRegresaron, 0);
  const porCobrar = Math.max(mesActual.ventaProyectada - mesActual.ventaRealizada, 0);
  const diferencia = Math.round((mesActual.tasaRetorno - retornoPromedio6m) * 10) / 10;
  const mejorQuePromedio = diferencia >= 0;

  return (
    <div style={S.wrap}>
      {/* ── Encabezado plegable: un gerente lo quiere ver, una vendedora que
             solo va a llamar prefiere el espacio para la lista. ─────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ ...S.panelTitulo, fontSize: 16 }}>📊 Inteligencia del mes</h3>
          <p style={{ ...S.panelSub, margin: '2px 0 0' }}>
            {etiquetaMes(mesActual.mes)} · calculado sobre tu base completa y tu lista de precios
          </p>
        </div>
        <button onClick={() => setAbierto(!abierto)} style={{
          background: '#fff', border: `1px solid ${C.borde}`, borderRadius: 9,
          padding: '7px 14px', fontSize: 12.5, fontWeight: 700, color: C.violeta, cursor: 'pointer',
        }}>
          {abierto ? '▲ Ocultar panel' : '▼ Ver panel'}
        </button>
      </div>

      {abierto && (
        <>
          {/* ── KPIs ───────────────────────────────────────────────────── */}
          <div style={S.gridKpi}>
            <Kpi
              titulo="Clientes esperados este mes"
              cifra={mesActual.clientesEsperados.toLocaleString('es-CO')}
              acento={C.violeta}
              pie={<>{mesActual.cantidadEquipos.toLocaleString('es-CO')} equipos por recargar · <strong>{pendientes}</strong> sin atender aún</>}
            />
            <Kpi
              titulo="Venta esperada del mes"
              cifra={fmtCorto(mesActual.ventaProyectada)}
              acento={C.verde}
              fondo="linear-gradient(180deg,#ffffff,#f6fffb)"
              pie={<>Ya facturado <strong>{fmtCorto(mesActual.ventaRealizada)}</strong> · falta {fmtCorto(porCobrar)}</>}
            />
            <Kpi
              titulo="Tasa de retorno"
              cifra={`${mesActual.tasaRetorno}%`}
              acento={mejorQuePromedio ? C.verde : C.ambar}
              chip={<span style={S.chip(mejorQuePromedio ? C.verdeSuave : C.ambarSuave, mejorQuePromedio ? '#047857' : '#b45309')}>
                {mejorQuePromedio ? '▲' : '▼'} {Math.abs(diferencia)} pts
              </span>}
              pie={<>{mesActual.clientesRegresaron} de {mesActual.clientesEsperados} ya volvieron · promedio 6 meses: {retornoPromedio6m}%</>}
            />
            <Kpi
              titulo="Vencidos sin atender"
              cifra={fmtCorto(vencidos.valor)}
              acento={C.rojo}
              fondo="linear-gradient(180deg,#ffffff,#fff7f7)"
              pie={<>
                {vencidos.clientes.toLocaleString('es-CO')} clientes · {vencidos.equipos.toLocaleString('es-CO')} equipos
                {onVerVencidos && (
                  <>
                    {' '}·{' '}
                    <button onClick={onVerVencidos} style={{
                      background: 'none', border: 'none', padding: 0, color: C.rojo,
                      fontWeight: 800, fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
                    }}>ver lista</button>
                  </>
                )}
              </>}
            />
          </div>

          {/* ── Aviso de cobertura de precios ──────────────────────────────
                 Sin esto, un gerente podría leer la proyección como completa
                 cuando le falta valorizar parte de la base. ─────────────── */}
          {mesActual.equiposSinPrecio > 0 && (
            <div style={S.aviso}>
              <span style={{ fontSize: 15 }}>⚠️</span>
              <span>
                <strong>{mesActual.equiposSinPrecio} equipos de este mes no tienen precio</strong> porque su
                descripción no coincide con ningún producto de tu lista. No se estimaron con un promedio:
                la venta esperada real es <em>mayor</em> a la que ves. Crea esos productos en{' '}
                <strong>Productos</strong> o corrige la descripción del equipo para que la proyección quede completa.
              </span>
            </div>
          )}

          {/* ── Gráficas ──────────────────────────────────────────────────── */}
          <div style={S.panel}>
            <h4 style={S.panelTitulo}>Venta esperada — próximos 6 meses</h4>
            <p style={S.panelSub}>
              Cada barra suma los equipos que vencen ese mes valorizados con el precio al público de tu
              lista de productos. Es la caja que deberías facturar si todos los clientes regresan.
            </p>
            <GraficaProyeccion datos={proyeccion} mesActual={mesActual.mes} />
          </div>

          <div style={S.panel}>
            <h4 style={S.panelTitulo}>¿Cuántos clientes están regresando?</h4>
            <p style={S.panelSub}>
              De los clientes que vencían cada mes, qué porcentaje volvió a recargar. La línea punteada es tu
              promedio de los últimos 6 meses: por debajo de ella, el mes va perdiendo clientes.
            </p>
            <GraficaRetorno datos={historico} promedio={retornoPromedio6m} />
          </div>

          <div style={S.fila2}>
            <div style={S.panel}>
              <h4 style={S.panelTitulo}>Por empresa que factura</h4>
              <p style={S.panelSub}>De este mes en adelante — sirve para proyectar por razón social.</p>
              <BarrasHorizontal
                items={empresas.slice(0, 6)}
                etiqueta={(e) => e.empresa}
                valor={(e) => e.venta}
                sufijo={(e) => `${fmtCorto(e.venta)} · ${e.clientes} cli`}
              />
            </div>

            <div style={S.panel}>
              <h4 style={S.panelTitulo}>Qué se recarga más este mes</h4>
              <p style={S.panelSub}>Para tener el inventario listo antes de que empiecen a llamar.</p>
              <BarrasHorizontal
                items={topEquipos}
                etiqueta={(e) => e.equipo}
                valor={(e) => e.cantidad}
                sufijo={(e) => `${e.cantidad} und`}
                color={C.azul}
              />
            </div>
          </div>

          <p style={{ fontSize: 11.5, color: C.gris, margin: 0, lineHeight: 1.6 }}>
            Precios tomados de tu lista de productos ({cobertura.productosConPrecio} productos con precio de venta).
            Un cliente cuenta como “regresó” cuando su ciclo quedó cerrado con venta: orden asociada,
            marcado como gestionado o ciclo renovado.
          </p>
        </>
      )}
    </div>
  );
}
