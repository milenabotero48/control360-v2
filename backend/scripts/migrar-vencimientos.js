// ============================================================
// Control360 — Migración: vencimientos desde órdenes históricas
// Ubicación: backend/scripts/migrar-vencimientos.js
// ------------------------------------------------------------
// EJECUTAR UNA SOLA VEZ desde Railway Console o local:
//   node backend/scripts/migrar-vencimientos.js
//
// Qué hace:
//   · Recorre TODAS las órdenes completadas de TODOS los tenants
//   · Filtra items con categorías RECARGA Y MANTENIMIENTO / EXTINTORES
//   · Crea registros en `vencimientos` con mesVencimiento basado
//     en la fecha de completado de la orden (+ 12 meses)
//   · Respeta el anti-duplicado (no duplica si ya existe)
//   · Imprime un resumen al final
//
// SEGURO: no modifica órdenes ni clientes. Solo crea en `vencimientos`.
// ============================================================

require('dotenv').config();
require('../config/firebase'); // inicializa Firebase Admin

const { db, admin } = require('../config/firebase');
const { crearVencimientosDeOrden, PALABRAS_VENCIMIENTO } = require('../services/vencimientosService');

// Calcular mes de servicio desde la fecha de completado de la orden
const mesDesdefecha = (fecha) => {
  if (!fecha) return null;
  const f = new Date(fecha);
  if (isNaN(f)) return null;
  // Colombia UTC-5
  const fCO = new Date(f.getTime() - 5 * 3600 * 1000);
  return fCO.toISOString().slice(0, 7); // "YYYY-MM"
};

// Override temporal del mesActualColombia para usar la fecha real de la orden
// (el servicio normalmente usa "hoy", pero en migración necesitamos la fecha histórica)
const calcularMesVencimientoHistorico = (yyyymm) => {
  const [y, m] = yyyymm.split('-').map(Number);
  const total  = m + 12;
  const anio   = y + Math.floor((total - 1) / 12);
  const mes    = ((total - 1) % 12) + 1;
  return `${anio}-${String(mes).padStart(2, '0')}-01`;
};

const esItemConVencimiento = (item = {}) => {
  const cat = (item.categoria || '').toLowerCase().trim();
  const nom = (item.nombre   || '').toLowerCase().trim();
  return PALABRAS_VENCIMIENTO.some(p => cat.includes(p) || nom.includes(p));
};

const migrar = async () => {
  console.log('🔄 Iniciando migración de vencimientos históricos...\n');

  const snap = await db.collection('orders')
    .where('estado', '==', 'completada')
    .get();

  console.log(`📦 Total de órdenes completadas encontradas: ${snap.size}\n`);

  let procesadas = 0, conVencimiento = 0, errores = 0;
  const resumenTenants = {};

  for (const doc of snap.docs) {
    const orden = { id: doc.id, ...doc.data() };
    const adminId = orden.adminId;
    if (!adminId) continue;

    const items = (orden.items || []).filter(esItemConVencimiento);
    if (!items.length) { procesadas++; continue; }

    // Fecha de servicio = fechaCompletada o createdAt
    const fechaServicio = orden.fechaCompletada || orden.createdAt?.toDate?.()?.toISOString();
    const mesServicio   = mesDesdefecha(fechaServicio) || new Date().toISOString().slice(0, 7);
    const mesVencimiento = calcularMesVencimientoHistorico(mesServicio);

    const clienteId = orden.clienteId || null;
    const telefono  = orden.clienteTelefono || orden.telefono || null;
    if (!clienteId && !telefono) { procesadas++; continue; }

    try {
      const batch = db.batch();
      let creados = 0, renovados = 0;

      for (const item of items) {
        const descripcion = (item.nombre || item.descripcion || 'Extintor').trim();
        const cantidad    = Number(item.cantidad) || 1;

        // Anti-dup: buscar por clienteId + equipo + mesVencimiento
        let existing = null;
        if (clienteId) {
          const s = await db.collection('vencimientos')
            .where('adminId',          '==', adminId)
            .where('clienteId',        '==', clienteId)
            .where('descripcionEquipo','==', descripcion)
            .where('fechaVencimiento', '==', mesVencimiento)
            .limit(1).get();
          if (!s.empty) existing = s.docs[0];
        }
        if (!existing && telefono) {
          const s = await db.collection('vencimientos')
            .where('adminId',          '==', adminId)
            .where('telefono',         '==', telefono)
            .where('descripcionEquipo','==', descripcion)
            .where('fechaVencimiento', '==', mesVencimiento)
            .limit(1).get();
          if (!s.empty) existing = s.docs[0];
        }

        if (existing) {
          renovados++;
          // No actualizar si es más reciente que la migración
          continue;
        }

        const ref = db.collection('vencimientos').doc();
        batch.set(ref, {
          adminId,
          clienteId:         clienteId || null,
          telefono:          telefono  || null,
          sucursal:          orden.sucursal || null,
          descripcionEquipo: descripcion,
          cantidad,
          mesServicio,
          fechaVencimiento:  mesVencimiento,
          gestionado:        false,
          origenDato:        'migracion_historica',
          ordenId:           doc.id,
          createdAt:         admin.firestore.FieldValue.serverTimestamp(),
        });
        creados++;
      }

      if (creados > 0) await batch.commit();

      if (!resumenTenants[adminId]) resumenTenants[adminId] = { creados: 0, omitidos: 0 };
      resumenTenants[adminId].creados  += creados;
      resumenTenants[adminId].omitidos += renovados;

      conVencimiento++;
    } catch (e) {
      console.error(`❌ Error en orden ${doc.id}:`, e.message);
      errores++;
    }
    procesadas++;

    if (procesadas % 50 === 0) {
      console.log(`  ⏳ Procesadas: ${procesadas}/${snap.size}...`);
    }
  }

  console.log('\n✅ Migración completada\n');
  console.log(`📊 Resumen:`);
  console.log(`   Total procesadas:            ${procesadas}`);
  console.log(`   Con items de vencimiento:    ${conVencimiento}`);
  console.log(`   Errores:                     ${errores}`);
  console.log('\n📋 Por tenant (adminId):');
  Object.entries(resumenTenants).forEach(([id, r]) => {
    console.log(`   ${id}: ${r.creados} creados, ${r.omitidos} ya existían`);
  });

  process.exit(0);
};

migrar().catch(e => {
  console.error('Error fatal en migración:', e);
  process.exit(1);
});
