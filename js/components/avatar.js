import { html, raw } from '../utils.js';

/**
 * Renders a person as a photo when one is configured, falling back to their
 * emoji. Every screen goes through here so adding or removing a photo is a
 * one-line config change rather than an edit in six templates.
 *
 * Sizes map to the existing .avatar / .avatar-sm / .avatar-lg rules, which
 * already clip to a circle and cover-fit any <img> inside them.
 */
export function avatar(person, size = '') {
  if (!person) return raw('');
  const className = ['avatar', size ? `avatar-${size}` : ''].filter(Boolean).join(' ');

  if (person.photo) {
    return raw(html`
      <span class="${className}">
        <img src="${person.photo}" alt="${person.name || ''}" loading="lazy" decoding="async" />
      </span>
    `);
  }
  return raw(html`<span class="${className}" aria-hidden="true">${person.avatar || '👤'}</span>`);
}

/**
 * Compact form for chips and metadata rows, where the name sits beside the
 * face and the avatar should not dominate the line.
 */
export function avatarInline(person) {
  if (!person) return raw('');
  if (person.photo) {
    return raw(html`
      <span class="avatar-inline">
        <img src="${person.photo}" alt="" loading="lazy" decoding="async" />
      </span>
    `);
  }
  return raw(html`<span aria-hidden="true">${person.avatar || '👤'}</span>`);
}
