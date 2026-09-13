// ============================================================
// Control360 — Anny · MOTOR v3 · etapas.js
// Ubicación: backend/services/anny/etapas.js
// ============================================================
// ANNY-V3-ETAPAS: máquina de etapas + slots. EL SISTEMA lleva la
// conversación; el modelo solo redacta el siguiente mensaje.
//
// Etapas (misiones con venta):
//   INICIO → NECESIDAD → COTIZACION → CIERRE → CONFIRMADO → POSTVENTA
// Misiones sin etapas (COBRANZA, TALLER, SAAS, CONFIRMACION): TRAMITE
//
// Slots (genéricos; el nicho decide cuáles son mínimos):
//   contactoNombre, contactoEmpresa, necesidad, items[], direccion,
//   barrio, sucursal, fecha, cedulaNit, correo
//
// preguntasHechas[slot] cuenta cuántas veces el motor mandó pedir
// ese dato. Regla: un mínimo se pide máximo 2 veces (la 2ª
// reformulada); un opcional 1 vez. Agotado → se cierra con el dato
// pendiente (opcional) o se escala DATOS (mínimo bloqueante).
// Esto reemplaza la "regla anti-loro" del prompt por aritmética.
// ============================================================

const ETAPAS = ['INICIO', 'NECESIDAD', 'COTIZACION', 'CIERRE', 'CONFIRMADO', 'POSTVENTA', 'TRAMITE'];

const SLOTS = {
  contactoNombre: { etiqueta: 'nombre de la persona con quien hablas', comoPedir: 'pregunta con quién tienes el gusto' },
  contactoEmpresa: { etiqueta: 'empresa que representa', comoPedir: 'pregunta de qué empresa escribe (solo si es un negocio)' },
  items: { etiqueta: 'qué producto o servicio necesita y cuántos', comoPedir: 'pregunta qué necesita y para cuántos equipos o unidades' },
  direccion: { etiqueta: 'dirección de entrega o recogida', comoPedir: 'pregunta a qué dirección' },
  barrio: { etiqueta: 'barrio', comoPedir: 'pregunta el barrio' },
  sucursal: { etiqueta: 'sede a la que se envía el servicio', comoPedir: 'pregunta a cuál de sus sedes' },
  fecha: { etiqueta: 'fecha o franja para el servicio', comoPedir: 'pregunta qué día le sirve' },
  cedulaNit: { etiqueta: 'cédula o NIT para la factura', comoPedir: 'pide cédula o NIT para la factura' },
  correo: { etiqueta: 'correo para enviar la factura', comoPedir: 'pide el correo para la factura' }
};

const LIMITE_MINIMO = 2;
const LIMITE_OPCIONAL = 1;

// ------------------------------------------------------------
// Limpieza de un valor de slot que devolvió el modelo
// ------------------------------------------------------------
function limpiarValor(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.length > 200) return null;
  if (/^(null|undefined|n\/a|na|no|no se|nose|pendiente|desconocido|sin dato|-)$/i.test(s)) return null;
  return s;
}

function limpiarItems(items) {
  if (!Array.isArray(items)) return null;
  const out = items.map(it => {
    if (!it || typeof it !== 'object') return null;
    const nombre = limpiarValor(it.nombre);
    if (!nombre) return null;
    const cantidad = Math.max(1, Math.min(999, parseInt(it.cantidad, 10) || 1));
    const precio = Number(String(it.precio || '').replace(/[^\d]/g, '')) || null;
    return { nombre, cantidad, precio, productoId: limpiarValor(it.productoId) };
  }).filter(Boolean).slice(0, 10);
  return out.length ? out : null;
}

// ------------------------------------------------------------
// mezclarSlots: aplica lo que el modelo extrajo sobre el estado.
// Regla: un valor nuevo no vacío pisa al anterior (el cliente
// puede corregir su dirección); vacío nunca pisa.
// Los precios de items SOLO pueden venir del catálogo servido:
// si el modelo puso un precio que no existe en `permitidos`, se
// descarta (no se inventa una cifra).
// ------------------------------------------------------------
function mezclarSlots(estado, extraidos = {}, productosPermitidos = []) {
  const slots = { ...(estado.slots || {}) };
  const ex = extraidos || {};

  for (const k of ['contactoNombre', 'contactoEmpresa', 'necesidad', 'direccion', 'barrio', 'sucursal', 'fecha', 'cedulaNit', 'correo']) {
    const v = limpiarValor(ex[k]);
    if (v) slots[k] = v;
  }

  const items = limpiarItems(ex.items);
  if (items) {
    const porNombre = new Map(productosPermitidos.map(p => [String(p.nombre).toLowerCase(), p]));
    slots.items = items.map(it => {
      const prod = porNombre.get(it.nombre.toLowerCase())
        || productosPermitidos.find(p => it.productoId && p.id === it.productoId)
        || null;
      return {
        nombre: prod ? prod.nombre : it.nombre,
        cantidad: it.cantidad,
        precio: prod ? prod.precio : null,   // sin catálogo no hay precio
        productoId: prod ? prod.id : null
      };
    });
  }
  return slots;
}

function totalItems(items = []) {
  return items.reduce((s, it) => s + (it.precio ? it.precio * (it.cantidad || 1) : 0), 0);
}

function itemsConPrecio(items = []) {
  return items.length > 0 && items.every(it => it.precio > 0);
}

// ------------------------------------------------------------
// datoFaltante: el ÚNICO dato que toca pedir ahora.
// Devuelve { slot, tipo: 'minimo'|'opcional', agotado } o null.
// ------------------------------------------------------------
function datoFaltante(estado, nicho, fichaCliente, omitir = []) {
  const slots = estado.slots || {};
  const ph = estado.preguntasHechas || {};
  const minimos = nicho.slotsMinimos || ['items', 'contactoNombre', 'direccion'];
  const opcionales = nicho.slotsOpcionales || [];

  const tiene = (k) => {
    if (k === 'items') return Array.isArray(slots.items) && slots.items.length > 0;
    if (k === 'contactoNombre') return !!slots.contactoNombre || !!(fichaCliente && fichaCliente.existe && fichaCliente.nombre);
    if (k === 'direccion') return !!slots.direccion || !!(fichaCliente && fichaCliente.existe && fichaCliente.direccion && (fichaCliente.sucursales || []).length <= 1);
    if (k === 'cedulaNit') return !!slots.cedulaNit || !!(fichaCliente && fichaCliente.existe && fichaCliente.nit);
    if (k === 'correo') return !!slots.correo || !!(fichaCliente && fichaCliente.existe && fichaCliente.correo);
    return !!slots[k];
  };

  // Cliente con varias sedes: se pide la SEDE en lugar de la dirección
  // (la dirección sale de la sede elegida).
  const conSedes = fichaCliente && fichaCliente.existe && (fichaCliente.sucursales || []).length > 1;
  const listaMinimos = conSedes
    ? minimos.map(k => (k === 'direccion' ? 'sucursal' : k)).filter((k, i, a) => a.indexOf(k) === i)
    : minimos;

  for (const k of listaMinimos) {
    if (tiene(k) || omitir.includes(k)) continue;
    return { slot: k, tipo: 'minimo', agotado: (ph[k] || 0) >= LIMITE_MINIMO, veces: ph[k] || 0 };
  }
  for (const k of opcionales) {
    if (tiene(k) || omitir.includes(k)) continue;
    if ((ph[k] || 0) >= LIMITE_OPCIONAL) continue; // ya se pidió: va como pendiente
    return { slot: k, tipo: 'opcional', agotado: false, veces: ph[k] || 0 };
  }
  return null;
}

function pendientesOpcionales(estado, nicho, fichaCliente) {
  const slots = estado.slots || {};
  return (nicho.slotsOpcionales || []).filter(k => {
    if (slots[k]) return false;
    if (k === 'cedulaNit' && fichaCliente?.existe && fichaCliente.nit) return false;
    if (k === 'correo' && fichaCliente?.existe && fichaCliente.correo) return false;
    return true;
  });
}

// ------------------------------------------------------------
// calcularEtapa: transición determinística a partir del estado
// ya mezclado y de las señales del modelo.
// señales: { clienteConfirma, cambioDeTema }
// ------------------------------------------------------------
function calcularEtapa(estado, mision, nicho, fichaCliente, senales = {}, estadoPedido = { existe: false }) {
  if (!mision.usaEtapas) return 'TRAMITE';
  const slots = estado.slots || {};
  const items = slots.items || [];
  const actual = estado.etapa || 'INICIO';

  // Pedido ya confirmado hace poco y el cliente sigue hablando de él
  if (actual === 'CONFIRMADO' || actual === 'POSTVENTA') {
    if (senales.cambioDeTema) return 'NECESIDAD';
    const reciente = estadoPedido.existe && estadoPedido.abierto;
    return reciente ? 'POSTVENTA' : 'NECESIDAD';
  }

  if (!items.length) return 'NECESIDAD';
  if (!itemsConPrecio(items)) return 'NECESIDAD'; // sin precio no se cotiza: hay que aclarar producto

  const confirmado = estado.clienteConfirmo || senales.clienteConfirma === true;
  if (!confirmado) return 'COTIZACION';

  const falta = datoFaltante({ ...estado, slots }, nicho, fichaCliente);
  if (!falta || falta.tipo === 'opcional' || falta.agotado) return 'CIERRE_LISTO';
  return 'CIERRE';
}

// ------------------------------------------------------------
// Construye el pedido para pedidosAnny (mismo contrato que v2:
// el panel y el prellenado de orden lo leen tal cual).
// ------------------------------------------------------------
function construirPedido(estado, nicho, fichaCliente, telefono) {
  const s = estado.slots || {};
  const items = s.items || [];
  const total = totalItems(items);
  const pend = pendientesOpcionales(estado, nicho, fichaCliente);
  const nombre = s.contactoNombre || fichaCliente?.nombre || '';
  const sede = (fichaCliente?.sucursales || []).find(x => s.sucursal && x.nombre && x.nombre.toLowerCase() === String(s.sucursal).toLowerCase());
  const direccion = s.direccion || (sede && sede.direccion) || fichaCliente?.direccion || '';
  return {
    producto: items.map(it => `${it.cantidad}x ${it.nombre}`).join(', '),
    items: items.map(it => ({ nombre: it.nombre, cantidad: it.cantidad, precio: it.precio, productoId: it.productoId || null })),
    cantidad: items.reduce((n, it) => n + (it.cantidad || 1), 0),
    total: total ? `$${total.toLocaleString('es-CO')}` : 'por confirmar',
    totalNumero: total,
    nombreCliente: nombre,
    empresa: s.contactoEmpresa || fichaCliente?.empresaNombre || '',
    cedulaNit: s.cedulaNit || fichaCliente?.nit || 'PENDIENTE',
    correo: s.correo || fichaCliente?.correo || 'PENDIENTE',
    direccion,
    barrio: s.barrio || '',
    sucursal: s.sucursal || '',
    telefonoContacto: telefono,
    fecha: s.fecha || 'PENDIENTE',
    datosPendientes: pend,
    clienteId: fichaCliente?.existe ? fichaCliente.id : null,
    origen: 'anny_v3'
  };
}

// ------------------------------------------------------------
// Instrucción de etapa para el modelo (texto corto y concreto).
// ------------------------------------------------------------
function instruccionEtapa({ etapa, falta, estado, nicho, perfil, primerContacto, contactoConocido, seleccion }) {
  const partes = [];
  const s = estado.slots || {};

  if (primerContacto) {
    const pres = perfil.presentacion
      ? `Preséntate con esta frase (ajústala si hace falta): "${perfil.presentacion}".`
      : `Preséntate en una frase: "Hola, soy ${perfil.nombreAgente} de ${perfil.empresa}".`;
    partes.push(pres);
    if (perfil.identificarAlInicio && !contactoConocido) {
      partes.push('En el mismo mensaje, tras responder lo que preguntó, pregunta con quién tienes el gusto.');
    }
  }

  switch (etapa) {
    case 'NECESIDAD':
      if (seleccion?.modo === 'ambiguo') {
        partes.push('El cliente pregunta precio pero no está claro QUÉ producto exacto quiere. NO des cifras: haz UNA pregunta que lo aclare (ver reglas del negocio).');
      } else if (seleccion?.modo === 'ninguno' && (s.necesidad || s.items)) {
        partes.push('No tienes precio para lo que pide. No lo inventes: si ya confirmó qué quiere, escala con tipo PRECIO; si no, pregunta el detalle que falta.');
      } else {
        const sig = falta ? (SLOTS[falta.slot] || {}).etiqueta || falta.slot : null;
        partes.push(`Etapa NECESIDAD: entiende qué necesita. Si el catálogo de abajo trae el producto, dale el precio directo y pregunta cuántos son o pide confirmar el detalle. Una sola pregunta.${sig && sig !== SLOTS.items.etiqueta ? ` Si el cliente ya confirma que lo quiere, pide ${sig}.` : ''}`);
      }
      break;
    case 'COTIZACION': {
      const sig = falta ? (SLOTS[falta.slot] || {}).etiqueta || falta.slot : null;
      partes.push(`Etapa COTIZACIÓN: ya cotizaste ${(s.items || []).map(i => `${i.cantidad}x ${i.nombre}`).join(', ')}. No repitas el precio salvo que lo pida. Resuelve su duda y pregunta si avanzamos.${sig ? ` Si en este mensaje el cliente ACEPTA, no vuelvas a cotizar: pasa al cierre y pide ${sig}.` : ''}`);
      break;
    }
    case 'CIERRE':
      if (falta) {
        const def = SLOTS[falta.slot] || { etiqueta: falta.slot, comoPedir: `pide ${falta.slot}` };
        partes.push(`Etapa CIERRE: el cliente ya dijo que sí. Falta UN dato: ${def.etiqueta}. ${falta.veces > 0 ? 'Ya lo pediste una vez y no lo dio: pídelo de forma más simple y concreta, sin reprochar.' : def.comoPedir.charAt(0).toUpperCase() + def.comoPedir.slice(1) + '.'} Nada más en este mensaje.`);
      }
      break;
    case 'CIERRE_LISTO':
      partes.push('Etapa CIERRE: tienes todo lo necesario. Confirma el pedido en UNA frase con producto, cantidad y total, di cuál es el siguiente paso (recogida/entrega/pago según el negocio) y cierra con cordialidad. No pidas más datos.');
      break;
    case 'POSTVENTA':
      partes.push('El pedido ya está registrado. Resuelve la duda puntual sobre ese pedido; no abras otro ni vuelvas a resumirlo.');
      break;
    case 'TRAMITE':
      partes.push('Esta conversación es un trámite puntual (ver misión). Continúa ese hilo.');
      break;
    default:
      break;
  }
  return partes.join(' ');
}

module.exports = {
  ETAPAS,
  SLOTS,
  mezclarSlots,
  datoFaltante,
  pendientesOpcionales,
  calcularEtapa,
  construirPedido,
  instruccionEtapa,
  totalItems,
  itemsConPrecio
};
