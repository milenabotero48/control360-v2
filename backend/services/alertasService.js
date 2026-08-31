// ════════════════════════════════════════════════════════════════════════════════
// services/alertasService.js — ALERTAS-001
// ─────────────────────────────────────────────────────────────────────────────
// Servicio de alertas inteligentes. Extraído de routes/alertas.js para separar
// la LÓGICA DE DETECCIÓN del transporte HTTP.
//
// Qué cambia respecto a la versión anterior (y por qué):
//
//   1. AGREGACIÓN — antes cada detector emitía una alerta POR DOCUMENTO.
//      90 órdenes atoradas en taller = 90 filas idénticas en la campana.
//      Ahora cada tipo emite UNA alerta con el conteo y el detalle adentro:
//      "12 órdenes atoradas en taller". El detalle no se pierde: va en
//      `datos.ordenesEjemplo` y `datos.casos`.
//
//   2. CADENCIA POR TIPO — antes los 7 detectores se recalculaban juntos cada
//      5 minutos, leyendo ~20.000 documentos cada vez. CLIENTE_FUGANDOSE solo
//      leía 19.266 documentos para responder "¿quién no compra hace 11 meses?",
//      una pregunta cuya respuesta cambia una vez al día, no 288 veces.
//      Ahora cada detector tiene su propia frecuencia según qué tan rápido
//      cambia el dato que vigila.
//
//   3. FILTRO EN LA CONSULTA — antes se traía la colección completa y se
//      filtraba en memoria. Ahora se filtra en Firestore. Si falta el índice
//      compuesto, hace fallback automático a la consulta vieja y deja el aviso
//      en los logs: nada se rompe mientras se crean los índices.
//
// LO QUE NO CAMBIA: las reglas de negocio de los 7 detectores son idénticas.
// Los umbrales, las prioridades y los roles destino se movieron tal cual.
// ════════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const admin = require('firebase-admin');
const db = admin.firestore();
const { parseFecha, horasEntre, diasEntre, log } = require('../routes/_helpers');

// ─── CONFIG: umbrales (después estos van a configuracion para personalizar) ──
const UMBRALES = {
  FOTOS_FALTANTES_MIN: 3,          // ≥3 órdenes sin foto = bandera roja
  TALLER_ATORADO_DIAS: 3,          // >3 días en taller sin movimiento
  PAGO_PENDIENTE_HORAS: 24,        // >24h sin validar pago virtual
  PRESTAMO_DIAS: 30,               // >30 días sin devolver préstamo
  CXC_DIAS_MORA: 15,               // >15 días vencido
  CLIENTE_FUGANDOSE_MESES: 11,     // 11 meses sin comprar (ciclo anual es 13)
  CLIENTE_FUGADO_MESES: 13,        // ya pasados 13 meses = fugado (va a reportes)
};

const PRIORIDAD = {
  DEFECTO_RESPONDIDO: 'critica',
  FOTOS_FALTANTES: 'critica',
  TALLER_ATORADO: 'critica',
  PAGO_PENDIENTE: 'importante',
  PRESTAMO_VIEJO: 'importante',
  CXC_VENCIDO: 'importante',
  CLIENTE_FUGANDOSE: 'informativa',
};

const ROLES_DESTINO = {
  DEFECTO_RESPONDIDO: ['admin', 'taller'],
  FOTOS_FALTANTES: ['admin'],
  TALLER_ATORADO: ['admin', 'taller'],
  PAGO_PENDIENTE: ['admin', 'tesoreria'],
  PRESTAMO_VIEJO: ['admin'],
  CXC_VENCIDO: ['admin', 'tesoreria'],
  CLIENTE_FUGANDOSE: ['admin', 'comercial'],
};

// ════════════════════════════════════════════════════════════════════════════
// CADENCIA — cada cuánto se recalcula cada detector.
// El criterio es qué tan rápido cambia el dato que vigila, no qué tan
// importante es la alerta.
// ════════════════════════════════════════════════════════════════════════════
const MIN = 60 * 1000;
const HORA = 60 * MIN;

const CADENCIA_MS = {
  // Operativas: hay que reaccionar el mismo día
  DEFECTO_RESPONDIDO: 15 * MIN,
  TALLER_ATORADO: 15 * MIN,
  PAGO_PENDIENTE: 15 * MIN,
  // Tácticas: no cambian en minutos
  FOTOS_FALTANTES: 12 * HORA,
  PRESTAMO_VIEJO: 12 * HORA,
  CXC_VENCIDO: 12 * HORA,
  // Estratégica: es un indicador de ciclo anual
  CLIENTE_FUGANDOSE: 24 * HORA,
};

// ════════════════════════════════════════════════════════════════════════════
// AGRUPACIÓN — cómo se consolidan los casos de cada tipo en alertas.
//
//   'tenant'  → UNA alerta para todo el tipo, con el conteo en el título.
//   'sujeto'  → una alerta por sujeto (mensajero, cliente...). Se usa cuando
//               el sujeto ES la información: "Carlos con 46 órdenes sin foto"
//               ya es una sola alerta bien formada.
// ════════════════════════════════════════════════════════════════════════════
const AGRUPACION = {
  FOTOS_FALTANTES: 'sujeto',   // ya venía agrupado por mensajero — se respeta
  TALLER_ATORADO: 'tenant',
  PAGO_PENDIENTE: 'tenant',
  DEFECTO_RESPONDIDO: 'tenant',
  PRESTAMO_VIEJO: 'tenant',
  CXC_VENCIDO: 'tenant',
  CLIENTE_FUGANDOSE: 'tenant',
};

// Título de la alerta consolidada, en función de cuántos casos agrupa.
const TITULO_GRUPO = {
  TALLER_ATORADO: (n) => `${n} órdenes atoradas en taller hace más de ${UMBRALES.TALLER_ATORADO_DIAS} días`,
  PAGO_PENDIENTE: (n) => `${n} pagos virtuales sin validar hace más de ${UMBRALES.PAGO_PENDIENTE_HORAS}h`,
  DEFECTO_RESPONDIDO: (n) => `${n} clientes respondieron sobre cambio de repuesto`,
  PRESTAMO_VIEJO: (n) => `${n} extintores en préstamo hace más de ${UMBRALES.PRESTAMO_DIAS} días`,
  CXC_VENCIDO: (n) => `${n} clientes con cartera vencida hace más de ${UMBRALES.CXC_DIAS_MORA} días`,
  CLIENTE_FUGANDOSE: (n) => `${n} clientes sin comprar hace ${UMBRALES.CLIENTE_FUGANDOSE_MESES}+ meses`,
};

// ════════════════════════════════════════════════════════════════════════════
// Lectura con fallback: intenta la consulta filtrada (barata). Si Firestore
// pide un índice compuesto que todavía no existe, cae a la consulta vieja
// (cara pero funcional) y deja el aviso en los logs con el link para crearlo.
// Regla: una optimización pendiente NUNCA deja al usuario sin alertas.
// ════════════════════════════════════════════════════════════════════════════
const leerConFallback = async (queryFiltrada, queryBase, etiqueta) => {
  try {
    return await queryFiltrada.get();
  } catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('index') || e?.code === 9) {
      log.warn('alertas', `${etiqueta}: falta índice compuesto, usando consulta sin filtro. Crear el índice con el link del error: ${msg.slice(0, 300)}`);
      return await queryBase.get();
    }
    throw e;
  }
};

// ════════════════════════════════════════════════════════════════════════════
// DETECTORES
// Cada uno devuelve un array de CASOS individuales: { referenciaId, titulo,
// descripcion, datos }. La consolidación en alertas la hace `agrupar()`.
// Las reglas de negocio son idénticas a la versión anterior.
// ════════════════════════════════════════════════════════════════════════════

// 🔴 FOTOS_FALTANTES — mensajeros con ≥3 órdenes sin foto de entrega
const detectarFotosFaltantes = async (adminId) => {
  const casos = [];
  try {
    const base = db.collection('orders').where('adminId', '==', adminId);
    const snap = await leerConFallback(
      base.where('estado', 'in', ['completada', 'cuadre_dinero']),
      base,
      'FOTOS_FALTANTES'
    );

    const sinFoto = {}; // mensajeroId → [ordenes]
    snap.forEach(d => {
      const o = d.data();
      if (o.estado !== 'completada' && o.estado !== 'cuadre_dinero') return;
      if (o.estado === 'anulada') return;
      if (o.fotoEntrega) return;
      if (!o.mensajeroId) return;
      if (!sinFoto[o.mensajeroId]) sinFoto[o.mensajeroId] = [];
      sinFoto[o.mensajeroId].push({ id: d.id, ...o });
    });

    for (const [mensajeroId, ords] of Object.entries(sinFoto)) {
      if (ords.length >= UMBRALES.FOTOS_FALTANTES_MIN) {
        casos.push({
          referenciaId: mensajeroId,
          titulo: `${ords[0].mensajeroNombre || 'Mensajero'} con ${ords.length} órdenes sin foto`,
          descripcion: `Posibles descargos formales. Verifica las últimas entregas.`,
          datos: {
            mensajeroId,
            mensajeroNombre: ords[0].mensajeroNombre || '',
            cantidadOrdenes: ords.length,
            ordenesEjemplo: ords.slice(0, 5).map(o => ({
              id: o.id, numeroOrden: o.numeroOrden, clienteNombre: o.clienteNombre,
            })),
          },
        });
      }
    }
  } catch (e) { log.error('alertas.fotos', 'detección falló', e); }
  return casos;
};

// 🔴 TALLER_ATORADO — órdenes en taller >3 días sin avance
const detectarTallerAtorado = async (adminId) => {
  const casos = [];
  try {
    const base = db.collection('orders').where('adminId', '==', adminId);
    const snap = await leerConFallback(
      base.where('estado', 'in', ['en_taller', 'taller_proceso']),
      base,
      'TALLER_ATORADO'
    );

    const ahora = new Date();
    snap.forEach(d => {
      const o = d.data();
      if (o.estado !== 'en_taller' && o.estado !== 'taller_proceso') return;
      const fechaEnTaller = parseFecha(o.fechaEnTaller)
        || parseFecha((o.historialEstados || []).find(h => h.estado === 'en_taller')?.fecha)
        || parseFecha(o.updatedAt);
      if (!fechaEnTaller) return;
      const dias = diasEntre(fechaEnTaller, ahora);
      if (dias >= UMBRALES.TALLER_ATORADO_DIAS) {
        casos.push({
          referenciaId: d.id,
          titulo: `Orden ${o.numeroOrden} atorada en taller hace ${dias} días`,
          descripcion: `Cliente: ${o.clienteNombre}. Revisa qué está bloqueando el avance.`,
          etiqueta: o.numeroOrden,
          datos: {
            ordenId: d.id, numeroOrden: o.numeroOrden,
            clienteNombre: o.clienteNombre,
            fechaEnTaller: fechaEnTaller.toISOString(),
            dias,
          },
        });
      }
    });
  } catch (e) { log.error('alertas.taller', 'detección falló', e); }
  return casos;
};

// 🔴 DEFECTO_RESPONDIDO — el cliente ya contestó el WhatsApp del defecto
const detectarDefectoRespondido = async (adminId) => {
  const casos = [];
  try {
    const snap = await db.collection('orders')
      .where('adminId', '==', adminId)
      .where('tieneDefectosPendientes', '==', true)
      .get();

    snap.forEach(doc => {
      const o = doc.data();
      const defectos = Array.isArray(o.tallerDefectos) ? o.tallerDefectos : [];

      defectos.forEach((d, idx) => {
        if (d.estado !== 'pendiente_autorizacion') return;
        const r = d.respuestaCliente;
        if (!r || (r.valor !== 'APROBADO' && r.valor !== 'RECHAZADO')) return;

        const aprobo = r.valor === 'APROBADO';
        casos.push({
          // referenciaId único por defecto: permite resolver un caso sin
          // ocultar los de otros defectos de la misma orden.
          referenciaId: `${doc.id}_${idx}`,
          titulo: aprobo
            ? `El cliente APROBÓ el cambio de repuesto — orden ${o.numeroOrden}`
            : `El cliente NO APROBÓ el cambio de repuesto — orden ${o.numeroOrden}`,
          descripcion: `${o.clienteNombre || 'Cliente'} respondió por WhatsApp: "${String(r.textoLiteral || '').slice(0, 120)}". Confirma en Taller para aplicar la decisión.`,
          etiqueta: o.numeroOrden,
          datos: {
            ordenId: doc.id,
            numeroOrden: o.numeroOrden,
            clienteNombre: o.clienteNombre || '',
            defectoIndex: idx,
            descripcionDefecto: d.descripcion || '',
            costoReparacion: Number(d.costoReparacion) || 0,
            respuesta: r.valor,
            textoLiteral: r.textoLiteral || '',
            fechaRespuesta: r.fecha || '',
          },
        });
      });
    });
  } catch (e) { log.error('alertas.defectoRespondido', 'detección falló', e); }
  return casos;
};

// 🟡 PAGO_PENDIENTE — pagos virtuales sin validar >24h
const detectarPagoPendiente = async (adminId) => {
  const casos = [];
  try {
    const base = db.collection('orders').where('adminId', '==', adminId);
    const snap = await leerConFallback(
      base.where('pagoVirtualPendienteValidar', '==', true),
      base,
      'PAGO_PENDIENTE'
    );

    const ahora = new Date();
    snap.forEach(d => {
      const o = d.data();
      if (!o.pagoVirtualPendienteValidar) return;
      const fechaCobro = parseFecha(o.fechaCobro) || parseFecha(o.fechaPago) || parseFecha(o.updatedAt);
      if (!fechaCobro) return;
      const h = horasEntre(fechaCobro, ahora);
      if (h >= UMBRALES.PAGO_PENDIENTE_HORAS) {
        casos.push({
          referenciaId: d.id,
          titulo: `Pago virtual sin validar hace ${Math.round(h)}h: ${o.numeroOrden}`,
          descripcion: `Cliente: ${o.clienteNombre}. ${o.formaPago || 'Pago virtual'}. Valida el comprobante.`,
          etiqueta: o.numeroOrden,
          datos: {
            ordenId: d.id, numeroOrden: o.numeroOrden,
            clienteNombre: o.clienteNombre,
            formaPago: o.formaPago, total: o.total,
            fechaCobro: fechaCobro.toISOString(),
            horas: Math.round(h),
          },
        });
      }
    });
  } catch (e) { log.error('alertas.pago', 'detección falló', e); }
  return casos;
};

// 🟡 PRESTAMO_VIEJO — extintores en préstamo >30 días en cliente
const detectarPrestamosViejos = async (adminId) => {
  const casos = [];
  try {
    const base = db.collection('extintores_prestamo').where('adminId', '==', adminId);
    const snap = await leerConFallback(
      base.where('estado', '==', 'prestado'),
      base,
      'PRESTAMO_VIEJO'
    );

    const ahora = new Date();
    snap.forEach(d => {
      const p = d.data();
      if (p.estado !== 'prestado') return;
      const fSalida = parseFecha(p.fechaSalida);
      if (!fSalida) return;
      const dias = diasEntre(fSalida, ahora);
      if (dias >= UMBRALES.PRESTAMO_DIAS) {
        casos.push({
          referenciaId: d.id,
          titulo: `Extintor ${p.numeroExtintor} en cliente hace ${dias} días`,
          descripcion: `Cliente: ${p.clienteNombre}. Posible riesgo de pérdida.`,
          etiqueta: p.numeroExtintor,
          datos: {
            prestamoId: d.id,
            numeroExtintor: p.numeroExtintor,
            clienteNombre: p.clienteNombre,
            clienteId: p.clienteId,
            fechaSalida: fSalida.toISOString(),
            dias,
          },
        });
      }
    });
  } catch (e) { log.error('alertas.prestamos', 'detección falló', e); }
  return casos;
};

// 🟡 CXC_VENCIDO — facturas en mora >15 días
const detectarCxCVencido = async (adminId) => {
  const casos = [];
  try {
    const base = db.collection('cxc').where('adminId', '==', adminId);
    const snap = await leerConFallback(
      base.where('estado', '==', 'pendiente'),
      base,
      'CXC_VENCIDO'
    );

    const ahora = new Date();
    snap.forEach(d => {
      const c = d.data();
      if (c.estado !== 'pendiente') return;
      const fVenc = parseFecha(c.fechaVencimiento);
      if (!fVenc) return;
      const dias = diasEntre(fVenc, ahora);
      if (dias >= UMBRALES.CXC_DIAS_MORA) {
        casos.push({
          referenciaId: d.id,
          titulo: `CxC ${c.numeroOrden || ''} en mora hace ${dias} días`,
          descripcion: `Cliente: ${c.clienteNombre}. Saldo: $${(c.saldoPendiente || c.monto || 0).toLocaleString('es-CO')}`,
          etiqueta: c.clienteNombre,
          datos: {
            cxcId: d.id, numeroOrden: c.numeroOrden,
            clienteNombre: c.clienteNombre,
            saldoPendiente: c.saldoPendiente || c.monto,
            fechaVencimiento: fVenc.toISOString(),
            diasMora: dias,
          },
        });
      }
    });
  } catch (e) { log.error('alertas.cxc', 'detección falló', e); }
  return casos;
};

// 🟢 CLIENTE_FUGANDOSE — 11+ meses sin comprar (antes de los 13 que ya son fugados)
// Es el detector más caro del sistema: cruza clients × orders completos.
// Por eso corre UNA vez al día (ver CADENCIA_MS) — su respuesta no cambia
// de un minuto a otro.
const detectarClientesFugandose = async (adminId) => {
  const casos = [];
  try {
    const [clientsSnap, ordsSnap] = await Promise.all([
      db.collection('clients').where('adminId', '==', adminId).get(),
      db.collection('orders').where('adminId', '==', adminId)
        .select('estado', 'clienteId', 'createdAt').get(),
    ]);

    // Última orden por cliente
    const ultimaPorCliente = {};
    ordsSnap.forEach(d => {
      const o = d.data();
      if (o.estado === 'anulada' || !o.clienteId) return;
      const f = parseFecha(o.createdAt);
      if (!f) return;
      const cur = ultimaPorCliente[o.clienteId];
      if (!cur || f > cur) ultimaPorCliente[o.clienteId] = f;
    });

    const ahora = new Date();
    clientsSnap.forEach(d => {
      const c = d.data();
      const ultima = ultimaPorCliente[d.id];
      if (!ultima) return; // nunca compró → no es "fugándose"
      const dias = diasEntre(ultima, ahora);
      const meses = dias / 30;
      if (meses >= UMBRALES.CLIENTE_FUGANDOSE_MESES && meses < UMBRALES.CLIENTE_FUGADO_MESES) {
        casos.push({
          referenciaId: d.id,
          titulo: `${c.nombre} sin comprar hace ${Math.round(meses * 10) / 10} meses`,
          descripcion: `Antes de los ${UMBRALES.CLIENTE_FUGADO_MESES} meses, ¡contáctalo! Su ciclo anual está por vencer.`,
          etiqueta: c.nombre,
          datos: {
            clienteId: d.id,
            clienteNombre: c.nombre,
            celular: c.celular,
            ultimaCompraISO: ultima.toISOString(),
            meses: Math.round(meses * 10) / 10,
          },
        });
      }
    });
  } catch (e) { log.error('alertas.fugandose', 'detección falló', e); }
  return casos;
};

const DETECTORES = {
  FOTOS_FALTANTES: detectarFotosFaltantes,
  TALLER_ATORADO: detectarTallerAtorado,
  DEFECTO_RESPONDIDO: detectarDefectoRespondido,
  PAGO_PENDIENTE: detectarPagoPendiente,
  PRESTAMO_VIEJO: detectarPrestamosViejos,
  CXC_VENCIDO: detectarCxCVencido,
  CLIENTE_FUGANDOSE: detectarClientesFugandose,
};

// ════════════════════════════════════════════════════════════════════════════
// AGRUPACIÓN — de casos individuales a alertas consolidadas
// ════════════════════════════════════════════════════════════════════════════

// Huella estable del conjunto de casos. Sirve como referenciaId del grupo:
// mientras el conjunto sea el mismo, la alerta resuelta sigue resuelta.
// Si entra o sale un caso, la huella cambia y la alerta vuelve a aparecer
// — que es exactamente lo que se quiere: el problema ya no es el mismo.
const huellaDe = (casos) => {
  const ids = casos.map(c => String(c.referenciaId)).sort().join('|');
  return crypto.createHash('md5').update(ids).digest('hex').slice(0, 10);
};

const agrupar = (tipo, casos) => {
  if (!casos.length) return [];

  const comun = {
    tipo,
    prioridad: PRIORIDAD[tipo],
    rolesDestino: ROLES_DESTINO[tipo],
  };

  // Agrupación por sujeto: cada caso ya es una alerta bien formada.
  if (AGRUPACION[tipo] === 'sujeto') {
    return casos.map(c => ({
      ...comun,
      referenciaId: c.referenciaId,
      titulo: c.titulo,
      descripcion: c.descripcion,
      cantidad: 1,
      datos: c.datos,
    }));
  }

  // Un solo caso: se muestra tal cual, sin envolverlo en un grupo.
  if (casos.length === 1) {
    return [{
      ...comun,
      referenciaId: casos[0].referenciaId,
      titulo: casos[0].titulo,
      descripcion: casos[0].descripcion,
      cantidad: 1,
      datos: casos[0].datos,
    }];
  }

  // Varios casos: UNA alerta con el conteo y el detalle adentro.
  const etiquetas = casos.map(c => c.etiqueta).filter(Boolean);
  const muestra = etiquetas.slice(0, 3).join(', ');
  const resto = etiquetas.length - 3;

  return [{
    ...comun,
    referenciaId: `GRUPO_${huellaDe(casos)}`,
    titulo: (TITULO_GRUPO[tipo] || ((n) => `${n} casos`))(casos.length),
    descripcion: muestra
      ? `${muestra}${resto > 0 ? ` y ${resto} más` : ''}. Abre el detalle para revisarlos.`
      : `${casos.length} casos pendientes de revisar.`,
    cantidad: casos.length,
    datos: {
      cantidad: casos.length,
      // Se reutiliza `ordenesEjemplo` porque la campana ya sabe renderizarlo:
      // así el detalle aparece sin tocar el frontend.
      ordenesEjemplo: casos.slice(0, 5).map(c => ({
        id: c.referenciaId,
        numeroOrden: c.etiqueta || c.referenciaId,
        clienteNombre: c.datos?.clienteNombre || '',
      })),
      casos: casos.map(c => ({
        referenciaId: c.referenciaId,
        titulo: c.titulo,
        descripcion: c.descripcion,
        datos: c.datos,
      })),
    },
  }];
};

// ════════════════════════════════════════════════════════════════════════════
// CACHE POR TENANT Y POR TIPO
// Antes había un solo caché de 5 minutos para los 7 detectores juntos: al
// vencer, se recalculaban todos. Ahora cada tipo vence según su cadencia, así
// que el detector caro (CLIENTE_FUGANDOSE) no se arrastra con los baratos.
// ════════════════════════════════════════════════════════════════════════════
const cache = new Map(); // adminId → Map(tipo → { casos, expiraEn })

const cacheTenant = (adminId) => {
  if (!cache.has(adminId)) cache.set(adminId, new Map());
  return cache.get(adminId);
};

const invalidarCache = (adminId, tipo = null) => {
  if (!adminId) return;
  if (!tipo) { cache.delete(adminId); return; }
  cacheTenant(adminId).delete(tipo);
};

// ════════════════════════════════════════════════════════════════════════════
// API DEL SERVICIO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Devuelve todas las alertas activas de un tenant, ya consolidadas.
 * Solo recalcula los detectores cuya cadencia venció; el resto sale de caché.
 */
const obtenerAlertas = async (adminId) => {
  const propio = cacheTenant(adminId);
  const ahora = Date.now();

  const tipos = Object.keys(DETECTORES);
  const vencidos = tipos.filter(t => {
    const e = propio.get(t);
    return !e || ahora > e.expiraEn;
  });

  if (vencidos.length) {
    const resultados = await Promise.all(
      vencidos.map(t => DETECTORES[t](adminId).catch(err => {
        log.error('alertas', `detector ${t} falló`, err);
        return null; // null = no pudimos calcular; se conserva lo anterior
      }))
    );

    vencidos.forEach((t, i) => {
      const casos = resultados[i];
      if (casos === null) return; // falló: se deja el caché viejo si existía
      propio.set(t, { casos, expiraEn: ahora + CADENCIA_MS[t] });
    });

    log.info('alertas', `recalculados para ${adminId}: ${vencidos.join(', ')}`);
  }

  const alertas = [];
  tipos.forEach(t => {
    const e = propio.get(t);
    if (!e) return;
    alertas.push(...agrupar(t, e.casos));
  });

  return alertas;
};

module.exports = {
  obtenerAlertas,
  invalidarCache,
  UMBRALES,
  PRIORIDAD,
  ROLES_DESTINO,
  CADENCIA_MS,
  AGRUPACION,
};
