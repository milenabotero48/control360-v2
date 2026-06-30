// ============================================================
// Control360 — Motor de Vencimientos (Fase 2)
// Ubicación: backend/routes/vencimientos.js
// ------------------------------------------------------------
// MONTAJE en server.js (UNA línea junto a las demás rutas):
//   app.use('/api/vencimientos', authenticate, require('./routes/vencimientos'));
//
// REGLAS DEL DOCUMENTO ARQ-COMERCIAL-V1.1 implementadas aquí:
//   R-COM-01  El vencimiento pertenece al equipo, no al cliente
//   R-COM-03  Filas sin fecha → colección prospectos (no clients)
//   (R-COM-02 / 07 — agrupación y candado 30 días — viven en el
//    motor automático de la Fase 4, no en este archivo)
//
// DISEÑO DEL IMPORTADOR: el frontend parsea el Excel con SheetJS
// (ya disponible en el stack) y envía JSON. El backend NO necesita
// dependencias nuevas (multer/xlsx). Cero cambios en package.json.
//
// FECHAS: strings 'YYYY-MM-DD' (regla del proyecto: Railway corre
// en UTC, Colombia es UTC-5 — se evita Date() para días calendario).
// ============================================================

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

// ─── HELPER: auditoría (mismo patrón de clients.js) ─────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'vencimientos', descripcion,
      usuarioId, usuarioNombre, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

// ─── HELPER: resolver tenant (patrón estándar del proyecto) ──────────────────
const getAdminId = (req) => req.adminId || req.user?.uid || req.user?.id;

// ─── HELPER: fechas calendario sin riesgo de zona horaria ────────────────────
// 'YYYY-MM-DD' + meses → 'YYYY-MM-DD'
const sumarMeses = (fechaStr, meses) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1 + meses, d));
  return fecha.toISOString().slice(0, 10);
};

const hoyColombia = () => {
  // UTC-5: restar 5 horas al reloj UTC y tomar la fecha
  const ahora = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return ahora.toISOString().slice(0, 10);
};

const esFechaValida = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ─── HELPER: parseo flexible de fecha SOLO para el importador masivo ─────────
// El formulario manual y el resto del sistema siguen exigiendo 'YYYY-MM-DD'
// estricto (esFechaValida). Esta función existe porque los archivos que las
// suscriptoras exportan desde Excel/su sistema anterior traen fechas en
// formatos variados (ej: "26-Jul-25") y antes se descartaban silenciosamente,
// mandando esas filas a Prospectos en vez de crear el vencimiento.
const pad2 = (n) => String(n).padStart(2, '0');
const MESES_ABREV = {
  ene:1, jan:1, feb:2, mar:3, abr:4, apr:4, may:5, jun:6, jul:7,
  ago:8, aug:8, sep:9, sept:9, oct:10, nov:11, dic:12, dec:12,
};
const parsearFechaFlexible = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return null;

  // YYYY-MM-DD (ya válido)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // YYYY-MM (se asume día 01)
  if (/^\d{4}-\d{2}$/.test(s)) return s + '-01';

  // YYYY/MM/DD
  let m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  // DD-MMM-YY o DD-MMM-YYYY (ej: 26-Jul-25, 26-Jul-2025, 26 Jul 25)
  m = s.match(/^(\d{1,2})[\-\/\s]+([a-zA-ZñÑ]{3,9})[\-\/\s]+(\d{2,4})$/);
  if (m) {
    const mesNum = MESES_ABREV[m[2].toLowerCase().slice(0, 3)];
    if (mesNum) {
      let year = m[3];
      if (year.length === 2) year = (Number(year) <= 30 ? '20' : '19') + year;
      const dia = Number(m[1]);
      if (dia >= 1 && dia <= 31) return `${year}-${pad2(mesNum)}-${pad2(dia)}`;
    }
  }

  // DD/MM/YYYY o DD-MM-YYYY (numérico, día primero — convención colombiana)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let year = m[3];
    if (year.length === 2) year = (Number(year) <= 30 ? '20' : '19') + year;
    let dia = Number(m[1]), mes = Number(m[2]);
    if (mes > 12 && dia <= 12) { const t = dia; dia = mes; mes = t; } // invertir si el "mes" no es válido
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) return `${year}-${pad2(mes)}-${pad2(dia)}`;
  }

  // MM/YYYY o MM-YYYY (solo mes y año)
  m = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[2]}-${pad2(m[1])}-01`;

  return null;
};

// Estado calculado dinámicamente (no se "pudre" en la base):
// GESTIONADO se respeta si está marcado; el resto se deriva de la fecha.
const calcularEstado = (venc, hoy) => {
  if (venc.gestionado) return 'GESTIONADO';
  if (!venc.fechaVencimiento) return 'SIN_FECHA';
  if (venc.fechaVencimiento < hoy) return 'VENCIDO';
  const limite30 = sumarMeses(hoy, 1); // ~30 días
  if (venc.fechaVencimiento <= limite30) return 'POR_VENCER';
  return 'VIGENTE';
};

// ─── HELPER: normalizar teléfono (mismo criterio del servicio WhatsApp) ──────
const normalizarTelefono = (telefono) => {
  if (!telefono) return null;
  let t = String(telefono).replace(/[\s\-\(\)\+\.]/g, '');
  if (t.startsWith('57') && t.length === 12) return t;
  if (t.length === 10 && t.startsWith('3')) return '57' + t;
  return t.length >= 10 ? t : null;
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vencimientos — Listar con filtros (estado, clienteId, mes)
// Orden en memoria por fechaVencimiento (regla: sin orderBy/índices compuestos)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { estado, clienteId, mes } = req.query; // mes: 'YYYY-MM'

    let query = db.collection('vencimientos').where('adminId', '==', adminId);
    if (clienteId) query = query.where('clienteId', '==', clienteId);

    const snap = await query.limit(2000).get();
    const hoy = hoyColombia();

    let lista = snap.docs.map(d => {
      const data = { id: d.id, ...d.data() };
      data.estado = calcularEstado(data, hoy);
      return data;
    });

    if (estado) lista = lista.filter(v => v.estado === estado);
    if (mes) lista = lista.filter(v => (v.fechaVencimiento || '').startsWith(mes));

    lista.sort((a, b) => (a.fechaVencimiento || '9999').localeCompare(b.fechaVencimiento || '9999'));

    return res.json(lista);
  } catch (err) {
    console.error('GET /vencimientos:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vencimientos/resumen — Tarjetas del dashboard
// ═════════════════════════════════════════════════════════════════════════════
router.get('/resumen', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const snap = await db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .limit(5000)
      .get();

    const hoy = hoyColombia();
    const resumen = { VENCIDO: 0, POR_VENCER: 0, VIGENTE: 0, GESTIONADO: 0, SIN_FECHA: 0, total: 0 };

    snap.docs.forEach(d => {
      const e = calcularEstado(d.data(), hoy);
      resumen[e] = (resumen[e] || 0) + 1;
      resumen.total++;
    });

    return res.json(resumen);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/vencimientos — Crear registro manual (desde ficha cliente o llamada)
// Body: { clienteId, sucursal?, descripcionEquipo, cantidad?,
//         fechaUltimaRecarga? | fechaVencimiento?, origenDato? }
// Si solo viene fechaUltimaRecarga → vencimiento = +12 meses (R-COM-04)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const { clienteId, sucursal, descripcionEquipo, cantidad, fechaUltimaRecarga, fechaVencimiento, origenDato, ordenId } = req.body;

    if (!clienteId || !descripcionEquipo) {
      return res.status(400).json({ error: 'clienteId y descripcionEquipo son requeridos' });
    }

    let fVenc = esFechaValida(fechaVencimiento) ? fechaVencimiento : null;
    const fRecarga = esFechaValida(fechaUltimaRecarga) ? fechaUltimaRecarga : null;
    if (!fVenc && fRecarga) fVenc = sumarMeses(fRecarga, 12);
    if (!fVenc) return res.status(400).json({ error: 'Se requiere fechaVencimiento o fechaUltimaRecarga (YYYY-MM-DD)' });

    const nuevo = {
      adminId,
      clienteId,
      sucursal: sucursal || null,
      descripcionEquipo,
      cantidad: Number(cantidad) || 1,
      fechaUltimaRecarga: fRecarga,
      fechaVencimiento: fVenc,
      gestionado: false,
      origenDato: origenDato || 'manual',
      ordenId: ordenId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('vencimientos').add(nuevo);

    await auditar({
      accion: 'crear', descripcion: `Vencimiento creado: ${descripcionEquipo} (${fVenc})`,
      usuarioId: getAdminId(req), usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { vencimientoId: ref.id, clienteId }
    });

    return res.status(201).json({ id: ref.id, ...nuevo });
  } catch (err) {
    console.error('POST /vencimientos:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/vencimientos/importar — Importación masiva (Excel → JSON)
// El frontend parsea el Excel con SheetJS y envía:
// Body: { filas: [{ nombre, empresa?, telefono, sucursal?, equipo,
//                   cantidad?, fechaUltimaRecarga? ('YYYY-MM-DD' o 'YYYY-MM') }] }
//
// Enrutamiento por fila (sección 06 del documento):
//   CON fecha  → cliente (existente o nuevo) + registro en vencimientos
//   SIN fecha  → colección prospectos (estado NUEVO) para la vendedora
//   Teléfono ya en clients → no duplica cliente, agrega vencimientos
// ═════════════════════════════════════════════════════════════════════════════
router.post('/importar', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede importar' });
    }
    const adminId = getAdminId(req);
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    // Ola 3: la importación pertenece a UNA empresa facturadora (selector en
    // pantalla). Los clientes nuevos nacen con el esquema oficial completo.
    const empresaId = req.body?.empresaId || '';
    const empresaNombre = req.body?.empresaNombre || '';

    if (!filas.length) return res.status(400).json({ error: 'No se recibieron filas para importar' });
    if (filas.length > 2000) return res.status(400).json({ error: 'Máximo 2000 filas por importación. Divide el archivo.' });
    if (!empresaId) return res.status(400).json({ error: 'Selecciona la empresa que factura para esta importación' });

    // 1. Cargar clientes existentes del tenant UNA vez (mapa por teléfono)
    const clientesSnap = await db.collection('clients').where('adminId', '==', adminId).get();
    const porTelefono = new Map();
    clientesSnap.docs.forEach(d => {
      // Clientes oficiales usan `celular`; antiguos pueden usar `telefono`.
      const data = d.data();
      [normalizarTelefono(data.celular), normalizarTelefono(data.telefono)]
        .filter(Boolean)
        .forEach(t => { if (!porTelefono.has(t)) porTelefono.set(t, d.id); });
    });

    // Prospectos existentes por teléfono → MODO ACTUALIZAR: si la fila trae
    // datos nuevos (NIT, empresa, equipo), se ENRIQUECE el prospecto en vez
    // de duplicarlo. Así una re-importación del mismo archivo completa la
    // base sin tocar el trabajo de llamadas ya hecho.
    const prospSnap = await db.collection('prospectos').where('adminId', '==', adminId).get();
    const prospPorTel = new Map();
    prospSnap.docs.forEach(d => {
      const t = normalizarTelefono(d.data().telefono);
      if (t && !prospPorTel.has(t)) prospPorTel.set(t, { id: d.id, ...d.data() });
    });


    let resultadoExtra = { prospectosActualizados: 0 };
    const resultado = { vencimientosCreados: 0, clientesNuevos: 0, prospectosCreados: 0, errores: [] };
    let batch = db.batch();
    let ops = 0;
    const commitSiLleno = async () => {
      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    };

    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const fila = i + 2; // +2: encabezado del Excel
      try {
        // Alias de columnas — acepta la plantilla de clientes de la empresa:
        const nombre = String(f.nombre || f.razonSocial || f['razon social'] || f.empresa || '').trim();
        const telefono = normalizarTelefono(f.telefono || f.celular);
        const nitFila = String(f.nit || '').replace(/[^0-9]/g, '') || null;

        if (!nombre || !telefono) {
          resultado.errores.push({ fila, error: 'Falta nombre o teléfono válido' });
          continue;
        }

        // ✅ FIX: antes solo aceptaba 'YYYY-MM-DD'/'YYYY-MM'; formatos como
        // "26-Jul-25" se descartaban silenciosamente y la fila caía a Prospectos.
        const fRecarga = parsearFechaFlexible(f.fechaUltimaRecarga);

        if (!fRecarga) {
          // ─── SIN FECHA → prospecto para la vendedora (R-COM-03 / sección 06)
          const existente = prospPorTel.get(telefono);
          if (existente) {
            // MODO ACTUALIZAR: enriquecer sin duplicar ni borrar gestión.
            const cambios = {};
            if (nitFila && !existente.nit) cambios.nit = nitFila;
            if (f.empresa && !existente.empresa) cambios.empresa = f.empresa;
            if (f.sucursal && !existente.sucursal) cambios.sucursal = f.sucursal;
            if (f.equipo && !existente.equipoReportado) cambios.equipoReportado = f.equipo;
            if (!existente.clienteId && porTelefono.get(telefono)) cambios.clienteId = porTelefono.get(telefono);
            if (Object.keys(cambios).length) {
              cambios.updatedAt = admin.firestore.FieldValue.serverTimestamp();
              batch.update(db.collection('prospectos').doc(existente.id), cambios);
              ops++; resultadoExtra.prospectosActualizados++;
              await commitSiLleno();
            }
            continue;
          }
          const refP = db.collection('prospectos').doc();
          batch.set(refP, {
            adminId,
            nombre,
            empresa: f.empresa || null,
            telefono,
            nit: nitFila,
            sucursal: f.sucursal || null,
            equipoReportado: f.equipo || null,
            origen: 'importacion',
            estado: 'NUEVO',
            asignadoA: null,
            proximaLlamada: null,
            clienteId: porTelefono.get(telefono) || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          prospPorTel.set(telefono, { id: refP.id, nombre, telefono });
          ops++; resultado.prospectosCreados++;
          await commitSiLleno();
          continue;
        }

        // ─── CON FECHA → cliente + vencimiento
        let clienteId = porTelefono.get(telefono);
        if (!clienteId) {
          // Esquema OFICIAL de cliente (visible y editable en el módulo Clientes)
          const refC = db.collection('clients').doc();
          batch.set(refC, {
            adminId,
            nombre: nombre.toUpperCase(),
            tipoDocumento: 'NIT',
            nit: nitFila,
            celular: telefono,
            telefono,
            emailLegal: f.email || null,
            emailsAdicionales: [],
            direccionPrincipal: f.direccion || null,
            ciudad: f.ciudad || null,
            empresaId,
            empresaNombre,
            sucursales: [],
            notas: '',
            origen: 'importacion_vencimientos',
            activo: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          clienteId = refC.id;
          porTelefono.set(telefono, clienteId); // evita duplicar en filas siguientes
          ops++; resultado.clientesNuevos++;
        }
        // Si existe un prospecto con este teléfono → vincularlo y enriquecerlo
        const prospLink = prospPorTel.get(telefono);
        if (prospLink && (!prospLink.clienteId || (nitFila && !prospLink.nit))) {
          const cambiosP = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
          if (!prospLink.clienteId) cambiosP.clienteId = clienteId;
          if (nitFila && !prospLink.nit) cambiosP.nit = nitFila;
          batch.update(db.collection('prospectos').doc(prospLink.id), cambiosP);
          prospLink.clienteId = clienteId;
          ops++; resultadoExtra.prospectosActualizados++;
        }

        const refV = db.collection('vencimientos').doc();
        batch.set(refV, {
          adminId,
          clienteId,
          sucursal: f.sucursal || null,
          descripcionEquipo: f.equipo || 'Extintor',
          cantidad: Number(f.cantidad) || 1,
          fechaUltimaRecarga: fRecarga,
          fechaVencimiento: sumarMeses(fRecarga, 12),
          gestionado: false,
          origenDato: 'importacion',
          ordenId: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        ops++; resultado.vencimientosCreados++;
        await commitSiLleno();

      } catch (errFila) {
        resultado.errores.push({ fila, error: errFila.message });
      }
    }

    if (ops > 0) await batch.commit();

    await auditar({
      accion: 'importar',
      descripcion: `Importación: ${resultado.vencimientosCreados} vencimientos, ${resultado.clientesNuevos} clientes nuevos, ${resultado.prospectosCreados} prospectos, ${resultadoExtra.prospectosActualizados} prospectos actualizados`,
      usuarioId: adminId, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { totalFilas: filas.length, errores: resultado.errores.length }
    });

    return res.json({ ...resultado, ...resultadoExtra });
  } catch (err) {
    console.error('POST /vencimientos/importar:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/vencimientos/:id — Actualizar (fecha, sucursal) o marcar gestionado
// ═════════════════════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const adminId = getAdminId(req);
    const ref = db.collection('vencimientos').doc(req.params.id);
    const doc = await ref.get();

    if (!doc.exists) return res.status(404).json({ error: 'Vencimiento no encontrado' });
    if (doc.data().adminId !== adminId) return res.status(403).json({ error: 'No autorizado' }); // aislamiento

    const { sucursal, descripcionEquipo, cantidad, fechaUltimaRecarga, fechaVencimiento, gestionado, ordenId } = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (sucursal !== undefined) update.sucursal = sucursal;
    if (descripcionEquipo) update.descripcionEquipo = descripcionEquipo;
    if (cantidad !== undefined) update.cantidad = Number(cantidad) || 1;
    if (esFechaValida(fechaUltimaRecarga)) {
      update.fechaUltimaRecarga = fechaUltimaRecarga;
      update.fechaVencimiento = sumarMeses(fechaUltimaRecarga, 12);
    }
    if (esFechaValida(fechaVencimiento)) update.fechaVencimiento = fechaVencimiento;
    if (typeof gestionado === 'boolean') update.gestionado = gestionado;
    if (ordenId !== undefined) update.ordenId = ordenId;

    await ref.update(update);

    await auditar({
      accion: 'actualizar', descripcion: `Vencimiento ${req.params.id} actualizado`,
      usuarioId: adminId, usuarioNombre: req.user?.nombre || req.user?.email,
      datos: { cambios: Object.keys(update) }
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
