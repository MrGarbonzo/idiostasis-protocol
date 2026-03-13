import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
/** Tool definition for LLM tool-calling loop. */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<string>;
}

// ── Types for OpenAI-compatible chat completions ────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface CompletionResponse {
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ── Load system prompt ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSystemPrompt(): string {
  // Try deploy/IDENTITY.md first (when running from project root),
  // then fall back to a path relative to compiled output
  const candidates = [
    resolve(__dirname, '../../deploy/IDENTITY.md'),
    resolve(__dirname, '../../../deploy/IDENTITY.md'),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8');
    } catch { /* try next */ }
  }
  // Fallback inline prompt
  return 'You are an Idiostasis Protocol node agent.';
}

// ── Convert our Tool[] to OpenAI tool format ────────────────────

function toOpenAITools(tools: Tool[]): object[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ── Main LLM client ─────────────────────────────────────────────

const MAX_TOOL_ITERATIONS = 5;

/**
 * Run a non-streaming tool-calling loop against the Secret AI endpoint.
 *
 * 1. Send user message + available tools
 * 2. If model returns tool_calls, execute them and send results back
 * 3. Repeat until model returns a text response or max iterations
 */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function runToolLoop(
  userMessage: string,
  tools: Tool[],
  config: LLMConfig,
  history?: HistoryMessage[],
): Promise<string> {
  const systemPrompt = loadSystemPrompt();
  const openaiTools = toOpenAITools(tools);
  const toolMap = new Map(tools.map(t => [t.name, t]));

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    // Inject prior conversation history (user + assistant turns only)
    ...(history ?? []).map(h => ({ role: h.role as ChatMessage['role'], content: h.content })),
    { role: 'user', content: userMessage },
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: false,
    };

    // Only include tools if we have any
    if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    let resp: Response;
    try {
      resp = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error('LLM request timed out after 60s — the AI endpoint may be down');
      }
      throw err;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as CompletionResponse;
    const choice = data.choices?.[0];
    if (!choice) throw new Error('LLM returned no choices');

    const msg = choice.message;

    // If the model wants to call tools
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log(`[llm] Iteration ${i + 1}: ${msg.tool_calls.length} tool call(s): ${msg.tool_calls.map(tc => tc.function.name).join(', ')}`);

      // Add assistant message with tool_calls to conversation
      messages.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.tool_calls,
      });

      // Execute each tool call and add results
      for (const tc of msg.tool_calls) {
        const tool = toolMap.get(tc.function.name);
        if (!tool) {
          console.log(`[llm] Unknown tool: ${tc.function.name}`);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Unknown tool: ${tc.function.name}` }),
          });
          continue;
        }

        try {
          const params = JSON.parse(tc.function.arguments);
          const t0 = Date.now();
          const result = await tool.execute(params);
          console.log(`[llm] ${tc.function.name} executed in ${Date.now() - t0}ms (${result.length} chars)`);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[llm] ${tc.function.name} FAILED:`, errMsg);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: errMsg }),
          });
        }
      }

      continue; // Loop back for next LLM turn
    }

    // Model returned a text response — we're done
    const text = (msg.content ?? '').trim();
    console.log(`[llm] Iteration ${i + 1}: text response (${text.length} chars), finish: ${choice.finish_reason}`);
    return text || 'Hmm, let me try that again. Could you rephrase?';
  }

  return 'I reached the maximum number of tool calls. Please try a simpler request.';
}
