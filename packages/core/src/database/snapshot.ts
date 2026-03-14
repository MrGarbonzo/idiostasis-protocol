import { createHash, createCipheriv, createDecipheriv, randomBytes, verify, createPublicKey } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ProtocolDatabase } from './db.js';

export interface DbSnapshot {
  encryptedDb: string;
  iv: string;
  authTag: string;
  sequenceNum: number;
  checksum: string;
  signedBy: string;
  signature: string;
  timestamp: number;
}

const SEQ_CONFIG_KEY = 'snapshot_sequence_num';

export class SnapshotManager {
  private db: ProtocolDatabase;
  private readonly vaultKey: Uint8Array;
  private readonly teeInstanceId: string;

  constructor(db: ProtocolDatabase, vaultKey: Uint8Array, teeInstanceId: string) {
    this.db = db;
    this.vaultKey = vaultKey;
    this.teeInstanceId = teeInstanceId;
  }

  async createSnapshot(
    signer: (data: Uint8Array) => Promise<Uint8Array>,
  ): Promise<DbSnapshot> {
    // Serialize DB to bytes
    const plaintext = this.db.serialize();
    const checksum = createHash('sha256').update(plaintext).digest('hex');

    // Encrypt with vault key (AES-256-GCM)
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.vaultKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encryptedDb = encrypted.toString('base64');

    // Get next sequence number
    const lastSeq = this.db.getConfig(SEQ_CONFIG_KEY);
    const sequenceNum = lastSeq ? parseInt(lastSeq, 10) + 1 : 1;
    this.db.setConfig(SEQ_CONFIG_KEY, String(sequenceNum));

    const timestamp = Date.now();

    // Sign: Ed25519 over concatenation of encryptedDb+sequenceNum+checksum
    const signPayload = `${encryptedDb}${sequenceNum}${checksum}`;
    const signatureBytes = await signer(new Uint8Array(Buffer.from(signPayload)));
    const signature = Buffer.from(signatureBytes).toString('base64');

    return {
      encryptedDb,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      sequenceNum,
      checksum,
      signedBy: this.teeInstanceId,
      signature,
      timestamp,
    };
  }

  verifySnapshot(snapshot: DbSnapshot, expectedSignerKey: Uint8Array): boolean {
    try {
      // Verify Ed25519 signature
      const signPayload = `${snapshot.encryptedDb}${snapshot.sequenceNum}${snapshot.checksum}`;
      const payloadBytes = Buffer.from(signPayload);
      const signatureBytes = Buffer.from(snapshot.signature, 'base64');

      // Import the raw Ed25519 public key
      const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
      const spki = Buffer.concat([ed25519SpkiPrefix, expectedSignerKey]);
      const pubKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });

      const sigValid = verify(null, payloadBytes, pubKey, signatureBytes);
      if (!sigValid) return false;

      // Verify checksum matches decrypted content
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.vaultKey,
        Buffer.from(snapshot.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(snapshot.authTag, 'hex'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(snapshot.encryptedDb, 'base64')),
        decipher.final(),
      ]);
      const computedChecksum = createHash('sha256').update(decrypted).digest('hex');
      return computedChecksum === snapshot.checksum;
    } catch {
      return false;
    }
  }

  validateSequenceNum(snapshot: DbSnapshot, lastKnownSeq: number): boolean {
    return snapshot.sequenceNum > lastKnownSeq;
  }

  async applySnapshot(snapshot: DbSnapshot): Promise<void> {
    // Decrypt
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.vaultKey,
      Buffer.from(snapshot.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(snapshot.authTag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(snapshot.encryptedDb, 'base64')),
      decipher.final(),
    ]);

    // Verify checksum
    const checksum = createHash('sha256').update(decrypted).digest('hex');
    if (checksum !== snapshot.checksum) {
      throw new Error('Snapshot checksum mismatch');
    }

    // Replace DB file
    this.db.close();
    await writeFile(this.db.getDbPath(), decrypted);
    this.db.reinitialize();
  }
}
