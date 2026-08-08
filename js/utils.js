/**
 * Shared helpers used by every screen.
 * Kept dependency-free so both app.js and api.js can import it without a cycle.
 */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

const RAW = Symbol('raw-markup');

/** Marks already-safe markup so `html` will not escape it again. */
export function raw(markup) {
  return { [RAW]: String(markup ?? '') };
}

function interpolate(value) {
  if (value == null) return '';
  // Booleans render as "true"/"false" so aria-* attributes are valid.
  // Conditional markup must therefore use a ternary, never `cond && html`...``.
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (typeof value === 'object' && RAW in value) return value[RAW];
  return escapeHtml(value);
}

/**
 * Tagged template that escapes every interpolated value.
 * Use raw() for markup that was built with html() itself.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1];
  return out;
}

const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

/** Returns a navigable URL, or '' for anything that could execute script. */
export function safeUrl(value) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  try {
    const parsed = new URL(withScheme);
    return SAFE_PROTOCOLS.includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

export function generateId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, delay) {
  let timeoutId;
  const wrapped = function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
  wrapped.cancel = () => clearTimeout(timeoutId);
  wrapped.flush = function (...args) {
    clearTimeout(timeoutId);
    fn.apply(this, args);
  };
  return wrapped;
}

/* ---------------------------------------------------------------- storage */

export function isQuotaError(error) {
  return error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

export function readJSON(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    if (stored == null) return fallback;
    const parsed = JSON.parse(stored);
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    return parsed;
  } catch {
    console.warn(`Discarding unreadable localStorage entry: ${key}`);
    return fallback;
  }
}

/** Returns false (and warns the user) when the write was rejected. */
export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    if (isQuotaError(error)) {
      showToast('אין מספיק מקום אחסון במכשיר. מחקו תמונות או משימות ישנות.', 'error');
    } else {
      console.error(`Failed to write ${key}`, error);
    }
    return false;
  }
}

/* ----------------------------------------------------------------- toasts */

function toastContainer() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * showToast('נשמר', 'success')
 * showToast('המשימה נמחקה', { actionLabel: 'בטל', onAction: restore })
 */
export function showToast(message, options = {}) {
  const config = typeof options === 'string' ? { type: options } : options;
  const { type = 'info', actionLabel, onAction } = config;
  const duration = config.duration ?? (actionLabel ? 6000 : 3200);

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.appendChild(text);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!toast.isConnected) return;
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  };

  if (actionLabel && onAction) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.type = 'button';
    button.textContent = actionLabel;
    button.addEventListener('click', () => {
      dismiss();
      onAction();
    });
    toast.appendChild(button);
  }

  toastContainer().appendChild(toast);
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

/* -------------------------------------------------------------- date/time */

/** Local calendar date as YYYY-MM-DD — never use toISOString(), it shifts by timezone. */
export function toDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
}

export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Human due-date label: היום / מחר / אתמול / short date. */
export function formatDueDate(dateKey) {
  if (!dateKey) return '';
  const today = toDateKey();
  if (dateKey === today) return 'היום';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dateKey === toDateKey(tomorrow)) return 'מחר';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey === toDateKey(yesterday)) return 'אתמול';
  return formatDate(dateKey);
}

export function formatRelativeTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return formatDateTime(value);
  if (seconds < 60) return 'עכשיו';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? 'לפני דקה' : `לפני ${minutes} דקות`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'לפני שעה' : `לפני ${hours} שעות`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'אתמול';
  if (days < 7) return `לפני ${days} ימים`;
  return formatDateTime(value);
}

export function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'בוקר טוב';
  if (hour < 18) return 'צהריים טובים';
  return 'ערב טוב';
}
