/**
 * @freeq/sdk — TypeScript SDK for building freeq IRC clients.
 *
 * @example
 * ```typescript
 * import { FreeqClient } from '@freeq/sdk';
 *
 * const client = new FreeqClient({
 *   url: 'wss://irc.freeq.at/irc',
 *   nick: 'mybot',
 * });
 *
 * client.on('message', (channel, msg) => {
 *   console.log(`[${channel}] ${msg.from}: ${msg.text}`);
 * });
 *
 * client.on('ready', () => {
 *   client.join('#mychannel');
 *   client.sendMessage('#mychannel', 'Hello from the SDK!');
 * });
 *
 * client.connect();
 * ```
 */
export { FreeqClient } from './client.js';
export type { FreeqEvents } from './events.js';
export { parse, format, prefixNick } from './parser.js';
export { Transport } from './transport.js';
export type { IRCMessage, Message, Member, Channel, PinnedMessage, WhoisInfo, ChannelListEntry, AvSession, AvParticipant, TransportState, SaslCredentials, FreeqClientOptions, Batch, PresenceState, GovernanceSignal, GovernancePayload, PresencePayload, CoordinationEventPayload, SpendPayload, BudgetSnapshot, AgentSpawnedPayload, AgentDespawnedPayload, HistoryOptions, EmitEventOptions, HeartbeatHandle, NickCollisionPolicy, ReconnectConfig, } from './types.js';
export { fetchProfile, prefetchProfiles, getCachedProfile } from './profiles.js';
export type { ATProfile } from './profiles.js';
export { generateDidKey, importDidKey } from './did-key.js';
export type { DidKey } from './did-key.js';
export { createGroup, rotate, encryptGroup, decryptGroup, sealFor, openSealed, sealedToWire, sealedFromWire, sealBatch, openBest, isGroupEncrypted, parseEpoch, } from './e2ee_group.js';
export type { GroupState, SealedGroupKey, X25519Secret } from './e2ee_group.js';
//# sourceMappingURL=index.d.ts.map