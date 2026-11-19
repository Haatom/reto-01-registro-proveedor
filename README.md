# Reto 01 — Agente Conversacional "Registro como Proveedor"

Agente conversacional que automatiza el llenado de formularios de registro como proveedor para Periferia IT Group.

## Levantar en local

```bash
# 1. Instalar dependencias
bun install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env y agregar OPENAI_API_KEY

# 3. Iniciar (front + backend)
bun run dev
```

El servidor arranca en `http://localhost:3000`.

## Variables de entorno requeridas

| Variable | Descripción | Requerida |
|---|---|---|
| `OPENAI_API_KEY` | Clave de API de OpenAI | Sí (para el chat) |
| `LLM_MODEL` | Modelo a usar | No (default: `gpt-4o-mini`) |
| `PORT` | Puerto del servidor | No (default: `3000`) |
| `MAX_ITERATIONS` | Tope de iteraciones por turno | No (default: `25`) |
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
| `GET` | `/api/sessions/:id` | Historial de la sesión |
| `GET` | `/api/health` | Estado del servidor y proveedor LLM |

## Estructura del proyecto

```
reto-01/
├── agent/prompt.md              # System prompt del agente
├── src/
│   ├── server.ts                # API HTTP + ciclo del agente
│   ├── llm/
│   │   ├── adapter.ts           # Interfaz del proveedor LLM
│   │   └── openai.ts            # Implementación OpenAI
│   ├── tools/
│   │   └── proveedor.ts         # 5 herramientas tipadas con zod
│   └── knowledge/
│       └── registro-proveedor.md # Conocimiento del proceso
├── web/index.html               # Front de chat
├── fixtures/                    # Datos de prueba (solo lectura)
├── demo.ts                      # Verificación sin modelo
└── SOLUCION.md                  # Planteamiento de la solución
```

## Casos de prueba

| Caso | País | Formato | Qué prueba |
|---|---|---|---|
| `co-industrias-delta` | CO | xlsx | Caso estándar Colombia con datos bancarios |
| `ec-corp-andina` | EC | pdf | Ecuador, ID tributario extranjero, soporte ausente |
| `hn-agroexport-sula` | HN | xlsx | Honduras, campos faltantes, soporte vencido |
| `pa-logistica-istmo` | PA | portal | Panamá, formato no implementado → valores para copiar |
