// ═══════════════════════════════════════════════════════════════════════════════
// novedadesCron.js — Publica solo los avisos del calendario laboral
// ─────────────────────────────────────────────────────────────────────────────
// NOVEDADES-001
//
// Corre una vez al día y revisa qué eventos del calendario colombiano entran
// hoy en ventana de aviso (cesantías, prima, intereses, salario mínimo...).
// Si alguno entra y todavía no se publicó este período, crea la novedad y —
// si es una obligación legal con fecha límite — la manda por correo.
//
// Sin dependencias externas: mismo patrón de setInterval que suscripcionCron.js,
// para no meter node-cron por un solo uso más.
//
// Se ejecuta a las 8:00 AM Colombia, una hora antes que el cron de cobros, para
// que un suscriptor no reciba dos correos nuestros en el mismo minuto.
// ═══════════════════════════════════════════════════════════════════════════════

const { db, admin } = require('../config/firebase');
const C = require('./calendarioColombia');

// Se importa perezosamente para evitar una dependencia circular:
// novedades.js (ruta) requiere servicios, y este servicio requiere la ruta.
let enviarNovedadPorCorreo = null;
const cargarEnvio = () => {
  if (!enviarNovedadPorCorreo) {
    enviarNovedadPorCorreo = require('../routes/novedades').enviarNovedadPorCorreo;
  }
  return enviarNovedadPorCorreo;
};

// ═════════════════════════════════════════════════════════════════════════════
// Ejecución
// ═════════════════════════════════════════════════════════════════════════════
const ejecutarCronNovedades = async () => {
  const hoy = C.hoyCO();
  const eventos = C.eventosDelDia(hoy);

  if (eventos.length === 0) {
    console.log(`[CRON-NOVEDADES] ${hoy} — sin eventos del calendario en ventana`);
    return { generadas: 0 };
  }

  // Claves ya publicadas — así el mismo aviso no se repite dentro del período
  const yaSnap = await db.collection('novedades').where('automatica', '==', true).get();
  const yaPublicadas = new Set();
  yaSnap.forEach(d => { if (d.data().claveEvento) yaPublicadas.add(d.data().claveEvento); });

  let generadas = 0;

  for (const ev of eventos) {
    if (yaPublicadas.has(ev.clave)) continue;

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

    try {
      const ref = await db.collection('novedades').add(novedad);
      generadas += 1;

      // Solo las obligaciones legales salen por correo. Los recordatorios
      // suaves se quedan en la campanita: si todo llega al correo, el correo
      // deja de leerse y perdemos el canal justo cuando importa.
      if (ev.tipo === C.OBLIGACION) {
        const enviar = cargarEnvio();
        const r = await enviar(ref.id, novedad, { soloConEmpleados: ev.requiere === 'empleados' });
        console.log(`[CRON-NOVEDADES] "${ev.id}" → correo a ${r.ok}/${r.total} suscriptor(es)`);
      } else {
        console.log(`[CRON-NOVEDADES] "${ev.id}" → publicada solo en la app`);
      }

      await db.collection('audit_logs').add({
        accion: 'NOVEDAD_AUTOMATICA_PUBLICADA',
        modulo: 'novedades',
        descripcion: `Calendario: ${novedad.titulo} (límite ${ev.fechaLimite})`,
        usuarioNombre: 'Sistema',
        documento: ref.id,
        datos: { eventoId: ev.id, clave: ev.clave, diasRestantes: ev.diasRestantes },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        fecha: new Date().toISOString()
      });
    } catch (e) {
      console.error(`[CRON-NOVEDADES] Error publicando "${ev.id}":`, e.message);
    }
  }

  console.log(`[CRON-NOVEDADES] ${hoy} — ${generadas} aviso(s) generado(s)`);
  return { generadas };
};

// ═════════════════════════════════════════════════════════════════════════════
// Agendador — 8:00 AM Colombia
// ═════════════════════════════════════════════════════════════════════════════
let ultimaEjecucion = null;

const iniciarCronNovedades = () => {
  const verificarYEjecutar = () => {
    const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
    const fechaHoy = ahoraCO.toISOString().slice(0, 10);
    const hora = ahoraCO.getUTCHours();

    if (hora === 8 && ultimaEjecucion !== fechaHoy) {
      ultimaEjecucion = fechaHoy;
      ejecutarCronNovedades().catch(e => console.error('[CRON-NOVEDADES] Error:', e.message));
    }
  };

  setInterval(verificarYEjecutar, 15 * 60 * 1000);
  verificarYEjecutar();
  console.log('✅ Cron de novedades activo — corre diario a las 8:00 AM Colombia');
};

module.exports = { iniciarCronNovedades, ejecutarCronNovedades };
