/** IRC message parser and formatter. */
import type { IRCMessage } from './types.js';
/** Extract nick from a prefix like "nick!user@host". */
export declare function prefixNick(prefix: string): string;
/** Parse a raw IRC line into a structured message. */
export declare function parse(raw: string): IRCMessage;
/**
 * Empirical safe ceiling for a single IRC line going into freeq-server.
 * The server's MAX_LINE_LEN is 8192; we warn earlier to leave headroom
 * for tags the server may add on receive (msgid, account, sig, etc.).
 * Crossing this threshold doesn't *guarantee* the message will be
 * truncated — but it's far enough into the danger zone that callers
 * should know about it before something silently disappears on the
 * wire (which happened live 2026-05-21 with a rebuttal-prompt body
 * that JSON-stringified to 8.6KB and was truncated at ~8KB by the
 * server, making the panelist's JSON.parse fail with a confusing
 * "Unterminated string" error).
 */
export declare const LINE_SIZE_WARN_THRESHOLD = 7000;
/**
 * IRCv3 message-tags spec: client tags max 4094 bytes (the `@...`
 * portion, excluding the leading `@` and trailing space). Going over
 * is a spec violation; the freeq-server may silently drop the line.
 */
export declare const TAG_SIZE_WARN_THRESHOLD = 4094;
/** Format a raw IRC line from parts. */
export declare function format(command: string, params: string[], tags?: Record<string, string>): string;
//# sourceMappingURL=parser.d.ts.map