import { CONFIG, getCategory, getPriority, getMember, isCategory } from '../config.js';
import { api, isOverdue } from '../api.js';
import { bottomNav } from '../components/nav.js';
import { avatarInline } from '../components/avatar.js';
import { confirmDialog } from '../components/modal.js';
import { html, raw, debounce, showToast, formatDueDate, toDateKey } from '../utils.js';

const PRIORITY_ORDER = { urgent: 4, high: 3, medium: 2, low: 1 };

export async function render(container, params = {}) {
  const category = params.category && isCategory(params.category) ? params.category : null;
  if (params.category && !category) {
    window.location.hash = '#/tasks';
    return;
  }

  let tasks = [];
  let searchQuery = '';
  let activeFilter = 'all';
  let sortBy = 'created';
  let searchOpen = false;

  container.innerHTML = html`
    <div class="screen screen-with-nav">
      <header class="screen-header">
        <div class="flex-align-center gap-sm">
          ${category ? raw(html`
            <button class="btn btn-icon btn-ghost" id="back-btn" type="button" aria-label="חזרה">→</button>
          `) : ''}
          <h1 class="text-xl font-bold">${category ? getCategory(category).name : 'כל המשימות'}</h1>
        </div>
        <button class="btn btn-icon btn-ghost" id="search-toggle" type="button"
                aria-label="חיפוש" aria-expanded="false">🔍</button>
      </header>

      <div id="search-bar" class="search-bar" hidden>
        <input type="search" id="search-input" class="input" placeholder="חיפוש משימות..." autocomplete="off" />
      </div>

      <div class="filter-tabs" id="filter-tabs" role="tablist">
        <button class="filter-tab active" type="button" data-filter="all" role="tab" aria-selected="true">הכל</button>
        ${category ? '' : CONFIG.CATEGORIES.map((c) => raw(html`
          <button class="filter-tab" type="button" data-filter="cat_${c.id}" role="tab" aria-selected="false">${c.icon} ${c.name}</button>
        `))}
        ${CONFIG.STATUSES.map((s) => raw(html`
          <button class="filter-tab" type="button" data-filter="stat_${s.id}" role="tab" aria-selected="false">${s.icon} ${s.name}</button>
        `))}
      </div>

      <div class="sort-row">
        <label class="text-sm text-secondary" for="sort-select">מיון לפי</label>
        <select id="sort-select" class="select select-sm">
          <option value="created">תאריך יצירה</option>
          <option value="due">תאריך יעד</option>
          <option value="priority">עדיפות</option>
          <option value="name">שם</option>
        </select>
      </div>

      <main class="screen-content" id="task-list">
        <div class="loading-screen"><div class="spinner"></div></div>
      </main>

      <a class="fab" id="fab-add" href="#/task/new${category ? `?category=${category}` : ''}" aria-label="משימה חדשה">+</a>
      ${bottomNav(category === 'shopping' ? 'shopping' : 'tasks')}
    </div>
  `;

  const listEl = container.querySelector('#task-list');
  const searchBar = container.querySelector('#search-bar');
  const searchInput = container.querySelector('#search-input');
  const searchToggle = container.querySelector('#search-toggle');

  container.querySelector('#back-btn')?.addEventListener('click', () => {
    if (history.length > 1) history.back(); else window.location.hash = '#/home';
  });

  searchToggle.addEventListener('click', () => {
    searchOpen = !searchOpen;
    searchBar.hidden = !searchOpen;
    searchToggle.setAttribute('aria-expanded', String(searchOpen));
    if (searchOpen) {
      searchInput.focus();
    } else if (searchQuery) {
      searchQuery = '';
      searchInput.value = '';
      renderTasks();
    }
  });

  const onSearch = debounce((value) => {
    searchQuery = value.trim().toLowerCase();
    renderTasks();
  }, 150);
  searchInput.addEventListener('input', (event) => onSearch(event.target.value));

  container.querySelector('#sort-select').addEventListener('change', (event) => {
    sortBy = event.target.value;
    renderTasks();
  });

  container.querySelector('#filter-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.filter-tab');
    if (!tab) return;
    container.querySelectorAll('.filter-tab').forEach((other) => {
      other.classList.toggle('active', other === tab);
      other.setAttribute('aria-selected', String(other === tab));
    });
    activeFilter = tab.dataset.filter;
    renderTasks();
  });

  function visibleTasks() {
    // Copy before sorting so the master list keeps its own order.
    let filtered = [...tasks];
    if (category) filtered = filtered.filter((t) => t.category === category);
    if (searchQuery) {
      filtered = filtered.filter((t) =>
        t.title.toLowerCase().includes(searchQuery) || t.description.toLowerCase().includes(searchQuery));
    }
    if (activeFilter.startsWith('cat_')) {
      const id = activeFilter.slice(4);
      filtered = filtered.filter((t) => t.category === id);
    } else if (activeFilter.startsWith('stat_')) {
      const id = activeFilter.slice(5);
      filtered = filtered.filter((t) => (id === 'overdue' ? isOverdue(t) : t.status === id));
    }

    return filtered.sort((a, b) => {
      switch (sortBy) {
        case 'name': return a.title.localeCompare(b.title, 'he');
        case 'due': return (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31');
        case 'priority': return (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0);
        default: return b.created_at.localeCompare(a.created_at);
      }
    });
  }

  function taskCard(task) {
    const isCompleted = task.status === 'completed';
    const cat = getCategory(task.category);
    const priority = getPriority(task.priority);
    const assignee = task.assignee ? getMember(task.assignee) : null;
    const overdue = isOverdue(task);
    const dueSoon = task.due_date && !overdue && task.due_date <= toDateKey(new Date(Date.now() + 86400000));

    return html`
      <article class="task-card ${isCompleted ? 'completed' : ''}" data-id="${task.id}">
        <button class="task-checkbox" type="button" data-action="toggle"
                role="checkbox" aria-checked="${isCompleted}"
                aria-label="${isCompleted ? 'סמן כלא הושלם' : 'סמן כהושלם'}">✓</button>

        <div class="task-content" data-action="open" role="link" tabindex="0">
          <div class="flex-between gap-sm">
            <h3 class="task-title">${task.title || 'משימה ללא כותרת'}</h3>
            <span class="task-priority-dot prio-${priority.id}" title="${`עדיפות ${priority.name}`}"></span>
          </div>

          <div class="task-meta">
            <span class="chip chip-cat cat-${cat.id}">${cat.icon} ${cat.name}</span>
            ${assignee ? raw(html`<span class="task-assignee">${avatarInline(assignee)} ${assignee.name}</span>`) : ''}
            ${task.due_date ? raw(html`
              <span class="task-due ${overdue ? 'overdue' : ''} ${dueSoon ? 'due-soon' : ''}">
                📅 ${formatDueDate(task.due_date)}
              </span>
            `) : ''}
            ${task.category === 'shopping' && task.quantity > 1 ? raw(html`<span class="task-qty">×${task.quantity}</span>`) : ''}
          </div>

          ${task.progress > 0 && !isCompleted ? raw(html`
            <div class="progress-bar mt-xs">
              <div class="progress-fill" style="width: ${Math.min(100, task.progress)}%"></div>
            </div>
          `) : ''}
        </div>
      </article>
    `;
  }

  function renderTasks() {
    const filtered = visibleTasks();

    if (filtered.length === 0) {
      const isFiltered = Boolean(searchQuery) || activeFilter !== 'all';
      listEl.innerHTML = html`
        <div class="empty-state">
          <div class="empty-state-icon">${isFiltered ? '🔍' : '📭'}</div>
          <h2 class="empty-state-title">${isFiltered ? 'לא נמצאו משימות' : 'אין משימות כרגע. איזה כיף! 🎉'}</h2>
          <p class="empty-state-text">${isFiltered ? 'נסו לשנות את החיפוש או הסינון' : 'הוסיפו משימה חדשה כדי להתחיל'}</p>
          ${isFiltered ? '' : raw(html`
            <a class="btn btn-primary" href="#/task/new${category ? `?category=${category}` : ''}">+ הוסף משימה</a>
          `)}
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(taskCard).join('');
  }

  async function toggleTask(taskId) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const status = task.status === 'completed' ? 'pending' : 'completed';
    const updated = await api.updateTask(taskId, { status });
    if (updated) Object.assign(task, updated);
    renderTasks();
  }

  async function deleteTask(taskId) {
    const task = tasks.find((t) => t.id === taskId);
    const confirmed = await confirmDialog({
      title: 'מחיקת משימה',
      message: `למחוק את "${task?.title || 'המשימה'}"?`,
      confirmText: 'מחק',
      danger: true
    });
    if (!confirmed) return;

    const snapshot = await api.deleteTask(taskId);
    tasks = tasks.filter((t) => t.id !== taskId);
    renderTasks();

    showToast('המשימה נמחקה', {
      actionLabel: 'בטל',
      onAction: async () => {
        await api.restoreTask(snapshot);
        tasks = await api.getTasks();
        renderTasks();
      }
    });
  }

  listEl.addEventListener('click', (event) => {
    const card = event.target.closest('.task-card');
    if (!card) return;
    if (event.target.closest('[data-action="toggle"]')) {
      toggleTask(card.dataset.id);
      return;
    }
    window.location.hash = `#/task/${encodeURIComponent(card.dataset.id)}`;
  });

  listEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('[data-action="open"]');
    if (!target) return;
    event.preventDefault();
    window.location.hash = `#/task/${encodeURIComponent(target.closest('.task-card').dataset.id)}`;
  });

  // Horizontal swipe: right completes, left deletes. Ignored when the gesture
  // is mostly vertical (a scroll) or too slow to be a deliberate swipe.
  let touchStart = null;
  listEl.addEventListener('touchstart', (event) => {
    const card = event.target.closest('.task-card');
    if (!card) return;
    const touch = event.changedTouches[0];
    touchStart = { x: touch.screenX, y: touch.screenY, at: Date.now(), id: card.dataset.id };
  }, { passive: true });

  listEl.addEventListener('touchend', (event) => {
    if (!touchStart) return;
    const start = touchStart;
    touchStart = null;
    const touch = event.changedTouches[0];
    const dx = touch.screenX - start.x;
    const dy = touch.screenY - start.y;
    if (Date.now() - start.at > 800) return;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // RTL: a swipe toward the start edge (right) completes.
    if (dx > 0) toggleTask(start.id); else deleteTask(start.id);
  }, { passive: true });

  try {
    tasks = await api.getTasks();
  } catch (error) {
    console.error('Failed to load tasks', error);
    tasks = [];
    showToast('לא ניתן לטעון משימות', 'error');
  }
  renderTasks();
}
