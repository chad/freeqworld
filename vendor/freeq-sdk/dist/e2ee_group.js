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
const EG1_PREFIX = 'EG1:';
const EGK1_PREFIX = 'EGK1:';
// WebCrypto's lib.dom types reject `Uint8Array<ArrayBufferLike>` where a strict
// `BufferSource` is expected (SharedArrayBuffer strictness). The rest of this
// SDK works around it with an `any` view of SubtleCrypto; mirror that here.
const subtle = crypto.subtle;
// ── Steward: group lifecycle ──
/** Create a fresh group at epoch 1 with a random secret. */
export function createGroup(channel) {
    return {
        channel: channel.toLowerCase(),
        epoch: 1,
        secret: crypto.getRandomValues(new Uint8Array(32)),
    };
}
/** Mint the next epoch with a new random secret (call on membership change). */
export function rotate(state) {
    return {
        channel: state.channel,
        epoch: state.epoch + 1,
        secret: crypto.getRandomValues(new Uint8Array(32)),
    };
}
// ── Channel message encrypt / decrypt (EG1) ──
/** Encrypt a channel message → `EG1:<epoch>:<nonce>:<ct>`. */
export async function encryptGroup(state, plaintext) {
    const key = await messageKey(state);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(plaintext)));
    return `${EG1_PREFIX}${state.epoch}:${b64(iv)}:${b64(ct)}`;
}
/** Decrypt an `EG1:` message. Returns null on wrong epoch/key/tamper. */
export async function decryptGroup(state, wire) {
    if (!wire.startsWith(EG1_PREFIX))
        return null;
    const parts = wire.slice(EG1_PREFIX.length).split(':');
    if (parts.length !== 3)
        return null;
    const epoch = Number(parts[0]);
    if (!Number.isInteger(epoch) || epoch !== state.epoch)
        return null;
    try {
        const iv = unb64(parts[1]);
        const ct = unb64(parts[2]);
        if (iv.length !== 12)
            return null;
        const key = await messageKey(state);
        const cryptoKey = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
        const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
        return new TextDecoder().decode(pt);
    }
    catch {
        return null;
    }
}
/** True if `text` is an EG1 channel message. */
export function isGroupEncrypted(text) {
    return text.startsWith(EG1_PREFIX);
}
/** Read the epoch off an EG1 message without decrypting. */
export function parseEpoch(wire) {
    if (!wire.startsWith(EG1_PREFIX))
        return null;
    const n = Number(wire.slice(EG1_PREFIX.length).split(':')[0]);
    return Number.isInteger(n) ? n : null;
}
// ── Key wrap: seal to a member, open with your secret (EGK1) ──
/**
 * Steward: seal this epoch's secret to a member's raw 32-byte X25519 public key.
 * Ephemeral-static ECIES — a fresh ephemeral key per seal.
 */
export async function sealFor(state, memberPub) {
    const eph = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const ephPub = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    const shared = await x25519(eph.privateKey, memberPub);
    const wrapKey = await deriveWrapKey(shared, state.channel, state.epoch);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await subtle.importKey('raw', wrapKey, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, state.secret));
    return { channel: state.channel, epoch: state.epoch, ephemeralPub: ephPub, nonce: iv, ciphertext: ct };
}
/**
 * Member: recover the group state from a sealed key using your raw 32-byte
 * X25519 secret. This is the only way to obtain the secret; the server cannot.
 */
export async function openSealed(sealed, mySecret) {
    try {
        const myKey = await toPrivateKey(mySecret);
        const shared = await x25519(myKey, sealed.ephemeralPub);
        const wrapKey = await deriveWrapKey(shared, sealed.channel, sealed.epoch);
        const cryptoKey = await subtle.importKey('raw', wrapKey, { name: 'AES-GCM' }, false, ['decrypt']);
        const secret = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: sealed.nonce }, cryptoKey, sealed.ciphertext));
        if (secret.length !== 32)
            return null;
        return { channel: sealed.channel, epoch: sealed.epoch, secret };
    }
    catch {
        return null;
    }
}
/** Serialize to `EGK1:<channel>:<epoch>:<eph-pub>:<nonce>:<ct>`. */
export function sealedToWire(s) {
    return `${EGK1_PREFIX}${s.channel}:${s.epoch}:${b64(s.ephemeralPub)}:${b64(s.nonce)}:${b64(s.ciphertext)}`;
}
/** Parse an `EGK1:` control message. */
export function sealedFromWire(wire) {
    if (!wire.startsWith(EGK1_PREFIX))
        return null;
    const body = wire.slice(EGK1_PREFIX.length);
    // channel : epoch : ephPub : nonce : ct  — channel has no ':' for IRC names.
    const idx = [];
    for (let i = 0, found = 0; i < body.length && found < 4; i++) {
        if (body[i] === ':') {
            idx.push(i);
            found++;
        }
    }
    if (idx.length !== 4)
        return null;
    const channel = body.slice(0, idx[0]);
    const epoch = Number(body.slice(idx[0] + 1, idx[1]));
    if (!Number.isInteger(epoch))
        return null;
    try {
        return {
            channel,
            epoch,
            ephemeralPub: unb64(body.slice(idx[1] + 1, idx[2])),
            nonce: unb64(body.slice(idx[2] + 1, idx[3])),
            ciphertext: unb64(body.slice(idx[3] + 1)),
        };
    }
    catch {
        return null;
    }
}
// ── Convenience ──
/** Steward: seal to many members → `[member_did, EGK1-wire]` for the POST body. */
export async function sealBatch(state, members) {
    const out = [];
    for (const [did, pub] of members)
        out.push([did, sealedToWire(await sealFor(state, pub))]);
    return out;
}
/**
 * Member: from the sealed keys the server returned (each `[epoch, EGK1-wire]`),
 * recover the newest epoch we can open. Older epochs stay openable for history.
 */
export async function openBest(candidates, mySecret) {
    const sorted = [...candidates].sort((a, b) => b[0] - a[0]);
    for (const [, wire] of sorted) {
        const sealed = sealedFromWire(wire);
        if (!sealed)
            continue;
        const state = await openSealed(sealed, mySecret);
        if (state)
            return state;
    }
    return null;
}
// ── Crypto helpers (mirror freeq-sdk-js/src/e2ee.ts) ──
async function messageKey(state) {
    const salt = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(state.channel)));
    return hkdf(state.secret, salt, `freeq-group-msg-v1-${state.epoch}`);
}
async function deriveWrapKey(shared, channel, epoch) {
    const salt = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(channel.toLowerCase())));
    return hkdf(shared, salt, `freeq-group-keywrap-v1-${epoch}`);
}
async function hkdf(ikm, salt, info) {
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) }, base, 256);
    return new Uint8Array(bits);
}
/** Coerce a member secret into an importable X25519 private CryptoKey. */
async function toPrivateKey(sk) {
    if (sk instanceof CryptoKey)
        return sk;
    // Raw scalar pair → JWK (WebCrypto requires both d and x for OKP private keys).
    return subtle.importKey('jwk', { kty: 'OKP', crv: 'X25519', d: b64(sk.secret), x: b64(sk.publicKey) }, { name: 'X25519' }, false, ['deriveBits']);
}
async function x25519(mySecret, theirPublic) {
    const theirKey = await subtle.importKey('raw', theirPublic, { name: 'X25519' }, false, []);
    const bits = await subtle.deriveBits({ name: 'X25519', public: theirKey }, mySecret, 256);
    return new Uint8Array(bits);
}
function b64(data) {
    return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (str.length % 4)) % 4);
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
//# sourceMappingURL=e2ee_group.js.map