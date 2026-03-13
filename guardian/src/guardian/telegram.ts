/**
 * Guardian Telegram Bot — group protocol + DM governance commands.
 * No LLM — just command handlers and protocol message parsing.
 */
import { Bot } from 'grammy';
import type { PeerRegistry } from './peers.js';
import type { DelegationTracker } from './delegations.js';
import type { ProposalManager } from '../sentry/proposals.js';
import type { VotingSystem } from '../sentry/voting.js';
import type { NFTVerifier } from '../sentry/nft-verifier.js';
import type { ConfigGovernance } from '../sentry/config-governance.js';
import type { NFTStakingManager } from './nft-staking.js';
import {
  parseProtocolMessage,
  formatGuardianAnnounce,
  formatDiscoverResponse,
  formatProposalNew,
} from '../shared/telegram-protocol.js';

export interface GuardianTelegramConfig {
  botToken: string;
  groupChatId: string;
  guardianAddress: string;
  guardianEndpoint: string;
  isSentry: boolean;
  isSentryNow?: () => boolean;
  ownerChatId?: number;
}

export interface GuardianBotDeps {
  peers: PeerRegistry;
  proposals: ProposalManager;
  voting: VotingSystem;
  delegations: DelegationTracker;
  nftVerifier: NFTVerifier;
  nftStaking?: NFTStakingManager;
  configGov?: ConfigGovernance;
  broadcastToGroup?: (msg: string) => void;
}

/** Send a DM to the owner (no-op if no owner configured). */
async function dmOwner(bot: Bot, ownerChatId: number | undefined, message: string): Promise<void> {
  if (!ownerChatId) return;
  try {
    await bot.api.sendMessage(ownerChatId, message);
  } catch (err: unknown) {
    console.error('[Guardian TG] Failed to DM owner:', err);
  }
}

export function createGuardianBot(
  config: GuardianTelegramConfig,
  deps: GuardianBotDeps,
): Bot {
  const bot = new Bot(config.botToken);
  const groupId = Number(config.groupChatId);
  const startTime = Date.now();

  // ── Group protocol handler ────────────────────────────────────

  bot.on('message:text', async (ctx, next) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // Only handle protocol messages in the designated group
    if (chatId !== groupId) {
      return next();
    }

    const msg = parseProtocolMessage(text);
    if (!msg) return next();

    switch (msg.kind) {
      case 'discover_request': {
        console.log('[Guardian TG] Received DISCOVER:REQUEST, responding...');
        const response = formatDiscoverResponse({
          address: config.guardianAddress,
          endpoint: config.guardianEndpoint,
          isSentry: config.isSentryNow?.() ?? config.isSentry,
        });
        await ctx.reply(response);
        break;
      }

      case 'agent_announce': {
        const { endpoint, teeId, codeHash } = msg.data;
        console.log(`[Guardian TG] Agent announced: ${endpoint} (TEE: ${teeId})`);
        // Record agent as a special peer
        deps.peers.upsert({
          address: `agent:${teeId}`,
          endpoint,
          metadata: JSON.stringify({ teeId, codeHash, type: 'agent' }),
        });
        break;
      }

      case 'guardian_announce': {
        const { address, endpoint, isSentry } = msg.data;
        console.log(`[Guardian TG] Guardian announced: ${address} at ${endpoint}`);
        deps.peers.upsert({ address, endpoint, isSentry });
        break;
      }

      case 'proposal_new': {
        console.log(`[Guardian TG] New proposal: ${msg.data.id} (${msg.data.type})`);
        await dmOwner(bot, config.ownerChatId,
          `New proposal: ${msg.data.id}\n` +
          `Type: ${msg.data.type}\n` +
          `Threshold: ${msg.data.thresholdPct}%, Deadline: ${msg.data.deadline}\n\n` +
          `Vote: /vote ${msg.data.id} approve\n` +
          `Or:   /vote ${msg.data.id} reject`,
        );
        break;
      }

      case 'proposal_result': {
        console.log(`[Guardian TG] Proposal result: ${msg.data.id} ${msg.data.status} (${msg.data.approvalPct}%)`);
        const passed = msg.data.status === 'approved';
        await dmOwner(bot, config.ownerChatId,
          `Proposal ${msg.data.id}: ${passed ? 'PASSED' : 'FAILED'} (${msg.data.approvalPct}%)\n` +
          (passed ? 'Change will be pushed to agent.' : 'No action taken.'),
        );
        break;
      }

      case 'attestation_request': {
        console.log(`[Guardian TG] Attestation request from ${msg.data.peerId} (pubkey: ${msg.data.pubkey})`);
        break;
      }

      case 'attestation_verified': {
        console.log(`[Guardian TG] Attestation verified: ${msg.data.peerId} (sentry: ${msg.data.isSentry})`);
        break;
      }

      case 'attestation_rejected': {
        console.log(`[Guardian TG] Attestation rejected: ${msg.data.peerId} — ${msg.data.reason}`);
        break;
      }

      case 'vault_key_sent': {
        console.log(`[Guardian TG] Vault key sent to ${msg.data.toPeerId}`);
        break;
      }

      case 'vault_key_received': {
        console.log(`[Guardian TG] Vault key received from ${msg.data.fromPeerId}`);
        break;
      }

      case 'db_sync_sent': {
        console.log(`[Guardian TG] DB sync sent: seq=${msg.data.seq} peers=${msg.data.peers} size=${msg.data.sizeKB}KB`);
        break;
      }

      case 'db_sync_received': {
        console.log(`[Guardian TG] DB sync received from ${msg.data.fromPeerId} seq=${msg.data.seq}`);
        break;
      }

      case 'db_sync_rejected': {
        console.log(`[Guardian TG] DB sync rejected from ${msg.data.fromPeerId}: ${msg.data.reason}`);
        break;
      }

      case 'recovery_request': {
        console.log(`[Guardian TG] Recovery request from ${msg.data.fromPeerId}`);
        break;
      }

      case 'recovery_served': {
        console.log(`[Guardian TG] Recovery served to ${msg.data.toPeerId} seq=${msg.data.seq}`);
        break;
      }

      case 'trust_peer_added': {
        console.log(`[Guardian TG] Trust peer added: ${msg.data.peerId} (sentry: ${msg.data.isSentry})`);
        break;
      }

      case 'trust_peer_removed': {
        console.log(`[Guardian TG] Trust peer removed: ${msg.data.peerId}`);
        break;
      }

      default:
        break;
    }
  });

  // ── DM commands ───────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply(
      'Guardian Node Bot\n\n' +
      'Commands:\n' +
      '/status - Guardian health & uptime\n' +
      '/peers - Known peers\n' +
      '/proposals - Active proposals\n' +
      '/propose <type> <args> <reason> - Create proposal\n' +
      '/vote <id> <approve|reject> - Cast vote\n' +
      '/delegate <sentryAddress> - Delegate voting power\n' +
      '/undelegate - Revoke delegation\n' +
      '/my_delegations - Current delegations\n' +
      '/sentries - Active sentries\n' +
      '/stake [tokenId...] - Stake NFTs for sentry status\n' +
      '/unstake - Unstake all NFTs\n' +
      '/my_stakes - View staked NFTs\n\n' +
      'Propose types:\n' +
      '  pause <reason>\n' +
      '  unpause <reason>\n' +
      '  rpc_add <chain> <url> <reason>\n' +
      '  rpc_remove <chain> <url> <reason>\n' +
      '  strategy <strategyId> <reason>\n' +
      '  trading_limits <json> <reason>\n' +
      '  tee_approve <measurement> <reason>\n' +
      '  tee_revoke <measurement> <reason>',
    );
  });

  bot.command('propose', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!deps.configGov) {
      await ctx.reply('This guardian is not a sentry — proposals must be created on a sentry node.');
      return;
    }
    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);
    if (args.length < 2) {
      await ctx.reply(
        'Usage: /propose <type> <args...>\n\n' +
        'Types:\n' +
        '  pause <reason>\n' +
        '  unpause <reason>\n' +
        '  rpc_add <chain> <url> <reason>\n' +
        '  rpc_remove <chain> <url> <reason>\n' +
        '  strategy <strategyId> <reason>\n' +
        '  trading_limits <json> <reason>\n' +
        '  tee_approve <measurement> <reason>\n' +
        '  tee_revoke <measurement> <reason>',
      );
      return;
    }

    const subcommand = args[0];
    const proposer = config.guardianAddress;

    try {
      let id: string;
      switch (subcommand) {
        case 'pause':
        case 'unpause': {
          const reason = args.slice(1).join(' ');
          id = deps.configGov.proposeEmergencyAction({ proposer, action: subcommand, reason });
          break;
        }
        case 'rpc_add':
        case 'rpc_remove': {
          if (args.length < 4) {
            await ctx.reply(`Usage: /propose ${subcommand} <chain> <url> <reason>`);
            return;
          }
          const action = subcommand === 'rpc_add' ? 'add' : 'remove';
          const chain = args[1];
          const url = args[2];
          const reason = args.slice(3).join(' ');
          id = deps.configGov.proposeRpcChange({ proposer, action, chain, url, reason });
          break;
        }
        case 'strategy': {
          if (args.length < 3) {
            await ctx.reply('Usage: /propose strategy <strategyId> <reason>');
            return;
          }
          const targetStrategy = args[1];
          const reason = args.slice(2).join(' ');
          id = deps.configGov.proposeStrategyChange({ proposer, targetStrategy, reason });
          break;
        }
        case 'trading_limits': {
          if (args.length < 3) {
            await ctx.reply('Usage: /propose trading_limits <json> <reason>');
            return;
          }
          let limits: Record<string, number>;
          try {
            limits = JSON.parse(args[1]) as Record<string, number>;
          } catch {
            await ctx.reply('Invalid JSON for limits. Example: {"maxPositionSize":1000}');
            return;
          }
          const reason = args.slice(2).join(' ');
          id = deps.configGov.proposeTradingLimits({ proposer, limits, reason });
          break;
        }
        case 'tee_approve':
        case 'tee_revoke': {
          if (args.length < 3) {
            await ctx.reply(`Usage: /propose ${subcommand} <measurement> <reason>`);
            return;
          }
          const action = subcommand === 'tee_approve' ? 'approve' : 'revoke';
          const measurement = args[1];
          const reason = args.slice(2).join(' ');
          id = deps.configGov.proposeTEEMeasurement({ proposer, action, measurement, reason });
          break;
        }
        default:
          await ctx.reply(`Unknown proposal type: ${subcommand}`);
          return;
      }

      // Broadcast to group
      const proposal = deps.proposals.getById(id);
      if (proposal && deps.broadcastToGroup) {
        deps.broadcastToGroup(formatProposalNew({
          id,
          type: proposal.type,
          thresholdPct: proposal.threshold_pct,
          deadline: proposal.deadline,
        }));
      }

      await ctx.reply(`Proposal created: ${id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Proposal failed: ${msg}`);
    }
  });

  bot.command('status', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const stats = deps.peers.stats();
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);

    const currentSentry = config.isSentryNow?.() ?? config.isSentry;
    const stakes = deps.nftStaking?.getActiveStakes(config.guardianAddress) ?? [];
    const sentrySource = config.isSentry ? 'env' : stakes.length > 0 ? 'staked NFTs' : 'none';

    await ctx.reply(
      `Guardian: ${config.guardianAddress}\n` +
      `Sentry: ${currentSentry ? 'yes' : 'no'} (${sentrySource}${stakes.length > 0 ? `, staked NFTs: ${stakes.length}` : ''})\n` +
      `Endpoint: ${config.guardianEndpoint}\n` +
      `Uptime: ${hours}h ${mins}m\n` +
      `Peers: ${stats.total} total, ${stats.active} active, ${stats.sentries} sentries`,
    );
  });

  bot.command('peers', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const all = deps.peers.listAll();
    if (all.length === 0) {
      await ctx.reply('No known peers.');
      return;
    }
    const lines = all.map(
      (p) => `${p.address} ${p.is_sentry ? '[sentry]' : ''} ${p.endpoint} (seen: ${p.last_seen})`,
    );
    await ctx.reply(lines.join('\n'));
  });

  bot.command('proposals', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const active = deps.proposals.listActive();
    if (active.length === 0) {
      await ctx.reply('No active proposals.');
      return;
    }
    const lines = active.map(
      (p) => `${p.id} [${p.type}] ${p.description.slice(0, 60)} (${p.threshold_pct}%, deadline: ${p.deadline})`,
    );
    await ctx.reply(lines.join('\n\n'));
  });

  bot.command('vote', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);
    if (args.length < 2) {
      await ctx.reply('Usage: /vote <proposalId> <approve|reject>');
      return;
    }
    const [proposalId, decision] = args;
    if (decision !== 'approve' && decision !== 'reject') {
      await ctx.reply('Vote must be "approve" or "reject".');
      return;
    }
    try {
      const result = deps.voting.castVote({
        proposalId,
        voterAddress: config.guardianAddress,
        approve: decision === 'approve',
      });
      await ctx.reply(`Vote cast on ${proposalId}: ${decision} (power: ${result.votingPower} cents)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Vote failed: ${msg}`);
    }
  });

  bot.command('delegate', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);
    if (args.length < 1) {
      await ctx.reply('Usage: /delegate <sentryAddress>');
      return;
    }
    const sentryAddress = args[0];
    const tgId = ctx.from?.id?.toString();
    if (!tgId) {
      await ctx.reply('Could not identify your Telegram ID.');
      return;
    }

    try {
      // Verify the target sentry exists
      const sentry = deps.peers.get(sentryAddress);
      if (!sentry || !sentry.is_sentry) {
        await ctx.reply(`${sentryAddress} is not a known sentry node.`);
        return;
      }

      // Create delegation (simplified: no NFT verification in this flow)
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
      const delegationId = deps.delegations.create({
        delegatorTgId: tgId,
        sentryAddress,
        nftTokenIds: [],
        totalValue: 0,
        signature: `tg:${tgId}:${Date.now()}`,
        expiresAt,
      });
      await ctx.reply(`Delegated to ${sentryAddress} (delegation #${delegationId}, expires in 30 days)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Delegation failed: ${msg}`);
    }
  });

  bot.command('undelegate', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const tgId = ctx.from?.id?.toString();
    if (!tgId) {
      await ctx.reply('Could not identify your Telegram ID.');
      return;
    }

    const delegations = deps.delegations.getByDelegator(tgId);
    if (delegations.length === 0) {
      await ctx.reply('No active delegations to revoke.');
      return;
    }

    let revoked = 0;
    for (const d of delegations) {
      if (deps.delegations.revoke(d.id, tgId)) revoked++;
    }
    await ctx.reply(`Revoked ${revoked} delegation(s).`);
  });

  bot.command('my_delegations', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const tgId = ctx.from?.id?.toString();
    if (!tgId) {
      await ctx.reply('Could not identify your Telegram ID.');
      return;
    }

    const delegations = deps.delegations.getByDelegator(tgId);
    if (delegations.length === 0) {
      await ctx.reply('No active delegations.');
      return;
    }

    const lines = delegations.map(
      (d) => `#${d.id} -> ${d.sentry_address} (value: ${d.total_value} cents, expires: ${d.expires_at})`,
    );
    await ctx.reply(lines.join('\n'));
  });

  // ── NFT Staking commands (owner-only DM) ───────────────────

  bot.command('stake', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!deps.nftStaking) {
      await ctx.reply('NFT staking is not available on this node.');
      return;
    }
    if (!config.ownerChatId || ctx.from?.id !== config.ownerChatId) {
      await ctx.reply('Only the guardian owner can stake NFTs.');
      return;
    }

    const ownerTgId = config.ownerChatId.toString();
    const args = (ctx.message?.text ?? '').split(/\s+/).slice(1);

    try {
      let result: { staked: number[]; failed: Array<{ tokenId: number; error: string }> };
      if (args.length === 0) {
        // Stake all owned NFTs
        result = await deps.nftStaking.stakeAll(config.guardianAddress, ownerTgId);
      } else {
        // Stake specific token IDs
        const tokenIds = args.map(Number).filter(n => !isNaN(n) && n > 0);
        if (tokenIds.length === 0) {
          await ctx.reply('Usage: /stake [tokenId...]\nNo args = stake all your NFTs.');
          return;
        }
        result = await deps.nftStaking.stakeNFTs(config.guardianAddress, ownerTgId, tokenIds);
      }

      const lines: string[] = [];
      if (result.staked.length > 0) {
        lines.push(`Staked: ${result.staked.map(id => `#${id}`).join(', ')}`);
      }
      for (const f of result.failed) {
        lines.push(`Failed #${f.tokenId}: ${f.error}`);
      }
      if (lines.length === 0) {
        lines.push('No NFTs found to stake.');
      }
      await ctx.reply(lines.join('\n'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Stake failed: ${msg}`);
    }
  });

  bot.command('unstake', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!deps.nftStaking) {
      await ctx.reply('NFT staking is not available on this node.');
      return;
    }
    if (!config.ownerChatId || ctx.from?.id !== config.ownerChatId) {
      await ctx.reply('Only the guardian owner can unstake NFTs.');
      return;
    }

    const count = deps.nftStaking.unstakeAll(config.guardianAddress);
    await ctx.reply(count > 0 ? `Unstaked ${count} NFT(s). Sentry status may be lost.` : 'No active stakes to remove.');
  });

  bot.command('my_stakes', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (!deps.nftStaking) {
      await ctx.reply('NFT staking is not available on this node.');
      return;
    }
    if (!config.ownerChatId || ctx.from?.id !== config.ownerChatId) {
      await ctx.reply('Only the guardian owner can view stakes.');
      return;
    }

    const stakes = deps.nftStaking.getActiveStakes(config.guardianAddress);
    if (stakes.length === 0) {
      await ctx.reply('No active stakes.');
      return;
    }

    const totalValue = stakes.reduce((sum, s) => sum + s.current_value, 0);
    const lines = stakes.map(
      s => `#${s.token_id} — value: ${s.current_value} cents, verified: ${s.last_verified}`,
    );
    lines.push(`\nTotal staked value: ${totalValue} cents`);
    await ctx.reply(lines.join('\n'));
  });

  bot.command('sentries', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const sentries = deps.peers.listAll(true);
    if (sentries.length === 0) {
      await ctx.reply('No known sentries.');
      return;
    }

    const lines: string[] = [];
    for (const s of sentries) {
      const power = deps.delegations.getVotingPower(s.address);
      lines.push(
        `${s.address} (power: ${power.totalPower} cents, delegations: ${power.delegationCount})`,
      );
    }
    await ctx.reply(lines.join('\n'));
  });

  return bot;
}

/** Send a protocol message to the group chat. */
export async function sendToGroup(bot: Bot, groupChatId: string, message: string): Promise<void> {
  try {
    await bot.api.sendMessage(Number(groupChatId), message);
  } catch (err: unknown) {
    console.error('[Guardian TG] Failed to send to group:', err);
  }
}
