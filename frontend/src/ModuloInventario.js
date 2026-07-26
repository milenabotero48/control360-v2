// ============================================================================
// Control360 — Módulo Inventario (Kardex · Conteo físico · Rotación)
// Ubicación: src/components/ModuloInventario.js
// FIX INV-KARDEX-003
// ----------------------------------------------------------------------------
// Se monta como una sección DENTRO de Productos, no como módulo suelto del menú.
// Vive en archivo propio y no dentro de GestionProductos.js: ese archivo ya tiene
// 1.347 líneas y absorber esta UI lo llevaría a más de 2.200. Un componente
// autónomo se prueba, se lee y se reemplaza sin tocar el catálogo de productos.
//
// GATING
// Todos los endpoints van detrás de requireModuloPremium('inventario_pro'). Si el
// tenant no lo tiene, el backend responde 403 con error MODULO_NO_ACTIVO y aquí
// se muestra la pantalla de módulo no disponible en vez de un error crudo.
//
// PERMISOS
// Rotación, conteo y ajustes son solo de admin: el backend ya lo impone, y aquí
// esas pestañas no se dibujan para otros roles. Un comercial ve el Kardex sin
// costos ni valorizaciones (el backend los recorta antes de enviarlos).
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const formatCOP = (v) => {
  const n = Number(v) || 0;
  return '$' + n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
};

const formatFecha = (iso) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: '2-digit' }) +
           ' ' + d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
};

// Primer día del mes en curso y hoy, en formato YYYY-MM-DD.
const hoyISO = () => new Date().toISOString().slice(0, 10);
const inicioMesISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

// Color por naturaleza del movimiento: entra verde, sale rojo, ajuste ámbar.
// Es la lectura más rápida posible de una tabla de kardex.
const colorMovimiento = (tipo, cantidad) => {
  if (String(tipo).startsWith('AJUSTE')) return '#d97706';
  return (Number(cantidad) || 0) > 0 ? '#16a34a' : '#dc2626';
};

const TIPOS_FILTRO = [
  { v: '', l: 'Todos los movimientos' },
  { v: 'ENTRADA_COMPRA', l: 'Entradas por compra' },
  { v: 'SALIDA_VENTA', l: 'Salidas por venta' },
  { v: 'CONSUMO_COMPUESTO', l: 'Consumo como componente' },
  { v: 'DEVOLUCION_ANULACION', l: 'Devoluciones por anulación' },
  { v: 'ENTRADA_PRODUCCION', l: 'Entradas por producción' },
  { v: 'CONSUMO_PRODUCCION', l: 'Consumo en producción' },
  { v: 'AJUSTE_CONTEO', l: 'Ajustes por conteo' },
  { v: 'ENTRADA_AJUSTE', l: 'Ajustes — entrada' },
  { v: 'SALIDA_AJUSTE', l: 'Ajustes — salida' },
  { v: 'SALIDA_DEVOLUCION_PROVEEDOR', l: 'Devoluciones a proveedor' },
  { v: 'AJUSTE_HISTORICO_NO_TRAZADO', l: 'Diferencias históricas' }
];

const descargarCSV = (filas, nombre) => {
  if (!filas.length) return;
  const cols = Object.keys(filas[0]);
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    cols.join(','),
    ...filas.map(f => cols.map(c => escapar(f[c])).join(','))
  ].join('\n');
  // BOM para que Excel en español respete los acentos.
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nombre}_${hoyISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

const ModuloInventario = ({ user, productos = [], categorias = [], onStockCambiado }) => {
  const isAdmin = user?.role === 'admin';

  const [tab, setTab]           = useState('kardex');   // kardex | conteo | rotacion
  const [sinModulo, setSinModulo] = useState(false);
  const [error, setError]       = useState('');
  const [exito, setExito]       = useState('');

  const [desde, setDesde] = useState(inicioMesISO());
  const [hasta, setHasta] = useState(hoyISO());

  const [resumen, setResumen]         = useState(null);
  const [cargandoResumen, setCargandoResumen] = useState(true);

  // Kardex
  const [productoSel, setProductoSel] = useState(null);
  const [buscar, setBuscar]           = useState('');
  const [filtroTipo, setFiltroTipo]   = useState('');
  const [kardex, setKardex]           = useState(null);
  const [cargandoKardex, setCargandoKardex] = useState(false);

  // Ajuste
  const [modalAjuste, setModalAjuste] = useState(null);
  const [ajusteCant, setAjusteCant]   = useState('');
  const [ajusteMotivo, setAjusteMotivo] = useState('');
  const [ajustando, setAjustando]     = useState(false);

  // Conteo
  const [catConteo, setCatConteo]     = useState('');
  const [conteos, setConteos]         = useState({});
  const [previewConteo, setPreviewConteo] = useState(null);
  const [aplicandoConteo, setAplicandoConteo] = useState(false);

  // Rotación
  const [rotacion, setRotacion]       = useState(null);
  const [cargandoRot, setCargandoRot] = useState(false);

  // Reconstrucción
  const [estadoRecon, setEstadoRecon] = useState(null);
  const [informeRecon, setInformeRecon] = useState(null);
  const [reconstruyendo, setReconstruyendo] = useState(false);

  const token = localStorage.getItem('token');
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // Un 403 con MODULO_NO_ACTIVO no es un error del usuario: es una pantalla
  // distinta. Se separa aquí para no mostrar un mensaje rojo por algo que
  // simplemente no está contratado.
  const manejarError = useCallback((e, fallback) => {
    if (e?.response?.status === 403 && e?.response?.data?.error === 'MODULO_NO_ACTIVO') {
      setSinModulo(true);
      return;
    }
    setError(e?.response?.data?.error || fallback);
  }, []);

  const cargarResumen = useCallback(async () => {
    setCargandoResumen(true);
    try {
      const { data } = await axios.get(`${API}/inventario/resumen`, {
        headers, params: { desde, hasta }
      });
      setResumen(data);
      setSinModulo(false);
    } catch (e) {
      manejarError(e, 'No se pudo cargar el resumen de inventario');
    } finally {
      setCargandoResumen(false);
    }
  }, [headers, desde, hasta, manejarError]);

  const cargarEstadoRecon = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const { data } = await axios.get(`${API}/inventario/reconstruir/estado`, { headers });
      setEstadoRecon(data);
    } catch { /* si falla, simplemente no se muestra el banner */ }
  }, [headers, isAdmin]);

  useEffect(() => { cargarResumen(); }, [cargarResumen]);
  useEffect(() => { cargarEstadoRecon(); }, [cargarEstadoRecon]);

  // ─── KARDEX ───────────────────────────────────────────────────────────────
  const abrirKardex = async (prod) => {
    setProductoSel(prod);
    setKardex(null);
    setCargandoKardex(true);
    setError('');
    try {
      const { data } = await axios.get(`${API}/inventario/kardex/${prod.id}`, {
        headers, params: { desde, hasta }
      });
      setKardex(data);
    } catch (e) {
      manejarError(e, 'No se pudo cargar el kardex de este producto');
    } finally {
      setCargandoKardex(false);
    }
  };

  const movimientosFiltrados = useMemo(() => {
    if (!kardex) return [];
    if (!filtroTipo) return kardex.movimientos;
    return kardex.movimientos.filter(m => m.tipo === filtroTipo);
  }, [kardex, filtroTipo]);

  const exportarKardex = () => {
    if (!kardex) return;
    descargarCSV(movimientosFiltrados.map(m => ({
      Fecha: formatFecha(m.fecha),
      Movimiento: m.tipoLabel,
      Cantidad: m.cantidad,
      Saldo: m.saldo,
      Documento: m.origenNumero || '',
      Cliente: m.clienteNombre || '',
      Proveedor: m.proveedorNombre || '',
      Usuario: m.usuarioNombre || '',
      Motivo: m.motivo || ''
    })), `kardex_${kardex.producto.codigo || kardex.producto.nombre}`);
  };

  // ─── AJUSTE ───────────────────────────────────────────────────────────────
  const aplicarAjuste = async () => {
    const cant = Number(ajusteCant);
    if (!cant) { setError('La cantidad debe ser distinta de cero'); return; }
    if (!ajusteMotivo || ajusteMotivo.trim().length < 5) {
      setError('Escribe el motivo del ajuste (mínimo 5 caracteres)');
      return;
    }
    setAjustando(true);
    setError('');
    try {
      await axios.post(`${API}/inventario/ajuste`, {
        productoId: modalAjuste.id,
        cantidad: cant,
        motivo: ajusteMotivo.trim()
      }, { headers });
      setExito(`Stock ajustado. El movimiento quedó registrado en el Kardex.`);
      setModalAjuste(null);
      setAjusteCant('');
      setAjusteMotivo('');
      cargarResumen();
      if (onStockCambiado) onStockCambiado();
      if (productoSel?.id === modalAjuste.id) abrirKardex(productoSel);
    } catch (e) {
      manejarError(e, 'No se pudo aplicar el ajuste');
    } finally {
      setAjustando(false);
    }
  };

  // ─── CONTEO ───────────────────────────────────────────────────────────────
  const productosConteo = useMemo(() => {
    return productos.filter(p =>
      p.tipo !== 'servicio' && p.tieneStock !== false && p.activo !== false &&
      (!catConteo || p.categoria === catConteo)
    );
  }, [productos, catConteo]);

  const verPreviewConteo = async () => {
    const lista = Object.entries(conteos)
      .filter(([, v]) => v !== '' && v !== null && !isNaN(Number(v)))
      .map(([productoId, contado]) => ({ productoId, contado: Number(contado) }));

    if (!lista.length) { setError('Escribe al menos una cantidad contada'); return; }
    setError('');
    try {
      const { data } = await axios.post(`${API}/inventario/conteo/preview`, { conteos: lista }, { headers });
      setPreviewConteo(data);
    } catch (e) {
      manejarError(e, 'No se pudo calcular el conteo');
    }
  };

  const aplicarConteo = async () => {
    const lista = previewConteo.filas
      .filter(f => f.diferencia !== 0)
      .map(f => ({ productoId: f.productoId, contado: f.contado }));

    setAplicandoConteo(true);
    setError('');
    try {
      const { data } = await axios.post(`${API}/inventario/conteo/aplicar`, {
        conteos: lista,
        motivo: `Conteo físico ${hoyISO()}`
      }, { headers });
      setExito(`${data.ajustesAplicados} ajuste(s) aplicados. Cada uno quedó registrado en el Kardex.`);
      setPreviewConteo(null);
      setConteos({});
      cargarResumen();
      if (onStockCambiado) onStockCambiado();
    } catch (e) {
      manejarError(e, 'No se pudo aplicar el conteo');
    } finally {
      setAplicandoConteo(false);
    }
  };

  // ─── ROTACIÓN ─────────────────────────────────────────────────────────────
  const cargarRotacion = useCallback(async () => {
    setCargandoRot(true);
    setError('');
    try {
      const { data } = await axios.get(`${API}/inventario/rotacion`, {
        headers, params: { desde, hasta }
      });
      setRotacion(data);
    } catch (e) {
      manejarError(e, 'No se pudo calcular la rotación');
    } finally {
      setCargandoRot(false);
    }
  }, [headers, desde, hasta, manejarError]);

  useEffect(() => {
    if (tab === 'rotacion' && isAdmin) cargarRotacion();
  }, [tab, isAdmin, cargarRotacion]);

  // ─── RECONSTRUCCIÓN ───────────────────────────────────────────────────────
  const reconstruir = async (confirmar) => {
    setReconstruyendo(true);
    setError('');
    try {
      const { data } = await axios.post(`${API}/inventario/reconstruir`, { confirmar }, { headers });
      setInformeRecon(data);
      if (confirmar) {
        setExito(`Histórico reconstruido: ${data.escritos} movimientos registrados.`);
        cargarEstadoRecon();
        cargarResumen();
      }
    } catch (e) {
      manejarError(e, 'No se pudo reconstruir el histórico');
    } finally {
      setReconstruyendo(false);
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // MÓDULO NO CONTRATADO
  // ══════════════════════════════════════════════════════════════════════════
  if (sinModulo) {
    return (
      <div style={st.vacio}>
        <div style={{ fontSize: 46, marginBottom: 14 }}>📊</div>
        <h3 style={st.vacioTitulo}>Inventario Inteligente no está activo</h3>
        <p style={st.vacioTexto}>
          Kardex por producto, conteo físico y análisis de rotación. Contacta a Control360
          para activarlo en tu plan.
        </p>
      </div>
    );
  }

  const productosBuscados = productos.filter(p => {
    if (p.tipo === 'servicio' || p.tieneStock === false) return false;
    if (!buscar) return true;
    const q = buscar.toUpperCase();
    return (p.nombre || '').toUpperCase().includes(q) ||
           (p.codigo || '').toUpperCase().includes(q);
  });

  return (
    <div>
      {error && <div style={st.alertError}>{error}</div>}
      {exito && <div style={st.alertExito}>{exito}</div>}

      {/* ─── BANNER DE RECONSTRUCCIÓN ─── */}
      {isAdmin && estadoRecon && !estadoRecon.reconstruido && (
        <div style={st.bannerRecon}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <strong style={{ display: 'block', marginBottom: 4 }}>Tu histórico todavía no está reconstruido</strong>
            <span style={{ fontSize: 13, color: '#78350f' }}>
              El Kardex registra desde hoy. Puedes reconstruir el pasado a partir de tus órdenes
              y compras para tener trazabilidad hacia atrás. Primero verás un informe: no se escribe nada.
            </span>
          </div>
          <button style={st.btnAmbar} disabled={reconstruyendo} onClick={() => reconstruir(false)}>
            {reconstruyendo ? 'Analizando…' : 'Ver informe'}
          </button>
        </div>
      )}

      {/* ─── INFORME DE RECONSTRUCCIÓN ─── */}
      {informeRecon && (
        <div style={st.card}>
          <h3 style={st.cardTitulo}>
            {informeRecon.dryRun ? 'Informe de reconstrucción (nada se ha escrito)' : 'Reconstrucción aplicada'}
          </h3>
          <div style={st.kpiGrid}>
            <Kpi label="Órdenes leídas" valor={informeRecon.ordenesLeidas} />
            <Kpi label="Compras leídas" valor={informeRecon.comprasLeidas} />
            <Kpi label="Movimientos a generar" valor={informeRecon.movimientosGenerados} />
            <Kpi label="Productos con diferencia" valor={informeRecon.productosConDiferencia} tono="alerta" />
            <Kpi label="Valor de las diferencias" valor={formatCOP(informeRecon.valorTotalDiferencias)} tono="alerta" />
          </div>

          {informeRecon.diferencias?.length > 0 && (
            <>
              <p style={st.notaGris}>
                Estas diferencias son movimientos que ocurrieron sin quedar registrados: ediciones
                manuales de stock, cargas iniciales o importaciones. Se registran como asiento de
                apertura para que el Kardex quede cuadrado desde el primer día.
              </p>
              <div style={st.tablaWrap}>
                <table style={st.tabla}>
                  <thead>
                    <tr>
                      <th style={st.th}>Producto</th>
                      <th style={st.thNum}>Calculado</th>
                      <th style={st.thNum}>Real</th>
                      <th style={st.thNum}>Diferencia</th>
                      <th style={st.thNum}>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {informeRecon.diferencias.slice(0, 50).map(d => (
                      <tr key={d.productoId}>
                        <td style={st.td}>
                          <strong>{d.nombre}</strong>
                          <div style={st.tdSub}>{d.codigo}</div>
                        </td>
                        <td style={st.tdNum}>{d.calculado}</td>
                        <td style={st.tdNum}>{d.real}</td>
                        <td style={{ ...st.tdNum, color: d.diferencia < 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
                          {d.diferencia > 0 ? '+' : ''}{d.diferencia}
                        </td>
                        <td style={st.tdNum}>{formatCOP(d.valorDiferencia)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {informeRecon.diferencias.length > 50 && (
                <p style={st.notaGris}>Mostrando las 50 diferencias de mayor valor de {informeRecon.diferencias.length}.</p>
              )}
            </>
          )}

          {informeRecon.dryRun && (
            <div style={st.filaBtns}>
              <button style={st.btnGhost} onClick={() => setInformeRecon(null)}>Cerrar</button>
              <button style={st.btnPrimario} disabled={reconstruyendo} onClick={() => reconstruir(true)}>
                {reconstruyendo ? 'Reconstruyendo…' : 'Confirmar y escribir el histórico'}
              </button>
            </div>
          )}
          {!informeRecon.dryRun && (
            <div style={st.filaBtns}>
              <button style={st.btnGhost} onClick={() => setInformeRecon(null)}>Cerrar</button>
            </div>
          )}
        </div>
      )}

      {/* ─── FILTRO DE PERÍODO ─── */}
      <div style={st.barraPeriodo}>
        <div style={st.campoInline}>
          <label style={st.labelSm}>Desde</label>
          <input type="date" style={st.inputSm} value={desde} onChange={e => setDesde(e.target.value)} />
        </div>
        <div style={st.campoInline}>
          <label style={st.labelSm}>Hasta</label>
          <input type="date" style={st.inputSm} value={hasta} onChange={e => setHasta(e.target.value)} />
        </div>
        <button style={st.btnGhost} onClick={cargarResumen}>Actualizar</button>
      </div>

      {/* ─── KPIs ─── */}
      {cargandoResumen ? (
        <div style={st.cargando}>Cargando inventario…</div>
      ) : resumen && (
        <>
          <div style={st.kpiGrid}>
            <Kpi label="Unidades ingresadas" valor={resumen.unidadesIngresadas} tono="ok" />
            <Kpi label="Unidades salidas" valor={resumen.unidadesSalidas} />
            <Kpi label="Movimientos" valor={resumen.movimientosTotales} />
            {isAdmin && <Kpi label="Valor del inventario" valor={formatCOP(resumen.valorInventario)} />}
            <Kpi label="Referencias en negativo" valor={resumen.referenciasEnNegativo}
                 tono={resumen.referenciasEnNegativo > 0 ? 'alerta' : 'ok'} />
          </div>

          {/* ─── NEGATIVOS CON SU EXPLICACIÓN ─── */}
          {resumen.productosEnNegativo?.length > 0 && (
            <div style={st.cardAlerta}>
              <h3 style={{ ...st.cardTitulo, color: '#b91c1c' }}>
                Referencias con stock en negativo
              </h3>
              <p style={{ ...st.notaGris, marginTop: 0 }}>
                Un negativo significa que salió mercancía que el sistema no tenía registrada.
                No se bloquea: se muestra para que corrijas la venta o registres la entrada que falta.
              </p>
              {resumen.productosEnNegativo.map(p => (
                <div key={p.id} style={st.negFila}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <strong>{p.nombre}</strong>
                    <span style={st.tdSub}> · {p.codigo}</span>
                    {p.nota && <div style={st.negNota}>{p.nota}</div>}
                    {p.fecha && <div style={st.tdSub}>{formatFecha(p.fecha)}{p.origenNumero ? ` · ${p.origenNumero}` : ''}</div>}
                  </div>
                  <div style={st.negValor}>{p.stock}</div>
                  <button style={st.btnMini} onClick={() => {
                    const prod = productos.find(x => x.id === p.id);
                    if (prod) abrirKardex(prod);
                    setTab('kardex');
                  }}>Ver kardex</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ─── PESTAÑAS ─── */}
      <div style={st.tabs}>
        <button style={tab === 'kardex' ? st.tabActiva : st.tab} onClick={() => setTab('kardex')}>
          Kardex
        </button>
        {isAdmin && (
          <button style={tab === 'conteo' ? st.tabActiva : st.tab} onClick={() => setTab('conteo')}>
            Conteo físico
          </button>
        )}
        {isAdmin && (
          <button style={tab === 'rotacion' ? st.tabActiva : st.tab} onClick={() => setTab('rotacion')}>
            Rotación
          </button>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          KARDEX
      ══════════════════════════════════════════════════════════════════ */}
      {tab === 'kardex' && (
        <div style={st.dosCol}>
          {/* Lista de productos */}
          <div style={st.card}>
            <h3 style={st.cardTitulo}>Elige un producto</h3>
            <input style={st.input} placeholder="Buscar por nombre o código…"
              value={buscar} onChange={e => setBuscar(e.target.value)} />
            <div style={st.listaProd}>
              {productosBuscados.slice(0, 100).map(p => (
                <button key={p.id}
                  style={productoSel?.id === p.id ? st.prodItemActivo : st.prodItem}
                  onClick={() => abrirKardex(p)}>
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={{ fontWeight: 600 }}>{p.nombre}</div>
                    <div style={st.tdSub}>{p.codigo} · {p.categoria}</div>
                  </div>
                  <span style={{
                    fontWeight: 700,
                    color: (Number(p.stock) || 0) < 0 ? '#dc2626' : '#374151'
                  }}>{p.stock ?? 0}</span>
                </button>
              ))}
              {productosBuscados.length === 0 && (
                <div style={st.notaGris}>Ningún producto coincide con la búsqueda.</div>
              )}
            </div>
          </div>

          {/* Movimientos */}
          <div style={st.card}>
            {!productoSel && (
              <div style={st.vacioChico}>
                Selecciona un producto para ver todo lo que entró y salió, con fecha,
                documento y cliente.
              </div>
            )}

            {productoSel && cargandoKardex && <div style={st.cargando}>Cargando kardex…</div>}

            {productoSel && kardex && !cargandoKardex && (
              <>
                <div style={st.cabeceraKardex}>
                  <div>
                    <h3 style={{ ...st.cardTitulo, marginBottom: 2 }}>{kardex.producto.nombre}</h3>
                    <div style={st.tdSub}>{kardex.producto.codigo} · {kardex.producto.categoria}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={st.labelSm}>Stock actual</div>
                    <div style={{
                      fontSize: 26, fontWeight: 800,
                      color: kardex.producto.stock < 0 ? '#dc2626' : '#111'
                    }}>{kardex.producto.stock}</div>
                  </div>
                </div>

                <div style={st.filaFiltros}>
                  <select style={st.inputSm} value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
                    {TIPOS_FILTRO.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                  </select>
                  <button style={st.btnGhost} onClick={exportarKardex}>Exportar CSV</button>
                  {isAdmin && (
                    <button style={st.btnPrimario} onClick={() => setModalAjuste(kardex.producto)}>
                      Ajustar stock
                    </button>
                  )}
                </div>

                {movimientosFiltrados.length === 0 ? (
                  <div style={st.vacioChico}>
                    Sin movimientos en este período. Amplía las fechas o quita el filtro de tipo.
                  </div>
                ) : (
                  <div style={st.tablaWrap}>
                    <table style={st.tabla}>
                      <thead>
                        <tr>
                          <th style={st.th}>Fecha</th>
                          <th style={st.th}>Movimiento</th>
                          <th style={st.thNum}>Cant.</th>
                          <th style={st.thNum}>Saldo</th>
                          <th style={st.th}>Documento</th>
                          <th style={st.th}>Cliente / Proveedor</th>
                          <th style={st.th}>Usuario</th>
                        </tr>
                      </thead>
                      <tbody>
                        {movimientosFiltrados.map(m => (
                          <tr key={m.id} style={m.stockNegativo ? { background: '#fef2f2' } : undefined}>
                            <td style={st.td}>{formatFecha(m.fecha)}</td>
                            <td style={st.td}>
                              {m.tipoLabel}
                              {m.motivo && <div style={st.tdSub}>{m.motivo}</div>}
                              {m.notaNegativo && <div style={st.negNota}>{m.notaNegativo}</div>}
                            </td>
                            <td style={{ ...st.tdNum, color: colorMovimiento(m.tipo, m.cantidad), fontWeight: 700 }}>
                              {m.cantidad > 0 ? '+' : ''}{m.cantidad}
                            </td>
                            <td style={{ ...st.tdNum, color: m.saldo < 0 ? '#dc2626' : '#374151' }}>{m.saldo}</td>
                            <td style={st.td}>{m.origenNumero || '—'}</td>
                            <td style={st.td}>{m.clienteNombre || m.proveedorNombre || '—'}</td>
                            <td style={st.td}>{m.usuarioNombre || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          CONTEO FÍSICO
      ══════════════════════════════════════════════════════════════════ */}
      {tab === 'conteo' && isAdmin && (
        <div style={st.card}>
          <h3 style={st.cardTitulo}>Conteo físico</h3>
          <p style={st.notaGris}>
            Escribe lo que contaste. Verás las diferencias valorizadas antes de aplicar nada,
            y cada ajuste queda registrado en el Kardex con su motivo.
          </p>

          {!previewConteo && (
            <>
              <div style={st.filaFiltros}>
                <select style={st.inputSm} value={catConteo} onChange={e => setCatConteo(e.target.value)}>
                  <option value="">Todas las categorías</option>
                  {categorias.map(c => (
                    <option key={c.id || c.nombre} value={c.nombre}>{c.nombre}</option>
                  ))}
                </select>
                <span style={st.tdSub}>{productosConteo.length} referencia(s)</span>
              </div>

              <div style={st.tablaWrap}>
                <table style={st.tabla}>
                  <thead>
                    <tr>
                      <th style={st.th}>Producto</th>
                      <th style={st.thNum}>Sistema</th>
                      <th style={st.thNum}>Contado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productosConteo.map(p => (
                      <tr key={p.id}>
                        <td style={st.td}>
                          <strong>{p.nombre}</strong>
                          <div style={st.tdSub}>{p.codigo}</div>
                        </td>
                        <td style={st.tdNum}>{p.stock ?? 0}</td>
                        <td style={st.tdNum}>
                          <input type="number" style={st.inputConteo}
                            value={conteos[p.id] ?? ''}
                            placeholder="—"
                            onChange={e => setConteos(prev => ({ ...prev, [p.id]: e.target.value }))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={st.filaBtns}>
                <button style={st.btnGhost} onClick={() => setConteos({})}>Limpiar</button>
                <button style={st.btnPrimario} onClick={verPreviewConteo}>Ver diferencias</button>
              </div>
            </>
          )}

          {previewConteo && (
            <>
              <div style={st.kpiGrid}>
                <Kpi label="Contadas" valor={previewConteo.resumen.referenciasContadas} />
                <Kpi label="Cuadran" valor={previewConteo.resumen.cuadran} tono="ok" />
                <Kpi label="Faltantes" valor={previewConteo.resumen.faltantes} tono="alerta" />
                <Kpi label="Sobrantes" valor={previewConteo.resumen.sobrantes} />
                <Kpi label="Valor faltante" valor={formatCOP(previewConteo.resumen.valorFaltante)} tono="alerta" />
              </div>

              <div style={st.tablaWrap}>
                <table style={st.tabla}>
                  <thead>
                    <tr>
                      <th style={st.th}>Producto</th>
                      <th style={st.thNum}>Sistema</th>
                      <th style={st.thNum}>Contado</th>
                      <th style={st.thNum}>Diferencia</th>
                      <th style={st.thNum}>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewConteo.filas.map(f => (
                      <tr key={f.productoId}>
                        <td style={st.td}>
                          <strong>{f.nombre}</strong>
                          <div style={st.tdSub}>{f.codigo}</div>
                        </td>
                        <td style={st.tdNum}>{f.sistema}</td>
                        <td style={st.tdNum}>{f.contado}</td>
                        <td style={{ ...st.tdNum, fontWeight: 700, color: f.diferencia === 0 ? '#6b7280' : (f.diferencia < 0 ? '#dc2626' : '#16a34a') }}>
                          {f.diferencia > 0 ? '+' : ''}{f.diferencia}
                        </td>
                        <td style={st.tdNum}>{f.diferencia === 0 ? '—' : formatCOP(f.valorDiferencia)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={st.filaBtns}>
                <button style={st.btnGhost} onClick={() => setPreviewConteo(null)}>Volver a editar</button>
                <button style={st.btnPrimario} disabled={aplicandoConteo} onClick={aplicarConteo}>
                  {aplicandoConteo ? 'Aplicando…' : `Aplicar ${previewConteo.filas.filter(f => f.diferencia !== 0).length} ajuste(s)`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          ROTACIÓN
      ══════════════════════════════════════════════════════════════════ */}
      {tab === 'rotacion' && isAdmin && (
        <div style={st.card}>
          <h3 style={st.cardTitulo}>Rotación de inventario</h3>
          <p style={st.notaGris}>
            Rotación = unidades salidas ÷ inventario promedio del período. Los días de inventario
            dicen cuánto te dura el stock actual al ritmo de salida que llevas.
          </p>

          {cargandoRot && <div style={st.cargando}>Calculando rotación…</div>}

          {rotacion && !cargandoRot && (
            <>
              <div style={st.kpiGrid}>
                <Kpi label="Referencias analizadas" valor={rotacion.resumen.referenciasAnalizadas} />
                <Kpi label="Sin movimiento" valor={rotacion.resumen.referenciasSinMovimiento} tono="alerta" />
                <Kpi label="Capital dormido" valor={formatCOP(rotacion.resumen.valorCapitalDormido)} tono="alerta" />
                <Kpi label="Costo de lo vendido" valor={formatCOP(rotacion.resumen.costoVendidoTotal)} />
                <Kpi label="Valor del inventario" valor={formatCOP(rotacion.resumen.valorInventarioActual)} />
              </div>

              <div style={st.filaBtns}>
                <button style={st.btnGhost} onClick={() => descargarCSV(rotacion.productos.map(p => ({
                  Producto: p.nombre, Codigo: p.codigo, Categoria: p.categoria,
                  SaldoInicial: p.saldoInicial, Entradas: p.entradasPeriodo, Salidas: p.salidasPeriodo,
                  SaldoFinal: p.saldoFinal, InventarioPromedio: p.inventarioPromedio,
                  Rotacion: p.rotacion ?? '', DiasInventario: p.diasInventario ?? '',
                  ValorStock: p.valorStockActual
                })), 'rotacion_inventario')}>Exportar CSV</button>
              </div>

              <div style={st.tablaWrap}>
                <table style={st.tabla}>
                  <thead>
                    <tr>
                      <th style={st.th}>Producto</th>
                      <th style={st.thNum}>Entradas</th>
                      <th style={st.thNum}>Salidas</th>
                      <th style={st.thNum}>Stock</th>
                      <th style={st.thNum}>Rotación</th>
                      <th style={st.thNum}>Días inv.</th>
                      <th style={st.thNum}>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rotacion.productos.map(p => (
                      <tr key={p.productoId} style={p.capitalDormido ? { background: '#fffbeb' } : undefined}>
                        <td style={st.td}>
                          <strong>{p.nombre}</strong>
                          <div style={st.tdSub}>
                            {p.codigo}
                            {p.capitalDormido && <span style={st.chipDormido}>sin movimiento</span>}
                          </div>
                        </td>
                        <td style={st.tdNum}>{p.entradasPeriodo}</td>
                        <td style={st.tdNum}>{p.salidasPeriodo}</td>
                        <td style={{ ...st.tdNum, color: p.saldoFinal < 0 ? '#dc2626' : '#374151' }}>{p.saldoFinal}</td>
                        <td style={st.tdNum}>{p.rotacion ?? '—'}</td>
                        <td style={st.tdNum}>{p.diasInventario ?? '—'}</td>
                        <td style={st.tdNum}>{formatCOP(p.valorStockActual)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── MODAL: AJUSTE DE STOCK ─── */}
      {modalAjuste && (
        <div style={st.overlay} onClick={() => !ajustando && setModalAjuste(null)}>
          <div style={st.modal} onClick={e => e.stopPropagation()}>
            <h3 style={st.cardTitulo}>Ajustar stock</h3>
            <p style={st.notaGris}>
              <strong>{modalAjuste.nombre}</strong> · stock actual: {modalAjuste.stock}
            </p>

            <div style={st.campo}>
              <label style={st.label}>Cantidad a ajustar</label>
              <input type="number" style={st.input} placeholder="Ej: 5 para sumar, -3 para descontar"
                value={ajusteCant} onChange={e => setAjusteCant(e.target.value)} />
              {ajusteCant !== '' && !isNaN(Number(ajusteCant)) && (
                <small style={st.hint}>
                  El stock quedará en {(Number(modalAjuste.stock) || 0) + Number(ajusteCant)}
                </small>
              )}
            </div>

            <div style={st.campo}>
              <label style={st.label}>Motivo del ajuste</label>
              <textarea style={{ ...st.input, minHeight: 70, resize: 'vertical' }}
                placeholder="Ej: unidades dañadas en bodega, error de digitación en la factura 1042…"
                value={ajusteMotivo} onChange={e => setAjusteMotivo(e.target.value)} />
              <small style={st.hint}>Queda guardado con tu nombre en el Kardex.</small>
            </div>

            <div style={st.filaBtns}>
              <button style={st.btnGhost} disabled={ajustando} onClick={() => setModalAjuste(null)}>Cancelar</button>
              <button style={st.btnPrimario} disabled={ajustando} onClick={aplicarAjuste}>
                {ajustando ? 'Aplicando…' : 'Aplicar ajuste'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── KPI ────────────────────────────────────────────────────────────────────
const Kpi = ({ label, valor, tono }) => (
  <div style={{
    ...st.kpi,
    borderLeft: `4px solid ${tono === 'alerta' ? '#f59e0b' : tono === 'ok' ? '#16a34a' : '#7c3aed'}`
  }}>
    <div style={st.kpiLabel}>{label}</div>
    <div style={st.kpiValor}>{valor}</div>
  </div>
);

// ─── ESTILOS ────────────────────────────────────────────────────────────────
// Mismos tokens que GestionProductos.js: violeta #7c3aed, tarjetas blancas,
// radio 12px, Segoe UI. La coherencia con el resto de Control360 pesa más que
// inventar un lenguaje visual propio para una sección interna.
const st = {
  card:        { background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', padding: '20px', marginBottom: '16px' },
  cardAlerta:  { background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', padding: '20px', marginBottom: '16px', border: '1px solid #fca5a5' },
  cardTitulo:  { margin: '0 0 12px', fontSize: '16px', fontWeight: 700, color: '#111' },

  alertError:  { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' },
  alertExito:  { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '12px 16px', borderRadius: '8px', marginBottom: '16px' },

  bannerRecon: { background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '12px', padding: '16px 20px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', color: '#92400e' },
  btnAmbar:    { padding: '10px 18px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },

  barraPeriodo:{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '16px' },
  campoInline: { display: 'flex', flexDirection: 'column', gap: '4px' },

  kpiGrid:     { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px', marginBottom: '16px' },
  kpi:         { background: '#fff', borderRadius: '10px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', padding: '14px 16px' },
  kpiLabel:    { fontSize: '12px', color: '#6b7280', marginBottom: '4px' },
  kpiValor:    { fontSize: '22px', fontWeight: 800, color: '#111' },

  tabs:        { display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' },
  tab:         { padding: '10px 20px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' },
  tabActiva:   { padding: '10px 20px', background: '#ede9fe', color: '#7c3aed', border: '2px solid #7c3aed', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },

  dosCol:      { display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', gap: '16px', alignItems: 'start' },

  listaProd:   { maxHeight: '520px', overflowY: 'auto', marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' },
  prodItem:    { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: '#f9fafb', border: '1px solid transparent', borderRadius: '8px', cursor: 'pointer', width: '100%', fontSize: '13px' },
  prodItemActivo: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: '#ede9fe', border: '1px solid #7c3aed', borderRadius: '8px', cursor: 'pointer', width: '100%', fontSize: '13px' },

  cabeceraKardex: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap', marginBottom: '14px' },
  filaFiltros: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px' },
  filaBtns:    { display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px', flexWrap: 'wrap' },

  tablaWrap:   { overflowX: 'auto', maxHeight: '560px', overflowY: 'auto' },
  tabla:       { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  th:          { textAlign: 'left', padding: '10px 12px', background: '#f9fafb', color: '#6b7280', fontWeight: 600, fontSize: '12px', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0 },
  thNum:       { textAlign: 'right', padding: '10px 12px', background: '#f9fafb', color: '#6b7280', fontWeight: 600, fontSize: '12px', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0 },
  td:          { padding: '10px 12px', borderBottom: '1px solid #f3f4f6', color: '#374151', verticalAlign: 'top' },
  tdNum:       { padding: '10px 12px', borderBottom: '1px solid #f3f4f6', color: '#374151', textAlign: 'right', verticalAlign: 'top' },
  tdSub:       { fontSize: '11px', color: '#9ca3af', marginTop: '2px' },

  negFila:     { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0', borderBottom: '1px solid #f3f4f6', flexWrap: 'wrap' },
  negNota:     { fontSize: '12px', color: '#b91c1c', marginTop: '4px', lineHeight: 1.45 },
  negValor:    { fontSize: '20px', fontWeight: 800, color: '#dc2626', minWidth: '52px', textAlign: 'right' },

  chipDormido: { marginLeft: '6px', padding: '1px 7px', background: '#fef3c7', color: '#92400e', borderRadius: '999px', fontSize: '10px', fontWeight: 700 },

  campo:       { marginBottom: '14px' },
  label:       { display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '6px' },
  labelSm:     { fontSize: '11px', color: '#6b7280', fontWeight: 600 },
  input:       { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box', fontFamily: 'inherit' },
  inputSm:     { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13px', fontFamily: 'inherit' },
  inputConteo: { width: '90px', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '13px', textAlign: 'right' },
  hint:        { fontSize: '11px', color: '#6b7280', display: 'block', marginTop: '4px' },

  btnPrimario: { padding: '10px 22px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '13px' },
  btnGhost:    { padding: '10px 18px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' },
  btnMini:     { padding: '6px 12px', background: '#ede9fe', color: '#7c3aed', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '12px' },

  notaGris:    { fontSize: '13px', color: '#6b7280', lineHeight: 1.5, margin: '0 0 14px' },
  cargando:    { padding: '32px', textAlign: 'center', color: '#6b7280' },
  vacioChico:  { padding: '40px 20px', textAlign: 'center', color: '#9ca3af', fontSize: '14px', lineHeight: 1.6 },
  vacio:       { padding: '60px 24px', textAlign: 'center', background: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
  vacioTitulo: { margin: '0 0 8px', fontSize: '18px', fontWeight: 700, color: '#111' },
  vacioTexto:  { margin: 0, color: '#6b7280', fontSize: '14px', maxWidth: '460px', marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 },

  overlay:     { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' },
  modal:       { background: '#fff', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '460px', maxHeight: '90vh', overflowY: 'auto' }
};

export default ModuloInventario;
