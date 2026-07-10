const express = require('express');
const router  = express.Router();
const { db, admin } = require('../config/firebase');

// Reutilizar LA MISMA máquina de estados de orders.js (una sola fuente de
// verdad del flujo — el mensajero ya no recalcula el flujo por su cuenta).
const ordersRouter = require('./orders');
const construirFlujo = ordersRouter.construirFlujo;
const registrarIngresoEnCaja = ordersRouter.registrarIngresoEnCaja;
// Verificador de PIN por usuario (Ola 1 — sustituye al PIN de empresa).
const verificarPinUsuario = ordersRouter.verificarPinUsuario;
const { authenticate, validarTenant } = require('../middleware/auth');
// ✅ FIX FECHA-CO-001: "hoy" siempre en fecha Colombia (America/Bogota).
// new Date().toISOString() es UTC: después de las 7 pm en Colombia ya es
// "mañana" y las órdenes/asignaciones quedaban con fecha corrida un día.
const { hoyEnCO } = require('./_helpers');

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// ✅ FIX LOGISTICA-004 (2026-06-30): valida que un mensajeroId pertenezca al
// tenant del admin autenticado antes de leer o escribir su cuadre. Sin esto,
// cualquier usuario autenticado podía pasar el mensajeroId de OTRO suscriptor
// por la URL y ver — o incluso cuadrar/corromper — su información financiera.
const validarMensajeroDelTenant = async (adminId, mensajeroId) => {
  try {
    const snap = await db.collection('users').doc(mensajeroId).get();
    if (!snap.exists) return false;
    const u = snap.data();
    // Compatibilidad: usuarios antiguos guardados con adminId en vez de creadoPor.
    return u.creadoPor === adminId || u.adminId === adminId;
  } catch (e) {
    return false;
  }
};

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
    // ✅ FIX LOGISTICA-003: filtrar por adminId — sin esto se veían órdenes de otros suscriptores
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    
    // Filtrar por adminId primero, luego por estado en memoria (evita índice compuesto)
    const snap = await db.collection('orders')
      .where('adminId', '==', adminId)
      .get();

    const estadosLogistica = ['programada', 'despacho', 'en_ruta_recogida', 'en_ruta_entrega', 'entrega_cobranza'];
    const hoy = hoyEnCO(); // ✅ FIX FECHA-CO-001
    const ordenes = [];

    snap.forEach(doc => {
      const o = { id: doc.id, ...doc.data() };
      if (!estadosLogistica.includes(o.estado)) return; // filtrar estados en memoria
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
    const { mensajeroId, mensajeroNombre, mensajeroCelular, ordenIds, forzarReasignar } = req.body;
    if (!mensajeroId || !ordenIds?.length) {
      return res.status(400).json({ error: 'mensajeroId y ordenIds requeridos' });
    }

    const adminId = req.adminId || req.user?.uid || req.user?.id;
    const esAdmin = req.user?.role === 'admin';

    // ── Mini-Ola 2.6: bloqueo doble asignación ─────────────────────────────
    // Validamos primero TODAS las órdenes antes de hacer cualquier cambio.
    // Si alguna ya está asignada a otro mensajero, rechazamos a menos que
    // sea admin con flag forzarReasignar=true.
    const conflictos = [];
    for (const oid of ordenIds) {
      const snap = await db.collection('orders').doc(oid).get();
      if (!snap.exists) {
        return res.status(404).json({ error: `Orden ${oid} no encontrada` });
      }
      const od = snap.data();
      const yaAsignada = od.mensajeroId && od.mensajeroId !== '' && od.mensajeroId !== mensajeroId;
      if (yaAsignada) {
        conflictos.push({
          ordenId: oid,
          numeroOrden: od.numeroOrden,
          mensajeroActual: od.mensajeroNombre || 'Otro mensajero'
        });
      }
    }

    if (conflictos.length > 0 && !(esAdmin && forzarReasignar)) {
      return res.status(409).json({
        error: esAdmin
          ? 'Hay órdenes ya asignadas. Confirma reasignación.'
          : `Hay ${conflictos.length} orden(es) ya asignada(s) a otro mensajero. Solo el admin puede reasignar.`,
        conflictos,
        requiereConfirmacion: esAdmin
      });
    }

    const batch = db.batch();
    const hoy = hoyEnCO(); // ✅ FIX FECHA-CO-001

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
      // ✅ FIX ASIGNAR-ESTADO-001: asignar mensajero NO retrocede la orden.
      // ANTES: este endpoint escribía `estado` a ciegas según los items. Una
      // orden EN TALLER que se (re)asignaba volvía a 'en_ruta_recogida' —
      // retroceso ilegal que rompía el flujo (bug real OS-0119). El parche
      // anterior (yaSalioDeTaller) solo protegía 2 estados y dejó el resto
      // expuesto.
      // AHORA: la máquina de estados manda. La asignación solo mueve el
      // estado si la orden está en 'programada' (su único paso legal de
      // salida es la asignación). En CUALQUIER otro estado, asignar/reasignar
      // solo actualiza el mensajero y deja constancia en el historial — el
      // estado queda intacto. Pre-asignar el mensajero de entrega mientras
      // la orden sigue en taller es válido y ya no daña nada.
      const tieneRecogerReal = (ordData.items || []).some(
        it => esRecargaMant(it) && !it.esCambio
      );
      // ✅ FIX ASIGNAR-FLUJO-001: la máquina de estados manda TAMBIÉN aquí.
      // ANTES: se escribía en_ruta_recogida/en_ruta_entrega a ciegas según los
      // items. Una orden INTERNA (flujo: programada → interna_proceso) o de
      // COBRANZA (programada → en_ruta_recogida) caía en un estado que NO
      // existe en su flujo y quedaba atascada para siempre sin siguiente paso
      // (caso real OI-0005). AHORA: solo se avanza si el paso de salida de
      // 'programada' en el flujo de ESTA orden es la asignación ('asignar'),
      // y al estado que el flujo diga. En cualquier otro caso la asignación
      // solo registra el mensajero y el estado queda intacto.
      let cambiaEstado = false;
      let estadoAsignado = ordData.estado;
      if (ordData.estado === 'programada' && typeof construirFlujo === 'function') {
        const flujoAsig = construirFlujo(ordData.lugarAtencion, ordData.requiereFactura, tieneRecogerReal);
        const pasoProg = flujoAsig['programada'];
        if (pasoProg && pasoProg.accion === 'asignar' && pasoProg.siguiente) {
          cambiaEstado = true;
          estadoAsignado = pasoProg.siguiente;
        }
      }

      batch.update(ref, {
        mensajeroId,
        mensajeroNombre: mensajeroNombre || '',
        ...(cambiaEstado ? { estado: estadoAsignado } : {}),
        fechaAsignacion: hoy,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        historialEstados: admin.firestore.FieldValue.arrayUnion({
          estado: estadoAsignado,
          fecha: new Date().toISOString(),
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.email,
          nota: cambiaEstado
            ? (estadoAsignado === 'en_ruta_recogida'
                ? `Asignada a ${mensajeroNombre} — recoge equipo para taller`
                : `Asignada a ${mensajeroNombre} — lleva equipo (cambio/venta), va a entrega`)
            : `Mensajero asignado: ${mensajeroNombre} — la orden conserva su estado actual (ASIGNAR-FLUJO-001)`
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

    // ── Maps SaaS-ready (Ola 2.5 Bloque 1): adjuntar ciudad de la empresa ──
    // Google Maps recibe el texto plano de la dirección. Si solo va "Calle 5
    // #45-67" Maps lo resuelve por la ubicación actual del usuario, lo cual
    // hace que para un suscriptor de Medellín se abra en Cali (porque su
    // celular está en otra zona). Solución: añadir la ciudad/región de la
    // empresa al final de cada dirección.
    let ciudadEmpresa = '';
    try {
      const snapEmpresa = await db.collection('companies')
        .where('adminId', '==', adminId)
        .limit(1)
        .get();
      if (!snapEmpresa.empty) {
        const empresa = snapEmpresa.docs[0].data();
        // Toma ciudad explícita o, si no existe, la última parte del address
        ciudadEmpresa = empresa.ciudad || empresa.city || '';
        if (!ciudadEmpresa && empresa.address) {
          // Si address tiene formato "Cra X #Y, Cali" toma "Cali"
          const partes = String(empresa.address).split(',').map(s => s.trim()).filter(Boolean);
          ciudadEmpresa = partes[partes.length - 1] || '';
        }
      }
    } catch {}
    const sufijoCiudad = ciudadEmpresa ? `, ${ciudadEmpresa}, Colombia` : '';

    // Construir link Google Maps con todas las paradas en orden
    const direcciones = snapOrdenes
      .map(d => {
        const dir = d.data()?.sucursalDireccion || d.data()?.clienteDireccion || d.data()?.clienteDireccionPrincipal || '';
        if (!dir) return '';
        // Si la dirección ya menciona la ciudad, no duplicar
        const yaTieneCiudad = ciudadEmpresa && dir.toLowerCase().includes(ciudadEmpresa.toLowerCase());
        return yaTieneCiudad ? dir : (dir + sufijoCiudad);
      })
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
    const { nota, extintorPrestamo, fotoUrl, cobro, formaPago, fotoTransferenciaUrl, items, gps, prestamoDevueltoId, prestamosDevueltosIds, deficiencia } = req.body;
    let nuevoEstado = req.body.nuevoEstado;
    if (!nuevoEstado) return res.status(400).json({ error: 'nuevoEstado requerido' });

    const ordenRef = db.collection('orders').doc(req.params.id);
    const ordenDoc = await ordenRef.get();
    if (!ordenDoc.exists) return res.status(404).json({ error: 'Orden no encontrada' });

    const orden = ordenDoc.data();
    const timestampFoto = new Date().toISOString();

    // ══════════════════════════════════════════════════════════════════════════
    // VALIDACIÓN DE TRANSICIÓN LEGAL — la máquina de estados manda (Ola 3)
    // ──────────────────────────────────────────────────────────────────────────
    // Igual que en orders.js: una pantalla sin refrescar NO puede retroceder
    // una orden. Si llega 'auto', el backend calcula el siguiente paso él solo.
    // ══════════════════════════════════════════════════════════════════════════
    if (typeof construirFlujo === 'function') {
      const tieneTallerVal = typeof orden.tieneEquipoTaller === 'boolean'
        ? orden.tieneEquipoTaller
        : (orden.items || []).some(it => {
            const c = (it.categoria || '').toLowerCase();
            return ['recarga', 'mantenimiento', 'hidrostatica', 'hidrostática'].some(k => c.includes(k));
          });
      const estadoBaseVal = orden.estado === 'reparacion_proceso' ? 'en_taller' : orden.estado;
      const flujoVal = construirFlujo(orden.lugarAtencion, orden.requiereFactura, tieneTallerVal);

      // Cadena hacia adelante desde el estado actual
      const alcanzables = new Set();
      let cursorVal = estadoBaseVal;
      let guardiaVal = 0;
      while (guardiaVal++ < 12) {
        const pasoVal = flujoVal[cursorVal];
        if (!pasoVal || !pasoVal.siguiente || alcanzables.has(pasoVal.siguiente)) break;
        alcanzables.add(pasoVal.siguiente);
        cursorVal = pasoVal.siguiente;
      }
      if (orden.estado === 'reparacion_proceso') alcanzables.add('en_taller');
      if (orden.estado === 'entrega_cobranza') alcanzables.add('cxc');
      if (orden.estado === 'cuadre_dinero') { alcanzables.add('completada'); alcanzables.add('cxc'); }

      // Modo AVANZAR automático: el frontend ya no calcula el flujo.
      if (nuevoEstado === 'auto') {
        const pasoAuto = flujoVal[estadoBaseVal];
        if (!pasoAuto || !pasoAuto.siguiente) {
          return res.status(400).json({
            error: `La orden está en "${orden.estado}" y no tiene siguiente paso en su flujo.`,
            estadoActual: orden.estado
          });
        }
        nuevoEstado = pasoAuto.siguiente;
      }

      const transicionLegal = nuevoEstado === orden.estado || alcanzables.has(nuevoEstado);
      if (!transicionLegal) {
        return res.status(409).json({
          error: `La orden ${orden.numeroOrden} está en "${orden.estado}" y no puede pasar a "${nuevoEstado}". Refresca la pantalla: es posible que otro usuario ya la haya avanzado.`,
          estadoActual: orden.estado,
          transicionInvalida: true
        });
      }
    }

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
      // ✅ ITEMS-RECOGIDA-001: la edición de productos solo es legal en la
      // RECOGIDA (ahí el mensajero descubre las cantidades reales en el
      // cliente). En la ENTREGA las cantidades ya están definidas por el
      // taller/factura y NO se tocan — salvo VENTA DIRECTA (sin equipo de
      // taller: despacho/cambio/venta a domicilio), donde la entrega es el
      // primer contacto con el cliente y puede retractarse o aumentar.
      // Se valida en backend porque esconderlo solo en pantalla deja el
      // hueco abierto por API.
      const esVentaDirectaItems = typeof orden.tieneEquipoTaller === 'boolean'
        ? !orden.tieneEquipoTaller
        : !(orden.items || []).some(it => {
            const c = (it.categoria || '').toLowerCase();
            const esTallerCat = ['recarga', 'mantenimiento', 'hidrostatica', 'hidrostática'].some(k => c.includes(k));
            return esTallerCat && !it.esCambio;
          });
      const puedeEditarItemsBackend =
        orden.estado === 'en_ruta_recogida' ||
        (orden.estado === 'en_ruta_entrega' && esVentaDirectaItems);
      if (!puedeEditarItemsBackend) {
        return res.status(400).json({
          error: 'Los productos de esta orden solo se pueden editar durante la recogida. En la entrega las cantidades son fijas.'
        });
      }
      // ✅ PRECIO-CERO-001: ningún item puede quedar en $0 — un cero nunca es
      // un accidente. Las cortesías se manejan con descuento (decisión visible).
      const itemCero = items.find(it => !(Number(it.precioUnitario) > 0));
      if (itemCero) {
        return res.status(400).json({ error: `El producto "${itemCero.nombre || 'sin nombre'}" no puede quedar con precio $0. Usa el campo descuento para cortesías.` });
      }
      update.items = items;
      // ✅ IVA-AJUSTE-001: antes esto escribía total = suma de items SIN IVA y
      // dejaba el ivaValor viejo huérfano — toda orden con IVA donde el
      // mensajero ajustara cantidades quedaba mal cobrada. Ahora se recalculan
      // los TRES campos coherentes con la misma fórmula del resto del sistema.
      const nuevoSubtotal = items.reduce((s, it) => s + (it.precioUnitario || 0) * (it.cantidad || 1) * (1 - (it.descuento || 0) / 100), 0);
      const ivaPctOrden = Number(orden.ivaPct) || 0;
      const nuevoIva = Math.round(nuevoSubtotal * ivaPctOrden / 100);
      update.subtotal = Math.round(nuevoSubtotal);
      update.ivaValor = nuevoIva;
      update.total = Math.round(nuevoSubtotal) + nuevoIva;

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
        adminId: req.adminId || req.user?.uid || req.user?.id, // FIX: multi-tenant isolation
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
    const esCredito = /crédito|credito|cxc|fiado|no pag/.test(fp);
    const montoCobro = Number(cobro) || 0;
    // ── FIX PAGO FANTASMA (Ola 3): si NO hay forma de pago Y NO hay monto,
    // el cliente NO pagó. Antes el sistema rellenaba el vacío con
    // "pagó efectivo el total de la orden" — inventaba dinero en el cuadre
    // del mensajero. Ahora: sin pago explícito = queda en cartera (CxC).
    const sinPago = !esCredito && !formaPago && montoCobro <= 0;

    if (nuevoEstado === 'entrega_cobranza') {
      // Ola 2.5: si la orden YA está pagada (admin la marcó pagada antes, o ya
      // pasó por validación), NO bloqueamos el avance: simplemente saltamos la
      // sección de "registrar cobro" porque ya no hay nada que cobrar.
      // El mensajero solo entrega y se cierra como completada.
      const ordenYaPagada = (orden.pagado === true || orden.dineroEnCaja === true)
        && !esCredito;
      const intentaCobrarDeNuevo = montoCobro > 0 || (formaPago && !esCredito);

      if (ordenYaPagada && intentaCobrarDeNuevo) {
        // Caso real recobro: rechazar
        return res.status(409).json({ error: 'Esta orden ya está pagada.', yaPagada: true });
      }

      if (ordenYaPagada) {
        // Caso entrega de orden ya pagada: solo cerrar.
        update.estado = 'completada';
        update.historialEstados = admin.firestore.FieldValue.arrayUnion(
          { estado: 'entrega_cobranza', fecha: timestampFoto,
            usuarioId: req.user.uid || req.user.id,
            usuarioNombre: req.user.nombre || req.user.email,
            nota: nota || '', gps: gps || null },
          { estado: 'completada', fecha: timestampFoto,
            usuarioId: req.user.uid || req.user.id,
            usuarioNombre: req.user.nombre || req.user.email,
            nota: 'Orden entregada — ya estaba pagada' }
        );
        // Ola 3 Bloque 2: registrar fechaCompletada para dashboards y reportes
        if (update.estado === 'completada' && !orden.fechaCompletada) {
          update.fechaCompletada = new Date().toISOString();
        }
        await ordenRef.update(update);

        // Préstamo devuelto si aplica
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

        await auditar({
          accion: 'ENTREGAR_ORDEN_PAGADA',
          descripcion: `${req.user.email} entregó ${orden.numeroOrden} (ya estaba pagada)`,
          usuarioId: req.user.uid || req.user.id,
          usuarioEmail: req.user.email,
          documento: orden.numeroOrden,
        });

        return res.json({ ok: true, estado: 'completada', yaPagada: true });
      }

      // ¿Hay un mensajero de por medio? Si NO hay mensajero asignado, la
      // persona que avanza la orden (admin/comercial) es quien recibe el
      // dinero AHORA. No habrá cuadre con PIN — por eso el dinero debe entrar
      // a caja en este momento, o se perdería.
      const hayMensajero = !!orden.mensajeroId;

      if (esCredito || sinPago) {
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
        // El mensajero eligió una forma de pago en efectivo de forma EXPLÍCITA.
        // Si no digitó monto, se asume el total de la orden (eligió cobrar).
        update.formaPagoRecaudo = formaPago || 'Efectivo';
        update.montoRecaudado = montoCobro || orden.total || 0;
        update.tipoCobro = 'efectivo';
      }

      if (!esCredito && !sinPago) {
        update.pagado = true;
        update.montoPagado = update.montoRecaudado;
        update.fechaPago = timestampFoto;
        // Solo se "cobra por mensajero" (espera cuadre) si HAY mensajero.
        update.cobradoPorMensajero = hayMensajero;
      }
      if (formaPago) update.formaPago = formaPago;

      // ── SIN MENSAJERO: registrar el pago según la regla Ola 2.5 ────────────
      // REGLA RAÍZ: pago y estado son DOS dimensiones separadas.
      //   - Pago entra a caja (efectivo) o queda pendiente validar (virtual).
      //   - El estado SOLO se completa si la orden YA estaba en entrega_cobranza.
      //   - Si está en recogida/taller/entrega, el flujo sigue su curso normal.
      const esPagoVirtual = formaPago && formaPago !== 'Efectivo' &&
        formaPago !== 'A crédito (CxC)' && formaPago !== 'A crédito' &&
        formaPago !== 'CXC' && formaPago !== 'Cuenta por Pagar';

      if (!hayMensajero) {
        const yaEnCobranza = orden.estado === 'entrega_cobranza';

        if (esCredito || sinPago) {
          // No pagó → queda en cartera (CxC). Solo cambia estado si ya estaba en cobranza.
          if (yaEnCobranza) {
            update.estado = 'cxc';
            update.historialEstados = admin.firestore.FieldValue.arrayUnion(
              { estado: 'cxc', fecha: timestampFoto,
                usuarioId: req.user.uid || req.user.id,
                usuarioNombre: req.user.nombre || req.user.email,
                nota: 'Sin pago: queda en cartera (CxC)' }
            );
          }
        } else if (esPagoVirtual) {
          // Pago virtual: marca pagado pero el dinero NO entra a caja hasta validar.
          update.pagoVirtualPendienteValidar = true;
          update.pagoValidado = false;
          if (yaEnCobranza) {
            update.estado = 'completada';
            update.historialEstados = admin.firestore.FieldValue.arrayUnion(
              { estado: 'completada', fecha: timestampFoto,
                usuarioId: req.user.uid || req.user.id,
                usuarioNombre: req.user.nombre || req.user.email,
                nota: `Pago ${formaPago} en cobranza — pendiente de validar` }
            );
          } else {
            // Solo registra el pago, sin cambiar estado.
            update.historialEstados = admin.firestore.FieldValue.arrayUnion(
              { estado: orden.estado, fecha: timestampFoto,
                usuarioId: req.user.uid || req.user.id,
                usuarioNombre: req.user.nombre || req.user.email,
                accion: 'PAGO_REGISTRADO',
                nota: `Pago ${formaPago} registrado — pendiente de validar. El servicio sigue su flujo.` }
            );
          }
        } else {
          // Pago en EFECTIVO: dinero entra a caja YA. Estado solo cierra si estaba en cobranza.
          update.dineroEnCaja = true;
          update.dineroEnCajaFecha = timestampFoto;
          update.dineroEnCajaPor = req.user.email;
          if (yaEnCobranza) {
            update.estado = 'completada';
            update.historialEstados = admin.firestore.FieldValue.arrayUnion(
              { estado: 'completada', fecha: timestampFoto,
                usuarioId: req.user.uid || req.user.id,
                usuarioNombre: req.user.nombre || req.user.email,
                nota: 'Cobro en cobranza: dinero en caja' }
            );
          } else {
            update.historialEstados = admin.firestore.FieldValue.arrayUnion(
              { estado: orden.estado, fecha: timestampFoto,
                usuarioId: req.user.uid || req.user.id,
                usuarioNombre: req.user.nombre || req.user.email,
                accion: 'PAGO_REGISTRADO',
                nota: 'Cobro en efectivo registrado. El servicio sigue su flujo.' }
            );
          }
        }

        // Ola 3 Bloque 2: fechaCompletada para dashboards y reportes
        if (update.estado === 'completada' && !orden.fechaCompletada) {
          update.fechaCompletada = new Date().toISOString();
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
        // FIX Ola 2.5: solo efectivo entra a caja directo. Virtual espera
        // validación de Admin/Tesorería.
        let resultadoCaja = null;
        if (!esCredito && !sinPago && !esPagoVirtual && typeof registrarIngresoEnCaja === 'function') {
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
          dineroEnCaja: !esCredito && !sinPago,
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

    // ✅ FIX LOGISTICA-005: 'cuadre_dinero' SIN mensajero no tiene a quién
    // cuadrar con PIN — la orden se cierra sola (mismo criterio que orders.js):
    //   - pagada (o dinero ya en caja) → completada; si fue efectivo y aún no
    //     está en caja, el ingreso se registra abajo con el candado único.
    //   - sin pago → cxc (queda en cartera, jamás "completada sin cobrar").
    let cierreSinMensajero = false;
    if ((update.estado || nuevoEstado) === 'cuadre_dinero'
        && !orden.mensajeroId && !orden.trabajadorAsignadoId) {
      cierreSinMensajero = true;
      const quedoPagada = orden.pagado === true || orden.dineroEnCaja === true
        || (update.pagado === true);
      update.estado = quedoPagada ? 'completada' : 'cxc';
    }

    // ── Ola 3 Bloque 2: si la orden quedó completada, registrar fechaCompletada ──
    if (update.estado === 'completada' && !orden.fechaCompletada) {
      update.fechaCompletada = new Date().toISOString();
    }

    await ordenRef.update(update);

    // ✅ FIX LOGISTICA-005: huella del cierre sin mensajero + dinero a caja
    if (cierreSinMensajero) {
      try {
        await ordenRef.update({
          historialEstados: admin.firestore.FieldValue.arrayUnion({
            estado: update.estado, fecha: new Date().toISOString(),
            usuarioId: req.user.uid || req.user.id,
            usuarioNombre: req.user.nombre || req.user.email,
            nota: update.estado === 'completada'
              ? 'Cierre automático (sin mensajero — no requiere cuadre)'
              : 'Sin pago y sin mensajero — queda en cartera (CxC)'
          })
        });
        const fpCierre = update.formaPagoRecaudo || orden.formaPagoRecaudo || update.formaPago || orden.formaPago || '';
        const montoCierre = Number(update.montoRecaudado ?? orden.montoRecaudado) || Number(orden.montoPagado) || Number(orden.total) || 0;
        if (update.estado === 'completada' && orden.dineroEnCaja !== true
            && /efectivo/i.test(fpCierre) && montoCierre > 0
            && typeof registrarIngresoEnCaja === 'function') {
          await registrarIngresoEnCaja({
            userId: req.adminId || req.user.uid || req.user.id,
            ordenId: req.params.id,
            numeroOrden: orden.numeroOrden,
            clienteNombre: orden.clienteNombre,
            monto: montoCierre,
            formaPago: fpCierre || 'Efectivo',
            usuarioEmail: req.user.email,
            numeroFactura: orden.numeroFactura || ''
          });
        }
      } catch (eCierre) {
        console.error('LOGISTICA-005: error en cierre sin mensajero:', eCierre.message);
      }
    }

    // ── Ola 2.5: marcar préstamos devueltos en bulk ───────────────────────────
    // El mensajero marcó qué préstamos recogió en la entrega. Cambiamos cada
    // uno a estado "devuelto". Los que NO marcó quedan pendientes.
    if (Array.isArray(prestamosDevueltosIds) && prestamosDevueltosIds.length > 0) {
      for (const prestId of prestamosDevueltosIds) {
        try {
          await db.collection('extintores_prestamo').doc(prestId).update({
            estado: 'devuelto',
            fechaDevolucion: new Date().toISOString(),
            recibidoPor: req.user.email,
            ordenDevolucionId: req.params.id,
            ordenDevolucionNumero: orden.numeroOrden
          });
        } catch (eP) {
          console.warn(`No se pudo marcar préstamo ${prestId}:`, eP.message);
        }
      }
    }

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
    const adminId = req.adminId || req.user?.uid || req.user?.id; // FIX: multi-tenant isolation
    const { estado, buscar, clienteId } = req.query;

    // Traer solo los préstamos del tenant activo
    const snap = await db.collection('extintores_prestamo')
      .where('adminId', '==', adminId)
      .get();

    let lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // ✅ PRESTAMO-ENTREGA-001: filtrar por cliente — al ir a ENTREGAR, el
    // mensajero necesita ver qué extintores de préstamo tiene ESE cliente para
    // saber cuántos y cuáles recoger. Antes decía solo "recoger extintores de
    // préstamo" sin cantidad, y si iba otro mensajero o no se acordaba, recogía
    // incompleto. Por defecto solo los que siguen en préstamo (no devueltos).
    if (clienteId) {
      lista = lista.filter(e => e.clienteId === clienteId && e.estado !== 'devuelto');
    }

    // Filtros en memoria (evita índice compuesto)
    if (estado && estado !== 'todos') {
      lista = lista.filter(e => e.estado === estado);
    }

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
    const adminId = req.adminId || req.user?.uid || req.user?.id;

    // ✅ FIX LOGISTICA-004: el mensajeroId debe pertenecer al tenant autenticado
    const perteneceAlTenant = await validarMensajeroDelTenant(adminId, mensajeroId);
    if (!perteneceAlTenant) {
      return res.status(403).json({ error: 'No autorizado para consultar este mensajero' });
    }

    const snapOrdenes = await db.collection('orders')
      .where('mensajeroId', '==', mensajeroId)
      .where('estado', 'in', ['en_ruta_entrega', 'entrega_cobranza', 'cuadre_dinero', 'completada'])
      .get();

    let totalEfectivo = 0;   // lo carga el mensajero → a entregar
    let totalVirtual = 0;    // pagos virtuales → solo validar comprobante
    const ordenesCobro = [];
    const ordenesVirtual = [];
    const ordenesSinPago = []; // entregadas sin pago → quedan en cartera (CxC) al cuadrar
    // ✅ LOGISTICA-CUADRE-002: detalle completo de la ruta — para que el admin
    // vea QUÉ está haciendo cada mensajero (no ir a ciegas). Cada orden con su
    // estado, monto y si ya cobró.
    const rutaDetalle = [];

    const etiquetaEstado = {
      en_ruta_recogida: 'En ruta recogida', en_ruta_entrega: 'En ruta entrega',
      entrega_cobranza: 'Entrega/cobranza', cuadre_dinero: 'Por cuadrar',
      completada: 'Completada', en_taller: 'En taller'
    };

    snapOrdenes.forEach(doc => {
      const o = doc.data();
      if (o.cuadrado === true) return;
      const monto = Number(o.montoRecaudado) || 0;
      // Registrar en el detalle de ruta (todas, cobradas o no)
      rutaDetalle.push({
        numeroOrden: o.numeroOrden,
        clienteNombre: o.clienteNombre,
        estado: o.estado,
        estadoLabel: etiquetaEstado[o.estado] || o.estado,
        total: Number(o.total) || 0,
        montoRecaudado: monto,
        formaPago: o.formaPagoRecaudo || '',
        cobrado: monto > 0
      });
      if (monto <= 0) {
        // Sin cobro real: NO suma al cuadre, pero el Admin debe verla — al
        // confirmar el cuadre pasará a CxC (Ola 3: visibilidad de cartera).
        if (['entrega_cobranza', 'cuadre_dinero'].includes(o.estado)) {
          ordenesSinPago.push({
            id: doc.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
            monto: Number(o.total) || 0
          });
        }
        return;
      }

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
      ordenesSinPago,         // entregadas sin pago → pasarán a CxC al confirmar
      egresosProv,
      extintoresPendientes,   // préstamos pendientes de devolver/recoger
      cambiosEntregados,      // extintores de cambio para confirmar 1x1
      rutaDetalle             // ✅ LOGISTICA-CUADRE-002: todas las órdenes de la ruta con su estado
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRMAR CUADRE (Admin/Tesorería con PIN)
// POST /api/logistica/cuadre/:mensajeroId/confirmar
// ─────────────────────────────────────────────────────────────────────────────
// Ola 1: el PIN se valida contra el usuario LOGUEADO (Admin o Tesorería)
//        — antes se validaba contra el pinAutorizacion de la empresa.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/cuadre/:mensajeroId/confirmar', async (req, res) => {
  try {
    // ✅ CUADRE-CAJA-001: quien RECIBE el dinero elige la caja de efectivo
    // destino (segregación de funciones: el mensajero declara, el receptor
    // clasifica). Antes el backend tomaba a ciegas la primera caja tipo
    // 'Efectivo' — origen de cajas erradas y traslados para cuadrar.
    const { pin, montoRecibido, extintoresDevueltos, cajaEfectivoId } = req.body;
    const { mensajeroId } = req.params;
    const adminId = req.adminId || req.user?.uid || req.user?.id;

    // ✅ FIX LOGISTICA-004: validar tenant ANTES de tocar cualquier dato.
    // Este es el punto más crítico — sin esto, un usuario podía confirmar
    // el cuadre de un mensajero de OTRO suscriptor: se marcaban como
    // cuadradas sus órdenes/egresos/extintores, pero el dinero entraba
    // en la caja de quien confirma. Es decir, corrompía el cuadre ajeno.
    const perteneceAlTenant = await validarMensajeroDelTenant(adminId, mensajeroId);
    if (!perteneceAlTenant) {
      return res.status(403).json({ error: 'No autorizado para cuadrar este mensajero' });
    }

    const verificacion = await verificarPinUsuario(req.user.uid || req.user.id, pin);
    if (!verificacion.ok) {
      // Auditar intento fallido (sin tumbar el flujo).
      try {
        await db.collection('audit_logs').add({
          accion: 'CUADRE_PIN_FALLIDO',
          modulo: 'logistica',
          descripcion: `${req.user.email} falló PIN al cuadrar mensajero ${mensajeroId}`,
          usuarioId: req.user.uid || req.user.id,
          usuarioEmail: req.user.email,
          fecha: new Date().toISOString()
        });
      } catch {}
      return res.status(403).json({ error: verificacion.error });
    }

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
    // ✅ FIX CUADRE-BARRIDO-001: el cuadre YA NO incluye 'en_ruta_entrega'.
    // ANTES: la consulta barría también las órdenes aún EN RUTA (sin entregar)
    // y les forzaba un cierre: sin monto → CxC. Cuando al mensajero no le
    // alcanzaba el día, sus órdenes pendientes saltaban a cartera sin entrega,
    // sin foto y sin cobranza real (causa raíz de las órdenes atascadas).
    // AHORA: el cuadre solo procesa órdenes que el mensajero YA declaró con el
    // modal de entrega (entrega_cobranza / cuadre_dinero) o ya completadas.
    // Las que sigan en ruta conservan su estado, listas para el día siguiente.
    const snapOrdenes = await db.collection('orders')
      .where('mensajeroId', '==', mensajeroId)
      .where('estado', 'in', ['entrega_cobranza', 'cuadre_dinero', 'completada'])
      .get();

    // ✅ CUADRE-BARRIDO-001: contar las que quedan en ruta (solo informativo,
    // NO se tocan) para reportarlas en la respuesta y en el arqueo.
    let ordenesPendientesRuta = [];
    try {
      const snapEnRuta = await db.collection('orders')
        .where('mensajeroId', '==', mensajeroId)
        .where('estado', 'in', ['en_ruta_recogida', 'en_ruta_entrega'])
        .get();
      ordenesPendientesRuta = snapEnRuta.docs.map(d => ({
        numeroOrden: d.data().numeroOrden,
        clienteNombre: d.data().clienteNombre || '',
        estado: d.data().estado
      }));
    } catch (ePend) { console.warn('CUADRE-BARRIDO-001: no se pudo listar pendientes:', ePend.message); }

    // ✅ FIX CUADRE-MONTO-001: monto recibido OBLIGATORIO si hay efectivo.
    // ANTES: si el receptor no digitaba el monto, el backend asumía
    // recibido = esperado y el arqueo quedaba con descuadre $0 aunque nadie
    // hubiera contado el dinero (arqueos reales en $0/$0). AHORA: si hay
    // efectivo por entregar, el monto recibido se digita SÍ o SÍ — el conteo
    // físico del dinero es el corazón del arqueo. Se valida ANTES de tocar
    // cualquier dato (el batch aún no se ha confirmado).
    let esperadoPrevio = 0;
    snapOrdenes.forEach(doc => {
      const o = doc.data();
      if (o.cuadrado === true) return;
      const montoPre = Number(o.montoRecaudado) || 0;
      const tipoPre = o.tipoCobro
        || (/transfer|nequi|banco|consign|qr/i.test(o.formaPagoRecaudo || '') ? 'virtual' : 'efectivo');
      const esCreditoPre = tipoPre === 'credito' || /cr.dito|cxc|fiado/i.test(o.formaPagoRecaudo || '');
      if (!esCreditoPre && montoPre > 0 && o.dineroEnCaja !== true && tipoPre !== 'virtual') {
        esperadoPrevio += montoPre;
      }
    });
    const montoRecibidoDigitado = montoRecibido !== undefined && montoRecibido !== null && montoRecibido !== '';
    if (esperadoPrevio > 0 && !montoRecibidoDigitado) {
      return res.status(400).json({
        error: `Debes digitar el monto recibido. El mensajero debe entregar $${esperadoPrevio.toLocaleString('es-CO')} en efectivo — cuéntalo y digítalo antes de confirmar.`,
        requiereMontoRecibido: true,
        efectivoEsperado: esperadoPrevio
      });
    }

    let sumaEfectivo = 0;   // → caja Efectivo
    let sumaVirtual  = 0;   // → caja Bancos
    const ordenesParaCaja = [];
    let mensajeroNombreCuadre = ''; // ✅ LOGISTICA-CUADRE-001: para el arqueo

    snapOrdenes.forEach(doc => {
      const o = doc.data();
      if (o.cuadrado === true) return;
      if (!mensajeroNombreCuadre && o.mensajeroNombre) mensajeroNombreCuadre = o.mensajeroNombre;

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
      // FIX Ola 2.5: dinero virtual NO entra en el cuadre, espera validación
      // de Admin/Tesorería. Solo efectivo cuadra a caja inmediatamente.
      const yaEnCaja = o.dineroEnCaja === true;
      const sumaCaja = !esCredito && monto > 0 && !yaEnCaja && tipo !== 'virtual';

      batch.update(doc.ref, {
        cuadrado: true,
        fechaCuadre: new Date().toISOString(),
        cuadradoPor: req.user.email,
        estado: estadoFinal,
        // Ola 3: si queda en cartera, los flags de pago quedan LIMPIOS para
        // que CxC muestre el saldo completo y nadie crea que ya se cobró.
        ...(estadoFinal === 'cxc' ? {
          pagado: false,
          montoPagado: 0,
          montoRecaudado: 0,
          formaPagoRecaudo: 'A crédito (CxC)',
          tipoCobro: 'credito'
        } : {}),
        ...(sumaCaja ? {
          dineroEnCaja: true,
          dineroEnCajaFecha: new Date().toISOString(),
          dineroEnCajaPor: req.user.email
        } : {}),
        // FIX Ola 2.5: si fue virtual, marcar pendiente de validar (NO falsear).
        ...(tipo === 'virtual' && !esCredito ? {
          pagoVirtualPendienteValidar: true,
          pagoValidado: false
        } : {}),
        historialEstados: admin.firestore.FieldValue.arrayUnion({
          estado: estadoFinal,
          fecha: new Date().toISOString(),
          usuarioId: req.user.uid || req.user.id,
          usuarioNombre: req.user.email,
          nota: esCredito ? 'Cuadre: queda en cartera (CxC)'
              : tipo === 'virtual' ? 'Cuadre: pago virtual pendiente de validar'
              : 'Cuadre: dinero confirmado en caja'
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (sumaCaja) {
        sumaEfectivo += monto;
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

      // ✅ CUADRE-CAJA-001: si el receptor eligió caja para el EFECTIVO,
      // esa caja manda (validando que exista y pertenezca al tenant).
      let cajaDestinoRef = null;
      let cajaDestinoId = null;
      if (tipoCaja === 'Efectivo' && cajaEfectivoId) {
        const cajaSelDoc = await db.collection('cajas').doc(cajaEfectivoId).get();
        if (cajaSelDoc.exists && cajaSelDoc.data().userId === adminId) {
          cajaDestinoRef = cajaSelDoc.ref;
          cajaDestinoId = cajaSelDoc.id;
        } else {
          console.warn('CUADRE-CAJA-001: caja seleccionada inválida o de otro tenant — se usa fallback');
        }
      }

      if (!cajaDestinoRef) {
        // Fallback (comportamiento histórico): primera caja del tipo.
        // ✅ CUADRE-CAJA-001: se busca por adminId (antes req.user.uid — si
        // tesorería confirmaba el cuadre, no encontraba las cajas del tenant).
        const snapCajas = await db.collection('cajas')
          .where('userId', '==', adminId)
          .where('tipo', '==', tipoCaja)
          .limit(1).get();
        if (snapCajas.empty) {
          console.warn(`Cuadre: no se encontró caja tipo ${tipoCaja}`);
          return;
        }
        cajaDestinoRef = snapCajas.docs[0].ref;
        cajaDestinoId = snapCajas.docs[0].id;
      }

      await cajaDestinoRef.update({
        saldo: admin.firestore.FieldValue.increment(monto),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('movimientos').add({
        userId: adminId,
        cajaId: cajaDestinoId,
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

    // ══════════════════════════════════════════════════════════════════════
    // ✅ LOGISTICA-CUADRE-001: ARQUEO INMUTABLE
    // Al confirmar, se congela una "foto" permanente de este cuadre. Antes no
    // quedaba ningún registro consultable: si el mensajero decía "yo cuadré $X"
    // no había cómo verificarlo. Este documento es la huella de auditoría del
    // arqueo de caja — inmutable (nunca se edita ni borra, se anula si acaso),
    // respetando el invariante contable del sistema.
    // Opción (c): si hay descuadre (recibido ≠ esperado), se registra con la
    // nota/motivo, se permite confirmar, y el faltante/sobrante queda marcado.
    // ══════════════════════════════════════════════════════════════════════
    try {
      const esperadoEntregar = sumaEfectivo; // efectivo que debía entregar a caja
      const recibidoReal = montoRecibido !== undefined && montoRecibido !== null
        ? Number(montoRecibido)
        : esperadoEntregar;
      const descuadre = recibidoReal - esperadoEntregar; // <0 faltante, >0 sobrante

      const arqueo = {
        adminId,
        mensajeroId,
        mensajeroNombre: mensajeroNombreCuadre || '',
        fecha: new Date().toISOString(),
        autorizadoPorId: req.user.uid || req.user.id,
        autorizadoPorEmail: req.user.email,
        // Totales del arqueo
        efectivoEsperado: esperadoEntregar,
        efectivoRecibido: recibidoReal,
        descuadre,                       // faltante (−) o sobrante (+)
        motivoDescuadre: req.body.motivoDescuadre || '',
        virtualIngresado: sumaVirtual,
        // Detalle congelado (evidencia)
        ordenesCuadradas: ordenesParaCaja,
        // ✅ CUADRE-BARRIDO-001: constancia de lo que quedó en ruta (no cuadrado)
        ordenesPendientesRuta,
        // ✅ CUADRE-CAJA-001: caja de efectivo elegida por el receptor
        cajaEfectivoId: cajaEfectivoId || null,
        extintoresDevueltos: Array.isArray(extintoresDevueltos) ? extintoresDevueltos : [],
        // Estado del arqueo
        anulado: false
      };

      const refArqueo = await db.collection('cuadres_historial').add(arqueo);

      // Auditoría cruzada del arqueo (además del registro propio)
      await db.collection('audit_logs').add({
        accion: descuadre === 0 ? 'CUADRE_CONFIRMADO' : 'CUADRE_CON_DESCUADRE',
        adminId,
        mensajeroId,
        arqueoId: refArqueo.id,
        descripcion: `${req.user.email} confirmó cuadre de ${mensajeroNombreCuadre || mensajeroId}` +
          (descuadre !== 0 ? ` — DESCUADRE ${descuadre > 0 ? '+' : ''}${descuadre.toLocaleString('es-CO')} (${req.body.motivoDescuadre || 'sin motivo'})` : ''),
        fecha: new Date().toISOString()
      });
    } catch (eArqueo) {
      // El arqueo es registro; si falla no revierte el cuadre ya confirmado,
      // pero sí se loguea para revisión.
      console.error('LOGISTICA-CUADRE-001: no se pudo registrar el arqueo:', eArqueo.message);
    }

    res.json({
      ok: true,
      efectivoIngresado: sumaEfectivo,
      virtualIngresado: sumaVirtual,
      ordenesCuadradas: ordenesParaCaja.length,
      // ✅ CUADRE-BARRIDO-001: informar cuántas quedaron en ruta sin tocar
      ordenesPendientesRuta: ordenesPendientesRuta.length,
      pendientesDetalle: ordenesPendientesRuta
    });
  } catch (e) {
    console.error('POST cuadre/confirmar:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ✅ LOGISTICA-CUADRE-001: HISTÓRICO DE ARQUEOS (Admin / Tesorería)
// GET /api/logistica/cuadres-historial?mensajeroId=&desde=&hasta=
// Solo lectura. Consulta cualquier cuadre pasado con su detalle congelado —
// la respuesta a "¿cuánto cuadró Henry el día X?" con evidencia firmada.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/cuadres-historial', async (req, res) => {
  try {
    if (!['admin', 'tesoreria'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Solo administración o tesorería pueden ver el histórico de cuadres' });
    }
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    const { mensajeroId, desde, hasta } = req.query;

    // Filtro por adminId en Firestore; el resto en memoria (evita índices compuestos)
    const snap = await db.collection('cuadres_historial')
      .where('adminId', '==', adminId)
      .get();

    let arqueos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (mensajeroId) arqueos = arqueos.filter(a => a.mensajeroId === mensajeroId);
    if (desde) arqueos = arqueos.filter(a => (a.fecha || '') >= desde);
    if (hasta) arqueos = arqueos.filter(a => (a.fecha || '') <= `${hasta}T23:59:59`);

    // Más recientes primero
    arqueos.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

    res.json({
      total: arqueos.length,
      arqueos
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESUMEN POR MENSAJERO (Admin)
// GET /api/logistica/resumen-mensajeros
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/resumen-mensajeros', async (req, res) => {
  try {
    // ✅ FIX LOGISTICA-004 (2026-06-30): aislamiento multi-tenant — sin esto
    // se traían órdenes de TODOS los suscriptores y se mezclaban por
    // mensajeroId, exponiendo mensajeros y montos recaudados de otras
    // empresas. Se filtra por adminId primero y el estado en memoria
    // (mismo patrón que /ordenes, evita índice compuesto).
    const adminId = req.adminId || req.user?.uid || req.user?.id;
    // ✅ LOGISTICA-CUADRE-002: unificar la fuente de verdad con el cuadre.
    // Antes la tarjeta contaba estados distintos al modal de cuadre, por eso
    // mostraba "Recaudado $53.000" mientras el cuadre salía en $0. Ahora ambos
    // usan el MISMO universo de estados y el mismo montoRecaudado, solo de
    // órdenes NO cuadradas todavía (las ya cuadradas no son recaudo pendiente).
    const estadosResumen = ['en_ruta_recogida', 'en_ruta_entrega', 'entrega_cobranza', 'en_taller', 'cuadre_dinero', 'completada'];

    const snap = await db.collection('orders')
      .where('adminId', '==', adminId)
      .get();

    const porMensajero = {};
    snap.forEach(doc => {
      const o = doc.data();
      if (!estadosResumen.includes(o.estado)) return;
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
      if (o.estado === 'entrega_cobranza' || o.estado === 'completada') m.completadas++;
      if (['en_ruta_recogida', 'en_ruta_entrega'].includes(o.estado)) m.enRuta++;
      // ✅ LOGISTICA-CUADRE-002: solo recaudo pendiente (no ya cuadrado)
      if (o.cuadrado !== true) m.totalRecaudado += o.montoRecaudado || 0;
    });

    res.json(Object.values(porMensajero));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/logistica/orden/:id/asignar-sector — Mini-Ola 2.6
// Permite a Sandra/comercial asignar el sector a una orden desde Logística
// cuando llega sin él. Importante: ADEMÁS de actualizar la orden, GRABA el
// sector en el cliente o sucursal correspondiente para que futuras órdenes
// del mismo cliente lo tengan automáticamente.
// Body: { sectorId: 'sec_norte' }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/orden/:id/asignar-sector', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { sectorId } = req.body;
    if (!sectorId) return res.status(400).json({ error: 'sectorId requerido' });

    const ordenRef = db.collection('orders').doc(id);
    const ordenSnap = await ordenRef.get();
    if (!ordenSnap.exists) return res.status(404).json({ error: 'Orden no encontrada' });
    const orden = ordenSnap.data();

    // 1. Actualizar el sectorId en la orden
    await ordenRef.update({
      sectorId,
      sectorAsignadoPor: req.user.email,
      sectorAsignadoEn: new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2. Grabar el sector en el cliente o sucursal (para futuras órdenes)
    if (orden.clienteId) {
      try {
        const clienteRef = db.collection('clients').doc(orden.clienteId);
        const clienteSnap = await clienteRef.get();
        if (clienteSnap.exists) {
          const cliente = clienteSnap.data();
          if (orden.sucursalId) {
            // Grabar en la sucursal
            const sucursales = (cliente.sucursales || []).map(s =>
              s.id === orden.sucursalId ? { ...s, sectorId } : s
            );
            await clienteRef.update({
              sucursales,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } else {
            // Grabar en el cliente general
            await clienteRef.update({
              sectorId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      } catch (e) {
        console.warn('No se pudo grabar sector en cliente:', e.message);
      }
    }

    await auditar({
      accion: 'ASIGNAR_SECTOR_ORDEN',
      descripcion: `${req.user.email} asignó sector ${sectorId} a orden ${orden.numeroOrden}`,
      usuarioId: req.user.uid || req.user.id,
      usuarioEmail: req.user.email,
      documento: orden.numeroOrden,
    });

    res.json({ ok: true, sectorId, ordenId: id });
  } catch (e) {
    console.error('PUT asignar-sector orden:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;