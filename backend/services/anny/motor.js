// ============================================================
// Control360 — Anny · MOTOR v3 · motor.js
// Ubicación: backend/services/anny/motor.js
// ============================================================
// ANNY-V3-MOTOR: procesarMensajeEntrante — el flujo de un turno.
//
//   1. gate del módulo · pausa · medios fallidos · pide humano
//   2. carga de contexto en paralelo (una sola pasada)
//   3. atajo de base de conocimiento (conversación fría)
//   4. estado de conversación (etapa + slots) — el sistema decide
//      qué toca pedir; el modelo redacta
//   5. selección de contexto por relevancia (diccionario → catálogo
//      filtrado → nada) — ANNY-COTIZA-056
//   6. modelo (system cacheado + turnos reales + tool_use)
//   7. post-proceso determinístico: pago, escalado, slots, etapa,
//      pedido, contacto, calidad, registro
//
// CONTRATO DE SALIDA (igual a v2 + campos v3):
//   { procesado, tipo, accion, respuesta, caseId, notificarA,
//     avisoEscalamiento, avisoPago, imagenComprobante, pedido,
//     avisoTaller, notificarTallerA, telefonoCliente,
//     etapa, slots }   ← v3 (para el simulador)
// ============================================================

const { db } = require('../../config/firebase');
const tallerRespuestas = require('../tallerRespuestas');
const cfg = require('./config');
const { compromisoDeRespuesta } = require('./horario');
const texto = require('./texto');
const conocimiento = require('./conocimiento');
const contexto = require('./contexto');
const chats = require('./chats');
const etapas = require('./etapas');
const prompt = require('./prompt');
const modelo = require('./modelo');

const VENTANA_CONVERSACION_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------
// Estado al abrir un turno: si la conversación lleva >24 h sin
// actividad, el hilo comercial se reinicia (se conserva quién es
// el contacto). Un pedido confirmado ayer no sigue "en cierre" hoy.
// ------------------------------------------------------------
function estadoParaTurno(docChat, mision) {
  const e = { ...chats.ESTADO_VACIO(), ...(docChat.estado || {}) };
  const inactivo = docChat.ultimaFechaMs > 0 && (Date.now() - docChat.ultimaFechaMs) > VENTANA_CONVERSACION_MS;
  if (inactivo || !mision.usaEtapas) {
    return {
      etapa: mision.usaEtapas ? 'INICIO' : 'TRAMITE',
      slots: { contactoNombre: e.slots?.contactoNombre, contactoEmpresa: e.slots?.contactoEmpresa },
      preguntasHechas: {},
      clienteConfirmo: false,
      actualizadoMs: 0
    };
  }
  return e;
}

function decisionPreviaCambio(msg) {
  return /\b(otro|otra|cambiar|cambio|mejor el|mejor la|en vez de|tambien|también|agrega|agregar|adicional)\b/i.test(String(msg || ''));
}

function faltantesOrdenados(estado, nicho, ficha) {
  // Lista completa (mínimos + opcionales aún no agotados) en orden
  const out = [];
  for (let i = 0; i < 8; i++) {
    const f = etapas.datoFaltante(estado, nicho, ficha, out.map(x => x.slot));
    if (!f) break;
    out.push(f);
  }
  return out;
}

async function procesarMensajeEntrante(props) {
  const { adminId, telefono, nombreCliente, mensajeTexto, imagenAdjunta = null } = props;
  let misionNombre = props.mision || null;

  if (!adminId || !telefono || !mensajeTexto) {
    return { procesado: false, error: 'datos_incompletos' };
  }

  try {
    // ── 1. Gate y pausa ──────────────────────────────────────
    if (!(await cfg.tenantTieneAnnyActiva(adminId))) return { procesado: false, error: 'anny_inactivo' };

    if (await chats.annyEstaPausada(adminId, telefono)) {
      await chats.registrarConversacion(adminId, { telefono, nombreCliente: nombreCliente || telefono, mensajeCliente: mensajeTexto, respuestaAgente: null, respondidoPor: 'PAUSA_ADMIN', escalado: false, caseId: null });
      return { procesado: true, tipo: 'PAUSADA_POR_ADMIN', accion: null };
    }

    const perfil = await cfg.obtenerPerfilTenant(adminId);
    const nicho = cfg.obtenerNicho(perfil.nicho);

    // ── Medios que no se pudieron procesar (ANNY-AUDIO-054 / FOTO-031) ──
    const t0 = String(mensajeTexto).trim();
    if (/^\[el cliente envió una nota de voz/i.test(t0)) {
      const r = 'No logré escuchar tu nota de voz. ¿Me lo escribes en un mensaje? Así te respondo de una.';
      await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: r, respondidoPor: 'AGENTE_AUTOMATICO', tipo: 'AUDIO_NO_PROCESADO', escalado: false });
      return { procesado: true, tipo: 'AUDIO_NO_PROCESADO', accion: 'enviar_mensaje', respuesta: r };
    }
    if (!imagenAdjunta && /^\[el cliente envió una foto/i.test(t0)) {
      const r = 'No logré abrir la foto. ¿Me la reenvías o me escribes lo que necesitas? Así te ayudo de una vez.';
      await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: r, respondidoPor: 'AGENTE_AUTOMATICO', tipo: 'FOTO_NO_PROCESADA', escalado: false, caseId: null });
      return { procesado: true, tipo: 'FOTO_NO_PROCESADA', accion: 'enviar_mensaje', respuesta: r };
    }

    // ── Pide humano (determinístico, ANNY-HUMANO-012) ──
    if (texto.pidePersonaHumana(mensajeTexto)) {
      const caseId = await chats.registrarCasoEscalado(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, tipo: 'HUMANO', razon: 'El cliente pidió atención de una persona', prioridad: 'ALTA', asignadoA: adminId });
      const r = `Claro, ya le aviso a un asesor. ${compromisoDeRespuesta(perfil)}.`;
      await chats.pausarAnny(adminId, telefono, 60, 'cliente_pidio_asesor');
      await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: r, respondidoPor: 'ESCALADO_A_ADMIN', tipo: 'HUMANO', escalado: true, caseId });
      await chats.actualizarMetricas(adminId, 'casos_escalados');
      return {
        procesado: true, tipo: 'ESCALADO_HUMANO', accion: 'enviar_mensaje', respuesta: r, caseId,
        notificarA: perfil.notificarEscalamientoA,
        avisoEscalamiento: `🚨 CLIENTE PIDE ASESOR\n${nombreCliente || 'Sin nombre'} — ${telefono}\n"${String(mensajeTexto).slice(0, 120)}"\nAnny quedó pausada 60 min en este chat.`,
        telefonoCliente: telefono
      };
    }

    // ── 2. Contexto en paralelo ──────────────────────────────
    const [respuestas, historial, fichaCliente, catalogo, estadoPedido, defectoPendiente, docChat, ordenesServicio, diccionario] = await Promise.all([
      cfg.obtenerRespuestasTenant(adminId),
      chats.obtenerHistorialReciente(adminId, telefono),
      contexto.buscarClienteEnBD(adminId, telefono),
      perfil.fuentePrecios === 'products' ? conocimiento.obtenerCatalogoProductos(adminId) : Promise.resolve([]),
      contexto.obtenerEstadoPedidoHilo(adminId, telefono),
      tallerRespuestas.buscarDefectoPendiente(adminId, telefono).catch(() => null),
      chats.obtenerDocChat(adminId, telefono),
      contexto.obtenerOrdenesServicio(adminId, telefono).catch(() => []),
      conocimiento.obtenerDiccionarioTenant(adminId).catch(() => ({}))
    ]);

    if (!misionNombre) misionNombre = docChat.misionActiva;
    const mision = cfg.obtenerMision(misionNombre);
    const contactoChat = docChat.contacto;

    const ultimoTs = historial.length ? historial[historial.length - 1].ts : 0;
    const conversacionActiva = ultimoTs > 0 && (Date.now() - ultimoTs) < VENTANA_CONVERSACION_MS;
    const primerContacto = misionNombre === 'ATENCION' && !contactoChat.presentada && (historial.length === 0 || !conversacionActiva);

    // ── 3. Atajo de base de conocimiento (conversación fría) ──
    if (!conversacionActiva && misionNombre === 'ATENCION' && !imagenAdjunta && !primerContacto) {
      const rc = texto.buscarRespuestaConfigura(mensajeTexto, respuestas);
      if (rc.encontrada) {
        const r = texto.recortarRespuesta(rc.respuesta, mision.maxChars, perfil.tono?.emojis);
        await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: r, respondidoPor: 'AGENTE_AUTOMATICO', tipo: rc.tipo, escalado: false, caseId: null });
        await chats.actualizarMetricas(adminId, 'respuestas_automaticas');
        return { procesado: true, tipo: 'RESPUESTA_AUTOMATICA', accion: 'enviar_mensaje', respuesta: r };
      }
    }

    // ── 4. Estado de conversación ────────────────────────────
    let estado = estadoParaTurno(docChat, mision);
    if (contactoChat.nombre && !estado.slots.contactoNombre) estado.slots.contactoNombre = contactoChat.nombre;
    if (contactoChat.empresa && !estado.slots.contactoEmpresa) estado.slots.contactoEmpresa = contactoChat.empresa;

    // ── 5. Selección de conocimiento y catálogo ──────────────
    const resueltos = conocimiento.resolverPorPalabrasClave(mensajeTexto, diccionario, catalogo);
    const seleccion = (mision.permiteVenta || mision.ventaReactiva)
      ? conocimiento.seleccionarCatalogo({ mensajeTexto, resueltos, catalogo, familias: nicho.familiasIntencion, slots: estado.slots })
      : { productos: [], modo: 'sin_venta', familia: null };
    const kbRelevante = texto.conocimientoRelevante(mensajeTexto, respuestas);
    if (resueltos.length) console.log(`[ANNY-DICC] ${telefono}: "${resueltos[0].coincidio}" → ${resueltos[0].nombre} $${resueltos[0].precio}`);

    // Etapa ANTES del turno (para instruir al modelo)
    const etapaPrevia = estado.etapa === 'INICIO' && mision.usaEtapas ? 'NECESIDAD' : (mision.usaEtapas ? etapas.calcularEtapa(estado, mision, nicho, fichaCliente, {}, estadoPedido) : 'TRAMITE');
    const faltantes = mision.usaEtapas ? faltantesOrdenados(estado, nicho, fichaCliente).filter(f => !(f.slot === 'items' && etapaPrevia !== 'NECESIDAD')) : [];
    // Con precio ya dado y sin nueva pregunta de precio, el catálogo no hace falta (ahorra tokens y evita recotizar)
    if (['COTIZACION', 'CIERRE', 'CIERRE_LISTO', 'POSTVENTA'].includes(etapaPrevia) && !resueltos.length && !texto.preguntaPrecio(mensajeTexto) && !decisionPreviaCambio(mensajeTexto)) {
      seleccion.productos = []; seleccion.modo = 'no_necesario';
    }
    const instruccion = etapas.instruccionEtapa({
      etapa: etapaPrevia,
      falta: faltantes[0] || null,
      estado, nicho, perfil, primerContacto,
      contactoConocido: !!(estado.slots.contactoNombre || (fichaCliente.existe && fichaCliente.nombre)),
      seleccion
    }) + (faltantes.length > 1 ? ` Después de ese, en orden: ${faltantes.slice(1).map(f => (etapas.SLOTS[f.slot] || {}).etiqueta || f.slot).join(', ')}. Si el cliente acaba de dar el dato en este mensaje, no lo repitas: pide el siguiente.` : '');

    const maxChars = primerContacto ? Math.max(mision.maxChars, 320) : mision.maxChars;

    // ── 6. Modelo ────────────────────────────────────────────
    const system = prompt.construirSystem({
      perfil, nicho, mision, misionNombre,
      catalogoModo: perfil.fuentePrecios === 'products' ? 'products' : 'sin_catalogo'
    });
    const contextoTxt = prompt.bloqueContexto({
      instruccion, maxChars, fichaCliente, estadoPedido, ordenes: ordenesServicio, seleccion, estado, defectoPendiente,
      imagen: !!imagenAdjunta, cartera: fichaCliente.existe ? fichaCliente.saldoCxC : null, contacto: contactoChat, conocimiento: kbRelevante
    });
    const messages = prompt.construirMensajes({ historial, mensajeTexto, contextoTxt, imagenAdjunta });

    const decision = await modelo.decidir({ adminId, modelo: perfil.modelo, system, messages, conImagen: !!imagenAdjunta });

    // ── 7. Post-proceso ──────────────────────────────────────
    // 7a. Contacto
    chats.guardarContactoChat(adminId, telefono, {
      nombre: decision.extraidos?.contactoNombre,
      empresa: decision.extraidos?.contactoEmpresa,
      presentada: primerContacto
    }).catch(() => {});

    // 7b. Error del modelo → escalar honesto (nunca un "te respondemos pronto" sin dueño)
    if (decision._error) {
      const caseId = await chats.registrarCasoEscalado(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, tipo: 'ERROR', razon: 'Fallo técnico al generar respuesta', asignadoA: adminId });
      const r = `Tuve un problema para responderte en este momento. Un asesor te escribe: ${compromisoDeRespuesta(perfil).toLowerCase()}.`;
      await chats.pausarAnny(adminId, telefono, 30, 'error_modelo');
      await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: r, respondidoPor: 'ESCALADO_A_ADMIN', tipo: 'ERROR', escalado: true, caseId });
      await chats.actualizarMetricas(adminId, 'casos_escalados');
      return { procesado: true, tipo: 'CASO_ESCALADO', accion: 'enviar_mensaje', respuesta: r, caseId, notificarA: perfil.notificarEscalamientoA, avisoEscalamiento: `⚠️ ERROR TÉCNICO DE ANNY\n${nombreCliente || 'Sin nombre'} — ${telefono}\nNo se pudo generar respuesta. Atender manualmente.`, telefonoCliente: telefono };
    }

    // 7c. Pago reportado (ANNY-PAGO-050) — antes que cualquier escalado
    if (decision.comprobantePago) {
      const cp = decision.comprobantePago;
      const orden = await contexto.registrarPagoReportado(adminId, telefono, cp);
      const queLlego = imagenAdjunta ? 'tu comprobante' : 'tu aviso de pago';
      const r = orden
        ? `Recibí ${queLlego} y lo dejé asociado a la orden ${orden.numero}. Tesorería lo valida y te confirmamos. ¡Gracias!`
        : `Recibí ${queLlego} y ya lo pasé a tesorería para que lo validen. Apenas quede confirmado te avisamos. ¡Gracias!`;
      await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: r, respondidoPor: 'AGENTE_AUTOMATICO', tipo: 'PAGO', escalado: false });
      await chats.actualizarMetricas(adminId, 'respuestas_ia');
      const detalle = [cp.monto ? `Monto: ${cp.monto}` : null, cp.fecha ? `Fecha: ${cp.fecha}` : null, cp.banco ? `Medio: ${cp.banco}` : null, cp.referencia ? `Ref: ${cp.referencia}` : null].filter(Boolean).join(' · ')
        || (imagenAdjunta ? 'No se pudo leer el detalle — revisar la imagen' : 'Sin detalles — confirmar antes de abonar');
      return {
        procesado: true, tipo: 'COMPROBANTE_PAGO', accion: 'enviar_mensaje', respuesta: r,
        avisoPago: `💵 *${imagenAdjunta ? 'COMPROBANTE DE PAGO RECIBIDO' : 'EL CLIENTE AVISA QUE YA PAGÓ (sin soporte)'}*\n${nombreCliente || 'Sin nombre'} — ${telefono}\n${detalle}\n${orden ? `Orden ${orden.numero}${orden.saldo > 0 ? ` · saldo $${orden.saldo.toLocaleString('es-CO')}` : ''}` : '⚠️ Sin orden asociada — verificar'}\nPendiente de VALIDAR en Control360.`,
        imagenComprobante: imagenAdjunta,
        notificarA: perfil.notificarEscalamientoA,
        telefonoCliente: telefono
      };
    }

    // 7d. Escalado por criterio del modelo (ANNY-AVISO-057: razón corta)
    if (decision.escalar) {
      const razon = String(decision.escalar.razon || '').replace(/\s+/g, ' ').slice(0, 120);
      const caseId = await chats.registrarCasoEscalado(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, tipo: decision.escalar.tipo, razon, asignadoA: adminId });
      const r = `Este caso prefiero pasarlo a un asesor para no darte un dato equivocado. ${compromisoDeRespuesta(perfil)}.`;
      await chats.pausarAnny(adminId, telefono, 45, `escalado_${decision.escalar.tipo}`);
      await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: r, respondidoPor: 'ESCALADO_A_ADMIN', tipo: decision.escalar.tipo, escalado: true, caseId });
      await chats.actualizarMetricas(adminId, 'casos_escalados');
      await chats.guardarEstadoChat(adminId, telefono, { ...estado, slots: etapas.mezclarSlots(estado, decision.extraidos, seleccion.productos) });
      return {
        procesado: true, tipo: 'CASO_ESCALADO', accion: 'enviar_mensaje', respuesta: r, caseId,
        notificarA: perfil.notificarEscalamientoA,
        avisoEscalamiento: `⚠️ CASO ESCALADO (${decision.escalar.tipo})\n${nombreCliente || 'Sin nombre'} — ${telefono}\n${razon}`,
        telefonoCliente: telefono
      };
    }

    // 7e. Slots y etapa
    const slots = etapas.mezclarSlots(estado, decision.extraidos, seleccion.productos);
    const nuevoEstado = {
      ...estado,
      slots,
      clienteConfirmo: estado.clienteConfirmo || decision.clienteConfirma === true,
      preguntasHechas: { ...(estado.preguntasHechas || {}) }
    };
    if (decision.cambioDeTema && mision.usaEtapas) {
      nuevoEstado.clienteConfirmo = false;
      nuevoEstado.slots = { ...slots, items: undefined, necesidad: undefined };
      nuevoEstado.preguntasHechas = {};
    }
    // Contador: lo que se pidió y el cliente no dio
    if (faltantes[0]) {
      const k = faltantes[0].slot;
      const sigueFaltando = !etapas.datoFaltante(nuevoEstado, nicho, fichaCliente) ? false : etapas.datoFaltante(nuevoEstado, nicho, fichaCliente).slot === k;
      if (sigueFaltando) nuevoEstado.preguntasHechas[k] = (nuevoEstado.preguntasHechas[k] || 0) + 1;
    }
    if (primerContacto && perfil.identificarAlInicio && !nuevoEstado.slots.contactoNombre) {
      nuevoEstado.preguntasHechas.contactoNombre = (nuevoEstado.preguntasHechas.contactoNombre || 0) + 1;
    }

    let etapaFinal = etapas.calcularEtapa(nuevoEstado, mision, nicho, fichaCliente, { clienteConfirma: decision.clienteConfirma, cambioDeTema: decision.cambioDeTema }, estadoPedido);

    // Mínimo bloqueante agotado (2 intentos) → escalar DATOS
    const faltaAhora = etapas.datoFaltante(nuevoEstado, nicho, fichaCliente);
    // "Agotado" se mide sobre lo pedido ANTES de este turno: 1ª vez se pide,
    // 2ª vez se reformula, 3ª vez ya no se pregunta: se escala.
    const yaPedidas = faltaAhora ? ((estado.preguntasHechas || {})[faltaAhora.slot] || 0) : 0;
    if (mision.usaEtapas && nuevoEstado.clienteConfirmo && faltaAhora && faltaAhora.tipo === 'minimo' && yaPedidas >= 2 && faltaAhora.slot !== 'items') {
      const caseId = await chats.registrarCasoEscalado(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, tipo: 'DATOS', razon: `Cliente confirmó compra pero no da ${etapas.SLOTS[faltaAhora.slot]?.etiqueta || faltaAhora.slot}`, asignadoA: adminId });
      const r = `Para no demorarte más, un asesor te contacta y lo cierran de una. ${compromisoDeRespuesta(perfil)}.`;
      await chats.pausarAnny(adminId, telefono, 45, 'escalado_DATOS');
      await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: r, respondidoPor: 'ESCALADO_A_ADMIN', tipo: 'DATOS', escalado: true, caseId });
      await chats.actualizarMetricas(adminId, 'casos_escalados');
      await chats.guardarEstadoChat(adminId, telefono, { ...nuevoEstado, etapa: 'CIERRE' });
      return { procesado: true, tipo: 'CASO_ESCALADO', accion: 'enviar_mensaje', respuesta: r, caseId, notificarA: perfil.notificarEscalamientoA, avisoEscalamiento: `⚠️ CASO ESCALADO (DATOS)\n${nombreCliente || 'Sin nombre'} — ${telefono}\nConfirmó compra; faltan datos tras 2 intentos: ${faltaAhora.slot}`, telefonoCliente: telefono, etapa: 'CIERRE', slots: nuevoEstado.slots };
    }

    // 7f. Respuesta final
    let respuesta = texto.recortarRespuesta(decision.respuesta || '', maxChars, perfil.tono?.emojis);
    if (!respuesta) respuesta = '¿Me cuentas un poco más qué necesitas? Así te ayudo de una vez.';

    // 7g. Pedido: se registra cuando el cierre está listo
    let notificarA = null;
    let pedidoParaAviso = null;
    if (etapaFinal === 'CIERRE_LISTO' && mision.permitePedido) {
      const pedido = etapas.construirPedido(nuevoEstado, nicho, fichaCliente, telefono);
      const res = await chats.registrarPedido(adminId, telefono, pedido);
      if (res) {
        etapaFinal = 'CONFIRMADO';
        if (!res.esDuplicado) {
          await chats.actualizarMetricas(adminId, 'pedidos');
          pedidoParaAviso = pedido;
          try {
            const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
            notificarA = cfgDoc.exists ? (cfgDoc.data().notificarPedidosA || null) : null;
          } catch (e) { notificarA = null; }
          // Si el modelo no confirmó en texto, se confirma determinísticamente.
          const totalTxt = pedido.total.replace(/\./g, '');
          if (!respuesta.replace(/\./g, '').includes(totalTxt) && pedido.totalNumero > 0) {
            respuesta = texto.recortarRespuesta(`${respuesta} Te confirmo el pedido: ${pedido.producto}, total ${pedido.total}.`, maxChars + 80, perfil.tono?.emojis);
          }
        }
      }
    }
    nuevoEstado.etapa = etapaFinal;

    // 7h. Palabras clave sugeridas: cotizó por catálogo filtrado, no por diccionario
    if (seleccion.modo === 'filtrado' && slots.items?.length && texto.preguntaPrecio(mensajeTexto)) {
      conocimiento.sugerirPalabraClave(adminId, mensajeTexto, slots.items[0].nombre).catch(() => {});
    }

    // 7i. Taller
    let avisoTaller = null, telefonoAvisoTaller = null;
    if (decision.respuestaTaller && defectoPendiente) {
      const reg = await tallerRespuestas.registrarRespuestaCliente(adminId, telefono, decision.respuestaTaller, mensajeTexto);
      if (reg) {
        avisoTaller = `${reg.valor === 'APROBADO' ? '✅ EL CLIENTE APROBÓ' : '❌ EL CLIENTE NO APROBÓ'} EL CAMBIO DE REPUESTO\nOrden ${reg.numeroOrden} — ${reg.clienteNombre || nombreCliente || telefono}\n${reg.descripcion} · $${Math.round(reg.costoReparacion).toLocaleString('es-CO')}\nRespondió: "${String(mensajeTexto).slice(0, 120)}"\n\n⚠️ Falta confirmarlo en Taller para que se aplique.`;
        try {
          const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
          telefonoAvisoTaller = cfgDoc.exists ? (cfgDoc.data().notificarTallerA || cfgDoc.data().notificarEscalamientoA || null) : null;
        } catch (e) { telefonoAvisoTaller = null; }
      }
    }

    // 7j. Registro, calidad y estado
    await chats.registrarConversacion(adminId, { telefono, nombreCliente, mensajeCliente: mensajeTexto, respuestaAgente: respuesta, respondidoPor: 'AGENTE_IA', tipo: pedidoParaAviso ? 'PEDIDO' : 'RESPUESTA', escalado: false, etapa: etapaFinal });
    await chats.actualizarMetricas(adminId, 'respuestas_ia');
    chats.registrarCalidad(adminId, telefono, respuesta, historial).catch(() => {});
    await chats.guardarEstadoChat(adminId, telefono, nuevoEstado);

    return {
      procesado: true,
      tipo: pedidoParaAviso ? 'PEDIDO_CONFIRMADO' : 'RESPUESTA_IA',
      accion: 'enviar_mensaje',
      respuesta,
      pedido: pedidoParaAviso,
      notificarA,
      avisoTaller,
      notificarTallerA: telefonoAvisoTaller,
      telefonoCliente: telefono,
      etapa: etapaFinal,
      slots: nuevoEstado.slots,
      seleccion: { modo: seleccion.modo, familia: seleccion.familia, productos: (seleccion.productos || []).length }
    };
  } catch (err) {
    console.error('[ANNY] Error procesando mensaje:', err.message, err.stack);
    return { procesado: false, error: err.message };
  }
}

module.exports = { procesarMensajeEntrante };
