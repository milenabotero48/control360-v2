// ============================================================
// Control360 — Gestión de Vencimientos v5
// Vista: acordeón por mes → agrupado por CLIENTE → lista equipos
// ACTUALIZADO: Agrega Anny + adminId dinámico (multi-tenant seguro)
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import LlamadasIA from './LlamadasIA';
import VencimientosAnny from './VencimientosAnny';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`,
});

// ============================================================
// FIX MULTI-TENANT-001: Obtener adminId del usuario logueado
// (en lugar de hardcodearlo)
// ============================================================
const getAdminId = () => {
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    return user.uid || user.id || null;
  } catch {
    return null;
  }
};

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

export default function GestionVencimientos({ user, onNavegar }) {
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
  
  // ============================================================
  // FIX MULTI-TENANT-001: vista puede ser 'vencimientos' | 'anny' | 'llamadas_ia'
  // ============================================================
  const [vista, setVista] = useState('vencimientos'); // 'vencimientos' | 'anny' | 'llamadas_ia'

  // ✅ NUEVO: el backend exige una empresa facturadora para cada importación
  const [empresasDisponibles, setEmpresasDisponibles] = useState([]);
  const [mostrarImportVenc, setMostrarImportVenc] = useState(false);
  const [empresaImportSel, setEmpresaImportSel] = useState('');
  const [archivoImportSel, setArchivoImportSel] = useState(null);

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

  // ✅ NUEVO: cargar empresas del tenant para el selector de importación
  useEffect(() => {
    fetch(`${API}/companies`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setEmpresasDisponibles(Array.isArray(d) ? d : []))
      .catch(() => setEmpresasDisponibles([]));
  }, []);

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
        (v.clienteNombre||'').toLowerCase().includes(q) ||
        (v.clienteContacto||'').toLowerCase().includes(q) ||
        (cli?.nombre||'').toLowerCase().includes(q) ||
        (cli?.empresa||'').toLowerCase().includes(q) ||
        (v.clienteTelefono||'').includes(q) ||
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
          nombre: v.clienteNombre || cli?.nombre || cli?.empresa || 'Sin nombre',
          contacto: v.clienteContacto || cli?.contacto || null,
          telefono: v.clienteTelefono || cli?.celular || cli?.telefono || v.telefono || null,
          direccion: v.clienteDireccion || cli?.direccionPrincipal || cli?.direccion || null,
          barrio: v.clienteBarrio || cli?.barrio || null,
          email: v.clienteEmail || cli?.emailLegal || cli?.email || null,
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
          const e = estadoMasUrgente(c.equipos);
          acc[e] = (acc[e]||0) + 1;
          return acc;
        }, {}),
      }));
  };

  const agrupado = agruparPorMesYCliente();

  const marcarGestionado = async (vencId) => {
    try {
      await fetch(`${API}/vencimientos/${vencId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ estado: 'GESTIONADO' })
      });
      cargar();
    } catch(e) { console.error(e); }
  };

  const marcarTodosGestionados = async (equipos, e) => {
    e.stopPropagation?.();
    const ids = equipos.map(eq => eq.id).filter(Boolean);
    if (ids.length === 0) return;
    for (const id of ids) await marcarGestionado(id);
  };

  const importarCSV = async (archivo, empresaId, empresaNombre) => {
    setImportando(true);
    setMsgImport(null);
    const formData = new FormData();
    formData.append('archivo', archivo);
    formData.append('empresaId', empresaId);
    try {
      const r = await fetch(`${API}/vencimientos/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: formData
      });
      const d = await r.json();
      setMsgImport(r.ok ? `✓ Importados ${d.creados} vencimientos de ${empresaNombre}` : `❌ ${d.error}`);
      if (r.ok) { setTimeout(() => { setMostrarImportVenc(false); cargar(); }, 1500); }
    } catch(e) { setMsgImport(`❌ ${e.message}`); }
    setImportando(false);
  };

  const exportarCSV = () => {
    const rows = [['Cliente','Empresa','Teléfono','Equipo','Cantidad','Sucursal','Vencimiento','Estado']];
    lista.forEach(v => {
      rows.push([v.clienteNombre||'',v.empresa||'',v.telefono||'',v.descripcionEquipo||'',v.cantidad||1,v.sucursal||'',v.fechaVencimiento||'',v.estado||'']);
    });
    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    link.download = `vencimientos_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const inp = { width:'100%', padding:'8px 12px', border:'1px solid #d1d5db', borderRadius:8, fontSize:13 };

  return (
    <div style={{ padding:20, background:'#fff' }}>
      
      {/* ============================================================ */}
      {/* HEADER */}
      {/* ============================================================ */}
      <div style={{ marginBottom:20 }}>
        <h1 style={{ fontSize:24, fontWeight:800, color:'#1a1a2e', marginBottom:4 }}>
          📅 Vencimientos
        </h1>
        {resumen && (
          <div style={{ display:'flex', gap:16, fontSize:13, color:'#6b7280' }}>
            <span>🔴 {resumen.vencido} Vencido</span>
            <span>🟡 {resumen.por_vencer} Por vencer</span>
            <span>🟢 {resumen.vigente} Vigente</span>
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* TABS - ACTUALIZADO CON ANNY */}
      {/* ============================================================ */}
      <div style={{ display:'flex', gap:8, marginBottom:20, borderBottom:'1px solid #e5e7eb', overflowX:'auto' }}>
        <button
          onClick={() => setVista('vencimientos')}
          style={{
            padding:'12px 20px',
            border:'none',
            background: vista === 'vencimientos' ? '#7c3aed' : 'transparent',
            color: vista === 'vencimientos' ? '#fff' : '#6b7280',
            fontSize:13,
            fontWeight:700,
            cursor:'pointer',
            borderRadius:'8px 8px 0 0',
            whiteSpace:'nowrap'
          }}>
          📋 Vencimientos
        </button>
        
        <button
          onClick={() => setVista('anny')}
          style={{
            padding:'12px 20px',
            border:'none',
            background: vista === 'anny' ? '#7c3aed' : 'transparent',
            color: vista === 'anny' ? '#fff' : '#6b7280',
            fontSize:13,
            fontWeight:700,
            cursor:'pointer',
            borderRadius:'8px 8px 0 0',
            whiteSpace:'nowrap'
          }}>
          🤖 WhatsApp IA Anny
        </button>

        <button
          onClick={() => setVista('llamadas_ia')}
          style={{
            padding:'12px 20px',
            border:'none',
            background: vista === 'llamadas_ia' ? '#7c3aed' : 'transparent',
            color: vista === 'llamadas_ia' ? '#fff' : '#6b7280',
            fontSize:13,
            fontWeight:700,
            cursor:'pointer',
            borderRadius:'8px 8px 0 0',
            whiteSpace:'nowrap'
          }}>
          📞 Lucy (Llamadas IA)
        </button>
      </div>

      {/* ============================================================ */}
      {/* CONTENIDO POR VISTA */}
      {/* ============================================================ */}
      
      {/* ===== VISTA: VENCIMIENTOS ===== */}
      {vista === 'vencimientos' && (
        <>
          {/* Búsqueda y filtros */}
          <div style={{ display:'flex', gap:8, marginBottom:20, flexWrap:'wrap' }}>
            <input
              type="text"
              placeholder="Buscar cliente, equipo, teléfono..."
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              style={{ ...inp, flex:1, minWidth:200 }} />
            
            <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)} style={inp}>
              <option value="">Todos los estados</option>
              <option value="VENCIDO">Vencido</option>
              <option value="POR_VENCER">Por vencer</option>
              <option value="VIGENTE">Vigente</option>
              <option value="GESTIONADO">Gestionado</option>
            </select>

            <button
              onClick={() => setMostrarImportVenc(true)}
              style={{ padding:'8px 16px', border:'none', borderRadius:8, background:'#7c3aed', color:'#fff', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              ⬆ Importar
            </button>

            <button
              onClick={exportarCSV}
              style={{ padding:'8px 16px', border:'none', borderRadius:8, background:'#1a1a2e', color:'#fff', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              ⬇ Exportar
            </button>
          </div>

          {/* Lista de vencimientos */}
          {cargando ? (
            <div style={{ textAlign:'center', color:'#9ca3af', padding:20 }}>Cargando...</div>
          ) : agrupado.length === 0 ? (
            <div style={{ textAlign:'center', color:'#9ca3af', padding:20 }}>Sin vencimientos</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {agrupado.map(mes => (
                <div key={mes.key} style={{ border:'1px solid #e5e7eb', borderRadius:10, overflow:'hidden' }}>
                  {/* Header mes */}
                  <button
                    onClick={() => setMesAbierto(mesAbierto === mes.key ? null : mes.key)}
                    style={{
                      width:'100%',
                      padding:'14px 16px',
                      border:'none',
                      background: mesAbierto === mes.key ? '#f3f4f6' : '#fff',
                      textAlign:'left',
                      cursor:'pointer',
                      display:'flex',
                      justifyContent:'space-between',
                      alignItems:'center'
                    }}>
                    <div>
                      <div style={{ fontWeight:800, fontSize:14, color:'#1a1a2e' }}>{mes.label}</div>
                      <div style={{ fontSize:12, color:'#9ca3af', marginTop:2 }}>
                        {mes.total} cliente{mes.total!==1?'s':''} • 
                        <span style={{ marginLeft:8, color:'#b91c1c' }}>🔴 {mes.estados.VENCIDO||0}</span>
                        <span style={{ marginLeft:8, color:'#b45309' }}>🟡 {mes.estados.POR_VENCER||0}</span>
                        <span style={{ marginLeft:8, color:'#15803d' }}>🟢 {mes.estados.VIGENTE||0}</span>
                      </div>
                    </div>
                    <div style={{ fontSize:18, color:'#9ca3af' }}>{mesAbierto === mes.key ? '▼' : '▶'}</div>
                  </button>

                  {/* Clientes del mes */}
                  {mesAbierto === mes.key && (
                    <div style={{ padding:'0 16px 16px', background:'#f9fafb' }}>
                      {mes.clientes.map((c, idx) => {
                        const todosGestionados = c.equipos.every(e => e.estado === 'GESTIONADO');
                        const est = ESTADOS[estadoMasUrgente(c.equipos)] || ESTADOS.VIGENTE;

                        return (
                          <div key={c.cKey || idx} style={{
                            background:'#fff',
                            border:'1px solid #e5e7eb',
                            borderRadius:8,
                            marginBottom:10,
                            overflow:'hidden'
                          }}>
                            {/* Cliente header */}
                            <button
                              onClick={() => setDetalle({ cli:c, equipos:c.equipos, mes:mes.label })}
                              style={{
                                width:'100%',
                                padding:'12px 14px',
                                border:'none',
                                background:est.bg,
                                textAlign:'left',
                                cursor:'pointer',
                                display:'flex',
                                justifyContent:'space-between',
                                alignItems:'center'
                              }}>
                              <div>
                                <div style={{ fontWeight:700, fontSize:13, color:est.color }}>{c.nombre}</div>
                                {c.telefono && (
                                  <a href={`tel:+${c.telefono}`} onClick={e => e.stopPropagation()} style={{ fontSize:11, color:est.color, textDecoration:'none', marginTop:2, display:'inline-block' }}>
                                    📱 {telBonito(c.telefono)}
                                  </a>
                                )}
                              </div>
                              <span style={{ background:est.bg, color:est.color, padding:'3px 10px', borderRadius:6, fontSize:11, fontWeight:700 }}>
                                {est.label}
                              </span>
                            </button>

                            {/* Equipos */}
                            <div style={{ padding:'12px 14px', borderTop:`1px solid #e5e7eb` }}>
                              {c.equipos.map(eq => {
                                const estEq = ESTADOS[eq.estado] || ESTADOS.VIGENTE;
                                return (
                                  <div key={eq.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, padding:8, background:'#f9fafb', borderRadius:6 }}>
                                    <span>{eq.cantidad > 1 ? `${eq.cantidad}× ` : ''}{eq.descripcionEquipo}{eq.sucursal ? ` · ${eq.sucursal}` : ''}</span>
                                  </div>
                                );
                              })}
                            </div>

                            {!todosGestionados && (
                              <button onClick={e => { e.stopPropagation(); marcarTodosGestionados(c.equipos, e); }}
                                style={{ width:'100%', border:'none', borderRadius:0, padding:'6px 0', background:'#f0fdf4', color:'#15803d', fontWeight:700, fontSize:11, cursor:'pointer' }}>
                                ✓ Gestionado
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Modal importar */}
          {mostrarImportVenc && (
            <div onClick={() => { if(!importando){ setMostrarImportVenc(false); setEmpresaImportSel(''); setArchivoImportSel(null); } }}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
              <div onClick={e => e.stopPropagation()} style={{ background:'#fff', borderRadius:16, width:'100%', maxWidth:480, maxHeight:'92vh', overflowY:'auto', padding:20 }}>

                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
                  <div style={{ fontWeight:800, fontSize:15, color:'#1a1a2e' }}>⬆ Importar Vencimientos</div>
                  <button onClick={() => { setMostrarImportVenc(false); setEmpresaImportSel(''); setArchivoImportSel(null); }} disabled={importando}
                    style={{ border:'none', background:'#f3f4f6', borderRadius:8, width:30, height:30, cursor:'pointer' }}>✕</button>
                </div>

                <div style={{ marginBottom:14 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Paso 1 — ¿Qué empresa factura estos vencimientos? *</div>
                  <select value={empresaImportSel} onChange={e => setEmpresaImportSel(e.target.value)} style={inp}>
                    <option value="">— Selecciona la empresa —</option>
                    {empresasDisponibles.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </div>

                <div style={{ marginBottom:6 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Paso 2 — Sube tu archivo CSV</div>
                  <div style={{ background:'#f9fafb', border:'2px dashed #e5e7eb', borderRadius:10, padding:18, textAlign:'center' }}>
                    <input type="file" accept=".csv" id="fileImportVenc" hidden disabled={!empresaImportSel || importando}
                      onChange={e => { const f = e.target.files && e.target.files[0]; if (f) setArchivoImportSel(f); e.target.value=''; }} />
                    <label htmlFor="fileImportVenc" style={{
                      display:'inline-block', padding:'10px 20px', borderRadius:8, fontWeight:700, fontSize:13,
                      background: empresaImportSel ? '#7c3aed' : '#e5e7eb',
                      color: empresaImportSel ? '#fff' : '#9ca3af',
                      cursor: empresaImportSel ? 'pointer' : 'not-allowed',
                    }}>
                      📂 {archivoImportSel ? archivoImportSel.name : 'Seleccionar CSV'}
                    </label>
                  </div>
                </div>

                {msgImport && (
                  <div style={{ marginTop:12, background:msgImport.startsWith('✓')?'#dcfce7':'#fee2e2', color:msgImport.startsWith('✓')?'#15803d':'#b91c1c', borderRadius:8, padding:'9px 12px', fontSize:12, fontWeight:600 }}>
                    {msgImport}
                  </div>
                )}

                <button
                  onClick={() => archivoImportSel && empresaImportSel && importarCSV(archivoImportSel, empresaImportSel, empresasDisponibles.find(e => e.id===empresaImportSel)?.name || '')}
                  disabled={!archivoImportSel || !empresaImportSel || importando}
                  style={{
                    width:'100%', marginTop:14, border:'none', borderRadius:10, padding:'12px 0', fontWeight:700, fontSize:13,
                    background: (archivoImportSel && empresaImportSel && !importando) ? '#1a1a2e' : '#e5e7eb',
                    color: (archivoImportSel && empresaImportSel && !importando) ? '#fff' : '#9ca3af',
                    cursor: (archivoImportSel && empresaImportSel && !importando) ? 'pointer' : 'not-allowed',
                  }}>
                  {importando ? 'Importando...' : 'Importar archivo'}
                </button>
              </div>
            </div>
          )}

          {/* Modal detalle cliente */}
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

                <div style={{ background:'#f9fafb', borderRadius:10, padding:'12px 14px', marginBottom:14 }}>
                  {detalle.cli.telefono && (
                    <a href={`tel:+${detalle.cli.telefono}`} style={{ display:'block', fontSize:14, fontWeight:700, color:'#7c3aed', textDecoration:'none', marginBottom:4 }}>
                      📱 {telBonito(detalle.cli.telefono)}
                    </a>
                  )}
                  {detalle.cli.direccion && <div style={{ fontSize:12, color:'#6b7280' }}>📍 {detalle.cli.direccion}</div>}
                  {detalle.cli.email    && <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>✉️ {detalle.cli.email}</div>}
                </div>

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
        </>
      )}

      {/* ===== VISTA: ANNY ===== */}
      {vista === 'anny' && (
        <VencimientosAnny />
      )}

      {/* ===== VISTA: LUCY ===== */}
      {vista === 'llamadas_ia' && (
        <LlamadasIA />
      )}
    </div>
  );
}