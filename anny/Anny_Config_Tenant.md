# Configuración de Anny por suscriptor (tenant)

El prompt de Anny es **uno solo para toda la plataforma**. Lo que cambia por
suscriptor son las variables de abajo y los datos de su base.

Esto respeta el principio de Control360: una sola arquitectura adaptable a
verticales, no un prompt distinto por cliente.

---

## Las 3 capas

```
┌─────────────────────────────────────────────────────────┐
│  CAPA 1 — PROMPT BASE (Anny_Prompt_PEGAR.txt)           │
│  Igual para todos los suscriptores. Versionado.         │
│  Regla de no inventar, flujos, escalamiento, tono.      │
│  Si cambia, cambia para todos → correr banco de pruebas.│
├─────────────────────────────────────────────────────────┤
│  CAPA 2 — VARIABLES DEL TENANT (tabla de abajo)         │
│  Marca, tratamiento, reglas del oficio.                 │
│  Se inyectan en {{llaves}} al construir el prompt.      │
├─────────────────────────────────────────────────────────┤
│  CAPA 3 — DATOS (consultas en vivo)                     │
│  Catálogo, precios, clientes, horarios, equipos.        │
│  NUNCA en el prompt. Siempre por consulta.              │
└─────────────────────────────────────────────────────────┘
```

**El error de hoy es que la capa 3 está metida en la capa 1.** Por eso Anny
cotizó $42.000 y $8.500 para lo mismo.

---

## Variables por suscriptor

| Variable | Qué es | Ejemplo (Extintores del Valle) |
|---|---|---|
| `asistente_nombre` | Cómo se llama el asistente de ese suscriptor | Anny |
| `empresa_nombre` | Nombre comercial exacto | Extintores del Valle |
| `empresa_descripcion` | Una línea de qué hace | Recarga y venta de extintores y elementos de seguridad industrial |
| `tratamiento` | USTED o TÚ | USTED |
| `reglas_del_negocio` | Bloque de conocimiento técnico del oficio | Criterios de recarga vs. mantenimiento, anillos del cilindro, normativa |
| `sla_escalamiento` | Tiempo prometido de respuesta humana | 30 minutos en horario de atención |

> ⚠️ En los chats revisados aparecen **dos marcas**: "Extintores del Valle" y
> "Extintores del Sur". Si son dos suscriptores distintos, cada uno necesita su
> propio registro. Si es una sola empresa, la variable está cruzada y hay que
> corregirla — hoy Anny le dice a un mismo cliente nombres distintos.

---

## Lo que NO debe estar en el prompt de ningún tenant

- Precios de cualquier tipo
- Metrajes, capacidades, dimensiones
- Horarios y direcciones
- Nombres de productos o listas de catálogo
- Datos de cuentas bancarias

Todo eso sale de consulta. Si está en el prompt, tarde o temprano el modelo
lo va a recordar mal.

---

## Regla de despliegue

1. Cualquier cambio en la **capa 1** afecta a todos los suscriptores
   → correr el banco de pruebas completo antes de publicar.
2. Cambios en la **capa 2** afectan solo a ese tenant
   → correr las pruebas de identidad y de reglas del oficio.
3. Cambios en la **capa 3** (catálogo, precios)
   → correr las pruebas de precio y alias de ese tenant.

Si falla una sola prueba de precio o especificación, no se publica.
