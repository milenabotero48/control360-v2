// ═══════════════════════════════════════════════════════════════════════════════
// EgresosGraficas.js — Panel visual del módulo Egresos
// ─────────────────────────────────────────────────────────────────────────────
// EGRESO-VISUAL-001
//
// PARA QUÉ SIRVE
// --------------
// La pregunta que la gerencia hace todos los meses es una sola:
//     "¿Por dónde se me está yendo la plata?"
// Una tabla de 800 filas no la responde. Estas gráficas sí, en cinco segundos.
//
// DECISIONES DE DISEÑO
// --------------------
// · SVG puro, sin Recharts ni Chart.js. Mismo criterio que CajaGraficas.js:
//   no engorda el bundle, no agrega dependencias que después hay que mantener,
//   y todo se dibuja sobre datos que ya están cargados en memoria.
// · Nada de "gráfica bonita que no dice nada". Cada bloque responde una
//   pregunta concreta de negocio y muestra el número exacto al lado.
// · Los porcentajes se calculan sobre el TOTAL PAGADO (base + IVA − retención),
//   que es la plata que realmente salió, no sobre la base gravable.
//
// BLOQUES
//   1. Ingresos vs Gastos del mes  → ¿estoy ganando o perdiendo?
//   2. Distribución por clasificación contable → ¿en qué tipo de cosa se va?
//   3. Top categorías (barras)     → ¿cuáles son los 8 rubros más pesados?
//   4. Evolución mensual           → ¿venía así o se disparó este mes?
//   5. Consumo por vehículo        → ¿cuál placa se está comiendo la plata?
//   6. Concentración por tercero   → ¿de quién dependo?
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useMemo, useState } from 'react';

const fmt = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(n || 0);

// Formato corto para ejes: 1.200.000 → "1,2M"
const fmtCorto = (n) => {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + 'MM';
  if (v >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + 'M';
  if (v >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
};

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ─── Paleta ──────────────────────────────────────────────────────────────────
// Colores estables por posición: la misma categoría conserva su color entre
// recargas, para que el ojo aprenda a reconocerla.
const PALETA = [
  '#4f46e5', '#0284c7', '#059669', '#d97706', '#dc2626',
  '#7c3aed', '#0891b2', '#65a30d', '#ea580c', '#be123c',
  '#4338ca', '#0369a1', '#15803d', '#a16207', '#9f1239'
];

// Colores por clasificación contable — semánticos, no decorativos
const COLOR_TIPO = {
  costo_servicio:       { c: '#0891b2', label: 'Costo de servicios' },
  compra_inventario:    { c: '#7c3aed', label: 'Compra de inventario' },
  gasto_personal:       { c: '#dc2626', label: 'Personal' },
  gasto_operativo:      { c: '#d97706', label: 'Operativos' },
  gasto_fijo:           { c: '#0284c7', label: 'Fijos' },
  gasto_administrativo: { c: '#059669', label: 'Administrativos' },
  gasto_financiero:     { c: '#be123c', label: 'Financieros' },
  gasto_fiscal:         { c: '#65a30d', label: 'Fiscales' },
  sin_clasificar:       { c: '#94a3b8', label: 'Sin clasificar' }
};

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// ═════════════════════════════════════════════════════════════════════════════
// Tarjeta contenedora
// ═════════════════════════════════════════════════════════════════════════════
const Tarjeta = ({ titulo, subtitulo, children, acento = '#4f46e5', extra }) => (
  <div style={{
    background: '#fff', borderRadius: 16, padding: '18px 20px',
    boxShadow: '0 1px 3px rgba(15,23,42,0.08), 0 8px 24px -12px rgba(15,23,42,0.12)',
    border: '1px solid #f1f5f9'
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
      <div>
        <div style={{
          fontSize: 13, fontWeight: 800, color: '#0f172a',
          display: 'flex', alignItems: 'center', gap: 8
        }}>
          <span style={{ width: 4, height: 16, background: acento, borderRadius: 4, display: 'inline-block' }} />
          {titulo}
        </div>
        {subtitulo && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, marginLeft: 12 }}>{subtitulo}</div>}
      </div>
      {extra}
    </div>
    {children}
  </div>
);

const Vacio = ({ texto = 'Sin datos en el período' }) => (
  <div style={{ padding: '30px 0', textAlign: 'center', color: '#cbd5e1', fontSize: 12 }}>{texto}</div>
);

// ═════════════════════════════════════════════════════════════════════════════
// 1 · DONA — distribución por clasificación contable
// ─────────────────────────────────────────────────────────────────────────────
// Responde: "¿mi plata se va en personal, en mercancía o en gastos fijos?"
// Es la vista más alta: 8 grupos, no 30 categorías.
// ═════════════════════════════════════════════════════════════════════════════
const Dona = ({ datos, total, size = 190 }) => {
  const [activo, setActivo] = useState(null);
  if (!datos.length || total <= 0) return <Vacio />;

  const R = size / 2 - 16;
  const GROSOR = 30;
  const cx = size / 2, cy = size / 2;
  const circunferencia = 2 * Math.PI * R;

  let acumulado = 0;
  const segmentos = datos.map((d) => {
    const frac = d.valor / total;
    const seg = {
      ...d, frac,
      dash: frac * circunferencia,
      offset: -acumulado * circunferencia,
      pct: frac * 100
    };
    acumulado += frac;
    return seg;
  });

  const foco = activo !== null ? segmentos[activo] : null;

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="#f1f5f9" strokeWidth={GROSOR} />
          {segmentos.map((s, i) => (
            <circle
              key={i} cx={cx} cy={cy} r={R} fill="none"
              stroke={s.color} strokeWidth={activo === i ? GROSOR + 6 : GROSOR}
              strokeDasharray={`${s.dash} ${circunferencia}`}
              strokeDashoffset={s.offset}
              style={{ transition: 'stroke-width .15s', cursor: 'pointer' }}
              onMouseEnter={() => setActivo(i)}
              onMouseLeave={() => setActivo(null)}
            />
          ))}
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none'
        }}>
          <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>
            {foco ? foco.label : 'Total'}
          </div>
          <div style={{ fontSize: foco ? 15 : 16, fontWeight: 900, color: foco ? foco.color : '#0f172a', marginTop: 2, textAlign: 'center', padding: '0 8px' }}>
            {fmt(foco ? foco.valor : total)}
          </div>
          {foco && <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700 }}>{foco.pct.toFixed(1)}%</div>}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {segmentos.map((s, i) => (
          <div key={i}
            onMouseEnter={() => setActivo(i)} onMouseLeave={() => setActivo(null)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
              borderRadius: 8, cursor: 'pointer',
              background: activo === i ? '#f8fafc' : 'transparent'
            }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: '#334155', flex: 1, fontWeight: activo === i ? 700 : 500 }}>{s.label}</span>
            <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, minWidth: 38, textAlign: 'right' }}>
              {s.pct.toFixed(1)}%
            </span>
            <span style={{ fontSize: 12, fontWeight: 800, color: '#0f172a', minWidth: 82, textAlign: 'right' }}>
              {fmt(s.valor)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// 2 · BARRAS HORIZONTALES — top categorías
// ─────────────────────────────────────────────────────────────────────────────
// Responde: "¿cuáles son los rubros concretos más pesados?"
// Horizontal y no vertical porque los nombres de categoría son largos.
// ═════════════════════════════════════════════════════════════════════════════
const BarrasH = ({ datos, total, onClick }) => {
  if (!datos.length) return <Vacio />;
  const max = Math.max(...datos.map(d => d.valor), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {datos.map((d, i) => {
        const pctBarra = (d.valor / max) * 100;
        const pctTotal = total > 0 ? (d.valor / total) * 100 : 0;
        return (
          <div key={i}
            onClick={() => onClick && onClick(d)}
            style={{ cursor: onClick ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, color: '#334155', fontWeight: 600 }}>
                {d.label}
                {d.cantidad ? <span style={{ color: '#cbd5e1', fontWeight: 500 }}> · {d.cantidad}</span> : null}
              </span>
              <span style={{ fontSize: 12, fontWeight: 800, color: '#0f172a' }}>
                {fmt(d.valor)}
                <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600, marginLeft: 6 }}>
                  {pctTotal.toFixed(1)}%
                </span>
              </span>
            </div>
            <div style={{ height: 9, background: '#f1f5f9', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{
                width: `${pctBarra}%`, height: '100%', borderRadius: 6,
                background: `linear-gradient(90deg, ${d.color}, ${d.color}bb)`,
                transition: 'width .4s ease'
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// 3 · LÍNEA COMPARATIVA — ingresos vs gastos por mes
// ─────────────────────────────────────────────────────────────────────────────
// Responde: "¿esto viene pasando o es de este mes?"
// La zona roja entre las dos líneas es el mes en que se gastó más de lo que
// entró — se ve sin leer un solo número.
// ═════════════════════════════════════════════════════════════════════════════
const LineaComparativa = ({ meses, alto = 190 }) => {
  const [hover, setHover] = useState(null);
  if (!meses.length) return <Vacio />;

  const W = 640, H = alto, PL = 52, PR = 14, PT = 14, PB = 26;
  const iw = W - PL - PR, ih = H - PT - PB;

  const max = Math.max(...meses.flatMap(m => [m.ingresos, m.gastos]), 1);
  const x = (i) => PL + (meses.length === 1 ? iw / 2 : (i / (meses.length - 1)) * iw);
  const y = (v) => PT + ih - (v / max) * ih;

  const linea = (key) => meses.map((m, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(m[key])}`).join(' ');
  const area = (key) => `${linea(key)} L${x(meses.length - 1)},${PT + ih} L${x(0)},${PT + ih} Z`;

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="gradIng" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#059669" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="gradGas" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#dc2626" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#dc2626" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Rejilla + eje Y */}
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line x1={PL} y1={PT + ih - f * ih} x2={W - PR} y2={PT + ih - f * ih}
              stroke="#f1f5f9" strokeWidth="1" />
            <text x={PL - 7} y={PT + ih - f * ih + 3} textAnchor="end"
              fontSize="9" fill="#cbd5e1" fontWeight="600">{fmtCorto(max * f)}</text>
          </g>
        ))}

        <path d={area('ingresos')} fill="url(#gradIng)" />
        <path d={area('gastos')} fill="url(#gradGas)" />
        <path d={linea('ingresos')} fill="none" stroke="#059669" strokeWidth="2.5" strokeLinejoin="round" />
        <path d={linea('gastos')} fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinejoin="round" />

        {meses.map((m, i) => (
          <g key={i}>
            <rect x={x(i) - iw / (meses.length * 2 || 1)} y={PT} width={iw / (meses.length || 1)} height={ih}
              fill="transparent" onMouseEnter={() => setHover(i)} style={{ cursor: 'pointer' }} />
            <circle cx={x(i)} cy={y(m.ingresos)} r={hover === i ? 5 : 3} fill="#059669" stroke="#fff" strokeWidth="1.5" />
            <circle cx={x(i)} cy={y(m.gastos)} r={hover === i ? 5 : 3} fill="#dc2626" stroke="#fff" strokeWidth="1.5" />
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="9.5"
              fill={hover === i ? '#0f172a' : '#94a3b8'} fontWeight={hover === i ? 800 : 600}>
              {m.etiqueta}
            </text>
          </g>
        ))}
      </svg>

      {hover !== null && (
        <div style={{
          position: 'absolute', top: 4, right: 4, background: '#0f172a', color: '#fff',
          borderRadius: 10, padding: '9px 12px', fontSize: 11, minWidth: 150,
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)', pointerEvents: 'none'
        }}>
          <div style={{ fontWeight: 800, marginBottom: 6, fontSize: 12 }}>{meses[hover].etiquetaLarga}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ color: '#6ee7b7' }}>Ingresos</span><strong>{fmt(meses[hover].ingresos)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ color: '#fca5a5' }}>Gastos</span><strong>{fmt(meses[hover].gastos)}</strong>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', gap: 12,
            borderTop: '1px solid #334155', marginTop: 5, paddingTop: 5
          }}>
            <span>Resultado</span>
            <strong style={{ color: meses[hover].ingresos - meses[hover].gastos >= 0 ? '#6ee7b7' : '#fca5a5' }}>
              {fmt(meses[hover].ingresos - meses[hover].gastos)}
            </strong>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 11, color: '#059669', fontWeight: 700 }}>● Ingresos</span>
        <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 700 }}>● Gastos</span>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// 4 · MEDIDOR — resultado del mes
// ─────────────────────────────────────────────────────────────────────────────
// El número que importa, sin rodeos. Si es negativo, se ve rojo y grande.
// ═════════════════════════════════════════════════════════════════════════════
const ResultadoMes = ({ ingresos, gastos, etiqueta }) => {
  const resultado = ingresos - gastos;
  const positivo = resultado >= 0;
  const margen = ingresos > 0 ? (resultado / ingresos) * 100 : 0;
  // Cuánto del ingreso se consume en gastos
  const consumo = ingresos > 0 ? Math.min(100, (gastos / ingresos) * 100) : 100;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div style={{ background: '#f0fdf4', borderRadius: 12, padding: '12px 14px', border: '1px solid #dcfce7' }}>
          <div style={{ fontSize: 10, color: '#15803d', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            Ingresos {etiqueta}
          </div>
          <div style={{ fontSize: 19, fontWeight: 900, color: '#15803d', marginTop: 3 }}>{fmt(ingresos)}</div>
        </div>
        <div style={{ background: '#fef2f2', borderRadius: 12, padding: '12px 14px', border: '1px solid #fee2e2' }}>
          <div style={{ fontSize: 10, color: '#b91c1c', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            Gastos {etiqueta}
          </div>
          <div style={{ fontSize: 19, fontWeight: 900, color: '#b91c1c', marginTop: 3 }}>{fmt(gastos)}</div>
        </div>
      </div>

      {/* Barra de consumo: qué parte del ingreso se comieron los gastos */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', fontWeight: 700, marginBottom: 5 }}>
          <span>Los gastos consumen</span>
          <span style={{ color: consumo >= 100 ? '#dc2626' : consumo > 85 ? '#d97706' : '#059669' }}>
            {consumo.toFixed(0)}% del ingreso
          </span>
        </div>
        <div style={{ height: 12, background: '#f1f5f9', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            width: `${consumo}%`, height: '100%', borderRadius: 8,
            background: consumo >= 100
              ? 'linear-gradient(90deg,#dc2626,#991b1b)'
              : consumo > 85 ? 'linear-gradient(90deg,#f59e0b,#d97706)'
              : 'linear-gradient(90deg,#22c55e,#059669)',
            transition: 'width .5s ease'
          }} />
        </div>
      </div>

      <div style={{
        background: positivo ? 'linear-gradient(135deg,#059669,#047857)' : 'linear-gradient(135deg,#dc2626,#991b1b)',
        borderRadius: 12, padding: '14px 18px', color: '#fff',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
      }}>
        <div>
          <div style={{ fontSize: 10, opacity: .85, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>
            {positivo ? 'Resultado del período' : 'Pérdida del período'}
          </div>
          <div style={{ fontSize: 24, fontWeight: 900, marginTop: 2 }}>{fmt(resultado)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, opacity: .85, fontWeight: 700 }}>MARGEN</div>
          <div style={{ fontSize: 20, fontWeight: 900 }}>{margen.toFixed(1)}%</div>
        </div>
      </div>

      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8, lineHeight: 1.5 }}>
        Comparativo de caja del período filtrado. No reemplaza el Estado de Resultados:
        aquí la compra de mercancía cuenta como salida de dinero, mientras que en el ERI
        es inventario y solo se vuelve costo cuando se vende.
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// 5 · VEHÍCULOS
// ─────────────────────────────────────────────────────────────────────────────
// Responde: "¿cuál placa se está comiendo la plata?"
// El bloque de "sin asignar" es tan importante como el resto: mide cuánto del
// gasto de vehículos todavía no se puede atribuir.
// ═════════════════════════════════════════════════════════════════════════════
const PanelVehiculos = ({ consumo }) => {
  if (!consumo) return <Vacio texto="Cargando consumo por vehículo..." />;
  const { vehiculos = [], sinAsignar = {}, trazabilidad = 0, totalGeneral = 0 } = consumo;

  if (!vehiculos.length && !sinAsignar.total) {
    return <Vacio texto="Todavía no hay vehículos registrados ni gastos de combustible en el período" />;
  }

  const conGasto = vehiculos.filter(v => v.total > 0);
  const max = Math.max(...conGasto.map(v => v.total), sinAsignar.total || 0, 1);

  return (
    <div>
      {/* Indicador de trazabilidad */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
        background: trazabilidad >= 80 ? '#f0fdf4' : trazabilidad >= 50 ? '#fffbeb' : '#fef2f2',
        border: `1px solid ${trazabilidad >= 80 ? '#dcfce7' : trazabilidad >= 50 ? '#fef3c7' : '#fee2e2'}`,
        borderRadius: 10, padding: '10px 14px'
      }}>
        <div style={{
          fontSize: 22, fontWeight: 900,
          color: trazabilidad >= 80 ? '#15803d' : trazabilidad >= 50 ? '#d97706' : '#b91c1c'
        }}>{trazabilidad}%</div>
        <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.45 }}>
          <strong>Trazabilidad del gasto vehicular.</strong> Del total de {fmt(totalGeneral)} en gastos
          de vehículo, este porcentaje sí tiene placa asignada. El resto no se puede atribuir.
        </div>
      </div>

      {conGasto.length === 0 && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
          Ningún gasto tiene placa asignada todavía.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {conGasto.map((v, i) => (
          <div key={v.vehiculoId}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, alignItems: 'baseline' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontFamily: 'monospace', fontSize: 12, fontWeight: 900, letterSpacing: '.06em',
                  background: '#0f172a', color: '#fbbf24', padding: '3px 8px', borderRadius: 5,
                  border: '1px solid #334155'
                }}>{v.placa}</span>
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  {v.tipo}{v.conductorNombre ? ` · ${v.conductorNombre}` : ''}
                </span>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: '#0f172a' }}>
                {fmt(v.total)}
                <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600, marginLeft: 6 }}>
                  {v.egresos} mov · prom {fmt(v.promedioPorEgreso)}
                </span>
              </span>
            </div>
            <div style={{ height: 9, background: '#f1f5f9', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{
                width: `${(v.total / max) * 100}%`, height: '100%', borderRadius: 6,
                background: `linear-gradient(90deg, ${PALETA[i % PALETA.length]}, ${PALETA[i % PALETA.length]}bb)`
              }} />
            </div>
          </div>
        ))}

        {sinAsignar.total > 0 && (
          <div style={{ marginTop: 4, paddingTop: 12, borderTop: '1px dashed #e2e8f0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, alignItems: 'baseline' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontFamily: 'monospace', fontSize: 12, fontWeight: 900,
                  background: '#f1f5f9', color: '#94a3b8', padding: '3px 8px', borderRadius: 5,
                  border: '1px dashed #cbd5e1'
                }}>SIN PLACA</span>
                <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>
                  {sinAsignar.cantidad} egreso(s) sin atribuir
                </span>
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: '#dc2626' }}>{fmt(sinAsignar.total)}</span>
            </div>
            <div style={{ height: 9, background: '#f1f5f9', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{
                width: `${(sinAsignar.total / max) * 100}%`, height: '100%', borderRadius: 6,
                background: 'repeating-linear-gradient(45deg,#fca5a5,#fca5a5 5px,#fecaca 5px,#fecaca 10px)'
              }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
export default function EgresosGraficas({
  egresos = [],          // egresos YA filtrados por el período seleccionado
  egresosTodos = [],     // histórico completo, para la evolución mensual
  ingresosPeriodo = 0,   // ingresos del período (ventas)
  ingresosPorMes = {},   // { 'YYYY-MM': valor }  para la evolución
  categoriasMeta = [],   // catálogo con tipoERI
  consumoVehiculos = null,
  etiquetaPeriodo = 'del período',
  isMobile = false,
  onVerCategoria
}) {

  // ─── Solo cuenta lo efectivamente pagado y no anulado ─────────────────────
  const pagados = useMemo(
    () => egresos.filter(e => e.estado === 'PAGADO' && e.anulado !== true),
    [egresos]
  );

  const totalGastos = useMemo(
    () => pagados.reduce((a, e) => a + (Number(e.totalPagar || e.monto) || 0), 0),
    [pagados]
  );

  // ─── Agrupación por clasificación contable (tipoERI) ──────────────────────
  const porTipo = useMemo(() => {
    const mapa = {};
    for (const e of pagados) {
      const meta = categoriasMeta.find(c => norm(c.nombre) === norm(e.categoria));
      const tipo = meta?.tipoERI || 'sin_clasificar';
      const valor = Number(e.totalPagar || e.monto) || 0;
      if (!mapa[tipo]) mapa[tipo] = 0;
      mapa[tipo] += valor;
    }
    return Object.entries(mapa)
      .map(([tipo, valor]) => ({
        tipo, valor,
        label: COLOR_TIPO[tipo]?.label || 'Sin clasificar',
        color: COLOR_TIPO[tipo]?.c || '#94a3b8'
      }))
      .filter(d => d.valor > 0)
      .sort((a, b) => b.valor - a.valor);
  }, [pagados, categoriasMeta]);

  // ─── Top categorías concretas ─────────────────────────────────────────────
  const porCategoria = useMemo(() => {
    const mapa = {};
    for (const e of pagados) {
      const cat = e.categoria || 'Sin categoría';
      const valor = Number(e.totalPagar || e.monto) || 0;
      if (!mapa[cat]) mapa[cat] = { label: cat, valor: 0, cantidad: 0 };
      mapa[cat].valor += valor;
      mapa[cat].cantidad += 1;
    }
    return Object.values(mapa)
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 8)
      .map((d, i) => ({ ...d, color: PALETA[i % PALETA.length] }));
  }, [pagados]);

  // ─── Concentración por tercero ────────────────────────────────────────────
  const porTercero = useMemo(() => {
    const mapa = {};
    for (const e of pagados) {
      const t = (e.proveedor || '').trim() || 'Sin tercero';
      const valor = Number(e.totalPagar || e.monto) || 0;
      if (!mapa[t]) mapa[t] = { label: t, valor: 0, cantidad: 0 };
      mapa[t].valor += valor;
      mapa[t].cantidad += 1;
    }
    return Object.values(mapa)
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 6)
      .map((d, i) => ({ ...d, color: PALETA[(i + 3) % PALETA.length] }));
  }, [pagados]);

  // ─── Evolución de los últimos 6 meses ─────────────────────────────────────
  const evolucion = useMemo(() => {
    const gastosMes = {};
    for (const e of egresosTodos) {
      if (e.estado !== 'PAGADO' || e.anulado === true) continue;
      const ym = String(e.fecha || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      gastosMes[ym] = (gastosMes[ym] || 0) + (Number(e.totalPagar || e.monto) || 0);
    }

    const claves = new Set([...Object.keys(gastosMes), ...Object.keys(ingresosPorMes || {})]);
    return [...claves].sort().slice(-6).map(ym => {
      const [a, m] = ym.split('-');
      return {
        ym,
        etiqueta: MESES[Number(m) - 1] || m,
        etiquetaLarga: `${MESES[Number(m) - 1] || m} ${a}`,
        gastos: gastosMes[ym] || 0,
        ingresos: (ingresosPorMes || {})[ym] || 0
      };
    });
  }, [egresosTodos, ingresosPorMes]);

  // ─── Concentración: cuánto pesan las 3 categorías más grandes ─────────────
  const concentracion = useMemo(() => {
    if (!totalGastos) return 0;
    const top3 = porCategoria.slice(0, 3).reduce((a, d) => a + d.valor, 0);
    return Math.round(top3 / totalGastos * 100);
  }, [porCategoria, totalGastos]);

  const grid2 = { display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 16 };

  if (!pagados.length) {
    return (
      <div style={{
        background: '#fff', borderRadius: 16, padding: 40, textAlign: 'center',
        color: '#94a3b8', fontSize: 13, border: '1px solid #f1f5f9'
      }}>
        📊 No hay egresos pagados en el período seleccionado.<br />
        <span style={{ fontSize: 12, color: '#cbd5e1' }}>Ajustá el rango de fechas para ver el análisis.</span>
      </div>
    );
  }

  return (
    <div>
      {/* ── FILA 1: Resultado del período + Distribución ───────────────────── */}
      <div style={grid2}>
        <Tarjeta
          titulo="Ingresos vs Gastos"
          subtitulo={`Movimiento de dinero ${etiquetaPeriodo}`}
          acento="#059669">
          <ResultadoMes ingresos={ingresosPeriodo} gastos={totalGastos} etiqueta={etiquetaPeriodo} />
        </Tarjeta>

        <Tarjeta
          titulo="¿En qué se va la plata?"
          subtitulo="Distribución por clasificación contable"
          acento="#4f46e5">
          <Dona datos={porTipo} total={totalGastos} />
        </Tarjeta>
      </div>

      {/* ── FILA 2: Top categorías + Terceros ──────────────────────────────── */}
      <div style={grid2}>
        <Tarjeta
          titulo="Rubros más pesados"
          subtitulo="Top 8 categorías · clic para filtrar"
          acento="#d97706"
          extra={
            <div style={{
              background: concentracion > 70 ? '#fef2f2' : '#f8fafc',
              border: `1px solid ${concentracion > 70 ? '#fee2e2' : '#f1f5f9'}`,
              borderRadius: 8, padding: '5px 10px', textAlign: 'right'
            }}>
              <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>TOP 3 =</div>
              <div style={{ fontSize: 14, fontWeight: 900, color: concentracion > 70 ? '#dc2626' : '#334155' }}>
                {concentracion}%
              </div>
            </div>
          }>
          <BarrasH datos={porCategoria} total={totalGastos} onClick={onVerCategoria} />
        </Tarjeta>

        <Tarjeta
          titulo="¿A quién le pagamos más?"
          subtitulo="Top 6 terceros del período"
          acento="#7c3aed">
          <BarrasH datos={porTercero} total={totalGastos} />
        </Tarjeta>
      </div>

      {/* ── FILA 3: Evolución ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <Tarjeta
          titulo="Evolución de los últimos 6 meses"
          subtitulo="¿El gasto de este mes es normal o se disparó?"
          acento="#0284c7">
          <LineaComparativa meses={evolucion} />
        </Tarjeta>
      </div>

      {/* ── FILA 4: Vehículos ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <Tarjeta
          titulo="Consumo por vehículo"
          subtitulo="Combustible, mantenimiento y peajes atribuidos a cada placa"
          acento="#be123c">
          <PanelVehiculos consumo={consumoVehiculos} />
        </Tarjeta>
      </div>
    </div>
  );
}

export { Tarjeta, Dona, BarrasH, LineaComparativa, ResultadoMes, PanelVehiculos, fmtCorto, PALETA, COLOR_TIPO };
