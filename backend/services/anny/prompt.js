// ============================================================
// Control360 — Anny · MOTOR v3 · prompt.js
// Ubicación: backend/services/anny/prompt.js
// ============================================================
// ANNY-V3-PROMPT: prompt en capas + historial como turnos reales.
//
//   system[0]  MOTOR   — principios genéricos (estable, cacheable)
//   system[1]  NICHO + TENANT + MISIÓN — estable por tenant 5 min
//              (cache_control: ephemeral → se paga una vez)
//   messages   historial user/assistant REAL + último mensaje del
//              cliente con un bloque corto de CONTEXTO DEL SISTEMA
//              (etapa, dato que falta, precios servidos, ficha).
//
// El modelo devuelve su decisión por TOOL USE (esquema fijo), no
// por JSON libre: no hay parseo frágil ni "```json".
// ============================================================

const { describirHorario } = require('./horario');

// ============================================================
// Capa MOTOR — principios positivos, sin datos de ninguna empresa.
// 12 principios en vez de 50 prohibiciones: un modelo pequeño
// imita ejemplos y sigue principios; las negaciones lo confunden.
// ============================================================
const MOTOR = `Eres una asesora comercial que atiende por WhatsApp en nombre de una empresa. Escribes como una persona con criterio y poco tiempo: clara, cálida y directa.

CÓMO ESCRIBES
1. Un mensaje corto de WhatsApp: prosa, sin listas ni títulos, máximo el largo indicado.
2. Empiezas por la respuesta, nunca por una cortesía ("Perfecto", "Claro que sí", "Entendido").
3. Una idea principal y como máximo UNA pregunta por mensaje. La pregunta es la que hace avanzar la conversación, no una de cortesía.
4. Cada mensaje aporta algo nuevo: un dato, un precio, una propuesta o el siguiente paso. Lo que ya dijiste en la conversación no se repite ni se resume.
5. No saludas de nuevo en una conversación en curso. Te presentas solo cuando el sistema te lo indique.
6. Si el cliente no sabe algo técnico, tú propones lo más probable y pides confirmar; no lo interrogas.

QUÉ PUEDES AFIRMAR
7. Precios: solo los que aparecen en el catálogo servido en este mensaje, textuales. Sin precio en el catálogo no hay cifra.
8. Estados de pedidos, órdenes, citas y pagos: solo lo que el sistema muestra. No afirmas que algo está listo, en camino, aplicado o confirmado si no lo ves.
9. No prometes acciones futuras tuyas ("déjame revisar", "ya te confirmo"): lo que sabes lo dices ahora; lo que no, lo admites.
10. La base de conocimiento de la empresa es la fuente de verdad para horarios, dirección, medios de pago y políticas: respondes desde ella sin cambiarle datos.

CUÁNDO ESCALAR A UNA PERSONA (solo estos casos)
11. Pide hablar con alguien; pide descuento o negocia el valor; se queja de un servicio; quiere cambiar la fecha de un servicio ya agendado; pregunta por facturación legal; confirma que quiere un producto del que no tienes precio; o lleva dos intentos sin dar un dato mínimo. Consultar cómo pagar, el estado de una orden visible, o una duda general NO se escala: se responde.
12. Al escalar, la razón es UNA línea concreta (máximo 100 caracteres) que un asesor entienda de un vistazo.

Usa la herramienta "responder" en cada turno. Extrae en "extraidos" únicamente lo que el cliente dijo de forma explícita en su último mensaje.`;

// ============================================================
// Capa NICHO + TENANT + MISIÓN
// ============================================================
function capaTenant({ perfil, nicho, mision, misionNombre, catalogoModo }) {
  const t = perfil.tono || {};
  const tono = [
    t.tratamiento === 'usted' ? 'Tratas al cliente de USTED.' : 'Tuteas al cliente.',
    t.emojis ? 'Puedes usar un emoji ocasional, máximo uno por mensaje.' : 'No usas emojis.',
    t.calidez === 'cercana' ? 'Tono cercano y cálido.' : 'Tono directo y profesional.'
  ].join(' ');

  const ejemplos = (nicho.ejemplos || []).map((dialogo, i) =>
    `Ejemplo ${i + 1}:\n` + dialogo.map(([rol, txt]) =>
      `${rol === 'cliente' ? 'Cliente' : perfil.nombreAgente}: ${txt.replace(/\{agente\}/g, perfil.nombreAgente).replace(/\{empresa\}/g, perfil.empresa).replace(/\{precio\}/g, '$[precio del catálogo]')}`
    ).join('\n')
  ).join('\n\n');

  const ventaTxt = mision.permiteVenta
    ? 'En esta conversación atiendes y vendes: primero resuelves lo que pregunta, luego avanzas hacia el cierre.'
    : (mision.ventaReactiva
      ? 'Viniste a un trámite puntual. No ofreces productos por iniciativa propia; si el cliente pide comprar o cotizar, lo atiendes con el catálogo y luego retomas el trámite.'
      : 'Viniste a un trámite puntual y te limitas a él. No ofreces productos, no citas precios, no abres pedidos. Si el cliente quiere comprar algo, dile que con gusto lo atienden apenas cierren este tema y escala con tipo VENTA.');

  return `IDENTIDAD
Eres ${perfil.nombreAgente}, asesora de ${perfil.empresa}, empresa de ${perfil.vertical}.
Qué ofrece la empresa: ${perfil.queVende}.
${tono}
Horario de atención de la empresa: ${describirHorario(perfil.horarioAtencion)}.
${perfil.mediosPago ? `Medios de pago: ${perfil.mediosPago}.` : ''}

REGLAS DEL NEGOCIO (criterio de oficio de esta empresa)
${perfil.reglasNegocio || '(sin reglas adicionales)'}
${nicho.conocimientoBase ? `\nCriterio técnico: ${nicho.conocimientoBase}` : ''}

MISIÓN DE ESTA CONVERSACIÓN: ${misionNombre}
Objetivo: ${mision.objetivo}
${ventaTxt}
Reglas de la misión: ${mision.reglas}
${catalogoModo === 'sin_catalogo' ? 'Esta empresa no maneja catálogo de productos físicos: no inventes productos ni precios.' : ''}

ASÍ SUENA UNA BUENA CONVERSACIÓN EN ESTE NEGOCIO
${ejemplos || '(sin ejemplos)'}`;
}

// ============================================================
// Bloque de contexto del sistema (va en el ÚLTIMO mensaje user)
// ============================================================
function bloqueContexto({ instruccion, maxChars, fichaCliente, estadoPedido, ordenes, seleccion, estado, defectoPendiente, imagen, cartera, contacto, conocimiento }) {
  const L = [];
  L.push(`[CONTEXTO DEL SISTEMA — esto NO lo escribió el cliente]`);
  L.push(`Largo máximo de tu respuesta: ${maxChars} caracteres.`);
  if (instruccion) L.push(instruccion);

  // Quién escribe
  if (contacto?.nombre || contacto?.empresa) {
    L.push(`Hablas con ${contacto.nombre || 'una persona'}${contacto.empresa ? ` de ${contacto.empresa}` : ''}. No vuelvas a preguntarlo.`);
  }

  // Ficha
  if (fichaCliente && fichaCliente.existe) {
    const f = fichaCliente;
    let ficha = `Cliente registrado: ${f.nombre || '(sin nombre)'}${f.nit ? `, ${f.tipoDocumento || 'NIT'} ${f.nit}` : ''}${f.direccion ? `, dirección ${f.direccion}${f.ciudad ? ', ' + f.ciudad : ''}` : ''}. Usa estos datos, no los pidas.`;
    if ((f.sucursales || []).length > 1) ficha += ` Tiene ${f.sucursales.length} sedes: ${f.sucursales.map(s => s.nombre).join(' | ')} → pregunta a cuál.`;
    const v = f.vencimientos;
    if (v && v.total > 0) {
      ficha += ` Equipos registrados pendientes de recarga: ${v.total}${v.vencidos ? ` (${v.vencidos} ya vencidos)` : ''}${v.proximos ? ` (${v.proximos} vencen este mes)` : ''}.`;
      if (v.detalle.length) ficha += ` Detalle: ${v.detalle.slice(0, 6).map(e => `${e.cantidad}x ${e.equipo} vence ${e.fecha}`).join('; ')}.`;
    }
    L.push(ficha);
  } else {
    L.push('Cliente no registrado en el sistema.');
  }

  if (cartera && cartera.saldo > 0) {
    L.push(`Cartera (dato interno): $${Math.round(cartera.saldo).toLocaleString('es-CO')} pendientes en ${cartera.facturas} orden(es). Si pregunta cómo pagar, responde con los medios de pago. Si discute el valor, escala.`);
  }

  // Pedido y órdenes
  if (estadoPedido && estadoPedido.existe) {
    L.push(`Pedido tomado por ti: #${estadoPedido.id} estado ${estadoPedido.estado}, ${estadoPedido.producto || ''} ${estadoPedido.total || ''}${estadoPedido.datosPendientes.length ? `, pendientes: ${estadoPedido.datosPendientes.join(', ')}` : ''}. No lo resumas de nuevo.`);
  }
  if (ordenes && ordenes.length) {
    L.push('Órdenes de servicio en el sistema: ' + ordenes.map(o => {
      const cita = o.fechaProgramada ? `agendada ${o.fechaProgramada}${o.horaProgramada ? ` ${o.horaProgramada}` : ' (hora la confirma el mensajero)'}` : 'sin fecha';
      return `orden ${o.numero} ${o.estado}, ${cita}, total $${o.total.toLocaleString('es-CO')}${o.saldo > 0 ? `, saldo $${o.saldo.toLocaleString('es-CO')}` : ''}`;
    }).join(' · ') + '. Si pregunta por su cita u orden, responde con esto.');
  }

  // Precios
  if (seleccion) {
    if (seleccion.modo === 'diccionario') {
      L.push('PRECIO YA RESUELTO por las palabras del cliente (catálogo vigente): ' + seleccion.productos.map(p => `"${p.coincidio}" → ${p.nombre}: $${p.precio.toLocaleString('es-CO')}`).join(' · ') + '. Dalo directo, sin pedir especificaciones antes.');
    } else if (seleccion.modo === 'filtrado') {
      L.push(`CATÁLOGO RELEVANTE${seleccion.familia ? ` (familia: ${seleccion.familia})` : ''}:\n` + seleccion.productos.map(p => `- ${p.categoria ? `[${p.categoria}] ` : ''}${p.nombre}: $${p.precio.toLocaleString('es-CO')}`).join('\n'));
    }
  }

  // Base de conocimiento relevante (la escribió la dueña del negocio)
  if (conocimiento && conocimiento.length) {
    L.push('BASE DE CONOCIMIENTO DE LA EMPRESA (fuente de verdad, responde desde aquí sin cambiar datos):\n' + conocimiento.map(c => `- ${c.key}: ${c.respuesta}`).join('\n'));
  }

  // Slots ya capturados (para que no los vuelva a pedir)
  const s = estado?.slots || {};
  const capturados = [];
  if (s.items?.length) capturados.push(`items: ${s.items.map(i => `${i.cantidad}x ${i.nombre}${i.precio ? ` $${i.precio.toLocaleString('es-CO')}` : ''}`).join(', ')}`);
  for (const k of ['necesidad', 'direccion', 'barrio', 'sucursal', 'fecha', 'cedulaNit', 'correo']) if (s[k]) capturados.push(`${k}: ${s[k]}`);
  if (capturados.length) L.push('Ya sabes (no lo pidas de nuevo): ' + capturados.join(' | '));

  // Taller
  if (defectoPendiente) {
    L.push(`Autorización de reparación pendiente (orden ${defectoPendiente.numeroOrden}): se le informó "${defectoPendiente.descripcion}" por $${Math.round(defectoPendiente.costoReparacion).toLocaleString('es-CO')}. Clasifica su respuesta en respuestaTaller: APROBADO solo si autoriza inequívocamente, RECHAZADO solo si niega inequívocamente, null en cualquier otro caso. Tú no autorizas: el taller confirma.`);
  }

  // Imagen
  if (imagen) {
    L.push('El cliente envió una foto (arriba). Si es un comprobante de pago, llena comprobantePago y deja respuesta vacía. Si tiene que ver con el negocio, di qué identificas y pide confirmar antes de usarlo. Si no tiene que ver con el negocio (publicidad, meme, saludo), agradece en una frase y no escales.');
  }

  L.push('Si el cliente afirma que ya pagó (con o sin foto), llena comprobantePago con lo que tengas y deja respuesta vacía: el sistema redacta el acuse. Nunca digas que un pago quedó aplicado.');
  return L.join('\n');
}

// ============================================================
// Historial → mensajes user/assistant (alternados, primero user)
// ============================================================
function construirMensajes({ historial, mensajeTexto, contextoTxt, imagenAdjunta }) {
  const msgs = [];
  const push = (role, text) => {
    if (!text) return;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) { last.content += '\n' + text; return; }
    msgs.push({ role, content: text });
  };

  for (const t of historial || []) {
    if (t.rol === 'cliente') push('user', String(t.texto).slice(0, 600));
    else if (t.rol === 'admin') push('assistant', `[mensaje escrito por una persona del equipo] ${String(t.texto).slice(0, 600)}`);
    else if (t.rol === 'sistema') push('assistant', `[aviso automático enviado] ${String(t.texto).slice(0, 600)}`);
    else push('assistant', String(t.texto).slice(0, 600));
  }
  if (msgs.length && msgs[0].role === 'assistant') msgs.unshift({ role: 'user', content: '[inicio de la conversación]' });

  const textoFinal = `${contextoTxt}\n\n[MENSAJE DEL CLIENTE]\n${mensajeTexto}`;
  const last = msgs[msgs.length - 1];
  // Si el último turno del historial ya era del cliente (mensaje pendiente
  // sin respuesta), se agrega el nuevo como continuación.
  if (last && last.role === 'user') msgs.pop();
  const prev = last && last.role === 'user' ? last.content + '\n' : '';

  const content = imagenAdjunta
    ? [
        { type: 'image', source: { type: 'base64', media_type: imagenAdjunta.media_type, data: imagenAdjunta.data } },
        { type: 'text', text: prev + textoFinal }
      ]
    : prev + textoFinal;
  msgs.push({ role: 'user', content });
  return msgs;
}

// ============================================================
// Herramienta de salida estructurada
// ============================================================
const TOOL_RESPONDER = {
  name: 'responder',
  description: 'Entrega tu respuesta al cliente y lo que extrajiste de su mensaje.',
  input_schema: {
    type: 'object',
    properties: {
      respuesta: { type: 'string', description: 'Texto para el cliente. Vacío si comprobantePago no es null.' },
      extraidos: {
        type: 'object',
        description: 'Solo lo dicho explícitamente por el cliente en su último mensaje. Omite lo que no dijo.',
        properties: {
          contactoNombre: { type: 'string' },
          contactoEmpresa: { type: 'string' },
          necesidad: { type: 'string', description: 'qué necesita, en pocas palabras' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nombre: { type: 'string', description: 'nombre EXACTO del producto del catálogo servido' },
                cantidad: { type: 'integer' },
                productoId: { type: 'string' }
              },
              required: ['nombre']
            }
          },
          direccion: { type: 'string' },
          barrio: { type: 'string' },
          sucursal: { type: 'string' },
          fecha: { type: 'string' },
          cedulaNit: { type: 'string' },
          correo: { type: 'string' }
        }
      },
      clienteConfirma: { type: 'boolean', description: 'true solo si el cliente aceptó la cotización o dijo que sí al pedido' },
      cambioDeTema: { type: 'boolean', description: 'true si el cliente quiere algo distinto a lo que se venía tratando' },
      escalar: {
        type: ['object', 'null'],
        properties: {
          tipo: { type: 'string', enum: ['PRECIO', 'SERVICIO', 'DATOS', 'NEGOCIACION', 'CAPACITACION', 'PROBLEMA', 'VENTA', 'HUMANO', 'FACTURACION', 'OTRO'] },
          razon: { type: 'string', description: 'una línea, máximo 100 caracteres' }
        },
        required: ['tipo', 'razon']
      },
      comprobantePago: {
        type: ['object', 'null'],
        properties: {
          monto: { type: ['string', 'null'] },
          fecha: { type: ['string', 'null'] },
          banco: { type: ['string', 'null'] },
          referencia: { type: ['string', 'null'] }
        }
      },
      respuestaTaller: { type: ['string', 'null'], description: 'Solo si hay autorización de taller pendiente: "APROBADO", "RECHAZADO" o null' }
    },
    required: ['respuesta', 'extraidos', 'clienteConfirma', 'cambioDeTema', 'escalar', 'comprobantePago']
  }
};

function construirSystem({ perfil, nicho, mision, misionNombre, catalogoModo }) {
  return [
    { type: 'text', text: MOTOR },
    { type: 'text', text: capaTenant({ perfil, nicho, mision, misionNombre, catalogoModo }), cache_control: { type: 'ephemeral' } }
  ];
}

module.exports = { MOTOR, construirSystem, bloqueContexto, construirMensajes, TOOL_RESPONDER };
