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

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-INTELIGENTE-001 — Motor de reglas de digitación
// ─────────────────────────────────────────────────────────────────────────────
// El frontend valida mientras se digita para dar feedback inmediato, pero eso
// no basta: cualquiera puede llamar la API directo. Aquí se vuelve a validar
// SIEMPRE, y el resultado se guarda EN el documento del egreso.
//
// Filosofía: advertir, no bloquear. Guardamos igual, pero dejamos la marca
// para que el panel de calidad y el ERI puedan mostrar "12 egresos guardados
// con advertencia" en vez de que el error se pierda entre 800 registros.
// ═════════════════════════════════════════════════════════════════════════════
const { validarEgreso, auditarLote, norm } = require('../services/validacionEgresos');

// Trae las categorías configuradas del suscriptor (con su tipoERI) para que el
// motor sepa si una categoría es de personal, fiscal, inventario, etc.
const cargarContextoValidacion = async (adminId, egresoActual = null) => {
  const ctx = { categoriasMeta: [], categoriasValidas: [], categoriaMeta: null, egresosRecientes: [], periodoCerradoHasta: null, empleados: [] };
  try {
    const [cfgDoc, empSnap] = await Promise.all([
      db.collection('configuracion').doc(adminId).get(),
      // ✅ NOMINA-PROVISIONES-001: la lista de empleados alimenta la regla que
      // detecta si el tercero de un egreso es en realidad alguien de la nómina.
      db.collection('empleados').where('userId', '==', adminId).get().catch(() => ({ forEach: () => {} }))
    ]);
    const cfg = cfgDoc.exists ? cfgDoc.data() : {};
    const cats = (cfg.categoriasEgresos || []).filter(c => c.activa !== false);
    ctx.categoriasMeta = cats;
    ctx.categoriasValidas = cats.map(c => c.nombre);
    ctx.periodoCerradoHasta = cfg.periodoCerradoHasta || null;
    if (egresoActual?.categoria) {
      ctx.categoriaMeta = cats.find(c => norm(c.nombre) === norm(egresoActual.categoria)) || null;
    }
    empSnap.forEach(d => {
      const e = d.data();
      if (e.activo === false) return;
      ctx.empleados.push({ id: d.id, nombre: e.nombre, documento: e.documento });
    });
  } catch (e) { console.error('cargarContextoValidacion:', e.message); }
  return ctx;
};

// Egresos de los últimos 15 días — solo para detectar pagos duplicados.
const cargarEgresosRecientes = async (adminId, fechaRef) => {
  try {
    const base = fechaRef || hoyEnCO();
    const d = new Date(base + 'T00:00:00');
    d.setDate(d.getDate() - 15);
    const desde = d.toISOString().slice(0, 10);
    const snap = await db.collection('egresos')
      .where('userId', '==', adminId)
      .where('fecha', '>=', desde)
      .get();
    const lista = [];
    snap.forEach(x => lista.push({ id: x.id, ...x.data() }));
    return lista;
  } catch (e) { return []; }
};

// Evalúa y devuelve el bloque que se persiste dentro del egreso.
const evaluarCalidad = async (adminId, egreso) => {
  const ctx = await cargarContextoValidacion(adminId, egreso);
  ctx.egresosRecientes = await cargarEgresosRecientes(adminId, egreso.fecha);
  const r = validarEgreso(egreso, ctx);
  return {
    alertas: r.alertas,
    conteo: r.conteo,
    hayGraves: r.hayGraves,
    // Bloque persistible — liviano, para no inflar el documento
    marca: {
      revisadoEn: new Date().toISOString(),
      cantidad: r.alertas.length,
      graves: r.conteo.graves,
      medias: r.conteo.medias,
      leves: r.conteo.leves,
      reglas: r.alertas.map(a => a.id),
      resumen: r.resumen
    }
  };
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
      formaPago, cajaId, empresaId, fecha, fechaCausacion, notas, pagarAhora, productosCompra,
      tipo, mensajeroId, mensajeroNombre, numeroOrdenInterna, cuadrado,
      // ✅ EGRESO-PROV-001: legalización de anticipo desde el egreso normal
      provisionalId, pin,
      // ✅ EGRESO-VEHICULO-001: placa a la que se imputa el gasto
      vehiculoId, vehiculoPlaca,
      // ✅ NOMINA-PROVISIONES-001: anticipo de nómina enlazado a un empleado
      esAnticipoNomina, empleadoId, empleadoNombre, empleadoDocumento,
      // ✅ EGRESO-INTELIGENTE-001: el usuario confirmó guardar pese a las alertas
      confirmoAlertas
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
      // ══════════════════════════════════════════════════════════════════
      // ✅ CAUSACION-001 — Cuándo OCURRIÓ el gasto vs cuándo se PAGÓ
      // ──────────────────────────────────────────────────────────────────
      // Bajo principio de devengo, un gasto pertenece al mes en que ocurre el
      // hecho económico, no al mes en que sale la plata. Si la mensajería de
      // julio se paga en agosto, es costo de JULIO: si no, julio queda sin
      // costo (margen inflado) y agosto con costo de más.
      //
      //   fecha           → cuándo salió la plata  → Flujo de Efectivo
      //   fechaCausacion  → a qué mes corresponde  → Estado de Resultados
      //
      // Vacío = las dos son la misma, que es el caso normal.
      // ══════════════════════════════════════════════════════════════════
      fechaCausacion: fechaCausacion ? String(fechaCausacion).slice(0, 10) : (fecha || hoyEnCO()),
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
      // ✅ EGRESO-VEHICULO-001: se guarda el id (para agrupar) y la placa
      // (snapshot legible, por si el vehículo se da de baja después).
      vehiculoId: vehiculoId || '',
      vehiculoPlaca: vehiculoPlaca || '',
      // ✅ NOMINA-PROVISIONES-001
      // Un anticipo NO es gasto: es una cuenta por cobrar al empleado. Estas
      // banderas permiten que el comprobante de nómina lo encuentre y lo cruce,
      // en vez de que quede como un gasto suelto que después duplica la nómina.
      esAnticipoNomina: esAnticipoNomina === true,
      empleadoId: empleadoId || '',
      empleadoNombre: empleadoNombre || '',
      empleadoDocumento: empleadoDocumento || '',
      cruzadoEnNomina: false,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // ✅ EGRESO-INTELIGENTE-001: se evalúa ANTES de guardar y la marca queda
    // dentro del documento. No bloquea — pero deja constancia de que se guardó
    // con observaciones, y de si el usuario las vio y confirmó.
    let calidadNuevo = null;
    try {
      calidadNuevo = await evaluarCalidad(req.adminId || req.user.uid, nuevo);
      nuevo.calidad = { ...calidadNuevo.marca, confirmadoPorUsuario: confirmoAlertas === true };
    } catch (e) { console.error('evaluarCalidad (crear):', e.message); }

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
      // ✅ EGRESO-INTELIGENTE-001: alertas de digitación detectadas al guardar
      alertasCalidad: calidadNuevo?.alertas || [],
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

    // ✅ EGRESO-EDICION-002: se amplían los campos editables.
    // Antes solo se podían corregir concepto, proveedor, categoría, monto,
    // forma de pago y caja. Faltaban IVA, retención, fecha y vehículo — que es
    // exactamente lo que impedía corregir los $18.316 de IVA descontable mal
    // ubicados dentro de la categoría Nómina en julio 2026.
    const {
      pin, motivoEdicion, concepto, proveedor, categoria, monto, formaPago, cajaId, notas,
      ivaVal, ivaPct, retenVal, retenPct, fecha, fechaCausacion, vehiculoId, vehiculoPlaca, empresaId
    } = req.body;
    if (!motivoEdicion?.trim()) return res.status(400).json({ error: 'Motivo de edición requerido' });
    if (motivoEdicion.trim().length < 10) {
      return res.status(400).json({ error: 'El motivo debe explicar la corrección (mínimo 10 caracteres)' });
    }

    // Exigir PIN — acción sensible
    const verif = await verificarPinUsuario(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    const ref = db.collection('egresos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Egreso no encontrado' });

    const egresoAnterior = doc.data();
    const montoAnterior = Number(egresoAnterior.monto);
    const montoNuevo = Number(monto) || montoAnterior;

    // ✅ EGRESO-EDICION-002: `undefined` significa "no lo toques"; un valor
    // explícito (incluido 0) sí se aplica. El patrón anterior (`x || anterior`)
    // hacía imposible poner un IVA en CERO, que era justamente la corrección
    // que se necesitaba para sacar el IVA de la categoría Nómina.
    const tomar = (nuevo, previo) => (nuevo === undefined || nuevo === null || nuevo === '') ? previo : nuevo;
    const tomarNum = (nuevo, previo) => (nuevo === undefined || nuevo === null || nuevo === '') ? (Number(previo) || 0) : (Number(nuevo) || 0);

    const ivaValNuevo   = tomarNum(ivaVal, egresoAnterior.ivaVal);
    const ivaPctNuevo   = tomarNum(ivaPct, egresoAnterior.ivaPct);
    const retenValNuevo = tomarNum(retenVal, egresoAnterior.retenVal);
    const retenPctNuevo = tomarNum(retenPct, egresoAnterior.retenPct);

    // El total a pagar se recalcula siempre: base + IVA − retención.
    const totalPagarNuevo = Math.round(montoNuevo + ivaValNuevo - retenValNuevo);

    const update = {
      concepto:  tomar(concepto,  egresoAnterior.concepto),
      proveedor: tomar(proveedor, egresoAnterior.proveedor),
      categoria: tomar(categoria, egresoAnterior.categoria),
      monto: montoNuevo,
      ivaVal: ivaValNuevo,
      ivaPct: ivaPctNuevo,
      retenVal: retenValNuevo,
      retenPct: retenPctNuevo,
      totalPagar: totalPagarNuevo,
      fecha:     tomar(fecha,     egresoAnterior.fecha),
      // ✅ CAUSACION-001: permite reasignar un gasto al mes que le corresponde
      // sin mover la salida de caja. Es lo que arregla el caso de un servicio
      // prestado en un mes y pagado al siguiente.
      fechaCausacion: tomar(fechaCausacion, egresoAnterior.fechaCausacion || egresoAnterior.fecha),
      formaPago: tomar(formaPago, egresoAnterior.formaPago),
      cajaId:    tomar(cajaId,    egresoAnterior.cajaId),
      empresaId: tomar(empresaId, egresoAnterior.empresaId),
      notas:     tomar(notas,     egresoAnterior.notas),
      // ✅ EGRESO-VEHICULO-001: permite asignar la placa a gastos ya registrados,
      // que es como se recupera la trazabilidad del combustible histórico.
      vehiculoId:    vehiculoId    === undefined ? (egresoAnterior.vehiculoId    || '') : (vehiculoId || ''),
      vehiculoPlaca: vehiculoPlaca === undefined ? (egresoAnterior.vehiculoPlaca || '') : (vehiculoPlaca || ''),
      // ✅ NOMINA-PROVISIONES-001: permite enlazar a un empleado un anticipo ya
      // registrado — así se recupera la trazabilidad del histórico sin volver
      // a digitarlo. Un anticipo ya cruzado no se puede desmarcar desde acá.
      esAnticipoNomina: egresoAnterior.cruzadoEnNomina === true
        ? egresoAnterior.esAnticipoNomina
        : (req.body.esAnticipoNomina === undefined ? (egresoAnterior.esAnticipoNomina === true) : req.body.esAnticipoNomina === true),
      empleadoId:        req.body.empleadoId        === undefined ? (egresoAnterior.empleadoId || '')        : (req.body.empleadoId || ''),
      empleadoNombre:    req.body.empleadoNombre    === undefined ? (egresoAnterior.empleadoNombre || '')    : (req.body.empleadoNombre || ''),
      empleadoDocumento: req.body.empleadoDocumento === undefined ? (egresoAnterior.empleadoDocumento || '') : (req.body.empleadoDocumento || ''),
      motivoEdicion,
      editadoPor: req.user.email,
      editadoEn: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // ✅ EGRESO-INTELIGENTE-001: re-evaluar calidad después de la corrección.
    // Si la edición arregló el problema, la marca desaparece sola.
    let calidad = null;
    try {
      calidad = await evaluarCalidad(req.adminId || req.user.uid, { ...egresoAnterior, ...update, id: req.params.id });
      update.calidad = calidad.marca;
    } catch (e) { console.error('evaluarCalidad (editar):', e.message); }

    await ref.update(update);

    // ✅ EGRESO-EDICION-002: la caja se ajusta contra el TOTAL PAGADO, no
    // contra la base. Lo que salió del cajón fue base + IVA − retención; si se
    // corrige el IVA y solo se compensa la base, el saldo de caja queda torcido.
    const salidaAnterior = Number(egresoAnterior.totalPagar || egresoAnterior.monto) || 0;
    const salidaNueva    = totalPagarNuevo;
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
            saldo: Number(cajaAnteriorDoc.data().saldo) + salidaAnterior
          });
        }
        if (cajaNuevaDoc.exists) {
          batch.update(db.collection('cajas').doc(cajaId), {
            saldo: Number(cajaNuevaDoc.data().saldo) - salidaNueva
          });
        }
        await batch.commit();
      } else if (salidaNueva !== salidaAnterior) {
        const cajaDoc = await db.collection('cajas').doc(cajaIdFinal).get();
        if (cajaDoc.exists) {
          const diferencia = salidaAnterior - salidaNueva;
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
        // ✅ EGRESO-EDICION-002: la auditoría guarda TODOS los campos sensibles,
        // no solo concepto/monto/categoría. Sin el antes-y-después completo el
        // log no sirve para reconstruir qué se corrigió.
        anterior: {
          concepto:  egresoAnterior.concepto,
          proveedor: egresoAnterior.proveedor || '',
          categoria: egresoAnterior.categoria,
          monto:     montoAnterior,
          ivaVal:    Number(egresoAnterior.ivaVal) || 0,
          retenVal:  Number(egresoAnterior.retenVal) || 0,
          totalPagar: salidaAnterior,
          fecha:     egresoAnterior.fecha || '',
          vehiculoPlaca: egresoAnterior.vehiculoPlaca || ''
        },
        nuevo: {
          concepto:  update.concepto,
          proveedor: update.proveedor || '',
          categoria: update.categoria,
          monto:     montoNuevo,
          ivaVal:    ivaValNuevo,
          retenVal:  retenValNuevo,
          totalPagar: salidaNueva,
          fecha:     update.fecha || '',
          vehiculoPlaca: update.vehiculoPlaca || ''
        },
        // Lista concreta de qué cambió — es lo que se muestra en el historial
        camposCambiados: Object.keys(update).filter(k =>
          !['motivoEdicion', 'editadoPor', 'editadoEn', 'updatedAt', 'calidad'].includes(k) &&
          String(update[k] ?? '') !== String(egresoAnterior[k] ?? '')
        ),
        motivoEdicion
      }
    });

    res.json({ ok: true, id: req.params.id, ...update, calidad: calidad?.alertas || [] });
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

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-RECLASIFICAR-001 — Reclasificación masiva de categoría
// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ EXISTE ESTE ENDPOINT
// La auditoría de julio 2026 encontró 56 egresos de personal mal repartidos
// entre las categorías `Nómina` y `anticipos de nomina`, cruzados en los dos
// sentidos, en UN SOLO MES. Corregirlos de a uno son 56 aperturas de modal,
// 56 digitaciones de PIN y 56 oportunidades nuevas de equivocarse.
//
// QUÉ NO HACE
// No toca valores. Solo mueve la ETIQUETA contable. Por eso no necesita ajustar
// caja ni inventario: la plata que salió es la misma, cambia dónde se clasifica.
// Cualquier cambio de valor sigue exigiendo la edición unitaria.
//
// TRAZABILIDAD
// Todos los egresos del lote comparten un `loteId`. Con ese id se puede revertir
// la operación completa si se reclasificó mal. Cada egreso guarda además su
// categoría anterior, para que la reversión no dependa de leer el log.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/reclasificar-lote', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede reclasificar egresos' });
    }

    const { ids, categoriaDestino, motivo, pin } = req.body;
    const adminId = req.adminId || req.user.uid;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Seleccioná al menos un egreso' });
    }
    if (ids.length > 300) {
      return res.status(400).json({ error: 'Máximo 300 egresos por lote. Filtrá más y repetí la operación.' });
    }
    if (!categoriaDestino?.trim()) {
      return res.status(400).json({ error: 'Categoría destino requerida' });
    }
    if (!motivo?.trim() || motivo.trim().length < 10) {
      return res.status(400).json({ error: 'El motivo debe explicar la reclasificación (mínimo 10 caracteres)' });
    }

    const verif = await verificarPinUsuario(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    // La categoría destino debe existir en el catálogo. Sin esto, una
    // reclasificación masiva podría crear la variante fantasma número cinco.
    const ctx = await cargarContextoValidacion(adminId);
    if (ctx.categoriasValidas.length > 0 &&
        !ctx.categoriasValidas.some(c => norm(c) === norm(categoriaDestino))) {
      return res.status(400).json({
        error: `"${categoriaDestino}" no existe en el catálogo de categorías activas. ` +
               `Creála primero en Configuración → Categorías de egreso.`
      });
    }
    const catDestinoReal = ctx.categoriasValidas.find(c => norm(c) === norm(categoriaDestino)) || categoriaDestino.trim();

    const loteId = `LOTE-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const ahora = new Date().toISOString();

    // Leer todos primero: validamos pertenencia antes de escribir nada.
    const refs = ids.map(id => db.collection('egresos').doc(id));
    const docs = await db.getAll(...refs);

    const aplicables = [];
    const omitidos = [];

    docs.forEach((doc, i) => {
      if (!doc.exists) { omitidos.push({ id: ids[i], razon: 'No existe' }); return; }
      const e = doc.data();
      if (e.userId !== adminId)     { omitidos.push({ id: ids[i], numero: e.numero, razon: 'De otra empresa' }); return; }
      if (e.anulado === true)       { omitidos.push({ id: ids[i], numero: e.numero, razon: 'Anulado' }); return; }
      if (norm(e.categoria) === norm(catDestinoReal)) {
        omitidos.push({ id: ids[i], numero: e.numero, razon: 'Ya estaba en esa categoría' }); return;
      }
      aplicables.push({ ref: refs[i], id: ids[i], data: e });
    });

    if (aplicables.length === 0) {
      return res.status(400).json({
        error: 'Ningún egreso del lote se puede reclasificar',
        omitidos
      });
    }

    // Escritura en batches de 400 (el límite de Firestore es 500 operaciones).
    for (let i = 0; i < aplicables.length; i += 400) {
      const tanda = aplicables.slice(i, i + 400);
      const batch = db.batch();
      for (const item of tanda) {
        batch.update(item.ref, {
          categoria: catDestinoReal,
          reclasificacion: {
            loteId,
            categoriaAnterior: item.data.categoria || '',
            categoriaNueva: catDestinoReal,
            motivo: motivo.trim(),
            por: req.user.email,
            en: ahora,
            revertido: false
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      await batch.commit();
    }

    // Resumen por categoría de origen — es lo que se le muestra al usuario.
    const porOrigen = {};
    let valorTotal = 0;
    for (const item of aplicables) {
      const origen = item.data.categoria || 'Sin categoría';
      const valor = Number(item.data.totalPagar || item.data.monto) || 0;
      if (!porOrigen[origen]) porOrigen[origen] = { categoria: origen, cantidad: 0, valor: 0 };
      porOrigen[origen].cantidad += 1;
      porOrigen[origen].valor += valor;
      valorTotal += valor;
    }

    await registrarAuditoria({
      accion: 'EGRESOS_RECLASIFICADOS_LOTE',
      modulo: 'egresos',
      descripcion: `RECLASIFICACIÓN MASIVA: ${aplicables.length} egreso(s) por ${fmt(valorTotal)} → "${catDestinoReal}". Motivo: ${motivo.trim()}`,
      usuarioId: adminId,
      usuarioNombre: req.user.email,
      documento: loteId,
      datos: {
        loteId,
        categoriaDestino: catDestinoReal,
        cantidad: aplicables.length,
        valorTotal,
        origenes: Object.values(porOrigen),
        egresos: aplicables.map(a => ({
          id: a.id, numero: a.data.numero,
          categoriaAnterior: a.data.categoria || '',
          valor: Number(a.data.totalPagar || a.data.monto) || 0
        })),
        omitidos,
        motivo: motivo.trim()
      }
    });

    res.json({
      ok: true,
      loteId,
      reclasificados: aplicables.length,
      valorTotal,
      categoriaDestino: catDestinoReal,
      origenes: Object.values(porOrigen).sort((a, b) => b.valor - a.valor),
      omitidos
    });
  } catch (e) {
    console.error('POST reclasificar-lote:', e);
    res.status(500).json({ error: 'Error al reclasificar el lote' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-RECLASIFICAR-001 — Revertir un lote completo
// ─────────────────────────────────────────────────────────────────────────────
// Devuelve cada egreso del lote a la categoría que tenía antes. Es la red de
// seguridad que hace que reclasificar 200 registros no dé miedo.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/reclasificar-lote/:loteId/revertir', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede revertir una reclasificación' });
    }

    const { pin, motivo } = req.body;
    const adminId = req.adminId || req.user.uid;
    const { loteId } = req.params;

    const verif = await verificarPinUsuario(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    const snap = await db.collection('egresos')
      .where('userId', '==', adminId)
      .where('reclasificacion.loteId', '==', loteId)
      .get();

    if (snap.empty) return res.status(404).json({ error: 'Lote no encontrado o ya revertido' });

    const items = [];
    snap.forEach(d => {
      const e = d.data();
      if (e.reclasificacion?.revertido === true) return;
      items.push({ ref: d.ref, id: d.id, numero: e.numero, categoriaAnterior: e.reclasificacion?.categoriaAnterior || '' });
    });

    if (items.length === 0) return res.status(400).json({ error: 'El lote ya fue revertido' });

    for (let i = 0; i < items.length; i += 400) {
      const batch = db.batch();
      for (const item of items.slice(i, i + 400)) {
        batch.update(item.ref, {
          categoria: item.categoriaAnterior,
          'reclasificacion.revertido': true,
          'reclasificacion.revertidoPor': req.user.email,
          'reclasificacion.revertidoEn': new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      await batch.commit();
    }

    await registrarAuditoria({
      accion: 'RECLASIFICACION_REVERTIDA',
      modulo: 'egresos',
      descripcion: `Reclasificación ${loteId} revertida: ${items.length} egreso(s) volvieron a su categoría original. ${motivo || ''}`,
      usuarioId: adminId,
      usuarioNombre: req.user.email,
      documento: loteId,
      datos: { loteId, cantidad: items.length, egresos: items.map(i => ({ id: i.id, numero: i.numero, volvioA: i.categoriaAnterior })) }
    });

    res.json({ ok: true, loteId, revertidos: items.length });
  } catch (e) {
    console.error('POST revertir lote:', e);
    res.status(500).json({ error: 'Error al revertir el lote' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-INTELIGENTE-001 — GET /api/egresos/calidad
// ─────────────────────────────────────────────────────────────────────────────
// Corre el motor de reglas sobre TODOS los egresos del rango y devuelve el
// ranking de problemas. Es el panel que responde "¿qué tan confiable es mi
// información este mes?" antes de mirar el estado de resultados.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/calidad', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const { desde, hasta } = req.query;

    const [ctx, snap] = await Promise.all([
      cargarContextoValidacion(adminId),
      db.collection('egresos').where('userId', '==', adminId).get()
    ]);

    const lista = [];
    snap.forEach(d => {
      const e = { id: d.id, ...d.data() };
      if (desde && e.fecha && e.fecha < desde) return;
      if (hasta && e.fecha && e.fecha > hasta) return;
      lista.push(e);
    });

    const resultado = auditarLote(lista, {
      categoriasMeta: ctx.categoriasMeta,
      categoriasValidas: ctx.categoriasValidas,
      periodoCerradoHasta: ctx.periodoCerradoHasta
    });

    // Puntaje simple de confiabilidad: qué % de los egresos no tiene ninguna
    // observación. Es el número que la gerente mira de un vistazo.
    const limpios = resultado.totalRevisados - resultado.totalConAlerta;
    resultado.puntaje = resultado.totalRevisados > 0
      ? Math.round(limpios / resultado.totalRevisados * 100)
      : 100;

    res.json(resultado);
  } catch (e) {
    console.error('GET egresos/calidad:', e);
    res.status(500).json({ error: 'Error al auditar la calidad de los egresos' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-INTELIGENTE-001 — POST /api/egresos/calidad/marcar-historicos
// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ HACE FALTA
// El motor de validación nació después de los egresos que ya estaban en la
// base. Los 800 registros de julio 2026 nunca pasaron por él, así que no
// tienen el campo `calidad` y no muestran la marca en el listado.
//
// La pestaña Revisión los evalúa en vivo y funciona bien, pero el ícono de
// alerta en la tabla solo aparecía en los egresos nuevos. Este endpoint corre
// el motor sobre el histórico y guarda la marca en cada documento.
//
// NO MODIFICA NINGÚN VALOR. Solo agrega el campo `calidad`.
// Es idempotente: se puede correr las veces que haga falta.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/calidad/marcar-historicos', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede ejecutar esta revisión' });
    }
    const adminId = req.adminId || req.user.uid;
    const { desde, hasta, soloFaltantes } = req.body || {};

    const ctx = await cargarContextoValidacion(adminId);
    const snap = await db.collection('egresos').where('userId', '==', adminId).get();

    const lista = [];
    snap.forEach(d => {
      const e = { id: d.id, ref: d.ref, ...d.data() };
      if (e.anulado === true) return;
      if (desde && e.fecha && e.fecha < desde) return;
      if (hasta && e.fecha && e.fecha > hasta) return;
      // Por defecto solo marca los que no tienen la evaluación todavía
      if (soloFaltantes !== false && e.calidad?.revisadoEn) return;
      lista.push(e);
    });

    if (lista.length === 0) {
      return res.json({ ok: true, revisados: 0, conAlerta: 0, mensaje: 'No hay egresos pendientes de revisar.' });
    }

    // Contexto compartido: los duplicados se buscan contra la misma lista
    const universo = [];
    snap.forEach(d => { const e = d.data(); if (e.anulado !== true) universo.push({ id: d.id, ...e }); });

    let conAlerta = 0, graves = 0;
    const porRegla = {};

    for (let i = 0; i < lista.length; i += 400) {
      const tanda = lista.slice(i, i + 400);
      const batch = db.batch();
      for (const e of tanda) {
        const meta = ctx.categoriasMeta.find(c => norm(c.nombre) === norm(e.categoria)) || null;
        const r = validarEgreso(e, {
          categoriaMeta: meta,
          categoriasValidas: ctx.categoriasValidas,
          egresosRecientes: universo,
          periodoCerradoHasta: ctx.periodoCerradoHasta,
          empleados: ctx.empleados
        });
        if (r.alertas.length) {
          conAlerta += 1;
          graves += r.conteo.graves;
          for (const a of r.alertas) porRegla[a.id] = (porRegla[a.id] || 0) + 1;
        }
        batch.update(e.ref, {
          calidad: {
            revisadoEn: new Date().toISOString(),
            cantidad: r.alertas.length,
            graves: r.conteo.graves,
            medias: r.conteo.medias,
            leves: r.conteo.leves,
            reglas: r.alertas.map(a => a.id),
            resumen: r.resumen,
            marcadoRetroactivamente: true
          }
        });
      }
      await batch.commit();
    }

    await registrarAuditoria({
      accion: 'CALIDAD_HISTORICOS_MARCADA',
      modulo: 'egresos',
      descripcion: `Revisión retroactiva: ${lista.length} egreso(s) evaluados, ${conAlerta} con observaciones (${graves} graves)`,
      usuarioId: adminId,
      usuarioNombre: req.user.email,
      documento: `REVISION-${new Date().toISOString().slice(0, 10)}`,
      datos: { revisados: lista.length, conAlerta, graves, porRegla, desde, hasta }
    });

    res.json({
      ok: true,
      revisados: lista.length,
      conAlerta,
      graves,
      limpios: lista.length - conAlerta,
      porRegla,
      mensaje: `${lista.length} egreso(s) revisados. ${conAlerta} tienen observaciones` +
               (graves ? `, de los cuales ${graves} son errores contables probables.` : '.')
    });
  } catch (e) {
    console.error('POST marcar-historicos:', e);
    res.status(500).json({ error: 'Error al revisar los egresos históricos' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-RECLASIFICAR-001 — GET /api/egresos/lotes
// ─────────────────────────────────────────────────────────────────────────────
// Lista las reclasificaciones masivas hechas, para poder revertir una desde la
// interfaz sin tener que buscar el id del lote en el log de auditoría.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/lotes', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;
    const snap = await db.collection('egresos').where('userId', '==', adminId).get();

    const lotes = {};
    snap.forEach(d => {
      const e = d.data();
      const r = e.reclasificacion;
      if (!r?.loteId) return;
      if (!lotes[r.loteId]) {
        lotes[r.loteId] = {
          loteId: r.loteId,
          categoriaNueva: r.categoriaNueva,
          motivo: r.motivo,
          por: r.por,
          en: r.en,
          revertido: r.revertido === true,
          revertidoPor: r.revertidoPor || null,
          revertidoEn: r.revertidoEn || null,
          cantidad: 0,
          valor: 0,
          origenes: {}
        };
      }
      const L = lotes[r.loteId];
      L.cantidad += 1;
      L.valor += Number(e.totalPagar || e.monto) || 0;
      const o = r.categoriaAnterior || 'Sin categoría';
      L.origenes[o] = (L.origenes[o] || 0) + 1;
    });

    const lista = Object.values(lotes)
      .map(l => ({ ...l, origenes: Object.entries(l.origenes).map(([categoria, cantidad]) => ({ categoria, cantidad })) }))
      .sort((a, b) => String(b.en).localeCompare(String(a.en)));

    res.json(lista);
  } catch (e) {
    console.error('GET lotes:', e);
    res.status(500).json({ error: 'Error al cargar las reclasificaciones' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ✅ EGRESO-EDICION-002 — GET /api/egresos/:id/historial
// ─────────────────────────────────────────────────────────────────────────────
// Historial de cambios de un egreso. Es lo que convierte una edición en algo
// defendible ante una revisión: quién, cuándo, qué campo, de qué a qué y por qué.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/:id/historial', async (req, res) => {
  try {
    const adminId = req.adminId || req.user.uid;

    const doc = await db.collection('egresos').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Egreso no encontrado' });
    if (doc.data().userId !== adminId) return res.status(403).json({ error: 'Egreso de otra empresa' });

    const numero = doc.data().numero;
    const snap = await db.collection('audit_logs')
      .where('usuarioId', '==', adminId)
      .where('documento', '==', numero)
      .get();

    const eventos = [];
    snap.forEach(d => {
      const a = d.data();
      eventos.push({
        id: d.id,
        accion: a.accion,
        descripcion: a.descripcion,
        usuario: a.usuarioNombre || '',
        fecha: a.fecha,
        anterior: a.datos?.anterior || null,
        nuevo: a.datos?.nuevo || null,
        camposCambiados: a.datos?.camposCambiados || [],
        motivo: a.datos?.motivoEdicion || a.datos?.motivo || ''
      });
    });

    eventos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

    res.json({
      egresoId: req.params.id,
      numero,
      reclasificacion: doc.data().reclasificacion || null,
      eventos
    });
  } catch (e) {
    console.error('GET historial:', e);
    res.status(500).json({ error: 'Error al cargar el historial' });
  }
});

module.exports = router;
