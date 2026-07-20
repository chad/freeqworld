/**
 * End-to-end encryption for DMs using Double Ratchet (Signal protocol)
 * and channel passphrase encryption (AES-256-GCM via HKDF).
 *
 * Architecture:
 * - X25519 identity key generated on first AT Protocol login
 * - Signed pre-key uploaded to server for async key exchange (X3DH)
 * - Session per DM partner with forward-secret key derivation
 * - Sessions persisted in IndexedDB
 * - Messages with ENC3: prefix are DM-encrypted; ENC1: are channel-encrypted
 *
 * The server never sees plaintext DM content.
 */
/** Check if text is an ENC3 (DM Double Ratchet) encrypted message. */
export declare function isEncrypted(text: string): boolean;
/** Check if text is an ENC1 (channel passphrase) encrypted message. */
export declare function isENC1(text: string): boolean;
/** Check if E2EE is initialized and ready for DM encryption. */
export declare function isE2eeReady(): boolean;
/** Check if a DM session exists with the given DID. */
export declare function hasSession(did: string): boolean;
/** Check if a channel has an encryption key set. */
export declare function hasChannelKey(channel: string): boolean;
/** Get the identity public key (X25519). */
export declare function getIdentityPublicKey(): Uint8Array | null;
/**
 * Get the safety number for a DM session.
 * A human-readable fingerprint of both identity keys.
 * Format: 12 groups of 5 digits (60 digits total), like Signal.
 */
export declare function getSafetyNumber(remoteDid: string): Promise<string | null>;
/** Initialize E2EE for an authenticated user. */
export declare function initialize(did: string, serverOrigin: string): Promise<void>;
/** Shut down E2EE and clear state. */
export declare function shutdown(): void;
/** Set a passphrase for a channel. Derives AES-256 key via HKDF. */
export declare function setChannelKey(channel: string, passphrase: string): Promise<void>;
/** Remove the encryption key for a channel. */
export declare function removeChannelKey(channel: string): void;
/** Encrypt a DM using the Double Ratchet. */
export declare function encryptMessage(remoteDid: string, plaintext: string, serverOrigin: string): Promise<string | null>;
/** Decrypt a DM using the Double Ratchet. */
export declare function decryptMessage(remoteDid: string, wire: string, serverOrigin?: string): Promise<string | null>;
/** Encrypt a message for a channel (ENC1 format). */
export declare function encryptChannel(channel: string, plaintext: string): Promise<string | null>;
/** Decrypt an ENC1 message. */
export declare function decryptChannel(channel: string, wire: string): Promise<string | null>;
/** Fetch a pre-key bundle for a remote user. */
export declare function fetchPreKeyBundle(origin: string, did: string): Promise<any | null>;
//# sourceMappingURL=e2ee.d.ts.map