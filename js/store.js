/** Minimal reactive store. Screens subscribe to the keys they care about. */
export const store = {
  state: {
    tasks: [],
    currentMember: null,
    isOnline: navigator.onLine,
    isLoading: false,
    activeScreen: '',
    pendingSync: 0
  },

  listeners: new Map(),

  getState(key) {
    return this.state[key];
  },

  setState(key, value) {
    if (Object.is(this.state[key], value)) return;
    this.state[key] = value;
    const callbacks = this.listeners.get(key);
    if (!callbacks) return;
    for (const callback of [...callbacks]) {
      try {
        callback(value);
      } catch (error) {
        console.error(`Store listener for "${key}" failed`, error);
      }
    }
  },

  /** Returns an unsubscribe function so screens can clean up on teardown. */
  subscribe(key, callback) {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(callback);
    return () => this.unsubscribe(key, callback);
  },

  unsubscribe(key, callback) {
    this.listeners.get(key)?.delete(callback);
  }
};
