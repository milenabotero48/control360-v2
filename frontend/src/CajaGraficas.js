// ═══════════════════════════════════════════════════════════════════════════
// ✅ CAJA-REDISENO-001: Gráficas SVG puras para el módulo Caja.
// Sin dependencias externas (no Recharts) → livianas, no agregan peso al
// bundle ni consultas nuevas. Se dibujan una vez sobre datos ya cargados.
// Diseño premium: colores translúcidos, tipografía clara, estética de contadora.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';

const fmt = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

// ✅ FIX CAJA-FLUJO-001: normalizador de fecha de movimientos → 'YYYY-MM-DD'.
// Los movimientos que crean el cuadre y registrarIngresoEnCaja NO traen campo
// `fecha`: solo `createdAt` como Timestamp de Firestore, que llega al frontend
// como objeto {_seconds}. El código anterior le hacía .toString() → devolvía
// "[object Object]", nunca coincidía con el mes seleccionado y la gráfica
// mostraba "Sin movimientos este mes" teniendo movimientos reales. Este helper
// acepta string ISO, Timestamp serializado (_seconds/seconds), Timestamp vivo
// (toDate) y Date — siempre en fecha de Colombia (America/Bogota).
export const fechaMovISO = (m) => {
  const v = (m && (m.fecha || m.createdAt || m.timestamp)) || m;
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  let d = null;
  if (v._seconds) d = new Date(v._seconds * 1000);
  else if (v.seconds) d = new Date(v.seconds * 1000);
  else if (typeof v.toDate === 'function') d = v.toDate();
  else if (v instanceof Date) d = v;
  if (!d || isNaN(d.getTime())) return '';
  // 'en-CA' produce YYYY-MM-DD; timeZone Bogota evita el corrimiento de día UTC
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
};

// Paleta premium por tipo de caja (translúcida y elegante)
export const COLORES_CAJA = [
  { solid: '#10b981', soft: 'rgba(16,185,129,0.12)', name: 'esmeralda' },
  { solid: '#3b82f6', soft: 'rgba(59,130,246,0.12)', name: 'azul' },
  { solid: '#8b5cf6', soft: 'rgba(139,92,246,0.12)', name: 'violeta' },
  { solid: '#f59e0b', soft: 'rgba(245,158,11,0.12)', name: 'ámbar' },
  { solid: '#ec4899', soft: 'rgba(236,72,153,0.12)', name: 'rosa' },
  { solid: '#14b8a6', soft: 'rgba(20,184,166,0.12)', name: 'teal' },
  { solid: '#6366f1', soft: 'rgba(99,102,241,0.12)', name: 'índigo' },
];

export const colorPorIndice = (i) => COLORES_CAJA[i % COLORES_CAJA.length];

// ─── DONA DE DISTRIBUCIÓN DE SALDOS ─────────────────────────────────────────
// Muestra qué caja concentra más saldo. SVG puro con arcos calculados.
export const DonaDistribucion = ({ datos = [], size = 200 }) => {
  const total = datos.reduce((s, d) => s + Math.max(0, d.valor), 0);
  if (total <= 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: size, color: '#94a3b8', fontSize: 13 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🍩</div>
        Sin saldos para graficar
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;
  const grosor = 26;
  const rInterno = r - grosor;

  let anguloAcum = -90; // empezar arriba
  const segmentos = datos
    .filter(d => d.valor > 0)
    .map((d, i) => {
      const proporcion = d.valor / total;
      const angulo = proporcion * 360;
      const inicio = anguloAcum;
      const fin = anguloAcum + angulo;
      anguloAcum = fin;

      const radInicio = (inicio * Math.PI) / 180;
      const radFin = (fin * Math.PI) / 180;
      const x1 = cx + r * Math.cos(radInicio);
      const y1 = cy + r * Math.sin(radInicio);
      const x2 = cx + r * Math.cos(radFin);
      const y2 = cy + r * Math.sin(radFin);
      const xi1 = cx + rInterno * Math.cos(radFin);
      const yi1 = cy + rInterno * Math.sin(radFin);
      const xi2 = cx + rInterno * Math.cos(radInicio);
      const yi2 = cy + rInterno * Math.sin(radInicio);
      const largeArc = angulo > 180 ? 1 : 0;

      const path = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${xi1} ${yi1} A ${rInterno} ${rInterno} 0 ${largeArc} 0 ${xi2} ${yi2} Z`;
      return { path, color: d.color, pct: Math.round(proporcion * 100), nombre: d.nombre, valor: d.valor };
    });

  // La caja con mayor saldo (para el centro)
  const mayor = [...datos].sort((a, b) => b.valor - a.valor)[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segmentos.map((s, i) => (
          <path key={i} d={s.path} fill={s.color} stroke="#fff" strokeWidth="2">
            <title>{s.nombre}: {fmt(s.valor)} ({s.pct}%)</title>
          </path>
        ))}
        {/* Centro: caja con mayor saldo */}
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize="11" fill="#94a3b8" fontWeight="600">Mayor saldo</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize="13" fill="#334155" fontWeight="800">
          {mayor?.nombre?.length > 14 ? mayor.nombre.slice(0, 13) + '…' : mayor?.nombre}
        </text>
      </svg>
      {/* Leyenda */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12, width: '100%' }}>
        {segmentos.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, display: 'inline-block' }} />
              <span style={{ color: '#475569', fontWeight: 600 }}>{s.nombre}</span>
            </div>
            <span style={{ color: '#64748b' }}>{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── GRÁFICA DE FLUJO MENSUAL (ingresos vs egresos por día) ──────────────────
// Barras SVG: ingresos hacia arriba (verde), egresos hacia abajo (rojo).
export const FlujoMensual = ({ movimientos = [], mes, width = 520, height = 200 }) => {
  // Agrupar por día del mes seleccionado — cálculo en memoria, sin queries
  const porDia = {};
  movimientos.forEach(m => {
    // ✅ FIX CAJA-FLUJO-001: fecha normalizada (antes los Timestamps de
    // Firestore daban "[object Object]" y todos los movimientos se descartaban)
    const fecha = fechaMovISO(m);
    if (mes && !fecha.startsWith(mes)) return;
    const dia = fecha.slice(8, 10);
    if (!dia) return;
    if (!porDia[dia]) porDia[dia] = { ingreso: 0, egreso: 0, traslEnt: 0, traslSal: 0 };
    const monto = Math.abs(Number(m.monto) || 0);
    // ✅ MOVIMIENTOS-SIGNO-001: ANTES los traslados se descartaban en silencio
    // (no eran 'ingreso' ni 'egreso'), así que la gráfica NO podía explicar el
    // saldo de la caja: faltaba toda la plata movida entre cajas propias.
    // AHORA se contabilizan, pero SEPARADOS del flujo operativo: un traslado
    // no es venta ni gasto, es dinero cambiando de bolsillo — no toca resultados.
    if (m.tipo === 'ingreso') porDia[dia].ingreso += monto;
    else if (m.tipo === 'egreso') porDia[dia].egreso += monto;
    else if (m.tipo === 'traslado_entrada') porDia[dia].traslEnt += monto;
    else if (m.tipo === 'traslado_salida') porDia[dia].traslSal += monto;
  });

  const dias = Object.keys(porDia).sort();
  if (dias.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height, color: '#94a3b8', fontSize: 13 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
        Sin movimientos este mes
      </div>
    );
  }

  const maxVal = Math.max(
    ...dias.map(d => Math.max(
      porDia[d].ingreso + porDia[d].traslEnt,
      porDia[d].egreso + porDia[d].traslSal
    )),
    1
  );
  const padding = { top: 20, bottom: 24, left: 8, right: 8 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const midY = padding.top + chartH / 2;
  const anchoBarra = Math.max(4, Math.min(18, chartW / dias.length - 4));
  const paso = chartW / dias.length;

  const totalIngreso = dias.reduce((s, d) => s + porDia[d].ingreso, 0);
  const totalEgreso = dias.reduce((s, d) => s + porDia[d].egreso, 0);
  const totalTraslEnt = dias.reduce((s, d) => s + porDia[d].traslEnt, 0);
  const totalTraslSal = dias.reduce((s, d) => s + porDia[d].traslSal, 0);
  const hayTraslados = totalTraslEnt > 0 || totalTraslSal > 0;
  // Variación real del saldo de la caja en el mes. Esta cifra SÍ cuadra contra
  // el saldo: es lo que antes no se podía comprobar desde esta gráfica.
  const netoCaja = (totalIngreso + totalTraslEnt) - (totalEgreso + totalTraslSal);

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#10b981' }} /> Ingresos <strong>{fmt(totalIngreso)}</strong>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#ef4444' }} /> Egresos <strong>{fmt(totalEgreso)}</strong>
        </span>
        {hayTraslados && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: '#94a3b8' }} /> Traslados <strong>+{fmt(totalTraslEnt)} / -{fmt(totalTraslSal)}</strong>
          </span>
        )}
      </div>
      {/* Cuadre: variación neta del saldo de la caja en el mes (operativo + traslados) */}
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
        Variación del saldo en el mes:{' '}
        <strong style={{ color: netoCaja >= 0 ? '#16a34a' : '#dc2626' }}>
          {netoCaja >= 0 ? '+' : '-'}{fmt(Math.abs(netoCaja))}
        </strong>
        {hayTraslados && <span> · incluye traslados entre cajas propias (no son ingresos ni gastos)</span>}
      </div>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {/* Línea base cero */}
        <line x1={padding.left} y1={midY} x2={width - padding.right} y2={midY} stroke="#e2e8f0" strokeWidth="1" />
        {dias.map((d, i) => {
          const x = padding.left + i * paso + (paso - anchoBarra) / 2;
          const esc = (v) => (v / maxVal) * (chartH / 2);
          const hIngreso = esc(porDia[d].ingreso);
          const hEgreso = esc(porDia[d].egreso);
          // Los traslados se apilan en gris sobre la barra operativa: se ven,
          // se suman al saldo, pero no se confunden con ventas ni con gastos.
          const hTraslEnt = esc(porDia[d].traslEnt);
          const hTraslSal = esc(porDia[d].traslSal);
          return (
            <g key={d}>
              {porDia[d].ingreso > 0 && (
                <rect x={x} y={midY - hIngreso} width={anchoBarra} height={hIngreso} rx="2" fill="#10b981">
                  <title>Día {d}: +{fmt(porDia[d].ingreso)}</title>
                </rect>
              )}
              {porDia[d].traslEnt > 0 && (
                <rect x={x} y={midY - hIngreso - hTraslEnt} width={anchoBarra} height={hTraslEnt} rx="2" fill="#94a3b8">
                  <title>Día {d}: traslado recibido +{fmt(porDia[d].traslEnt)}</title>
                </rect>
              )}
              {porDia[d].egreso > 0 && (
                <rect x={x} y={midY} width={anchoBarra} height={hEgreso} rx="2" fill="#ef4444">
                  <title>Día {d}: -{fmt(porDia[d].egreso)}</title>
                </rect>
              )}
              {porDia[d].traslSal > 0 && (
                <rect x={x} y={midY + hEgreso} width={anchoBarra} height={hTraslSal} rx="2" fill="#94a3b8">
                  <title>Día {d}: traslado enviado -{fmt(porDia[d].traslSal)}</title>
                </rect>
              )}
              {/* etiqueta de día cada ciertos pasos para no saturar */}
              {(dias.length <= 15 || i % 3 === 0) && (
                <text x={x + anchoBarra / 2} y={height - 8} textAnchor="middle" fontSize="9" fill="#94a3b8">{d}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};
