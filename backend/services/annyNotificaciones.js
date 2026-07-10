// ============================================================
// Control360 — Notificaciones salientes vía Anny (Baileys)
// Ubicación: backend/services/annyNotificaciones.js
// FIX ANNY-NOTIF-001
// ============================================================
// PROPÓSITO: que los módulos operativos (taller, órdenes, CxC)
// puedan avisar al cliente por WhatsApp a través de la línea
// conectada de Anny, SIN acoplarse a Baileys directamente.
//
// PRINCIPIOS:
// 1. Fire-and-forget: si Anny no está activa o conectada, se
//    omite el envío en silencio — NUNCA rompe el módulo que llama.
// 2. Gate multi-tenant: solo envía si el tenant tiene 'anny_ia'.
// 3. Cobranza CxC: cron los viernes 9:00 AM Colombia, órdenes en
//    CxC con más de 10 días de completadas, dosificado (1 msg / 4s)
//    y con marca ultimaCobranzaAnny para no duplicar el mismo día.
// ============================================================

const { db } = require('../config/firebase');
const annyService = require('./annyService');
const baileysService = require('./baileysService');

// ─── Helper: fecha Firestore/ISO → ISO string ────────────────
function aISO(f) {
  if (!f) return null;
  if (typeof f === 'string') return f;
  if (f.toDate) return f.toDate().toISOString();
  if (f._seconds) return new Date(f._seconds * 1000).toISOString();
  if (f.seconds) return new Date(f.seconds * 1000).toISOString();
  return null;
}

// ============================================================
// Enviar un WhatsApp a un cliente por la línea de Anny.
// Retorna true si se envió, false si se omitió (sin conexión,
// módulo inactivo, celular inválido) — nunca lanza excepción.
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
      // Registrar en el historial para que quede visible en el panel
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
    // Solo tenants con Anny conectada
    const cfgSnap = await db.collection('annyConfig')
      .where('conexionEstado', '==', 'conectado')
      .get();

    const hoyStr = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

    for (const cfgDoc of cfgSnap.docs) {
      const adminId = cfgDoc.id;

      const activo = await annyService.tenantTieneAnnyActiva(adminId);
      if (!activo) continue;

      // Órdenes en cartera del tenant
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

          // Días desde que la orden se completó (mismo criterio de
          // cartera que cxc.js: fecha de factura como respaldo)
          const fechaCompletada =
            (o.historialEstados || []).find(h => h.estado === 'completada')?.fecha ||
            (o.historialEstados || []).find(h => h.estado === 'cxc')?.fecha ||
            aISO(o.fechaFactura) ||
            aISO(o.createdAt);

          if (!fechaCompletada) continue;
          const dias = Math.floor((Date.now() - new Date(fechaCompletada).getTime()) / 86400000);
          if (dias <= 10) continue;

          // No duplicar si ya se envió hoy (protege contra reinicios)
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

          // Dosificar envíos (anti-bloqueo de la línea): 1 cada 4 segundos
          await new Promise(r => setTimeout(r, 4000));
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
// Cron: viernes 9:00 AM Colombia (mismo patrón que suscripcionCron:
// setInterval de 15 min + una sola ejecución por día)
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
  iniciarCronCobranzaAnny
};
// FIN annyNotificaciones.js
