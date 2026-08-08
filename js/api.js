import { CONFIG, settings, saveSettings, isBackendConfigured, isCategory } from './config.js';
import { generateId, readJSON, writeJSON, showToast, toDateKey } from './utils.js';
import { store } from './store.js';

const KEYS = CONFIG.STORAGE_KEYS;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_QUEUE_ATTEMPTS = 5;

/* ------------------------------------------------------------ task shape */

/**
 * Canonical task, matching server/schema.sql. Every screen reads and writes
 * exactly these fields; normalizeTask() migrates the older client shapes.
 */
export function emptyTask(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title: '',
    description: '',
    category: 'general',
    assignee: null,
    assignees: [],
    priority: 'medium',
    status: 'pending',
    progress: 0,
    due_date: null,
    due_time: null,
    location: '',
    quantity: 1,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function coerceDateKey(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : toDateKey(date);
}

function coerceTimestamp(value, fallback) {
  if (value == null || value === '') return fallback;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

/** Clock time as HH:MM, or null. Events carry one; most tasks do not. */
function coerceTime(value) {
  if (value == null || value === '') return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Accepts any historical client shape and returns the canonical one. */
export function normalizeTask(input) {
  if (!input || typeof input !== 'object') return null;

  // A task can belong to one of them or to both, so `assignees` is the real
  // field; `assignee` is kept as the first entry for the database's foreign key
  // and for anything still reading the singular form.
  const rawAssignees = Array.isArray(input.assignees)
    ? input.assignees
    : [input.assignees ?? input.assignee];
  const assignees = [];
  for (const candidate of rawAssignees) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed && !assignees.includes(trimmed)) assignees.push(trimmed);
  }
  const assignee = assignees[0] ?? null;

  const category = input.category ?? input.categoryId;
  const createdAt = coerceTimestamp(input.created_at ?? input.createdAt ?? input.created, new Date().toISOString());

  // Shopping quantity used to live in `description`.
  let quantity = Number.parseInt(input.quantity, 10);
  if (!Number.isFinite(quantity) || quantity < 1) {
    const legacy = Number.parseInt(input.description, 10);
    quantity = Number.isFinite(legacy) && legacy >= 1 && String(input.description).trim() === String(legacy)
      ? legacy
      : 1;
  }

  const description = String(input.description ?? '') === String(quantity) ? '' : String(input.description ?? '');
  const progress = Math.min(100, Math.max(0, Number.parseInt(input.progress, 10) || 0));

  return {
    id: String(input.id || generateId()),
    title: String(input.title ?? '').trim(),
    description,
    category: isCategory(category) ? category : 'general',
    assignee,
    assignees,
    priority: ['low', 'medium', 'high', 'urgent'].includes(input.priority) ? input.priority : 'medium',
    status: ['pending', 'in_progress', 'completed', 'overdue'].includes(input.status) ? input.status : 'pending',
    progress,
    due_date: coerceDateKey(input.due_date ?? input.dueDate),
    due_time: coerceTime(input.due_time ?? input.dueTime),
    location: String(input.location ?? '').trim(),
    quantity,
    created_by: input.created_by ?? input.createdBy ?? null,
    created_at: createdAt,
    updated_at: coerceTimestamp(input.updated_at ?? input.updatedAt, createdAt)
  };
}

/** A task is overdue when its due date has passed and it is not done. */
export function isOverdue(task) {
  if (!task || task.status === 'completed') return false;
  if (task.status === 'overdue') return true;
  return Boolean(task.due_date) && task.due_date < toDateKey();
}

/* ------------------------------------------------------------ local store */

function readTasks() {
  const stored = readJSON(KEYS.TASKS_CACHE, []);
  return stored.map(normalizeTask).filter(Boolean);
}

function writeTasks(tasks) {
  return writeJSON(KEYS.TASKS_CACHE, tasks);
}

const readCollection = (key) => readJSON(key, []);
const writeCollection = (key, rows) => writeJSON(key, rows);

function readQueue() {
  return readJSON(KEYS.OFFLINE_QUEUE, []);
}

function writeQueue(queue) {
  writeJSON(KEYS.OFFLINE_QUEUE, queue);
  store.setState('pendingSync', queue.length);
}

export function pendingSyncCount() {
  return readQueue().length;
}

/**
 * Only meaningful when a backend exists but is currently unreachable.
 * With no server configured the device *is* the source of truth, so queueing
 * would grow forever and show a sync backlog that will never drain.
 */
function queueMutation(action, payload) {
  if (!isBackendConfigured()) return;

  const queue = readQueue();
  // Collapse repeated edits of the same task so a long editing session syncs once.
  if (action === 'update_task') {
    const existing = queue.find((item) => item.action === 'update_task' && item.payload.taskId === payload.taskId);
    if (existing) {
      existing.payload.changes = { ...existing.payload.changes, ...payload.changes };
      existing.ts = Date.now();
      writeQueue(queue);
      return;
    }
  }
  queue.push({ id: generateId(), action, payload, ts: Date.now(), attempts: 0 });
  writeQueue(queue);
}

/* -------------------------------------------------------------- activity */

/**
 * Collapses repeated events, keeping the most recent of each. Expects rows in
 * newest-first order, which is how both the local log and the server return them.
 */
function dedupeActivity(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    // Status changes ignore the details, so done/undone/done collapses to where
    // the task actually ended up. Other actions keep details in the key, since
    // two different comments are two genuine events.
    // JSON.stringify keys the fields unambiguously — a separator character
    // could otherwise collide with text inside a task title.
    const key = row.action === 'update_status'
      ? JSON.stringify([row.task_id, 'update_status', row.actor])
      : JSON.stringify([row.task_id, row.action, row.actor, row.details]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

export function logActivity(action, { taskId = null, details = '', actor = null, source = 'user' } = {}) {
  const rows = readCollection(KEYS.ACTIVITY);
  rows.unshift({
    id: generateId(),
    task_id: taskId,
    action,
    details,
    source,
    actor: actor ?? store.getState('currentMember')?.id ?? null,
    created_at: new Date().toISOString()
  });
  writeCollection(KEYS.ACTIVITY, rows.slice(0, 200));
}

/* ------------------------------------------------------------- transport */

function extractJson(content) {
  if (content == null) return null;
  if (typeof content === 'object') return content;

  const text = String(content).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    // The agent replies in Hebrew prose around the payload; take the outermost object.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch { /* fall through */ }
    }
  }
  return null;
}

/**
 * nanobot only accepts the exact model name it was configured with and rejects
 * a generic "default", so the id is discovered from /v1/models once and cached.
 */
let cachedModel = null;

async function resolveModel() {
  if (cachedModel) return cachedModel;
  try {
    const response = await fetch(`${settings.nanobotUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}
    });
    if (response.ok) {
      const body = await response.json();
      const id = body?.data?.[0]?.id;
      if (id) cachedModel = id;
    }
  } catch {
    // Fall through to the generic name; the request will surface any real error.
  }
  return cachedModel || 'default';
}

/** Posts a structured instruction to the nanobot agent and returns its JSON payload. */
export async function nanobotRequest(instruction, { signal, quiet = false } = {}) {
  if (!isBackendConfigured()) throw new Error('backend-not-configured');
  if (!navigator.onLine) throw new Error('offline');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(`${settings.nanobotUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
      },
      // nanobot rejects a system message ("Only a single user message is
      // supported"), so the response contract is folded into the user turn.
      body: JSON.stringify({
        model: await resolveModel(),
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            'Reply with a single JSON object and nothing else.',
            'No prose, no explanation, no markdown fences.',
            'Shape: {"success": boolean, "data": object, "error": string}',
            '',
            `Request: ${JSON.stringify(instruction)}`
          ].join('\n')
        }],
        session_id: `family-app:${store.getState('currentMember')?.id ?? 'anonymous'}`
      })
    });

    if (!response.ok) throw new Error(`API ${response.status}`);

    const body = await response.json();
    const payload = extractJson(body.choices?.[0]?.message?.content);
    if (!payload) throw new Error('unparseable-response');
    if (payload.success === false) throw new Error(payload.error || 'agent-error');
    return payload.data ?? payload;
  } catch (error) {
    if (!quiet) {
      const message = error.name === 'AbortError' ? 'השרת לא הגיב בזמן' : 'תקשורת עם השרת נכשלה';
      showToast(message, 'error');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Deterministic CRUD against the SQLite storage service.
 *
 * Task data deliberately does NOT go through the language model: an LLM
 * recalling a list can drop or invent entries, its transcript is per-session
 * (so two phones would never share one list), and it eventually truncates.
 * nanobotRequest above is kept for the things a model is actually good at.
 */
export async function storageRequest(instruction, { signal, quiet = false } = {}) {
  if (!isBackendConfigured()) throw new Error('backend-not-configured');
  if (!navigator.onLine) throw new Error('offline');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(`${settings.nanobotUrl.replace(/\/+$/, '')}/api`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
      },
      body: JSON.stringify(instruction)
    });

    if (response.status === 401) throw new Error('unauthorized');
    if (!response.ok) throw new Error(`API ${response.status}`);

    const body = await response.json();
    if (!body.success) throw new Error(body.error || 'request-failed');
    return body.data ?? {};
  } catch (error) {
    if (!quiet) {
      const messages = {
        unauthorized: 'מפתח ה-API שגוי',
        offline: 'אין חיבור לאינטרנט'
      };
      showToast(messages[error.message] ||
        (error.name === 'AbortError' ? 'השרת לא הגיב בזמן' : 'תקשורת עם השרת נכשלה'), 'error');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const canReachServer = () => isBackendConfigured() && navigator.onLine;

/* ------------------------------------------------------------------- api */

export const api = {
  isLocalOnly() {
    return !isBackendConfigured();
  },

  /**
   * Uploads tasks this device holds that the server has never seen. Runs once,
   * the first time a device connects to a backend, so switching from local-only
   * mode does not silently discard existing tasks. It must not run repeatedly:
   * a task deleted on another phone still exists in this device's cache, and
   * re-uploading it every sync would resurrect it forever.
   */
  async migrateLocalTasks() {
    if (!canReachServer() || settings.serverMigratedAt) return { uploaded: 0 };

    const data = await storageRequest({ action: 'get_tasks', filters: {} }, { quiet: true });
    const remoteIds = new Set((data?.tasks ?? []).map((t) => t.id));
    const localOnly = readTasks().filter((task) => !remoteIds.has(task.id));

    let uploaded = 0;
    for (const task of localOnly) {
      try {
        await storageRequest({ action: 'create_task', task }, { quiet: true });
        uploaded++;
      } catch {
        // Leave the flag unset so the migration is retried on the next connect.
        return { uploaded };
      }
    }

    saveSettings({ serverMigratedAt: new Date().toISOString() });
    if (uploaded > 0) showToast(`הועלו ${uploaded} משימות לשרת`, 'success');
    return { uploaded };
  },

  async getTasks(filters = {}) {
    let tasks = readTasks();

    if (canReachServer()) {
      try {
        if (!settings.serverMigratedAt) await this.migrateLocalTasks();
        // Ask for everything and filter locally, so the cache mirrors the server
        // rather than holding only the slice matching the current screen.
        const data = await storageRequest({ action: 'get_tasks', filters: {} }, { quiet: true });
        const remote = (data?.tasks ?? []).map(normalizeTask).filter(Boolean);
        // Once migrated the server is authoritative, including when it is empty:
        // that is how a delete on the other phone reaches this one.
        writeTasks(remote);
        tasks = remote;
      } catch {
        // Local cache is the fallback; the queue will reconcile later.
      }
    }

    if (filters.category) tasks = tasks.filter((t) => t.category === filters.category);
    if (filters.assignee) tasks = tasks.filter((t) => t.assignee === filters.assignee);
    if (filters.status) tasks = tasks.filter((t) => t.status === filters.status);
    return tasks;
  },

  async getTask(taskId) {
    const local = readTasks().find((t) => t.id === taskId) || null;
    if (!canReachServer()) return local;
    try {
      const data = await storageRequest({ action: 'get_task', taskId }, { quiet: true });
      const remote = normalizeTask(data?.task);
      if (!remote) return local;
      const tasks = readTasks();
      const index = tasks.findIndex((t) => t.id === remote.id);
      if (index === -1) tasks.push(remote); else tasks[index] = remote;
      writeTasks(tasks);
      return remote;
    } catch {
      return local;
    }
  },

  async createTask(input) {
    const task = normalizeTask(emptyTask({
      ...input,
      created_by: input.created_by ?? store.getState('currentMember')?.id ?? null
    }));

    const tasks = readTasks();
    tasks.push(task);
    if (!writeTasks(tasks)) throw new Error('storage-full');

    logActivity('create_task', { taskId: task.id, details: task.title });

    if (canReachServer()) {
      try {
        await storageRequest({ action: 'create_task', task }, { quiet: true });
      } catch {
        queueMutation('create_task', { task });
      }
    } else {
      queueMutation('create_task', { task });
    }
    return task;
  },

  async updateTask(taskId, changes) {
    const tasks = readTasks();
    const index = tasks.findIndex((t) => t.id === taskId);
    if (index === -1) return null;

    const updated = normalizeTask({ ...tasks[index], ...changes, id: taskId });
    updated.updated_at = new Date().toISOString();
    tasks[index] = updated;
    writeTasks(tasks);

    if (changes.status && changes.status !== 'pending') {
      logActivity('update_status', { taskId, details: `${updated.title}: ${changes.status}` });
    }

    if (canReachServer()) {
      try {
        await storageRequest({ action: 'update_task', taskId, changes }, { quiet: true });
      } catch {
        queueMutation('update_task', { taskId, changes });
      }
    } else {
      queueMutation('update_task', { taskId, changes });
    }
    return updated;
  },

  /** Returns a snapshot so the caller can offer an undo. */
  async deleteTask(taskId) {
    const tasks = readTasks();
    const task = tasks.find((t) => t.id === taskId) || null;
    writeTasks(tasks.filter((t) => t.id !== taskId));

    const snapshot = {
      task,
      comments: readCollection(KEYS.COMMENTS).filter((c) => c.task_id === taskId),
      links: readCollection(KEYS.LINKS).filter((l) => l.task_id === taskId),
      photos: readCollection(KEYS.PHOTOS).filter((p) => p.task_id === taskId)
    };

    writeCollection(KEYS.COMMENTS, readCollection(KEYS.COMMENTS).filter((c) => c.task_id !== taskId));
    writeCollection(KEYS.LINKS, readCollection(KEYS.LINKS).filter((l) => l.task_id !== taskId));
    writeCollection(KEYS.PHOTOS, readCollection(KEYS.PHOTOS).filter((p) => p.task_id !== taskId));

    if (task) logActivity('delete_task', { taskId, details: task.title });

    if (canReachServer()) {
      try {
        await storageRequest({ action: 'delete_task', taskId }, { quiet: true });
      } catch {
        queueMutation('delete_task', { taskId });
      }
    } else {
      queueMutation('delete_task', { taskId });
    }
    return snapshot;
  },

  /** Re-inserts a deleted task and its attachments (undo). */
  async restoreTask(snapshot) {
    if (!snapshot?.task) return null;
    const tasks = readTasks();
    if (!tasks.some((t) => t.id === snapshot.task.id)) tasks.push(snapshot.task);
    writeTasks(tasks);

    if (snapshot.comments?.length) writeCollection(KEYS.COMMENTS, [...readCollection(KEYS.COMMENTS), ...snapshot.comments]);
    if (snapshot.links?.length) writeCollection(KEYS.LINKS, [...readCollection(KEYS.LINKS), ...snapshot.links]);
    if (snapshot.photos?.length) writeCollection(KEYS.PHOTOS, [...readCollection(KEYS.PHOTOS), ...snapshot.photos]);

    if (canReachServer()) {
      try {
        await storageRequest({ action: 'create_task', task: snapshot.task }, { quiet: true });
      } catch {
        queueMutation('create_task', { task: snapshot.task });
      }
    } else {
      queueMutation('create_task', { task: snapshot.task });
    }
    return snapshot.task;
  },

  /* -------------------------------------------------------- attachments */

  async getComments(taskId) {
    return readCollection(KEYS.COMMENTS)
      .filter((c) => c.task_id === taskId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  async addComment(taskId, content, author = null) {
    const comment = {
      id: generateId(),
      task_id: taskId,
      author: author ?? store.getState('currentMember')?.id ?? null,
      content: String(content).trim(),
      created_at: new Date().toISOString()
    };
    if (!comment.content) return null;
    writeCollection(KEYS.COMMENTS, [...readCollection(KEYS.COMMENTS), comment]);
    logActivity('add_comment', { taskId, details: comment.content.slice(0, 60) });
    if (canReachServer()) {
      storageRequest({ action: 'add_comment', comment }, { quiet: true })
        .catch(() => queueMutation('add_comment', { comment }));
    } else {
      queueMutation('add_comment', { comment });
    }
    return comment;
  },

  async deleteComment(commentId) {
    writeCollection(KEYS.COMMENTS, readCollection(KEYS.COMMENTS).filter((c) => c.id !== commentId));
  },

  async getLinks(taskId) {
    if (canReachServer()) {
      try {
        const data = await storageRequest({ action: 'get_links', taskId }, { quiet: true });
        const links = data?.links ?? [];
        writeCollection(KEYS.LINKS, [
          ...readCollection(KEYS.LINKS).filter((l) => l.task_id !== taskId),
          ...links
        ]);
        return links;
      } catch {
        // Fall back to the cached copy.
      }
    }
    return readCollection(KEYS.LINKS).filter((l) => l.task_id === taskId);
  },

  async addLink(taskId, url, title = '') {
    const link = {
      id: generateId(),
      task_id: taskId,
      url,
      title: title || url,
      added_by: store.getState('currentMember')?.id ?? null,
      created_at: new Date().toISOString()
    };
    writeCollection(KEYS.LINKS, [...readCollection(KEYS.LINKS), link]);
    logActivity('add_link', { taskId, details: link.title });

    if (canReachServer()) {
      try {
        await storageRequest({ action: 'add_link', link }, { quiet: true });
      } catch {
        queueMutation('add_link', { link });
      }
    } else {
      queueMutation('add_link', { link });
    }
    return link;
  },

  async deleteLink(linkId) {
    writeCollection(KEYS.LINKS, readCollection(KEYS.LINKS).filter((l) => l.id !== linkId));
    if (canReachServer()) {
      try {
        await storageRequest({ action: 'delete_link', linkId }, { quiet: true });
      } catch {
        queueMutation('delete_link', { linkId });
      }
    } else {
      queueMutation('delete_link', { linkId });
    }
  },

  /**
   * Returns photos with `path` holding a displayable data URL, whether they
   * came from this device or the server, so screens render them the same way.
   * Bytes are fetched per photo and cached locally — the metadata listing stays
   * small, and an authenticated fetch is required, so an <img src> pointing at
   * a public URL is never involved.
   */
  async getPhotos(taskId) {
    const cached = readCollection(KEYS.PHOTOS);
    if (!canReachServer()) return cached.filter((p) => p.task_id === taskId);

    try {
      const data = await storageRequest({ action: 'get_photos', taskId }, { quiet: true });
      const remote = data?.photos ?? [];
      const resolved = [];

      for (const meta of remote) {
        const known = cached.find((p) => p.id === meta.id && p.path);
        if (known) {
          resolved.push(known);
          continue;
        }
        try {
          const full = await storageRequest({ action: 'get_photo', photoId: meta.id }, { quiet: true });
          if (full?.photo?.data) resolved.push({ ...meta, path: full.photo.data });
        } catch {
          // Skip this one; the others still render.
        }
      }

      writeCollection(KEYS.PHOTOS, [
        ...cached.filter((p) => p.task_id !== taskId),
        ...resolved
      ]);
      return resolved;
    } catch {
      return cached.filter((p) => p.task_id === taskId);
    }
  },

  /** Stores a downscaled data URL; throws 'storage-full' when the quota rejects it. */
  async addPhoto(taskId, dataUrl, filename = 'photo.jpg') {
    const photo = {
      id: generateId(),
      task_id: taskId,
      filename,
      path: dataUrl,
      uploaded_by: store.getState('currentMember')?.id ?? null,
      created_at: new Date().toISOString()
    };

    if (canReachServer()) {
      // Upload first: if the server rejects it there is no point caching it.
      await storageRequest({
        action: 'add_photo',
        photo: { ...photo, data: dataUrl }
      });
    }
    // Deliberately not queued when offline. A queued photo would hold a second
    // copy of its base64 in the same localStorage budget, and filling that
    // budget would break syncing for tasks too — a far worse failure than one
    // photo staying on the device that took it.

    const rows = [...readCollection(KEYS.PHOTOS), photo];
    if (!writeCollection(KEYS.PHOTOS, rows) && !canReachServer()) throw new Error('storage-full');
    logActivity('add_photo', { taskId, details: filename });
    return photo;
  },

  async deletePhoto(photoId) {
    writeCollection(KEYS.PHOTOS, readCollection(KEYS.PHOTOS).filter((p) => p.id !== photoId));
    if (canReachServer()) {
      try {
        await storageRequest({ action: 'delete_photo', photoId }, { quiet: true });
      } catch {
        queueMutation('delete_photo', { photoId });
      }
    } else {
      queueMutation('delete_photo', { photoId });
    }
  },

  /**
   * Recent activity, with repeats collapsed: toggling a task done, undone and
   * done again is one fact, not three feed entries, and a double-tap is not two
   * events. The log itself keeps every row; only this view is condensed.
   *
   * Reads from the server when one is configured, so both phones see the same
   * feed — a purely local feed would only ever show your own actions.
   */
  async getActivityLog(taskId = null, limit = 20) {
    if (canReachServer()) {
      try {
        const data = await storageRequest(
          { action: 'get_activity', taskId, limit }, { quiet: true }
        );
        const activity = data?.activity ?? [];
        if (activity.length) writeCollection(KEYS.ACTIVITY, activity);
        return activity;
      } catch {
        // Fall through to the local copy.
      }
    }

    const rows = readCollection(KEYS.ACTIVITY);
    const scoped = taskId ? rows.filter((r) => r.task_id === taskId) : rows;
    return dedupeActivity(scoped).slice(0, limit);
  },

  /* -------------------------------------------------------------- sync */

  async sendWhatsApp(to, message) {
    if (!canReachServer()) {
      console.info('WhatsApp skipped (local-only mode):', to, message);
      return false;
    }
    await nanobotRequest({ action: 'send_whatsapp', to, message });
    return true;
  },

  async testConnection() {
    if (!isBackendConfigured()) return { ok: false, reason: 'not-configured' };
    if (!navigator.onLine) return { ok: false, reason: 'offline' };
    try {
      await storageRequest({ action: 'ping' }, { quiet: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  },

  /**
   * Drains the mutation queue. A permanently failing item is retired to a
   * dead-letter list after MAX_QUEUE_ATTEMPTS instead of blocking everything behind it.
   */
  async syncOfflineQueue() {
    if (!canReachServer()) return { synced: 0, failed: 0 };

    const queue = readQueue();
    if (queue.length === 0) return { synced: 0, failed: 0 };

    const remaining = [];
    const retired = [];
    let synced = 0;
    let networkDown = false;

    for (const item of queue) {
      if (networkDown) {
        remaining.push(item);
        continue;
      }
      try {
        await storageRequest({ action: item.action, ...item.payload }, { quiet: true });
        synced++;
      } catch (error) {
        item.attempts = (item.attempts || 0) + 1;
        if (error.message === 'offline' || error.name === 'AbortError') {
          networkDown = true;
          remaining.push(item);
        } else if (item.attempts >= MAX_QUEUE_ATTEMPTS) {
          retired.push({ ...item, retired_at: new Date().toISOString(), error: error.message });
        } else {
          remaining.push(item);
        }
      }
    }

    writeQueue(remaining);
    if (retired.length) {
      writeJSON(KEYS.FAILED_QUEUE, [...readJSON(KEYS.FAILED_QUEUE, []), ...retired]);
      showToast(`${retired.length} שינויים לא הצליחו להסתנכרן ונשמרו בצד`, 'error');
    }
    if (synced > 0) showToast(`סונכרנו ${synced} שינויים`, 'success');
    return { synced, failed: retired.length };
  },

  /** Everything the user owns, for the Settings export button. */
  exportAll() {
    return {
      exported_at: new Date().toISOString(),
      version: CONFIG.VERSION,
      settings: { ...settings, apiKey: '' },
      tasks: readTasks(),
      comments: readCollection(KEYS.COMMENTS),
      links: readCollection(KEYS.LINKS),
      photos: readCollection(KEYS.PHOTOS),
      activity: readCollection(KEYS.ACTIVITY),
      pending_sync: readQueue()
    };
  }
};

store.setState('pendingSync', readQueue().length);
