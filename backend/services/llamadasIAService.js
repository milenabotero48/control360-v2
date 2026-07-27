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

// Fracción de llamadas lanzadas que termina en conversación facturable.
// Conservador: si de cada 10 llamadas contestan 4, solo esas consumen minutos.
const FACTOR_CONTESTACION = Number(process.env.LLAMADA_IA_FACTOR_CONTESTACION) || 0.45;

// Control de concurrencia: ElevenLabs/Twilio limitan llamadas simultáneas.
// Antes se lanzaban en serie con 800 ms de separación — con 900 vencimientos
// eso deja cientos de llamadas vivas al mismo tiempo y el proveedor rechaza.
const LOTE_CONCURRENTE  = Number(process.env.LLAMADA_IA_CONCURRENCIA) || 5;
const PAUSA_ENTRE_LOTES = Number(process.env.LLAMADA_IA_PAUSA_LOTE_MS) || 20000;

// ─── Helpers de fecha (mismo criterio que vencimientosService.js) ────────────
const mesActualColombia = () => {
  const ahoraCO = new Date(Date.now() - 5 * 3600 * 1000);
  return ahoraCO.toISOString().slice(0, 7); // "YYYY-MM"
};

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

const obtenerSede = async (adminId, empresaId, cacheSedes) => {
  const clave = empresaId || '__principal__';
  if (cacheSedes.has(clave)) return cacheSedes.get(clave);

  let sede = null;

  if (empresaId) {
    const doc = await db.collection('companies').doc(empresaId).get();
    // Ownership multi-tenant: una sede de otro suscriptor jamás se usa.
    if (doc.exists && doc.data().user_id === adminId) sede = { id: doc.id, ...doc.data() };
  }

  // Sin empresaId asignado → sede principal del suscriptor (la primera activa).
  if (!sede) {
    const snap = await db.collection('companies').where('user_id', '==', adminId).limit(5).get();
    if (!snap.empty) sede = { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  const resuelta = sede
    ? {
        completa:  !!(sede.address && String(sede.address).trim()),
        nombre:    sede.name || '',
        direccion: sede.address || '',
        ciudad:    sede.ciudad || '',
        telefono:  sede.phone || sede.cellphone || sede.whatsapp || '',
        horario:   sede.horarioAtencion || HORARIO_FALLBACK,
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
const obtenerConfigTenant = async (adminId) => {
  const doc = await db.collection('llamadas_ia_config').doc(adminId).get();
  const data = doc.exists ? doc.data() : {};
  const mes = mesActualColombia();
  return {
    topeMinutosMes: Number(data.topeMinutosMes) || TOPE_MINUTOS_DEFAULT,
    minutosConsumidosMes: Number(data.consumo?.[mes]) || 0,
    // ✅ LUCY-CAPACIDAD-001: intentos por cliente/mes configurables por tenant.
    // Antes estaba quemado en 2 dentro del motor.
    maxIntentos: Number(data.maxIntentos) || MAX_INTENTOS_DEFAULT,
    // Ruleset de clasificación propio del suscriptor (opcional). Si no lo tiene,
    // se usa el de extintores por defecto.
    reglasClasificacion: Array.isArray(data.reglasClasificacion) ? data.reglasClasificacion : null,
  };
};

const registrarConsumoMinutos = async (adminId, segundos) => {
  if (!adminId || !segundos) return;
  const minutos = Math.ceil(segundos / 60); // se factura por minuto, igual criterio del proveedor
  const mes = mesActualColombia();
  await db.collection('llamadas_ia_config').doc(adminId).set({
    consumo: { [mes]: admin.firestore.FieldValue.increment(minutos) },
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
    direccion_cliente:  cliente.direccion || 'no registrada',
    telefono_cliente:   String(vencimiento.telefono || cliente.celular || cliente.telefono || ''),
    tipo_servicio:      cliente.tipoServicioHistorico || 'oficina',
    valor_domicilio:    tenantInfo.valorDomicilio || 'según su sector',
    mes_vencimiento:    vencimiento.fechaVencimiento || '',
    medios_pago:        tenantInfo.mediosPago || 'efectivo, transferencia y Nequi',

    // ── Datos de la SEDE que atiende a este cliente ──────────────────────────
    direccion_empresa:  sedeSegura.direccion || tenantInfo.direccion || '',
    ciudad_empresa:     sedeSegura.ciudad    || tenantInfo.ciudad    || '',
    horario_empresa:    sedeSegura.horario   || HORARIO_FALLBACK,
    telefono_empresa:   sedeSegura.telefono  || '',
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
const lanzarLlamadaElevenLabs = async ({ telefono, variables }) => {
  try {
    if (!ELEVEN_API_KEY || !ELEVEN_AGENT_ID || !ELEVEN_PHONE_ID) {
      return { ok: false, error: 'Faltan variables ELEVENLABS_* en el entorno (Railway)' };
    }
    const resp = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: ELEVEN_AGENT_ID,
        agent_phone_number_id: ELEVEN_PHONE_ID,
        to_number: telefono,
        conversation_initiation_client_data: {
          dynamic_variables: variables, // adminId/registroId incluidos — vuelven en el webhook
        },
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) {
      return { ok: false, error: data?.detail?.message || data?.message || `HTTP ${resp.status}` };
    }
    return { ok: true, conversationId: data.conversation_id || data.callSid || null };
  } catch (e) {
    return { ok: false, error: e.message };
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
  const { soloAdminId = null, ignorarHorario = false } = opciones;
  const mesActual = mesActualColombia();
  console.log(`[LLAMADAS-IA] Motor — mes ${mesActual}${soloAdminId ? ` — SOLO tenant ${soloAdminId}` : ' — todos los tenants activos'}`);

  try {
    // 1) Vencimientos del MES ACTUAL no gestionados
    let vencQuery = db.collection('vencimientos')
      .where('fechaVencimiento', '>=', `${mesActual}-01`)
      .where('fechaVencimiento', '<=', `${mesActual}-31`)
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
    const porTenant = {};
    vencSnap.docs.forEach(doc => {
      const d = doc.data();
      if (!d.adminId || !d.clienteId) return;
      if (!porTenant[d.adminId]) porTenant[d.adminId] = [];
      porTenant[d.adminId].push({ id: doc.id, ...d });
    });

    let totalLanzadas = 0;
    let tenantsProcesados = 0;
    let omitidasPorTope = 0;
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
      };

      // Cache de sedes por corrida — evita releer `companies` en cada llamada.
      const cacheSedes = new Map();
      let lanzadasEnLote = 0;

      for (const venc of vencimientos) {
        try {
          if (minutosDisponibles <= 0) { omitidasPorTope++; continue; }

          // 4) Anti-duplicado + máximo 2 intentos
          const existentesSnap = await db.collection('llamadas_ia')
            .where('adminId', '==', adminId)
            .where('clienteId', '==', venc.clienteId)
            .where('mesVencimiento', '==', venc.fechaVencimiento)
            .get();

          const intentos = existentesSnap.docs.map(d => d.data());
          const yaTieneResultadoFinal = intentos.some(i =>
            ['cerrada', 'reagendada', 'inactivo_cliente', 'escalado_asesor', 'no_interesado'].includes(i.resultado)
          );
          if (yaTieneResultadoFinal) { motivos.ya_gestionado++; continue; }

          // ✅ LUCY-CAPACIDAD-001: intentos configurables (antes quemado en 2).
          const numeroIntento = intentos.length + 1;
          if (numeroIntento > config.maxIntentos) { motivos.intentos_agotados++; continue; }

          // 5) Cliente y teléfono
          const cliDoc = await db.collection('clients').doc(venc.clienteId).get();
          if (!cliDoc.exists) { motivos.cliente_inexistente++; continue; }
          const cliente = cliDoc.data();
          const telefonoRaw = venc.telefono || cliente.celular || cliente.telefono;
          const telefono = normalizarParaLlamada(telefonoRaw);
          if (!telefono) {
            motivos.sin_telefono++;
            console.warn(`[LLAMADAS-IA] Cliente ${venc.clienteId} sin teléfono válido — omitido`);
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

          // 6) ✅ FIX LUCY-ELEVEN-001b: registroRef se declara ANTES de usarse
          // (antes se usaba registroRef.id dos líneas antes de su declaración
          // — TDZ ReferenceError que tumbaba cada intento de llamada).
          const registroRef = db.collection('llamadas_ia').doc();
          const variables = construirVariablesLlamada({
            adminId, registroId: registroRef.id, cliente, vencimiento: venc, tenantInfo, sede, perfil,
          });

          const resultadoLanzamiento = await lanzarLlamadaElevenLabs({ telefono, variables });

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
    }

    console.log(`[LLAMADAS-IA] Motor completado — ${tenantsProcesados} tenant(s), ${totalLanzadas} llamada(s), ${omitidasPorTope} omitida(s) por tope`, motivos);
    return {
      tenantsProcesados,
      llamadasLanzadas: totalLanzadas,
      omitidasPorTope,
      vencimientosEvaluados: vencSnap.size,
      motivos, // ✅ LUCY-DIAGNOSTICO-002 — desglose visible en el panel
    };
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

  const resultadoLanzamiento = await lanzarLlamadaElevenLabs({ telefono: telefonoE164, variables });

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

    // Sin respuesta en intento 2, o escalado → señal para Telemercadeo (TELEVENC-001)
    if ((resultado === 'sin_respuesta' && registroActual.intento >= 2) || resultado === 'escalado_asesor') {
      await db.collection('vencimientos').doc(registroActual.vencimientoId).update({
        escaladoTelemercadeo: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

    // Resuelto → gestionado=true para que el motor no vuelva a llamar este ciclo
    if (['cerrada', 'reagendada', 'inactivo_cliente'].includes(resultado)) {
      await db.collection('vencimientos').doc(registroActual.vencimientoId).update({
        gestionado: true,
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
      await ejecutarMotorLlamadas({ soloAdminId: prog.adminId, ignorarHorario: true })
        .catch(e => console.error('[LLAMADAS-IA-CRON] Error en programada:', e.message));
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
