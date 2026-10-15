// ═══════════════════════════════════════════════════════════════════════════════
// test-prestamos-nomina.js — NOMINA-PRESTAMO-001
// ─────────────────────────────────────────────────────────────────────────────
// Sin Firestore real: se reemplaza por una base en memoria con transacciones
// que se descartan si algo falla (para probar que no quedan números quemados).
//     node backend/scripts/test-prestamos-nomina.js
// ═══════════════════════════════════════════════════════════════════════════════
const path = require('path');
const http = require('http');

// ─── Firestore falso ────────────────────────────────────────────────────────
const clone = (o) => JSON.parse(JSON.stringify(o));
const aplicar = (prev, patch, merge) => {
  const base = merge ? clone(prev || {}) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v && v.__op === 'increment') base[k] = (Number(base[k]) || 0) + v.n;
    else if (v && v.__op === 'serverTimestamp') base[k] = new Date().toISOString();
    else if (v && v.__op === 'arrayUnion') base[k] = (base[k] || []).concat(clone(v.items));
    else base[k] = clone(v);
  }
  return base;
};

class FakeDB {
  constructor() { this.data = {}; this.n = 0; }
  collection(name) { return new Col(this, name); }
  getAll(...refs) { return Promise.all(refs.map(r => r.get())); }
  async runTransaction(fn) {
    const ops = [];
    const tx = {
      get: (ref) => ref.get(),
      set: (ref, obj, opt) => ops.push(() => ref._set(obj, opt)),
      update: (ref, obj) => ops.push(() => ref._update(obj))
    };
    const r = await fn(tx);          // si lanza, ops se descartan: rollback
    ops.forEach(o => o());
    return r;
  }
}
class Col {
  constructor(db, name) { this.db = db; this.name = name; this.db.data[name] = this.db.data[name] || {}; }
  doc(id) { return new Ref(this.db, this.name, id || `auto${++this.db.n}`); }
  async add(obj) { const r = this.doc(); r._set(obj); return r; }
  where(f, op, v) { return new Query(this, [[f, v]]); }
  async get() { return new Query(this, []).get(); }
}
class Query {
  constructor(col, filtros) { this.col = col; this.filtros = filtros; }
  where(f, op, v) { return new Query(this.col, [...this.filtros, [f, v]]); }
  async get() {
    const docs = Object.entries(this.col.db.data[this.col.name])
      .filter(([, d]) => this.filtros.every(([f, v]) => d[f] === v))
      .map(([id, d]) => snap(this.col.db, this.col.name, id, d));
    return { docs, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
  }
}
const snap = (db, col, id, d) => ({ id, exists: d !== undefined, data: () => clone(d), ref: new Ref(db, col, id) });
class Ref {
  constructor(db, col, id) { this.db = db; this.col = col; this.id = id; }
  async get() { return snap(this.db, this.col, this.id, this.db.data[this.col]?.[this.id]); }
  _set(obj, opt) { this.db.data[this.col] = this.db.data[this.col] || {}; this.db.data[this.col][this.id] = aplicar(this.db.data[this.col][this.id], obj, !!(opt && opt.merge)); }
  _update(obj) {
    if (this.db.data[this.col]?.[this.id] === undefined) throw new Error(`update sobre doc inexistente ${this.col}/${this.id}`);
    this.db.data[this.col][this.id] = aplicar(this.db.data[this.col][this.id], obj, true);
  }
  async set(obj, opt) { this._set(obj, opt); }
  async update(obj) { this._update(obj); }
}

const fakeDb = new FakeDB();
const fakeAdmin = { firestore: { FieldValue: {
  increment: (n) => ({ __op: 'increment', n }),
  serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  arrayUnion: (...items) => ({ __op: 'arrayUnion', items })
} } };
const fbPath = require.resolve(path.join(__dirname, '../config/firebase'));
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { db: fakeDb, admin: fakeAdmin } };

const P = require('../services/prestamosNomina');
const N = require('../services/nominaColombia');
const express = require('express');

// ─── Mini framework de pruebas ──────────────────────────────────────────────
let pasaron = 0, fallaron = 0;
const casos = [];
const seccion = (t) => casos.push({ seccion: t });
const check = (nombre, obtenido, esperado, tol = 0) => {
  const ok = typeof esperado === 'number' ? Math.abs(obtenido - esperado) <= tol : obtenido === esperado;
  casos.push({ nombre, obtenido, esperado, ok });
  ok ? pasaron++ : fallaron++;
};

const SMMLV = N.parametrosAnio(2026).smmlv;

// ═════════════════════════════════════════════════════════════════════════════
seccion('1 · Fecha de descuento (política de quincenas)');
// ═════════════════════════════════════════════════════════════════════════════
check('5 oct → 15 oct (ejemplo de Milena)', P.fechaDescuento('2026-10-05'), '2026-10-15');
check('17 oct → 30 oct (ejemplo de Milena)', P.fechaDescuento('2026-10-17'), '2026-10-30');
check('el mismo 15 se descuenta ese día', P.fechaDescuento('2026-10-15'), '2026-10-15');
check('el mismo 30 se descuenta ese día', P.fechaDescuento('2026-10-30'), '2026-10-30');
check('día 1 → 15', P.fechaDescuento('2026-11-01'), '2026-11-15');
check('día 31 → 15 del mes siguiente', P.fechaDescuento('2026-10-31'), '2026-11-15');
check('31 de diciembre → 15 de enero del otro año', P.fechaDescuento('2026-12-31'), '2027-01-15');
check('febrero: del 16 al 28 se paga el 28', P.fechaDescuento('2026-02-16'), '2026-02-28');
check('febrero: el 28 se paga el 28', P.fechaDescuento('2026-02-28'), '2026-02-28');
check('febrero bisiesto: el 29 se paga el 29', P.fechaDescuento('2028-02-29'), '2028-02-29');
check('mes de 30 días: 30 nov → 30 nov', P.fechaDescuento('2026-11-30'), '2026-11-30');
check('fecha imposible (30 feb) → null', P.fechaDescuento('2026-02-30'), null);
check('texto basura → null', P.fechaDescuento('hola'), null);

// ═════════════════════════════════════════════════════════════════════════════
seccion('2 · Valor en letras');
// ═════════════════════════════════════════════════════════════════════════════
const letras = { 1: 'un peso', 50000: 'cincuenta mil pesos', 1000: 'mil pesos', 21000: 'veintiún mil pesos',
  31000: 'treinta y un mil pesos', 100000: 'cien mil pesos', 120000: 'ciento veinte mil pesos',
  1500000: 'un millón quinientos mil pesos', 2000000: 'dos millones de pesos', 1000000: 'un millón de pesos',
  999999: 'novecientos noventa y nueve mil novecientos noventa y nueve pesos', 21000000: 'veintiún millones de pesos' };
for (const [v, t] of Object.entries(letras)) check(`${v} → "${t}"`, P.valorEnLetras(Number(v)), t);

// ═════════════════════════════════════════════════════════════════════════════
seccion('3 · Tope de descuento por quincena');
// ═════════════════════════════════════════════════════════════════════════════
// Hecho a mano: (3.000.000 − 1.750.905) ÷ 5 = 249.819 al mes → 124.910 por quincena
const cupoLegal = P.calcularCupoQuincena({ salario: 3000000, fechaDescuento: '2026-10-15' });
check('modo legal, salario 3.000.000: cupo mensual 249.819', cupoLegal.cupoMensual, 249819, 1);
check('modo legal, salario 3.000.000: cupo quincena 124.910', cupoLegal.cupoQuincena, 124910, 1);
check('modo legal, salario mínimo: cupo 0', P.calcularCupoQuincena({ salario: SMMLV, fechaDescuento: '2026-10-15' }).cupoQuincena, 0);
check('modo legal, salario menor al mínimo: cupo 0', P.calcularCupoQuincena({ salario: 900000, fechaDescuento: '2026-10-15' }).cupoQuincena, 0);
check('modo porcentaje 20 %, salario 3.000.000: cupo quincena 300.000',
  P.calcularCupoQuincena({ salario: 3000000, fechaDescuento: '2026-10-15', modo: 'porcentaje', porcentaje: 20 }).cupoQuincena, 300000);
const t1 = P.evaluarTope({ salario: 3000000, fechaDescuento: '2026-10-15', valor: 50000, comprometidoPrevio: 50000 });
check('100.000 dentro del cupo de 124.910: no excede', t1.excedido, false);
const t2 = P.evaluarTope({ salario: 3000000, fechaDescuento: '2026-10-15', valor: 50000, comprometidoPrevio: 100000 });
check('150.000 supera 124.910: excede', t2.excedido, true);
check('el exceso es 25.090', t2.exceso, 25090, 1);
check('estado: anulado manda', P.estadoPrestamo({ estado: 'ANULADO' }, { cruzadoEnNomina: true }), 'ANULADO');
check('estado: cruzado en nómina = DESCONTADO', P.estadoPrestamo({ estado: 'ACTIVO' }, { cruzadoEnNomina: true }), 'DESCONTADO');
check('estado: pendiente = ACTIVO', P.estadoPrestamo({ estado: 'ACTIVO' }, { cruzadoEnNomina: false }), 'ACTIVO');

// ═════════════════════════════════════════════════════════════════════════════
// Integración de la ruta
// ═════════════════════════════════════════════════════════════════════════════
const sembrar = () => {
  fakeDb.data = {};
  const put = (col, id, obj) => fakeDb.collection(col).doc(id)._set(obj);
  put('users', 'admin1', { role: 'admin', pin: '1234', email: 'admin@test.co' });
  put('users', 'admin2', { role: 'admin', pin: '9999', email: 'otro@test.co' });
  put('empleados', 'e1', { userId: 'admin1', nombre: 'Juan Pérez', documento: '1111', tipoDocumento: 'CC', cargo: 'Técnico', salario: 3000000, activo: true });
  put('empleados', 'e2', { userId: 'admin1', nombre: 'Ana Mínimo', documento: '2222', tipoDocumento: 'CC', cargo: 'Auxiliar', salario: SMMLV, activo: true });
  put('empleados', 'eOtro', { userId: 'admin2', nombre: 'Ajeno', documento: '9', salario: 5000000, activo: true });
  put('cajas', 'c1', { userId: 'admin1', nombre: 'Caja menor', tipo: 'Efectivo', saldo: 500000 });
  put('cajas', 'c2', { userId: 'admin1', nombre: 'Bancolombia', tipo: 'Banco', saldo: 1000000 });
  put('cajas', 'cOtro', { userId: 'admin2', nombre: 'Caja ajena', tipo: 'Efectivo', saldo: 999999 });
  put('companies', 'emp1', { user_id: 'admin1', name: 'Extintores del Valle SAS', nit: '901443552' });
  put('configuracion', 'admin1', { categoriasEgresos: [{ nombre: 'Servicios' }, { nombre: 'ANTICIPOS DE NOMINA' }] });
  put('counters', 'admin1_egresos', { value: 41 });
};

const montar = () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const tenant = req.headers['x-test-tenant'] || 'admin1';
    req.user = { uid: tenant, id: tenant, role: req.headers['x-test-role'] || 'admin', email: `${tenant}@test.co` };
    req.adminId = tenant;
    next();
  });
  app.use('/api/prestamos-nomina', require('../routes/prestamosNomina'));
  return http.createServer(app);
};

(async () => {
  const server = montar();
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/prestamos-nomina`;
  const call = async (metodo, ruta, body, headers = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo, headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null; try { json = await r.json(); } catch { }
    return { status: r.status, body: json };
  };
  const D = (col, id) => (id === undefined ? fakeDb.data[col] : fakeDb.data[col]?.[id]);
  const contador = (n) => D('counters', n)?.value;
  // Confirmación del exceso: e1 ya está por encima del tope en la quincena del 15 oct
  const CONF = { confirmoExceso: true, motivoExceso: 'Aprobado por gerencia (prueba)' };

  sembrar();

  // ───────────────────────────────────────────────────────────────────────────
  seccion('4 · Crear: número, fecha, forma de entrega, egreso y caja');
  const r1 = await call('POST', '/', { empleadoId: 'e1', valor: 50000, cajaId: 'c1', empresaId: 'emp1', fechaSolicitud: '2026-10-05' });
  check('crea el préstamo (201)', r1.status, 201);
  check('número PN-0001', r1.body?.numero, 'PN-0001');
  check('se descuenta el 15 de octubre', r1.body?.fechaDescuento, '2026-10-15');
  check('caja de efectivo → forma de entrega Efectivo', r1.body?.formaEntrega, 'Efectivo');
  check('valor en letras', r1.body?.valorEnLetras, 'cincuenta mil pesos');
  check('guarda el salario del contrato', r1.body?.salarioContrato, 3000000);
  check('guarda la cédula del trabajador', r1.body?.empleadoDocumento, '1111');
  check('guarda razón social y NIT', `${r1.body?.empresaNombre}|${r1.body?.empresaNit}`, 'Extintores del Valle SAS|901443552');
  check('la caja baja 50.000', D('cajas', 'c1').saldo, 450000);
  const eg1 = D('egresos', r1.body?.egresoId);
  check('crea el egreso EGR-0042 (sigue el contador de egresos)', eg1?.numero, 'EGR-0042');
  check('el egreso es anticipo de nómina', eg1?.esAnticipoNomina, true);
  check('el egreso queda ligado al empleado', eg1?.empleadoId, 'e1');
  check('usa la categoría de anticipos del suscriptor', eg1?.categoria, 'ANTICIPOS DE NOMINA');
  check('el egreso nace PAGADO y sin cruzar', `${eg1?.estado}|${eg1?.cruzadoEnNomina}`, 'PAGADO|false');
  const movs = Object.values(D('movimientos') || {});
  check('deja un movimiento de egreso en caja', movs.filter(m => m.tipo === 'egreso' && m.monto === 50000 && m.cajaId === 'c1').length, 1);
  check('contador de egresos avanzó a 42', contador('admin1_egresos'), 42);
  check('contador de préstamos en 1', contador('admin1_prestamos_nomina'), 1);

  const r2 = await call('POST', '/', { empleadoId: 'e1', valor: 40000, cajaId: 'c2', empresaId: 'emp1', fechaSolicitud: '2026-10-17' });
  check('segundo préstamo desde banco (201)', r2.status, 201);
  check('número PN-0002', r2.body?.numero, 'PN-0002');
  check('17 oct → se descuenta el 30 oct', r2.body?.fechaDescuento, '2026-10-30');
  check('banco → forma de entrega Transferencia', r2.body?.formaEntrega, 'Transferencia');
  check('el banco baja 40.000', D('cajas', 'c2').saldo, 960000);

  // ───────────────────────────────────────────────────────────────────────────
  seccion('5 · Validaciones y atomicidad (nada queda a medias)');
  const antesPN = contador('admin1_prestamos_nomina'), antesEG = contador('admin1_egresos'), antesSaldo = D('cajas', 'c1').saldo;
  const rSin = await call('POST', '/', { empleadoId: 'e1', valor: 600000, cajaId: 'c1', fechaSolicitud: '2026-10-06', ...CONF });
  check('sin saldo → 400', rSin.status, 400);
  check('mensaje de saldo insuficiente', /Saldo insuficiente/.test(rSin.body?.error || ''), true);
  check('no se quema número de préstamo', contador('admin1_prestamos_nomina'), antesPN);
  check('no se quema número de egreso', contador('admin1_egresos'), antesEG);
  check('la caja no se toca', D('cajas', 'c1').saldo, antesSaldo);
  check('valor cero → 400', (await call('POST', '/', { empleadoId: 'e1', valor: 0, cajaId: 'c1' })).status, 400);
  check('sin caja → 400', (await call('POST', '/', { empleadoId: 'e1', valor: 1000 })).status, 400);
  check('fecha imposible → 400', (await call('POST', '/', { empleadoId: 'e1', valor: 1000, cajaId: 'c1', fechaSolicitud: '2026-02-30' })).status, 400);

  // ───────────────────────────────────────────────────────────────────────────
  seccion('6 · Tope: advierte, no bloquea, exige motivo');
  // e1 ya tiene 50.000 para el 15 oct. Otro de 50.000 → 100.000 (cupo 124.910): pasa.
  const r3 = await call('POST', '/', { empleadoId: 'e1', valor: 50000, cajaId: 'c1', fechaSolicitud: '2026-10-10' });
  check('100.000 en la misma quincena, dentro del cupo (201)', r3.status, 201);
  check('PN-0003 sin saltos de numeración', r3.body?.numero, 'PN-0003');
  // Un tercero de 50.000 → 150.000 > 124.910
  const antesCont = contador('admin1_prestamos_nomina');
  const r4 = await call('POST', '/', { empleadoId: 'e1', valor: 50000, cajaId: 'c1', fechaSolicitud: '2026-10-12' });
  check('150.000 supera el cupo → 409 pide confirmación', r4.status, 409);
  check('código TOPE_EXCEDIDO', r4.body?.codigo, 'TOPE_EXCEDIDO');
  check('la advertencia dice "ya tiene préstamos por"', /ya tiene préstamos por/.test(r4.body?.advertencia || ''), true);
  check('la advertencia nombra los préstamos previos', /PN-0001/.test(r4.body?.advertencia || '') && /PN-0003/.test(r4.body?.advertencia || ''), true);
  check('la advertencia trae el máximo de la quincena', /124\.910/.test(r4.body?.advertencia || ''), true);
  check('mientras no confirma, no se crea nada', contador('admin1_prestamos_nomina'), antesCont);
  const r5 = await call('POST', '/', { empleadoId: 'e1', valor: 50000, cajaId: 'c1', fechaSolicitud: '2026-10-12', confirmoExceso: true, motivoExceso: 'corto' });
  check('confirmar con motivo muy corto → sigue 409', r5.status, 409);
  const r6 = await call('POST', '/', { empleadoId: 'e1', valor: 50000, cajaId: 'c1', fechaSolicitud: '2026-10-12', confirmoExceso: true, motivoExceso: 'Urgencia médica de un familiar' });
  check('confirmando con motivo suficiente → 201', r6.status, 201);
  check('guarda el motivo del exceso', r6.body?.excesoConfirmado?.motivo, 'Urgencia médica de un familiar');
  check('guarda cuánto se pasó', r6.body?.excesoConfirmado?.exceso, 25090, 1);
  const rMin = await call('POST', '/simular', { empleadoId: 'e2', valor: 50000, fechaSolicitud: '2026-10-05' });
  check('salario mínimo: cupo 0 y avisa', `${rMin.body?.tope?.cupoQuincena}|${rMin.body?.tope?.excedido}`, '0|true');
  check('simular no guarda nada', Object.keys(D('prestamos_nomina')).length, 4);

  // ───────────────────────────────────────────────────────────────────────────
  seccion('7 · Modo porcentaje (configurable por la empresa)');
  check('config por defecto = legal', (await call('GET', '/config')).body?.modoTope, 'legal');
  check('no admin no puede cambiar el tope (403)', (await call('PUT', '/config', { modoTope: 'porcentaje', porcentaje: 20 }, { 'x-test-role': 'tesoreria' })).status, 403);
  check('porcentaje fuera de rango → 400', (await call('PUT', '/config', { modoTope: 'porcentaje', porcentaje: 150 })).status, 400);
  check('guarda modo porcentaje 20 %', (await call('PUT', '/config', { modoTope: 'porcentaje', porcentaje: 20 })).status, 200);
  const rMin2 = await call('POST', '/simular', { empleadoId: 'e2', valor: 50000, fechaSolicitud: '2026-11-05' });
  check('con 20 %, salario mínimo: cupo quincena 175.091 y no excede', `${rMin2.body?.tope?.cupoQuincena}|${rMin2.body?.tope?.excedido}`, '175091|false');
  await call('PUT', '/config', { modoTope: 'legal' });

  // ───────────────────────────────────────────────────────────────────────────
  seccion('8 · Lista y estado');
  const lista = await call('GET', '/');
  check('la lista trae los 4 préstamos', lista.body?.prestamos?.length, 4);
  check('todos ACTIVOS', lista.body?.prestamos?.every(p => p.estado === 'ACTIVO'), true);
  check('valor pendiente = 190.000', lista.body?.resumen?.valorPendiente, 190000);
  check('orden: el más nuevo primero', lista.body?.prestamos?.[0]?.numero, 'PN-0004');

  // ───────────────────────────────────────────────────────────────────────────
  seccion('9 · Editar (PIN + motivo, caja siempre cuadrada)');
  const id1 = r1.body.id;
  check('sin PIN → 403', (await call('PUT', `/${id1}`, { motivo: 'Corrección del valor digitado', valor: 80000 })).status, 403);
  check('PIN incorrecto → 403', (await call('PUT', `/${id1}`, { motivo: 'Corrección del valor digitado', valor: 80000, pin: '0000' })).status, 403);
  check('motivo corto → 400', (await call('PUT', `/${id1}`, { motivo: 'corto', valor: 80000, pin: '1234' })).status, 400);
  check('no admin → 403', (await call('PUT', `/${id1}`, { motivo: 'Corrección del valor digitado', valor: 80000, pin: '1234' }, { 'x-test-role': 'tesoreria' })).status, 403);
  const sinConfirmar = await call('PUT', `/${id1}`, { motivo: 'Corrección del valor digitado', valor: 80000, pin: '1234' });
  check('editar que deja a e1 sobre el tope sin confirmar → 409', sinConfirmar.status, 409);
  const saldoAntes = D('cajas', 'c1').saldo;
  const e1r = await call('PUT', `/${id1}`, { motivo: 'Corrección del valor digitado', valor: 80000, pin: '1234', ...CONF });
  check('edita el valor (200)', e1r.status, 200);
  check('la caja baja solo la diferencia (30.000)', D('cajas', 'c1').saldo, saldoAntes - 30000);
  check('el egreso se ajusta a 80.000', D('egresos', r1.body.egresoId).totalPagar, 80000);
  check('el préstamo muestra 80.000 y su valor en letras', `${D('prestamos_nomina', id1).valor}|${D('prestamos_nomina', id1).valorEnLetras}`, '80000|ochenta mil pesos');
  check('queda historial del cambio', D('prestamos_nomina', id1).historial.length, 1);
  check('el historial guarda el motivo', D('prestamos_nomina', id1).historial[0].motivo, 'Corrección del valor digitado');
  check('conserva el número PN-0001', D('prestamos_nomina', id1).numero, 'PN-0001');
  // Cambiar de caja: del efectivo (c1) al banco (c2)
  const c1Antes = D('cajas', 'c1').saldo, c2Antes = D('cajas', 'c2').saldo;
  const e2r = await call('PUT', `/${id1}`, { motivo: 'Se entregó por transferencia', cajaId: 'c2', pin: '1234', ...CONF });
  check('cambia de caja (200)', e2r.status, 200);
  check('la caja anterior recupera los 80.000', D('cajas', 'c1').saldo, c1Antes + 80000);
  check('el banco paga los 80.000', D('cajas', 'c2').saldo, c2Antes - 80000);
  check('forma de entrega pasa a Transferencia', D('prestamos_nomina', id1).formaEntrega, 'Transferencia');
  check('el egreso también cambia de caja', D('egresos', r1.body.egresoId).cajaId, 'c2');
  check('editar sin cambios → 400', (await call('PUT', `/${id1}`, { motivo: 'Sin cambios reales aquí', pin: '1234', ...CONF })).status, 400);
  const eSinSaldo = await call('PUT', `/${id1}`, { motivo: 'Valor que no alcanza en caja', valor: 5000000, pin: '1234', ...CONF });
  check('editar a un valor sin saldo → 400', eSinSaldo.status, 400);
  check('y no cambia nada', D('prestamos_nomina', id1).valor, 80000);

  // ───────────────────────────────────────────────────────────────────────────
  seccion('10 · Anular (reintegra la caja, nunca borra, no se vuelve a cruzar)');
  const id2 = r2.body.id;
  check('sin PIN → 403', (await call('POST', `/${id2}/anular`, { motivo: 'Se digitó por error' })).status, 403);
  check('motivo corto → 400', (await call('POST', `/${id2}/anular`, { motivo: 'error', pin: '1234' })).status, 400);
  check('no admin → 403', (await call('POST', `/${id2}/anular`, { motivo: 'Se digitó por error', pin: '1234' }, { 'x-test-role': 'tesoreria' })).status, 403);
  const bancoAntes = D('cajas', 'c2').saldo;
  const an = await call('POST', `/${id2}/anular`, { motivo: 'Se digitó por error', pin: '1234' });
  check('anula (200)', an.status, 200);
  check('el dinero vuelve al banco (+40.000)', D('cajas', 'c2').saldo, bancoAntes + 40000);
  check('el préstamo queda ANULADO y visible', D('prestamos_nomina', id2).estado, 'ANULADO');
  const egAn = D('egresos', r2.body.egresoId);
  check('el egreso queda ANULADO', egAn.estado, 'ANULADO');
  check('el egreso queda anulado:true (que la nómina no lo cruce)', egAn.anulado, true);
  check('anular otra vez → 400', (await call('POST', `/${id2}/anular`, { motivo: 'Se digitó por error', pin: '1234' })).status, 400);
  check('editar un anulado → 400', (await call('PUT', `/${id2}`, { motivo: 'Intento editar un anulado', valor: 1000, pin: '1234' })).status, 400);
  const lista2 = await call('GET', '/');
  check('la lista lo muestra ANULADO', lista2.body.prestamos.find(p => p.numero === 'PN-0002').estado, 'ANULADO');
  check('un anulado no cuenta en el tope: quincena del 30 oct libre', (await call('POST', '/simular', { empleadoId: 'e1', valor: 100000, fechaSolicitud: '2026-10-20' })).body.tope.comprometidoPrevio, 0);
  const r7 = await call('POST', '/', { empleadoId: 'e1', valor: 10000, cajaId: 'c1', fechaSolicitud: '2026-10-21' });
  check('el número anulado no se reutiliza (sigue PN-0005)', r7.body?.numero, 'PN-0005');

  // ───────────────────────────────────────────────────────────────────────────
  seccion('11 · Después de la nómina: ya no se toca');
  const idN = r3.body.id;
  D('egresos', r3.body.egresoId).cruzadoEnNomina = true;           // la nómina lo cruzó
  D('egresos', r3.body.egresoId).cruzadoEnEgresoNumero = 'EGR-0099';
  const lista3 = await call('GET', '/');
  const pN = lista3.body.prestamos.find(p => p.id === idN);
  check('pasa a DESCONTADO', pN.estado, 'DESCONTADO');
  check('indica en qué nómina se descontó', pN.descontadoEnNomina, 'EGR-0099');
  const eN = await call('PUT', `/${idN}`, { motivo: 'Intento cambiar un descontado', valor: 1000, pin: '1234' });
  check('no se edita (400)', eN.status, 400);
  check('el mensaje manda corregir la nómina', /EGR-0099/.test(eN.body?.error || ''), true);
  check('no se anula (400)', (await call('POST', `/${idN}/anular`, { motivo: 'Intento anular un descontado', pin: '1234' })).status, 400);
  check('filtro por estado DESCONTADO', (await call('GET', '/?estado=DESCONTADO')).body.prestamos.length, 1);

  // ───────────────────────────────────────────────────────────────────────────
  seccion('12 · Aislamiento entre suscriptores');
  const otro = { 'x-test-tenant': 'admin2' };
  check('otro suscriptor no ve los préstamos', (await call('GET', '/', null, otro)).body.prestamos.length, 0);
  check('no puede editar uno ajeno (403)', (await call('PUT', `/${id1}`, { motivo: 'Intento desde otra empresa', valor: 1000, pin: '9999' }, otro)).status, 403);
  check('no puede anular uno ajeno (403)', (await call('POST', `/${id1}/anular`, { motivo: 'Intento desde otra empresa', pin: '9999' }, otro)).status, 403);
  check('no puede prestarle a un empleado ajeno (403)', (await call('POST', '/', { empleadoId: 'e1', valor: 1000, cajaId: 'cOtro' }, otro)).status, 403);
  check('no puede sacar plata de una caja ajena (403)', (await call('POST', '/', { empleadoId: 'eOtro', valor: 1000, cajaId: 'c1' }, otro)).status, 403);
  check('la caja ajena sigue intacta', D('cajas', 'c1').saldo === undefined ? -1 : D('cajas', 'cOtro').saldo, 999999);
  check('no puede usar la empresa de otro suscriptor (403)', (await call('POST', '/', { empleadoId: 'eOtro', valor: 1000, cajaId: 'cOtro', empresaId: 'emp1' }, otro)).status, 403);
  check('no ve la configuración de tope de otro (usa la suya)', (await call('GET', '/config', null, otro)).body?.modoTope, 'legal');

  server.close();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PRUEBAS · Préstamos de nómina (NOMINA-PRESTAMO-001)');
  console.log('══════════════════════════════════════════════════════════════\n');
  const fmtN = n => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
  for (const c of casos) {
    if (c.seccion) { console.log(`\n${c.seccion}`); console.log('─'.repeat(62)); continue; }
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`);
    if (!c.ok) {
      const v = typeof c.obtenido === 'number' ? fmtN(c.obtenido) : String(c.obtenido);
      const e = typeof c.esperado === 'number' ? fmtN(c.esperado) : String(c.esperado);
      console.log(`      obtenido: ${v}   ·   esperado: ${e}`);
    }
  }
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  ${pasaron} pasaron · ${fallaron} fallaron`);
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(fallaron > 0 ? 1 : 0);
})().catch(e => { console.error('ERROR EN LA PRUEBA:', e); process.exit(1); });
