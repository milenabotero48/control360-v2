import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const fmtFecha = f => f ? new Date(f + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const GestionCxP = ({ user }) => {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [cajas, setCajas]         = useState([]);
  const [formasPago, setFormasPago] = useState([]);
  const [formasPagoConfig, setFormasPagoConfig] = useState([]);
  const [tab, setTab]             = useState('proveedores');
  const [modalPago, setModalPago] = useState(null);
  const [formPago, setFormPago]   = useState({ formaPago: '', cajaId: '', cajaLabel: '', fechaPago: new Date().toISOString().split('T')[0] });
  const [montoAbono, setMontoAbono] = useState('');
  const [verAbonos, setVerAbonos] = useState(null); // egresoId del que se muestran los abonos
  const [guardando, setGuardando] = useState(false);
  const [exito, setExito]         = useState('');
  const [error, setError]         = useState('');

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // ✅ CXP-IVA-001: selector de período fiscal (cuatrimestre por defecto —
  // la declaración de IVA de estas empresas es cuatrimestral)
  const cuatrimestres = (() => {
    const hoy = new Date(Date.now() - 5 * 3600 * 1000);
    const anio = hoy.getUTCFullYear();
    const actual = Math.floor(hoy.getUTCMonth() / 4);
    const lista = [];
    for (const a of [anio, anio - 1]) {
      for (let c = 2; c >= 0; c--) {
        if (a === anio && c > actual) continue;
        lista.push({
          key: `${a}-${c}`,
          label: `${['Ene–Abr', 'May–Ago', 'Sep–Dic'][c]} ${a}`,
          desde: `${a}-${String(c * 4 + 1).padStart(2, '0')}-01`,
          hasta: `${a}-${String(c * 4 + 4).padStart(2, '0')}-31`,
        });
      }
    }
    return lista;
  })();
  const [periodo, setPeriodo] = useState(cuatrimestres[0]);

  const cargar = useCallback(async () => {
    try {
      setLoading(true);
      const [resCxp, resCajas, resConf] = await Promise.all([
        axios.get(`${API}/cxp?desde=${periodo.desde}&hasta=${periodo.hasta}`, { headers }),
        axios.get(`${API}/cajas`, { headers }),
        axios.get(`${API}/configuracion`, { headers }),
      ]);
      setData(resCxp.data);
      setCajas(Array.isArray(resCajas.data) ? resCajas.data : []);
      const fps = (resConf.data?.formasPago || []).filter(f => f.activa && f.nombre !== 'Cuenta por Pagar').map(f => f.nombre);
      setFormasPago(fps.length > 0 ? fps : ['Efectivo', 'Transferencia']);
      setFormasPagoConfig(resConf.data?.formasPago || []);
    } catch (e) { setError('Error al cargar CxP'); }
    finally { setLoading(false); }
  }, [token, periodo]);

  useEffect(() => { cargar(); }, [cargar]);

  const handleFormaPago = (nombre) => {
    const conf = (formasPagoConfig || []).find(f => f.nombre === nombre);
    const caja = conf?.cajaId ? cajas.find(c => c.id === conf.cajaId) : null;
    setFormPago(p => ({ ...p, formaPago: nombre, cajaId: caja?.id || '', cajaLabel: caja?.nombre || '' }));
  };

  const registrarPago = async () => {
    if (!formPago.formaPago || !formPago.cajaId) return setError('Selecciona forma de pago — debe tener caja asignada');
    const montoAbonoNum = Number(montoAbono) || 0;
    if (montoAbono && montoAbonoNum <= 0) return setError('El monto del abono debe ser mayor a 0');
    if (montoAbono && montoAbonoNum > (modalPago.saldo || 0)) return setError('El abono no puede superar el saldo pendiente');
    setGuardando(true); setError('');
    try {
      const payload = { ...formPago, montoAbono: montoAbonoNum || undefined };
      const { data: resp } = await axios.post(`${API}/cxp/${modalPago.id}/pagar`, payload, { headers });
      setExito(resp.esAbonoParcial ? `Abono de ${fmt(resp.montoPagado)} registrado. Saldo restante: ${fmt(resp.saldoRestante)}` : 'Pago total registrado ✓');
      setModalPago(null);
      setMontoAbono('');
      setFormPago({ formaPago: '', cajaId: '', cajaLabel: '', fechaPago: new Date().toISOString().split('T')[0] });
      setTimeout(() => setExito(''), 3000);
      await cargar();
    } catch (e) { setError(e.response?.data?.error || 'Error al registrar pago'); }
    setGuardando(false);
  };

  const exportarExcel = () => {
    if (!data) return;
    const rows = [];
    rows.push(['CUENTAS POR PAGAR — Control360']);
    rows.push([]);
    rows.push(['PROVEEDORES']);
    rows.push(['Proveedor', 'N° Comprobante', 'Concepto', 'Fecha', 'Total', 'Saldo']);
    data.proveedores.forEach(p => {
      p.egresos.forEach(e => {
        rows.push([p.proveedorNombre, e.numero, e.concepto, e.fecha, e.total, e.saldo]);
      });
    });
    rows.push([]);
    rows.push(['IMPUESTOS']);
    rows.push(['Concepto', 'Valor']);
    rows.push(['IVA generado', data.impuestos.ivaGenerado]);
    rows.push(['IVA descontable', data.impuestos.totalIvaDescontable]);
    rows.push(['IVA neto a pagar', data.impuestos.ivaNeto]);
    rows.push(['Retefuente pendiente', data.impuestos.retefuente]);
    rows.push(['Renta (retenciones clientes)', data.impuestos.renta]);

    const csv = rows.map(r => r.join(';')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `cxp_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  };

  const imprimirResumen = () => {
    if (!data) return;
    const filasProv = data.proveedores.map(p =>
      `<tr style="background:#7c3aed;color:#fff"><td colspan="5" style="padding:8px 12px;font-weight:700">${p.proveedorNombre}</td></tr>
       ${p.egresos.map(e => `<tr><td style="padding:7px 12px">${e.numero}</td><td style="padding:7px 12px">${e.concepto}</td><td style="padding:7px 12px">${fmtFecha(e.fecha)}</td><td style="padding:7px 12px;text-align:right">${fmt(e.total)}</td><td style="padding:7px 12px;text-align:right;color:#dc2626;font-weight:700">${fmt(e.saldo)}</td></tr>`).join('')}`
    ).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>CxP</title>
    <style>body{font-family:'Segoe UI',sans-serif;padding:24px;color:#111}table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px}th{background:#f8fafc;padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase}td{border-bottom:1px solid #f3f4f6}@media print{body{padding:8mm}}</style>
    </head><body>
    <h2 style="color:#7c3aed;margin-bottom:4px">Cuentas por Pagar</h2>
    <p style="color:#9ca3af;font-size:12px;margin-bottom:24px">Generado el ${new Date().toLocaleDateString('es-CO', { day:'2-digit', month:'long', year:'numeric' })}</p>
    <h3>Proveedores</h3>
    <table><thead><tr><th>N°</th><th>Concepto</th><th>Fecha</th><th style="text-align:right">Total</th><th style="text-align:right">Saldo</th></tr></thead>
    <tbody>${filasProv}</tbody></table>
    <h3>Impuestos</h3>
    <table><thead><tr><th>Concepto</th><th style="text-align:right">Valor</th></tr></thead>
    <tbody>
      <tr><td style="padding:7px 12px">IVA generado en órdenes</td><td style="padding:7px 12px;text-align:right">${fmt(data.impuestos.ivaGenerado)}</td></tr>
      <tr><td style="padding:7px 12px">IVA descontable (compras)</td><td style="padding:7px 12px;text-align:right;color:#16a34a">(${fmt(data.impuestos.totalIvaDescontable)})</td></tr>
      <tr style="font-weight:700"><td style="padding:7px 12px">IVA neto a ${data.impuestos.ivaNeto < 0 ? 'favor' : 'pagar'}</td><td style="padding:7px 12px;text-align:right;color:${data.impuestos.ivaNeto < 0 ? '#16a34a' : '#dc2626'}">${fmt(Math.abs(data.impuestos.ivaNeto))}</td></tr>
      <tr><td style="padding:7px 12px">Retefuente pendiente</td><td style="padding:7px 12px;text-align:right">${fmt(data.impuestos.retefuente)}</td></tr>
      <tr><td style="padding:7px 12px">Renta (retenciones clientes)</td><td style="padding:7px 12px;text-align:right">${fmt(data.impuestos.renta)}</td></tr>
    </tbody></table>
    </body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 500);
  };

  if (loading) return <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Cargando CxP...</div>;

  return (
    <div style={s.wrapper}>
      <div style={s.header}>
        <div>
          <h2 style={s.titulo}>📋 Cuentas por Pagar</h2>
          <p style={s.subtitulo}>Proveedores · IVA · Retefuente · Renta</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={exportarExcel} style={s.btnSec}>📥 Exportar CSV</button>
          <button onClick={imprimirResumen} style={s.btnSec}>🖨️ Imprimir</button>
        </div>
      </div>

      {exito && <div style={s.alertOk}>{exito}</div>}
      {error && <div style={s.alertError}>{error}</div>}

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        <div style={s.kpi}>
          <span style={s.kpiLabel}>Total proveedores</span>
          <span style={{ ...s.kpiVal, color: '#dc2626' }}>{fmt(data?.totales?.proveedores)}</span>
        </div>
        <div style={{ ...s.kpi, background: data?.impuestos?.ivaNeto < 0 ? '#f0fdf4' : '#fef2f2' }}>
          <span style={s.kpiLabel}>IVA neto {data?.impuestos?.ivaNeto < 0 ? '(a favor)' : '(a pagar)'}</span>
          <span style={{ ...s.kpiVal, color: data?.impuestos?.ivaNeto < 0 ? '#16a34a' : '#dc2626' }}>{fmt(Math.abs(data?.impuestos?.ivaNeto || 0))}</span>
        </div>
        <div style={s.kpi}>
          <span style={s.kpiLabel}>Retefuente pendiente</span>
          <span style={{ ...s.kpiVal, color: '#7c3aed' }}>{fmt(data?.impuestos?.retefuente)}</span>
        </div>
        <div style={s.kpi}>
          <span style={s.kpiLabel}>Renta (retenciones)</span>
          <span style={{ ...s.kpiVal, color: '#d97706' }}>{fmt(data?.impuestos?.renta)}</span>
        </div>
      </div>

      {/* TABS */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[{ key: 'proveedores', label: '🏭 Proveedores' }, { key: 'impuestos', label: '🧾 Impuestos' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '9px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13, border: 'none',
            background: tab === t.key ? '#7c3aed' : '#f3f4f6',
            color: tab === t.key ? '#fff' : '#374151',
          }}>{t.label}</button>
        ))}
      </div>

      {/* TAB PROVEEDORES */}
      {tab === 'proveedores' && (
        data?.proveedores?.length === 0 ? (
          <div style={s.empty}><p style={{ fontSize: 48, margin: '0 0 12px' }}>🏭</p><p>No hay deudas con proveedores</p></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {data?.proveedores?.map((prov, i) => (
              <div key={i} style={s.card}>
                <div style={s.cardHeader}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 16, color: '#111' }}>{prov.proveedorNombre}</div>
                    <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{prov.egresos.length} comprobante{prov.egresos.length !== 1 ? 's' : ''} pendiente{prov.egresos.length !== 1 ? 's' : ''}</div>
                  </div>
                  <span style={{ fontSize: 20, fontWeight: 800, color: '#dc2626' }}>{fmt(prov.totalPendiente)}</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 12 }}>
                  <thead><tr style={{ background: '#f8fafc' }}>
                    {['N°', 'Concepto', 'Fecha', 'Total', 'Saldo', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {prov.egresos.map((e, j) => (
                      <tr key={j} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={s.td}><code style={{ fontSize: 12 }}>{e.numero}</code></td>
                        <td style={s.td}>{e.concepto}</td>
                        <td style={s.td}>{fmtFecha(e.fecha)}</td>
                        <td style={s.td}>{fmt(e.total)}</td>
                        <td style={{ ...s.td, fontWeight: 700, color: '#dc2626' }}>{fmt(e.saldo)}</td>
                        <td style={s.td}>
                          <button onClick={() => { setModalPago(e); setError(''); }}
                            style={{ padding: '4px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                            💳 Pagar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )
      )}

      {/* TAB IMPUESTOS */}
      {/* ✅ CXP-IVA-001: período fiscal — IVA causado por factura registrada */}
      {tab === 'impuestos' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280' }}>📅 Período de declaración:</span>
          {cuatrimestres.map(c => (
            <button key={c.key} onClick={() => setPeriodo(c)} style={{
              border: periodo.key === c.key ? '2px solid #7c3aed' : '1px solid #d1d5db',
              background: periodo.key === c.key ? '#f5f3ff' : '#fff',
              color: periodo.key === c.key ? '#5b21b6' : '#374151',
              borderRadius: 99, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}>{c.label}</button>
          ))}
        </div>
      )}
      {tab === 'impuestos' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* IVA */}
          <div style={s.card}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#0284c7' }}>🔵 IVA</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div style={s.impItem}><span style={s.impLabel}>IVA generado en órdenes</span><span style={{ fontWeight: 700, color: '#dc2626' }}>{fmt(data?.impuestos?.ivaGenerado)}</span></div>
              <div style={s.impItem}><span style={s.impLabel}>IVA descontable (compras)</span><span style={{ fontWeight: 700, color: '#16a34a' }}>({fmt(data?.impuestos?.totalIvaDescontable)})</span></div>
              <div style={{ ...s.impItem, background: data?.impuestos?.ivaNeto < 0 ? '#f0fdf4' : '#fef2f2', border: `1px solid ${data?.impuestos?.ivaNeto < 0 ? '#86efac' : '#fca5a5'}` }}>
                <span style={s.impLabel}>IVA neto {data?.impuestos?.ivaNeto < 0 ? '✅ A FAVOR' : '⚠️ A PAGAR'}</span>
                <span style={{ fontWeight: 800, fontSize: 18, color: data?.impuestos?.ivaNeto < 0 ? '#16a34a' : '#dc2626' }}>{fmt(Math.abs(data?.impuestos?.ivaNeto || 0))}</span>
              </div>
            </div>
          </div>

          {/* Retefuente */}
          <div style={s.card}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#7c3aed' }}>🟣 Retefuente (pago mensual)</h3>
            <div style={s.impItem}>
              <span style={s.impLabel}>Total retenciones practicadas pendientes de pago</span>
              <span style={{ fontWeight: 800, fontSize: 18, color: '#7c3aed' }}>{fmt(data?.impuestos?.retefuente)}</span>
            </div>
          </div>

          {/* Renta */}
          <div style={s.card}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#d97706' }}>🟡 Renta (pago anual)</h3>
            <div style={s.impItem}>
              <span style={s.impLabel}>Retenciones que te practicaron los clientes</span>
              <span style={{ fontWeight: 800, fontSize: 18, color: '#d97706' }}>{fmt(data?.impuestos?.renta)}</span>
            </div>
            {data?.impuestos?.retencionesClientes?.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 12 }}>
                <thead><tr style={{ background: '#f8fafc' }}>
                  {['Orden', 'Cliente', 'Fecha', 'Retención'].map(h => <th key={h} style={s.th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {data.impuestos.retencionesClientes.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={s.td}><code style={{ fontSize: 12 }}>{r.numeroOrden}</code></td>
                      <td style={s.td}>{r.clienteNombre}</td>
                      <td style={s.td}>{fmtFecha(r.fecha)}</td>
                      <td style={{ ...s.td, fontWeight: 700, color: '#d97706' }}>{fmt(r.monto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* MODAL PAGO */}
      {modalPago && (
        <div style={s.overlay}>
          <div style={{ background: '#fff', borderRadius: 16, maxWidth: 480, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ background: 'linear-gradient(135deg,#7c3aed,#6d28d9)', padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: 0, color: '#fff', fontSize: 16, fontWeight: 700 }}>💳 Registrar Pago / Abono</h3>
                <p style={{ margin: '4px 0 0', color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>{modalPago.concepto}</p>
              </div>
              <button onClick={() => { setModalPago(null); setError(''); setMontoAbono(''); }} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 8, color: '#fff', width: 28, height: 28, cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>
            <div style={{ padding: '20px 24px' }}>
              {/* Saldo actual */}
              <div style={{ background: '#faf5ff', border: '1px solid #c4b5fd', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' }}>Saldo pendiente</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#7c3aed' }}>{fmt(modalPago.saldo)}</div>
                  </div>
                  {(modalPago.abonos?.length > 0) && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{modalPago.abonos.length} abono(s) previo(s)</div>
                      <div style={{ fontSize: 13, color: '#16a34a', fontWeight: 700 }}>Pagado: {fmt(modalPago.montoPagado || 0)}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Historial de abonos anteriores */}
              {(modalPago.abonos?.length > 0) && (
                <div style={{ marginBottom: 16 }}>
                  <button onClick={() => setVerAbonos(verAbonos === modalPago.id ? null : modalPago.id)}
                    style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 12px', fontSize: 12, color: '#6b7280', cursor: 'pointer', fontWeight: 600, width: '100%' }}>
                    {verAbonos === modalPago.id ? '▲ Ocultar' : '▼ Ver'} historial de abonos ({modalPago.abonos.length})
                  </button>
                  {verAbonos === modalPago.id && (
                    <div style={{ marginTop: 8, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead><tr style={{ background: '#f9fafb' }}>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 700 }}>Fecha</th>
                          <th style={{ padding: '8px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 700 }}>Forma</th>
                          <th style={{ padding: '8px 10px', textAlign: 'right', color: '#6b7280', fontWeight: 700 }}>Monto</th>
                          <th style={{ padding: '8px 10px', textAlign: 'right', color: '#6b7280', fontWeight: 700 }}>Saldo</th>
                        </tr></thead>
                        <tbody>
                          {(modalPago.abonos || []).map((ab, i) => (
                            <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                              <td style={{ padding: '8px 10px' }}>{ab.fecha ? ab.fecha.slice(0,10) : '—'}</td>
                              <td style={{ padding: '8px 10px' }}>{ab.formaPago}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'right', color: '#16a34a', fontWeight: 700 }}>{fmt(ab.monto)}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'right', color: '#dc2626' }}>{fmt(ab.saldoDespues)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Monto del abono */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
                  Monto a pagar <span style={{ fontWeight: 400, color: '#6b7280' }}>(vacío = pagar todo el saldo)</span>
                </label>
                <input
                  type="number"
                  value={montoAbono}
                  onChange={e => setMontoAbono(e.target.value)}
                  placeholder={`Máx: ${(modalPago.saldo || 0).toLocaleString('es-CO')}`}
                  style={{ padding: '10px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 15, fontWeight: 700, outline: 'none', color: '#7c3aed' }}
                />
                {montoAbono && Number(montoAbono) < (modalPago.saldo || 0) && (
                  <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>
                    ⚠️ Abono parcial — quedará saldo de {fmt((modalPago.saldo || 0) - Number(montoAbono))}
                  </div>
                )}
              </div>

              {/* Forma de pago */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Forma de pago *</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {formasPago.map(f => (
                    <button key={f} type="button" onClick={() => handleFormaPago(f)} style={{
                      padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, border: 'none',
                      background: formPago.formaPago === f ? '#7c3aed' : '#f3f4f6',
                      color: formPago.formaPago === f ? '#fff' : '#374151',
                    }}>{f}</button>
                  ))}
                </div>
                {formPago.cajaLabel && <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✅ Caja: {formPago.cajaLabel}</div>}
                {formPago.formaPago && !formPago.cajaId && <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 600 }}>⚠️ Sin caja asignada en Mi Empresa</div>}
              </div>

              {/* Fecha */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Fecha de pago</label>
                <input type="date" value={formPago.fechaPago} onChange={e => setFormPago(p => ({ ...p, fechaPago: e.target.value }))}
                  style={{ padding: '9px 12px', border: '2px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }} />
              </div>

              {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12, fontWeight: 600 }}>⚠️ {error}</div>}
            </div>
            <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => { setModalPago(null); setError(''); setMontoAbono(''); }} style={{ padding: '10px 20px', background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>Cancelar</button>
              <button onClick={registrarPago} disabled={guardando} style={{ padding: '10px 24px', background: 'linear-gradient(135deg,#7c3aed,#6d28d9)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                {guardando ? 'Registrando...' : montoAbono && Number(montoAbono) < (modalPago.saldo || 0) ? '💰 Registrar abono' : '✅ Pagar total'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const s = {
  wrapper:  { padding: '32px', maxWidth: 1400, margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  header:   { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  titulo:   { margin: 0, fontSize: 26, fontWeight: 700, color: '#111' },
  subtitulo:{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 },
  btnSec:   { padding: '10px 18px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  kpi:      { background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', display: 'flex', flexDirection: 'column', gap: 6 },
  kpiLabel: { fontSize: 12, color: '#6b7280', fontWeight: 600 },
  kpiVal:   { fontSize: 20, fontWeight: 800, color: '#111' },
  card:     { background: '#fff', borderRadius: 12, padding: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' },
  cardHeader:{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  th:       { padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' },
  td:       { padding: '10px 12px', fontSize: 13, color: '#374151', borderBottom: '1px solid #f3f4f6' },
  impItem:  { background: '#f9fafb', borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  impLabel: { fontSize: 13, color: '#6b7280' },
  empty:    { textAlign: 'center', padding: 60, color: '#9ca3af', background: '#fff', borderRadius: 12 },
  alertOk:  { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  alertError:{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  overlay:  { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
};

export default GestionCxP;

