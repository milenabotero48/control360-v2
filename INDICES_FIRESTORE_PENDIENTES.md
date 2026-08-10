# Índices de Firestore pendientes de crear

> Crearlos **después del push**, cuando la aplicación esté corriendo con el código nuevo.
>
> **La forma más fácil:** entrar a cada pantalla y usarla. Si falta un índice, Firestore
> devuelve un error con un enlace directo para crearlo con un clic. Este documento es el
> respaldo por si el enlace no aparece o hay que crearlos a mano desde la consola.

---

## Cómo crearlos a mano

Consola de Firebase → **Firestore Database** → pestaña **Índices** → *Crear índice*.
Cada índice tarda 1 a 5 minutos en construirse. Mientras tanto la consulta falla.

---

## Módulo Empleados y Nómina

| Colección | Campos | Se usa en |
|---|---|---|
| `empleados` | `userId` (Asc) + `documento` (Asc) | Validar que no se repita la cédula al crear |
| `provisiones_prestaciones` | `userId` (Asc) + `anio` (Asc) + `mes` (Asc) | Causar y consultar provisiones del mes |

## Módulo Vehículos

| Colección | Campos | Se usa en |
|---|---|---|
| `vehiculos` | `userId` (Asc) + `placa` (Asc) | Validar que no se repita la placa |

## Módulo Egresos

| Colección | Campos | Se usa en |
|---|---|---|
| `egresos` | `userId` (Asc) + `fecha` (Asc) | Detección de pagos duplicados |
| `egresos` | `userId` (Asc) + `reclasificacion.loteId` (Asc) | Revertir una reclasificación en lote |

## Módulo Novedades

| Colección | Campos | Se usa en |
|---|---|---|
| `novedades` | `publicada` (Asc) | Listar las novedades del suscriptor |
| `novedades` | `automatica` (Asc) | Evitar que el calendario repita un aviso |
| `novedades_lecturas` | `adminId` (Asc) | Saber qué ya leyó cada suscriptor |

## Auditoría

| Colección | Campos | Se usa en |
|---|---|---|
| `audit_logs` | `usuarioId` (Asc) + `documento` (Asc) | Historial de cambios de un egreso |

---

## Verificación después de crearlos

Entrar a cada pantalla y comprobar que carga sin error:

- [ ] **Empleados** → crear un empleado de prueba
- [ ] **Empleados → Provisiones** → elegir un mes
- [ ] **Vehículos** → crear un vehículo de prueba
- [ ] **Egresos** → registrar un egreso con un proveedor repetido (debe avisar del posible duplicado)
- [ ] **Egresos** → botón 📜 de historial en cualquier egreso
- [ ] **Novedades** → publicar una de prueba sin marcar el envío por correo
- [ ] La campanita 🎁 debe mostrar la novedad de prueba

---

## Variables de entorno a revisar

| Variable | Dónde | Para qué |
|---|---|---|
| `RESEND_API_KEY` | Railway (backend) | Correos de novedades y de cobro. **Si falta, las novedades se publican igual en la app** pero no salen por correo (queda el error en el log). |
| `FRONTEND_URL` | Railway (backend) | El enlace "Ingresar a Control360" dentro de los correos |
