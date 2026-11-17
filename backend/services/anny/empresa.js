// ============================================================
// Control360 — Anny · empresa que atiende a cada cliente
// Ubicación: backend/services/anny/empresa.js
// ✅ ANNY-EMPRESA-067 (2026-11-16)
// ------------------------------------------------------------
// REGLA: los datos duros los decide el sistema, no el modelo.
//
// Un suscriptor puede tener varias empresas (razones sociales) con
// IVA y cuentas de pago distintos. Antes Anny trabajaba a nivel de
// suscriptor: un solo texto de medios de pago y el precio del
// catálogo sin IVA. Resultado: daba la cuenta de la otra empresa y
// cotizaba un valor que después la orden subía al sumarle el IVA.
//
// Este módulo resuelve, ANTES de llamar al modelo:
//   · qué empresa atiende/factura a este cliente
//       ficha del cliente → última orden → respuesta guardada en el
//       chat → única empresa del suscriptor
//   · el IVA de esa empresa (el precio se entrega con IVA incluido)
//   · los medios de pago de ESA empresa (y solo esos)
//
// Datos nuevos en `companies` (aditivos, se digitan en Mi Empresa):
//   mediosPago    texto con las cuentas de esa empresa
//   annyCriterio  cuándo aplica esta empresa a un cliente NUEVO
//
// Sin esos datos el comportamiento es el de antes (sin regresión):
//   · ninguna empresa con mediosPago → se usa perfil.mediosPago
//   · menos de 2 empresas con annyCriterio → no se pregunta nada
// ============================================================

const { normalizar } = require('./texto');

const _cache = new Map(); // adminId → { data, exp }
const CACHE_MS = 5 * 60 * 1000;

async function obtenerEmpresasTenant(adminId) {
  if (!adminId) return [];
  const c = _cache.get(adminId);
  if (c && Date.now() < c.exp) return c.data;
  const data = [];
  try {
    const { db } = require('../../config/firebase');
    const snap = await db.collection('companies').where('user_id', '==', adminId).get();
    snap.forEach(d => {
      const e = d.data() || {};
      data.push({
        id: d.id,
        nombre: String(e.name || '').trim(),
        iva: Math.max(0, Number(e.iva) || 0),
        mediosPago: String(e.mediosPago || '').trim(),
        criterio: String(e.annyCriterio || '').trim()
      });
    });
  } catch (err) {
    console.error('[ANNY-EMPRESA-067] Error leyendo empresas:', err.message);
    return [];
  }
  _cache.set(adminId, { data, exp: Date.now() + CACHE_MS });
  return data;
}

function invalidarEmpresas(adminId) {
  if (adminId) _cache.delete(adminId); else _cache.clear();
}

// ------------------------------------------------------------
// resolverEmpresa → { modo, empresa, origen, opciones, pagoPorEmpresa }
//   modo 'resuelta'      se sabe la empresa
//        'por_definir'   cliente nuevo y hay criterio para preguntar
//        'sin_criterio'  no se sabe y no hay cómo preguntar
//        'sin_empresas'  el suscriptor no tiene empresas creadas
// ------------------------------------------------------------
function resolverEmpresa({ empresas, fichaCliente, ordenes, empresaIdChat } = {}) {
  const lista = (empresas || []).filter(e => e && e.id);
  if (!lista.length) return { modo: 'sin_empresas', empresa: null, origen: null, opciones: [], pagoPorEmpresa: false };

  const pagoPorEmpresa = lista.some(e => e.mediosPago);
  const porId = id => (id ? lista.find(e => e.id === id) || null : null);

  let empresa = porId(fichaCliente && fichaCliente.existe ? fichaCliente.empresaId : null);
  let origen = empresa ? 'cliente' : null;
  if (!empresa) {
    empresa = porId(((ordenes || []).find(o => o && o.empresaId) || {}).empresaId);
    if (empresa) origen = 'orden';
  }
  if (!empresa) {
    empresa = porId(empresaIdChat);
    if (empresa) origen = 'chat';
  }
  if (!empresa && lista.length === 1) { empresa = lista[0]; origen = 'unica'; }

  if (empresa) return { modo: 'resuelta', empresa, origen, opciones: [], pagoPorEmpresa };

  const conCriterio = lista.filter(e => e.criterio);
  if (conCriterio.length >= 2) return { modo: 'por_definir', empresa: null, origen: null, opciones: conCriterio, pagoPorEmpresa };
  return { modo: 'sin_criterio', empresa: null, origen: null, opciones: [], pagoPorEmpresa };
}

function factorIva(ctx) {
  return ctx && ctx.modo === 'resuelta' ? 1 + (Number(ctx.empresa.iva) || 0) / 100 : 1;
}

// El modelo devuelve el id de la opción; solo vale si es una de las servidas.
function validarEleccion(valor, opciones) {
  const v = String(valor || '').replace(/[\[\]\s]/g, '');
  if (!v) return null;
  return (opciones || []).find(e => e.id === v) || null;
}

// Bloque para el contexto del turno (lo lee el modelo).
function textoContexto(ctx) {
  if (!ctx) return '';
  if (ctx.modo === 'resuelta') {
    const e = ctx.empresa;
    const L = [`EMPRESA QUE ATIENDE Y FACTURA A ESTE CLIENTE: ${e.nombre}${e.iva > 0 ? ` (cobra IVA del ${e.iva}%)` : ' (no cobra IVA)'}.`];
    if (e.iva > 0) L.push('Todos los precios de este contexto YA incluyen el IVA: al dar un precio di "IVA incluido". No sumes ni restes IVA por tu cuenta.');
    if (ctx.pagoPorEmpresa) {
      L.push(e.mediosPago
        ? `MEDIOS DE PAGO DE ESTE CLIENTE (los únicos válidos; cópialos sin cambiar ni un dato): ${e.mediosPago}. No menciones ninguna otra cuenta, aunque aparezca más arriba en la conversación.`
        : 'Esta empresa no tiene medios de pago configurados: si pregunta cómo o a dónde pagar, no des ninguna cuenta y escala con tipo FACTURACION.');
    }
    return L.join(' ');
  }
  if (ctx.modo === 'por_definir') {
    return 'PRIORIDAD — todavía no se sabe cuál empresa atiende a este cliente. Opciones:\n'
      + ctx.opciones.map(e => `- [${e.id}] aplica cuando: ${e.criterio}`).join('\n')
      + '\nAntes de dar un precio o una cuenta de pago haz UNA sola pregunta, natural y corta, que permita saber cuál opción aplica (no nombres las empresas ni expliques por qué preguntas). Si el cliente ya lo dijo en la conversación, no preguntes: llena empresaCliente con el id que va entre corchetes.';
  }
  if (ctx.modo === 'sin_criterio' && ctx.pagoPorEmpresa) {
    return 'No se sabe cuál empresa factura a este cliente: si pregunta cómo o a dónde pagar, no des ninguna cuenta y escala con tipo FACTURACION.';
  }
  return '';
}

// ------------------------------------------------------------
// Entrenamiento con datos de pago: cuando las cuentas viven por
// empresa, una entrada vieja de Entrenamiento con "la cuenta" es
// justo lo que hacía responder la que no era. Se excluye.
// ------------------------------------------------------------
const RAICES_PAGO = ['nequi', 'daviplata', 'bancolombia', 'davivienda', 'ahorros', 'corriente', 'consign', 'transfer', 'medios de pago', 'medio de pago', 'numero de cuenta', 'cuenta bancaria', 'cuenta de ahorro'];

function esConocimientoDePago(key, c) {
  const bruto = `${key || ''} ${(c && Array.isArray(c.patrones) ? c.patrones.join(' ') : '')} ${(c && c.respuesta) || ''}`;
  const t = normalizar(bruto);
  if (RAICES_PAGO.some(r => t.includes(r))) return true;
  return /cuenta/.test(t) && /\d{6,}/.test(String(bruto).replace(/[\s.\-]/g, ''));
}

function filtrarRespuestasPago(respuestas) {
  const out = {};
  for (const [k, c] of Object.entries(respuestas || {})) {
    if (!esConocimientoDePago(k, c)) out[k] = c;
  }
  return out;
}

// ------------------------------------------------------------
// Medios de pago para los mensajes SALIENTES (cobranza, venta).
// Si las órdenes son de una sola empresa → sus cuentas. Si son de
// varias o no se sabe → no se manda ninguna (mejor nada que la
// equivocada): el cliente pregunta y se resuelve en la conversación.
// ------------------------------------------------------------
function mediosPagoSalida(empresas, empresaIds, perfil) {
  const lista = (empresas || []).filter(e => e && e.id);
  if (!lista.some(e => e.mediosPago)) return (perfil && perfil.mediosPago) || '';
  if (lista.length === 1) return lista[0].mediosPago;
  const ids = [...new Set((empresaIds || []).filter(Boolean))];
  if (ids.length !== 1) return '';
  const e = lista.find(x => x.id === ids[0]);
  return e ? e.mediosPago : '';
}

module.exports = {
  obtenerEmpresasTenant,
  invalidarEmpresas,
  resolverEmpresa,
  factorIva,
  validarEleccion,
  textoContexto,
  esConocimientoDePago,
  filtrarRespuestasPago,
  mediosPagoSalida
};
