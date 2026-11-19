import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, appendFileSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod";
import type { LlmAdapter, LlmMessage, LlmResponse, ToolDefinition } from "../src/llm/adapter.js";

// ─── Tipos ──────────────────────────────────────────────────────
type ToolResult = string;
type Ctx = { directory: string; sessionId: string };
type ToolEntry = {
  name: string;
  description: string;
  args: Record<string, z.ZodTypeAny>;
  execute: (args: Record<string, unknown>, ctx: Ctx) => Promise<string>;
};

// ─── Config ─────────────────────────────────────────────────────
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || "15");
const MAX_TOKENS_SESSION = parseInt(process.env.MAX_TOKENS_SESSION || "200000");
// Resolución robusta del directorio raíz del proyecto en Vercel serverless.
// En Vercel, process.cwd() = /var/task y los archivos incluidos via includeFiles
// están en /var/task/. Usamos process.cwd() como método principal.
const PROJECT_DIR = process.cwd();

// ─── Helpers de herramientas (inlined para serverless) ──────────
function ok(data: unknown): ToolResult {
  return JSON.stringify({ ok: true, data });
}

function fail(error: string): ToolResult {
  return JSON.stringify({ ok: false, error });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── KimiAI / Moonshot Adapter (OpenAI-compatible) ──────────────
class KimiAdapter implements LlmAdapter {
  provider = "kimi";
  model: string;
  private apiKey: string;
  private timeoutMs: number;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.MOONSHOT_API_KEY || "";
    this.model = process.env.LLM_MODEL || "kimi-k2.6";
    this.baseUrl = process.env.KIMI_BASE_URL || "https://api.moonshot.ai/v1";
    this.timeoutMs = 55_000;

    if (!this.apiKey) throw new Error("MOONSHOT_API_KEY no configurada");
  }

  async enviar(mensajes: LlmMessage[], herramientas: ToolDefinition[]): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Construir mensajes en formato OpenAI
      const apiMessages: Array<Record<string, unknown>> = [];

      for (const m of mensajes) {
        if (m.role === "system") {
          apiMessages.push({ role: "system", content: m.content || "" });
          continue;
        }
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
          const msg: Record<string, unknown> = { role: "assistant" };
          if (m.content) msg.content = m.content;
          msg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
          apiMessages.push(msg);
          continue;
        }
        if (m.role === "tool") {
          apiMessages.push({
            role: "tool",
            tool_call_id: m.tool_call_id,
            content: m.content || "",
          });
          continue;
        }
        apiMessages.push({ role: m.role, content: m.content || "" });
      }

      // Construir body OpenAI-compatible
      const body: Record<string, unknown> = {
        model: this.model,
        messages: apiMessages,
        max_tokens: 4096,
      };
      if (herramientas.length > 0) {
        body.tools = herramientas.map((h) => ({
          type: "function",
          function: {
            name: h.function.name,
            description: h.function.description,
            parameters: h.function.parameters,
          },
        }));
        body.tool_choice = "auto";
      }

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) { const text = await res.text(); throw new Error(`Kimi API error ${res.status}: ${text}`); }

      const json = (await res.json()) as any;
      const choice = json.choices?.[0]?.message;

      if (!choice) throw new Error("Respuesta vacía de Kimi API");

      const textContent = choice.content || "";
      const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

      if (choice.tool_calls && Array.isArray(choice.tool_calls)) {
        for (const tc of choice.tool_calls) {
          toolCalls.push({
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: tc.function.arguments },
          });
        }
      }

      const usage = json.usage ? {
        prompt_tokens: json.usage.prompt_tokens,
        completion_tokens: json.usage.completion_tokens,
        total_tokens: json.usage.total_tokens,
      } : undefined;

      return { content: textContent || null, tool_calls: toolCalls, usage };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new Error("Timeout LLM (55s)");
      throw e;
    } finally { clearTimeout(timer); }
  }
}

// ─── Definición de herramientas de proveedor ────────────────────
function buildTools(projectDir: string) {
  const fixturesDir = join(projectDir, "fixtures", "reto-01");
  const tools = new Map<string, ToolEntry>();

  // 1. leer_solicitud
  tools.set("proveedor_leer_solicitud", {
    name: "proveedor_leer_solicitud",
    description: "Lee la solicitud de registro de un caso y retorna los campos solicitados, formato, soportes exigidos y correo del cliente.",
    args: { caso: z.string().describe("Nombre del caso, ej: co-industrias-delta") },
    execute: async (args: any, ctx: Ctx) => {
      const caso = args.caso as string;
      const casoDir = join(fixturesDir, "casos", caso);
      if (!existsSync(casoDir)) return fail(`Caso "${caso}" no encontrado en fixtures/reto-01/casos/`);

      const solicitud = readJson(join(casoDir, "solicitud.json")) as any;
      let campos: string[] = [];
      let formato = solicitud.formato_respuesta || "desconocido";
      const correo = solicitud.correo_cliente || solicitud.correo || "no-especificado";

      // Detectar campos de plantilla
      const plantillaFile = existsSync(join(casoDir, "plantilla-celdas.json")) ? "plantilla-celdas.json" : existsSync(join(casoDir, "plantilla-campos.json")) ? "plantilla-campos.json" : null;
      if (plantillaFile) {
        const plantilla = readJson(join(casoDir, plantillaFile)) as any;
        if (Array.isArray(plantilla)) campos = plantilla.map((p: any) => p.campo || p.etiqueta || p.label || String(p));
        else if (plantilla.campos) campos = plantilla.campos.map((p: any) => p.campo || p.etiqueta || p.label || String(p));
        else if (plantilla.celdas) campos = plantilla.celdas.map((c: any) => c.etiqueta || c.campo || c.celda || String(c));
      }

      let soportes: string[] = [];
      const sopFile = join(casoDir, "soportes-exigidos.json");
      if (existsSync(sopFile)) {
        const sopData = readJson(sopFile);
        soportes = Array.isArray(sopData) ? sopData : (sopData as any).soportes || [];
      }

      return ok({ caso, campos, formato, soportes, correo, totalCampos: campos.length });
    },
  });

  // 2. mapear_campos
  tools.set("proveedor_mapear_campos", {
    name: "proveedor_mapear_campos",
    description: "Cruza los campos de la solicitud contra el maestro de Periferia usando el glosario de sinónimos. Aplica RN1 (ID tributario extranjero).",
    args: {
      caso: z.string().describe("Nombre del caso"),
      campos: z.array(z.string()).describe("Lista de campos a mapear"),
    },
    execute: async (args: any, ctx: Ctx) => {
      const { caso, campos } = args as { caso: string; campos: string[] };
      const maestro = readJson(join(fixturesDir, "repositorio", "maestro.json")) as Record<string, unknown>;
      const glosario = readJson(join(fixturesDir, "glosario-campos.json")) as Record<string, string>;

      const solicitud = readJson(join(fixturesDir, "casos", caso, "solicitud.json")) as any;
      const pais = solicitud.pais || "CO";

      const resultado = campos.map((campo) => {
        const normalizado = campo.toLowerCase().trim();
        // glosario es un objeto plano { "sinónimo": "campo_maestro" }
        const campoMaestro = Object.entries(glosario).find(([key]) => key.toLowerCase() === normalizado)?.[1] ?? null;
        if (!campoMaestro) return { campo, estado: "no_mapeado", valor: null, campo_maestro: null, nota: "Sin sinónimo en glosario" };

        const valor = getNestedValue(maestro, campoMaestro);
        if (valor === undefined || valor === null) return { campo, estado: "faltante_en_maestro", valor: null, campo_maestro: campoMaestro, nota: "No existe en maestro.json" };

        const idTributarios = ["nit", "rut", "rtn", "ruc", "identificacion_tributaria"];
        const requiereConfirmacion = pais !== "CO" && idTributarios.some((id) => campoMaestro.toLowerCase().includes(id));

        return {
          campo,
          estado: requiereConfirmacion ? "requiere_confirmacion" : "mapeado",
          valor,
          campo_maestro: campoMaestro,
          nota: requiereConfirmacion ? `Identificador tributario extranjero (país: ${pais}). Verificar equivalencia.` : null,
        };
      });

      const resumen = {
        total: resultado.length,
        mapeados: resultado.filter((r) => r.estado === "mapeado").length,
        requieren_confirmacion: resultado.filter((r) => r.estado === "requiere_confirmacion").length,
        no_mapeados: resultado.filter((r) => r.estado === "no_mapeado").length,
        faltantes: resultado.filter((r) => r.estado === "faltante_en_maestro").length,
      };

      return ok({ mapeo: resultado, resumen });
    },
  });

  // 3. generar_formulario
  tools.set("proveedor_generar_formulario", {
    name: "proveedor_generar_formulario",
    description: "Genera el formulario lleno en el formato solicitado (xlsx, pdf, portal). Escribe archivos en /tmp.",
    args: {
      caso: z.string().describe("Nombre del caso"),
      formato: z.string().describe("Formato: xlsx, pdf, portal"),
      campos_mapeados: z.array(z.any()).describe("Array de campos mapeados con valor"),
    },
    execute: async (args: any, ctx: Ctx) => {
      const { caso, formato, campos_mapeados } = args;
      const outDir = `/tmp/out/${caso}`;
      mkdirSync(outDir, { recursive: true });

      if (formato === "xlsx") {
        // En serverless no podemos usar ExcelJS fácilmente, generamos CSV
        const header = "Campo,Valor,Estado,Nota";
        const rows = campos_mapeados.map((c: any) => `"${c.campo}","${c.valor || ""}","${c.estado}","${c.nota || ""}"`);
        const csv = [header, ...rows].join("\n");
        writeFileSync(join(outDir, `formulario-${caso}.csv`), csv);
        return ok({ archivo: `formulario-${caso}.csv`, formato: "csv (compatiblexlsx)", filas: campos_mapeados.length, nota: "En entorno serverless se genera CSV compatible. En local se genera xlsx con ExcelJS." });
      }

      if (formato === "pdf") {
        const lines = campos_mapeados.map((c: any) => `${c.campo}: ${c.valor || "(vacío)"} [${c.estado}]`);
        const content = `FORMULARIO DE REGISTRO — ${caso.toUpperCase()}\n${"=".repeat(50)}\n\n${lines.join("\n")}`;
        writeFileSync(join(outDir, `formulario-${caso}.txt`), content);
        return ok({ archivo: `formulario-${caso}.txt`, formato: "txt (representación del PDF)", filas: campos_mapeados.length });
      }

      if (formato === "portal") {
        const md = campos_mapeados.map((c: any) => `- **${c.campo}**: \`${c.valor || "(vacío)"}\` → copiar al portal`).join("\n");
        const content = `# Valores para el Portal — ${caso}\n\n${md}`;
        writeFileSync(join(outDir, `valores-portal.md`), content);
        return ok({ archivo: "valores-portal.md", formato: "portal (markdown copy-ready)", filas: campos_mapeados.length });
      }

      return fail(`Formato "${formato}" no soportado. Use xlsx, pdf o portal.`);
    },
  });

  // 4. armar_paquete
  tools.set("proveedor_armar_paquete", {
    name: "proveedor_armar_paquete",
    description: "Arma el paquete para firma: copia soportes, verifica vigencia (RN3), genera checklist y borrador de correo (RN2: sin datos bancarios).",
    args: {
      caso: z.string().describe("Nombre del caso"),
      soportes_exigidos: z.array(z.string()).describe("Lista de soportes exigidos"),
    },
    execute: async (args: any, ctx: Ctx) => {
      const { caso, soportes_exigidos } = args;
      const indexPath = join(fixturesDir, "repositorio", "soportes", "index.json");
      const soportesIndex = readJson(indexPath) as Array<{ id: string; archivo: string; vigencia_hasta?: string; descripcion?: string }>;

      const hoy = new Date().toISOString().slice(0, 10);
      const outDir = `/tmp/out/${caso}`;
      mkdirSync(join(outDir, "soportes"), { recursive: true });

      const resultado = soportes_exigidos.map((exigido: string) => {
        const normalizado = exigido.toLowerCase().replace(/[\s_-]+/g, "-");
        const match = soportesIndex.find((s) => s.id.toLowerCase() === normalizado || s.id.toLowerCase().includes(normalizado) || normalizado.includes(s.id.toLowerCase()));
        if (!match) return { soporte: exigido, estado: "ausente", archivo: null, nota: "No encontrado en repositorio" };

        const archivoPath = join(fixturesDir, "repositorio", "soportes", match.archivo);
        if (!existsSync(archivoPath)) return { soporte: exigido, estado: "ausente", archivo: match.archivo, nota: "Archivo referenciado no existe" };

        if (match.vigencia_hasta && match.vigencia_hasta < hoy) {
          return { soporte: exigido, estado: "vencido", archivo: match.archivo, vigencia: match.vigencia_hasta, nota: `Vencido el ${match.vigencia_hasta}` };
        }

        try { copyFileSync(archivoPath, join(outDir, "soportes", match.archivo)); } catch {}
        return { soporte: exigido, estado: "presente", archivo: match.archivo, vigencia: match.vigencia_hasta || "sin_vigencia" };
      });

      const hayVencidos = resultado.some((r: any) => r.estado === "vencido");
      const hayAusentes = resultado.some((r: any) => r.estado === "ausente");
      const listoParaFirma = !hayVencidos && !hayAusentes;

      // Checklist
      const checklist = resultado.map((r: any) => `- [${r.estado === "presente" ? "x" : " "}] ${r.soporte}: ${r.estado}${r.nota ? ` — ${r.nota}` : ""}`);
      writeFileSync(join(outDir, "checklist.md"), `# Checklist de soportes — ${caso}\n\n${checklist.join("\n")}\n\n**Listo para firma:** ${listoParaFirma ? "SÍ ✅" : "NO ❌"}\n`);

      // Borrador correo (RN2: no incluir datos bancarios)
      const solicitud = readJson(join(fixturesDir, "casos", caso, "solicitud.json")) as any;
      const correo = solicitud.correo_cliente || solicitud.correo || "destinatario@empresa.com";
      const borradorCorreo = `Para: ${correo}\nAsunto: Registro como Proveedor — Periferia IT Group\n\nEstimado(a),\n\nAdjunto encontrará la documentación solicitada para el registro de Periferia IT Group como proveedor.\n\nDocumentos adjuntos:\n${resultado.filter((r: any) => r.estado === "presente").map((r: any) => `- ${r.soporte}`).join("\n")}\n${hayVencidos || hayAusentes ? `\nNota: Algunos documentos requieren actualización. Ver checklist adjunto.\n` : ""}\nQuedo atento(a) a cualquier requerimiento adicional.\n\nCordialmente,\nPeriferia IT Group`;
      writeFileSync(join(outDir, "borrador-correo.md"), borradorCorreo);

      return ok({
        soportes: resultado,
        resumen: { total: resultado.length, presentes: resultado.filter((r: any) => r.estado === "presente").length, vencidos: resultado.filter((r: any) => r.estado === "vencido").length, ausentes: resultado.filter((r: any) => r.estado === "ausente").length },
        listoParaFirma,
        archivosGenerados: ["checklist.md", "borrador-correo.md"],
      });
    },
  });

  // 5. simular_envio
  tools.set("proveedor_simular_envio", {
    name: "proveedor_simular_envio",
    description: "Simula el envío del paquete al cliente. Requiere confirmado=true (RN4). Sin confirmación, rechaza.",
    args: {
      caso: z.string().describe("Nombre del caso"),
      confirmado: z.boolean().describe("true si el usuario confirmó el envío"),
    },
    execute: async (args: any, ctx: Ctx) => {
      const { caso, confirmado } = args;
      if (!confirmado) return fail("El envío requiere confirmación explícita del usuario. Pregunte antes de proceder.");

      const outDir = `/tmp/out/${caso}`;
      mkdirSync(outDir, { recursive: true });
      const ts = new Date().toISOString();

      writeFileSync(join(outDir, "ENVIO-SIMULADO.md"), `# Envío Simulado ✅\n\n- **Caso:** ${caso}\n- **Timestamp:** ${ts}\n- **Estado:** ENVIADO (simulación)\n- **Sesión:** ${ctx.sessionId}\n\n> Este archivo confirma que el agente simuló el envío exitosamente.\n`);

      return ok({ caso, estado: "enviado_simulado", timestamp: ts, archivo: "ENVIO-SIMULADO.md" });
    },
  });

  return tools;
}

// ─── Convertir args zod a JSON Schema ───────────────────────────
function zodToJsonSchema(args: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(args)) {
    const desc = schema.description || key;
    if (schema instanceof z.ZodString) { properties[key] = { type: "string", description: desc }; required.push(key); }
    else if (schema instanceof z.ZodBoolean) { properties[key] = { type: "boolean", description: desc }; required.push(key); }
    else if (schema instanceof z.ZodNumber) { properties[key] = { type: "number", description: desc }; required.push(key); }
    else if (schema instanceof z.ZodArray) { properties[key] = { type: "array", items: { type: "string" }, description: desc }; required.push(key); }
    else { properties[key] = { type: "string", description: desc }; }
  }
  return { type: "object", properties, required };
}

// ─── Sesiones en memoria (efímeras en serverless) ───────────────
interface Session { id: string; messages: LlmMessage[]; tokensUsed: number; }
const sessions = new Map<string, Session>();

function getOrCreateSession(id: string): Session {
  if (!sessions.has(id)) {
    const systemPrompt = readFileSync(join(PROJECT_DIR, "agent", "prompt.md"), "utf-8");
    const knowledge = readFileSync(join(PROJECT_DIR, "src", "knowledge", "registro-proveedor.md"), "utf-8");
    sessions.set(id, { id, messages: [{ role: "system", content: `${systemPrompt}\n\n---\n\n${knowledge}` }], tokensUsed: 0 });
  }
  return sessions.get(id)!;
}

// ─── Agent Loop ─────────────────────────────────────────────────
async function agentLoop(session: Session, userMessage: string, llm: LlmAdapter, tools: Map<string, ToolEntry>) {
  session.messages.push({ role: "user", content: userMessage });
  const toolCallsLog: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];
  const toolDefs: ToolDefinition[] = Array.from(tools.values()).map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: zodToJsonSchema(t.args) },
  }));

  let iterations = 0;
  let needsConfirmation = false;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    if (session.tokensUsed > MAX_TOKENS_SESSION) {
      const msg = `Límite de tokens alcanzado (${MAX_TOKENS_SESSION}).`;
      session.messages.push({ role: "assistant", content: msg });
      return { reply: msg, toolCalls: toolCallsLog, needsConfirmation: false };
    }

    const response = await llm.enviar(session.messages, toolDefs);
    if (response.usage) session.tokensUsed += response.usage.total_tokens;

    if (!response.tool_calls || response.tool_calls.length === 0) {
      const reply = response.content || "Sin respuesta del modelo.";
      session.messages.push({ role: "assistant", content: reply });
      const confirmPatterns = ["¿desea", "¿quiere", "¿confirma", "¿procedo", "¿procedemos", "confirmar", "confirmación"];
      needsConfirmation = confirmPatterns.some((p) => reply.toLowerCase().includes(p));
      return { reply, toolCalls: toolCallsLog, needsConfirmation };
    }

    session.messages.push({ role: "assistant", content: response.content, tool_calls: response.tool_calls });

    for (const tc of response.tool_calls) {
      const tool = tools.get(tc.function.name);
      let result: string;
      if (!tool) { result = JSON.stringify({ ok: false, error: `Herramienta "${tc.function.name}" no existe.` }); }
      else {
        try {
          const args = JSON.parse(tc.function.arguments);
          const schema = z.object(tool.args);
          const parsed = schema.safeParse(args);
          if (!parsed.success) result = JSON.stringify({ ok: false, error: `Args inválidos: ${parsed.error.issues.map((i) => `${i.path}: ${i.message}`).join(", ")}` });
          else result = await tool.execute(parsed.data as Record<string, unknown>, { directory: PROJECT_DIR, sessionId: session.id });
        } catch (e) { result = JSON.stringify({ ok: false, error: `Error: ${e instanceof Error ? e.message : String(e)}` }); }
      }
      toolCallsLog.push({ name: tc.function.name, args: JSON.parse(tc.function.arguments), result: result.length > 500 ? result.slice(0, 500) + "..." : result });
      session.messages.push({ role: "tool", content: result, tool_call_id: tc.id });
    }
  }
  return { reply: `Límite de ${MAX_ITERATIONS} iteraciones.`, toolCalls: toolCallsLog, needsConfirmation: false };
}

// ─── Handler ────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const llm = new KimiAdapter();
    const tools = buildTools(PROJECT_DIR);

    const { sessionId: reqSessionId, message } = req.body as { sessionId?: string; message: string };
    if (!message) return res.status(400).json({ error: "message requerido" });

    const sessionId = reqSessionId || crypto.randomUUID();
    const session = getOrCreateSession(sessionId);
    const result = await agentLoop(session, message, llm, tools);

    return res.status(200).json({ sessionId, ...result });
  } catch (e) {
    return res.status(500).json({ error: `Error: ${e instanceof Error ? e.message : String(e)}` });
  }
}
