// ═══════════════════════════════════════════════════════════════════════════════
// comprobantePrestamo.js — Comprobante de préstamo de nómina para firmar
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PRESTAMO-001
//
// El trabajador firma ESTE papel: es la autorización escrita que exige el CST
// (arts. 149 y 151) para descontarle el préstamo del salario. Por eso el texto
// sale de los datos que el sistema congeló al crear el préstamo — nombre,
// cédula, salario del contrato, valor y fecha de descuento — y nadie vuelve a
// digitarlo. Un préstamo anulado se imprime con la marca ANULADO.
// ═══════════════════════════════════════════════════════════════════════════════

const money = (n) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(Number(n) || 0);

const fecha = (iso) => {
  const f = String(iso || '').slice(0, 10);
  if (f.length !== 10) return '—';
  return new Date(f + 'T12:00:00').toLocaleDateString('es-CO',
    { day: '2-digit', month: 'long', year: 'numeric' });
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Abre el comprobante en una ventana para imprimir o guardar en PDF.
 * @param {object} p { prestamo } — el objeto que devuelve /api/prestamos-nomina
 */
export function imprimirComprobantePrestamo({ prestamo: p }) {
  if (!p) return;

  const anulado = p.estado === 'ANULADO';
  const empresa = p.empresaNombre || 'LA EMPRESA';
  const entrega = p.formaEntrega === 'Transferencia' ? 'transferencia' : 'efectivo';
  const tipoDoc = p.empleadoTipoDocumento || 'CC';

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Comprobante de préstamo ${esc(p.numero)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 12.5px; line-height: 1.55; margin: 0; padding: 0; position: relative; }
  .encabezado { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0f172a; padding-bottom: 12px; margin-bottom: 18px; gap: 12px; }
  .empresa { font-size: 17px; font-weight: 800; }
  .nit { font-size: 11.5px; color: #475569; margin-top: 2px; }
  .titulo { text-align: right; }
  .titulo h1 { margin: 0; font-size: 15px; letter-spacing: .03em; text-transform: uppercase; }
  .numero { font-size: 22px; font-weight: 800; color: #b45309; margin-top: 3px; }
  table.datos { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  table.datos td { padding: 7px 10px; border: 1px solid #cbd5e1; vertical-align: top; }
  table.datos td.k { background: #f1f5f9; font-weight: 700; width: 30%; color: #334155; }
  .valor { text-align: center; border: 2px solid #0f172a; border-radius: 8px; padding: 12px; margin: 16px 0; }
  .valor .monto { font-size: 26px; font-weight: 800; }
  .valor .letras { font-size: 12.5px; color: #475569; text-transform: capitalize; margin-top: 2px; }
  .bloque { margin: 14px 0; text-align: justify; }
  .bloque h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 6px; color: #334155; }
  .firmas { display: flex; gap: 40px; margin-top: 70px; }
  .firma { flex: 1; text-align: center; }
  .firma-linea { border-top: 1.5px solid #0f172a; padding-top: 6px; font-size: 11.5px; }
  .firma-linea b { display: block; font-size: 12.5px; }
  .huella { font-size: 10.5px; color: #64748b; margin-top: 3px; }
  .pie { margin-top: 36px; font-size: 10.5px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  .marca { position: fixed; top: 38%; left: 8%; right: 8%; text-align: center; font-size: 110px; font-weight: 900; color: rgba(220,38,38,0.16); transform: rotate(-24deg); letter-spacing: 8px; pointer-events: none; }
  .anulado-info { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 8px 12px; border-radius: 6px; margin-bottom: 14px; font-size: 11.5px; }
  @media print { .no-print { display: none; } }
  .no-print { text-align: center; margin-bottom: 14px; }
  .no-print button { padding: 9px 22px; font-size: 13px; font-weight: 700; border: none; border-radius: 8px; background: #4f46e5; color: #fff; cursor: pointer; }
</style></head><body>
${anulado ? '<div class="marca">ANULADO</div>' : ''}
<div class="no-print"><button onclick="window.print()">🖨️ Imprimir</button></div>

<div class="encabezado">
  <div>
    <div class="empresa">${esc(empresa)}</div>
    <div class="nit">NIT ${esc(p.empresaNit || '—')}</div>
  </div>
  <div class="titulo">
    <h1>Comprobante de préstamo de nómina</h1>
    <div class="numero">No. ${esc(p.numero)}</div>
  </div>
</div>

${anulado ? `<div class="anulado-info"><b>Documento anulado</b>${p.motivoAnulacion ? ` · ${esc(p.motivoAnulacion)}` : ''}${p.anuladoPor ? ` · por ${esc(p.anuladoPor)}` : ''}. No tiene validez para descuento.</div>` : ''}

<table class="datos">
  <tr><td class="k">Fecha de solicitud</td><td>${fecha(p.fechaSolicitud)}</td></tr>
  <tr><td class="k">Trabajador</td><td><b>${esc(p.empleadoNombre)}</b></td></tr>
  <tr><td class="k">Documento de identidad</td><td>${esc(tipoDoc)} ${esc(p.empleadoDocumento)}</td></tr>
  <tr><td class="k">Cargo</td><td>${esc(p.empleadoCargo || '—')}</td></tr>
  <tr><td class="k">Salario según contrato</td><td>${money(p.salarioContrato)}</td></tr>
  <tr><td class="k">Entrega del dinero</td><td style="text-transform:capitalize">${esc(entrega)}</td></tr>
  <tr><td class="k">Se descuenta en el pago del</td><td><b>${fecha(p.fechaDescuento)}</b></td></tr>
</table>

<div class="valor">
  <div class="monto">${money(p.valor)}</div>
  <div class="letras">(${esc(p.valorEnLetras)})</div>
</div>

<div class="bloque">
  <h2>Autorización de descuento</h2>
  Yo, <b>${esc(p.empleadoNombre)}</b>, identificado(a) con ${esc(tipoDoc)} No. <b>${esc(p.empleadoDocumento)}</b>,
  autorizo de manera expresa, previa y escrita a <b>${esc(empresa)}</b> para descontar de mi salario,
  en el pago correspondiente al <b>${fecha(p.fechaDescuento)}</b>, el valor total de este préstamo,
  <b>${money(p.valor)}</b> (${esc(p.valorEnLetras)}), en una sola cuota y <b>sin intereses</b>.
  Esta autorización aplica únicamente a este préstamo. Si mi contrato termina antes de esa fecha,
  autorizo que el saldo se descuente de mi liquidación final (arts. 149 y 151 del Código Sustantivo del Trabajo).
</div>

<div class="bloque">
  Declaro que recibí el dinero en ${esc(entrega)} el día ${fecha(p.fechaSolicitud)}, que firmo de manera
  libre y voluntaria y que recibo copia de este documento.
</div>

<div class="firmas">
  <div class="firma">
    <div class="firma-linea">
      <b>${esc(p.empleadoNombre)}</b>
      ${esc(tipoDoc)} ${esc(p.empleadoDocumento)} · Trabajador
    </div>
    <div class="huella">Firma y fecha</div>
  </div>
  <div class="firma">
    <div class="firma-linea">
      <b>${esc(empresa)}</b>
      NIT ${esc(p.empresaNit || '—')} · Quien autoriza
    </div>
    <div class="huella">Firma y fecha</div>
  </div>
</div>

<div class="pie">Documento generado por Control360 · ${esc(p.numero)}</div>
</body></html>`;

  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) {
    alert('El navegador bloqueó la ventana emergente. Permítela para poder imprimir el comprobante.');
    return;
  }
  w.document.write(html);
  w.document.close();
}

export default imprimirComprobantePrestamo;
