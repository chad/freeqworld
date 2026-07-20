/**
 * FreeqClient — event-driven IRC client with AT Protocol identity and E2EE.
 *
 * Usage:
 *   const client = new FreeqClient({ url: 'wss://irc.freeq.at/irc', nick: 'mybot' });
 *   client.on('message', (channel, msg) => console.log(`${msg.from}: ${msg.text}`));
 *   client.connect();
 */
import { EventEmitter } from './events.js';
import type { AvSession, FreeqClientOptions, SaslCredentials, TransportState, PinnedMessage, WhoisInfo, HistoryOptions, EmitEventOptions, HeartbeatHandle } from './types.js';
export declare class FreeqClient extends EventEmitter {
    private transport;
    private _nick;
    private _authDid;
    /** Bearer token usable for `/agent/tools/*` HTTP calls. Populated
     *  from the server-emitted `NOTICE * :API-BEARER <session_id>` that
     *  fires immediately after SASL success. Bots use this to call
     *  diagnostic tools as themselves instead of as anonymous. */
    private _apiBearer;
    private _connectionState;
    private _registered;
    private opts;
    private ackedCaps;
    private sasl;
    private skipBrokerRefresh;
    private guestFallbackCount;
    /** Set when SASL was attempted and 904 was received. Suppresses any
     *  subsequent registration completion as a guest, and blocks outgoing
     *  PRIVMSGs that would silently leak under the guest identity. */
    private _saslFailed;
    /** Channels the server has flagged +E. Used to block plaintext sends
     *  when we don't (yet) have the passphrase, so messages don't leak
     *  unencrypted into a channel the rest of the room expects encrypted. */
    private _encryptedChannels;
    /** Current AWAY reason, or null if not away. Re-asserted on
     *  reconnect so the wire and UI states don't diverge after the
     *  server forgets us during the disconnect. */
    private _currentAway;
    private autoJoinChannels;
    private _joinedChannels;
    /** Accumulates NAMES (353) lines per channel between the start of a NAMES
     *  reply and its 366 terminator, so the full roster can be emitted atomically
     *  as `membersSync`. A key present = a NAMES sequence is in progress; 366
     *  deletes it, so the next reply starts fresh. */
    private _namesAccum;
    private backgroundWhois;
    private echoPlaintextCache;
    private batches;
    /** Server-advertised `draft/multiline` policy (parsed from CAP LS). */
    private multilineMaxBytes;
    private multilineMaxLines;
    /** Monotonic counter for client-generated BATCH ids. */
    private nextBatchSeq;
    private pendingAwayReason;
    private _avSessions;
    private _activeAvSession;
    /** Session id → MoQ access token (`+freeq.at/av-token` TAGMSG, sent by
     *  the server right after av-start/av-join). Appended to the SFU dial
     *  URL as `?jwt=…`; without it the SFU rejects the connection once the
     *  server enforces tokens (FREEQ_AV_REQUIRE_TOKEN). */
    private _avTokens;
    /** Lowercase nick → DID. Populated from numeric 330 (WHOIS) and from
     *  inbound `+freeq.at/account` tags. */
    private _nickToDid;
    /** DID → lowercase nick. Reverse cache for AGENT PAUSE/REVOKE which
     *  take nicks, not DIDs. */
    private _didToNick;
    /** Accumulating WHOIS info per nick. Multiple WHOIS numerics fire
     *  incrementally (311/312/319/330/671/673); we collect until 318
     *  (RPL_ENDOFWHOIS) and resolve the requestWhois() Promise. */
    private _whoisBuffer;
    /** Pending requestWhois() Promise resolvers, keyed by lowercase nick. */
    private _pendingWhois;
    /** Random-suffix nick collision retry counter. */
    private _nickCollisionRetries;
    /** Background heartbeat loop handle (set by startHeartbeat()). */
    private _agentHeartbeatTimer;
    /** Recently-seen coordination event IDs (TAGMSG + companion PRIVMSG carry
     *  the same eventId; we fire `coordinationEvent` only once per pair). */
    private _seenCoordinationEvents;
    constructor(opts: FreeqClientOptions);
    /** Current IRC nickname. */
    get nick(): string;
    /** Authenticated AT Protocol DID, or null if guest. */
    get authDid(): string | null;
    /** Bearer token for `/agent/tools/*` HTTP calls. Set automatically
     *  on SASL success; null while unauthenticated. Use as
     *  `Authorization: Bearer <client.apiBearer>` to make diagnostic
     *  calls as the same identity the IRC session is bound to. */
    get apiBearer(): string | null;
    /** Current connection state. */
    get connectionState(): TransportState;
    /** Whether IRC registration is complete (001 received). */
    get registered(): boolean;
    /** Set of channels we're currently in (lowercase). */
    get joinedChannels(): ReadonlySet<string>;
    /** Active AV sessions. */
    get avSessions(): ReadonlyMap<string, AvSession>;
    /** Active AV session ID we're participating in. */
    get activeAvSession(): string | null;
    /** MoQ access token for an AV session (from `+freeq.at/av-token`), or
     *  null if none received yet. Append to the SFU URL as `?jwt=…`. */
    avTokenFor(sessionId: string): string | null;
    /** Server origin for API calls. */
    get serverOrigin(): string;
    /** Connect to the IRC server. */
    connect(): void;
    /** Wait for the WebSocket send buffer to drain. Returns when
     *  `bufferedAmount` reaches 0 (or the WS is no longer open), or after
     *  `maxMs` (default 2000ms). Call before `disconnect()` if you need
     *  outbound messages (PRESENCE=offline, QUIT, etc.) to actually reach
     *  the server before the socket closes. */
    flush(maxMs?: number): Promise<void>;
    /** Disconnect from the server. */
    disconnect(): void;
    /** Force an immediate reconnect. */
    reconnect(): void;
    /** Set SASL credentials (call before connect, or before reconnect). */
    setSaslCredentials(creds: SaslCredentials): void;
    /**
     * Send a message to a channel or user. Multi-line text routes by
     * negotiated cap:
     * - `draft/multiline` acked AND text contains `\n` → BATCH (one
     *   chunk per logical line).
     * - Otherwise → single PRIVMSG with `\n` escaped as `\\n` and a
     *   `+freeq.at/multiline` tag. The SDK normalizes both forms on
     *   receive so consumers always see real `\n`.
     *
     * The `multiline` param is accepted but unused; routing keys on `\n`
     * in the text and the negotiated cap.
     */
    sendMessage(target: string, text: string, multiline?: boolean): void;
    /**
     * Multi-line send with two affordances `sendMessage` doesn't have:
     *
     * - **Array input** — pass `['line1', 'line2', ...]` directly.
     *   Equivalent to `sendMessage(target, body.join('\n'))`.
     * - **Opener tags** — pass arbitrary tags via `options.tags` to ride
     *   on the BATCH opener (e.g. commit-reveal payloads). For common
     *   tags use the dedicated methods: `sendReply` (+reply), `sendEdit`
     *   (+draft/edit), `sendTagged` (arbitrary single-PRIVMSG tags).
     *
     * For plain multi-line text without custom opener tags, `sendMessage`
     * is equivalent and simpler — it auto-detects `\n` and routes to a
     * `draft/multiline` BATCH (when the cap is acked) or the legacy
     * single-PRIVMSG path otherwise.
     *
     * Returns `null` — the BATCH frames are emitted asynchronously
     * after the assembled body is signed, so the id isn't synchronously
     * available.
     */
    sendMultiline(target: string, body: string | string[], options?: {
        tags?: Record<string, string>;
    }): string | null;
    /**
     * Shared implementation behind `sendMessage` / `sendMultiline` /
     * `sendReply` / `sendEdit`. Picks the wire shape based on whether
     * the text has line breaks, whether the channel is E2EE, and
     * whether the server acked `draft/multiline`.
     *
     * Returns the BATCH id if a multiline BATCH was used, or `null` if
     * a single PRIVMSG (with or without `+freeq.at/multiline`) was used.
     */
    private sendMessageInternal;
    /**
     * Single-PRIVMSG fallback: escapes `\n` as `\\n` and sets
     * `+freeq.at/multiline` when the text has line breaks, so older
     * receivers that decode that tag still render correctly. Used when
     * the multiline cap isn't acked.
     */
    private sendLegacyPlaintext;
    /**
     * Emit local echo if `echo-message` wasn't acked, so the sender's UI
     * still sees its own outbound message immediately.
     */
    private maybeLocalEcho;
    /**
     * Per-PRIVMSG-chunk byte budget. Caps below the SDK's own
     * `LINE_SIZE_WARN_THRESHOLD` (7000) so chunked sends don't trigger
     * an oversize warning. Reserve ~600 bytes for worst-case opener
     * metadata; the rest is body content. The server-advertised
     * `max-bytes` is the TOTAL across all chunks, not per-chunk, so it
     * doesn't override this budget directly.
     */
    private perChunkByteBudget;
    /** Send a reply to a specific message. Multi-line replies use the
     *  same wire shape as `sendMessage`. */
    sendReply(target: string, replyToMsgId: string, text: string, multiline?: boolean): void;
    /** Edit a message. Multi-line edits use the same wire shape as
     *  `sendMessage`. */
    sendEdit(target: string, originalMsgId: string, newText: string, multiline?: boolean): void;
    /** Send a message with Markdown formatting. */
    sendMarkdown(target: string, text: string): void;
    /** Delete a message. */
    sendDelete(target: string, msgId: string): void;
    /** React to a message with an emoji. */
    sendReaction(target: string, emoji: string, msgId?: string): void;
    /** Remove our previous reaction to a message. */
    sendUnreact(target: string, emoji: string, msgId: string): void;
    /** Join a channel. */
    join(channel: string): void;
    /** Leave a channel. */
    part(channel: string): void;
    /** Set a channel's topic. */
    setTopic(channel: string, topic: string): void;
    /** Set a channel or user mode. */
    setMode(channel: string, mode: string, arg?: string): void;
    /** Kick a user from a channel. */
    kick(channel: string, nick: string, reason?: string): void;
    /** Invite a user to a channel. */
    invite(channel: string, nick: string): void;
    /** Set or clear away status. */
    setAway(reason?: string): void;
    /**
     * Set the cross-device read marker for `target` (IRCv3 `draft/read-marker`).
     *
     * `timestamp` must be ISO 8601 with millisecond precision and a `Z` suffix,
     * exactly as in the `server-time` extension (`YYYY-MM-DDThh:mm:ss.sssZ`).
     * The server only ever moves the marker forward: a stale timestamp is
     * ignored and the server replies with the current (newer) value. Either way
     * the reply arrives via the `readMarker` event, and — for DID-authenticated
     * sessions — the update is pushed to your other connected devices.
     */
    markRead(target: string, timestamp: string): void;
    /**
     * Query the current read marker for `target`. The answer arrives via the
     * `readMarker` event with `timestamp = null` when no marker has been set.
     */
    getReadMarker(target: string): void;
    /** Fire a WHOIS and resolve with parsed info when 318 (RPL_ENDOFWHOIS)
     *  arrives. Renamed from `whois()` — that name remains as a deprecated
     *  alias for one release. */
    requestWhois(nick: string, opts?: {
        timeoutMs?: number;
    }): Promise<WhoisInfo>;
    /** @deprecated Use `requestWhois(nick)` (returns `Promise<WhoisInfo>`).
     *  Kept for one release; calling this still fires the `whois` event
     *  on each numeric, same as before. */
    whois(nick: string): void;
    /** Request chat history for a target (channel or DM partner).
     *
     *  `opts.mode` selects:
     *    - 'latest' — most recent N messages
     *    - 'before' — N messages before `opts.msgid`
     *    - 'after'  — N messages after `opts.msgid`
     */
    requestHistory(opts: HistoryOptions): void;
    /** @deprecated Use the `HistoryOptions` form. The two-arg form is kept
     *  for backwards compatibility with freeq-app. */
    requestHistory(channel: string, before?: string): void;
    /** Request CHATHISTORY TARGETS — list of recent conversation targets
     *  (channels + DM partners with recent activity).
     *  Each result fires `historyTarget(target, timestamp?)`. */
    requestHistoryTargets(limit?: number): void;
    /** @deprecated Use `requestHistoryTargets(limit)`. CHATHISTORY TARGETS
     *  returns channels too, not just DMs; the original name was misleading.
     *  Kept for one release. */
    requestDmTargets(limit?: number): void;
    /** Pin a message. */
    pin(channel: string, msgid: string): void;
    /** Unpin a message. */
    unpin(channel: string, msgid: string): void;
    /** Send a raw IRC command. */
    raw(line: string): void;
    /** Set a channel encryption passphrase (ENC1). */
    setChannelEncryption(channel: string, passphrase: string): Promise<void>;
    /** Remove channel encryption. */
    removeChannelEncryption(channel: string): void;
    /** Initialize E2EE for DMs (called automatically after SASL success). */
    initializeE2EE(did: string): Promise<void>;
    /** Get the E2EE safety number for a DM partner. */
    getSafetyNumber(remoteDid: string): Promise<string | null>;
    /** Fetch pinned messages for a channel via REST API.
     *  Returns the fetched pins; also fires the `pins` event for any
     *  subscribers. Returns an empty array on failure. */
    fetchPins(channel: string): Promise<PinnedMessage[]>;
    /**
     * A reconnect could not re-establish the authenticated identity *before any
     * SASL attempt* — the broker session refresh timed out or failed and we have
     * no usable token to fall back on. The user intended to be logged in
     * (`sasl.did` is set), so we MUST NOT silently complete registration as a
     * guest: that would rename us to GuestNNNNN, leave the app's stale `authDid`
     * in place (verified badge next to a Guest nick), and let PRIVMSGs leak under
     * the guest identity.
     *
     * Mirror the 904 teardown: drop the dead credentials, mark `_saslFailed` so
     * any in-flight 001 is suppressed and outgoing PRIVMSGs are blocked, notify
     * the app (so its store clears `authDid` and surfaces "session expired"), and
     * tear the socket down so the next user action is an explicit re-auth.
     */
    private failReconnectAuth;
    private onTransportStateChange;
    /** Whether a message/tag came from us. Prefers the account DID — robust to
     *  nick case and to force-renames across our own sessions, unlike a raw nick
     *  compare (a stale `_nick` made our own DM echoes look like incoming DMs,
     *  spawning a phantom self-DM buffer + notification). Falls back to nick. */
    private isSelfSender;
    private didForNick;
    /**
     * Canonical DM identity for a peer — its DID when known, else the peer
     * unchanged (see `address.ts`). Used as BOTH the wire target we address and
     * the local buffer key we file under, so "bob" and "did:plc:bob" are one
     * conversation and a DID-addressed DM reaches the right identity on any
     * server. A guest / unresolved nick passes through, so nick DMs are intact.
     *
     * Buffer keying additionally consults the REVERSE of the display binding
     * (DID→nick, learned from the server's conversation list): for an OFFLINE
     * peer nothing this session teaches nick→DID, so without the reverse an
     * echo or incoming line addressed by nick files under a nick thread while
     * the server persists the same conversation under the DID — one person,
     * two buffers. The reverse binding is server-asserted conversation
     * identity, safe for grouping; wire ADDRESSING stays strict (didForNick
     * only) so routing semantics never ride a possibly-stale display nick.
     */
    private dmKey;
    /** Strict resolver for wire targets: DID only when addressing-grade known. */
    private wireDmTarget;
    /** The DID whose known display nick is `nick`, if exactly that binding exists. */
    private reverseDidForNick;
    /** The recipient DID for a DM target that may be a nick or already a DID. */
    private remoteDidFor;
    /**
     * Learn a sender's nick↔DID binding from an inbound message's `account`
     * tag. Without this, the first DM from a peer we share no channel with (so
     * no JOIN/WHOIS taught us their DID) would key under the bare nick while
     * our own sends key under the DID — splitting one conversation in two.
     */
    private rememberSenderDid;
    /** Resolve nick to DID — set by the app layer for E2EE support. */
    nickToDid: ((nick: string) => string | undefined) | null;
    private resolveNickToDid;
    /** Parse a `+freeq.at/event=*` TAGMSG/PRIVMSG and emit `coordinationEvent`.
     *  De-dupes by eventId so the paired TAGMSG + companion PRIVMSG fire
     *  the event only once. */
    private emitCoordinationEvent;
    private signedPrivmsg;
    private cacheEchoPlaintext;
    /**
     * Parse the cap params advertised as `draft/multiline=max-bytes=N,max-lines=M`.
     * Captures server policy so the chunker doesn't exceed it.
     */
    private parseMultilineCapParams;
    /** Mint a unique BATCH id for an outbound multiline send. */
    private mintBatchId;
    /**
     * Assemble the chunks of a closed `draft/multiline` batch per spec
     * concat rules: a chunk with `draft/multiline-concat` is joined to
     * the predecessor with no separator; otherwise joined with `\n`.
     */
    private assembleMultiline;
    /**
     * Emit a `draft/multiline` BATCH on the wire. `chunks` are already
     * sized to fit in a PRIVMSG line. `openerTags` go on the BATCH opener
     * (e.g. commit-reveal client-tags); `+encrypted` rides on each chunk.
     * Returns the BATCH id used.
     */
    private emitMultilineBatch;
    /**
     * Close-time handler for an assembled `draft/multiline` batch.
     * Concatenates the chunks per spec rules, decrypts if the assembled
     * body is ENC1/ENC3, builds a synthetic `Message` carrying the
     * opener's identity (msgid, time, sender, etc.), and either emits it
     * as a top-level `message` event or pushes it into the parent batch
     * if the multiline was nested (e.g. inside a CHATHISTORY batch).
     */
    private dispatchAssembledMultiline;
    /**
     * Chunk a body into lines respecting `max-bytes` per chunk and the
     * `max-lines` per batch ceiling. Two strategies:
     *
     *   - `concatChunks=false`: chunk on `\n` boundaries; each source line
     *     becomes one chunk (no `draft/multiline-concat`). If a single
     *     source line exceeds the byte budget it is hard-split with concat
     *     so the assembled body is byte-identical.
     *   - `concatChunks=true`: chunk on byte boundaries only (used for
     *     ciphertext-chunking E2EE messages — there are no logical line
     *     breaks to honor).
     */
    private chunkMultilineBody;
    /**
     * Partition already-sized chunk lines into batches that each respect
     * the server's `max-lines` and `max-bytes` ceilings. A message that
     * doesn't fit one batch becomes several — each emitted as its own
     * BATCH (its own logical message), rather than collapsed into a single
     * oversized line the server would truncate.
     *
     * Group boundaries fall only on a real line start (`concat === false`)
     * so a hard-split source line (its continuations carry `concat`) is
     * never severed across two messages. Byte accounting uses string
     * `.length`, matching the rest of the multiline sizing (`perChunkBudget`,
     * the `max-bytes` guard) — exact for the ASCII-heavy pastes this fixes.
     */
    private groupChunksIntoBatches;
    private handleLine;
    private handleCap;
    private handleAuthenticate;
    private handleAvSessionState;
    /** Send IRC QUIT. Closes the session cleanly on the server side. */
    quit(reason?: string): void;
    /** JOIN multiple channels at once (comma-separated wire form). */
    joinMany(channels: string[]): void;
    /** PRIVMSG with arbitrary IRCv3 tags. Caller-managed escaping is handled
     *  by the SDK's format() helper. */
    sendTagged(target: string, text: string, tags: Record<string, string>): void;
    /** TAGMSG (tags-only, no body) to a target. */
    sendTagmsg(target: string, tags: Record<string, string>): void;
    /** Send a media attachment (image/audio/video URL with metadata).
     *  Server side stores the media tags; rich clients render the embed. */
    sendMedia(target: string, media: {
        url: string;
        mime?: string;
        alt?: string;
        width?: number;
        height?: number;
        durationMs?: number;
        sizeBytes?: number;
        fallback?: string;
    }): void;
    /** Attach link-preview metadata to a message. */
    sendLinkPreview(target: string, preview: {
        url: string;
        title?: string;
        description?: string;
        imageUrl?: string;
    }): void;
    /** Send a message and await the server-assigned msgid via echo-message.
     *  Resolves with the msgid the server stamps on the echo. Requires
     *  `echo-message` cap (negotiated by default). Timeouts after 5s. */
    sendAndAwaitEcho(target: string, text: string, tags?: Record<string, string>): Promise<string>;
    /** Send a threaded reply (alias for sendReply, named to match Rust SDK
     *  `reply_in_thread`). */
    sendReplyInThread(target: string, parentMsgId: string, text: string): void;
    /** Start a typing indicator in a target (channel or DM). */
    startTyping(target: string): void;
    /** Stop a typing indicator. */
    stopTyping(target: string): void;
    /** Sync lookup: nick → DID. Returns undefined if unknown.
     *  Auto-populated from WHOIS 330, JOIN account tags, and ACCOUNT notify. */
    getDidForNick(nick: string): string | undefined;
    /** Sync lookup: DID → current nick. Returns undefined if unknown.
     *  Needed for AGENT PAUSE/REVOKE which take nicks, not DIDs. */
    getNickForDid(did: string): string | undefined;
    /** Declare actor_class for this session. Class is one of:
     *  'agent' | 'external_agent' | 'human'. Broadcast to shared channels. */
    registerAgent(actorClass: 'agent' | 'external_agent' | 'human'): void;
    /** Submit a provenance declaration (JSON value, base64url-encoded on
     *  the wire). For agents, typically a FreeqBotDelegation/v1 cert. */
    submitProvenance(provenance: unknown): void;
    /** Update structured agent presence (state, status, task). */
    setPresence(state: string, status?: string, task?: string): void;
    /** Send a single heartbeat. */
    sendHeartbeat(state: string, ttlSeconds: number): void;
    /** Start a background heartbeat loop at the given interval (ms).
     *  TTL is set to 2× interval per Rust SDK convention. */
    startHeartbeat(intervalMs: number): HeartbeatHandle;
    /** Request approval from channel ops for a capability use. */
    requestApproval(channel: string, capability: string, resource?: string): void;
    /** Op-only. Pause target agent — expects PRESENCE=paused within 10s. */
    pauseAgent(nick: string, reason?: string): void;
    /** Op-only. Resume a paused agent. */
    resumeAgent(nick: string): void;
    /** Op-only. Revoke capabilities + force disconnect. */
    revokeAgent(nick: string, reason?: string): void;
    /** Op approval response. */
    approveAgent(nick: string, capability: string): void;
    /** Op denial response. */
    denyAgent(nick: string, capability: string, reason?: string): void;
    /** Emit a coordination event as paired TAGMSG (for storage) +
     *  companion PRIVMSG (for rich-client rendering). Returns the
     *  server-stored event ID. */
    emitEvent(channel: string, eventType: string, payload: unknown, opts?: EmitEventOptions): string;
    /** Sugar over `emitEvent` for `task_request`. Returns the task ID. */
    createTask(channel: string, description: string): string;
    /** Sugar for `task_update` — progress update on a task. */
    updateTask(channel: string, taskId: string, phase: string, summary: string): void;
    /** Sugar for `task_complete`. */
    completeTask(channel: string, taskId: string, summary: string, url?: string): void;
    /** Sugar for `task_failed`. */
    failTask(channel: string, taskId: string, error: string): void;
    /** Sugar for `evidence_attach` — attach evidence to a task. */
    attachEvidence(channel: string, taskId: string, evidenceType: string, summary: string, url?: string): void;
    /** Submit an agent manifest (base64-encoded TOML). */
    submitManifest(tomlContent: string): void;
    /** Spawn a child agent in a channel. */
    spawnAgent(channel: string, nick: string, capabilities: string[], ttlSeconds?: number, taskRef?: string): void;
    /** Despawn a child agent (parent only). */
    despawnAgent(nick: string): void;
    /** Send a message attributed to a spawned child agent. */
    sendAsChild(childNick: string, channel: string, text: string): void;
    /** Submit a spend record for the current action.
     *  (Server emits a `budget_exceeded` governance TAGMSG to us if this
     *  spend pushes us past the per-agent budget cap.) */
    submitSpend(channel: string, amount: number, unit: string, description: string, taskRef?: string): void;
    /** Set a per-agent budget on a channel (op only). */
    setBudget(channel: string, maxAmount: number, unit: string, period: string, sponsorDid: string): void;
    /** Query channel budget state (server replies with snapshot). */
    requestBudget(channel: string): void;
}
//# sourceMappingURL=client.d.ts.map