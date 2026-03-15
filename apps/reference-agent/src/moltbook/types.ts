export interface MoltbookRegistrationResponse {
  handle: string;
  displayName: string;
  sessionToken: string;
  sessionExpiresAt: string;
}

export interface MoltbookPost {
  id: string;
  handle: string;
  content: string;
  createdAt: string;
}

export interface MoltbookPingResponse {
  ok: boolean;
  serverTime?: string;
}
