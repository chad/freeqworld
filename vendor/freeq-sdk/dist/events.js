/**
 * Typed event emitter for the freeq SDK.
 *
 * Usage:
 *   client.on('message', (channel, message) => { ... });
 *   client.off('message', handler);
 *   client.once('connected', () => { ... });
 */
/**
 * Minimal typed event emitter.
 * Consumers subscribe to strongly-typed events.
 */
export class EventEmitter {
    listeners = new Map();
    /** Subscribe to an event. */
    on(event, handler) {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(handler);
        return this;
    }
    /** Unsubscribe from an event. */
    off(event, handler) {
        this.listeners.get(event)?.delete(handler);
        return this;
    }
    /** Subscribe to an event, but only fire once. */
    once(event, handler) {
        const wrapper = ((...args) => {
            this.off(event, wrapper);
            handler(...args);
        });
        return this.on(event, wrapper);
    }
    /** Emit an event to all subscribers. */
    emit(event, ...args) {
        const set = this.listeners.get(event);
        if (!set)
            return;
        for (const fn of set) {
            try {
                fn(...args);
            }
            catch (e) {
                console.error(`[freeq-sdk] Error in ${event} handler:`, e);
            }
        }
    }
    /** Remove all listeners (useful on disconnect). */
    removeAllListeners() {
        this.listeners.clear();
    }
}
//# sourceMappingURL=events.js.map