import { CONFIG, getMembers } from '../config.js';
import { store } from '../store.js';
import { html, raw, readJSON, writeJSON, showToast } from '../utils.js';

const PIN_LENGTH = 4;
const PBKDF2_ITERATIONS = 150000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60000;

const toHex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/**
 * A 4-digit PIN has only 10,000 candidates, so a bare SHA-256 digest is
 * brute-forced instantly. PBKDF2 with a per-install salt makes each guess costly.
 */
async function derivePin(pin, salt, iterations = PBKDF2_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toHex(bits);
}

async function legacyHash(pin) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin)));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function hasPin() {
  return Boolean(localStorage.getItem(CONFIG.STORAGE_KEYS.PIN) ||
    localStorage.getItem(CONFIG.STORAGE_KEYS.PIN_LEGACY_HASH));
}

export async function storePin(pin) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derivePin(pin, salt);
  writeJSON(CONFIG.STORAGE_KEYS.PIN, { v: 2, salt, iterations: PBKDF2_ITERATIONS, hash });
  localStorage.removeItem(CONFIG.STORAGE_KEYS.PIN_LEGACY_HASH);
}

export async function verifyPin(pin) {
  const record = readJSON(CONFIG.STORAGE_KEYS.PIN, null);
  if (record?.hash && record?.salt) {
    return timingSafeEqual(await derivePin(pin, record.salt, record.iterations || PBKDF2_ITERATIONS), record.hash);
  }
  // Upgrade the pre-1.1 unsalted digest on first successful login.
  const legacy = localStorage.getItem(CONFIG.STORAGE_KEYS.PIN_LEGACY_HASH);
  if (legacy && timingSafeEqual(await legacyHash(pin), legacy)) {
    await storePin(pin);
    return true;
  }
  return false;
}

function readAttempts() {
  return readJSON(CONFIG.STORAGE_KEYS.PIN_ATTEMPTS, { count: 0, until: 0 });
}

function lockoutRemainingMs() {
  const { until } = readAttempts();
  return Math.max(0, until - Date.now());
}

function registerFailure() {
  const attempts = readAttempts();
  attempts.count += 1;
  if (attempts.count >= MAX_ATTEMPTS) {
    // Escalate: every further block of failures locks for longer.
    const blocks = Math.floor(attempts.count / MAX_ATTEMPTS);
    attempts.until = Date.now() + LOCKOUT_MS * blocks;
  }
  writeJSON(CONFIG.STORAGE_KEYS.PIN_ATTEMPTS, attempts);
  return attempts;
}

function clearAttempts() {
  localStorage.removeItem(CONFIG.STORAGE_KEYS.PIN_ATTEMPTS);
}

export function render(container, params = {}) {
  // 'login' | 'setup' | 'confirm' | 'member' | 'verify-current'
  let mode;
  if (params.change === '1') mode = 'verify-current';
  else if (params.member === '1') mode = 'member';
  else mode = hasPin() ? 'login' : 'setup';

  let enteredPin = '';
  let firstPin = '';
  let errorMsg = '';
  let busy = false;
  let lockoutTimer = null;

  const screen = document.createElement('div');
  screen.className = 'auth-screen';
  container.appendChild(screen);

  const TITLES = {
    login: { title: 'היי! חזרתם 👋', subtitle: 'הזינו קוד גישה' },
    setup: { title: 'משימות משפחתיות', subtitle: 'ברוכים הבאים! הגדירו קוד גישה' },
    confirm: { title: 'משימות משפחתיות', subtitle: 'אמתו את קוד הגישה' },
    'verify-current': { title: 'שינוי קוד גישה', subtitle: 'הזינו את הקוד הנוכחי' },
    'new-pin': { title: 'שינוי קוד גישה', subtitle: 'הזינו קוד חדש' }
  };

  function renderMemberPicker() {
    screen.innerHTML = html`
      <div class="auth-logo" aria-hidden="true">👨‍👩‍👧‍👦</div>
      <h1 class="auth-title">מי אתם?</h1>
      <p class="auth-subtitle">בחרו את הפרופיל שלכם</p>
      <div class="member-select">
        ${getMembers().map((member) => raw(html`
          <button class="member-btn" type="button" data-id="${member.id}">
            <span class="member-avatar" aria-hidden="true">${member.avatar}</span>
            <span class="member-name">${member.name}</span>
          </button>
        `))}
      </div>
    `;

    screen.querySelectorAll('.member-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const member = getMembers().find((m) => m.id === button.dataset.id);
        if (!member) return;
        localStorage.setItem(CONFIG.STORAGE_KEYS.CURRENT_MEMBER, member.id);
        sessionStorage.setItem(CONFIG.SESSION_KEYS.UNLOCKED, '1');
        store.setState('currentMember', member);
        window.location.hash = '#/home';
      });
    });
  }

  function renderPinPad() {
    const locked = lockoutRemainingMs() > 0;
    const copy = TITLES[mode] || TITLES.login;

    screen.innerHTML = html`
      <div class="auth-logo" aria-hidden="true">🏠</div>
      <h1 class="auth-title">${copy.title}</h1>
      <p class="auth-subtitle">${copy.subtitle}</p>
      <p class="error-msg auth-error" role="alert">${errorMsg}</p>
      <div class="pin-input-container ${errorMsg && !locked ? 'shake' : ''}" id="pin-dots"
           role="status" aria-label="${enteredPin.length} מתוך ${PIN_LENGTH} ספרות">
        ${Array.from({ length: PIN_LENGTH }, (_, i) => raw(html`
          <span class="pin-dot ${enteredPin.length > i ? 'filled' : ''}"></span>
        `))}
      </div>
      <div class="numpad" id="numpad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => raw(html`
          <button class="numpad-key" type="button" data-val="${n}" ${locked ? raw('disabled') : ''}>${n}</button>
        `))}
        <span class="numpad-key numpad-key-empty" aria-hidden="true"></span>
        <button class="numpad-key" type="button" data-val="0" ${locked ? raw('disabled') : ''}>0</button>
        <button class="numpad-key delete-key" type="button" data-val="back"
                aria-label="מחק ספרה" ${locked ? raw('disabled') : ''}>⌫</button>
      </div>
      ${mode === 'login' && hasPin() ? raw(html`
        <button class="btn btn-ghost btn-sm auth-reset" type="button">שכחתם את הקוד?</button>
      `) : ''}
    `;

    screen.querySelector('#numpad').addEventListener('click', (event) => {
      const key = event.target.closest('.numpad-key');
      if (!key || key.disabled || busy) return;
      handleKey(key.dataset.val);
    });

    screen.querySelector('.auth-reset')?.addEventListener('click', showResetHelp);
  }

  async function showResetHelp() {
    const { confirmDialog } = await import('../components/modal.js');
    const reset = await confirmDialog({
      title: 'איפוס קוד גישה',
      message: 'איפוס הקוד ימחק את כל הנתונים המקומיים במכשיר הזה (משימות, רשימות ותמונות). האם להמשיך?',
      confirmText: 'אפס הכל',
      danger: true
    });
    if (!reset) return;
    localStorage.clear();
    sessionStorage.clear();
    window.location.reload();
  }

  function handleKey(value) {
    if (value === 'back') {
      if (enteredPin.length === 0) return;
      enteredPin = enteredPin.slice(0, -1);
      errorMsg = '';
      renderPinPad();
      return;
    }
    if (!/^[0-9]$/.test(value) || enteredPin.length >= PIN_LENGTH) return;

    enteredPin += value;
    errorMsg = '';
    renderPinPad();

    if (enteredPin.length === PIN_LENGTH) {
      busy = true;
      // Let the last dot paint before the (deliberately slow) key derivation.
      setTimeout(() => { handleComplete().finally(() => { busy = false; }); }, 120);
    }
  }

  function fail(message) {
    errorMsg = message;
    enteredPin = '';
    renderPinPad();
  }

  async function handleComplete() {
    const pin = enteredPin;

    if (mode === 'setup') {
      firstPin = pin;
      enteredPin = '';
      mode = 'confirm';
      renderPinPad();
      return;
    }

    if (mode === 'confirm') {
      if (pin !== firstPin) {
        firstPin = '';
        mode = 'setup';
        fail('הקודים אינם תואמים. נסו שוב.');
        return;
      }
      await storePin(pin);
      clearAttempts();
      sessionStorage.setItem(CONFIG.SESSION_KEYS.UNLOCKED, '1');
      enteredPin = '';
      mode = 'member';
      renderMemberPicker();
      return;
    }

    if (mode === 'new-pin') {
      await storePin(pin);
      clearAttempts();
      showToast('קוד הגישה עודכן', 'success');
      window.location.hash = '#/settings';
      return;
    }

    const remaining = lockoutRemainingMs();
    if (remaining > 0) {
      fail(`נסיונות רבים מדי. נסו שוב בעוד ${Math.ceil(remaining / 1000)} שניות.`);
      return;
    }

    const ok = await verifyPin(pin);
    if (!ok) {
      const attempts = registerFailure();
      const left = MAX_ATTEMPTS - (attempts.count % MAX_ATTEMPTS || MAX_ATTEMPTS);
      fail(lockoutRemainingMs() > 0
        ? `נסיונות רבים מדי. נסו שוב בעוד ${Math.ceil(lockoutRemainingMs() / 1000)} שניות.`
        : `קוד שגוי. נותרו ${left} נסיונות.`);
      scheduleLockoutRefresh();
      return;
    }

    clearAttempts();

    if (mode === 'verify-current') {
      enteredPin = '';
      mode = 'new-pin';
      renderPinPad();
      return;
    }

    sessionStorage.setItem(CONFIG.SESSION_KEYS.UNLOCKED, '1');
    const savedId = localStorage.getItem(CONFIG.STORAGE_KEYS.CURRENT_MEMBER);
    const member = getMembers().find((m) => m.id === savedId);
    if (member) {
      store.setState('currentMember', member);
      window.location.hash = '#/home';
    } else {
      enteredPin = '';
      mode = 'member';
      renderMemberPicker();
    }
  }

  function scheduleLockoutRefresh() {
    clearTimeout(lockoutTimer);
    if (lockoutRemainingMs() <= 0) return;
    lockoutTimer = setTimeout(() => {
      errorMsg = lockoutRemainingMs() > 0
        ? `נסיונות רבים מדי. נסו שוב בעוד ${Math.ceil(lockoutRemainingMs() / 1000)} שניות.`
        : '';
      renderPinPad();
      scheduleLockoutRefresh();
    }, 1000);
  }

  function onKeydown(event) {
    if (mode === 'member' || busy) return;
    if (/^[0-9]$/.test(event.key)) handleKey(event.key);
    else if (event.key === 'Backspace') handleKey('back');
  }

  if (mode === 'member') renderMemberPicker(); else renderPinPad();
  document.addEventListener('keydown', onKeydown);
  scheduleLockoutRefresh();

  return () => {
    document.removeEventListener('keydown', onKeydown);
    clearTimeout(lockoutTimer);
  };
}
