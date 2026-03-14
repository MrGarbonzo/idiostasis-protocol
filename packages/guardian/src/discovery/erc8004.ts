import type { ERC8004Client } from '@idiostasis/erc8004-client';

/**
 * ERC-8004 discovery — wraps the ERC8004Client to provide
 * primary agent discovery for the guardian.
 */
export class Erc8004Discovery {
  private readonly client: ERC8004Client;
  private readonly agentTokenId: number;

  constructor(client: ERC8004Client, agentTokenId: number) {
    this.client = client;
    this.agentTokenId = agentTokenId;
  }

  async discoverPrimary(): Promise<string | null> {
    return this.client.getLivePrimaryAddress(this.agentTokenId);
  }
}
