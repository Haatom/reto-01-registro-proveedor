// Interfaz del adaptador LLM — cambiar de proveedor no toca el ciclo del agente
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface LlmAdapter {
  enviar(mensajes: LlmMessage[], herramientas: ToolDefinition[]): Promise<LlmResponse>;
  provider: string;
  model: string;
}
