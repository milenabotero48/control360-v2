const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

// ─────────────────────────────────────────────────────────────────────────────
// Cambios Ola 1 sobre el original:
//   1) Aislamiento multi-tenant estricto: TODAS las queries de egresos y
//      órdenes filtran por adminId (antes leían toda la colección 'orders'
//      sin filtro, lo que era una fuga entre suscriptores cuando lleguemos
//      al SaaS).
//   2) Auditoría con `documento` cuando se paga una CxP.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/cxp — Listar todas las CxP agrupadas
router.get('/', async (req, res) => {
  try {
    const userId = req.adminId || req.user.uid || req.user.id;

    // ✅ CXP-IVA-001: período fiscal. La declaración de IVA en Colombia es
    // cuatrimestral para estas empresas (bimestral solo el primer año), así
    // que el panel calcula por CUATRIMESTRE (Ene-Abr, May-Ago, Sep-Dic).
    // El frontend puede enviar ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD para ver
    // otro período. Sin parámetros → cuatrimestre actual (hora Colombia).
    const hoyCO = new Date(Date.now() - 5 * 3600 * 1000);
    const anio = hoyCO.getUTCFullYear();
    const mes = hoyCO.getUTCMonth(); // 0-11
    const cuatri = Math.floor(mes / 4); // 0,1,2
    const defDesde = `${anio}-${String(cuatri * 4 + 1).padStart(2, '0')}-01`;
    const defHasta = `${anio}-${String(cuatri * 4 + 4).padStart(2, '0')}-31`;
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : defDesde;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : defHasta;
    const enPeriodo = (f) => {
      const fecha = String(f || '').slice(0, 10);
      return fecha >= desde && fecha <= hasta;
    };

    // FIX BUG A: el IVA descontable debe sumar TODOS los egresos del período
    // (PAGADOS Y PENDIENTES), no solo PENDIENTES. Antes el filtro de PENDIENTE
    // hacía que cuando pagabas un egreso desapareciera del cálculo.
    //
    // FIX BUG B: cualquier egreso PENDIENTE con proveedor cuenta como deuda
    // en CxP (antes solo si formaPago === 'Cuenta por Pagar' literal).
    //
    // Hacemos 2 queries:
    //   - snapTodos:    todos los egresos del admin → para IVA descontable total
    //   - snapPendiente: solo PENDIENTES → para mostrar como deuda con proveedor
    const [snapTodos, snapPendiente] = await Promise.all([
      db.collection('egresos').where('userId', '==', userId).get(),
      db.collection('egresos').where('userId', '==', userId).where('estado', '==', 'PENDIENTE').get()
    ]);

    // ✅ CXP-IVA-002: detectar dinámicamente qué empresa(s) son responsables de
    // IVA (iva > 0). No se fija a una empresa concreta — otro suscriptor podría
    // tener varias responsables. El IVA generado solo cuenta de estas empresas.
    let empresasResponsablesIVA = [];
    try {
      // ✅ CXP-IVA-003 FIX: la colección companies usa el campo user_id (no
      // adminId). Con adminId la consulta salía vacía, idsResponsables quedaba
      // vacío, y el informe contaba TODAS las empresas en vez de solo la
      // responsable de IVA — por eso el Valle traía datos que no eran suyos.
      const snapEmp = await db.collection('companies').where('user_id', '==', userId).get();
      empresasResponsablesIVA = snapEmp.docs
        .map(d => ({ id: d.id, name: d.data().name, nit: d.data().nit, iva: Number(d.data().iva) || 0 }))
        .filter(e => e.iva > 0);
    } catch (e) { /* si falla, el informe sale sin encabezado de empresa */ }
    const idsResponsables = new Set(empresasResponsablesIVA.map(e => e.id));

    // ✅ CXP-IVA-002: acumuladores del INFORME agrupado
    const generadoPorCliente = {};   // clienteNombre → { nombre, nit, facturas[], subtotalIva, subtotalBase }
    const descontablePorProveedor = {}; // proveedor → { nombre, facturas[], subtotalIva, subtotalBase }
    let ivaDescontableFueraPeriodo = 0; // diagnóstico del descontable $0

    const proveedores = {};
    let totalIvaDescontable = 0;
    let totalRetefuente = 0;

    // ── 1. Sumar IVA y retención de TODOS los egresos del admin ─────────
    // (excluir provisionales no cuadrados y retenciones puras)
    snapTodos.forEach(doc => {
      const e = { id: doc.id, ...doc.data() };
      // Excluir provisionales no cuadrados (no son egresos reales aún)
      if (e.esProvisional && !e.cuadrado) return;
      // Excluir entradas que son solo "retención practicada" (no compras)
      if (e.tipo === 'retencion') return;

      // ✅ CXP-IVA-001: IVA descontable solo del período de declaración
      if (e.ivaVal > 0 && enPeriodo(e.fecha)) {
        totalIvaDescontable += Number(e.ivaVal) || 0;
        // ✅ CXP-IVA-002: agrupar por proveedor para el informe
        const prov = (e.proveedor || 'Sin proveedor').trim() || 'Sin proveedor';
        if (!descontablePorProveedor[prov]) {
          descontablePorProveedor[prov] = { nombre: prov, facturas: [], subtotalIva: 0, subtotalBase: 0 };
        }
        const baseEgreso = (Number(e.monto) || 0) - (Number(e.ivaVal) || 0);
        descontablePorProveedor[prov].facturas.push({
          concepto: e.concepto || '',
          numeroFactura: e.numeroFactura || e.factura || '',
          fecha: (e.fecha || '').slice(0, 10),
          base: baseEgreso > 0 ? baseEgreso : (Number(e.monto) || 0),
          iva: Number(e.ivaVal) || 0
        });
        descontablePorProveedor[prov].subtotalIva += Number(e.ivaVal) || 0;
        descontablePorProveedor[prov].subtotalBase += baseEgreso > 0 ? baseEgreso : 0;
      } else if (e.ivaVal > 0 && !enPeriodo(e.fecha)) {
        // ✅ CXP-IVA-002: diagnóstico — hay IVA de compras pero cae fuera del
        // período (o sin fecha válida). Explica por qué el descontable da bajo/$0.
        ivaDescontableFueraPeriodo += Number(e.ivaVal) || 0;
      }
      // Retefuente pendiente de pago: no depende del período (es deuda viva)
      if (e.retenVal > 0 && e.estado !== 'PAGADO') totalRetefuente += Number(e.retenVal) || 0;
    });

    // ── 2. Listar PENDIENTES como deuda con proveedor ──────────────────
    snapPendiente.forEach(doc => {
      const e = { id: doc.id, ...doc.data() };
      // Excluir provisionales no cuadrados
      if (e.esProvisional && !e.cuadrado) return;
      if (e.tipo === 'retencion') return;

      // FIX BUG B: TODO egreso PENDIENTE cuenta como deuda, no solo si
      // formaPago === 'Cuenta por Pagar'. Si está pendiente, debes plata.
      const key = e.proveedorId || e.proveedor || 'Sin proveedor';
      if (!proveedores[key]) {
        proveedores[key] = {
          proveedorId: e.proveedorId || '',
          proveedorNombre: e.proveedor || 'Sin proveedor',
          totalPendiente: 0,
          egresos: []
        };
      }
      const saldo = (e.totalPagar || e.monto || 0) - (e.montoPagado || 0);
      proveedores[key].totalPendiente += saldo;
      proveedores[key].egresos.push({
        id: e.id, numero: e.numero, concepto: e.concepto,
        fecha: e.fecha, total: e.totalPagar || e.monto || 0,
        saldo, formaPago: e.formaPago || 'Pendiente'
      });
    });

    // ✅ CXP-IVA-001: el IVA se CAUSA al facturar, no al cobrar (régimen
    // común). Antes solo sumaba órdenes en estado 'completada' — las ventas
    // a crédito (estado cxc) y toda orden facturada aún en flujo quedaban
    // por fuera: un contribuyente con operación a crédito veía IVA $0.
    // Regla nueva: toda orden CON número de factura registrado y no anulada,
    // dentro del período. También se fusionan las DOS queries idénticas que
    // había (misma corrección que en el dashboard de taller) y se agrega
    // .select() — una sola lectura liviana en vez de dos completas.
    const snapOrdenes = await db.collection('orders')
      .where('adminId', '==', userId)
      .select('numeroFactura', 'ivaValor', 'subtotal', 'total', 'empresaId', 'retencionPracticada', 'estado',
              'fechaFactura', 'fechaPago', 'fechaProgramada', 'numeroOrden', 'clienteNombre')
      .get();

    let ivaGenerado = 0;
    let totalRenta = 0;
    const retencionesClientes = [];
    snapOrdenes.forEach(doc => {
      const o = doc.data();
      if (o.estado === 'anulada') return;
      const fechaCausacion = o.fechaFactura || o.fechaPago || o.fechaProgramada;
      const facturada = typeof o.numeroFactura === 'string' && o.numeroFactura.trim().length > 0;

      if (facturada && enPeriodo(fechaCausacion)) {
        // ✅ CXP-IVA-002: el IVA generado solo cuenta de las empresas
        // responsables de IVA. Si no hay empresas responsables detectadas,
        // se cuenta todo (compatibilidad / tenant sin empresas configuradas).
        const esResponsable = idsResponsables.size === 0 || idsResponsables.has(o.empresaId);
        if (esResponsable) {
          ivaGenerado += o.ivaValor || 0;
          // Agrupar por cliente para el informe
          const cli = (o.clienteNombre || 'Sin cliente').trim() || 'Sin cliente';
          if (!generadoPorCliente[cli]) {
            generadoPorCliente[cli] = { nombre: cli, facturas: [], subtotalIva: 0, subtotalBase: 0 };
          }
          const baseOrden = Number(o.subtotal) || ((Number(o.total) || 0) - (Number(o.ivaValor) || 0));
          generadoPorCliente[cli].facturas.push({
            numeroOrden: o.numeroOrden || '',
            numeroFactura: o.numeroFactura,
            fecha: (fechaCausacion || '').slice(0, 10),
            base: baseOrden,
            iva: Number(o.ivaValor) || 0
          });
          generadoPorCliente[cli].subtotalIva += Number(o.ivaValor) || 0;
          generadoPorCliente[cli].subtotalBase += baseOrden;
        }
      }
      // Retenciones practicadas por clientes — mismo período
      if ((o.retencionPracticada || 0) > 0 && enPeriodo(o.fechaPago || fechaCausacion)) {
        totalRenta += o.retencionPracticada;
        retencionesClientes.push({
          ordenId: doc.id, numeroOrden: o.numeroOrden,
          clienteNombre: o.clienteNombre, monto: o.retencionPracticada,
          fecha: o.fechaPago
        });
      }
    });

    const ivaNeto = ivaGenerado - totalIvaDescontable;

    // ✅ CXP-IVA-002: INFORME FISCAL DE IVA — estructura agrupada y auditable.
    // Ordena cada grupo por IVA descendente (los más relevantes primero).
    const ordenarPorIva = (obj) => Object.values(obj)
      .map(g => ({ ...g, facturas: g.facturas.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')) }))
      .sort((a, b) => b.subtotalIva - a.subtotalIva);

    const informe = {
      periodo: { desde, hasta },
      // Encabezado: empresa(s) responsable(s) de IVA
      empresasResponsables: empresasResponsablesIVA.map(e => ({ name: e.name, nit: e.nit, iva: e.iva })),
      resumen: {
        ivaGenerado,
        ivaDescontable: totalIvaDescontable,
        ivaNeto,
        ivaFavor: ivaNeto < 0
      },
      generado: ordenarPorIva(generadoPorCliente),      // ventas por cliente
      descontable: ordenarPorIva(descontablePorProveedor), // compras por proveedor
      // Diagnóstico: por qué el descontable puede verse bajo/$0
      diagnostico: {
        ivaDescontableFueraPeriodo,
        hayComprasFueraPeriodo: ivaDescontableFueraPeriodo > 0,
        sinComprasConIva: totalIvaDescontable === 0 && ivaDescontableFueraPeriodo === 0
      }
    };

    res.json({
      periodo: { desde, hasta }, // ✅ CXP-IVA-001
      proveedores: Object.values(proveedores),
      impuestos: {
        ivaGenerado, totalIvaDescontable, ivaNeto,
        ivaFavor: ivaNeto < 0,
        retefuente: totalRetefuente,
        renta: totalRenta,
        retencionesClientes
      },
      informe, // ✅ CXP-IVA-002
      totales: {
        proveedores: Object.values(proveedores).reduce((s, p) => s + p.totalPendiente, 0),
        impuestos: Math.max(ivaNeto, 0) + totalRetefuente + totalRenta
      }
    });
  } catch (e) {
    console.error('GET CxP:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cxp/:egresoId/pagar — Registrar pago o abono parcial de CxP proveedor
router.post('/:egresoId/pagar', async (req, res) => {
  try {
    const { cajaId, formaPago, fechaPago, montoAbono } = req.body;
    if (!cajaId || !formaPago) return res.status(400).json({ error: 'cajaId y formaPago requeridos' });

    const egresoRef = db.collection('egresos').doc(req.params.egresoId);
    const egresoDoc = await egresoRef.get();
    if (!egresoDoc.exists) return res.status(404).json({ error: 'Egreso no encontrado' });

    const egreso = egresoDoc.data();

    const userId = req.adminId || req.user.uid || req.user.id;
    if (egreso.userId && egreso.userId !== userId) {
      return res.status(403).json({ error: 'No tienes acceso a este egreso' });
    }

    const saldoActual = egreso.saldo ?? (egreso.totalPagar || egreso.monto || 0);
    if (saldoActual <= 0) return res.status(400).json({ error: 'Este egreso ya esta completamente pagado' });

    const montoAbonoNum = Number(montoAbono) || 0;
    const montoPagar = (montoAbonoNum > 0 && montoAbonoNum < saldoActual)
      ? montoAbonoNum
      : saldoActual;

    const nuevoSaldo = saldoActual - montoPagar;
    const nuevoMontoPagado = (egreso.montoPagado || 0) + montoPagar;
    const esAbonoParcial = nuevoSaldo > 0;
    const nuevoEstado = esAbonoParcial ? 'PENDIENTE' : 'PAGADO';

    const abono = {
      monto: montoPagar,
      formaPago,
      cajaId,
      fecha: fechaPago || new Date().toISOString(),
      creadoPor: req.user.email || '',
      saldoAntes: saldoActual,
      saldoDespues: nuevoSaldo,
      createdAt: new Date().toISOString()
    };

    const batch = db.batch();
    batch.update(egresoRef, {
      estado: nuevoEstado,
      saldo: nuevoSaldo,
      montoPagado: nuevoMontoPagado,
      cajaId, formaPago,
      fechaPago: esAbonoParcial ? (egreso.fechaPago || null) : (fechaPago || new Date().toISOString()),
      abonos: admin.firestore.FieldValue.arrayUnion(abono),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const cajaRef = db.collection('cajas').doc(cajaId);
    batch.update(cajaRef, {
      saldo: admin.firestore.FieldValue.increment(-montoPagar),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    await db.collection('movimientos').add({
      userId, cajaId, tipo: 'egreso',
      concepto: `${esAbonoParcial ? 'Abono' : 'Pago'} CxP ${egreso.numero} — ${egreso.proveedor || ''}`,
      monto: montoPagar,
      referencia: egreso.numero,
      formaPago,
      egresoId: req.params.egresoId,
      esAbonoParcial,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    try {
      await db.collection('audit_logs').add({
        accion: esAbonoParcial ? 'CXP_ABONO' : 'CXP_PAGADA',
        modulo: 'cxp',
        descripcion: `${esAbonoParcial ? 'Abono' : 'Pago total'} CxP ${egreso.numero} — ${egreso.proveedor || ''} — ${fmt(montoPagar)} — Saldo: ${fmt(nuevoSaldo)}`,
        usuarioId: userId,
        usuarioNombre: req.user.email,
        documento: egreso.numero,
        datos: { montoPagado: montoPagar, saldoAnterior: saldoActual, saldoNuevo: nuevoSaldo },
        fecha: new Date().toISOString(),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch {}

    res.json({ ok: true, esAbonoParcial, saldoRestante: nuevoSaldo, montoPagado: montoPagar });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;
