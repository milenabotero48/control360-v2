// ═══════════════════════════════════════════════════════════════════════════════
// vehiculos.js — Maestro de vehículos y control de gasto por placa
// ─────────────────────────────────────────────────────────────────────────────
// EGRESO-VEHICULO-001
//
// PROBLEMA QUE RESUELVE
// ---------------------
// En julio 2026 se registraron $1.206.682 en "Transporte / Combustible" y
// $733.900 en "fletes", sin forma de saber a qué vehículo correspondían.
// La pregunta que la gerencia no podía responder:
//     "¿Cuál de mis vehículos se está comiendo la plata?"
//
// POR QUÉ UN MAESTRO Y NO UN CAMPO DE TEXTO
// ------------------------------------------
// El mismo error que produjo cuatro variantes de "Señalización" en el ERI
// (SEÑALIZACIÓN GENERICA / SEÑALIZACION GENERICA / SEÑALIZACION / ...) se
// repetiría con las placas: "WGY123", "wgy-123", "WGY 123" contarían como
// tres vehículos distintos y el reporte de consumo sería inservible.
//
// La placa se normaliza SIEMPRE a mayúsculas sin espacios ni guiones, y se
// valida contra el formato colombiano antes de guardar.
//
// ENDPOINTS
//   GET    /api/vehiculos                  → lista
//   POST   /api/vehiculos                  → crear
//   PUT    /api/vehiculos/:id              → editar
//   DELETE /api/vehiculos/:id              → desactivar (nunca borra)
//   GET    /api/vehiculos/consumo          → gasto por vehículo en un rango
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firebase');

const resolverAdminId = (req) => req.adminId || req.user?.uid || req.user?.id || null;

// ─── Normalización de placa ──────────────────────────────────────────────────
// "wgy-123" · "WGY 123" · "Wgy123"  →  "WGY123"
const normalizarPlaca = (p) => String(p || '')
  .toUpperCase()
  .replace(/[\s\-._]/g, '')
  .trim();

// Formatos válidos en Colombia:
//   Automóvil / camioneta / camión : 3 letras + 3 números   → WGY123
//   Motocicleta (actual)           : 3 letras + 2 números + 1 letra → ABC12D
//   Motocicleta (antigua)          : 3 letras + 2 números   → ABC12
//   Remolque / semirremolque       : R + 5 números          → R12345
const PLACA_VALIDA = /^([A-Z]{3}\d{3}|[A-Z]{3}\d{2}[A-Z]|[A-Z]{3}\d{2}|R\d{5})$/;

const TIPOS = ['Automóvil', 'Camioneta', 'Camión', 'Motocicleta', 'Furgón', 'Remolque', 'Otro'];

const registrarAuditoria = async (datos) => {
  try {
    await db.collection('audit_logs').add({
      ...datos,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      fecha: new Date().toISOString()
    });
  } catch (e) { console.error('Auditoría vehículos:', e); }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vehiculos — lista del suscriptor
// ═════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'No autenticado' });

    const snap = await db.collection('vehiculos').where('userId', '==', adminId).get();
    const lista = [];
    snap.forEach(d => lista.push({ id: d.id, ...d.data() }));

    // Activos primero, luego por placa
    lista.sort((a, b) => {
      if ((a.activo !== false) !== (b.activo !== false)) return a.activo === false ? 1 : -1;
      return String(a.placa || '').localeCompare(String(b.placa || ''));
    });

    res.json(lista);
  } catch (e) {
    console.error('GET vehiculos:', e);
    res.status(500).json({ error: 'Error al cargar vehículos' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/vehiculos — crear
// ═════════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'No autenticado' });

    const { placa, tipo, marca, modelo, conductorId, conductorNombre, notas } = req.body;

    const placaNorm = normalizarPlaca(placa);
    if (!placaNorm) return res.status(400).json({ error: 'La placa es obligatoria' });
    if (!PLACA_VALIDA.test(placaNorm)) {
      return res.status(400).json({
        error: `"${placa}" no tiene formato de placa colombiana. Ejemplos válidos: WGY123 (vehículo), ABC12D (moto), R12345 (remolque).`
      });
    }

    // Unicidad por suscriptor — evita el problema de las categorías duplicadas
    const existe = await db.collection('vehiculos')
      .where('userId', '==', adminId)
      .where('placa', '==', placaNorm)
      .limit(1).get();
    if (!existe.empty) {
      return res.status(400).json({ error: `La placa ${placaNorm} ya está registrada` });
    }

    const nuevo = {
      userId: adminId,
      placa: placaNorm,
      tipo: TIPOS.includes(tipo) ? tipo : 'Otro',
      marca: (marca || '').trim(),
      modelo: (modelo || '').trim(),
      conductorId: conductorId || '',
      conductorNombre: (conductorNombre || '').trim(),
      notas: (notas || '').trim(),
      activo: true,
      creadoPor: req.user?.email || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('vehiculos').add(nuevo);

    await registrarAuditoria({
      accion: 'VEHICULO_CREADO',
      modulo: 'vehiculos',
      descripcion: `Vehículo ${placaNorm} registrado`,
      usuarioId: adminId,
      usuarioNombre: req.user?.email || '',
      documento: placaNorm,
      datos: { vehiculoId: ref.id, placa: placaNorm, tipo: nuevo.tipo }
    });

    res.json({ id: ref.id, ...nuevo });
  } catch (e) {
    console.error('POST vehiculos:', e);
    res.status(500).json({ error: 'Error al crear vehículo' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/vehiculos/:id — editar
// ═════════════════════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const ref = db.collection('vehiculos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Vehículo no encontrado' });
    if (doc.data().userId !== adminId) return res.status(403).json({ error: 'Vehículo de otra empresa' });

    const { placa, tipo, marca, modelo, conductorId, conductorNombre, notas, activo } = req.body;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (placa !== undefined) {
      const placaNorm = normalizarPlaca(placa);
      if (!PLACA_VALIDA.test(placaNorm)) {
        return res.status(400).json({ error: `"${placa}" no tiene formato de placa colombiana válido` });
      }
      if (placaNorm !== doc.data().placa) {
        const existe = await db.collection('vehiculos')
          .where('userId', '==', adminId).where('placa', '==', placaNorm).limit(1).get();
        if (!existe.empty) return res.status(400).json({ error: `La placa ${placaNorm} ya está registrada` });
      }
      update.placa = placaNorm;
    }
    if (tipo !== undefined)            update.tipo = TIPOS.includes(tipo) ? tipo : 'Otro';
    if (marca !== undefined)           update.marca = (marca || '').trim();
    if (modelo !== undefined)          update.modelo = (modelo || '').trim();
    if (conductorId !== undefined)     update.conductorId = conductorId || '';
    if (conductorNombre !== undefined) update.conductorNombre = (conductorNombre || '').trim();
    if (notas !== undefined)           update.notas = (notas || '').trim();
    if (activo !== undefined)          update.activo = activo !== false;

    await ref.update(update);
    res.json({ id: req.params.id, ...doc.data(), ...update });
  } catch (e) {
    console.error('PUT vehiculos:', e);
    res.status(500).json({ error: 'Error al editar vehículo' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DELETE /api/vehiculos/:id — desactivar
// ─────────────────────────────────────────────────────────────────────────────
// Nunca borra: los egresos históricos apuntan a este vehículo y perderían la
// referencia. Solo lo saca de la lista de selección.
// ═════════════════════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    const ref = db.collection('vehiculos').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Vehículo no encontrado' });
    if (doc.data().userId !== adminId) return res.status(403).json({ error: 'Vehículo de otra empresa' });

    await ref.update({ activo: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    await registrarAuditoria({
      accion: 'VEHICULO_DESACTIVADO',
      modulo: 'vehiculos',
      descripcion: `Vehículo ${doc.data().placa} desactivado`,
      usuarioId: adminId,
      usuarioNombre: req.user?.email || '',
      documento: doc.data().placa,
      datos: { vehiculoId: req.params.id }
    });

    res.json({ ok: true, desactivado: true });
  } catch (e) {
    console.error('DELETE vehiculos:', e);
    res.status(500).json({ error: 'Error al desactivar vehículo' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/vehiculos/consumo?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
// Devuelve el gasto acumulado por vehículo en el rango, con desglose por
// categoría y el detalle de egresos. Incluye el bloque "sinAsignar", que es
// justamente la plata que hoy no se puede atribuir a ningún vehículo.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/consumo', async (req, res) => {
  try {
    const adminId = resolverAdminId(req);
    if (!adminId) return res.status(401).json({ error: 'No autenticado' });

    const { desde, hasta } = req.query;

    const [vehSnap, egrSnap] = await Promise.all([
      db.collection('vehiculos').where('userId', '==', adminId).get(),
      db.collection('egresos').where('userId', '==', adminId).get()
    ]);

    const vehiculos = {};
    vehSnap.forEach(d => {
      const v = d.data();
      vehiculos[d.id] = {
        vehiculoId: d.id, placa: v.placa, tipo: v.tipo,
        marca: v.marca || '', modelo: v.modelo || '',
        conductorNombre: v.conductorNombre || '', activo: v.activo !== false,
        total: 0, egresos: 0, porCategoria: {}, detalle: []
      };
    });

    // Categorías que representan gasto de vehículo
    const esGastoVehiculo = (cat) => /combustible|gasolina|acpm|diesel|transporte|vehiculo|peaje|parqueadero|mantenimiento|flete|llanta|lavado|seguro|soat|tecnomecanic/i
      .test(String(cat || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));

    let sinAsignarTotal = 0;
    let sinAsignarCantidad = 0;
    const sinAsignarDetalle = [];

    egrSnap.forEach(d => {
      const e = d.data();
      if (e.anulado === true) return;
      if (e.estado !== 'PAGADO') return;
      if (desde && e.fecha && e.fecha < desde) return;
      if (hasta && e.fecha && e.fecha > hasta) return;

      const valor = Number(e.totalPagar || e.monto) || 0;
      if (valor <= 0) return;

      if (e.vehiculoId && vehiculos[e.vehiculoId]) {
        const v = vehiculos[e.vehiculoId];
        v.total += valor;
        v.egresos += 1;
        v.porCategoria[e.categoria || 'Sin categoría'] =
          (v.porCategoria[e.categoria || 'Sin categoría'] || 0) + valor;
        v.detalle.push({
          id: d.id, numero: e.numero, fecha: e.fecha,
          concepto: e.concepto, categoria: e.categoria, valor
        });
      } else if (esGastoVehiculo(e.categoria)) {
        // Gasto que PARECE de vehículo pero no tiene placa asignada
        sinAsignarTotal += valor;
        sinAsignarCantidad += 1;
        sinAsignarDetalle.push({
          id: d.id, numero: e.numero, fecha: e.fecha,
          concepto: e.concepto, categoria: e.categoria, valor
        });
      }
    });

    const lista = Object.values(vehiculos)
      .map(v => ({
        ...v,
        detalle: v.detalle.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))),
        promedioPorEgreso: v.egresos > 0 ? Math.round(v.total / v.egresos) : 0
      }))
      .sort((a, b) => b.total - a.total);

    const totalAsignado = lista.reduce((a, v) => a + v.total, 0);

    res.json({
      desde: desde || null,
      hasta: hasta || null,
      totalAsignado,
      totalGeneral: totalAsignado + sinAsignarTotal,
      // % de trazabilidad: qué tanto del gasto de vehículos sí sabemos a quién atribuir
      trazabilidad: (totalAsignado + sinAsignarTotal) > 0
        ? Math.round(totalAsignado / (totalAsignado + sinAsignarTotal) * 100)
        : 100,
      vehiculos: lista,
      sinAsignar: {
        total: sinAsignarTotal,
        cantidad: sinAsignarCantidad,
        detalle: sinAsignarDetalle.sort((a, b) => b.valor - a.valor)
      }
    });
  } catch (e) {
    console.error('GET vehiculos/consumo:', e);
    res.status(500).json({ error: 'Error al calcular consumo por vehículo' });
  }
});

module.exports = router;
module.exports.normalizarPlaca = normalizarPlaca;
module.exports.PLACA_VALIDA = PLACA_VALIDA;
module.exports.TIPOS = TIPOS;
