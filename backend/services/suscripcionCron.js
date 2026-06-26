// ============================================================
// Control360 — Cron de recordatorios de suscripción
// Ubicación: backend/services/suscripcionCron.js
// ------------------------------------------------------------
// Se ejecuta diariamente a las 9:00 AM Colombia (UTC-5 = 14:00 UTC)
// usando node-cron (ya disponible en el proyecto vía Railway).
//
// REGLAS:
//   Día -4: email + el admin recibe aviso
//   Día -1: email urgente
//   Día  0: email último aviso
//   Día +1 en adelante: solo la barra en app (sin email extra)
//
// R-COM-07 adaptado: máximo 1 email de recordatorio por
// suscriptor cada 3 días (evita spam si el cron corre varias veces).
// ============================================================

const cron   = require('node-cron');
const { db, admin } = require('../config/firebase');
const { Resend }    = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Datos bancarios desde variables de entorno ──────────────────────────────
const BANCO = {
  nombre:   process.env.BANCO_NOMBRE   || 'Milena Botero',
  entidad:  process.env.BANCO_ENTIDAD  || 'Bancolombia',
  tipo:     process.env.BANCO_TIPO     || 'Ahorros',
  numero:   process.env.BANCO_NUMERO   || '',
  cc:       process.env.BANCO_CC       || '',
};
const ADMIN_EMAIL     = process.env.ADMIN_EMAIL     || 'tucontrol360@gmail.com';
const ADMIN_WHATSAPP  = process.env.ADMIN_WHATSAPP  || '573234152442';
const FRONTEND_URL    = process.env.FRONTEND_URL    || 'https://app.tucontrol360.com';
const LANDING_PLANES  = 'https://tucontrol360.com/#planes';

const NOMBRE_PLAN = {
  punto_venta:   'Punto de Venta — $50.000/mes',
  independiente: 'Independiente — $75.000/mes',
  empresa:       'Empresa — $100.000/mes',
  super_pro:     'Super Pro',
};

const PRECIO_PLAN = {
  punto_venta:   '$50.000',
  independiente: '$75.000',
  empresa:       '$100.000',
  super_pro:     'Acordado',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const hoyColombia = () =>
  new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

const diasRestantes = (fechaVencimiento) => {
  if (!fechaVencimiento) return null;
  const fin  = new Date(`${String(fechaVencimiento).slice(0, 10)}T23:59:59-05:00`);
  const ahora = new Date();
  return Math.ceil((fin - ahora) / (1000 * 60 * 60 * 24));
};

// ─── Bloque HTML reutilizable: datos de pago ─────────────────────────────────
const htmlDatosPago = (plan, urgente = false) => `
  <div style="background:${urgente ? '#fff8e6' : '#f5f3ff'};border-radius:12px;padding:20px 22px;margin:20px 0;border:1.5px solid ${urgente ? '#f3d98a' : '#c4b5fd'};">
    <div style="font-size:11px;font-weight:800;color:${urgente ? '#8a6d1a' : '#6d28d9'};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">
      💳 DATOS PARA EL PAGO
    </div>
    <table style="width:100%;font-size:13.5px;color:#374151;border-collapse:collapse;">
      <tr><td style="padding:4px 0;color:#6b7280;width:40%;">Entidad</td><td style="font-weight:700;">${BANCO.entidad}</td></tr>
      <tr><td style="padding:4px 0;color:#6b7280;">Tipo de cuenta</td><td style="font-weight:700;">${BANCO.tipo}</td></tr>
      <tr><td style="padding:4px 0;color:#6b7280;">Número</td><td style="font-weight:700;">${BANCO.numero}</td></tr>
      <tr><td style="padding:4px 0;color:#6b7280;">Titular</td><td style="font-weight:700;">${BANCO.nombre}</td></tr>
      <tr><td style="padding:4px 0;color:#6b7280;">CC</td><td style="font-weight:700;">${BANCO.cc}</td></tr>
      <tr><td style="padding:4px 0;color:#6b7280;">Valor</td><td style="font-weight:800;color:#7c3aed;font-size:15px;">${PRECIO_PLAN[plan] || plan}</td></tr>
    </table>
  </div>`;

const htmlBotonesAccion = (nombreEmpresa, plan) => {
  const msgWA = encodeURIComponent(
    `Hola Sandra, acabo de realizar el pago de mi suscripción Control360 — ${NOMBRE_PLAN[plan] || plan}. Te adjunto el comprobante. Empresa: ${nombreEmpresa}`
  );
  return `
  <div style="margin:20px 0;">
    <a href="https://wa.me/${ADMIN_WHATSAPP}?text=${msgWA}"
       style="display:block;text-align:center;background:#25D366;color:white;padding:13px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;margin-bottom:10px;">
      📱 Enviar comprobante por WhatsApp
    </a>
    <a href="${LANDING_PLANES}"
       style="display:block;text-align:center;background:#f5f3ff;color:#7c3aed;padding:12px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;border:1.5px solid #c4b5fd;">
      ⬆ Actualizar mi plan
    </a>
  </div>`;
};

// ─── Enviar email de recordatorio ────────────────────────────────────────────
const enviarRecordatorio = async ({ email, nombre, plan, diasRestantes: dias, fechaVencimiento }) => {
  const nombreCorto  = String(nombre || 'Cliente').split(' ')[0];
  const venceTxt     = fechaVencimiento || '—';
  const urgente      = dias <= 1;
  const vencido      = dias < 0;

  let asunto, titulo, mensaje;

  if (vencido) {
    asunto  = `⛔ Tu suscripción Control360 ha vencido`;
    titulo  = `Tu suscripción ha vencido`;
    mensaje = `Tu plan <strong>${NOMBRE_PLAN[plan] || plan}</strong> venció el <strong>${venceTxt}</strong>. Para continuar usando Control360 sin interrupciones, realiza el pago y envíanos el comprobante.`;
  } else if (dias === 0) {
    asunto  = `🔴 Hoy vence tu suscripción Control360`;
    titulo  = `Hoy es el último día`;
    mensaje = `Tu plan <strong>${NOMBRE_PLAN[plan] || plan}</strong> vence <strong>hoy</strong>. Realiza el pago para no perder el acceso a tu operación.`;
  } else if (dias === 1) {
    asunto  = `🟠 Mañana vence tu suscripción Control360`;
    titulo  = `Mañana vence tu suscripción`;
    mensaje = `Tu plan <strong>${NOMBRE_PLAN[plan] || plan}</strong> vence <strong>mañana ${venceTxt}</strong>. Realiza el pago hoy para no perder el acceso.`;
  } else {
    asunto  = `⚠️ Tu suscripción Control360 vence en ${dias} días`;
    titulo  = `Tu suscripción vence en ${dias} días`;
    mensaje = `Tu plan <strong>${NOMBRE_PLAN[plan] || plan}</strong> vence el <strong>${venceTxt}</strong>. Tienes ${dias} días para renovar.`;
  }

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;">
      <div style="text-align:center;margin-bottom:24px;">
        <span style="font-size:26px;font-weight:900;color:#0D1B2A;">Control<span style="color:#7c3aed;">360</span></span>
      </div>
      <div style="background:${vencido ? '#fef2f2' : urgente ? '#fff8e6' : '#f5f3ff'};border-radius:12px;padding:18px 20px;margin-bottom:20px;border-left:4px solid ${vencido ? '#dc2626' : urgente ? '#f59e0b' : '#7c3aed'};">
        <h2 style="margin:0 0 8px;color:${vencido ? '#b91c1c' : urgente ? '#b45309' : '#4c1d95'};font-size:18px;">${titulo}</h2>
        <p style="margin:0;color:#374151;font-size:13.5px;line-height:1.6;">${mensaje}</p>
      </div>
      <p style="color:#374151;font-size:13px;">Hola <strong>${nombreCorto}</strong>, para renovar tu suscripción realiza una transferencia con los siguientes datos:</p>
      ${htmlDatosPago(plan, urgente || vencido)}
      ${htmlBotonesAccion(nombre, plan)}
      <div style="background:#f9fafb;border-radius:10px;padding:14px 16px;margin-top:16px;">
        <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6;">
          Una vez realizado el pago, envíanos el comprobante por WhatsApp al número indicado arriba.<br>
          Tu cuenta será activada en menos de 2 horas hábiles.<br><br>
          ¿Tienes preguntas? Escríbenos a <a href="mailto:tucontrol360@gmail.com" style="color:#7c3aed;">tucontrol360@gmail.com</a>
        </p>
      </div>
      <div style="text-align:center;margin-top:24px;">
        <a href="${FRONTEND_URL}" style="font-size:12px;color:#9ca3af;">Ingresar a Control360</a>
      </div>
    </div>`;

  await resend.emails.send({
    from:    'Control360 <noreply@tucontrol360.com>',
    to:      email,
    subject: asunto,
    html,
  });
};

// ─── Notificar al admin cuando hay suscriptores próximos a vencer ─────────────
const notificarAdmin = async (proximos) => {
  if (!proximos.length) return;
  const filas = proximos.map(s =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${s.nombre || s.email}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${NOMBRE_PLAN[s.plan] || s.plan}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:700;color:${s.dias <= 1 ? '#b91c1c' : '#b45309'};">
        ${s.dias <= 0 ? `Venció hace ${Math.abs(s.dias)} día(s)` : `${s.dias} día(s)`}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${s.email}</td>
    </tr>`
  ).join('');

  await resend.emails.send({
    from:    'Control360 <noreply@tucontrol360.com>',
    to:      ADMIN_EMAIL,
    subject: `⚠️ Control360 — ${proximos.length} suscriptor(es) próximos a vencer`,
    html: `
      <div style="font-family:sans-serif;max-width:620px;margin:0 auto;padding:32px;">
        <h2 style="color:#0D1B2A;">Panel de vencimientos — Control360</h2>
        <p style="color:#374151;">Los siguientes suscriptores vencen pronto o ya vencieron:</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#0D1B2A;color:white;">
              <th style="padding:10px 12px;text-align:left;">Cliente</th>
              <th style="padding:10px 12px;text-align:left;">Plan</th>
              <th style="padding:10px 12px;text-align:left;">Días restantes</th>
              <th style="padding:10px 12px;text-align:left;">Email</th>
            </tr>
          </thead>
          <tbody>${filas}</tbody>
        </table>
        <p style="font-size:12px;color:#9ca3af;margin-top:20px;">
          Gestiona las suscripciones en el <a href="${FRONTEND_URL}" style="color:#7c3aed;">Panel de Suscriptores</a>
        </p>
      </div>`,
  });
};

// ─── Job principal ────────────────────────────────────────────────────────────
const ejecutarCron = async () => {
  console.log('[CRON] Revisando suscripciones...');
  try {
    const snap = await db.collection('suscripciones').get();
    if (snap.empty) { console.log('[CRON] Sin suscripciones'); return; }

    const proximos = []; // para notificar al admin

    for (const doc of snap.docs) {
      const sus     = doc.data();
      const adminId = doc.id;
      if (sus.estado === 'suspendido') continue;

      const dias = diasRestantes(sus.fechaVencimiento);
      if (dias === null) continue;

      // Solo procesamos si está en rango de alerta (-1 a 4 días)
      const enRango = dias <= 4;
      if (!enRango) continue;

      // Obtener datos del usuario admin del tenant
      let userData = null;
      try {
        const userDoc = await db.collection('users').doc(adminId).get();
        if (!userDoc.exists) continue;
        userData = userDoc.data();
      } catch (e) { continue; }

      if (!userData?.email) continue;

      // Candado: no enviar si ya enviamos en las últimas 72 horas
      const yaEnviado = sus.ultimoRecordatorio
        ? (Date.now() - new Date(sus.ultimoRecordatorio).getTime()) < 72 * 3600 * 1000
        : false;

      if (!yaEnviado) {
        try {
          await enviarRecordatorio({
            email:           userData.email,
            nombre:          userData.empresa || userData.nombre || userData.email,
            plan:            sus.plan,
            diasRestantes:   dias,
            fechaVencimiento: sus.fechaVencimiento,
          });
          // Registrar envío para el candado de 72 horas
          await doc.ref.update({ ultimoRecordatorio: new Date().toISOString() });
          console.log(`[CRON] Email enviado a ${userData.email} (${dias} días)`);
        } catch (e) {
          console.error(`[CRON] Error enviando a ${userData.email}:`, e.message);
        }
      }

      // Agregar al resumen del admin (independiente del candado)
      proximos.push({
        nombre: userData.empresa || userData.nombre,
        email:  userData.email,
        plan:   sus.plan,
        dias,
      });
    }

    // Notificar al admin si hay vencimientos próximos
    if (proximos.length) {
      try { await notificarAdmin(proximos); } catch (e) {
        console.error('[CRON] Error notificando admin:', e.message);
      }
    }

    console.log(`[CRON] Completado. ${proximos.length} suscriptor(es) en rango de alerta.`);
  } catch (e) {
    console.error('[CRON] Error general:', e.message);
  }
};

// ─── Inicializar el cron (llamar desde server.js) ────────────────────────────
// 9:00 AM Colombia = 14:00 UTC
const iniciarCron = () => {
  cron.schedule('0 14 * * *', ejecutarCron, { timezone: 'UTC' });
  console.log('✅ Cron de suscripciones activo — corre diario a las 9:00 AM Colombia');
};

module.exports = { iniciarCron, ejecutarCron };
