// DM addressing: one rule for referencing a direct-message peer.
//
// A DM peer can be named two ways — a nick ("bob") or a DID
// ("did:plc:bob"). To make a DID the load-bearing identity, the same rule
// is applied everywhere a DM references a peer — the wire target we send to
// AND the local buffer/thread key we file under:
//
//   DID when we know it, else the input unchanged.
//
// Because it is idempotent (DID in → same DID out) and maps a known nick to
// the same DID, "bob" and "did:plc:bob" collapse to one conversation instead
// of splitting into two. An unknown nick — a guest, or a remote user this
// client hasn't learned a DID for — passes through untouched, so nick
// addressing keeps working exactly as before.
//
// Channels are never routed through this (callers guard on `#`/`&` first).
/** A syntactic DID: `did:<method>:<id>`. No network, no `id` validation. */
export function isDid(s) {
    return /^did:[a-z0-9]+:.+/i.test(s);
}
/**
 * Canonical key for a DM peer: its DID when known, else the input unchanged.
 * `resolve` maps a nick to its DID (undefined if unknown); a peer that is
 * already a DID is returned as-is without consulting it.
 */
export function dmPeerKey(peer, resolve) {
    if (isDid(peer))
        return peer;
    return resolve(peer) ?? peer;
}
//# sourceMappingURL=address.js.map