/** A syntactic DID: `did:<method>:<id>`. No network, no `id` validation. */
export declare function isDid(s: string): boolean;
/**
 * Canonical key for a DM peer: its DID when known, else the input unchanged.
 * `resolve` maps a nick to its DID (undefined if unknown); a peer that is
 * already a DID is returned as-is without consulting it.
 */
export declare function dmPeerKey(peer: string, resolve: (nick: string) => string | undefined): string;
//# sourceMappingURL=address.d.ts.map