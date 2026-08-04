const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
// ✅ FIX FECHA-CO-001: la fecha del egreso siempre en día Colombia. Antes se
// usaba toISOString() (UTC): todo egreso digitado después de las 7 pm quedaba
// con fecha del DÍA SIGUIENTE (causa real del reporte de fechas corridas).
const { hoyEnCO } = require('./_helpers');
// FIX PIN-UNICO-001: la autorizacion por PIN ya no vive aqui. Fuente unica de
// verdad en routes/_autorizacion.js (matriz accion -> roles).
const { verificarPin } = require('./_autorizacion');
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

// FIX PIN-UNICO-001: wrapper delgado sobre el verificador compartido.
// Se conserva el MISMO nombre y el MISMO contrato de retorno ({ ok, error })
// para no tocar ninguna llamada existente. Lo unico nuevo es el 3er parametro
// `accion`, que aplica la matriz de roles de _autorizacion.js.
const verificarPinUsuario = (uid, pin, accion = null) => verificarPin(uid, pin, accion);

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

// ══════════════════════════════════════════════════════════════════════════════
// FIX INV-KARDEX-001: motor del Kardex. La compra rápida por egreso es el sexto
// y último punto donde el stock se movía sin dejar rastro. Lógica de control y
// alertas de margen intactas; solo cambia la escritura del stock.
// ══════════════════════════════════════════════════════════════════════════════
const ledger = require('../services/inventoryLedger');

// ─── HELPER: actualizar stock e inventario al comprar mercancía ───────────────
const actualizarInventarioCompra = async (productosCompra, egreso = {}, usuario = {}) => {
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

      // ✅ INV-KARDEX-001: el stock sale de este update y pasa al ledger.
      const update = {
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

      // ✅ INV-KARDEX-001
      await ledger.registrarMovimiento({
        productoId: item.productoId,
        tipo: ledger.TIPOS.ENTRADA_COMPRA,
        cantidad: cantidadComprada,
        origenTipo: 'egreso', origenId: egreso.id || null,
        origenNumero: egreso.numero || null,
        proveedorNombre: egreso.beneficiario || null,
        usuarioId: usuario.id || null,
        usuarioNombre: usuario.nombre || null,
        costoUnitario: costoNuevo > 0 ? costoNuevo : null,
        motivo: egreso.concepto ? `Compra por egreso: ${egreso.concepto}` : 'Compra registrada por egreso'
      });
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
    // ✅ EGRESO-PROV-001: doble filtro — cuadrado (Ola 2) y legalizado (Ola 4)
    const lista = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(e => e.legalizado !== true && e.anulado !== true);
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
      tipo, mensajeroId, mensajeroNombre, numeroOrdenInterna, cuadrado,
      // ✅ EGRESO-PROV-001: legalización de anticipo desde el egreso normal
      provisionalId, pin
    } = req.body;

    if (!concepto?.trim()) return res.status(400).json({ error: 'Concepto requerido' });
    if (!monto || Number(monto) <= 0) return res.status(400).json({ error: 'Monto inválido' });

    // ══════════════════════════════════════════════════════════════════════
    // ✅ EGRESO-PROV-001 — LEGALIZACIÓN DE ANTICIPO
    // ──────────────────────────────────────────────────────────────────────
    // El egreso provisional es un ANTICIPO al mensajero, no un gasto. Cuando
    // vuelve con la factura real, se registra un egreso NORMAL (con IVA y
    // retención, formulario completo) y se marca forma de pago "Legalizar
    // comprobante provisional". Aquí:
    //   - la plata NO vuelve a salir de caja (ya salió al dar el anticipo)
    //   - solo se mueve la DIFERENCIA: vuelto a caja o salida adicional
    //   - el provisional queda cerrado y enlazado, nunca se borra
    // ══════════════════════════════════════════════════════════════════════
    const esLegalizacion = !!provisionalId;
    let prov = null, provRef = null, baseAnticipo = 0, diferenciaLegal = 0;

    if (esLegalizacion) {
      const verifLeg = await verificarPinUsuario(req.user.uid || req.user.id, pin, 'cuadrar_egreso');
      if (!verifLeg.ok) return res.status(403).json({ error: verifLeg.error, codigo: verifLeg.codigo });

      provRef = db.collection('egresos').doc(provisionalId);
      const provDoc = await provRef.get();
      if (!provDoc.exists) return res.status(404).json({ error: 'Comprobante provisional no encontrado' });

      prov = provDoc.data();
      if (prov.userId !== (req.adminId || req.user.uid)) {
        return res.status(403).json({ error: 'Comprobante provisional de otra empresa' });
      }
      if (prov.tipo !== 'provisional') {
        return res.status(400).json({ error: 'El comprobante seleccionado no es provisional' });
      }
      if (prov.legalizado === true || prov.cuadrado === true) {
        return res.status(400).json({ error: `El comprobante ${prov.numero} ya fue legalizado` });
      }
      if (prov.anulado === true) {
        return res.status(400).json({ error: `El comprobante ${prov.numero} está anulado` });
      }

      baseAnticipo   = Number(prov.totalPagar || prov.monto) || 0;
      const realLegal = Number(totalPagar) || Number(monto);
      diferenciaLegal = baseAnticipo - realLegal; // >0 vuelto · <0 falta plata

      if (!(cajaId || prov.cajaId)) {
        return res.status(400).json({ error: 'Caja requerida para ajustar la diferencia del anticipo' });
      }
    }

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
      // ✅ EGRESO-PROV-001: al legalizar, hereda la caja del anticipo si no se eligió otra
      cajaId: cajaId || (esLegalizacion ? (prov.cajaId || '') : ''),
      empresaId: empresaId || (esLegalizacion ? (prov.empresaId || '') : ''),
      fecha: fecha || hoyEnCO(), // ✅ FIX FECHA-CO-001
      notas: notas || '',
      productosCompra: productosCompra || [],
      // Campos provisional / orden interna
      tipo: esProvisional ? 'provisional' : (tipo || 'normal'),
      cuadrado: esProvisional ? (cuadrado === true ? true : false) : true,
      // ✅ EGRESO-PROV-001: el anticipo nace SIN legalizar
      legalizado: esProvisional ? false : true,
      mensajeroId: mensajeroId || '',
      mensajeroNombre: mensajeroNombre || '',
      numeroOrdenInterna: numeroOrdenInterna || '',
      // ✅ EGRESO-PROV-001: enlace al anticipo que este egreso legaliza
      legalizaProvisionalId: esLegalizacion ? provisionalId : '',
      legalizaProvisionalNumero: esLegalizacion ? (prov.numero || '') : '',
      // ✅ EGRESO-PROV-001: estado propio del anticipo. NO es 'PENDIENTE'
      // (la plata ya salió de caja) ni 'PAGADO' (no es gasto todavía).
      // Este estado lo excluye del ERI y del dashboard, y bloquea el botón Pagar.
      estado: esProvisional ? 'ANTICIPO' : ((pagarAhora || esLegalizacion) ? 'PAGADO' : 'PENDIENTE'),
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('egresos').add(nuevo);

    // ✅ EGRESO-PROV-001: en una LEGALIZACIÓN la plata NO sale otra vez.
    // Solo se ajusta la diferencia contra la caja elegida.
    if (esLegalizacion) {
      const cajaIdFinal = cajaId || prov.cajaId;
      const cajaRefLeg  = db.collection('cajas').doc(cajaIdFinal);

      if (diferenciaLegal !== 0) {
        await cajaRefLeg.update({
          saldo: admin.firestore.FieldValue.increment(diferenciaLegal),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await db.collection('movimientos').add({
          userId: req.adminId || req.user.uid,
          cajaId: cajaIdFinal,
          tipo: diferenciaLegal > 0 ? 'ingreso' : 'egreso',
          concepto: diferenciaLegal > 0
            ? `Reintegro (vuelto) anticipo ${prov.numero} — legaliza ${numero}`
            : `Diferencia adicional anticipo ${prov.numero} — legaliza ${numero}`,
          monto: Math.abs(diferenciaLegal),
          referencia: `${numero} · ${prov.numero}`,
          egresoId: ref.id,
          formaPago: formaPago || prov.formaPago || '',
          creadoPor: req.user.email,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Cerrar el anticipo: nunca se borra, queda enlazado y con trazabilidad.
      await provRef.update({
        legalizado: true,
        cuadrado: true,
        egresoDefinitivoId: ref.id,
        egresoDefinitivoNumero: numero,
        definitivoId: ref.id,          // compatibilidad con Ola 2
        definitivoNumero: numero,      // compatibilidad con Ola 2
        legalizadoEn: new Date().toISOString(),
        legalizadoPor: req.user.email,
        cuadradoEn: new Date().toISOString(),
        cuadradoPor: req.user.email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await registrarAuditoria({
        accion: 'EGRESO_PROVISIONAL_LEGALIZADO',
        modulo: 'egresos',
        descripcion: `${numero} legaliza el anticipo ${prov.numero}: base ${fmt(baseAnticipo)} → real ${fmt(Number(totalPagar) || Number(monto))} (${diferenciaLegal >= 0 ? 'vuelto ' + fmt(diferenciaLegal) : 'gasto adicional ' + fmt(Math.abs(diferenciaLegal))})`,
        usuarioId: req.adminId || req.user.uid,
        usuarioNombre: req.user.email,
        documento: numero,
        datos: { provisionalId, definitivoId: ref.id, base: baseAnticipo, real: Number(totalPagar) || Number(monto), diferencia: diferenciaLegal }
      });
    }
    // Si paga ahora O es provisional → descontar de caja
    // Provisionales: el dinero sale físicamente de caja al dárselo al mensajero
    else if ((pagarAhora || esProvisional) && cajaId) {
      const totalAPagar = Number(totalPagar) || Number(monto);
      const cajaRef = db.collection('cajas').doc(cajaId);
      await cajaRef.update({
        saldo: admin.firestore.FieldValue.increment(-totalAPagar),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('movimientos').add({
        userId: req.adminId || req.user.uid, cajaId,
        tipo: 'egreso',
        concepto: esProvisional ? `Provisional ${numero} — ${concepto}` : `${numero} — ${concepto}`,
        monto: totalAPagar,
        referencia: numeroOrdenInterna ? `${numero} · ${numeroOrdenInterna}` : numero,
        formaPago: formaPago || '',
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    let alertasMargen = [];
    if (categoria === 'Compra de Mercancia' && productosCompra?.length > 0) {
      // ✅ INV-KARDEX-001: contexto del egreso para el kardex.
      alertasMargen = await actualizarInventarioCompra(
        productosCompra,
        { numero, concepto, beneficiario: proveedor },
        { id: req.adminId || req.user.uid, nombre: req.user.nombre || req.user.email }
      );
    }

    await registrarAuditoria({
      accion: esProvisional ? 'EGRESO_PROVISIONAL_CREADO' : 'EGRESO_CREADO',
      modulo: 'egresos',
      descripcion: `${esProvisional ? 'Egreso provisional' : 'Egreso'} ${numero}: ${concepto} - ${fmt(monto)}${numeroOrdenInterna ? ' · OI ' + numeroOrdenInterna : ''}`,
      usuarioId: req.adminId || req.user.uid,
      usuarioNombre: req.user.email,
      documento: numero
    });

    res.status(201).json({
      id: ref.id, ...nuevo, alertasMargen,
      // ✅ EGRESO-PROV-001: el frontend pinta el consecutivo REAL con esto
      ...(esLegalizacion ? {
        legalizacion: {
          provisionalNumero: prov.numero,
          base: baseAnticipo,
          real: Number(totalPagar) || Number(monto),
          diferencia: diferenciaLegal
        }
      } : {})
    });
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
    // ✅ EGRESO-PROV-001: un anticipo NO se paga — se legaliza. Pagarlo aquí
    // descontaba la plata de caja por segunda vez y lo contaba como gasto.
    if (egreso.tipo === 'provisional') {
      return res.status(400).json({
        error: `${egreso.numero} es un anticipo, no un gasto. La plata ya salió de caja. Registra el egreso con la factura real y márcalo como "Legalizar comprobante provisional".`
      });
    }

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

    const verif = await verificarPinUsuario(req.user.uid || req.user.id, pin, 'cuadrar_egreso');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

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
    // ✅ EGRESO-PROV-001: la Orden Interna dejó de ser obligatoria. Un anticipo
    // puede ser una vuelta suelta sin OI. Antes esto dejaba TODO provisional
    // creado desde el modal (que nunca enviaba la OI) imposible de cuadrar.
    if (provisional.legalizado === true) {
      return res.status(400).json({ error: 'Este provisional ya fue legalizado' });
    }
    const oiRef = provisional.numeroOrdenInterna || 'sin OI';

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
      concepto: `Cuadre ${oiRef} — ${provisional.concepto}`,
      proveedor: proveedor || provisional.proveedor || '',
      categoria: provisional.categoria || 'Orden Interna',
      monto: real,
      totalPagar: real,
      ivaVal: 0, ivaPct: 0, retenVal: 0, retenPct: 0,
      formaPago: formaPago || provisional.formaPago || '',
      cajaId: cajaIdFinal,
      empresaId: provisional.empresaId || '',
      fecha: hoyEnCO(), // ✅ FIX FECHA-CO-001
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
      legalizado: true, // ✅ EGRESO-PROV-001
      egresoDefinitivoId: definitivoRef.id,
      egresoDefinitivoNumero: numero,
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
        concepto: `Vuelto ${oiRef} (cuadre ${numero})`,
        monto: diferencia,
        referencia: `${numero} · ${provisional.numero}`,
        egresoId: definitivoRef.id,
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else if (diferencia < 0) {
      await db.collection('movimientos').add({
        userId: req.adminId || req.user.uid,
        cajaId: cajaIdFinal, tipo: 'egreso',
        concepto: `Diferencia adicional ${oiRef} (cuadre ${numero})`,
        monto: Math.abs(diferencia),
        referencia: `${numero} · ${provisional.numero}`,
        egresoId: definitivoRef.id,
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await registrarAuditoria({
      accion: 'EGRESO_PROVISIONAL_CUADRADO',
      modulo: 'egresos',
      descripcion: `Cuadre ${oiRef}: base ${fmt(base)} → real ${fmt(real)} (${diferencia >= 0 ? 'vuelto ' + fmt(diferencia) : 'gasto adicional ' + fmt(Math.abs(diferencia))})`,
      usuarioId: req.adminId || req.user.uid,
      usuarioNombre: req.user.email,
      documento: provisional.numero,
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
    const verif = await verificarPinUsuario(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

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

// ─── POST /api/egresos/:id/anular ─────────────────────────────────────────────────
// Anula un egreso PAGADO: requiere PIN admin + motivo.
// Revierte dinero a caja automáticamente.
router.post('/:id/anular', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el admin puede anular egresos' });

    const { pin, motivo } = req.body;
    if (!motivo?.trim()) return res.status(400).json({ error: 'Motivo de anulación requerido' });
    if (motivo.trim().length < 10) return res.status(400).json({ error: 'El motivo debe tener al menos 10 caracteres' });

    // Exigir PIN — acción sensible
    const verif = await verificarPinUsuario(req.user.uid || req.user.id, pin, 'anular_egreso');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    const ref = db.collection('egresos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Egreso no encontrado' });

    const egreso = doc.data();
    if (egreso.estado !== 'PAGADO') return res.status(400).json({ error: 'Solo se pueden anular egresos PAGADOS' });

    const montoTotal = Number(egreso.totalPagar) || Number(egreso.monto) || 0;
    const cajaId = egreso.cajaId;

    // Transacción atómica: anular egreso + reversar dinero a caja
    const batch = db.batch();

    batch.update(ref, {
      estado: 'ANULADO',
      motvoAnulacion: motivo,
      anuladoPor: req.user.email,
      anuladoEn: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Reversar dinero a la caja original
    if (cajaId) {
      const cajaRef = db.collection('cajas').doc(cajaId);
      batch.update(cajaRef, {
        saldo: admin.firestore.FieldValue.increment(montoTotal),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();

    // Movimiento de reversión en caja (visible en Caja → Movimientos)
    if (cajaId) {
      await db.collection('movimientos').add({
        userId: req.adminId || req.user.uid,
        cajaId,
        tipo: 'ingreso',
        concepto: `Anulación ${egreso.numero}: ${egreso.concepto}`,
        monto: montoTotal,
        referencia: egreso.numero,
        egresoId: req.params.id,
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Registrar en auditoría
    await registrarAuditoria({
      accion: 'EGRESO_ANULADO_CRITICO',
      modulo: 'egresos',
      descripcion: `ANULACIÓN CRÍTICA: ${egreso.numero} anulado por ${req.user.email}. Motivo: ${motivo}`,
      usuarioId: req.adminId || req.user.uid,
      usuarioNombre: req.user.email,
      documento: egreso.numero,
      datos: {
        egresoId: req.params.id,
        numero: egreso.numero,
        monto: montoTotal,
        cajaId,
        motvoAnulacion: motivo
      }
    });

    res.json({ ok: true, id: req.params.id, estado: 'ANULADO', dineroReversado: montoTotal });
  } catch (e) {
    console.error('POST anular:', e);
    res.status(500).json({ error: 'Error al anular egreso' });
  }
});

module.exports = router;
