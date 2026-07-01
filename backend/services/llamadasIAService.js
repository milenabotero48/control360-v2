// ============================================================
// Control360 — Servicio de Llamadas IA (Lucy / Vapi)
// Ubicación: backend/services/llamadasIAService.js
// ------------------------------------------------------------
// EXTENSIÓN del motor de Vencimientos — mismo patrón que
// vencimientosService.js / el cron de WhatsApp. NO modifica
// ninguna colección existente (vencimientos, clients, orders).
//
// REGLAS DE NEGOCIO (validadas con Sandra, Jun 2026):
//
// 1. ACTIVACIÓN: 100% manual por Sandra, por tenant, en la
//    colección llamadas_ia_config (igual patrón que whatsapp_config).
//    Si no existe el doc o activo=false → ese tenant nunca entra al cron.
//
// 2. DISPARO: día 2 de cada mes (hora Colombia), para los
//    vencimientos del MES ACTUAL (no el siguiente — ese ya
//    recibió WhatsApp 5 días hábiles antes).
//
// 3. MÁXIMO 2 INTENTOS por cliente/mes. Si tras el intento 2
//    no contesta → se marca para telemercadeo (no se reintenta).
//
// 4. ANTI-DUPLICADO: clienteId + mesVencimiento (igual idea que
//    vencimientosService, pero la clave es la llamada, no el equipo).
//
// 5. AISLAMIENTO: toda operación filtra por adminId (multi-tenant).
//
// 6. FIRE-AND-FORGET: errores individuales no detienen el lote.
// ============================================================

const { db, admin } = require('../config/firebase');

const VAPI_API_KEY     = process.env.VAPI_API_KEY;
const VAPI_PHONE_ID    = process.env.VAPI_PHONE_NUMBER_ID;   // ID del número en Vapi (no el número en sí)
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;     // Assistant "Lucy"
const COSTO_FACTURADO_COP = Number(process.env.LLAMADA_IA_COSTO_COP) || 300; // valor fijo definido por Sandra

// ─── Helpers de fecha (mismo criterio que vencimientosService.js) ────────────
const mesActualColombia = () => {
  const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
  return ahoraCO.toISOString().slice(0, 7); // "YYYY-MM"
};

const hoyColombia = () => {
  const ahora = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return ahora.toISOString().slice(0, 10); // "YYYY-MM-DD"
};

// ─── Helper: normalizar teléfono a formato E.164 para Vapi/Twilio ────────────
const normalizarParaVapi = (telefono) => {
  if (!telefono) return null;
  let t = String(telefono).replace(/[\s\-\(\)\.]/g, '');
  if (t.startsWith('+')) return t;
  if (t.startsWith('57') && t.length === 12) return '+' + t;
  if (t.length === 10 && t.startsWith('3')) return '+57' + t;
  return null; // no se intenta adivinar formatos raros — mejor omitir que llamar mal
};

// ─── Helper: nombre de pila (para que Lucy no diga el nombre completo siempre) ─
const primerNombre = (nombreCompleto) => {
  if (!nombreCompleto) return 'cliente';
  return String(nombreCompleto).trim().split(/\s+/)[0];
};

// ═════════════════════════════════════════════════════════════════════════════
// Verifica si un tenant tiene Lucy activada.
//
// MISMO PATRÓN QUE 'qr' (ver PanelSuscriptores.js / superadmin.js): el
// SuperAdmin activa módulos agregando la clave al array `modulos` del
// documento del usuario admin en la colección `users`. Convención del
// sistema: modulos === [] significa "todos los módulos" — PERO para
// 'llamadas_ia', igual que para 'qr', la convención NO aplica: solo se
// considera activo si la clave está EXPLÍCITAMENTE en el array, porque
// es un módulo que se habilita uno por uno, nunca por defecto.
// ═════════════════════════════════════════════════════════════════════════════
const tenantTieneLucyActiva = async (adminId) => {
  const userDoc = await db.collection('users').doc(adminId).get();
  if (!userDoc.exists) return false;
  const modulos = userDoc.data().modulos || [];
  return modulos.includes('llamadas_ia');
};

// ═════════════════════════════════════════════════════════════════════════════
// Construye las variables dinámicas que Vapi inyecta en el system prompt
// de Lucy ({{nombre_cliente}}, {{mes_vencimiento}}, etc.)
//
// IMPORTANTE: el PRECIO ya no se precalcula aquí (era frágil — "Recarga ABC
// 5 lbs" vs "Extintor ABC 5 lbs" son productos DISTINTOS con reglas de
// negocio distintas: 5 lbs vehicular = cambio/despacho, 10 lbs empresa =
// recarga/domicilio). En su lugar, Lucy consulta el precio EN VIVO durante
// la llamada mediante la Tool "consultar_precio" (ver routes/llamadasIA.js),
// que sí aplica un matching más cuidadoso del lado del servidor.
//
// TAMPOCO crea la orden — eso quedó deliberadamente fuera del alcance de
// Lucy por riesgo de negocio (confundir recarga vs. extintor nuevo, tipo
// de servicio incorrecto contamina inventario/CxC/taller en producción).
// Lucy solo REGISTRA EL CIERRE; un humano revisa y crea la orden desde
// la pestaña Llamadas IA, igual patrón que Telemercadeo → NuevaOrden.js.
// ═════════════════════════════════════════════════════════════════════════════
const construirVariablesLlamada = ({ adminId, registroId, cliente, vencimiento, tenantInfo }) => {
  return {
    adminId,                                                          // para que las Tools sepan de qué tenant es
    registroId,                                                       // para que registrar_cierre sepa qué doc actualizar
    nombre_empresa:     tenantInfo.nombre || 'nuestra empresa',
    nombre_cliente:     primerNombre(cliente.nombre),
    equipos:            vencimiento.descripcionEquipo || 'su extintor',
    tipo_servicio:      cliente.tipoServicioHistorico || 'oficina',
    valor_domicilio:    tenantInfo.valorDomicilio || 'según su sector',
    mes_vencimiento:    vencimiento.fechaVencimiento || '',
    medios_pago:        tenantInfo.mediosPago || 'efectivo, transferencia y Nequi',
    direccion_empresa:  tenantInfo.direccion || '',
    horario_empresa:    tenantInfo.horario || 'lunes a viernes 8:00 a.m. – 5:30 p.m., sábados 8:00 a.m. – 12:00 p.m.',
    ciudad_empresa:     tenantInfo.ciudad || '',
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// Lanza UNA llamada a través de la API de Vapi
// Devuelve { ok, vapiCallId, error? }
// ═════════════════════════════════════════════════════════════════════════════
const lanzarLlamadaVapi = async ({ telefono, variables, metadata }) => {
  try {
    const resp = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_ID,
        customer: { number: telefono },
        assistantOverrides: {
          variableValues: variables,
        },
        metadata, // viaja de vuelta en el webhook — aquí va adminId/clienteId/vencimientoId
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { ok: false, error: data?.message || 'Error desconocido de Vapi' };
    }
    return { ok: true, vapiCallId: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL — ejecuta el motor para TODOS los tenants activos
// Llamada desde el cron diario (día 2 del mes, 9 AM Colombia) o manualmente
// desde /api/llamadas-ia/ejecutar-motor (solo admin, para pruebas).
// ═════════════════════════════════════════════════════════════════════════════
const ejecutarMotorLlamadas = async () => {
  const mesActual = mesActualColombia();
  const hoy = hoyColombia();
  console.log(`[LLAMADAS-IA] Iniciando motor — mes ${mesActual}`);

  try {
    // 1) Vencimientos del MES ACTUAL, no gestionados todavía
    const vencSnap = await db.collection('vencimientos')
      .where('fechaVencimiento', '>=', `${mesActual}-01`)
      .where('fechaVencimiento', '<=', `${mesActual}-31`)
      .where('gestionado', '==', false)
      .get();

    if (vencSnap.empty) {
      console.log('[LLAMADAS-IA] Sin vencimientos para este mes');
      return { tenantsProcesados: 0, llamadasLanzadas: 0 };
    }

    // 2) Agrupar por tenant (mismo patrón que el cron de WhatsApp)
    const porTenant = {};
    vencSnap.docs.forEach(doc => {
      const d = doc.data();
      if (!d.adminId || !d.clienteId) return;
      if (!porTenant[d.adminId]) porTenant[d.adminId] = [];
      porTenant[d.adminId].push({ id: doc.id, ...d });
    });

    let totalLanzadas = 0;
    let tenantsProcesados = 0;

    for (const [adminId, vencimientos] of Object.entries(porTenant)) {
      // 3) Filtro de activación manual — si Sandra no la activó, se omite el tenant
      const activa = await tenantTieneLucyActiva(adminId);
      if (!activa) continue;

      tenantsProcesados++;

      // Datos del tenant para personalizar el guión. Horario / medios de
      // pago / domicilio quedan con los valores por defecto razonables de
      // construirVariablesLlamada por ahora (igual patrón que el resto del
      // proyecto: simple primero, se personaliza por tenant más adelante
      // si hace falta — no bloquea el lanzamiento del 2 de julio).
      const userDoc = await db.collection('users').doc(adminId).get();
      const tenantInfo = {
        nombre:    userDoc.exists ? (userDoc.data().empresa || userDoc.data().nombre) : 'Control360',
        direccion: userDoc.exists ? userDoc.data().direccion : '',
        ciudad:    userDoc.exists ? userDoc.data().ciudad : '',
      };

      for (const venc of vencimientos) {
        try {
          // 4) Anti-duplicado + control de máximo 2 intentos
          const existentesSnap = await db.collection('llamadas_ia')
            .where('adminId', '==', adminId)
            .where('clienteId', '==', venc.clienteId)
            .where('mesVencimiento', '==', venc.fechaVencimiento)
            .get();

          const intentos = existentesSnap.docs.map(d => d.data());
          const yaTieneResultadoFinal = intentos.some(i =>
            ['cerrada', 'reagendada', 'inactivo_cliente', 'escalado_asesor', 'no_interesado'].includes(i.resultado)
          );
          if (yaTieneResultadoFinal) continue; // ya se resolvió, no se vuelve a llamar

          const numeroIntento = intentos.length + 1;
          if (numeroIntento > 2) continue; // ya agotó los 2 intentos → debe pasar a telemercadeo (paso aparte)

          // 5) Resolver datos del cliente y teléfono
          const cliDoc = await db.collection('clients').doc(venc.clienteId).get();
          if (!cliDoc.exists) continue;
          const cliente = cliDoc.data();
          const telefonoRaw = venc.telefono || cliente.celular || cliente.telefono;
          const telefono = normalizarParaVapi(telefonoRaw);
          if (!telefono) {
            console.warn(`[LLAMADAS-IA] Cliente ${venc.clienteId} sin teléfono válido — omitido`);
            continue;
          }

          // Respeta el horario permitido del proyecto (L-V 8-18, Sáb 9-12 Colombia)
          const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
          const diaSemana = ahoraCO.getUTCDay(); // 0 dom, 6 sáb
          const horaActual = ahoraCO.getUTCHours();
          const horarioValido =
            (diaSemana >= 1 && diaSemana <= 5 && horaActual >= 8 && horaActual < 18) ||
            (diaSemana === 6 && horaActual >= 9 && horaActual < 12);
          if (!horarioValido) {
            console.log('[LLAMADAS-IA] Fuera de horario permitido — el cron reintentará en la próxima ventana');
            continue;
          }

          // 6) Construir variables dinámicas y lanzar la llamada
          // registroRef se crea PRIMERO (solo genera el ID, no escribe nada
          // en Firestore todavía) porque las variables que viajan a Vapi
          // necesitan registroRef.id — el .set() real sigue más abajo.
          const registroRef = db.collection('llamadas_ia').doc();
          const variables = construirVariablesLlamada({ adminId, registroId: registroRef.id, cliente, vencimiento: venc, tenantInfo });

          const resultadoVapi = await lanzarLlamadaVapi({
            telefono,
            variables,
            metadata: {
              adminId,
              clienteId: venc.clienteId,
              vencimientoId: venc.id,
              registroId: registroRef.id,
              intento: numeroIntento,
            },
          });

          await registroRef.set({
            adminId,
            vencimientoId: venc.id,
            clienteId: venc.clienteId,
            telefono: telefonoRaw,
            mesVencimiento: venc.fechaVencimiento,
            intento: numeroIntento,
            estado: resultadoVapi.ok ? 'en_curso' : 'fallida',
            resultado: null,
            vapiCallId: resultadoVapi.ok ? resultadoVapi.vapiCallId : null,
            errorLanzamiento: resultadoVapi.ok ? null : resultadoVapi.error,
            costoFacturadoCOP: COSTO_FACTURADO_COP,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          if (resultadoVapi.ok) totalLanzadas++;
          else console.error(`[LLAMADAS-IA] Fallo al lanzar a ${telefono}:`, resultadoVapi.error);

          // Pausa breve entre llamadas — evita saturar la API igual que WhatsApp
          await new Promise(r => setTimeout(r, 800));

        } catch (errCliente) {
          console.error('[LLAMADAS-IA] Error procesando vencimiento', venc.id, errCliente.message);
        }
      }
    }

    console.log(`[LLAMADAS-IA] Motor completado — ${tenantsProcesados} tenant(s), ${totalLanzadas} llamada(s) lanzada(s)`);
    return { tenantsProcesados, llamadasLanzadas: totalLanzadas };
  } catch (e) {
    console.error('[LLAMADAS-IA] Error general del motor:', e.message);
    return { tenantsProcesados: 0, llamadasLanzadas: 0, error: e.message };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Procesa el webhook que Vapi envía al terminar una llamada (end-of-call-report)
// Actualiza el registro en llamadas_ia con resultado, duración, costo y
// transcripción. Si Lucy cerró la venta, dispara la creación de la orden.
// ═════════════════════════════════════════════════════════════════════════════
const procesarResultadoLlamada = async (payload) => {
  try {
    const metadata = payload?.call?.metadata || payload?.message?.call?.metadata || {};
    const registroId = metadata.registroId;
    if (!registroId) {
      console.warn('[LLAMADAS-IA] Webhook sin registroId en metadata — ignorado');
      return { ok: false, error: 'Sin registroId' };
    }

    const ref = db.collection('llamadas_ia').doc(registroId);
    const doc = await ref.get();
    if (!doc.exists) {
      console.warn('[LLAMADAS-IA] Webhook referencia un registro inexistente:', registroId);
      return { ok: false, error: 'Registro no encontrado' };
    }

    const analysis = payload?.message?.analysis || payload?.analysis || {};
    const transcript = payload?.message?.transcript || payload?.transcript || '';
    const durationSeconds = payload?.message?.call?.endedAt && payload?.message?.call?.startedAt
      ? Math.round((new Date(payload.message.call.endedAt) - new Date(payload.message.call.startedAt)) / 1000)
      : (payload?.message?.durationSeconds || null);

    // Vapi reporta el costo en USD dentro de message.cost (según su API)
    const costoUSD = payload?.message?.cost ?? payload?.cost ?? null;

    // El resultado estructurado (cerrada/reagendada/etc.) lo determina Lucy
    // mediante una function-call durante la llamada (Tool "registrar_resultado").
    // Si no llegó por ahí, se infiere de forma conservadora del análisis de Vapi.
    const resultado = metadata.resultadoReportado || analysis?.structuredData?.resultado || 'sin_respuesta';

    const update = {
      estado: 'completada',
      resultado,
      duracionSegundos: durationSeconds,
      costoVapiUSD: costoUSD,
      transcripcion: transcript,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (metadata.fechaAgendada) update.fechaAgendada = metadata.fechaAgendada;
    if (metadata.datosCierre) update.datosCierre = metadata.datosCierre; // datos recolectados por Lucy, pendientes de revisión humana

    await ref.update(update);

    // Si quedó sin respuesta y ya fue el intento 2, marcar el vencimiento
    // para que la cola de Telemercadeo lo tome (no se toca su lógica interna,
    // solo se deja la señal — el módulo Comercial ya sabe leer esto).
    const data = doc.data();
    if (resultado === 'sin_respuesta' && data.intento >= 2) {
      await db.collection('vencimientos').doc(data.vencimientoId).update({
        escaladoTelemercadeo: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

    // Si Lucy marcó el vencimiento como resuelto (cerrada/reagendada/inactivo),
    // se marca gestionado=true para que no vuelva a sonar el motor el próximo mes
    // con el mismo ciclo. (No aplica si quedó escalado a asesor sin resolución.)
    if (['cerrada', 'reagendada', 'inactivo_cliente'].includes(resultado)) {
      await db.collection('vencimientos').doc(data.vencimientoId).update({
        gestionado: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

    console.log(`[LLAMADAS-IA] Resultado procesado — registro ${registroId}: ${resultado}`);
    return { ok: true };
  } catch (e) {
    console.error('[LLAMADAS-IA] Error procesando webhook:', e.message);
    return { ok: false, error: e.message };
  }
};

module.exports = {
  ejecutarMotorLlamadas,
  procesarResultadoLlamada,
  tenantTieneLucyActiva,
  normalizarParaVapi,
};

// ════════════════════════════════════════════════════════════════════════════
// CRON AUTOMÁTICO — mismo patrón que iniciarCronWhatsapp() en suscripcionCron.js
// ------------------------------------------------------------------------------
// Disparo: ventana de los primeros 3 días HÁBILES de cada mes (no solo el
// día 2 exacto). Esto evita que el negocio se quede sin llamadas ese mes si
// el día 2 cae en fin de semana, o si el servidor tuvo un problema puntual
// ese día — el motor reintenta automáticamente al día siguiente hábil y la
// deduplicación (clienteId + mesVencimiento) evita llamar dos veces al mismo
// cliente aunque el cron corra varios días seguidos.
// Corre todos los días a las 9:00 AM Colombia, pero solo ACTÚA dentro de la
// ventana — fuera de ella no hace nada (mismo costo en credits que no correr).
// ════════════════════════════════════════════════════════════════════════════

const esDiaHabil = (fechaStr) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const diaSemana = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 dom, 6 sáb
  return diaSemana >= 1 && diaSemana <= 5;
};

// Cuenta cuántos días hábiles van transcurridos en el mes, incluyendo hoy
const diasHabilesTranscurridosMes = (fechaStr) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  let count = 0;
  for (let dia = 1; dia <= d; dia++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    if (esDiaHabil(ds)) count++;
  }
  return count;
};

let ultimaEjecucionLlamadasIA = null;

const iniciarCronLlamadasIA = () => {
  const verificar = () => {
    const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
    const fechaHoy = ahoraCO.toISOString().slice(0, 10);
    const hora = ahoraCO.getUTCHours();

    // Correr a las 9:00 AM Colombia, una sola vez al día
    if (hora !== 9 || ahoraCO.getMinutes() >= 15) return;
    if (ultimaEjecucionLlamadasIA === fechaHoy) return;

    if (!esDiaHabil(fechaHoy)) {
      console.log('[LLAMADAS-IA-CRON] Día no hábil — sin ejecución');
      return;
    }

    // Ventana: primeros 3 días hábiles del mes (cubre el "día 2" + margen
    // de seguridad si el 2 cae en fin de semana o hubo un fallo puntual)
    const diasHabiles = diasHabilesTranscurridosMes(fechaHoy);
    if (diasHabiles > 3) {
      return; // fuera de ventana — silencioso, no llena logs todos los días
    }

    ultimaEjecucionLlamadasIA = fechaHoy;
    console.log(`[LLAMADAS-IA-CRON] Ejecutando motor — día hábil ${diasHabiles} del mes`);
    ejecutarMotorLlamadas().catch(e => console.error('[LLAMADAS-IA-CRON]', e.message));
  };

  setInterval(verificar, 15 * 60 * 1000); // revisa cada 15 min, igual que los otros crons
  verificar();
  console.log('✅ Cron Llamadas IA (Lucy) activo — corre en los primeros 3 días hábiles del mes, 9:00 AM Colombia');
};

module.exports.iniciarCronLlamadasIA = iniciarCronLlamadasIA;
