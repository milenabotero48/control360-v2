// ════════════════════════════════════════════════════════════════════════════
// printOrden.js — PLANTILLA ÚNICA DE IMPRESIÓN DE ÓRDENES · Control360
// ────────────────────────────────────────────────────────────────────────────
// Una sola fuente de verdad para la impresión de órdenes de servicio.
// La usan NuevaOrden.js (impresión al crear) y DetalleOrden.js (impresión
// desde el detalle). Cualquier ajuste futuro de diseño se hace SOLO aquí.
//
// Formatos:
//   'pos'   → tirilla térmica, blanco y negro. El ancho NO está quemado:
//             se lee de empresa.anchoImpresoraPos (58 por defecto, soporta 80).
//             Todo escala proporcionalmente al ancho (logo, letra, márgenes).
//   'carta' → media carta 148mm con el logo grande corregido.
//
// Datos del cliente: SIEMPRE completos, con fallbacks:
//   Teléfono  → clienteCelular, o clienteTelefono
//   Dirección → sucursalDireccion, o clienteDireccionPrincipal, o clienteDireccion
//
// Fechas: SIEMPRE en horario de Colombia (America/Bogota), sin importar la
// zona horaria del dispositivo que imprime.
// ════════════════════════════════════════════════════════════════════════════

const formatCOP = (v) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v || 0);

// Fecha en horario Colombia. Acepta "YYYY-MM-DD" o ISO completo ("...T05:00:00Z").
const formatFechaCO = (f) => {
  if (!f) return '—';
  try {
    // "YYYY-MM-DD" plano → interpretarlo como medianoche Colombia (05:00 UTC)
    const esFechaPlana = typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f);
    const d = new Date(esFechaPlana ? `${f}T05:00:00.000Z` : f);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-CO', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Bogota'
    });
  } catch {
    return '—';
  }
};

// Subtotal del ítem: usa el guardado por el backend; si no existe (órdenes
// viejas o recién mapeadas), lo calcula.
const subtotalItem = (item) => {
  if (typeof item.subtotalItem === 'number') return item.subtotalItem;
  return Math.round((item.precioUnitario || 0) * (item.cantidad || 1) * (1 - (item.descuento || 0) / 100));
};

// ─── DATOS DEL CLIENTE CON FALLBACKS ─────────────────────────────────────────
const datosCliente = (orden) => ({
  nombre: orden.clienteNombre || '',
  nit: orden.clienteNit || '',
  telefono: orden.clienteCelular || orden.clienteTelefono || '',
  direccion: orden.sucursalDireccion || orden.clienteDireccionPrincipal || orden.clienteDireccion || '',
  sede: orden.sucursalNombre || ''
});

// ════════════════════════════════════════════════════════════════════════════
// generarHTMLImpresionOrden(orden, empresa, formato)
//   formato: 'pos' | 'tirilla' → tirilla térmica B/N
//            cualquier otro valor ('carta', 'media') → media carta
// ════════════════════════════════════════════════════════════════════════════
export const generarHTMLImpresionOrden = (orden, empresa, formato = 'carta') => {
  const isPos = formato === 'pos' || formato === 'tirilla';

  // ── Ancho POS configurable por suscriptor (Mi Empresa) ────────────────────
  // 58mm por defecto. Si el suscriptor configura 80mm, TODO escala: ancho del
  // cuerpo, logo y tipografía. Así una térmica de 80 no imprime una columna
  // angosta de 58 con papel desperdiciado.
  const anchoPosNum = Math.max(48, Math.min(112, Number(empresa?.anchoImpresoraPos) || 58));
  const esc = isPos ? anchoPosNum / 58 : 1; // factor de escala tipográfica POS
  const px = (base) => `${Math.round(base * esc)}px`;

  const ancho = isPos ? `${anchoPosNum}mm` : '148mm';
  const anchoLogoPos = `${Math.max(40, anchoPosNum - 6)}mm`;

  const cli = datosCliente(orden);

  const items = (orden.items || []).map(item => `
    <tr>
      <td>${item.nombre || ''}${item.notas ? `<br/><small style="color:#666">${item.notas}</small>` : ''}</td>
      <td style="text-align:center">${item.cantidad || 1}</td>
      ${isPos ? '' : `<td style="text-align:right">${formatCOP(item.precioUnitario)}</td>`}
      ${isPos ? '' : (item.descuento > 0 ? `<td style="text-align:center;color:#dc2626">-${item.descuento}%</td>` : '<td></td>')}
      <td style="text-align:right;font-weight:bold">${formatCOP(subtotalItem(item))}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>${orden.numeroOrden || 'Orden de Servicio'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Courier New', monospace; font-size: ${isPos ? px(14) : '11px'}; color: ${isPos ? '#000' : '#333'}; width: ${ancho}; margin: 0; padding: ${isPos ? '2mm 2mm' : '8mm'}; font-weight: ${isPos ? '600' : '400'}; }
    .header { text-align: center; border-bottom: ${isPos ? '3px solid #000' : '2px solid #333'}; padding-bottom: 6px; margin-bottom: 6px; }
    .empresa-logo { font-size: ${isPos ? px(15) : '18px'}; font-weight: 900; color: #000; }
    .empresa-datos { font-size: ${isPos ? px(12) : '10px'}; color: ${isPos ? '#000' : '#444'}; margin-top: 3px; line-height: 1.4; }
    .orden-num { font-size: ${isPos ? px(18) : '20px'}; font-weight: 900; margin: 6px 0; color: #000; }
    .cliente-box { padding: 4px 0; border-bottom: ${isPos ? '2px dashed #000' : '1px dashed #999'}; margin-bottom: 6px; font-size: ${isPos ? px(13) : '11px'}; color: #000; text-align: left; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    th { padding: 3px 2px; text-align: left; font-size: ${isPos ? px(12) : '10px'}; border-bottom: ${isPos ? '2px solid #000' : '1px solid #333'}; font-weight: 900; color: #000; }
    td { padding: 3px 2px; border-bottom: ${isPos ? '1px dashed #000' : '1px dashed #ddd'}; vertical-align: top; font-size: ${isPos ? px(13) : '10px'}; color: #000; }
    .totales { border-top: ${isPos ? '3px solid #000' : '2px solid #333'}; padding-top: 4px; font-size: ${isPos ? px(14) : '11px'}; color: #000; }
    .total-final { font-size: ${isPos ? px(18) : '16px'}; font-weight: 900; color: #000; }
    .footer { text-align: center; margin-top: 8px; padding-top: 6px; border-top: ${isPos ? '2px dashed #000' : '1px dashed #999'}; font-size: ${isPos ? px(11) : '9px'}; color: ${isPos ? '#000' : '#666'}; }
    .notas { border: ${isPos ? '2px dashed #000' : '1px dashed #999'}; padding: 4px; margin-bottom: 6px; font-size: ${isPos ? px(12) : '10px'}; color: #000; }
    .pago-box { border: ${isPos ? '3px solid #000' : '1px solid #333'}; padding: ${isPos ? '6px' : '4px'}; margin-top: 4px; font-size: ${isPos ? px(14) : '10px'}; font-weight: 900; color: #000; }
    @media print {
      * { margin: 0 !important; }
      body { width: ${ancho} !important; margin: 0 !important; padding: ${isPos ? '0 2mm' : '8mm'} !important; }
      @page { margin: 0; size: ${isPos ? `${anchoPosNum}mm auto` : 'auto'}; }
    }
  </style></head><body>
  <div class="header">
    ${empresa?.logo ? `<img src="${empresa.logo}" style="${isPos
      ? `width:${anchoLogoPos};max-width:100%;height:auto;object-fit:contain;margin:0 auto 6px;display:block`
      : 'height:100px;max-width:220px;object-fit:contain;margin:0 auto 8px;display:block'
    }" /><br/>` : ''}
    <div class="empresa-logo">${empresa?.name || 'ORDEN DE SERVICIO'}</div>
    <div class="empresa-datos">
      NIT: ${empresa?.nit || ''} | Tel: ${empresa?.cellphone || empresa?.phone || ''}<br/>
      ${empresa?.address || ''}${empresa?.email ? ` | ${empresa.email}` : ''}
    </div>
  </div>
  <div style="text-align:center">
    <div class="orden-num">${orden.numeroOrden || ''}</div>
    <div style="font-size:${isPos ? px(12) : '10px'};color:${isPos ? '#000' : '#666'}">${formatFechaCO(orden.fechaProgramada || orden.createdAt)}</div>
    ${orden.numeroFactura ? `<div style="font-size:${isPos ? px(12) : '11px'};font-weight:900;color:#000">Factura: ${orden.numeroFactura}</div>` : ''}
  </div>
  <div class="cliente-box">
    <strong>${cli.nombre}</strong><br/>
    ${cli.nit ? `NIT: ${cli.nit}<br/>` : ''}
    ${cli.telefono ? `Tel: ${cli.telefono}<br/>` : ''}
    ${cli.direccion ? `Dir: ${cli.direccion}<br/>` : ''}
    ${cli.sede ? `Sede: ${cli.sede}<br/>` : ''}
    ${orden.formaPago ? `Pago: ${orden.formaPago}` : ''}
  </div>
  ${orden.notasOrden ? `<div class="notas">📝 ${orden.notasOrden}</div>` : ''}
  ${orden.extintorPrestamo ? `<div class="notas">🧯 Extintor préstamo: ${orden.extintorPrestamo}</div>` : ''}
  <table>
    <thead><tr><th>Descripción</th><th>Cant</th>${isPos ? '' : '<th>Precio</th><th>Desc</th>'}<th>Total</th></tr></thead>
    <tbody>${items}</tbody>
  </table>
  <div class="totales">
    <div style="display:flex;justify-content:space-between"><span>Subtotal:</span><span>${formatCOP(orden.subtotal)}</span></div>
    ${orden.ivaPct > 0 ? `<div style="display:flex;justify-content:space-between"><span>IVA (${orden.ivaPct}%):</span><span>${formatCOP(orden.ivaValor)}</span></div>` : ''}
    <div class="total-final" style="display:flex;justify-content:space-between;margin-top:4px"><span>TOTAL:</span><span>${formatCOP(orden.total)}</span></div>
  </div>
  ${orden.pagado ? `<div class="pago-box">✅ PAGADO — ${orden.formaPago || ''} — ${formatCOP(orden.montoPagado)}</div>` : ''}
  <div class="footer">
    Elaborado con Control360 | 📞 3148361622<br/>
    <em>Sistema operativo para empresas de servicios</em>
  </div>
  </body></html>`;
};

// ─── ABRIR VENTANA E IMPRIMIR (helper compartido) ────────────────────────────
// Misma rutina en NuevaOrden y DetalleOrden: abre, escribe, enfoca, imprime.
export const abrirImpresionOrden = (orden, empresa, formato = 'carta') => {
  const contenido = generarHTMLImpresionOrden(orden, empresa, formato);
  const ventana = window.open('', '_blank');
  if (!ventana) return false; // popup bloqueado: el llamador muestra el aviso
  ventana.document.write(contenido);
  ventana.document.close();
  ventana.focus();
  setTimeout(() => { ventana.print(); }, 500);
  return true;
};
