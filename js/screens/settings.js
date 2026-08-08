import { CONFIG, settings, saveSettings, getMembers, isBackendConfigured } from '../config.js';
import { api, pendingSyncCount } from '../api.js';
import { store } from '../store.js';
import { bottomNav } from '../components/nav.js';
import { avatar, avatarInline } from '../components/avatar.js';
import { confirmDialog } from '../components/modal.js';
import { html, raw, showToast, debounce } from '../utils.js';

export function render(container) {
  const member = store.getState('currentMember');

  container.innerHTML = html`
    <div class="screen screen-with-nav">
      <header class="screen-header">
        <div class="flex-align-center gap-sm">
          <a class="btn btn-icon btn-ghost" href="#/home" aria-label="חזרה">→</a>
          <h1 class="text-xl font-bold">⚙️ הגדרות</h1>
        </div>
      </header>

      <main class="screen-content">
        <section class="settings-group">
          <h2 class="settings-group-title">פרופיל</h2>
          <div class="settings-item">
            <div class="flex-align-center gap-sm">
              ${avatar(member, 'lg')}
              <span class="font-semibold">${member?.name ?? 'אורח'}</span>
            </div>
            <a class="btn btn-sm btn-outline" href="#/auth?member=1">החלף משתמש</a>
          </div>
        </section>

        <section class="settings-group">
          <h2 class="settings-group-title">חברי המשפחה</h2>
          ${getMembers().map((m) => raw(html`
            <div class="settings-item settings-item-stack" data-member="${m.id}">
              <span class="text-sm text-secondary flex-align-center gap-xs">${avatarInline(m)} ${m.name}</span>
              <div class="settings-field-row">
                <label class="sr-only" for="member-name-${m.id}">שם</label>
                <input id="member-name-${m.id}" class="input" data-field="name" type="text"
                       value="${m.name}" placeholder="שם" maxlength="30" />
                <label class="sr-only" for="member-phone-${m.id}">טלפון</label>
                <input id="member-phone-${m.id}" class="input" data-field="phone" type="tel"
                       value="${m.phone}" placeholder="טלפון (לוואטסאפ)" inputmode="tel" />
              </div>
            </div>
          `))}
        </section>

        <section class="settings-group">
          <h2 class="settings-group-title">שרת</h2>
          <div class="settings-item settings-item-stack">
            <label class="input-label" for="server-url">כתובת שרת</label>
            <input id="server-url" class="input" type="url" inputmode="url"
                   placeholder="https://nanobot.example.com" value="${settings.nanobotUrl}" />
            <p class="text-xs text-tertiary mt-xs">בלי כתובת שרת האפליקציה עובדת במצב מקומי בלבד.</p>
          </div>
          <div class="settings-item settings-item-stack">
            <label class="input-label" for="api-key">מפתח API</label>
            <div class="settings-field-row">
              <input id="api-key" class="input" type="password" placeholder="הכניסו מפתח"
                     value="${settings.apiKey}" autocomplete="off" />
              <button class="btn btn-ghost" id="toggle-key" type="button" aria-label="הצג מפתח">👁️</button>
            </div>
          </div>
          <div class="settings-item">
            <button class="btn btn-primary btn-sm" id="test-connection" type="button">בדקו חיבור</button>
            <span class="connection-status" id="connection-status" role="status">
              ${isBackendConfigured() ? 'לא נבדק' : 'מצב מקומי'}
            </span>
          </div>
        </section>

        <section class="settings-group">
          <h2 class="settings-group-title">אבטחה</h2>
          <div class="settings-item">
            <span>קוד גישה</span>
            <a class="btn btn-sm btn-outline" href="#/auth?change=1">שנו קוד</a>
          </div>
          <div class="settings-item">
            <span>נעילה</span>
            <button class="btn btn-sm btn-outline" id="lock-now" type="button">נעלו עכשיו</button>
          </div>
        </section>

        <section class="settings-group">
          <h2 class="settings-group-title">ננובוט</h2>
          <div class="settings-item">
            <label for="auto-updates">עדכונים אוטומטיים</label>
            <button class="toggle-switch ${settings.autoUpdates ? 'active' : ''}" id="auto-updates"
                    type="button" role="switch" aria-checked="${settings.autoUpdates}"></button>
          </div>
          <div class="settings-item">
            <label for="wa-reminders">תזכורות בוואטסאפ</label>
            <button class="toggle-switch ${settings.whatsappReminders ? 'active' : ''}" id="wa-reminders"
                    type="button" role="switch" aria-checked="${settings.whatsappReminders}"></button>
          </div>
          <div class="settings-item">
            <label class="input-label" for="daily-time">שעת סיכום יומי</label>
            <input id="daily-time" class="input input-inline" type="time" value="${settings.dailySummaryTime}" />
          </div>
          <div class="settings-item">
            <span>הודעת בדיקה</span>
            <button class="btn btn-sm btn-outline" id="test-wa" type="button">שלחו</button>
          </div>
        </section>

        <section class="settings-group">
          <h2 class="settings-group-title">מראה</h2>
          <div class="settings-item">
            <label class="input-label" for="theme-select">ערכת נושא</label>
            <select id="theme-select" class="select input-inline">
              <option value="auto" ${settings.theme === 'auto' ? 'selected' : ''}>אוטומטי</option>
              <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>בהיר</option>
              <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>כהה</option>
            </select>
          </div>
        </section>

        <section class="settings-group">
          <h2 class="settings-group-title">נתונים</h2>
          <div class="settings-item">
            <span>גיבוי מלא (משימות, הערות, תמונות)</span>
            <button class="btn btn-sm btn-outline" id="export-data" type="button">ייצאו</button>
          </div>
          <div class="settings-item">
            <span>סנכרון</span>
            <span class="text-sm text-secondary" id="sync-status"></span>
          </div>
          <div class="settings-item">
            <span class="text-danger">מחיקת כל הנתונים</span>
            <button class="btn btn-sm btn-danger" id="delete-data" type="button">מחקו</button>
          </div>
        </section>

        <section class="settings-group text-center">
          <h3 class="font-bold">משימות משפחתיות</h3>
          <p class="text-sm text-secondary">גרסה ${CONFIG.VERSION}</p>
          <p class="text-sm text-secondary">נבנה עם 💜 עבור המשפחה</p>
        </section>
      </main>

      ${bottomNav('settings')}
    </div>
  `;

  const $ = (selector) => container.querySelector(selector);

  /* ------------------------------------------------------------ members */

  const saveMembers = debounce(() => {
    const members = getMembers().map((m) => {
      const row = container.querySelector(`[data-member="${m.id}"]`);
      return {
        ...m,
        name: row.querySelector('[data-field="name"]').value.trim() || m.name,
        phone: row.querySelector('[data-field="phone"]').value.trim()
      };
    });
    saveSettings({ members });
    // Keep the header greeting and any cached member reference in sync.
    const current = store.getState('currentMember');
    if (current) store.setState('currentMember', members.find((m) => m.id === current.id) || current);
    showToast('פרטי המשפחה נשמרו', 'success');
  }, 700);

  container.querySelectorAll('[data-member] input').forEach((input) => {
    input.addEventListener('input', saveMembers);
  });

  /* ------------------------------------------------------------- server */

  const serverUrl = $('#server-url');
  const apiKey = $('#api-key');
  const statusEl = $('#connection-status');

  const persistServer = debounce(() => {
    const url = serverUrl.value.trim();
    saveSettings({ nanobotUrl: url, apiKey: apiKey.value.trim() });
    statusEl.textContent = isBackendConfigured() ? 'לא נבדק' : 'מצב מקומי';
    statusEl.className = 'connection-status';
  }, 500);

  serverUrl.addEventListener('input', persistServer);
  apiKey.addEventListener('input', persistServer);

  $('#toggle-key').addEventListener('click', (event) => {
    const revealed = apiKey.type === 'text';
    apiKey.type = revealed ? 'password' : 'text';
    event.currentTarget.setAttribute('aria-label', revealed ? 'הצג מפתח' : 'הסתר מפתח');
  });

  $('#test-connection').addEventListener('click', async (event) => {
    persistServer.flush();
    const button = event.currentTarget;
    button.disabled = true;
    statusEl.textContent = 'בודק...';
    statusEl.className = 'connection-status pending';

    const result = await api.testConnection();
    const messages = {
      'not-configured': 'לא הוגדרה כתובת שרת',
      offline: 'אין חיבור לאינטרנט'
    };
    statusEl.textContent = result.ok ? 'מחובר ✓' : (messages[result.reason] || 'החיבור נכשל');
    statusEl.className = `connection-status ${result.ok ? 'ok' : 'fail'}`;
    button.disabled = false;
  });

  /* ------------------------------------------------------------ security */

  $('#lock-now').addEventListener('click', () => {
    sessionStorage.removeItem(CONFIG.SESSION_KEYS.UNLOCKED);
    window.location.hash = '#/auth';
  });

  /* ------------------------------------------------------------- nanobot */

  const bindToggle = (id, key) => {
    $(id).addEventListener('click', (event) => {
      const button = event.currentTarget;
      const next = !(button.getAttribute('aria-checked') === 'true');
      button.classList.toggle('active', next);
      button.setAttribute('aria-checked', String(next));
      saveSettings({ [key]: next });
    });
  };
  bindToggle('#auto-updates', 'autoUpdates');
  bindToggle('#wa-reminders', 'whatsappReminders');

  $('#daily-time').addEventListener('change', (event) => {
    saveSettings({ dailySummaryTime: event.target.value });
    showToast('שעת הסיכום עודכנה', 'success');
  });

  $('#test-wa').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const phone = getMembers().find((m) => m.id === store.getState('currentMember')?.id)?.phone;
    if (!isBackendConfigured()) {
      showToast('צריך להגדיר כתובת שרת קודם', 'error');
      return;
    }
    if (!phone) {
      showToast('הוסיפו מספר טלפון בפרטי חברי המשפחה', 'error');
      return;
    }
    button.disabled = true;
    try {
      await api.sendWhatsApp(phone, 'הודעת בדיקה ממשימות משפחתיות 🏠');
      showToast('הודעת הבדיקה נשלחה', 'success');
    } catch {
      // nanobotRequest already surfaced the failure.
    } finally {
      button.disabled = false;
    }
  });

  /* -------------------------------------------------------------- theme */

  $('#theme-select').addEventListener('change', (event) => {
    saveSettings({ theme: event.target.value });
  });

  /* --------------------------------------------------------------- data */

  const syncStatus = $('#sync-status');
  const renderSyncStatus = (count = pendingSyncCount()) => {
    if (!isBackendConfigured()) {
      syncStatus.textContent = 'מצב מקומי — אין סנכרון';
      return;
    }
    syncStatus.textContent = count === 0
      ? 'הכול מסונכרן'
      : `${count} פעולות ממתינות לסנכרון`;
  };
  renderSyncStatus();
  const unsubscribeSync = store.subscribe('pendingSync', renderSyncStatus);

  $('#export-data').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(api.exportAll(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `family-app-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke only after the download has been handed off.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('הגיבוי הורד', 'success');
  });

  $('#delete-data').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'מחיקת כל הנתונים',
      message: 'כל המשימות, ההערות והתמונות במכשיר יימחקו לצמיתות. פעולה זו אינה הפיכה.',
      confirmText: 'מחקו הכול',
      danger: true
    });
    if (!confirmed) return;
    localStorage.clear();
    sessionStorage.clear();
    window.location.hash = '#/auth';
    window.location.reload();
  });

  return () => {
    unsubscribeSync();
    saveMembers.cancel();
    persistServer.cancel();
  };
}
