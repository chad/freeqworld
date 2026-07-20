/**
 * Client-side message signing using Ed25519 via Web Crypto API.
 *
 * After authentication, the client generates an Ed25519 keypair,
 * registers the public key with the server via MSGSIG, and signs
 * every outgoing PRIVMSG with +freeq.at/sig.
 */
let signingKey = null;
let publicKeyB64 = null;
let authenticatedDid = null;
/** Base64url encode (no padding). */
function b64url(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (const b of bytes)
        s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Generate Ed25519 keypair and return base64url public key. */
export async function generateSigningKey() {
    try {
        const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
        signingKey = kp;
        const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
        publicKeyB64 = b64url(rawPub);
        return publicKeyB64;
    }
    catch (e) {
        console.warn('Ed25519 not available in Web Crypto, falling back to server signing:', e);
        return null;
    }
}
/** Set the authenticated DID (called after SASL success). */
export function setSigningDid(did) {
    authenticatedDid = did;
}
/** Sign a PRIVMSG. Returns the signature tag value or null. */
export async function signMessage(target, text) {
    if (!signingKey?.privateKey || !authenticatedDid)
        return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const canonical = `${authenticatedDid}\0${target}\0${text}\0${timestamp}`;
    const encoded = new TextEncoder().encode(canonical);
    try {
        const sig = await crypto.subtle.sign('Ed25519', signingKey.privateKey, encoded);
        return b64url(sig);
    }
    catch {
        return null;
    }
}
/** Get the public key (for MSGSIG registration). */
export function getPublicKey() {
    return publicKeyB64;
}
/** Reset signing state (on disconnect). */
export function resetSigning() {
    signingKey = null;
    publicKeyB64 = null;
    authenticatedDid = null;
}
//# sourceMappingURL=signing.js.map