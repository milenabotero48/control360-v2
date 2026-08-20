// ═══════════════════════════════════════════════════════════════════════════════
// empleados.js — Maestro de empleados, provisiones de prestaciones y nómina
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PROVISIONES-001
//
// EL PROBLEMA QUE RESUELVE
// ------------------------
// El ERI de julio 2026 mostraba $15.440.975 de nómina. Ese número incluía
// pagos y seguridad social, pero NO las prestaciones sociales causadas:
// faltaban entre $2,5 y $2,8 millones MENSUALES ($30–34 millones al año).
//
// Además, los anticipos de nómina se registraban como GASTO. Eso está mal por
// partida doble:
//   1. Un anticipo no es gasto, es una cuenta por cobrar al empleado.
//   2. Si después se registra el salario completo, el gasto se duplica.
//
// ESTE MÓDULO ARREGLA LAS DOS COSAS:
//   · Genera provisiones mensuales de prestaciones → gasto + PASIVO
//   · Cruza los anticipos contra la nómina del período → sin duplicar
//
// COLECCIONES
//   empleados               · maestro
//   provisiones_prestaciones · una por empleado/mes, es el pasivo acumulado
//   egresos                  · el comprobante de nómina se crea aquí (reusa el módulo)
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { verificarPin } = require('./_autorizacion');
const N = require('../services/nominaColombia');
// ✅ NOMINA-PASIVO-001: el saldo del pasivo (causado − pagado) se calcula en un
// solo lugar y lo comparten esta ruta, prestaciones.js y el ERI.
const PL = require('../services/pasivoLaboral');

const resolverAdminId = (req) => req.adminId || req.user?.uid || req.user?.id || null;
const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const registrarAuditoria = async (datos) => {
  try {
    await db.collection('audit_logs').add({
      ...datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (e) { console.error('Auditoría empleados:', e); }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/empleados/config — catálogos para la UI
// ─────────────────────────────────────────────────────────────────────────────
// Se expone el motor de cálculo al frontend para que la pantalla explique los
// porcentajes en vez de mostrarlos como números mágicos.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/config', (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  res.json({
    parametros: N.parametrosAnio(anio),
    tiposContrato: Object.values(N.TIPOS_CONTRATO),
    prestaciones: N.PRESTACIONES,
    seguridadSocial: N.SEGURIDAD_SOCIAL,
    clasesRiesgoARL: N.CLASES_RIESGO_ARL,
    conceptosHoras: N.conceptosHoras(new Date().toISOString().slice(0, 10)),
    horasMes: N.HORAS_MES_LEGAL,
    aniosDisponibles: Object.keys(N.TABLA_ANUAL).map(Number).sort()
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/empleados — lista
// ═════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'No autenticado' });

    const snap = await db.collection('empleados').where('userId', '==', adminId).get();
    const lista = [];
    snap.forEach(d => lista.push({ id: d.id, ...d.data() }));

    lista.sort((a, b) => {
      const aAct = a.activo !== false, bAct = b.activo !== false;
      if (aAct !== bAct) return aAct ? -1 : 1;
      return String(a.nombre || '').localeCompare(String(b.nombre || ''));
    });

    res.json(lista);
  } catch (e) {
    console.error('GET empleados:', e);
    res.status(500).json({ error: 'Error al cargar empleados' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/empleados — crear
// ═════════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'No autenticado' });

    const {
      nombre, documento, tipoDocumento, cargo, tipoContrato, salario,
      fechaInicio, fechaFin, claseRiesgoARL, tarifaARLPersonalizada, auxilioTransporteManual,
      eps, fondoPension, fondoCesantias, caja, email, telefono, notas
    } = req.body;

    if (!nombre?.trim())   return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!documento?.trim()) return res.status(400).json({ error: 'El documento es obligatorio' });
    if (!fechaInicio)      return res.status(400).json({ error: 'La fecha de inicio es obligatoria' });

    const tipo = N.TIPOS_CONTRATO[tipoContrato];
    if (!tipo) return res.status(400).json({ error: 'Tipo de contrato inválido' });
    if (tipo.requiereFechaFin && !fechaFin) {
      return res.status(400).json({ error: 'Un contrato a término fijo requiere fecha de terminación' });
    }

    const sal = Number(salario) || 0;
    if (sal <= 0) return res.status(400).json({ error: 'El salario debe ser mayor a cero' });

    // Validaciones de coherencia laboral
    const anio = Number(String(fechaInicio).slice(0, 4)) || new Date().getFullYear();
    const P = N.parametrosAnio(anio);
    const avisos = [];

    if (tipo.esLaboral && sal < P.smmlv) {
      avisos.push(`El salario (${fmt(sal)}) es menor al mínimo legal de ${anio} (${fmt(P.smmlv)}). ` +
                  `Solo es válido si trabaja jornada parcial.`);
    }
    if (tipo.minimoSMMLV && sal < P.smmlv * tipo.minimoSMMLV) {
      return res.status(400).json({
        error: `El salario integral no puede ser menor a ${tipo.minimoSMMLV} SMMLV (${fmt(P.smmlv * tipo.minimoSMMLV)}). ` +
               `Son 10 SMMLV de salario más el 30% de factor prestacional.`
      });
    }

    // Documento único por suscriptor
    const existe = await db.collection('empleados')
      .where('userId', '==', adminId)
      .where('documento', '==', String(documento).trim())
      .limit(1).get();
    if (!existe.empty) {
      return res.status(400).json({ error: `Ya existe un empleado con documento ${documento}` });
    }

    const nuevo = {
      userId: adminId,
      nombre: nombre.trim(),
      nombreNorm: norm(nombre),         // para la detección automática en egresos
      documento: String(documento).trim(),
      tipoDocumento: tipoDocumento || 'CC',
      cargo: (cargo || '').trim(),
      tipoContrato: tipo.id,
      salario: sal,
      fechaInicio: String(fechaInicio).slice(0, 10),
      fechaFin: fechaFin ? String(fechaFin).slice(0, 10) : '',
      claseRiesgoARL: N.CLASES_RIESGO_ARL[claseRiesgoARL] ? claseRiesgoARL : 'III',
      // ✅ Tarifa REAL que la ARL asignó. Vacío = usa la inicial de la clase.
      tarifaARLPersonalizada: (tarifaARLPersonalizada === '' || tarifaARLPersonalizada === undefined || tarifaARLPersonalizada === null)
        ? null : Number(tarifaARLPersonalizada),
      auxilioTransporteManual: auxilioTransporteManual === '' || auxilioTransporteManual === undefined || auxilioTransporteManual === null
        ? null : Number(auxilioTransporteManual),
      eps: (eps || '').trim(),
      fondoPension: (fondoPension || '').trim(),
      fondoCesantias: (fondoCesantias || '').trim(),
      caja: (caja || '').trim(),
      email: (email || '').trim(),
      telefono: (telefono || '').trim(),
      notas: (notas || '').trim(),
      activo: true,
      creadoPor: req.user?.email || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('empleados').add(nuevo);

    await registrarAuditoria({
      accion: 'EMPLEADO_CREADO', modulo: 'empleados',
      descripcion: `Empleado ${nombre} (${documento}) · ${tipo.etiqueta} · ${fmt(sal)}`,
      usuarioId: adminId, usuarioNombre: req.user?.email || '', documento: String(documento).trim(),
      datos: { empleadoId: ref.id, tipoContrato: tipo.id, salario: sal }
    });

    // Vista previa del costo real, para que el suscriptor vea de una lo que
    // este empleado le cuesta de verdad — no solo el salario.
    const preview = N.calcularProvisionMensual({ ...nuevo, id: ref.id }, { anio });

    res.json({ id: ref.id, ...nuevo, avisos, costoMensualEstimado: preview });
  } catch (e) {
    console.error('POST empleados:', e);
    res.status(500).json({ error: 'Error al crear empleado' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/empleados/:id — editar
// ═════════════════════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const ref = db.collection('empleados').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (doc.data().userId !== adminId) return res.status(403).json({ error: 'Empleado de otra empresa' });

    const b = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (b.nombre !== undefined)   { update.nombre = String(b.nombre).trim(); update.nombreNorm = norm(b.nombre); }
    if (b.documento !== undefined) update.documento = String(b.documento).trim();
    if (b.tipoDocumento !== undefined) update.tipoDocumento = b.tipoDocumento;
    if (b.cargo !== undefined)     update.cargo = String(b.cargo).trim();
    if (b.salario !== undefined)   update.salario = Number(b.salario) || 0;
    if (b.fechaInicio !== undefined) update.fechaInicio = String(b.fechaInicio).slice(0, 10);
    if (b.fechaFin !== undefined)  update.fechaFin = b.fechaFin ? String(b.fechaFin).slice(0, 10) : '';
    if (b.claseRiesgoARL !== undefined) update.claseRiesgoARL = N.CLASES_RIESGO_ARL[b.claseRiesgoARL] ? b.claseRiesgoARL : 'III';
    if (b.tarifaARLPersonalizada !== undefined) {
      update.tarifaARLPersonalizada = (b.tarifaARLPersonalizada === '' || b.tarifaARLPersonalizada === null)
        ? null : Number(b.tarifaARLPersonalizada);
    }
    if (b.auxilioTransporteManual !== undefined) {
      update.auxilioTransporteManual = (b.auxilioTransporteManual === '' || b.auxilioTransporteManual === null)
        ? null : Number(b.auxilioTransporteManual);
    }
    for (const k of ['eps', 'fondoPension', 'fondoCesantias', 'caja', 'email', 'telefono', 'notas']) {
      if (b[k] !== undefined) update[k] = String(b[k]).trim();
    }
    if (b.tipoContrato !== undefined) {
      const tipo = N.TIPOS_CONTRATO[b.tipoContrato];
      if (!tipo) return res.status(400).json({ error: 'Tipo de contrato inválido' });
      update.tipoContrato = tipo.id;
    }
    if (b.activo !== undefined) update.activo = b.activo !== false;

    await ref.update(update);

    await registrarAuditoria({
      accion: 'EMPLEADO_EDITADO', modulo: 'empleados',
      descripcion: `Empleado ${update.nombre || doc.data().nombre} actualizado`,
      usuarioId: adminId, usuarioNombre: req.user?.email || '',
      documento: update.documento || doc.data().documento,
      datos: { empleadoId: req.params.id, anterior: doc.data(), cambios: update }
    });

    res.json({ id: req.params.id, ...doc.data(), ...update });
  } catch (e) {
    console.error('PUT empleados:', e);
    res.status(500).json({ error: 'Error al editar empleado' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DELETE /api/empleados/:id — dar de baja (nunca borra)
// ═════════════════════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const ref = db.collection('empleados').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (doc.data().userId !== adminId) return res.status(403).json({ error: 'Empleado de otra empresa' });

    const { fechaRetiro } = req.body || {};
    await ref.update({
      activo: false,
      fechaFin: fechaRetiro ? String(fechaRetiro).slice(0, 10) : (doc.data().fechaFin || new Date().toISOString().slice(0, 10)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await registrarAuditoria({
      accion: 'EMPLEADO_RETIRADO', modulo: 'empleados',
      descripcion: `Empleado ${doc.data().nombre} dado de baja`,
      usuarioId: adminId, usuarioNombre: req.user?.email || '', documento: doc.data().documento,
      datos: { empleadoId: req.params.id, fechaRetiro }
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE empleados:', e);
    res.status(500).json({ error: 'Error al dar de baja' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/empleados/anticipos?desde&hasta[&empleadoId]
// ─────────────────────────────────────────────────────────────────────────────
// Devuelve los anticipos de nómina PENDIENTES DE CRUCE, agrupados por empleado.
//
// Un anticipo se considera pendiente si:
//   · está marcado como anticipo de nómina (esAnticipoNomina)
//   · tiene empleadoId asignado
//   · no fue cruzado todavía (cruzadoEnNomina !== true)
//
// Esto es lo que la pantalla de nómina consulta cuando se digita la cédula:
// "trae los préstamos que ha realizado en la quincena".
// ═════════════════════════════════════════════════════════════════════════════
router.get('/anticipos', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const { desde, hasta, empleadoId } = req.query;

    const snap = await db.collection('egresos').where('userId', '==', adminId).get();

    const porEmpleado = {};
    let totalGeneral = 0;
    const sinEmpleado = [];

    snap.forEach(d => {
      const e = d.data();
      if (e.anulado === true) return;
      if (e.esAnticipoNomina !== true) return;
      if (e.cruzadoEnNomina === true) return;
      if (desde && e.fecha && e.fecha < desde) return;
      if (hasta && e.fecha && e.fecha > hasta) return;
      if (empleadoId && e.empleadoId !== empleadoId) return;

      const valor = Number(e.totalPagar || e.monto) || 0;
      const item = {
        egresoId: d.id, numero: e.numero, fecha: e.fecha,
        concepto: e.concepto, valor, categoria: e.categoria
      };

      if (!e.empleadoId) { sinEmpleado.push(item); return; }

      if (!porEmpleado[e.empleadoId]) {
        porEmpleado[e.empleadoId] = {
          empleadoId: e.empleadoId,
          nombre: e.empleadoNombre || '',
          documento: e.empleadoDocumento || '',
          total: 0, cantidad: 0, anticipos: []
        };
      }
      porEmpleado[e.empleadoId].total += valor;
      porEmpleado[e.empleadoId].cantidad += 1;
      porEmpleado[e.empleadoId].anticipos.push(item);
      totalGeneral += valor;
    });

    const lista = Object.values(porEmpleado)
      .map(g => ({ ...g, anticipos: g.anticipos.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))) }))
      .sort((a, b) => b.total - a.total);

    res.json({
      desde: desde || null, hasta: hasta || null,
      totalGeneral, empleados: lista,
      // Anticipos marcados como tal pero sin empleado asignado: hay que
      // asignarlos antes de poder cruzarlos.
      sinEmpleadoAsignado: sinEmpleado.sort((a, b) => b.valor - a.valor)
    });
  } catch (e) {
    console.error('GET anticipos:', e);
    res.status(500).json({ error: 'Error al cargar anticipos' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/empleados/provisiones?anio&mes
// ─────────────────────────────────────────────────────────────────────────────
// Calcula (sin guardar) la provisión de prestaciones de todos los empleados
// vigentes en el mes, y muestra el pasivo acumulado a la fecha.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/provisiones', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const anio = Number(req.query.anio) || new Date().getFullYear();
    const mes  = Number(req.query.mes)  || (new Date().getMonth() + 1);

    const [empSnap, cfgDoc, provSnap, egSnap] = await Promise.all([
      db.collection('empleados').where('userId', '==', adminId).get(),
      db.collection('configuracion').doc(adminId).get(),
      db.collection('provisiones_prestaciones').where('userId', '==', adminId).get(),
      db.collection('egresos').where('userId', '==', adminId).select('esComprobanteNomina', 'anulado', 'periodoNomina', 'empleadoId', 'liquidacion', 'numero').get()
    ]);

    const empresaExonerada = cfgDoc.exists ? (cfgDoc.data().empresaExoneradaAportes !== false) : true;

    const empleados = [];
    empSnap.forEach(d => empleados.push({ id: d.id, ...d.data() }));

    // Provisiones ya causadas — el pasivo acumulado
    const causadas = [];
    provSnap.forEach(d => causadas.push({ id: d.id, ...d.data() }));
    const yaCausadoEsteMes = causadas.filter(p => p.anio === anio && p.mes === mes);

    // ✅ FIX NOMINA-EXTRAS-001: comprobantes de nómina del mes. Las horas extras
    // y los recargos SON salario (art. 127 CST) y entran en la base de
    // cesantías, intereses, prima y vacaciones. La causación los ignoraba: el
    // motor siempre aceptó `devengadoAdicional`, pero nadie se lo pasaba.
    const comprobantesDelMes = egSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(e => e.esComprobanteNomina === true && e.anulado !== true)
      .filter(e => Number(e.periodoNomina?.anio) === anio && Number(e.periodoNomina?.mes) === mes);

    const detalle = [];
    let totalPrestaciones = 0, totalSS = 0, totalDevengado = 0, totalCosto = 0;
    let totalDevengadoAdicional = 0;
    const porConcepto = { cesantias: 0, interesesCesantias: 0, prima: 0, vacaciones: 0 };

    for (const emp of empleados) {
      if (!N.vigenteEnMes(emp, anio, mes)) continue;
      const dias = N.diasTrabajadosEnMes(emp, anio, mes);
      if (dias <= 0) continue;

      const extras = N.devengadoAdicionalDeComprobantes(
        comprobantesDelMes.filter(c => c.empleadoId === emp.id)
      );
      totalDevengadoAdicional += extras.total;

      const p = N.calcularProvisionMensual(emp, {
        anio, mes, diasTrabajados: dias, empresaExonerada,
        devengadoAdicional: extras.total
      });
      p.devengadoAdicional = extras.total;
      p.devengadoAdicionalDetalle = extras.detalle;
      p.empleadoId = emp.id;
      p.documento = emp.documento;
      p.cargo = emp.cargo || '';
      p.yaCausada = yaCausadoEsteMes.some(x => x.empleadoId === emp.id);

      detalle.push(p);
      totalPrestaciones += p.totalPrestaciones;
      totalSS += p.totalSeguridadSocial;
      totalDevengado += p.baseConAuxilio;
      totalCosto += p.costoTotalEmpleador;

      for (const k of Object.keys(porConcepto)) {
        porConcepto[k] += p.prestaciones[k]?.valor || 0;
      }
    }

    // ✅ FIX NOMINA-PASIVO-001: el pasivo acumulado es NETO — causado menos
    // pagado. Antes solo sumaba las provisiones causadas y nunca restaba nada,
    // así que el pasivo del balance únicamente crecía: al consignar cesantías
    // en febrero o pagar la prima en junio, la provisión seguía completa.
    // El descargue lo lleva `pasivoLaboral.js` sobre el campo `aplicado`.
    const pasivo = PL.consolidarPasivo(causadas);
    const pasivoAcumulado = { ...pasivo.porConcepto, total: pasivo.total };

    res.json({
      anio, mes,
      parametros: N.parametrosAnio(anio),
      empresaExonerada,
      empleadosVigentes: detalle.length,
      totales: {
        devengado: totalDevengado,
        prestaciones: totalPrestaciones,
        seguridadSocial: totalSS,
        costoTotal: totalCosto,
        devengadoAdicional: totalDevengadoAdicional,
        factorPromedio: totalDevengado > 0 ? Number((totalCosto / totalDevengado).toFixed(4)) : 0
      },
      porConcepto,
      pasivoAcumulado,
      // Detalle del pasivo: causado, pagado y saldo por concepto y por empleado
      pasivo,
      yaCausadoEsteMes: yaCausadoEsteMes.length,
      detalle
    });
  } catch (e) {
    console.error('GET provisiones:', e);
    res.status(500).json({ error: 'Error al calcular provisiones' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/empleados/provisiones/causar
// ─────────────────────────────────────────────────────────────────────────────
// CAUSA las provisiones del mes: crea el registro del PASIVO.
//
// Esto NO mueve caja. Es un asiento de causación:
//     Débito  · Gasto de prestaciones sociales   (estado de resultados)
//     Crédito · Prestaciones por pagar            (pasivo, balance)
//
// Es exactamente lo que faltaba para que el ERI reflejara el costo real.
// Es idempotente: si el mes ya se causó, no duplica.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/provisiones/causar', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede causar provisiones' });
    }
    const adminId = resolverAdminId(req);
    const anio = Number(req.body.anio);
    const mes  = Number(req.body.mes);
    if (!anio || !mes || mes < 1 || mes > 12) {
      return res.status(400).json({ error: 'Año y mes válidos son obligatorios' });
    }

    const [empSnap, cfgDoc, yaSnap, egSnap] = await Promise.all([
      db.collection('empleados').where('userId', '==', adminId).get(),
      db.collection('configuracion').doc(adminId).get(),
      db.collection('provisiones_prestaciones')
        .where('userId', '==', adminId).where('anio', '==', anio).where('mes', '==', mes).get(),
      db.collection('egresos').where('userId', '==', adminId).select('esComprobanteNomina', 'anulado', 'periodoNomina', 'empleadoId', 'liquidacion', 'numero').get()
    ]);

    const empresaExonerada = cfgDoc.exists ? (cfgDoc.data().empresaExoneradaAportes !== false) : true;
    // ✅ FASE 3: apagado por defecto a propósito. Ver la nota extensa en
    // services/pasivoLaboral.js — encenderlo sin cambiar cómo se digita la PILA
    // duplica el gasto de aportes patronales desde el primer mes.
    const causarSeguridadSocial = cfgDoc.exists
      ? (cfgDoc.data().causarSeguridadSocial === true) : false;
    const yaCausados = new Set();
    yaSnap.forEach(d => { if (d.data().revertida !== true) yaCausados.add(d.data().empleadoId); });

    // ✅ FIX NOMINA-EXTRAS-001: mismos comprobantes que usa el preview, para que
    // lo que se GUARDA coincida con lo que el usuario vio en pantalla.
    const comprobantesDelMes = egSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(e => e.esComprobanteNomina === true && e.anulado !== true)
      .filter(e => Number(e.periodoNomina?.anio) === anio && Number(e.periodoNomina?.mes) === mes);

    const empleados = [];
    empSnap.forEach(d => empleados.push({ id: d.id, ...d.data() }));

    const creadas = [];
    const omitidos = [];
    const batch = db.batch();
    let totalPrestaciones = 0;

    for (const emp of empleados) {
      if (!N.vigenteEnMes(emp, anio, mes)) { continue; }
      const dias = N.diasTrabajadosEnMes(emp, anio, mes);
      if (dias <= 0) continue;

      if (yaCausados.has(emp.id)) {
        omitidos.push({ empleadoId: emp.id, nombre: emp.nombre, razon: 'Ya causada este mes' });
        continue;
      }

      const extras = N.devengadoAdicionalDeComprobantes(
        comprobantesDelMes.filter(c => c.empleadoId === emp.id)
      );
      const p = N.calcularProvisionMensual(emp, {
        anio, mes, diasTrabajados: dias, empresaExonerada,
        devengadoAdicional: extras.total
      });

      if (!p.aplicaProvision) {
        omitidos.push({ empleadoId: emp.id, nombre: emp.nombre, razon: p.motivoNoAplica });
        continue;
      }

      const ref = db.collection('provisiones_prestaciones').doc();
      batch.set(ref, {
        userId: adminId,
        empleadoId: emp.id,
        empleadoNombre: emp.nombre,
        empleadoDocumento: emp.documento,
        tipoContrato: emp.tipoContrato,
        anio, mes,
        periodo: `${anio}-${String(mes).padStart(2, '0')}`,
        diasTrabajados: dias,
        salario: emp.salario,
        auxilioTransporte: p.auxilioTransporte,
        baseConAuxilio: p.baseConAuxilio,
        baseSinAuxilio: p.baseSinAuxilio,
        // ✅ FIX NOMINA-EXTRAS-001: horas extras y recargos incluidos en la base
        devengadoAdicional: extras.total,
        devengadoAdicionalDetalle: extras.detalle,
        prestaciones: p.prestaciones,
        totalPrestaciones: p.totalPrestaciones,
        seguridadSocialPatronal: p.seguridadSocialPatronal,
        totalSeguridadSocial: p.totalSeguridadSocial,
        costoTotalEmpleador: p.costoTotalEmpleador,
        // Naturaleza contable — para que el ERI y el balance sepan qué hacer
        naturaleza: 'pasivo',
        tipoERI: 'gasto_personal',
        // ✅ NOMINA-PASIVO-001: cuánto de cada concepto lleva pagado. Un doc
        // viejo sin este campo se lee como cero — no hace falta migrar nada.
        aplicado: { cesantias: 0, interesesCesantias: 0, prima: 0, vacaciones: 0 },
        // ✅ FASE 3 (apagada por defecto): si el suscriptor activó la causación
        // de aportes patronales, esta provisión los lleva como PASIVO y el ERI
        // los causa. Si está apagado, los aportes siguen entrando al gasto
        // cuando se digita la PILA como egreso — que es como funciona hoy.
        causaSeguridadSocial: causarSeguridadSocial,
        aplicadoSeguridadSocial: 0,
        pagada: false,
        revertida: false,
        causadaPor: req.user.email,
        causadaEn: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      creadas.push({ empleadoId: emp.id, nombre: emp.nombre, valor: p.totalPrestaciones });
      totalPrestaciones += p.totalPrestaciones;
    }

    if (creadas.length === 0) {
      return res.status(400).json({
        error: 'No hay provisiones nuevas para causar en este período',
        omitidos
      });
    }

    await batch.commit();

    await registrarAuditoria({
      accion: 'PROVISIONES_CAUSADAS', modulo: 'empleados',
      descripcion: `Provisión de prestaciones ${anio}-${String(mes).padStart(2, '0')}: ${creadas.length} empleado(s) por ${fmt(totalPrestaciones)}`,
      usuarioId: adminId, usuarioNombre: req.user.email,
      documento: `PROV-${anio}-${String(mes).padStart(2, '0')}`,
      datos: { anio, mes, cantidad: creadas.length, totalPrestaciones, creadas, omitidos }
    });

    res.json({
      ok: true, anio, mes,
      causadas: creadas.length,
      totalPrestaciones,
      detalle: creadas,
      omitidos,
      mensaje: `Se causaron ${fmt(totalPrestaciones)} de prestaciones sociales como gasto del período y como pasivo por pagar.`
    });
  } catch (e) {
    console.error('POST causar provisiones:', e);
    res.status(500).json({ error: 'Error al causar las provisiones' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/empleados/provisiones/:anio/:mes/revertir
// ═════════════════════════════════════════════════════════════════════════════
router.post('/provisiones/:anio/:mes/revertir', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el admin puede revertir' });
    const adminId = resolverAdminId(req);
    const { pin, motivo } = req.body;
    const anio = Number(req.params.anio), mes = Number(req.params.mes);

    const verif = await verificarPin(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });
    if (!motivo?.trim() || motivo.trim().length < 10) {
      return res.status(400).json({ error: 'Explicá el motivo de la reversión (mínimo 10 caracteres)' });
    }

    const snap = await db.collection('provisiones_prestaciones')
      .where('userId', '==', adminId).where('anio', '==', anio).where('mes', '==', mes).get();

    if (snap.empty) return res.status(404).json({ error: 'No hay provisiones causadas en ese período' });

    const batch = db.batch();
    let n = 0, total = 0;
    snap.forEach(d => {
      if (d.data().revertida === true) return;
      batch.update(d.ref, {
        revertida: true, revertidaPor: req.user.email,
        revertidaEn: new Date().toISOString(), motivoReversion: motivo.trim()
      });
      n += 1; total += Number(d.data().totalPrestaciones) || 0;
    });

    if (n === 0) return res.status(400).json({ error: 'Las provisiones de ese período ya fueron revertidas' });
    await batch.commit();

    await registrarAuditoria({
      accion: 'PROVISIONES_REVERTIDAS', modulo: 'empleados',
      descripcion: `Provisión ${anio}-${String(mes).padStart(2, '0')} revertida: ${n} registro(s) por ${fmt(total)}. Motivo: ${motivo.trim()}`,
      usuarioId: adminId, usuarioNombre: req.user.email,
      documento: `PROV-${anio}-${String(mes).padStart(2, '0')}`,
      datos: { anio, mes, cantidad: n, total, motivo: motivo.trim() }
    });

    res.json({ ok: true, revertidas: n, total });
  } catch (e) {
    console.error('POST revertir provisiones:', e);
    res.status(500).json({ error: 'Error al revertir provisiones' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/empleados/nomina/preview
// ─────────────────────────────────────────────────────────────────────────────
// Calcula la liquidación SIN guardar nada. Es lo que alimenta el formulario
// del comprobante en vivo: al digitar horas extras o cambiar los días, el
// neto se recalcula al instante.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/nomina/preview', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const { empleadoId, desde, hasta, diasTrabajados, horas, otrosDevengados, otrasDeducciones, incluirAnticipos } = req.body;

    const doc = await db.collection('empleados').doc(empleadoId || '_').get();
    if (!doc.exists) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (doc.data().userId !== adminId) return res.status(403).json({ error: 'Empleado de otra empresa' });
    const emp = { id: doc.id, ...doc.data() };

    const cfgDoc = await db.collection('configuracion').doc(adminId).get();
    const empresaExonerada = cfgDoc.exists ? (cfgDoc.data().empresaExoneradaAportes !== false) : true;

    // Anticipos pendientes del empleado en el período
    let anticipos = [];
    if (incluirAnticipos !== false) {
      const egSnap = await db.collection('egresos').where('userId', '==', adminId).get();
      egSnap.forEach(d => {
        const e = d.data();
        if (e.anulado === true || e.esAnticipoNomina !== true || e.cruzadoEnNomina === true) return;
        if (e.empleadoId !== empleadoId) return;
        if (desde && e.fecha && e.fecha < desde) return;
        if (hasta && e.fecha && e.fecha > hasta) return;
        anticipos.push({
          egresoId: d.id, numero: e.numero, fecha: e.fecha,
          concepto: e.concepto, valor: Number(e.totalPagar || e.monto) || 0
        });
      });
      anticipos.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
    }

    const anio = Number(String(hasta || desde || '').slice(0, 4)) || new Date().getFullYear();
    const mes  = Number(String(hasta || desde || '').slice(5, 7)) || (new Date().getMonth() + 1);

    const liq = N.liquidarNomina(emp, {
      anio, mes, desde, hasta,
      diasTrabajados, horas, otrosDevengados, otrasDeducciones,
      anticipos, empresaExonerada, fechaPago: hasta
    });

    res.json(liq);
  } catch (e) {
    console.error('POST nomina/preview:', e);
    res.status(500).json({ error: 'Error al calcular la nómina' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/empleados/nomina/comprobante
// ─────────────────────────────────────────────────────────────────────────────
// Crea el COMPROBANTE DE EGRESO DE NÓMINA. Esto es lo que hace todo el
// mecanismo funcionar bien:
//
//   1. Crea un egreso por el NETO (lo que realmente sale de caja hoy)
//   2. Marca los anticipos del período como CRUZADOS → dejan de contar aparte
//   3. Guarda el desglose completo (devengados, deducciones, provisión)
//
// El anticipo nunca fue gasto: era una cuenta por cobrar. Al cruzarlo aquí,
// el gasto del mes es el DEVENGADO completo y la salida de caja es el NETO.
// Así se elimina la duplicación que tenía el ERI.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/nomina/comprobante', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin puede generar comprobantes de nómina' });
    }
    const adminId = resolverAdminId(req);
    const {
      empleadoId, desde, hasta, diasTrabajados, horas,
      otrosDevengados, otrasDeducciones, cajaId, formaPago, empresaId,
      notas, pin, categoriaNomina
    } = req.body;

    const verif = await verificarPin(req.user.uid || req.user.id, pin, 'editar_egreso_pagado');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    const doc = await db.collection('empleados').doc(empleadoId || '_').get();
    if (!doc.exists) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (doc.data().userId !== adminId) return res.status(403).json({ error: 'Empleado de otra empresa' });
    const emp = { id: doc.id, ...doc.data() };

    const cfgDoc = await db.collection('configuracion').doc(adminId).get();
    const empresaExonerada = cfgDoc.exists ? (cfgDoc.data().empresaExoneradaAportes !== false) : true;
    // ✅ FASE 3 / NOMINA-RETENCION-001: si la causación está encendida, lo que
    // se le retiene al trabajador queda como PASIVO hasta pagar la PILA.
    // Apagado (por defecto), el comportamiento es el de siempre.
    const causarSeguridadSocial = cfgDoc.exists
      ? (cfgDoc.data().causarSeguridadSocial === true) : false;

    // Anticipos a cruzar
    const anticipos = [];
    const egSnap = await db.collection('egresos').where('userId', '==', adminId).get();
    egSnap.forEach(d => {
      const e = d.data();
      if (e.anulado === true || e.esAnticipoNomina !== true || e.cruzadoEnNomina === true) return;
      if (e.empleadoId !== empleadoId) return;
      if (desde && e.fecha && e.fecha < desde) return;
      if (hasta && e.fecha && e.fecha > hasta) return;
      anticipos.push({
        egresoId: d.id, ref: d.ref, numero: e.numero, fecha: e.fecha,
        concepto: e.concepto, valor: Number(e.totalPagar || e.monto) || 0
      });
    });

    const anio = Number(String(hasta || desde || '').slice(0, 4)) || new Date().getFullYear();
    const mes  = Number(String(hasta || desde || '').slice(5, 7)) || (new Date().getMonth() + 1);

    const liq = N.liquidarNomina(emp, {
      anio, mes, desde, hasta, diasTrabajados, horas,
      otrosDevengados, otrasDeducciones,
      anticipos: anticipos.map(a => ({ egresoId: a.egresoId, numero: a.numero, fecha: a.fecha, concepto: a.concepto, valor: a.valor })),
      empresaExonerada, fechaPago: hasta
    });

    if (liq.netoAPagar < 0) {
      return res.status(400).json({
        error: `El neto a pagar es negativo (${fmt(liq.netoAPagar)}). Los anticipos superan lo devengado. ` +
               `Revisá si algún anticipo corresponde a otro período.`,
        liquidacion: liq
      });
    }

    // ─── Numeración del comprobante ────────────────────────────────────────
    const counterRef = db.collection('counters').doc(`${adminId}_egresos`);
    const siguiente = await db.runTransaction(async (tx) => {
      const d = await tx.get(counterRef);
      const actual = d.exists ? (Number(d.data().value) || 0) : 0;
      tx.set(counterRef, { value: actual + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return actual + 1;
    });
    const numero = `EGR-${String(siguiente).padStart(4, '0')}`;

    // ─── Crear el egreso por el NETO ───────────────────────────────────────
    const egreso = {
      userId: adminId,
      numero,
      concepto: `Nómina ${emp.nombre} · ${desde || ''} a ${hasta || ''}`,
      proveedor: emp.nombre,
      categoria: categoriaNomina || 'Nómina',
      monto: liq.netoAPagar,
      totalPagar: liq.netoAPagar,
      ivaVal: 0, ivaPct: 0, retenVal: 0, retenPct: 0,
      formaPago: formaPago || '',
      cajaId: cajaId || '',
      empresaId: empresaId || '',
      fecha: (hasta || new Date().toISOString().slice(0, 10)).slice(0, 10),
      notas: notas || '',
      tipo: 'nomina',
      estado: 'PAGADO',
      cuadrado: true, legalizado: true,
      // ─── Trazabilidad laboral ───
      esComprobanteNomina: true,
      empleadoId: emp.id,
      empleadoNombre: emp.nombre,
      empleadoDocumento: emp.documento,
      tipoContrato: emp.tipoContrato,
      periodoNomina: { desde, hasta, anio, mes, diasTrabajados: liq.periodo.diasTrabajados },
      liquidacion: {
        devengados: liq.devengados,
        totalDevengado: liq.totalDevengado,
        deducciones: liq.deducciones,
        totalDeducciones: liq.totalDeducciones,
        totalAnticipos: liq.totalAnticipos,
        netoAPagar: liq.netoAPagar,
        retencionSeguridadSocial: liq.retencionSeguridadSocial,
        horasExtras: liq.horasExtras,
        prestacionesProvisionadas: liq.provision.totalPrestaciones,
        seguridadSocialPatronal: liq.provision.totalSeguridadSocial,
        costoTotalEmpleador: liq.costoTotalEmpleador
      },
      anticiposCruzados: anticipos.map(a => ({ egresoId: a.egresoId, numero: a.numero, valor: a.valor })),
      // ═══════════════════════════════════════════════════════════════════
      // ✅ NOMINA-RETENCION-001 · lo retenido al trabajador para la PILA
      // ───────────────────────────────────────────────────────────────────
      // El egreso sale por el NETO — es lo que efectivamente se le entrega.
      // Pero salud, pensión y FSP se le descontaron y se quedan en la caja de
      // la empresa hasta que se paga la planilla el mes siguiente. Esa plata
      // NO es de la empresa.
      //
      // Con nómina QUINCENAL se retiene dos veces y se paga una: entre la
      // primera retención y el pago pasan hasta seis semanas.
      //
      // `causaRetencionEmpleado` marca si esto es pasivo (Fase 3 encendida) o
      // si sigue el camino viejo (entra al gasto cuando se digita la PILA).
      retencionSeguridadSocial: liq.retencionSeguridadSocial,
      causaRetencionEmpleado: causarSeguridadSocial,
      aplicadoRetencionEmpleado: 0,
      // Devengado del período: lo que el ERI debe reconocer como gasto cuando
      // la causación está encendida (el egreso solo lleva el neto).
      totalDevengadoNomina: liq.totalDevengado,
      creadoPor: req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('egresos').add(egreso);

    // ─── Marcar los anticipos como cruzados ────────────────────────────────
    // Esta es la línea que elimina la doble contabilización.
    if (anticipos.length > 0) {
      const batch = db.batch();
      for (const a of anticipos) {
        batch.update(a.ref, {
          cruzadoEnNomina: true,
          cruzadoEnEgresoId: ref.id,
          cruzadoEnEgresoNumero: numero,
          cruzadoEn: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      await batch.commit();
    }

    // ─── Descontar de caja ─────────────────────────────────────────────────
    if (cajaId) {
      const cajaRef = db.collection('cajas').doc(cajaId);
      const cajaDoc = await cajaRef.get();
      if (cajaDoc.exists) {
        await cajaRef.update({
          saldo: admin.firestore.FieldValue.increment(-liq.netoAPagar),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await db.collection('movimientos').add({
          userId: adminId, cajaId, tipo: 'egreso',
          monto: liq.netoAPagar,
          concepto: `Nómina ${emp.nombre}`,
          referencia: numero,
          formaPago: formaPago || '',
          creadoPor: req.user.email,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    await registrarAuditoria({
      accion: 'COMPROBANTE_NOMINA_CREADO', modulo: 'empleados',
      descripcion: `Nómina ${numero} · ${emp.nombre} · devengado ${fmt(liq.totalDevengado)} · neto ${fmt(liq.netoAPagar)}` +
                   (anticipos.length ? ` · ${anticipos.length} anticipo(s) cruzado(s) por ${fmt(liq.totalAnticipos)}` : ''),
      usuarioId: adminId, usuarioNombre: req.user.email, documento: numero,
      datos: {
        egresoId: ref.id, empleadoId: emp.id, periodo: { desde, hasta },
        totalDevengado: liq.totalDevengado, netoAPagar: liq.netoAPagar,
        anticiposCruzados: anticipos.map(a => ({ numero: a.numero, valor: a.valor })),
        costoTotalEmpleador: liq.costoTotalEmpleador
      }
    });

    res.status(201).json({
      ok: true, id: ref.id, numero,
      liquidacion: liq,
      anticiposCruzados: anticipos.length,
      totalAnticiposCruzados: liq.totalAnticipos
    });
  } catch (e) {
    console.error('POST nomina/comprobante:', e);
    res.status(500).json({ error: 'Error al generar el comprobante de nómina' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/empleados/buscar?q=
// ─────────────────────────────────────────────────────────────────────────────
// Búsqueda por nombre o documento. La usa el módulo de Egresos para detectar
// si el proveedor que se está digitando es en realidad un empleado — y en ese
// caso preguntar si el egreso es un anticipo de nómina.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/buscar', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const q = norm(req.query.q || '');
    if (q.length < 3) return res.json([]);

    const snap = await db.collection('empleados').where('userId', '==', adminId).get();
    const hits = [];
    snap.forEach(d => {
      const e = d.data();
      if (e.activo === false) return;
      const nombreN = e.nombreNorm || norm(e.nombre);
      const docN = String(e.documento || '');
      // Coincidencia si el texto contiene el nombre del empleado o viceversa,
      // o si coincide el documento.
      if (nombreN.includes(q) || q.includes(nombreN) || docN === req.query.q?.trim()) {
        hits.push({
          id: d.id, nombre: e.nombre, documento: e.documento,
          cargo: e.cargo || '', tipoContrato: e.tipoContrato, salario: e.salario
        });
      }
    });
    res.json(hits.slice(0, 10));
  } catch (e) {
    console.error('GET empleados/buscar:', e);
    res.status(500).json({ error: 'Error en la búsqueda' });
  }
});

module.exports = router;
