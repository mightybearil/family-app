import { CONFIG, getCategory, getMember } from '../config.js';
import { api, isOverdue } from '../api.js';
import { bottomNav } from '../components/nav.js';
import { avatarInline } from '../components/avatar.js';
import { html, raw, toDateKey, showToast } from '../utils.js';

const DAY_INITIALS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

const MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'
];

/** Sunday-first, which is how a week reads in Israel. */
function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());

  const weeks = [];
  const cursor = new Date(start);
  // Six rows always: a fixed height stops the grid jumping as months change.
  for (let week = 0; week < 6; week++) {
    const days = [];
    for (let day = 0; day < 7; day++) {
      days.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }
  return weeks;
}

export async function render(container) {
  const today = toDateKey();
  let cursor = new Date();
  cursor.setDate(1);
  let selected = today;
  let tasks = [];

  container.innerHTML = html`
    <div class="screen screen-with-nav">
      <header class="screen-header">
        <!--
          In a right-to-left layout the past sits to the right and the future to
          the left, so "previous" is the right-hand control. The arrows are → and
          ← rather than the ‹ › chevrons used before: those are bidi-mirrored
          characters, so they silently rendered pointing the wrong way here.
        -->
        <button class="btn btn-icon btn-ghost" id="prev-month" type="button"
                aria-label="חודש קודם">→</button>
        <h1 class="text-lg font-bold" id="month-label">לוח שנה</h1>
        <div class="flex-align-center gap-xs">
          <button class="btn btn-sm btn-ghost" id="today-btn" type="button">היום</button>
          <button class="btn btn-icon btn-ghost" id="next-month" type="button"
                  aria-label="חודש הבא">←</button>
        </div>
      </header>

      <main class="screen-content calendar-content">
        <div class="calendar-weekdays">
          ${DAY_INITIALS.map((d) => raw(html`<span>${d}</span>`))}
        </div>
        <div class="calendar-grid" id="calendar-grid"></div>

        <div class="calendar-legend">
          <span><i class="legend-star">★</i> אירוע</span>
          <span><i class="legend-dot legend-task"></i> משימה</span>
          <span><i class="legend-dot legend-overdue"></i> באיחור</span>
        </div>

        <section id="day-panel" class="day-panel"></section>
      </main>

      <a class="fab" id="fab-add" href="#/task/new?category=events" aria-label="אירוע חדש">+</a>
      ${bottomNav('calendar')}
    </div>
  `;

  const grid = container.querySelector('#calendar-grid');
  const panel = container.querySelector('#day-panel');
  const label = container.querySelector('#month-label');

  /** Only dated items belong on a calendar. */
  function byDate() {
    const map = new Map();
    for (const task of tasks) {
      if (!task.due_date) continue;
      if (!map.has(task.due_date)) map.set(task.due_date, []);
      map.get(task.due_date).push(task);
    }
    // Timed items first, in clock order, so a day reads as a schedule.
    for (const items of map.values()) {
      items.sort((a, b) => (a.due_time || '99:99').localeCompare(b.due_time || '99:99'));
    }
    return map;
  }

  function renderGrid() {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    label.textContent = `${MONTHS[month]} ${year}`;

    const dated = byDate();

    grid.innerHTML = monthGrid(year, month).flat().map((date) => {
      const key = toDateKey(date);
      const items = dated.get(key) || [];
      const outside = date.getMonth() !== month;

      const events = items.filter((t) => t.category === 'events');
      const overdue = items.filter((t) => t.category !== 'events' && isOverdue(t));
      const plain = items.length - events.length - overdue.length;

      return html`
        <button class="calendar-day ${outside ? 'outside' : ''} ${key === today ? 'today' : ''} ${key === selected ? 'selected' : ''}"
                type="button" data-date="${key}" aria-label="${key}">
          <span class="calendar-daynum">${date.getDate()}</span>
          <span class="calendar-dots">
            ${events.length ? raw(html`<i class="legend-star">★</i>`) : ''}
            ${overdue.length ? raw(html`<i class="legend-dot legend-overdue"></i>`) : ''}
            ${plain > 0 ? raw(html`<i class="legend-dot legend-task"></i>`) : ''}
          </span>
        </button>
      `;
    }).join('');
  }

  function renderDay() {
    const items = byDate().get(selected) || [];
    const readable = new Date(`${selected}T12:00:00`).toLocaleDateString('he-IL', {
      weekday: 'long', day: 'numeric', month: 'long'
    });

    if (items.length === 0) {
      panel.innerHTML = html`
        <h2 class="section-title">${readable}</h2>
        <p class="text-sm text-secondary">אין שום דבר ביום הזה.</p>
        <a class="btn btn-sm btn-outline mt-sm" href="#/task/new?category=events">+ הוסיפו אירוע</a>
      `;
      return;
    }

    panel.innerHTML = html`
      <h2 class="section-title">${readable}</h2>
      <div class="flex-col gap-xs">
        ${items.map((task) => {
          const isEvent = task.category === 'events';
          const category = getCategory(task.category);
          const member = task.assignees?.length === 1 ? getMember(task.assignees[0]) : null;
          const both = (task.assignees?.length || 0) > 1;

          return raw(html`
            <a class="agenda-item ${isEvent ? 'is-event' : 'is-task'} ${isOverdue(task) ? 'is-overdue' : ''} cat-${category.id}"
               href="#/task/${encodeURIComponent(task.id)}">
              <span class="agenda-time">${task.due_time || (isEvent ? '' : '—')}</span>
              <span class="agenda-body">
                <span class="agenda-title ${task.status === 'completed' ? 'done' : ''}">${task.title}</span>
                <span class="agenda-meta">
                  ${isEvent ? raw(html`<span class="chip chip-cat cat-events">📅 אירוע</span>`)
                            : raw(html`<span class="chip chip-cat cat-${category.id}">${category.icon} ${category.name}</span>`)}
                  ${task.location ? raw(html`<span class="agenda-where">📍 ${task.location}</span>`) : ''}
                  ${member ? raw(html`<span>${avatarInline(member)} ${member.name}</span>`) : ''}
                  ${both ? raw(html`<span>שניהם</span>`) : ''}
                </span>
              </span>
            </a>
          `);
        })}
      </div>
    `;
  }

  function draw() {
    renderGrid();
    renderDay();
  }

  grid.addEventListener('click', (event) => {
    const cell = event.target.closest('.calendar-day');
    if (!cell) return;
    selected = cell.dataset.date;
    // Tapping a day outside the current month moves the view to that month.
    const clicked = new Date(`${selected}T12:00:00`);
    if (clicked.getMonth() !== cursor.getMonth()) {
      cursor = new Date(clicked.getFullYear(), clicked.getMonth(), 1);
    }
    draw();
  });

  const step = (months) => {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + months, 1);
    draw();
  };
  container.querySelector('#prev-month').addEventListener('click', () => step(-1));
  container.querySelector('#next-month').addEventListener('click', () => step(1));
  container.querySelector('#today-btn').addEventListener('click', () => {
    cursor = new Date();
    cursor.setDate(1);
    selected = today;
    draw();
  });

  draw();

  try {
    tasks = await api.getTasks();
  } catch (error) {
    console.error('Failed to load calendar data', error);
    showToast('לא ניתן לטעון את לוח השנה', 'error');
  }
  if (container.isConnected) draw();
}
