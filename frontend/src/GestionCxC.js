import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const aDate = ts => {
  if (!ts) return null;
  if (ts._seconds) return new Date(ts._seconds * 1000);
  if (ts.seconds) return new Date(ts.seconds * 1000);
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
};
const fmtFecha = ts => {
  const d = aDate(ts);
  return d ? d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
};
const diasDesde = ts => {
  const d = aDate(ts);
  return d ? Math.floor((new Date() - d) / (1000 * 60 * 60 * 24)) : 0;
};

// ─── GENERADOR DE HTML ESTADO DE CUENTA ──────────────────────────────────────
const generarHtmlEstadoCuenta = (cliente, empresa, cuentaBancaria) => {
  const hoy = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  const fmt2 = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
  const filas = (cliente.ordenes || []).map(o => {
    // La cartera se cuenta desde la factura (fechaConciliacion la calcula el
    // backend). Las fechas ya llegan legibles del backend.
    const fechaRef = o.fechaConciliacion || o.fechaFactura || o.fechaCreacion;
    const d = aDate(fechaRef);
    const dias = d ? Math.floor((new Date() - d) / 86400000) : 0;
    const fecha = d ? d.toLocaleDateString('es-CO') : '—';
    const docCol = o.facturaPendiente
      ? `<span style="color:#d97706;font-weight:700">${o.numeroOrden}</span><br/><span style="font-size:11px;color:#d97706">⚠ Factura pendiente</span>`
      : (o.numeroFactura
          ? `<strong>${o.numeroFactura}</strong><br/><span style="font-size:11px;color:#9ca3af">${o.numeroOrden}</span>`
          : (o.numeroOrden || '—'));
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6">${docCol}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6">${fecha}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;text-align:right">${fmt2(o.total)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;text-align:right;color:#dc2626;font-weight:700">${fmt2(o.saldoPendiente)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f3f4f6;text-align:center">
        ${o.facturaPendiente
          ? '<span style="padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;background:#fef3c7;color:#d97706">Sin facturar</span>'
          : `<span style="padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${dias >= 30 ? '#fef2f2' : '#fffbeb'};color:${dias >= 30 ? '#dc2626' : '#d97706'}">${dias}d</span>`}
      </td>
    </tr>`;
  }).join('');

  const cuentaHtml = cuentaBancaria ? `
    <div style="margin-top:28px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px 20px">
      <p style="margin:0 0 8px;font-weight:700;color:#16a34a;font-size:13px">💳 DATOS PARA EL PAGO</p>
      <table style="width:100%;font-size:13px;color:#374151">
        <tr><td style="padding:3px 0;font-weight:600;width:140px">Banco:</td><td>${cuentaBancaria.banco || '—'}</td></tr>
        <tr><td style="padding:3px 0;font-weight:600">Tipo de cuenta:</td><td>${cuentaBancaria.tipoCuenta || '—'}</td></tr>
        <tr><td style="padding:3px 0;font-weight:600">N° Cuenta:</td><td>${cuentaBancaria.numeroCuenta || '—'}</td></tr>
        <tr><td style="padding:3px 0;font-weight:600">Titular:</td><td>${cuentaBancaria.titularCuenta || '—'}</td></tr>
      </table>
    </div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Estado de Cuenta — ${cliente.clienteNombre}</title>
  <style>body{font-family:'Segoe UI',sans-serif;margin:0;padding:0;background:#fff;color:#111}
  @media print{body{padding:0}}</style></head><body>
  <div style="max-width:780px;margin:0 auto;padding:32px">
    <!-- MEMBRETE -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #7c3aed;padding-bottom:20px;margin-bottom:24px">
      <div>
        ${empresa?.logo ? `<img src="${empresa.logo}" style="height:60px;object-fit:contain;margin-bottom:8px" />` : `<div style="font-size:24px;font-weight:900;color:#7c3aed">${empresa?.name || 'EMPRESA'}</div>`}
        <div style="font-size:13px;color:#6b7280;margin-top:4px">${empresa?.address || ''}</div>
        <div style="font-size:13px;color:#6b7280">${empresa?.phone || ''} · ${empresa?.email || ''}</div>
        <div style="font-size:13px;color:#6b7280">NIT: ${empresa?.nit || ''}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:22px;font-weight:900;color:#7c3aed">ESTADO DE CUENTA</div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px">Fecha: ${hoy}</div>
        <div style="margin-top:12px;background:#fef2f2;border-radius:8px;padding:10px 16px;text-align:center">
          <div style="font-size:11px;color:#dc2626;font-weight:700">TOTAL PENDIENTE</div>
          <div style="font-size:26px;font-weight:900;color:#dc2626">${fmt2(cliente.totalPendiente)}</div>
        </div>
      </div>
    </div>
    <!-- DATOS CLIENTE -->
    <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin-bottom:24px">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px">Cliente</p>
      <div style="font-size:18px;font-weight:800;color:#111">${cliente.clienteNombre}</div>
      ${cliente.clienteNit ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">NIT / CC: ${cliente.clienteNit}</div>` : ''}
      ${cliente.clienteCelular ? `<div style="font-size:13px;color:#6b7280">📱 ${cliente.clienteCelular}</div>` : ''}
    </div>
    <!-- TABLA ÓRDENES -->
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#7c3aed;color:#fff">
          <th style="padding:10px 12px;text-align:left">Factura / N° Orden</th>
          <th style="padding:10px 12px;text-align:left">Fecha</th>
          <th style="padding:10px 12px;text-align:right">Total</th>
          <th style="padding:10px 12px;text-align:right">Saldo</th>
          <th style="padding:10px 12px;text-align:center">Días</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
      <tfoot>
        <tr style="background:#f9fafb;font-weight:700">
          <td colspan="3" style="padding:12px;text-align:right;font-size:14px">TOTAL PENDIENTE:</td>
          <td style="padding:12px;text-align:right;font-size:18px;color:#dc2626;font-weight:900">${fmt2(cliente.totalPendiente)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
    ${cuentaHtml}
    <div style="margin-top:32px;font-size:11px;color:#9ca3af;text-align:center;border-top:1px solid #f3f4f6;padding-top:16px">
      Documento generado el ${hoy} por Control360 · Sistema Operativo Empresarial
    </div>
  </div>
  </body></html>`;
};

// ─── MODAL ESTADO DE CUENTA ───────────────────────────────────────────────────
const ModalEstadoCuenta = ({ cliente, cajas, formasPago, formasPagoConfig, empresas, onPagar, onCerrar }) => {
  const [ordenesSeleccionadas, setOrdenesSeleccionadas] = useState({});
  const [formPago, setFormPago] = useState({ formaPago: '', cajaId: '', cajaLabel: '', fechaPago: new Date().toISOString().split('T')[0], retencion: '' });
  const [montoAbono, setMontoAbono] = useState(''); // ✅ FIX: permite abono parcial
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const [mostrarPago, setMostrarPago] = useState(false);

  const empresa = empresas.find(e => e.id === cliente.empresaId) || empresas[0];
  const cuentaBancaria = cajas.find(c => c.usarParaCobros && c.tipo === 'Banco' && c.empresaId === empresa?.id)
    || cajas.find(c => c.usarParaCobros && c.tipo === 'Banco');

  // Calcular total de órdenes seleccionadas
  const ordenesChecked = (cliente.ordenes || []).filter(o => ordenesSeleccionadas[o.id]);
  const totalSeleccionado = ordenesChecked.reduce((s, o) => s + (o.saldoPendiente || 0), 0);
  const todasSeleccionadas = (cliente.ordenes || []).length > 0 && ordenesChecked.length === (cliente.ordenes || []).length;

  const toggleOrden = (id) => setOrdenesSeleccionadas(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleTodas = () => {
    if (todasSeleccionadas) setOrdenesSeleccionadas({});
    else { const nuevo = {}; (cliente.ordenes || []).forEach(o => { nuevo[o.id] = true; }); setOrdenesSeleccionadas(nuevo); }
  };

  // Auto-asignar caja al seleccionar forma de pago
  const handleFormaPago = (nombreForma) => {
    const confForma = formasPagoConfig?.find(f => f.nombre === nombreForma);
    const cajaAsignada = confForma?.cajaId ? cajas.find(c => c.id === confForma.cajaId) : null;
    setFormPago(p => ({ ...p, formaPago: nombreForma, cajaId: cajaAsignada?.id || '', cajaLabel: cajaAsignada?.nombre || '' }));
  };

  const handlePagar = async () => {
    if (!formPago.formaPago) { setError('Selecciona la forma de pago'); return; }
    if (!formPago.cajaId) { setError('La forma de pago seleccionada no tiene caja asignada en Mi Empresa'); return; }
    if (ordenesChecked.length === 0) { setError('Selecciona al menos una orden'); return; }
    // ✅ FIX: si hay monto de abono, validar que sea > 0 y <= saldo total
    const montoAbonoNum = Number(montoAbono) || 0;
    if (montoAbono && montoAbonoNum <= 0) { setError('El monto del abono debe ser mayor a 0'); return; }
    if (montoAbono && montoAbonoNum > totalSeleccionado) { setError('El abono no puede superar el saldo total'); return; }
    setGuardando(true); setError('');
    try {
      for (const orden of ordenesChecked) {
        // Si hay abono parcial y solo hay una orden seleccionada, usar el monto del abono
        const montoOrden = (montoAbono && ordenesChecked.length === 1)
          ? montoAbonoNum
          : (orden.saldoPendiente || orden.total || 0);
        await onPagar(orden.id, {
          ...formPago,
          retencion: Number(formPago.retencion) || 0,
          montoAbono: montoOrden,
          esAbonoParcial: montoOrden < (orden.saldoPendiente || orden.total || 0)
        });
      }
      setOrdenesSeleccionadas({});
      setMostrarPago(false);
      setMontoAbono('');
      setFormPago({ formaPago: '', cajaId: '', cajaLabel: '', fechaPago: new Date().toISOString().split('T')[0], retencion: '' });
    } catch (e) { setError(e.response?.data?.error || 'Error al registrar pago'); }
    setGuardando(false);
  };

  const handleImprimir = () => {
    const html = generarHtmlEstadoCuenta(cliente, empresa, cuentaBancaria);
    const win = window.open('', '_blank');
    win.document.write(html); win.document.close(); win.focus();
    setTimeout(() => win.print(), 600);
  };

  const handleWhatsApp = () => {
    const total = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(cliente.totalPendiente || 0);
    const ordenes = (cliente.ordenes || []).map(o => `• ${o.numeroOrden} — ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(o.saldoPendiente)}`).join('\n');
    const cuenta = cuentaBancaria ? `\n\n💳 *Datos para el pago:*\nBanco: ${cuentaBancaria.banco}\nCuenta ${cuentaBancaria.tipoCuenta}: ${cuentaBancaria.numeroCuenta}\nTitular: ${cuentaBancaria.titularCuenta}` : '';
    const msg = `*Estado de Cuenta*\n${empresa?.name || ''}\n\nEstimado(a) *${cliente.clienteNombre}*,\n\nLe informamos que tiene el siguiente saldo pendiente:\n\n${ordenes}\n\n*Total pendiente: ${total}*${cuenta}\n\nPor favor regularice su cartera. Gracias.`;
    const cel = cliente.clienteCelular?.replace(/\D/g, '') || '';
    window.open(cel ? `https://wa.me/57${cel}?text=${encodeURIComponent(msg)}` : `https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  const handleEmail = () => {
    const total = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(cliente.totalPendiente || 0);
    const subject = encodeURIComponent(`Estado de Cuenta — ${cliente.clienteNombre}`);
    const body = encodeURIComponent(`Estimado(a) ${cliente.clienteNombre},\n\nAdjunto encontrará su estado de cuenta con un saldo pendiente de ${total}.\n\nPor favor comuníquese con nosotros para regularizar su cartera.\n\nCordialmente,\n${empresa?.name || ''}`);
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 720 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>📋 Estado de Cuenta</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>{cliente.clienteNombre} {cliente.clienteNit && `· NIT: ${cliente.clienteNit}`}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={handleWhatsApp} style={{ padding: '7px 14px', background: '#25D366', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>💬 WhatsApp</button>
            <button onClick={handleEmail} style={{ padding: '7px 14px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>📧 Email</button>
            <button onClick={handleImprimir} style={{ padding: '7px 14px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>🖨️ Imprimir</button>
            <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
          </div>
        </div>

        <div style={s.modalBody}>
          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div style={s.kpi}><span style={s.kpiLabel}>Total pendiente</span><span style={{ ...s.kpiValor, color: '#dc2626' }}>{fmt(cliente.totalPendiente)}</span></div>
            <div style={s.kpi}><span style={s.kpiLabel}>Días vencido</span><span style={{ ...s.kpiValor, color: cliente.diasVencido >= 30 ? '#dc2626' : '#f59e0b' }}>{cliente.diasVencido} días</span></div>
            <div style={s.kpi}><span style={s.kpiLabel}>Órdenes</span><span style={s.kpiValor}>{cliente.ordenes?.length || 0}</span></div>
          </div>

          {/* Lista de órdenes con checkboxes */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h4 style={{ ...s.seccionTitulo, margin: 0 }}>Órdenes pendientes</h4>
            {ordenesChecked.length > 0 && (
              <div style={{ fontSize: 13, color: '#16a34a', fontWeight: 700 }}>
                {ordenesChecked.length} seleccionada{ordenesChecked.length !== 1 ? 's' : ''} · {fmt(totalSeleccionado)}
              </div>
            )}
          </div>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#f8fafc' }}>
                <th style={{ ...s.th, width: 40 }}>
                  <input type="checkbox" checked={todasSeleccionadas} onChange={toggleTodas}
                    style={{ width: 16, height: 16, cursor: 'pointer' }} />
                </th>
                {['Factura / N° Orden', 'Fecha', 'Total', 'Saldo', 'Días'].map(h => <th key={h} style={s.th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {(cliente.ordenes || []).map((o, i) => (
                  <tr key={o.id} onClick={() => toggleOrden(o.id)}
                    style={{ background: ordenesSeleccionadas[o.id] ? '#f0fdf4' : i % 2 === 0 ? '#fff' : '#f9fafb', cursor: 'pointer', transition: 'background 0.1s' }}>
                    <td style={{ ...s.td, textAlign: 'center' }}>
                      <input type="checkbox" checked={!!ordenesSeleccionadas[o.id]} onChange={() => toggleOrden(o.id)}
                        onClick={e => e.stopPropagation()} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                    </td>
                    <td style={s.td}>
  {o.facturaPendiente
    ? <><code style={{ fontSize: 12 }}>{o.numeroOrden}</code><div style={{ fontSize: 11, color: '#d97706', fontWeight: 700 }}>⚠ Factura pendiente</div></>
    : (o.numeroFactura
        ? <><strong style={{ fontSize: 12 }}>{o.numeroFactura}</strong><div style={{ fontSize: 11, color: '#9ca3af' }}>{o.numeroOrden}</div></>
        : <code style={{ fontSize: 12 }}>{o.numeroOrden}</code>)
  }
</td>
                    <td style={s.td}>{fmtFecha(o.fechaConciliacion || o.fechaFactura || o.fechaCreacion)}</td>
                    <td style={s.td}>{fmt(o.total)}</td>
                    <td style={{ ...s.td, fontWeight: 700, color: '#dc2626' }}>{fmt(o.saldoPendiente)}</td>
                    <td style={s.td}>
                      {o.facturaPendiente ? (
                        <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: '#fef3c7', color: '#d97706' }}>
                          Sin facturar
                        </span>
                      ) : (() => {
                        const ref = o.fechaConciliacion || o.fechaFactura || o.fechaCreacion;
                        const dd = diasDesde(ref);
                        return (
                          <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                            background: dd >= 30 ? '#fef2f2' : '#fffbeb',
                            color: dd >= 30 ? '#dc2626' : '#d97706' }}>
                            {dd}d
                          </span>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Botón registrar pago */}
          {!mostrarPago && (
            <button onClick={() => { if (ordenesChecked.length === 0) { setError('Selecciona al menos una orden'); return; } setError(''); setMostrarPago(true); }}
              style={{ padding: '10px 24px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
              💰 Registrar pago {ordenesChecked.length > 0 ? `(${ordenesChecked.length} orden${ordenesChecked.length !== 1 ? 'es' : ''} · ${fmt(totalSeleccionado)})` : ''}
            </button>
          )}
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 8 }}>⚠️ {error}</div>}

          {/* Form pago */}
          {mostrarPago && (
            <div style={{ background: '#f0fdf4', border: '2px solid #86efac', borderRadius: 10, padding: 16 }}>
              <h4 style={{ margin: '0 0 4px', color: '#16a34a', fontSize: 14 }}>
                💰 Registrar pago — {ordenesChecked.length} orden{ordenesChecked.length !== 1 ? 'es' : ''}
              </h4>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: '#374151' }}>
                Total a registrar: <strong>{fmt(totalSeleccionado)}</strong>
              </p>

              {/* Forma de pago — chips */}
              <div style={s.campo}>
                <label style={s.label}>Forma de pago *</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {formasPago.map(f => (
                    <button key={f} type="button" onClick={() => handleFormaPago(f)} style={{
                      padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                      background: formPago.formaPago === f ? '#16a34a' : '#f3f4f6',
                      color: formPago.formaPago === f ? '#fff' : '#374151',
                      border: formPago.formaPago === f ? '2px solid #16a34a' : '2px solid transparent',
                    }}>{f}</button>
                  ))}
                </div>
                {formPago.cajaLabel && (
                  <div style={{ fontSize: 12, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>
                    ✅ Caja asignada: {formPago.cajaLabel}
                  </div>
                )}
                {formPago.formaPago && !formPago.cajaId && (
                  <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6, fontWeight: 600 }}>
                    ⚠️ Esta forma de pago no tiene caja asignada. Configúrala en Mi Empresa → Formas de pago.
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div style={s.campo}>
                  <label style={s.label}>Fecha de pago</label>
                  <input type="date" style={s.input} value={formPago.fechaPago}
                    onChange={e => setFormPago(p => ({ ...p, fechaPago: e.target.value }))} />
                </div>
                <div style={s.campo}>
                  <label style={s.label}>Retención practicada <span style={{ fontWeight: 400, color: '#9ca3af' }}>(opcional)</span></label>
                  <input type="number" min="0" style={s.input} placeholder="0"
                    value={formPago.retencion} onChange={e => setFormPago(p => ({ ...p, retencion: e.target.value }))} />
                </div>
              </div>
              {/* ✅ FIX: campo abono parcial */}
              <div style={s.campo}>
                <label style={s.label}>
                  Monto a abonar
                  <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
                    (dejar vacío = pago total de {fmt(totalSeleccionado)})
                  </span>
                </label>
                <input type="number" min="1" max={totalSeleccionado} style={{ ...s.input, fontWeight: 700, fontSize: 15 }}
                  placeholder={String(totalSeleccionado)}
                  value={montoAbono}
                  onChange={e => setMontoAbono(e.target.value)} />
                {montoAbono && Number(montoAbono) < totalSeleccionado && (
                  <div style={{ marginTop: 6, padding: '8px 12px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
                    💡 Abono parcial: {fmt(Number(montoAbono))} de {fmt(totalSeleccionado)} — saldo restante: <strong>{fmt(totalSeleccionado - Number(montoAbono))}</strong>
                  </div>
                )}
              </div>

              {Number(formPago.retencion) > 0 && (
                <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>
                  ⚠️ Retención: {fmt(formPago.retencion)} → categoría <strong>Retefuente</strong> como CXP
                  <br />💵 Ingreso neto a caja: <strong>{fmt(totalSeleccionado - Number(formPago.retencion || 0))}</strong>
                </div>
              )}

              {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 8 }}>⚠️ {error}</div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={handlePagar} disabled={guardando}
                  style={{ padding: '10px 24px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                  {guardando ? 'Registrando...' : `✅ Confirmar ${montoAbono && Number(montoAbono) < totalSeleccionado ? 'abono' : 'pago'} · ${fmt(montoAbono ? Number(montoAbono) : totalSeleccionado)}`}
                </button>
                <button onClick={() => { setMostrarPago(false); setError(''); }}
                  style={{ padding: '10px 20px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnCancelar}>Cerrar</button>
        </div>
      </div>
    </div>
  );
};


// ─── MODAL COBRANZA PARCIAL (NUEVO PARA CTRL-003) ───────────────────────────────
const ModalCobranza = ({ cliente, onCobrar, onCerrar }) => {
  const [ordenesSeleccionadas, setOrdenesSeleccionadas] = useState({});
  const [montos, setMontos] = useState({});
  const [dineroRecibido, setDineroRecibido] = useState('');
  const [formaPago, setFormaPago] = useState('Efectivo');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const ordenesPendientes = (cliente.ordenes || []).filter(o => (o.saldoPendiente || 0) > 0);
  const ordenesChecked = Object.keys(ordenesSeleccionadas).filter(k => ordenesSeleccionadas[k]);
  const totalACobrar = ordenesChecked.reduce((s, ordenId) => {
    const orden = ordenesPendientes.find(o => o.ordenId === ordenId);
    return s + (montos[ordenId] || orden?.saldoPendiente || 0);
  }, 0);
  const cambio = Math.max(0, Number(dineroRecibido) - totalACobrar);

  const handleToggleOrden = (ordenId) => {
    setOrdenesSeleccionadas(p => ({ ...p, [ordenId]: !p[ordenId] }));
    if (!montos[ordenId]) {
      const orden = ordenesPendientes.find(o => o.ordenId === ordenId);
      setMontos(p => ({ ...p, [ordenId]: orden?.saldoPendiente || 0 }));
    }
  };

  const handleMontoChange = (ordenId, valor) => {
    const numVal = Number(valor) || 0;
    const orden = ordenesPendientes.find(o => o.ordenId === ordenId);
    const maxMonto = orden?.saldoPendiente || 0;
    if (numVal <= maxMonto) {
      setMontos(p => ({ ...p, [ordenId]: numVal }));
    }
  };

  const handleCobrar = async () => {
    if (ordenesChecked.length === 0) return setError('Selecciona al menos una factura');
    if (totalACobrar === 0) return setError('El total a cobrar debe ser mayor a 0');
    if (Number(dineroRecibido) < totalACobrar) return setError('El dinero recibido es menor al total a cobrar');

    setGuardando(true); setError('');
    try {
      const ordenesCobradas = ordenesChecked.map(ordenId => {
        const orden = ordenesPendientes.find(o => o.ordenId === ordenId);
        return {
          ordenId,
          numeroOrden: orden?.numeroOrden,
          monto: montos[ordenId] || orden?.saldoPendiente || 0
        };
      });

      await onCobrar({
        clienteId: cliente.clienteId,
        ordenesCobradas,
        dineroTotal: totalACobrar,
        metodoPago: formaPago,
        cambio
      });
      
      onCerrar();
    } catch (e) {
      setError(e.response?.data?.error || 'Error al registrar cobranza');
    }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 820 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>💰 Cobranza — Pago Parcial</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>{cliente.clienteNombre}</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14 }}>⚠️ {error}</div>}

          {/* Tabla de facturas */}
          <h4 style={s.seccionTitulo}>Facturas pendientes</h4>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ padding: '12px 14px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#6b7280' }}>Seleccionar</th>
                  <th style={{ padding: '12px 14px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#6b7280' }}>Factura</th>
                  <th style={{ padding: '12px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#6b7280' }}>Total</th>
                  <th style={{ padding: '12px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#6b7280' }}>Saldo</th>
                  <th style={{ padding: '12px 14px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#6b7280' }}>Monto a cobrar</th>
                </tr>
              </thead>
              <tbody>
                {ordenesPendientes.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>Sin facturas pendientes</td></tr>
                ) : (
                  ordenesPendientes.map((o, i) => (
                    <tr key={o.ordenId} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                        <input type="checkbox" checked={!!ordenesSeleccionadas[o.ordenId]}
                          onChange={() => handleToggleOrden(o.ordenId)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 13, fontWeight: 700, color: '#1e1b4b' }}>
                        {o.numeroFactura || o.numeroOrden}
                      </td>
                      <td style={{ padding: '12px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#374151' }}>
                        {fmt(o.total)}
                      </td>
                      <td style={{ padding: '12px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#dc2626' }}>
                        {fmt(o.saldoPendiente)}
                      </td>
                      <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                        {ordenesSeleccionadas[o.ordenId] ? (
                          <input type="number" value={montos[o.ordenId] || ''} onChange={e => handleMontoChange(o.ordenId, e.target.value)}
                            style={{ width: 100, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, textAlign: 'right' }} />
                        ) : (
                          <span style={{ color: '#9ca3af' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Resumen cobranza */}
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Total a cobrar</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: '#16a34a' }}>{fmt(totalACobrar)}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Dinero recibido</div>
                <input type="number" value={dineroRecibido} onChange={e => setDineroRecibido(e.target.value)}
                  placeholder="0" style={{ width: '100%', padding: '8px 12px', border: '2px solid #86efac', borderRadius: 8, fontSize: 16, fontWeight: 700, color: '#16a34a' }} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Cambio</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: '#059669' }}>{fmt(cambio)}</div>
              </div>
              <div>
                <label style={s.label}>Forma de pago *</label>
                <select style={s.input} value={formaPago} onChange={e => setFormaPago(e.target.value)}>
                  <option>Efectivo</option>
                  <option>Transferencia</option>
                  <option>Cheque</option>
                </select>
              </div>
            </div>
          </div>
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnCancelar}>Cancelar</button>
          <button onClick={handleCobrar} disabled={guardando || ordenesChecked.length === 0}
            style={{ padding: '10px 24px', background: ordenesChecked.length > 0 ? 'linear-gradient(135deg,#16a34a,#15803d)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
            {guardando ? 'Registrando cobranza...' : `✅ Cobrar ${fmt(totalACobrar)}`}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── MODAL GESTIÓN COBRANZA ───────────────────────────────────────────────────
const ModalGestion = ({ cliente, gestiones, onGuardar, onCerrar }) => {
  const [form, setForm] = useState({ nota: '', proximoSeguimiento: '' });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const handleGuardar = async () => {
    if (!form.nota.trim()) { setError('Escribe una nota de la gestión'); return; }
    setGuardando(true); setError('');
    try {
      await onGuardar({ ...form, clienteId: cliente.clienteId, clienteNombre: cliente.clienteNombre });
      setForm({ nota: '', proximoSeguimiento: '' });
    } catch (e) { setError(e.response?.data?.error || 'Error al guardar'); }
    setGuardando(false);
  };

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 620 }}>
        <div style={s.modalHeader}>
          <div>
            <h3 style={s.modalTitulo}>📞 Gestión de Cobranza</h3>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6b7280' }}>{cliente.clienteNombre}</p>
          </div>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          {/* Nueva gestión */}
          <h4 style={s.seccionTitulo}>Registrar gestión</h4>
          <div style={s.campo}>
            <label style={s.label}>Nota de la gestión *</label>
            <textarea style={{ ...s.input, height: 80, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Ej: Se llamó al cliente, informa que paga el viernes 16..."
              value={form.nota}
              onChange={e => setForm(p => ({ ...p, nota: e.target.value }))} />
          </div>
          <div style={s.campo}>
            <label style={s.label}>Próximo seguimiento <span style={{ fontWeight: 400, color: '#9ca3af' }}>(opcional)</span></label>
            <input type="date" style={s.input} value={form.proximoSeguimiento}
              onChange={e => setForm(p => ({ ...p, proximoSeguimiento: e.target.value }))} />
          </div>
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 8 }}>⚠️ {error}</div>}
          <button onClick={handleGuardar} disabled={guardando}
            style={{ padding: '10px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, marginBottom: 24 }}>
            {guardando ? 'Guardando...' : '💾 Guardar gestión'}
          </button>

          {/* Historial */}
          <h4 style={s.seccionTitulo}>Historial de gestiones</h4>
          {gestiones.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: 13 }}>Sin gestiones registradas aún.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {gestiones.map(g => (
                <div key={g.id} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed' }}>{g.realizadoPor}</span>
                    <span style={{ fontSize: 12, color: '#9ca3af' }}>{fmtFecha(g.fecha)}</span>
                  </div>
                  <p style={{ margin: '0 0 6px', fontSize: 13, color: '#374151' }}>{g.nota}</p>
                  {g.proximoSeguimiento && (
                    <span style={{ fontSize: 11, background: '#ede9fe', color: '#7c3aed', padding: '2px 8px', borderRadius: 20, fontWeight: 600 }}>
                      📅 Seguimiento: {new Date(g.proximoSeguimiento + 'T00:00:00').toLocaleDateString('es-CO')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnCancelar}>Cerrar</button>
        </div>
      </div>
    </div>
  );
};

// ─── MODAL CONFIGURACIÓN ──────────────────────────────────────────────────────
const ModalConfig = ({ config, onGuardar, onCerrar }) => {
  const [form, setForm] = useState({ diasBloqueoCartera: config.diasBloqueoCartera || 30, diasAlertaCobranza: config.diasAlertaCobranza || 7 });
  const [guardando, setGuardando] = useState(false);

  return (
    <div style={s.overlay}>
      <div style={{ ...s.modal, maxWidth: 440 }}>
        <div style={s.modalHeader}>
          <h3 style={s.modalTitulo}>⚙️ Configuración Cartera</h3>
          <button onClick={onCerrar} style={s.btnCerrar}>✕</button>
        </div>
        <div style={s.modalBody}>
          <div style={s.campo}>
            <label style={s.label}>Días para bloqueo por cartera vencida</label>
            <input type="number" min="1" style={s.input} value={form.diasBloqueoCartera}
              onChange={e => setForm(p => ({ ...p, diasBloqueoCartera: e.target.value }))} />
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Al superar este número de días, el cliente queda bloqueado para nuevas órdenes</span>
          </div>
          <div style={s.campo}>
            <label style={s.label}>Días entre alertas de cobranza</label>
            <input type="number" min="1" style={s.input} value={form.diasAlertaCobranza}
              onChange={e => setForm(p => ({ ...p, diasAlertaCobranza: e.target.value }))} />
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Cada cuántos días se genera alerta de seguimiento</span>
          </div>
        </div>
        <div style={s.modalFooter}>
          <button onClick={onCerrar} style={s.btnCancelar}>Cancelar</button>
          <button disabled={guardando} onClick={async () => { setGuardando(true); await onGuardar(form); setGuardando(false); onCerrar(); }}
            style={{ padding: '10px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
            {guardando ? 'Guardando...' : '💾 Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// COMPONENTE PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════
const GestionCxC = ({ user }) => {
  const [clientes, setClientes]       = useState([]);
  const [loading, setLoading]         = useState(true);
  const [diasBloqueo, setDiasBloqueo] = useState(30);
  const [cajas, setCajas]             = useState([]);
  const [formasPago, setFormasPago]   = useState([]);
  const [formasPagoConfig, setFormasPagoConfig] = useState([]);
  const [empresas, setEmpresas]       = useState([]);
  const [buscar, setBuscar]           = useState('');
  const [modalDetalle, setModalDetalle]   = useState(null);
  const [modalCobranza, setModalCobranza] = useState(null);
  const [modalGestion, setModalGestion]   = useState(null);
  const [modalConfig, setModalConfig]     = useState(false);
  const [gestiones, setGestiones]         = useState([]);
  const [exito, setExito]                 = useState('');
  const [error, setError]                 = useState('');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };
  const isAdmin = user?.role === 'admin';

  const cargar = useCallback(async () => {
    try {
      setLoading(true);
      const [resCxc, resCajas, resConfig] = await Promise.all([
        axios.get(`${API}/cxc`, { headers }),
        axios.get(`${API}/cajas`, { headers }),
        axios.get(`${API}/cxc/config`, { headers }),
      ]);
      setClientes(resCxc.data.clientes || []);
      setDiasBloqueo(resCxc.data.diasBloqueo || 30);
      setCajas(Array.isArray(resCajas.data) ? resCajas.data : []);

      // Formas de pago desde configuración
      const resConf = await axios.get(`${API}/configuracion`, { headers });
      const fps = (resConf.data?.formasPago || []).filter(f => f.activa && f.tipo !== 'credito').map(f => f.nombre);
      setFormasPago(fps.length > 0 ? fps : ['Efectivo', 'Transferencia', 'Nequi', 'Datafono']);
      setFormasPagoConfig(resConf.data?.formasPago || []);

      // Empresas para membrete
      const resEmpresas = await axios.get(`${API}/companies`, { headers });
      setEmpresas(Array.isArray(resEmpresas.data) ? resEmpresas.data : []);
    } catch (e) {
      setError('Error al cargar cartera');
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { cargar(); }, [cargar]);

  const abrirGestion = async (cliente) => {
    setModalGestion(cliente);
    try {
      const res = await axios.get(`${API}/cxc/gestiones/${cliente.clienteId}`, { headers });
      setGestiones(Array.isArray(res.data) ? res.data : []);
    } catch { setGestiones([]); }
  };

  const guardarGestion = async (data) => {
    await axios.post(`${API}/cxc/gestiones`, data, { headers });
    const res = await axios.get(`${API}/cxc/gestiones/${data.clienteId}`, { headers });
    setGestiones(Array.isArray(res.data) ? res.data : []);
    toast('Gestión registrada ✓');
  };

  const registrarCobranzaParcial = async (datos) => {
    try {
      await axios.post(`${API}/cxc/cobrar`, datos, { headers });
      toast('✅ Cobranza registrada');
      setModalCobranza(null);
      await cargar();
    } catch (e) {
      alert('Error: ' + (e.response?.data?.error || e.message));
    }
  };

  const registrarPago = async (ordenId, formPago) => {
    await axios.post(`${API}/cxc/${ordenId}/pago`, {
      formaPago: formPago.formaPago,
      cajaId: formPago.cajaId,
      fechaPago: formPago.fechaPago,
      retencion: Number(formPago.retencion) || 0,
    }, { headers });
    toast('Pago registrado ✓');
    setModalDetalle(null);
    await cargar();
  };

  const guardarConfig = async (data) => {
    await axios.put(`${API}/cxc/config`, data, { headers });
    await cargar();
    toast('Configuración guardada ✓');
  };

  const toast = (msg) => { setExito(msg); setTimeout(() => setExito(''), 3000); };

  const clientesFiltrados = clientes.filter(c =>
    !buscar || c.clienteNombre?.toLowerCase().includes(buscar.toLowerCase()) || c.clienteNit?.includes(buscar)
  );

  const totalCartera = clientes.reduce((s, c) => s + c.totalPendiente, 0);
  const clientesVencidos = clientes.filter(c => c.diasVencido >= diasBloqueo).length;
  const clientesAlerta = clientes.filter(c => c.diasVencido >= 30 && c.diasVencido < diasBloqueo).length;

  return (
    <div style={s.wrapper}>
      {/* HEADER */}
      <div style={s.pageHeader}>
        <div>
          <h2 style={s.pageTitle}>💳 Cuentas por Cobrar</h2>
          <p style={s.pageSubtitle}>Cartera activa · ordenada por antigüedad</p>
        </div>
        {isAdmin && (
          <button onClick={() => setModalConfig(true)} style={s.btnSecundario}>⚙️ Configurar</button>
        )}
      </div>

      {exito && <div style={s.alertExito}>{exito}</div>}
      {error && <div style={s.alertError}>{error}</div>}

      {/* KPIs */}
      <div style={s.kpiRow}>
        <div style={s.kpiCard}>
          <span style={s.kpiLabel}>Total cartera</span>
          <span style={{ ...s.kpiValor, color: '#dc2626', fontSize: 22 }}>{fmt(totalCartera)}</span>
        </div>
        <div style={s.kpiCard}>
          <span style={s.kpiLabel}>Clientes con deuda</span>
          <span style={{ ...s.kpiValor, color: '#7c3aed' }}>{clientes.length}</span>
        </div>
        <div style={{ ...s.kpiCard, background: '#fffbeb', border: '1px solid #fcd34d' }}>
          <span style={s.kpiLabel}>⚠️ En alerta</span>
          <span style={{ ...s.kpiValor, color: '#d97706' }}>{clientesAlerta}</span>
        </div>
        <div style={{ ...s.kpiCard, background: '#fef2f2', border: '1px solid #fca5a5' }}>
          <span style={s.kpiLabel}>🔴 Bloqueados +{diasBloqueo}d</span>
          <span style={{ ...s.kpiValor, color: '#dc2626' }}>{clientesVencidos}</span>
        </div>
      </div>

      {/* BÚSQUEDA */}
      <div style={{ marginBottom: 16 }}>
        <div style={s.searchWrap}>
          <span>🔍</span>
          <input style={s.searchInput} placeholder="Buscar por nombre o NIT..."
            value={buscar} onChange={e => setBuscar(e.target.value)} />
          {buscar && <button onClick={() => setBuscar('')} style={s.clearBtn}>✕</button>}
        </div>
      </div>

      {/* TABLA */}
      {loading ? (
        <div style={s.loadingBox}>Cargando cartera...</div>
      ) : clientesFiltrados.length === 0 ? (
        <div style={s.emptyBox}>
          <p style={{ fontSize: 48, margin: '0 0 12px' }}>💳</p>
          <p>No hay cuentas por cobrar pendientes</p>
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.tabla}>
            <thead>
              <tr style={s.theadRow}>
                {['Cliente', 'NIT', 'Órdenes', 'Total pendiente', 'Días vencido', 'Estado', 'Acciones'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clientesFiltrados.map((c, i) => {
                const bloqueado = c.diasVencido >= diasBloqueo;
                const alerta = c.diasVencido >= 30 && !bloqueado;
                return (
                  <tr key={c.clienteId} style={{ background: bloqueado ? '#fff5f5' : alerta ? '#fffbeb' : i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                    <td style={s.td}>
                      <strong style={{ color: '#111' }}>{c.clienteNombre}</strong>
                      {c.clienteCelular && <div style={{ fontSize: 11, color: '#9ca3af' }}>📱 {c.clienteCelular}</div>}
                    </td>
                    <td style={s.td}><code style={{ fontSize: 12, color: '#6b7280' }}>{c.clienteNit || '—'}</code></td>
                    <td style={s.td}>{c.ordenes?.length || 0}</td>
                    <td style={{ ...s.td, fontWeight: 700, color: '#dc2626' }}>{fmt(c.totalPendiente)}</td>
                    <td style={s.td}>
                      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                        background: bloqueado ? '#fef2f2' : alerta ? '#fffbeb' : '#f0fdf4',
                        color: bloqueado ? '#dc2626' : alerta ? '#d97706' : '#16a34a' }}>
                        {c.diasVencido}d
                      </span>
                    </td>
                    <td style={s.td}>
                      {bloqueado
                        ? <span style={{ background: '#fef2f2', color: '#dc2626', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>🔴 BLOQUEADO</span>
                        : alerta
                          ? <span style={{ background: '#fffbeb', color: '#d97706', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>⚠️ ALERTA</span>
                          : <span style={{ background: '#f0fdf4', color: '#16a34a', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>✅ VIGENTE</span>
                      }
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button onClick={() => setModalDetalle(c)}
                          style={{ ...s.btnAccion, background: '#ede9fe', color: '#7c3aed' }}>📋 Ver</button>
                        <button onClick={() => abrirGestion(c)}
                          style={{ ...s.btnAccion, background: '#dbeafe', color: '#1d4ed8' }}>📞 Gestión</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* MODALES */}
      {modalDetalle && (
        <ModalEstadoCuenta
          cliente={modalDetalle}
          cajas={cajas}
          formasPago={formasPago}
          formasPagoConfig={formasPagoConfig}
          empresas={empresas}
          onPagar={registrarPago}
          onCerrar={() => setModalDetalle(null)}
        />
      )}
      {modalCobranza && (
        <ModalCobranza
          cliente={modalCobranza}
          onCobrar={registrarCobranzaParcial}
          onCerrar={() => setModalCobranza(null)}
        />
      )}
      {modalGestion && (
        <ModalGestion
          cliente={modalGestion}
          gestiones={gestiones}
          onGuardar={guardarGestion}
          onCerrar={() => setModalGestion(null)}
        />
      )}
      {modalConfig && (
        <ModalConfig
          config={{ diasBloqueoCartera: diasBloqueo }}
          onGuardar={guardarConfig}
          onCerrar={() => setModalConfig(false)}
        />
      )}
    </div>
  );
};

// ─── ESTILOS ──────────────────────────────────────────────────────────────────
const s = {
  wrapper:      { padding: '32px', maxWidth: '1400px', margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  pageHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  pageTitle:    { margin: 0, fontSize: 26, fontWeight: 700, color: '#111' },
  pageSubtitle: { margin: '4px 0 0', color: '#6b7280', fontSize: 14 },
  btnSecundario:{ padding: '10px 18px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13 },

  alertError:   { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  alertExito:   { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14 },

  kpiRow:       { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 },
  kpiCard:      { background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', display: 'flex', flexDirection: 'column', gap: 6 },
  kpiLabel:     { fontSize: 12, color: '#6b7280', fontWeight: 600 },
  kpiValor:     { fontSize: 20, fontWeight: 800, color: '#111' },
  kpi:          { background: '#f9fafb', borderRadius: 10, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 },

  searchWrap:   { display: 'flex', alignItems: 'center', background: '#fff', border: '2px solid #e5e7eb', borderRadius: 8, padding: '0 12px', maxWidth: 360 },
  searchInput:  { flex: 1, border: 'none', outline: 'none', fontSize: 14, padding: '10px 8px', background: 'transparent' },
  clearBtn:     { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 16 },

  loadingBox:   { textAlign: 'center', padding: 60, color: '#9ca3af' },
  emptyBox:     { textAlign: 'center', padding: 60, color: '#9ca3af', background: '#fff', borderRadius: 12 },

  tableWrap:    { background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.07)', overflow: 'hidden' },
  tabla:        { width: '100%', borderCollapse: 'collapse' },
  theadRow:     { background: '#f8fafc', borderBottom: '2px solid #e5e7eb' },
  th:           { padding: '12px 16px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' },
  td:           { padding: '12px 16px', fontSize: 14, color: '#374151', borderBottom: '1px solid #f3f4f6' },
  btnAccion:    { padding: '5px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 },

  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 },
  modal:        { background: '#fff', borderRadius: 16, width: '100%', maxWidth: 780, maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  modalHeader:  { padding: '20px 24px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 },
  modalTitulo:  { margin: 0, fontSize: 18, fontWeight: 700, color: '#111' },
  btnCerrar:    { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', fontSize: 16, color: '#6b7280', flexShrink: 0 },
  modalBody:    { padding: '20px 24px', overflow: 'auto', flex: 1 },
  modalFooter:  { padding: '14px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 12, flexShrink: 0 },
  btnCancelar:  { padding: '10px 24px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 },

  campo:        { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 },
  label:        { fontSize: 13, fontWeight: 700, color: '#374151' },
  input:        { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box' },
  seccionTitulo:{ margin: '0 0 12px', fontWeight: 700, color: '#374151', fontSize: 14 },
};

export default GestionCxC;
