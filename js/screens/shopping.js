import { api } from '../api.js';
import { bottomNav } from '../components/nav.js';
import { confirmDialog } from '../components/modal.js';
import { html, raw, showToast } from '../utils.js';

export async function render(container) {
  let items = [];
  let filter = 'all';

  container.innerHTML = html`
    <div class="screen screen-with-nav">
      <header class="screen-header">
        <h1 class="text-xl font-bold">🛒 קניות</h1>
        <button class="btn btn-sm btn-ghost text-danger" id="clear-completed" type="button" disabled>נקה שנקנו</button>
      </header>

      <form class="shopping-quick-add" id="add-item-form">
        <label class="sr-only" for="new-item-input">פריט חדש</label>
        <input type="text" id="new-item-input" class="input" placeholder="הוסיפו פריט..." autocomplete="off" required />
        <button class="btn btn-primary" type="submit" aria-label="הוסף">➕</button>
      </form>

      <div class="filter-tabs" id="shopping-filters" role="tablist">
        <button class="filter-tab active" type="button" data-filter="all" role="tab" aria-selected="true">הכל</button>
        <button class="filter-tab" type="button" data-filter="pending" role="tab" aria-selected="false">לקנות</button>
        <button class="filter-tab" type="button" data-filter="completed" role="tab" aria-selected="false">נקנה</button>
      </div>

      <main class="screen-content shopping-content" id="shopping-list">
        <div class="loading-screen"><div class="spinner"></div></div>
      </main>

      <div class="shopping-actions">
        <button class="btn btn-secondary btn-block" id="whatsapp-btn" type="button">שלחו רשימה בוואטסאפ 📱</button>
      </div>

      ${bottomNav('shopping')}
    </div>
  `;

  const listEl = container.querySelector('#shopping-list');
  const input = container.querySelector('#new-item-input');
  const clearBtn = container.querySelector('#clear-completed');

  const pendingItems = () => items.filter((item) => item.status !== 'completed');
  const boughtItems = () => items.filter((item) => item.status === 'completed');

  function itemRow(item) {
    const bought = item.status === 'completed';
    return html`
      <div class="shopping-item ${bought ? 'bought' : ''}" data-id="${item.id}">
        <button class="task-checkbox" type="button" data-action="toggle"
                role="checkbox" aria-checked="${bought}" aria-label="${item.title}">✓</button>
        <span class="shopping-name">${item.title}</span>
        <div class="quantity-stepper">
          <button type="button" data-action="minus" aria-label="הפחת כמות" ${item.quantity <= 1 ? 'disabled' : ''}>−</button>
          <span>${item.quantity}</span>
          <button type="button" data-action="plus" aria-label="הוסף כמות">+</button>
        </div>
        <button class="btn btn-icon btn-ghost" type="button" data-action="delete" aria-label="מחק פריט">🗑️</button>
      </div>
    `;
  }

  /** Only the list is re-rendered, so the quick-add input keeps focus and value. */
  function renderList() {
    const pending = pendingItems();
    const bought = boughtItems();
    clearBtn.disabled = bought.length === 0;

    if (items.length === 0) {
      listEl.innerHTML = html`
        <div class="empty-state">
          <div class="empty-state-icon">🛒</div>
          <h2 class="empty-state-title">הרשימה ריקה</h2>
          <p class="empty-state-text">הוסיפו פריטים לרשימת הקניות</p>
        </div>
      `;
      return;
    }

    const showPending = filter !== 'completed';
    const showBought = filter !== 'pending';

    listEl.innerHTML = html`
      ${showPending && pending.length > 0
        ? raw(html`<div class="card shopping-section">${raw(pending.map(itemRow).join(''))}</div>`)
        : ''}
      ${showBought && bought.length > 0
        ? raw(html`
            <h2 class="section-title mt-md">נקנו ✓ <span class="badge">${bought.length}</span></h2>
            <div class="card shopping-section">${raw(bought.map(itemRow).join(''))}</div>
          `)
        : ''}
      ${showPending && pending.length === 0 && filter === 'pending'
        ? raw('<p class="text-center text-secondary mt-md">הכל נקנה! 🎉</p>') : ''}
      ${showBought && bought.length === 0 && filter === 'completed'
        ? raw('<p class="text-center text-secondary mt-md">עדיין לא נקנה כלום</p>') : ''}
    `;
  }

  container.querySelector('#add-item-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    input.value = '';

    // Adding the same product again bumps its quantity instead of duplicating the row.
    const existing = pendingItems().find((item) => item.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      const updated = await api.updateTask(existing.id, { quantity: existing.quantity + 1 });
      if (updated) Object.assign(existing, updated);
    } else {
      items.push(await api.createTask({ title, category: 'shopping', status: 'pending', priority: 'medium' }));
    }
    renderList();
  });

  container.querySelector('#shopping-filters').addEventListener('click', (event) => {
    const tab = event.target.closest('.filter-tab');
    if (!tab) return;
    filter = tab.dataset.filter;
    container.querySelectorAll('#shopping-filters .filter-tab').forEach((other) => {
      other.classList.toggle('active', other === tab);
      other.setAttribute('aria-selected', String(other === tab));
    });
    renderList();
  });

  listEl.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const row = button.closest('.shopping-item');
    const item = items.find((candidate) => candidate.id === row?.dataset.id);
    if (!item) return;

    switch (button.dataset.action) {
      case 'toggle': {
        const updated = await api.updateTask(item.id, {
          status: item.status === 'completed' ? 'pending' : 'completed'
        });
        if (updated) Object.assign(item, updated);
        break;
      }
      case 'plus':
      case 'minus': {
        const delta = button.dataset.action === 'plus' ? 1 : -1;
        const quantity = Math.max(1, item.quantity + delta);
        if (quantity === item.quantity) return;
        const updated = await api.updateTask(item.id, { quantity });
        if (updated) Object.assign(item, updated);
        break;
      }
      case 'delete': {
        const snapshot = await api.deleteTask(item.id);
        items = items.filter((candidate) => candidate.id !== item.id);
        showToast(`"${item.title}" נמחק`, {
          actionLabel: 'בטל',
          onAction: async () => {
            await api.restoreTask(snapshot);
            items = await api.getTasks({ category: 'shopping' });
            renderList();
          }
        });
        break;
      }
    }
    renderList();
  });

  clearBtn.addEventListener('click', async () => {
    const bought = boughtItems();
    if (bought.length === 0) return;
    const confirmed = await confirmDialog({
      title: 'ניקוי הרשימה',
      message: `למחוק ${bought.length} פריטים שכבר נקנו?`,
      confirmText: 'מחק',
      danger: true
    });
    if (!confirmed) return;

    const snapshots = [];
    for (const item of bought) snapshots.push(await api.deleteTask(item.id));
    items = pendingItems();
    renderList();

    showToast(`${bought.length} פריטים נמחקו`, {
      actionLabel: 'בטל',
      onAction: async () => {
        for (const snapshot of snapshots) await api.restoreTask(snapshot);
        items = await api.getTasks({ category: 'shopping' });
        renderList();
      }
    });
  });

  container.querySelector('#whatsapp-btn').addEventListener('click', () => {
    const pending = pendingItems();
    if (pending.length === 0) {
      showToast('אין פריטים ברשימה', 'info');
      return;
    }
    const text = ['🛒 רשימת קניות:', ...pending.map((item) =>
      item.quantity > 1 ? `• ${item.title} (×${item.quantity})` : `• ${item.title}`)].join('\n');
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  });

  try {
    items = await api.getTasks({ category: 'shopping' });
  } catch (error) {
    console.error('Failed to load shopping list', error);
    items = [];
    showToast('לא ניתן לטעון את הרשימה', 'error');
  }
  renderList();

  // Desktop convenience only — auto-focus on touch would pop the keyboard open.
  if (!window.matchMedia('(pointer: coarse)').matches) input.focus();
}
