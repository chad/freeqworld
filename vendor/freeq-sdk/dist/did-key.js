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
// ─── base58btc + multicodec ─────────────────────────────────────────────
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/**
 * Base58btc encode a byte slice. Inline implementation (~25 lines) so
 * the SDK gains zero dependencies for this. Performance-irrelevant —
 * called once at key-generation time and never on a hot path.
 */
function base58btcEncode(bytes) {
    // Count leading zero bytes — base58 doesn't represent them
    // implicitly, so we prepend a '1' for each.
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0)
        zeros++;
    // Convert bytes to base58 by repeated division.
    const digits = [];
    for (let i = zeros; i < bytes.length; i++) {
        let carry = bytes[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let out = '';
    for (let i = 0; i < zeros; i++)
        out += '1';
    for (let i = digits.length - 1; i >= 0; i--)
        out += BASE58_ALPHABET[digits[i]];
    return out;
}
/** ed25519 multicodec public-key prefix (varint). */
const MULTICODEC_ED25519_PUB = new Uint8Array([0xed, 0x01]);
function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
function bytesToBase64Url(bytes) {
    let s = '';
    for (const b of bytes)
        s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/**
 * Generate a fresh ed25519 did:key.
 *
 * Uses Web Crypto Subtle (`Ed25519`), available in Node 22+ and modern
 * browsers. Throws if Ed25519 isn't available — there's no fallback;
 * the bot author should bail and surface the missing-runtime error.
 */
export async function generateDidKey() {
    // The `extractable: true` on the private key is required so that
    // exportSeed can return the seed for persistence. Web Crypto allows
    // sign() to use an extractable key normally.
    const kp = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']));
    return wrapKeypair(kp);
}
/**
 * Re-import a previously generated did:key from its raw 32-byte seed
 * (returned by [`DidKey.exportSeed`]).
 *
 * Lets a bot persist its identity between runs without the operator
 * managing a PEM file or PDS account. Just store the seed somewhere
 * safe (env var, secrets file).
 */
export async function importDidKey(seed) {
    if (seed.length !== 32) {
        throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`);
    }
    // Web Crypto's import format for a raw ed25519 private key is PKCS8.
    // We construct a minimal PKCS8 wrapper around the 32-byte seed.
    const pkcs8 = ed25519SeedToPkcs8(seed);
    // Cast: Web Crypto's `BufferSource` doesn't accept the
    // `Uint8Array<ArrayBufferLike>` shape Node's TS types produce, but the
    // runtime accepts plain Uint8Array fine.
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
    // Derive the public key from the private one — Web Crypto doesn't
    // give us a CryptoKeyPair, so we have to construct one. The public
    // half can be exported by re-deriving via JWK: export as JWK, take
    // the `x` field, import as raw public.
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    if (!jwk.x)
        throw new Error('exported JWK missing public component');
    const pubBytes = base64UrlDecode(jwk.x);
    const publicKey = await crypto.subtle.importKey('raw', pubBytes, 'Ed25519', true, ['verify']);
    return wrapKeypair({ privateKey, publicKey });
}
async function wrapKeypair(kp) {
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const multibase = `z${base58btcEncode(concat(MULTICODEC_ED25519_PUB, rawPub))}`;
    const did = `did:key:${multibase}`;
    const signer = async (challengeBytes) => {
        const sigBuf = await crypto.subtle.sign('Ed25519', kp.privateKey, challengeBytes);
        return bytesToBase64Url(new Uint8Array(sigBuf));
    };
    const exportSeed = async () => {
        const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
        if (!jwk.d)
            throw new Error('exported JWK missing seed (key was not extractable)');
        return base64UrlDecode(jwk.d);
    };
    return { did, publicKeyMultibase: multibase, signer, exportSeed };
}
// ─── PKCS8 wrapper for ed25519 seed import ──────────────────────────────
/**
 * Wrap a 32-byte ed25519 seed in the minimum PKCS8 envelope that
 * Web Crypto's importKey('pkcs8', …, 'Ed25519') accepts.
 *
 * Hand-coded DER because the structure is fixed: PKCS8 PrivateKeyInfo
 * for an Ed25519 key is always exactly these bytes followed by the
 * 32-byte seed inside an OCTET STRING inside an OCTET STRING.
 */
function ed25519SeedToPkcs8(seed) {
    // SEQUENCE {
    //   INTEGER 0                -- version
    //   SEQUENCE {               -- algorithm
    //     OID 1.3.101.112        -- ed25519
    //   }
    //   OCTET STRING {           -- privateKey
    //     OCTET STRING { seed }  -- inner
    //   }
    // }
    const prefix = new Uint8Array([
        0x30, 0x2e, // SEQUENCE 46
        0x02, 0x01, 0x00, // INTEGER 0
        0x30, 0x05, // SEQUENCE 5
        0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112
        0x04, 0x22, // OCTET STRING 34
        0x04, 0x20, // inner OCTET STRING 32
    ]);
    return concat(prefix, seed);
}
function base64UrlDecode(s) {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (padded.length % 4)) % 4;
    const bin = atob(padded + '='.repeat(pad));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
//# sourceMappingURL=did-key.js.map