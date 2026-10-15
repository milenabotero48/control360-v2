// ═══════════════════════════════════════════════════════════════════════════════
// prestamosNomina.js — Comprobante de préstamo de nómina
// ─────────────────────────────────────────────────────────────────────────────
// NOMINA-PRESTAMO-001
//
// POR QUÉ EXISTE
// --------------
// Los préstamos de quincena se entregaban con un egreso suelto y sin documento
// firmado. Si el trabajador discutía el descuento, la empresa no tenía cómo
// probar que lo autorizó por escrito (CST art. 149 y 151).
//
// CÓMO SE CONECTA (sin duplicar nada)
// -----------------------------------
//   · El DINERO lo mueve un egreso-anticipo (esAnticipoNomina) — exactamente el
//     mismo que la nómina ya cruza. No se inventó otro mecanismo de descuento.
//   · El PRÉSTAMO es el documento: numerado (PN-0001), con el salario del
//     contrato y los datos del trabajador congelados al momento de firmar.
//   · El estado "descontado" se DEDUCE del egreso; no se guarda dos veces.
//
// REGLAS
//   · Todo filtrado por el tenant de la sesión (adminId). Nunca hardcodeado.
//   · Crear = una sola transacción: número PN, número EGR, egreso, movimiento
//     de caja y saldo. O queda todo o no queda nada (numeración sin saltos).
//   · Anular, nunca borrar. Editar y anular piden PIN + motivo.
//   · El tope de descuento ADVIERTE, no bloquea: exige confirmación con motivo.
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { verificarPin } = require('./_autorizacion');
const P = require('../services/prestamosNomina');

const resolverAdminId = (req) => req.adminId || req.user?.uid || req.user?.id || null;
const hoyCO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const num = (v) => Number(v) || 0;
const fmt = n => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', maximumFractionDigits: 0
}).format(n || 0);
const MOTIVO_MIN = 10;

const esCajaEfectivo = (caja) => (caja?.tipo || 'Efectivo').toLowerCase().includes('efectivo');

const registrarAuditoria = async (datos) => {
  try {
    await db.collection('audit_logs').add({
      ...datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (e) { console.error('Auditoría préstamos nómina:', e); }
};

// ─── Configuración del tope (por suscriptor) ────────────────────────────────
const cargarConfig = async (adminId) => {
  try {
    const d = await db.collection('configuracion').doc(adminId).get();
    const c = d.exists ? (d.data().prestamosNomina || {}) : {};
    return {
      modoTope: P.MODOS_TOPE.includes(c.modoTope) ? c.modoTope : P.CONFIG_TOPE_DEFECTO.modoTope,
      porcentaje: c.porcentaje !== undefined ? num(c.porcentaje) : P.CONFIG_TOPE_DEFECTO.porcentaje
    };
  } catch (e) {
    return { ...P.CONFIG_TOPE_DEFECTO };
  }
};

// Categoría contable del anticipo: la del suscriptor que diga "anticipo".
const categoriaAnticipo = async (adminId) => {
  try {
    const d = await db.collection('configuracion').doc(adminId).get();
    const lista = d.exists ? (d.data().categoriasEgresos || []) : [];
    const nombres = lista.map(c => (typeof c === 'string' ? c : (c?.nombre || c?.name || ''))).filter(Boolean);
    return nombres.find(n => /anticipo/i.test(n)) || 'Anticipos de nómina';
  } catch (e) { return 'Anticipos de nómina'; }
};

const cargarEmpleado = async (adminId, empleadoId) => {
  if (!empleadoId) return { error: 'Empleado requerido', status: 400 };
  const doc = await db.collection('empleados').doc(empleadoId).get();
  if (!doc.exists) return { error: 'Empleado no encontrado', status: 404 };
  const e = doc.data();
  if (e.userId !== adminId) return { error: 'Empleado de otra empresa', status: 403 };
  return { emp: { id: doc.id, ...e } };
};

const cargarEmpresa = async (adminId, empresaId) => {
  if (!empresaId) return { empresa: { id: '', nombre: '', nit: '' } };
  const doc = await db.collection('companies').doc(empresaId).get();
  if (!doc.exists) return { error: 'Empresa no encontrada', status: 404 };
  const c = doc.data();
  if ((c.user_id || c.userId) !== adminId) return { error: 'Empresa de otro suscriptor', status: 403 };
  return { empresa: { id: doc.id, nombre: c.name || c.nombre || '', nit: c.nit || '' } };
};

// Lo que ya se le va a descontar a este trabajador en ESA fecha de pago.
const comprometidoPrevio = async (adminId, empleadoId, fechaDesc, excluirId = null) => {
  const snap = await db.collection('prestamos_nomina')
    .where('userId', '==', adminId)
    .where('empleadoId', '==', empleadoId)
    .get();
  let total = 0;
  const previos = [];
  snap.forEach(d => {
    const p = d.data();
    if (excluirId && d.id === excluirId) return;
    if (p.estado === 'ANULADO') return;
    if (p.fechaDescuento !== fechaDesc) return;
    total += num(p.valor);
    previos.push({ numero: p.numero, valor: num(p.valor) });
  });
  return { total, previos };
};

const evaluar = async (adminId, emp, valor, fechaSolicitud, excluirId = null) => {
  const fd = P.fechaDescuento(fechaSolicitud);
  if (!fd) return { error: 'Fecha de solicitud inválida', status: 400 };
  const cfg = await cargarConfig(adminId);
  const { total, previos } = await comprometidoPrevio(adminId, emp.id, fd, excluirId);
  const tope = P.evaluarTope({
    salario: emp.salario, fechaDescuento: fd, valor,
    comprometidoPrevio: total, modo: cfg.modoTope, porcentaje: cfg.porcentaje
  });
  return {
    fechaDescuento: fd, tope, previos,
    advertencia: tope.excedido ? P.textoAdvertencia(emp.nombre, tope, fd, previos) : null
  };
};

const exigirAdmin = (req, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Solo el administrador puede hacer esta acción' });
    return false;
  }
  return true;
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/prestamos-nomina/config · PUT /api/prestamos-nomina/config
// ═════════════════════════════════════════════════════════════════════════════
router.get('/config', async (req, res) => {
  try {
    res.json(await cargarConfig(resolverAdminId(req)));
  } catch (e) {
    console.error('GET prestamos config:', e);
    res.status(500).json({ error: 'Error al cargar la configuración' });
  }
});

router.put('/config', async (req, res) => {
  try {
    if (!exigirAdmin(req, res)) return;
    const adminId = resolverAdminId(req);
    const { modoTope, porcentaje } = req.body;
    if (!P.MODOS_TOPE.includes(modoTope)) return res.status(400).json({ error: 'Modo de tope inválido' });
    const pct = num(porcentaje);
    if (modoTope === 'porcentaje' && (pct <= 0 || pct > 100)) {
      return res.status(400).json({ error: 'El porcentaje debe estar entre 1 y 100' });
    }
    await db.collection('configuracion').doc(adminId).set({
      prestamosNomina: { modoTope, porcentaje: pct || P.CONFIG_TOPE_DEFECTO.porcentaje }
    }, { merge: true });
    await registrarAuditoria({
      accion: 'PRESTAMO_NOMINA_CONFIG', modulo: 'empleados',
      descripcion: `Tope de descuento de préstamos: ${modoTope}${modoTope === 'porcentaje' ? ` ${pct}%` : ' (quinta parte del excedente sobre el mínimo)'}`,
      usuarioId: adminId, usuarioNombre: req.user.email
    });
    res.json({ ok: true, modoTope, porcentaje: pct });
  } catch (e) {
    console.error('PUT prestamos config:', e);
    res.status(500).json({ error: 'Error al guardar la configuración' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/prestamos-nomina/simular — fecha de descuento y tope, sin guardar
// ═════════════════════════════════════════════════════════════════════════════
router.post('/simular', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const { empleadoId, valor, fechaSolicitud, excluirId } = req.body;
    const r = await cargarEmpleado(adminId, empleadoId);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const ev = await evaluar(adminId, r.emp, num(valor), fechaSolicitud || hoyCO(), excluirId || null);
    if (ev.error) return res.status(ev.status).json({ error: ev.error });
    res.json({
      fechaDescuento: ev.fechaDescuento,
      tope: ev.tope,
      previos: ev.previos,
      advertencia: ev.advertencia,
      empleado: {
        id: r.emp.id, nombre: r.emp.nombre, documento: r.emp.documento,
        tipoDocumento: r.emp.tipoDocumento || 'CC', cargo: r.emp.cargo || '', salario: num(r.emp.salario)
      },
      valorEnLetras: P.valorEnLetras(num(valor))
    });
  } catch (e) {
    console.error('POST prestamos simular:', e);
    res.status(500).json({ error: 'Error al simular el préstamo' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/prestamos-nomina?empleadoId&estado&desde&hasta
// ═════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const { empleadoId, estado, desde, hasta } = req.query;

    const snap = await db.collection('prestamos_nomina').where('userId', '==', adminId).get();
    let lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (empleadoId) lista = lista.filter(p => p.empleadoId === empleadoId);
    if (desde) lista = lista.filter(p => String(p.fechaSolicitud || '') >= desde);
    if (hasta) lista = lista.filter(p => String(p.fechaSolicitud || '') <= hasta);
    lista.sort((a, b) => String(b.numero || '').localeCompare(String(a.numero || '')));
    lista = lista.slice(0, 500);

    // El estado "descontado" lo sabe el egreso-anticipo.
    const refs = lista.filter(p => p.estado !== 'ANULADO' && p.egresoId)
      .map(p => db.collection('egresos').doc(p.egresoId));
    const egresos = {};
    if (refs.length > 0) {
      const docs = await db.getAll(...refs);
      docs.forEach(d => { if (d.exists) egresos[d.id] = d.data(); });
    }

    let items = lista.map(p => {
      const eg = egresos[p.egresoId];
      return {
        ...p,
        estado: P.estadoPrestamo(p, eg),
        descontadoEnNomina: eg?.cruzadoEnNomina === true ? (eg.cruzadoEnEgresoNumero || '') : ''
      };
    });
    if (estado) items = items.filter(p => p.estado === estado);

    const activos = items.filter(p => p.estado === 'ACTIVO');
    res.json({
      prestamos: items,
      resumen: {
        total: items.length,
        activos: activos.length,
        valorPendiente: activos.reduce((a, p) => a + num(p.valor), 0)
      }
    });
  } catch (e) {
    console.error('GET prestamos nomina:', e);
    res.status(500).json({ error: 'Error al cargar los préstamos' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/prestamos-nomina — crear préstamo (+ egreso-anticipo + caja)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'No autenticado' });
    const { empleadoId, valor, cajaId, empresaId, fechaSolicitud, notas, confirmoExceso, motivoExceso } = req.body;

    const v = Math.round(num(valor));
    if (v <= 0) return res.status(400).json({ error: 'El valor del préstamo debe ser mayor a cero' });
    if (!cajaId) return res.status(400).json({ error: 'Selecciona la caja o el banco de donde sale el dinero' });

    const r = await cargarEmpleado(adminId, empleadoId);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const emp = r.emp;
    if (emp.activo === false) return res.status(400).json({ error: 'El empleado está inactivo' });

    const re = await cargarEmpresa(adminId, empresaId);
    if (re.error) return res.status(re.status).json({ error: re.error });

    const fSol = String(fechaSolicitud || hoyCO()).slice(0, 10);
    const ev = await evaluar(adminId, emp, v, fSol);
    if (ev.error) return res.status(ev.status).json({ error: ev.error });

    // ADVIERTE, no bloquea: pide confirmación con motivo.
    let excesoRegistrado = null;
    if (ev.tope.excedido) {
      const motivo = String(motivoExceso || '').trim();
      if (confirmoExceso !== true || motivo.length < MOTIVO_MIN) {
        return res.status(409).json({
          codigo: 'TOPE_EXCEDIDO', requiereConfirmacion: true,
          error: ev.advertencia, advertencia: ev.advertencia,
          tope: ev.tope, previos: ev.previos, fechaDescuento: ev.fechaDescuento
        });
      }
      excesoRegistrado = {
        motivo, confirmadoPor: req.user.email || '', cupoQuincena: ev.tope.cupoQuincena,
        totalConEste: ev.tope.totalConEste, exceso: ev.tope.exceso
      };
    }

    const categoria = await categoriaAnticipo(adminId);
    const cajaRef = db.collection('cajas').doc(cajaId);
    const counterPN = db.collection('counters').doc(`${adminId}_prestamos_nomina`);
    const counterEG = db.collection('counters').doc(`${adminId}_egresos`);
    const egresoRef = db.collection('egresos').doc();
    const prestRef = db.collection('prestamos_nomina').doc();
    const movRef = db.collection('movimientos').doc();

    const creado = await db.runTransaction(async (tx) => {
      // Todas las lecturas primero (requisito de Firestore).
      const [dPN, dEG, dCaja] = await Promise.all([tx.get(counterPN), tx.get(counterEG), tx.get(cajaRef)]);
      if (!dCaja.exists) { const err = new Error('Caja no encontrada'); err.status = 404; throw err; }
      const caja = dCaja.data();
      if (caja.userId !== adminId) { const err = new Error('Caja de otra empresa'); err.status = 403; throw err; }
      if (num(caja.saldo) < v) {
        const err = new Error(`Saldo insuficiente en "${caja.nombre}". Disponible: ${fmt(caja.saldo)}`);
        err.status = 400; throw err;
      }

      const nPN = (dPN.exists ? num(dPN.data().value) : 0) + 1;
      const nEG = (dEG.exists ? num(dEG.data().value) : 0) + 1;
      const numeroPN = `PN-${String(nPN).padStart(4, '0')}`;
      const numeroEG = `EGR-${String(nEG).padStart(4, '0')}`;
      const efectivo = esCajaEfectivo(caja);
      const formaEntrega = efectivo ? 'Efectivo' : 'Transferencia';
      const ts = admin.firestore.FieldValue.serverTimestamp();
      const ahoraISO = new Date().toISOString();

      tx.set(counterPN, { value: nPN, tipo: 'prestamos_nomina', adminId, updatedAt: ts }, { merge: true });
      tx.set(counterEG, { value: nEG, updatedAt: ts }, { merge: true });

      // El egreso-anticipo: lo que la nómina ya sabe cruzar.
      tx.set(egresoRef, {
        userId: adminId, numero: numeroEG,
        concepto: `Préstamo de nómina ${numeroPN} · ${emp.nombre}`,
        proveedor: emp.nombre, categoria,
        monto: v, totalPagar: v, ivaVal: 0, ivaPct: 0, retenVal: 0, retenPct: 0,
        formaPago: formaEntrega, cajaId, empresaId: re.empresa.id,
        fecha: fSol, fechaCausacion: fSol,
        notas: notas || '', tipo: 'normal',
        estado: 'PAGADO', saldo: 0, montoPagado: v,
        abonos: [{
          monto: v, formaPago: formaEntrega, cajaId, cajaNombre: caja.nombre || '',
          fecha: fSol, creadoPor: req.user.email || '', origen: 'prestamo_nomina',
          saldoAntes: v, saldoDespues: 0, createdAt: ahoraISO
        }],
        fechaPago: ahoraISO, cuadrado: true, legalizado: true,
        esAnticipoNomina: true,
        empleadoId: emp.id, empleadoNombre: emp.nombre, empleadoDocumento: emp.documento || '',
        cruzadoEnNomina: false,
        prestamoNominaId: prestRef.id, prestamoNominaNumero: numeroPN,
        creadoPor: req.user.email || '', createdAt: ts, updatedAt: ts
      });

      // El documento que firma el trabajador.
      const prestamo = {
        userId: adminId, numero: numeroPN, estado: 'ACTIVO',
        empleadoId: emp.id, empleadoNombre: emp.nombre,
        empleadoTipoDocumento: emp.tipoDocumento || 'CC', empleadoDocumento: emp.documento || '',
        empleadoCargo: emp.cargo || '', salarioContrato: num(emp.salario),
        empresaId: re.empresa.id, empresaNombre: re.empresa.nombre, empresaNit: re.empresa.nit,
        valor: v, valorEnLetras: P.valorEnLetras(v),
        fechaSolicitud: fSol, fechaDescuento: ev.fechaDescuento,
        cajaId, cajaNombre: caja.nombre || '', formaEntrega,
        egresoId: egresoRef.id, egresoNumero: numeroEG,
        tope: ev.tope, excesoConfirmado: excesoRegistrado,
        notas: notas || '', historial: [],
        creadoPor: req.user.email || '', createdAt: ts, updatedAt: ts
      };
      tx.set(prestRef, prestamo);

      tx.update(cajaRef, { saldo: admin.firestore.FieldValue.increment(-v), updatedAt: ts });
      tx.set(movRef, {
        userId: adminId, cajaId, tipo: 'egreso',
        concepto: `${numeroEG} — Préstamo de nómina ${numeroPN} · ${emp.nombre}`,
        monto: v, referencia: numeroEG, formaPago: formaEntrega,
        egresoId: egresoRef.id, prestamoNominaId: prestRef.id,
        creadoPor: req.user.email || '', createdAt: ts
      });

      return { prestamo, numeroPN, numeroEG };
    });

    await registrarAuditoria({
      accion: 'PRESTAMO_NOMINA_CREADO', modulo: 'empleados',
      descripcion: `${creado.numeroPN}: préstamo de ${fmt(v)} a ${emp.nombre}, se descuenta el ${ev.fechaDescuento}` +
        (excesoRegistrado ? ` · EXCEDE EL TOPE (${fmt(excesoRegistrado.exceso)} de más). Motivo: ${excesoRegistrado.motivo}` : ''),
      usuarioId: adminId, usuarioNombre: req.user.email, documento: creado.numeroPN,
      datos: { prestamoId: prestRef.id, egresoId: egresoRef.id, valor: v, empleadoId: emp.id }
    });

    res.status(201).json({ id: prestRef.id, ...creado.prestamo, createdAt: undefined, updatedAt: undefined, estado: 'ACTIVO' });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('POST prestamos nomina:', e);
    res.status(500).json({ error: 'Error al crear el préstamo' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/prestamos-nomina/:id — editar (solo si sigue sin descontarse)
// ─────────────────────────────────────────────────────────────────────────────
// Se puede corregir valor, caja, empresa y notas. Mantiene el número y deja el
// historial. Si cambia el dinero, se reversa el movimiento anterior y se registra
// el nuevo: la caja siempre cuadra con lo que dice el comprobante.
// ═════════════════════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    if (!exigirAdmin(req, res)) return;
    const adminId = resolverAdminId(req);
    const { pin, motivo, valor, cajaId, empresaId, notas, confirmoExceso, motivoExceso } = req.body;

    if (!String(motivo || '').trim() || String(motivo).trim().length < MOTIVO_MIN) {
      return res.status(400).json({ error: `El motivo debe tener al menos ${MOTIVO_MIN} caracteres` });
    }
    const verif = await verificarPin(req.user.uid || req.user.id, pin, 'editar_prestamo_nomina');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    const prestRef = db.collection('prestamos_nomina').doc(req.params.id);
    const prestDoc = await prestRef.get();
    if (!prestDoc.exists) return res.status(404).json({ error: 'Préstamo no encontrado' });
    const p = prestDoc.data();
    if (p.userId !== adminId) return res.status(403).json({ error: 'Préstamo de otra empresa' });
    if (p.estado === 'ANULADO') return res.status(400).json({ error: `${p.numero} está anulado` });

    const egresoRef = db.collection('egresos').doc(p.egresoId);
    const egDoc = await egresoRef.get();
    if (egDoc.exists && egDoc.data().cruzadoEnNomina === true) {
      return res.status(400).json({
        error: `${p.numero} ya se descontó en la nómina ${egDoc.data().cruzadoEnEgresoNumero || ''}. ` +
               `Para corregirlo, corrige primero ese comprobante de nómina.`
      });
    }

    const nuevoValor = valor !== undefined && valor !== '' ? Math.round(num(valor)) : p.valor;
    if (nuevoValor <= 0) return res.status(400).json({ error: 'El valor del préstamo debe ser mayor a cero' });
    const nuevaCajaId = cajaId || p.cajaId;
    const cambiaDinero = nuevoValor !== num(p.valor) || nuevaCajaId !== p.cajaId;

    let nuevaEmpresa = { id: p.empresaId, nombre: p.empresaNombre, nit: p.empresaNit };
    if (empresaId !== undefined && empresaId !== p.empresaId) {
      const re = await cargarEmpresa(adminId, empresaId);
      if (re.error) return res.status(re.status).json({ error: re.error });
      nuevaEmpresa = re.empresa;
    }

    // El tope se vuelve a evaluar (sin contarse a sí mismo).
    const r = await cargarEmpleado(adminId, p.empleadoId);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const ev = await evaluar(adminId, r.emp, nuevoValor, p.fechaSolicitud, req.params.id);
    if (ev.error) return res.status(ev.status).json({ error: ev.error });
    let excesoRegistrado = null;
    if (ev.tope.excedido) {
      const mx = String(motivoExceso || '').trim();
      if (confirmoExceso !== true || mx.length < MOTIVO_MIN) {
        return res.status(409).json({
          codigo: 'TOPE_EXCEDIDO', requiereConfirmacion: true,
          error: ev.advertencia, advertencia: ev.advertencia, tope: ev.tope, previos: ev.previos
        });
      }
      excesoRegistrado = {
        motivo: mx, confirmadoPor: req.user.email || '', cupoQuincena: ev.tope.cupoQuincena,
        totalConEste: ev.tope.totalConEste, exceso: ev.tope.exceso
      };
    }

    const cajaViejaRef = db.collection('cajas').doc(p.cajaId);
    const cajaNuevaRef = db.collection('cajas').doc(nuevaCajaId);
    const ts = admin.firestore.FieldValue.serverTimestamp();
    const cambios = {};
    if (nuevoValor !== num(p.valor)) cambios.valor = { antes: p.valor, despues: nuevoValor };
    if (nuevaCajaId !== p.cajaId) cambios.cajaId = { antes: p.cajaId, despues: nuevaCajaId };
    if (nuevaEmpresa.id !== p.empresaId) cambios.empresaId = { antes: p.empresaId, despues: nuevaEmpresa.id };
    if (notas !== undefined && notas !== p.notas) cambios.notas = { antes: p.notas || '', despues: notas };
    if (Object.keys(cambios).length === 0) return res.status(400).json({ error: 'No hay cambios para guardar' });

    const resultado = await db.runTransaction(async (tx) => {
      const lecturas = [tx.get(cajaViejaRef)];
      if (cambiaDinero && nuevaCajaId !== p.cajaId) lecturas.push(tx.get(cajaNuevaRef));
      const docs = await Promise.all(lecturas);
      const cajaVieja = docs[0].data();
      const cajaNueva = docs[1] ? docs[1].data() : cajaVieja;
      if (docs[1] && !docs[1].exists) { const err = new Error('Caja no encontrada'); err.status = 404; throw err; }
      if (cajaNueva.userId !== adminId) { const err = new Error('Caja de otra empresa'); err.status = 403; throw err; }

      let formaEntrega = p.formaEntrega, cajaNombre = p.cajaNombre;
      if (cambiaDinero) {
        // Saldo disponible en la caja que va a pagar, contando lo que se reintegra.
        const disponible = num(cajaNueva.saldo) + (nuevaCajaId === p.cajaId ? num(p.valor) : 0);
        if (disponible < nuevoValor) {
          const err = new Error(`Saldo insuficiente en "${cajaNueva.nombre}". Disponible: ${fmt(disponible)}`);
          err.status = 400; throw err;
        }
        formaEntrega = esCajaEfectivo(cajaNueva) ? 'Efectivo' : 'Transferencia';
        cajaNombre = cajaNueva.nombre || '';

        tx.update(cajaViejaRef, { saldo: admin.firestore.FieldValue.increment(num(p.valor)), updatedAt: ts });
        tx.set(db.collection('movimientos').doc(), {
          userId: adminId, cajaId: p.cajaId, tipo: 'ingreso',
          concepto: `Ajuste ${p.numero} (reverso): ${p.empleadoNombre}`, monto: num(p.valor),
          referencia: p.egresoNumero, egresoId: p.egresoId, prestamoNominaId: req.params.id,
          creadoPor: req.user.email || '', createdAt: ts
        });
        tx.update(cajaNuevaRef, { saldo: admin.firestore.FieldValue.increment(-nuevoValor), updatedAt: ts });
        tx.set(db.collection('movimientos').doc(), {
          userId: adminId, cajaId: nuevaCajaId, tipo: 'egreso',
          concepto: `Ajuste ${p.numero}: ${p.empleadoNombre}`, monto: nuevoValor,
          referencia: p.egresoNumero, formaPago: formaEntrega, egresoId: p.egresoId,
          prestamoNominaId: req.params.id, creadoPor: req.user.email || '', createdAt: ts
        });
      }

      tx.update(egresoRef, {
        monto: nuevoValor, totalPagar: nuevoValor, montoPagado: nuevoValor,
        cajaId: nuevaCajaId, formaPago: formaEntrega, empresaId: nuevaEmpresa.id,
        notas: notas !== undefined ? notas : (p.notas || ''),
        updatedAt: ts
      });
      tx.update(prestRef, {
        valor: nuevoValor, valorEnLetras: P.valorEnLetras(nuevoValor),
        cajaId: nuevaCajaId, cajaNombre, formaEntrega,
        empresaId: nuevaEmpresa.id, empresaNombre: nuevaEmpresa.nombre, empresaNit: nuevaEmpresa.nit,
        notas: notas !== undefined ? notas : (p.notas || ''),
        tope: ev.tope, excesoConfirmado: excesoRegistrado,
        historial: admin.firestore.FieldValue.arrayUnion({
          fecha: new Date().toISOString(), usuario: req.user.email || '',
          motivo: String(motivo).trim(), cambios
        }),
        updatedAt: ts
      });
      return { formaEntrega, cajaNombre };
    });

    await registrarAuditoria({
      accion: 'PRESTAMO_NOMINA_EDITADO', modulo: 'empleados',
      descripcion: `${p.numero} editado por ${req.user.email}. Motivo: ${String(motivo).trim()}`,
      usuarioId: adminId, usuarioNombre: req.user.email, documento: p.numero,
      datos: { prestamoId: req.params.id, cambios }
    });

    res.json({ ok: true, id: req.params.id, numero: p.numero, valor: nuevoValor, ...resultado });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('PUT prestamos nomina:', e);
    res.status(500).json({ error: 'Error al editar el préstamo' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/prestamos-nomina/:id/anular
// ─────────────────────────────────────────────────────────────────────────────
// Anular, nunca borrar. Devuelve el dinero a la caja y deja el comprobante
// visible como ANULADO. Marca el egreso con `anulado: true` además del estado:
// los cruces de nómina filtran por ese campo, y un anticipo anulado que siga
// "vivo" se le descontaría al trabajador por plata que ya volvió a caja.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/:id/anular', async (req, res) => {
  try {
    if (!exigirAdmin(req, res)) return;
    const adminId = resolverAdminId(req);
    const { pin, motivo } = req.body;

    if (String(motivo || '').trim().length < MOTIVO_MIN) {
      return res.status(400).json({ error: `El motivo debe tener al menos ${MOTIVO_MIN} caracteres` });
    }
    const verif = await verificarPin(req.user.uid || req.user.id, pin, 'anular_prestamo_nomina');
    if (!verif.ok) return res.status(403).json({ error: verif.error, codigo: verif.codigo });

    const prestRef = db.collection('prestamos_nomina').doc(req.params.id);
    const prestDoc0 = await prestRef.get();
    if (!prestDoc0.exists) return res.status(404).json({ error: 'Préstamo no encontrado' });
    const p0 = prestDoc0.data();
    if (p0.userId !== adminId) return res.status(403).json({ error: 'Préstamo de otra empresa' });
    const egresoRef = db.collection('egresos').doc(p0.egresoId);
    const cajaRef = db.collection('cajas').doc(p0.cajaId);

    await db.runTransaction(async (tx) => {
      const [dP, dE] = await Promise.all([tx.get(prestRef), tx.get(egresoRef)]);
      const p = dP.data();
      if (p.estado === 'ANULADO') { const err = new Error(`${p.numero} ya está anulado`); err.status = 400; throw err; }
      if (dE.exists && dE.data().cruzadoEnNomina === true) {
        const err = new Error(`${p.numero} ya se descontó en la nómina ${dE.data().cruzadoEnEgresoNumero || ''}. ` +
          `Para anularlo, corrige primero ese comprobante de nómina.`);
        err.status = 400; throw err;
      }
      const ts = admin.firestore.FieldValue.serverTimestamp();
      const ahora = new Date().toISOString();

      tx.update(prestRef, {
        estado: 'ANULADO', motivoAnulacion: String(motivo).trim(),
        anuladoPor: req.user.email || '', anuladoEn: ahora, updatedAt: ts
      });
      if (dE.exists) {
        tx.update(egresoRef, {
          estado: 'ANULADO', anulado: true,
          motivoAnulacion: String(motivo).trim(), motvoAnulacion: String(motivo).trim(),
          anuladoPor: req.user.email || '', anuladoEn: ahora, updatedAt: ts
        });
      }
      tx.update(cajaRef, { saldo: admin.firestore.FieldValue.increment(num(p.valor)), updatedAt: ts });
      tx.set(db.collection('movimientos').doc(), {
        userId: adminId, cajaId: p.cajaId, tipo: 'ingreso',
        concepto: `Anulación ${p.numero}: ${p.empleadoNombre}`, monto: num(p.valor),
        referencia: p.egresoNumero, egresoId: p.egresoId, prestamoNominaId: req.params.id,
        creadoPor: req.user.email || '', createdAt: ts
      });
    });

    await registrarAuditoria({
      accion: 'PRESTAMO_NOMINA_ANULADO', modulo: 'empleados',
      descripcion: `ANULACIÓN: ${p0.numero} (${fmt(p0.valor)} a ${p0.empleadoNombre}) por ${req.user.email}. Motivo: ${String(motivo).trim()}`,
      usuarioId: adminId, usuarioNombre: req.user.email, documento: p0.numero,
      datos: { prestamoId: req.params.id, egresoId: p0.egresoId, valor: p0.valor, motivo: String(motivo).trim() }
    });

    res.json({ ok: true, id: req.params.id, estado: 'ANULADO', dineroReversado: num(p0.valor) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('POST anular prestamo nomina:', e);
    res.status(500).json({ error: 'Error al anular el préstamo' });
  }
});

module.exports = router;
