import { html, raw } from '../utils.js';

const ITEMS = [
  { key: 'home', href: '#/home', icon: '🏠', label: 'בית' },
  { key: 'tasks', href: '#/tasks', icon: '📋', label: 'משימות' },
  { key: 'calendar', href: '#/calendar', icon: '📅', label: 'לוח שנה' },
  { key: 'shopping', href: '#/shopping', icon: '🛒', label: 'קניות' },
  { key: 'settings', href: '#/settings', icon: '⚙️', label: 'הגדרות' }
];

/**
 * The single bottom navigation used by every screen.
 * Returns raw() markup so it can be embedded directly in an html`` template.
 */
export function bottomNav(activeKey) {
  return raw(html`
    <nav class="bottom-nav" aria-label="ניווט ראשי">
      ${ITEMS.map((item) => raw(html`
        <a href="${item.href}"
           class="bottom-nav-item ${item.key === activeKey ? 'active' : ''}"
           ${item.key === activeKey ? raw('aria-current="page"') : ''}>
          <span class="nav-icon" aria-hidden="true">${item.icon}</span>
          <span>${item.label}</span>
        </a>
      `))}
    </nav>
  `);
}
