// ═══════════════════════════════════════════════════════════════════════════════
// comprobanteNomina.js — Colilla de pago para que el trabajador firme
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-COLILLA-001
//
// POR QUÉ EXISTE
// --------------
// El comprobante de nómina calculaba bien y creaba el egreso, pero no producía
// papel. El suscriptor volvía a digitar todo en una plantilla de Excel para
// hacérselo firmar al trabajador — y ahí se colaban los errores: en el caso
// que lo destapó, quien la llenó puso el valor de la prima en la casilla de
// vacaciones y viceversa.
//
// Un cálculo correcto que se vuelve a digitar a mano deja de ser correcto.
//
// QUÉ MUESTRA
//   · Devengados con el desglose completo, incluidas horas extras por tipo
//   · Deducciones de ley y anticipos cruzados, con su número de egreso
//   · Neto pagado y firma de recibido
//   · El costo real para la empresa, solo en la copia del empleador
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

/**
 * Abre la colilla de pago en una ventana para imprimir o guardar en PDF.
 *
 * @param {object} p {
 *   liquidacion,   // objeto devuelto por liquidarNomina
 *   empleado,      // { nombre, documento, tipoDocumento, cargo }
 *   empresa,       // { name/nombre, nit, address }
 *   numero,        // número del comprobante de egreso
 *   incluirCostoEmpresa  // muestra el bloque de costo real (copia interna)
 * }
 */
export function imprimirComprobanteNomina({
  liquidacion: L, empleado = {}, empresa = {}, numero = '', incluirCostoEmpresa = true
}) {
  if (!L) return;

  const nombreEmpresa = empresa?.name || empresa?.nombre || 'EMPRESA';
  const per = L.periodo || {};

  const filas = (lista, negativo) => lista.map(d => `
    <tr>
      <td class="c">${esc(d.etiqueta || d.concepto)}${d.detalle ? `<span class="det">${esc(d.detalle)}</span>` : ''}</td>
      <td class="v${negativo ? ' neg' : ''}">${negativo ? '−' : ''}${money(d.valor)}</td>
    </tr>`).join('');

  const devengados = (L.devengados || []).map(d => ({
    etiqueta: d.etiqueta,
    detalle: d.esSalarial === false ? 'No constituye salario' : '',
    valor: d.valor
  }));

  const deducciones = (L.deducciones || []).map(d => ({
    etiqueta: d.etiqueta,
    detalle: d.esCruceAnticipo && d.detalle
      ? `Egresos: ${d.detalle.map(x => x.numero).filter(Boolean).join(', ')}`
      : '',
    valor: d.valor
  }));

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Comprobante de nómina · ${esc(empleado.nombre)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color:#1f2937;
         padding: 14mm; max-width: 190mm; margin: 0 auto; line-height: 1.45; }
  .head { display:flex; justify-content:space-between; align-items:flex-start;
          border-bottom: 3px solid #15803d; padding-bottom: 10px; margin-bottom: 14px; gap:16px; }
  .emp-nombre { font-size: 16px; font-weight: 900; color:#14532d; letter-spacing:.3px; }
  .emp-datos { font-size: 9.5px; color:#6b7280; margin-top:3px; }
  .doc-box { border:2px solid #15803d; border-radius:6px; padding:7px 14px; text-align:center; min-width:130px; }
  .doc-label { font-size: 8.5px; font-weight:700; color:#6b7280; text-transform:uppercase; letter-spacing:.6px; }
  .doc-num { font-size: 17px; font-weight:900; color:#15803d; }
  h1 { font-size: 13px; text-transform: uppercase; letter-spacing: 1.1px; text-align:center;
       margin: 4px 0 14px; color:#14532d; font-weight:900; }
  .datos { display:grid; grid-template-columns: repeat(3, 1fr); gap:9px 16px;
           background:#f8fafc; border:1px solid #e5e7eb; border-radius:6px; padding:11px 14px; margin-bottom:14px; }
  .campo-l { font-size:8.5px; font-weight:700; color:#9ca3af; text-transform:uppercase; letter-spacing:.4px; }
  .campo-v { font-size:11.5px; font-weight:700; color:#111827; margin-top:1px; }
  h2 { font-size:10px; text-transform:uppercase; letter-spacing:.8px; color:#15803d;
       border-bottom:1.5px solid #bbf7d0; padding-bottom:4px; margin:14px 0 4px; font-weight:800; }
  table { width:100%; border-collapse:collapse; }
  td { padding: 5px 0; border-bottom:1px solid #f1f5f9; vertical-align:top; }
  td.c { font-size:11px; }
  td.v { text-align:right; font-weight:700; white-space:nowrap; width:34%; font-size:11.5px; }
  td.v.neg { color:#b91c1c; }
  .det { display:block; font-size:9px; color:#9ca3af; font-weight:400; margin-top:1px; }
  .subtotal td { border-top:1.5px solid #cbd5e1; border-bottom:none; padding-top:7px;
                 font-weight:800; font-size:11.5px; }
  .neto { display:flex; justify-content:space-between; align-items:center;
          background:#15803d; color:#fff; border-radius:7px; padding:13px 18px; margin-top:14px; }
  .neto-l { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.8px; opacity:.9; }
  .neto-v { font-size:22px; font-weight:900; }
  .costo { margin-top:14px; border:1px dashed #cbd5e1; border-radius:6px; padding:10px 14px;
           background:#f8fafc; font-size:9.5px; color:#64748b; }
  .costo-t { font-weight:800; color:#334155; text-transform:uppercase; font-size:8.5px;
             letter-spacing:.5px; margin-bottom:5px; }
  .costo-row { display:flex; justify-content:space-between; padding:2px 0; }
  .constancia { margin-top:16px; border:1px solid #e5e7eb; border-radius:6px; padding:11px 14px;
                font-size:9.5px; color:#4b5563; line-height:1.65; }
  .firmas { display:flex; justify-content:space-between; gap:24px; margin-top:30px; }
  .firma { width:47%; text-align:center; }
  .firma-linea { border-top:1px solid #374151; padding-top:5px; margin-top:44px;
                 font-size:9.5px; color:#4b5563; }
  .firma-linea b { display:block; color:#111827; font-size:10.5px; }
  .pie { text-align:center; margin-top:16px; padding-top:9px; border-top:1px dashed #d1d5db;
         font-size:8.5px; color:#9ca3af; }
  @media print { body { padding: 10mm; } .noprint { display:none; } }
  .noprint { text-align:center; margin-bottom:14px; }
  .btn { background:#15803d; color:#fff; border:none; padding:9px 20px; border-radius:6px;
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
    <div class="doc-label">Comprobante N°</div>
    <div class="doc-num">${esc(numero || '—')}</div>
  </div>
</div>

<h1>Comprobante de pago de nómina</h1>

<div class="datos">
  <div><div class="campo-l">Trabajador</div><div class="campo-v">${esc(empleado.nombre || L.nombre)}</div></div>
  <div><div class="campo-l">${esc(empleado.tipoDocumento || 'CC')}</div><div class="campo-v">${esc(empleado.documento || L.documento || '—')}</div></div>
  <div><div class="campo-l">Cargo</div><div class="campo-v">${esc(empleado.cargo || L.cargo || '—')}</div></div>
  <div><div class="campo-l">Período</div><div class="campo-v">${fecha(per.desde)} a ${fecha(per.hasta)}</div></div>
  <div><div class="campo-l">Días laborados</div><div class="campo-v">${per.diasTrabajados ?? '—'}</div></div>
  <div><div class="campo-l">Tipo de contrato</div><div class="campo-v">${esc(L.tipoContratoEtiqueta || '—')}</div></div>
</div>

<h2>Devengados</h2>
<table>
  ${filas(devengados, false)}
  <tr class="subtotal"><td class="c">Total devengado</td><td class="v">${money(L.totalDevengado)}</td></tr>
</table>

${deducciones.length ? `
<h2>Deducciones</h2>
<table>
  ${filas(deducciones, true)}
  <tr class="subtotal"><td class="c">Total deducciones</td><td class="v neg">−${money(L.totalDeducciones)}</td></tr>
</table>` : ''}

<div class="neto">
  <span class="neto-l">Neto pagado al trabajador</span>
  <span class="neto-v">${money(L.netoAPagar)}</span>
</div>

${incluirCostoEmpresa && L.provision ? `
<div class="costo">
  <div class="costo-t">Costo real para la empresa · información interna</div>
  <div class="costo-row"><span>Devengado del período</span><span>${money(L.totalDevengado)}</span></div>
  <div class="costo-row"><span>Prestaciones sociales causadas (21,83%)</span><span>${money(L.provision.totalPrestaciones)}</span></div>
  <div class="costo-row"><span>Aportes patronales</span><span>${money(L.provision.totalSeguridadSocial)}</span></div>
  <div class="costo-row" style="border-top:1px solid #cbd5e1;margin-top:4px;padding-top:5px;font-weight:800;color:#334155">
    <span>Costo total</span><span>${money(L.costoTotalEmpleador)}</span>
  </div>
</div>` : ''}

<div class="constancia">
  Declaro que recibí de <b>${esc(nombreEmpresa)}</b> la suma de
  <b>${money(L.netoAPagar)}</b> por concepto de la nómina del período
  ${fecha(per.desde)} a ${fecha(per.hasta)}, con el desglose de devengados y
  deducciones que aparece en este documento, el cual acepto a satisfacción.
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
      <b>${esc(empleado.nombre || L.nombre)}</b>
      ${esc(empleado.tipoDocumento || 'CC')} ${esc(empleado.documento || L.documento || '')} · Recibí conforme
    </div>
  </div>
</div>

<div class="pie">
  Documento generado por Control360 el ${fecha(new Date().toLocaleDateString('en-CA'))}
</div>

</body></html>`;

  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) {
    alert('El navegador bloqueó la ventana emergente. Permitila para poder imprimir el comprobante.');
    return;
  }
  w.document.write(html);
  w.document.close();
}

export default imprimirComprobanteNomina;
