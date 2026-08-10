// ═══════════════════════════════════════════════════════════════════════════════
// novedades.js — Anuncios a suscriptores y avisos del calendario
// ─────────────────────────────────────────────────────────────────────────────
// NOVEDADES-001
//
// EL PROBLEMA QUE RESUELVE
// ------------------------
// Cuando se publica una mejora, nadie se entera. Peor: cuando un cambio altera
// cómo se trabaja —como mover el registro de nómina a su propio módulo— el
// suscriptor sigue haciéndolo como antes y el error persiste.
//
// Una funcionalidad que nadie conoce no existe. Este módulo es el canal.
//
// DOS FUENTES DE NOVEDADES
//   1. MANUALES  · las publica el superadmin desde el panel
//   2. AUTOMÁTICAS · las genera el calendario laboral colombiano
//                    (cesantías en febrero, prima en junio y diciembre...)
//
// DOS CANALES DE ENTREGA
//   · En la app  · campanita siempre; banner solo si es crítica
//   · Por correo · opcional, con la misma infraestructura del cobro (Resend)
//
// COLECCIONES
//   novedades           · el anuncio en sí
//   novedades_lecturas  · qué suscriptor leyó qué (un doc por par)
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const { Resend } = require('resend');
const C = require('../services/calendarioColombia');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.tucontrol360.com';
const REMITENTE = 'Control360 <noreply@tucontrol360.com>';

// ─── Cliente de correo perezoso ──────────────────────────────────────────────
// `new Resend()` lanza excepción si falta la API key. Si se instancia al cargar
// el módulo, una variable de entorno mal configurada tumba TODO el servidor —
// no solo el envío de correos, sino la API completa.
//
// Instanciándolo solo al momento de enviar, el peor caso es que las novedades
// no salgan por correo (y quede el error en el log), pero el sistema sigue
// funcionando y la novedad igual se publica dentro de la app.
let _resend = null;
const getResend = () => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY no está configurada — la novedad se publicó en la app pero no se pudo enviar por correo');
  }
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
};

const resolverAdminId = (req) => req.adminId || req.user?.uid || req.user?.id || null;

// ─── Tipos de novedad ────────────────────────────────────────────────────────
const TIPOS = {
  nueva_funcion: { etiqueta: 'Nueva función',    icono: '🚀', color: '#4f46e5' },
  mejora:        { etiqueta: 'Mejora',            icono: '✨', color: '#0284c7' },
  importante:    { etiqueta: 'Aviso importante',  icono: '⚠️', color: '#dc2626' },
  correccion:    { etiqueta: 'Corrección',        icono: '🔧', color: '#059669' },
  obligacion:    { etiqueta: 'Obligación legal',  icono: '📅', color: '#b45309' },
  recordatorio:  { etiqueta: 'Recordatorio',      icono: '💡', color: '#7c3aed' },
  parametro:     { etiqueta: 'Actualización',     icono: '⚙️', color: '#64748b' },
};

// ─── Solo el superadmin publica ──────────────────────────────────────────────
const soloSuperAdmin = async (req, res, next) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();
    if (!doc.exists || doc.data().superAdmin !== true) {
      return res.status(403).json({ error: 'Acceso restringido' });
    }
    req.superAdminNombre = doc.data().nombre || doc.data().email || 'Control360';
    next();
  } catch (e) {
    console.error('soloSuperAdmin novedades:', e);
    res.status(500).json({ error: 'Error verificando permisos' });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Markdown mínimo → HTML
// ─────────────────────────────────────────────────────────────────────────────
// Solo lo que se usa al escribir un anuncio: negrita, viñetas y saltos de
// párrafo. No se usa una librería para no agregar una dependencia por esto.
// Se escapa el HTML de entrada: el contenido lo escribe el superadmin, pero
// igual no hay razón para permitir etiquetas arbitrarias en un correo.
// ═════════════════════════════════════════════════════════════════════════════
const escaparHtml = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const markdownSimple = (texto) => {
  const lineas = escaparHtml(texto).split('\n');
  const salida = [];
  let enLista = false;

  for (const linea of lineas) {
    const t = linea.trim();
    const esVinneta = /^[·\-*]\s+/.test(t);

    if (esVinneta) {
      if (!enLista) { salida.push('<ul style="margin:8px 0;padding-left:20px;">'); enLista = true; }
      salida.push(`<li style="margin:4px 0;color:#374151;font-size:13.5px;line-height:1.6;">${t.replace(/^[·\-*]\s+/, '')}</li>`);
      continue;
    }
    if (enLista) { salida.push('</ul>'); enLista = false; }
    if (!t) continue;
    salida.push(`<p style="margin:0 0 10px;color:#374151;font-size:13.5px;line-height:1.65;">${t}</p>`);
  }
  if (enLista) salida.push('</ul>');

  return salida.join('')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#111827;">$1</strong>');
};

// ═════════════════════════════════════════════════════════════════════════════
// Plantilla del correo — mismo estilo visual que los correos de cobro
// ═════════════════════════════════════════════════════════════════════════════
const htmlNovedad = (novedad, nombreSuscriptor) => {
  const t = TIPOS[novedad.tipo] || TIPOS.mejora;
  const saludo = (nombreSuscriptor || '').split(' ')[0] || '';

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#ffffff;">
    <div style="text-align:center;margin-bottom:26px;">
      <div style="font-size:22px;font-weight:800;color:#0D1B2A;letter-spacing:-0.5px;">Control <span style="color:#7c3aed;">360</span></div>
      <div style="font-size:10px;color:#9ca3af;letter-spacing:2px;text-transform:uppercase;margin-top:2px;">Sistema Operativo Empresarial</div>
    </div>

    <div style="background:${t.color}12;border-left:4px solid ${t.color};border-radius:10px;padding:16px 18px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:800;color:${t.color};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">
        ${t.icono} ${t.etiqueta}
      </div>
      <div style="font-size:18px;font-weight:800;color:#0D1B2A;line-height:1.35;">${escaparHtml(novedad.titulo)}</div>
      ${novedad.fechaLimite ? `<div style="font-size:12px;color:${t.color};font-weight:700;margin-top:6px;">Fecha límite: ${novedad.fechaLimite}</div>` : ''}
    </div>

    ${saludo ? `<p style="color:#374151;font-size:13.5px;margin:0 0 14px;">Hola <strong>${escaparHtml(saludo)}</strong>,</p>` : ''}

    <div style="margin-bottom:22px;">${markdownSimple(novedad.cuerpo)}</div>

    <div style="text-align:center;margin:26px 0;">
      <a href="${FRONTEND_URL}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#ffffff;text-decoration:none;padding:13px 30px;border-radius:9px;font-size:14px;font-weight:700;">
        ${escaparHtml(novedad.accion?.texto || 'Ingresar a Control360')}
      </a>
    </div>

    <div style="background:#f9fafb;border-radius:10px;padding:14px 16px;margin-top:20px;">
      <p style="margin:0;font-size:11.5px;color:#6b7280;line-height:1.6;">
        ¿Dudas sobre este cambio? Escribinos a
        <a href="mailto:tucontrol360@gmail.com" style="color:#7c3aed;">tucontrol360@gmail.com</a>
        o por WhatsApp desde la aplicación.
      </p>
    </div>

    <div style="text-align:center;margin-top:22px;padding-top:16px;border-top:1px solid #f3f4f6;">
      <span style="font-size:11px;color:#9ca3af;">Control360 · Este mensaje se envía a los suscriptores activos.</span>
    </div>
  </div>`;
};

// ═════════════════════════════════════════════════════════════════════════════
// Destinatarios: admins activos con correo
// ═════════════════════════════════════════════════════════════════════════════
const cargarDestinatarios = async (soloConEmpleados = false) => {
  const snap = await db.collection('users').get();
  const lista = [];
  const candidatos = [];

  snap.forEach(d => {
    const u = d.data();
    if (u.role !== 'admin') return;
    if (u.activo === false) return;
    if (!u.email) return;
    candidatos.push({ adminId: d.id, nombre: u.nombre || u.empresa || '', email: u.email });
  });

  // Los avisos de nómina solo tienen sentido para quien tiene empleados cargados
  if (!soloConEmpleados) return candidatos;

  for (const c of candidatos) {
    const emp = await db.collection('empleados')
      .where('userId', '==', c.adminId).limit(1).get();
    if (!emp.empty) lista.push(c);
  }
  return lista;
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/novedades — las que le corresponden al suscriptor
// ─────────────────────────────────────────────────────────────────────────────
// Devuelve las novedades publicadas, marcando cuáles ya leyó. La campanita usa
// `sinLeer` para el punto rojo y `banner` para lo crítico sin leer.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'No autenticado' });

    const [novSnap, lecSnap] = await Promise.all([
      db.collection('novedades').where('publicada', '==', true).get(),
      db.collection('novedades_lecturas').where('adminId', '==', adminId).get()
    ]);

    const leidas = new Set();
    lecSnap.forEach(d => leidas.add(d.data().novedadId));

    const lista = [];
    novSnap.forEach(d => {
      const n = d.data();
      // Las novedades dirigidas a un suscriptor puntual no le llegan al resto
      if (Array.isArray(n.destinatarios) && n.destinatarios.length > 0 &&
          !n.destinatarios.includes(adminId)) return;
      lista.push({
        id: d.id,
        tipo: n.tipo,
        titulo: n.titulo,
        cuerpo: n.cuerpo,
        critico: n.critico === true,
        accion: n.accion || null,
        fechaLimite: n.fechaLimite || null,
        automatica: n.automatica === true,
        publicadaEn: n.publicadaEn,
        leida: leidas.has(d.id)
      });
    });

    lista.sort((a, b) => String(b.publicadaEn).localeCompare(String(a.publicadaEn)));

    const sinLeer = lista.filter(n => !n.leida);

    res.json({
      total: lista.length,
      sinLeer: sinLeer.length,
      // La más crítica sin leer es la que se muestra como banner
      banner: sinLeer.find(n => n.critico) || null,
      novedades: lista.slice(0, 40),
      tipos: TIPOS
    });
  } catch (e) {
    console.error('GET novedades:', e);
    res.status(500).json({ error: 'Error al cargar novedades' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/novedades/:id/leer — marcar como leída
// ═════════════════════════════════════════════════════════════════════════════
router.post('/:id/leer', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    // Un id compuesto hace la operación idempotente sin consultar antes
    const docId = `${adminId}_${req.params.id}`;
    await db.collection('novedades_lecturas').doc(docId).set({
      adminId,
      novedadId: req.params.id,
      leidaEn: new Date().toISOString(),
      leidaPor: req.user?.email || ''
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST leer novedad:', e);
    res.status(500).json({ error: 'Error al marcar como leída' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/novedades/leer-todas
// ═════════════════════════════════════════════════════════════════════════════
router.post('/leer-todas', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const snap = await db.collection('novedades').where('publicada', '==', true).get();
    const batch = db.batch();
    let n = 0;
    snap.forEach(d => {
      batch.set(db.collection('novedades_lecturas').doc(`${adminId}_${d.id}`), {
        adminId, novedadId: d.id,
        leidaEn: new Date().toISOString(),
        leidaPor: req.user?.email || ''
      }, { merge: true });
      n += 1;
    });
    if (n > 0) await batch.commit();
    res.json({ ok: true, marcadas: n });
  } catch (e) {
    console.error('POST leer-todas:', e);
    res.status(500).json({ error: 'Error al marcar todas' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/novedades — publicar (solo superadmin)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/', soloSuperAdmin, async (req, res) => {
  try {
    const {
      tipo, titulo, cuerpo, critico, enviarCorreo, accion, destinatarios, soloConEmpleados,
      // ✅ NOVEDADES-PRUEBA-001: envío de prueba a la propia casilla del
      // superadmin. Un correo masivo no se puede deshacer: mandarlo primero a
      // uno mismo es la única forma de ver cómo llega de verdad —el formato,
      // los acentos, el botón, cómo se ve en el celular— antes de que lo reciban
      // todos. La novedad NO se publica en modo prueba.
      modoPrueba
    } = req.body;

    // ─── Envío de prueba: no publica nada, solo manda el correo al superadmin ─
    if (modoPrueba === true) {
      const doc = await db.collection('users').doc(req.user.uid).get();
      const miEmail = doc.exists ? doc.data().email : null;
      if (!miEmail) return res.status(400).json({ error: 'Tu usuario no tiene correo registrado' });
      if (!titulo?.trim() || !cuerpo?.trim()) {
        return res.status(400).json({ error: 'Completá el título y el contenido antes de enviar la prueba' });
      }

      const borrador = {
        tipo: TIPOS[tipo] ? tipo : 'mejora',
        titulo: titulo.trim(),
        cuerpo: cuerpo.trim(),
        accion: accion?.texto ? { texto: accion.texto, modulo: accion.modulo || '' } : null
      };
      const t = TIPOS[borrador.tipo];

      try {
        const cliente = getResend();
        await cliente.emails.send({
          from: REMITENTE,
          to: miEmail,
          subject: `[PRUEBA] ${t.icono} ${borrador.titulo}`,
          html: htmlNovedad(borrador, req.superAdminNombre)
        });
      } catch (err) {
        return res.status(500).json({ error: `No se pudo enviar la prueba: ${err.message}` });
      }

      return res.json({
        ok: true,
        prueba: true,
        enviadoA: miEmail,
        mensaje: `Correo de prueba enviado a ${miEmail}. Revisá cómo llegó antes de publicarlo de verdad. La novedad NO se publicó.`
      });
    }

    if (!titulo?.trim()) return res.status(400).json({ error: 'El título es obligatorio' });
    if (!cuerpo?.trim())  return res.status(400).json({ error: 'El contenido es obligatorio' });
    if (!TIPOS[tipo])     return res.status(400).json({ error: 'Tipo de novedad inválido' });

    const nueva = {
      tipo,
      titulo: titulo.trim(),
      cuerpo: cuerpo.trim(),
      critico: critico === true,
      accion: accion?.texto ? { texto: accion.texto, modulo: accion.modulo || '' } : null,
      destinatarios: Array.isArray(destinatarios) ? destinatarios : [],
      automatica: false,
      publicada: true,
      publicadaEn: new Date().toISOString(),
      publicadaPor: req.superAdminNombre,
      correoEnviado: false,
      correosOk: 0,
      correosFallidos: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('novedades').add(nueva);

    // ─── Envío por correo ────────────────────────────────────────────────────
    let resumenCorreo = null;
    if (enviarCorreo === true) {
      resumenCorreo = await enviarNovedadPorCorreo(ref.id, nueva, {
        soloConEmpleados: soloConEmpleados === true,
        destinatarios: nueva.destinatarios
      });
    }

    await db.collection('audit_logs').add({
      accion: 'NOVEDAD_PUBLICADA',
      modulo: 'novedades',
      descripcion: `Novedad publicada: "${nueva.titulo}"` +
                   (enviarCorreo ? ` · correo a ${resumenCorreo?.ok || 0} suscriptor(es)` : ' · sin correo'),
      usuarioId: req.user.uid,
      usuarioNombre: req.superAdminNombre,
      documento: ref.id,
      datos: { tipo, critico: nueva.critico, enviarCorreo: enviarCorreo === true, resumenCorreo },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });

    res.status(201).json({ ok: true, id: ref.id, ...nueva, correo: resumenCorreo });
  } catch (e) {
    console.error('POST novedades:', e);
    res.status(500).json({ error: 'Error al publicar la novedad' });
  }
});

// ─── Envío masivo ────────────────────────────────────────────────────────────
// Se envía de a tandas con una pausa: mandar cientos de correos de golpe hace
// que el proveedor limite el envío y algunos se pierdan en silencio.
async function enviarNovedadPorCorreo(novedadId, novedad, opciones = {}) {
  let destinos = await cargarDestinatarios(opciones.soloConEmpleados === true);

  if (Array.isArray(opciones.destinatarios) && opciones.destinatarios.length > 0) {
    destinos = destinos.filter(d => opciones.destinatarios.includes(d.adminId));
  }

  const t = TIPOS[novedad.tipo] || TIPOS.mejora;
  let ok = 0, fallidos = 0;
  const errores = [];

  // Si no hay servicio de correo configurado, se avisa y se sigue: la novedad
  // ya quedó publicada en la app, que es lo que no se puede perder.
  let cliente;
  try {
    cliente = getResend();
  } catch (e) {
    console.error('[NOVEDADES]', e.message);
    await db.collection('novedades').doc(novedadId).update({
      correoEnviado: false,
      correoError: e.message
    });
    return { total: destinos.length, ok: 0, fallidos: destinos.length, errores: [{ error: e.message }] };
  }

  for (let i = 0; i < destinos.length; i += 10) {
    const tanda = destinos.slice(i, i + 10);
    await Promise.all(tanda.map(async (d) => {
      try {
        await cliente.emails.send({
          from: REMITENTE,
          to: d.email,
          subject: `${t.icono} ${novedad.titulo}`,
          html: htmlNovedad(novedad, d.nombre)
        });
        ok += 1;
      } catch (err) {
        fallidos += 1;
        errores.push({ email: d.email, error: err.message });
        console.error(`Correo novedad falló para ${d.email}:`, err.message);
      }
    }));
    if (i + 10 < destinos.length) await new Promise(r => setTimeout(r, 1100));
  }

  await db.collection('novedades').doc(novedadId).update({
    correoEnviado: ok > 0,
    correosOk: ok,
    correosFallidos: fallidos,
    correoEnviadoEn: new Date().toISOString(),
    // ✅ NOVEDADES-DIAGNOSTICO-001: guardar el motivo del fallo. Sin esto, un
    // envío fallido quedaba como "0 enviados" sin rastro de por qué.
    correoError: fallidos > 0 ? (errores[0]?.error || 'error desconocido') : null
  });

  if (destinos.length === 0) {
    console.warn('[NOVEDADES] Sin destinatarios: no hay admins activos con correo' +
      (opciones.soloConEmpleados ? ' que tengan empleados cargados' : ''));
  }
  if (fallidos > 0) {
    console.error(`[NOVEDADES] ${fallidos} de ${destinos.length} correos fallaron. Primer error:`, errores[0]?.error);
  }

  return { total: destinos.length, ok, fallidos, errores: errores.slice(0, 10) };
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/novedades/admin — todas, con estadísticas de lectura (superadmin)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/admin', soloSuperAdmin, async (req, res) => {
  try {
    const [novSnap, lecSnap, usersSnap] = await Promise.all([
      db.collection('novedades').get(),
      db.collection('novedades_lecturas').get(),
      db.collection('users').get()
    ]);

    let totalSuscriptores = 0;
    usersSnap.forEach(d => {
      const u = d.data();
      if (u.role === 'admin' && u.activo !== false) totalSuscriptores += 1;
    });

    const lecturasPorNovedad = {};
    lecSnap.forEach(d => {
      const l = d.data();
      lecturasPorNovedad[l.novedadId] = (lecturasPorNovedad[l.novedadId] || 0) + 1;
    });

    const lista = [];
    novSnap.forEach(d => {
      const n = d.data();
      const leidas = lecturasPorNovedad[d.id] || 0;
      lista.push({
        id: d.id, ...n,
        lecturas: leidas,
        // % de suscriptores que la vieron — mide si el canal funciona
        alcance: totalSuscriptores > 0 ? Math.round(leidas / totalSuscriptores * 100) : 0
      });
    });

    lista.sort((a, b) => String(b.publicadaEn).localeCompare(String(a.publicadaEn)));

    res.json({ totalSuscriptores, novedades: lista, tipos: TIPOS });
  } catch (e) {
    console.error('GET novedades/admin:', e);
    res.status(500).json({ error: 'Error al cargar el historial' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DELETE /api/novedades/:id — despublicar (nunca borra)
// ═════════════════════════════════════════════════════════════════════════════
router.delete('/:id', soloSuperAdmin, async (req, res) => {
  try {
    await db.collection('novedades').doc(req.params.id).update({
      publicada: false,
      despublicadaEn: new Date().toISOString(),
      despublicadaPor: req.superAdminNombre
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE novedad:', e);
    res.status(500).json({ error: 'Error al despublicar' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/novedades/calendario — calendario laboral del año
// ═════════════════════════════════════════════════════════════════════════════
router.get('/calendario', async (req, res) => {
  try {
    const anio = Number(req.query.anio) || new Date().getFullYear();
    res.json({
      anio,
      hoy: C.hoyCO(),
      eventos: C.calendarioAnual(anio),
      enVentana: C.eventosDelDia().map(e => ({
        id: e.id, titulo: e.titulo, fechaLimite: e.fechaLimite,
        diasRestantes: e.diasRestantes, urgencia: C.etiquetaUrgencia(e.diasRestantes),
        critico: e.critico === true
      }))
    });
  } catch (e) {
    console.error('GET calendario:', e);
    res.status(500).json({ error: 'Error al cargar el calendario' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/novedades/calendario/generar
// ─────────────────────────────────────────────────────────────────────────────
// Genera las novedades automáticas de los eventos que hoy entran en ventana.
// Lo llama el cron diario. Es idempotente: la `clave` del evento incluye el
// año (y el mes en los mensuales), así que nunca se publica dos veces.
//
// El parámetro `fecha` permite probar un día concreto sin esperar a que llegue.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/calendario/generar', soloSuperAdmin, async (req, res) => {
  try {
    const { fecha, simular } = req.body || {};
    const eventos = C.eventosDelDia(fecha);

    if (eventos.length === 0) {
      return res.json({ ok: true, generadas: 0, mensaje: 'Hoy no hay eventos del calendario en ventana de aviso.' });
    }

    // Qué claves ya se publicaron
    const yaSnap = await db.collection('novedades').where('automatica', '==', true).get();
    const yaPublicadas = new Set();
    yaSnap.forEach(d => { if (d.data().claveEvento) yaPublicadas.add(d.data().claveEvento); });

    const creadas = [];
    const omitidas = [];

    for (const ev of eventos) {
      if (yaPublicadas.has(ev.clave)) { omitidas.push({ id: ev.id, razon: 'Ya publicada este período' }); continue; }
      if (simular === true) { creadas.push({ id: ev.id, titulo: ev.titulo, simulado: true }); continue; }

      const novedad = {
        tipo: ev.tipo,
        titulo: `${ev.titulo} · ${C.etiquetaUrgencia(ev.diasRestantes)}`,
        cuerpo: ev.cuerpo,
        critico: ev.critico === true,
        accion: ev.accion || null,
        fechaLimite: ev.fechaLimite,
        destinatarios: [],
        automatica: true,
        claveEvento: ev.clave,
        publicada: true,
        publicadaEn: new Date().toISOString(),
        publicadaPor: 'Calendario automático',
        correoEnviado: false,
        correosOk: 0,
        correosFallidos: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const ref = await db.collection('novedades').add(novedad);

      // Las obligaciones legales sí van por correo; los recordatorios suaves no,
      // para no saturar la bandeja y que el canal pierda valor.
      let correo = null;
      if (ev.tipo === C.OBLIGACION) {
        correo = await enviarNovedadPorCorreo(ref.id, novedad, {
          soloConEmpleados: ev.requiere === 'empleados'
        });
      }

      creadas.push({ id: ev.id, novedadId: ref.id, titulo: novedad.titulo, correo });
    }

    res.json({ ok: true, generadas: creadas.length, creadas, omitidas, simulado: simular === true });
  } catch (e) {
    console.error('POST calendario/generar:', e);
    res.status(500).json({ error: 'Error al generar los avisos del calendario' });
  }
});

module.exports = router;
module.exports.enviarNovedadPorCorreo = enviarNovedadPorCorreo;
module.exports.TIPOS = TIPOS;
