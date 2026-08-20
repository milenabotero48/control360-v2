// ═══════════════════════════════════════════════════════════════════════════════
// actaLiquidacion.js — Acta de liquidación para que el trabajador firme
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-ACTA-001
//
// POR QUÉ EXISTE
// --------------
// La liquidación generaba la cuenta por pagar pero no producía documento. El
// suscriptor tenía que volver a digitar todo en una plantilla de Excel aparte
// — y ahí es donde se cuelan los errores: en el caso que lo destapó, la
// plantilla calculaba las VACACIONES con la misma fórmula que las cesantías
// (8,33% en vez de 4,17%), sobrepagando $138.330 en una sola liquidación.
//
// Si el sistema calcula bien pero el papel se hace aparte, el sistema no sirve.
//
// SOBRE EL PAZ Y SALVO
// --------------------
// La constancia dice que el trabajador RECIBIÓ los valores, no que renuncie a
// nada. En Colombia los derechos laborales son irrenunciables (art. 14 CST):
// una cláusula de renuncia general no vale, y ponerla solo da falsa seguridad.
//
// Usa el mismo patrón de impresión que el comprobante de egreso: se arma el
// HTML, se abre en una ventana y se imprime o se guarda como PDF.
// ═══════════════════════════════════════════════════════════════════════════════

const money = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(Number(n) || 0);

const fecha = (iso) => {
  const f = String(iso || '').slice(0, 10);
  if (f.length !== 10) return '—';
  return new Date(f + 'T00:00:00').toLocaleDateString('es-CO',
    { day: '2-digit', month: 'long', year: 'numeric' });
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tiempo laborado en años, meses y días comerciales. */
const tiempoLaborado = (dias) => {
  const d = Number(dias) || 0;
  const anios = Math.floor(d / 360);
  const meses = Math.floor((d % 360) / 30);
  const dd = d % 30;
  return [
    anios > 0 ? `${anios} año${anios > 1 ? 's' : ''}` : null,
    meses > 0 ? `${meses} mes${meses > 1 ? 'es' : ''}` : null,
    dd > 0 ? `${dd} día${dd > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(', ') || '0 días';
};

/**
 * Abre el acta de liquidación en una ventana para imprimir o guardar en PDF.
 *
 * @param {object} p {
 *   liquidacion,   // objeto devuelto por liquidarContrato
 *   empleado,      // { nombre, documento, tipoDocumento, cargo }
 *   empresa,       // { name/nombre, nit, address }
 *   numero,        // consecutivo del documento
 * }
 */
export function imprimirActaLiquidacion({ liquidacion: L, empleado = {}, empresa = {}, numero = '' }) {
  if (!L) return;

  const nombreEmpresa = empresa?.name || empresa?.nombre || 'EMPRESA';
  const diasTotales = L.prestaciones?.vacaciones?.dias
    ?? L.prestaciones?.cesantias?.dias ?? 0;

  // ── Devengados ────────────────────────────────────────────────────────────
  const devengados = [];
  if (L.salarioPendiente > 0) {
    devengados.push({
      concepto: `Salario pendiente (${L.diasSalarioPendiente} días)`,
      valor: L.salarioPendiente
    });
  }
  if (L.auxilioPendiente > 0) {
    devengados.push({ concepto: 'Auxilio de transporte', valor: L.auxilioPendiente });
  }
  for (const p of Object.values(L.prestaciones || {})) {
    devengados.push({
      concepto: p.etiqueta,
      detalle: p.dias != null ? `${p.dias} días` : '',
      valor: p.valor
    });
  }
  for (const o of (L.otrosDevengados || [])) {
    devengados.push({ concepto: o.concepto, valor: o.valor });
  }
  if (L.indemnizacion && L.indemnizacion.valor > 0) {
    devengados.push({
      concepto: 'Indemnización por despido sin justa causa',
      detalle: `Art. 64 CST · ${L.indemnizacion.dias} días`,
      valor: L.indemnizacion.valor,
      destacado: true
    });
  }
  const totalDevengado = devengados.reduce((a, d) => a + (Number(d.valor) || 0), 0);

  // ── Deducciones ───────────────────────────────────────────────────────────
  const deducciones = (L.deducciones || []).map(d => ({
    concepto: d.etiqueta,
    detalle: d.esCruceAnticipo && d.detalle
      ? d.detalle.map(x => x.numero).filter(Boolean).join(', ')
      : '',
    valor: d.valor
  }));

  const filas = (lista, negativo) => lista.map(d => `
    <tr>
      <td class="c">${esc(d.concepto)}${d.detalle ? `<span class="det">${esc(d.detalle)}</span>` : ''}</td>
      <td class="v${negativo ? ' neg' : ''}${d.destacado ? ' dest' : ''}">${negativo ? '−' : ''}${money(d.valor)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Acta de liquidación · ${esc(empleado.nombre)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color:#1f2937;
         padding: 14mm; max-width: 190mm; margin: 0 auto; line-height: 1.45; }
  .head { display:flex; justify-content:space-between; align-items:flex-start;
          border-bottom: 3px solid #4c1d95; padding-bottom: 10px; margin-bottom: 14px; gap:16px; }
  .emp-nombre { font-size: 16px; font-weight: 900; color:#1e1b4b; letter-spacing:.3px; }
  .emp-datos { font-size: 9.5px; color:#6b7280; margin-top:3px; }
  .doc-box { border:2px solid #4c1d95; border-radius:6px; padding:7px 14px; text-align:center; min-width:130px; }
  .doc-label { font-size: 8.5px; font-weight:700; color:#6b7280; text-transform:uppercase; letter-spacing:.6px; }
  .doc-num { font-size: 17px; font-weight:900; color:#4c1d95; }
  h1 { font-size: 13px; text-transform: uppercase; letter-spacing: 1.1px; text-align:center;
       margin: 4px 0 14px; color:#1e1b4b; font-weight:900; }
  .datos { display:grid; grid-template-columns: repeat(3, 1fr); gap:9px 16px;
           background:#f8fafc; border:1px solid #e5e7eb; border-radius:6px; padding:11px 14px; margin-bottom:14px; }
  .campo-l { font-size:8.5px; font-weight:700; color:#9ca3af; text-transform:uppercase; letter-spacing:.4px; }
  .campo-v { font-size:11.5px; font-weight:700; color:#111827; margin-top:1px; }
  h2 { font-size:10px; text-transform:uppercase; letter-spacing:.8px; color:#4c1d95;
       border-bottom:1.5px solid #ddd6fe; padding-bottom:4px; margin:14px 0 4px; font-weight:800; }
  table { width:100%; border-collapse:collapse; }
  td { padding: 5px 0; border-bottom:1px solid #f1f5f9; vertical-align:top; }
  td.c { font-size:11px; }
  td.v { text-align:right; font-weight:700; white-space:nowrap; width:34%; font-size:11.5px; }
  td.v.neg { color:#b91c1c; }
  td.v.dest { color:#b45309; }
  .det { display:block; font-size:9px; color:#9ca3af; font-weight:400; margin-top:1px; }
  .subtotal td { border-top:1.5px solid #cbd5e1; border-bottom:none; padding-top:7px;
                 font-weight:800; font-size:11.5px; }
  .neto { display:flex; justify-content:space-between; align-items:center;
          background:#4c1d95; color:#fff; border-radius:7px; padding:13px 18px; margin-top:14px; }
  .neto-l { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.8px; opacity:.9; }
  .neto-v { font-size:22px; font-weight:900; }
  .constancia { margin-top:16px; border:1px solid #e5e7eb; border-radius:6px; padding:11px 14px;
                font-size:9.5px; color:#4b5563; line-height:1.65; }
  .constancia b { color:#1f2937; }
  .constancia ol { margin:6px 0 0 16px; }
  .constancia li { margin-bottom:4px; }
  .firmas { display:flex; justify-content:space-between; gap:24px; margin-top:34px; }
  .firma { width:47%; text-align:center; }
  .firma-linea { border-top:1px solid #374151; padding-top:5px; margin-top:44px;
                 font-size:9.5px; color:#4b5563; }
  .firma-linea b { display:block; color:#111827; font-size:10.5px; }
  .pie { text-align:center; margin-top:16px; padding-top:9px; border-top:1px dashed #d1d5db;
         font-size:8.5px; color:#9ca3af; }
  @media print { body { padding: 10mm; } .noprint { display:none; } }
  .noprint { text-align:center; margin-bottom:14px; }
  .btn { background:#4c1d95; color:#fff; border:none; padding:9px 20px; border-radius:6px;
         font-size:12px; font-weight:700; cursor:pointer; }
</style></head><body>

<div class="noprint">
  <button class="btn" onclick="window.print()">Imprimir o guardar como PDF</button>
</div>

<div class="head">
  <div>
    <div class="emp-nombre">${esc(nombreEmpresa)}</div>
    <div class="emp-datos">
      NIT: ${esc(empresa?.nit || '—')}${empresa?.address ? ` &nbsp;|&nbsp; ${esc(empresa.address)}` : ''}
    </div>
  </div>
  <div class="doc-box">
    <div class="doc-label">Liquidación N°</div>
    <div class="doc-num">${esc(numero || '—')}</div>
  </div>
</div>

<h1>Acta de liquidación de contrato de trabajo</h1>

<div class="datos">
  <div><div class="campo-l">Trabajador</div><div class="campo-v">${esc(empleado.nombre)}</div></div>
  <div><div class="campo-l">${esc(empleado.tipoDocumento || 'CC')}</div><div class="campo-v">${esc(empleado.documento || '—')}</div></div>
  <div><div class="campo-l">Cargo</div><div class="campo-v">${esc(empleado.cargo || '—')}</div></div>
  <div><div class="campo-l">Tipo de contrato</div><div class="campo-v">${esc(L.tipoContratoEtiqueta || '—')}</div></div>
  <div><div class="campo-l">Fecha de ingreso</div><div class="campo-v">${fecha(L.fechaInicio)}</div></div>
  <div><div class="campo-l">Fecha de retiro</div><div class="campo-v">${fecha(L.fechaRetiro)}</div></div>
  <div><div class="campo-l">Tiempo laborado</div><div class="campo-v">${tiempoLaborado(diasTotales)}</div></div>
  <div style="grid-column: span 2"><div class="campo-l">Causa de terminación</div><div class="campo-v">${esc(L.motivoEtiqueta || '—')}</div></div>
</div>

<h2>Devengados</h2>
<table>
  ${filas(devengados, false)}
  <tr class="subtotal"><td class="c">Total devengado</td><td class="v">${money(totalDevengado)}</td></tr>
</table>

${deducciones.length ? `
<h2>Deducciones</h2>
<table>
  ${filas(deducciones, true)}
  <tr class="subtotal"><td class="c">Total deducciones</td><td class="v neg">−${money(L.totalDeducciones)}</td></tr>
</table>` : ''}

<div class="neto">
  <span class="neto-l">Neto a pagar al trabajador</span>
  <span class="neto-v">${money(L.netoAPagar)}</span>
</div>

<div class="constancia">
  <b>SE HACE CONSTAR:</b>
  <ol>
    <li>Que la presente liquidación comprende los valores causados a favor del trabajador por
        salarios, auxilio de transporte, cesantías, intereses a las cesantías, prima de servicios,
        vacaciones${L.indemnizacion && L.indemnizacion.valor > 0 ? ' e indemnización' : ''}, con
        ocasión de la terminación del contrato de trabajo.</li>
    <li>Que las deducciones aplicadas corresponden a los aportes de ley a cargo del trabajador
        y a los valores que le fueron entregados como anticipos o préstamos durante la relación laboral,
        los cuales el trabajador autoriza descontar de esta liquidación.</li>
    <li>Que el trabajador recibe a satisfacción la suma de <b>${money(L.netoAPagar)}</b>
        como pago de la presente liquidación.</li>
    <li>Que las cesantías consignadas en el fondo con anterioridad a esta fecha no hacen parte de
        esta liquidación y el trabajador las reclama directamente ante la entidad administradora.</li>
  </ol>
</div>

<div class="firmas">
  <div class="firma">
    <div class="firma-linea">
      <b>${esc(nombreEmpresa)}</b>
      NIT ${esc(empresa?.nit || '—')} · Empleador
    </div>
  </div>
  <div class="firma">
    <div class="firma-linea">
      <b>${esc(empleado.nombre)}</b>
      ${esc(empleado.tipoDocumento || 'CC')} ${esc(empleado.documento || '')} · Trabajador
    </div>
  </div>
</div>

<div class="pie">
  Documento generado por Control360 el ${fecha(new Date().toLocaleDateString('en-CA'))} ·
  Elaborar en dos ejemplares del mismo tenor
</div>

</body></html>`;

  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) {
    alert('El navegador bloqueó la ventana emergente. Permitila para poder imprimir el acta.');
    return;
  }
  w.document.write(html);
  w.document.close();
}

export default imprimirActaLiquidacion;
