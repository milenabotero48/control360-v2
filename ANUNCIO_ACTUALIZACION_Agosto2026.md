# Control 360 · Actualización de agosto 2026

**Dos módulos nuevos y un cambio importante en cómo se registra la nómina.**

---

## 🚚 Nuevo: módulo de Vehículos

*Menú lateral → Recursos → Vehículos*

Ahora podés registrar las placas de los vehículos de tu empresa. Cuando cargues un gasto de combustible, mantenimiento, peajes o fletes, vas a poder indicar a qué vehículo corresponde.

**Para qué sirve:** hasta hoy el gasto vehicular era un solo bloque. Sabías cuánto gastaste, pero no en qué. Con las placas cargadas podés ver cuánto consume cada vehículo, detectar un consumo fuera de lo normal y decidir con datos si conviene reparar, vender o reemplazar una unidad.

La pantalla también te muestra qué porcentaje de tu gasto vehicular ya tiene placa asignada, y lista los egresos que faltan por atribuir.

> La placa se valida y se normaliza automáticamente. `WGY123`, `wgy-123` y `WGY 123` quedan como un solo vehículo, no como tres.

---

## 👥 Nuevo: módulo de Empleados y Nómina

*Menú lateral → Recursos → Empleados*

Registrás cada empleado con su tipo de contrato, salario, fechas y clase de riesgo ARL. A partir de ahí el sistema:

**Calcula lo que cada empleado cuesta de verdad.** Mientras escribís el salario, la pantalla te muestra el costo real: salario + auxilio de transporte + prestaciones + aportes. Vas a ver que un empleado con salario mínimo no cuesta $1.750.905 — cuesta cerca de $2.780.000.

**Genera las provisiones mensuales de prestaciones sociales.** Cesantías, intereses a las cesantías, prima y vacaciones se van causando mes a mes como gasto y como obligación acumulada (pasivo), aunque se paguen después.

**Distingue por tipo de contrato.** Un contratista por prestación de servicios no genera prestaciones, y el sistema no se las calcula. Un salario integral tampoco, porque ya van incluidas en el factor prestacional.

**Genera el comprobante de nómina completo:** salario proporcional a los días trabajados, horas extras y recargos, auxilio de transporte, deducciones de ley, y el descuento automático de los anticipos.

### ¿Por qué importa esto?

Si en tu estado de resultados la nómina solo refleja lo que sale de caja, te está faltando el **21,83% del salario base** en prestaciones que ya causaste aunque no las hayas pagado. Sobre una nómina de 15 millones mensuales, son cerca de **$2,5 millones al mes** — unos **$30 millones al año** de costo real que no aparecía en el informe.

---

## ⚠️ Cambio importante: la nómina ya no se registra en Egresos

**Antes:** Egresos → Nuevo egreso → categoría "Nómina" → digitar el valor.

**Ahora:** Empleados → pestaña Nómina → Nuevo comprobante.

### ¿Por qué cambió?

Un pago de nómina registrado como un egreso simple pierde toda la información:

- No calcula las horas extras ni los recargos
- No separa el auxilio de transporte (que no es salario)
- No aplica las deducciones de salud y pensión
- No cruza los anticipos que el empleado pidió durante la quincena
- No causa las prestaciones sociales

Desde el nuevo módulo, todo eso se calcula solo y **el sistema crea el egreso automáticamente**. No tenés que registrarlo dos veces.

Si por costumbre vas a Egresos y elegís una categoría de nómina, el sistema te va a avisar y te lleva al módulo correcto. No te bloquea — hay pagos de personal que sí van por Egresos, como la planilla de seguridad social (PILA), los parafiscales o una liquidación definitiva.

### Los anticipos de nómina sí se siguen registrando en Egresos

Cuando un empleado pide un adelanto de su quincena, lo registrás como siempre desde Egresos. La diferencia es que ahora, **cuando el proveedor coincide con un empleado registrado, el sistema te pregunta si es un anticipo de nómina.**

Si respondés que sí, ese anticipo queda enlazado al empleado y **se descuenta automáticamente** cuando generes el comprobante de nómina del período.

> **Esto corrige un error frecuente y costoso:** un anticipo no es un gasto, es una cuenta por cobrar al empleado. Si se registra como gasto y después se paga el salario completo, el gasto queda contado dos veces.

---

## 🔍 Mejoras en el módulo de Egresos

### Revisión automática mientras digitás

El sistema ahora revisa cada egreso a medida que se registra y avisa cuando algo no cuadra:

- IVA descontable en una categoría de nómina (la nómina no genera IVA)
- IVA que no corresponde al porcentaje declarado
- Gasto de combustible sin placa asignada
- Posible pago duplicado al mismo proveedor
- Categoría sin clasificación contable
- Fecha en un período ya cerrado
- Concepto que no describe el gasto

**No bloquea nada.** Explica qué puede estar mal y por qué importa; quien digita decide. Si guarda con una observación grave, queda marcado para revisarlo después.

### Nueva pestaña "Revisión"

Te da un puntaje de confiabilidad de la información del período y agrupa los problemas por tipo, con la opción de corregirlos en lote. Es la pantalla para mirar **antes** de darle por bueno el estado de resultados del mes.

### Nueva pestaña "Análisis"

Gráficas que responden de un vistazo *"¿por dónde se me está yendo la plata?"*:

- Ingresos vs gastos del período, con el porcentaje del ingreso que consumen los gastos
- Distribución por clasificación contable
- Los 8 rubros más pesados y los 6 terceros a los que más se les paga
- Evolución de los últimos 6 meses
- Consumo por vehículo

### Corrección de egresos ya pagados

Ahora se puede corregir la **categoría, el proveedor, la fecha, el IVA y la retención** de un egreso ya pagado — antes solo el concepto, el monto y las notas.

Requiere PIN y motivo, y queda registrado quién cambió qué, de qué valor a qué valor. Cada egreso tiene un botón 📜 para ver ese historial.

### Reclasificación en lote

Si tenés varios egresos mal categorizados, los seleccionás con los checkboxes y los cambiás todos de una. Requiere PIN y motivo, y **la operación completa se puede revertir**: cada egreso vuelve a la categoría que tenía antes.

### Cierre de período contable

Podés marcar hasta qué fecha está cerrada la contabilidad. A partir de ahí, el sistema alerta si alguien intenta registrar un movimiento con fecha anterior.

---

## ⚙️ Un ajuste que vale la pena revisar con tu contador

En **Empleados → Ajustes** hay una opción llamada *"Exoneración de aportes parafiscales y salud"*.

El artículo 114-1 del Estatuto Tributario exonera a ciertos empleadores de pagar **salud (8,5%), SENA (2%) e ICBF (3%)** por los empleados que ganen menos de 10 salarios mínimos. Son **13,5 puntos porcentuales** sobre la nómina.

Pueden acogerse las sociedades contribuyentes declarantes del impuesto de renta, y las personas naturales empleadoras con dos o más trabajadores.

**Consultalo con tu contador antes de activarlo.** Es una decisión tributaria que depende de la naturaleza jurídica de tu empresa, y el sistema no tiene cómo determinarla solo. Activarlo sin tener derecho genera un pasivo con la UGPP; no activarlo teniendo derecho te hace pagar de más.

En la pantalla está la explicación completa de quiénes aplican y quiénes no.

---

## Por dónde empezar

1. **Empleados → Ajustes** — definí primero el criterio de exoneración
2. **Empleados** — cargá tu personal con tipo de contrato, salario y clase de ARL
3. **Vehículos** — registrá las placas de la empresa
4. **Empleados → Provisiones** — elegí el mes y causá las prestaciones
5. **Egresos → Revisión** — mirá cómo está la calidad de tu información

---

*Cualquier duda, escribinos por el botón de WhatsApp que está abajo a la derecha en la aplicación.*
