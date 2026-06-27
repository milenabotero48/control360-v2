// ============================================================

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

const ESTADOS = {
  VENCIDO:    { label: 'Vencido',     bg: '#fee2e2', color: '#b91c1c' },
  POR_VENCER: { label: 'Por vencer',  bg: '#fff8e6', color: '#b45309' },
  VIGENTE:    { label: 'Vigente',      bg: '#dcfce7', color: '#15803d' },
  GESTIONADO: { label: 'Gestionado',  bg: '#e0f2fe', color: '#0369a1' },
  SIN_FECHA:  { label: 'Sin fecha',   bg: '#f3f4f6', color: '#6b7280' },
};

export default function GestionVencimientos({ user }) {
  const [resumen,   setResumen]   = useState(null);
  const [lista,     setLista]     = useState([]);
  const [filtro,    setFiltro]    = useState('');
  const [busqueda,  setBusqueda]  = useState('');
  const [cargando,  setCargando]  = useState(true);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [importando,  setImportando]  = useState(false);
  const [msgImport,   setMsgImport]   = useState(null);
  const [form, setForm] = useState({
    clienteId: '', sucursal: '', descripcionEquipo: '',
    cantidad: 1, fechaUltimaRecarga: '', fechaVencimiento: '',
  });
  const [clientes, setClientes] = useState([]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const [resR, listR, cliR] = await Promise.all([
        fetch(`${API}/vencimientos/resumen`, { headers: authHeaders() }),
        fetch(`${API}/vencimientos${filtro ? `?estado=${filtro}` : ''}`, { headers: authHeaders() }),
        fetch(`${API}/clients`, { headers: authHeaders() }),
      ]);
      const [res, lst, clis] = await Promise.all([resR.json(), listR.json(), cliR.json()]);
      setResumen(res);
      setLista(Array.isArray(lst) ? lst : []);
      const arr = Array.isArray(clis) ? clis : (clis.clientes || clis.clients || []);
      setClientes(arr);
    } catch (e) { console.error(e); }
    setCargando(false);
  }, [filtro]);

  useEffect(() => { cargar(); }, [cargar]);

  const nombreCliente = (id) => {
    const c = clientes.find(c => (c.id || c.uid) === id);
    return c?.nombre || c?.empresa || id || '—';
  };

  const marcarGestionado = async (id) => {
    await fetch(`${API}/vencimientos/${id}`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ gestionado: true }),
    });
    cargar();
  };

  const crearVencimiento = async () => {
    if (!form.clienteId || !form.descripcionEquipo) return alert('Cliente y equipo son requeridos');
    if (!form.fechaUltimaRecarga && !form.fechaVencimiento) return alert('Ingresa la fecha de última recarga o vencimiento');
    const res = await fetch(`${API}/vencimientos`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Error al crear');
    setForm({ clienteId: '', sucursal: '', descripcionEquipo: '', cantidad: 1, fechaUltimaRecarga: '', fechaVencimiento: '' });
    setMostrarForm(false);
    cargar();
  };

  // Importador CSV
  const importarCSV = async (file) => {
    setImportando(true); setMsgImport(null);
    try {
      const texto = (await file.text()).replace(/^\uFEFF/, '');
      const lineas = texto.split(/\r?\n/).filter(l => l.trim());
      if (lineas.length < 2) throw new Error('Archivo vacío o sin datos');
      const sep = lineas[0].includes(';') ? ';' : ',';
      const headers = lineas[0].split(sep).map(h => h.trim().toLowerCase());
      const idx = (n) => headers.findIndex(h => h.includes(n));
      const iNombre = idx('nombre'), iTel = idx('tel'), iEquipo = idx('equipo');
      const iSuc = idx('sucursal'), iCant = idx('cant'), iFecha = idx('fecha');
      if (iNombre < 0 || iTel < 0) throw new Error('El archivo debe tener columnas nombre y telefono. Descarga la plantilla.');

      const filas = lineas.slice(1).map(l => {
        const c = l.split(sep);
        return {
          nombre:              c[iNombre]?.trim() || '',
          telefono:            c[iTel]?.trim() || '',
          equipo:              iEquipo >= 0 ? c[iEquipo]?.trim() : 'Extintor',
          sucursal:            iSuc   >= 0 ? c[iSuc]?.trim()   : null,
          cantidad:            iCant  >= 0 ? Number(c[iCant])  : 1,
          fechaUltimaRecarga:  iFecha >= 0 ? c[iFecha]?.trim() : null,
        };
      }).filter(f => f.nombre || f.telefono);

      const res = await fetch(`${API}/vencimientos/importar`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ filas }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al importar');
      setMsgImport(`✓ ${json.vencimientosCreados} vencimientos · ${json.clientesNuevos} clientes nuevos · ${json.prospectosCreados} prospectos sin fecha${json.errores?.length ? ` · ${json.errores.length} errores` : ''}`);
      cargar();
    } catch (e) {
      setMsgImport(`✗ ${e.message}`);
    }
    setImportando(false);
  };

  const descargarPlantilla = () => {
    const csv = '\uFEFFnombre;telefono;equipo;sucursal;cantidad;fechaUltimaRecarga\nCarlos Pérez;3101234567;Extintor ABC 10 lbs;Sede Norte;2;2024-01-15\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a'); a.href = url;
    a.download = 'plantilla_vencimientos.csv'; a.click();
  };

  const visibles = lista.filter(v => {
    if (!busqueda) return true;
    const q = busqueda.toLowerCase();
    return (
      (v.descripcionEquipo || '').toLowerCase().includes(q) ||
      (v.sucursal || '').toLowerCase().includes(q) ||
      (nombreCliente(v.clienteId) || '').toLowerCase().includes(q)
    );
  });

  const inp = { width: '100%', padding: '9px 10px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' };

  return (
    <div style={{ padding: '16px 16px 80px', maxWidth: 1100, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#1a1a2e' }}>⏰ Vencimientos</h1>
          <div style={{ fontSize: 12, color: '#6b7280' }}>Control de fechas de recarga por cliente y equipo</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={descargarPlantilla} style={{ background: '#fff', border: '1.5px solid #e5e7eb', color: '#374151', borderRadius: 9, padding: '8px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            ⬇ Plantilla
          </button>
          <label style={{ background: '#7c3aed', color: '#fff', borderRadius: 9, padding: '9px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            {importando ? 'Importando...' : '⬆ Importar CSV'}
            <input type="file" accept=".csv" hidden disabled={importando}
              onChange={e => { if (e.target.files[0]) importarCSV(e.target.files[0]); e.target.value = ''; }} />
          </label>
          <button onClick={() => setMostrarForm(!mostrarForm)} style={{ background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            + Nuevo
          </button>
        </div>
      </div>

      {/* Mensaje importación */}
      {msgImport && (
        <div style={{ background: msgImport.startsWith('✓') ? '#dcfce7' : '#fee2e2', color: msgImport.startsWith('✓') ? '#15803d' : '#b91c1c', borderRadius: 8, padding: '10px 14px', fontSize: 12.5, fontWeight: 600, marginBottom: 12 }}>
          {msgImport}
        </div>
      )}

      {/* Tarjetas resumen */}
      {resumen && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 16 }}>
          {Object.entries(ESTADOS).map(([k, v]) => (
            <div key={k} onClick={() => setFiltro(filtro === k ? '' : k)} style={{
              background: filtro === k ? v.bg : '#fff', border: `1.5px solid ${filtro === k ? v.color : '#e5e7eb'}`,
              borderRadius: 12, padding: '12px 14px', cursor: 'pointer', transition: 'all .15s',
            }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: v.color }}>{resumen[k] || 0}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: filtro === k ? v.color : '#6b7280' }}>{v.label}</div>
            </div>
          ))}
          <div style={{ background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 12, padding: '12px 14px' }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#1a1a2e' }}>{resumen.total || 0}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280' }}>Total</div>
          </div>
        </div>
      )}

      {/* Formulario nuevo vencimiento */}
      {mostrarForm && (
        <div style={{ background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 14, padding: 16, marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#1a1a2e', marginBottom: 12 }}>Nuevo vencimiento</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Cliente *</div>
              <select value={form.clienteId} onChange={e => setForm({ ...form, clienteId: e.target.value })} style={inp}>
                <option value="">— Selecciona —</option>
                {clientes.map(c => <option key={c.id || c.uid} value={c.id || c.uid}>{c.nombre || c.empresa}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Equipo *</div>
              <input placeholder="Ej: Extintor ABC 10 lbs" value={form.descripcionEquipo} onChange={e => setForm({ ...form, descripcionEquipo: e.target.value })} style={inp} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Sucursal</div>
              <input placeholder="Sede Norte" value={form.sucursal} onChange={e => setForm({ ...form, sucursal: e.target.value })} style={inp} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Cantidad</div>
              <input type="number" min="1" value={form.cantidad} onChange={e => setForm({ ...form, cantidad: e.target.value })} style={inp} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Última recarga</div>
              <input type="date" value={form.fechaUltimaRecarga} onChange={e => setForm({ ...form, fechaUltimaRecarga: e.target.value })} style={inp} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 4 }}>O vencimiento directo</div>
              <input type="date" value={form.fechaVencimiento} onChange={e => setForm({ ...form, fechaVencimiento: e.target.value })} style={inp} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={crearVencimiento} style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Guardar</button>
            <button onClick={() => setMostrarForm(false)} style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, padding: '9px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Buscador */}
      <input placeholder="🔍 Buscar por cliente, equipo o sucursal..." value={busqueda} onChange={e => setBusqueda(e.target.value)}
        style={{ ...inp, marginBottom: 12, background: '#fff' }} />

      {/* Tabla / Cards */}
      {cargando ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Cargando vencimientos...</div>
      ) : visibles.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 14, padding: 40, textAlign: 'center', border: '1.5px solid #e5e7eb' }}>
          <div style={{ fontSize: 32 }}>⏰</div>
          <div style={{ fontWeight: 700, color: '#1a1a2e', marginTop: 8 }}>No hay vencimientos{filtro ? ' en este estado' : ''}</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Importa tu base con el botón "Importar CSV" o crea uno manualmente</div>
        </div>
      ) : (
        <>
          {/* Desktop: tabla */}
          <div style={{ display: 'none' }} className="tabla-desktop">
          </div>

          {/* Cards (mobile + desktop) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            {visibles.map(v => {
              const est = ESTADOS[v.estado] || ESTADOS.SIN_FECHA;
              return (
                <div key={v.id} style={{ background: '#fff', borderRadius: 12, border: '1.5px solid #e5e7eb', padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5, color: '#1a1a2e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {v.descripcionEquipo || 'Sin descripción'}
                        {v.cantidad > 1 && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>×{v.cantidad}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                        {nombreCliente(v.clienteId)}{v.sucursal ? ` · ${v.sucursal}` : ''}
                      </div>
                    </div>
                    <span style={{ background: est.bg, color: est.color, fontWeight: 800, fontSize: 10, padding: '3px 9px', borderRadius: 8, flexShrink: 0 }}>
                      {est.label}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: '#6b7280', marginBottom: 10 }}>
                    {v.fechaUltimaRecarga && <span>🔧 Recarga: {v.fechaUltimaRecarga}</span>}
                    {v.fechaVencimiento   && <span>📅 Vence: <strong style={{ color: v.estado === 'VENCIDO' ? '#b91c1c' : '#1a1a2e' }}>{v.fechaVencimiento}</strong></span>}
                  </div>

                  {v.estado !== 'GESTIONADO' && (
                    <button onClick={() => marcarGestionado(v.id)} style={{
                      width: '100%', border: 'none', borderRadius: 8, padding: '8px 0',
                      background: '#f0fdf4', color: '#15803d', fontWeight: 700, fontSize: 12, cursor: 'pointer',
                    }}>
                      ✓ Marcar como gestionado
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'right', marginTop: 10 }}>
            {visibles.length} registro(s){filtro ? ` — filtrado: ${ESTADOS[filtro]?.label}` : ''}
          </div>
        </>
      )}
    </div>
  );
}
