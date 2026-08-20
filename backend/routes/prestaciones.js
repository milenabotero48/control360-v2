// ═══════════════════════════════════════════════════════════════════════════════
// prestaciones.js — Pago del pasivo laboral y liquidación de contrato
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PASIVO-001 · NOMINA-LIQUIDACION-001
//
// EL PROBLEMA QUE RESUELVE
// ------------------------
// `empleados.js` causaba el pasivo de prestaciones pero no tenía cómo cerrarlo.
// No existía endpoint de pago, `pagada: false` nunca cambiaba, y el pasivo
// acumulado del balance solo crecía. Cuando un empleado se retiraba, su
// provisión quedaba huérfana para siempre.
//
// Peor: la única forma de registrar el pago era digitarlo como egreso con
// categoría "Nómina" — y eso lo contaba OTRA VEZ como gasto en el ERI, porque
// `eri.js` ya suma las provisiones causadas. Doble conteo del mismo gasto.
//
// LOS TRES ASIENTOS QUE ESTE MÓDULO HACE BIEN
// -------------------------------------------
//   1. PAGO DE PRESTACIONES (consignación, prima, intereses, vacaciones)
//        Db  Pasivo prestaciones      ← descarga la provisión, NO es gasto
//        Cr  Caja / Banco
//
//   2. LIQUIDACIÓN DE CONTRATO
//        Db  Pasivo prestaciones      ← lo ya causado
//        Db  Gasto de personal        ← indemnización + salario pendiente (nuevo)
//        Cr  CxP empleado             ← queda exigible en Cuentas por Pagar
//
//   3. PAGO DE LA CxP → desde el módulo CxP existente, sin cambios ahí.
//
// POR QUÉ LA LIQUIDACIÓN GENERA CxP Y NO UN PAGO DIRECTO
// -----------------------------------------------------
// Porque casi nunca se paga el mismo día que se firma. Entre la liquidación y
// el desembolso hay una deuda cierta, con monto exacto y tercero identificado:
// eso es una cuenta por pagar, no una provisión. `cxp.js` ya cuenta como deuda
// todo egreso en estado PENDIENTE, así que aparece solo — cero cambios allá.
//
// COLECCIONES
//   pagos_prestaciones     · cada pago que descarga el pasivo
//   liquidaciones_contrato · la liquidación final; su `gastoNuevo` va al ERI
//   provisiones_prestaciones · se actualiza el campo `aplicado` por concepto
//   egresos                · el comprobante (PAGADO o PENDIENTE si es CxP)
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { verificarPin } = require('./_autorizacion');
const N = require('../services/nominaColombia');
const PL = require('../services/pasivoLaboral');

const resolverAdminId = (req) => req.adminId || req.user?.uid || req.user?.id || null;
const num = (v) => Number(v) || 0;
const hoyCO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

const registrarAuditoria = async (datos) => {
  try {
    await db.collection('audit_logs').add({
      ...datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (e) { console.error('Auditoría prestaciones:', e); }
};

/** Numeración atómica de egresos — mismo contador que usa el resto del sistema. */
const siguienteNumeroEgreso = async (adminId) => {
  const counterRef = db.collection('counters').doc(`${adminId}_egresos`);
  const n = await db.runTransaction(async (tx) => {
    const d = await tx.get(counterRef);
    const actual = d.exists ? (num(d.data().value)) : 0;
    tx.set(counterRef, { value: actual + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return actual + 1;
  });
  return `EGR-${String(n).padStart(4, '0')}`;
};

/** Carga provisiones del tenant. Se usa en casi todos los endpoints. */
const cargarProvisiones = async (adminId) => {
  const snap = await db.collection('provisiones_prestaciones').where('userId', '==', adminId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

/**
 * ✅ NOMINA-ANTICIPOS-LIQUIDACION-001
 *
 * Anticipos pendientes de cruce de un empleado, y los egresos SOSPECHOSOS:
 * pagos hechos a nombre de esa persona que nadie marcó como anticipo.
 *
 * EL CASO QUE LO DESTAPÓ: un técnico tenía dos anticipos, de $20.000 y
 * $100.000. El de $20.000 estaba marcado y aparecía; el de $100.000 se registró
 * solo con la categoría "ANTICIPO DE NÓMINA" pero sin marcar la casilla, así
 * que no figuraba en ninguna parte. El sistema lo señalaba con una alerta en
 * Egresos (regla R16), pero esa alerta no llegaba a la pantalla de nómina.
 *
 * Al liquidar un contrato eso es plata perdida: se le paga la liquidación
 * completa sin descontar lo que ya se le había entregado.
 */
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const cargarAnticipos = async (adminId, empleado) => {
  const snap = await db.collection('egresos').where('userId', '==', adminId)
    .select('esAnticipoNomina', 'cruzadoEnNomina', 'anulado', 'empleadoId', 'numero',
            'fecha', 'concepto', 'proveedor', 'categoria', 'totalPagar', 'monto',
            'esComprobanteNomina', 'periodoNomina').get();

  const pendientes = [];
  const sospechosos = [];
  const comprobantes = [];
  const nombreEmp = norm(empleado.nombre);

  snap.docs.forEach(d => {
    const e = d.data();
    if (e.anulado === true) return;
    if (e.esComprobanteNomina === true) {
      if (e.empleadoId === empleado.id) {
        comprobantes.push({ numero: e.numero || '', periodoNomina: e.periodoNomina || null });
      }
      return;
    }
    const valor = num(e.totalPagar || e.monto);
    if (valor <= 0) return;

    const item = {
      egresoId: d.id, numero: e.numero || '', fecha: e.fecha || '',
      concepto: e.concepto || '', categoria: e.categoria || '', valor
    };

    if (e.esAnticipoNomina === true && e.empleadoId === empleado.id) {
      if (e.cruzadoEnNomina === true) return;
      pendientes.push(item);
      return;
    }

    // Regla R16 en el contexto de la liquidación: el tercero se llama como el
    // empleado pero el egreso no está marcado ni enlazado.
    if (nombreEmp.length >= 5) {
      const texto = `${norm(e.proveedor)} ${norm(e.concepto)}`;
      if (texto.includes(nombreEmp)) sospechosos.push(item);
    }
  });

  const cmp = (a, b) => String(a.fecha).localeCompare(String(b.fecha));
  return {
    pendientes: pendientes.sort(cmp),
    sospechosos: sospechosos.sort(cmp),
    totalPendientes: pendientes.reduce((a, x) => a + x.valor, 0),
    totalSospechosos: sospechosos.reduce((a, x) => a + x.valor, 0),
    comprobantes,
  };
};

/**
 * ✅ FIX NOMINA-DIAS-PENDIENTES-001
 *
 * Días de salario que quedan por pagar al liquidar.
 *
 * EL BUG: el valor por defecto eran los días TRABAJADOS en el mes de retiro.
 * Con nómina quincenal eso está mal casi siempre: si el trabajador salió el 18
 * y ya había cobrado la quincena del 1 al 15, se le deben 3 días, no 18.
 * La liquidación proponía pagar 15 días de más — unos $437.000 en el caso que
 * lo destapó.
 *
 * Ahora se mira hasta qué día lo cubren los comprobantes de nómina ya emitidos
 * en ese mes, y se cuentan solo los días posteriores.
 */
const diasSalarioPendiente = (comprobantes, empleado, fechaRetiro) => {
  const f = String(fechaRetiro || '').slice(0, 10);
  const mesRetiro = f.slice(0, 7);
  const diaRetiro = Math.min(30, Number(f.slice(8, 10)) || 0);

  // Día hasta el que ya se pagó, dentro del mes de retiro.
  let ultimoPagado = 0;
  for (const c of comprobantes) {
    const hasta = String(c.periodoNomina?.hasta || '').slice(0, 10);
    if (!hasta || hasta.slice(0, 7) !== mesRetiro) continue;
    ultimoPagado = Math.max(ultimoPagado, Math.min(30, Number(hasta.slice(8, 10)) || 0));
  }

  // Si entró en el mes de retiro, no se cuentan días previos a su ingreso.
  const ini = String(empleado?.fechaInicio || '').slice(0, 10);
  const diaIngreso = ini.slice(0, 7) === mesRetiro ? Math.min(30, Number(ini.slice(8, 10)) || 1) : 1;

  const desde = Math.max(diaIngreso, ultimoPagado + 1);
  return {
    dias: Math.max(0, diaRetiro - desde + 1),
    ultimoPagado,
    desde, hasta: diaRetiro,
    explica: ultimoPagado > 0
      ? `Ya se le pagó hasta el día ${ultimoPagado} del mes. Quedan del ${desde} al ${diaRetiro}.`
      : `No hay comprobante de nómina de este mes, así que se cuentan todos los días trabajados (${desde} al ${diaRetiro}). Si ya le pagaste una quincena, corregí el número.`
  };
};

const cargarEmpleado = async (empleadoId, adminId) => {
  const doc = await db.collection('empleados').doc(empleadoId || '_').get();
  if (!doc.exists) return { error: 'Empleado no encontrado', status: 404 };
  if (doc.data().userId !== adminId) return { error: 'Empleado de otra empresa', status: 403 };
  return { empleado: { id: doc.id, ...doc.data() } };
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/prestaciones/catalogos
// ─────────────────────────────────────────────────────────────────────────────
// Los tipos de pago y los motivos de terminación viven en el backend para que
// la UI no los tenga hardcodeados y las validaciones usen la misma fuente.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/catalogos', (req, res) => {
  res.json({
    conceptos: PL.CONCEPTOS.map(c => ({
      clave: c, etiqueta: PL.ETIQUETAS[c], cuentaPUC: PL.CUENTAS_PUC[c]
    })),
    tiposPago: Object.values(PL.TIPOS_PAGO),
    motivosTerminacion: Object.values(N.MOTIVOS_TERMINACION),
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/prestaciones/saldo?empleadoId&hasta
// ─────────────────────────────────────────────────────────────────────────────
// El pasivo REAL: causado − pagado. Antes `empleados.js` mostraba solo el
// causado, y por eso el número solo subía.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/saldo', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const provisiones = await cargarProvisiones(adminId);
    const pasivo = PL.consolidarPasivo(provisiones, {
      empleadoId: req.query.empleadoId || undefined,
      hasta: req.query.hasta || undefined,
    });

    // Historial de pagos, para que el usuario vea qué descargó el pasivo
    const pagosSnap = await db.collection('pagos_prestaciones')
      .where('userId', '==', adminId).get();
    const pagos = pagosSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.anulado !== true)
      .filter(p => !req.query.empleadoId || p.empleadoId === req.query.empleadoId)
      .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')))
      .slice(0, 50);

    res.json({ ...pasivo, pagosRecientes: pagos });
  } catch (e) {
    console.error('GET prestaciones/saldo:', e);
    res.status(500).json({ error: 'Error al calcular el pasivo de prestaciones' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/prestaciones/pagar/preview
// ─────────────────────────────────────────────────────────────────────────────
// Muestra contra qué provisiones se va a aplicar el pago ANTES de confirmarlo.
// Sin esto el usuario firma a ciegas un asiento que toca el balance.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/pagar/preview', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const { concepto, monto, empleadoId } = req.body;
    if (!PL.CONCEPTOS.includes(concepto)) {
      return res.status(400).json({ error: `Concepto inválido. Válidos: ${PL.CONCEPTOS.join(', ')}` });
    }
    if (num(monto) <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a cero' });

    const provisiones = await cargarProvisiones(adminId);
    const plan = PL.planificarAplicacion(provisiones, concepto, num(monto), { empleadoId });

    const avisos = [];
    if (plan.sobrante > 0) {
      avisos.push({
        nivel: 'media',
        texto: `${fmt(plan.sobrante)} del pago superan el pasivo causado de ${PL.ETIQUETAS[concepto]}. ` +
               `Ese excedente se registrará como GASTO del período: significa que se provisionó de menos ` +
               `(normalmente por horas extras o comisiones no incluidas en la base).`
      });
    }
    if (plan.provisionExcedente > 0) {
      avisos.push({
        nivel: 'info',
        texto: `Quedan ${fmt(plan.provisionExcedente)} de provisión viva en ${PL.ETIQUETAS[concepto]} ` +
               `después de este pago. Es normal si el pago es parcial o si aún hay meses por pagar.`
      });
    }
    res.json({ ...plan, avisos });
  } catch (e) {
    console.error('POST prestaciones/pagar/preview:', e);
    res.status(500).json({ error: e.message || 'Error al calcular la aplicación del pago' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/prestaciones/pagar
// ─────────────────────────────────────────────────────────────────────────────
// Registra el pago y DESCARGA el pasivo. El egreso que crea lleva
// `esPagoPasivoLaboral: true`, que es la marca que hace que el ERI NO lo cuente
// como gasto (ya se causó mes a mes) pero el flujo de caja SÍ lo vea salir.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/pagar', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede registrar pagos de prestaciones' });
    }
    const adminId = resolverAdminId(req);
    const {
      concepto, monto, empleadoId, tipoPago, cajaId, formaPago,
      empresaId, fecha, beneficiario, notas, pin
    } = req.body;

    const verif = await verificarPin(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    if (!PL.CONCEPTOS.includes(concepto)) {
      return res.status(400).json({ error: `Concepto inválido. Válidos: ${PL.CONCEPTOS.join(', ')}` });
    }
    if (num(monto) <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a cero' });
    const tp = PL.TIPOS_PAGO[tipoPago];
    if (!tp) return res.status(400).json({ error: 'Tipo de pago inválido' });
    if (!tp.conceptos.includes(concepto)) {
      return res.status(400).json({
        error: `Un pago de tipo "${tp.etiqueta}" no aplica al concepto ${PL.ETIQUETAS[concepto]}.`
      });
    }
    if (!cajaId) return res.status(400).json({ error: 'Indicá desde qué caja o banco sale el pago' });

    let empleado = null;
    if (empleadoId) {
      const r = await cargarEmpleado(empleadoId, adminId);
      if (r.error) return res.status(r.status).json({ error: r.error });
      empleado = r.empleado;
    }

    const provisiones = await cargarProvisiones(adminId);
    const plan = PL.planificarAplicacion(provisiones, concepto, num(monto), { empleadoId });

    const fechaPago = String(fecha || hoyCO()).slice(0, 10);
    const numero = await siguienteNumeroEgreso(adminId);
    const etiquetaConcepto = PL.ETIQUETAS[concepto];
    const nombreBeneficiario = beneficiario || empleado?.nombre || tp.etiqueta;

    // ─── 1. Egreso (comprobante y salida de caja) ─────────────────────────────
    const egreso = {
      userId: adminId,
      numero,
      concepto: `${tp.etiqueta} · ${etiquetaConcepto}${empleado ? ` · ${empleado.nombre}` : ''}`,
      proveedor: nombreBeneficiario,
      categoria: 'Pago de prestaciones sociales',
      monto: num(monto),
      totalPagar: num(monto),
      ivaVal: 0, ivaPct: 0, retenVal: 0, retenPct: 0,
      formaPago: formaPago || '',
      cajaId,
      empresaId: empresaId || '',
      fecha: fechaPago,
      fechaPago,
      notas: notas || '',
      tipo: 'pago_prestaciones',
      estado: 'PAGADO',
      cuadrado: true, legalizado: true,
      // ⚠️ LA MARCA CLAVE: el ERI excluye esto del gasto. Ya se causó mes a mes
      // en `provisiones_prestaciones`. Contarlo acá sería duplicar.
      esPagoPasivoLaboral: true,
      conceptoPasivo: concepto,
      tipoPagoPasivo: tp.id,
      empleadoId: empleado?.id || null,
      empleadoNombre: empleado?.nombre || null,
      // El excedente sobre lo provisionado SÍ es gasto del período
      excedenteGasto: plan.sobrante,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const egresoRef = await db.collection('egresos').add(egreso);

    // ─── 2. Descargue del pasivo (batch) ──────────────────────────────────────
    const porProvision = {};
    for (const a of plan.aplicaciones) {
      (porProvision[a.provisionId] = porProvision[a.provisionId] || []).push(a);
    }
    const batch = db.batch();
    for (const [provisionId, aplicaciones] of Object.entries(porProvision)) {
      const prov = provisiones.find(p => p.id === provisionId);
      const aplicadoNuevo = PL.mezclarAplicado(prov, aplicaciones);
      batch.update(db.collection('provisiones_prestaciones').doc(provisionId), {
        aplicado: aplicadoNuevo,
        pagada: PL.estaSaldada(prov, aplicadoNuevo),
        ultimoPagoId: egresoRef.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // ─── 3. Registro del pago ─────────────────────────────────────────────────
    const pagoRef = db.collection('pagos_prestaciones').doc();
    batch.set(pagoRef, {
      userId: adminId,
      egresoId: egresoRef.id,
      numero,
      concepto,
      conceptoEtiqueta: etiquetaConcepto,
      cuentaPUC: PL.CUENTAS_PUC[concepto],
      tipoPago: tp.id,
      tipoPagoEtiqueta: tp.etiqueta,
      empleadoId: empleado?.id || null,
      empleadoNombre: empleado?.nombre || null,
      beneficiario: nombreBeneficiario,
      monto: num(monto),
      aplicadoAProvision: plan.aplicado,
      excedenteGasto: plan.sobrante,
      aplicaciones: plan.aplicaciones,
      fecha: fechaPago,
      periodo: fechaPago.slice(0, 7),
      cajaId, formaPago: formaPago || '',
      empresaId: empresaId || '',
      notas: notas || '',
      anulado: false,
      naturaleza: 'descargue_pasivo',
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    // ─── 4. Movimiento de caja ────────────────────────────────────────────────
    const cajaRef = db.collection('cajas').doc(cajaId);
    const cajaDoc = await cajaRef.get();
    if (cajaDoc.exists) {
      await cajaRef.update({
        saldo: admin.firestore.FieldValue.increment(-num(monto)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('movimientos').add({
        userId: adminId, cajaId, tipo: 'egreso',
        monto: num(monto),
        concepto: `${tp.etiqueta} · ${etiquetaConcepto}`,
        referencia: numero,
        formaPago: formaPago || '',
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await registrarAuditoria({
      accion: 'PAGO_PRESTACIONES', modulo: 'prestaciones',
      descripcion: `${tp.etiqueta} · ${etiquetaConcepto} por ${fmt(num(monto))}` +
                   (empleado ? ` · ${empleado.nombre}` : '') +
                   ` · descargó ${fmt(plan.aplicado)} del pasivo` +
                   (plan.sobrante > 0 ? ` · ${fmt(plan.sobrante)} como gasto por defecto de provisión` : ''),
      usuarioId: adminId, usuarioNombre: req.user.email, documento: numero,
      datos: {
        egresoId: egresoRef.id, pagoId: pagoRef.id, concepto, monto: num(monto),
        aplicado: plan.aplicado, sobrante: plan.sobrante,
        provisionesAfectadas: Object.keys(porProvision).length
      }
    });

    res.status(201).json({
      ok: true,
      numero,
      egresoId: egresoRef.id,
      pagoId: pagoRef.id,
      aplicadoAProvision: plan.aplicado,
      excedenteGasto: plan.sobrante,
      saldoDespues: plan.saldoDespues,
      provisionesAfectadas: Object.keys(porProvision).length,
      mensaje: plan.sobrante > 0
        ? `Pago registrado. ${fmt(plan.aplicado)} descargaron el pasivo y ${fmt(plan.sobrante)} quedaron como gasto del período (se había provisionado de menos).`
        : `Pago registrado. Se descargaron ${fmt(plan.aplicado)} del pasivo de ${etiquetaConcepto}. No es gasto: ya se había causado mes a mes.`
    });
  } catch (e) {
    console.error('POST prestaciones/pagar:', e);
    res.status(500).json({ error: e.message || 'Error al registrar el pago de prestaciones' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/prestaciones/liquidacion/:empleadoId/preview
// ─────────────────────────────────────────────────────────────────────────────
// "¿Cuánto cuesta terminar este contrato hoy?" — sin escribir nada.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/liquidacion/:empleadoId/preview', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const r = await cargarEmpleado(req.params.empleadoId, adminId);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const empleado = r.empleado;

    const anticipos = await cargarAnticipos(adminId, empleado);
    const salarioPend = diasSalarioPendiente(anticipos.comprobantes, empleado, req.body.fechaRetiro || hoyCO());
    const liq = N.liquidarContrato(empleado, {
      fechaRetiro: req.body.fechaRetiro || hoyCO(),
      motivo: req.body.motivo || 'sin_justa_causa',
      diasVacacionesPendientes: req.body.diasVacacionesPendientes,
      fechaUltimasVacaciones: req.body.fechaUltimasVacaciones,
      salarioBaseIndemnizacion: req.body.salarioBaseIndemnizacion,
      // ✅ FIX NOMINA-DIAS-PENDIENTES-001: si el usuario no lo fija a mano,
      // se calcula desde los comprobantes ya emitidos — no los días trabajados.
      diasSalarioPendiente: (req.body.diasSalarioPendiente === undefined ||
                             req.body.diasSalarioPendiente === null ||
                             req.body.diasSalarioPendiente === '')
        ? salarioPend.dias : req.body.diasSalarioPendiente,
      otrosDevengados: req.body.otrosDevengados,
      otrasDeducciones: req.body.otrasDeducciones,
      fechaFinObra: req.body.fechaFinObra,
      // ✅ NOMINA-PRIMA-SEMESTRE-001
      incluirPrimaSemestreAnterior: req.body.incluirPrimaSemestreAnterior === true,
      // ✅ NOMINA-ANTICIPOS-LIQUIDACION-001
      anticipos: req.body.cruzarAnticipos === false ? [] : anticipos.pendientes,
    });

    // Contraste con el pasivo realmente causado: acá se ve si la empresa
    // provisionó bien o si le va a doler el bolsillo.
    const provisiones = await cargarProvisiones(adminId);
    const pasivo = PL.consolidarPasivo(provisiones, { empleadoId: empleado.id });
    const montos = {};
    for (const c of PL.CONCEPTOS) montos[c] = num(liq.prestaciones?.[c]?.valor);
    const plan = PL.planificarAplicacionMultiple(provisiones, montos, { empleadoId: empleado.id });

    const brecha = liq.totalPrestaciones - plan.totalAplicado;
    const comparacion = {
      liquidacionCalculada: liq.totalPrestaciones,
      pasivoDisponible: pasivo.total,
      seDescargaDelPasivo: plan.totalAplicado,
      gastoAdicionalPorDefectoDeProvision: Math.max(0, brecha),
      provisionSobrante: Math.max(0, pasivo.total - plan.totalAplicado),
      porConcepto: PL.CONCEPTOS.map(c => ({
        clave: c, etiqueta: PL.ETIQUETAS[c],
        liquidacion: montos[c],
        pasivo: pasivo.porConcepto[c],
        aplica: plan.planes[c]?.aplicado || 0,
        faltante: plan.planes[c]?.sobrante || 0,
      })),
    };

    if (brecha > 0) {
      liq.avisos.push({
        nivel: 'media',
        texto: `La liquidación supera en ${fmt(brecha)} lo que se tenía provisionado para este empleado. ` +
               `Esa diferencia es gasto del período. Suele pasar cuando no se causaron todos los meses ` +
               `o cuando la provisión no incluyó horas extras.`
      });
    }

    // ✅ NOMINA-ANTICIPOS-LIQUIDACION-001: plata que ya se le entregó y hay
    // que recuperar antes de pagarle la liquidación.
    if (anticipos.totalSospechosos > 0) {
      liq.avisos.push({
        nivel: 'grave',
        texto: `Hay ${anticipos.sospechosos.length} egreso(s) a nombre de ${empleado.nombre} por ` +
               `${fmt(anticipos.totalSospechosos)} que NO están marcados como anticipo de nómina, ` +
               `así que no se están descontando. Si eran plata que se le entregó, andá a Egresos, ` +
               `editalos, marcalos como anticipo y enlazalos al empleado — o descontalos a mano acá. ` +
               `Si no los recuperás ahora, se pierden: el contrato termina hoy.`
      });
    }

    // Preaviso de término fijo — el aviso que evita una renovación por descuido
    const preaviso = N.estadoPreavisoFijo(empleado, hoyCO());

    res.json({ liquidacion: liq, comparacion, preaviso, pasivoEmpleado: pasivo, anticipos, salarioPendiente: salarioPend });
  } catch (e) {
    console.error('POST prestaciones/liquidacion/preview:', e);
    res.status(500).json({ error: e.message || 'Error al calcular la liquidación' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/prestaciones/liquidacion/:empleadoId
// ─────────────────────────────────────────────────────────────────────────────
// Confirma la liquidación:
//   · descarga el pasivo causado
//   · registra el gasto NUEVO (indemnización + salario pendiente) para el ERI
//   · genera la CxP a nombre del empleado (egreso PENDIENTE)
//   · desactiva al empleado con su fecha de retiro
//
// NO mueve caja: se paga después desde el módulo CxP.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/liquidacion/:empleadoId', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede liquidar un contrato' });
    }
    const adminId = resolverAdminId(req);
    const { pin, empresaId, notas } = req.body;

    const verif = await verificarPin(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    const r = await cargarEmpleado(req.params.empleadoId, adminId);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const empleado = r.empleado;

    if (empleado.activo === false && empleado.liquidado === true) {
      return res.status(400).json({ error: 'Este empleado ya fue liquidado' });
    }

    const fechaRetiro = String(req.body.fechaRetiro || hoyCO()).slice(0, 10);
    const anticipos = await cargarAnticipos(adminId, empleado);
    const salarioPend = diasSalarioPendiente(anticipos.comprobantes, empleado, fechaRetiro);
    const liq = N.liquidarContrato(empleado, {
      fechaRetiro,
      motivo: req.body.motivo || 'sin_justa_causa',
      diasVacacionesPendientes: req.body.diasVacacionesPendientes,
      fechaUltimasVacaciones: req.body.fechaUltimasVacaciones,
      salarioBaseIndemnizacion: req.body.salarioBaseIndemnizacion,
      // ✅ FIX NOMINA-DIAS-PENDIENTES-001: si el usuario no lo fija a mano,
      // se calcula desde los comprobantes ya emitidos — no los días trabajados.
      diasSalarioPendiente: (req.body.diasSalarioPendiente === undefined ||
                             req.body.diasSalarioPendiente === null ||
                             req.body.diasSalarioPendiente === '')
        ? salarioPend.dias : req.body.diasSalarioPendiente,
      otrosDevengados: req.body.otrosDevengados,
      otrasDeducciones: req.body.otrasDeducciones,
      fechaFinObra: req.body.fechaFinObra,
      // ✅ NOMINA-PRIMA-SEMESTRE-001
      incluirPrimaSemestreAnterior: req.body.incluirPrimaSemestreAnterior === true,
      // ✅ NOMINA-ANTICIPOS-LIQUIDACION-001
      anticipos: req.body.cruzarAnticipos === false ? [] : anticipos.pendientes,
    });

    if (liq.avisos.some(a => a.nivel === 'grave' && /fecha de ingreso|fecha de retiro|anterior a la de ingreso/i.test(a.texto))) {
      return res.status(400).json({ error: 'Datos insuficientes para liquidar', liquidacion: liq });
    }
    if (liq.netoAPagar < 0) {
      return res.status(400).json({
        error: `El neto a pagar es negativo (${fmt(liq.netoAPagar)}). Revisá las deducciones.`,
        liquidacion: liq
      });
    }

    const provisiones = await cargarProvisiones(adminId);
    const montos = {};
    for (const c of PL.CONCEPTOS) montos[c] = num(liq.prestaciones?.[c]?.valor);
    const plan = PL.planificarAplicacionMultiple(provisiones, montos, { empleadoId: empleado.id });

    // El gasto NUEVO del período: indemnización, salario pendiente, otros
    // devengados y la parte de prestaciones que no alcanzó a estar provisionada.
    const defectoProvision = Math.max(0, liq.totalPrestaciones - plan.totalAplicado);

    // ═══════════════════════════════════════════════════════════════════════
    // ✅ FIX NOMINA-LIBERACION-001 · liberar la provisión que sobra
    // ───────────────────────────────────────────────────────────────────────
    // Casi siempre sobra provisión al liquidar, y por dos razones legítimas:
    //
    //   · Se causó el mes completo pero el trabajador salió a mitad de mes.
    //   · Los intereses se provisionan al 1% mensual de la base — una
    //     aproximación estándar que sobreprovisiona el primer año, porque el
    //     saldo real de cesantías todavía era pequeño.
    //
    // Ese sobrante YA NO ES UNA DEUDA: el contrato terminó y no hay a quién
    // pagárselo. Si se deja vivo, el balance queda con un pasivo fantasma —
    // exactamente el problema que este módulo vino a resolver, pero al revés.
    //
    // Liberarlo es una RECUPERACIÓN: reduce el gasto de personal del período
    // en que se liquida, porque en su momento se registró de más.
    // ═══════════════════════════════════════════════════════════════════════
    const pasivoEmpleado = PL.consolidarPasivo(provisiones, { empleadoId: empleado.id });
    const provisionLiberada = Math.max(0, pasivoEmpleado.total - plan.totalAplicado);

    // Puede quedar negativo si la indemnización o el salario pendiente no
    // alcanzan a compensar la liberación. Es correcto: es una recuperación neta.
    const gastoNuevoTotal = num(liq.contabilidad?.gastoNuevo) + defectoProvision - provisionLiberada;

    const numero = await siguienteNumeroEgreso(adminId);

    // ─── 1. CxP a nombre del empleado (egreso PENDIENTE) ──────────────────────
    const egreso = {
      userId: adminId,
      numero,
      concepto: `Liquidación de contrato · ${empleado.nombre} · ${liq.motivoEtiqueta}`,
      proveedor: empleado.nombre,
      categoria: 'Liquidación de contrato',
      monto: liq.netoAPagar,
      totalPagar: liq.netoAPagar,
      montoPagado: 0,
      saldo: liq.netoAPagar,
      ivaVal: 0, ivaPct: 0, retenVal: 0, retenPct: 0,
      formaPago: 'Cuenta por Pagar',
      cajaId: '',
      empresaId: empresaId || '',
      fecha: fechaRetiro,
      notas: notas || '',
      tipo: 'liquidacion_contrato',
      // PENDIENTE → `cxp.js` lo toma como deuda automáticamente, sin cambios allá
      estado: 'PENDIENTE',
      cuadrado: true, legalizado: true,
      // El ERI NO lo cuenta como gasto: las prestaciones ya se causaron y el
      // gasto nuevo se registra aparte en `liquidaciones_contrato`.
      esPagoPasivoLaboral: true,
      esLiquidacionContrato: true,
      empleadoId: empleado.id,
      empleadoNombre: empleado.nombre,
      empleadoDocumento: empleado.documento || '',
      liquidacion: {
        motivo: liq.motivo,
        motivoEtiqueta: liq.motivoEtiqueta,
        fechaInicio: liq.fechaInicio,
        fechaRetiro: liq.fechaRetiro,
        prestaciones: liq.prestaciones,
        totalPrestaciones: liq.totalPrestaciones,
        salarioPendiente: liq.salarioPendiente,
        auxilioPendiente: liq.auxilioPendiente,
        indemnizacion: liq.indemnizacion,
        deducciones: liq.deducciones,
        totalDeducciones: liq.totalDeducciones,
        totalADevengar: liq.totalADevengar,
        netoAPagar: liq.netoAPagar,
      },
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const egresoRef = await db.collection('egresos').add(egreso);

    const batch = db.batch();
    // Se crea la referencia antes del descargue: las provisiones liberadas
    // apuntan a la liquidación que las cerró.
    const liqRef = db.collection('liquidaciones_contrato').doc();
    const liqRefId = liqRef.id;

    // ─── 2. Descargue del pasivo ──────────────────────────────────────────────
    const porProvision = {};
    for (const a of plan.aplicaciones) {
      (porProvision[a.provisionId] = porProvision[a.provisionId] || []).push(a);
    }
    // ✅ FIX NOMINA-LIBERACION-001: TODAS las provisiones del empleado se
    // cierran, no solo las que el pago alcanzó a tocar. Lo aplicado se registra;
    // lo que sobra se marca como liberado. Después de liquidar, este empleado
    // no puede seguir apareciendo en el pasivo.
    const provisionesEmpleado = provisiones.filter(
      p => p.empleadoId === empleado.id && p.revertida !== true
    );
    for (const prov of provisionesEmpleado) {
      const aplicaciones = porProvision[prov.id] || [];
      const aplicadoNuevo = PL.mezclarAplicado(prov, aplicaciones);
      batch.update(db.collection('provisiones_prestaciones').doc(prov.id), {
        aplicado: aplicadoNuevo,
        pagada: true,
        // El saldo que no se pagó deja de ser deuda: el contrato terminó.
        liberada: true,
        liberadaEnLiquidacion: liqRefId,
        liquidadaEn: egresoRef.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // ─── 3. La liquidación: su `gastoNuevo` es lo que el ERI debe causar ──────
    batch.set(liqRef, {
      userId: adminId,
      egresoId: egresoRef.id,
      numero,
      empleadoId: empleado.id,
      empleadoNombre: empleado.nombre,
      empleadoDocumento: empleado.documento || '',
      tipoContrato: liq.tipoContrato,
      motivo: liq.motivo,
      motivoEtiqueta: liq.motivoEtiqueta,
      fechaInicio: liq.fechaInicio,
      fechaRetiro,
      periodo: fechaRetiro.slice(0, 7),
      anio: Number(fechaRetiro.slice(0, 4)),
      mes: Number(fechaRetiro.slice(5, 7)),
      prestaciones: liq.prestaciones,
      totalPrestaciones: liq.totalPrestaciones,
      descargadoDelPasivo: plan.totalAplicado,
      defectoProvision,
      // ✅ NOMINA-LIBERACION-001: sobreprovisión que deja de ser deuda al
      // terminar el contrato. Reduce el gasto del período (recuperación).
      provisionLiberada,
      indemnizacion: liq.indemnizacion || null,
      valorIndemnizacion: num(liq.indemnizacion?.valor),
      salarioPendiente: liq.salarioPendiente,
      auxilioPendiente: liq.auxilioPendiente,
      // ⚠️ Este es el número que el ERI suma a gasto_personal.
      gastoNuevoTotal,
      deducciones: liq.deducciones,
      totalDeducciones: liq.totalDeducciones,
      netoAPagar: liq.netoAPagar,
      avisos: liq.avisos,
      anulada: false,
      empresaId: empresaId || '',
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ─── 4. Registro del pago que descargó el pasivo ──────────────────────────
    const pagoRef = db.collection('pagos_prestaciones').doc();
    batch.set(pagoRef, {
      userId: adminId,
      egresoId: egresoRef.id,
      liquidacionId: liqRef.id,
      numero,
      concepto: 'liquidacion',
      conceptoEtiqueta: 'Liquidación de contrato',
      tipoPago: 'liquidacion_contrato',
      tipoPagoEtiqueta: PL.TIPOS_PAGO.liquidacion_contrato.etiqueta,
      empleadoId: empleado.id,
      empleadoNombre: empleado.nombre,
      beneficiario: empleado.nombre,
      monto: liq.totalPrestaciones,
      aplicadoAProvision: plan.totalAplicado,
      excedenteGasto: defectoProvision,
      aplicaciones: plan.aplicaciones,
      fecha: fechaRetiro,
      periodo: fechaRetiro.slice(0, 7),
      anulado: false,
      naturaleza: 'descargue_pasivo',
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // ─── 4b. Marcar los anticipos como cruzados ───────────────────────────────
    // ✅ NOMINA-ANTICIPOS-LIQUIDACION-001: si se descontaron en la liquidación,
    // dejan de estar pendientes. Sin esto reaparecerían como deuda viva de
    // alguien que ya no trabaja acá.
    for (const a of (liq.anticipos || [])) {
      batch.update(db.collection('egresos').doc(a.egresoId), {
        cruzadoEnNomina: true,
        cruzadoEnLiquidacion: liqRefId,
        cruzadoEnEgresoNumero: numero,
        cruzadoEn: new Date().toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // ─── 5. Retirar al empleado ───────────────────────────────────────────────
    batch.update(db.collection('empleados').doc(empleado.id), {
      activo: false,
      fechaFin: fechaRetiro,
      liquidado: true,
      liquidacionId: liqRef.id,
      motivoRetiro: liq.motivo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    await registrarAuditoria({
      accion: 'LIQUIDACION_CONTRATO', modulo: 'prestaciones',
      descripcion: `Liquidación ${numero} · ${empleado.nombre} · ${liq.motivoEtiqueta} · ` +
                   `neto ${fmt(liq.netoAPagar)}` +
                   (num(liq.indemnizacion?.valor) > 0 ? ` · indemnización ${fmt(liq.indemnizacion.valor)}` : '') +
                   ` · descargó ${fmt(plan.totalAplicado)} del pasivo`,
      usuarioId: adminId, usuarioNombre: req.user.email, documento: numero,
      datos: {
        egresoId: egresoRef.id, liquidacionId: liqRef.id, empleadoId: empleado.id,
        fechaRetiro, motivo: liq.motivo,
        totalPrestaciones: liq.totalPrestaciones,
        indemnizacion: num(liq.indemnizacion?.valor),
        descargadoDelPasivo: plan.totalAplicado,
        gastoNuevoTotal, netoAPagar: liq.netoAPagar
      }
    });

    res.status(201).json({
      ok: true,
      numero,
      egresoId: egresoRef.id,
      liquidacionId: liqRef.id,
      liquidacion: liq,
      descargadoDelPasivo: plan.totalAplicado,
      defectoProvision,
      provisionLiberada,
      gastoNuevoTotal,
      mensaje: `Liquidación ${numero} generada por ${fmt(liq.netoAPagar)}. ` +
               `Quedó como Cuenta por Pagar a nombre de ${empleado.nombre}: pagala desde el módulo CxP. ` +
               `Se descargaron ${fmt(plan.totalAplicado)} del pasivo provisionado.`
    });
  } catch (e) {
    console.error('POST prestaciones/liquidacion:', e);
    res.status(500).json({ error: e.message || 'Error al liquidar el contrato' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/prestaciones/retroactivas
// ─────────────────────────────────────────────────────────────────────────────
// Causa las provisiones de un empleado para un RANGO de meses de una sola vez.
//
// POR QUÉ EXISTE: al registrar un empleado que ya venía trabajando, había que
// ir mes por mes cambiando el período y dándole "Causar" — y cada clic tocaba
// además a todos los demás empleados de ese mes.
//
// Es idempotente: los meses ya causados se omiten, no se duplican.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/retroactivas', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede causar provisiones' });
    }
    const adminId = resolverAdminId(req);
    const { empleadoId, desde, hasta, salariosHistoricos } = req.body;

    const r = await cargarEmpleado(empleadoId, adminId);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const empleado = r.empleado;

    const desdeISO = String(desde || empleado.fechaInicio || '').slice(0, 10);
    const hastaISO = String(hasta || hoyCO()).slice(0, 10);
    if (!desdeISO) return res.status(400).json({ error: 'Indicá desde qué mes causar (o registrá la fecha de ingreso del empleado)' });
    if (hastaISO < desdeISO) return res.status(400).json({ error: 'El rango de fechas está invertido' });

    const meses = N.mesesEntre(desdeISO, hastaISO);
    if (meses.length === 0) return res.status(400).json({ error: 'El rango no contiene meses válidos' });
    if (meses.length > 60) return res.status(400).json({ error: 'El rango no puede superar 60 meses' });

    const [cfgDoc, yaSnap, egSnap] = await Promise.all([
      db.collection('configuracion').doc(adminId).get(),
      db.collection('provisiones_prestaciones')
        .where('userId', '==', adminId).where('empleadoId', '==', empleadoId).get(),
      db.collection('egresos').where('userId', '==', adminId).select('esComprobanteNomina', 'anulado', 'periodoNomina', 'empleadoId', 'liquidacion', 'numero').get()
    ]);
    const empresaExonerada = cfgDoc.exists ? (cfgDoc.data().empresaExoneradaAportes !== false) : true;

    const yaCausados = new Set();
    yaSnap.forEach(d => {
      const p = d.data();
      if (p.revertida === true) return;
      yaCausados.add(p.periodo || `${p.anio}-${String(p.mes).padStart(2, '0')}`);
    });

    // Comprobantes de nómina del empleado, para incluir horas extras en la base
    const comprobantes = egSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(e => e.esComprobanteNomina === true && e.anulado !== true && e.empleadoId === empleadoId);

    // Salarios históricos opcionales: [{ desde: 'YYYY-MM', salario: n }]
    const tramos = Array.isArray(salariosHistoricos)
      ? salariosHistoricos
          .map(t => ({ desde: String(t.desde || '').slice(0, 7), salario: num(t.salario) }))
          .filter(t => t.desde && t.salario > 0)
          .sort((a, b) => a.desde.localeCompare(b.desde))
      : [];
    const salarioDelPeriodo = (clave) => {
      let s = num(empleado.salario);
      for (const t of tramos) { if (t.desde <= clave) s = t.salario; }
      return s;
    };

    const batch = db.batch();
    const creadas = [];
    const omitidos = [];
    let totalPrestaciones = 0;

    for (const m of meses) {
      if (yaCausados.has(m.clave)) { omitidos.push({ periodo: m.clave, razon: 'Ya causada' }); continue; }
      if (!N.vigenteEnMes(empleado, m.anio, m.mes)) { omitidos.push({ periodo: m.clave, razon: 'Fuera del período de vinculación' }); continue; }
      const dias = N.diasTrabajadosEnMes(empleado, m.anio, m.mes);
      if (dias <= 0) { omitidos.push({ periodo: m.clave, razon: 'Sin días trabajados' }); continue; }

      const compsMes = comprobantes.filter(c => {
        const pn = c.periodoNomina || {};
        return Number(pn.anio) === m.anio && Number(pn.mes) === m.mes;
      });
      const extras = N.devengadoAdicionalDeComprobantes(compsMes);

      const empleadoDelPeriodo = { ...empleado, salario: salarioDelPeriodo(m.clave) };
      const p = N.calcularProvisionMensual(empleadoDelPeriodo, {
        anio: m.anio, mes: m.mes, diasTrabajados: dias,
        empresaExonerada, devengadoAdicional: extras.total
      });

      if (!p.aplicaProvision) { omitidos.push({ periodo: m.clave, razon: p.motivoNoAplica }); continue; }

      const ref = db.collection('provisiones_prestaciones').doc();
      batch.set(ref, {
        userId: adminId,
        empleadoId: empleado.id,
        empleadoNombre: empleado.nombre,
        empleadoDocumento: empleado.documento,
        tipoContrato: empleado.tipoContrato,
        anio: m.anio, mes: m.mes, periodo: m.clave,
        diasTrabajados: dias,
        salario: empleadoDelPeriodo.salario,
        auxilioTransporte: p.auxilioTransporte,
        baseConAuxilio: p.baseConAuxilio,
        baseSinAuxilio: p.baseSinAuxilio,
        devengadoAdicional: extras.total,
        devengadoAdicionalDetalle: extras.detalle,
        prestaciones: p.prestaciones,
        totalPrestaciones: p.totalPrestaciones,
        seguridadSocialPatronal: p.seguridadSocialPatronal,
        totalSeguridadSocial: p.totalSeguridadSocial,
        costoTotalEmpleador: p.costoTotalEmpleador,
        naturaleza: 'pasivo',
        tipoERI: 'gasto_personal',
        aplicado: { cesantias: 0, interesesCesantias: 0, prima: 0, vacaciones: 0 },
        pagada: false,
        revertida: false,
        retroactiva: true,
        causadaPor: req.user.email,
        causadaEn: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      creadas.push({ periodo: m.clave, valor: p.totalPrestaciones, dias, extras: extras.total });
      totalPrestaciones += p.totalPrestaciones;
    }

    if (creadas.length === 0) {
      return res.status(400).json({ error: 'No hay meses nuevos para causar en ese rango', omitidos });
    }

    await batch.commit();

    await registrarAuditoria({
      accion: 'PROVISIONES_RETROACTIVAS', modulo: 'prestaciones',
      descripcion: `Provisiones retroactivas de ${empleado.nombre}: ${creadas.length} mes(es) ` +
                   `(${creadas[0].periodo} a ${creadas[creadas.length - 1].periodo}) por ${fmt(totalPrestaciones)}`,
      usuarioId: adminId, usuarioNombre: req.user.email,
      documento: `PROV-RETRO-${empleado.documento || empleado.id}`,
      datos: { empleadoId: empleado.id, desde: desdeISO, hasta: hastaISO, creadas, omitidos, totalPrestaciones }
    });

    res.status(201).json({
      ok: true,
      empleado: empleado.nombre,
      mesesCausados: creadas.length,
      totalPrestaciones,
      creadas, omitidos,
      avisos: tramos.length === 0 ? [{
        nivel: 'media',
        texto: 'Se usó el salario ACTUAL para todos los meses. Si el empleado tuvo aumentos, ' +
               'cargá los salarios históricos para que cada mes se provisione con el suyo.'
      }] : [],
      mensaje: `Se causaron ${creadas.length} mes(es) por ${fmt(totalPrestaciones)}.`
    });
  } catch (e) {
    console.error('POST prestaciones/retroactivas:', e);
    res.status(500).json({ error: e.message || 'Error al causar provisiones retroactivas' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET  /api/prestaciones/pila   · saldo de aportes patronales causados
// POST /api/prestaciones/pila   · registra el pago de la planilla
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ FASE 3 — SOLO APLICA SI `causarSeguridadSocial` ESTÁ ENCENDIDO.
//
// Con el interruptor apagado (el estado por defecto) los aportes patronales NO
// son pasivo: entran al gasto cuando se digita la PILA como egreso normal con
// categoría "Nómina", que es como venía funcionando. Este endpoint devuelve
// saldo cero y rechaza el pago, para que nadie lo use por error y termine
// descontando de un pasivo que no existe.
//
// Con el interruptor encendido, los aportes se causan mes a mes y la PILA se
// paga POR ACÁ. Digitarla como egreso "Nómina" contaría el gasto dos veces.
// ═════════════════════════════════════════════════════════════════════════════
const leerFlagSS = async (adminId) => {
  const cfg = await db.collection('configuracion').doc(adminId).get();
  return cfg.exists ? (cfg.data().causarSeguridadSocial === true) : false;
};

/** Comprobantes de nómina del tenant — de ahí sale la retención al trabajador. */
const cargarComprobantes = async (adminId) => {
  const snap = await db.collection('egresos').where('userId', '==', adminId)
    .select('esComprobanteNomina', 'anulado', 'periodoNomina', 'empleadoId', 'empleadoNombre',
            'numero', 'fecha', 'retencionSeguridadSocial', 'causaRetencionEmpleado',
            'aplicadoRetencionEmpleado').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

router.get('/pila', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const [activo, provisiones, comprobantes] = await Promise.all([
      leerFlagSS(adminId), cargarProvisiones(adminId), cargarComprobantes(adminId)
    ]);
    const filtro = { empleadoId: req.query.empleadoId || undefined };
    const patronal = PL.consolidarSeguridadSocial(provisiones, filtro);
    const retencion = PL.consolidarRetencionEmpleado(comprobantes, filtro);

    res.json({
      causacionActiva: activo,
      // Compatibilidad con la primera versión de la pantalla
      ...patronal,
      patronal,
      retencionEmpleado: retencion,
      // Lo que hay que consignar: las dos partes juntas
      totalAPagar: patronal.saldo + retencion.saldo,
      nota: activo
        ? 'Los aportes patronales y la retención al trabajador están causados como pasivo. ' +
          'Pagá la PILA desde acá para descargar las dos partes — no como egreso categoría "Nómina", ' +
          'o el gasto se contaría dos veces.'
        : 'La causación está APAGADA (comportamiento por defecto). Seguí digitando la planilla PILA ' +
          'como egreso con categoría "Nómina". Los valores de acá son informativos.',
      // Guía para nómina quincenal — es donde más se enreda la contabilización
      notaQuincenal:
        'Con nómina quincenal se retiene dos veces al mes (el 15 y el 30) y la PILA se paga una sola ' +
        'vez en los primeros días hábiles del mes siguiente, según los dos últimos dígitos del NIT. ' +
        'Cada comprobante de quincena retiene su parte; acá se suman y se descargan juntas al pagar.'
    });
  } catch (e) {
    console.error('GET prestaciones/pila:', e);
    res.status(500).json({ error: 'Error al consultar el pasivo de seguridad social' });
  }
});

router.post('/pila', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede registrar el pago de la PILA' });
    }
    const adminId = resolverAdminId(req);
    const { monto, cajaId, formaPago, empresaId, fecha, operador, notas, pin } = req.body;

    const activo = await leerFlagSS(adminId);
    if (!activo) {
      return res.status(409).json({
        codigo: 'CAUSACION_SS_APAGADA',
        error: 'La causación de aportes patronales está apagada. Mientras siga así, la planilla PILA se ' +
               'registra como un egreso normal con categoría "Nómina" desde el módulo de Egresos. ' +
               'Usar este endpoint descontaría de un pasivo que todavía no existe.'
      });
    }

    const verif = await verificarPin(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });
    if (num(monto) <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a cero' });
    if (!cajaId) return res.status(400).json({ error: 'Indicá desde qué caja o banco sale el pago' });

    const [provisiones, comprobantes] = await Promise.all([
      cargarProvisiones(adminId), cargarComprobantes(adminId)
    ]);

    // ═══════════════════════════════════════════════════════════════════════
    // La PILA lleva DOS bolsas y el orden de aplicación importa.
    // ───────────────────────────────────────────────────────────────────────
    // Primero se descarga la RETENCIÓN al trabajador, porque esa plata nunca
    // fue de la empresa: se le descontó del pago y estaba guardada. Después
    // los aportes patronales, que sí son costo de la empresa.
    //
    // Si el pago no alcanza para las dos, es mejor que quede debiendo aportes
    // propios y no plata del trabajador.
    // ═══════════════════════════════════════════════════════════════════════
    const planRet = PL.planificarAplicacionRetencion(comprobantes, num(monto));
    const plan = PL.planificarAplicacionSS(provisiones, planRet.sobrante);
    const sobranteFinal = plan.sobrante;

    const fechaPago = String(fecha || hoyCO()).slice(0, 10);
    const numero = await siguienteNumeroEgreso(adminId);

    const egresoRef = await db.collection('egresos').add({
      userId: adminId, numero,
      concepto: `Planilla PILA${operador ? ` · ${operador}` : ''} · aportes patronales y retención al trabajador`,
      proveedor: operador || 'Operador PILA',
      categoria: 'Pago de prestaciones sociales',
      monto: num(monto), totalPagar: num(monto),
      ivaVal: 0, ivaPct: 0, retenVal: 0, retenPct: 0,
      formaPago: formaPago || '', cajaId, empresaId: empresaId || '',
      fecha: fechaPago, fechaPago, notas: notas || '',
      tipo: 'pago_pila', estado: 'PAGADO', cuadrado: true, legalizado: true,
      esPagoPasivoLaboral: true,
      conceptoPasivo: 'seguridadSocial',
      descargaRetencionEmpleado: planRet.aplicado,
      descargaAportesPatronales: plan.aplicado,
      excedenteGasto: sobranteFinal,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const batch = db.batch();
    // Descargue de la retención al trabajador (sobre los comprobantes)
    for (const a of planRet.aplicaciones) {
      batch.update(db.collection('egresos').doc(a.comprobanteId), {
        aplicadoRetencionEmpleado: a.aplicadoDespues,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    // Descargue de los aportes patronales (sobre las provisiones)
    for (const a of plan.aplicaciones) {
      batch.update(db.collection('provisiones_prestaciones').doc(a.provisionId), {
        aplicadoSeguridadSocial: a.aplicadoDespues,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    const pagoRef = db.collection('pagos_prestaciones').doc();
    batch.set(pagoRef, {
      userId: adminId, egresoId: egresoRef.id, numero,
      concepto: 'seguridadSocial',
      conceptoEtiqueta: 'PILA · aportes patronales y retención',
      tipoPago: 'pila', tipoPagoEtiqueta: 'Planilla PILA',
      beneficiario: operador || 'Operador PILA',
      monto: num(monto),
      aplicadoAProvision: plan.aplicado,
      aplicadoARetencion: planRet.aplicado,
      excedenteGasto: sobranteFinal,
      aplicaciones: [...planRet.aplicaciones, ...plan.aplicaciones],
      fecha: fechaPago, periodo: fechaPago.slice(0, 7),
      cajaId, formaPago: formaPago || '', empresaId: empresaId || '',
      anulado: false, naturaleza: 'descargue_pasivo',
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await batch.commit();

    const cajaRef = db.collection('cajas').doc(cajaId);
    const cajaDoc = await cajaRef.get();
    if (cajaDoc.exists) {
      await cajaRef.update({
        saldo: admin.firestore.FieldValue.increment(-num(monto)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('movimientos').add({
        userId: adminId, cajaId, tipo: 'egreso', monto: num(monto),
        concepto: 'Planilla PILA · aportes patronales', referencia: numero,
        formaPago: formaPago || '', creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await registrarAuditoria({
      accion: 'PAGO_PILA', modulo: 'prestaciones',
      descripcion: `Planilla PILA por ${fmt(num(monto))} · retención al trabajador ${fmt(planRet.aplicado)} · ` +
                   `aportes patronales ${fmt(plan.aplicado)}` +
                   (sobranteFinal > 0 ? ` · ${fmt(sobranteFinal)} como gasto del período` : ''),
      usuarioId: adminId, usuarioNombre: req.user.email, documento: numero,
      datos: {
        egresoId: egresoRef.id, pagoId: pagoRef.id, monto: num(monto),
        aplicadoRetencion: planRet.aplicado, aplicadoAportes: plan.aplicado, sobrante: sobranteFinal
      }
    });

    res.status(201).json({
      ok: true, numero, egresoId: egresoRef.id,
      aplicadoARetencionEmpleado: planRet.aplicado,
      aplicadoAProvision: plan.aplicado,
      excedenteGasto: sobranteFinal,
      saldoRetencionDespues: planRet.saldoDespues,
      saldoAportesDespues: plan.saldoDespues,
      mensaje: `Planilla registrada. Se descargaron ${fmt(planRet.aplicado)} de retención al trabajador y ` +
               `${fmt(plan.aplicado)} de aportes patronales. No es gasto: ya se causó con la nómina.`
    });
  } catch (e) {
    console.error('POST prestaciones/pila:', e);
    res.status(500).json({ error: e.message || 'Error al registrar el pago de la PILA' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/prestaciones/alertas
// ─────────────────────────────────────────────────────────────────────────────
// Avisos que dependen de los DATOS del tenant, no de una fecha fija del
// calendario: preaviso de término fijo por empleado, meses sin causar, y el
// saldo real de cada obligación cuando se acerca su vencimiento.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/alertas', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const hoy = hoyCO();
    const anio = Number(hoy.slice(0, 4));
    const mes = Number(hoy.slice(5, 7));

    const [empSnap, provisiones] = await Promise.all([
      db.collection('empleados').where('userId', '==', adminId).get(),
      cargarProvisiones(adminId)
    ]);
    const empleados = empSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(e => e.activo !== false);

    const alertas = [];

    // ─── Preaviso de término fijo (art. 46 CST) ───────────────────────────────
    for (const emp of empleados) {
      const pre = N.estadoPreavisoFijo(emp, hoy);
      if (!pre) continue;
      if (pre.preavisoVencido) {
        alertas.push({
          id: `preaviso_vencido_${emp.id}`, nivel: 'grave', tipo: 'preaviso_fijo',
          empleadoId: emp.id, empleado: emp.nombre,
          titulo: `Se pasó el preaviso de ${emp.nombre}`,
          texto: pre.mensaje, fecha: pre.fechaFin
        });
      } else if (pre.enVentana) {
        alertas.push({
          id: `preaviso_${emp.id}`, nivel: 'media', tipo: 'preaviso_fijo',
          empleadoId: emp.id, empleado: emp.nombre,
          titulo: `Preaviso de no renovación · ${emp.nombre}`,
          texto: pre.mensaje, fecha: pre.fechaLimitePreaviso
        });
      } else if (pre.vencido) {
        alertas.push({
          id: `contrato_vencido_${emp.id}`, nivel: 'grave', tipo: 'contrato_vencido',
          empleadoId: emp.id, empleado: emp.nombre,
          titulo: `El contrato de ${emp.nombre} venció el ${pre.fechaFin}`,
          texto: pre.mensaje, fecha: pre.fechaFin
        });
      }
    }

    // ─── Meses sin causar ─────────────────────────────────────────────────────
    const causadosPorEmpleado = {};
    for (const p of provisiones) {
      if (p.revertida === true) continue;
      const k = p.empleadoId;
      (causadosPorEmpleado[k] = causadosPorEmpleado[k] || new Set())
        .add(p.periodo || `${p.anio}-${String(p.mes).padStart(2, '0')}`);
    }
    for (const emp of empleados) {
      const tipo = N.TIPOS_CONTRATO[emp.tipoContrato];
      if (!tipo?.generaPrestaciones) continue;
      const desde = String(emp.fechaInicio || '').slice(0, 10);
      if (!desde) continue;
      const meses = N.mesesEntre(desde, `${anio}-${String(mes).padStart(2, '0')}-01`);
      const set = causadosPorEmpleado[emp.id] || new Set();
      const faltantes = meses.filter(m => !set.has(m.clave)).map(m => m.clave);
      if (faltantes.length > 0) {
        alertas.push({
          id: `sin_causar_${emp.id}`, nivel: faltantes.length > 2 ? 'grave' : 'media',
          tipo: 'provision_faltante',
          empleadoId: emp.id, empleado: emp.nombre,
          titulo: `${emp.nombre} tiene ${faltantes.length} mes(es) sin provisionar`,
          texto: `Faltan: ${faltantes.slice(0, 12).join(', ')}${faltantes.length > 12 ? '…' : ''}. ` +
                 `Podés causarlos de una sola vez con "Causar retroactivas".`,
          meses: faltantes
        });
      }
    }

    // ─── Obligaciones del calendario con el saldo real ────────────────────────
    const pasivo = PL.consolidarPasivo(provisiones);
    const obligaciones = [
      { concepto: 'interesesCesantias', mes: 1,  dia: 31, titulo: 'Intereses a las cesantías' },
      { concepto: 'cesantias',          mes: 2,  dia: 14, titulo: 'Consignación de cesantías al fondo' },
      { concepto: 'prima',              mes: 6,  dia: 30, titulo: 'Prima del primer semestre' },
      { concepto: 'prima',              mes: 12, dia: 20, titulo: 'Prima de fin de año' },
    ];
    for (const o of obligaciones) {
      const limite = `${anio}-${String(o.mes).padStart(2, '0')}-${String(o.dia).padStart(2, '0')}`;
      const diasFaltan = Math.round((new Date(limite + 'T00:00:00') - new Date(hoy + 'T00:00:00')) / 86400000);
      if (diasFaltan < 0 || diasFaltan > 30) continue;
      const saldo = pasivo.porConcepto[o.concepto] || 0;
      if (saldo <= 0) continue;
      alertas.push({
        id: `oblig_${o.concepto}_${o.mes}`, nivel: diasFaltan <= 7 ? 'grave' : 'media',
        tipo: 'obligacion_laboral',
        titulo: `${o.titulo} — vence en ${diasFaltan} día(s)`,
        texto: `Tu pasivo acumulado de ${PL.ETIQUETAS[o.concepto]} es ${fmt(saldo)}. ` +
               `Registrá el pago desde Empleados → Pasivo laboral para que se descargue del balance.`,
        fecha: limite, concepto: o.concepto, saldo
      });
    }

    const orden = { grave: 0, media: 1, info: 2 };
    alertas.sort((a, b) => (orden[a.nivel] ?? 9) - (orden[b.nivel] ?? 9));

    res.json({ hoy, total: alertas.length, alertas, pasivoTotal: pasivo.total });
  } catch (e) {
    console.error('GET prestaciones/alertas:', e);
    res.status(500).json({ error: 'Error al calcular las alertas laborales' });
  }
});

module.exports = router;
