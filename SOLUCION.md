# SOLUCION.md — Reto 01: Registro como Proveedor

## 1. Problema en una frase

La analista administrativa pierde horas transcribiendo los mismos datos corporativos en formularios de registro de proveedores para cada cliente, con riesgo de errores en datos sensibles como NIT y cuentas bancarias, mientras nadie sistematiza dónde están los soportes ni cuáles están vencidos.

**A quién le duele:** A la analista administrativa (retrabajo), a la dirección (dependencia de una persona), y a la empresa (demora en facturación por registros lentos).

---

## 2. Arquitectura

```
┌──────────────────┐    HTTP     ┌────────────────────────────────────┐
│  Front: chat     │ ──────────▶ │  Backend (src/server.ts)           │
│  web/index.html  │ ◀────────── │  ├─ Ciclo del agente               │
│  - historial     │             │  │  (prompt → LLM → tools → reply) │
│  - tool calls    │             │  ├─ Adaptador LLM (src/llm/)       │
│  - confirmación  │             │  │  └─ OpenAI (intercambiable)      │
└──────────────────┘             │  └─ Herramientas (src/tools/)       │
                                 └──────┬──────────────────┬──────────┘
                                        │                  │
                              fixtures/ (lectura)    out/ (escritura)
```

- **Comportamiento**: `agent/prompt.md` — instrucciones al modelo, flujo esperado, reglas.
- **Conocimiento**: `src/knowledge/registro-proveedor.md` — reglas de negocio, mapeo de IDs tributarios, formatos.
- **Ejecución**: `src/tools/proveedor.ts` — 5 herramientas tipadas con zod que son la única fuente de valores.

---

## 3. Ciclo del agente

El ciclo implementa un bucle **tool-calling** con las siguientes características:

1. El usuario envía un mensaje por `/api/chat`.
2. Se inyecta en la sesión (historial de mensajes) y se envía al LLM con las definiciones de herramientas.
3. Si el LLM responde con `tool_calls`, se ejecutan las herramientas, se inyectan los resultados, y se vuelve al paso 2.
4. Si el LLM responde con texto (sin tools), se devuelve como respuesta final.
5. **Tope de iteraciones**: Máximo 25 ciclos herramienta→modelo por turno (`MAX_ITERATIONS`). Al alcanzarlo, se responde con lo procesado hasta el momento.
6. **Tope de tokens**: Se acumula `usage.total_tokens` por sesión. Al exceder `MAX_TOKENS_SESSION`, se informa y se detiene.
7. **Confirmación humana**: Cuando el agente necesita confirmación (ej: simular envío), termina el turno con una pregunta. El front detecta patrones de confirmación y muestra un banner visual. Solo procede si el siguiente mensaje del usuario confirma.

---

## 4. Elección del modelo

| Aspecto | Decisión |
|---|---|
| **Proveedor** | OpenAI |
| **Modelo** | `gpt-4o-mini` |
| **Razón** | Costo/rendimiento óptimo para tool-calling. Soporta bien el flujo de múltiples herramientas secuenciales. API estable y bien documentada. |
| **Costo estimado** | ~$0.01–$0.03 por caso procesado (4-5 tool calls × ~2K tokens prompt + ~500 tokens respuesta por iteración). |
| **Alternativa** | El adaptador LLM es intercambiable. Cambiar a `gpt-4o` o Claude solo requiere una nueva implementación de `LlmAdapter`. |

---

## 5. Diseño del portal web (sección 7.4 del PRD)

### Estrategia de automatización

Para el formato "portal web con usuario y contraseña", la estrategia sería usar **Playwright** (navegador controlado por el agente):

1. **El agente prepara los valores** en un JSON estructurado con `{ campo → valor }`.
2. **Un script Playwright** abre el portal, navega al formulario, y llena cada campo usando selectores CSS.
3. **Límites**: CAPTCHA (requiere intervención humana), MFA (el agente no puede completar 2FA), cambios de layout (requiere actualizar selectores).

### Credenciales

- **NUNCA** en el repositorio, el prompt, ni los logs.
- Se almacenan en un vault (Azure Key Vault, AWS Secrets Manager, o HashiCorp Vault).
- El usuario las ingresa en una interfaz segura que las pasa al script sin persistirlas.

### División humano/agente

| Acción | Responsable |
|---|---|
| Preparar valores del formulario | Agente |
| Ingresar credenciales del portal | Humano |
| Resolver CAPTCHA / MFA | Humano |
| Llenar campos del formulario | Agente (Playwright) |
| Revisar campos llenados | Humano |
| Clic en "Enviar" | Humano |
| Cargar soportes adjuntos | Agente (si el portal lo permite) |

---

## 6. Decisiones y trade-offs

### Trade-off 1: ExcelJS vs opción más ligera
- **Elegido**: ExcelJS para generación de `.xlsx` reales.
- **Descartada**: Generar CSV o JSON como alternativa.
- **Por qué**: El PRD exige que el formulario se produzca "en el mismo formato que envió el cliente". Un CSV no cumple con la estructura de hojas y celdas del Excel original.

### Trade-off 2: OpenAI vs Anthropic como proveedor
- **Elegido**: OpenAI (`gpt-4o-mini`).
- **Descartada**: Anthropic Claude.
- **Por qué**: El soporte de tool-calling de OpenAI es más maduro en la API. gpt-4o-mini ofrece el mejor balance costo/calidad para este flujo de múltiples herramientas secuenciales. El adaptador permite cambiar sin tocar el ciclo.

### Trade-off 3: Frontend HTML plano vs React/Vue
- **Elegido**: HTML plano con CSS y JS vanilla.
- **Descartada**: React.
- **Por qué**: Minimiza dependencias y tiempo de setup. El chat es suficientemente simple para no necesitar un framework. Arranca sin build step.

---

## 7. Supuestos

1. Los fixtures representan la variabilidad real de los clientes. En producción habrá plantillas más complejas.
2. El repositorio maestro está actualizado. En producción necesitaría un dueño del dato y un proceso de actualización.
3. Los soportes tienen vigencias fijas. En producción, la vigencia de la Cámara de Comercio se calcula desde la fecha de emisión (30 días).
4. El glosario de sinónimos cubre las etiquetas más comunes. En producción, el modelo podría proponer mapeos para etiquetas desconocidas (con confirmación humana).
5. Un solo representante legal firma todos los formularios.

---

## 8. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1: Leer solicitud | ✅ Hecho | Parsing de plantillas Excel reales (no JSON) |
| HU-2: Mapear campos | ✅ Hecho | Mapeo fuzzy para etiquetas no previstas en el glosario |
| HU-3: Generar formulario xlsx | ✅ Hecho | Respetar formato visual de la plantilla original |
| HU-3: Generar formulario pdf | ✅ Hecho | Rellenar AcroForms del PDF original en vez de generar nuevo |
| HU-3: Formato portal | ✅ Hecho (valores-portal.md) | Implementar automatización con Playwright |
| HU-4: Armar paquete | ✅ Hecho | Integración con SharePoint real para soportes |
| HU-5: Manejo de errores | ✅ Hecho | Más casos edge, retry con backoff para LLM |

---

## 9. Uso de IA

| Asistente | Para qué |
|---|---|
| **Claude (Anthropic)** | Diseño de la arquitectura, generación de código del proyecto completo (herramientas, servidor, frontend, demo), revisión de la cobertura de criterios de aceptación. |

**Qué descarté:** Sugerencias de usar frameworks pesados (NestJS, Next.js) que añadirían complejidad sin beneficio para un reto de este alcance. También descarté generar el prompt del agente con IA — lo escribí con base en las reglas del PRD para mantener el control sobre el comportamiento.

---

## 10. Riesgos de producción

| Riesgo | Mitigación |
|---|---|
| El modelo "completa" un campo faltante con un valor plausible | Las herramientas son la única fuente de valores. El prompt lo prohíbe. La validación zod refuerza la estructura. |
| Plantillas Excel con formatos complejos (celdas combinadas, listas desplegables) | Usar `openpyxl` o `ExcelJS` para leer la plantilla original y rellenarla, en vez de crear una nueva. |
| Soportes vencidos detectados tarde | Automatizar alertas periódicas de vencimiento próximo. |
| Portales web con CAPTCHA o MFA | El humano opera el portal; el agente prepara los valores en formato copiable. |
| Rotación de personal | El conocimiento está sistematizado en archivos, no en la cabeza de una persona. |
