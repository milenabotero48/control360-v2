// ============================================================
// Control360 — Gestión de Vencimientos v5
// Vista: acordeón por mes → agrupado por CLIENTE → lista equipos
// ACTUALIZADO: Agrega Anny + adminId dinámico (multi-tenant seguro)
// ============================================================

// ✅ FIX TEL-CO-001: enlaces de llamada con indicativo +57 (antes marcaban a Holanda)
import React, { useState, useEffect, useCallback } from 'react';
import LlamadasIA from './LlamadasIA';
import ModuloAnny from './components/anny/ModuloAnny';
// ✅ VENC-KPI-001 / VENC-IMPORT-LOTE-001 / VENC-EDICION-001
import PanelVencimientos from './PanelVencimientos';
import HistorialImportaciones from './HistorialImportaciones';
import ModalPin from './ModalPin';

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
  // ✅ VENC-TOPE-001 (2026-07-29): antes esta pantalla se bajaba TODA la
  // colección de una (`GET /vencimientos`) y agrupaba por mes en el navegador.
  // El backend cortaba en 2000 documentos sin avisar, así que con Extintores
  // del Sur (8.027 vencimientos) el acordeón mostraba el 25% de la base y
  // "Julio 2027" salía con 36 clientes en vez de los reales.
  // Ahora: el backend cuenta el 100% y devuelve el acordeón ya agregado por
  // mes (`/vencimientos/meses`), y las filas de un mes se piden solo cuando
  // se abre ese mes. Escala igual con 900 que con 30.000.
  const [meses,        setMeses]        = useState([]);   // cabeceras del acordeón
  const [filasPorMes,  setFilasPorMes]  = useState({});   // { 'YYYY-MM': [filas] }
  const [cargandoMes,  setCargandoMes]  = useState(null); // mes que se está trayendo
  const [totalEquipos, setTotalEquipos] = useState(0);
  const [error,        setError]        = useState(null); // falla real del backend
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
  // ✅ VENC-MANUAL-001: el form ahora maneja fechas reales (el backend calcula
  // el vencimiento a 12 meses si solo se envía la fecha de última recarga).
  const [form, setForm] = useState({ clienteId:'', sucursal:'', descripcionEquipo:'', cantidad:1, fechaUltimaRecarga:'', fechaVencimiento:'' });
  const [guardandoForm, setGuardandoForm] = useState(false);
  const [msgForm, setMsgForm] = useState(null);
  
  // ============================================================
  // FIX MULTI-TENANT-001: vista puede ser 'vencimientos' | 'anny' | 'llamadas_ia'
  // ============================================================
  const [vista, setVista] = useState('vencimientos'); // 'vencimientos' | 'anny' | 'llamadas_ia'

  // ✅ NUEVO: el backend exige una empresa facturadora para cada importación
  const [empresasDisponibles, setEmpresasDisponibles] = useState([]);
  const [cicloEstado, setCicloEstado] = useState(null); // VENC-CICLO-002
  const [mostrarImportVenc, setMostrarImportVenc] = useState(false);
  const [empresaImportSel, setEmpresaImportSel] = useState('');
  const [archivoImportSel, setArchivoImportSel] = useState(null);

  // ✅ VENC-KPI-001: contador que fuerza al panel a recalcular tras importar,
  // editar o borrar — sin recargar la página entera.
  const [refrescarPanel, setRefrescarPanel] = useState(0);
  // ✅ VENC-IMPORT-LOTE-001
  const [mostrarHistorial, setMostrarHistorial] = useState(false);
  // ✅ VENC-EDICION-001: { venc, modo: 'editar'|'borrar' } y su paso de PIN
  const [edicion, setEdicion] = useState(null);
  const [pinEdicion, setPinEdicion] = useState(null);
  const [msgEdicion, setMsgEdicion] = useState(null);

  // Trae el acordeón (agregado en backend sobre el 100% de la base) + tarjetas.
  // Los filtros de estado y búsqueda viajan al servidor: si se aplicaran acá
  // volveríamos a filtrar sobre una muestra parcial, que es el bug original.
  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const qs = new URLSearchParams();
      if (filtroEstado) qs.set('estado', filtroEstado);
      if (busqueda.trim()) qs.set('q', busqueda.trim());
      const sufijo = qs.toString() ? `?${qs}` : '';

      const [r1, r2] = await Promise.all([
        fetch(`${API}/vencimientos/resumen`, { headers: authHeaders() }),
        fetch(`${API}/vencimientos/meses${sufijo}`, { headers: authHeaders() }),
      ]);
      // Si el backend falla, hay que DECIRLO. Mostrar "Sin vencimientos"
      // cuando en realidad la consulta reventó es el mismo pecado que el
      // tope de 2000: la pantalla mintiendo sobre el estado de la base.
      if (!r1.ok || !r2.ok) {
        const detalle = await (r2.ok ? r1 : r2).json().catch(() => ({}));
        throw new Error(detalle.error || `El servidor respondió ${r2.ok ? r1.status : r2.status}`);
      }
      const [res, ms] = await Promise.all([r1.json(), r2.json()]);
      setResumen(res);
      setMeses(Array.isArray(ms?.meses) ? ms.meses : []);
      setTotalEquipos(ms?.totalEquipos || 0);
      setError(null);
      setFilasPorMes({});   // el filtro cambió: lo ya traído dejó de ser válido
      setMesAbierto(null);
    } catch(e) {
      console.error(e);
      setError(e.message || 'No se pudieron cargar los vencimientos');
      setMeses([]);
      setResumen(null);
    }
    setCargando(false);
  }, [filtroEstado, busqueda]);

  // Debounce de la búsqueda para no pegarle al backend en cada tecla.
  useEffect(() => {
    const t = setTimeout(() => { cargar(); }, busqueda ? 350 : 0);
    return () => clearTimeout(t);
  }, [cargar, busqueda]);

  // Trae las filas de un mes solo cuando se abre (y una sola vez).
  const abrirMes = useCallback(async (mesKeyPedido) => {
    if (!mesKeyPedido || filasPorMes[mesKeyPedido]) return;
    setCargandoMes(mesKeyPedido);
    try {
      const qs = new URLSearchParams({ mes: mesKeyPedido });
      if (filtroEstado) qs.set('estado', filtroEstado);
      if (busqueda.trim()) qs.set('q', busqueda.trim());
      const r = await fetch(`${API}/vencimientos?${qs}`, { headers: authHeaders() });
      const filas = await r.json();
      setFilasPorMes(prev => ({ ...prev, [mesKeyPedido]: Array.isArray(filas) ? filas : [] }));
    } catch(e) { console.error(e); }
    setCargandoMes(null);
  }, [filasPorMes, filtroEstado, busqueda]);

  useEffect(() => { if (mesAbierto) abrirMes(mesAbierto); }, [mesAbierto, abrirMes]);

  // ✅ NUEVO: cargar empresas del tenant para el selector de importación
  useEffect(() => {
    fetch(`${API}/companies`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setEmpresasDisponibles(Array.isArray(d) ? d : []))
      .catch(() => setEmpresasDisponibles([]));
  }, []);

  const buscarCliente = (id) => clientes.find(c => (c.id||c.uid) === id);

  // Agrupa por CLIENTE las filas de UN mes ya traído del servidor.
  // El backend manda los datos del cliente en cada fila (VENC-NOMBRE-001), así
  // que ya no hace falta cruzar contra /clients, que estaba paginado a 100 y
  // dejaba "Sin nombre" a todo cliente fuera de esa ventana.
  const agruparClientes = (filas = []) => {
    const porCliente = {};
    filas.forEach(v => {
      const cKey = v.clienteId || v.telefono || 'sin_cliente';
      if (!porCliente[cKey]) {
        porCliente[cKey] = {
          cKey, clienteId: v.clienteId,
          nombre:    v.clienteNombre || 'Sin nombre',
          contacto:  v.clienteContacto || null,
          telefono:  v.clienteTelefono || v.telefono || null,
          direccion: v.clienteDireccion || null,
          barrio:    v.clienteBarrio || null,
          email:     v.clienteEmail || null,
          equipos: [],
        };
      }
      porCliente[cKey].equipos.push(v);
    });
    return Object.values(porCliente);
  };

  // Cabeceras del acordeón: los totales vienen contados en backend sobre el
  // 100% de la base. Las filas solo existen para el mes que esté abierto.
  const agrupado = meses.map(m => ({
    key: m.key,
    label: m.key === 'sin_fecha' ? 'Sin fecha' : formatMes(`${m.key}-01`),
    total: m.totalClientes,
    totalEquipos: m.totalEquipos,
    estados: m.estados || {},
    clientes: agruparClientes(filasPorMes[m.key] || []),
  }));

  // ✅ FIX GESTIONADO-001: el backend expone PUT /:id y espera
  // { gestionado: true } — el frontend mandaba PATCH { estado } y la marca
  // NUNCA se guardaba (la fila volvía a aparecer al recargar).
  // Refresca solo lo necesario: las cabeceras del acordeón, las tarjetas y las
  // filas del mes abierto. No se usa cargar() porque cerraría el mes que la
  // usuaria está gestionando en ese momento.
  const refrescarMesAbierto = async () => {
    try {
      const qs = new URLSearchParams();
      if (filtroEstado) qs.set('estado', filtroEstado);
      if (busqueda.trim()) qs.set('q', busqueda.trim());
      const sufijo = qs.toString() ? `?${qs}` : '';

      const [r1, r2] = await Promise.all([
        fetch(`${API}/vencimientos/resumen`, { headers: authHeaders() }),
        fetch(`${API}/vencimientos/meses${sufijo}`, { headers: authHeaders() }),
      ]);
      const [res, ms] = await Promise.all([r1.json(), r2.json()]);
      setResumen(res);
      setMeses(Array.isArray(ms?.meses) ? ms.meses : []);
      setTotalEquipos(ms?.totalEquipos || 0);

      if (mesAbierto) {
        const q2 = new URLSearchParams({ mes: mesAbierto });
        if (filtroEstado) q2.set('estado', filtroEstado);
        if (busqueda.trim()) q2.set('q', busqueda.trim());
        const r = await fetch(`${API}/vencimientos?${q2}`, { headers: authHeaders() });
        const filas = await r.json();
        setFilasPorMes(prev => ({ ...prev, [mesAbierto]: Array.isArray(filas) ? filas : [] }));
      }
    } catch(e) { console.error(e); }
  };

  const marcarGestionado = async (vencId, refrescar = true) => {
    try {
      await fetch(`${API}/vencimientos/${vencId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ gestionado: true })
      });
      if (refrescar) await refrescarMesAbierto();
    } catch(e) { console.error(e); }
  };

  const marcarTodosGestionados = async (equipos, e) => {
    e.stopPropagation?.();
    const ids = equipos.map(eq => eq.id).filter(Boolean);
    if (ids.length === 0) return;
    // Un solo refresco al final, no uno por equipo.
    for (const id of ids) await marcarGestionado(id, false);
    await refrescarMesAbierto();
  };

  // ✅ FIX IMPORT-VENC-001: la importación estaba ROTA — el frontend enviaba el
  // archivo como FormData a /vencimientos/import (endpoint inexistente: 404),
  // mientras el backend expone /vencimientos/importar y espera las filas ya
  // parseadas en JSON. Ahora el CSV se parsea aquí y se envía { filas }.
  // Columnas aceptadas por el backend (alias tolerantes):
  //   nombre | razon social | empresa   ← obligatoria
  //   telefono | celular                ← obligatoria
  //   nit, sucursal, equipo, cantidad, fechaUltimaRecarga
  // Fila CON fecha → cliente + vencimiento · SIN fecha → prospecto (Telemercadeo)
  const parsearCSV = (texto) => {
    // Parser tolerante: separador ; o , — respeta comillas dobles.
    const limpio = texto.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const lineas = limpio.split('\n').filter(l => l.trim() !== '');
    if (lineas.length < 2) return [];
    const sep = (lineas[0].match(/;/g) || []).length > (lineas[0].match(/,/g) || []).length ? ';' : ',';

    const partir = (linea) => {
      const out = []; let actual = ''; let enComillas = false;
      for (let i = 0; i < linea.length; i++) {
        const c = linea[i];
        if (c === '"') {
          if (enComillas && linea[i + 1] === '"') { actual += '"'; i++; }
          else enComillas = !enComillas;
        } else if (c === sep && !enComillas) { out.push(actual); actual = ''; }
        else actual += c;
      }
      out.push(actual);
      return out.map(s => s.trim());
    };

    // Normaliza encabezados: sin tildes, minúsculas, sin espacios extra.
    const normHead = (h) => h.toLowerCase().trim()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ');
    const ALIAS = {
      'nombre': 'nombre', 'razon social': 'nombre', 'razonsocial': 'nombre', 'cliente': 'nombre',
      'empresa': 'empresa',
      'telefono': 'telefono', 'celular': 'telefono', 'movil': 'telefono',
      'nit': 'nit', 'sucursal': 'sucursal', 'sede': 'sucursal',
      'equipo': 'equipo', 'descripcion equipo': 'equipo', 'descripcion': 'equipo',
      'cantidad': 'cantidad', 'cant': 'cantidad',
      // ✅ VENC-IMPORT-EMPRESA-001: empresa FACTURADORA (no la del cliente).
      'empresafactura': 'empresaFactura', 'empresa factura': 'empresaFactura',
      'empresa que factura': 'empresaFactura', 'empresa facturadora': 'empresaFactura',
      'razon social facturadora': 'empresaFactura', 'facturado por': 'empresaFactura',
      'factura': 'empresaFactura', 'mi empresa': 'empresaFactura',
      'fecha ultima recarga': 'fechaUltimaRecarga', 'fechaultimarecarga': 'fechaUltimaRecarga',
      'ultima recarga': 'fechaUltimaRecarga', 'fecha recarga': 'fechaUltimaRecarga',
      'fecha': 'fechaUltimaRecarga', 'vencimiento': 'fechaUltimaRecarga',
    };
    const cabecera = partir(lineas[0]).map(h => ALIAS[normHead(h)] || normHead(h));

    return lineas.slice(1).map(l => {
      const celdas = partir(l);
      const fila = {};
      cabecera.forEach((col, i) => { if (col && celdas[i] !== undefined) fila[col] = celdas[i]; });
      return fila;
    }).filter(f => (f.nombre || f.empresa) && f.telefono);
  };

  const descargarPlantilla = () => {
    // ✅ FIX IMPORT-VENC-001: plantilla oficial (volvió al modal).
    const hoy = new Date().toISOString().slice(0, 10);
    // ✅ VENC-IMPORT-EMPRESA-001: `empresaFactura` es la columna NUEVA — la
    // razón social que le factura a ese cliente. `empresa` sigue siendo la del
    // cliente (no se le cambió el significado para no romper archivos viejos).
    // Las dos filas de ejemplo van a propósito con empresas distintas: es la
    // forma más rápida de mostrar que un solo archivo sirve para toda la base.
    const empA = empresasDisponibles[0]?.name || 'MI EMPRESA SAS';
    const empB = empresasDisponibles[1]?.name || empA;
    const filas = [
      ['nombre', 'empresa', 'nit', 'telefono', 'sucursal', 'equipo', 'cantidad', 'fechaUltimaRecarga', 'empresaFactura'],
      ['INDUSTRIAS EJEMPLO SAS', 'INDUSTRIAS EJEMPLO SAS', '900123456', '3001234567', 'Sede Norte', 'Extintor ABC 10 lbs', '3', hoy, empA],
      ['CLIENTE SIN FECHA LTDA', 'CLIENTE SIN FECHA LTDA', '', '3109876543', '', 'Extintor CO2 15 lbs', '1', '', empB],
    ];
    const csv = filas.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent('﻿' + csv)}`;
    link.download = 'plantilla_vencimientos_control360.csv';
    link.click();
  };

  const importarCSV = async (archivo, empresaId, empresaNombre) => {
    setImportando(true);
    setMsgImport(null);
    try {
      const texto = await archivo.text();
      const filas = parsearCSV(texto);
      if (!filas.length) {
        setMsgImport('❌ No se encontraron filas válidas. Cada fila necesita al menos nombre y teléfono — descarga la plantilla para ver el formato.');
        setImportando(false);
        return;
      }
      if (filas.length > 2000) {
        setMsgImport('❌ Máximo 2000 filas por importación. Divide el archivo.');
        setImportando(false);
        return;
      }

      const r = await fetch(`${API}/vencimientos/importar`, {
        method: 'POST',
        headers: authHeaders(),
        // ✅ VENC-IMPORT-EMPRESA-001: empresaId ahora es solo el RESPALDO para
        // las filas que no traigan su propia columna `empresaFactura`.
        body: JSON.stringify({ filas, empresaId, empresaNombre, archivoNombre: archivo.name })
      });
      const d = await r.json();
      if (!r.ok) { setMsgImport(`❌ ${d.error || 'Error al importar'}`); setImportando(false); return; }

      const partes = [`✓ ${d.vencimientosCreados || 0} vencimientos`];
      if (d.clientesNuevos)          partes.push(`${d.clientesNuevos} clientes nuevos`);
      if (d.prospectosCreados)       partes.push(`${d.prospectosCreados} prospectos (sin fecha → Telemercadeo)`);
      if (d.prospectosActualizados)  partes.push(`${d.prospectosActualizados} prospectos actualizados`);
      if (d.vencimientosOmitidos)    partes.push(`${d.vencimientosOmitidos} omitidos (ya existían)`);
      if (d.porVerificar)            partes.push(`☎️ ${d.porVerificar} teléfonos por verificar`);
      if (d.errores?.length)         partes.push(`⚠️ ${d.errores.length} filas con error`);

      // ✅ VENC-IMPORT-EMPRESA-001: reparto real por empresa facturadora — es
      // la confirmación de que cada cliente quedó donde debía.
      const reparto = Object.entries(d.empresas || {});
      const sufijo = reparto.length
        ? ` — ${reparto.map(([n, c]) => `${n}: ${c}`).join(' · ')}`
        : (empresaNombre ? ` — ${empresaNombre}` : '');
      setMsgImport(`${partes.join(' · ')}${sufijo}`);

      const sinReconocer = Object.keys(d.empresasNoReconocidas || {});
      if (sinReconocer.length) {
        setMsgImport(m => `${m}\n⚠️ Empresas no reconocidas: ${sinReconocer.join(', ')} — esas filas usaron la empresa por defecto.`);
      }
      setTimeout(() => { setMostrarImportVenc(false); setMsgImport(null); cargar(); setRefrescarPanel(n => n + 1); }, 4500);
    } catch(e) { setMsgImport(`❌ ${e.message}`); }
    setImportando(false);
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ✅ VENC-EDICION-001 — Editar y borrar un vencimiento
  // ───────────────────────────────────────────────────────────────────────
  // Ambas acciones envían el PIN al backend en el body: ModalPin lo valida
  // primero solo para dar feedback inmediato, pero quien autoriza de verdad
  // es el backend (contrato de FIX PIN-UNICO-001 — nunca una bandera local).
  // ═══════════════════════════════════════════════════════════════════════
  const guardarEdicion = async (pin, motivo) => {
    const { venc, campos } = edicion;
    const r = await fetch(`${API}/vencimientos/${venc.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ ...campos, cantidad: Number(campos.cantidad) || 1, pin, motivo }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'No se pudo actualizar');
    setPinEdicion(null); setEdicion(null); setDetalle(null);
    setMsgEdicion('✓ Vencimiento actualizado');
    cargar(); setRefrescarPanel(n => n + 1);
    setTimeout(() => setMsgEdicion(null), 4000);
  };

  const borrarVencimiento = async (pin, motivo) => {
    const { venc } = edicion;
    const r = await fetch(`${API}/vencimientos/${venc.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ pin, motivo }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'No se pudo borrar');
    setPinEdicion(null); setEdicion(null); setDetalle(null);
    setMsgEdicion('✓ Vencimiento borrado — queda copia en auditoría');
    cargar(); setRefrescarPanel(n => n + 1);
    setTimeout(() => setMsgEdicion(null), 4000);
  };

  // ✅ FIX VENC-MANUAL-001: crear un vencimiento a mano.
  // Regla del backend: exige clienteId + descripcionEquipo, y al menos una de
  // las dos fechas. Con solo la fecha de recarga, el vencimiento se calcula
  // solo (+12 meses) — el caso normal de una recarga de extintor.
  const guardarVencimiento = async () => {
    if (!form.clienteId)          { setMsgForm('❌ Selecciona el cliente'); return; }
    if (!form.descripcionEquipo)  { setMsgForm('❌ Escribe el equipo (ej: Extintor ABC 10 lbs)'); return; }
    if (!form.fechaUltimaRecarga && !form.fechaVencimiento) {
      setMsgForm('❌ Indica la fecha de la última recarga o la fecha de vencimiento');
      return;
    }
    setGuardandoForm(true); setMsgForm(null);
    try {
      const r = await fetch(`${API}/vencimientos`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          clienteId: form.clienteId,
          sucursal: form.sucursal || null,
          descripcionEquipo: form.descripcionEquipo,
          cantidad: Number(form.cantidad) || 1,
          fechaUltimaRecarga: form.fechaUltimaRecarga || null,
          fechaVencimiento: form.fechaVencimiento || null,
          origenDato: 'manual',
        })
      });
      const d = await r.json();
      if (!r.ok) { setMsgForm(`❌ ${d.error || 'No se pudo crear'}`); setGuardandoForm(false); return; }
      setMsgForm(`✓ Vencimiento creado — vence ${d.fechaVencimiento}`);
      setTimeout(() => { setMostrarForm(false); setMsgForm(null); cargar(); }, 1400);
    } catch(e) { setMsgForm(`❌ ${e.message}`); }
    setGuardandoForm(false);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ✅ VENC-CICLO-002 — Cerrar ciclos de clientes que ya fueron atendidos
  // ───────────────────────────────────────────────────────────────────────────
  // SIEMPRE simula primero. El usuario ve exactamente qué se va a cerrar y
  // recién ahí confirma. Cerrar vencimientos a ciegas sería destruir la base
  // de campañas sin posibilidad de revisar.
  // ═══════════════════════════════════════════════════════════════════════════
  const revisarCiclos = async () => {
    setCicloEstado({ cargando: true });
    try {
      const r = await fetch(`${API}/vencimientos/cerrar-ciclos-servidos`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ aplicar: false, mesesAtras: 6 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo revisar');
      setCicloEstado({ cargando: false, resultado: d });
    } catch (e) {
      setCicloEstado({ cargando: false, error: e.message });
    }
  };

  const aplicarCiclos = async () => {
    setCicloEstado(s => ({ ...s, cargando: true }));
    try {
      const r = await fetch(`${API}/vencimientos/cerrar-ciclos-servidos`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ aplicar: true, mesesAtras: 6 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo aplicar');
      setCicloEstado({ cargando: false, aplicado: d.aCerrar });
      cargar();
    } catch (e) {
      setCicloEstado(s => ({ ...s, cargando: false, error: e.message }));
    }
  };

  // ✅ VENC-TOPE-001: los exports ya no pueden leer de una lista en memoria —
  // esa lista era justamente la muestra truncada a 2000. Piden los datos al
  // servidor, que responde sobre el 100% de la base.
  const traerFilas = async (params = {}) => {
    const qs = new URLSearchParams(params);
    if (busqueda.trim() && !params.q) qs.set('q', busqueda.trim());
    const r = await fetch(`${API}/vencimientos?${qs}`, { headers: authHeaders() });
    const filas = await r.json();
    return Array.isArray(filas) ? filas : [];
  };

  const exportarCSV = async () => {
    const filas = await traerFilas(filtroEstado ? { estado: filtroEstado } : { todos: '1' });
    const rows = [['Cliente','Empresa','Teléfono','Equipo','Cantidad','Sucursal','Vencimiento','Estado']];
    filas.forEach(v => {
      rows.push([v.clienteNombre||'',v.empresa||'',v.clienteTelefono||v.telefono||'',v.descripcionEquipo||'',v.cantidad||1,v.sucursal||'',v.fechaVencimiento||'',v.estado||'']);
    });
    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    link.download = `vencimientos_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ✅ EXPORT GOOGLE CONTACTS — VENC-CONTACTOS-001 (2026-07-26)
  // ───────────────────────────────────────────────────────────────────────────
  // Automatiza el paso manual del cierre de mes: hoy los contactos de la
  // campaña de WhatsApp se arman a mano en Google Contacts antes de usar la
  // lista de difusión paga. Esto genera el CSV listo para importar.
  //
  // DECISIONES DE DISEÑO:
  //  · UN CONTACTO POR CLIENTE, no por equipo. Un cliente con 12 extintores
  //    recibe UN mensaje, no 12 — es la regla de "un solo toque por cliente/mes".
  //  · Etiqueta VENC-AAAA-MM: permite seleccionar el grupo completo en el
  //    celular y borrarlo después sin ensuciar la agenda.
  //  · Teléfono en formato +57XXXXXXXXXX para que el celular lo reconozca.
  //  · Solo se exportan vencidos y por vencer — no tiene sentido escribirle
  //    a quien está vigente.
  // ═══════════════════════════════════════════════════════════════════════════
  const exportarGoogleContacts = async () => {
    const mesTag = new Date().toISOString().slice(0, 7); // AAAA-MM
    const etiqueta = `VENC-${mesTag}`;

    // ✅ VENC-TOPE-001: se piden al servidor los VENCIDO y POR_VENCER de toda
    // la base. Antes filtraba en memoria comparando contra 'vencido' y
    // 'por_vencer' en minúscula, pero el backend devuelve los estados en
    // MAYÚSCULA: el filtro no casaba nunca y el CSV de la campaña salía vacío.
    const [vencidos, porVencer] = await Promise.all([
      traerFilas({ estado: 'VENCIDO' }),
      traerFilas({ estado: 'POR_VENCER' }),
    ]);

    // 1) Agrupar por cliente (clave: id de cliente, o teléfono si no hay id)
    const porCliente = new Map();
    [...vencidos, ...porVencer]
      .forEach(v => {
        const tel = String(v.clienteTelefono || v.telefono || '').replace(/\D/g, '');
        if (!tel) return; // sin teléfono no sirve para la campaña
        const clave = v.clienteId || tel;
        if (!porCliente.has(clave)) {
          porCliente.set(clave, {
            nombre: v.clienteNombre || '',
            empresa: v.empresa || '',
            telefono: tel,
            equipos: [],
            unidades: 0,
            proximo: v.fechaVencimiento || '',
          });
        }
        const c = porCliente.get(clave);
        c.equipos.push(`${v.cantidad || 1}× ${v.descripcionEquipo || 'equipo'}`);
        c.unidades += Number(v.cantidad) || 1;
        if (v.fechaVencimiento && (!c.proximo || v.fechaVencimiento < c.proximo)) {
          c.proximo = v.fechaVencimiento;
        }
      });

    if (porCliente.size === 0) {
      alert('No hay clientes con vencimientos y teléfono válido para exportar este mes.');
      return;
    }

    // 2) Formato CSV de Google Contacts
    const telE164 = (t) => (t.length === 10 && t.startsWith('3')) ? `+57${t}`
                        : (t.length === 12 && t.startsWith('57')) ? `+${t}`
                        : t;

    const cab = ['Name','Given Name','Family Name','Organization 1 - Name',
                 'Phone 1 - Type','Phone 1 - Value','Notes','Group Membership'];

    const filas = [...porCliente.values()].map(c => {
      const nombreLimpio = (c.nombre || c.empresa || 'Cliente').trim();
      return [
        `${etiqueta} · ${nombreLimpio}`,   // prefijo → quedan juntos en la agenda
        nombreLimpio,
        '',
        c.empresa || '',
        'Mobile',
        telE164(c.telefono),
        `${c.unidades} unidad(es) — ${c.equipos.join('; ')}. Vence: ${c.proximo}`,
        `* myContacts ::: ${etiqueta}`,
      ];
    });

    const escapar = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [cab, ...filas].map(r => r.map(escapar).join(',')).join('\r\n');

    // BOM para que Google/Excel respeten las tildes
    const link = document.createElement('a');
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent('﻿' + csv)}`;
    link.download = `google_contacts_${etiqueta}.csv`;
    link.click();

    setMsgImport(`✓ ${filas.length} contacto(s) exportado(s) con la etiqueta ${etiqueta}. Impórtalo en Google Contacts y usa esa etiqueta para armar la difusión.`);
    setTimeout(() => setMsgImport(null), 12000);
  };

  const inp = { width:'100%', padding:'8px 12px', border:'1px solid #d1d5db', borderRadius:8, fontSize:13, boxSizing:'border-box' };
  // ✅ VENC-EDICION-001: etiqueta de campo del formulario de edición
  const lbl = { fontSize:12, fontWeight:700, color:'#374151', marginBottom:5 };

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
            {/* ✅ VENC-TOPE-001: el backend devuelve los estados en MAYÚSCULA
                (VENCIDO/POR_VENCER/VIGENTE). Estas tarjetas leían las claves en
                minúscula, así que siempre mostraban vacío. */}
            <span>🔴 {resumen.VENCIDO ?? 0} Vencido</span>
            <span>🟡 {resumen.POR_VENCER ?? 0} Por vencer</span>
            <span>🟢 {resumen.VIGENTE ?? 0} Vigente</span>
            <span style={{ color:'#9ca3af' }}>· {resumen.total ?? 0} equipos en total</span>
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
          {/* ✅ VENC-KPI-001 — Panel de inteligencia comercial.
              Va ARRIBA de la lista a propósito: quien abre este módulo primero
              decide (¿cuánto entra, cuánto se va?) y después opera. */}
          <PanelVencimientos
            recargar={refrescarPanel}
            onVerVencidos={() => { setFiltroEstado('VENCIDO'); window.scrollTo({ top: 320, behavior: 'smooth' }); }}
          />

          {msgEdicion && (
            <div style={{
              background:'#ecfdf5', border:'1px solid #a7f3d0', color:'#047857',
              borderRadius:10, padding:'10px 14px', fontSize:13, fontWeight:600, marginBottom:12,
            }}>{msgEdicion}</div>
          )}

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

            {/* ✅ FIX VENC-MANUAL-001: crear un vencimiento suelto sin importar
                un archivo (el endpoint POST /api/vencimientos ya existía, pero
                no había forma de llamarlo desde la pantalla). */}
            <button
              onClick={() => { setForm({ clienteId:'', sucursal:'', descripcionEquipo:'', cantidad:1, fechaUltimaRecarga:'', fechaVencimiento:'' }); setMsgForm(null); setMostrarForm(true); }}
              style={{ padding:'8px 16px', border:'none', borderRadius:8, background:'#16a34a', color:'#fff', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              ➕ Nuevo vencimiento
            </button>

            <button
              onClick={() => setMostrarImportVenc(true)}
              style={{ padding:'8px 16px', border:'none', borderRadius:8, background:'#7c3aed', color:'#fff', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              ⬆ Importar
            </button>

            {/* ✅ VENC-IMPORT-LOTE-001 — historial y deshacer */}
            <button
              onClick={() => setMostrarHistorial(true)}
              title="Ver las últimas 5 importaciones y deshacer una si el archivo estaba mal"
              style={{ padding:'8px 16px', border:'1px solid #ddd6fe', borderRadius:8, background:'#fff', color:'#6d28d9', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              🗂 Historial de cargas
            </button>

            <button
              onClick={exportarCSV}
              style={{ padding:'8px 16px', border:'none', borderRadius:8, background:'#1a1a2e', color:'#fff', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              ⬇ Exportar
            </button>

            {/* ✅ VENC-CONTACTOS-001 — CSV listo para Google Contacts */}
            <button
              onClick={exportarGoogleContacts}
              title="Genera el CSV de contactos agrupado por cliente y etiquetado por mes, listo para importar en Google Contacts y armar la difusión de WhatsApp"
              style={{ padding:'8px 16px', border:'none', borderRadius:8, background:'#16a34a', color:'#fff', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              📇 Contactos WhatsApp
            </button>

            {/* ✅ VENC-CICLO-002 — cerrar ciclos de clientes ya atendidos */}
            <button
              onClick={() => { setCicloEstado({}); revisarCiclos(); }}
              title="Detecta clientes que ya recargaron y cuyo vencimiento viejo sigue abierto, para que Lucy no los llame"
              style={{ padding:'8px 16px', border:'none', borderRadius:8, background:'#0369a1', color:'#fff', fontWeight:700, fontSize:13, cursor:'pointer' }}>
              🔄 Cerrar ciclos atendidos
            </button>
          </div>

          {/* Panel de revisión — simulación antes de aplicar */}
          {cicloEstado && (
            <div style={{ background:'#f0f9ff', border:'1.5px solid #bae6fd', borderRadius:12, padding:16, marginBottom:16 }}>
              {cicloEstado.cargando && <div style={{ color:'#0369a1', fontWeight:600, fontSize:13 }}>Revisando órdenes de los últimos 6 meses…</div>}

              {cicloEstado.error && (
                <div style={{ color:'#b91c1c', fontWeight:600, fontSize:13 }}>❌ {cicloEstado.error}</div>
              )}

              {cicloEstado.aplicado !== undefined && (
                <div style={{ color:'#15803d', fontWeight:700, fontSize:14 }}>
                  ✓ Listo: {cicloEstado.aplicado} vencimiento(s) cerrados. Lucy ya no los va a llamar.
                </div>
              )}

              {cicloEstado.resultado && cicloEstado.aplicado === undefined && !cicloEstado.cargando && (
                <>
                  <div style={{ fontWeight:800, fontSize:14, color:'#0c4a6e', marginBottom:4 }}>
                    {cicloEstado.resultado.aCerrar} vencimiento(s) se pueden cerrar
                  </div>
                  <div style={{ fontSize:12, color:'#0369a1', marginBottom:12 }}>
                    Son clientes que ya recargaron pero cuyo vencimiento viejo sigue abierto.
                    Esto es una simulación: todavía no se ha modificado nada.
                  </div>

                  {cicloEstado.resultado.aCerrar > 0 && (
                    <>
                      <div style={{ maxHeight:220, overflowY:'auto', background:'#fff', borderRadius:8, padding:10, marginBottom:12 }}>
                        {cicloEstado.resultado.detalle.map(x => (
                          <div key={x.id} style={{ fontSize:12, padding:'5px 0', borderBottom:'1px solid #f1f5f9' }}>
                            <strong>{x.cliente || x.telefono}</strong> · {x.equipo}
                            <div style={{ color:'#64748b', fontSize:11 }}>
                              Vencía {x.vencia} · atendido el {x.atendidoEn} {x.orden ? `(orden ${x.orden})` : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display:'flex', gap:8 }}>
                        <button onClick={() => setCicloEstado(null)}
                          style={{ padding:'9px 16px', border:'1px solid #cbd5e1', borderRadius:8, background:'#fff', color:'#475569', fontWeight:700, fontSize:13, cursor:'pointer' }}>
                          Cancelar
                        </button>
                        <button onClick={aplicarCiclos}
                          style={{ padding:'9px 18px', border:'none', borderRadius:8, background:'#0369a1', color:'#fff', fontWeight:700, fontSize:13, cursor:'pointer' }}>
                          ✓ Cerrar estos {cicloEstado.resultado.aCerrar}
                        </button>
                      </div>
                    </>
                  )}

                  {cicloEstado.resultado.aCerrar === 0 && (
                    <button onClick={() => setCicloEstado(null)}
                      style={{ padding:'8px 14px', border:'1px solid #cbd5e1', borderRadius:8, background:'#fff', color:'#475569', fontWeight:700, fontSize:12, cursor:'pointer' }}>
                      Cerrar
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Lista de vencimientos */}
          {cargando ? (
            <div style={{ textAlign:'center', color:'#9ca3af', padding:20 }}>Cargando...</div>
          ) : error ? (
            /* No decir "Sin vencimientos" cuando lo que pasó es que el backend
               falló: esa mentira fue justamente la que ocultó el tope de 2000
               durante meses. Si algo se rompió, se dice. */
            <div style={{
              textAlign:'center', padding:24, background:'#fef2f2',
              border:'1px solid #fecaca', borderRadius:10, color:'#b91c1c'
            }}>
              <div style={{ fontWeight:800, marginBottom:6 }}>
                No se pudieron cargar los vencimientos
              </div>
              <div style={{ fontSize:13, marginBottom:12 }}>{error}</div>
              <div style={{ fontSize:12, color:'#7f1d1d', marginBottom:12 }}>
                Los datos están intactos: falló la consulta, no la base.
              </div>
              <button
                onClick={() => cargar()}
                style={{
                  padding:'8px 18px', border:'none', borderRadius:8,
                  background:'#b91c1c', color:'#fff', fontWeight:700, cursor:'pointer'
                }}>
                Reintentar
              </button>
            </div>
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
                        {mes.total} cliente{mes.total!==1?'s':''}
                        {mes.totalEquipos ? ` · ${mes.totalEquipos} equipo${mes.totalEquipos!==1?'s':''}` : ''} •
                        <span style={{ marginLeft:8, color:'#b91c1c' }}>🔴 {mes.estados.VENCIDO||0}</span>
                        <span style={{ marginLeft:8, color:'#b45309' }}>🟡 {mes.estados.POR_VENCER||0}</span>
                        <span style={{ marginLeft:8, color:'#15803d' }}>🟢 {mes.estados.VIGENTE||0}</span>
                      </div>
                    </div>
                    <div style={{ fontSize:18, color:'#9ca3af' }}>{mesAbierto === mes.key ? '▼' : '▶'}</div>
                  </button>

                  {/* Clientes del mes — se piden al servidor al abrir el mes */}
                  {mesAbierto === mes.key && (
                    <div style={{ padding:'0 16px 16px', background:'#f9fafb' }}>
                      {cargandoMes === mes.key && (
                        <div style={{ textAlign:'center', color:'#9ca3af', padding:16, fontSize:13 }}>
                          Cargando {mes.total} cliente{mes.total!==1?'s':''}...
                        </div>
                      )}
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
                                  <a href={`tel:+57${String(c.telefono || '').replace(/^57/, '')}`} onClick={e => e.stopPropagation()} style={{ fontSize:11, color:est.color, textDecoration:'none', marginTop:2, display:'inline-block' }}>
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

          {/* ✅ VENC-MANUAL-001: Modal crear vencimiento manual */}
          {mostrarForm && (
            <div onClick={() => { if(!guardandoForm){ setMostrarForm(false); setMsgForm(null); } }}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:500, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
              <div onClick={e => e.stopPropagation()} style={{ background:'#fff', borderRadius:16, width:'100%', maxWidth:480, maxHeight:'92vh', overflowY:'auto', padding:20 }}>

                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
                  <div style={{ fontWeight:800, fontSize:15, color:'#1a1a2e' }}>➕ Nuevo vencimiento</div>
                  <button onClick={() => { setMostrarForm(false); setMsgForm(null); }} disabled={guardandoForm}
                    style={{ border:'none', background:'#f3f4f6', borderRadius:8, width:30, height:30, cursor:'pointer' }}>✕</button>
                </div>

                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Cliente *</div>
                  <select value={form.clienteId} onChange={e => setForm(f => ({ ...f, clienteId: e.target.value }))} style={inp}>
                    <option value="">— Selecciona el cliente —</option>
                    {clientes.map(c => (
                      <option key={c.id || c.uid} value={c.id || c.uid}>
                        {c.nombre || c.empresa || 'Sin nombre'}{c.nit ? ` — NIT ${c.nit}` : ''}
                      </option>
                    ))}
                  </select>
                  {clientes.length === 0 && (
                    <div style={{ fontSize:11, color:'#b45309', marginTop:5 }}>
                      No hay clientes cargados. Crea el cliente primero en el módulo Clientes.
                    </div>
                  )}
                </div>

                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Equipo *</div>
                  <input type="text" placeholder="Ej: Extintor ABC 10 lbs" style={inp}
                    value={form.descripcionEquipo}
                    onChange={e => setForm(f => ({ ...f, descripcionEquipo: e.target.value }))} />
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Cantidad</div>
                    <input type="number" min="1" style={inp}
                      value={form.cantidad}
                      onChange={e => setForm(f => ({ ...f, cantidad: e.target.value }))} />
                  </div>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Sucursal</div>
                    <input type="text" placeholder="Opcional" style={inp}
                      value={form.sucursal}
                      onChange={e => setForm(f => ({ ...f, sucursal: e.target.value }))} />
                  </div>
                </div>

                <div style={{ background:'#f9fafb', border:'1px solid #e5e7eb', borderRadius:10, padding:'12px 14px', marginBottom:12 }}>
                  <div style={{ fontSize:11, color:'#6b7280', marginBottom:10, lineHeight:1.5 }}>
                    Con la <strong>fecha de última recarga</strong>, el vencimiento se calcula solo (12 meses después).
                    Si ya conoces la fecha exacta de vencimiento, escríbela abajo y manda esa.
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                    <div>
                      <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Última recarga</div>
                      <input type="date" style={inp}
                        value={form.fechaUltimaRecarga}
                        onChange={e => setForm(f => ({ ...f, fechaUltimaRecarga: e.target.value }))} />
                    </div>
                    <div>
                      <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Vencimiento</div>
                      <input type="date" style={inp}
                        value={form.fechaVencimiento}
                        onChange={e => setForm(f => ({ ...f, fechaVencimiento: e.target.value }))} />
                    </div>
                  </div>
                </div>

                {msgForm && (
                  <div style={{ marginBottom:12, background: msgForm.startsWith('✓') ? '#dcfce7' : '#fee2e2', color: msgForm.startsWith('✓') ? '#15803d' : '#b91c1c', borderRadius:8, padding:'9px 12px', fontSize:12, fontWeight:600 }}>
                    {msgForm}
                  </div>
                )}

                <button onClick={guardarVencimiento} disabled={guardandoForm}
                  style={{
                    width:'100%', border:'none', borderRadius:10, padding:'12px 0', fontWeight:700, fontSize:13,
                    background: guardandoForm ? '#e5e7eb' : '#16a34a',
                    color: guardandoForm ? '#9ca3af' : '#fff',
                    cursor: guardandoForm ? 'not-allowed' : 'pointer',
                  }}>
                  {guardandoForm ? 'Guardando...' : 'Crear vencimiento'}
                </button>
              </div>
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

                {/* ✅ VENC-IMPORT-EMPRESA-001 — La empresa viaja en el archivo.
                    Antes este selector era obligatorio y obligaba a partir la
                    base en un archivo por razón social. Ahora es opcional: solo
                    se usa como respaldo para las filas sin columna
                    `empresaFactura`. Un archivo, toda la base. */}
                <div style={{ marginBottom:14, background:'#f5f3ff', border:'1px solid #ddd6fe', borderRadius:10, padding:'12px 14px' }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#5b21b6', marginBottom:4 }}>Plantilla y formato</div>
                  <div style={{ fontSize:11, color:'#6d28d9', lineHeight:1.6, marginBottom:8 }}>
                    Obligatorias: <strong>nombre</strong> y <strong>telefono</strong>.<br/>
                    Opcionales: nit, sucursal, equipo, cantidad, fechaUltimaRecarga y{' '}
                    <strong>empresaFactura</strong>.<br/>
                    <span style={{ display:'inline-block', marginTop:5, background:'#ede9fe', borderRadius:6, padding:'5px 8px' }}>
                      💡 Si pones la columna <strong>empresaFactura</strong>, cada cliente se asigna a su
                      razón social automáticamente y puedes subir <strong>un solo archivo</strong> con toda
                      la base, sin partirla por empresa.
                    </span><br/>
                    Con fecha de recarga → Vencimientos (vence 12 meses después). Sin fecha → Telemercadeo como prospecto.
                  </div>
                  <button onClick={descargarPlantilla}
                    style={{ padding:'7px 14px', border:'none', borderRadius:8, background:'#7c3aed', color:'#fff', fontWeight:700, fontSize:12, cursor:'pointer' }}>
                    ⬇ Descargar plantilla CSV
                  </button>
                </div>

                {empresasDisponibles.length > 1 && (
                  <div style={{ marginBottom:14 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>
                      Empresa por defecto <span style={{ fontWeight:500, color:'#9ca3af' }}>(opcional)</span>
                    </div>
                    <select value={empresaImportSel} onChange={e => setEmpresaImportSel(e.target.value)} style={inp}>
                      <option value="">— Usar la columna empresaFactura del archivo —</option>
                      {empresasDisponibles.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                    <div style={{ fontSize:11, color:'#6b7280', marginTop:5, lineHeight:1.5 }}>
                      Solo se aplica a las filas que no traigan empresa propia en el archivo.
                    </div>
                  </div>
                )}

                <div style={{ marginBottom:6 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#374151', marginBottom:6 }}>Sube tu archivo CSV</div>
                  <div style={{ background:'#f9fafb', border:'2px dashed #e5e7eb', borderRadius:10, padding:18, textAlign:'center' }}>
                    <input type="file" accept=".csv" id="fileImportVenc" hidden disabled={importando}
                      onChange={e => { const f = e.target.files && e.target.files[0]; if (f) setArchivoImportSel(f); e.target.value=''; }} />
                    <label htmlFor="fileImportVenc" style={{
                      display:'inline-block', padding:'10px 20px', borderRadius:8, fontWeight:700, fontSize:13,
                      background: importando ? '#e5e7eb' : '#7c3aed',
                      color: importando ? '#9ca3af' : '#fff',
                      cursor: importando ? 'not-allowed' : 'pointer',
                    }}>
                      📂 {archivoImportSel ? archivoImportSel.name : 'Seleccionar CSV'}
                    </label>
                  </div>
                </div>

                {msgImport && (
                  <div style={{ marginTop:12, whiteSpace:'pre-line', background:msgImport.startsWith('✓')?'#dcfce7':'#fee2e2', color:msgImport.startsWith('✓')?'#15803d':'#b91c1c', borderRadius:8, padding:'9px 12px', fontSize:12, fontWeight:600 }}>
                    {msgImport}
                  </div>
                )}

                <button
                  onClick={() => archivoImportSel && importarCSV(archivoImportSel, empresaImportSel, empresasDisponibles.find(e => e.id===empresaImportSel)?.name || '')}
                  disabled={!archivoImportSel || importando}
                  style={{
                    width:'100%', marginTop:14, border:'none', borderRadius:10, padding:'12px 0', fontWeight:700, fontSize:13,
                    background: (archivoImportSel && !importando) ? '#1a1a2e' : '#e5e7eb',
                    color: (archivoImportSel && !importando) ? '#fff' : '#9ca3af',
                    cursor: (archivoImportSel && !importando) ? 'pointer' : 'not-allowed',
                  }}>
                  {importando ? 'Importando...' : 'Importar archivo'}
                </button>

                <button
                  onClick={() => { setMostrarImportVenc(false); setMostrarHistorial(true); }}
                  style={{ width:'100%', marginTop:8, background:'none', border:'none', color:'#6d28d9', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                  🗂 Ver historial de cargas anteriores
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
                    <a href={`tel:+57${String(detalle.cli.telefono || '').replace(/^57/, '')}`} style={{ display:'block', fontSize:14, fontWeight:700, color:'#7c3aed', textDecoration:'none', marginBottom:4 }}>
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
                        <div style={{ fontSize:11, color:'#9ca3af' }}>
                          Vence {eq.fechaVencimiento || 's/f'}
                          {eq.fechaUltimaRecarga ? ` · recargó ${eq.fechaUltimaRecarga}` : ''}
                        </div>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ background:est.bg, color:est.color, fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:8 }}>{est.label}</span>
                        {/* ✅ VENC-EDICION-001: editar y borrar el equipo — ambos con PIN */}
                        <button
                          title="Editar este vencimiento (requiere PIN)"
                          onClick={() => { setMsgEdicion(null); setEdicion({ modo:'editar', venc: eq, cli: detalle.cli, campos: { descripcionEquipo: eq.descripcionEquipo || '', cantidad: eq.cantidad || 1, sucursal: eq.sucursal || '', fechaUltimaRecarga: eq.fechaUltimaRecarga || '', fechaVencimiento: eq.fechaVencimiento || '' } }); }}
                          style={{ border:'1px solid #e5e7eb', background:'#fff', borderRadius:7, padding:'4px 8px', fontSize:12, cursor:'pointer' }}>
                          ✏️
                        </button>
                        <button
                          title="Borrar este vencimiento (requiere PIN y motivo)"
                          onClick={() => { setMsgEdicion(null); setEdicion({ modo:'borrar', venc: eq, cli: detalle.cli }); }}
                          style={{ border:'1px solid #fecaca', background:'#fff', borderRadius:7, padding:'4px 8px', fontSize:12, cursor:'pointer', color:'#dc2626' }}>
                          🗑
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div style={{ display:'flex', gap:8, marginTop:16 }}>
                  {detalle.cli.telefono && (
                    <a href={`tel:+57${String(detalle.cli.telefono || '').replace(/^57/, '')}`} style={{ flex:1, textAlign:'center', background:'#7c3aed', color:'#fff', borderRadius:10, padding:'12px 0', fontWeight:700, fontSize:13, textDecoration:'none' }}>
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
        <ModuloAnny user={user} onNavegar={onNavegar} />
      )}

      {/* ===== VISTA: LUCY ===== */}
      {/* ✅ FIX LUCY-BOTONES-001: se montaba SIN el prop `user`, así que
          esAdmin (user.role === 'admin') siempre era falso y los botones
          "Lanzar ahora", "Programar" y "Llamada de prueba" NUNCA se dibujaban,
          aunque el backend sí los tenía listos. */}
      {vista === 'llamadas_ia' && (
        <LlamadasIA user={user} onNavegar={onNavegar} />
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          ✅ VENC-IMPORT-LOTE-001 — Historial de importaciones
          ═══════════════════════════════════════════════════════════════ */}
      {mostrarHistorial && (
        <HistorialImportaciones
          onCerrar={() => setMostrarHistorial(false)}
          onCambio={() => { cargar(); setRefrescarPanel(n => n + 1); }}
        />
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          ✅ VENC-EDICION-001 — Editar / borrar un vencimiento
          El formulario se muestra primero y el PIN se pide AL FINAL, cuando
          ya se sabe qué se va a cambiar. Pedir el PIN de entrada obliga a
          autenticarse para algo que quizá se termina cancelando.
          ═══════════════════════════════════════════════════════════════ */}
      {edicion && edicion.modo === 'editar' && (
        <div onClick={e => { if (e.target === e.currentTarget) setEdicion(null); }}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:900, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:'#fff', borderRadius:16, width:'100%', maxWidth:440, padding:20, maxHeight:'92vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
              <div style={{ fontWeight:800, fontSize:15, color:'#1a1a2e' }}>✏️ Editar vencimiento</div>
              <button onClick={() => setEdicion(null)} style={{ border:'none', background:'#f3f4f6', borderRadius:8, width:30, height:30, cursor:'pointer' }}>✕</button>
            </div>
            <div style={{ fontSize:12, color:'#6b7280', marginBottom:14 }}>{edicion.cli?.nombre}</div>

            <div style={{ display:'flex', flexDirection:'column', gap:11 }}>
              <div>
                <div style={lbl}>Equipo</div>
                <input style={inp} value={edicion.campos.descripcionEquipo}
                  onChange={e => setEdicion(s => ({ ...s, campos:{ ...s.campos, descripcionEquipo:e.target.value } }))} />
              </div>
              <div style={{ display:'flex', gap:10 }}>
                <div style={{ flex:1 }}>
                  <div style={lbl}>Cantidad</div>
                  <input style={inp} type="number" min="1" value={edicion.campos.cantidad}
                    onChange={e => setEdicion(s => ({ ...s, campos:{ ...s.campos, cantidad:e.target.value } }))} />
                </div>
                <div style={{ flex:2 }}>
                  <div style={lbl}>Sucursal</div>
                  <input style={inp} value={edicion.campos.sucursal}
                    onChange={e => setEdicion(s => ({ ...s, campos:{ ...s.campos, sucursal:e.target.value } }))} />
                </div>
              </div>
              <div>
                <div style={lbl}>Última recarga</div>
                <input style={inp} type="date" value={edicion.campos.fechaUltimaRecarga}
                  onChange={e => setEdicion(s => ({ ...s, campos:{ ...s.campos, fechaUltimaRecarga:e.target.value, fechaVencimiento:'' } }))} />
                <div style={{ fontSize:11, color:'#6b7280', marginTop:4, lineHeight:1.5 }}>
                  Al cambiar esta fecha, el vencimiento se recalcula solo a 12 meses después.
                </div>
              </div>
              <div>
                <div style={lbl}>O fija el vencimiento directamente</div>
                <input style={inp} type="date" value={edicion.campos.fechaVencimiento}
                  onChange={e => setEdicion(s => ({ ...s, campos:{ ...s.campos, fechaVencimiento:e.target.value } }))} />
              </div>
            </div>

            <div style={{ background:'#fffbeb', border:'1px solid #fde68a', borderRadius:10, padding:'10px 12px', fontSize:11.5, color:'#92400e', lineHeight:1.55, marginTop:14 }}>
              Cambiar la fecha mueve la próxima llamada, la alerta y la venta proyectada de este cliente.
              Por eso se confirma con tu PIN.
            </div>

            <button onClick={() => setPinEdicion('editar')}
              style={{ width:'100%', marginTop:14, border:'none', borderRadius:10, padding:'12px 0', fontWeight:700, fontSize:13, background:'#7c3aed', color:'#fff', cursor:'pointer' }}>
              🔐 Guardar cambios
            </button>
          </div>
        </div>
      )}

      {edicion && edicion.modo === 'borrar' && (
        <div onClick={e => { if (e.target === e.currentTarget) setEdicion(null); }}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:900, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:'#fff', borderRadius:16, width:'100%', maxWidth:420, padding:20 }}>
            <div style={{ fontWeight:800, fontSize:15, color:'#1a1a2e', marginBottom:10 }}>🗑 Borrar vencimiento</div>
            <div style={{ background:'#f9fafb', borderRadius:10, padding:'11px 13px', fontSize:12.5, color:'#374151', lineHeight:1.6 }}>
              <strong>{edicion.cli?.nombre}</strong><br/>
              {edicion.venc.cantidad > 1 ? `${edicion.venc.cantidad}× ` : ''}{edicion.venc.descripcionEquipo}<br/>
              Vence {edicion.venc.fechaVencimiento || 's/f'}
            </div>
            <div style={{ background:'#fef2f2', border:'1px solid #fca5a5', borderRadius:10, padding:'11px 13px', fontSize:12, color:'#991b1b', lineHeight:1.6, marginTop:12 }}>
              Este equipo desaparece de Vencimientos, de Telemercadeo y de las alertas de Lucy.
              Queda copia completa en auditoría por si hay que reconstruirlo.
            </div>
            <div style={{ display:'flex', gap:10, marginTop:16 }}>
              <button onClick={() => setEdicion(null)}
                style={{ flex:1, background:'#f3f4f6', border:'none', borderRadius:9, padding:'11px 0', fontWeight:600, fontSize:13, cursor:'pointer' }}>
                Cancelar
              </button>
              <button onClick={() => setPinEdicion('borrar')}
                style={{ flex:1, background:'#dc2626', color:'#fff', border:'none', borderRadius:9, padding:'11px 0', fontWeight:700, fontSize:13, cursor:'pointer' }}>
                🔐 Continuar
              </button>
            </div>
          </div>
        </div>
      )}

      {pinEdicion && (
        <ModalPin
          accion={pinEdicion === 'borrar' ? 'borrar_vencimiento' : 'editar_vencimiento'}
          titulo={pinEdicion === 'borrar' ? 'Borrar vencimiento' : 'Editar vencimiento'}
          advertencia={pinEdicion === 'borrar'
            ? 'El equipo se elimina del radar comercial. Queda copia en auditoría.'
            : 'Cambiar la fecha corre el próximo ciclo de recarga de este cliente.'}
          requiereMotivo={pinEdicion === 'borrar'}
          minMotivo={5}
          textoBoton={pinEdicion === 'borrar' ? '🗑 Borrar' : '💾 Guardar'}
          onConfirmar={(pin, motivo) => (pinEdicion === 'borrar' ? borrarVencimiento(pin, motivo) : guardarEdicion(pin, motivo))}
          onCancelar={() => setPinEdicion(null)}
        />
      )}
    </div>
  );
}