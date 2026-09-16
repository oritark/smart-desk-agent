export const MODEL_URL = 'https://teachablemachine.withgoogle.com/models/q3YTZOQtb/';
export const LABELS = { PHONE: 'טלפון', NOTEBOOK: 'מחברת', 'WATER BOTTLE': 'בקבוק מים', PAPER: 'דף נייר', 'NO OBJECT': 'ללא חפץ' };
export const ACTIONS = ['START_FOCUS', 'PAUSE_FOCUS', 'RESUME_FOCUS', 'DRINK_WATER', 'TAKE_BREAK', 'CONTINUE'];
export const STATUS = ['idle', 'focusing', 'paused', 'break', 'completed'];
export function remainingSeconds(session, now = Date.now()) {
  return session.deadline ? Math.max(0, Math.ceil((session.deadline - now) / 1000)) : session.remaining;
}
export function allowedActions(status) {
  const choices = ['CONTINUE', 'DRINK_WATER'];
  if (status === 'idle') choices.push('START_FOCUS');
  if (status === 'focusing') choices.push('PAUSE_FOCUS', 'TAKE_BREAK');
  if (status === 'paused') choices.push('RESUME_FOCUS', 'TAKE_BREAK');
  return choices;
}
export function applyAction(session, action, now = Date.now()) {
  if (!allowedActions(session.status).includes(action)) return session;
  const next = { ...session };
  if (action === 'START_FOCUS' || action === 'RESUME_FOCUS') {
    next.status = 'focusing'; next.deadline = now + next.remaining * 1000;
  } else if (action === 'PAUSE_FOCUS') {
    next.remaining = remainingSeconds(next, now); next.deadline = null; next.status = 'paused';
  } else if (action === 'TAKE_BREAK') {
    next.savedRemaining = remainingSeconds(next, now); next.remaining = 300;
    next.status = 'break'; next.deadline = now + 300000;
  } else if (action === 'DRINK_WATER') next.lastDrinkAt = now;
  return next;
}
// A distinct local simulator, never presented as a Gemini decision.
export function demoDecision({ prediction, state }, now = Date.now()) {
  const label = prediction.label;
  if (label === 'PHONE' && state.status === 'focusing') return { action: 'PAUSE_FOCUS', title: 'קצת מרחק מהטלפון, קצת יותר ריכוז', message: 'זיהיתי טלפון בזמן הלימוד. אפשר להשהות לרגע, להניח אותו בצד ואז לחזור למשימה.', reason: 'זוהה טלפון בזמן סשן פעיל.' };
  if (label === 'WATER BOTTLE' && now - state.lastDrinkAt > 20 * 60000) return { action: 'DRINK_WATER', title: 'רגע קטן לשתות מים', message: 'הבקבוק לידך, ועבר זמן מאז אישור השתייה האחרון. כמה לגימות וחוזרים לעניינים.', reason: 'זוהה בקבוק ולא נרשמה שתייה ב־20 הדקות האחרונות.' };
  if (['NOTEBOOK', 'PAPER'].includes(label) && state.status === 'idle') return { action: 'START_FOCUS', title: 'הכול מוכן לצעד הראשון', message: 'חומרי הלימוד כבר כאן. נתחיל זמן ממוקד למשימה שבחרת?', reason: 'חומר לימוד מזוהה, והסשן עדיין לא התחיל.' };
  if (['NOTEBOOK', 'PAPER'].includes(label) && state.status === 'paused') return { action: 'RESUME_FOCUS', title: 'אפשר לחזור לקצב שלך', message: 'חומרי הלימוד מולך והטיימר בהשהיה. אפשר להמשיך מהמקום שבו עצרת.', reason: 'זוהו חומרי לימוד במהלך השהיה.' };
  return { action: 'CONTINUE', title: 'ממשיכים בקצב שלך', message: 'אין כרגע צורך בפעולה נוספת. אשאיר לך מרחב להתרכז.', reason: 'הזיהוי והמצב הנוכחי אינם מצריכים הפרעה.' };
}
export class StablePrediction {
  constructor(threshold = 0.85, stableMs = 1500, cooldownMs = 30000) {
    Object.assign(this, { threshold, stableMs, cooldownMs, label: null, since: 0, lastSent: -Infinity, sentLabels: new Map() });
  }
  update(prediction, now = Date.now()) {
    if (prediction.confidence < this.threshold) { this.label = null; return false; }
    if (prediction.label !== this.label) { this.label = prediction.label; this.since = now; return false; }
    if (now - this.since < this.stableMs || now - this.lastSent < this.cooldownMs || now - (this.sentLabels.get(this.label) ?? -Infinity) < 120000) return false;
    this.lastSent = now; this.sentLabels.set(this.label, now); return true;
  }
}
