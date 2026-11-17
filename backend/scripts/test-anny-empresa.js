// ═══════════════════════════════════════════════════════════════
// test-anny-empresa.js — ANNY-EMPRESA-067
// ───────────────────────────────────────────────────────────────
// Sin Firestore ni modelo: prueba que la empresa, el IVA y la cuenta
// de pago los resuelve el sistema y no dependen de lo que escoja Anny.
//     node backend/scripts/test-anny-empresa.js
// ═══════════════════════════════════════════════════════════════
const path = require('path');
const Module = require('module');

// Firebase falso: estos módulos no deben tocar la base en esta prueba.
const firebasePath = path.resolve(__dirname, '../config/firebase.js');
require.cache[firebasePath] = { id: firebasePath, filename: firebasePath, loaded: true, exports: { db: {}, admin: {} } };
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (/config\/firebase$/.test(req)) return firebasePath;
  return _resolve.call(this, req, ...rest);
};

const E = require('../services/anny/empresa');
const prompt = require('../services/anny/prompt');

let ok = 0, mal = 0;
const t = (nombre, cond) => { if (cond) { ok++; console.log('  ✅', nombre); } else { mal++; console.log('  ❌', nombre); } };

const CON_IVA = { id: 'empIva', nombre: 'EMPRESA CON IVA SAS', iva: 19, mediosPago: 'Banco A ahorros 111-111 a nombre de EMPRESA CON IVA SAS', criterio: 'el cliente necesita factura electrónica' };
const SIN_IVA = { id: 'empSin', nombre: 'EMPRESA SIN IVA', iva: 0, mediosPago: 'Banco B ahorros 222-222 a nombre de EMPRESA SIN IVA', criterio: 'el cliente no necesita factura electrónica' };
const empresas = [CON_IVA, SIN_IVA];

console.log('\n1 · Empresa del cliente');
let c = E.resolverEmpresa({ empresas, fichaCliente: { existe: true, empresaId: 'empIva' }, ordenes: [{ empresaId: 'empSin' }], empresaIdChat: 'empSin' });
t('cliente registrado → manda su empresa, por encima de órdenes y chat', c.modo === 'resuelta' && c.empresa.id === 'empIva' && c.origen === 'cliente');
c = E.resolverEmpresa({ empresas, fichaCliente: { existe: false }, ordenes: [{ empresaId: '' }, { empresaId: 'empSin' }] });
t('sin ficha → la empresa de su orden', c.modo === 'resuelta' && c.empresa.id === 'empSin' && c.origen === 'orden');
c = E.resolverEmpresa({ empresas, fichaCliente: { existe: false }, ordenes: [], empresaIdChat: 'empIva' });
t('cliente nuevo que ya respondió → la guardada en el chat', c.modo === 'resuelta' && c.origen === 'chat');
c = E.resolverEmpresa({ empresas, fichaCliente: { existe: false }, ordenes: [] });
t('cliente nuevo sin datos → por definir, con las 2 opciones', c.modo === 'por_definir' && c.opciones.length === 2);
c = E.resolverEmpresa({ empresas: [SIN_IVA], fichaCliente: { existe: false }, ordenes: [] });
t('suscriptor con una sola empresa → nunca pregunta', c.modo === 'resuelta' && c.origen === 'unica');
c = E.resolverEmpresa({ empresas: [{ ...CON_IVA, criterio: '' }, { ...SIN_IVA, criterio: '' }], fichaCliente: { existe: false }, ordenes: [] });
t('sin criterio configurado → no pregunta (comportamiento anterior)', c.modo === 'sin_criterio');
c = E.resolverEmpresa({ empresas: [], fichaCliente: { existe: false } });
t('sin empresas → sin_empresas y pago como antes', c.modo === 'sin_empresas' && c.pagoPorEmpresa === false);
c = E.resolverEmpresa({ empresas, fichaCliente: { existe: true, empresaId: 'idQueNoExiste' }, ordenes: [] });
t('empresaId desconocido no resuelve a ciegas', c.modo === 'por_definir');

console.log('\n2 · IVA en el precio');
const ctxIva = E.resolverEmpresa({ empresas, fichaCliente: { existe: true, empresaId: 'empIva' } });
const ctxSin = E.resolverEmpresa({ empresas, fichaCliente: { existe: true, empresaId: 'empSin' } });
const ctxNuevo = E.resolverEmpresa({ empresas, fichaCliente: { existe: false } });
t('empresa con IVA 19% → factor 1,19', Math.abs(E.factorIva(ctxIva) - 1.19) < 1e-9);
t('empresa sin IVA → factor 1', E.factorIva(ctxSin) === 1);
t('por definir → factor 1 (y el precio se oculta)', E.factorIva(ctxNuevo) === 1);

const sel = { modo: 'filtrado', familia: 'recarga', productos: [{ nombre: 'RECARGA ABC 10 LB', categoria: 'Recargas', precio: 25000 }] };
const base = { instruccion: '', maxChars: 300, fichaCliente: { existe: false }, seleccion: sel, estado: { slots: { items: [{ nombre: 'RECARGA ABC 10 LB', cantidad: 2, precio: 25000 }] } } };
let txt = prompt.bloqueContexto({ ...base, empresaTxt: E.textoContexto(ctxIva), factorIva: E.factorIva(ctxIva) });
t('con IVA: el modelo ve $29.750 y NO ve $25.000', txt.includes('$29.750') && !txt.includes('$25.000'));
t('con IVA: se le ordena decir "IVA incluido"', txt.includes('IVA incluido'));
txt = prompt.bloqueContexto({ ...base, empresaTxt: E.textoContexto(ctxSin), factorIva: E.factorIva(ctxSin) });
t('sin IVA: el modelo ve $25.000', txt.includes('$25.000') && !txt.includes('$29.750'));
txt = prompt.bloqueContexto({ ...base, empresaTxt: E.textoContexto(ctxNuevo), factorIva: 1, ocultarPrecios: true });
t('por definir: no ve NINGÚN precio', !txt.includes('$25.000') && !txt.includes('$29.750'));
t('por definir: se le pide una sola pregunta y el id', txt.includes('[empIva]') && txt.includes('[empSin]') && txt.includes('UNA sola pregunta'));
txt = prompt.bloqueContexto({ ...base });
t('sin el módulo (llamada antigua): precio base, igual que antes', txt.includes('$25.000'));

console.log('\n3 · Cuenta de pago');
txt = E.textoContexto(ctxIva);
t('cliente de la empresa con IVA → solo ve la cuenta 111-111', txt.includes('111-111') && !txt.includes('222-222'));
txt = E.textoContexto(ctxSin);
t('cliente de la empresa sin IVA → solo ve la cuenta 222-222', txt.includes('222-222') && !txt.includes('111-111'));
txt = E.textoContexto(ctxNuevo);
t('por definir → no ve ninguna cuenta', !txt.includes('111-111') && !txt.includes('222-222'));
c = E.resolverEmpresa({ empresas: [{ ...CON_IVA, criterio: '' }, { ...SIN_IVA, criterio: '' }], fichaCliente: { existe: false } });
txt = E.textoContexto(c);
t('no se sabe la empresa y no hay criterio → ninguna cuenta, escala', !txt.includes('111-111') && !txt.includes('222-222') && txt.includes('FACTURACION'));
c = E.resolverEmpresa({ empresas: [{ ...CON_IVA, mediosPago: '' }, SIN_IVA], fichaCliente: { existe: true, empresaId: 'empIva' } });
txt = E.textoContexto(c);
t('empresa sin cuenta configurada → no presta la de la otra', !txt.includes('222-222') && txt.includes('FACTURACION'));

const system = prompt.construirSystem({ perfil: { nombreAgente: 'Anny', empresa: 'X', vertical: 'v', queVende: 'q', mediosPago: 'CUENTA GENERAL 999-999', horarioAtencion: null, tono: {} }, nicho: { ejemplos: [] }, mision: { objetivo: '', reglas: '', permiteVenta: true }, misionNombre: 'ATENCION', catalogoModo: 'products', pagoPorEmpresa: true });
t('con cuentas por empresa, el texto general 999-999 ya no entra al prompt', !JSON.stringify(system).includes('999-999'));
const system2 = prompt.construirSystem({ perfil: { nombreAgente: 'Anny', empresa: 'X', vertical: 'v', queVende: 'q', mediosPago: 'CUENTA GENERAL 999-999', horarioAtencion: null, tono: {} }, nicho: { ejemplos: [] }, mision: { objetivo: '', reglas: '', permiteVenta: true }, misionNombre: 'ATENCION', catalogoModo: 'products', pagoPorEmpresa: false });
t('sin cuentas por empresa, sigue el texto general (sin regresión)', JSON.stringify(system2).includes('999-999'));

console.log('\n4 · Entrenamiento con datos de pago');
const kb = {
  'cuenta bancolombia': { patrones: ['cuenta', 'donde pago'], respuesta: 'Puedes consignar a Bancolombia ahorros 222-222' },
  'horario': { patrones: ['horario'], respuesta: 'Lunes a viernes de 8 a 5' },
  'pago': { patrones: ['como pago'], respuesta: 'Cuenta 12345678 a nombre de la empresa' },
  'garantia': { patrones: ['garantia'], respuesta: 'La recarga tiene un año; tenlo en cuenta al programar.' }
};
const f = E.filtrarRespuestasPago(kb);
t('se excluyen las entradas con cuentas', !f['cuenta bancolombia'] && !f['pago']);
t('se conservan las demás (horario, garantía)', !!f['horario'] && !!f['garantia']);

console.log('\n5 · Mensajes salientes (cobranza y venta)');
const perfil = { mediosPago: 'CUENTA GENERAL 999-999' };
t('órdenes de la empresa con IVA → cuenta 111-111', E.mediosPagoSalida(empresas, ['empIva', 'empIva'], perfil).includes('111-111'));
t('órdenes de la empresa sin IVA → cuenta 222-222', E.mediosPagoSalida(empresas, ['empSin'], perfil).includes('222-222'));
t('órdenes de las dos empresas → no se manda ninguna', E.mediosPagoSalida(empresas, ['empIva', 'empSin'], perfil) === '');
t('orden sin empresa → no se manda ninguna', E.mediosPagoSalida(empresas, [''], perfil) === '');
t('nada configurado por empresa → texto general, como antes', E.mediosPagoSalida([{ id: 'a', mediosPago: '' }], ['a'], perfil) === 'CUENTA GENERAL 999-999');

console.log('\n6 · Elección del cliente nuevo');
t('id válido se acepta (con o sin corchetes)', E.validarEleccion('[empIva]', ctxNuevo.opciones)?.id === 'empIva' && E.validarEleccion('empSin', ctxNuevo.opciones)?.id === 'empSin');
t('id inventado se descarta', E.validarEleccion('otraEmpresa', ctxNuevo.opciones) === null && E.validarEleccion(null, ctxNuevo.opciones) === null);

console.log(`\n${ok} verdes · ${mal} rojos\n`);
process.exit(mal ? 1 : 0);
