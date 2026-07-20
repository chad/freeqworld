/**
 * AT Protocol profile fetcher with in-memory TTL cache.
 */
const cache = new Map();
const pending = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const PUBLIC_API = 'https://public.api.bsky.app';
/** Fetch an AT Protocol profile by DID or handle. Results are cached for 10 minutes. */
export async function fetchProfile(didOrHandle) {
    const cached = cache.get(didOrHandle);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
        return cached.profile;
    }
    const existing = pending.get(didOrHandle);
    if (existing)
        return existing;
    const promise = doFetch(didOrHandle);
    pending.set(didOrHandle, promise);
    try {
        return await promise;
    }
    finally {
        pending.delete(didOrHandle);
    }
}
async function doFetch(didOrHandle) {
    try {
        const url = `${PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(didOrHandle)}`;
        const res = await fetch(url);
        if (!res.ok)
            return null;
        const data = await res.json();
        const profile = {
            did: data.did,
            handle: data.handle,
            displayName: data.displayName,
            avatar: data.avatar,
            description: data.description,
            banner: data.banner,
            followersCount: data.followersCount,
            followsCount: data.followsCount,
            postsCount: data.postsCount,
        };
        cache.set(didOrHandle, { profile, fetchedAt: Date.now() });
        if (didOrHandle !== data.did) {
            cache.set(data.did, { profile, fetchedAt: Date.now() });
        }
        return profile;
    }
    catch {
        return null;
    }
}
/** Batch-fetch profiles for multiple DIDs. Non-blocking, best-effort. */
export function prefetchProfiles(dids) {
    for (const did of dids) {
        if (!cache.has(did)) {
            fetchProfile(did).catch(() => { });
        }
    }
}
/** Get a cached profile without fetching. Returns null if not cached. */
export function getCachedProfile(didOrHandle) {
    const cached = cache.get(didOrHandle);
    return cached ? cached.profile : null;
}
//# sourceMappingURL=profiles.js.map