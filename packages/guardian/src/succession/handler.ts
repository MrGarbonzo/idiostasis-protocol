import {
  SuccessionManager,
  SuccessionExhaustedError,
  ProtocolDatabase,
} from '@idiostasis/core';
import type {
  ProtocolConfig,
  SuccessionTransport,
  Erc8004Checker,
} from '@idiostasis/core';

const STAND_DOWN_POLL_INTERVAL_MS = 5_000;
const STAND_DOWN_MAX_WAIT_MS = 120_000;

export class SuccessionHandler {
  private readonly db: ProtocolDatabase;
  private readonly config: ProtocolConfig;
  private readonly vaultKey: Uint8Array;
  private readonly teeInstanceId: string;
  private readonly erc8004Checker: Erc8004Checker;
  private inProgress = false;
  private successionManager: SuccessionManager;
  private transport: SuccessionTransport | null = null;
  private signer: ((data: Uint8Array) => Promise<Uint8Array>) | null = null;

  constructor(
    db: ProtocolDatabase,
    config: ProtocolConfig,
    vaultKey: Uint8Array,
    teeInstanceId: string,
    erc8004Client: Erc8004Checker,
  ) {
    this.db = db;
    this.config = config;
    this.vaultKey = vaultKey;
    this.teeInstanceId = teeInstanceId;
    this.erc8004Checker = erc8004Client;

    this.successionManager = new SuccessionManager(
      db, config, teeInstanceId, vaultKey,
      async (newPrimaryAddress) => {
        await this.pollForStandDown(newPrimaryAddress);
      },
      erc8004Client,
    );
  }

  setTransport(transport: SuccessionTransport): void {
    this.transport = transport;
  }

  setSigner(signer: (data: Uint8Array) => Promise<Uint8Array>): void {
    this.signer = signer;
  }

  async initiate(): Promise<void> {
    console.warn('[succession] initiate() called — starting succession protocol');
    if (this.inProgress) return;
    this.inProgress = true;

    const transport = this.transport;
    const signer = this.signer;
    if (!transport || !signer) {
      console.error('[succession] transport or signer not configured');
      this.inProgress = false;
      return;
    }

    try {
      console.warn('[succession] calling successionManager.initiateSuccession()');
      await this.successionManager.initiateSuccession(transport, signer);
    } catch (err) {
      if (err instanceof SuccessionExhaustedError) {
        console.error('[succession] CRITICAL: all candidates exhausted');
      } else {
        console.error('[succession] unexpected error:', err);
      }
      this.inProgress = false;
    }
  }

  isInProgress(): boolean {
    return this.inProgress;
  }

  private async pollForStandDown(expectedNewPrimary: string): Promise<void> {
    const deadline = Date.now() + STAND_DOWN_MAX_WAIT_MS;

    while (Date.now() < deadline) {
      const stood = await this.successionManager.checkAndStandDown(this.teeInstanceId);
      if (stood) {
        console.log('[succession] stand-down confirmed — new primary registered');
        this.inProgress = false;
        return;
      }
      await new Promise(r => setTimeout(r, STAND_DOWN_POLL_INTERVAL_MS));
    }

    console.warn('[succession] stand-down poll timed out after 2 minutes');
    this.inProgress = false;
  }
}
