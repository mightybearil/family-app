import { nanobotRequest, api, isOverdue } from './api.js';
import { getMember, getStatus, getPriority } from './config.js';

/**
 * Higher-level agent helpers. Each one degrades gracefully so the UI keeps
 * working when the backend is unreachable or not configured at all.
 */
export const nanobot = {
  async suggestUpdates(task) {
    try {
      return await nanobotRequest({
        action: 'suggest_updates',
        instruction: 'נתחו את המשימה והציעו עדכונים חכמים: סטטוס, עדיפות או קטגוריה.',
        task
      }, { quiet: true });
    } catch (error) {
      console.info('suggestUpdates unavailable', error.message);
      return null;
    }
  },

  async generateDailySummary() {
    const tasks = await api.getTasks();
    const open = tasks.filter((task) => task.status !== 'completed');
    const overdue = open.filter(isOverdue);
    const fallback = overdue.length
      ? `יש ${open.length} משימות פתוחות, מתוכן ${overdue.length} באיחור.`
      : `יש ${open.length} משימות פתוחות להיום.`;

    try {
      const response = await nanobotRequest({
        action: 'daily_summary',
        instruction: 'הכינו סיכום יומי קצר בעברית למשימות הפתוחות, והדגישו את הדחופות.',
        tasks: open
      }, { quiet: true });
      return response?.summary || fallback;
    } catch {
      return fallback;
    }
  },

  async inferProgress(task, comments) {
    try {
      const response = await nanobotRequest({
        action: 'infer_progress',
        instruction: 'על סמך ההערות והמשימה, העריכו את אחוז ההתקדמות בין 0 ל-100.',
        task,
        comments
      }, { quiet: true });
      const progress = Number.parseInt(response?.progress, 10);
      return Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : task.progress ?? 0;
    } catch {
      return task.progress ?? 0;
    }
  },

  async sendReminder(task, memberId) {
    const member = getMember(memberId);
    if (!member?.phone) return false;
    return api.sendWhatsApp(member.phone, `תזכורת למשימה: ${task.title}\nנשמח שתסיימו אותה בהקדם 🙂`);
  },

  async sendPartnerMessage(fromMemberId, toMemberId, message) {
    const from = getMember(fromMemberId);
    const to = getMember(toMemberId);
    if (!to?.phone) return false;
    return api.sendWhatsApp(to.phone, `הודעה מ${from?.name ?? 'המשפחה'}: ${message}`);
  },

  async shareTaskViaWhatsApp(task, memberId) {
    const member = getMember(memberId);
    if (!member?.phone) return false;
    const text = [
      `משימה: ${task.title}`,
      `סטטוס: ${getStatus(task.status).name}`,
      `עדיפות: ${getPriority(task.priority).name}`,
      task.due_date ? `תאריך יעד: ${task.due_date}` : null
    ].filter(Boolean).join('\n');
    return api.sendWhatsApp(member.phone, text);
  },

  /** Flags overdue tasks locally so the UI reflects them without a server round-trip. */
  async markOverdueTasks() {
    const tasks = await api.getTasks();
    const stale = tasks.filter((task) => isOverdue(task) && task.status !== 'overdue');
    for (const task of stale) await api.updateTask(task.id, { status: 'overdue' });
    return stale;
  }
};
