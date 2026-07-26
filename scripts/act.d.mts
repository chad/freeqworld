// Types for the agents' plain-ESM act implementation, so the conformance test
// (which holds it to the same vectors as shared/src/act.ts) typechecks.
export declare function actCanonical(tags: Record<string, string>): string
export declare function actKid(publicKey: Uint8Array): string
export declare function signAct(tags: Record<string, string>, secretKey: Uint8Array, publicKey: Uint8Array): string
export declare function ulid(now?: number): string
export declare function actTags(a: {
  kind: string; verb: string; id: string; from: string
  title?: string; to?: string; caps?: string; deadline?: number; ctxHash?: string; ref?: string
}): Record<string, string>
export declare const ACT_SIG_TAG: string
