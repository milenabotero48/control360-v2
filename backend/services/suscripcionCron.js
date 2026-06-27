// ============================================================
// Control360 — Cron de recordatorios de suscripción
// Ubicación: backend/services/suscripcionCron.js
// ------------------------------------------------------------
// SIN dependencias externas — usa setInterval nativo de Node.js
// Revisa cada 15 minutos si es hora de ejecutar (9 AM Colombia)
// y garantiza una sola ejecución por día.
// ============================================================

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
// Sin node-cron: usa setInterval cada 15 min y rastrea la última ejecución.
// 9:00 AM Colombia = hora UTC 14 (UTC-5).
let ultimaEjecucion = null;

const iniciarCron = () => {
  const verificarYEjecutar = () => {
    const ahoraCO  = new Date(Date.now() - 5 * 3600 * 1000);
    const fechaHoy = ahoraCO.toISOString().slice(0, 10);
    const hora     = ahoraCO.getUTCHours(); // ya ajustado a CO

    // Ejecutar una vez al día entre las 9:00 y 9:14 AM Colombia
    if (hora === 9 && ultimaEjecucion !== fechaHoy) {
      ultimaEjecucion = fechaHoy;
      ejecutarCron().catch(e => console.error('[CRON] Error:', e.message));
    }
  };

  // Revisar cada 15 minutos
  setInterval(verificarYEjecutar, 15 * 60 * 1000);
  // También verificar al arrancar por si el servidor reinició cerca de las 9 AM
  verificarYEjecutar();
  console.log('✅ Cron de suscripciones activo — corre diario a las 9:00 AM Colombia');
};

module.exports = { iniciarCron, ejecutarCron };

// ═════════════════════════════════════════════════════════════════════════════
// CRON WHATSAPP — Recordatorios de vencimiento por mes
// ─────────────────────────────────────────────────────────────────────────────
// Reglas validadas con Sandra (Jun 2026):
//   · Solo aplica cuando WhatsApp está activo para el tenant
//   · Envía en los ÚLTIMOS 5 DÍAS HÁBILES del mes ANTERIOR al vencimiento
//   · Distribuye la base entre los días disponibles (ej: 2000 / 5 = 400/día)
//   · No envía sábados ni domingos
//   · Un solo mensaje por cliente por ciclo (candado wa_mensajes)
//   · Se activa automáticamente cuando Meta apruebe la cuenta
// ═════════════════════════════════════════════════════════════════════════════

// Festivos Colombia 2026 (formato YYYY-MM-DD)
const FESTIVOS_CO_2026 = new Set([
  '2026-01-01','2026-01-12','2026-03-23','2026-04-02','2026-04-03',
  '2026-05-01','2026-05-18','2026-06-08','2026-06-15','2026-06-29',
  '2026-07-20','2026-08-07','2026-08-17','2026-10-12','2026-11-02',
  '2026-11-16','2026-12-08','2026-12-25',
]);

const esDiaHabil = (fechaStr) => {
  const d = new Date(`${fechaStr}T12:00:00-05:00`);
  const dia = d.getDay(); // 0=dom, 6=sab
  return dia !== 0 && dia !== 6 && !FESTIVOS_CO_2026.has(fechaStr);
};

// Contar días hábiles restantes en el mes actual (desde hoy hasta fin de mes)
const diasHabilesRestantesMes = (hoy) => {
  const [y, m] = hoy.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(y, m, 0)).getDate(); // último día del mes
  let count = 0;
  for (let d = parseInt(hoy.slice(8), 10); d <= ultimoDia; d++) {
    const fecha = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (esDiaHabil(fecha)) count++;
  }
  return count;
};

// Mes siguiente al actual → es el mes de vencimiento a recordar
const mesSiguiente = (yyyymm) => {
  const [y, m] = yyyymm.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2,'0')}`;
};

const ejecutarCronWhatsapp = async () => {
  const ahoraCO  = new Date(Date.now() - 5 * 3600 * 1000);
  const hoy      = ahoraCO.toISOString().slice(0, 10);
  const mesActual = hoy.slice(0, 7);

  // Solo ejecutar en días hábiles
  if (!esDiaHabil(hoy)) {
    console.log('[WA-CRON] Día no hábil — sin envíos');
    return;
  }

  // Días hábiles restantes en el mes (incluyendo hoy)
  const diasHabiles = diasHabilesRestantesMes(hoy);

  // Solo enviar en los últimos 5 días hábiles del mes
  if (diasHabiles > 5) {
    console.log(`[WA-CRON] Faltan ${diasHabiles} días hábiles — aún no es momento de enviar`);
    return;
  }

  console.log(`[WA-CRON] Iniciando — ${diasHabiles} día(s) hábil(es) restantes en el mes`);

  // Mes de vencimiento a notificar = mes siguiente
  const mesVencimiento = mesSiguiente(mesActual);

  try {
    // Obtener todos los vencimientos del mes siguiente (de todos los tenants)
    const snap = await db.collection('vencimientos')
      .where('fechaVencimiento', '>=', `${mesVencimiento}-01`)
      .where('fechaVencimiento', '<=', `${mesVencimiento}-31`)
      .where('gestionado', '==', false)
      .get();

    if (snap.empty) {
      console.log('[WA-CRON] Sin vencimientos para el mes siguiente');
      return;
    }

    // Agrupar por tenant (adminId)
    const porTenant = {};
    snap.docs.forEach(doc => {
      const d = doc.data();
      if (!d.adminId || !d.clienteId) return;
      if (!porTenant[d.adminId]) porTenant[d.adminId] = {};
      const cKey = d.clienteId;
      if (!porTenant[d.adminId][cKey]) porTenant[d.adminId][cKey] = { clienteId: d.clienteId, telefono: d.telefono, equipos: [] };
      porTenant[d.adminId][cKey].equipos.push(d.descripcionEquipo + (d.cantidad > 1 ? ` ×${d.cantidad}` : ''));
    });

    for (const [adminId, clientes] of Object.entries(porTenant)) {
      // Verificar que el tenant tiene WhatsApp activo
      const cfgDoc = await db.collection('whatsapp_config').doc(adminId).get();
      if (!cfgDoc.exists || !cfgDoc.data().activo) continue;

      const totalClientes = Object.keys(clientes).length;
      // Distribuir: cuántos enviar hoy
      const porDia = Math.ceil(totalClientes / Math.max(diasHabiles, 1));

      // Ver cuántos ya se enviaron hoy para este tenant
      const yaEnviadosHoy = await db.collection('wa_mensajes')
        .where('adminId', '==', adminId)
        .where('contexto', '==', `vencimiento:${mesVencimiento}`)
        .where('fechaEnvio', '==', hoy)
        .get();

      const enviadosHoy = yaEnviadosHoy.size;
      const pendienteHoy = Math.max(porDia - enviadosHoy, 0);

      if (pendienteHoy === 0) {
        console.log(`[WA-CRON] Tenant ${adminId}: cuota del día cumplida`);
        continue;
      }

      // Ver cuáles ya recibieron mensaje este ciclo
      const yaContactados = new Set();
      const contactadosSnap = await db.collection('wa_mensajes')
        .where('adminId', '==', adminId)
        .where('contexto', '==', `vencimiento:${mesVencimiento}`)
        .get();
      contactadosSnap.docs.forEach(d => yaContactados.add(d.data().telefono));

      // Seleccionar los pendientes de este ciclo
      const pendientes = Object.values(clientes)
        .filter(c => c.telefono && !yaContactados.has(c.telefono))
        .slice(0, pendienteHoy);

      console.log(`[WA-CRON] Tenant ${adminId}: enviando ${pendientes.length}/${totalClientes} mensajes hoy`);

      // Obtener datos del tenant para el mensaje
      const userDoc = await db.collection('users').doc(adminId).get();
      const empresaNombre = userDoc.exists ? (userDoc.data().empresa || 'Control360') : 'Control360';

      for (const cliente of pendientes) {
        // Obtener teléfono del cliente si no está en el vencimiento
        let telefono = cliente.telefono;
        if (!telefono && cliente.clienteId) {
          const cliDoc = await db.collection('clients').doc(cliente.clienteId).get();
          if (cliDoc.exists) telefono = cliDoc.data().celular || cliDoc.data().telefono;
        }
        if (!telefono) continue;

        const listaEquipos = cliente.equipos.join(', ');
        const variables = [
          userDoc.exists ? (userDoc.data().nombre || empresaNombre) : empresaNombre,
          listaEquipos,
          mesVencimiento,
        ];

        try {
          const { enviarPlantilla } = require('./services/whatsappService');
          await enviarPlantilla({
            adminId,
            telefono,
            plantilla: 'recordatorio_vencimiento',
            variables,
            contexto: `vencimiento:${mesVencimiento}`,
            ordenId: null,
          });
          // Registrar fecha de envío para el control de cuota diaria
          await db.collection('wa_mensajes')
            .where('adminId', '==', adminId)
            .where('telefono', '==', telefono)
            .where('contexto', '==', `vencimiento:${mesVencimiento}`)
            .limit(1).get().then(s => {
              if (!s.empty) s.docs[0].ref.update({ fechaEnvio: hoy });
            });
        } catch (e) {
          console.error(`[WA-CRON] Error enviando a ${telefono}:`, e.message);
        }

        // Pausa entre mensajes para no saturar la API
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log('[WA-CRON] Ciclo completado');
  } catch (e) {
    console.error('[WA-CRON] Error general:', e.message);
  }
};

// Iniciar cron de WhatsApp — se activa desde iniciarCron()
// Separado del cron de suscripciones para no mezclar responsabilidades
let ultimaEjecucionWA = null;

const iniciarCronWhatsapp = () => {
  const verificar = () => {
    const ahoraCO  = new Date(Date.now() - 5 * 3600 * 1000);
    const fechaHoy = ahoraCO.toISOString().slice(0, 10);
    const hora     = ahoraCO.getUTCHours();
    // Correr a las 9:30 AM Colombia (distinto al cron de suscripciones)
    if (hora === 9 && ahoraCO.getMinutes() >= 30 && ultimaEjecucionWA !== fechaHoy) {
      ultimaEjecucionWA = fechaHoy;
      ejecutarCronWhatsapp().catch(e => console.error('[WA-CRON]', e.message));
    }
  };
  setInterval(verificar, 15 * 60 * 1000);
  verificar();
  console.log('✅ Cron WhatsApp vencimientos activo — corre en días hábiles a las 9:30 AM Colombia');
};

module.exports = { iniciarCron, ejecutarCron, iniciarCronWhatsapp, ejecutarCronWhatsapp };

