// ════════════════════════════════════════════════════════════════════════════
// printCuadreDiario.js — CUADRE DIARIO DE CAJA · Control360 (Ola 3)
// ────────────────────────────────────────────────────────────────────────────
// Documento ejecutivo de cierre del día: saldos por caja con continuidad
// (saldo inicial = saldo final del día anterior), ingresos y egresos del día,
// CxC y CxP del día, detalle de movimientos y espacios de firma.
// Formato carta, membrete con logo de la empresa. Fechas en horario Colombia.
// ════════════════════════════════════════════════════════════════════════════

const fmt = (v) => v === null || v === undefined
  ? '🔒 Reservado'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);

const fechaLargaCO = (f) => {
  try {
    return new Date(`${f}T05:00:00.000Z`).toLocaleDateString('es-CO', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Bogota'
    });
  } catch { return f; }
};

const TIPO_MOV = {
  ingreso: '📥 Ingreso', egreso: '📤 Egreso',
  traslado_entrada: '🔄 Traslado entrada', traslado_salida: '🔄 Traslado salida',
  ajuste: '⚖️ Ajuste',
};

export const generarHTMLCuadreDiario = (cierre, empresa, empresas = []) => {
  const c = cierre;
  const nombresEmpresas = (empresas || []).map(e => e.name).filter(Boolean).join(' · ');

  const filaCaja = (k) => `
    <tr>
      <td style="font-weight:700">${k.esBanco ? '🏦' : '💵'} ${k.nombre}</td>
      <td class="num">${fmt(k.saldoInicial)}</td>
      <td class="num pos">${k.ingresos ? '+' + fmt(k.ingresos) : '—'}</td>
      <td class="num neg">${k.egresos ? '−' + fmt(k.egresos) : '—'}</td>
      <td class="num">${(k.trasladosEntrada || k.trasladosSalida) ? `+${fmt(k.trasladosEntrada)} / −${fmt(k.trasladosSalida)}` : '—'}</td>
      <td class="num" style="font-weight:900">${fmt(k.saldoFinal)}</td>
    </tr>`;

  const filaMov = (m) => `
    <tr>
      <td>${m.hora}</td>
      <td>${m.caja}</td>
      <td>${TIPO_MOV[m.tipo] || m.tipo}</td>
      <td>${m.concepto}${m.referencia ? ` <span style="color:#888">· ${m.referencia}</span>` : ''}</td>
      <td>${m.creadoPor}</td>
      <td class="num ${m.entrada ? 'pos' : 'neg'}">${m.entrada ? '+' : '−'}${fmt(m.monto)}</td>
    </tr>`;

  const seccionLista = (titulo, filasHtml, totalLabel, total) => filasHtml ? `
    <div class="seccion">
      <div class="seccion-titulo">${titulo}</div>
      <table>${filasHtml}</table>
      <div class="seccion-total">${totalLabel}: <strong>${fmt(total)}</strong></div>
    </div>` : '';

  const cxcNuevasHtml = (c.cxc?.nuevas || []).map(x =>
    `<tr><td>${x.numeroOrden}</td><td>${x.clienteNombre}</td><td class="num neg">${fmt(x.monto)}</td></tr>`).join('');
  const cxcCobradasHtml = (c.cxc?.cobradas || []).map(x =>
    `<tr><td>${x.numeroOrden}</td><td>${x.clienteNombre}</td><td class="num pos">${fmt(x.monto)}</td></tr>`).join('');
  const cxpNuevasHtml = (c.cxp?.nuevas || []).map(x =>
    `<tr><td>${x.numero}</td><td>${x.proveedor}</td><td>${x.concepto}</td><td class="num neg">${fmt(x.monto)}</td></tr>`).join('');
  const egresosPagadosHtml = (c.cxp?.pagadasHoy || []).map(x =>
    `<tr><td>${x.numero}</td><td>${x.proveedor}</td><td>${x.concepto} <span style="color:#888">· ${x.formaPago}</span></td><td class="num neg">${fmt(x.monto)}</td></tr>`).join('');
  const movsHtml = (c.movimientosDia || []).map(filaMov).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Cuadre diario ${c.fecha}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #1f2937; width: 216mm; padding: 12mm 14mm; }
    .membrete { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #1f2937; padding-bottom: 10px; margin-bottom: 4px; }
    .membrete-info { text-align: right; font-size: 10px; color: #4b5563; line-height: 1.5; }
    .titulo { text-align: center; margin: 14px 0 2px; font-size: 19px; font-weight: 900; letter-spacing: 2px; color: #111; }
    .subtitulo { text-align: center; font-size: 12px; color: #4b5563; margin-bottom: 14px; text-transform: capitalize; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f3f4f6; text-align: left; padding: 6px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #374151; border-bottom: 2px solid #d1d5db; }
    td { padding: 5px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; }
    .pos { color: #15803d; }
    .neg { color: #b91c1c; }
    .tarjetas { display: flex; gap: 8px; margin: 12px 0; }
    .tarjeta { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; }
    .tarjeta .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; }
    .tarjeta .val { font-size: 15px; font-weight: 900; margin-top: 2px; }
    .seccion { margin-top: 14px; page-break-inside: avoid; }
    .seccion-titulo { font-size: 12px; font-weight: 800; color: #111; border-left: 4px solid #4f46e5; padding-left: 8px; margin-bottom: 6px; }
    .seccion-total { text-align: right; padding: 5px 8px; font-size: 11px; color: #374151; }
    .firmas { display: flex; gap: 40px; margin-top: 44px; page-break-inside: avoid; }
    .firma { flex: 1; text-align: center; }
    .firma .linea { border-top: 1.5px solid #374151; margin-bottom: 5px; }
    .firma .cargo { font-size: 10px; color: #4b5563; }
    .footer { text-align: center; margin-top: 22px; padding-top: 8px; border-top: 1px dashed #d1d5db; font-size: 9px; color: #9ca3af; }
    .nota-reserva { font-size: 9px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 5px 8px; margin-top: 6px; }
    @media print { body { width: 100%; } @page { size: letter; margin: 10mm; } }
  </style></head><body>

  <div class="membrete">
    <div style="display:flex;align-items:center;gap:12px">
      ${empresa?.logo ? `<img src="${empresa.logo}" style="height:64px;max-width:170px;object-fit:contain" />` : ''}
      <div>
        <div style="font-size:15px;font-weight:900">${empresa?.name || ''}</div>
        ${nombresEmpresas && (empresas || []).length > 1 ? `<div style="font-size:9px;color:#6b7280">${nombresEmpresas}</div>` : ''}
      </div>
    </div>
    <div class="membrete-info">
      ${empresa?.nit ? `NIT: ${empresa.nit}<br/>` : ''}
      ${empresa?.address || ''}<br/>
      ${empresa?.cellphone || empresa?.phone || ''}
    </div>
  </div>

  <div class="titulo">${c.modo === 'individual' ? `CUADRE DIARIO — ${(c.cajaNombre || 'CAJA').toUpperCase()}` : 'CUADRE DIARIO DE CAJA · CONSOLIDADO'}</div>
  <div class="subtitulo">${fechaLargaCO(c.fecha)}</div>

  <div class="tarjetas">
    <div class="tarjeta"><div class="lbl">Saldo inicial del día</div><div class="val">${fmt(c.totales?.saldoInicial)}</div></div>
    <div class="tarjeta"><div class="lbl">Ingresos del día</div><div class="val pos">+${fmt(c.totales?.ingresos)}</div></div>
    <div class="tarjeta"><div class="lbl">Egresos del día</div><div class="val neg">−${fmt(c.totales?.egresos)}</div></div>
    <div class="tarjeta" style="background:#f5f3ff;border-color:#c4b5fd"><div class="lbl">Saldo final del día</div><div class="val" style="color:#4f46e5">${fmt(c.totales?.saldoFinal)}</div></div>
  </div>
  ${c.totales?.saldosReservados ? `<div class="nota-reserva">🔒 Los saldos de cuentas bancarias están reservados al administrador. Los totales mostrados corresponden a las cajas visibles para quien genera este documento.</div>` : ''}

  <div class="seccion">
    <div class="seccion-titulo">${c.modo === 'individual' ? 'Continuidad del día — ' + (c.cajaNombre || '') : 'Saldos por caja — continuidad del día'}</div>
    <table>
      <thead><tr><th>Caja</th><th class="num">Saldo inicial<br/><span style="font-weight:400;text-transform:none">(= saldo final día anterior)</span></th><th class="num">Ingresos</th><th class="num">Egresos</th><th class="num">Traslados (+/−)</th><th class="num">Saldo final</th></tr></thead>
      <tbody>${(c.cajas || []).map(filaCaja).join('')}</tbody>
    </table>
  </div>

  ${seccionLista('Cuentas por Cobrar generadas hoy (ventas a crédito)', cxcNuevasHtml, 'Total CxC nuevas', c.cxc?.totalNuevas)}
  ${seccionLista('Cartera recuperada hoy (CxC cobradas)', cxcCobradasHtml, 'Total recuperado', c.cxc?.totalCobradas)}
  ${seccionLista('Cuentas por Pagar registradas hoy', cxpNuevasHtml, 'Total CxP nuevas', c.cxp?.totalNuevas)}
  ${seccionLista('Egresos pagados hoy', egresosPagadosHtml, 'Total pagado', c.cxp?.totalPagadasHoy)}

  <div class="seccion">
    <div class="seccion-titulo">Detalle de movimientos del día (${(c.movimientosDia || []).length})</div>
    ${movsHtml ? `<table>
      <thead><tr><th>Hora</th><th>Caja</th><th>Tipo</th><th>Concepto</th><th>Registró</th><th class="num">Monto</th></tr></thead>
      <tbody>${movsHtml}</tbody>
    </table>` : '<div style="color:#9ca3af;padding:8px">Sin movimientos en este día.</div>'}
  </div>

  <div class="firmas">
    <div class="firma"><div class="linea"></div><div class="cargo">Elaborado por<br/><strong>${c.generadoPor || ''}</strong></div></div>
    <div class="firma"><div class="linea"></div><div class="cargo">Revisado por</div></div>
    <div class="firma"><div class="linea"></div><div class="cargo">Aprobado por</div></div>
  </div>

  <div class="footer">
    Documento generado con Control360 — Sistema operativo para empresas de servicios · ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}
  </div>
  </body></html>`;
};

export const abrirImpresionCuadreDiario = (cierre, empresa, empresas = []) => {
  const contenido = generarHTMLCuadreDiario(cierre, empresa, empresas);
  const ventana = window.open('', '_blank');
  if (!ventana) return false;
  ventana.document.write(contenido);
  ventana.document.close();
  ventana.focus();
  setTimeout(() => { ventana.print(); }, 500);
  return true;
};
