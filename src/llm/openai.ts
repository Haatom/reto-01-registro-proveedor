import type { LlmAdapter, LlmMessage, LlmResponse, ToolDefinition } from "./adapter.js";

export class OpenAIAdapter implements LlmAdapter {
  provider = "openai";
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts?: { model?: string; apiKey?: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = opts?.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = opts?.model || process.env.LLM_MODEL || "gpt-4o-mini";
    this.baseUrl = opts?.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    this.timeoutMs = opts?.timeoutMs || 60_000;

    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY no configurada. Revisa tu archivo .env");
    }
  }

  async enviar(mensajes: LlmMessage[], herramientas: ToolDefinition[]): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: mensajes.map((m) => {
          if (m.role === "tool") {
            return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
          }
          if (m.tool_calls && m.tool_calls.length > 0) {
            return { role: m.role, content: m.content, tool_calls: m.tool_calls };
          }
          return { role: m.role, content: m.content };
        }),
        temperature: 0.2,
        max_tokens: 4096,
      };

      if (herramientas.length > 0) {
        body.tools = herramientas;
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

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${text}`);
      }

      const json = (await res.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: "function";
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const choice = json.choices[0];
      return {
        content: choice.message.content,
        tool_calls: choice.message.tool_calls ?? [],
        usage: json.usage,
      };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`Timeout al comunicarse con el proveedor LLM (${this.timeoutMs}ms)`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
