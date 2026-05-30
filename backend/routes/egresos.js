const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

// ─────────────────────────────────────────────────────────────────────────────
// Cambios Ola 1 sobre el original:
//   1) Campo nuevo `numeroOrdenInterna` en egresos → permite a orders.js
//      bloquear el cierre de una OI hasta tener su egreso definitivo.
//   2) Endpoint POST /api/egresos/:id/cuadrar-definitivo:
//        Reemplaza el provisional por el definitivo (con factura y vuelto).
//        Exige PIN del usuario logueado (Admin/Tesorería).
//        Devuelve a caja el vuelto, ajusta el total a lo realmente pagado,
//        adjunta soporte y marca el egreso como tipo: 'definitivo', estado:'PAGADO'.
//   3) GET /api/egresos/provisionales-pendientes — alerta del fin del día.
//   4) Aislamiento por adminId en todas las consultas (consistente).
//   5) Auditoría con campo `documento` para que el log filtrable lo capture.
// ─────────────────────────────────────────────────────────────────────────────

const registrarAuditoria = async (datos) => {
  try {
    await db.collection('audit_logs').add({
      ...datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

const verificarPinUsuario = async (uid, pin) => {
  if (!pin) return { ok: false, error: 'PIN requerido' };
  if (!uid) return { ok: false, error: 'Sesión inválida' };
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) return { ok: false, error: 'Usuario no encontrado' };
  const u = doc.data();
  if (u.role !== 'admin' && u.role !== 'tesoreria') {
    return { ok: false, error: 'Tu rol no puede autorizar esta acción' };
  }
  if (!u.pin) return { ok: false, error: 'No tienes PIN configurado' };
  if (String(u.pin) !== String(pin)) return { ok: false, error: 'PIN incorrecto' };
  return { ok: true };
};

// ─── HELPER: generar número de egreso (ATÓMICO con transacción) ─────────────
// Ola 2: protege contra colisiones cuando varios usuarios crean egresos
// simultáneamente. Mismo patrón que orders.js — contador en colección
// 'counters' incrementado dentro de una transacción Firestore.
const genNumero = async (userId) => {
  if (!userId) throw new Error('genNumero requiere userId');

  const counterRef = db.collection('counters').doc(`${userId}_egresos`);

  // Inicializar si es la primera vez (lee max histórico una sola vez)
  const counterDoc = await counterRef.get();
  if (!counterDoc.exists) {
    const snap = await db.collection('egresos')
      .where('userId', '==', userId)
      .get();
    let maximo = 0;
    snap.forEach(d => {
      const num = parseInt((d.data().numero || '').replace(/\D/g, '').slice(-4));
      if (!isNaN(num) && num > maximo) maximo = num;
    });
    await counterRef.set({
      value: maximo,
      tipo: 'egresos',
      adminId: userId,
      inicializado: true,
      inicializadoEn: new Date().toISOString()
    });
  }

  // Incremento atómico
  const siguiente = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef);
    const actual = doc.exists ? (Number(doc.data().value) || 0) : 0;
    const nuevo = actual + 1;
    tx.set(counterRef, {
      value: nuevo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return nuevo;
  });

  return `EGR-${String(siguiente).padStart(4, '0')}`;
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

      const update = {
        stock: admin.firestore.FieldValue.increment(cantidadComprada),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (costoNuevo > 0 && costoNuevo !== costoPrevio) {
        update.precioCosto = costoNuevo;
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

// ─── GET /api/egresos/provisionales-pendientes ───────────────────────────────
// Para la alerta de fin de día (R-03-02): egresos provisionales sin cuadrar.
router.get('/provisionales-pendientes', async (req, res) => {
  try {
    const snap = await db.collection('egresos')
      .where('userId', '==', req.adminId || req.user.uid)
      .where('tipo', '==', 'provisional')
      .where('cuadrado', '==', false)
      .get();
    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ total: lista.length, egresos: lista });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/egresos ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      concepto, proveedor, categoria, monto, totalPagar, ivaVal, ivaPct, retenVal, retenPct,
      formaPago, cajaId, empresaId, fecha, notas, pagarAhora, productosCompra,
      tipo, mensajeroId, mensajeroNombre, numeroOrdenInterna, cuadrado
    } = req.body;

    if (!concepto?.trim()) return res.status(400).json({ error: 'Concepto requerido' });
    if (!monto || Number(monto) <= 0) return res.status(400).json({ error: 'Monto inválido' });

    const numero = await genNumero(req.adminId || req.user.uid);
    const esProvisional = tipo === 'provisional';

    const nuevo = {
      userId: req.adminId || req.user.uid,
      numero,
      concepto: concepto.trim(),
      proveedor: proveedor || '',
      categoria: categoria || (esProvisional ? 'Provisional' : 'Otros'),
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
      // Campos provisional / orden interna
      tipo: esProvisional ? 'provisional' : (tipo || 'normal'),
      cuadrado: esProvisional ? (cuadrado === true ? true : false) : true,
      mensajeroId: mensajeroId || '',
      mensajeroNombre: mensajeroNombre || '',
      numeroOrdenInterna: numeroOrdenInterna || '',
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
        tipo: 'egreso',
        concepto: `${numero} — ${concepto}`,
        monto: totalAPagar,
        referencia: numeroOrdenInterna ? `${numero} · ${numeroOrdenInterna}` : numero,
        formaPago: formaPago || '',
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    let alertasMargen = [];
    if (categoria === 'Compra de Mercancia' && productosCompra?.length > 0) {
      alertasMargen = await actualizarInventarioCompra(productosCompra);
    }

    await registrarAuditoria({
      accion: esProvisional ? 'EGRESO_PROVISIONAL_CREADO' : 'EGRESO_CREADO',
      modulo: 'egresos',
      descripcion: `${esProvisional ? 'Egreso provisional' : 'Egreso'} ${numero}: ${concepto} - ${fmt(monto)}${numeroOrdenInterna ? ' · OI ' + numeroOrdenInterna : ''}`,
      usuarioId: req.adminId || req.user.uid,
      usuarioNombre: req.user.email,
      documento: numero
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
      return res.status(400).json({ error: 'Egreso pagado. Usa /editar-pagado con PIN admin.' });
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
      accion: 'EGRESO_PAGADO',
      modulo: 'egresos',
      descripcion: `${egreso.numero} pagado ${fmt(totalAPagar)} desde caja "${caja.nombre}"`,
      usuarioId: req.adminId || req.user.uid,
      usuarioNombre: req.user.email,
      documento: egreso.numero,
      datos: { egresoId: req.params.id, cajaId, monto: totalAPagar }
    });

    res.json({ ok: true, nuevoSaldoCaja: Number(caja.saldo) - totalAPagar });
  } catch (e) {
    console.error('POST pagar egreso:', e);
    res.status(500).json({ error: 'Error al pagar egreso' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/egresos/:provisionalId/cuadrar-definitivo
// ─────────────────────────────────────────────────────────────────────────────
// Cuadre del egreso provisional de una Orden Interna:
//   - Reemplaza el provisional por el egreso definitivo.
//   - Ajusta el valor real pagado (puede ser igual, menor o mayor).
//   - Si hay vuelto positivo (base > valor real) → suma el vuelto a caja.
//   - Si el valor real fue mayor a la base → descuenta la diferencia de caja.
//   - Requiere PIN (Admin/Tesorería).
//   - Marca el provisional como `cuadrado: true` y crea el definitivo
//     vinculado a la misma OI.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/:provisionalId/cuadrar-definitivo', async (req, res) => {
  try {
    const { pin, valorReal, facturaAdjunta, proveedor, notas, cajaId, formaPago } = req.body;

    const verif = await verificarPinUsuario(req.user.uid || req.user.id, pin);
    if (!verif.ok) return res.status(403).json({ error: verif.error });

    const provisionalRef = db.collection('egresos').doc(req.params.provisionalId);
    const provDoc = await provisionalRef.get();
    if (!provDoc.exists) return res.status(404).json({ error: 'Egreso provisional no encontrado' });

    const provisional = provDoc.data();
    if (provisional.tipo !== 'provisional') {
      return res.status(400).json({ error: 'Este egreso no es provisional' });
    }
    if (provisional.cuadrado === true) {
      return res.status(400).json({ error: 'Este provisional ya fue cuadrado' });
    }
    if (!provisional.numeroOrdenInterna) {
      return res.status(400).json({ error: 'El provisional no tiene Orden Interna asociada' });
    }

    const base = Number(provisional.monto) || 0;
    const real = Number(valorReal);
    if (isNaN(real) || real < 0) {
      return res.status(400).json({ error: 'Valor real inválido' });
    }
    const diferencia = base - real; // positiva = vuelto, negativa = falta

    const cajaIdFinal = cajaId || provisional.cajaId;
    if (!cajaIdFinal) return res.status(400).json({ error: 'Caja requerida para el cuadre' });

    const cajaRef = db.collection('cajas').doc(cajaIdFinal);
    const cajaDoc = await cajaRef.get();
    if (!cajaDoc.exists) return res.status(404).json({ error: 'Caja no encontrada' });

    const batch = db.batch();

    // 1) Crear egreso definitivo (estado PAGADO desde el inicio)
    const numero = await genNumero(req.adminId || req.user.uid);
    const definitivoRef = db.collection('egresos').doc();
    batch.set(definitivoRef, {
      userId: req.adminId || req.user.uid,
      numero,
      concepto: `Cuadre OI ${provisional.numeroOrdenInterna} — ${provisional.concepto}`,
      proveedor: proveedor || provisional.proveedor || '',
      categoria: provisional.categoria || 'Orden Interna',
      monto: real,
      totalPagar: real,
      ivaVal: 0, ivaPct: 0, retenVal: 0, retenPct: 0,
      formaPago: formaPago || provisional.formaPago || '',
      cajaId: cajaIdFinal,
      empresaId: provisional.empresaId || '',
      fecha: new Date().toISOString().slice(0, 10),
      notas: notas || '',
      facturaAdjunta: facturaAdjunta || '',
      tipo: 'definitivo',
      cuadrado: true,
      mensajeroId: provisional.mensajeroId || '',
      mensajeroNombre: provisional.mensajeroNombre || '',
      numeroOrdenInterna: provisional.numeroOrdenInterna,
      provisionalId: req.params.provisionalId,
      estado: 'PAGADO',
      creadoPor: req.user.email,
      pagadoPor: req.user.email,
      pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2) Marcar el provisional como cuadrado y referenciar el definitivo
    batch.update(provisionalRef, {
      cuadrado: true,
      definitivoId: definitivoRef.id,
      definitivoNumero: numero,
      cuadradoEn: new Date().toISOString(),
      cuadradoPor: req.user.email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3) Ajustar caja según diferencia (vuelto o gasto adicional)
    if (diferencia !== 0) {
      batch.update(cajaRef, {
        saldo: admin.firestore.FieldValue.increment(diferencia),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();

    // 4) Movimiento de caja: documentar el ajuste real
    if (diferencia > 0) {
      await db.collection('movimientos').add({
        userId: req.adminId || req.user.uid,
        cajaId: cajaIdFinal, tipo: 'ingreso',
        concepto: `Vuelto OI ${provisional.numeroOrdenInterna} (cuadre ${numero})`,
        monto: diferencia,
        referencia: `${numero} · ${provisional.numeroOrdenInterna}`,
        egresoId: definitivoRef.id,
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else if (diferencia < 0) {
      await db.collection('movimientos').add({
        userId: req.adminId || req.user.uid,
        cajaId: cajaIdFinal, tipo: 'egreso',
        concepto: `Diferencia adicional OI ${provisional.numeroOrdenInterna} (cuadre ${numero})`,
        monto: Math.abs(diferencia),
        referencia: `${numero} · ${provisional.numeroOrdenInterna}`,
        egresoId: definitivoRef.id,
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await registrarAuditoria({
      accion: 'EGRESO_PROVISIONAL_CUADRADO',
      modulo: 'egresos',
      descripcion: `Cuadre OI ${provisional.numeroOrdenInterna}: base ${fmt(base)} → real ${fmt(real)} (${diferencia >= 0 ? 'vuelto ' + fmt(diferencia) : 'gasto adicional ' + fmt(Math.abs(diferencia))})`,
      usuarioId: req.adminId || req.user.uid,
      usuarioNombre: req.user.email,
      documento: provisional.numeroOrdenInterna,
      datos: { provisionalId: req.params.provisionalId, definitivoId: definitivoRef.id, base, real, diferencia }
    });

    res.json({
      ok: true,
      provisionalId: req.params.provisionalId,
      definitivoId: definitivoRef.id,
      definitivoNumero: numero,
      base, real, diferencia
    });
  } catch (e) {
    console.error('POST cuadrar-definitivo:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/egresos/:id/editar-pagado ─────────────────────────────────────
// Requiere rol admin + PIN — genera auditoría crítica
router.post('/:id/editar-pagado', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el admin puede editar egresos pagados' });

    const { pin, motivoEdicion, concepto, proveedor, categoria, monto, formaPago, cajaId, notas } = req.body;
    if (!motivoEdicion?.trim()) return res.status(400).json({ error: 'Motivo de edición requerido' });

    // Exigir PIN — acción sensible
    const verif = await verificarPinUsuario(req.user.uid || req.user.id, pin);
    if (!verif.ok) return res.status(403).json({ error: verif.error });

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

    const cajaIdFinal = cajaId || egresoAnterior.cajaId;
    if (cajaIdFinal) {
      if (cajaId && cajaId !== egresoAnterior.cajaId) {
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
        const cajaDoc = await db.collection('cajas').doc(cajaIdFinal).get();
        if (cajaDoc.exists) {
          const diferencia = montoAnterior - montoNuevo;
          await db.collection('cajas').doc(cajaIdFinal).update({
            saldo: Number(cajaDoc.data().saldo) + diferencia
          });
        }
      }
    }

    await registrarAuditoria({
      accion: 'EGRESO_PAGADO_EDITADO_CRITICO',
      modulo: 'egresos',
      descripcion: `EDICIÓN CRÍTICA: ${egresoAnterior.numero} editado por ${req.user.email}. Motivo: ${motivoEdicion}`,
      usuarioId: req.adminId || req.user.uid,
      usuarioNombre: req.user.email,
      documento: egresoAnterior.numero,
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
