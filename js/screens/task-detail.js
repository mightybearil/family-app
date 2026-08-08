import { CONFIG, getCategory, getPriority, getStatus, getMembers, describeActor, isCategory } from '../config.js';
import { api, emptyTask, isOverdue } from '../api.js';
import { store } from '../store.js';
import { avatar, avatarInline } from '../components/avatar.js';
import { confirmDialog, promptDialog, openPhotoViewer } from '../components/modal.js';
import { html, raw, safeUrl, debounce, showToast, formatRelativeTime, formatDateTime } from '../utils.js';

const MAX_PHOTO_EDGE = 1280;
const PHOTO_QUALITY = 0.75;

/** Downscales before storing — full-resolution camera shots blow the localStorage quota. */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('decode-failed'));
      image.onload = () => {
        const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export async function render(container, params = {}) {
  const isNew = params.id === 'new';
  const currentMember = store.getState('currentMember');

  let task = isNew
    ? emptyTask({
      category: isCategory(params.category) ? params.category : 'general',
      assignees: currentMember?.id ? [currentMember.id] : [],
      created_by: currentMember?.id ?? null
    })
    : await api.getTask(params.id);

  if (!task) {
    container.innerHTML = html`
      <div class="screen">
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <h1 class="empty-state-title">המשימה לא נמצאה</h1>
          <p class="empty-state-text">ייתכן שהיא נמחקה ממכשיר אחר.</p>
          <a class="btn btn-primary" href="#/tasks">חזרה לרשימת המשימות</a>
        </div>
      </div>
    `;
    return;
  }

  let comments = isNew ? [] : await api.getComments(task.id);
  let links = isNew ? [] : await api.getLinks(task.id);
  let photos = isNew ? [] : await api.getPhotos(task.id);
  let activity = isNew ? [] : await api.getActivityLog(task.id, 30);

  container.innerHTML = html`
    <div class="screen">
      <header class="screen-header">
        <div class="flex-align-center gap-sm">
          <button class="btn btn-icon btn-ghost" id="back-btn" type="button" aria-label="חזרה">→</button>
          <h1 class="text-lg font-bold" id="header-title">${isNew ? 'משימה חדשה' : (task.title || 'משימה ללא כותרת')}</h1>
        </div>
        <div class="flex-align-center gap-xs">
          <button class="btn btn-icon btn-ghost" id="share-btn" type="button" aria-label="שיתוף">📤</button>
          ${isNew ? '' : raw(html`
            <button class="btn btn-icon btn-ghost" id="delete-btn" type="button" aria-label="מחיקה">🗑️</button>
          `)}
        </div>
      </header>

      <div class="screen-content detail-content">
        <div class="input-group">
          <label class="sr-only" for="task-title">כותרת המשימה</label>
          <input type="text" id="task-title" class="detail-title-input" placeholder="כותרת המשימה"
                 value="${task.title}" maxlength="140" />
        </div>

        <div class="input-group">
          <label class="sr-only" for="task-desc">תיאור</label>
          <textarea id="task-desc" class="detail-desc-input" rows="2" placeholder="תיאור (אופציונלי)">${task.description}</textarea>
        </div>

        <section class="card detail-section">
          <div class="field">
            <span class="input-label">קטגוריה</span>
            <div class="chip-row" id="category-selector" role="radiogroup" aria-label="קטגוריה">
              ${CONFIG.CATEGORIES.map((c) => raw(html`
                <button class="chip-toggle cat-${c.id}" type="button" data-val="${c.id}" role="radio"
                        aria-checked="${c.id === task.category}">${c.icon} ${c.name}</button>
              `))}
            </div>
          </div>

          <div class="field">
            <span class="input-label">עדיפות</span>
            <div class="priority-options" id="priority-selector" role="radiogroup" aria-label="עדיפות">
              ${CONFIG.PRIORITIES.map((p) => raw(html`
                <button class="priority-option prio-${p.id}" type="button" data-val="${p.id}" role="radio"
                        aria-checked="${p.id === task.priority}">${p.name}</button>
              `))}
            </div>
          </div>

          <div class="field">
            <span class="input-label">מוקצה ל</span>
            <div class="chip-row" id="assignee-selector" role="group" aria-label="מוקצה ל">
              ${getMembers().map((m) => raw(html`
                <button class="chip-toggle" type="button" data-val="${m.id}" role="checkbox"
                        aria-checked="${(task.assignees || []).includes(m.id)}">${avatarInline(m)} ${m.name}</button>
              `))}
            </div>
          </div>

          <div class="field">
            <label class="input-label" for="task-due-date">תאריך יעד</label>
            <input type="date" id="task-due-date" class="input" value="${task.due_date ?? ''}" />
          </div>

          <div class="field">
            <span class="input-label">סטטוס</span>
            <div class="chip-row" id="status-selector" role="radiogroup" aria-label="סטטוס">
              ${CONFIG.STATUSES.map((s) => raw(html`
                <button class="chip-toggle" type="button" data-val="${s.id}" role="radio"
                        aria-checked="${s.id === task.status}">${s.icon} ${s.name}</button>
              `))}
            </div>
          </div>

          <div class="field">
            <div class="flex-between">
              <label class="input-label" for="task-progress">התקדמות</label>
              <span class="text-sm font-semibold" id="progress-val">${task.progress}%</span>
            </div>
            <input type="range" id="task-progress" class="range-input" min="0" max="100" step="5" value="${task.progress}" />
          </div>

          ${task.category === 'shopping' ? raw(html`
            <div class="field">
              <label class="input-label" for="task-quantity">כמות</label>
              <input type="number" id="task-quantity" class="input" min="1" max="99" value="${task.quantity}" />
            </div>
          `) : ''}
        </section>

        <section class="card detail-section">
          <div class="flex-between mb-sm">
            <h2 class="text-md font-semibold">קישורים</h2>
            <button class="btn btn-sm btn-ghost text-accent" id="add-link-btn" type="button">+ הוסף</button>
          </div>
          <div id="links-container" class="flex-col gap-xs"></div>
        </section>

        <section class="card detail-section">
          <div class="flex-between mb-sm">
            <h2 class="text-md font-semibold">תמונות</h2>
            <button class="btn btn-sm btn-ghost text-accent" id="add-photo-btn" type="button">+ הוסף</button>
          </div>
          <input type="file" id="photo-upload" accept="image/*" hidden />
          <div id="photos-container" class="photo-grid"></div>
        </section>

        ${isNew ? '' : raw(html`
          <section class="card detail-section">
            <details>
              <summary class="text-md font-semibold">היסטוריית שינויים</summary>
              <div id="activity-container" class="activity-log mt-sm"></div>
            </details>
          </section>

          <section class="card detail-section">
            <h2 class="text-md font-semibold mb-sm">הערות <span class="text-tertiary font-regular" id="comment-count">(0)</span></h2>
            <div id="comments-container" class="comment-thread"></div>
            <div class="comment-input-area">
              <label class="sr-only" for="new-comment">הערה חדשה</label>
              <input type="text" id="new-comment" class="input" placeholder="הוסיפו הערה..." maxlength="500" />
              <button class="btn btn-primary" id="send-comment" type="button">שלח</button>
            </div>
          </section>
        `)}
      </div>

      ${isNew ? raw(html`
        <div class="detail-action-bar">
          <button class="btn btn-primary btn-lg btn-block" id="save-new-btn" type="button">שמור משימה</button>
        </div>
      `) : raw(html`
        <div class="save-indicator" id="save-indicator" role="status" aria-live="polite"></div>
      `)}
    </div>
  `;

  const $ = (selector) => container.querySelector(selector);
  const titleInput = $('#task-title');
  const descInput = $('#task-desc');
  const progressInput = $('#task-progress');
  const progressVal = $('#progress-val');
  const dueInput = $('#task-due-date');
  const quantityInput = $('#task-quantity');
  const saveIndicator = $('#save-indicator');
  const headerTitle = $('#header-title');

  function autoGrow() {
    descInput.style.height = 'auto';
    descInput.style.height = `${descInput.scrollHeight}px`;
  }
  autoGrow();

  function syncSelectors() {
    const map = [
      ['#category-selector', task.category],
      ['#priority-selector', task.priority],

      ['#status-selector', task.status]
    ];
    for (const [selector, value] of map) {
      container.querySelectorAll(`${selector} [data-val]`).forEach((button) => {
        const selected = button.dataset.val === value;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-checked', String(selected));
      });
    }

    // Assignees are a multi-select: either of them, or both.
    container.querySelectorAll('#assignee-selector [data-val]').forEach((button) => {
      const selected = (task.assignees || []).includes(button.dataset.val);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', String(selected));
    });
  }

  function renderLinks() {
    const target = $('#links-container');
    if (links.length === 0) {
      target.innerHTML = html`<p class="text-sm text-tertiary">אין קישורים</p>`;
      return;
    }
    target.innerHTML = links.map((link) => html`
      <div class="link-item">
        <a href="${safeUrl(link.url) || '#'}" target="_blank" rel="noopener noreferrer" class="truncate">${link.title}</a>
        <button class="btn btn-icon btn-ghost text-danger" type="button" data-id="${link.id}" aria-label="מחק קישור">✕</button>
      </div>
    `).join('');
  }

  function renderPhotos() {
    const target = $('#photos-container');
    if (photos.length === 0) {
      target.innerHTML = html`<p class="text-sm text-tertiary">אין תמונות</p>`;
      return;
    }
    target.innerHTML = photos.map((photo) => html`
      <div class="photo-cell">
        <img class="photo-thumb" src="${photo.path}" alt="${photo.filename}" data-id="${photo.id}" />
        <button class="photo-remove" type="button" data-id="${photo.id}" aria-label="מחק תמונה">✕</button>
      </div>
    `).join('');
  }

  function renderComments() {
    const target = $('#comments-container');
    if (!target) return;
    $('#comment-count').textContent = `(${comments.length})`;
    if (comments.length === 0) {
      target.innerHTML = html`<p class="text-sm text-tertiary">אין הערות</p>`;
      return;
    }
    target.innerHTML = comments.map((comment) => {
      const author = describeActor(comment.author);
      const mine = comment.author && comment.author === currentMember?.id;
      return html`
        <div class="comment-item ${mine ? 'mine' : ''}">
          ${avatar(author, 'sm')}
          <div class="comment-content">
            <div class="comment-header">
              <span class="comment-author">${author.name}</span>
              <span class="comment-time">${formatRelativeTime(comment.created_at)}</span>
            </div>
            <p class="comment-text">${comment.content}</p>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderActivity() {
    const target = $('#activity-container');
    if (!target) return;
    if (activity.length === 0) {
      target.innerHTML = html`<p class="text-sm text-tertiary">אין היסטוריה</p>`;
      return;
    }
    target.innerHTML = activity.map((entry) => {
      const actor = describeActor(entry.actor);
      return html`
        <div class="activity-item">
          <span class="activity-icon" aria-hidden="true">${actor.avatar}</span>
          <div class="activity-content">
            <div class="activity-text">${actor.name} — ${entry.details || entry.action}</div>
            <div class="activity-time">${formatDateTime(entry.created_at)}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  /* ------------------------------------------------------------ saving */

  function collectFields() {
    task.title = titleInput.value.trim();
    task.description = descInput.value;
    task.progress = Number.parseInt(progressInput.value, 10) || 0;
    task.due_date = dueInput.value || null;
    if (quantityInput) {
      task.quantity = Math.max(1, Number.parseInt(quantityInput.value, 10) || 1);
    }
    // Reaching 100% means done; completing a task fills the bar.
    if (task.progress === 100 && task.status !== 'completed') task.status = 'completed';
    if (task.status === 'completed' && task.progress < 100) task.progress = 100;
  }

  function setIndicator(text, state = '') {
    if (!saveIndicator) return;
    saveIndicator.textContent = text;
    saveIndicator.className = `save-indicator ${text ? 'visible' : ''} ${state}`;
  }

  const persist = debounce(async () => {
    try {
      const updated = await api.updateTask(task.id, task);
      if (updated) task = updated;
      headerTitle.textContent = task.title || 'משימה ללא כותרת';
      setIndicator('נשמר ✓', 'success');
      setTimeout(() => setIndicator(''), 1800);
      syncSelectors();
    } catch (error) {
      console.error('Save failed', error);
      setIndicator('שגיאה בשמירה', 'error');
    }
  }, 700);

  function triggerSave() {
    if (isNew) return;
    collectFields();
    setIndicator('שומר...');
    persist();
  }

  /* ----------------------------------------------------------- events */

  $('#back-btn').addEventListener('click', () => {
    if (history.length > 1) history.back(); else window.location.hash = '#/tasks';
  });

  titleInput.addEventListener('input', triggerSave);
  descInput.addEventListener('input', () => { autoGrow(); triggerSave(); });
  dueInput.addEventListener('change', triggerSave);
  quantityInput?.addEventListener('change', triggerSave);
  progressInput.addEventListener('input', (event) => {
    progressVal.textContent = `${event.target.value}%`;
    triggerSave();
  });

  const selectorHandlers = {
    '#category-selector': (value) => { task.category = value; },
    '#priority-selector': (value) => { task.priority = value; },
    '#status-selector': (value) => { task.status = value; },
    // Multi-select: tapping toggles that person on or off, so a chore can be
    // assigned to one of them or to both.
    '#assignee-selector': (value) => {
      const current = new Set(task.assignees || []);
      if (current.has(value)) current.delete(value); else current.add(value);
      task.assignees = [...current];
      task.assignee = task.assignees[0] ?? null;
    }
  };

  for (const [selector, apply] of Object.entries(selectorHandlers)) {
    $(selector).addEventListener('click', (event) => {
      const button = event.target.closest('[data-val]');
      if (!button) return;
      apply(button.dataset.val);
      if (selector === '#status-selector' && task.status === 'completed') {
        task.progress = 100;
        progressInput.value = 100;
        progressVal.textContent = '100%';
      }
      syncSelectors();
      triggerSave();
    });
  }

  $('#add-link-btn').addEventListener('click', async () => {
    const input = await promptDialog({
      title: 'הוספת קישור',
      label: 'כתובת אינטרנט',
      placeholder: 'https://example.com',
      type: 'url'
    });
    if (!input) return;
    const url = safeUrl(input);
    if (!url) {
      showToast('הכתובת אינה תקינה', 'error');
      return;
    }
    if (isNew) {
      links.push({ id: `pending-${links.length}`, task_id: task.id, url, title: new URL(url).hostname });
    } else {
      links.push(await api.addLink(task.id, url, new URL(url).hostname));
    }
    renderLinks();
  });

  $('#links-container').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    if (!isNew) await api.deleteLink(button.dataset.id);
    links = links.filter((link) => link.id !== button.dataset.id);
    renderLinks();
  });

  const photoUpload = $('#photo-upload');
  $('#add-photo-btn').addEventListener('click', () => photoUpload.click());

  photoUpload.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await compressImage(file);
      if (isNew) {
        photos.push({ id: `pending-${photos.length}`, task_id: task.id, filename: file.name, path: dataUrl });
      } else {
        photos.push(await api.addPhoto(task.id, dataUrl, file.name));
      }
      renderPhotos();
    } catch (error) {
      showToast(error.message === 'storage-full'
        ? 'אין מספיק מקום לשמירת התמונה'
        : 'לא ניתן לטעון את התמונה', 'error');
    }
  });

  $('#photos-container').addEventListener('click', async (event) => {
    const remove = event.target.closest('.photo-remove');
    if (remove) {
      if (!isNew) await api.deletePhoto(remove.dataset.id);
      photos = photos.filter((photo) => photo.id !== remove.dataset.id);
      renderPhotos();
      return;
    }
    const thumb = event.target.closest('.photo-thumb');
    if (thumb) openPhotoViewer(thumb.src, thumb.alt);
  });

  $('#delete-btn')?.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'מחיקת משימה',
      message: `למחוק את "${task.title || 'המשימה'}"? אפשר לבטל מיד לאחר המחיקה.`,
      confirmText: 'מחק',
      danger: true
    });
    if (!confirmed) return;
    const snapshot = await api.deleteTask(task.id);
    window.location.hash = '#/tasks';
    showToast('המשימה נמחקה', {
      actionLabel: 'בטל',
      onAction: () => api.restoreTask(snapshot)
    });
  });

  $('#share-btn').addEventListener('click', async () => {
    collectFields();
    const status = getStatus(task.status);
    const category = getCategory(task.category);
    const lines = [
      `${category.icon} ${task.title || 'משימה'}`,
      task.description ? task.description : null,
      `סטטוס: ${status.name}`,
      `עדיפות: ${getPriority(task.priority).name}`,
      task.due_date ? `תאריך יעד: ${task.due_date}` : null
    ].filter(Boolean);
    const text = lines.join('\n');

    if (navigator.share) {
      try {
        await navigator.share({ title: task.title || 'משימה', text });
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  });

  $('#send-comment')?.addEventListener('click', addComment);
  $('#new-comment')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addComment();
    }
  });

  async function addComment() {
    const input = $('#new-comment');
    const content = input.value.trim();
    if (!content) return;
    const comment = await api.addComment(task.id, content);
    if (comment) comments.push(comment);
    input.value = '';
    renderComments();
    activity = await api.getActivityLog(task.id, 30);
    renderActivity();
  }

  $('#save-new-btn')?.addEventListener('click', async () => {
    const button = $('#save-new-btn');
    button.disabled = true;
    collectFields();
    if (!task.title) {
      showToast('צריך כותרת למשימה', 'error');
      titleInput.focus();
      button.disabled = false;
      return;
    }
    try {
      const created = await api.createTask(task);
      // Attachments added before the first save belong to the real task id.
      for (const link of links) await api.addLink(created.id, link.url, link.title);
      for (const photo of photos) await api.addPhoto(created.id, photo.path, photo.filename);
      window.location.hash = `#/task/${encodeURIComponent(created.id)}`;
    } catch (error) {
      console.error('Create failed', error);
      showToast(error.message === 'storage-full' ? 'אין מספיק מקום אחסון' : 'שגיאה ביצירת המשימה', 'error');
      button.disabled = false;
    }
  });

  if (!isNew && isOverdue(task) && task.status !== 'overdue' && task.status !== 'completed') {
    task.status = 'overdue';
  }

  syncSelectors();
  renderLinks();
  renderPhotos();
  renderComments();
  renderActivity();

  return () => persist.cancel();
}
