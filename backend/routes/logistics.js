const express = require('express');
const router  = express.Router();
const { db, admin } = require('../config/firebase');

// Reutilizar LA MISMA máquina de estados de orders.js (una sola fuente de
// verdad del flujo — el mensajero ya no recalcula el flujo por su cuenta).
const ordersRouter = require('./orders');
const construirFlujo = ordersRouter.construirFlujo;
const registrarIngresoEnCaja = ordersRouter.registrarIngresoEnCaja;
const { authenticate, validarTenant } = require('../middleware/auth');

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const auditar = async ({ accion, descripcion, usuarioId, usuarioEmail }) => {
  try {
    await db.collection('audit_logs').add({
      accion, modulo: 'logistica', descripcion,
      usuarioId, usuarioEmail,
      fecha: new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.error('Audit logistica:', e.message); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ÓRDENES PENDIENTES LOGÍSTICA
// GET /api/logistica/ordenes — Órdenes para asignar (programada + despacho)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/ordenes', async (req, res) => {
  try {
    const snap = await db.collection('orders')
      .where('estado', 'in', ['programada', 'despacho', 'en_ruta_recogida', 'en_ruta_entrega', 'entrega_cobranza'])
      .get();

    const hoy = new Date().toISOString().split('T')[0];
    const ordenes = [];

    snap.forEach(doc => {
      const o = { id: doc.id, ...doc.data() };
      const fechaProg = o.fechaProgramada || o.createdAt?.toDate?.()?.toISOString()?.split('T')[0] || hoy;
      ordenes.push({ ...o, fechaProgramada: fechaProg });
    });

    // Ordenar: fecha programada ASC (más antigua primero), futuras al final
    ordenes.sort((a, b) => {
      const fa = a.fechaProgramada || '9999';
      const fb = b.fechaProgramada || '9999';
      if (fa <= hoy && fb <= hoy) return fa.localeCompare(fb);
      if (fa <= hoy) return -1;
      if (fb <= hoy) return 1;
      return fa.localeCompare(fb);
    });

    res.json(ordenes);
  } catch (e) {
    console.error('GET logistica/ordenes:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ASIGNAR RUTA A MENSAJERO
// POST /api/logistica/asignar
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/asignar', async (req, res) => {
  try {
    const { mensajeroId, mensajeroNombre, mensajeroCelular, ordenIds } = req.body;
    if (!mensajeroId || !ordenIds?.length) {
      return res.status(400).json({ error: 'mensajeroId y ordenIds requeridos' });
    }

    const batch = db.batch();
    const hoy = new Date().toISOString().split('T')[0];

    for (const ordenId of ordenIds) {
      const ref = db.collection('orders').doc(ordenId);

      // CONDICIÓN DE RUTA:
      //  - Si hay ítems de recarga/mantenimiento SIN marcar "cambio" → hay
      //    equipo del cliente que recoger y llevar a taller → RECOGIDA.
      //  - Si TODOS los de recarga están marcados "cambio" (o no hay
      //    recarga) → el mensajero LLEVA el equipo listo → ENTREGA directa.
      // Esto cubre: orden de cambio = entrega; pero si el mensajero edita
      // y agrega equipos normales (sin cambio), pasa a recogida/taller.
      const snapOrd = await ref.get();
      const ordData = snapOrd.exists ? snapOrd.data() : {};
      const esRecargaMant = (it) => {
        const cat = (it.categoria || '').toLowerCase();
        return cat.includes('recarga') || cat.includes('mantenimiento')
          || cat.includes('hidrostatica') || cat.includes('hidrostática');
      };
      // ¿Hay al menos un equipo de recarga/mant que NO sea de cambio?
      const tieneRecogerReal = (ordData.items || []).some(
        it => esRecargaMant(it) && !it.esCambio
      );

      const estadoAsignado = tieneRecogerReal ? 'en_ruta_recogida' : 'en_ruta_entrega';

      batch.update(ref, {
        mensajeroId,
        mensajeroNombre: mensajeroNombre || '',
        estado: estadoAsignado,
        fechaAsignacion: hoy,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        historialEstados: admin.firestore.FieldValue.arrayUnion({
          estado: estadoAsignado,
          fecha: new Date().toISOString(),
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.email,
          nota: tieneRecogerReal
            ? `Asignada a ${mensajeroNombre} — recoge equipo para taller`
            : `Asignada a ${mensajeroNombre} — lleva equipo (cambio/venta), va a entrega`
        })
      });
    }

    await batch.commit();

    // Construir mensaje WhatsApp para mensajero
    const snapOrdenes = await Promise.all(ordenIds.map(id => db.collection('orders').doc(id).get()));
    const fmtCOP = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
    const detalles = snapOrdenes.map(d => {
      const o = d.data();
      const direccion = o.sucursalDireccion || o.clienteDireccion || o.clienteDireccionPrincipal || 'Sin dirección';
      const telefono = o.clienteCelular || o.clienteTelefono || '';
      const productos = (o.items || []).map(it => `     • ${it.cantidad}x ${it.nombre}${it.notas ? ` (${it.notas})` : ''}`).join('\n');
      const esCobranzaMsg = o.tipoOrden === 'cxc' || o.lugarAtencion === 'cobranza';
const valorMostrar = esCobranzaMsg ? (o.montoCobrar || 0) : (o.total || 0);
return `📋 *${o.numeroOrden}* — ${o.clienteNombre}${esCobranzaMsg ? ' 💳 *COBRANZA*' : ''}${telefono ? `\n   📞 ${telefono}` : ''}\n   📍 ${direccion}${!esCobranzaMsg && productos ? `\n   📦 Productos:\n${productos}` : ''}\n   💰 ${fmtCOP(valorMostrar)}`;
    }).join('\n\n');

    // Construir link Google Maps con todas las paradas en orden
    const direcciones = snapOrdenes
      .map(d => d.data()?.sucursalDireccion || d.data()?.clienteDireccion || d.data()?.clienteDireccionPrincipal || '')
      .filter(Boolean)
      .map(d => encodeURIComponent(d));

    let mapsUrl = '';
    if (direcciones.length > 0) {
      if (direcciones.length === 1) {
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${direcciones[0]}`;
      } else {
        const destino = direcciones[direcciones.length - 1];
        const waypoints = direcciones.slice(0, -1).join('|');
        mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destino}&waypoints=${waypoints}`;
      }
    }

    const msg = `🚚 *RUTA ASIGNADA — ${new Date().toLocaleDateString('es-CO')}*\n\nHola ${mensajeroNombre}, tienes ${ordenIds.length} orden${ordenIds.length !== 1 ? 'es' : ''} asignada${ordenIds.length !== 1 ? 's' : ''}:\n\n${detalles}\n\nTotal a recaudar: ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(snapOrdenes.reduce((s, d) => { const od = d.data(); const esC = od?.tipoOrden === 'cxc' || od?.lugarAtencion === 'cobranza'; return s + (esC ? (od?.montoCobrar || 0) : (od?.total || 0)); }, 0))}${mapsUrl ? `\n\n📍 *Tu ruta en Google Maps:*\n${mapsUrl}` : ''}\n\n¡Buena ruta! 💪`;

    const cel = mensajeroCelular?.replace(/\D/g, '') || '';
    const whatsappUrl = cel
      ? `https://wa.me/57${cel}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;

    await auditar({
      accion: 'RUTA_ASIGNADA',
      descripcion: `${ordenIds.length} órdenes asignadas a ${mensajeroNombre}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioEmail: req.user.email
    });

    res.json({ ok: true, ordenesAsignadas: ordenIds.length, whatsappUrl });
  } catch (e) {
    console.error('POST logistica/asignar:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ÓRDENES DEL MENSAJERO
// GET /api/logistica/mis-ordenes — Órdenes asignadas al mensajero activo
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/mis-ordenes', async (req, res) => {
  try {
    const userId = req.user.uid || req.user.id;
    const snap = await db.collection('orders')
      .where('mensajeroId', '==', userId)
      .where('estado', 'in', ['en_ruta_recogida', 'en_ruta_entrega', 'entrega_cobranza', 'programada', 'despacho'])
      .get();

    const ordenes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    ordenes.sort((a, b) => (a.fechaProgramada || '').localeCompare(b.fechaProgramada || ''));
    res.json(ordenes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AVANZAR ESTADO DE ORDEN (mensajero)

// ✅ CTRL-002: NUEVA FUNCIÓN: Registrar deficiencia
const registrarDeficiencia = async ({ adminId, ordenId, numeroOrden, tipo, mensajeroId, mensajeroNombre }) => {
  try {
    await db.collection('deficiencias').add({
      adminId,
      ordenId,
      numeroOrden,
      tipo,
      mensajeroId,
      mensajeroNombre,
      fecha: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('Error registrando deficiencia:', err);
  }
};

// ✅ CTRL-002: NUEVA FUNCIÓN: Actualizar score de mensajero
const actualizarScoreMensajero = async ({ adminId, mensajeroId, restarPuntos, tipo }) => {
  try {
    const userRef = db.collection('users').doc(mensajeroId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      console.warn('Usuario no encontrado para score update:', mensajeroId);
      return;
    }

    const user = userDoc.data();
    const scoreActual = user.scorePerformance || 100;
    const scoreNuevo = Math.max(0, scoreActual - restarPuntos);

    await userRef.update({
      scorePerformance: scoreNuevo,
      deficienciasCount: admin.firestore.FieldValue.increment(1),
      ultimaDeficiencia: new Date().toISOString()
    });

    const hace30dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deficienciasRecientes = await db.collection('deficiencias')
      .where('adminId', '==', adminId)
      .where('mensajeroId', '==', mensajeroId)
      .where('fecha', '>=', hace30dias.toISOString())
      .get();

    if (deficienciasRecientes.size >= 3) {
      await db.collection('admin_alertas').add({
        tipo: 'comportamiento_deficiencias',
        adminId,
        mensajeroId,
        mensajeroNombre: user.nombre || user.email,
        totalDeficiencias: deficienciasRecientes.size,
        mensaje: `⚠️ CRÍTICO: ${user.nombre || user.email} tiene ${deficienciasRecientes.size} deficiencias en 30 días. Requiere descargo.`,
        accion: 'Programar reunión 1:1',
        leida: false,
        fecha: new Date().toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    console.log(`Score actualizado: ${user.nombre} ${scoreActual} → ${scoreNuevo}`);
  } catch (err) {
    console.error('Error actualizando score:', err);
  }
};

// PUT /api/logistica/orden/:id/estado
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/orden/:id/estado', authenticate, validarTenant('orders'), async (req, res) => {
  try {
    const { nuevoEstado, nota, extintorPrestamo, fotoUrl, cobro, formaPago, fotoTransferenciaUrl, items, gps, prestamoDevueltoId, deficiencia } = req.body;
    if (!nuevoEstado) return res.status(400).json({ error: 'nuevoEstado requerido' });

    const ordenRef = db.collection('orders').doc(req.params.id);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();
    const timestampFoto = new Date().toISOString();

    const update = {
      estado: nuevoEstado,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      historialEstados: admin.firestore.FieldValue.arrayUnion({
        estado: nuevoEstado,
        fecha: timestampFoto,
        usuarioId: req.user.uid || req.user.id,
        usuarioNombre: req.user.nombre || req.user.email,
        nota: nota || '',
        gps: gps || null
      })
    };

    // ✅ CTRL-002: Si hay deficiencia, registrarla
    if (deficiencia) {
      const getAdminId = (req) => req.user.adminId || req.user.uid;
      const adminId = getAdminId(req);
      
      await registrarDeficiencia({
        adminId,
        ordenId: req.params.id,
        numeroOrden: orden.numeroOrden,
        tipo: deficiencia,
        mensajeroId: req.user.uid || req.user.id,
        mensajeroNombre: req.user.nombre || req.user.email
      });

      await actualizarScoreMensajero({
        adminId,
        mensajeroId: req.user.uid || req.user.id,
        restarPuntos: 5,
        tipo: deficiencia
      });

      update.deficiencia = deficiencia;
    }

    // Actualizar items si vienen
    if (items && items.length > 0) {
      update.items = items;
      const nuevoTotal = items.reduce((s, it) => s + (it.precioUnitario || 0) * (it.cantidad || 1) * (1 - (it.descuento || 0) / 100), 0);
      update.total = Math.round(nuevoTotal);

      // Si el mensajero agregó equipos de recarga/mant SIN marcar cambio,
      // esos equipos hay que recogerlos y llevarlos a taller. La orden
      // (que iba a entrega por ser cambio) se redirige a taller.
      const esRecMant = (it) => {
        const c = (it.categoria || '').toLowerCase();
        return c.includes('recarga') || c.includes('mantenimiento')
          || c.includes('hidrostatica') || c.includes('hidrostática');
      };
      const hayEquipoParaTaller = items.some(it => esRecMant(it) && !it.esCambio);
      if (hayEquipoParaTaller
          && ['en_ruta_entrega', 'en_ruta_recogida'].includes(orden.estado)
          && nuevoEstado !== 'en_taller') {
        update.estado = 'en_taller';
        update.tieneEquipoTaller = true;
        update.historialEstados = admin.firestore.FieldValue.arrayUnion({
          estado: 'en_taller',
          fecha: timestampFoto,
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.nombre || req.user.email,
          nota: 'El mensajero agregó equipos para recargar — pasa a taller'
        });
      }
    }

    // Guardar foto de recogida
    if (nuevoEstado === 'en_taller' && fotoUrl) update.fotoRecogida = fotoUrl;

    // Guardar extintor préstamo
    if (extintorPrestamo) {
      update.extintorPrestamo = extintorPrestamo;
      // Registrar en colección de préstamos
      await db.collection('extintores_prestamo').add({
        numeroExtintor: extintorPrestamo,
        clienteId: orden.clienteId,
        clienteNombre: orden.clienteNombre,
        clienteDireccion: orden.sucursalDireccion || orden.clienteDireccion || '',
        ordenId: req.params.id,
        numeroOrden: orden.numeroOrden,
        mensajeroId: req.user.uid || req.user.id,
        mensajeroNombre: req.user.nombre || req.user.email,
        fechaSalida: new Date().toISOString(),
        estado: 'prestado',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Guardar foto de entrega
    if (nuevoEstado === 'entrega_cobranza' && fotoUrl) update.fotoEntrega = fotoUrl;
    if (fotoTransferenciaUrl) update.fotoTransferencia = fotoTransferenciaUrl;

    // ── REGISTRO DE COBRO — clasificado por forma de pago ────────────────────
    // El dinero NO entra a caja aquí: solo se registra. Entra en el cuadre PIN.
    const fp = (formaPago || '').toLowerCase();
    const esVirtual = /transfer|nequi|daviplata|banco|consign|qr|bancolombia/.test(fp);
    const esCredito = /crédito|credito|cxc|fiado/.test(fp);
    const montoCobro = Number(cobro) || 0;

    if (nuevoEstado === 'entrega_cobranza') {
      // Anti-recobro: si ya está pagada, no se vuelve a registrar cobro
      if (orden.pagado === true || orden.dineroEnCaja === true) {
        return res.status(409).json({ error: 'Esta orden ya está pagada.', yaPagada: true });
      }

      // ¿Hay un mensajero de por medio? Si NO hay mensajero asignado, la
      // persona que avanza la orden (admin/comercial) es quien recibe el
      // dinero AHORA. No habrá cuadre con PIN — por eso el dinero debe entrar
      // a caja en este momento, o se perdería.
      const hayMensajero = !!orden.mensajeroId;

      if (esCredito) {
        update.formaPagoRecaudo = 'A crédito (CxC)';
        update.montoRecaudado = 0;
        update.tipoCobro = 'credito';
      } else if (esVirtual) {
        if (!fotoTransferenciaUrl && !orden.fotoTransferencia) {
          return res.status(400).json({
            error: 'Para pago virtual debes subir la foto del comprobante.',
            requiereComprobante: true
          });
        }
        update.formaPagoRecaudo = formaPago || 'Transferencia';
        update.montoRecaudado = montoCobro || orden.total || 0;
        update.tipoCobro = 'virtual';
        if (hayMensajero) update.pagoVirtualPendienteValidar = true;
      } else {
        update.formaPagoRecaudo = formaPago || 'Efectivo';
        update.montoRecaudado = montoCobro || orden.total || 0;
        update.tipoCobro = 'efectivo';
      }

      if (!esCredito) {
        update.pagado = true;
        update.montoPagado = update.montoRecaudado;
        update.fechaPago = timestampFoto;
        // Solo se "cobra por mensajero" (espera cuadre) si HAY mensajero.
        update.cobradoPorMensajero = hayMensajero;
      }
      if (formaPago) update.formaPago = formaPago;

      // ── SIN MENSAJERO: cerrar la orden y meter el dinero a caja YA ─────────
      if (!hayMensajero) {
        if (esCredito) {
          // No pagó → queda en cartera (CxC), sin sumar a caja.
          update.estado = 'cxc';
          update.historialEstados = admin.firestore.FieldValue.arrayUnion(
            { estado: 'entrega_cobranza', fecha: timestampFoto,
              usuarioId: req.user.uid || req.user.id,
              usuarioNombre: req.user.nombre || req.user.email,
              nota: nota || '', gps: gps || null },
            { estado: 'cxc', fecha: timestampFoto,
              usuarioId: req.user.uid || req.user.id,
              usuarioNombre: req.user.nombre || req.user.email,
              nota: 'Sin pago: queda en cartera (CxC)' }
          );
        } else {
          // Pagó → el dinero entra a caja AHORA (candado anti-doble-suma
          // dentro de registrarIngresoEnCaja) y la orden queda completada.
          update.estado = 'completada';
          update.dineroEnCaja = true;
          update.dineroEnCajaFecha = timestampFoto;
          update.dineroEnCajaPor = req.user.email;
          update.historialEstados = admin.firestore.FieldValue.arrayUnion(
            { estado: 'entrega_cobranza', fecha: timestampFoto,
              usuarioId: req.user.uid || req.user.id,
              usuarioNombre: req.user.nombre || req.user.email,
              nota: nota || '', gps: gps || null },
            { estado: 'completada', fecha: timestampFoto,
              usuarioId: req.user.uid || req.user.id,
              usuarioNombre: req.user.nombre || req.user.email,
              nota: 'Cobro directo (sin mensajero): dinero en caja' }
          );
        }

        await ordenRef.update(update);

        // ── PRÉSTAMO: si el cliente devolvió el extintor de préstamo, se
        // registra AQUÍ mismo (no hay cuadre con mensajero que lo cierre).
        // Mismo efecto que hace el cuadre con PIN: vuelve a 'devuelto'.
        if (prestamoDevueltoId) {
          try {
            await db.collection('extintores_prestamo').doc(prestamoDevueltoId).update({
              estado: 'devuelto',
              fechaDevolucion: new Date().toISOString(),
              recibidoPor: req.user.email
            });
          } catch (ePrest) {
            console.warn('No se pudo marcar préstamo devuelto:', ePrest.message);
          }
        }

        // Registrar el dinero en caja usando la función de orders.js
        // (tiene el candado que impide doble suma).
        let resultadoCaja = null;
        if (!esCredito && typeof registrarIngresoEnCaja === 'function') {
          resultadoCaja = await registrarIngresoEnCaja({
            userId: req.adminId || req.user.uid || req.user.id,
            ordenId: req.params.id,
            numeroOrden: orden.numeroOrden,
            clienteNombre: orden.clienteNombre,
            monto: update.montoRecaudado,
            formaPago: formaPago || 'Efectivo',
            usuarioEmail: req.user.email,
            numeroFactura: orden.numeroFactura || ''
          });
        }

        await auditar({
          accion: 'COBRO_DIRECTO_SIN_MENSAJERO',
          descripcion: `Orden ${orden.numeroOrden} cobrada directo (sin mensajero) → ${update.estado}${prestamoDevueltoId ? ' · préstamo devuelto' : ''}`,
          usuarioId: req.user.uid || req.user.id,
          usuarioEmail: req.user.email
        });

        return res.json({
          ok: true,
          estado: update.estado,
          dineroEnCaja: !esCredito,
          prestamoDevuelto: !!prestamoDevueltoId,
          caja: resultadoCaja
        });
      }
    } else if (montoCobro > 0) {
      // El mensajero cobró FUERA de la entrega (ej: al recoger el equipo,
      // el cliente le paga ahí mismo). Hay que registrarlo igual que un
      // cobro normal para que entre al cuadre — si no, el dinero se pierde
      // cuando al mensajero se le olvida reportarlo.
      if (orden.pagado === true || orden.dineroEnCaja === true) {
        return res.status(409).json({ error: 'Esta orden ya está pagada.', yaPagada: true });
      }
      if (esCredito) {
        update.formaPagoRecaudo = 'A crédito (CxC)';
        update.montoRecaudado = 0;
        update.tipoCobro = 'credito';
      } else if (esVirtual) {
        if (!fotoTransferenciaUrl && !orden.fotoTransferencia) {
          return res.status(400).json({
            error: 'Para pago virtual debes subir la foto del comprobante.',
            requiereComprobante: true
          });
        }
        update.formaPagoRecaudo = formaPago || 'Transferencia';
        update.montoRecaudado = montoCobro;
        update.tipoCobro = 'virtual';
        if (orden.mensajeroId) update.pagoVirtualPendienteValidar = true;
      } else {
        update.formaPagoRecaudo = formaPago || 'Efectivo';
        update.montoRecaudado = montoCobro;
        update.tipoCobro = 'efectivo';
      }
      if (!esCredito) {
        update.pagado = true;
        update.montoPagado = montoCobro;
        update.fechaPago = timestampFoto;
        // Cobró el mensajero en ruta → tiene que cuadrarlo. La alerta a
        // tesorería se dispara más abajo (cobroParaCuadre).
        update.cobradoPorMensajero = !!orden.mensajeroId;
      }
      if (formaPago) update.formaPago = formaPago;
    }

    // ── AVANCE AUTOMÁTICO con la máquina de estados ÚNICA ────────────────────
    if (typeof construirFlujo === 'function') {
      let cursor = nuevoEstado;
      let guardia = 0;
      const extra = [];
      const tieneTaller = typeof orden.tieneEquipoTaller === 'boolean'
        ? orden.tieneEquipoTaller
        : (orden.items || []).some(it => {
            const c = (it.categoria || '').toLowerCase();
            return ['recarga','mantenimiento','hidrostatica','hidrostática'].some(k => c.includes(k));
          });
      while (guardia++ < 12) {
        const flujo = construirFlujo(orden.lugarAtencion, orden.requiereFactura, tieneTaller);
        const paso = flujo[cursor];
        if (!paso || !paso.auto) break;
        if (paso.requiereFacturaAntes && !orden.numeroFactura) break;
        cursor = paso.siguiente;
        extra.push({
          estado: cursor, fecha: timestampFoto,
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.nombre || req.user.email,
          nota: 'Avance automático del sistema'
        });
      }
      if (cursor !== nuevoEstado) {
        update.estado = cursor;
        update.historialEstados = admin.firestore.FieldValue.arrayUnion(
          { estado: nuevoEstado, fecha: timestampFoto,
            usuarioId: req.user.uid || req.user.id,
            usuarioNombre: req.user.nombre || req.user.email,
            nota: nota || '', gps: gps || null },
          ...extra
        );
      }
    }

    await ordenRef.update(update);

    // ── ALERTA A TESORERÍA: mensajero con dinero por cuadrar ─────────────────
    // Se dispara apenas el mensajero registra un cobro real — sin importar si
    // cobró en la recogida o en la entrega. Si ya hay una alerta abierta para
    // este mensajero, no se duplica (una sola hasta que cuadre).
    const mensajeroCobro = !!orden.mensajeroId
      && update.tipoCobro && update.tipoCobro !== 'credito'
      && Number(update.montoRecaudado) > 0;
    if (mensajeroCobro) {
      try {
        const yaAlerta = await db.collection('notificaciones')
          .where('tipo', '==', 'CUADRE_PENDIENTE')
          .where('mensajeroId', '==', orden.mensajeroId)
          .where('resuelta', '==', false)
          .limit(1).get();
        if (yaAlerta.empty) {
          await db.collection('notificaciones').add({
            tipo: 'CUADRE_PENDIENTE',
            mensajeroId: orden.mensajeroId,
            mensajeroNombre: orden.mensajeroNombre || '',
            adminId: req.adminId || req.user.uid || req.user.id,
            mensaje: `${orden.mensajeroNombre || 'El mensajero'} tiene dinero pendiente de cuadrar`,
            resuelta: false,
            leida: false,
            creadoEn: new Date().toISOString(),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      } catch (eAlerta) { console.warn('No se pudo crear alerta cuadre:', eAlerta.message); }
    }

    await auditar({
      accion: 'ESTADO_ORDEN_LOGISTICA',
      descripcion: `Orden ${orden.numeroOrden} → ${update.estado || nuevoEstado}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioEmail: req.user.email
    });

    res.json({ ok: true, estado: update.estado || nuevoEstado });
  } catch (e) {
    console.error('PUT logistica/orden/estado:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXTINTORES EN PRÉSTAMO
// GET /api/logistica/extintores-prestamo
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/extintores-prestamo', async (req, res) => {
  try {
    const { estado, buscar } = req.query;
    let query = db.collection('extintores_prestamo');
    if (estado && estado !== 'todos') query = query.where('estado', '==', estado);
    const snap = await query.get();
    let lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Ordenar del lado del servidor
    lista.sort((a, b) => (b.fechaSalida || '').localeCompare(a.fechaSalida || ''));

    if (buscar) {
      const q = buscar.toLowerCase();
      lista = lista.filter(e =>
        e.numeroExtintor?.toLowerCase().includes(q) ||
        e.clienteNombre?.toLowerCase().includes(q)
      );
    }

    res.json(lista);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEVOLVER EXTINTOR PRÉSTAMO
// PUT /api/logistica/extintores-prestamo/:id/devolver
// ═══════════════════════════════════════════════════════════════════════════════
router.put('/extintores-prestamo/:id/devolver', async (req, res) => {
  try {
    await db.collection('extintores_prestamo').doc(req.params.id).update({
      estado: 'devuelto',
      fechaDevolucion: new Date().toISOString(),
      recibidoPor: req.user.nombre || req.user.email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CUADRE DEL MENSAJERO
// GET /api/logistica/cuadre/:mensajeroId
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/cuadre/:mensajeroId', async (req, res) => {
  try {
    const { mensajeroId } = req.params;

    const snapOrdenes = await db.collection('orders')
      .where('mensajeroId', '==', mensajeroId)
      .where('estado', 'in', ['en_ruta_entrega', 'entrega_cobranza', 'cuadre_dinero', 'completada'])
      .get();

    let totalEfectivo = 0;   // lo carga el mensajero → a entregar
    let totalVirtual = 0;    // pagos virtuales → solo validar comprobante
    const ordenesCobro = [];
    const ordenesVirtual = [];

    snapOrdenes.forEach(doc => {
      const o = doc.data();
      if (o.cuadrado === true) return;
      const monto = Number(o.montoRecaudado) || 0;
      if (monto <= 0) return;  // sin cobro real (ej. CxC)

      const tipo = o.tipoCobro
        || (/transfer|nequi|banco|consign|qr/i.test(o.formaPagoRecaudo || '') ? 'virtual' : 'efectivo');

      if (tipo === 'virtual') {
        totalVirtual += monto;
        ordenesVirtual.push({
          id: doc.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
          monto, formaPago: o.formaPagoRecaudo,
          fotoTransferencia: o.fotoTransferencia || null,
          pendienteValidar: o.pagoVirtualPendienteValidar === true
        });
      } else {
        totalEfectivo += monto;
        ordenesCobro.push({
          id: doc.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
          monto, formaPago: o.formaPagoRecaudo || 'Efectivo'
        });
      }
    });

    const snapEgresos = await db.collection('egresos')
      .where('mensajeroId', '==', mensajeroId)
      .where('tipo', '==', 'provisional')
      .where('cuadrado', '==', false)
      .get();

    let totalProvisional = 0;
    const egresosProv = [];
    snapEgresos.forEach(doc => {
      const e = doc.data();
      totalProvisional += e.monto || 0;
      egresosProv.push({ id: doc.id, concepto: e.concepto, monto: e.monto });
    });

    const snapExtintores = await db.collection('extintores_prestamo')
      .where('mensajeroId', '==', mensajeroId)
      .where('estado', '==', 'prestado')
      .get();
    const extintoresPendientes = snapExtintores.docs.map(d => ({ id: d.id, ...d.data() }));

    // ── Extintores de CAMBIO entregados en esta ruta ─────────────────────────
    // Se sacan de los items de las órdenes (marcados esCambio + codigoQR).
    // El mensajero los confirma uno por uno en el cuadre con PIN.
    const cambiosEntregados = [];
    snapOrdenes.forEach(doc => {
      const o = doc.data();
      if (o.cuadrado === true) return;
      (o.items || []).forEach(it => {
        if (it.esCambio && it.codigoQR) {
          cambiosEntregados.push({
            ordenId: doc.id,
            numeroOrden: o.numeroOrden,
            clienteNombre: o.clienteNombre,
            codigoQR: it.codigoQR,
            producto: it.nombre || ''
          });
        }
      });
    });

    res.json({
      // El mensajero solo entrega EFECTIVO (más lo provisional que le dieron)
      totalCobrado: totalEfectivo,
      totalVirtual,
      totalProvisional,
      totalAEntregar: totalEfectivo + totalProvisional,
      ordenesCobro,
      ordenesVirtual,
      egresosProv,
      extintoresPendientes,   // préstamos pendientes de devolver/recoger
      cambiosEntregados       // extintores de cambio para confirmar 1x1
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRMAR CUADRE (Admin/Tesorería con PIN)
// POST /api/logistica/cuadre/:mensajeroId/confirmar
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/cuadre/:mensajeroId/confirmar', async (req, res) => {
  try {
    const { pin, montoRecibido, extintoresDevueltos } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN requerido' });

    // Verificar PIN — buscar empresas del admin
    const adminId = req.adminId || req.user.uid || req.user.id;
    const [snap1, snap2] = await Promise.all([
      db.collection('companies').where('adminId', '==', adminId).get(),
      db.collection('companies').where('user_id', '==', adminId).get()
    ]);
    const todasEmpresas = [...snap1.docs, ...snap2.docs];
    const autorizado = todasEmpresas.some(d => d.data().pinAutorizacion === pin);
    if (!autorizado) return res.status(403).json({ error: 'PIN incorrecto' });

    const { mensajeroId } = req.params;
    const batch = db.batch();

    // Marcar egresos provisionales como cuadrados
    const snapEgresos = await db.collection('egresos')
      .where('mensajeroId', '==', mensajeroId)
      .where('tipo', '==', 'provisional')
      .where('cuadrado', '==', false)
      .get();

    snapEgresos.forEach(doc => {
      batch.update(doc.ref, {
        cuadrado: true,
        fechaCuadre: new Date().toISOString(),
        cuadradoPor: req.user.email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // Marcar extintores devueltos
    if (extintoresDevueltos?.length > 0) {
      for (const extId of extintoresDevueltos) {
        const extRef = db.collection('extintores_prestamo').doc(extId);
        batch.update(extRef, {
          estado: 'devuelto',
          fechaDevolucion: new Date().toISOString(),
          recibidoPor: req.user.email
        });
      }
    }
    // ── Marcar órdenes cuadradas + registrar dinero SOLO una vez ─────────────
    const snapOrdenes = await db.collection('orders')
      .where('mensajeroId', '==', mensajeroId)
      .where('estado', 'in', ['en_ruta_entrega', 'entrega_cobranza', 'cuadre_dinero', 'completada'])
      .get();

    let sumaEfectivo = 0;   // → caja Efectivo
    let sumaVirtual  = 0;   // → caja Bancos
    const ordenesParaCaja = [];

    snapOrdenes.forEach(doc => {
      const o = doc.data();
      if (o.cuadrado === true) return;

      const monto = Number(o.montoRecaudado) || 0;
      const tipo = o.tipoCobro
        || (/transfer|nequi|banco|consign|qr/i.test(o.formaPagoRecaudo || '') ? 'virtual' : 'efectivo');
      const esCredito = tipo === 'credito' || /cr.dito|cxc|fiado/i.test(o.formaPagoRecaudo || '');

      // Al cuadrar, la orden se CIERRA SOLA según el resultado del cobro:
      //  - Pago (efectivo/virtual)  -> completada (el dinero ya está en caja)
      //  - Sin pago / a crédito      -> cxc (queda en cartera)
      // Así el mensajero no tiene que avanzar nada a mano.
      const estadoFinal = (esCredito || monto <= 0) ? 'cxc' : 'completada';

      // CANDADO ANTI-DOBLE-SUMA: solo suma a caja si NO entró ya
      const yaEnCaja = o.dineroEnCaja === true;
      const sumaCaja = !esCredito && monto > 0 && !yaEnCaja;

      batch.update(doc.ref, {
        cuadrado: true,
        fechaCuadre: new Date().toISOString(),
        cuadradoPor: req.user.email,
        estado: estadoFinal,
        ...(sumaCaja ? {
          dineroEnCaja: true,
          dineroEnCajaFecha: new Date().toISOString(),
          dineroEnCajaPor: req.user.email
        } : {}),
        ...(tipo === 'virtual' ? { pagoVirtualPendienteValidar: false } : {}),
        historialEstados: admin.firestore.FieldValue.arrayUnion({
          estado: estadoFinal,
          fecha: new Date().toISOString(),
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.email,
          nota: esCredito ? 'Cuadre: queda en cartera (CxC)' : 'Cuadre: dinero confirmado en caja'
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (sumaCaja) {
        if (tipo === 'virtual') sumaVirtual += monto;
        else sumaEfectivo += monto;
        ordenesParaCaja.push({ numeroOrden: o.numeroOrden, monto, tipo });
      }
    });

    await batch.commit();

    // Cerrar la alerta de "cuadre pendiente" de este mensajero (ya cuadró).
    try {
      const alertas = await db.collection('notificaciones')
        .where('tipo', '==', 'CUADRE_PENDIENTE')
        .where('mensajeroId', '==', mensajeroId)
        .where('resuelta', '==', false)
        .get();
      const b2 = db.batch();
      alertas.forEach(d => b2.update(d.ref, {
        resuelta: true, leida: true,
        resueltaEn: new Date().toISOString()
      }));
      if (!alertas.empty) await b2.commit();
    } catch (eCerrar) { console.warn('No se pudo cerrar alerta cuadre:', eCerrar.message); }

    // ── Registrar ingreso: efectivo→Efectivo, virtual→Bancos ─────────────────
    const refOrdenes = ordenesParaCaja.map(o => o.numeroOrden).join(', ') || 'Cuadre';
    const registrarEnCaja = async (monto, tipoCaja, concepto) => {
      if (monto <= 0) return;
      const snapCajas = await db.collection('cajas')
        .where('userId', '==', req.user.uid)
        .where('tipo', '==', tipoCaja)
        .limit(1).get();
      if (snapCajas.empty) {
        console.warn(`Cuadre: no se encontró caja tipo ${tipoCaja}`);
        return;
      }
      await snapCajas.docs[0].ref.update({
        saldo: admin.firestore.FieldValue.increment(monto),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('movimientos').add({
        userId: req.user.uid,
        cajaId: snapCajas.docs[0].id,
        tipo: 'ingreso',
        concepto,
        monto,
        referencia: refOrdenes,
        creadoPor: req.user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    };

    await registrarEnCaja(sumaEfectivo, 'Efectivo', 'Cuadre mensajero (efectivo)');
    await registrarEnCaja(sumaVirtual, 'Bancos', 'Cuadre mensajero (pagos virtuales validados)');

    await auditar({
      accion: 'CUADRE_CONFIRMADO',
      descripcion: `Cuadre mensajero ${mensajeroId}: efectivo $${sumaEfectivo.toLocaleString()}, virtual $${sumaVirtual.toLocaleString()} (${ordenesParaCaja.length} órdenes)`,
      usuarioId: req.user.uid || req.user.id,
      usuarioEmail: req.user.email
    });

    res.json({
      ok: true,
      efectivoIngresado: sumaEfectivo,
      virtualIngresado: sumaVirtual,
      ordenesCuadradas: ordenesParaCaja.length
    });
  } catch (e) {
    console.error('POST cuadre/confirmar:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESUMEN POR MENSAJERO (Admin)
// GET /api/logistica/resumen-mensajeros
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/resumen-mensajeros', async (req, res) => {
  try {
    const snap = await db.collection('orders')
      .where('estado', 'in', ['en_ruta_recogida', 'en_ruta_entrega', 'entrega_cobranza', 'en_taller'])
      .get();

    const porMensajero = {};
    snap.forEach(doc => {
      const o = doc.data();
      if (!o.mensajeroId) return;
      if (!porMensajero[o.mensajeroId]) {
        porMensajero[o.mensajeroId] = {
          mensajeroId: o.mensajeroId,
          mensajeroNombre: o.mensajeroNombre || '',
          totalOrdenes: 0,
          completadas: 0,
          enRuta: 0,
          totalRecaudado: 0
        };
      }
      const m = porMensajero[o.mensajeroId];
      m.totalOrdenes++;
      if (o.estado === 'entrega_cobranza') m.completadas++;
      if (['en_ruta_recogida', 'en_ruta_entrega'].includes(o.estado)) m.enRuta++;
      m.totalRecaudado += o.montoRecaudado || 0;
    });

    res.json(Object.values(porMensajero));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;