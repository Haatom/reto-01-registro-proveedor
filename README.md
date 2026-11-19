# Reto 01 — Agente Conversacional "Registro como Proveedor"

Agente conversacional que automatiza el llenado de formularios de registro como proveedor para Periferia IT Group.

## 🌐 Demo en producción

**URL pública:** [https://reto-01-registro-proveedor-six.vercel.app](https://reto-01-registro-proveedor-six.vercel.app)

El revisor puede probar el agente directamente desde el enlace anterior. La aplicación está desplegada en Vercel con funciones serverless.

## Proveedor de IA: KimiAI (Moonshot)

Este proyecto utiliza **KimiAI** (Moonshot AI) como proveedor de modelo de lenguaje. KimiAI ofrece una API compatible con el estándar OpenAI, lo que facilita la integración.

- **Base URL:** `https://api.moonshot.ai/v1`
- **Endpoint:** `/v1/chat/completions`
- **Modelo por defecto:** `kimi-k2.6`
- **Autenticación:** Bearer token (`MOONSHOT_API_KEY`)
- **Formato:** Compatible con OpenAI (messages, tools, tool_choice)

### Historial de cambios de proveedor LLM

| Fecha | Proveedor | Motivo |
|---|---|---|
| Inicial | OpenAI (`gpt-4o-mini`) | Implementación original |
| Cambio 1 | Anthropic (`claude-sonnet-4`) | La cuenta OpenAI no tenía créditos |
| Cambio 2 | **KimiAI** (`kimi-k2.6`) | Proveedor final seleccionado por el usuario |

### Cambios realizados para KimiAI

1. **`api/chat.ts`**: Se reemplazó `AnthropicAdapter` por `KimiAdapter`. El nuevo adaptador usa el formato OpenAI-compatible:
   - Los mensajes se envían en formato estándar (`role`, `content`, `tool_calls`)
   - Las herramientas se definen con `type: "function"` y `tool_choice: "auto"`
   - La respuesta se lee de `choices[0].message`
   - Variable de entorno: `MOONSHOT_API_KEY`

2. **`api/health.ts`**: Se actualizó el endpoint de salud para reflejar `provider: "kimi"` y `model: "kimi-k2.6"`.

3. **Variables de entorno en Vercel**: Se debe configurar `MOONSHOT_API_KEY` con la clave de API de KimiAI en el panel de Vercel.

## Levantar en local

```bash
# 1. Instalar dependencias
bun install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env y agregar MOONSHOT_API_KEY

# 3. Iniciar (front + backend)
bun run dev
```

El servidor arranca en `http://localhost:3000`.

## Variables de entorno requeridas

| Variable | Descripción | Requerida |
|---|---|---|
| `MOONSHOT_API_KEY` | Clave de API de KimiAI (Moonshot) | Sí (para el chat) |
| `LLM_MODEL` | Modelo a usar | No (default: `kimi-k2.6`) |
| `PORT` | Puerto del servidor | No (default: `3000`) |
| `MAX_ITERATIONS` | Tope de iteraciones por turno | No (default: `15` en Vercel) |
| `MAX_TOKENS_SESSION` | Tope de tokens por sesión | No (default: `200000`) |

## Correr demo sin modelo

```bash
bun install && bun run demo.ts
```

Procesa los 4 casos del buzón llamando directamente a las herramientas, sin necesidad de API key.

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → respuesta del agente |
| `GET` | `/api/health` | Estado del servidor y proveedor LLM |

## Estructura del proyecto

```
reto-01/
├── agent/prompt.md              # System prompt del agente
├── api/
│   ├── chat.ts                  # Handler serverless (agente + KimiAdapter)
│   └── health.ts                # Endpoint de salud
├── src/
│   ├── llm/
│   │   └── adapter.ts           # Interfaz del proveedor LLM
│   ├── tools/
│   │   └── proveedor.ts         # 5 herramientas tipadas con zod
│   └── knowledge/
│       └── registro-proveedor.md # Conocimiento del proceso
├── public/index.html            # Front de chat (desplegado en Vercel)
├── fixtures/                    # Datos de prueba (solo lectura)
├── demo.ts                      # Verificación sin modelo
├── vercel.json                  # Configuración de Vercel
└── SOLUCION.md                  # Planteamiento de la solución
```

## Herramientas del agente

| Herramienta | Descripción |
|---|---|
| `proveedor_leer_solicitud` | Lee la solicitud de un caso y extrae campos, formato y soportes |
| `proveedor_mapear_campos` | Cruza campos contra el maestro usando glosario de sinónimos |
| `proveedor_generar_formulario` | Genera el formulario en el formato solicitado (xlsx/pdf/portal) |
| `proveedor_armar_paquete` | Arma el paquete: copia soportes, verifica vigencia, genera checklist |
| `proveedor_simular_envio` | Simula el envío del paquete al cliente (requiere confirmación) |

## Reglas de negocio

- **RN1:** Identificadores tributarios extranjeros requieren confirmación
- **RN2:** No incluir datos bancarios en correos
- **RN3:** Verificar vigencia de soportes
- **RN4:** El envío requiere confirmación explícita del usuario

## Casos de prueba

| Caso | País | Formato | Qué prueba |
|---|---|---|---|
| `co-industrias-delta` | CO | xlsx | Caso estándar Colombia con datos bancarios |
| `ec-corp-andina` | EC | pdf | Ecuador, ID tributario extranjero, soporte ausente |
| `hn-agroexport-sula` | HN | xlsx | Honduras, campos faltantes, soporte vencido |
| `pa-logistica-istmo` | PA | portal | Panamá, formato no implementado → valores para copiar |

## Despliegue en Vercel

El proyecto está configurado para Vercel serverless:
- Los archivos en `api/` se despliegan como funciones serverless (Node.js auto-detectado)
- `public/index.html` se sirve como frontend estático
- `vercel.json` configura las rutas y el `includeFiles` para bundlear fixtures
- Configurar `MOONSHOT_API_KEY` en Settings → Environment Variables del proyecto en Vercel
