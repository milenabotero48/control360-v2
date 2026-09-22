// ============================================================
// Control360 — Notificaciones salientes vía Anny (Baileys)  v22
// Ubicación: backend/services/annyNotificaciones.js
// FIX ANNY-NOTIF-001 + ANNY-VENC-001 + ANNY-VENC-002 + ANNY-VENC-003
// + ✅ ANNY-SLA-060 + ✅ ANNY-INCIDENTE-061 + ✅ ANNY-ESCALADO-059 (vigilante SLA)
// ============================================================
// FIX ANNY-VENC-003: los 320 vencimientos daban 0 candidatos.
// Causa: fechaVencimiento importada como Timestamp (no string).
// Ahora: lectura de fecha ROBUSTA + log de diagnóstico por motivo.
//
// ════════════════════════════════════════════════════════════
// NUEVO EN v22:
// - ANNY-MISION-014: toda salida deja marcada la MISIÓN activa del
//   chat (`misionActiva` + `misionHasta` en el resumen del chat).
//   Sin esto, un cliente que responde a una cobranza era atendido
//   como si fuera una consulta comercial y Anny le ofrecía
//   productos en medio de un cobro. Ahora la conversación
//   mantiene el propósito con el que se abrió.
// - ANNY-HUMANO-012: `enviarAvisoInterno` — manda el aviso de
//   escalamiento al WhatsApp que la suscriptora ya configuró
//   (perfil.notificarEscalamientoA, o notificarPedidosA).
// - ANNY-TALLER-018: `notificarCambioTaller` — misión
//   NOTIFICACION_TALLER para autorizar cambios de repuesto.
// - ANNY-SAAS-019: `ejecutarRenovacionSaaS` — cuenta de cobro a
//   suscriptores bajo la misión RENOVACION_SAAS. NO tiene cron
//   propio a propósito: se dispara manualmente hasta validarla.
// - ANNY-BREV-011: plantillas salientes acortadas y sin formato
//   de folleto, coherentes con el tono nuevo de Anny.
// ============================================================

const { db, admin } = require('../config/firebase');
const annyService = require('./annyService');
const baileysService = require('./baileysService');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Helper: fecha Firestore/ISO → ISO string ────────────────
function aISO(f) {
  if (!f) return null;
  if (typeof f === 'string') return f;
  if (f.toDate) return f.toDate().toISOString();
  if (f._seconds) return new Date(f._seconds * 1000).toISOString();
  if (f.seconds) return new Date(f.seconds * 1000).toISOString();
  return null;
}

// ─── FIX ANNY-VENC-003: mes 'YYYY-MM' desde cualquier formato ─
function mesDeFecha(f) {
  if (!f) return null;
  if (typeof f === 'string') {
    const m = f.match(/^(\d{4})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}` : null;
  }
  if (f.toDate) return f.toDate().toISOString().slice(0, 7);
  if (f._seconds) return new Date(f._seconds * 1000).toISOString().slice(0, 7);
  if (f.seconds) return new Date(f.seconds * 1000).toISOString().slice(0, 7);
  if (f instanceof Date) return f.toISOString().slice(0, 7);
  return null;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// 'YYYY-MM' → "julio 2026"
function formatearMes(mesStr) {
  try {
    const [anio, mes] = String(mesStr).split('-');
    return `${MESES[parseInt(mes) - 1] || mes} ${anio}`;
  } catch { return String(mesStr || ''); }
}

// ─── Normalización de celular a JID de WhatsApp ──────────────
function aJid(celular) {
  // ✅ ANNY-GRUPO-051: acepta también un jid ya formado (grupo @g.us
  // o contacto @s.whatsapp.net), no solo un número de 10 dígitos.
  const raw = String(celular || '').trim();
  if (raw.endsWith('@g.us') || raw.endsWith('@s.whatsapp.net')) {
    return { num: raw.split('@')[0], jid: raw };
  }
  const num = raw.replace(/\D/g, '');
  if (num.length < 10) return null;
  const con57 = num.startsWith('57') ? num : '57' + num;
  return { num: con57, jid: `${con57}@s.whatsapp.net` };
}

// ============================================================
// FIX ANNY-MISION-014: marcar la misión activa del chat
// ------------------------------------------------------------
// Cuando Anny abre una conversación con un propósito (cobrar,
// pedir autorización de taller, renovar suscripción), ese
// propósito debe sobrevivir a la respuesta del cliente.
// Se guarda en el resumen del chat con vencimiento, para que
// pasado el plazo la conversación vuelva a ATENCION normal.
// ============================================================
async function marcarMisionActiva(adminId, telefonoNum, mision, horasVigencia = 48) {
  try {
    if (!adminId || !telefonoNum || !mision) return;
    await db.collection('chatsAnny')
      .doc(adminId)
      .collection('chats')
      .doc(String(telefonoNum))
      .set({
        adminId,
        telefono: String(telefonoNum),
        misionActiva: mision,
        misionHasta: Date.now() + horasVigencia * 3600 * 1000,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
  } catch (err) {
    console.error('[ANNY-NOTIF] Error marcando misión activa:', err.message);
  }
}

// ============================================================
// Enviar un WhatsApp a un cliente por la línea de Anny.
// v22: recibe la misión con la que se abre la conversación.
// ============================================================
async function notificarClienteWhatsApp(adminId, celular, texto, mision = null) {
  try {
    if (!adminId || !celular || !texto) return false;

    const activo = await annyService.tenantTieneAnnyActiva(adminId);
    if (!activo) return false;

    const tel = aJid(celular);
    if (!tel) return false;

    const enviado = await baileysService.enviarMensaje(adminId, tel.jid, texto);
    if (enviado) {
      await annyService.registrarConversacion(adminId, {
        telefono: tel.num,
        nombreCliente: null,
        mensajeCliente: null,
        respuestaAgente: texto,
        respondidoPor: 'NOTIFICACION_SISTEMA',
        mision: mision || null,
        escalado: false,
        caseId: null
      });

      // ANNY-MISION-014: la respuesta del cliente se atenderá con
      // esta misión, no como una consulta comercial cualquiera.
      if (mision) await marcarMisionActiva(adminId, tel.num, mision);
    }
    return !!enviado;
  } catch (err) {
    console.error('[ANNY-NOTIF] Error enviando notificación:', err.message);
    return false;
  }
}

// ============================================================
// FIX ANNY-HUMANO-012: aviso INTERNO al equipo
// ------------------------------------------------------------
// No va al cliente: va al WhatsApp de la empresa. Se usa cuando
// el cliente pide un asesor o cuando se escala un caso.
// Destino: perfil.notificarEscalamientoA → si está vacío, cae al
// notificarPedidosA que la suscriptora ya tiene configurado.
// ============================================================
async function enviarAvisoInterno(adminId, texto, destinoExplicito = null) {
  try {
    if (!adminId || !texto) return false;

    // ✅ ANNY-GRUPO-051: el grupo interno manda sobre el número
    // individual. Un aviso que ven cinco personas se atiende; uno
    // que llega a un solo celular se pierde cuando esa persona
    // está manejando.
    let destino = null;
    try {
      const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
      if (cfgDoc.exists && cfgDoc.data().notificarGrupoJid) {
        destino = cfgDoc.data().notificarGrupoJid;
      }
    } catch (e) { /* sigue con el destino normal */ }

    if (!destino) destino = destinoExplicito;
    if (!destino) {
      const perfil = await annyService.obtenerPerfilTenant(adminId);
      destino = perfil.notificarEscalamientoA;
    }
    if (!destino) {
      console.warn(`[ANNY-NOTIF] Tenant ${adminId} sin WhatsApp de avisos configurado`);
      return false;
    }

    const tel = aJid(destino);
    if (!tel) return false;

    return !!(await baileysService.enviarMensaje(adminId, tel.jid, texto));
  } catch (err) {
    console.error('[ANNY-NOTIF] Error enviando aviso interno:', err.message);
    return false;
  }
}

// ============================================================
// COBRANZA CxC — órdenes en cartera con >10 días de completadas
// Misión: COBRANZA (Anny NO vende dentro de un cobro)
// ============================================================
async function ejecutarCobranzaCxC() {
  console.log('[ANNY-NOTIF] Iniciando cobranza CxC semanal...');
  let enviados = 0;

  try {
    const cfgSnap = await db.collection('annyConfig')
      .where('conexionEstado', '==', 'conectado')
      .get();

    const hoyStr = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

    for (const cfgDoc of cfgSnap.docs) {
      const adminId = cfgDoc.id;

      const activo = await annyService.tenantTieneAnnyActiva(adminId);
      if (!activo) continue;

      const snap = await db.collection('orders')
        .where('adminId', '==', adminId)
        .where('estado', '==', 'cxc')
        .get();

      for (const doc of snap.docs) {
        try {
          const o = doc.data();

          const saldo = (o.total || 0) - (o.montoPagado || 0);
          if (saldo <= 0) continue;

          const celular = (o.clienteCelular || '').replace(/\D/g, '');
          if (celular.length < 10) continue;

          const fechaCompletada =
            (o.historialEstados || []).find(h => h.estado === 'completada')?.fecha ||
            (o.historialEstados || []).find(h => h.estado === 'cxc')?.fecha ||
            aISO(o.fechaFactura) ||
            aISO(o.createdAt);

          if (!fechaCompletada) continue;
          const dias = Math.floor((Date.now() - new Date(fechaCompletada).getTime()) / 86400000);
          if (dias <= 10) continue;

          if (o.ultimaCobranzaAnny === hoyStr) continue;

          // ANNY-BREV-011: mensaje corto, sin bloques ni adornos.
          const msg = `Hola ${o.clienteNombre || ''} 👋 Te escribo de cartera: ` +
            `la orden ${o.numeroOrden} tiene un saldo pendiente de ` +
            `$${saldo.toLocaleString('es-CO')} (${dias} días desde el servicio). ` +
            `¿Me confirmas cuándo lo podemos coordinar?`;

          const ok = await notificarClienteWhatsApp(adminId, celular, msg, 'COBRANZA');
          if (ok) {
            enviados += 1;
            await doc.ref.update({ ultimaCobranzaAnny: hoyStr });
          }

          await sleep(4000);
        } catch (errOrden) {
          console.error('[ANNY-NOTIF] Error en orden de cobranza:', errOrden.message);
        }
      }
    }

    console.log(`[ANNY-NOTIF] Cobranza CxC terminada — ${enviados} mensajes enviados`);
  } catch (err) {
    console.error('[ANNY-NOTIF] Error en cobranza CxC:', err.message);
  }

  return { enviados };
}

// ============================================================
// ✅ ANNY-VENTA-034: confirmación de venta al cliente final
// ------------------------------------------------------------
// La suscriptora registra una venta (orden) y Anny le escribe al
// cliente: qué compró, el total y los medios de pago del perfil.
// Se activa por tenant (perfil.avisarVentaCliente = true) y se
// dispara fire-and-forget desde la creación de la orden — un
// fallo aquí JAMÁS puede tumbar el guardado de la venta.
// La respuesta del cliente llega bajo misión CONFIRMACION_VENTA.
// ============================================================
async function notificarVentaCliente(adminId, datos = {}) {
  try {
    const { celular, nombreCliente, numeroOrden, descripcion, total } = datos;
    if (!celular) return { ok: false, error: 'sin_celular' };

    const activo = await annyService.tenantTieneAnnyActiva(adminId);
    if (!activo) return { ok: false, error: 'anny_inactivo' };

    const perfil = await annyService.obtenerPerfilTenant(adminId);
    if (perfil.avisarVentaCliente !== true) return { ok: false, error: 'aviso_desactivado' };

    const totalTxt = Number(total) > 0 ? ` por $${Number(total).toLocaleString('es-CO')}` : '';
    const ordenTxt = numeroOrden ? ` (orden ${numeroOrden})` : '';
    const queTxt = descripcion ? `: ${String(descripcion).slice(0, 120)}` : '';
    const pagoTxt = perfil.mediosPago
      ? ` Puedes pagar así: ${perfil.mediosPago}.`
      : ' ¿Te comparto los medios de pago?';

    const msg = `Hola${nombreCliente ? ' ' + nombreCliente : ''} 👋 ` +
      `Quedó registrada tu compra${ordenTxt}${queTxt}${totalTxt}.${pagoTxt} ` +
      `Cuando hagas el pago me envías el comprobante por aquí y coordinamos la entrega.`;

    const ok = await notificarClienteWhatsApp(adminId, celular, msg, 'CONFIRMACION_VENTA');
    return { ok, enviado: ok };
  } catch (err) {
    console.error('[ANNY-VENTA] Error confirmando venta:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============================================================
// FIX ANNY-TALLER-018: notificación de cambio de repuesto
// ------------------------------------------------------------
// Misión NOTIFICACION_TALLER: informar la novedad y obtener un
// SÍ/NO. Si el cliente negocia el precio, el motor escala.
// Uso desde el módulo Taller:
//   notificarCambioTaller(adminId, {
//     celular, nombreCliente, numeroOrden, repuesto, valor
//   })
// ============================================================
async function notificarCambioTaller(adminId, datos = {}) {
  try {
    const { celular, nombreCliente, numeroOrden, repuesto, valor } = datos;
    if (!celular || !repuesto) {
      return { ok: false, error: 'faltan_datos', mensaje: 'Se requiere celular y repuesto.' };
    }

    const activo = await annyService.tenantTieneAnnyActiva(adminId);
    if (!activo) return { ok: false, error: 'anny_inactivo' };

    const valorTxt = Number(valor) > 0 ? ` Tiene un costo de $${Number(valor).toLocaleString('es-CO')}.` : '';
    const ordenTxt = numeroOrden ? ` de la orden ${numeroOrden}` : '';

    const msg = `Hola${nombreCliente ? ' ' + nombreCliente : ''} 👋 ` +
      `Revisando tu equipo${ordenTxt} encontramos que necesita cambio de ${repuesto}.${valorTxt} ` +
      `¿Autorizas que lo hagamos?`;

    const ok = await notificarClienteWhatsApp(adminId, celular, msg, 'NOTIFICACION_TALLER');
    return { ok, enviado: ok };
  } catch (err) {
    console.error('[ANNY-TALLER] Error notificando cambio:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============================================================
// FIX ANNY-SAAS-019: cuenta de cobro de suscripción
// ------------------------------------------------------------
// Misión RENOVACION_SAAS. Anny habla del SOFTWARE, no de
// productos físicos: por eso el tenant que la use debe tener su
// perfil con fuentePrecios 'planes' o 'ninguna' (ANNY-CFG-010).
//
// SIN CRON A PROPÓSITO: se dispara manualmente hasta validar
// varias corridas. Un cobro automático mal calibrado le escribe
// a todos los suscriptores a la vez — el mismo error que ya
// costó 170 llamadas con Lucy.
//
// Params: adminId = tenant dueño de la línea (Control360),
//         opciones.diasAntes = ventana de aviso (default 5)
//         opciones.simular = true → no envía, solo lista
// ============================================================
async function ejecutarRenovacionSaaS(adminId, opciones = {}) {
  const diasAntes = Number(opciones.diasAntes) || 5;
  const simular = opciones.simular === true;

  try {
    const activo = await annyService.tenantTieneAnnyActiva(adminId);
    if (!activo) return { ok: false, error: 'anny_inactivo' };

    const perfil = await annyService.obtenerPerfilTenant(adminId);
    if (perfil.fuentePrecios === 'products') {
      return {
        ok: false,
        error: 'perfil_incorrecto',
        mensaje: 'Este tenant tiene perfil de venta de productos. Configura su perfil de Anny con fuentePrecios "planes" antes de usar la renovación de suscripciones.'
      };
    }

    const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
    if (!cfgDoc.exists || cfgDoc.data().conexionEstado !== 'conectado') {
      return { ok: false, error: 'whatsapp_desconectado' };
    }

    const hoy = new Date(Date.now() - 5 * 3600 * 1000);
    const hoyStr = hoy.toISOString().slice(0, 10);
    const limite = new Date(hoy.getTime() + diasAntes * 86400000).toISOString().slice(0, 10);

    const snap = await db.collection('suscripciones').limit(500).get();

    const candidatos = [];
    for (const d of snap.docs) {
      const s = d.data();
      const venc = String(s.fechaVencimiento || '').slice(0, 10);
      if (!venc || venc > limite) continue;
      if (s.estado === 'suspendido') continue;
      if (s.ultimoAvisoCobroAnny === hoyStr) continue;

      const celular = String(s.celular || s.telefono || '').replace(/\D/g, '');
      if (celular.length < 10) continue;

      candidatos.push({ id: d.id, ref: d.ref, ...s, _celular: celular, _venc: venc });
    }

    if (simular) {
      return {
        ok: true, simulacion: true, candidatos: candidatos.length,
        detalle: candidatos.map(c => ({ id: c.id, nombre: c.nombre || c.empresa || c.id, vence: c._venc }))
      };
    }

    let enviados = 0;
    for (const c of candidatos) {
      try {
        const valor = Number(c.valorMensual || c.precio || 0);
        const valorTxt = valor > 0 ? ` por $${valor.toLocaleString('es-CO')}` : '';
        const msg = `Hola${c.nombre ? ' ' + c.nombre : ''} 👋 Te recuerdo que tu suscripción a Control360` +
          `${valorTxt} vence el ${c._venc}. ¿Te comparto los datos para el pago?`;

        const ok = await notificarClienteWhatsApp(adminId, c._celular, msg, 'RENOVACION_SAAS');
        if (ok) {
          enviados += 1;
          await c.ref.update({ ultimoAvisoCobroAnny: hoyStr });
        }
        await sleep(8000);
      } catch (e) {
        console.error('[ANNY-SAAS] Error con suscriptor', c.id, e.message);
      }
    }

    console.log(`[ANNY-SAAS] Renovación terminada — ${enviados}/${candidatos.length} enviados`);
    return { ok: true, candidatos: candidatos.length, enviados };
  } catch (err) {
    console.error('[ANNY-SAAS] Error en renovación:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============================================================
// RONDA DE VENCIMIENTOS — misión REACTIVACION
// ============================================================

const rondasEnCurso = new Set();

async function ejecutarRondaVencimientos(adminId) {
  if (rondasEnCurso.has(adminId)) {
    return { ok: false, error: 'ronda_en_curso', mensaje: 'Ya hay una ronda enviándose para esta empresa.' };
  }

  const activo = await annyService.tenantTieneAnnyActiva(adminId);
  if (!activo) return { ok: false, error: 'anny_inactivo' };

  const cfgDoc = await db.collection('annyConfig').doc(adminId).get();
  const cfg = cfgDoc.exists ? cfgDoc.data() : {};
  if (cfg.conexionEstado !== 'conectado') {
    return { ok: false, error: 'whatsapp_desconectado', mensaje: 'Conecta WhatsApp antes de enviar una ronda.' };
  }

  const tope = Number(cfg.topeDiarioRonda) || 60;

  const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
  const mesActual = ahoraCO.toISOString().slice(0, 7); // 'YYYY-MM'

  const snap = await db.collection('vencimientos')
    .where('adminId', '==', adminId)
    .get();

  const hoyMs = Date.now();
  const todos = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

  // FIX ANNY-VENC-003: filtrado con desglose de motivos + fecha robusta
  const stats = { gestionados: 0, sinTelefono: 0, mesNoVencido: 0, sinFecha: 0, enEspera12d: 0 };
  const candidatos = [];

  for (const v of todos) {
    if (v.gestionado === true) { stats.gestionados++; continue; }
    if (!v.telefono) { stats.sinTelefono++; continue; }

    const mesV = mesDeFecha(v.fechaVencimiento);
    if (!mesV) { stats.sinFecha++; continue; }
    if (mesV > mesActual) { stats.mesNoVencido++; continue; }

    if (v.ultimaRondaAnny && (hoyMs - new Date(v.ultimaRondaAnny).getTime()) <= 12 * 86400000) {
      stats.enEspera12d++;
      continue;
    }

    candidatos.push({ ...v, _mesVencimiento: mesV });
  }

  candidatos.sort((a, b) => a._mesVencimiento.localeCompare(b._mesVencimiento));

  console.log(
    `[ANNY-VENC] Tenant ${adminId}: ${todos.length} totales → candidatos=${candidatos.length} | ` +
    `gestionados=${stats.gestionados} sinTelefono=${stats.sinTelefono} ` +
    `mesNoVencido=${stats.mesNoVencido} sinFecha=${stats.sinFecha} enEspera12d=${stats.enEspera12d}`
  );

  const lote = candidatos.slice(0, tope);
  const pendientesDespues = candidatos.length - lote.length;

  if (lote.length === 0) {
    return {
      ok: true,
      encolados: 0,
      pendientesDespues: 0,
      mensaje: `Sin candidatos. Desglose: ${stats.gestionados} gestionados, ${stats.sinTelefono} sin teléfono, ` +
        `${stats.mesNoVencido} aún no vencidos, ${stats.sinFecha} sin fecha, ${stats.enEspera12d} recibieron ronda hace <12 días.`
    };
  }

  rondasEnCurso.add(adminId);
  procesarLoteRonda(adminId, lote)
    .catch(err => console.error('[ANNY-VENC] Error en lote de ronda:', err.message))
    .finally(() => rondasEnCurso.delete(adminId));

  return {
    ok: true,
    encolados: lote.length,
    pendientesDespues,
    mensaje: `Ronda iniciada: ${lote.length} mensajes en cola (1 cada 45 segundos ≈ ${Math.ceil(lote.length * 45 / 60)} minutos).` +
      (pendientesDespues > 0 ? ` Quedan ${pendientesDespues} para próximas rondas (tope diario: ${tope}).` : '')
  };
}

async function procesarLoteRonda(adminId, lote) {
  console.log(`[ANNY-VENC] Ronda tenant ${adminId}: ${lote.length} mensajes`);
  let enviados = 0;

  for (const v of lote) {
    try {
      let nombre = '';
      if (v.clienteId) {
        try {
          const cliDoc = await db.collection('clients').doc(v.clienteId).get();
          // AISLAMIENTO: nunca leer el nombre de un cliente de otro tenant
          if (cliDoc.exists && cliDoc.data().adminId === adminId) {
            const c = cliDoc.data();
            nombre = c.nombre || c.nombreCompleto || c.razonSocial || '';
          }
        } catch { /* sin nombre, saludo genérico */ }
      }

      const mesTxt = formatearMes(v._mesVencimiento || mesDeFecha(v.fechaVencimiento));
      const equipoTxt = v.descripcionEquipo || 'extintor';
      const plural = (v.cantidad || 1) > 1;

      // ANNY-BREV-011: dos frases, sin bloques ni doble salto.
      const msg = `Hola${nombre ? ' ' + nombre : ''} 👋 ` +
        `${plural ? `Tus ${v.cantidad} equipos ${equipoTxt} vencieron` : `Tu ${equipoTxt} venció`} ` +
        `su recarga en ${mesTxt} y ya no te protege en una emergencia. ` +
        `¿Te lo agendamos? Vamos hasta donde estés.`;

      const ok = await notificarClienteWhatsApp(adminId, v.telefono, msg, 'REACTIVACION');
      if (ok) {
        enviados += 1;
        await v.ref.update({
          ultimaRondaAnny: new Date().toISOString(),
          rondasEnviadas: admin.firestore.FieldValue.increment(1)
        });
      }

      await sleep(45000);
    } catch (errV) {
      console.error('[ANNY-VENC] Error enviando a', v.telefono, errV.message);
    }
  }

  console.log(`[ANNY-VENC] Ronda tenant ${adminId} terminada — ${enviados}/${lote.length} enviados`);
}

// ============================================================
// Cron rondas de vencimientos: días configurables por empresa
// ============================================================
function iniciarCronRondasVencimientos() {
  const verificarYEjecutar = async () => {
    try {
      const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
      const diaMes = ahoraCO.getUTCDate();
      const horaCO = ahoraCO.getUTCHours();
      const fechaHoy = ahoraCO.toISOString().slice(0, 10);

      const cfgSnap = await db.collection('annyConfig')
        .where('conexionEstado', '==', 'conectado')
        .get();

      for (const doc of cfgSnap.docs) {
        const cfg = doc.data();

        const dias = String(cfg.diasRondaVencimientos || '')
          .split(',')
          .map(s => parseInt(s.trim()))
          .filter(n => n >= 1 && n <= 31);

        if (!dias.includes(diaMes)) continue;

        const horaCfg = parseInt(String(cfg.horaEnvio || '09:00').split(':')[0]) || 9;
        if (!(horaCO >= horaCfg && horaCO < horaCfg + 3)) continue;

        if (cfg.ultimaRondaFecha === fechaHoy) continue;

        await doc.ref.update({ ultimaRondaFecha: fechaHoy });
        console.log(`[ANNY-VENC] Cron dispara ronda para tenant ${doc.id} (día ${diaMes})`);
        ejecutarRondaVencimientos(doc.id).catch(err =>
          console.error('[ANNY-VENC] Error en ronda programada:', err.message)
        );
      }
    } catch (err) {
      console.error('[ANNY-VENC] Error en cron de rondas:', err.message);
    }
  };

  setInterval(verificarYEjecutar, 15 * 60 * 1000);
  verificarYEjecutar();
  console.log('✅ Cron rondas de vencimientos Anny activo — días configurables por empresa');
}

// ============================================================
// Cron cobranza: viernes 9:00 AM Colombia
// Log tag para Railway: ANNY-NOTIF
// ============================================================
let ultimaCobranza = null;

function iniciarCronCobranzaAnny() {
  const verificarYEjecutar = () => {
    const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000); // UTC-5
    const fechaHoy = ahoraCO.toISOString().slice(0, 10);
    const esViernes = ahoraCO.getUTCDay() === 5;
    const enVentana = ahoraCO.getUTCHours() >= 9 && ahoraCO.getUTCHours() < 12;

    if (esViernes && enVentana && ultimaCobranza !== fechaHoy) {
      ultimaCobranza = fechaHoy;
      ejecutarCobranzaCxC().catch(err =>
        console.error('[ANNY-NOTIF] Error ejecutando cobranza:', err.message)
      );
    }
  };

  setInterval(verificarYEjecutar, 15 * 60 * 1000);
  verificarYEjecutar();
  console.log('✅ Cron cobranza Anny activo — viernes 9:00 AM Colombia');
}

// ============================================================
// ✅ ANNY-SLA-048 — vigilante de casos escalados.
// ------------------------------------------------------------
// Revisa cada 5 minutos los casos PENDIENTE.
//   > 15 min sin atender  → recordatorio al asesor
//   > 45 min sin atender  → alerta al admin
//   > 24 h sin atender    → VENCIDO, deja de insistir
//
// ✅ ANNY-SLA-060 — cuándo PARA de insistir:
//   1. Solo avisa DENTRO del horario del tenant. Lo que ocurre de
//      noche espera y sale en el primer resumen al abrir.
//   2. UN mensaje por ronda por tenant con todos los casos que
//      tocan (antes: un mensaje por caso). Máximo 2 avisos por caso.
//   3. Cierra solo: si existe una orden creada DESPUÉS del escalado
//      para ese celular → RESUELTO (resueltoPor: 'orden_creada').
//      Lectura de órdenes como máximo cada 15 min por caso; no toca
//      orders.js ni la máquina de estados.
//   4. Casos de números del equipo (ANNY-INTERNO-064) se cierran.
// ✅ ANNY-ESCALADO-059 — al cerrar o vencer un caso se apaga la
//   marca roja del chat; además cada ronda autocura hasta 50 chats
//   que tengan la marca prendida sin casos abiertos (histórico).
// ✅ ANNY-INCIDENTE-061 — casos marcados `incidente: true`:
//   · mientras el incidente sigue activo: ni avisos ni vencimiento;
//   · al volver el servicio: salen UNA vez en el resumen del grupo;
//   · SuperAdmin recibe un aviso de apertura (y reaviso máx. 1/hora)
//     y uno de cierre, por el WhatsApp del tenant SuperAdmin.
// ============================================================
const SLA_RECORDATORIO_MIN = 15;
const SLA_ALERTA_ADMIN_MIN = 45;
const SLA_VENCIMIENTO_MIN = 24 * 60;
const SLA_REVISAR_ORDEN_MS = 15 * 60 * 1000;   // ANNY-SLA-060
const SLA_MAX_ITEMS_MENSAJE = 15;              // ANNY-SLA-060
const INCIDENTE_REAVISO_MS = 60 * 60 * 1000;   // ANNY-INCIDENTE-061

function _ms(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v.seconds) return v.seconds * 1000;
  if (v._seconds) return v._seconds * 1000;
  return 0;
}

// ANNY-INCIDENTE-061: caché de la marca superAdmin del dueño del tenant
const _cacheSuperAdmin = new Map(); // adminId → { es, exp }
async function _tenantEsSuperAdmin(adminId) {
  const c = _cacheSuperAdmin.get(adminId);
  if (c && Date.now() < c.exp) return c.es;
  let es = false;
  try {
    const doc = await db.collection('users').doc(adminId).get();
    es = !!(doc.exists && doc.data().superAdmin === true);
  } catch (e) { es = false; }
  _cacheSuperAdmin.set(adminId, { es, exp: Date.now() + 30 * 60 * 1000 });
  return es;
}

// ANNY-SLA-060: una línea por caso dentro del resumen agrupado
function _lineaCaso(c, edadMin) {
  const tel = String(c.telefono || '').replace(/\D/g, '');
  const edad = edadMin >= 120 ? `${Math.round(edadMin / 60)} h` : `${Math.round(edadMin)} min`;
  const MOTIVOS = { ERROR: 'sin respuesta de Anny', HUMANO: 'pidió asesor', DATOS: 'faltan datos', PRECIO: 'precio', QUEJA: 'queja' };
  const motivo = MOTIVOS[c.tipo] || String(c.tipo || 'caso').toLowerCase();
  return `• ${c.nombreCliente || 'Sin nombre'} — ${edad} · ${motivo}\n  wa.me/${tel}`;
}

function _bloque(titulo, items) {
  if (!items.length) return '';
  const visibles = items.slice(0, SLA_MAX_ITEMS_MENSAJE).map(i => i.linea);
  const resto = items.length - visibles.length;
  return `${titulo}\n${visibles.join('\n')}${resto > 0 ? `\n…y ${resto} más en el panel` : ''}`;
}

async function revisarCasosEscalados() {
  const incidente = (typeof annyService.estadoIncidente === 'function') ? annyService.estadoIncidente() : { activo: false };
  const incidentesPorTenant = []; // { adminId, esperando }
  let tenantSuperAdmin = null;

  try {
    const cfgSnap = await db.collection('annyConfig')
      .where('conexionEstado', '==', 'conectado')
      .get();

    for (const cfgDoc of cfgSnap.docs) {
      const adminId = cfgDoc.id;
      const cfg = cfgDoc.data() || {};

      try {
        if (!tenantSuperAdmin && await _tenantEsSuperAdmin(adminId)) tenantSuperAdmin = adminId;

        let perfil = {};
        try { perfil = await annyService.obtenerPerfilTenant(adminId); } catch (e) { perfil = {}; }

        const enHorario = annyService.estaEnHorario(perfil.horarioAtencion);
        const destinoAsesor = perfil.notificarEscalamientoA || cfg.notificarPedidosA || null;
        const destinoAdmin = cfg.notificarPedidosA || perfil.notificarEscalamientoA || null;
        const hayGrupo = !!cfg.notificarGrupoJid;

        // ANNY-ESCALADO-059: autocuración del histórico de marcas
        await annyService.repararMarcasEscalado(adminId, 50);

        const snap = await db.collection('casosEscaladosAnny')
          .doc(adminId)
          .collection('casos')
          .where('estado', '==', 'PENDIENTE')
          .limit(100)
          .get();

        if (snap.empty) continue;

        const equipo = await annyService.numerosDelEquipo(adminId);
        const telefonosCerrados = new Set();
        const recordatorios = [];   // nivel 0 → 1
        const urgentes = [];        // nivel <2 → 2
        const recuperados = [];     // incidentes ya superados
        let esperandoIncidente = 0;

        for (const doc of snap.docs) {
          const c = doc.data() || {};
          const tel = String(c.telefono || '');
          const creadoMs = _ms(c.createdAt) || Date.now();
          const edadMin = (Date.now() - creadoMs) / 60000;
          const telNorm = tel.replace(/\D/g, '').replace(/^57(?=\d{10}$)/, '');

          // ANNY-INTERNO-064: casos abiertos a números del equipo
          if (telNorm && equipo.has(telNorm)) {
            await doc.ref.set({ estado: 'RESUELTO', resueltoPor: 'numero_interno', resueltoMs: Date.now(), notas: 'Cerrado: el número pertenece al equipo del tenant.' }, { merge: true });
            telefonosCerrados.add(tel);
            continue;
          }

          const esIncidente = c.incidente === true;

          // Caducidad: no aplica a incidentes que siguen abiertos
          if (edadMin > SLA_VENCIMIENTO_MIN && !(esIncidente && incidente.activo)) {
            await doc.ref.set({ estado: 'VENCIDO', vencidoEn: Date.now() }, { merge: true });
            telefonosCerrados.add(tel);
            continue;
          }

          // ANNY-SLA-060: ¿ya hay una orden creada después del escalado?
          if (edadMin >= SLA_RECORDATORIO_MIN && (Date.now() - (Number(c.ordenRevisadaMs) || 0)) > SLA_REVISAR_ORDEN_MS) {
            try {
              const ordenes = await annyService.obtenerOrdenesServicio(adminId, tel);
              const posterior = (ordenes || []).find(o => o.creadaMs > creadoMs);
              if (posterior) {
                await doc.ref.set({
                  estado: 'RESUELTO', resueltoPor: 'orden_creada', resueltoMs: Date.now(),
                  notas: `Cerrado automáticamente: se creó la orden ${posterior.numero || ''} para este cliente.`.trim()
                }, { merge: true });
                telefonosCerrados.add(tel);
                continue;
              }
              await doc.ref.set({ ordenRevisadaMs: Date.now() }, { merge: true });
            } catch (eOrd) { /* si falla la lectura, sigue el flujo normal */ }
          }

          const nivel = Number(c.nivelSLA) || 0;

          if (esIncidente) {
            if (incidente.activo) { esperandoIncidente += 1; continue; }
            if (enHorario && !c.recuperadoAvisado) recuperados.push({ ref: doc.ref, linea: _lineaCaso(c, edadMin) });
            continue;
          }

          if (!enHorario) continue; // ANNY-SLA-060: de noche no se insiste

          if (edadMin >= SLA_ALERTA_ADMIN_MIN && nivel < 2) {
            urgentes.push({ ref: doc.ref, linea: _lineaCaso(c, edadMin) });
          } else if (edadMin >= SLA_RECORDATORIO_MIN && nivel < 1) {
            recordatorios.push({ ref: doc.ref, linea: _lineaCaso(c, edadMin) });
          }
        }

        // ANNY-ESCALADO-059: apagar marcas de los chats que quedaron sin casos
        for (const tel of telefonosCerrados) await annyService.sincronizarEscaladoChat(adminId, tel);

        if (esperandoIncidente > 0) incidentesPorTenant.push({ adminId, esperando: esperandoIncidente });

        // ── ANNY-SLA-060: UN mensaje por ronda ──
        const bloques = [
          _bloque(`🔴 *Más de ${SLA_ALERTA_ADMIN_MIN} min sin atender* (${urgentes.length})`, urgentes),
          _bloque(`⏳ *Clientes esperando asesor* (${recordatorios.length})`, recordatorios),
          _bloque(`🔁 *Anny estuvo sin servicio — estos clientes no recibieron respuesta* (${recuperados.length})`, recuperados)
        ].filter(Boolean);

        if (bloques.length) {
          const texto = `${bloques.join('\n\n')}\n\nAl responderles desde el WhatsApp de la empresa el caso se cierra solo.\nControl360 → Anny → Escalados`;
          const enviado = await enviarAvisoInterno(adminId, texto, destinoAsesor);

          // Alerta separada al admin solo si no hay grupo y el admin es otro destino
          if (urgentes.length && !hayGrupo && destinoAdmin && destinoAdmin !== destinoAsesor) {
            await sleep(300);
            await enviarAvisoInterno(adminId, `${_bloque(`🔴 *Casos sin atender hace más de ${SLA_ALERTA_ADMIN_MIN} min* (${urgentes.length})`, urgentes)}\n\nControl360 → Anny → Escalados`, destinoAdmin);
          }

          if (enviado) {
            const lote = db.batch();
            const ahora = Date.now();
            urgentes.forEach(i => lote.set(i.ref, { nivelSLA: 2, ultimoAvisoMs: ahora }, { merge: true }));
            recordatorios.forEach(i => lote.set(i.ref, { nivelSLA: 1, ultimoAvisoMs: ahora }, { merge: true }));
            recuperados.forEach(i => lote.set(i.ref, { recuperadoAvisado: true, nivelSLA: 2, ultimoAvisoMs: ahora }, { merge: true }));
            await lote.commit();
            console.log(`[ANNY-SLA-060] Tenant ${adminId}: 1 resumen (${urgentes.length} urgentes, ${recordatorios.length} recordatorios, ${recuperados.length} recuperados)`);
          }
        }

        if (snap.size >= 10) {
          console.warn(`[ANNY-SLA] Tenant ${adminId} acumula ${snap.size} casos escalados pendientes`);
        }
      } catch (errTenant) {
        // Un tenant con error no detiene la ronda de los demás
        console.error(`[ANNY-SLA] Error en tenant ${adminId}:`, errTenant.message);
      }
    }
  } catch (err) {
    console.error('[ANNY-SLA] Error revisando casos escalados:', err.message);
  }

  // ── ANNY-INCIDENTE-061: aviso a SuperAdmin ──
  try {
    await _avisarIncidenteSuperAdmin(incidente, tenantSuperAdmin, incidentesPorTenant);
  } catch (e) {
    console.error('[ANNY-INCIDENTE-061] Error avisando a SuperAdmin:', e.message);
  }
}

// El aviso de plataforma va DIRECTO al WhatsApp de SuperAdmin
// (ADMIN_WHATSAPP), no al grupo comercial. Sale por la sesión del
// tenant SuperAdmin; si esa sesión no está conectada, queda en log.
async function _avisarIncidenteSuperAdmin(incidente, tenantSuperAdmin, porTenant) {
  if (typeof annyService.marcarAvisoIncidente !== 'function') return;
  const abrirPendiente = incidente.activo && (!incidente.avisoAperturaMs || (Date.now() - incidente.avisoAperturaMs) > INCIDENTE_REAVISO_MS);
  const cierrePendiente = !incidente.activo && incidente.avisoCierrePendiente;
  if (!abrirPendiente && !cierrePendiente) return;

  if (!tenantSuperAdmin) {
    console.warn(`[ANNY-INCIDENTE-061] ${incidente.activo ? 'Incidente activo' : 'Incidente cerrado'} (${incidente.tipo}) — sin sesión de SuperAdmin conectada para avisar`);
    return;
  }

  const destino = aJid(process.env.ADMIN_WHATSAPP || '');
  if (!destino) {
    // A propósito NO cae al grupo comercial: un problema de plataforma no es trabajo del equipo.
    console.warn('[ANNY-INCIDENTE-061] ADMIN_WHATSAPP no está configurado en Railway — el aviso de incidente queda solo en log');
    return;
  }
  const minutos = Math.max(1, Math.round((Date.now() - (incidente.desdeMs || Date.now())) / 60000));
  let texto;

  if (abrirPendiente) {
    const esperando = porTenant.reduce((a, t) => a + t.esperando, 0);
    texto = `🛑 *ANNY SIN SERVICIO* — hace ${minutos} min\n` +
      `Causa: ${incidente.etiqueta || incidente.tipo}\n` +
      `Clientes con acuse automático esperando asesor: ${esperando} (${porTenant.length} empresa${porTenant.length === 1 ? '' : 's'})\n` +
      (incidente.tipo === 'SIN_SALDO' ? 'Recarga en la consola de Anthropic (Plans & Billing) y activa la recarga automática.\n' : '') +
      'Anny vuelve sola en cuanto la API responda.';
  } else {
    texto = `✅ *Anny recuperó el servicio*\nEstuvo sin servicio por ${incidente.etiqueta || incidente.tipo}. ` +
      'Los clientes que quedaron esperando salen en el próximo resumen de cada grupo, dentro del horario.';
  }

  const enviado = await baileysService.enviarMensaje(tenantSuperAdmin, destino.jid, texto);

  if (enviado) {
    annyService.marcarAvisoIncidente(abrirPendiente ? 'apertura' : 'cierre');
    console.log(`[ANNY-INCIDENTE-061] Aviso de ${abrirPendiente ? 'apertura' : 'cierre'} enviado a SuperAdmin`);
  }
}

function iniciarCronSLAEscalados() {
  setInterval(() => {
    revisarCasosEscalados().catch(err =>
      console.error('[ANNY-SLA] Error en cron:', err.message)
    );
  }, 5 * 60 * 1000);
  console.log('✅ Cron SLA de escalados activo — resumen agrupado en horario (ANNY-SLA-060), incidentes a SuperAdmin (ANNY-INCIDENTE-061)');
}

module.exports = {
  notificarClienteWhatsApp,
  ejecutarCobranzaCxC,
  iniciarCronCobranzaAnny,
  ejecutarRondaVencimientos,
  iniciarCronRondasVencimientos,
  // ── v22 ──
  enviarAvisoInterno,
  marcarMisionActiva,
  notificarCambioTaller,
  notificarVentaCliente, // ✅ ANNY-VENTA-034
  ejecutarRenovacionSaaS,
  // ── ANNY-SLA-048 ──
  revisarCasosEscalados,
  iniciarCronSLAEscalados
};
// FIN annyNotificaciones.js (v22)
