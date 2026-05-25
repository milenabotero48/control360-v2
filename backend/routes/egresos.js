const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

const registrarAuditoria = async (datos) => {
  try {
    await db.collection('audit_logs').add({
      ...datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

const genNumero = async (userId) => {
  const snap = await db.collection('egresos').where('userId', '==', userId).get();
  return `EGR-${String(snap.size + 1).padStart(4, '0')}`;
};

// ─── HELPER: actualizar stock e inventario al comprar mercancía ───────────────
const actualizarInventarioCompra = async (productosCompra) => {
  const alertas = [];
  for (const item of productosCompra) {
    if (!item.productoId || !item.cantidad || item.cantidad <= 0) continue;
    try {
      const prodRef = db.collection('products').doc(item.productoId);
      const prodDoc = await prodRef.get();
      if (!prodDoc.exists) continue;
      const prod = prodDoc.data();

      const costoPrevio = prod.precioCosto || 0;
      const costoNuevo = Number(item.precioUnitario) || 0;
      const cantidadComprada = Number(item.cantidad);

      // Actualizar stock y precio costo
      const update = {
        stock: admin.firestore.FieldValue.increment(cantidadComprada),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (costoNuevo > 0 && costoNuevo !== costoPrevio) {
        update.precioCosto = costoNuevo;
        // Calcular nuevo margen
        const precioVenta = prod.precioVenta || 0;
        const margenPrevio = costoPrevio > 0 ? (((precioVenta - costoPrevio) / precioVenta) * 100).toFixed(1) : 0;
        const margenNuevo = costoNuevo > 0 ? (((precioVenta - costoNuevo) / precioVenta) * 100).toFixed(1) : 0;
        if (Number(margenNuevo) < Number(margenPrevio)) {
          alertas.push({
            productoId: item.productoId,
            nombre: prod.nombre,
            precioVenta,
            costoPrevio,
            costoNuevo,
            margenPrevio,
            margenNuevo
          });
        }
      }
      await prodRef.update(update);
    } catch (e) { console.warn('Error actualizando inventario compra:', item.productoId, e.message); }
  }
  return alertas;
};

// ─── GET /api/egresos ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection('egresos')
      .where('userId', '==', req.adminId || req.user.uid)
      .get();
    const egresos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    egresos.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    res.json(egresos);
  } catch (e) {
    console.error('GET egresos:', e);
    res.status(500).json({ error: 'Error al obtener egresos', detalle: e.message });
  }
});

// ─── POST /api/egresos ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { concepto, proveedor, categoria, monto, totalPagar, ivaVal, ivaPct, retenVal, retenPct,
            formaPago, cajaId, empresaId, fecha, notas, pagarAhora, productosCompra } = req.body;
    if (!concepto?.trim()) return res.status(400).json({ error: 'Concepto requerido' });
    if (!monto || Number(monto) <= 0) return res.status(400).json({ error: 'Monto inválido' });

    const numero = await genNumero(req.adminId || req.user.uid);

    const nuevo = {
      userId: req.adminId || req.user.uid,
      numero,
      concepto: concepto.trim(),
      proveedor: proveedor || '',
      categoria: categoria || 'Otros',
      monto: Number(monto),
      totalPagar: Number(totalPagar) || Number(monto),
      ivaVal: Number(ivaVal) || 0,
      ivaPct: Number(ivaPct) || 0,
      retenVal: Number(retenVal) || 0,
      retenPct: Number(retenPct) || 0,
      formaPago: formaPago || '',
      cajaId: cajaId || '',
      empresaId: empresaId || '',
      fecha: fecha || new Date().toISOString().slice(0, 10),
      notas: notas || '',
      productosCompra: productosCompra || [],
      estado: pagarAhora ? 'PAGADO' : 'PENDIENTE',
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('egresos').add(nuevo);

    // Si paga ahora → descontar de caja
    if (pagarAhora && cajaId) {
      const totalAPagar = Number(totalPagar) || Number(monto);
      const cajaRef = db.collection('cajas').doc(cajaId);
      await cajaRef.update({
        saldo: admin.firestore.FieldValue.increment(-totalAPagar),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('movimientos').add({
        userId: req.adminId || req.user.uid, cajaId,
        tipo: 'egreso', concepto: `${numero} — ${concepto}`,
        monto: totalAPagar, formaPago: formaPago || '',
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Si es compra de mercancía → actualizar inventario
    let alertasMargen = [];
    if (categoria === 'Compra de Mercancia' && productosCompra?.length > 0) {
      alertasMargen = await actualizarInventarioCompra(productosCompra);
    }

    await registrarAuditoria({
      accion: 'EGRESO_CREADO', modulo: 'egresos',
      descripcion: `Egreso ${numero} creado: ${concepto} - $${monto}`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email
    });

    res.status(201).json({ id: ref.id, ...nuevo, alertasMargen });
  } catch (e) {
    console.error('POST egresos:', e);
    res.status(500).json({ error: 'Error al crear egreso' });
  }
});

// ─── PUT /api/egresos/:id — Editar egreso PENDIENTE ──────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const ref = db.collection('egresos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Egreso no encontrado' });

    const egreso = doc.data();
    if (egreso.estado === 'PAGADO') {
      return res.status(400).json({ error: 'Egreso pagado. Usa /editar-pagado con contraseña admin.' });
    }

    const update = {
      ...req.body,
      monto: Number(req.body.monto),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    delete update.userId; delete update.estado; delete update.numero;

    await ref.update(update);
    res.json({ id: req.params.id, ...egreso, ...update });
  } catch (e) {
    console.error('PUT egresos:', e);
    res.status(500).json({ error: 'Error al editar egreso' });
  }
});

// ─── POST /api/egresos/:id/pagar ──────────────────────────────────────────────
router.post('/:id/pagar', async (req, res) => {
  try {
    const { cajaId, formaPago } = req.body;
    if (!cajaId) return res.status(400).json({ error: 'Caja requerida' });

    const egresoRef = db.collection('egresos').doc(req.params.id);
    const egresoDoc = await egresoRef.get();
    if (!egresoDoc.exists) return res.status(404).json({ error: 'Egreso no encontrado' });

    const egreso = egresoDoc.data();
    if (egreso.estado === 'PAGADO') return res.status(400).json({ error: 'Ya está pagado' });

    const cajaRef = db.collection('cajas').doc(cajaId);
    const cajaDoc = await cajaRef.get();
    if (!cajaDoc.exists) return res.status(404).json({ error: 'Caja no encontrada' });

    const caja = cajaDoc.data();
    const totalAPagar = Number(egreso.totalPagar) || Number(egreso.monto) || 0;

    if (Number(caja.saldo) < totalAPagar) {
      return res.status(400).json({ error: `Saldo insuficiente en caja. Disponible: ${fmt(caja.saldo)}` });
    }

    const batch = db.batch();

    batch.update(egresoRef, {
      estado: 'PAGADO',
      cajaId,
      formaPago,
      pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
      pagadoPor: req.user.email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    batch.update(cajaRef, {
      saldo: admin.firestore.FieldValue.increment(-totalAPagar),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    await db.collection('movimientos').add({
      userId: req.adminId || req.user.uid,
      cajaId,
      tipo: 'egreso',
      concepto: `Pago ${egreso.numero}: ${egreso.concepto}`,
      monto: totalAPagar,
      referencia: egreso.numero,
      egresoId: req.params.id,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await registrarAuditoria({
      accion: 'EGRESO_PAGADO', modulo: 'egresos',
      descripcion: `${egreso.numero} pagado $${totalAPagar} desde caja "${caja.nombre}"`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      datos: { egresoId: req.params.id, cajaId, monto: totalAPagar }
    });

    res.json({ ok: true, nuevoSaldoCaja: Number(caja.saldo) - totalAPagar });
  } catch (e) {
    console.error('POST pagar egreso:', e);
    res.status(500).json({ error: 'Error al pagar egreso' });
  }
});

// ─── POST /api/egresos/:id/editar-pagado ─────────────────────────────────────
// Requiere contraseña admin — genera auditoría crítica
router.post('/:id/editar-pagado', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el admin puede editar egresos pagados' });

    const { motivoEdicion, concepto, proveedor, categoria, monto, formaPago, cajaId, notas } = req.body;
    if (!motivoEdicion?.trim()) return res.status(400).json({ error: 'Motivo de edición requerido' });

    const ref = db.collection('egresos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Egreso no encontrado' });

    const egresoAnterior = doc.data();
    const montoAnterior = Number(egresoAnterior.monto);
    const montoNuevo = Number(monto) || montoAnterior;

    const update = {
      concepto: concepto || egresoAnterior.concepto,
      proveedor: proveedor || egresoAnterior.proveedor,
      categoria: categoria || egresoAnterior.categoria,
      monto: montoNuevo,
      formaPago: formaPago || egresoAnterior.formaPago,
      cajaId: cajaId || egresoAnterior.cajaId,
      notas: notas || egresoAnterior.notas,
      motivoEdicion,
      editadoPor: req.user.email,
      editadoEn: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await ref.update(update);

    // Si cambió el monto o la caja, ajustar saldos
    const cajaIdFinal = cajaId || egresoAnterior.cajaId;
    if (cajaIdFinal) {
      if (cajaId && cajaId !== egresoAnterior.cajaId) {
        // Cambió de caja: devolver a caja anterior, descontar de nueva
        const [cajaAnteriorDoc, cajaNuevaDoc] = await Promise.all([
          db.collection('cajas').doc(egresoAnterior.cajaId).get(),
          db.collection('cajas').doc(cajaId).get()
        ]);
        const batch = db.batch();
        if (cajaAnteriorDoc.exists) {
          batch.update(db.collection('cajas').doc(egresoAnterior.cajaId), {
            saldo: Number(cajaAnteriorDoc.data().saldo) + montoAnterior
          });
        }
        if (cajaNuevaDoc.exists) {
          batch.update(db.collection('cajas').doc(cajaId), {
            saldo: Number(cajaNuevaDoc.data().saldo) - montoNuevo
          });
        }
        await batch.commit();
      } else if (montoNuevo !== montoAnterior) {
        // Misma caja, distinto monto: ajustar diferencia
        const cajaDoc = await db.collection('cajas').doc(cajaIdFinal).get();
        if (cajaDoc.exists) {
          const diferencia = montoAnterior - montoNuevo; // positivo = devuelve, negativo = descuenta más
          await db.collection('cajas').doc(cajaIdFinal).update({
            saldo: Number(cajaDoc.data().saldo) + diferencia
          });
        }
      }
    }

    // Auditoría crítica
    await registrarAuditoria({
      accion: 'EGRESO_PAGADO_EDITADO_CRITICO', modulo: 'egresos',
      descripcion: `EDICIÓN CRÍTICA: ${egresoAnterior.numero} editado por admin. Motivo: ${motivoEdicion}`,
      usuarioId: req.adminId || req.user.uid, usuarioNombre: req.user.email,
      datos: {
        egresoId: req.params.id,
        numero: egresoAnterior.numero,
        anterior: { concepto: egresoAnterior.concepto, monto: montoAnterior, categoria: egresoAnterior.categoria },
        nuevo: { concepto, monto: montoNuevo, categoria },
        motivoEdicion
      }
    });

    res.json({ ok: true, id: req.params.id, ...update });
  } catch (e) {
    console.error('POST editar-pagado:', e);
    res.status(500).json({ error: 'Error al editar egreso pagado' });
  }
});

module.exports = router;
