const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');
const jwt = require('jsonwebtoken');
const { authenticate, validarTenant } = require('../middleware/auth');

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
// GET /api/clients — Listar clientes (filtro por empresa opcional)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { empresaId, buscar, activo } = req.query;
    let query = db.collection('clients');

    if (empresaId) query = query.where('empresaId', '==', empresaId);

    // Solo admin ve inactivos si los pide explícitamente
    if (activo === 'todos' && req.user.role === 'admin') {
      // no filtrar
    } else {
      query = query.where('activo', '==', true);
    }

    query = query.orderBy('nombre', 'asc');
    const snapshot = await query.get();

    let clientes = [];
    snapshot.forEach(doc => clientes.push({ id: doc.id, ...doc.data() }));

    // Filtro de búsqueda por texto
    if (buscar) {
      const term = buscar.toUpperCase();
      clientes = clientes.filter(c =>
        c.nombre?.includes(term) ||
        c.nit?.includes(term) ||
        c.email?.includes(buscar.toLowerCase())
      );
    }

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

    // Verificar NIT exacto
    if (nit) {
      const nitSnap = await db.collection('clients').where('nit', '==', nit.toString()).get();
      if (!nitSnap.empty) {
        resultado.nitDuplicado = true;
        resultado.clienteExistente = { id: nitSnap.docs[0].id, ...nitSnap.docs[0].data() };
        return res.json(resultado);
      }
    }

    // Verificar nombre similar
    if (nombre) {
      const todosSnap = await db.collection('clients').get();
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
      confirmarDuplicado = false
    } = req.body;

    // Validaciones obligatorias
    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!empresaId) return res.status(400).json({ error: 'Debes asignar el cliente a una empresa (Sur o Valle)' });

    // Nombre siempre en mayúsculas
    const nombreUpper = nombre.toUpperCase().trim();

    // Validar NIT solo números
    if (nit && !/^\d+$/.test(nit)) {
      return res.status(400).json({ error: 'El NIT debe contener solo números' });
    }

    // Validar celular solo números
    if (celular && !/^\d{10}$/.test(celular)) {
      return res.status(400).json({ error: 'El celular debe tener exactamente 10 dígitos' });
    }

    // Validar teléfono solo números
    if (telefono && !/^\d+$/.test(telefono)) {
      return res.status(400).json({ error: 'El teléfono debe contener solo números' });
    }

    // Anti-duplicado NIT
    if (nit && !confirmarDuplicado) {
      const nitExiste = await db.collection('clients').where('nit', '==', nit.toString()).get();
      if (!nitExiste.empty) {
        return res.status(409).json({
          error: 'Ya existe un cliente con ese NIT',
          clienteExistente: { id: nitExiste.docs[0].id, ...nitExiste.docs[0].data() }
        });
      }
    }

    // Construir objeto cliente
    const nuevoCliente = {
      nombre: nombreUpper,
      nit: nit ? nit.toString() : '',
      tipoDocumento,
      telefono: telefono || '',
      celular: celular || '',
      emailLegal: emailLegal || '',
      emailsAdicionales: Array.isArray(emailsAdicionales) ? emailsAdicionales.filter(e => e) : [],
      direccionPrincipal: direccionPrincipal || '',
      ciudad: ciudad || '',
      departamento: departamento || '',
      empresaId,
      empresaNombre: empresaNombre || '',
      sucursales: sucursales.map((s, i) => ({
        id: `suc-${Date.now()}-${i}`,
        nombre: s.nombre?.toUpperCase().trim() || '',
        direccion: s.direccion || '',
        ciudad: s.ciudad || '',
        telefono: s.telefono?.replace(/\D/g, '') || '',
        encargado: s.encargado || '',
        activo: true
      })),
      notas,
      activo: true,
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
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nombre, nit, tipoDocumento,
      telefono, celular, emailLegal, emailsAdicionales,
      direccionPrincipal, ciudad, departamento,
      sucursales, notas, activo,
      empresaId, empresaNombre
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
      activo: s.activo !== false
    }));
    if (notas !== undefined) cambios.notas = notas;
    if (activo !== undefined) cambios.activo = activo;
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
router.delete('/:id', authenticate, async (req, res) => {
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

module.exports = router;
