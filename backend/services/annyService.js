// ============================================================
// Control360 — Servicio WhatsApp IA Anny  (MOTOR v3 — fachada)
// Ubicación: backend/services/annyService.js
// ============================================================
// ANNY-V3: el motor monolítico de 2.700 líneas se reemplaza por
// módulos en backend/services/anny/. Este archivo conserva EL
// MISMO module.exports que v23, así que routes/anny.js,
// annyNotificaciones.js, baileysService.js y server.js siguen
// funcionando sin cambios de contrato.
//
//   anny/config.js        perfil · nichos · misiones · cachés
//   anny/horario.js       compromiso de respuesta con horario del tenant
//   anny/texto.js         saneador · pide humano · intención · similitud
//   anny/conocimiento.js  catálogo · diccionario · selección por relevancia
//   anny/contexto.js      ficha · vencimientos · cartera · órdenes · pedido
//   anny/chats.js         historial · resumen · estado · pausas · casos
//   anny/etapas.js        máquina de etapas + slots
//   anny/prompt.js        system en capas + turnos reales + tool_use
//   anny/modelo.js        llamada a Claude (caché) · sugerencias KB
//   anny/motor.js         procesarMensajeEntrante
//   anny/cola.js          cola por chat + agrupación de ráfagas
//
// Correcciones de fondo que trae v3 (ver doc ANNY-CONV-002):
//   ANNY-RAFAGA-058  cola por chat: fin de respuestas duplicadas
//   ANNY-LID-055     número real en vez de LID (en baileysService)
//   ANNY-HORARIO     horario por tenant (antes quemado en código)
//   ANNY-COTIZA-056  diccionario primero, catálogo filtrado
//   ANNY-ETAPAS      el sistema lleva la conversación
//   ANNY-PROMPT-V3   12 principios + ejemplos; historial real; caché
//   ANNY-AVISO-057   razón de escalado en una línea
// ============================================================

const config = require('./anny/config');
const horario = require('./anny/horario');
const texto = require('./anny/texto');
const conocimiento = require('./anny/conocimiento');
const contexto = require('./anny/contexto');
const chats = require('./anny/chats');
const modelo = require('./anny/modelo');
const motor = require('./anny/motor');
const cola = require('./anny/cola');

// Compatibilidad: RESPUESTAS_BASE ya no contiene datos; el criterio
// técnico del nicho vive en NICHOS[nicho].conocimientoBase.
const RESPUESTAS_BASE = {};

async function sugerirRespuestaEntrenamiento(adminId, entrada) {
  const perfil = await config.obtenerPerfilTenant(adminId);
  return modelo.sugerirRespuestaEntrenamiento(perfil, entrada);
}

module.exports = {
  // motor
  procesarMensajeEntrante: motor.procesarMensajeEntrante,
  cola,

  // config / perfil
  obtenerConfig: config.obtenerConfig,
  actualizarConfig: config.actualizarConfig,
  tenantTieneAnnyActiva: config.tenantTieneAnnyActiva,
  obtenerPerfilTenant: config.obtenerPerfilTenant,
  actualizarPerfilTenant: config.actualizarPerfilTenant,
  invalidarCachePerfil: config.invalidarCachePerfil,
  obtenerRespuestasTenant: config.obtenerRespuestasTenant,
  invalidarCacheRespuestas: config.invalidarCacheRespuestas,
  MISIONES: config.MISIONES,
  PERFIL_DEFAULT: config.PERFIL_DEFAULT,
  NICHOS: config.NICHOS,
  MODELOS: config.MODELOS,
  RESPUESTAS_BASE,

  // chats / estado
  registrarConversacion: chats.registrarConversacion,
  registrarCasoEscalado: chats.registrarCasoEscalado,
  registrarPedido: chats.registrarPedido,
  obtenerHistorialReciente: chats.obtenerHistorialReciente,
  listarChats: chats.listarChats,
  obtenerMisionActiva: chats.obtenerMisionActiva,
  obtenerContactoChat: chats.obtenerContactoChat,
  guardarContactoChat: chats.guardarContactoChat,
  guardarLidChat: chats.guardarLidChat,
  buscarTelefonoPorLid: chats.buscarTelefonoPorLid,
  pausarAnny: chats.pausarAnny,
  annyEstaPausada: chats.annyEstaPausada,
  reactivarAnny: chats.reactivarAnny,
  obtenerMetricasHoy: chats.obtenerMetricasHoy,

  // contexto
  buscarClienteEnBD: contexto.buscarClienteEnBD,
  obtenerOrdenesServicio: contexto.obtenerOrdenesServicio,
  obtenerEstadoPedidoHilo: contexto.obtenerEstadoPedidoHilo,
  registrarPagoReportado: contexto.registrarPagoReportado,

  // conocimiento
  obtenerCatalogoProductos: conocimiento.obtenerCatalogoProductos,
  invalidarCacheCatalogo: conocimiento.invalidarCacheCatalogo,
  obtenerDiccionarioTenant: conocimiento.obtenerDiccionarioTenant,
  invalidarCacheDiccionario: conocimiento.invalidarCacheDiccionario,
  resolverPorPalabrasClave: conocimiento.resolverPorPalabrasClave,
  seleccionarCatalogo: conocimiento.seleccionarCatalogo,

  // texto / utilidades
  compromisoDeRespuesta: horario.compromisoDeRespuesta,
  recortarRespuesta: texto.recortarRespuesta,
  pidePersonaHumana: texto.pidePersonaHumana,
  buscarRespuestaConfigura: texto.buscarRespuestaConfigura,

  // modelo
  sugerirRespuestaEntrenamiento
};
// FIN annyService.js (v3)
