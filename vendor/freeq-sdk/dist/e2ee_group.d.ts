/**
 * VC-bootstrapped end-to-end group encryption for channels (EG1 / EGK1).
 *
 * The web/TS counterpart of `freeq-sdk::e2ee_group` (Rust). Wire formats and
 * key derivation are byte-identical, so a Rust steward bot can seal a group key
 * that a browser member opens, and vice versa (both use RFC 7748 X25519,
 * HKDF-SHA256, and AES-256-GCM).
 *
 * Model (see docs/VC-BOOTSTRAPPED-CHANNEL-E2EE.md):
 *  - A channel has a RANDOM 32-byte group secret at a given epoch — NOT derived
 *    from any public value (that was the broken ENC2 mistake).
 *  - A steward seals the secret to each member's X25519 public key. The server
 *    stores/relays the sealed `EGK1:` blob but can never open it.
 *  - Channel traffic is `EG1:<epoch>:<nonce>:<ct>` AES-256-GCM ciphertext.
 *  - On membership change the steward rotates the epoch and re-seals to the
 *    remaining members only — the departed member cannot read new epochs.
 */
export interface GroupState {
    channel: string;
    epoch: number;
    /** Random 32-byte group secret. Never leaves a member's device unsealed. */
    secret: Uint8Array;
}
export interface SealedGroupKey {
    channel: string;
    epoch: number;
    ephemeralPub: Uint8Array;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
}
/**
 * A member's X25519 secret for opening sealed keys. WebCrypto cannot import an
 * X25519 private key from raw bytes, so pass EITHER the private `CryptoKey`
 * (the natural browser path — generate the keypair and keep it) OR the raw
 * `{ secret, publicKey }` scalar pair (for interop with keys minted elsewhere,
 * e.g. a Rust member — imported via JWK, which needs both halves).
 */
export type X25519Secret = CryptoKey | {
    secret: Uint8Array;
    publicKey: Uint8Array;
};
/** Create a fresh group at epoch 1 with a random secret. */
export declare function createGroup(channel: string): GroupState;
/** Mint the next epoch with a new random secret (call on membership change). */
export declare function rotate(state: GroupState): GroupState;
/** Encrypt a channel message → `EG1:<epoch>:<nonce>:<ct>`. */
export declare function encryptGroup(state: GroupState, plaintext: string): Promise<string>;
/** Decrypt an `EG1:` message. Returns null on wrong epoch/key/tamper. */
export declare function decryptGroup(state: GroupState, wire: string): Promise<string | null>;
/** True if `text` is an EG1 channel message. */
export declare function isGroupEncrypted(text: string): boolean;
/** Read the epoch off an EG1 message without decrypting. */
export declare function parseEpoch(wire: string): number | null;
/**
 * Steward: seal this epoch's secret to a member's raw 32-byte X25519 public key.
 * Ephemeral-static ECIES — a fresh ephemeral key per seal.
 */
export declare function sealFor(state: GroupState, memberPub: Uint8Array): Promise<SealedGroupKey>;
/**
 * Member: recover the group state from a sealed key using your raw 32-byte
 * X25519 secret. This is the only way to obtain the secret; the server cannot.
 */
export declare function openSealed(sealed: SealedGroupKey, mySecret: X25519Secret): Promise<GroupState | null>;
/** Serialize to `EGK1:<channel>:<epoch>:<eph-pub>:<nonce>:<ct>`. */
export declare function sealedToWire(s: SealedGroupKey): string;
/** Parse an `EGK1:` control message. */
export declare function sealedFromWire(wire: string): SealedGroupKey | null;
/** Steward: seal to many members → `[member_did, EGK1-wire]` for the POST body. */
export declare function sealBatch(state: GroupState, members: Array<[string, Uint8Array]>): Promise<Array<[string, string]>>;
/**
 * Member: from the sealed keys the server returned (each `[epoch, EGK1-wire]`),
 * recover the newest epoch we can open. Older epochs stay openable for history.
 */
export declare function openBest(candidates: Array<[number, string]>, mySecret: X25519Secret): Promise<GroupState | null>;
//# sourceMappingURL=e2ee_group.d.ts.map