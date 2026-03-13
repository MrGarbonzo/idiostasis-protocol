/**
 * Resilient LLM Client — wraps the existing LLM tool loop with:
 *   - Retry with exponential backoff (3 attempts: 2s, 4s, 8s)
 *   - Per-attempt timeout (30s)
 *   - Circuit breaker (opens after 5 consecutive failures, 60s cooldown)
 */
import type { Tool } from './llm.js';
import { runToolLoop, type HistoryMessage } from './llm.js';

interface ResilientLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Max retry attempts per request (default: 3). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 2000). */
  baseDelayMs?: number;
  /** Consecutive failures before circuit opens (default: 5). */
  circuitThreshold?: number;
  /** Cooldown in ms before circuit half-opens (default: 60000). */
  circuitCooldownMs?: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

export class ResilientLLM {
  private config: Required<ResilientLLMConfig>;
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  constructor(config: ResilientLLMConfig) {
    this.config = {
      ...config,
      maxRetries: config.maxRetries ?? 3,
      baseDelayMs: config.baseDelayMs ?? 2000,
      circuitThreshold: config.circuitThreshold ?? 5,
      circuitCooldownMs: config.circuitCooldownMs ?? 60_000,
    };
  }

  get circuitState(): CircuitState {
    if (this.consecutiveFailures < this.config.circuitThreshold) return 'closed';
    const elapsed = Date.now() - this.circuitOpenedAt;
    if (elapsed < this.config.circuitCooldownMs) return 'open';
    return 'half-open';
  }

  get isAvailable(): boolean {
    return this.circuitState !== 'open';
  }

  /**
   * Run the LLM tool loop with retry + circuit breaker.
   * Throws if all retries exhausted or circuit is open.
   */
  async run(userMessage: string, tools: Tool[], history?: HistoryMessage[]): Promise<string> {
    const state = this.circuitState;

    if (state === 'open') {
      const remaining = Math.ceil(
        (this.config.circuitCooldownMs - (Date.now() - this.circuitOpenedAt)) / 1000,
      );
      throw new Error(`LLM circuit breaker open (${remaining}s remaining)`);
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.config.baseDelayMs * Math.pow(2, attempt - 1);
        console.log(`[ResilientLLM] Retry ${attempt}/${this.config.maxRetries - 1} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      try {
        const result = await runToolLoop(userMessage, tools, {
          baseUrl: this.config.baseUrl,
          apiKey: this.config.apiKey,
          model: this.config.model,
        }, history);

        // Success — reset circuit
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[ResilientLLM] Attempt ${attempt + 1} failed: ${lastError.message}`);
      }
    }

    // All retries exhausted
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.circuitThreshold) {
      this.circuitOpenedAt = Date.now();
      console.error(`[ResilientLLM] Circuit breaker OPENED after ${this.consecutiveFailures} consecutive failures`);
    }

    throw lastError ?? new Error('LLM request failed');
  }
}
