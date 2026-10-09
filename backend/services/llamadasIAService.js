// ============================================================
// Control360 — Servicio de Llamadas IA (Lucy / ElevenLabs)
// Ubicación: backend/services/llamadasIAService.js
// ------------------------------------------------------------
// ✅ FIX LUCY-ELEVEN-001 (2026-07-19): migración de proveedor
// Vapi → ElevenLabs Agents + correcciones de motor:
//   a) Proveedor: lanzarLlamadaElevenLabs() reemplaza a Vapi.
//      Las variables dinámicas y el metadata (adminId/registroId)
//      viajan en conversation_initiation_client_data y vuelven
//      en el webhook post-llamada.
//   b) BUG CORREGIDO: registroRef se usaba ANTES de declararse
//      (Temporal Dead Zone) — cada intento de llamada reventaba
//      dentro del try y caía al catch. Ahora se declara primero.
//   c) Motor con alcance por tenant: ejecutarMotorLlamadas ahora
//      acepta { soloAdminId } — el cron lo llama sin filtro (todos
//      los tenants ACTIVOS), pero el disparo manual y las corridas
//      programadas SIEMPRE pasan el tenant. Nunca más una prueba
//      manual dispara llamadas de otros suscriptores.
//   d) Tope de minutos por tenant/mes (llamadas_ia_config) — el
//      costo de ElevenLabs lo paga Control360; el tope protege el
//      margen y es la base del cobro por consumo del módulo.
//   e) Corridas programadas: Sandra/el suscriptor eligen día y
//      hora (igual que Anny) — colección llamadas_ia_programadas,
//      el cron las revisa cada 15 min y ejecuta las vencidas.
//   f) Llamada de prueba a un número puntual (lanzarLlamadaPrueba)
//      para validar guion/voz sin tocar clientes reales.
//
// REGLAS DE NEGOCIO (validadas con Sandra):
// 1. ACTIVACIÓN: 100% manual por Sandra, por tenant, clave
//    'llamadas_ia' en users.modulos (modulos===[] NO activa este
//    módulo — igual que 'qr').
// 2. DISPARO AUTOMÁTICO: primeros 3 días hábiles del mes, 9 AM CO.
// 3. MÁXIMO 2 INTENTOS por cliente/mes; luego telemercadeo.
// 4. ANTI-DUPLICADO: clienteId + mesVencimiento.
// 5. AISLAMIENTO multi-tenant en toda operación.
// 6. FIRE-AND-FORGET: errores individuales no detienen el lote.
// 7. LUCY CIERRA SOLA: precios de lista y agendamiento.
//    ESCALA AL ASESOR: descuentos, negociaciones, clientes grandes.
// ============================================================

const { db, admin } = require('../config/firebase');

// ─── Config ElevenLabs (Railway) ─────────────────────────────────────────────
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY;
const ELEVEN_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;          // agente "Lucy - Vencimientos"
const ELEVEN_PHONE_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID;   // id del número (Twilio) importado en ElevenLabs
const COSTO_FACTURADO_COP = Number(process.env.LLAMADA_IA_COSTO_COP) || 300;
const TOPE_MINUTOS_DEFAULT = Number(process.env.LLAMADA_IA_TOPE_MINUTOS) || 120; // por tenant/mes si no hay config

// ─── ✅ FIX LUCY-CAPACIDAD-001 (2026-07-26) ──────────────────────────────────
// PROBLEMA DETECTADO: el motor descontaba 2 minutos FIJOS del presupuesto por
// cada llamada lanzada. Con el tope por defecto de 120 min eso significaba
// exactamente 60 llamadas y corte silencioso — un tenant con 120 vencimientos
// solo recibía llamadas para la mitad de su base, sin explicación en pantalla.
// Además una llamada NO CONTESTADA consume ~0 minutos reales pero igual
// descontaba 2 del presupuesto, desperdiciando capacidad ya pagada.
//
// SOLUCIÓN (3 partes):
//   1. La reserva se estima POR TIPO DE ACTIVO (ver clasificarActivo), no un
//      valor fijo: el guion de mostrador es mucho más corto que el de técnico.
//   2. La reserva se ajusta por la TASA DE CONTESTACIÓN: solo una fracción de
//      las llamadas lanzadas llega a conversación real y consume minutos.
//   3. El consumo REAL sigue siendo el que manda: lo registra el webhook con
//      la duración efectiva (registrarConsumoMinutos). La reserva es solo un
//      freno de emergencia dentro de la corrida.
const MAX_INTENTOS_DEFAULT = Number(process.env.LLAMADA_IA_MAX_INTENTOS) || 3;

// ✅ LUCY-PRIORIDAD-001: umbral de equipos para considerar prioritario a un
// cliente. Un cliente con 1 extintor de carro y uno de oficina con 6 no valen
// lo mismo: al segundo no se le puede dejar enfriar 3 intentos de Lucy.
// Configurable por tenant en llamadasIAConfig.umbralPrioridadEquipos.
const UMBRAL_PRIORIDAD_DEFAULT = Number(process.env.LLAMADA_IA_UMBRAL_PRIORIDAD) || 2;

// Fracción de llamadas lanzadas que termina en conversación facturable.
// Conservador: si de cada 10 llamadas contestan 4, solo esas consumen minutos.
const FACTOR_CONTESTACION = Number(process.env.LLAMADA_IA_FACTOR_CONTESTACION) || 0.45;

// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-TIMBRE-006 (2026-09-22) — cuánto suena antes de colgar
// ─────────────────────────────────────────────────────────────────────────────
// ElevenLabs deja 60 s por defecto. En Colombia un timbre dura ~6 s, así que
// 60 s son ~10 timbres: el cliente que no va a contestar igual no contesta, y
// muchos números alcanzan a pasar al buzón — el buzón CONTESTA, Lucy le habla
// a una grabadora y eso sí consume minutos facturables.
// 20 s ≈ 3 timbres. Configurable por tenant en llamadas_ia_config.segundosTimbre.
const SEGUNDOS_TIMBRE_DEFAULT = Number(process.env.LLAMADA_IA_SEGUNDOS_TIMBRE) || 20;
const SEGUNDOS_TIMBRE_MIN = 10;
const SEGUNDOS_TIMBRE_MAX = 60;

// ✅ LUCY-PAQUETE-005: tamaño máximo de un paquete manual.
const MAX_LLAMADAS_TOPE = 1000;

// ═════════════════════════════════════════════════════════════════════════════
// CONTROL DE CONCURRENCIA — el plan de ElevenLabs limita llamadas SIMULTÁNEAS
// (Free 4 · Starter 6 · Creator 10 · Pro 20 · Scale 30). Superar el límite
// dispara tarifa de ráfaga (~2× el minuto) o rechazo de llamadas.
//
// ⚠️ EL CÁLCULO IMPORTA: no basta con lanzar lotes pequeños. Las llamadas del
// lote anterior SIGUEN VIVAS cuando entra el siguiente. Con lote=5 cada 20 s y
// llamadas de ~75 s, a los 40 segundos hay 15 activas — se supera el límite de
// Creator sin que nadie se dé cuenta.
//
// Concurrencia en régimen ≈ LOTE × (DURACIÓN_LLAMADA / PAUSA)
//   4 × (75 / 45) ≈ 6,7 activas → cabe con holgura en Creator (10)
//
// Si subes de plan, ajusta ambas variables en Railway; no toques este archivo.
// ═════════════════════════════════════════════════════════════════════════════
// Ajuste conservador pedido por Sandra: 3 llamadas por minuto.
//   3 × (75 / 60) ≈ 3,75 activas → margen enorme frente a las 10 de Creator.
//   Una base de 120 clientes se lanza en ~40 minutos.
const LOTE_CONCURRENTE  = Number(process.env.LLAMADA_IA_CONCURRENCIA) || 3;
const PAUSA_ENTRE_LOTES = Number(process.env.LLAMADA_IA_PAUSA_LOTE_MS) || 60000;

// ─── Helpers de fecha (mismo criterio que vencimientosService.js) ────────────
const mesActualColombia = () => {
  const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
  return ahoraCO.toISOString().slice(0, 7); // "YYYY-MM"
};

// ✅ LUCY-MES-004: un mes válido es exactamente "YYYY-MM". Se valida en el
// motor y en la ruta: un mes inventado consultaría un rango vacío en silencio.
const esMesValido = (mes) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || ''));

const ahoraColombiaISO = () => {
  // "YYYY-MM-DDTHH:mm" en hora Colombia — comparable como string
  const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
  return ahoraCO.toISOString().slice(0, 16);
};

// ─── Helper: normalizar teléfono a E.164 (Twilio) ────────────────────────────
const normalizarParaLlamada = (telefono) => {
  if (!telefono) return null;
  let t = String(telefono).replace(/[\s\-\(\)\.]/g, '');
  if (t.startsWith('+')) return t;
  if (t.startsWith('57') && t.length === 12) return '+' + t;
  if (t.length === 10 && t.startsWith('3')) return '+57' + t;
  return null; // no se adivinan formatos raros — mejor omitir que llamar mal
};

// ─── Helper: nombre de pila ──────────────────────────────────────────────────
const primerNombre = (nombreCompleto) => {
  if (!nombreCompleto) return 'cliente';
  return String(nombreCompleto).trim().split(/\s+/)[0];
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ CLASIFICACIÓN DE ACTIVO — LUCY-CAPACIDAD-001
// ─────────────────────────────────────────────────────────────────────────────
// Regla de negocio (validada con Sandra, mercado colombiano):
//   · ABC de 5 lb o menos  → ~90% son de VEHÍCULO. El cliente PASA por la sede,
//     no requiere agendar técnico. Guion corto (~1 min) y desenlace mostrador.
//   · ABC 10 lb+, CO2, Solkaflam, agua a presión, rodantes → EMPRESA. Servicio
//     en sitio, requiere agendar técnico. Guion largo (~2.5 min).
//
// IMPORTANTE PARA EL SaaS: esto es un RULESET POR DEFECTO, no una verdad
// universal. Un suscriptor de otro nicho (pólizas, mantenimientos, calibración)
// debe poder sobrescribirlo desde llamadas_ia_config.reglasClasificacion sin
// que nadie toque este archivo. El motor lee reglas; no las contiene.
//
// NOTA: Lucy NUNCA afirma "su extintor de carro" — el 10% restante puede ser de
// casa u oficina. El guion de mostrador funciona igual en los tres casos, y si
// el cliente pide visita, Lucy escala a preorden con técnico.
// ═════════════════════════════════════════════════════════════════════════════
const REGLAS_CLASIFICACION_DEFAULT = [
  // Se evalúan en orden; la primera que hace match gana.
  {
    id: 'empresa_por_agente',
    patron: 'CO2|SOLKAFLAM|LIMPIO|AGUA|ESPUMA|K |CLASE K|RODANTE|SATELITAL|CARRETA',
    tipoUso: 'empresa',
  },
  {
    id: 'empresa_por_peso',
    // 10, 15, 20, 30, 50, 100, 150 lb — todo lo que no es portátil de carro
    patron: '\\b(10|15|20|25|30|50|75|100|125|150)\\s*(LB|LBS|LIBRAS?|KG|KILOS?)\\b',
    tipoUso: 'empresa',
  },
  {
    id: 'vehicular_por_peso',
    patron: '\\b(2|2\\.5|3|4|5)\\s*(LB|LBS|LIBRAS?|KG|KILOS?)\\b',
    tipoUso: 'vehicular',
  },
];

const PERFILES_DESENLACE = {
  vehicular: {
    tipoUso: 'vehicular',
    requiereAgendamiento: false,
    desenlace: 'mostrador',
    guionTipo: 'corto_mostrador',
    minutosEstimados: 1.2,
  },
  empresa: {
    tipoUso: 'empresa',
    requiereAgendamiento: true,
    desenlace: 'preorden_tecnico',
    guionTipo: 'largo_agendamiento',
    minutosEstimados: 2.5,
  },
};

const clasificarActivo = (descripcionEquipo, reglasTenant = null) => {
  const texto = String(descripcionEquipo || '').toUpperCase();
  const reglas = Array.isArray(reglasTenant) && reglasTenant.length
    ? reglasTenant
    : REGLAS_CLASIFICACION_DEFAULT;

  for (const regla of reglas) {
    try {
      if (new RegExp(regla.patron, 'i').test(texto)) {
        return { ...PERFILES_DESENLACE[regla.tipoUso], reglaAplicada: regla.id };
      }
    } catch {
      // Una regla mal escrita por un suscriptor no puede tumbar el motor.
      console.warn('[LLAMADAS-IA] Regla de clasificación inválida — omitida:', regla.id);
    }
  }
  // Sin match: se asume EMPRESA (el caso caro). Es el fallback seguro: mejor
  // agendar de más que mandar a alguien al mostrador cuando necesita técnico.
  return { ...PERFILES_DESENLACE.empresa, reglaAplicada: 'fallback_empresa' };
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ SEDE DEL SUSCRIPTOR — LUCY-SEDE-001
// ─────────────────────────────────────────────────────────────────────────────
// La sede YA EXISTE en el sistema: es la colección `companies` (Sur / Valle /
// Cúcuta), y clientes y vencimientos ya guardan `empresaId`. No se crea una
// entidad nueva — se conecta la que ya está.
//
// REGLA CRÍTICA: si no hay dirección de sede, Lucy NO da una dirección
// inventada. Una dirección equivocada dicha por teléfono cuesta el cliente y
// obliga a rellamar (minutos ya pagados). En ese caso el guion cambia a
// "un asesor le confirma la dirección".
// ═════════════════════════════════════════════════════════════════════════════
const HORARIO_FALLBACK = 'lunes a viernes de 8:00 a.m. a 5:30 p.m. y sábados de 8:00 a.m. a 12:00 m.';

// ✅ LUCY-SINSEDE-008: celular que el suscriptor registró en su perfil. Es el
// contacto que Lucy da cuando la sede no tiene teléfono propio o dirección.
const telefonoContactoTenant = (u) => {
  const d = u || {};
  return String(d.celular || d.telefono || d.phone || d.whatsapp || '').trim();
};

const obtenerSede = async (adminId, empresaId, cacheSedes) => {
  const clave = empresaId || '__principal__';
  if (cacheSedes.has(clave)) return cacheSedes.get(clave);

  let sede = null;

  if (empresaId) {
    const doc = await db.collection('companies').doc(empresaId).get();
    // Ownership multi-tenant: una sede de otro suscriptor jamás se usa.
    if (doc.exists && doc.data().user_id === adminId) sede = { id: doc.id, ...doc.data() };
  }

  // ✅ SEDE-PRINCIPAL-001: sin empresaId asignado → la sede marcada como
  // PRINCIPAL por el suscriptor. Antes se tomaba "la primera que devuelva la
  // base de datos", un orden arbitrario que podía hacer que Lucy dictara la
  // dirección de otra ciudad a un cliente importado sin empresa.
  // Si no hay ninguna marcada, `sede` queda null y el motor NO llama.
  if (!sede) {
    const snap = await db.collection('companies')
      .where('user_id', '==', adminId)
      .where('esPrincipal', '==', true)
      .limit(1)
      .get();
    if (!snap.empty) sede = { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  // Qué número le decimos al cliente — lo elige el suscriptor por sede.
  const telefonoDeSede = (s) => {
    const preferido = s[s.telefonoPrincipal] || null;
    return preferido || s.phone || s.cellphone || s.whatsapp || '';
  };

  const resuelta = sede
    ? {
        // "completa" = Lucy puede dictar la dirección con confianza.
        completa:  !!(sede.address && String(sede.address).trim()),
        nombre:    sede.name || '',
        direccion: sede.address || '',
        ciudad:    sede.ciudad || '',
        telefono:  telefonoDeSede(sede),
        horario:   (sede.horarioAtencion && sede.horarioAtencion.trim()) || HORARIO_FALLBACK,
      }
    : { completa: false, nombre: '', direccion: '', ciudad: '', telefono: '', horario: HORARIO_FALLBACK };

  cacheSedes.set(clave, resuelta);
  return resuelta;
};

// ═════════════════════════════════════════════════════════════════════════════
// Activación por tenant — clave EXPLÍCITA en users.modulos (igual que 'qr':
// modulos === [] significa "todos" para el resto del sistema, pero NO aplica
// a módulos premium de activación uno-a-uno como este).
// ═════════════════════════════════════════════════════════════════════════════
const tenantTieneLucyActiva = async (adminId) => {
  const userDoc = await db.collection('users').doc(adminId).get();
  if (!userDoc.exists) return false;
  const modulos = userDoc.data().modulos || [];
  return modulos.includes('llamadas_ia');
};

// ═════════════════════════════════════════════════════════════════════════════
// Tope de minutos por tenant/mes — llamadas_ia_config/{adminId}
// { topeMinutosMes: number, consumo: { 'YYYY-MM': minutos } }
// El consumo lo alimenta procesarResultadoLlamada() con la duración real.
// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// ✅ FIX LUCY-CONSUMO-002 (2026-07-27) — CONSUMO CALCULADO, NO ACUMULADO
// ─────────────────────────────────────────────────────────────────────────────
// El contador `consumo` venía inflado por el bug de redondeo (cada llamada,
// aunque durara 3 segundos, sumaba 1 minuto). Corregir la fórmula no arregla
// los datos ya escritos: el panel seguía mostrando 213 minutos cuando el
// proveedor había cobrado ~31.
//
// En vez de acumular un contador que puede desviarse —y que después hay que
// migrar a mano—, el consumo se CALCULA sobre la fuente de la verdad: la
// duración real que el webhook guardó en cada registro de `llamadas_ia`.
//
// Ventajas: se autocorrige solo, no necesita migración, y si mañana hay que
// recalcular un mes cerrado los datos siguen ahí. Las llamadas de prueba no
// cuentan, porque no se le facturan al suscriptor.
// ═════════════════════════════════════════════════════════════════════════════
const calcularSegundosDelMes = async (adminId, mes) => {
  try {
    const snap = await db.collection('llamadas_ia')
      .where('adminId', '==', adminId)
      .limit(5000)
      .get();

    let segundos = 0;
    snap.docs.forEach(d => {
      const l = d.data();
      if (l.esPrueba) return;                 // las pruebas no se facturan
      if (!l.duracionSegundos) return;        // sin duración = nunca conectó
      const fecha = l.createdAt?.toDate?.();
      if (!fecha) return;
      // Mes en hora Colombia, mismo criterio que el resto del servicio
      const mesLlamada = new Date(fecha.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
      if (mesLlamada === mes) segundos += Number(l.duracionSegundos) || 0;
    });
    return segundos;
  } catch (e) {
    console.error('[LLAMADAS-IA] Error calculando consumo del mes:', e.message);
    return null; // null = no se pudo calcular; se usa el contador como respaldo
  }
};

const obtenerConfigTenant = async (adminId) => {
  const doc = await db.collection('llamadas_ia_config').doc(adminId).get();
  const data = doc.exists ? doc.data() : {};
  const mes = mesActualColombia();

  // Fuente de la verdad: la duración real de cada llamada. Si el cálculo falla
  // (p. ej. problema de red con Firestore) se cae al contador acumulado para no
  // dejar el módulo sin tope, que sería peor.
  const segundosCalculados = await calcularSegundosDelMes(adminId, mes);
  const segundosMes = segundosCalculados !== null
    ? segundosCalculados
    : (Number(data.consumoSegundos?.[mes]) || 0);

  const minutosMes = Math.ceil(segundosMes / 60);

  return {
    topeMinutosMes: Number(data.topeMinutosMes) || TOPE_MINUTOS_DEFAULT,
    minutosConsumidosMes: minutosMes,
    segundosConsumidosMes: segundosMes,
    // ✅ LUCY-CAPACIDAD-001: intentos por cliente/mes configurables por tenant.
    // Antes estaba quemado en 2 dentro del motor.
    maxIntentos: Number(data.maxIntentos) || MAX_INTENTOS_DEFAULT,
    // ✅ LUCY-SINSEDE-008: llamar aunque la sede no tenga dirección (Lucy no
    // dicta dirección; da el nombre y el celular de la empresa). Por defecto SÍ.
    // Para volver a la regla estricta de SEDE-PRINCIPAL-001: llamarSinDireccion=false.
    llamarSinDireccion: data.llamarSinDireccion !== false,
    // ✅ LUCY-TIMBRE-006: segundos de timbre antes de colgar (≈6 s por timbre).
    segundosTimbre: Math.min(SEGUNDOS_TIMBRE_MAX, Math.max(SEGUNDOS_TIMBRE_MIN,
      Number(data.segundosTimbre) || SEGUNDOS_TIMBRE_DEFAULT)),
    // ✅ LUCY-PRIORIDAD-001: a partir de cuántos equipos por vencer un cliente
    // se considera prioritario y NO espera a que Lucy agote sus intentos.
    // 0 desactiva la regla (todos siguen el flujo normal de Lucy).
    umbralPrioridadEquipos: Number.isFinite(Number(data.umbralPrioridadEquipos))
      ? Number(data.umbralPrioridadEquipos)
      : UMBRAL_PRIORIDAD_DEFAULT,
    // Ruleset de clasificación propio del suscriptor (opcional). Si no lo tiene,
    // se usa el de extintores por defecto.
    reglasClasificacion: Array.isArray(data.reglasClasificacion) ? data.reglasClasificacion : null,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-PRIORIDAD-001 — ¿este cliente merece pasar ya a un humano?
// ─────────────────────────────────────────────────────────────────────────────
// Criterio: total de equipos pendientes de recarga. Es la señal más limpia que
// tenemos del valor del cliente y no exige clasificarlos a mano.
// Solo lectura, siempre filtrado por adminId. Si falla, devuelve false: ante la
// duda el cliente sigue el flujo normal de Lucy (nunca se pierde, solo espera).
//
// Se declara AQUÍ, antes de procesarWebhook, y no más abajo: la regla del
// proyecto tras el bug de Temporal Dead Zone de LUCY-ELEVEN-001b es que nada
// se use antes de su declaración, aunque la llamada sea diferida.
// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-HUERFANOS-003 — Lucy no puede llamar → que lo vea un humano YA
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA QUE RESUELVE: `escaladoTelemercadeo` solo se escribía en el webhook,
// o sea DESPUÉS de una llamada. Cuando el motor descartaba un vencimiento sin
// poder llamarlo (sin teléfono, cliente borrado, sin sede), no había webhook y
// el vencimiento quedaba invisible para siempre: ni Lucy lo trabajaba ni el
// asesor lo veía en Telemercadeo. Plata perdida en silencio.
//
// Lucy filtra y adelanta trabajo, pero NUNCA puede retener un vencimiento que
// ella misma no es capaz de gestionar.
// ═════════════════════════════════════════════════════════════════════════════
const escalarPorqueLucyNoPuede = async (vencimientoId, motivo) => {
  try {
    if (!vencimientoId) return;
    await db.collection('vencimientos').doc(vencimientoId).update({
      escaladoTelemercadeo: true,
      estadoCiclo: 'EN_TELEMERCADEO',
      motivoEscalamiento: `lucy_no_puede_${motivo}`,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[LLAMADAS-IA] LUCY-HUERFANOS-003: vencimiento ${vencimientoId} escalado a telemercadeo (${motivo})`);
  } catch (e) {
    console.error('[LLAMADAS-IA] LUCY-HUERFANOS-003 falló:', e.message);
  }
};

const esClientePrioritario = async (adminId, clienteId, umbral) => {
  try {
    const min = Number.isFinite(Number(umbral)) ? Number(umbral) : UMBRAL_PRIORIDAD_DEFAULT;
    if (min <= 0) return false; // regla desactivada para este tenant
    if (!adminId || !clienteId) return false;

    const snap = await db.collection('vencimientos')
      .where('adminId', '==', adminId)
      .where('clienteId', '==', clienteId)
      .limit(200)
      .get();

    let equipos = 0;
    snap.forEach(d => {
      const v = d.data();
      if (v.gestionado) return;
      equipos += Number(v.cantidad) || 1;
    });

    return equipos >= min;
  } catch (e) {
    console.error('[LLAMADAS-IA] LUCY-PRIORIDAD-001 falló:', e.message);
    return false;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ FIX LUCY-CONSUMO-001 (2026-07-27) — CONTABILIDAD REAL DE MINUTOS
// ─────────────────────────────────────────────────────────────────────────────
// BUG: se acumulaba Math.ceil(segundos/60) POR LLAMADA. Una llamada de 3
// segundos que nadie contestó se registraba como 1 minuto completo. Con 247
// llamadas sin respuesta en un mes, eso inflaba el consumo en 247 minutos
// inexistentes: el panel mostraba 213 min cuando el proveedor había cobrado 31.
//
// POR QUÉ IMPORTA: este número es la base para cobrarle el módulo al
// suscriptor. Redondear hacia arriba en cada llamada multiplicaba la factura
// por ~7. Un error de facturación contra un cliente es mucho más grave que un
// error de reporte.
//
// AHORA: se acumulan SEGUNDOS reales y el redondeo se hace UNA sola vez, al
// mostrar el total del mes. Se conserva `consumo` (minutos) para no romper el
// histórico existente, pero manda `consumoSegundos` cuando está presente.
// ═════════════════════════════════════════════════════════════════════════════
const registrarConsumoMinutos = async (adminId, segundos) => {
  if (!adminId || !segundos) return;
  const mes = mesActualColombia();
  await db.collection('llamadas_ia_config').doc(adminId).set({
    consumoSegundos: { [mes]: admin.firestore.FieldValue.increment(Math.round(segundos)) },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
};

// ═════════════════════════════════════════════════════════════════════════════
// Variables dinámicas del agente ElevenLabs.
// NOMENCLATURA ALINEADA con el guion del agente (panel ElevenLabs):
//   nombre_empresa   → empresa del TENANT (quien llama)
//   nombre_cliente   → persona a la que Lucy saluda
//   empresa_cliente  → razón social del CLIENTE
//   direccion_cliente / telefono_cliente → para CONFIRMAR datos de la
//   orden en la llamada (no preguntarlos desde cero) — pedido de Sandra.
//
// El PRECIO no se precalcula: Lucy usa la Tool consultar_precio en vivo
// (matching por palabras clave del lado del servidor — "Recarga ABC 5lbs"
// y "Extintor ABC 5lbs" son productos distintos).
// Lucy NUNCA crea la orden: registra el cierre y un humano la crea.
// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-V2-009: dirección DEL CLIENTE (no de la empresa). La ficha del cliente
// la guarda en `direccionPrincipal` o dentro de la sucursal del vencimiento;
// antes se leía `cliente.direccion`, que no existe, y Lucy siempre decía
// "no registrada". Orden: sucursal del vencimiento → principal → legado.
const direccionDelCliente = (cliente, vencimiento) => {
  const suc = String(vencimiento?.sucursal || '').trim().toUpperCase();
  if (suc && Array.isArray(cliente.sucursales)) {
    const s = cliente.sucursales.find(x => String(x.nombre || '').trim().toUpperCase() === suc);
    if (s && String(s.direccion || '').trim()) return String(s.direccion).trim();
  }
  return String(cliente.direccionPrincipal || cliente.direccion || '').trim();
};

const construirVariablesLlamada = ({ adminId, registroId, cliente, vencimiento, tenantInfo, sede, perfil }) => {
  // ✅ LUCY-SEDE-001: la dirección/horario/teléfono que dice Lucy salen de la
  // SEDE del cliente (companies), no de un texto fijo del tenant.
  const sedeSegura = sede || { completa: false, direccion: '', ciudad: '', telefono: '', horario: HORARIO_FALLBACK };
  const perfilSeguro = perfil || PERFILES_DESENLACE.empresa;

  return {
    adminId:            String(adminId),
    registroId:         String(registroId),
    nombre_empresa:     tenantInfo.nombre || 'nuestra empresa',
    // ✅ FIX LUCY-CONTACTO-001: si hay persona de contacto, saluda por nombre propio
    nombre_cliente:     cliente.contacto ? String(cliente.contacto).trim() : primerNombre(cliente.nombre),
    empresa_cliente:    cliente.nombre || '',
    equipos:            vencimiento.descripcionEquipo || 'su extintor',
    direccion_cliente:  direccionDelCliente(cliente, vencimiento) || 'no registrada',
    // ✅ LUCY-V2-009: datos que Lucy CONFIRMA (no pregunta) si el cliente pide domicilio.
    nit_cliente:        String(cliente.nit || '').trim() || 'no registrado',
    cantidad_equipos:   String(Number(vencimiento.cantidad) || 1),
    telefono_cliente:   String(vencimiento.telefono || cliente.celular || cliente.telefono || ''),
    tipo_servicio:      cliente.tipoServicioHistorico || 'oficina',
    valor_domicilio:    tenantInfo.valorDomicilio || 'según su sector',
    mes_vencimiento:    vencimiento.fechaVencimiento || '',
    medios_pago:        tenantInfo.mediosPago || 'efectivo, transferencia y Nequi',

    // ── Datos de la SEDE que atiende a este cliente ──────────────────────────
    // ✅ LUCY-SINSEDE-008: con sede incompleta NO se entrega ninguna dirección
    // (ni la del perfil del tenant: un suscriptor con varias ciudades dictaría
    // la equivocada). Solo nombre de empresa y celular de contacto.
    direccion_empresa:  sedeSegura.completa ? (sedeSegura.direccion || tenantInfo.direccion || '') : '',
    ciudad_empresa:     sedeSegura.ciudad    || tenantInfo.ciudad    || '',
    horario_empresa:    sedeSegura.horario   || HORARIO_FALLBACK,
    telefono_empresa:   sedeSegura.telefono  || tenantInfo.telefono || '',   // ✅ LUCY-SINSEDE-008: respaldo = celular del perfil
    nombre_sede:        sedeSegura.nombre    || '',
    // Bandera para el guion: si es "no", Lucy NO dicta dirección y remite a un
    // asesor. Nunca inventa una sede.
    sede_confirmada:    sedeSegura.completa ? 'si' : 'no',

    // ── Ruta del guion según el tipo de activo (LUCY-CAPACIDAD-001) ──────────
    // El agente de ElevenLabs ramifica con estas variables: guion corto de
    // mostrador (~1 min) vs. guion largo con agendamiento de técnico (~2.5 min).
    // Menos turnos de conversación = menos latencia percibida.
    tipo_uso:               perfilSeguro.tipoUso,               // 'vehicular' | 'empresa'
    requiere_agendamiento:  perfilSeguro.requiereAgendamiento ? 'si' : 'no',
    guion_tipo:             perfilSeguro.guionTipo,             // 'corto_mostrador' | 'largo_agendamiento'
    desenlace_esperado:     perfilSeguro.desenlace,             // 'mostrador' | 'preorden_tecnico'
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// Lanza UNA llamada saliente vía ElevenLabs Agents (número Twilio importado)
// Devuelve { ok, conversationId, error? }
// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-TIMBRE-006: `telephony_call_config.ringing_timeout_secs` le dice al
// proveedor cuánto dejar sonar antes de rendirse (por defecto 60 s).
//
// REPLIEGUE DEFENSIVO: si esa opción no estuviera disponible en la cuenta o
// cambiara de nombre, el proveedor responde 4xx y NO se lanzaría ni una sola
// llamada — una corrida entera perdida por un campo opcional. El primer
// rechazo QUE SEA DEL CAMPO reintenta sin él y apaga el timbre por el resto
// de la corrida, para no pagar dos peticiones por cada número.
//
// OJO CON EL FALSO POSITIVO: un número inválido también devuelve 4xx. Si se
// tratara cualquier error como "campo no soportado", un solo teléfono malo
// dejaría sin timbre a toda la corrida. Por eso se exige que el mensaje hable
// del campo. La bandera se reinicia en cada corrida (ver ejecutarMotorLlamadas):
// un rechazo de hoy no puede apagar la función para siempre.
let _timbreNoSoportado = false;

const _reiniciarRepliegueTimbre = () => { _timbreNoSoportado = false; };

// ¿El rechazo es POR EL CAMPO del timbre, o por otra cosa (número inválido,
// saldo, agente mal configurado)? Solo el primero justifica reintentar.
const _rechazoEsPorElTimbre = (status, mensaje) => {
  if (status !== 400 && status !== 422) return false;
  const m = String(mensaje || '').toLowerCase();
  return /telephony_call_config|ringing_timeout|unknown field|unexpected field|extra fields|additional propert|not permitted|unrecognized/.test(m);
};

const _postLlamadaElevenLabs = async (cuerpo) => {
  const resp = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  });
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
};

const lanzarLlamadaElevenLabs = async ({ telefono, variables, segundosTimbre = null }) => {
  try {
    if (!ELEVEN_API_KEY || !ELEVEN_AGENT_ID || !ELEVEN_PHONE_ID) {
      return { ok: false, error: 'Faltan variables ELEVENLABS_* en el entorno (Railway)' };
    }

    const base = {
      agent_id: ELEVEN_AGENT_ID,
      agent_phone_number_id: ELEVEN_PHONE_ID,
      to_number: telefono,
      conversation_initiation_client_data: {
        dynamic_variables: variables, // adminId/registroId incluidos — vuelven en el webhook
      },
    };

    const conTimbre = Number(segundosTimbre) > 0 && !_timbreNoSoportado;
    const cuerpo = conTimbre
      ? { ...base, telephony_call_config: { ringing_timeout_secs: Math.round(Number(segundosTimbre)) } }
      : base;

    let { resp, data } = await _postLlamadaElevenLabs(cuerpo);

    if ((!resp.ok || data.success === false) && conTimbre) {
      const mensaje = data?.detail?.message || data?.message || JSON.stringify(data?.detail || data || '');
      if (_rechazoEsPorElTimbre(resp.status, mensaje)) {
        _timbreNoSoportado = true;
        console.warn('[LLAMADAS-IA] LUCY-TIMBRE-006: el proveedor rechazó ringing_timeout_secs — se reintenta sin el campo y se apaga el timbre por esta corrida:', mensaje);
        ({ resp, data } = await _postLlamadaElevenLabs(base));
      }
      // Si el rechazo NO es del campo (número inválido, etc.) se devuelve el
      // error tal cual: reintentar sin timbre fallaría igual y gastaría otra
      // petición por cada número malo de la base.
    }

    if (!resp.ok || data.success === false) {
      return { ok: false, error: data?.detail?.message || data?.message || `HTTP ${resp.status}` };
    }
    return { ok: true, conversationId: data.conversation_id || data.callSid || null, timbreAplicado: conTimbre && !_timbreNoSoportado };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-ASINCRONO-001 (2026-07-26) — ESTADO DE LA CORRIDA
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA: el motor lanza las llamadas con pausas para respetar el límite de
// llamadas simultáneas del plan. Una base de 120 clientes tarda ~40 minutos.
// La ruta /ejecutar-motor esperaba a que TERMINARA para responder — ninguna
// petición HTTP sobrevive eso: el panel mostraba error aunque Lucy estuviera
// llamando perfectamente, y el resumen de diagnóstico se perdía.
//
// SOLUCIÓN: la corrida se ejecuta en segundo plano y su estado vive en
// `llamadas_ia_corridas/{adminId}`. El panel lo consulta y muestra el avance
// en vivo. Un solo documento por tenant: siempre la última corrida.
// ═════════════════════════════════════════════════════════════════════════════
const guardarCorrida = async (adminId, datos) => {
  try {
    await db.collection('llamadas_ia_corridas').doc(adminId).set({
      ...datos,
      adminId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.error('[LLAMADAS-IA] No se pudo guardar el estado de la corrida:', e.message);
  }
};

const obtenerUltimaCorrida = async (adminId) => {
  const doc = await db.collection('llamadas_ia_corridas').doc(adminId).get();
  return doc.exists ? doc.data() : null;
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-PARADA-001 (2026-07-27) — FRENO DE LA CORRIDA
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA REAL (Sandra, 27-jul): una corrida de 478 llamadas arrancó y NO HABÍA
// FORMA DE DETENERLA. El panel decía "puedes cerrar esta pantalla, la corrida
// sigue" — literalmente cierto: el motor vive en el proceso del backend, cerrar
// el navegador no lo toca. La única salida era apagar el agente de ElevenLabs o
// quedarse sin saldo Twilio. Operar un marcador automático sin apagado es un
// riesgo operativo y legal (Ley 2300: no se puede llamar fuera de horario).
//
// POR QUÉ UNA SEÑAL EN FIRESTORE Y NO UNA VARIABLE EN MEMORIA:
// el backend puede correr con más de una instancia (Railway reinicia, escala).
// Una bandera en memoria solo la vería el proceso que la escribió, y el botón
// fallaría justo cuando más se necesita. La señal vive en el mismo documento
// que ya usa el panel: una lectura por llamada, ~1 KB, ritmo de 3 por minuto.
//
// DOS MODOS, PORQUE NO SON LO MISMO:
//   · pausar   → guarda los vencimientos que faltan. "Continuar" retoma EXACTO
//                donde quedó, sin volver a llamar a quien ya recibió llamada.
//   · cancelar → descarta la cola. Los vencimientos quedan sin gestionar y
//                entran normalmente en la siguiente corrida.
//
// REGLA CRÍTICA: la señal se lee ANTES DE CADA LLAMADA, no al inicio del lote.
// Si se leyera por lote, el botón tardaría hasta un minuto en surtir efecto y
// dejaría salir 3 llamadas más — que es justo lo que se quiere evitar.
// ═════════════════════════════════════════════════════════════════════════════
const SENALES_VALIDAS = ['pausar', 'cancelar'];

// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-PARADA-002 (2026-07-27) — CORRIDAS HUÉRFANAS
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA DETECTADO EN LA PRIMERA PRUEBA: el motor vive en la memoria del
// proceso de Node. Cuando Railway redespliega o reinicia, el bucle MUERE, pero
// el documento de la corrida queda escrito como 'en_curso' para siempre. Se
// pulsó Pausar y el panel quedó en "Deteniendo…" eternamente: nadie iba a leer
// la señal. Peor, ese registro fantasma bloquea "Lanzar ahora" con 409.
//
// SOLUCIÓN: LATIDO. El motor sella `latidoAt` mientras avanza. Si el latido
// está frío, la corrida se da por muerta y el estado se corrige AL INSTANTE en
// vez de dejar una señal que nadie consumirá.
//
// Por qué 3 minutos: entre llamada y llamada el motor pausa hasta 60 s por el
// límite de concurrencia del plan. 3 min = 3 ciclos perdidos, margen suficiente
// para no declarar muerta una corrida que solo está esperando su turno.
// ═════════════════════════════════════════════════════════════════════════════
const LATIDO_FRIO_MS = 3 * 60 * 1000;

const corridaEstaViva = (corrida) => {
  if (!corrida || corrida.estado !== 'en_curso') return false;
  const ref = corrida.latidoAt || corrida.reanudadaAt || corrida.iniciadaAt;
  if (!ref) return false; // 'en_curso' sin marca de tiempo = registro viejo, muerto
  const edad = Date.now() - new Date(ref).getTime();
  return Number.isFinite(edad) && edad < LATIDO_FRIO_MS;
};

const solicitarControlCorrida = async (adminId, senal) => {
  if (!SENALES_VALIDAS.includes(senal)) {
    return { ok: false, error: 'Señal inválida' };
  }
  const corrida = await obtenerUltimaCorrida(adminId);
  if (!corrida || corrida.estado !== 'en_curso') {
    return { ok: false, error: 'No hay ninguna corrida en curso' };
  }

  // ✅ LUCY-PARADA-002: corrida muerta (reinicio del backend) — se cierra ya.
  // No se deja señal: no hay proceso que pueda leerla.
  if (!corridaEstaViva(corrida)) {
    await guardarCorrida(adminId, {
      estado: 'cancelada',
      senalControl: null,
      pendientes: [],
      pendientesCount: 0,
      llamandoAhora: null,
      clienteAhora: null,
      detenidaAt: new Date().toISOString(),
      motivoCierre: 'huerfana_backend_reiniciado',
    });
    return { ok: true, senal, huerfana: true };
  }

  await guardarCorrida(adminId, {
    senalControl: senal,
    senalSolicitadaAt: new Date().toISOString(),
  });
  return { ok: true, senal };
};

// Lectura de la señal. Si Firestore falla NO se detiene la corrida: un error de
// red no puede cancelar llamadas que el suscriptor sí quiere hacer.
const leerSenalControl = async (adminId) => {
  try {
    const doc = await db.collection('llamadas_ia_corridas').doc(adminId).get();
    const senal = doc.exists ? doc.data().senalControl : null;
    return SENALES_VALIDAS.includes(senal) ? senal : null;
  } catch (e) {
    console.error('[LLAMADAS-IA] No se pudo leer la señal de control:', e.message);
    return null;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ✅ LUCY-LECTURAS-007 (2026-09-22) — intentos del mes en UNA consulta
// ─────────────────────────────────────────────────────────────────────────────
// ANTES: dentro del bucle, por CADA vencimiento, una consulta a `llamadas_ia`
// para contar los intentos de ese cliente. Con 589 vencimientos eran 589
// consultas por corrida. Además impedía ordenar la cola: para saber quién ya
// tenía llamadas había que estar dentro del bucle, o sea demasiado tarde.
//
// AHORA: una sola consulta por tenant devuelve las llamadas del mes y se arma
// un mapa `clienteId|fechaVencimiento → { intentos, final }`. La clave incluye
// la FECHA exacta, no el mes, para conservar la semántica anterior: dos
// vencimientos del mismo cliente en fechas distintas cuentan por separado.
//
// ÍNDICE: la consulta combina igualdad (adminId) con rango (mesVencimiento) y
// necesita el índice compuesto `llamadas_ia: adminId ASC + mesVencimiento ASC`.
// Si no existe, Firestore rechaza la consulta: se devuelve `null` y el motor
// vuelve solo al camino anterior (una consulta por cliente). Lucy nunca se
// queda sin llamar por un índice que falte.
// ═════════════════════════════════════════════════════════════════════════════
const RESULTADOS_FINALES = ['cerrada', 'reagendada', 'inactivo_cliente', 'escalado_asesor', 'no_interesado'];

const claveIntento = (clienteId, fechaVencimiento) => `${clienteId}|${fechaVencimiento}`;

const construirMapaIntentos = async (adminId, mes) => {
  try {
    const snap = await db.collection('llamadas_ia')
      .where('adminId', '==', adminId)
      .where('mesVencimiento', '>=', `${mes}-01`)
      .where('mesVencimiento', '<=', `${mes}-31`)
      .get();

    const mapa = new Map();
    snap.forEach(doc => {
      const l = doc.data() || {};
      if (l.esPrueba === true) return; // una llamada de prueba no gasta intentos
      if (!l.clienteId || !l.mesVencimiento) return;
      const k = claveIntento(l.clienteId, l.mesVencimiento);
      const actual = mapa.get(k) || { intentos: 0, final: false };
      actual.intentos += 1;
      if (RESULTADOS_FINALES.includes(l.resultado)) actual.final = true;
      mapa.set(k, actual);
    });
    console.log(`[LLAMADAS-IA] LUCY-LECTURAS-007: ${snap.size} llamada(s) del mes ${mes} leídas en 1 consulta (tenant ${adminId})`);
    return mapa;
  } catch (e) {
    console.warn(`[LLAMADAS-IA] LUCY-LECTURAS-007: no se pudo leer el mapa de intentos (${e.message}). Se usa el camino anterior, una consulta por cliente. Crea el índice compuesto llamadas_ia: adminId ASC + mesVencimiento ASC.`);
    return null;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// opciones:
//   soloAdminId    → limita la corrida a UN tenant (manual/programada). El cron
//                    no lo pasa y recorre todos los tenants ACTIVOS.
//   ignorarHorario → true en corridas manuales/programadas (el humano eligió
//                    el momento); el cron respeta la ventana L-V 8-18 / S 9-12.
// ═════════════════════════════════════════════════════════════════════════════
const ejecutarMotorLlamadas = async (opciones = {}) => {
  // ✅ LUCY-PARADA-001: soloVencimientoIds llega solo al REANUDAR una corrida
  // pausada — limita el motor a los vencimientos que quedaron en cola.
  // ✅ LUCY-MES-004: `mes` ("YYYY-MM") elige QUÉ mes se llama. Por defecto el
  //    actual, que es lo que hacía siempre. Sirve para recuperar un mes que se
  //    quedó atrás sin esperar al cron.
  // ✅ LUCY-PAQUETE-005: `maxLlamadas` corta la corrida al llegar a ese número
  //    de llamadas LANZADAS (no evaluadas) en el tenant.
  const {
    soloAdminId = null,
    ignorarHorario = false,
    soloVencimientoIds = null,
    mes = null,
    maxLlamadas = null,
  } = opciones;

  const mesObjetivo = esMesValido(mes) ? mes : mesActualColombia();
  const topePaquete = Number.isFinite(Number(maxLlamadas)) && Number(maxLlamadas) > 0
    ? Math.min(MAX_LLAMADAS_TOPE, Math.floor(Number(maxLlamadas)))
    : null;

  _reiniciarRepliegueTimbre();   // ✅ LUCY-TIMBRE-006: cada corrida vuelve a intentarlo

  console.log(`[LLAMADAS-IA] Motor — mes ${mesObjetivo}${topePaquete ? ` — paquete de ${topePaquete}` : ' — sin tope de paquete'}${soloAdminId ? ` — SOLO tenant ${soloAdminId}` : ' — todos los tenants activos'}`);

  try {
    // 1) Vencimientos del MES OBJETIVO no gestionados
    let vencQuery = db.collection('vencimientos')
      .where('fechaVencimiento', '>=', `${mesObjetivo}-01`)
      .where('fechaVencimiento', '<=', `${mesObjetivo}-31`)
      .where('gestionado', '==', false);
    // ✅ FIX LUCY-ELEVEN-001c: si la corrida es de un solo tenant, se filtra
    // desde la consulta — imposible tocar vencimientos de otros suscriptores.
    if (soloAdminId) vencQuery = vencQuery.where('adminId', '==', soloAdminId);

    const vencSnap = await vencQuery.get();
    if (vencSnap.empty) {
      console.log('[LLAMADAS-IA] Sin vencimientos para procesar');
      return { tenantsProcesados: 0, llamadasLanzadas: 0, omitidasPorTope: 0 };
    }

    // 2) Agrupar por tenant
    // ✅ LUCY-PARADA-001: al reanudar, solo entran los vencimientos que
    // quedaron pendientes cuando se pausó. El filtro se aplica aquí y no en la
    // consulta porque Firestore limita los `in` a 30 elementos.
    const setPendientes = Array.isArray(soloVencimientoIds) && soloVencimientoIds.length
      ? new Set(soloVencimientoIds)
      : null;

    const porTenant = {};
    vencSnap.docs.forEach(doc => {
      const d = doc.data();
      if (!d.adminId || !d.clienteId) return;
      if (setPendientes && !setPendientes.has(doc.id)) return;
      if (!porTenant[d.adminId]) porTenant[d.adminId] = [];
      porTenant[d.adminId].push({ id: doc.id, ...d });
    });

    let totalLanzadas = 0;
    let tenantsProcesados = 0;
    let omitidasPorTope = 0;
    // ✅ LUCY-PARADA-001: queda { senal, pendientes } si el usuario frenó.
    let detencion = null;
    // ✅ LUCY-PARADA-002: sello de vida del motor (ver corridaEstaViva).
    let ultimoLatidoAt = 0;
    // ✅ LUCY-DIAGNOSTICO-002: antes, cuando no salía ninguna llamada, el panel
    // solo podía decir "0 llamadas" o "omitidas por tope". Ahora se cuenta el
    // MOTIVO real de cada omisión y llega a pantalla.
    const motivos = {
      sin_telefono: 0,
      ya_gestionado: 0,
      intentos_agotados: 0,
      cliente_inexistente: 0,
      fuera_de_horario: 0,
      fallo_proveedor: 0,
      sin_sede: 0, // ✅ SEDE-PRINCIPAL-001
      llamada_sin_direccion: 0, // ✅ LUCY-SINSEDE-008: llamadas lanzadas sin dirección de sede
    };

    for (const [adminId, vencimientos] of Object.entries(porTenant)) {
      // 3) Activación manual por Sandra — sin la clave, el tenant no suena
      const activa = await tenantTieneLucyActiva(adminId);
      if (!activa) continue;

      tenantsProcesados++;

      // 3b) ✅ FIX LUCY-ELEVEN-001d: tope de minutos del tenant este mes
      const config = await obtenerConfigTenant(adminId);
      let minutosDisponibles = config.topeMinutosMes - config.minutosConsumidosMes;
      if (minutosDisponibles <= 0) {
        console.warn(`[LLAMADAS-IA] Tenant ${adminId} alcanzó su tope de ${config.topeMinutosMes} min — omitido`);
        omitidasPorTope += vencimientos.length;
        continue;
      }

      const userDoc = await db.collection('users').doc(adminId).get();
      const tenantInfo = {
        nombre:    userDoc.exists ? (userDoc.data().empresa || userDoc.data().nombre) : 'Control360',
        direccion: userDoc.exists ? userDoc.data().direccion : '',
        ciudad:    userDoc.exists ? userDoc.data().ciudad : '',
        telefono:  userDoc.exists ? telefonoContactoTenant(userDoc.data()) : '',   // ✅ LUCY-SINSEDE-008
      };

      // ✅ LUCY-LECTURAS-007 + LUCY-PAQUETE-005 — ORDEN DE LA COLA
      // ─────────────────────────────────────────────────────────────────────
      // El problema que esto resuelve: la consulta de vencimientos no tiene
      // `orderBy`, así que Firestore devolvía SIEMPRE el mismo orden. Cuando la
      // corrida se cortaba (tope de minutos, pausa, reinicio), la siguiente
      // arrancaba desde el primero y gastaba el intento 2 en los mismos de
      // arriba; los del final nunca recibían ni el primero.
      //
      // Orden decidido con Sandra: primero quien NUNCA ha recibido llamada y,
      // entre ellos, el vencimiento más próximo. Así el paquete 2 continúa
      // donde quedó el 1 sin necesidad de guardar un cursor, que se pierde con
      // un reinicio. Se ordena en memoria: no hace falta índice nuevo.
      const mapaIntentos = await construirMapaIntentos(adminId, mesObjetivo);

      const intentosDe = (v) => {
        if (!mapaIntentos) return 0; // sin mapa no se puede ordenar por intentos
        return (mapaIntentos.get(claveIntento(v.clienteId, v.fechaVencimiento)) || {}).intentos || 0;
      };

      vencimientos.sort((a, b) => {
        const ia = intentosDe(a), ib = intentosDe(b);
        if (ia !== ib) return ia - ib;                                   // 0 intentos primero
        return String(a.fechaVencimiento || '').localeCompare(String(b.fechaVencimiento || '')); // vence antes, llama antes
      });

      if (topePaquete) {
        const nuncaLlamados = vencimientos.filter(v => intentosDe(v) === 0).length;
        console.log(`[LLAMADAS-IA] LUCY-PAQUETE-005: ${vencimientos.length} vencimiento(s) en cola (${nuncaLlamados} sin llamar) — se lanzarán máximo ${topePaquete}`);
      }

      // Cache de sedes por corrida — evita releer `companies` en cada llamada.
      const cacheSedes = new Map();
      let lanzadasEnLote = 0;
      let lanzadasTenant = 0;   // ✅ LUCY-PAQUETE-005

      for (let idx = 0; idx < vencimientos.length; idx++) {
        const venc = vencimientos[idx];

        // ✅ LUCY-PAQUETE-005 — PAQUETE COMPLETO
        // Cuenta llamadas LANZADAS, no evaluadas: los omitidos (sin teléfono,
        // ya gestionado, sin sede) no gastan cupo del paquete.
        if (topePaquete && lanzadasTenant >= topePaquete) {
          console.log(`[LLAMADAS-IA] LUCY-PAQUETE-005: paquete de ${topePaquete} completo — quedan ${vencimientos.length - idx} en cola para el siguiente`);
          break;
        }

        // ✅ LUCY-PARADA-001 — PUNTO DE CONTROL
        // Se consulta ANTES de marcar cada número. Solo aplica a corridas de un
        // tenant (manual o programada): el cron mensual global no se detiene
        // desde el panel de un suscriptor.
        if (soloAdminId) {
          // ✅ LUCY-PARADA-002: latido cada ~45 s (no en cada vuelta: serían
          // cientos de escrituras por corrida sin ganar nada).
          if (Date.now() - ultimoLatidoAt > 45000) {
            ultimoLatidoAt = Date.now();
            await guardarCorrida(adminId, { latidoAt: new Date().toISOString() });
          }

          const senal = await leerSenalControl(adminId);
          if (senal) {
            // Lo que aún no se ha marcado. Es lo que "Continuar" retoma.
            const pendientes = vencimientos.slice(idx).map(v => v.id);
            detencion = { senal, pendientes };
            console.log(`[LLAMADAS-IA] Corrida ${senal === 'pausar' ? 'PAUSADA' : 'CANCELADA'} por el usuario — ${pendientes.length} pendiente(s)`);
            break;
          }
        }

        try {
          if (minutosDisponibles <= 0) { omitidasPorTope++; continue; }

          // 4) Anti-duplicado + máximo de intentos
          // ✅ LUCY-LECTURAS-007: del mapa armado arriba (1 consulta por tenant).
          // Si el mapa no se pudo armar (índice ausente), se cae al camino
          // anterior: una consulta por cliente. Misma decisión, más lecturas.
          let intentosPrevios;
          let yaTieneResultadoFinal;

          if (mapaIntentos) {
            const reg = mapaIntentos.get(claveIntento(venc.clienteId, venc.fechaVencimiento)) || { intentos: 0, final: false };
            intentosPrevios = reg.intentos;
            yaTieneResultadoFinal = reg.final;
          } else {
            const existentesSnap = await db.collection('llamadas_ia')
              .where('adminId', '==', adminId)
              .where('clienteId', '==', venc.clienteId)
              .where('mesVencimiento', '==', venc.fechaVencimiento)
              .get();
            const previos = existentesSnap.docs.map(d => d.data()).filter(l => l.esPrueba !== true);
            intentosPrevios = previos.length;
            yaTieneResultadoFinal = previos.some(i => RESULTADOS_FINALES.includes(i.resultado));
          }

          if (yaTieneResultadoFinal) { motivos.ya_gestionado++; continue; }

          // ✅ LUCY-PRIORIDAD-001: si este vencimiento ya pasó a telemercadeo
          // POR PRIORIDAD, Lucy deja de llamarlo — lo tiene un asesor humano y
          // dos llamadas por el mismo tema molestan al cliente.
          // OJO: solo aplica al escalamiento por prioridad. Los escalados por
          // 'lucy_sin_contacto' ya quedaron fuera por intentos agotados, y los
          // de 'lucy_escalo' por tener resultado final.
          if (venc.escaladoTelemercadeo === true && venc.motivoEscalamiento === 'prioridad_alta') {
            motivos.ya_gestionado++;
            continue;
          }

          // ✅ LUCY-CAPACIDAD-001: intentos configurables (antes quemado en 2).
          const numeroIntento = intentosPrevios + 1;
          if (numeroIntento > config.maxIntentos) { motivos.intentos_agotados++; continue; }

          // 5) Cliente y teléfono
          const cliDoc = await db.collection('clients').doc(venc.clienteId).get();
          if (!cliDoc.exists) {
            motivos.cliente_inexistente++;
            await escalarPorqueLucyNoPuede(venc.id, 'cliente_inexistente');
            continue;
          }
          const cliente = cliDoc.data();
          const telefonoRaw = venc.telefono || cliente.celular || cliente.telefono;
          const telefono = normalizarParaLlamada(telefonoRaw);
          if (!telefono) {
            motivos.sin_telefono++;
            console.warn(`[LLAMADAS-IA] Cliente ${venc.clienteId} sin teléfono válido — omitido`);
            await escalarPorqueLucyNoPuede(venc.id, 'sin_telefono');
            continue;
          }

          // Ventana horaria (solo la respeta el cron — ver FIX LUCY-ELEVEN-001c)
          if (!ignorarHorario) {
            const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
            const diaSemana = ahoraCO.getUTCDay();
            const horaActual = ahoraCO.getUTCHours();
            const horarioValido =
              (diaSemana >= 1 && diaSemana <= 5 && horaActual >= 8 && horaActual < 18) ||
              (diaSemana === 6 && horaActual >= 9 && horaActual < 12);
            if (!horarioValido) {
              motivos.fuera_de_horario++;
              console.log('[LLAMADAS-IA] Fuera de horario permitido — el cron reintentará');
              continue;
            }
          }

          // ✅ LUCY-CAPACIDAD-001 / LUCY-SEDE-001: perfil del activo + sede que
          // atiende a este cliente. Ambos se resuelven ANTES de marcar, para que
          // Lucy no haga ninguna consulta durante la llamada (menos latencia).
          const perfil = clasificarActivo(venc.descripcionEquipo, config.reglasClasificacion);
          const sede = await obtenerSede(adminId, venc.empresaId || cliente.empresaId, cacheSedes);

          // ✅ SEDE-PRINCIPAL-001 — REGLA: sin dirección de sede, NO se llama.
          // Decisión de negocio de Sandra: una llamada con dirección equivocada
          // cuesta el cliente y obliga a rellamar (minutos ya pagados); una
          // llamada no hecha solo cuesta esperar. El vencimiento queda listado
          // con el motivo para que se corrija la ficha del cliente.
          // ✅ LUCY-SINSEDE-008 (decisión de Milena, 2026-10-07): se llama IGUAL
          // sin dirección. Lucy recuerda el vencimiento y da nombre + celular
          // de la empresa (sede_confirmada='no' → guion sin dirección). Solo se
          // omite si el suscriptor apagó la opción o no hay NINGÚN celular de
          // contacto que dar: llamar sin poder decir cómo contactarnos no sirve.
          if (!sede.completa) {
            const contacto = sede.telefono || tenantInfo.telefono;
            if (!config.llamarSinDireccion || !contacto) {
              motivos.sin_sede++;
              console.warn(`[LLAMADAS-IA] Vencimiento ${venc.id} sin sede con dirección${!contacto ? ' ni celular de contacto' : ''} — omitido`);
              continue;
            }
            motivos.llamada_sin_direccion++;
          }

          // 6) ✅ FIX LUCY-ELEVEN-001b: registroRef se declara ANTES de usarse
          // (antes se usaba registroRef.id dos líneas antes de su declaración
          // — TDZ ReferenceError que tumbaba cada intento de llamada).
          const registroRef = db.collection('llamadas_ia').doc();
          const variables = construirVariablesLlamada({
            adminId, registroId: registroRef.id, cliente, vencimiento: venc, tenantInfo, sede, perfil,
          });

          // ✅ LUCY-TIMBRE-006: cuelga a los N segundos si nadie contesta.
          const resultadoLanzamiento = await lanzarLlamadaElevenLabs({
            telefono, variables, segundosTimbre: config.segundosTimbre,
          });

          await registroRef.set({
            adminId,
            vencimientoId: venc.id,
            clienteId: venc.clienteId,
            telefono: telefonoRaw,
            mesVencimiento: venc.fechaVencimiento,
            intento: numeroIntento,
            estado: resultadoLanzamiento.ok ? 'en_curso' : 'fallida',
            resultado: null,
            proveedor: 'elevenlabs',
            conversationId: resultadoLanzamiento.ok ? resultadoLanzamiento.conversationId : null,
            errorLanzamiento: resultadoLanzamiento.ok ? null : resultadoLanzamiento.error,
            costoFacturadoCOP: COSTO_FACTURADO_COP,
            esPrueba: false,
            // ✅ Trazabilidad del enrutamiento — permite auditar por qué Lucy
            // usó el guion corto o el largo, y medir cierre por tipo de activo.
            tipoUso: perfil.tipoUso,
            desenlaceEsperado: perfil.desenlace,
            guionTipo: perfil.guionTipo,
            reglaClasificacion: perfil.reglaAplicada,
            empresaId: venc.empresaId || cliente.empresaId || null,
            sedeConfirmada: sede.completa,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          if (resultadoLanzamiento.ok) {
            totalLanzadas++;
            lanzadasEnLote++;
            lanzadasTenant++;   // ✅ LUCY-PAQUETE-005
            // El mapa se mantiene al día dentro de la corrida: si el mismo
            // cliente apareciera otra vez, ya cuenta con este intento.
            if (mapaIntentos) {
              const k = claveIntento(venc.clienteId, venc.fechaVencimiento);
              const reg = mapaIntentos.get(k) || { intentos: 0, final: false };
              mapaIntentos.set(k, { ...reg, intentos: reg.intentos + 1 });
            }
            // ✅ LUCY-ASINCRONO-001: avance en vivo para el panel — a quién
            // está llamando Lucy en este momento y cuánto lleva.
            if (soloAdminId) {
              await guardarCorrida(adminId, {
                estado: 'en_curso',
                mes: mesObjetivo,                                  // ✅ LUCY-MES-004
                paquete: topePaquete,                              // ✅ LUCY-PAQUETE-005
                lanzadas: totalLanzadas,
                totalObjetivo: topePaquete ? Math.min(topePaquete, vencimientos.length) : vencimientos.length,
                enCola: vencimientos.length,
                llamandoAhora: telefonoRaw,
                clienteAhora: cliente.nombre || '',
                tipoAhora: perfil.tipoUso,
              });
            }
            // ✅ FIX LUCY-CAPACIDAD-001: la reserva ya NO es 2 min fijos. Se
            // estima por tipo de activo y se pondera por tasa de contestación
            // —una llamada no contestada casi no consume minutos—. El consumo
            // real lo fija el webhook con la duración efectiva.
            minutosDisponibles -= perfil.minutosEstimados * FACTOR_CONTESTACION;
          } else {
            motivos.fallo_proveedor++;
            console.error(`[LLAMADAS-IA] Fallo al lanzar a ${telefono}:`, resultadoLanzamiento.error);
          }

          // ✅ Control de concurrencia: se lanzan en lotes pequeños con pausa,
          // en vez de cientos de llamadas vivas al mismo tiempo (el proveedor
          // las rechaza y se pierden vencimientos sin aviso).
          if (lanzadasEnLote >= LOTE_CONCURRENTE) {
            lanzadasEnLote = 0;
            await new Promise(r => setTimeout(r, PAUSA_ENTRE_LOTES));
          } else {
            await new Promise(r => setTimeout(r, 800));
          }

        } catch (errCliente) {
          console.error('[LLAMADAS-IA] Error procesando vencimiento', venc.id, errCliente.message);
        }
      }

      // ✅ LUCY-PARADA-001: el freno corta la corrida completa, no solo el
      // tenant actual. En corridas de un solo tenant es lo mismo; se deja
      // explícito para que no cambie el comportamiento si algún día el botón
      // se expone en una corrida multi-tenant.
      if (detencion) break;
    }

    console.log(`[LLAMADAS-IA] Motor completado — mes ${mesObjetivo}, ${tenantsProcesados} tenant(s), ${totalLanzadas} llamada(s), ${omitidasPorTope} omitida(s) por tope`, motivos);
    const resumen = {
      tenantsProcesados,
      llamadasLanzadas: totalLanzadas,
      omitidasPorTope,
      vencimientosEvaluados: vencSnap.size,
      mes: mesObjetivo,        // ✅ LUCY-MES-004 — qué mes se llamó
      paquete: topePaquete,    // ✅ LUCY-PAQUETE-005 — tope pedido, null = sin tope
      motivos, // ✅ LUCY-DIAGNOSTICO-002 — desglose visible en el panel
    };
    // ✅ LUCY-ASINCRONO-001: el resumen se persiste porque el motor ya NO
    // responde dentro de la petición HTTP (ver más abajo).
    // ✅ LUCY-PARADA-001: si el usuario frenó, el estado final NO es 'terminada'.
    // 'pausada' conserva la cola para poder continuar; 'cancelada' la descarta.
    if (soloAdminId) {
      if (detencion) {
        await guardarCorrida(soloAdminId, {
          ...resumen,
          estado: detencion.senal === 'pausar' ? 'pausada' : 'cancelada',
          pendientes: detencion.senal === 'pausar' ? detencion.pendientes : [],
          pendientesCount: detencion.senal === 'pausar' ? detencion.pendientes.length : 0,
          senalControl: null,               // consumida: no frena la próxima corrida
          detenidaAt: new Date().toISOString(),
          llamandoAhora: null,
          clienteAhora: null,
        });
      } else {
        await guardarCorrida(soloAdminId, {
          estado: 'terminada',
          ...resumen,
          pendientes: [],
          pendientesCount: 0,
          senalControl: null,
          llamandoAhora: null,
          clienteAhora: null,
        });
      }
    }
    return { ...resumen, detenida: detencion?.senal || null };
  } catch (e) {
    console.error('[LLAMADAS-IA] Error general del motor:', e.message);
    return { tenantsProcesados: 0, llamadasLanzadas: 0, omitidasPorTope: 0, error: e.message };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// LLAMADA DE PRUEBA — ✅ FIX LUCY-ELEVEN-001f
// Lanza UNA llamada al número indicado con datos de ejemplo del tenant.
// No toca vencimientos ni clientes; el registro queda marcado esPrueba=true.
// ═════════════════════════════════════════════════════════════════════════════
const lanzarLlamadaPrueba = async ({ adminId, telefono, tipoUso = 'empresa' }) => {
  const telefonoE164 = normalizarParaLlamada(telefono);
  if (!telefonoE164) return { ok: false, error: 'Teléfono inválido — usa un celular colombiano de 10 dígitos' };

  const activa = await tenantTieneLucyActiva(adminId);
  if (!activa) return { ok: false, error: 'El módulo Llamadas IA no está activo para esta empresa' };

  const userDoc = await db.collection('users').doc(adminId).get();
  const tenantInfo = {
    nombre:    userDoc.exists ? (userDoc.data().empresa || userDoc.data().nombre) : 'Control360',
    direccion: userDoc.exists ? userDoc.data().direccion : '',
    ciudad:    userDoc.exists ? userDoc.data().ciudad : '',
    telefono:  userDoc.exists ? telefonoContactoTenant(userDoc.data()) : '',   // ✅ LUCY-SINSEDE-008
  };

  // ✅ LUCY-SEDE-001: la prueba usa la MISMA resolución de sede que la
  // operación real — así se valida en la prueba que la dirección que dicta
  // Lucy es la correcta, antes de llamar a un cliente.
  const cacheSedes = new Map();
  const sede = await obtenerSede(adminId, null, cacheSedes);

  // Permite probar cualquiera de los dos guiones sin tocar clientes reales.
  const equipoPrueba = tipoUso === 'vehicular'
    ? 'un extintor ABC de 5 libras'
    : 'tres extintores ABC de 10 libras';
  const perfil = clasificarActivo(equipoPrueba);

  const registroRef = db.collection('llamadas_ia').doc();
  const variables = construirVariablesLlamada({
    adminId,
    registroId: registroRef.id,
    cliente: {
      nombre: 'CLIENTE DE PRUEBA',
      contacto: 'Sandra',
      direccion: 'Calle 10 número 5-23, barrio Centro',
      celular: telefono,
    },
    vencimiento: {
      descripcionEquipo: equipoPrueba,
      fechaVencimiento: `${mesActualColombia()}-01`,
      telefono,
    },
    tenantInfo,
    sede,
    perfil,
  });

  // ✅ LUCY-TIMBRE-006: la prueba usa el MISMO timbre que una llamada real —
  // es la forma de verificar el ajuste sin gastar una corrida entera.
  const configPrueba = await obtenerConfigTenant(adminId).catch(() => ({ segundosTimbre: SEGUNDOS_TIMBRE_DEFAULT }));
  const resultadoLanzamiento = await lanzarLlamadaElevenLabs({
    telefono: telefonoE164, variables, segundosTimbre: configPrueba.segundosTimbre,
  });

  await registroRef.set({
    adminId,
    vencimientoId: null,
    clienteId: null,
    telefono,
    mesVencimiento: `${mesActualColombia()}-01`,
    intento: 1,
    estado: resultadoLanzamiento.ok ? 'en_curso' : 'fallida',
    resultado: null,
    proveedor: 'elevenlabs',
    conversationId: resultadoLanzamiento.ok ? resultadoLanzamiento.conversationId : null,
    errorLanzamiento: resultadoLanzamiento.ok ? null : resultadoLanzamiento.error,
    costoFacturadoCOP: 0, // las pruebas no se facturan al tenant
    esPrueba: true,
    tipoUso: perfil.tipoUso,
    desenlaceEsperado: perfil.desenlace,
    guionTipo: perfil.guionTipo,
    sedeConfirmada: sede.completa,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return resultadoLanzamiento.ok
    ? { ok: true, mensaje: 'Llamada de prueba lanzada — tu teléfono sonará en unos segundos', registroId: registroRef.id }
    : { ok: false, error: resultadoLanzamiento.error };
};

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOK POST-LLAMADA (ElevenLabs "post_call_transcription")
// Estructura del payload:
// { type, data: { conversation_id, transcript:[{role,message}],
//   metadata:{ call_duration_secs, cost }, analysis:{ transcript_summary,
//   data_collection_results }, conversation_initiation_client_data:
//   { dynamic_variables: { adminId, registroId, ... } } } }
// ═════════════════════════════════════════════════════════════════════════════
const procesarResultadoLlamada = async (payload) => {
  try {
    const data = payload?.data || payload || {};
    const dynVars = data?.conversation_initiation_client_data?.dynamic_variables || {};
    const registroId = dynVars.registroId || data?.metadata?.registroId;
    if (!registroId) {
      console.warn('[LLAMADAS-IA] Webhook sin registroId — ignorado');
      return { ok: false, error: 'Sin registroId' };
    }

    const ref = db.collection('llamadas_ia').doc(registroId);
    const doc = await ref.get();
    if (!doc.exists) {
      console.warn('[LLAMADAS-IA] Webhook referencia un registro inexistente:', registroId);
      return { ok: false, error: 'Registro no encontrado' };
    }
    const registroActual = doc.data();

    // Transcripción: ElevenLabs la entrega como array de turnos
    let transcript = '';
    if (Array.isArray(data.transcript)) {
      transcript = data.transcript
        .map(t => `${t.role === 'agent' ? 'Lucy' : 'Cliente'}: ${t.message || ''}`)
        .join('\n');
    } else if (typeof data.transcript === 'string') {
      transcript = data.transcript;
    }

    const durationSeconds = Number(data?.metadata?.call_duration_secs) || null;
    const costoCreditos = Number(data?.metadata?.cost) || null;

    // Resultado: prioridad 1) la Tool registrar-cierre ya marcó 'cerrada';
    // 2) data_collection_results del agente; 3) conservador: sin_respuesta.
    const dcr = data?.analysis?.data_collection_results || {};
    const resultadoAnalisis = dcr?.resultado?.value || dcr?.resultado || null;
    const RESULTADOS_VALIDOS = ['cerrada', 'reagendada', 'inactivo_cliente', 'escalado_asesor', 'no_interesado', 'sin_respuesta'];
    let resultado;
    if (registroActual.resultado === 'cerrada') {
      resultado = 'cerrada'; // la Tool ya lo fijó durante la llamada — no se pisa
    } else if (RESULTADOS_VALIDOS.includes(resultadoAnalisis)) {
      resultado = resultadoAnalisis;
    } else {
      resultado = 'sin_respuesta';
    }

    const update = {
      estado: 'completada',
      resultado,
      duracionSegundos: durationSeconds,
      costoCreditosEleven: costoCreditos,
      transcripcion: transcript,
      resumenIA: data?.analysis?.transcript_summary || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await ref.update(update);

    // ✅ FIX LUCY-ELEVEN-001d: consumo real de minutos del tenant
    await registrarConsumoMinutos(registroActual.adminId, durationSeconds);

    // Las pruebas terminan aquí — no tocan vencimientos ni telemercadeo
    if (registroActual.esPrueba) {
      console.log(`[LLAMADAS-IA] Prueba procesada — registro ${registroId}: ${resultado}`);
      return { ok: true };
    }

    // ✅ VENC-CICLO-003: agotados los intentos de Lucy, el ciclo NO se cierra —
    // pasa a un asesor humano. Regla de Sandra: solo se da por perdido cuando
    // telemercadeo también lo intentó. Lucy filtra, no descarta.
    const config = await obtenerConfigTenant(registroActual.adminId).catch(() => ({ maxIntentos: MAX_INTENTOS_DEFAULT }));

    // ✅ LUCY-ESCALA-002: el vencimiento pasa a telemercadeo tras la SEGUNDA
    // ronda sin respuesta, no al agotar los 3 intentos.
    // Regla de Sandra: si no contestaron dos veces, no vale la pena que Lucy
    // insista un mes entero mientras el cliente se enfría. Lucy sigue con su
    // tercer intento si le queda, pero el humano ya lo puede ver y llamar.
    const INTENTOS_PARA_ESCALAR = 2;
    const intentosAgotados = resultado === 'sin_respuesta' &&
      registroActual.intento >= Math.min(INTENTOS_PARA_ESCALAR, config.maxIntentos || MAX_INTENTOS_DEFAULT);

    // ✅ LUCY-PRIORIDAD-001: clientes de alto valor no esperan los 3 intentos.
    // Un cliente con varios equipos que no contesta la PRIMERA llamada pasa ya
    // a telemercadeo humano. Con 1 equipo, sigue el flujo normal de Lucy.
    // Aplica solo a 'sin_respuesta': si contestó, el resultado manda.
    let prioritario = false;
    if (resultado === 'sin_respuesta' && !intentosAgotados && registroActual.clienteId) {
      prioritario = await esClientePrioritario(
        registroActual.adminId, registroActual.clienteId, config.umbralPrioridadEquipos
      );
    }

    if (intentosAgotados || prioritario || resultado === 'escalado_asesor') {
      await db.collection('vencimientos').doc(registroActual.vencimientoId).update({
        escaladoTelemercadeo: true,
        estadoCiclo: 'EN_TELEMERCADEO',
        motivoEscalamiento: resultado === 'escalado_asesor' ? 'lucy_escalo'
          : prioritario ? 'prioridad_alta'   // ✅ LUCY-PRIORIDAD-001
          : 'lucy_sin_contacto',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      if (prioritario) {
        console.log(`[LLAMADAS-IA] LUCY-PRIORIDAD-001: cliente ${registroActual.clienteId} escalado a telemercadeo tras el intento ${registroActual.intento} (cliente de varios equipos)`);
      }
    }

    // Resuelto → gestionado=true para que el motor no vuelva a llamar este ciclo
    const ESTADO_POR_RESULTADO = {
      cerrada:          'RENOVADO',
      reagendada:       'EN_TELEMERCADEO',
      inactivo_cliente: 'INACTIVO',
      no_interesado:    'INACTIVO',
    };
    if (ESTADO_POR_RESULTADO[resultado]) {
      await db.collection('vencimientos').doc(registroActual.vencimientoId).update({
        gestionado: ['cerrada', 'inactivo_cliente', 'no_interesado'].includes(resultado),
        estadoCiclo: ESTADO_POR_RESULTADO[resultado],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

    console.log(`[LLAMADAS-IA] Resultado procesado — registro ${registroId}: ${resultado}`);
    return { ok: true };
  } catch (e) {
    console.error('[LLAMADAS-IA] Error procesando webhook:', e.message);
    return { ok: false, error: e.message };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// CORRIDAS PROGRAMADAS — ✅ FIX LUCY-ELEVEN-001e (igual que Anny)
// Colección llamadas_ia_programadas:
// { adminId, fechaHora: 'YYYY-MM-DDTHH:mm' (hora Colombia),
//   estado: 'pendiente' | 'ejecutada' | 'cancelada', creadaPor, createdAt }
// El cron (cada 15 min) ejecuta las vencidas, SIEMPRE scoped al tenant.
// ═════════════════════════════════════════════════════════════════════════════
const ejecutarProgramadasVencidas = async () => {
  try {
    const ahora = ahoraColombiaISO();
    const snap = await db.collection('llamadas_ia_programadas')
      .where('estado', '==', 'pendiente')
      .limit(50)
      .get();
    if (snap.empty) return;

    for (const doc of snap.docs) {
      const prog = doc.data();
      if (!prog.fechaHora || prog.fechaHora > ahora) continue; // aún no es la hora
      console.log(`[LLAMADAS-IA-CRON] Ejecutando corrida programada ${doc.id} — tenant ${prog.adminId}`);
      await doc.ref.update({
        estado: 'ejecutada',
        ejecutadaAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Scoped al tenant + ignora ventana horaria (el humano eligió la hora)
      // ✅ LUCY-MES-004 / LUCY-PAQUETE-005: la programación guarda el mes y el
      // tamaño del paquete que eligió el humano; si no los guardó (corridas
      // creadas antes de este cambio), el motor usa el mes actual y sin tope.
      await ejecutarMotorLlamadas({
        soloAdminId: prog.adminId,
        ignorarHorario: true,
        mes: prog.mes || null,
        maxLlamadas: prog.maxLlamadas || null,
      }).catch(e => console.error('[LLAMADAS-IA-CRON] Error en programada:', e.message));
    }
  } catch (e) {
    console.error('[LLAMADAS-IA-CRON] Error revisando programadas:', e.message);
  }
};

module.exports = {
  ejecutarMotorLlamadas,
  procesarResultadoLlamada,
  lanzarLlamadaPrueba,
  tenantTieneLucyActiva,
  obtenerConfigTenant,
  normalizarParaLlamada,
  clasificarActivo,   // expuesto para el panel y para pruebas del ruleset
  obtenerSede,
  guardarCorrida,
  obtenerUltimaCorrida,
  solicitarControlCorrida, // ✅ LUCY-PARADA-001
  leerSenalControl,
  corridaEstaViva,         // ✅ LUCY-PARADA-002
  esMesValido,             // ✅ LUCY-MES-004 — validación compartida con la ruta
  mesActualColombia,       // ✅ LUCY-MES-004 — mes por defecto del panel
  MAX_LLAMADAS_TOPE,       // ✅ LUCY-PAQUETE-005
  SEGUNDOS_TIMBRE_MIN,     // ✅ LUCY-TIMBRE-006
  SEGUNDOS_TIMBRE_MAX,     // ✅ LUCY-TIMBRE-006
};

// ════════════════════════════════════════════════════════════════════════════
// CRON AUTOMÁTICO
// - Corrida mensual: primeros 3 días hábiles, 9:00 AM Colombia (todos los
//   tenants ACTIVOS — la activación explícita es el filtro de seguridad).
// - Corridas programadas: se revisan cada 15 minutos, a cualquier hora.
// ════════════════════════════════════════════════════════════════════════════

const esDiaHabil = (fechaStr) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const diaSemana = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return diaSemana >= 1 && diaSemana <= 5;
};

const diasHabilesTranscurridosMes = (fechaStr) => {
  const [y, m, d] = fechaStr.split('-').map(Number);
  let count = 0;
  for (let dia = 1; dia <= d; dia++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    if (esDiaHabil(ds)) count++;
  }
  return count;
};

let ultimaEjecucionLlamadasIA = null;

const iniciarCronLlamadasIA = () => {
  const verificar = () => {
    // 1) Corridas programadas — cada ciclo, sin restricción de ventana
    ejecutarProgramadasVencidas();

    // 2) Corrida mensual automática
    const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
    const fechaHoy = ahoraCO.toISOString().slice(0, 10);
    const hora = ahoraCO.getUTCHours();

    if (hora !== 9 || ahoraCO.getMinutes() >= 15) return;
    if (ultimaEjecucionLlamadasIA === fechaHoy) return;
    if (!esDiaHabil(fechaHoy)) return;

    const diasHabiles = diasHabilesTranscurridosMes(fechaHoy);
    if (diasHabiles > 3) return;

    ultimaEjecucionLlamadasIA = fechaHoy;
    console.log(`[LLAMADAS-IA-CRON] Corrida mensual — día hábil ${diasHabiles} del mes`);
    ejecutarMotorLlamadas().catch(e => console.error('[LLAMADAS-IA-CRON]', e.message));
  };

  setInterval(verificar, 15 * 60 * 1000);
  verificar();
  console.log('✅ Cron Llamadas IA (Lucy/ElevenLabs) activo — mensual (3 primeros días hábiles 9AM) + programadas cada 15 min');
};

module.exports.iniciarCronLlamadasIA = iniciarCronLlamadasIA;
