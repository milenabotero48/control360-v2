const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

// ─────────────────────────────────────────────────────────────────────────────
// Módulo Compras — Control360 v2
// Disponible: Plan C (PRO) y Plan D (SUPER PRO)
//
// Flujo:
//   1. Suscriptor sube XML DIAN (UBL 2.1) o ingresa manualmente
//   2. Sistema parsea cabecera + lineas
//   3. Suscriptor mapea productos del XML al catalogo interno
//   4. Suscriptor ajusta retenciones y neto a pagar (siempre editable)
//   5. Al confirmar:
//      - stock += cantidad por cada linea mapeada
//      - egreso creado con categoria 'Compra de Mercancia'
//      - cxp creada si forma de pago != contado
//      - precio de costo del producto actualizado si cambio
// ─────────────────────────────────────────────────────────────────────────────

const registrarAuditoria = async (datos) => {
  try {
    await db.collection('audit_logs').add({
      ...datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (e) { console.error('Auditoria error:', e); }
};

const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

// ─── HELPER: generar numero de compra atomico ────────────────────────────────
const genNumeroCompra = async (adminId) => {
  const counterRef = db.collection('counters').doc(`${adminId}_compras`);
  const counterDoc = await counterRef.get();
  if (!counterDoc.exists) {
    const snap = await db.collection('compras').where('adminId', '==', adminId).get();
    let maximo = 0;
    snap.forEach(d => {
      const num = parseInt((d.data().numero || '').replace(/\D/g, '').slice(-4));
      if (!isNaN(num) && num > maximo) maximo = num;
    });
    await counterRef.set({ value: maximo, tipo: 'compras', adminId, inicializado: true });
  }
  const siguiente = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const nuevo = (doc.exists ? (Number(doc.data().value) || 0) : 0) + 1;
    tx.set(counterRef, { value: nuevo, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return nuevo;
  });
  return `CMP-${String(siguiente).padStart(4, '0')}`;
};

// ─── HELPER: actualizar stock y precio de costo al confirmar compra ──────────
const aplicarCompraAInventario = async (lineas) => {
  const alertasMargen = [];
  for (const linea of lineas) {
    if (!linea.productoId || !linea.cantidad || linea.cantidad <= 0) continue;
    try {
      const prodRef = db.collection('products').doc(linea.productoId);
      const prodDoc = await prodRef.get();
      if (!prodDoc.exists) continue;
      const prod = prodDoc.data();

      const costoPrevio = prod.precioCosto || 0;
      const costoNuevo = Number(linea.precioUnitario) || 0;

      const update = {
        stock: admin.firestore.FieldValue.increment(Number(linea.cantidad)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      // Actualizar precio de costo si cambio
      if (costoNuevo > 0 && costoNuevo !== costoPrevio) {
        update.precioCosto = costoNuevo;
        const precioVenta = prod.precioVenta || 0;
        if (precioVenta > 0) {
          const margenPrevio = costoPrevio > 0 ? (((precioVenta - costoPrevio) / precioVenta) * 100).toFixed(1) : 0;
          const margenNuevo = (((precioVenta - costoNuevo) / precioVenta) * 100).toFixed(1);
          if (Number(margenNuevo) < Number(margenPrevio)) {
            alertasMargen.push({
              productoId: linea.productoId,
              nombre: prod.nombre,
              precioVenta,
              costoPrevio,
              costoNuevo,
              margenPrevio,
              margenNuevo
            });
          }
        }
      }

      await prodRef.update(update);
    } catch (e) {
      console.warn('Error actualizando inventario compra:', linea.productoId, e.message);
    }
  }
  return alertasMargen;
};

// ─── GET /api/compras — Listar compras del tenant ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const snap = await db.collection('compras').where('adminId', '==', adminId).get();
    const compras = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    compras.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    res.json(compras);
  } catch (e) {
    console.error('GET compras:', e);
    res.status(500).json({ error: 'Error al obtener compras', detalle: e.message });
  }
});

// ─── GET /api/compras/:id — Detalle de una compra ────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const doc = await db.collection('compras').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Compra no encontrada' });
    const data = doc.data();
    if (data.adminId !== adminId) return res.status(403).json({ error: 'Acceso denegado' });
    res.json({ id: doc.id, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/compras/parsear-xml — Parsear XML DIAN sin guardar ────────────
// Recibe el contenido XML como string en req.body.xml
// Retorna cabecera + lineas para que el frontend muestre el paso de mapeo
router.post('/parsear-xml', async (req, res) => {
  try {
    const { xml } = req.body;
    if (!xml || !xml.trim()) {
      return res.status(400).json({ error: 'XML requerido' });
    }

    // Parser manual UBL 2.1 colombiano sin dependencias externas
    // Extrae valores con regex sobre el XML limpio
    const txt = xml.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const extraer = (tag, contenido = txt) => {
      const re = new RegExp(`<[^>]*:?${tag}[^>]*>([^<]*)<`, 'i');
      const m = contenido.match(re);
      return m ? m[1].trim() : '';
    };

    const extraerAtributo = (tag, attr, contenido = txt) => {
      const re = new RegExp(`<[^>]*:?${tag}[^\\s>]*[^>]*${attr}="([^"]*)"`, 'i');
      const m = contenido.match(re);
      return m ? m[1].trim() : '';
    };

    const extraerBloque = (tag, contenido = txt) => {
      const re = new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tag}>`, 'gi');
      const bloques = [];
      let m;
      while ((m = re.exec(contenido)) !== null) {
        bloques.push(m[1]);
      }
      return bloques;
    };

    // ── Cabecera ─────────────────────────────────────────────────────────────
    const numeroFactura = extraer('ID') || extraer('InvoiceID') || '';
    const fechaFactura  = extraer('IssueDate') || '';

    // NIT y nombre proveedor
    let nitProveedor  = '';
    let nombreProveedor = '';
    const bloqueProveedor = extraerBloque('AccountingSupplierParty');
    if (bloqueProveedor.length > 0) {
      nitProveedor    = extraer('CompanyID', bloqueProveedor[0]) || extraer('ID', bloqueProveedor[0]) || '';
      nombreProveedor = extraer('RegistrationName', bloqueProveedor[0]) || extraer('Name', bloqueProveedor[0]) || '';
    }

    // Totales globales
    const totalBruto     = parseFloat(extraer('LineExtensionAmount') || extraer('TaxExclusiveAmount') || '0') || 0;
    const totalIVAGlobal = (() => {
      const bloquesTax = extraerBloque('TaxTotal');
      let suma = 0;
      bloquesTax.forEach(b => {
        const v = parseFloat(extraer('TaxAmount', b) || '0');
        suma += v;
      });
      return suma;
    })();
    const netoPagarXML = parseFloat(extraer('PayableAmount') || '0') || 0;

    // ── Lineas de factura ────────────────────────────────────────────────────
    const bloquesLinea = extraerBloque('InvoiceLine');
    const lineas = bloquesLinea.map((bloque, idx) => {
      const cantidadStr = extraerAtributo('InvoicedQuantity', 'unitCode', bloque) || '';
      const cantidad    = parseFloat(extraer('InvoicedQuantity', bloque) || '1') || 1;
      const subtotal    = parseFloat(extraer('LineExtensionAmount', bloque) || '0') || 0;
      const descripcion = extraer('Description', bloque) || extraer('Name', bloque) || `Producto ${idx + 1}`;
      const precio      = parseFloat(extraer('PriceAmount', bloque) || String(subtotal / cantidad)) || 0;

      // IVA de la linea
      const bloqueTaxLinea = extraerBloque('TaxTotal', bloque);
      let ivaLinea = 0;
      if (bloqueTaxLinea.length > 0) {
        ivaLinea = parseFloat(extraer('TaxAmount', bloqueTaxLinea[0]) || '0') || 0;
      }

      return {
        idx,
        descripcionXML: descripcion,
        cantidad,
        precioUnitario: precio,
        subtotal,
        ivaVal: ivaLinea,
        productoId: null,
        productoNombre: '',
        mapeado: false
      };
    });

    res.json({
      ok: true,
      cabecera: {
        numeroFactura,
        fechaFactura,
        nitProveedor,
        nombreProveedor,
        totalBruto,
        totalIVA: totalIVAGlobal,
        netoPagarXML
      },
      lineas,
      totalLineas: lineas.length
    });
  } catch (e) {
    console.error('Error parsear XML:', e);
    res.status(500).json({ error: 'Error al parsear XML', detalle: e.message });
  }
});

// ─── POST /api/compras — Guardar borrador ────────────────────────────────────
// Guarda la compra en estado 'borrador' (antes de confirmar)
router.post('/', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const {
      proveedorId, proveedorNombre, proveedorNit,
      numeroFactura, fechaFactura,
      lineas, retenciones,
      subtotal, totalIVA, totalRetenciones, totalBruto, netoPagar,
      formaPago, cajaId, notas,
      origenXML, xmlNombre
    } = req.body;

    if (!lineas || lineas.length === 0) {
      return res.status(400).json({ error: 'Debe tener al menos una linea' });
    }
    if (!netoPagar || Number(netoPagar) <= 0) {
      return res.status(400).json({ error: 'Neto a pagar invalido' });
    }

    const numero = await genNumeroCompra(adminId);

    const nueva = {
      adminId,
      numero,
      proveedorId: proveedorId || '',
      proveedorNombre: proveedorNombre || '',
      proveedorNit: proveedorNit || '',
      numeroFactura: numeroFactura || '',
      fechaFactura: fechaFactura || new Date().toISOString().slice(0, 10),
      lineas: (lineas || []).map(l => ({
        descripcionXML: l.descripcionXML || '',
        productoId: l.productoId || null,
        productoNombre: l.productoNombre || '',
        cantidad: Number(l.cantidad) || 0,
        precioUnitario: Number(l.precioUnitario) || 0,
        subtotal: Number(l.subtotal) || 0,
        ivaVal: Number(l.ivaVal) || 0,
        mapeado: !!l.productoId
      })),
      retenciones: (retenciones || []).map(r => ({
        tipo: r.tipo || 'retefuente',
        base: Number(r.base) || 0,
        pct: Number(r.pct) || 0,
        valor: Number(r.valor) || 0
      })),
      subtotal: Number(subtotal) || 0,
      totalIVA: Number(totalIVA) || 0,
      totalRetenciones: Number(totalRetenciones) || 0,
      totalBruto: Number(totalBruto) || 0,
      netoPagar: Number(netoPagar),
      formaPago: formaPago || 'Contado',
      cajaId: cajaId || '',
      notas: notas || '',
      origenXML: !!origenXML,
      xmlNombre: xmlNombre || '',
      estado: 'borrador',
      egresoId: null,
      cxpId: null,
      creadoPor: req.user.email || req.user.nombre || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('compras').add(nueva);
    res.status(201).json({ id: ref.id, ...nueva });
  } catch (e) {
    console.error('POST compras:', e);
    res.status(500).json({ error: 'Error al guardar compra', detalle: e.message });
  }
});

// ─── PUT /api/compras/:id — Actualizar borrador ───────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const ref = db.collection('compras').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Compra no encontrada' });
    const data = doc.data();
    if (data.adminId !== adminId) return res.status(403).json({ error: 'Acceso denegado' });
    if (data.estado === 'confirmada') return res.status(400).json({ error: 'Compra ya confirmada. No se puede editar.' });

    const update = { ...req.body, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    // Proteger campos inmutables
    delete update.adminId; delete update.numero; delete update.estado;
    delete update.egresoId; delete update.cxpId; delete update.createdAt;

    await ref.update(update);
    res.json({ id: req.params.id, ...data, ...update });
  } catch (e) {
    console.error('PUT compras:', e);
    res.status(500).json({ error: 'Error al actualizar compra' });
  }
});

// ─── POST /api/compras/:id/confirmar — Confirmar y aplicar efectos ───────────
// Este es el endpoint crítico:
//   1. Valida que todas las lineas estén mapeadas
//   2. Aplica stock + precio de costo a productos
//   3. Crea egreso en finanzas
//   4. Crea CxP si no es pago de contado
//   5. Descuenta caja si pago de contado
//   6. Cambia estado a 'confirmada'
router.post('/:id/confirmar', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const ref = db.collection('compras').doc(req.params.id);
    const doc = await ref.get();

    if (!doc.exists) return res.status(404).json({ error: 'Compra no encontrada' });
    const compra = doc.data();
    if (compra.adminId !== adminId) return res.status(403).json({ error: 'Acceso denegado' });
    if (compra.estado === 'confirmada') return res.status(400).json({ error: 'Esta compra ya fue confirmada' });

    // Validar que todas las lineas esten mapeadas
    const sinMapear = (compra.lineas || []).filter(l => !l.productoId);
    if (sinMapear.length > 0) {
      return res.status(400).json({
        error: `Hay ${sinMapear.length} linea(s) sin mapear a producto. Debes asignar todos los productos antes de confirmar.`,
        lineasSinMapear: sinMapear.map(l => l.descripcionXML)
      });
    }

    // Validar caja si pago contado
    const esContado = !['credito', 'a credito', 'cuenta por pagar', 'cxp'].includes(
      (compra.formaPago || '').toLowerCase()
    );
    if (esContado && compra.cajaId) {
      const cajaDoc = await db.collection('cajas').doc(compra.cajaId).get();
      if (cajaDoc.exists) {
        const saldoCaja = Number(cajaDoc.data().saldo) || 0;
        if (saldoCaja < compra.netoPagar) {
          return res.status(400).json({
            error: `Saldo insuficiente en caja. Disponible: ${fmt(saldoCaja)} | Requerido: ${fmt(compra.netoPagar)}`
          });
        }
      }
    }

    // 1. Aplicar inventario
    const alertasMargen = await aplicarCompraAInventario(compra.lineas || []);

    // 2. Crear egreso
    const { db: dbRef } = require('../config/firebase');
    const numEgreso = `EGR-C-${compra.numero}`;

    const retenTotal = (compra.retenciones || []).reduce((s, r) => s + (Number(r.valor) || 0), 0);
    const retenPrincipal = (compra.retenciones || []).find(r => r.tipo === 'retefuente');

    const egresoData = {
      userId: adminId,
      numero: numEgreso,
      concepto: `Compra de Mercancia - Fact. ${compra.numeroFactura || compra.numero}`,
      proveedor: compra.proveedorNombre || '',
      proveedorId: compra.proveedorId || '',
      categoria: 'Compra de Mercancia',
      monto: Number(compra.totalBruto) || Number(compra.netoPagar),
      totalPagar: Number(compra.netoPagar),
      ivaVal: Number(compra.totalIVA) || 0,
      ivaPct: 0,
      retenVal: retenTotal,
      retenPct: retenPrincipal ? Number(retenPrincipal.pct) || 0 : 0,
      retenciones: compra.retenciones || [],
      formaPago: compra.formaPago || 'Contado',
      cajaId: compra.cajaId || '',
      fecha: compra.fechaFactura || new Date().toISOString().slice(0, 10),
      notas: compra.notas || '',
      productosCompra: (compra.lineas || []).map(l => ({
        productoId: l.productoId,
        nombre: l.productoNombre,
        cantidad: l.cantidad,
        precioUnitario: l.precioUnitario
      })),
      tipo: 'compra',
      origenCompraId: req.params.id,
      estado: esContado ? 'PAGADO' : 'PENDIENTE',
      cuadrado: true,
      creadoPor: req.user.email || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const egresoRef = await db.collection('egresos').add(egresoData);

    // 3. Descontar caja si contado
    if (esContado && compra.cajaId) {
      await db.collection('cajas').doc(compra.cajaId).update({
        saldo: admin.firestore.FieldValue.increment(-Number(compra.netoPagar)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('movimientos').add({
        userId: adminId,
        cajaId: compra.cajaId,
        tipo: 'egreso',
        concepto: `${numEgreso} - Compra ${compra.proveedorNombre || ''}`,
        monto: Number(compra.netoPagar),
        referencia: compra.numero,
        formaPago: compra.formaPago || 'Contado',
        creadoPor: req.user.email || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // 4. Confirmar la compra
    await ref.update({
      estado: 'confirmada',
      egresoId: egresoRef.id,
      confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await registrarAuditoria({
      accion: 'COMPRA_CONFIRMADA',
      modulo: 'compras',
      descripcion: `Compra ${compra.numero} confirmada - ${compra.proveedorNombre || ''} - ${fmt(compra.netoPagar)} - ${compra.lineas.length} producto(s)`,
      usuarioId: adminId,
      usuarioNombre: req.user.email || req.user.nombre || '',
      documento: compra.numero,
      datos: { egresoId: egresoRef.id, totalLineas: compra.lineas.length, netoPagar: compra.netoPagar }
    });

    res.json({
      ok: true,
      compraId: req.params.id,
      egresoId: egresoRef.id,
      alertasMargen,
      mensaje: `Compra ${compra.numero} confirmada. Inventario actualizado. Egreso ${numEgreso} creado.`
    });
  } catch (e) {
    console.error('POST confirmar compra:', e);
    res.status(500).json({ error: 'Error al confirmar compra', detalle: e.message });
  }
});

// ─── DELETE /api/compras/:id — Eliminar borrador ─────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const ref = db.collection('compras').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Compra no encontrada' });
    const data = doc.data();
    if (data.adminId !== adminId) return res.status(403).json({ error: 'Acceso denegado' });
    if (data.estado === 'confirmada') return res.status(400).json({ error: 'No se puede eliminar una compra confirmada' });
    await ref.delete();
    res.json({ ok: true, mensaje: 'Borrador eliminado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
