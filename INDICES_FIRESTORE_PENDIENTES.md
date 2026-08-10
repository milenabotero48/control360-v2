# Índice de Firestore pendiente

> **Corrección:** una versión anterior de este documento listaba 8 índices. Al revisarlo
> con detalle, **solo hace falta uno**.
>
> Firestore exige un índice compuesto únicamente cuando una consulta combina un filtro de
> **rango** (`>=`, `<=`, `>`, `<`) con otro campo, o cuando ordena por un campo distinto al
> que filtra. Las consultas de **solo igualdad** —como `userId == X` **y** `documento == Y`—
> las resuelve automáticamente con sus índices de campo único.

---

## El único índice que hay que crear

| Colección | Campos | Dónde se usa |
|---|---|---|
| `egresos` | `userId` (Asc) + `fecha` (Asc) | Detección de pagos duplicados al registrar un egreso |

Es la consulta de `cargarEgresosRecientes` en `backend/routes/egresos.js`: trae los egresos
de los últimos 15 días para avisar si el mismo proveedor ya recibió un pago igual.

**Si no se crea:** el egreso se guarda igual, pero la regla de "posible pago duplicado" no
alcanza a evaluarse y queda un error en los logs. Nada más se rompe.

---

## Cómo crearlo — camino fácil (el link automático)

⚠️ **Importante:** esta consulta corre en el BACKEND, no en el navegador. El error con el
link **no aparece en la consola del navegador** (F12), aparece en los logs de Railway.

1. Entrá a **Railway** → tu proyecto → el servicio del **backend** → pestaña **Logs**
2. En la aplicación, andá a **Egresos → + Nuevo egreso** y registrá uno con un proveedor
   que ya tenga otro pago reciente
3. En los logs vas a ver un error parecido a:

   ```
   FAILED_PRECONDITION: The query requires an index.
   You can create it here: https://console.firebase.google.com/project/.../firestore/indexes?create_composite=...
   ```

4. **Copiá ese link y abrilo.** Firebase se abre con todos los campos ya llenos
5. Dale **Crear índice**
6. Esperá 1 a 5 minutos mientras se construye (aparece "Compilando" y después "Habilitado")

---

## Cómo crearlo — a mano

Si el link no aparece o preferís no esperar:

1. Entrá a la **consola de Firebase** → tu proyecto
2. Menú lateral → **Firestore Database**
3. Pestaña **Índices** (arriba, al lado de "Datos" y "Reglas")
4. Sub-pestaña **Compuesto** → botón **Crear índice**
5. Llenalo así:

   | Campo | Valor |
   |---|---|
   | ID de colección | `egresos` |
   | Campo 1 | `userId` — Ascendente |
   | Campo 2 | `fecha` — Ascendente |
   | Alcance de la consulta | Colección |

6. **Crear** y esperar a que quede en estado "Habilitado"

---

## Verificación

Con el índice ya habilitado:

- [ ] Registrar un egreso con un proveedor y valor que se repitan → debe aparecer la
      alerta amarilla de **"Posible pago duplicado"**
- [ ] Revisar los logs de Railway → no debe quedar ningún `FAILED_PRECONDITION`

---

## Lo que NO necesita índice

Se listan para dejar constancia de que ya se revisaron:

| Colección | Consulta | Por qué no |
|---|---|---|
| `empleados` | `userId ==` + `documento ==` | Solo igualdades |
| `vehiculos` | `userId ==` + `placa ==` | Solo igualdades |
| `provisiones_prestaciones` | `userId ==` + `anio ==` + `mes ==` | Solo igualdades |
| `egresos` | `userId ==` + `reclasificacion.loteId ==` | Solo igualdades |
| `novedades` | `publicada ==` / `automatica ==` | Un solo campo |
| `novedades_lecturas` | `adminId ==` | Un solo campo |
| `audit_logs` | `usuarioId ==` + `documento ==` | Solo igualdades |

---

## Variables de entorno a revisar en Railway

| Variable | Para qué | Si falta |
|---|---|---|
| `RESEND_API_KEY` | Correos de novedades y de cobro | Las novedades se publican igual en la aplicación, pero no salen por correo. Queda el error en el log. |
| `FRONTEND_URL` | El enlace "Ingresar a Control360" dentro de los correos | El botón del correo apunta a la dirección por defecto |

---

## Checklist de verificación general (después del push)

- [ ] **Empleados** → crear un empleado de prueba y ver la vista previa del costo real
- [ ] **Empleados → Ajustes** → definir el criterio de exoneración
- [ ] **Empleados → Provisiones** → elegir un mes y revisar el detalle
- [ ] **Vehículos** → crear un vehículo de prueba
- [ ] **Egresos → Revisión** → correr "Revisar el histórico"
- [ ] **Egresos** → botón 📜 de historial en cualquier egreso
- [ ] **Finanzas → Estado de Resultados** → que la utilidad neta sea la misma arriba y abajo
- [ ] **Finanzas → Flujo de Efectivo** → que los cobros a clientes no salgan en $0
- [ ] **Novedades** → publicar una de prueba **sin** marcar el envío por correo
- [ ] La campanita 🎁 debe mostrar esa novedad de prueba
