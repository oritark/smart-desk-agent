import { MODEL_URL, LABELS, STATUS, ACTIONS, remainingSeconds, applyAction, allowedActions, demoDecision, StablePrediction } from './logic.js';
const $ = id => document.getElementById(id);
const storageKey = 'smart-desk-session-v1';
const icons = { PHONE: '▯', NOTEBOOK: '▤', 'WATER BOTTLE': '♧', PAPER: '▱', 'NO OBJECT': '◌' };
const actionNames = { START_FOCUS: 'מתחילים להתרכז', PAUSE_FOCUS: 'להשהות ולהניח את הטלפון בצד', RESUME_FOCUS: 'חוזרים ללמוד', DRINK_WATER: 'שתיתי מים', TAKE_BREAK: 'יוצאים להפסקה של 5 דקות', CONTINUE: 'ממשיכים' };
const statusNames = { idle: 'מוכנים להתחיל', focusing: 'זמן של ריכוז', paused: 'רגע של מנוחה', break: 'הפסקה קצרה', completed: 'כל הכבוד, סיימת!' };
let session = freshSession();
let history = [], cameraActive = false, cameraStarting = false, cameraGeneration = 0, stream, model, loopId;
let demo = false, busy = false, configured = false, pending = null, requestController, requestVersion = 0, latestPrediction = null;
let gate = new StablePrediction(), toastId;
const predictionRows = new Map();

function freshSession(minutes = 25, task = 'להתקדם בפרויקט הסיום') {
  return { status: 'idle', task, duration: minutes * 60, remaining: minutes * 60, deadline: null, lastDrinkAt: 0, savedRemaining: null };
}
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify({ session, history })); } catch { /* Session still works when storage is unavailable. */ }
}
function load() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey));
    const s = data?.session;
    if (!s || !STATUS.includes(s.status) || ![900, 1500, 2700].includes(s.duration) || typeof s.task !== 'string' || s.task.length > 160 || !Number.isFinite(s.remaining) || s.remaining < 0 || s.remaining > 2700 || (s.deadline !== null && (!Number.isFinite(s.deadline) || s.deadline > Date.now() + 2700000)) || !Number.isFinite(s.lastDrinkAt) || (s.savedRemaining !== null && (!Number.isFinite(s.savedRemaining) || s.savedRemaining < 0 || s.savedRemaining > 2700))) return;
    session = s;
    history = Array.isArray(data.history) ? data.history.filter(h => typeof h.text === 'string' && typeof h.outcome === 'string' && typeof h.action === 'string' && Number.isFinite(h.at)).slice(0, 30) : [];
  } catch { /* Fresh session on malformed or inaccessible storage. */ }
}
function notify(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastId); toastId = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
function log(text, action = 'SESSION', outcome = 'בוצע', source = 'user') {
  history.unshift({ text, action, outcome, source, at: Date.now() }); history = history.slice(0, 30);
  renderHistory(); save();
}
function renderHistory() {
  $('history-list').replaceChildren();
  $('history-empty').hidden = history.length > 0;
  $('history-count').textContent = history.length ? `${history.length} צעדים בסשן ובסשנים האחרונים` : 'עוד רגע מתחילים';
  for (const h of history.slice(0, 6)) {
    const li = document.createElement('li'), bullet = document.createElement('span'), description = document.createElement('div'), text = document.createElement('span'), sub = document.createElement('small'), time = document.createElement('time');
    bullet.className = 'history-bullet'; bullet.textContent = h.outcome === 'נדחה' ? '−' : '✓';
    description.className = 'history-description'; text.textContent = h.text;
    sub.textContent = `${h.outcome}${h.source === 'demo' ? ' · הדגמה מקומית' : h.source === 'gemini' ? ' · החלטת Gemini' : ''}`;
    time.dateTime = new Date(h.at).toISOString(); time.textContent = new Date(h.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    description.append(text, sub); li.append(bullet, description, time); $('history-list').append(li);
  }
}
function invalidateDecision() {
  requestVersion++; requestController?.abort(); busy = false; pending = null;
  $('agent-actions').hidden = true; $('retry-agent').hidden = true;
  $('agent-status').textContent = demo ? 'הדגמה מקומית' : 'ממתין לזיהוי';
}
function renderTimer() {
  const seconds = remainingSeconds(session);
  $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('timer').setAttribute('aria-label', `נותרו ${Math.floor(seconds / 60)} דקות ו־${seconds % 60} שניות`);
  const total = session.status === 'break' ? 300 : session.duration;
  $('timer-orbit').style.setProperty('--progress', `${Math.max(0, Math.min(100, (1 - seconds / total) * 100))}%`);
  $('session-status').textContent = statusNames[session.status];
  $('session-status').classList.toggle('active', ['focusing', 'completed'].includes(session.status));
  $('timer-caption').textContent = session.status === 'break' ? 'דקות להתאוורר' : session.status === 'completed' ? 'עוד צעד מאחוריך' : 'דקות של זמן לעצמך';
  const buttonText = { idle: '▶  מתחילים להתרכז', focusing: 'Ⅱ  השהיית הטיימר', paused: '▶  חוזרים להתרכז', break: '↩  סיום ההפסקה', completed: '↻  מתחילים סשן חדש' };
  $('timer-main').textContent = buttonText[session.status];
  $('task').disabled = session.status !== 'idle';
  document.querySelectorAll('[data-minutes]').forEach(b => {
    b.disabled = session.status !== 'idle';
    const selected = Number(b.dataset.minutes) * 60 === session.duration;
    b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', selected);
  });
}
function tick() {
  if (session.deadline && remainingSeconds(session) <= 0) {
    invalidateDecision();
    if (session.status === 'break') {
      session.status = 'paused'; session.remaining = session.savedRemaining ?? session.duration; session.savedRemaining = null;
      notify('ההפסקה הסתיימה. אפשר לחזור ללמוד בלחיצה.'); log('ההפסקה הסתיימה');
    } else {
      session.status = 'completed'; session.remaining = 0;
      $('agent-title').textContent = 'עשית מקום להתקדמות'; $('agent-message').textContent = 'הסשן הסתיים. אפשר לנוח לרגע, או לבחור את הצעד הבא.'; $('agent-reason').hidden = true;
      notify('כל הכבוד! השלמת את זמן הלימוד שלך.'); log('סשן הלימוד הושלם', 'COMPLETE');
    }
    session.deadline = null; save();
  }
  renderTimer();
}
function execute(action, source = 'user') {
  if (!session.task.trim() && action === 'START_FOCUS') { $('task').focus(); notify('כדאי לכתוב קודם במה תרצה להתמקד.'); return; }
  if (!allowedActions(session.status).includes(action)) { invalidateDecision(); notify('מצב הסשן השתנה. נמתין להמלצה מעודכנת.'); return; }
  session = applyAction(session, action);
  invalidateDecision(); renderTimer(); save();
  log(actionNames[action], action, 'בוצע', source);
  const messages = { START_FOCUS: 'הטיימר התחיל. בהצלחה במשימה!', PAUSE_FOCUS: 'הטיימר הושהה באישורך. אפשר לחזור כשתהיה מוכן.', RESUME_FOCUS: 'חזרנו ללמוד. הטיימר ממשיך מהמקום שבו עצרת.', DRINK_WATER: 'נרשם ששתית מים. נמתין לפני תזכורת נוספת.', TAKE_BREAK: 'התחילה הפסקה של 5 דקות. זמן הלימוד שנותר נשמר.' };
  $('agent-title').textContent = 'צעד קטן, התקדמות אמיתית'; $('agent-message').textContent = messages[action] || 'ממשיכים בקצב שלך.'; $('agent-reason').hidden = true;
  notify(messages[action] || 'בוצע');
}
$('task').addEventListener('input', () => { session.task = $('task').value; invalidateDecision(); save(); });
document.querySelectorAll('[data-minutes]').forEach(button => button.addEventListener('click', () => {
  if (session.status !== 'idle') return;
  session.duration = Number(button.dataset.minutes) * 60; session.remaining = session.duration;
  invalidateDecision(); renderTimer(); save();
}));
$('timer-main').addEventListener('click', () => {
  if (session.status === 'idle') execute('START_FOCUS');
  else if (session.status === 'focusing') execute('PAUSE_FOCUS');
  else if (session.status === 'paused') execute('RESUME_FOCUS');
  else if (session.status === 'break') {
    session.remaining = session.savedRemaining ?? session.duration; session.savedRemaining = null; session.deadline = null; session.status = 'paused';
    execute('RESUME_FOCUS');
  } else resetSession();
});
function resetSession() {
  const { duration, task, lastDrinkAt } = session;
  session = freshSession(duration / 60, task); session.lastDrinkAt = lastDrinkAt;
  invalidateDecision(); gate = new StablePrediction(); renderTimer(); save(); $('reset-confirm').hidden = true;
  $('agent-title').textContent = 'דף חדש, באותו הקצב'; $('agent-message').textContent = 'בחר משימה והתחל כשנוח לך.'; $('agent-reason').hidden = true;
  log('הסשן אופס');
}
$('timer-reset').addEventListener('click', () => { $('reset-confirm').hidden = false; $('reset-yes').focus(); });
$('reset-yes').addEventListener('click', resetSession);
$('reset-no').addEventListener('click', () => { $('reset-confirm').hidden = true; $('timer-reset').focus(); });

for (const [label, name] of Object.entries(LABELS)) {
  const row = document.createElement('div'); row.className = 'prediction';
  const labelEl = document.createElement('span'); labelEl.className = 'prediction-label';
  const icon = document.createElement('span'); icon.className = 'prediction-icon'; icon.textContent = icons[label]; icon.setAttribute('aria-hidden', 'true');
  labelEl.append(icon, document.createTextNode(name));
  const track = document.createElement('div'), fill = document.createElement('div'), value = document.createElement('span');
  track.className = 'prediction-track'; fill.className = 'prediction-fill'; track.append(fill); value.className = 'prediction-value'; value.dir = 'ltr'; value.textContent = '—';
  row.append(labelEl, track, value); $('predictions').append(row); predictionRows.set(label, { row, fill, value });
  const button = document.createElement('button'); button.textContent = name;
  button.addEventListener('click', () => {
    if (!demo || busy || pending) return;
    renderPredictions(Object.keys(LABELS).map(key => ({ className: key, probability: key === label ? .97 : .0075 })));
    requestDecision({ label, confidence: .97 });
  }); $('demo-buttons').append(button);
}
function renderPredictions(predictions = []) {
  const top = [...predictions].sort((a, b) => b.probability - a.probability)[0];
  for (const [label, elements] of predictionRows) {
    const p = predictions.find(p => p.className === label);
    elements.fill.style.width = `${p ? p.probability * 100 : 0}%`;
    elements.value.textContent = p ? `${Math.round(p.probability * 100)}%` : '—';
    elements.row.classList.toggle('top', Boolean(p && top.className === label));
  }
  latestPrediction = top ? { label: top.className, confidence: top.probability } : null;
  $('prediction-quality').textContent = demo ? 'זיהוי מדומה' : top ? (top.probability >= .85 ? 'בודק יציבות זיהוי' : 'עדיין לא בטוח בזיהוי') : 'ממתין למצלמה';
}
let librariesPromise;
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = url; script.crossOrigin = 'anonymous';
    const timeout = setTimeout(() => { script.remove(); reject(new Error('טעינת ספריית הזיהוי ארכה זמן רב. בדוק את החיבור ונסה שוב.')); }, 25000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('לא ניתן לטעון את ספריית הזיהוי. בדוק את החיבור לאינטרנט.')); };
    document.head.append(script);
  });
}
async function loadModel() {
  if (model) return model;
  if (!librariesPromise) librariesPromise = (async () => {
    if (!window.tf) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js');
    if (!window.tmImage) await loadScript('https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8.5/dist/teachablemachine-image.min.js');
  })().catch(e => { librariesPromise = null; throw e; });
  await librariesPromise;
  model = await window.tmImage.load(MODEL_URL + 'model.json', MODEL_URL + 'metadata.json');
  const actualLabels = model.getClassLabels();
  if (actualLabels.length !== Object.keys(LABELS).length || actualLabels.some(l => !Object.hasOwn(LABELS, l))) { model = null; throw new Error('קטגוריות המודל השתנו. יש לעדכן את הגדרות האפליקציה.'); }
  return model;
}
async function startCamera() {
  if (cameraStarting || cameraActive) return;
  if (!navigator.mediaDevices?.getUserMedia) { $('camera-error').textContent = 'המצלמה דורשת דפדפן תומך וכתובת HTTPS (או localhost בפיתוח).'; $('camera-error').hidden = false; return; }
  cameraStarting = true; const generation = ++cameraGeneration;
  $('camera-toggle').disabled = true; $('camera-toggle').textContent = 'טוען מודל ומבקש גישה למצלמה…'; $('camera-error').hidden = true;
  try {
    await loadModel();
    if (generation !== cameraGeneration) return;
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    if (generation !== cameraGeneration) { acquired.getTracks().forEach(t => t.stop()); return; }
    stream = acquired; $('webcam').srcObject = stream; await $('webcam').play();
    cameraActive = true; gate = new StablePrediction();
    $('webcam').hidden = false; $('camera-placeholder').hidden = true; $('live-tag').hidden = false;
    $('camera-status').textContent = 'מצלמה פעילה'; $('camera-status').classList.add('active');
    $('camera-toggle').textContent = 'כיבוי מצלמה'; $('camera-toggle').disabled = false;
    log('המצלמה הופעלה והמודל נטען'); predictLoop(generation);
  } catch (e) {
    if (generation !== cameraGeneration) return;
    stopCamera();
    const messages = { NotAllowedError: 'הגישה למצלמה לא אושרה. אפשר לאפשר מצלמה בהגדרות האתר ולנסות שוב, או להשתמש במצב ההדגמה.', NotFoundError: 'לא נמצאה מצלמה מחוברת. אפשר לחבר מצלמה או לנסות את מצב ההדגמה.', NotReadableError: 'המצלמה אינה זמינה כרגע. ייתכן שהיא בשימוש באפליקציה אחרת.' };
    $('camera-error').textContent = messages[e.name] || 'לא הצלחנו להפעיל את הזיהוי. בדוק את חיבור האינטרנט והרשאת המצלמה ונסה שוב.'; $('camera-error').hidden = false;
  } finally { cameraStarting = false; if (!cameraActive) { $('camera-toggle').textContent = 'הפעלת מצלמה'; $('camera-toggle').disabled = demo; } }
}
function stopCamera() {
  cameraGeneration++; clearTimeout(loopId); cameraActive = false;
  stream?.getTracks().forEach(t => t.stop()); stream = null; $('webcam').srcObject = null;
  $('webcam').hidden = true; $('camera-placeholder').hidden = false; $('live-tag').hidden = true;
  $('camera-status').textContent = 'מצלמה כבויה'; $('camera-status').classList.remove('active'); $('camera-toggle').textContent = 'הפעלת מצלמה';
  renderPredictions(); invalidateDecision();
}
async function predictLoop(generation) {
  if (!cameraActive || generation !== cameraGeneration) return;
  try {
    const video = $('webcam'), canvas = $('model-canvas'), context = canvas.getContext('2d');
    if (video.readyState >= 2 && video.videoWidth) {
      // Same centered square crop used by the Teachable Machine training preview.
      const side = Math.min(video.videoWidth, video.videoHeight);
      context.save(); context.translate(224, 0); context.scale(-1, 1);
      context.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 224, 224); context.restore();
      const predictions = await model.predict(canvas);
      if (!cameraActive || generation !== cameraGeneration) return;
      renderPredictions(predictions);
      if (!busy && !pending && configured && session.status !== 'completed' && session.status !== 'break' && latestPrediction && gate.update(latestPrediction)) requestDecision(latestPrediction);
    }
    loopId = setTimeout(() => predictLoop(generation), 220);
  } catch { stopCamera(); $('camera-error').textContent = 'הזיהוי נעצר עקב שגיאה. אפשר להפעיל את המצלמה מחדש.'; $('camera-error').hidden = false; }
}
$('camera-toggle').addEventListener('click', () => cameraActive ? stopCamera() : startCamera());
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(t => t.stop()); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (cameraActive || cameraStarting)) { stopCamera(); notify('המצלמה כובתה כשעזבת את הלשונית. הטיימר ממשיך כרגיל.'); } tick(); });

function contextInput(prediction) {
  return { prediction, state: { task: session.task, status: session.status, elapsedSeconds: Math.max(0, session.duration - (session.status === 'break' ? session.savedRemaining : remainingSeconds(session))), remainingSeconds: remainingSeconds(session), lastDrinkAt: session.lastDrinkAt, history: history.slice(0, 8).map(h => ({ action: h.action, outcome: h.outcome })) } };
}
async function requestDecision(prediction) {
  if (busy || pending || !session.task.trim()) return;
  const version = ++requestVersion; const expectedStatus = session.status; const isDemo = demo;
  busy = true; $('agent-status').textContent = 'חושב על הצעד הבא…'; $('retry-agent').hidden = true;
  requestController = new AbortController();
  const timeout = setTimeout(() => requestController?.abort(), 25000);
  try {
    let decision;
    if (isDemo) decision = { ...demoDecision(contextInput(prediction)), source: 'demo' };
    else {
      const response = await fetch('/api/agent', { method: 'POST', signal: requestController.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contextInput(prediction)) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'לא התקבלה החלטה מה־Agent.');
      decision = body;
    }
    if (version !== requestVersion || expectedStatus !== session.status || demo !== isDemo) return;
    if (!allowedActions(session.status).includes(decision.action) || ['title', 'message', 'reason'].some(k => typeof decision[k] !== 'string')) throw new Error('התקבלה החלטה לא תקינה. נסה שוב.');
    $('agent-title').textContent = decision.title; $('agent-message').textContent = decision.message;
    $('agent-reason').textContent = `למה עכשיו? ${decision.reason}`; $('agent-reason').hidden = false;
    $('agent-source').textContent = isDemo ? 'הדגמה מקומית · ללא קריאה ל־Gemini' : 'Gemini · הצעה לפי הזיהוי ומצב הסשן';
    $('agent-status').textContent = isDemo ? 'הדגמה מקומית' : 'ההמלצה מוכנה';
    log(decision.title, decision.action, decision.action === 'CONTINUE' ? 'עודכן משוב' : 'הוצע', decision.source);
    if (decision.action !== 'CONTINUE') {
      pending = { ...decision, expectedStatus };
      $('accept-action').textContent = actionNames[decision.action]; $('agent-actions').hidden = false;
    }
  } catch (e) {
    if (version !== requestVersion) return;
    $('agent-status').textContent = 'החיבור דורש תשומת לב'; $('agent-title').textContent = 'הטיימר שלך ממשיך כרגיל';
    $('agent-message').textContent = e.name === 'AbortError' ? 'התגובה ארכה זמן רב. אפשר לנסות שוב.' : e.message;
    $('agent-reason').hidden = true; $('retry-agent').hidden = false;
    $('agent-source').textContent = 'לא התקבלה החלטת AI';
  } finally { clearTimeout(timeout); if (version === requestVersion) busy = false; }
}
$('accept-action').addEventListener('click', () => {
  if (!pending) return;
  const proposal = pending;
  if (proposal.expectedStatus !== session.status) { invalidateDecision(); notify('הסשן השתנה. נמתין להמלצה חדשה.'); return; }
  execute(proposal.action, proposal.source);
});
$('dismiss-action').addEventListener('click', () => {
  if (pending) log(pending.title, pending.action, 'נדחה', pending.source);
  invalidateDecision(); $('agent-title').textContent = 'בקצב שלך'; $('agent-message').textContent = 'ההמלצה נסגרה. הטיימר נשאר כפי שהוא.'; $('agent-reason').hidden = true;
});
$('retry-agent').addEventListener('click', async () => {
  await checkConnection();
  if (configured && latestPrediction?.confidence >= .85) requestDecision(latestPrediction);
  else notify('הפעל מצלמה והצג חפץ לזיהוי ברור לפני ניסיון נוסף.');
});
$('demo-enabled').addEventListener('change', () => {
  demo = $('demo-enabled').checked; stopCamera(); invalidateDecision();
  $('demo-buttons').hidden = !demo; $('camera-toggle').disabled = demo;
  $('agent-status').textContent = demo ? 'הדגמה מקומית' : 'ממתין לזיהוי';
  $('agent-title').textContent = demo ? 'בוא ננסה תרחיש לדוגמה' : 'נפנה מקום למה שחשוב';
  $('agent-message').textContent = demo ? 'בחר חפץ בכפתורי ההדגמה. כדי לבדוק טלפון בזמן לימוד, התחל קודם את הטיימר.' : 'הפעל את המצלמה והצג חפץ מהשולחן.';
  $('agent-reason').hidden = true; $('agent-source').textContent = demo ? 'הזיהוי וההחלטה מדומים; הטיימר והכפתורים פועלים באמת' : 'ההחלטות שלך, העזרה שלנו';
  $('prediction-quality').textContent = demo ? 'מצב הדגמה' : 'ממתין למצלמה';
});
async function checkConnection() {
  try {
    const response = await fetch('/api/agent', { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error();
    configured = Boolean((await response.json()).configured);
    $('connection-note').textContent = configured ? '' : 'החיבור לעוזר AI עדיין בהכנה. המצלמה והטיימר זמינים, ואפשר להתנסות גם במצב ההדגמה למטה.';
    $('connection-note').hidden = configured;
  } catch {
    configured = false; $('connection-note').textContent = 'כרגע אין חיבור לשרת העוזר. אפשר להשתמש בטיימר ובמצב ההדגמה ולנסות שוב בהמשך.'; $('connection-note').hidden = false;
  }
}
load(); $('task').value = session.task; renderHistory(); tick();
setInterval(tick, 500); checkConnection();
