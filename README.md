# 🏠 משימות משפחתיות — Family Tasks

A Hebrew, right-to-left Progressive Web App for managing household tasks and shopping lists.

**Live app:** https://mightybearil.github.io/family-app/

Open that link on your phone and install it:

- **Android (Chrome):** ⋮ menu → *Install app*
- **iPhone (Safari):** Share → *Add to Home Screen*

## How it works

The app is **local-first**. It runs entirely in the browser with no backend, storing tasks in
`localStorage` on the device. That means it works offline and needs no server to be useful —
but it also means **each device keeps its own separate list**.

To share one list across phones (and get WhatsApp integration), a
[nanobot](https://github.com/nanobot-ai/nanobot) backend must be configured under
**הגדרות → שרת** on each device. See [FAMILY_APP.md](FAMILY_APP.md) for the full
architecture, data model, API contract, and deployment guide.

## Running locally

No build step — it's vanilla ES modules, HTML, and CSS:

```bash
python -m http.server 8080
```

Then open http://localhost:8080.

> The service worker caches the app shell aggressively. After editing files, hard-reload with
> **Ctrl+Shift+R**, or unregister the worker in DevTools → Application → Service Workers.

## Tech

Vanilla HTML/CSS/ES2022 modules · hash router · service worker · Web App Manifest ·
optional nanobot + SQLite backend. No framework, no bundler, no dependencies.
