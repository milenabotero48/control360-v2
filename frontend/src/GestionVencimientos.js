// ============================================================
// Control360 — Gestión de Vencimientos v4
// Vista: acordeón por mes → agrupado por CLIENTE → lista equipos
// Export CSV con toda la info comercial
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

const ESTADOS = {
  VENCIDO:    { label: 'Vencido',    bg: '#fee2e2', color: '#b91c1c' },
  POR_VENCER: { label: 'Por vencer', bg: '#fff8e6', color: '#b45309' },
  VIGENTE:    { label: 'Vigente',    bg: '#dcfce7', color: '#15803d' },
  GESTIONADO: { label: 'Gestionado', bg: '#e0f2fe', color: '#0369a1' },
  SIN_FECHA:  { label: 'Sin fecha',  bg: '#f3f4f6', color: '#6b7280' },
};

const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

const formatMes = (f) => {
  if (!f) return 'Sin fecha';
  const p = f.slice(0,7).split('-');
  return p.length < 2 ? f : `${MESES[parseInt(p[1],10)-1]} ${p[0]}`;
};

const mesKey = (f) => f ? f.slice(0,7) : 'sin_fecha';

const telBonito = (t) => {
  if (!t) return '';
  const s = String(t).replace(/^57/,'');
  return s.length === 10 ? `${s.slice(0,3)} ${s.slice(3,6)} ${s.slice(6)}` : s;
};

// Estado más urgente del grupo de equipos del cliente
const estadoMasUrgente = (equipos) => {
  if (equipos.some(e => e.estado === 'VENCIDO'))    return 'VENCIDO';
  if (equipos.some(e => e.estado === 'POR_VENCER')) return 'POR_VENCER';
  if (equipos.every(e => e.estado === 'GESTIONADO')) return 'GESTIONADO';
  return 'VIGENTE';
};

export default function GestionVencimientos({ user }) {
  const [lista,        setLista]        = useState([]);
  const [resumen,      setResumen]      = useState(null);
  const [clientes,     setClientes]     = useState([]);
  const [cargando,     setCargando]     = useState(true);
  const [busqueda,     setBusqueda]     = useState('');
  const [filtroEstado, setFiltroEstado] = useState('');
  const [mesAbierto,   setMesAbierto]   = useState(null);
  const [detalle,      setDetalle]      = useState(null); // { cli, equipos, mes }
  const [mostrarForm,  setMostrarForm]  = useState(false);
  const [importando,   setImportando]   = useState(false);
  const [msgImport,    setMsgImport]    = useState(null);
  const [form, setForm] = useState({ clienteId:'', sucursal:'', descripcionEquipo:'', cantidad:1, mesServicio:'' });

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const url = filtroEstado ? `${API}/vencimientos?estado=${filtroEstado}` : `${API}/vencimientos`;
      const [r1,r2,r3] = await Promise.all([
        fetch(`${API}/vencimientos/resumen`, { headers: authHeaders() }),
        fetch(url, { headers: authHeaders() }),
        fetch(`${API}/clients`, { headers: authHeaders() }),
      ]);
      const [res,lst,clis] = await Promise.all([r1.json(),r2.json(),r3.json()]);
      setResumen(res);
      setLista(Array.isArray(lst) ? lst : []);
      const arr = Array.isArray(clis) ? clis : (clis.clientes||clis.clients||[]);
      setClientes(arr);
    } catch(e) { console.error(e); }
    setCargando(false);
  }, [filtroEstado]);

  useEffect(() => { cargar(); }, [cargar]);

  const buscarCliente = (id) => clientes.find(c => (c.id||c.uid) === id);

  // Agrupar: mes → cliente → equipos
  const agruparPorMesYCliente = () => {
    const filtrados = lista.filter(v => {
      if (!busqueda) return true;
      const q = busqueda.toLowerCase();
      const cli = buscarCliente(v.clienteId);
      return (
        (v.descripcionEquipo||'').toLowerCase().includes(q) ||
        (v.sucursal||'').toLowerCase().includes(q) ||
        (cli?.nombre||'').toLowerCase().includes(q) ||
        (cli?.empresa||'').toLowerCase().includes(q) ||
        (v.telefono||'').includes(q)
      );
    });

    // Nivel 1: por mes
    const meses = {};
    filtrados.forEach(v => {
      const mk = mesKey(v.fechaVencimiento);
      if (!meses[mk]) meses[mk] = { key:mk, label:formatMes(v.fechaVencimiento), clientes:{} };
      // Nivel 2: por cliente dentro del mes
      const cli = buscarCliente(v.clienteId);
      const cKey = v.clienteId || v.telefono || 'sin_cliente';
      if (!meses[mk].clientes[cKey]) {
        meses[mk].clientes[cKey] = {
          cKey, clienteId: v.clienteId,
          nombre: cli?.nombre || cli?.empresa || 'Sin nombre',
          telefono: cli?.celular || cli?.telefono || v.telefono || null,
          direccion: cli?.direccionPrincipal || cli?.direccion || null,
          email: cli?.emailLegal || cli?.email || null,
          equipos: [],
        };
      }
      meses[mk].clientes[cKey].equipos.push(v);
    });

    return Object.values(meses)
      .sort((a,b) => a.key.localeCompare(b.key))
      .map(m => ({
        ...m,
        clientes: Object.values(m.clientes),
        total: Object.values(m.clientes).length,
        estados: Object.values(m.clientes).reduce((acc, c) => {
          const est = estadoMasUrgente(c.equipos);
          acc[est] = (acc[est]||0) + 1;
          return acc;
        }, {}),
      }));
  };

  const marcarTodosGestionados = async (equipos, e) => {
    e?.stopPropagation();
    await Promise.all(equipos.filter(eq => eq.estado !== 'GESTIONADO').map(eq =>
      fetch(`${API}/vencimientos/${eq.id}`, {
        method:'PUT', headers:authHeaders(), body:JSON.stringify({ gestionado:true }),
      })
    ));
    setDetalle(null);
    cargar();
  };

  // ─── EXPORTAR CSV ──────────────────────────────────────────────────────────
  const exportarCSV = (grupos) => {
    const filas = [
      ['Mes Vencimiento','Cliente','Teléfono','Dirección','Email','Equipos','Cantidad Total','Estado']
    ];
    grupos.forEach(g => {
      g.clientes.forEach(c => {
        const equiposTexto = c.equipos.map(e =>
          `${e.cantidad > 1 ? e.cantidad+'x ' : ''}${e.descripcionEquipo}${e.sucursal?' ('+e.sucursal+')':''}`
        ).join(' | ');
        const cantTotal = c.equipos.reduce((s,e) => s + (Number(e.cantidad)||1), 0);
        const estado = estadoMasUrgente(c.equipos);
        filas.push([
          g.label,
          c.nombre,
          telBonito(c.telefono) || '',
          c.direccion || '',
          c.email || '',
          equiposTexto,
          cantTotal,
          ESTADOS[estado]?.label || estado,
        ]);
      });
    });
    const csv = '\uFEFF' + filas.map(f => f.map(v => `"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n');
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
    const a = document.createElement('a'); a.href=url;
    a.download = `vencimientos_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  };

  const crearVencimiento = async () => {
    if (!form.clienteId || !form.descripcionEquipo) return alert('Cliente y equipo son requeridos');
    if (!form.mesServicio) return alert('Selecciona el mes de servicio');
    const [y,m] = form.mesServicio.split('-').map(Number);
    const fechaVencimiento = `${y+1}-${String(m).padStart(2,'0')}-01`;
    const r = await fetch(`${API}/vencimientos`, {
      method:'POST', headers:authHeaders(), body:JSON.stringify({ ...form, fechaVencimiento }),
    });
    if (!r.ok) { const d=await r.json(); return alert(d.error||'Error'); }
    setForm({ clienteId:'', sucursal:'', descripcionEquipo:'', cantidad:1, mesServicio:'' });
    setMostrarForm(false); cargar();
  };

  const importarCSV = async (file) => {
    setImportando(true); setMsgImport(null);
    try {
      const texto = (await file.text()).replace(/^\uFEFF/,'');
      const lineas = texto.split(/\r?\n/).filter(l => l.trim());
      if (lineas.length < 2) throw new Error('Archivo vacío');
      const sep = lineas[0].includes(';') ? ';' : ',';
      const headers = lineas[0].split(sep).map(h => h.trim().toLowerCase());
      const idx = n => headers.findIndex(h => h.includes(n));
      const iN=idx('nombre'),iT=idx('tel'),iE=idx('equipo'),iS=idx('sucursal'),iC=idx('cant'),iF=idx('fecha');
      if (iN<0||iT<0) throw new Error('El archivo debe tener columnas nombre y telefono');
      const filas = lineas.slice(1).map(l => {
        const c = l.split(sep);
        return { nombre:c[iN]?.trim()||'', telefono:c[iT]?.trim()||'',
          equipo:iE>=0?c[iE]?.trim():'Extintor', sucursal:iS>=0?c[iS]?.trim():null,
          cantidad:iC>=0?Number(c[iC]):1, fechaUltimaRecarga:iF>=0?c[iF]?.trim():null };
      }).filter(f => f.nombre||f.telefono);
      const r = await fetch(`${API}/vencimientos/importar`, {
        method:'POST', headers:authHeaders(), body:JSON.stringify({ filas }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error||'Error');
      setMsgImport(`✓ ${json.vencimientosCreados} vencimientos · ${json.clientesNuevos} clientes · ${json.prospectosCreados} prospectos sin fecha`);
      cargar();
    } catch(e) { setMsgImport(`✗ ${e.message}`); }
    setImportando(false);
  };

  const descargarPlantilla = () => {
    const csv = '\uFEFFnombre;telefono;equipo;sucursal;cantidad;fechaUltimaRecarga\nCarlos Pérez;3101234567;Extintor ABC 10 lbs;Sede Norte;2;2024-06\n';
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
    const a = document.createElement('a'); a.href=url; a.download='plantilla_vencimientos.csv'; a.click();
  };

  const grupos = agruparPorMesYCliente();
  const inp = { width:'100%', padding:'9px 10px', borderRadius:8, border:'1.5px solid #e5e7eb', fontSize:13, boxSizing:'border-box', fontFamily:'inherit' };

  return (
    <div style={{ padding:'12px 12px 80px', maxWidth:1100, margin:'0 auto' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:10, marginBottom:14 }}>
        <div>
          <h1 style={{ margin:0, fontSize:18, fontWeight:800, color:'#1a1a2e' }}>⏰ Vencimientos</h1>
          <div style={{ fontSize:11, color:'#6b7280' }}>Agrupado por mes · un registro por cliente</div>
        </div>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
          <button onClick={descargarPlantilla} style={{ background:'#fff', border:'1.5px solid #e5e7eb', color:'#374151', borderRadius:8, padding:'7px 12px', fontWeight:700, fontSize:11, cursor:'pointer' }}>⬇ Plantilla</button>
          <label style={{ background:'#7c3aed', color:'#fff', borderRadius:8, padding:'8px 12px', fontWeight:700, fontSize:11, cursor:'pointer' }}>
            {importando?'Importando...':'⬆ Importar'}
            <input type="file" accept=".csv" hidden disabled={importando}
              onChange={e => { if(e.target.files[0]) importarCSV(e.target.files[0]); e.target.value=''; }} />
          </label>
          <button onClick={() => exportarCSV(grupos)} style={{ background:'#15803d', color:'#fff', border:'none', borderRadius:8, padding:'8px 12px', fontWeight:700, fontSize:11, cursor:'pointer' }}>
            📥 Exportar
          </button>
          <button onClick={() => setMostrarForm(!mostrarForm)} style={{ background:'#1a1a2e', color:'#fff', border:'none', borderRadius:8, padding:'8px 12px', fontWeight:700, fontSize:11, cursor:'pointer' }}>+ Nuevo</button>
        </div>
      </div>

      {msgImport && (
        <div style={{ background:msgImport.startsWith('✓')?'#dcfce7':'#fee2e2', color:msgImport.startsWith('✓')?'#15803d':'#b91c1c', borderRadius:8, padding:'9px 12px', fontSize:12, fontWeight:600, marginBottom:10 }}>
          {msgImport}
        </div>
      )}

      {/* Chips resumen */}
      {resumen && (
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12 }}>
          <button onClick={() => setFiltroEstado('')} style={{ border:`2px solid ${!filtroEstado?'#1a1a2e':'transparent'}`, background:!filtroEstado?'#1a1a2e':'#fff', color:!filtroEstado?'#fff':'#374151', borderRadius:99, padding:'5px 14px', fontWeight:700, fontSize:11, cursor:'pointer' }}>
            Todos {resumen.total||0}
          </button>
          {Object.entries(ESTADOS).map(([k,v]) => (resumen[k]||0) > 0 && (
            <button key={k} onClick={() => setFiltroEstado(filtroEstado===k?'':k)} style={{ border:`2px solid ${filtroEstado===k?v.color:'transparent'}`, background:v.bg, color:v.color, borderRadius:99, padding:'5px 14px', fontWeight:700, fontSize:11, cursor:'pointer' }}>
              {v.label} {resumen[k]}
            </button>
          ))}
        </div>
      )}

      {/* Formulario nuevo */}
      {mostrarForm && (
        <div style={{ background:'#fff', border:'1.5px solid #e5e7eb', borderRadius:12, padding:14, marginBottom:14 }}>
          <div style={{ fontWeight:800, fontSize:13, color:'#1a1a2e', marginBottom:10 }}>Nuevo vencimiento</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:8 }}>
            <div><div style={{ fontSize:11, fontWeight:700, color:'#374151', marginBottom:3 }}>Cliente *</div>
              <select value={form.clienteId} onChange={e => setForm({...form,clienteId:e.target.value})} style={inp}>
                <option value="">— Selecciona —</option>
                {clientes.map(c => <option key={c.id||c.uid} value={c.id||c.uid}>{c.nombre||c.empresa}</option>)}
              </select></div>
            <div><div style={{ fontSize:11, fontWeight:700, color:'#374151', marginBottom:3 }}>Equipo *</div>
              <input placeholder="Ej: Extintor ABC 10 lbs" value={form.descripcionEquipo} onChange={e => setForm({...form,descripcionEquipo:e.target.value})} style={inp} /></div>
            <div><div style={{ fontSize:11, fontWeight:700, color:'#374151', marginBottom:3 }}>Mes servicio *</div>
              <input type="month" value={form.mesServicio} onChange={e => setForm({...form,mesServicio:e.target.value})} style={inp} /></div>
            <div><div style={{ fontSize:11, fontWeight:700, color:'#374151', marginBottom:3 }}>Sucursal</div>
              <input placeholder="Sede Norte" value={form.sucursal} onChange={e => setForm({...form,sucursal:e.target.value})} style={inp} /></div>
            <div><div style={{ fontSize:11, fontWeight:700, color:'#374151', marginBottom:3 }}>Cantidad</div>
              <input type="number" min="1" value={form.cantidad} onChange={e => setForm({...form,cantidad:e.target.value})} style={inp} /></div>
          </div>
          <div style={{ display:'flex', gap:8, marginTop:10 }}>
            <button onClick={crearVencimiento} style={{ background:'#7c3aed', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', fontWeight:700, fontSize:12, cursor:'pointer' }}>Guardar</button>
            <button onClick={() => setMostrarForm(false)} style={{ background:'#f3f4f6', color:'#374151', border:'none', borderRadius:8, padding:'8px 14px', fontWeight:700, fontSize:12, cursor:'pointer' }}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Buscador */}
      <input placeholder="🔍 Buscar por cliente, equipo, sucursal o teléfono..."
        value={busqueda} onChange={e => setBusqueda(e.target.value)}
        style={{ ...inp, marginBottom:12, background:'#fff' }} />

      {/* Acordeón por mes */}
      {cargando ? (
        <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Cargando...</div>
      ) : grupos.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:12, padding:40, textAlign:'center', border:'1.5px solid #e5e7eb' }}>
          <div style={{ fontSize:32 }}>⏰</div>
          <div style={{ fontWeight:700, color:'#1a1a2e', marginTop:8 }}>Sin vencimientos</div>
          <div style={{ fontSize:12, color:'#9ca3af', marginTop:4 }}>Importa tu base o crea uno manualmente</div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {grupos.map(g => {
            const abierto = mesAbierto === g.key;
            const vencidos   = g.estados['VENCIDO']    || 0;
            const porVencer  = g.estados['POR_VENCER'] || 0;
            const gestionados= g.estados['GESTIONADO'] || 0;
            const colorBorde = vencidos > 0 ? '#fca5a5' : porVencer > 0 ? '#fcd34d' : '#e5e7eb';
            const colorTitulo= vencidos > 0 ? '#b91c1c' : porVencer > 0 ? '#b45309' : '#1a1a2e';

            return (
              <div key={g.key} style={{ background:'#fff', borderRadius:12, border:`1.5px solid ${colorBorde}`, overflow:'hidden' }}>

                {/* Header mes */}
                <div onClick={() => setMesAbierto(abierto ? null : g.key)}
                  style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 16px', cursor:'pointer', userSelect:'none' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, flex:1, flexWrap:'wrap' }}>
                    <div style={{ fontWeight:800, fontSize:15, color:colorTitulo, minWidth:130 }}>📅 {g.label}</div>
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                      <span style={{ background:'#f3f4f6', color:'#374151', fontWeight:700, fontSize:12, padding:'3px 10px', borderRadius:99 }}>
                        {g.total} cliente{g.total!==1?'s':''}
                      </span>
                      {vencidos>0    && <span style={{ background:'#fee2e2', color:'#b91c1c', fontWeight:700, fontSize:11, padding:'3px 9px', borderRadius:99 }}>⛔ {vencidos} vencido{vencidos>1?'s':''}</span>}
                      {porVencer>0   && <span style={{ background:'#fff8e6', color:'#b45309', fontWeight:700, fontSize:11, padding:'3px 9px', borderRadius:99 }}>⚠️ {porVencer} por vencer</span>}
                      {gestionados>0 && <span style={{ background:'#e0f2fe', color:'#0369a1', fontWeight:700, fontSize:11, padding:'3px 9px', borderRadius:99 }}>✓ {gestionados} gestionado{gestionados>1?'s':''}</span>}
                    </div>
                  </div>
                  <span style={{ fontSize:16, color:'#9ca3af' }}>{abierto?'▲':'▼'}</span>
                </div>

                {/* Lista de clientes del mes */}
                {abierto && (
                  <div style={{ borderTop:'1px solid #f3f4f6', padding:'10px 12px 14px' }}>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(270px,1fr))', gap:8 }}>
                      {g.clientes.map(c => {
                        const estCliente = estadoMasUrgente(c.equipos);
                        const est = ESTADOS[estCliente] || ESTADOS.VIGENTE;
                        const todosGestionados = c.equipos.every(e => e.estado === 'GESTIONADO');
                        return (
                          <div key={c.cKey} onClick={() => setDetalle({ cli:c, equipos:c.equipos, mes:g.label })}
                            style={{ background:'#f9fafb', borderRadius:10, border:'1.5px solid #e5e7eb', padding:'10px 12px', cursor:'pointer', transition:'all .15s' }}
                            onMouseEnter={e => { e.currentTarget.style.background='#f0f4ff'; e.currentTarget.style.borderColor='#c4b5fd'; }}
                            onMouseLeave={e => { e.currentTarget.style.background='#f9fafb'; e.currentTarget.style.borderColor='#e5e7eb'; }}>

                            {/* Nombre + estado */}
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:6, marginBottom:6 }}>
                              <div style={{ fontWeight:700, fontSize:13, color:'#1a1a2e', minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                {c.nombre}
                              </div>
                              <span style={{ background:est.bg, color:est.color, fontWeight:800, fontSize:10, padding:'2px 8px', borderRadius:8, flexShrink:0 }}>{est.label}</span>
                            </div>

                            {/* Teléfono */}
                            {c.telefono && (
                              <div style={{ fontSize:12, color:'#7c3aed', fontWeight:700, marginBottom:4 }}>
                                📱 {telBonito(c.telefono)}
                              </div>
                            )}

                            {/* Lista de equipos */}
                            <div style={{ background:'#fff', borderRadius:7, padding:'6px 8px', marginBottom:8 }}>
                              {c.equipos.map((eq, i) => (
                                <div key={eq.id} style={{ fontSize:11.5, color:'#374151', padding:'2px 0', borderBottom: i < c.equipos.length-1 ? '1px solid #f3f4f6' : 'none', display:'flex', justifyContent:'space-between' }}>
                                  <span>{eq.cantidad > 1 ? `${eq.cantidad}× ` : ''}{eq.descripcionEquipo}{eq.sucursal ? ` · ${eq.sucursal}` : ''}</span>
                                </div>
                              ))}
                            </div>

                            {!todosGestionados && (
                              <button onClick={e => { e.stopPropagation(); marcarTodosGestionados(c.equipos, e); }}
                                style={{ width:'100%', border:'none', borderRadius:7, padding:'6px 0', background:'#f0fdf4', color:'#15803d', fontWeight:700, fontSize:11, cursor:'pointer' }}>
                                ✓ Gestionado
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal detalle del cliente */}
      {detalle && (
        <div onClick={() => setDetalle(null)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:400, display:'flex', alignItems:'flex-end', justifyContent:'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background:'#fff', borderRadius:'16px 16px 0 0', width:'100%', maxWidth:500, maxHeight:'85vh', overflowY:'auto', padding:'18px 18px 28px' }}>

            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
              <div>
                <div style={{ fontWeight:800, fontSize:15, color:'#1a1a2e' }}>{detalle.cli.nombre}</div>
                <div style={{ fontSize:11, color:'#9ca3af' }}>Vencimiento: {detalle.mes}</div>
              </div>
              <button onClick={() => setDetalle(null)} style={{ border:'none', background:'#f3f4f6', borderRadius:8, width:30, height:30, cursor:'pointer' }}>✕</button>
            </div>

            {/* Datos */}
            <div style={{ background:'#f9fafb', borderRadius:10, padding:'12px 14px', marginBottom:14 }}>
              {detalle.cli.telefono && (
                <a href={`tel:+${detalle.cli.telefono}`} style={{ display:'block', fontSize:14, fontWeight:700, color:'#7c3aed', textDecoration:'none', marginBottom:4 }}>
                  📱 {telBonito(detalle.cli.telefono)}
                </a>
              )}
              {detalle.cli.direccion && <div style={{ fontSize:12, color:'#6b7280' }}>📍 {detalle.cli.direccion}</div>}
              {detalle.cli.email    && <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>✉️ {detalle.cli.email}</div>}
            </div>

            {/* Equipos */}
            <div style={{ fontWeight:800, fontSize:11, color:'#374151', marginBottom:8, textTransform:'uppercase', letterSpacing:1 }}>
              Equipos a recargar — {detalle.equipos.length} tipo{detalle.equipos.length!==1?'s':''}
            </div>
            {detalle.equipos.map((eq,i) => {
              const est = ESTADOS[eq.estado] || ESTADOS.VIGENTE;
              return (
                <div key={eq.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'9px 12px', background:i%2===0?'#f9fafb':'#fff', borderRadius:8, marginBottom:4 }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600, color:'#1a1a2e' }}>
                      {eq.cantidad > 1 ? `${eq.cantidad}× ` : ''}{eq.descripcionEquipo}
                    </div>
                    {eq.sucursal && <div style={{ fontSize:11, color:'#9ca3af' }}>📍 {eq.sucursal}</div>}
                  </div>
                  <span style={{ background:est.bg, color:est.color, fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:8 }}>{est.label}</span>
                </div>
              );
            })}

            {/* Acciones */}
            <div style={{ display:'flex', gap:8, marginTop:16 }}>
              {detalle.cli.telefono && (
                <a href={`tel:+${detalle.cli.telefono}`} style={{ flex:1, textAlign:'center', background:'#7c3aed', color:'#fff', borderRadius:10, padding:'12px 0', fontWeight:700, fontSize:13, textDecoration:'none' }}>
                  📞 Llamar
                </a>
              )}
              {!detalle.equipos.every(e => e.estado==='GESTIONADO') && (
                <button onClick={e => marcarTodosGestionados(detalle.equipos, e)} style={{ flex:1, border:'none', borderRadius:10, padding:'12px 0', background:'#dcfce7', color:'#15803d', fontWeight:700, fontSize:13, cursor:'pointer' }}>
                  ✓ Todo gestionado
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
