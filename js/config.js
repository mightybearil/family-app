import { readJSON, writeJSON } from './utils.js';

/** Immutable app constants. Never overwritten by stored user settings. */
export const CONFIG = {
  VERSION: '1.1.0',

  CATEGORIES: [
    { id: 'house', name: 'משימות בית', icon: '🏠' },
    { id: 'shopping', name: 'קניות', icon: '🛒' },
    { id: 'general', name: 'כללי', icon: '📋' },
    { id: 'projects', name: 'פרויקטים', icon: '🏗️' },
    { id: 'events', name: 'אירועים', icon: '📅' }
  ],

  PRIORITIES: [
    { id: 'low', name: 'נמוכה' },
    { id: 'medium', name: 'בינונית' },
    { id: 'high', name: 'גבוהה' },
    { id: 'urgent', name: 'דחוף' }
  ],

  STATUSES: [
    { id: 'pending', name: 'ממתין', icon: '⏳' },
    { id: 'in_progress', name: 'בתהליך', icon: '🔄' },
    { id: 'completed', name: 'הושלם', icon: '✅' },
    { id: 'overdue', name: 'באיחור', icon: '⚠️' }
  ],

  // `photo` is a real portrait; `avatar` stays as the fallback when none is set.
  DEFAULT_MEMBERS: [
    { id: 'member1', name: 'אמיר', avatar: '👨', photo: 'assets/people/amir.jpg', phone: '' },
    { id: 'member2', name: 'יעל', avatar: '👩', photo: 'assets/people/yael.jpg', phone: '' }
  ],

  // Shown on the lock screen. Empty string falls back to the 🏠 emoji.
  COUPLE_PHOTO: 'assets/people/couple.jpg',

  STORAGE_KEYS: {
    PIN: 'family_pin',
    PIN_LEGACY_HASH: 'family_pin_hash',
    PIN_ATTEMPTS: 'family_pin_attempts',
    CURRENT_MEMBER: 'family_current_member',
    SETTINGS: 'family_settings',
    OFFLINE_QUEUE: 'family_offline_queue',
    FAILED_QUEUE: 'family_failed_queue',
    TASKS_CACHE: 'family_tasks_cache',
    COMMENTS: 'family_comments',
    LINKS: 'family_links',
    PHOTOS: 'family_photos',
    ACTIVITY: 'family_activity'
  },

  SESSION_KEYS: {
    UNLOCKED: 'family_unlocked'
  }
};

/**
 * When the app is served by its own backend, that origin is the backend — so
 * default to it rather than making every device type the address in by hand.
 * A device that skips this ends up silently local-only, which looks exactly
 * like "my partner's tasks are missing".
 *
 * Static hosts are excluded because there is no API there; pointing at them
 * would only produce failed requests. The API key is deliberately NOT defaulted:
 * anyone can load this page, so a key baked into the bundle would hand the
 * family's data to anyone who found the URL.
 */
function defaultBackendUrl() {
  if (typeof window === 'undefined') return '';
  const { origin, hostname, protocol } = window.location;
  if (!protocol.startsWith('http')) return '';
  const staticHost = hostname.endsWith('github.io') ||
    hostname.endsWith('netlify.app') ||
    hostname.endsWith('pages.dev');
  return staticHost ? '' : origin;
}

/** User-editable settings. Persisted separately so a corrupt blob cannot clobber CONFIG. */
export const settings = {
  nanobotUrl: defaultBackendUrl(),
  apiKey: '',
  theme: 'auto',
  autoUpdates: true,
  whatsappReminders: false,
  dailySummaryTime: '20:00',
  // Set once this device has uploaded its local tasks to a backend.
  serverMigratedAt: '',
  members: CONFIG.DEFAULT_MEMBERS.map((member) => ({ ...member }))
};

const SETTING_TYPES = {
  nanobotUrl: 'string',
  apiKey: 'string',
  theme: 'string',
  autoUpdates: 'boolean',
  whatsappReminders: 'boolean',
  dailySummaryTime: 'string',
  serverMigratedAt: 'string'
};

export function getCategory(id) {
  return CONFIG.CATEGORIES.find((c) => c.id === id) || CONFIG.CATEGORIES.find((c) => c.id === 'general');
}

export function isCategory(id) {
  return CONFIG.CATEGORIES.some((c) => c.id === id);
}

export function getPriority(id) {
  return CONFIG.PRIORITIES.find((p) => p.id === id) || CONFIG.PRIORITIES[1];
}

export function getStatus(id) {
  return CONFIG.STATUSES.find((s) => s.id === id) || CONFIG.STATUSES[0];
}

export function getMembers() {
  return settings.members;
}

export function getMember(id) {
  return settings.members.find((m) => m.id === id) || null;
}

/** Display info for an actor id, including the agent and unknown members. */
export function describeActor(id) {
  if (id === 'nanobot') return { id, name: 'ננובוט', avatar: '🤖', photo: '' };
  return getMember(id) || { id: id || 'unknown', name: 'לא ידוע', avatar: '👤', photo: '' };
}

export function loadSettings() {
  const stored = readJSON(CONFIG.STORAGE_KEYS.SETTINGS, null);
  if (stored && typeof stored === 'object') {
    for (const [key, expectedType] of Object.entries(SETTING_TYPES)) {
      if (typeof stored[key] !== expectedType) continue;
      // A device that ran an earlier build stored an empty URL. Letting that
      // overwrite the computed default would keep it local-only forever.
      if (key === 'nanobotUrl' && !stored[key].trim()) continue;
      settings[key] = stored[key];
    }
    if (Array.isArray(stored.members)) {
      settings.members = CONFIG.DEFAULT_MEMBERS.map((fallback) => {
        const saved = stored.members.find((m) => m && m.id === fallback.id) || {};
        return {
          id: fallback.id,
          name: typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim() : fallback.name,
          avatar: typeof saved.avatar === 'string' && saved.avatar ? saved.avatar : fallback.avatar,
          // Portraits ship with the app, so the bundled path always wins over
          // whatever an older settings blob happened to store.
          photo: fallback.photo,
          phone: typeof saved.phone === 'string' ? saved.phone.trim() : ''
        };
      });
    }
  }
  applyTheme(settings.theme);
  return settings;
}

export function saveSettings(patch) {
  // Pointing at a different backend means this device has never synced with it,
  // so its local tasks must be uploaded again.
  if ('nanobotUrl' in patch && patch.nanobotUrl !== settings.nanobotUrl && !('serverMigratedAt' in patch)) {
    settings.serverMigratedAt = '';
  }
  Object.assign(settings, patch);
  writeJSON(CONFIG.STORAGE_KEYS.SETTINGS, settings);
  if ('theme' in patch) applyTheme(settings.theme);
  return settings;
}

/**
 * 'auto' follows the OS; an explicit choice must win over prefers-color-scheme,
 * which is why both light and dark are stamped on the root element.
 */
export function applyTheme(theme = settings.theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
  const isDark = theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', isDark ? '#1A1118' : '#FFF8F5');
}

/** True once a reachable backend has been configured; otherwise the app stays local-only. */
export function isBackendConfigured() {
  if (!settings.nanobotUrl) return false;
  try {
    const url = new URL(settings.nanobotUrl);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
