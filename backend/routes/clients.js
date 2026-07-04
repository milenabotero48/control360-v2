const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const jwt = require('jsonwebtoken');
const { authenticate, validarTenant } = require('../middleware/auth');

// ✅ DUP-002: normalización telefónica coherente con el resto del dominio
// comercial (misma regla que comercial.js): 10 dígitos limpios, sin prefijo 57.
// Evita que el mismo cliente quede con formatos distintos entre módulos y se
// escape de la detección de duplicados.
const normalizarCelular = (t) => {
  if (!t) return null;
  let d = String(t).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('57')) d = d.slice(2);
  return d || null;
};

// ─── HELPER: auditoría ────────────────────────────────────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioNombre, datos = {} }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'clientes', descripcion,
      usuarioId, usuarioNombre, datos,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Auditoría error:', e); }
};

// ─── HELPER: similaridad de nombres (anti-duplicado) ─────────────────────────
const nombreSimilar = (n1, n2) => {
  const limpiar = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const a = limpiar(n1);
  const b = limpiar(n2);
  if (a === b) return true;
  // Contiene uno al otro
  if (a.includes(b) || b.includes(a)) return true;
  // Similitud básica: más del 80% de caracteres coinciden
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return true;
  let matches = 0;
  for (let c of shorter) { if (longer.includes(c)) matches++; }
  return (matches / longer.length) > 0.95;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clients — Listar clientes (paginado + búsqueda server-side)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { empresaId, buscar, activo, limite = 100 } = req.query;
    // AISLAMIENTO SAAS: cada admin solo ve sus propios clientes
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    let query = db.collection('clients').where('adminId', '==', adminId);

    if (empresaId) query = query.where('empresaId', '==', empresaId);

    // Solo admin ve inactivos si los pide explícitamente
    if (activo === 'todos' && req.user.role === 'admin') {
      // no filtrar
    } else {
      query = query.where('activo', '==', true);
    }

    // Si hay búsqueda: cargar todos, filtrar en servidor, devolver max 100
    if (buscar) {
      const snapshot = await query.get();
      let clientes = [];
      snapshot.forEach(doc => clientes.push({ id: doc.id, ...doc.data() }));
      // ✅ FIX CLIENTES-SEARCH-001: comparación case-insensitive en nombre.
      // Antes c.nombre?.includes(term) fallaba si el nombre estaba guardado en
      // minúsculas (ej. clientes importados por CSV), aunque el cliente existiera.
      const term = buscar.toUpperCase();
      clientes = clientes.filter(c =>
        c.nombre?.toUpperCase().includes(term) ||
        c.nit?.toString().includes(buscar) ||
        c.celular?.toString().includes(buscar) ||
        c.email?.toLowerCase().includes(buscar.toLowerCase()) ||
        c.emailLegal?.toLowerCase().includes(buscar.toLowerCase())
      );
      return res.json(clientes.slice(0, Number(limite)));
    }

    // Sin búsqueda: limitar la carga (evita traer 10,000 de golpe)
    const limiteNum = Math.min(Number(limite) || 100, 500);
    const snapshot = await query.limit(limiteNum).get();

    let clientes = [];
    snapshot.forEach(doc => clientes.push({ id: doc.id, ...doc.data() }));

    res.json(clientes);
  } catch (error) {
    console.error('Error listando clientes:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clients/verificar — Verificar duplicados antes de crear
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verificar', authenticate, async (req, res) => {
  try {
    const { nit, nombre } = req.body;
    const resultado = { nitDuplicado: false, nombreSimilar: false, clienteExistente: null, similares: [] };

    // ── AISLAMIENTO SAAS (Ola 3 fix) ─────────────────────────────────────
    // Antes esta verificación buscaba el NIT en TODA la base de datos: a un
    // suscriptor le aparecía "ya existe" por un cliente de OTRO suscriptor
    // (bloqueaba la creación y filtraba el nombre ajeno). Ahora todo se
    // verifica SOLO dentro del tenant actual.
    const adminIdVerif = req.adminId || req.user.uid || req.user.id;

    // Verificar NIT exacto — solo dentro del tenant
    if (nit) {
      const nitSnap = await db.collection('clients')
        .where('adminId', '==', adminIdVerif)
        .where('nit', '==', nit.toString())
        .get();
      if (!nitSnap.empty) {
        resultado.nitDuplicado = true;
        resultado.clienteExistente = { id: nitSnap.docs[0].id, ...nitSnap.docs[0].data() };
        return res.json(resultado);
      }
    }

    // Verificar nombre similar — solo dentro del tenant
    if (nombre) {
      const todosSnap = await db.collection('clients')
        .where('adminId', '==', adminIdVerif)
        .get();
      const similares = [];
      todosSnap.forEach(doc => {
        const data = doc.data();
        if (nombreSimilar(nombre, data.nombre || '')) {
          similares.push({ id: doc.id, nombre: data.nombre || data.name || 'Sin nombre', nit: data.nit });
        }
      });
      if (similares.length > 0) {
        resultado.nombreSimilar = true;
        resultado.similares = similares;
      }
    }

    res.json(resultado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clients — Crear cliente nuevo
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      nombre, nit, tipoDocumento = 'NIT',
      telefono, celular, emailLegal, emailsAdicionales = [],
      direccionPrincipal, ciudad, departamento,
      empresaId, empresaNombre,
      sucursales = [], notas = '',
      sectorId = '',           // Mini-Ola 2.6: sector del cliente sin sucursales
      confirmarDuplicado = false
    } = req.body;

    // Validaciones obligatorias
    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!empresaId) return res.status(400).json({ error: 'Debes asignar el cliente a una empresa (Sur o Valle)' });

    // Nombre siempre en mayúsculas
    const nombreUpper = nombre.toUpperCase().trim();

    // ✅ DUP-002: normalizar teléfono ANTES de validar — así un celular con
    // prefijo 57 (573105112345) se limpia a 10 dígitos en vez de rechazarse,
    // y se guarda coherente con la regla de identidad de duplicados.
    const celularNorm = normalizarCelular(celular);
    const telefonoNorm = normalizarCelular(telefono);

    // Validar NIT solo números
    if (nit && !/^\d+$/.test(nit)) {
      return res.status(400).json({ error: 'El NIT debe contener solo números' });
    }

    // Validar celular solo números (ya normalizado a 10 dígitos)
    if (celularNorm && !/^\d{10}$/.test(celularNorm)) {
      return res.status(400).json({ error: 'El celular debe tener exactamente 10 dígitos' });
    }

    // Validar teléfono solo números
    if (telefonoNorm && !/^\d+$/.test(telefonoNorm)) {
      return res.status(400).json({ error: 'El teléfono debe contener solo números' });
    }

    // Anti-duplicado NIT — solo dentro del mismo tenant Y misma empresa
    const adminIdActual = req.adminId || req.user.uid || req.user.id;
    if (nit && !confirmarDuplicado) {
      const nitExiste = await db.collection('clients')
        .where('adminId', '==', adminIdActual)
        .where('nit', '==', nit.toString())
        .get();
      if (!nitExiste.empty) {
        // Solo es duplicado si es la misma empresa
        const mismaEmpresa = nitExiste.docs.some(d => d.data().empresaId === empresaId);
        if (mismaEmpresa) {
          return res.status(409).json({
            error: 'Ya existe un cliente con ese NIT en esta empresa',
            clienteExistente: { id: nitExiste.docs[0].id, ...nitExiste.docs[0].data() }
          });
        }
      }
    }

    // ✅ CLIENTES-DUP-001: regla única de identidad de cliente en el tenant —
    // NIT (arriba), celular/teléfono y nombre. Muchos clientes no tienen NIT:
    // sin esto se creaban repetidos con el mismo celular o el mismo nombre.
    // Igual que con el NIT, solo cuenta como duplicado en la MISMA empresa
    // (un cliente puede existir legítimamente en Sur y en Valle).
    // Consultas limit(1) puntuales — costo mínimo, cero escaneos.
    if (!confirmarDuplicado) {
      const normTel = (t) => {
        let d = String(t || '').replace(/\D/g, '');
        if (d.length === 12 && d.startsWith('57')) d = d.slice(2);
        return d || null;
      };
      const telBuscar = normTel(celular) || normTel(telefono);
      const candidatos = [];
      if (telBuscar) {
        for (const campo of ['celular', 'telefono']) {
          try {
            const snapDup = await db.collection('clients')
              .where('adminId', '==', adminIdActual)
              .where(campo, '==', telBuscar)
              .limit(1).get();
            if (!snapDup.empty) candidatos.push(snapDup.docs[0]);
          } catch (e) { console.warn('CLIENTES-DUP-001 tel:', e.message); }
        }
      }
      try {
        const snapNom = await db.collection('clients')
          .where('adminId', '==', adminIdActual)
          .where('nombre', '==', nombreUpper)
          .limit(1).get();
        if (!snapNom.empty) candidatos.push(snapNom.docs[0]);
      } catch (e) { console.warn('CLIENTES-DUP-001 nombre (¿falta índice adminId+nombre?):', e.message); }

      const dup = candidatos.find(d => d.data().empresaId === empresaId && d.data().activo !== false);
      if (dup) {
        const dd = dup.data();
        const motivo = dd.nombre === nombreUpper ? 'nombre' : 'celular/teléfono';
        return res.status(409).json({
          error: `Ya existe un cliente con ese ${motivo} en esta empresa: ${dd.nombre}${dd.nit ? ` (NIT ${dd.nit})` : ''}. Si realmente es otro cliente, confirma la creación.`,
          clienteExistente: { id: dup.id, ...dd },
          duplicadoPor: motivo
        });
      }
    }

    // Construir objeto cliente
    const nuevoCliente = {
      nombre: nombreUpper,
      nit: nit ? nit.toString() : '',
      tipoDocumento,
      telefono: telefonoNorm || '',
      celular: celularNorm || '',
      emailLegal: emailLegal || '',
      emailsAdicionales: Array.isArray(emailsAdicionales) ? emailsAdicionales.filter(e => e) : [],
      direccionPrincipal: direccionPrincipal || '',
      ciudad: ciudad || '',
      departamento: departamento || '',
      empresaId,
      empresaNombre: empresaNombre || '',
      sectorId: sectorId || '',     // Mini-Ola 2.6: sector general (si no tiene sucursales)
      sucursales: sucursales.map((s, i) => ({
        id: `suc-${Date.now()}-${i}`,
        nombre: s.nombre?.toUpperCase().trim() || '',
        direccion: s.direccion || '',
        ciudad: s.ciudad || '',
        telefono: s.telefono?.replace(/\D/g, '') || '',
        encargado: s.encargado || '',
        sectorId: s.sectorId || '', // Mini-Ola 2.6: sector por sucursal
        activo: true
      })),
      notas,
      activo: true,
      adminId: req.adminId || req.user.uid || req.user.id, // AISLAMIENTO SAAS
      creadoPor: req.adminId || req.user.uid || req.user.id,
      creadoPorNombre: req.user.nombre || req.user.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('clients').add(nuevoCliente);

    await auditar({
      accion: 'CREAR_CLIENTE',
      descripcion: `${req.user.nombre || req.user.email} creó cliente ${nombreUpper}`,
      usuarioId: req.adminId || req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { nombre: nombreUpper, nit, empresaId }
    });

    res.status(201).json({ id: ref.id, ...nuevoCliente });
  } catch (error) {
    console.error('Error creando cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clients/:id — Ver detalle de cliente
// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// ✅ CLIENTES-DUP-001: GET /clients/duplicados — reporte de duplicados
// Solo lectura, solo admin, BAJO DEMANDA (un clic, no polling). Una única
// lectura del tenant con .select() de campos mínimos; el agrupamiento es en
// memoria. Detecta grupos con mismo NIT, mismo teléfono o mismo nombre
// dentro de la misma empresa — insumo para la futura herramienta de fusión.
// ══════════════════════════════════════════════════════════════════════════════
router.get('/duplicados', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede ver el reporte de duplicados' });
    }
    const adminId = req.adminId || req.user.uid || req.user.id;
    const snap = await db.collection('clients')
      .where('adminId', '==', adminId)
      .select('nombre', 'nit', 'celular', 'telefono', 'empresaId', 'empresaNombre', 'activo')
      .get();
    const clientes = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.activo !== false);

    // ✅ DUP-002: grupos ya descartados por el admin (falsos positivos:
    // "son empresas del mismo dueño"). No se vuelven a mostrar.
    const descSnap = await db.collection('duplicados_descartados')
      .where('adminId', '==', adminId).get();
    const gruposDescartados = new Set(descSnap.docs.map(d => d.data().firma));

    const normTel = (t) => {
      let d = String(t || '').replace(/\D/g, '');
      if (d.length === 12 && d.startsWith('57')) d = d.slice(2);
      return d || null;
    };
    const normNom = (n) => String(n || '').toUpperCase().trim().replace(/\s+/g, ' ') || null;
    // Palabras significativas de un nombre (para medir similitud)
    const palabras = (n) => new Set(normNom(n)?.split(' ').filter(w => w.length >= 3) || []);
    const compartenPalabra = (a, b) => {
      const pa = palabras(a), pb = palabras(b);
      for (const w of pa) if (pb.has(w)) return true;
      return false;
    };

    // Agrupar por cada criterio
    const grupos = new Map();
    const agrupar = (clave, c) => {
      if (!clave) return;
      if (!grupos.has(clave)) grupos.set(clave, new Map());
      grupos.get(clave).set(c.id, c);
    };
    for (const c of clientes) {
      const emp = c.empresaId || '';
      if (c.nit) agrupar(`NIT|${emp}|${c.nit}`, c);
      const t = normTel(c.celular) || normTel(c.telefono);
      if (t) agrupar(`TEL|${emp}|${t}`, c);
      const n = normNom(c.nombre);
      // ✅ DUP-002: el nombre solo agrupa si es COMPLETO (2+ palabras). Antes
      // "OSCAR" o "GERMAN" a secas generaban falsos grupos con homónimos.
      if (n && n.split(' ').length >= 2) agrupar(`NOMBRE|${emp}|${n}`, c);
    }

    // ✅ DUP-002: clasificar cada grupo por nivel de confianza
    //   🔴 seguro   → mismo NIT, o mismo teléfono + nombres que se parecen
    //   🟡 revisar  → mismo teléfono con nombres distintos (posible multi-negocio
    //                 de un mismo dueño: NO es duplicado, solo se muestra por si acaso)
    const seguros = [];
    const revisar = [];
    const vistos = new Set();

    for (const [clave, mapaC] of grupos) {
      if (mapaC.size < 2) continue;
      const arr = [...mapaC.values()];
      const ids = arr.map(c => c.id).sort();
      // Firma estable del grupo (para descarte y dedupe entre criterios)
      const firma = ids.join('|');
      if (vistos.has(firma)) continue;
      vistos.add(firma);
      if (gruposDescartados.has(firma)) continue; // ✅ ya revisado, es legítimo

      const criterio = clave.split('|')[0];
      const valor = clave.split('|')[2];

      let nivel;
      if (criterio === 'NIT' || criterio === 'NOMBRE') {
        nivel = 'seguro'; // mismo NIT o mismo nombre completo = misma entidad
      } else {
        // Criterio TEL: ¿los nombres se parecen entre sí?
        let algunoSimilar = false;
        for (let i = 0; i < arr.length && !algunoSimilar; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            if (compartenPalabra(arr[i].nombre, arr[j].nombre)) { algunoSimilar = true; break; }
          }
        }
        nivel = algunoSimilar ? 'seguro' : 'revisar';
      }

      const grupo = {
        firma, criterio,
        criterioLabel: criterio === 'TEL' ? 'teléfono' : criterio === 'NIT' ? 'NIT' : 'nombre',
        valor,
        clientes: arr
      };
      (nivel === 'seguro' ? seguros : revisar).push(grupo);
    }

    res.json({
      totalSeguros: seguros.length,
      totalRevisar: revisar.length,
      seguros,   // 🔴 acción requerida
      revisar    // 🟡 posible multi-negocio (colapsado en la UI)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ DUP-002: POST /clients/duplicados/descartar — marcar un grupo como
// falso positivo (empresas legítimas del mismo dueño). No borra ni fusiona
// nada; solo registra que ese grupo ya fue revisado y no debe reaparecer.
router.post('/duplicados/descartar', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede descartar duplicados' });
    }
    const adminId = req.adminId || req.user.uid || req.user.id;
    const { firma, clienteIds } = req.body;
    if (!firma || !Array.isArray(clienteIds) || clienteIds.length < 2) {
      return res.status(400).json({ error: 'Datos insuficientes para descartar el grupo' });
    }
    await db.collection('duplicados_descartados').add({
      adminId,
      firma,                       // misma firma estable que arma el reporte
      clienteIds,
      descartadoPorId: req.user.uid || req.user.id,
      descartadoPorEmail: req.user.email,
      fecha: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', authenticate, validarTenant('clients'), async (req, res) => {
  try {
    const doc = await db.collection('clients').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/clients/:id — Editar cliente
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', authenticate, validarTenant('clients'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nombre, nit, tipoDocumento,
      telefono, celular, emailLegal, emailsAdicionales,
      direccionPrincipal, ciudad, departamento,
      sucursales, notas, activo,
      empresaId, empresaNombre,
      sectorId           // Mini-Ola 2.6
    } = req.body;

    const clienteRef = db.collection('clients').doc(id);
    const clienteDoc = await clienteRef.get();
    if (!clienteDoc.exists) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Solo admin puede reasignar empresa
    if (empresaId && empresaId !== clienteDoc.data().empresaId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede reasignar la empresa del cliente' });
    }

    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (nombre) cambios.nombre = nombre.toUpperCase().trim();
    if (nit) {
      if (!/^\d+$/.test(nit)) return res.status(400).json({ error: 'NIT solo números' });
      cambios.nit = nit.toString();
    }
    if (tipoDocumento) cambios.tipoDocumento = tipoDocumento;
    if (telefono !== undefined) cambios.telefono = telefono.replace(/\D/g, '');
    if (celular !== undefined) {
      if (celular && !/^\d{10}$/.test(celular)) return res.status(400).json({ error: 'Celular debe tener 10 dígitos' });
      cambios.celular = celular;
    }
    if (emailLegal !== undefined) cambios.emailLegal = emailLegal;
    if (emailsAdicionales !== undefined) cambios.emailsAdicionales = emailsAdicionales.filter(e => e);
    if (direccionPrincipal !== undefined) cambios.direccionPrincipal = direccionPrincipal;
    if (ciudad !== undefined) cambios.ciudad = ciudad;
    if (departamento !== undefined) cambios.departamento = departamento;
    if (sucursales !== undefined) cambios.sucursales = sucursales.map((s, i) => ({
      id: s.id || `suc-${Date.now()}-${i}`,
      nombre: s.nombre?.toUpperCase().trim() || '',
      direccion: s.direccion || '',
      ciudad: s.ciudad || '',
      telefono: s.telefono?.replace(/\D/g, '') || '',
      encargado: s.encargado || '',
      sectorId: s.sectorId || '',          // Mini-Ola 2.6
      activo: s.activo !== false
    }));
    if (notas !== undefined) cambios.notas = notas;
    if (activo !== undefined) cambios.activo = activo;
    if (sectorId !== undefined) cambios.sectorId = sectorId; // Mini-Ola 2.6: sector general del cliente
    if (empresaId) { cambios.empresaId = empresaId; cambios.empresaNombre = empresaNombre || ''; }

    await clienteRef.update(cambios);

    await auditar({
      accion: 'EDITAR_CLIENTE',
      descripcion: `${req.user.nombre || req.user.email} editó cliente ${clienteDoc.data().nombre}`,
      usuarioId: req.adminId || req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { id, cambios: Object.keys(cambios) }
    });

    res.json({ id, ...cambios });
  } catch (error) {
    console.error('Error editando cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/clients/:id — Eliminar o desactivar según historial
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, validarTenant('clients'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede eliminar clientes' });
    }
    const clienteRef = db.collection('clients').doc(req.params.id);
    const clienteDoc = await clienteRef.get();
    if (!clienteDoc.exists) return res.status(404).json({ error: 'Cliente no encontrado' });

    const datosCliente = clienteDoc.data();

    // Verificar si tiene órdenes
    const ordenesSnap = await db.collection('orders')
      .where('clienteId', '==', req.params.id).limit(1).get();
    const tieneOrdenes = !ordenesSnap.empty;

    if (tieneOrdenes) {
      await clienteRef.update({ activo: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await auditar({
        accion: 'DESACTIVAR_CLIENTE',
        descripcion: 'Admin desactivó cliente ' + datosCliente.nombre + ' (tiene historial)',
        usuarioId: req.adminId || req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        datos: { id: req.params.id, nombre: datosCliente.nombre }
      });
      res.json({ accion: 'desactivado', mensaje: datosCliente.nombre + ' fue desactivado. Permanece en el historial.' });
    } else {
      await clienteRef.delete();
      await auditar({
        accion: 'ELIMINAR_CLIENTE',
        descripcion: 'Admin eliminó cliente ' + datosCliente.nombre + ' (sin historial)',
        usuarioId: req.adminId || req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        datos: { id: req.params.id, nombre: datosCliente.nombre }
      });
      res.json({ accion: 'eliminado', mensaje: datosCliente.nombre + ' fue eliminado permanentemente.' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/clients/:id/historial — Historial completo del cliente
// ─────────────────────────────────────────────────────────────────────────────
// Ola 2: en una sola llamada devuelve TODO lo que necesita la pestaña
// "Historial" del módulo Clientes:
//   - Órdenes (todas, ordenadas más recientes primero)
//   - Cotizaciones del cliente
//   - QR / equipos asignados (hojas de vida)
//   - Resumen: total facturado, último servicio, # de servicios, saldo CxC
// ═════════════════════════════════════════════════════════════════════════════
router.get('/:id/historial', authenticate, validarTenant('clients'), async (req, res) => {
  try {
    const { id } = req.params;

    // 1) Validar que el cliente exista y obtener datos básicos
    const cliDoc = await db.collection('clients').doc(id).get();
    if (!cliDoc.exists) return res.status(404).json({ error: 'Cliente no encontrado' });
    const cliente = { id: cliDoc.id, ...cliDoc.data() };

    // 2) Buscar todas las órdenes del cliente (por clienteId, NO por nombre —
    //    el nombre se edita; el id no).
    const ordersSnap = await db.collection('orders')
      .where('clienteId', '==', id)
      .get();
    const ordenes = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // 3) Cotizaciones — algunos sistemas viejos pueden tenerlas en otra colección
    let cotizaciones = [];
    try {
      const cotSnap = await db.collection('cotizaciones')
        .where('clienteId', '==', id)
        .get();
      cotizaciones = cotSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { /* la colección puede no existir todavía */ }

    // 4) QR / equipos asignados al cliente
    let equiposQR = [];
    try {
      const qrSnap = await db.collection('qr_equipos')
        .where('propietario.clienteId', '==', id)
        .get();
      equiposQR = qrSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
      // fallback por si el campo se guarda en otro path
      try {
        const qrSnap2 = await db.collection('qr_equipos')
          .where('clienteId', '==', id)
          .get();
        equiposQR = qrSnap2.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch { equiposQR = []; }
    }

    // 5) Resumen ejecutivo
    const ordenesCompletadas = ordenes.filter(o =>
      o.estado === 'completada' || o.estado === 'cuadre_dinero' || o.estado === 'cxc'
    );
    const totalFacturado = ordenesCompletadas.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const totalPagado    = ordenesCompletadas.reduce((s, o) => s + (Number(o.montoPagado) || 0), 0);
    const saldoCxC       = totalFacturado - totalPagado;

    const fechasCompletadas = ordenesCompletadas
      .map(o => o.fechaCompletada || o.completadaEn || o.updatedAt?._seconds * 1000 || 0)
      .filter(f => f)
      .map(f => typeof f === 'string' ? new Date(f).getTime() : Number(f))
      .filter(f => !isNaN(f));
    const ultimoServicio = fechasCompletadas.length > 0
      ? new Date(Math.max(...fechasCompletadas)).toISOString()
      : null;

    // Ordenar de más reciente a más viejo
    const sortDesc = (a, b) => {
      const aT = a.createdAt?._seconds || (a.createdAt ? new Date(a.createdAt).getTime() / 1000 : 0);
      const bT = b.createdAt?._seconds || (b.createdAt ? new Date(b.createdAt).getTime() / 1000 : 0);
      return bT - aT;
    };
    ordenes.sort(sortDesc);
    cotizaciones.sort(sortDesc);

    res.json({
      cliente,
      ordenes,
      cotizaciones,
      equiposQR,
      resumen: {
        totalOrdenes: ordenes.length,
        ordenesCompletadas: ordenesCompletadas.length,
        ordenesAnuladas: ordenes.filter(o => o.estado === 'anulada').length,
        ordenesEnCurso: ordenes.filter(o => !['completada', 'cuadre_dinero', 'cxc', 'anulada'].includes(o.estado)).length,
        totalFacturado,
        totalPagado,
        saldoCxC,
        ultimoServicio,
        totalCotizaciones: cotizaciones.length,
        cotizacionesAprobadas: cotizaciones.filter(c => c.estado === 'aprobada' || c.estado === 'convertida').length,
        totalQR: equiposQR.length
      }
    });
  } catch (e) {
    console.error('GET /clients/:id/historial:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/clients/:id/asignar-sector — Mini-Ola 2.6
// Permite asignar/cambiar el sector de un cliente o de una sucursal desde
// Logística. Sandra (o el comercial) puede usar esto cuando el mensajero
// llega a una orden sin sector y necesita organizarlo en el flujo.
// Body: { sectorId: 'sec_norte', sucursalId: 'suc-...' (opcional) }
// Si llega sucursalId → asigna al sector de esa sucursal.
// Si no llega sucursalId → asigna al sector general del cliente.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/asignar-sector', authenticate, validarTenant('clients'), async (req, res) => {
  try {
    const { id } = req.params;
    const { sectorId, sucursalId } = req.body;

    if (!sectorId) return res.status(400).json({ error: 'sectorId requerido' });

    const clienteRef = db.collection('clients').doc(id);
    const doc = await clienteRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Cliente no encontrado' });

    const cliente = doc.data();
    const cambios = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (sucursalId) {
      // Asignar al sector de UNA sucursal específica
      const sucursales = (cliente.sucursales || []).map(s =>
        s.id === sucursalId ? { ...s, sectorId } : s
      );
      const existe = sucursales.find(s => s.id === sucursalId);
      if (!existe) return res.status(404).json({ error: 'Sucursal no encontrada' });
      cambios.sucursales = sucursales;
    } else {
      // Asignar al sector general del cliente
      cambios.sectorId = sectorId;
    }

    await clienteRef.update(cambios);

    await auditar({
      accion: 'ASIGNAR_SECTOR',
      descripcion: `${req.user.nombre || req.user.email} asignó sector ${sectorId} a ${cliente.nombre}${sucursalId ? ` (sucursal ${sucursalId})` : ''}`,
      usuarioId: req.adminId || req.user.uid || req.user.id,
      usuarioNombre: req.user.nombre || req.user.email,
      datos: { clienteId: id, sectorId, sucursalId }
    });

    res.json({ ok: true, sectorId, sucursalId: sucursalId || null });
  } catch (e) {
    console.error('PUT asignar-sector:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
