import { readFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod";
import type { LlmAdapter, LlmMessage, ToolDefinition, ToolCall } from "./llm/adapter.js";
import { OpenAIAdapter } from "./llm/openai.js";
import * as proveedorTools from "./tools/proveedor.js";

// ─── Configuración ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000");
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || "25");
const MAX_TOKENS_SESSION = parseInt(process.env.MAX_TOKENS_SESSION || "200000");
const PROJECT_DIR = resolve(import.meta.dirname, "..");

// ─── Registro de herramientas ────────────────────────────────────
type ToolEntry = {
  name: string;
  description: string;
  args: Record<string, z.ZodTypeAny>;
  execute: (args: Record<string, unknown>, ctx: { directory: string; sessionId: string }) => Promise<string>;
};

const tools: Map<string, ToolEntry> = new Map();

function registerTool(prefix: string, exportName: string, tool: { description: string; args: Record<string, z.ZodTypeAny>; execute: (args: never, ctx: never) => Promise<string> }) {
  const name = `${prefix}_${exportName}`;
  tools.set(name, {
    name,
    description: tool.description,
    args: tool.args,
    execute: tool.execute as ToolEntry["execute"],
  });
}

// Registrar herramientas de proveedor
for (const [name, tool] of Object.entries(proveedorTools)) {
  if (typeof tool === "object" && "description" in tool && "execute" in tool) {
    registerTool("proveedor", name, tool as never);
  }
}

// ─── Convertir args zod a JSON Schema para el modelo ─────────────
function zodToJsonSchema(args: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, schema] of Object.entries(args)) {
    const desc = schema.description || key;
    if (schema instanceof z.ZodString) {
      properties[key] = { type: "string", description: desc };
      required.push(key);
    } else if (schema instanceof z.ZodBoolean) {
      properties[key] = { type: "boolean", description: desc };
      required.push(key);
    } else if (schema instanceof z.ZodNumber) {
      properties[key] = { type: "number", description: desc };
      required.push(key);
    } else if (schema instanceof z.ZodArray) {
      properties[key] = { type: "array", items: { type: "string" }, description: desc };
      required.push(key);
    } else if (schema instanceof z.ZodObject) {
      properties[key] = { type: "object", description: desc };
      required.push(key);
    } else {
      properties[key] = { type: "string", description: desc };
    }
  }

  return { type: "object", properties, required };
}

function getToolDefinitions(): ToolDefinition[] {
  return Array.from(tools.values()).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.args),
    },
  }));
}

// ─── Sesiones ────────────────────────────────────────────────────
interface Session {
  id: string;
  messages: LlmMessage[];
  tokensUsed: number;
  createdAt: string;
}

const sessions = new Map<string, Session>();

function getOrCreateSession(id: string): Session {
  if (!sessions.has(id)) {
    const systemPrompt = readFileSync(join(PROJECT_DIR, "agent", "prompt.md"), "utf-8");
    const knowledge = readFileSync(join(PROJECT_DIR, "src", "knowledge", "registro-proveedor.md"), "utf-8");

    sessions.set(id, {
      id,
      messages: [
        { role: "system", content: `${systemPrompt}\n\n---\n\n${knowledge}` },
      ],
      tokensUsed: 0,
      createdAt: new Date().toISOString(),
    });
  }
  return sessions.get(id)!;
}

// ─── Ciclo del agente ────────────────────────────────────────────
async function agentLoop(
  session: Session,
  userMessage: string,
  llm: LlmAdapter
): Promise<{ reply: string; toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>; needsConfirmation: boolean }> {
  session.messages.push({ role: "user", content: userMessage });

  const toolCallsLog: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];
  const toolDefs = getToolDefinitions();
  let iterations = 0;
  let needsConfirmation = false;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // CA1: Tope de tokens
    if (session.tokensUsed > MAX_TOKENS_SESSION) {
      const msg = `Se alcanzó el límite de tokens de la sesión (${MAX_TOKENS_SESSION}). Por favor inicia una nueva sesión.`;
      session.messages.push({ role: "assistant", content: msg });
      return { reply: msg, toolCalls: toolCallsLog, needsConfirmation: false };
    }

    let response;
    try {
      response = await llm.enviar(session.messages, toolDefs);
    } catch (e) {
      const errorMsg = `Error al comunicarse con el modelo: ${e instanceof Error ? e.message : String(e)}`;
      session.messages.push({ role: "assistant", content: errorMsg });
      return { reply: errorMsg, toolCalls: toolCallsLog, needsConfirmation: false };
    }

    if (response.usage) {
      session.tokensUsed += response.usage.total_tokens;
    }

    // Sin tool calls → respuesta final
    if (!response.tool_calls || response.tool_calls.length === 0) {
      const reply = response.content || "No se obtuvo respuesta del modelo.";
      session.messages.push({ role: "assistant", content: reply });

      // CA3: Detectar si pide confirmación
      const confirmPatterns = ["¿desea", "¿quiere", "¿confirma", "¿procedo", "¿procedemos", "confirmar", "confirmación"];
      needsConfirmation = confirmPatterns.some((p) => reply.toLowerCase().includes(p));

      return { reply, toolCalls: toolCallsLog, needsConfirmation };
    }

    // Hay tool calls → ejecutarlas
    session.messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });

    for (const tc of response.tool_calls) {
      const toolName = tc.function.name;
      const tool = tools.get(toolName);

      let result: string;
      if (!tool) {
        result = JSON.stringify({ ok: false, error: `Herramienta "${toolName}" no existe.` });
      } else {
        try {
          const args = JSON.parse(tc.function.arguments);
          // Validar con zod
          const schema = z.object(tool.args);
          const parsed = schema.safeParse(args);

          if (!parsed.success) {
            result = JSON.stringify({
              ok: false,
              error: `Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
            });
          } else {
            result = await tool.execute(parsed.data as Record<string, unknown>, {
              directory: PROJECT_DIR,
              sessionId: session.id,
            });
          }
        } catch (e) {
          result = JSON.stringify({
            ok: false,
            error: `Error ejecutando herramienta: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }

      toolCallsLog.push({
        name: toolName,
        args: JSON.parse(tc.function.arguments),
        result: result.length > 500 ? result.slice(0, 500) + "..." : result,
      });

      session.messages.push({
        role: "tool",
        content: result,
        tool_call_id: tc.id,
      });

      // Log global
      const logDir = join(PROJECT_DIR, "out");
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        join(logDir, "log.jsonl"),
        JSON.stringify({
          ts: new Date().toISOString(),
          sessionId: session.id,
          herramienta: toolName,
          args: JSON.parse(tc.function.arguments),
          ok: result.includes('"ok":true') || result.includes('"ok": true'),
        }) + "\n"
      );
    }
  }

  // CA1: Alcanzó el tope de iteraciones
  const msg = `Se alcanzó el límite de ${MAX_ITERATIONS} iteraciones. Resultados parciales procesados hasta ahora.`;
  session.messages.push({ role: "assistant", content: msg });
  return { reply: msg, toolCalls: toolCallsLog, needsConfirmation: false };
}

// ─── Servidor HTTP ───────────────────────────────────────────────
let llm: LlmAdapter;
try {
  llm = new OpenAIAdapter();
} catch {
  console.warn("⚠️  No se pudo inicializar el adaptador LLM. El chat requiere OPENAI_API_KEY.");
}

const webDir = join(PROJECT_DIR, "web");

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    // Health
    if (url.pathname === "/api/health") {
      return Response.json(
        { ok: true, provider: llm?.provider ?? "none", model: llm?.model ?? "none" },
        { headers: corsHeaders }
      );
    }

    // Chat
    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!llm) {
        return Response.json(
          { error: "LLM no configurado. Configura OPENAI_API_KEY en .env" },
          { status: 500, headers: corsHeaders }
        );
      }

      const body = (await req.json()) as { sessionId?: string; message: string };
      const sessionId = body.sessionId || crypto.randomUUID();
      const session = getOrCreateSession(sessionId);

      try {
        const result = await agentLoop(session, body.message, llm);
        return Response.json(
          { sessionId, ...result },
          { headers: corsHeaders }
        );
      } catch (e) {
        return Response.json(
          { error: `Error del agente: ${e instanceof Error ? e.message : String(e)}` },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Sessions
    if (url.pathname.startsWith("/api/sessions/")) {
      const id = url.pathname.split("/").pop()!;
      const session = sessions.get(id);
      if (!session) {
        return Response.json({ error: "Sesión no encontrada" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(session, { headers: corsHeaders });
    }

    // Servir front estático
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(join(webDir, "index.html"), "utf-8");
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Archivos estáticos del front
    const staticPath = join(webDir, url.pathname);
    if (existsSync(staticPath)) {
      const content = readFileSync(staticPath);
      const ext = url.pathname.split(".").pop() || "";
      const mimeTypes: Record<string, string> = {
        js: "application/javascript",
        css: "text/css",
        html: "text/html",
        json: "application/json",
        png: "image/png",
        svg: "image/svg+xml",
      };
      return new Response(content, {
        headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
      });
    }

    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
  },
});

console.log(`🚀 Servidor iniciado en http://localhost:${PORT}`);
console.log(`📋 Proveedor LLM: ${llm?.provider ?? "no configurado"} / ${llm?.model ?? "-"}`);
console.log(`🔧 Herramientas: ${Array.from(tools.keys()).join(", ")}`);
console.log(`📁 Directorio: ${PROJECT_DIR}`);
