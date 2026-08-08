import { html, raw } from '../utils.js';

/**
 * In-app dialogs replacing window.confirm/prompt, which look foreign against
 * the design system and are unavailable in some installed-PWA contexts.
 */
function openDialog({ title, bodyMarkup, confirmText, cancelText = 'ביטול', danger = false, onMount }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = html`
      <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="modal-header">
          <h2 class="modal-header-title">${title}</h2>
          <button class="modal-close" type="button" aria-label="סגור">✕</button>
        </div>
        <div class="modal-body">${raw(bodyMarkup)}</div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-action="cancel" type="button">${cancelText}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm" type="button">${confirmText}</button>
        </div>
      </div>
    `;

    const previouslyFocused = document.activeElement;
    let settled = false;

    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 250);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
      resolve(value);
    };

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
        return;
      }
      if (event.key !== 'Tab') return;
      // Keep focus inside the dialog.
      const focusable = overlay.querySelectorAll('button, input, textarea, select, a[href]');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    overlay.querySelector('.modal-close').addEventListener('click', () => close(null));
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null);
    });

    document.body.appendChild(overlay);
    // Force a reflow rather than waiting for rAF: a backgrounded tab never
    // paints, which would leave the dialog invisible and non-interactive.
    void overlay.offsetHeight;
    overlay.classList.add('active');
    document.addEventListener('keydown', onKeydown, true);

    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    const mounted = onMount?.(overlay, close);
    confirmBtn.addEventListener('click', () => close(mounted ? mounted() : true));
    (overlay.querySelector('.modal-body input, .modal-body textarea') || confirmBtn).focus();
  });
}

export async function confirmDialog({ title, message, confirmText = 'אישור', cancelText = 'ביטול', danger = false }) {
  const result = await openDialog({
    title,
    bodyMarkup: html`<p class="text-base text-secondary">${message}</p>`,
    confirmText,
    cancelText,
    danger
  });
  return result === true;
}

export async function promptDialog({ title, label, value = '', placeholder = '', type = 'text', confirmText = 'שמור' }) {
  return openDialog({
    title,
    bodyMarkup: html`
      <label class="input-label" for="modal-prompt-input">${label}</label>
      <input id="modal-prompt-input" class="input" type="${type}" value="${value}" placeholder="${placeholder}" />
    `,
    confirmText,
    onMount: (overlay, close) => {
      const input = overlay.querySelector('#modal-prompt-input');
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          close(input.value.trim() || null);
        }
      });
      return () => input.value.trim() || null;
    }
  });
}

/** Full-screen photo viewer. */
export function openPhotoViewer(src, alt = '') {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay photo-viewer';
  overlay.innerHTML = html`
    <div class="photo-viewer-inner">
      <button class="modal-close photo-viewer-close" type="button" aria-label="סגור">✕</button>
      <img src="${src}" alt="${alt}" />
    </div>
  `;
  const close = () => {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 250);
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('.photo-viewer-close')) close();
  });
  document.body.appendChild(overlay);
  void overlay.offsetHeight;
  overlay.classList.add('active');
  document.addEventListener('keydown', onKey, true);
}
