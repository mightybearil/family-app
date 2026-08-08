import { CONFIG, loadSettings, getMember, applyTheme, settings } from './config.js';
import { api } from './api.js';
import { store } from './store.js';
import { showToast, html } from './utils.js';

export { store } from './store.js';

/**
 * Route patterns are matched in order, so `#/task/new` is served by `#/task/:id`
 * with id === 'new'. Defining an exact `#/task/new` entry would leave params empty.
 */
const ROUTES = [
  { pattern: '#/auth', load: () => import('./screens/auth.js') },
  { pattern: '#/home', load: () => import('./screens/home.js') },
  { pattern: '#/tasks', load: () => import('./screens/task-list.js') },
  { pattern: '#/tasks/:category', load: () => import('./screens/task-list.js') },
  { pattern: '#/task/:id', load: () => import('./screens/task-detail.js') },
  { pattern: '#/shopping', load: () => import('./screens/shopping.js') },
  { pattern: '#/settings', load: () => import('./screens/settings.js') }
];

/** Hashes that older builds linked to. */
const REDIRECTS = {
  '#/login': '#/auth',
  '#/projects': '#/tasks/projects',
  '#/': '#/tasks',
  '': '#/tasks'
};

export function navigateTo(hash) {
  window.location.hash = hash;
}

function matchRoute(hash) {
  for (const route of ROUTES) {
    if (!route.pattern.includes(':')) {
      if (route.pattern === hash) return { route, params: {} };
      continue;
    }
    const names = [];
    const regex = new RegExp(`^${route.pattern.replace(/:([^/]+)/g, (_, name) => {
      names.push(name);
      return '([^/?]+)';
    })}$`);
    const found = hash.match(regex);
    if (found) {
      const params = {};
      names.forEach((name, index) => { params[name] = decodeURIComponent(found[index + 1]); });
      return { route, params };
    }
  }
  return null;
}

function isUnlocked() {
  const hasPin = Boolean(localStorage.getItem(CONFIG.STORAGE_KEYS.PIN) ||
    localStorage.getItem(CONFIG.STORAGE_KEYS.PIN_LEGACY_HASH));
  if (!hasPin) return false;
  // Session-scoped: closing the app requires the PIN again.
  return sessionStorage.getItem(CONFIG.SESSION_KEYS.UNLOCKED) === '1' &&
    Boolean(store.getState('currentMember'));
}

let currentTeardown = null;

async function handleRoute() {
  const fullHash = window.location.hash || '#/tasks';
  const [hashPath, queryString] = fullHash.split('?');

  const redirect = REDIRECTS[hashPath];
  if (redirect) return navigateTo(redirect + (queryString ? `?${queryString}` : ''));

  store.setState('activeScreen', hashPath);

  if (!isUnlocked() && hashPath !== '#/auth') return navigateTo('#/auth');
  if (isUnlocked() && hashPath === '#/auth') return navigateTo('#/tasks');

  const appContainer = document.getElementById('app');
  if (!appContainer) return;

  // Let the previous screen detach its store subscriptions and timers.
  try {
    currentTeardown?.();
  } catch (error) {
    console.error('Screen teardown failed', error);
  }
  currentTeardown = null;

  const params = {};
  if (queryString) {
    for (const [key, value] of new URLSearchParams(queryString)) params[key] = value;
  }

  const matched = matchRoute(hashPath);
  if (!matched) {
    appContainer.innerHTML = html`
      <div class="screen">
        <div class="empty-state">
          <div class="empty-state-icon">🧭</div>
          <h1 class="empty-state-title">העמוד לא נמצא</h1>
          <p class="empty-state-text">הקישור שביקשתם אינו קיים.</p>
          <a class="btn btn-primary" href="#/home">חזרה לדף הבית</a>
        </div>
      </div>
    `;
    return;
  }

  appContainer.innerHTML = html`
    <div class="loading-screen"><div class="spinner"></div><span>טוען...</span></div>
  `;

  try {
    const module = await matched.route.load();
    if (typeof module.render !== 'function') throw new Error('Screen has no render() export');
    // A newer navigation may have started while this module was loading.
    if (store.getState('activeScreen') !== hashPath) return;
    appContainer.innerHTML = '';
    currentTeardown = await module.render(appContainer, { ...matched.params, ...params }) || null;
  } catch (error) {
    console.error('Error loading route', hashPath, error);
    appContainer.innerHTML = html`
      <div class="screen">
        <div class="empty-state">
          <div class="empty-state-icon">⚠️</div>
          <h1 class="empty-state-title">שגיאה בטעינת המסך</h1>
          <p class="empty-state-text">משהו השתבש. נסו שוב או חזרו לדף הבית.</p>
          <a class="btn btn-primary" href="#/home">חזרה לדף הבית</a>
        </div>
      </div>
    `;
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('sw.js');

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // controller exists => this is an update, not the first install.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('גרסה חדשה זמינה', {
              actionLabel: 'רענן',
              duration: 20000,
              onAction: () => installing.postMessage({ type: 'SKIP_WAITING' })
            });
          }
        });
      });

      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    } catch (error) {
      console.warn('ServiceWorker registration failed', error);
    }
  });
}

function init() {
  loadSettings();

  const storedMember = localStorage.getItem(CONFIG.STORAGE_KEYS.CURRENT_MEMBER);
  if (storedMember) {
    // Older builds stored the whole member object; keep only the id as the source of truth.
    let memberId = storedMember;
    try {
      const parsed = JSON.parse(storedMember);
      if (parsed && typeof parsed === 'object' && parsed.id) memberId = parsed.id;
    } catch { /* already a plain id */ }
    localStorage.setItem(CONFIG.STORAGE_KEYS.CURRENT_MEMBER, memberId);
    const member = getMember(memberId);
    if (member) store.setState('currentMember', member);
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme('auto');
  });

  window.addEventListener('hashchange', handleRoute);

  window.addEventListener('online', () => {
    store.setState('isOnline', true);
    api.syncOfflineQueue();
  });
  window.addEventListener('offline', () => store.setState('isOnline', false));

  // Retry queued mutations periodically, but only when there is something to send.
  setInterval(() => {
    if (navigator.onLine && store.getState('pendingSync') > 0) api.syncOfflineQueue();
  }, 60000);

  registerServiceWorker();
  handleRoute();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
