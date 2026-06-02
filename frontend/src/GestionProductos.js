import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const API = 'http://localhost:5000/api';

const TIPOS = [
  { value: 'simple',    label: 'Producto Simple',  emoji: '📦', desc: 'Lo compras y revendes tal cual' },
  { value: 'insumo',    label: 'Insumo',           emoji: '🔩', desc: 'Componente que se vende solo o forma parte de compuestos' },
  { value: 'servicio',  label: 'Servicio',         emoji: '🔧', desc: 'Mano de obra, sin stock físico' },
  { value: 'compuesto', label: 'Compuesto',        emoji: '⚙️', desc: 'Se arma con otros productos, descuenta inventario automático' },
  { value: 'combo',     label: 'Combo',            emoji: '🎁', desc: 'Paquete de servicios a precio especial' },
];

const FORM_VACIO = {
  nombre: '', categoriaId: '', categoriaNombre: '', categoriaPrefijo: '',
  tipo: 'simple', precioCosto: '', precioVenta: '',
  stock: '', stockMinimo: '', componentes: [], descripcion: '', codigo: '',
  requiereQR: false, requiereCertificado: false
};

const formatCOP = (v) => {
  if (!v && v !== 0) return '';
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v);
};

const GestionProductos = ({ user }) => {
  const [vista, setVista]               = useState('productos'); // productos | categorias | ajuste
  const [categorias, setCategorias]     = useState([]);
  const [productos, setProductos]       = useState([]);
  const [loading, setLoading]           = useState(true);
  const [buscar, setBuscar]             = useState('');
  const [filtroCategoria, setFiltroCategoria] = useState('');
  const [filtroTipo, setFiltroTipo]     = useState('');
  const [mostrarForm, setMostrarForm]   = useState(false);
  const [editandoId, setEditandoId]     = useState(null);
  const [form, setForm]                 = useState(FORM_VACIO);
  const [guardando, setGuardando]       = useState(false);
  const [error, setError]               = useState('');
  const [exito, setExito]               = useState('');
  const isAdmin = user?.role === 'admin';
  const [verInactivos, setVerInactivos] = useState(false);
  const [mostrarImport, setMostrarImport] = useState(false);
  const [previstaImport, setPrevistaImport] = useState([]);
  const [importando, setImportando] = useState(false);
  const [resultadoImport, setResultadoImport] = useState(null);
  const [compuestosAfectados, setCompuestosAfectados] = useState([]);
  const [mostrarAlertaCompuestos, setMostrarAlertaCompuestos] = useState(false);

  // Ajuste masivo
  const [ajustePct, setAjustePct]       = useState('');
  const [ajusteCategoria, setAjusteCategoria] = useState('');
  const [ajusteTipo, setAjusteTipo]     = useState('');
  const [preview, setPreview]           = useState([]);
  const [previewEditado, setPreviewEditado] = useState([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [aplicando, setAplicando]       = useState(false);

  // Categorías form
  const [formCat, setFormCat]           = useState({ nombre: '', prefijo: '', descripcion: '' });
  const [guardandoCat, setGuardandoCat] = useState(false);
  const [editandoCat, setEditandoCat]   = useState(null);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // ─── CARGAR CATEGORÍAS ──────────────────────────────────────────────────────
  const cargarCategorias = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/products/categorias/lista`, { headers });
      setCategorias(Array.isArray(res.data) ? res.data : []);
    } catch { setCategorias([]); }
  }, [token]);

  // ─── CARGAR PRODUCTOS ───────────────────────────────────────────────────────
  const cargarProductos = useCallback(async () => {
    try {
      setLoading(true);
      const res = await axios.get(`${API}/products`, { headers });
      setProductos(Array.isArray(res.data) ? res.data : []);
    } catch { setProductos([]); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { cargarCategorias(); }, [cargarCategorias]);
  useEffect(() => { cargarProductos(); }, [cargarProductos]);

  // ─── GUARDAR PRODUCTO ───────────────────────────────────────────────────────
  const guardar = async () => {
    setError('');
    if (!form.nombre.trim()) { setError('El nombre es obligatorio'); return; }
    if (!form.categoriaId) { setError('Selecciona una categoría'); return; }
    if (!form.tipo) { setError('Selecciona el tipo'); return; }
    if (!form.precioVenta && form.precioVenta !== 0) { setError('El precio de venta es obligatorio'); return; }
    if (form.tipo === 'compuesto' && form.componentes.length === 0) {
      setError('Un producto compuesto necesita al menos un componente'); return;
    }
    try {
      setGuardando(true);
      const payload = {
        ...form,
        precioCosto: parseFloat(form.precioCosto) || 0,
        precioVenta: parseFloat(form.precioVenta) || 0,
        stock: parseInt(form.stock) || 0,
        stockMinimo: parseInt(form.stockMinimo) || 0,
      };
      if (editandoId) {
        const res = await axios.put(`${API}/products/${editandoId}`, payload, { headers });
        setExito('Producto actualizado ✓');
        // Verificar si hay compuestos afectados
        if (res.data.compuestosAfectados?.length > 0) {
          setCompuestosAfectados(res.data.compuestosAfectados);
          setMostrarAlertaCompuestos(true);
        }
      } else {
        await axios.post(`${API}/products`, payload, { headers });
        setExito('Producto creado ✓');
      }
      await cargarProductos();
      setTimeout(() => { setMostrarForm(false); setExito(''); }, 1500);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al guardar');
    } finally { setGuardando(false); }
  };

  // ─── ABRIR FORMULARIO ───────────────────────────────────────────────────────
  const abrirNuevo = () => {
    setEditandoId(null);
    setForm(FORM_VACIO);
    setError(''); setExito('');
    setMostrarForm(true);
  };

  const abrirEditar = (p) => {
    setEditandoId(p.id);
    setForm({
      nombre: p.nombre || '', categoriaId: p.categoriaId || '',
      categoriaNombre: p.categoria || '', categoriaPrefijo: '',
      tipo: p.tipo || 'simple',
      precioCosto: p.precioCosto || '', precioVenta: p.precioVenta || '',
      stock: p.stock || '', stockMinimo: p.stockMinimo || '',
      componentes: p.componentes || [], descripcion: p.descripcion || '',
      codigo: p.codigo || ''
    });
    setError(''); setExito('');
    setMostrarForm(true);
  };

  // ─── COMPONENTES DEL COMPUESTO ──────────────────────────────────────────────
  const agregarComponente = (producto) => {
    if (form.componentes.find(c => c.productoId === producto.id)) return;
    setForm(p => ({
      ...p,
      componentes: [...p.componentes, {
        productoId: producto.id,
        nombre: producto.nombre,
        codigo: producto.codigo,
        cantidad: 1,
        costo: producto.precioCosto || 0
      }]
    }));
  };

  const editarComponente = (idx, campo, valor) => {
    setForm(p => {
      const comps = [...p.componentes];
      comps[idx] = { ...comps[idx], [campo]: campo === 'cantidad' ? parseInt(valor) || 1 : parseFloat(valor) || 0 };
      return { ...p, componentes: comps };
    });
  };

  const eliminarComponente = (idx) => {
    setForm(p => ({ ...p, componentes: p.componentes.filter((_, i) => i !== idx) }));
  };

  const costoCompuesto = form.componentes.reduce((sum, c) => sum + (c.costo * c.cantidad), 0);
  const margenCalculado = form.precioVenta > 0
    ? (((form.precioVenta - costoCompuesto) / form.precioVenta) * 100).toFixed(1)
    : 0;

  // ─── CATEGORÍAS ─────────────────────────────────────────────────────────────
  const guardarCategoria = async () => {
    if (!formCat.nombre || !formCat.prefijo) { setError('Nombre y prefijo requeridos'); return; }
    try {
      setGuardandoCat(true);
      if (editandoCat) {
        await axios.put(`${API}/products/categorias/${editandoCat}`, formCat, { headers });
      } else {
        await axios.post(`${API}/products/categorias`, formCat, { headers });
      }
      setFormCat({ nombre: '', prefijo: '', descripcion: '' });
      setEditandoCat(null);
      await cargarCategorias();
      setExito('Categoría guardada ✓');
      setTimeout(() => setExito(''), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al guardar categoría');
    } finally { setGuardandoCat(false); }
  };

  const eliminarCategoria = async (id) => {
    if (!window.confirm('¿Eliminar esta categoría?')) return;
    try {
      await axios.delete(`${API}/products/categorias/${id}`, { headers });
      await cargarCategorias();
    } catch (err) {
      setError(err.response?.data?.error || 'Error al eliminar');
    }
  };

  // ─── AJUSTE MASIVO ──────────────────────────────────────────────────────────
  const generarPreview = async () => {
    if (!ajustePct || parseFloat(ajustePct) <= 0) { setError('Ingresa un porcentaje válido'); return; }
    try {
      setLoadingPreview(true); setError('');
      const res = await axios.post(`${API}/products/ajuste-masivo/preview`, {
        porcentaje: parseFloat(ajustePct),
        categoriaId: ajusteCategoria || undefined,
        tipo: ajusteTipo || undefined
      }, { headers });
      setPreview(res.data.preview || []);
      setPreviewEditado(res.data.preview?.map(p => ({ ...p })) || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Error generando preview');
    } finally { setLoadingPreview(false); }
  };

  const aplicarAjuste = async () => {
    if (!window.confirm(`¿Aplicar ajuste a ${previewEditado.length} productos?`)) return;
    try {
      setAplicando(true);
      await axios.post(`${API}/products/ajuste-masivo/aplicar`, {
        productos: previewEditado.map(p => ({ id: p.id, precioNuevo: p.precioNuevo })),
        porcentaje: parseFloat(ajustePct)
      }, { headers });
      setExito(`✅ Precios actualizados: ${previewEditado.length} productos`);
      setPreview([]); setPreviewEditado([]);
      setAjustePct('');
      await cargarProductos();
      setTimeout(() => setExito(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Error aplicando ajuste');
    } finally { setAplicando(false); }
  };

  const eliminarProducto = async (id, nombre) => {
    if (!window.confirm('¿Eliminar o desactivar "' + nombre + '"?')) return;
    try {
      const res = await axios.delete(API + '/products/' + id, { headers });
      setExito(res.data.mensaje);
      await cargarProductos();
      setTimeout(() => setExito(''), 4000);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al eliminar');
    }
  };

  const tipoInfo = (tipo) => TIPOS.find(t => t.value === tipo) || TIPOS[0];

  // ─── LISTA DE PRECIOS ────────────────────────────────────────────────────────
  const generarListaPrecios = (modo = 'imprimir') => {
    const activos = productos.filter(p => p.activo !== false && p.tipo !== 'insumo');
    const porCategoria = {};
    activos.forEach(p => {
      const cat = p.categoria || 'Sin categoría';
      if (!porCategoria[cat]) porCategoria[cat] = [];
      porCategoria[cat].push(p);
    });
    const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
    const filas = Object.entries(porCategoria).map(([cat, prods]) => `
      <tr style="background:#7c3aed;color:#fff"><td colspan="3" style="padding:10px 14px;font-weight:700;font-size:14px">${cat}</td></tr>
      ${prods.map(p => `<tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:8px 14px;font-size:13px;color:#9ca3af">${p.codigo || ''}</td>
        <td style="padding:8px 14px;font-size:13px;font-weight:600">${p.nombre}</td>
        <td style="padding:8px 14px;font-size:14px;font-weight:800;color:#16a34a;text-align:right">${fmt(p.precioVenta)}</td>
      </tr>`).join('')}
    `).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Lista de Precios</title>
    <style>body{font-family:'Segoe UI',sans-serif;margin:0;padding:24px;color:#111}@media print{body{padding:8mm}}</style>
    </head><body><div style="max-width:680px;margin:0 auto">
    <div style="border-bottom:3px solid #7c3aed;padding-bottom:16px;margin-bottom:20px">
      <div style="font-size:22px;font-weight:900;color:#7c3aed">LISTA DE PRECIOS</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px">Válida al ${new Date().toLocaleDateString('es-CO', { day:'2-digit', month:'long', year:'numeric' })}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:#f9fafb">
        <th style="padding:8px 14px;text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase">Código</th>
        <th style="padding:8px 14px;text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase">Producto / Servicio</th>
        <th style="padding:8px 14px;text-align:right;font-size:11px;color:#9ca3af;text-transform:uppercase">Precio</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div style="margin-top:24px;font-size:11px;color:#9ca3af;text-align:center;border-top:1px solid #f3f4f6;padding-top:12px">
      Los precios pueden cambiar sin previo aviso · Control360
    </div></div></body></html>`;

    if (modo === 'imprimir') {
      const w = window.open('', '_blank');
      w.document.write(html); w.document.close();
      setTimeout(() => w.print(), 500);
    } else {
      const fmt2 = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
      const resumen = Object.entries(porCategoria).map(([cat, prods]) =>
        `*${cat}*\n${prods.map(p => `• ${p.nombre}: ${fmt2(p.precioVenta)}`).join('\n')}`
      ).join('\n\n');
      const msg = `*LISTA DE PRECIOS*\n_${new Date().toLocaleDateString('es-CO')}_\n\n${resumen}\n\n_Los precios pueden cambiar sin previo aviso_`;
      window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
    }
  };

  // Filtro del lado del cliente (garantiza que filtros funcionen)
  const productosMostrados = (verInactivos ? productos : productos.filter(p => p.activo !== false))
    .filter(p => {
      if (filtroCategoria && p.categoriaId !== filtroCategoria) return false;
      if (filtroTipo && p.tipo !== filtroTipo) return false;
      if (buscar) {
        const q = buscar.toLowerCase();
        return p.nombre?.toLowerCase().includes(q) || p.codigo?.toLowerCase().includes(q);
      }
      return true;
    });

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div style={s.wrapper}>
      {/* HEADER */}
      <div style={s.pageHeader}>
        <div>
          <h2 style={s.pageTitle}>📦 Productos y Servicios</h2>
          <p style={s.pageSubtitle}>Catálogo centralizado con inventario y precios</p>
        </div>
        <div style={s.headerBtns}>
          {isAdmin && (
            <>
              <button onClick={() => setVista('productos')} style={vista === 'productos' ? s.btnActivo : s.btnSecundario}>📦 Productos</button>
              <button onClick={() => setVista('categorias')} style={vista === 'categorias' ? s.btnActivo : s.btnSecundario}>🗂️ Categorías</button>
              <button onClick={() => setVista('ajuste')} style={vista === 'ajuste' ? s.btnActivo : s.btnSecundario}>📊 Ajuste Precios</button>
              <button onClick={() => setVista('importar')} style={vista === 'importar' ? s.btnActivo : s.btnSecundario}>📥 Importar</button>
              <button onClick={() => setVista('exportar')} style={s.btnSecundario}>📤 Exportar CSV</button>
            </>
          )}
          <button onClick={() => { setVista('productos'); abrirNuevo(); }} style={s.btnPrimario}>+ Nuevo Producto</button>
        </div>
      </div>

      {error && <div style={s.alertError}>{error}</div>}
      {exito && <div style={s.alertExito}>{exito}</div>}

      {/* ════════════════════════════════════════════
          VISTA: CATEGORÍAS
      ════════════════════════════════════════════ */}
      {vista === 'categorias' && isAdmin && (
        <div style={s.dosColumnas}>
          {/* Form categoría */}
          <div style={s.card}>
            <h3 style={s.cardTitulo}>{editandoCat ? '✏️ Editar Categoría' : '➕ Nueva Categoría'}</h3>
            <div style={s.campo}>
              <label style={s.label}>Nombre *</label>
              <input style={s.input} placeholder="EXTINTORES" value={formCat.nombre}
                onChange={e => setFormCat(p => ({ ...p, nombre: e.target.value.toUpperCase() }))} />
            </div>
            <div style={s.campo}>
              <label style={s.label}>Prefijo código * <span style={s.hint}>(3 letras máx)</span></label>
              <input style={s.input} placeholder="EXT" maxLength={4} value={formCat.prefijo}
                onChange={e => setFormCat(p => ({ ...p, prefijo: e.target.value.toUpperCase() }))} />
              <small style={s.hint2}>Los productos de esta categoría se codificarán: {formCat.prefijo || 'EXT'}-001, {formCat.prefijo || 'EXT'}-002...</small>
            </div>
            <div style={s.campo}>
              <label style={s.label}>Descripción</label>
              <input style={s.input} placeholder="Descripción opcional" value={formCat.descripcion}
                onChange={e => setFormCat(p => ({ ...p, descripcion: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button onClick={guardarCategoria} disabled={guardandoCat} style={s.btnPrimario}>
                {guardandoCat ? 'Guardando...' : editandoCat ? '💾 Actualizar' : '✅ Crear'}
              </button>
              {editandoCat && <button onClick={() => { setEditandoCat(null); setFormCat({ nombre: '', prefijo: '', descripcion: '' }); }} style={s.btnCancelar}>Cancelar</button>}
            </div>
          </div>

          {/* Lista categorías */}
          <div style={s.card}>
            <h3 style={s.cardTitulo}>🗂️ Categorías ({categorias.length})</h3>
            {categorias.length === 0 ? (
              <div style={s.emptyBox}>No hay categorías aún</div>
            ) : (
              categorias.map(cat => (
                <div key={cat.id} style={s.catItem}>
                  <div>
                    <strong style={{ color: '#7c3aed' }}>{cat.prefijo}</strong>
                    <span style={{ margin: '0 8px', color: '#9ca3af' }}>—</span>
                    <span style={{ fontWeight: 600 }}>{cat.nombre}</span>
                    {cat.descripcion && <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#9ca3af' }}>{cat.descripcion}</p>}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => { setEditandoCat(cat.id); setFormCat({ nombre: cat.nombre, prefijo: cat.prefijo, descripcion: cat.descripcion || '' }); }} style={s.btnIcono}>✏️</button>
                    <button onClick={() => eliminarCategoria(cat.id)} style={{ ...s.btnIcono, color: '#dc2626' }}>🗑️</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════
          VISTA: AJUSTE MASIVO DE PRECIOS
      ════════════════════════════════════════════ */}
      {vista === 'ajuste' && isAdmin && (
        <div style={s.card}>
          <h3 style={s.cardTitulo}>📊 Ajuste Masivo de Precios</h3>
          <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '20px' }}>
            Aplica un porcentaje de aumento o descuento a toda la lista o a categorías específicas. El sistema redondea los precios automáticamente.
          </p>

          <div style={s.ajusteForm}>
            <div style={s.campo}>
              <label style={s.label}>Porcentaje de ajuste *</label>
              <div style={s.pctWrap}>
                <input style={{ ...s.input, textAlign: 'center', fontSize: '20px', fontWeight: 700 }}
                  type="number" placeholder="6" value={ajustePct}
                  onChange={e => setAjustePct(e.target.value)} />
                <span style={s.pctSymbol}>%</span>
              </div>
              <small style={s.hint2}>Positivo = aumento, negativo = descuento</small>
            </div>
            <div style={s.campo}>
              <label style={s.label}>Categoría (opcional)</label>
              <select style={s.input} value={ajusteCategoria} onChange={e => setAjusteCategoria(e.target.value)}>
                <option value="">Todas las categorías</option>
                {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
            <div style={s.campo}>
              <label style={s.label}>Tipo (opcional)</label>
              <select style={s.input} value={ajusteTipo} onChange={e => setAjusteTipo(e.target.value)}>
                <option value="">Todos los tipos</option>
                {TIPOS.filter(t => t.value !== 'compuesto').map(t => (
                  <option key={t.value} value={t.value}>{t.emoji} {t.label}</option>
                ))}
              </select>
            </div>
            <button onClick={generarPreview} disabled={loadingPreview} style={{ ...s.btnPrimario, alignSelf: 'flex-end' }}>
              {loadingPreview ? 'Calculando...' : '👁️ Ver preview'}
            </button>
          </div>

          {/* Preview tabla */}
          {previewEditado.length > 0 && (
            <div style={{ marginTop: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h4 style={{ margin: 0, color: '#374151' }}>Vista previa — {previewEditado.length} productos</h4>
                <button onClick={aplicarAjuste} disabled={aplicando} style={s.btnGuardar}>
                  {aplicando ? 'Aplicando...' : `✅ Aplicar a ${previewEditado.length} productos`}
                </button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={s.tabla}>
                  <thead>
                    <tr>
                      {['Código', 'Producto', 'Precio actual', 'Precio nuevo', 'Diferencia'].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewEditado.map((p, i) => (
                      <tr key={p.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                        <td style={s.td}><code style={s.codigo}>{p.codigo}</code></td>
                        <td style={s.td}>{p.nombre}</td>
                        <td style={s.td}>{formatCOP(p.precioActual)}</td>
                        <td style={s.td}>
                          <input
                            type="number"
                            value={p.precioNuevo}
                            onChange={e => {
                              const nuevo = [...previewEditado];
                              nuevo[i] = { ...nuevo[i], precioNuevo: parseInt(e.target.value) || 0 };
                              setPreviewEditado(nuevo);
                            }}
                            style={{ ...s.input, width: '120px', padding: '6px 10px', fontWeight: 700, color: '#7c3aed' }}
                          />
                        </td>
                        <td style={{ ...s.td, color: '#16a34a', fontWeight: 700 }}>
                          +{formatCOP(p.precioNuevo - p.precioActual)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════
          VISTA: LISTA PRODUCTOS
      ════════════════════════════════════════════ */}
      {vista === 'productos' && (
        <>
          {/* Filtros */}
          <div style={s.filtros}>
            <div style={s.searchWrap}>
              <span>🔍</span>
              <input style={s.searchInput} placeholder="Buscar por nombre o código..."
                value={buscar} onChange={e => setBuscar(e.target.value)} />
              {buscar && <button onClick={() => setBuscar('')} style={s.clearBtn}>✕</button>}
            </div>
            <select style={s.select} value={filtroCategoria} onChange={e => setFiltroCategoria(e.target.value)}>
              <option value="">Todas las categorías</option>
              {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
            <select style={s.select} value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
              <option value="">Todos los tipos</option>
              {TIPOS.map(t => <option key={t.value} value={t.value}>{t.emoji} {t.label}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <p style={{ ...s.contador, margin: 0 }}>{productosMostrados.length} producto{productosMostrados.length !== 1 ? 's' : ''}</p>
            <div style={{ display: 'flex', gap: 8 }}>
              {isAdmin && (
                <button onClick={() => setVerInactivos(!verInactivos)} style={{ ...s.btnSecundario, fontSize: '12px', padding: '6px 14px', color: verInactivos ? '#dc2626' : '#6b7280' }}>
                  {verInactivos ? '👁️ Ocultando inactivos' : '👁️ Ver inactivos'}
                </button>
              )}
              <button onClick={() => generarListaPrecios('imprimir')} style={{ ...s.btnSecundario, fontSize: '12px', padding: '6px 14px' }}>🖨️ Lista precios</button>
              <button onClick={() => generarListaPrecios('whatsapp')} style={{ ...s.btnSecundario, fontSize: '12px', padding: '6px 14px', background: '#f0fdf4', color: '#16a34a' }}>💬 Enviar WhatsApp</button>
            </div>
          </div>

          {loading ? (
            <div style={s.loadingBox}>Cargando productos...</div>
          ) : productosMostrados.length === 0 ? (
            <div style={s.emptyBox}>
              <p style={{ fontSize: '48px' }}>📦</p>
              <p>{productos.length === 0 ? 'No hay productos aún' : 'No hay productos con los filtros seleccionados'}</p>
              {productos.length === 0 && <button onClick={abrirNuevo} style={s.btnPrimario}>+ Crear primer producto</button>}
            </div>
          ) : (
            <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.07)', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e5e7eb' }}>
                    {(isAdmin
                      ? ['Código', 'Nombre', 'Tipo', 'Categoría', 'Costo', 'Precio venta', 'Margen', 'Stock', 'Acciones']
                      : ['Código', 'Nombre', 'Tipo', 'Categoría', 'Precio venta']
                    ).map(h => (
                      <th key={h} style={{ padding: '12px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {productosMostrados.map((p, i) => {
                    const tipo = tipoInfo(p.tipo);
                    const stockBajo = p.tieneStock && p.stock <= p.stockMinimo;
                    return (
                      <tr key={p.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', opacity: p.activo === false ? 0.5 : 1, borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '11px 14px' }}>
                          <code style={{ background: '#f3f4f6', padding: '3px 8px', borderRadius: 5, fontSize: 12, fontWeight: 700, color: '#374151' }}>{p.codigo}</code>
                        </td>
                        <td style={{ padding: '11px 14px' }}>
                          <div style={{ fontWeight: 700, fontSize: 13, color: '#111' }}>{p.nombre}</div>
                          {p.tipo === 'compuesto' && p.componentes?.length > 0 && (
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                              {p.componentes.slice(0, 2).map((c, i) => `${c.cantidad}× ${c.nombre}`).join(', ')}
                              {p.componentes.length > 2 && ` +${p.componentes.length - 2} más`}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '11px 14px' }}>
                          <span style={{ background: p.tipo === 'compuesto' ? '#ede9fe' : p.tipo === 'servicio' ? '#dbeafe' : '#f3f4f6', color: p.tipo === 'compuesto' ? '#7c3aed' : p.tipo === 'servicio' ? '#1d4ed8' : '#374151', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                            {tipo.emoji} {tipo.label}
                          </span>
                        </td>
                        <td style={{ padding: '11px 14px', fontSize: 13, color: '#6b7280' }}>{p.categoria || '—'}</td>
                        {isAdmin && <td style={{ padding: '11px 14px', fontSize: 13, color: '#dc2626', fontWeight: 600 }}>{p.precioCosto > 0 ? formatCOP(p.precioCosto) : '—'}</td>}
                        <td style={{ padding: '11px 14px', fontSize: 14, color: '#16a34a', fontWeight: 800 }}>{formatCOP(p.precioVenta)}</td>
                        {isAdmin && <td style={{ padding: '11px 14px', fontSize: 13, color: '#7c3aed', fontWeight: 600 }}>{p.margen > 0 ? `${p.margen}%` : '—'}</td>}
                        {isAdmin && <td style={{ padding: '11px 14px' }}>
                          {p.tieneStock ? (
                            <span style={{ background: stockBajo ? '#fef2f2' : '#f0fdf4', color: stockBajo ? '#dc2626' : '#16a34a', padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                              {stockBajo ? '⚠️ ' : ''}{p.stock}
                            </span>
                          ) : <span style={{ color: '#d1d5db' }}>—</span>}
                        </td>}
                        {isAdmin && <td style={{ padding: '11px 14px' }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => abrirEditar(p)} style={{ padding: '5px 12px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>✏️ Editar</button>
                            <button onClick={() => eliminarProducto(p.id, p.nombre)} style={{ padding: '5px 10px', background: '#fef2f2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>🗑️</button>
                          </div>
                        </td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ════════════════════════════════════════════
          MODAL FORMULARIO
      ════════════════════════════════════════════ */}
      {mostrarForm && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalHeader}>
              <h3 style={s.modalTitulo}>{editandoId ? '✏️ Editar Producto' : '➕ Nuevo Producto'}</h3>
              <button onClick={() => setMostrarForm(false)} style={s.btnCerrar}>✕</button>
            </div>

            {error && <div style={{ ...s.alertError, margin: '0 24px 0' }}>{error}</div>}
            {exito && <div style={{ ...s.alertExito, margin: '0 24px 0' }}>{exito}</div>}

            <div style={s.modalBody}>

              {/* Tipo */}
              <div style={s.campo}>
                <label style={s.label}>Tipo de producto *</label>
                <div style={s.tiposGrid}>
                  {TIPOS.map(t => (
                    <button key={t.value} type="button"
                      onClick={() => setForm(p => ({ ...p, tipo: t.value }))}
                      style={{
                        ...s.tipoBtn,
                        background: form.tipo === t.value ? '#7c3aed' : '#f9fafb',
                        color: form.tipo === t.value ? '#fff' : '#374151',
                        border: form.tipo === t.value ? '2px solid #7c3aed' : '2px solid #e5e7eb'
                      }}
                    >
                      <span style={{ fontSize: '20px' }}>{t.emoji}</span>
                      <span style={{ fontSize: '12px', fontWeight: 700 }}>{t.label}</span>
                      <span style={{ fontSize: '10px', opacity: 0.8 }}>{t.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Categoría + Nombre */}
              <div style={s.fila2}>
                <div style={s.campo}>
                  <label style={s.label}>Categoría *</label>
                  <select style={s.input} value={form.categoriaId}
                    onChange={e => {
                      const cat = categorias.find(c => c.id === e.target.value);
                      setForm(p => ({ ...p, categoriaId: e.target.value, categoriaNombre: cat?.nombre || '', categoriaPrefijo: cat?.prefijo || '' }));
                    }}>
                    <option value="">Seleccionar...</option>
                    {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </div>
                <div style={s.campo}>
                  <label style={s.label}>Código <span style={s.hint}>(auto si vacío)</span></label>
                  <input style={s.input} placeholder={form.categoriaPrefijo ? `${form.categoriaPrefijo}-001` : 'Auto'}
                    value={form.codigo}
                    onChange={e => setForm(p => ({ ...p, codigo: e.target.value.toUpperCase() }))} />
                </div>
              </div>

              {/* Nombre */}
              <div style={s.campo}>
                <label style={s.label}>Nombre *</label>
                <input style={s.input} placeholder="Nombre del producto o servicio"
                  value={form.nombre}
                  onChange={e => setForm(p => ({ ...p, nombre: e.target.value.toUpperCase() }))} />
              </div>

              {/* Precios */}
              <div style={s.fila2}>
                {isAdmin && (
                  <div style={s.campo}>
                    <label style={s.label}>Precio costo</label>
                    <input style={s.input} type="number" placeholder="0"
                      value={form.precioCosto}
                      onChange={e => setForm(p => ({ ...p, precioCosto: e.target.value }))}
                      disabled={form.tipo === 'compuesto'}
                    />
                    {form.tipo === 'compuesto' && <small style={s.hint2}>Se calcula automáticamente de los componentes</small>}
                  </div>
                )}
                <div style={s.campo}>
                  <label style={s.label}>Precio venta *</label>
                  <input style={s.input} type="number" placeholder="0"
                    value={form.precioVenta}
                    onChange={e => setForm(p => ({ ...p, precioVenta: e.target.value }))} />
                </div>
              </div>

              {/* Margen compuesto */}
              {form.tipo === 'compuesto' && isAdmin && (
                <div style={s.margenBox}>
                  <span>💰 Costo total componentes: <strong>{formatCOP(costoCompuesto)}</strong></span>
                  <span>📈 Margen: <strong style={{ color: margenCalculado < 0 ? '#dc2626' : '#16a34a' }}>{margenCalculado}%</strong></span>
                </div>
              )}

              {/* Stock */}
              {form.tipo !== 'servicio' && form.tipo !== 'combo' && (
                <div style={s.fila2}>
                  <div style={s.campo}>
                    <label style={s.label}>Stock actual</label>
                    <input style={s.input} type="number" placeholder="0"
                      value={form.stock}
                      onChange={e => setForm(p => ({ ...p, stock: e.target.value }))} />
                  </div>
                  <div style={s.campo}>
                    <label style={s.label}>Stock mínimo <span style={s.hint}>(alerta)</span></label>
                    <input style={s.input} type="number" placeholder="0"
                      value={form.stockMinimo}
                      onChange={e => setForm(p => ({ ...p, stockMinimo: e.target.value }))} />
                  </div>
                </div>
              )}

              {/* Componentes del compuesto */}
              {form.tipo === 'compuesto' && (
                <div style={s.campo}>
                  <label style={s.label}>Componentes * <span style={s.hint}>(busca y agrega)</span></label>
                  <select style={s.input} onChange={e => {
                    const prod = productos.find(p => p.id === e.target.value);
                    if (prod) agregarComponente(prod);
                    e.target.value = '';
                  }}>
                    <option value="">+ Agregar componente...</option>
                    {productos.filter(p => p.tipo !== 'compuesto' && p.tipo !== 'combo' && p.activo !== false).map(p => (
                      <option key={p.id} value={p.id}>{p.codigo} — {p.nombre}</option>
                    ))}
                  </select>

                  {form.componentes.length > 0 && (
                    <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {form.componentes.map((comp, idx) => (
                        <div key={idx} style={s.compRow}>
                          <span style={{ flex: 1, fontSize: '13px' }}>{comp.nombre}</span>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <span style={s.hint}>Cant:</span>
                            <input type="number" min="1" value={comp.cantidad} style={{ ...s.input, width: '60px', padding: '6px' }}
                              onChange={e => editarComponente(idx, 'cantidad', e.target.value)} />
                            {isAdmin && (
                              <>
                                <span style={s.hint}>Costo:</span>
                                <input type="number" value={comp.costo} style={{ ...s.input, width: '90px', padding: '6px' }}
                                  onChange={e => editarComponente(idx, 'costo', e.target.value)} />
                              </>
                            )}
                            <button onClick={() => eliminarComponente(idx)} style={s.btnEliminar}>✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Descripción */}
              <div style={s.campo}>
                <label style={s.label}>Descripción</label>
                <textarea style={{ ...s.input, height: '80px', resize: 'vertical' }}
                  placeholder="Descripción opcional del producto..."
                  value={form.descripcion}
                  onChange={e => setForm(p => ({ ...p, descripcion: e.target.value }))} />
              </div>
            </div>

            <div style={s.modalFooter}>
              <button onClick={() => setMostrarForm(false)} style={s.btnCancelar}>Cancelar</button>
              <button onClick={guardar} disabled={guardando} style={s.btnGuardar}>
                {guardando ? 'Guardando...' : editandoId ? '💾 Guardar cambios' : '✅ Crear producto'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* VISTA: IMPORTAR */}
      {vista === 'importar' && isAdmin && (
        <div style={s.card}>
          <h3 style={s.cardTitulo}>📥 Importar Productos desde CSV</h3>
          <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '20px' }}>
            Descarga la plantilla, completa tus productos en la hoja "MIS PRODUCTOS" y sube el archivo exportado como CSV.
          </p>

          {/* Paso 1: Descargar plantilla */}
          <div style={{ background: '#ede9fe', borderRadius: '10px', padding: '16px', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong style={{ color: '#7c3aed' }}>Paso 1 — Descarga la plantilla Excel</strong>
              <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#6b7280' }}>Plantilla con instrucciones, ejemplos y validaciones incluidas</p>
            </div>
            <a href="/plantilla_productos.xlsx" download="plantilla_productos_control360.xlsx" style={{ ...s.btnPrimario, textDecoration: 'none' }}>
              ⬇️ Descargar plantilla
            </a>
          </div>

          {/* Paso 2: Subir CSV */}
          <div style={{ background: '#f9fafb', border: '2px dashed #e5e7eb', borderRadius: '10px', padding: '24px', marginBottom: '16px', textAlign: 'center' }}>
            <p style={{ margin: '0 0 12px', fontWeight: 700, color: '#374151' }}>Paso 2 — Sube tu archivo CSV</p>
            <p style={{ margin: '0 0 16px', fontSize: '12px', color: '#9ca3af' }}>
              En Excel: Archivo → Guardar como → CSV UTF-8
            </p>
            <input type="file" accept=".csv,.xlsx" id="fileImport" style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files[0];
                if (!file) return;
                setPrevistaImport([]);
                setResultadoImport(null);
                const reader = new FileReader();
                reader.onload = ev => {
                  const text = ev.target.result;
                  const lineas = text.split(/\r?\n/).filter(l => l.trim());
                  if (lineas.length < 2) return;

                  // Detectar separador automáticamente (coma o punto y coma)
                  const separador = lineas[0].includes(';') ? ';' : ',';

                  // Limpiar encabezados: quitar BOM, *, espacios extras y comillas
                  const hdrs = lineas[0].split(separador).map(h =>
                    h.replace(/^\uFEFF/, '') // quitar BOM
                     .replace(/"/g, '')
                     .replace(/\*/g, '')     // quitar asteriscos
                     .trim()
                  );

                  const datos = lineas.slice(1).map(linea => {
                    const vals = [];
                    let inside = false, cur = '';
                    for (let ch of linea + separador) {
                      if (ch === '"') { inside = !inside; }
                      else if (ch === separador && !inside) { vals.push(cur.trim()); cur = ''; }
                      else { cur += ch; }
                    }
                    const obj = {};
                    hdrs.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
                    return obj;
                  }).filter(d => d.Nombre && d.Nombre.trim());
                  setPrevistaImport(datos);
                };
                reader.readAsText(file, 'UTF-8');
              }}
            />
            <label htmlFor="fileImport" style={{ ...s.btnPrimario, cursor: 'pointer', display: 'inline-block' }}>
              📂 Seleccionar archivo CSV
            </label>
          </div>

          {/* Vista previa */}
          {previstaImport.length > 0 && !resultadoImport && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h4 style={{ margin: 0, color: '#374151' }}>
                  Vista previa — {previstaImport.length} productos
                  {previstaImport.filter(p => p.Tipo === 'compuesto').length > 0 && (
                    <span style={{ marginLeft: '12px', background: '#fef3c7', color: '#92400e', padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600 }}>
                      ⚠️ {previstaImport.filter(p => p.Tipo === 'compuesto').length} compuestos requieren configuración
                    </span>
                  )}
                </h4>
                <button onClick={async () => {
                  setImportando(true);
                  try {
                    const res = await (await import('axios')).default.post(`${API}/products/importar`, { productos: previstaImport }, { headers });
                    setResultadoImport(res.data);
                    await cargarProductos();
                  } catch(e) { setError(e.response?.data?.error || 'Error al importar'); }
                  setImportando(false);
                }} disabled={importando} style={s.btnGuardar}>
                  {importando ? 'Importando...' : `✅ Importar ${previstaImport.length} productos`}
                </button>
              </div>
              <div style={{ overflowX: 'auto', maxHeight: '300px', overflowY: 'auto' }}>
                <table style={s.tabla}>
                  <thead>
                    <tr style={{ background: '#f9fafb', position: 'sticky', top: 0 }}>
                      {['Código', 'Nombre', 'Categoría', 'Tipo', 'Precio Venta', 'Stock'].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previstaImport.map((p, i) => (
                      <tr key={i} style={{ background: p.Tipo === 'compuesto' ? '#fffbeb' : i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                        <td style={s.td}><code style={s.codigo}>{p.Codigo || 'Auto'}</code></td>
                        <td style={{ ...s.td, fontWeight: 600 }}>{p.Nombre}</td>
                        <td style={s.td}>{p.Categoria}</td>
                        <td style={s.td}>
                          <span style={{ background: p.Tipo === 'compuesto' ? '#fef3c7' : '#f3f4f6', color: p.Tipo === 'compuesto' ? '#92400e' : '#374151', padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 600 }}>
                            {p.Tipo === 'compuesto' ? '⚠️ ' : ''}{p.Tipo}
                          </span>
                        </td>
                        <td style={{ ...s.td, color: '#16a34a', fontWeight: 700 }}>
                          {p.PrecioVenta ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(p.PrecioVenta) : '—'}
                        </td>
                        <td style={s.td}>{p.Stock || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Resultado importación */}
          {resultadoImport && (
            <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '10px', padding: '20px' }}>
              <h4 style={{ margin: '0 0 12px', color: '#16a34a' }}>✅ Importación completada</h4>
              <div style={{ display: 'flex', gap: '24px', fontSize: '14px' }}>
                <div><strong style={{ fontSize: '24px', color: '#16a34a' }}>{resultadoImport.creados}</strong><br/><span style={{ color: '#6b7280' }}>Productos creados</span></div>
                {resultadoImport.errores?.length > 0 && (
                  <div><strong style={{ fontSize: '24px', color: '#dc2626' }}>{resultadoImport.errores.length}</strong><br/><span style={{ color: '#6b7280' }}>Con errores</span></div>
                )}
              </div>
              {previstaImport.filter(p => p.Tipo === 'compuesto').length > 0 && (
                <div style={{ marginTop: '12px', padding: '12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px', fontSize: '13px', color: '#92400e' }}>
                  ⚠️ <strong>{previstaImport.filter(p => p.Tipo === 'compuesto').length} productos compuestos</strong> fueron creados como incompletos. 
                  Búscalos en la lista (marcados en amarillo) y asocia sus componentes.
                </div>
              )}
              <button onClick={() => { setResultadoImport(null); setPrevistaImport([]); setVista('productos'); }} style={{ ...s.btnPrimario, marginTop: '16px' }}>
                Ver lista de productos
              </button>
            </div>
          )}
        </div>
      )}

      {/* VISTA: EXPORTAR */}
      {vista === 'exportar' && isAdmin && (
        <div style={s.card}>
          <h3 style={s.cardTitulo}>📤 Exportar Productos</h3>
          <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '24px' }}>
            Descarga tu catálogo completo de productos en formato CSV. Puedes abrirlo en Excel para editarlo y volver a importarlo.
          </p>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            <button onClick={async () => {
              try {
                const axiosLib = (await import('axios')).default;
                const res = await axiosLib.get(API + '/products/exportar/excel', { headers });
                const prods = res.data.productos || [];
                if (!prods.length) { setError('No hay productos para exportar'); return; }
                const cols = ['Codigo','Nombre','Categoria','Tipo','PrecioCosto','PrecioVenta','Stock','StockMinimo','Activo'];
                const nl = String.fromCharCode(10);
                const filas = prods.map(function(p) {
                  return cols.map(function(c) { return '"' + String(p[c] == null ? '' : p[c]).replace(/"/g, '""') + '"'; }).join(',');
                });
                const csv = [cols.join(',')].concat(filas).join(nl);
                const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'productos_' + new Date().toISOString().split('T')[0] + '.csv';
                a.click();
                URL.revokeObjectURL(url);
                setExito(prods.length + ' productos exportados');
                setTimeout(function() { setExito(''); }, 3000);
              } catch { setError('Error al exportar'); }
            }} style={s.btnPrimario}>
              📥 Descargar CSV completo ({productos.length} productos)
            </button>
          </div>
          <div style={{ marginTop: '20px', padding: '16px', background: '#f9fafb', borderRadius: '8px', fontSize: '13px', color: '#6b7280' }}>
            <strong>Tip:</strong> Para reimportar productos editados, abre el CSV en Excel, haz tus cambios y guárdalo como "CSV UTF-8". Luego usa la opción Importar.
          </div>
        </div>
      )}

      {/* MODAL COMPUESTOS AFECTADOS */}
      {mostrarAlertaCompuestos && compuestosAfectados.length > 0 && (
        <div style={s.overlay}>
          <div style={{ ...s.modal, maxWidth: '600px' }}>
            <div style={s.modalHeader}>
              <h3 style={{ ...s.modalTitulo, color: '#d97706' }}>⚠️ Compuestos afectados por el cambio</h3>
              <button onClick={() => setMostrarAlertaCompuestos(false)} style={s.btnCerrar}>✕</button>
            </div>
            <div style={s.modalBody}>
              <p style={{ color: '#6b7280', fontSize: '14px', margin: '0 0 16px' }}>
                El costo de los siguientes productos compuestos fue actualizado automáticamente.
                Revisa si necesitas ajustar el precio de venta:
              </p>
              {compuestosAfectados.map((c, i) => (
                <div key={i} style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px', padding: '14px 16px', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <strong style={{ color: '#111' }}>{c.nombre}</strong>
                    <code style={s.codigoBadge}>{c.codigo}</code>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', fontSize: '13px' }}>
                    <div><span style={{ color: '#9ca3af' }}>Costo anterior</span><br/><strong>{formatCOP(c.costoAnterior)}</strong></div>
                    <div><span style={{ color: '#9ca3af' }}>Costo nuevo</span><br/><strong style={{ color: '#dc2626' }}>{formatCOP(c.costoNuevo)}</strong></div>
                    <div><span style={{ color: '#9ca3af' }}>Precio venta</span><br/><strong style={{ color: '#16a34a' }}>{formatCOP(c.precioVenta)}</strong></div>
                  </div>
                  <div style={{ marginTop: '8px', display: 'flex', gap: '16px', fontSize: '13px' }}>
                    <span>Margen anterior: <strong>{c.margenAnterior}%</strong></span>
                    <span>Margen nuevo: <strong style={{ color: c.margenNuevo < 20 ? '#dc2626' : '#16a34a' }}>{c.margenNuevo}%</strong></span>
                  </div>
                </div>
              ))}
            </div>
            <div style={s.modalFooter}>
              <button onClick={() => { setMostrarAlertaCompuestos(false); setCompuestosAfectados([]); }} style={s.btnCancelar}>Cerrar</button>
              <button onClick={() => { setMostrarAlertaCompuestos(false); setCompuestosAfectados([]); setVista('productos'); cargarProductos(); }} style={s.btnGuardar}>✅ Entendido, revisar precios</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── ESTILOS ──────────────────────────────────────────────────────────────────
const s = {
  wrapper:      { padding: '32px', maxWidth: '1400px', margin: '0 auto', fontFamily: "'Segoe UI', sans-serif" },
  pageHeader:   { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' },
  pageTitle:    { margin: 0, fontSize: '26px', fontWeight: 700, color: '#111' },
  pageSubtitle: { margin: '4px 0 0', color: '#6b7280', fontSize: '14px' },
  headerBtns:   { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  btnPrimario:  { padding: '12px 24px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' },
  btnSecundario:{ padding: '10px 18px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' },
  btnActivo:    { padding: '10px 18px', background: '#ede9fe', color: '#7c3aed', border: '2px solid #7c3aed', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnGuardar:   { padding: '10px 28px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' },
  btnCancelar:  { padding: '10px 24px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 },
  btnEditar:    { flex: 1, padding: '8px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnEliminar:  { padding: '6px 10px', background: '#fef2f2', color: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' },
  btnIcono:     { padding: '6px 10px', background: '#f3f4f6', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' },

  alertError:   { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' },
  alertExito:   { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' },

  dosColumnas:  { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' },
  card:         { background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', padding: '24px', marginBottom: '0' },
  cardTitulo:   { margin: '0 0 20px', fontSize: '17px', fontWeight: 700, color: '#111' },
  cardColorBar: { height: '4px', width: '100%' },
  catItem:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #f3f4f6' },

  filtros:      { display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' },
  searchWrap:   { display: 'flex', alignItems: 'center', flex: 1, minWidth: '250px', background: '#fff', border: '2px solid #e5e7eb', borderRadius: '8px', padding: '0 12px' },
  searchInput:  { flex: 1, border: 'none', outline: 'none', fontSize: '14px', padding: '10px 8px', background: 'transparent' },
  clearBtn:     { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' },
  select:       { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', background: '#fff', cursor: 'pointer' },
  contador:     { color: '#9ca3af', fontSize: '13px', marginBottom: '16px' },
  loadingBox:   { textAlign: 'center', padding: '60px', color: '#9ca3af' },
  emptyBox:     { textAlign: 'center', padding: '60px', color: '#9ca3af', background: '#fff', borderRadius: '12px' },

  grid:         { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px' },
  codigoBadge:  { background: '#f3f4f6', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, marginRight: '8px', fontFamily: 'monospace' },
  tipoBadge:    { padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600 },
  stockBadge:   { padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700 },
  prodNombre:   { margin: '8px 0 4px', fontSize: '15px', fontWeight: 700, color: '#111' },
  prodCategoria:{ margin: '0 0 10px', fontSize: '12px', color: '#9ca3af' },
  componentesPreview: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '10px' },
  compChip:     { background: '#ede9fe', color: '#7c3aed', padding: '2px 8px', borderRadius: '4px', fontSize: '11px' },
  precios:      { display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 0', borderTop: '1px solid #f3f4f6' },
  precioItem:   { display: 'flex', justifyContent: 'space-between', fontSize: '13px' },
  precioLabel:  { color: '#9ca3af' },
  cardAcciones: { marginTop: '12px', display: 'flex', gap: '8px' },

  overlay:      { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' },
  modal:        { background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '820px', maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  modalHeader:  { padding: '20px 24px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 },
  modalTitulo:  { margin: 0, fontSize: '18px', fontWeight: 700 },
  btnCerrar:    { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', fontSize: '16px' },
  modalBody:    { padding: '20px 24px', overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' },
  modalFooter:  { padding: '14px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: '12px', flexShrink: 0 },

  fila2:        { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  campo:        { display: 'flex', flexDirection: 'column', gap: '6px' },
  label:        { fontSize: '13px', fontWeight: 700, color: '#374151' },
  hint:         { fontSize: '11px', color: '#9ca3af', fontWeight: 400 },
  hint2:        { fontSize: '11px', color: '#9ca3af', marginTop: '2px' },
  input:        { padding: '10px 14px', border: '2px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', outline: 'none', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' },

  tiposGrid:    { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px' },
  tipoBtn:      { padding: '12px 8px', borderRadius: '10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', transition: 'all 0.15s', textAlign: 'center' },

  margenBox:    { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', fontSize: '14px' },
  compRow:      { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  codigo:       { fontFamily: 'monospace', background: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' },

  ajusteForm:   { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '16px', alignItems: 'end', marginBottom: '20px' },
  pctWrap:      { position: 'relative' },
  pctSymbol:    { position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)', fontWeight: 700, color: '#7c3aed', fontSize: '18px' },
  tabla:        { width: '100%', borderCollapse: 'collapse' },
  th:           { background: '#f9fafb', padding: '10px 14px', textAlign: 'left', fontSize: '12px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' },
  td:           { padding: '10px 14px', fontSize: '13px', color: '#374151', borderBottom: '1px solid #f3f4f6' },
};

export default GestionProductos;
