/**
 * Client-side message signing using Ed25519 via Web Crypto API.
 *
 * After authentication, the client generates an Ed25519 keypair,
 * registers the public key with the server via MSGSIG, and signs
 * every outgoing PRIVMSG with +freeq.at/sig.
 */
/** Generate Ed25519 keypair and return base64url public key. */
export declare function generateSigningKey(): Promise<string | null>;
/** Set the authenticated DID (called after SASL success). */
export declare function setSigningDid(did: string): void;
/** Sign a PRIVMSG. Returns the signature tag value or null. */
export declare function signMessage(target: string, text: string): Promise<string | null>;
/** Get the public key (for MSGSIG registration). */
export declare function getPublicKey(): string | null;
/** Reset signing state (on disconnect). */
export declare function resetSigning(): void;
//# sourceMappingURL=signing.d.ts.map