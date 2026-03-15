import type { AgentStateAdapter } from '@idiostasis/core';
import type { MoltbookState } from './schema.js';
import { createInitialState } from './schema.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MoltbookStateAdapter implements AgentStateAdapter {
  private state: MoltbookState;

  constructor(handle: string, displayName: string) {
    this.state = createInitialState(handle, displayName);
  }

  async serialize(): Promise<Uint8Array> {
    return encoder.encode(JSON.stringify(this.state));
  }

  async deserialize(data: Uint8Array): Promise<void> {
    const parsed = JSON.parse(decoder.decode(data)) as Record<string, unknown>;
    if (typeof parsed.agentHandle !== 'string') {
      throw new Error('MoltbookStateAdapter: missing agentHandle');
    }
    if (typeof parsed.createdAt !== 'string') {
      throw new Error('MoltbookStateAdapter: missing createdAt');
    }
    this.state = parsed as unknown as MoltbookState;
  }

  async onSuccessionComplete(): Promise<void> {
    this.state.recoveryCount += 1;
    this.state.lastRecoveryAt = new Date().toISOString();
  }

  async verify(): Promise<boolean> {
    return (
      typeof this.state.agentHandle === 'string' &&
      this.state.agentHandle.length > 0 &&
      typeof this.state.createdAt === 'string' &&
      this.state.createdAt.length > 0
    );
  }

  getState(): MoltbookState {
    return this.state;
  }

  updateCredentials(sessionToken: string, expiresAt: string): void {
    this.state.credentials.sessionToken = sessionToken;
    this.state.credentials.sessionExpiresAt = expiresAt;
  }
}
