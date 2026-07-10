// ============================================================
// Control360 — Notificaciones salientes vía Anny (Baileys)
// Ubicación: backend/services/annyNotificaciones.js
// FIX ANNY-NOTIF-001 + ANNY-VENC-001 + ANNY-VENC-002
// ============================================================
// PRINCIPIOS:
// 1. Fire-and-forget: si Anny no está activa/conectada se omite
//    en silencio — NUNCA rompe el módulo que llama.
// 2. Gate multi-tenant: solo envía si el tenant tiene 'anny_ia'.
// 3. Cobranza CxC: viernes 9:00 AM Colombia, >10 días completadas.
// 4. Rondas de vencimientos: días configurables + disparo manual,
//    tope diario, 45s entre mensajes, una ronda cada 12 días por
//    cliente.
// 5. FIX ANNY-VENC-002: los vencimientos IMPORTADOS por Excel
//    pueden no traer el campo `gestionado` — la query por igualdad
//    los excluía a TODOS (por eso la ronda enviaba 0). Ahora se
//    consulta por adminId y se filtra en memoria (gestionado !== true).
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

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "2026-07-01" → "julio 2026"
function formatearMes(fechaVenc) {
  try {
    const [anio, mes] = String(fechaVenc).split('-');
    return `${MESES[parseInt(mes) - 1] || mes} ${anio}`;
  } catch { return String(fechaVenc || ''); }
}

// ============================================================
// Enviar un WhatsApp a un cliente por la línea de Anny.
// ============================================================
async function notificarClienteWhatsApp(adminId, celular, texto) {
  try {
    if (!adminId || !celular || !texto) return false;

    const activo = await annyService.tenantTieneAnnyActiva(adminId);
    if (!activo) return false;

    const num = String(celular).replace(/\D/g, '');
    if (num.length < 10) return false;
    const jid = `${num.startsWith('57') ? num : '57' + num}@s.whatsapp.net`;

    const enviado = await baileysService.enviarMensaje(adminId, jid, texto);
    if (enviado) {
      await annyService.registrarConversacion(adminId, {
        telefono: num.startsWith('57') ? num : '57' + num,
        nombreCliente: null,
        mensajeCliente: null,
        respuestaAgente: texto,
        respondidoPor: 'NOTIFICACION_SISTEMA',
        escalado: false,
        caseId: null
      });
    }
    return !!enviado;
  } catch (err) {
    console.error('[ANNY-NOTIF] Error enviando notificación:', err.message);
    return false;
  }
}

// ============================================================
// COBRANZA CxC — órdenes en cartera con >10 días de completadas
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

          const msg = `Hola ${o.clienteNombre || ''} 👋\n\n` +
            `Te escribimos de parte de nuestra área de cartera. ` +
            `La orden *${o.numeroOrden}* presenta un saldo pendiente de *$${saldo.toLocaleString('es-CO')}* ` +
            `(${dias} días desde el servicio).\n\n` +
            `Puedes responder por este medio para coordinar el pago o resolver cualquier duda. ` +
            `¡Gracias por tu atención! 🙌`;

          const ok = await notificarClienteWhatsApp(adminId, celular, msg);
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
// RONDA DE VENCIMIENTOS
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
  const inicioMesActual = `${ahoraCO.toISOString().slice(0, 7)}-01`;

  // FIX ANNY-VENC-002: query SOLO por adminId — el filtro de
  // gestionado va en memoria para incluir docs importados que no
  // traen el campo (la igualdad ==false los excluía a todos).
  const snap = await db.collection('vencimientos')
    .where('adminId', '==', adminId)
    .get();

  const hoyMs = Date.now();
  const todos = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

  const candidatos = todos
    .filter(v => v.gestionado !== true) // incluye importados sin el campo
    .filter(v => v.telefono && v.fechaVencimiento && String(v.fechaVencimiento) <= inicioMesActual)
    .filter(v => !v.ultimaRondaAnny || (hoyMs - new Date(v.ultimaRondaAnny).getTime()) > 12 * 86400000)
    .sort((a, b) => String(a.fechaVencimiento).localeCompare(String(b.fechaVencimiento)));

  console.log(`[ANNY-VENC] Tenant ${adminId}: ${todos.length} vencimientos totales, ${candidatos.length} candidatos a ronda`);

  const lote = candidatos.slice(0, tope);
  const pendientesDespues = candidatos.length - lote.length;

  if (lote.length === 0) {
    return { ok: true, encolados: 0, pendientesDespues: 0, mensaje: 'No hay vencimientos pendientes de ronda (revisa que tengan teléfono y mes vencido).' };
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
          if (cliDoc.exists) {
            const c = cliDoc.data();
            nombre = c.nombre || c.nombreCompleto || c.razonSocial || '';
          }
        } catch { /* sin nombre, saludo genérico */ }
      }

      const mesTxt = formatearMes(v.fechaVencimiento);
      const equipoTxt = v.descripcionEquipo || 'extintor';
      const plural = (v.cantidad || 1) > 1;

      const msg = `Hola${nombre ? ' ' + nombre : ''} 👋\n\n` +
        `Te recordamos que ${plural ? `tus ${v.cantidad} equipos` : 'tu equipo'} ` +
        `*${equipoTxt}* ${plural ? 'vencieron' : 'venció'} su recarga en *${mesTxt}*. ` +
        `Un extintor vencido no te protege en una emergencia 🧯\n\n` +
        `¿Agendamos la recarga? Tenemos servicio a domicilio — responde este mensaje y te atendemos de una vez 😊`;

      const ok = await notificarClienteWhatsApp(adminId, v.telefono, msg);
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

module.exports = {
  notificarClienteWhatsApp,
  ejecutarCobranzaCxC,
  iniciarCronCobranzaAnny,
  ejecutarRondaVencimientos,
  iniciarCronRondasVencimientos
};
// FIN annyNotificaciones.js
