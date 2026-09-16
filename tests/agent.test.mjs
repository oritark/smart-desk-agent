import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { validateInput, validateDecision } from '../api/agent.js';
import { applyAction, remainingSeconds, demoDecision, StablePrediction } from '../public/logic.js';
const state = { status: 'focusing', task: 'ללמוד', elapsedSeconds: 100, remainingSeconds: 1400, lastDrinkAt: 0, history: [] };
const input = () => ({ prediction: { label: 'PHONE', confidence: .95 }, state: { ...state } });
test('phone proposal does not change session until action is accepted', () => {
  const s = { ...state, duration: 1500, remaining: 1400, deadline: 1400000 };
  const before = structuredClone(s);
  const decision = demoDecision({ prediction: { label: 'PHONE' }, state: s });
  assert.equal(decision.action, 'PAUSE_FOCUS'); assert.deepEqual(s, before);
  const paused = applyAction(s, decision.action, 100000);
  assert.equal(paused.status, 'paused'); assert.equal(paused.deadline, null); assert.equal(paused.remaining, 1300);
  assert.equal(applyAction(paused, 'RESUME_FOCUS', 200000).deadline, 1500000);
});
test('timer uses real elapsed time, including inactive-tab time', () => {
  assert.equal(remainingSeconds({ remaining: 1500, deadline: 1500000 }, 600000), 900);
  assert.equal(remainingSeconds({ remaining: 1500, deadline: 1500000 }, 1600000), 0);
});
test('same bottle yields a different decision after drinking', () => {
  const now = 10000000;
  assert.equal(demoDecision({ prediction: { label: 'WATER BOTTLE' }, state }, now).action, 'DRINK_WATER');
  assert.equal(demoDecision({ prediction: { label: 'WATER BOTTLE' }, state: { ...state, lastDrinkAt: now - 1000 } }, now).action, 'CONTINUE');
});
test('unstable predictions, repeated frames and repeated labels do not spam agent', () => {
  const gate = new StablePrediction(); const phone = { label: 'PHONE', confidence: .95 };
  assert.equal(gate.update(phone, 0), false); assert.equal(gate.update(phone, 1499), false); assert.equal(gate.update(phone, 1500), true);
  assert.equal(gate.update(phone, 50000), false);
  assert.equal(gate.update({ ...phone, confidence: .5 }, 121500), false);
  assert.equal(gate.update(phone, 122000), false); assert.equal(gate.update(phone, 124000), true);
});
test('break preserves remaining focus time and invalid actions cannot pause an idle session', () => {
  const s = { status: 'focusing', remaining: 1000, deadline: 2000000 };
  const breakState = applyAction(s, 'TAKE_BREAK', 1500000);
  assert.equal(breakState.savedRemaining, 500); assert.equal(breakState.deadline, 1800000); assert.equal(breakState.status, 'break');
  const idle = { status: 'idle', remaining: 1500, deadline: null };
  assert.strictEqual(applyAction(idle, 'PAUSE_FOCUS'), idle);
});
test('API rejects low confidence, unknown classes, bad state and extra-long content', () => {
  assert.doesNotThrow(() => validateInput(input()));
  for (const patch of [{ label: 'PERSON', confidence: .9 }, { label: 'PHONE', confidence: .2 }, { label: 'PHONE', confidence: NaN }]) assert.throws(() => validateInput({ ...input(), prediction: patch }));
  assert.throws(() => validateInput({ ...input(), state: { ...state, task: 'x'.repeat(161) } }));
  assert.throws(() => validateInput({ ...input(), state: { ...state, status: 'unknown' } }));
  assert.throws(() => validateInput({ ...input(), state: { ...state, history: null } }));
  assert.equal(validateInput({ ...input(), secret: 'never forward this' }).secret, undefined);
});
test('server validates the AI action against current session', () => {
  const decision = { action: 'PAUSE_FOCUS', title: 'כותרת', message: 'הודעה', reason: 'סיבה' };
  assert.throws(() => validateDecision(decision, 'idle'));
  assert.doesNotThrow(() => validateDecision(decision, 'focusing'));
  assert.throws(() => validateDecision({ ...decision, action: 'RUN_CODE' }, 'focusing'));
});
async function call(body, method = 'POST', origin = 'http://localhost:3000') {
  const req = { method, body, headers: { 'content-type': 'application/json', host: 'localhost:3000', origin }, socket: { remoteAddress: 'test' } };
  const result = {};
  const res = { setHeader() {}, status(code) { result.status = code; return this; }, json(data) { result.body = data; } };
  await handler(req, res); return result;
}
test('endpoint rejects cross-origin posts and never returns the API key', async () => {
  assert.equal((await call(input(), 'POST', 'https://elsewhere.test')).status, 403);
  assert.equal((await call(input(), 'PUT')).status, 405);
  const previous = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try {
    const status = await call(null, 'GET'); assert.deepEqual(status.body, { configured: false });
    const result = await call(input()); assert.equal(result.status, 503); assert.equal(result.body.code, 'NOT_CONFIGURED');
  } finally { if (previous !== undefined) process.env.GEMINI_API_KEY = previous; }
});
test('Gemini request sends only validated context and validates response (mock transport)', async () => {
  const previousFetch = globalThis.fetch, key = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only-not-a-real-key';
  globalThis.fetch = async (url, options) => {
    assert.match(url, /generativelanguage.googleapis.com/);
    assert.equal(options.headers['x-goog-api-key'], 'test-only-not-a-real-key');
    const payload = JSON.parse(options.body);
    assert.equal(payload.generationConfig.responseMimeType, 'application/json');
    assert.equal(JSON.parse(payload.contents[0].parts[0].text).prediction.label, 'PHONE');
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ action: 'PAUSE_FOCUS', title: 'מיקוד', message: 'להשהות?', reason: 'טלפון בזמן לימוד' }) }] } }] }) };
  };
  try {
    const result = await call(input()); assert.equal(result.status, 200); assert.equal(result.body.source, 'gemini');
    assert.equal(JSON.stringify(result.body).includes('test-only-not-a-real-key'), false);
  } finally { globalThis.fetch = previousFetch; if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; }
});
