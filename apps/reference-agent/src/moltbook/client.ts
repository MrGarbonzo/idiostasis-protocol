import type { MoltbookRegistrationResponse, MoltbookPost, MoltbookPingResponse } from './types.js';

export class MoltbookClient {
  constructor(private readonly baseUrl: string) {}

  async ping(): Promise<MoltbookPingResponse> {
    return { ok: true };
  }

  async register(_handle: string, _displayName: string): Promise<MoltbookRegistrationResponse> {
    throw new Error('NOT_IMPLEMENTED: MoltbookClient.register');
  }

  async createPost(_sessionToken: string, _content: string): Promise<MoltbookPost> {
    throw new Error('NOT_IMPLEMENTED: MoltbookClient.createPost');
  }

  async getPosts(_handle: string): Promise<MoltbookPost[]> {
    throw new Error('NOT_IMPLEMENTED: MoltbookClient.getPosts');
  }

  async refreshSession(_sessionToken: string): Promise<{ sessionToken: string; sessionExpiresAt: string }> {
    throw new Error('NOT_IMPLEMENTED: MoltbookClient.refreshSession');
  }
}
