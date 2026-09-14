// ============================================================
// Control360 — Diagnóstico PAGO-CUADRE-005b (SOLO LECTURA)
// ============================================================
// Foco: tenant iLc4V2z0UeyjhI653tMC — 28 órdenes pagadas con forma
// virtual (Daviplata/Nequi/Bancolombia), pagado:true, sin
// pagoVirtualPendienteValidar y sin movimiento en caja.
// Objetivo: confirmar si (a) fueron registradas por admin/tesorería
// (validadoAutomaticamente:true) y (b) por qué no hay movimiento —
// ¿falta mapeo de caja para esas formas de pago?
// ============================================================

const { db } = require('../config/firebase');

const TENANT_ID = 'iLc4V2z0UeyjhI653tMC';
const ORDEN_IDS = [
  '2KNkLo7bbcziFehykvTh','2bYhdJr3BRGac54Bicca','3DP5Q8etml9ymQ7R4pFH',
  'AcVukOm17bh5n8rkut7h','BS01XXlmn5REw9OAzRQR','CidSlrY4dTzKbKi1FGTO',
  'E2TGgfuskgC8vpDc9kE8','FsthIYexfrpToIMkKuXX','G9GGPDfjzJAhTF8Xc1n9',
  'O6qaZAzpgiYh6zEyETIR','UZ6HVKDsCC7Aw3ak574G','aqYkOE0ctjfc4pTUpABA',
  'hIUxHGFZaHpTADA9WyOu','iHSwZSNIInipdKCxCRnA','mg1rece0oS8O3uolgW3x',
  'uxDXi25fhOTQEO8R5gGf'
];

async function main() {
  const out = { tenantId: TENANT_ID, ordenes: [], configuracion: null };

  // 1. Configuración de mapeo de cajas del tenant
  try {
    const cfgSnap = await db.collection('configuracion').doc(TENANT_ID).get();
    out.configuracion = cfgSnap.exists ? (cfgSnap.data().mapeoCajas || cfgSnap.data().formasPago || cfgSnap.data()) : null;
  } catch (e) { out.configuracionError = e.message; }

  // 2. Cajas del tenant (para ver si existe alguna con "daviplata"/"nequi"/"bancolombia" en el nombre)
  try {
    const cajasSnap = await db.collection('cajas').where('userId', '==', TENANT_ID).get();
    out.cajas = cajasSnap.docs.map(d => ({ id: d.id, nombre: d.data().nombre, tipo: d.data().tipo }));
  } catch (e) { out.cajasError = e.message; }

  // 3. Detalle de cada orden sospechosa
  for (const id of ORDEN_IDS) {
    try {
      const doc = await db.collection('orders').doc(id).get();
      if (!doc.exists) { out.ordenes.push({ id, existe: false }); continue; }
      const o = doc.data();
      out.ordenes.push({
        id,
        numeroOrden: o.numeroOrden,
        formaPago: o.formaPago,
        total: o.total,
        pagado: o.pagado,
        dineroEnCaja: o.dineroEnCaja,
        pagoVirtualPendienteValidar: o.pagoVirtualPendienteValidar,
        validadoAutomaticamente: o.validadoAutomaticamente,
        pagoValidado: o.pagoValidado,
        pagoValidadoPor: o.pagoValidadoPor,
        pagoValidadoPorNombre: o.pagoValidadoPorNombre,
        creadoPor: o.creadoPor,
        usuarioCreacion: o.usuarioCreacion || o.creadoPorEmail || null,
        ingresadoCaja: o.ingresadoCaja,
        historialUltimos: Array.isArray(o.historialEstados) ? o.historialEstados.slice(-2) : null
      });
    } catch (e) {
      out.ordenes.push({ id, error: e.message });
    }
  }

  // 4. Buscar movimientos que referencien estas órdenes por si acaso
  //    (por si el ordenId se guardó en otro campo o hay coincidencia parcial)
  try {
    const movs = await db.collection('movimientos').where('userId', '==', TENANT_ID).limit(30000).get();
    const idsSet = new Set(ORDEN_IDS);
    out.movimientosRelacionados = movs.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(m => idsSet.has(m.ordenId))
      .map(m => ({ id: m.id, ordenId: m.ordenId, cajaId: m.cajaId, monto: m.monto, formaPago: m.formaPago }));
  } catch (e) { out.movimientosError = e.message; }

  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }));
  process.exit(1);
});
