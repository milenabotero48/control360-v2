// ════════════════════════════════════════════════════════════════════════════════
// tallerRespuestas.js — TALLER-RESPUESTA-001
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA QUE RESUELVE
// El taller registra un defecto y Anny le pregunta al cliente por WhatsApp
// "¿Autoriza la reparación? Responda SÍ o NO". El cliente responde... y ahí
// muere. Si el asesor no está leyendo las conversaciones, el equipo se queda
// parado en taller aunque el cliente ya dijo que sí hace tres días.
//
// QUÉ HACE ESTE SERVICIO
// Deja constancia de lo que el cliente respondió, en el defecto mismo, para
// que el taller lo vea al entrar. NADA MÁS.
//
// ⚠️ REGLA ARQUITECTÓNICA NO NEGOCIABLE (leer antes de modificar):
// El objeto `respuestaCliente` que escribe este servicio es INFORMATIVO.
//   - NO cambia `defecto.estado` (sigue en 'pendiente_autorizacion')
//   - NO toca inventario, ni stock, ni kardex, ni totales de la orden
//   - NINGÚN proceso automático puede leerlo como fuente de verdad para
//     autorizar una reparación
// La autorización real la sigue ejecutando un humano desde GestionTaller,
// por el endpoint PUT /api/workshop/ordenes/:ordenId/defecto/autorizar, que
// no se modifica. Anny SUGIERE, el taller DECIDE.
//
// Si en el futuro alguien quiere automatizar la autorización a partir de este
// campo: NO. Una interpretación errónea de "sí, pero cuánto vale" descontaría
// inventario y facturaría repuestos que el cliente nunca aprobó.
// ════════════════════════════════════════════════════════════════════════════════

// Mismo patrón de inicialización que el resto de services/ (annyService,
// llamadasIAService) — no se instancia firebase-admin por separado.
const { db, admin } = require('../config/firebase');

// Misma normalización que annyService / vencimientos / comercial:
// solo dígitos, sin prefijo 57 → celular CO de 10 dígitos.
function normalizarTelefono(telefono) {
  if (!telefono) return null;
  let t = String(telefono).replace(/[\s\-().+]/g, '').replace(/\D/g, '');
  if (t.length === 12 && t.startsWith('57')) t = t.slice(2);
  return t || null;
}

// ════════════════════════════════════════════════════════════════════════════
// Busca el defecto pendiente de autorización más reciente de este teléfono.
// AISLAMIENTO: filtra SIEMPRE por adminId — solo lectura.
// Devuelve null si no hay ninguno (caso normal: el cliente escribe por otra cosa).
// ════════════════════════════════════════════════════════════════════════════
async function buscarDefectoPendiente(adminId, telefonoRaw) {
  try {
    const tel = normalizarTelefono(telefonoRaw);
    if (!tel || !adminId) return null;

    // Dos filtros de igualdad: Firestore los resuelve sin índice compuesto.
    const snap = await db.collection('orders')
      .where('adminId', '==', adminId)
      .where('tieneDefectosPendientes', '==', true)
      .get();

    let mejor = null;

    snap.forEach(doc => {
      const o = doc.data();
      if (normalizarTelefono(o.clienteCelular) !== tel) return;

      const defectos = Array.isArray(o.tallerDefectos) ? o.tallerDefectos : [];
      defectos.forEach((d, idx) => {
        if (d.estado !== 'pendiente_autorizacion') return;
        const ts = Date.parse(d.fecha || '') || 0;
        if (!mejor || ts > mejor.ts) {
          mejor = {
            ts,
            ordenId: doc.id,
            numeroOrden: o.numeroOrden || '',
            clienteNombre: o.clienteNombre || '',
            defectoIndex: idx,
            descripcion: d.descripcion || '',
            costoReparacion: Number(d.costoReparacion) || 0,
            yaRespondido: !!d.respuestaCliente
          };
        }
      });
    });

    return mejor;
  } catch (err) {
    console.error('[TALLER-RESP] Error buscando defecto pendiente:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Registra la respuesta del cliente en el defecto — SOLO como información.
//
// valor: 'APROBADO' | 'RECHAZADO'  (nunca null: el llamador filtra las dudas)
// textoLiteral: lo que el cliente escribió, tal cual. Es la pieza clave —
//   si Anny interpretó mal, el técnico lo ve y decide distinto.
//
// Se usa transacción porque el técnico puede estar autorizando el mismo
// defecto desde la UI en este preciso momento: si ya dejó de estar pendiente,
// no se escribe nada.
// ════════════════════════════════════════════════════════════════════════════
async function registrarRespuestaCliente(adminId, telefonoRaw, valor, textoLiteral) {
  try {
    if (valor !== 'APROBADO' && valor !== 'RECHAZADO') return null;

    const pendiente = await buscarDefectoPendiente(adminId, telefonoRaw);
    if (!pendiente) return null;

    const ordenRef = db.collection('orders').doc(pendiente.ordenId);

    const resultado = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ordenRef);
      if (!doc.exists) return null;

      const o = doc.data();
      // Revalidación de tenant dentro de la transacción
      if (o.adminId && o.adminId !== adminId) return null;

      const defectos = Array.isArray(o.tallerDefectos) ? [...o.tallerDefectos] : [];
      const d = defectos[pendiente.defectoIndex];
      if (!d) return null;

      // El técnico ganó la carrera: ya lo autorizó/rechazó desde la UI.
      // No se pisa una decisión humana con una interpretación de IA.
      if (d.estado !== 'pendiente_autorizacion') return null;

      defectos[pendiente.defectoIndex] = {
        ...d,
        // ⚠️ INFORMATIVO — ver cabecera del archivo. `estado` NO se toca.
        respuestaCliente: {
          valor,
          textoLiteral: String(textoLiteral || '').slice(0, 500),
          telefono: normalizarTelefono(telefonoRaw),
          fecha: new Date().toISOString(),
          origen: 'anny_whatsapp'
        }
      };

      tx.update(ordenRef, {
        tallerDefectos: defectos,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        ordenId: pendiente.ordenId,
        numeroOrden: pendiente.numeroOrden,
        clienteNombre: pendiente.clienteNombre,
        defectoIndex: pendiente.defectoIndex,
        descripcion: pendiente.descripcion,
        costoReparacion: pendiente.costoReparacion,
        valor
      };
    });

    if (resultado) {
      console.log(`[TALLER-RESP] Orden ${resultado.numeroOrden}: cliente respondió ${valor} (informativo, sin cambio de estado)`);
      // El cache de alertas dura 5 min; se invalida para que el taller vea
      // la novedad de inmediato y no dentro de cinco minutos.
      try {
        const alertas = require('../routes/alertas');
        if (typeof alertas.invalidarCacheAlertas === 'function') {
          alertas.invalidarCacheAlertas(adminId);
        }
      } catch (e) { /* si falla, la alerta aparece al expirar el cache */ }
    }

    return resultado;
  } catch (err) {
    console.error('[TALLER-RESP] Error registrando respuesta:', err.message);
    return null;
  }
}

module.exports = {
  buscarDefectoPendiente,
  registrarRespuestaCliente,
  normalizarTelefono
};
