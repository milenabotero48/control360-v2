# Control360 · Nómina — cierre del ciclo del pasivo laboral

**Estado:** propuesta de arquitectura. Nada implementado.
**Módulo afectado:** `NOMINA-PROVISIONES-001` (`backend/routes/empleados.js`, `backend/services/nominaColombia.js`, `frontend/src/GestionEmpleados.js`)
**Fecha:** agosto 2026

---

## 1. Diagnóstico — qué hace y qué no hace el módulo hoy

El motor de cálculo (`nominaColombia.js`) está bien construido: parámetros por año, tipos de contrato, exoneración Ley 1819, ARL por trabajador, horas extras con la escala de la Ley 2466/2025. El problema no es el cálculo. Es que **el ciclo contable está abierto por un solo extremo**.

| # | Hallazgo | Evidencia | Severidad |
|---|---|---|---|
| H1 | `pagada: false` se escribe una vez y ningún endpoint vuelve a tocarlo | `empleados.js:526`; sin coincidencias de escritura en todo `backend/` | **Crítica** |
| H2 | `pasivoAcumulado` suma todas las provisiones no revertidas sin restar pagos | `empleados.js:412-419` | **Crítica** |
| H3 | La provisión mensual **no incluye horas extras**: `devengadoAdicional` nunca se pasa | `empleados.js:394` y `:497` vs. `nominaColombia.js:336,361` | **Crítica** |
| H4 | No existe liquidación de contrato ni indemnización: cero coincidencias de `indemniz` en el módulo | `empleados.js:264` (`desactivar` solo marca `fechaFin`) | **Crítica** |
| H5 | La seguridad social patronal se calcula y se guarda, pero el ERI **no la causa** | `eri.js:497` suma solo `totalPrestaciones` | Alta |
| H6 | Las deducciones al empleado (salud 4%, pensión 4%, FSP) no generan pasivo | `empleados.js:759` — el egreso es solo por `netoAPagar` | Alta |
| H7 | Riesgo de doble conteo si el pago se digita como egreso categoría "Nómina" | `eri.js:497` + suma de egresos `gasto_personal` | Alta |
| H8 | La causación retroactiva usa el salario **actual**, no el histórico | `empleados.js:497` lee `emp.salario` | Media |
| H9 | Sin aviso de preaviso de término fijo (art. 46 CST) → renovación automática no advertida | no existe | Media |

### Consecuencia acumulada

El pasivo laboral del balance **solo crece**. El ERI de febrero, junio y diciembre (meses de pago) queda inflado por doble conteo si el suscriptor digita el pago como egreso. Un contador que evalúe el producto detecta esto en la primera revisión.

---

## 2. Respuestas concretas a las cuatro preguntas

### 2.1 ¿Cómo se paga la seguridad social?

**Hoy:** se digita la planilla PILA como un egreso normal con categoría "Nómina". Eso *no* duplica actualmente, porque `eri.js` causa desde la provisión únicamente `totalPrestaciones` — la seguridad social patronal calculada en `provisiones_prestaciones.totalSeguridadSocial` es dato muerto que solo alimenta un KPI de pantalla.

**El problema de fondo:** el ERI queda con **dos criterios contables mezclados**.

| Concepto | Criterio actual | Debería ser |
|---|---|---|
| Prestaciones sociales | Causación (devengo) ✅ | Causación |
| Seguridad social patronal | Caja, y desfasada un mes (PILA se paga el mes siguiente) | Causación |
| Deducciones al empleado | No se registran como pasivo | Pasivo hasta pagar PILA |

Además, si el suscriptor **olvida** digitar la PILA, el ERI subestima el costo de personal en ~19–32% del salario base y nadie lo detecta.

**Propuesta:** causar la seguridad social junto con la provisión (mismo botón, mismo mes) y pagar la PILA descargando ese pasivo — no como gasto nuevo.

```
Causación mensual (un solo asiento):
  Db  Gasto de personal — prestaciones      21,83%
  Db  Gasto de personal — aportes patronales ~19% (exonerada) / ~32,5% (no exonerada)
  Cr  Pasivo prestaciones (por concepto)
  Cr  Pasivo seguridad social (patronal)
  Cr  Pasivo seguridad social (retenido al empleado)   ← del neto ya descontado

Pago de PILA:
  Db  Pasivo seguridad social (patronal + empleado)
  Cr  Caja / Banco
  → NO es gasto. Es descargue de pasivo.
```

⚠️ **Advertencia de secuencia:** si se causa la seguridad social sin cambiar al mismo tiempo cómo se digita la PILA, **empieza a duplicar de inmediato**. Las dos cosas van en el mismo despliegue.

---

### 2.2 Empleado nuevo al que hay que causarle meses anteriores

**Sí se puede hoy, y funciona.** El endpoint es idempotente por `(anio, mes, empleadoId)`:

```js
// empleados.js:477
yaSnap.forEach(d => { if (d.data().revertida !== true) yaCausados.add(d.data().empleadoId); });
// :492
if (yaCausados.has(emp.id)) { omitidos.push(...); continue; }
```

**Procedimiento manual:**

1. Pestaña **Provisiones** → cambiar el período al mes más antiguo pendiente
2. Botón **Causar** — solo creará la provisión del empleado que falta; los que ya la tienen se omiten
3. Repetir mes por mes hasta el actual
4. Verificar en el panel **Pasivo acumulado** que el total subió por el monto esperado

`vigenteEnMes()` respeta `fechaInicio`, así que no causa meses anteriores a la vinculación.

**Tres limitaciones que hay que conocer:**

- **Salario histórico (H8):** la causación retroactiva usa `emp.salario`, el salario **de hoy**. Si el trabajador tuvo un aumento, los meses anteriores quedan sobrevalorados. No existe historial de salario en el maestro.
- **Sin horas extras (H3):** ningún mes retroactivo incluirá extras.
- **Manual:** 8 meses de atraso = 8 iteraciones.

**Propuesta:** endpoint `POST /empleados/:id/provisiones/retroactivas` con rango `desde`/`hasta` y opción de salario histórico por tramo, más una tabla `empleados_salarios` (vigencia desde–hasta) que el motor consulte por período.

---

### 2.3 Horas extras en la base de la provisión — **bug confirmado**

El motor está preparado. Quien lo llama, no.

```js
// nominaColombia.js:361 — el motor SÍ lo soporta
const devengadoAdicional = Number(opciones.devengadoAdicional) || 0;
resultado.baseSinAuxilio = salarioProporcional + devengadoAdicional;

// nominaColombia.js:592 — la liquidación de nómina SÍ lo pasa
const provision = calcularProvisionMensual(empleado, { ..., devengadoAdicional: horas.total });

// empleados.js:394 y :497 — la causación NO lo pasa
const p = N.calcularProvisionMensual(emp, { anio, mes, diasTrabajados: dias, empresaExonerada });
```

**Resultado:** el comprobante de nómina muestra el costo correcto en pantalla, pero ese cálculo se queda en el JSON del egreso (`liquidacion.prestacionesProvisionadas`) y **nunca llega a `provisiones_prestaciones`**. Lo que se contabiliza está subvaluado.

**Base legal:** las horas extras y recargos son salario (art. 127 CST) y entran en la base de cesantías, intereses, prima y vacaciones. Un mensajero con 20 horas extra mensuales genera ~21,83% adicional sobre esas extras que hoy no se provisiona.

**Corrección:** la causación debe leer los comprobantes de nómina del período y pasar `devengadoAdicional = Σ devengados salariales − salario proporcional`. Esto invierte la dependencia actual: hoy la provisión se causa sin mirar la nómina; debería causarse **después** de liquidarla, o recalcularse cuando se liquida.

Decisión de arquitectura a validar: **¿la provisión se causa antes o después del comprobante de nómina?** Recomendación: después, o con recálculo automático — es la única forma de que las extras entren sin doble digitación.

---

### 2.4 Terminación sin justa causa e indemnización

**Hoy el sistema no lo contempla.** Cero coincidencias de `indemniz` en todo el módulo. `desactivar` (`empleados.js:264`) solo marca `activo: false` y `fechaFin`. El empleado sale y su provisión queda huérfana en el pasivo.

**Sí debe pagar indemnización.** Art. 64 CST (modificado por Ley 789/2002 art. 28):

| Tipo de contrato | Indemnización |
|---|---|
| **Término fijo** | Salarios del tiempo que falte hasta la fecha pactada de terminación |
| **Obra o labor** | Tiempo que falte para terminar la obra, **mínimo 15 días** de salario |
| **Indefinido**, salario < 10 SMMLV | 30 días por el primer año + 20 días por cada año adicional (proporcional por fracción) |
| **Indefinido**, salario ≥ 10 SMMLV | 20 días por el primer año + 15 días por cada año adicional (proporcional por fracción) |

**Reglas contables y fiscales:**

- La indemnización **no constituye salario**: no genera prestaciones ni aportes. No se descarga contra provisión — es gasto nuevo del período del despido.
- **Retención en la fuente:** 20% si el trabajador devenga más de 204 UVT mensuales (art. 401-3 ET).
- Los trabajadores con 10+ años de antigüedad al 27-dic-2002 conservan el régimen anterior (art. 64 antes de la Ley 789). Caso residual, pero el sistema debe marcarlo, no calcularlo.

**Alerta que el sistema debería dar y hoy no da (H9):** en término fijo, si no se avisa por escrito con **30 días de anticipación** al vencimiento, el contrato **se renueva automáticamente** por un período igual (art. 46 CST). El suscriptor que no avisa a tiempo queda amarrado otro período completo — y si después despide, paga indemnización por todo ese plazo.

**Y una advertencia, no un cálculo:** fuero de maternidad, fuero de salud, fuero sindical y estabilidad laboral reforzada hacen que el despido sea *ineficaz*, no simplemente indemnizable. El sistema debe mostrar un aviso ("verificá si aplica alguna protección especial antes de terminar") y nunca dar a entender que pagar la indemnización basta.

**Valor comercial:** un botón "¿Cuánto cuesta terminar este contrato hoy?" que muestre liquidación + indemnización + retención antes de decidir es una funcionalidad por la que un empresario paga. Ningún competidor de gama media la tiene bien resuelta.

---

## 3. Plan por fases

Cada fase es desplegable sola y no rompe lo existente.

### Fase 0 · Parche inmediato (1 cambio, sin migración)

Pasar `devengadoAdicional` en la causación (H3) y agregar `tipoERI: 'pago_pasivo_laboral'` al catálogo de categorías, excluido del gasto en `eri.js` — mismo patrón que `compra_inventario`. Permite digitar pagos de prestaciones sin duplicar mientras se construye la Fase 1.

**Impacto:** `empleados.js` (2 líneas), `configuracion.js` (1 entrada), `eri.js` (1 condición). Nada destructivo.

### Fase 1 · Cerrar el ciclo del pasivo

- Colección `pagos_prestaciones`
- `POST /api/empleados/prestaciones/pagar` — concepto, valor, caja, tipo (`consignacion_fondo` | `pago_directo` | `disfrute_vacaciones`)
- Descargue FIFO por período sobre `provisiones_prestaciones` (`pagada`, `saldoPendiente`)
- Egreso con `esPagoPasivoLaboral: true` → fuera del gasto en ERI, dentro del flujo de caja
- Diferencia real vs. provisionado → ajuste al gasto del mes de pago
- `pasivoAcumulado` = Σ provisiones no revertidas − Σ pagos aplicados

**Impacto:** `eri.js` una condición en el filtro de egresos; `finanzas.js` una línea de conciliación; `GestionEmpleados.js` pestaña nueva. `cxp.js` sin cambios.

### Fase 2 · Liquidación de contrato

- `POST /api/empleados/:id/liquidar` — preview y confirmación
- Calcula: cesantías del 1-ene al retiro, intereses proporcionales, prima proporcional, vacaciones compensadas, indemnización art. 64 si aplica, retención
- Genera **CxP a nombre del empleado** (egreso `estado: 'PENDIENTE'`) → entra solo al módulo CxP existente, que ya cuenta como deuda todo egreso pendiente
- Descarga la provisión acumulada del empleado; la indemnización va como gasto nuevo
- Advertencias de fuero antes de confirmar

**Impacto:** `empleados.js` endpoint nuevo, `nominaColombia.js` función `liquidarContrato()`. `cxp.js` **cero cambios**.

### Fase 3 · Seguridad social en causación

Causar aportes patronales y retenciones al empleado como pasivo; pagar PILA descargando ese pasivo. **Debe desplegarse junto con el cambio en cómo se digita la PILA**, o duplica.

### Fase 4 · Calendario laboral

Enganchar `calendarioColombia.js` + `novedades.js`: 31-ene intereses, 14-feb cesantías, 30-jun y 20-dic prima, preaviso de término fijo a 30 días del vencimiento — cada aviso con el saldo exacto del pasivo por concepto.

---

## 4. Decisiones que requieren validación antes de implementar

1. **¿La provisión se causa antes o después del comprobante de nómina?** Determina cómo entran las horas extras. Recomendación: recálculo automático al liquidar.
2. **¿Historial de salario por vigencia?** Necesario para causación retroactiva correcta. Implica tabla nueva y migración del maestro.
3. **¿La seguridad social se causa o se mantiene en caja?** Causarla es lo correcto, pero obliga a cambiar el hábito del suscriptor. Requiere novedad + guía en la app.
4. **¿Qué se hace con las provisiones ya causadas sin horas extras?** ¿Ajuste retroactivo, o corte a partir de la fecha del despliegue?
