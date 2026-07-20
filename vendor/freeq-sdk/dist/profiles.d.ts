/**
 * AT Protocol profile fetcher with in-memory TTL cache.
 */
export interface ATProfile {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
    description?: string;
    banner?: string;
    followersCount?: number;
    followsCount?: number;
    postsCount?: number;
}
/** Fetch an AT Protocol profile by DID or handle. Results are cached for 10 minutes. */
export declare function fetchProfile(didOrHandle: string): Promise<ATProfile | null>;
/** Batch-fetch profiles for multiple DIDs. Non-blocking, best-effort. */
export declare function prefetchProfiles(dids: string[]): void;
/** Get a cached profile without fetching. Returns null if not cached. */
export declare function getCachedProfile(didOrHandle: string): ATProfile | null;
//# sourceMappingURL=profiles.d.ts.map