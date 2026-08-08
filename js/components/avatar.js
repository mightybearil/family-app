import { html, raw } from '../utils.js';

/**
 * Renders a person as a photo when one is configured, falling back to their
 * emoji. Every screen goes through here so adding or removing a photo is a
 * one-line config change rather than an edit in six templates.
 *
 * Sizes map to the existing .avatar / .avatar-sm / .avatar-lg rules, which
 * already clip to a circle and cover-fit any <img> inside them.
 */

let fallbackInstalled = false;

/**
 * Portraits are deliberately not committed to the public repository, so the
 * GitHub Pages copy serves the app without them. Rather than showing a broken
 * image there, swap any portrait that fails to load for its emoji.
 *
 * Registered in the capture phase because `error` on an <img> does not bubble,
 * and as a single delegated listener so markup can stay a plain string.
 */
function installPhotoFallback() {
  if (fallbackInstalled || typeof document === 'undefined') return;
  fallbackInstalled = true;

  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;

    const replacement = document.createElement('span');
    replacement.textContent = img.dataset.fallback;
    replacement.setAttribute('aria-hidden', 'true');

    if (img.classList.contains('auth-portrait')) {
      replacement.className = 'auth-logo';
      img.replaceWith(replacement);
      return;
    }
    // Inside .avatar / .avatar-inline the wrapper already sizes and clips.
    img.replaceWith(replacement);
  }, true);
}

export function avatar(person, size = '') {
  if (!person) return raw('');
  installPhotoFallback();

  const className = ['avatar', size ? `avatar-${size}` : ''].filter(Boolean).join(' ');
  const emoji = person.avatar || '👤';

  if (person.photo) {
    return raw(html`
      <span class="${className}">
        <img src="${person.photo}" alt="${person.name || ''}" data-fallback="${emoji}"
             decoding="async" />
      </span>
    `);
  }
  return raw(html`<span class="${className}" aria-hidden="true">${emoji}</span>`);
}

/**
 * Compact form for chips and metadata rows, where the name sits beside the
 * face and the avatar should not dominate the line.
 */
export function avatarInline(person) {
  if (!person) return raw('');
  installPhotoFallback();

  const emoji = person.avatar || '👤';
  if (person.photo) {
    return raw(html`
      <span class="avatar-inline">
        <img src="${person.photo}" alt="" data-fallback="${emoji}" decoding="async" />
      </span>
    `);
  }
  return raw(html`<span aria-hidden="true">${emoji}</span>`);
}
