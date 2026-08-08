import { CONFIG, describeActor } from '../config.js';
import { api, isOverdue } from '../api.js';
import { store } from '../store.js';
import { bottomNav } from '../components/nav.js';
import { avatar } from '../components/avatar.js';
import { html, raw, getGreeting, toDateKey, formatRelativeTime } from '../utils.js';

const ACTIVITY_LABELS = {
  create_task: 'הוסיפו משימה',
  update_status: 'עדכנו סטטוס',
  delete_task: 'מחקו משימה',
  add_comment: 'הוסיפו הערה',
  add_photo: 'הוסיפו תמונה',
  add_link: 'הוסיפו קישור'
};

export async function render(container) {
  const member = store.getState('currentMember');
  let tasks = [];
  let activities = [];
  let loading = true;

  container.innerHTML = html`
    <div class="screen screen-with-nav">
      <div id="offline-bar" class="offline-bar" hidden>מצב לא מקוון — השינויים יסונכרנו מאוחר יותר</div>

      <header class="screen-header home-header">
        <div>
          <h1 class="greeting">${getGreeting()}, ${member?.name ?? 'אורח'}! 👋</h1>
          <p class="header-date">${new Date().toLocaleDateString('he-IL', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          })}</p>
        </div>
        <a class="btn btn-icon btn-ghost" href="#/settings" aria-label="הגדרות">⚙️</a>
      </header>

      <main class="screen-content" id="home-content">
        <div class="loading-screen"><div class="spinner"></div></div>
      </main>

      <a class="fab" href="#/task/new" aria-label="משימה חדשה">+</a>
      ${bottomNav('home')}
    </div>
  `;

  const content = container.querySelector('#home-content');
  const offlineBar = container.querySelector('#offline-bar');

  const syncOfflineBar = (online) => { offlineBar.hidden = online; };
  syncOfflineBar(store.getState('isOnline'));
  const unsubscribeOnline = store.subscribe('isOnline', syncOfflineBar);

  function renderContent() {
    if (loading) {
      content.innerHTML = html`<div class="loading-screen"><div class="spinner"></div></div>`;
      return;
    }

    const today = toDateKey();
    const mine = tasks.filter((t) => t.assignee === member?.id && t.status !== 'completed');
    const completedToday = tasks.filter((t) => t.status === 'completed' && t.updated_at?.startsWith(today));
    const overdue = tasks.filter(isOverdue);

    const categories = [
      ...CONFIG.CATEGORIES,
      { id: 'all', name: 'הכל', icon: '✨' }
    ];

    content.innerHTML = html`
      <section class="stats-row" aria-label="סיכום">
        <div class="stat-card">
          <div class="stat-value">${mine.length}</div>
          <div class="stat-label">המשימות שלי</div>
        </div>
        <div class="stat-card">
          <div class="stat-value stat-value-success">${completedToday.length}</div>
          <div class="stat-label">הושלמו היום</div>
        </div>
        <div class="stat-card ${overdue.length ? 'stat-card-danger' : ''}">
          <div class="stat-value ${overdue.length ? 'stat-value-danger' : ''}">${overdue.length}</div>
          <div class="stat-label">באיחור</div>
        </div>
      </section>

      <section class="home-section">
        <h2 class="section-title">קטגוריות</h2>
        <div class="category-grid">
          ${categories.map((category) => {
            const scoped = category.id === 'all' ? tasks : tasks.filter((t) => t.category === category.id);
            const active = scoped.filter((t) => t.status !== 'completed').length;
            return raw(html`
              <a class="category-card ${category.id === 'all' ? '' : `cat-${category.id}`}"
                 href="#/tasks${category.id === 'all' ? '' : `/${category.id}`}">
                <span class="category-icon" aria-hidden="true">${category.icon}</span>
                <span class="category-name">${category.name}</span>
                <span class="category-count">${active ? `${active} פעילות` : 'אין משימות'}</span>
              </a>
            `);
          })}
        </div>
      </section>

      <section class="home-section">
        <h2 class="section-title">פעילות אחרונה</h2>
        <div class="card activity-log">
          ${activities.length === 0
            ? raw(html`<p class="text-sm text-secondary text-center">אין פעילות אחרונה</p>`)
            : activities.slice(0, 6).map((activity) => {
              const actor = describeActor(activity.actor);
              return raw(html`
                <div class="activity-item">
                  ${avatar(actor, 'sm')}
                  <div class="activity-content">
                    <div class="activity-text">
                      <strong>${actor.name}</strong>
                      ${ACTIVITY_LABELS[activity.action] || activity.action}${activity.details ? ` — ${activity.details}` : ''}
                    </div>
                    <div class="activity-time">${formatRelativeTime(activity.created_at)}</div>
                  </div>
                </div>
              `);
            })}
        </div>
      </section>
    `;
  }

  renderContent();

  try {
    [tasks, activities] = await Promise.all([api.getTasks(), api.getActivityLog(null, 20)]);
  } catch (error) {
    console.error('Failed to load home data', error);
    tasks = [];
    activities = [];
  } finally {
    loading = false;
    if (container.isConnected) renderContent();
  }

  return () => unsubscribeOnline();
}
