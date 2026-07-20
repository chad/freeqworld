/**
 * did:key generation + signing for SASL ATPROTO-CHALLENGE crypto auth.
 *
 * Lets a JS bot authenticate to freeq with no PDS, no OAuth, no
 * external service — just a freshly-generated ed25519 keypair.
 *
 * The public key is encoded as `did:key:z<base58btc(0xed01 || pubkey)>`
 * which the server resolves locally (no network fetch). The signer
 * produces a base64url-encoded ed25519 signature over the raw
 * challenge bytes the server emitted in the AUTHENTICATE line.
 *
 * Wire-compatible with `freeq-sdk` (Rust)'s `KeySigner` and
 * `verify_crypto` — round-trip verified by
 * `freeq-server/tests/agent_assist_authenticated.rs`.
 */
/** Result of [`generateDidKey`]: a fresh did:key + a sign callback. */
export interface DidKey {
    /** `did:key:z…` — give this to the freeq server as your identity. */
    did: string;
    /** Multibase-encoded public key (`z…`). The DID without the `did:key:` prefix. */
    publicKeyMultibase: string;
    /**
     * Sign the raw challenge bytes the server emitted in AUTHENTICATE.
     * Returns a base64url-encoded ed25519 signature suitable for the
     * `signature` field of a SASL ATPROTO-CHALLENGE response.
     */
    signer: (challengeBytes: Uint8Array) => Promise<string>;
    /**
     * Raw private key bytes (32). Use [`exportSeed`]/[`importDidKey`] to
     * persist between bot runs. Treat as secret.
     */
    exportSeed: () => Promise<Uint8Array>;
}
/**
 * Generate a fresh ed25519 did:key.
 *
 * Uses Web Crypto Subtle (`Ed25519`), available in Node 22+ and modern
 * browsers. Throws if Ed25519 isn't available — there's no fallback;
 * the bot author should bail and surface the missing-runtime error.
 */
export declare function generateDidKey(): Promise<DidKey>;
/**
 * Re-import a previously generated did:key from its raw 32-byte seed
 * (returned by [`DidKey.exportSeed`]).
 *
 * Lets a bot persist its identity between runs without the operator
 * managing a PEM file or PDS account. Just store the seed somewhere
 * safe (env var, secrets file).
 */
export declare function importDidKey(seed: Uint8Array): Promise<DidKey>;
//# sourceMappingURL=did-key.d.ts.map