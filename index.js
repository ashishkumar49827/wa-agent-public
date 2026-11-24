/* wa-agent v3: WhatsApp AI assistant (Perisclaw-style persona)
 * - Connects to YOUR WhatsApp number as a linked device (Baileys / WhatsApp-Web protocol)
 * - Answers in your self-chat ("Message yourself"), and in any chat when you type "/claw <text>"
 * - Perisclaw-style personality: short Hinglish replies, friend energy, no corporate tone
 * - Robust text extraction (ephemeral / view-once / captions), read receipt + typing indicator
 * - Todos, reminders, notes, chat labels, search, daily digest (/help)
 * - /health endpoint for UptimeRobot keep-alive pings
 * - WhatsApp session + agent data backed up (encrypted) to a private GitHub repo
 */
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.join(__dirname, 'session');
const DATA_FILE = path.join(SESSION_DIR, 'agent-data.json');
const WA_PHONE = (process.env.WA_PHONE || '').replace(/[^0-9]/g, '');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/?$/, '/');
const MODEL = process.env.MODEL || 'gemini-2.5-flash';
const OWNER_NAME = process.env.OWNER_NAME || 'Ashish';
const BOT_NAME = process.env.BOT_NAME || 'Claw';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  `Tum ${BOT_NAME} ho, ${OWNER_NAME} ka personal WhatsApp assistant (Perisclaw jaisa).\n` +
  `Awaaz: dost jaisi. Chhota, seedha, thoda shararti. User jis bhasha me likhe usi me jawab do (Hindi, English ya Hinglish - "haan yaar ho gaya" style Hinglish aam hai).\n` +
  `Rules:\n` +
  `- Aam baat me 1-3 line. Lamba jawab sirf tab jab data, list, ya explain karne ko kaha jaye.\n` +
  `- Kaam ki baat pehle. Corporate ya chatbot tone kabhi nahi ("main aapki kaise madad kar sakta hoon" type kabhi nahi).\n` +
  `- Faltu disclaimer aur repetition nahi. Ek hi baat do baar na kaho.\n` +
  `- Emoji 0-2, sirf tab jab sach me baat ke sath baithe.\n` +
  `- Jhoot mat bolo. Pata na ho to seedha bolo "pata nahi" aur chaho to dekhne ka tarika batao.\n` +
  `- Tumhare paas ye commands hain: /todo, /remind, /note, /notes, /find, /clear, /stop, /ignore, /restart, /digest, /claw. Jab user ka kaam inse ho sakta hai, ek line me bol do ki wo command likh de (khud command nahi chala sakte).\n` +
  `- Reminders ka format: /remind 10m chai ya /remind 17:30 call mummy.\n` +
  `- Kisi ke personal baatein ya private data kisi aur ke naam na karo.`;
const GH_TOKEN = process.env.SESSION_BACKUP_TOKEN || '';
const GH_REPO = process.env.SESSION_BACKUP_REPO || '';
const GH_PASS = process.env.SESSION_BACKUP_PASS || '';
const GH_FILE = process.env.SESSION_BACKUP_FILE || 'session.enc';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const state = { connected: false, hasSession: false, pairingCode: null, lastBackup: null, selfChatJid: null, lastLLMError: null };
const sentIds = new Set();
let lastReply = { jid: null, text: '', ts: 0 };
const abortMap = new Map();

/* ---------- agent data (rides the encrypted session backup) ---------- */
let data = { nextId: 1, todos: [], reminders: [], notes: [], labels: {}, history: {}, lastDigest: null, digestHour: 8, ignoredIds: [] };
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch (e) { log.warn({ err: e.message }, 'data load failed, starting fresh'); }
}
function saveData() {
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch (e) { log.error({ err: e.message }, 'data save failed'); }
  scheduleBackup();
}
function getHist(jid) { if (!data.history[jid]) data.history[jid] = []; return data.history[jid]; }
function pushHist(jid, role, content) {
  const h = getHist(jid);
  h.push({ role, content });
  while (h.length > 60) h.shift();
}

/* ---------- encrypted session backup/restore (GitHub) ---------- */
function deriveKey() { return crypto.scryptSync(GH_PASS, 'wa-agent-session-v1', 32); }
function encryptJson(obj) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj))), cipher.final()]);
  return Buffer.concat([Buffer.from('WAB1'), iv, cipher.getAuthTag(), out]);
}
function decryptBuf(buf) {
  if (buf.subarray(0, 4).toString() !== 'WAB1') throw new Error('bad backup file');
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const out = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(out), decipher.final()]).toString());
}
function packSession() {
  const files = {};
  for (const f of fs.readdirSync(SESSION_DIR)) {
    const p = path.join(SESSION_DIR, f);
    if (fs.statSync(p).isFile()) files[f] = fs.readFileSync(p).toString('base64');
  }
  return files;
}
function unpackSession(files) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  for (const [name, b64] of Object.entries(files)) fs.writeFileSync(path.join(SESSION_DIR, name), Buffer.from(b64, 'base64'));
}
async function ghApi(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'wa-agent',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}
async function restoreSession() {
  if (!GH_TOKEN || !GH_REPO || !GH_PASS) return;
  try {
    const res = await ghApi('GET', `/repos/${GH_REPO}/contents/${GH_FILE}`);
    if (res.status === 404) { log.info('no session backup yet (first run)'); return; }
    if (!res.ok) throw new Error(`github get ${res.status}`);
    const json = await res.json();
    unpackSession(decryptBuf(Buffer.from(json.content, 'base64')));
    log.info('session + data restored from backup');
  } catch (e) { log.error({ err: e.message }, 'session restore failed'); }
}
let backupTimer = null;
function scheduleBackup(ms = 90_000) {
  if (!GH_TOKEN || !GH_REPO || !GH_PASS) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(doBackup, ms);
}
async function doBackup() {
  try {
    if (!fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) return;
    const content = encryptJson(packSession()).toString('base64');
    let sha;
    const cur = await ghApi('GET', `/repos/${GH_REPO}/contents/${GH_FILE}`);
    if (cur.ok) sha = (await cur.json()).sha;
    const res = await ghApi('PUT', `/repos/${GH_REPO}/contents/${GH_FILE}`, {
      message: 'session backup', content, branch: 'main', ...(sha ? { sha } : {}),
    });
    if (!res.ok) throw new Error(`github put ${res.status} ${await res.text()}`);
    state.lastBackup = new Date().toISOString();
    log.info('session backed up');
  } catch (e) { log.error({ err: e.message }, 'session backup failed'); }
}

/* ---------- text extraction (handles ephemeral / view-once / captions) ---------- */
function unwrapMsg(msg) {
  let m = msg;
  let guard = 0;
  while (m && guard++ < 6) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m || {};
}
function extractText(msg) {
  const m = unwrapMsg(msg);
  return (m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedDisplayText) ||
    (m.listResponseMessage && m.listResponseMessage.title) || '').trim();
}
function quotedText(msg) {
  const m = unwrapMsg(msg);
  const ctx = m.extendedTextMessage && m.extendedTextMessage.contextInfo;
  if (!ctx || !ctx.quotedMessage) return '';
  return extractText(ctx.quotedMessage);
}

/* ---------- LLM ---------- */
function crossChatContext() {
  const parts = [];
  for (const [j, msgs] of Object.entries(data.history)) {
    if (j === state.selfChatJid) continue;
    const users = msgs.filter((x) => x.role === 'user').slice(-3);
    for (const u of users) parts.push(u.content.slice(0, 100));
  }
  if (!parts.length) return '';
  return `Baaki chats ke haal ke messages (sirf context ke liye):\n${parts.slice(-8).join('\n')}`;
}
async function askLLM(chatJid, userText, signal) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  const cc = crossChatContext();
  const sys = `${SYSTEM_PROMPT}\n\nAbhi: ${now} IST.${cc ? `\n\n${cc}` : ''}`;
  const tryModels = MODEL === 'gemini-2.0-flash' ? ['gemini-2.0-flash'] : [MODEL, 'gemini-2.0-flash'];
  let lastErr = null;
  for (const mdl of tryModels) {
    try {
      const res = await fetch(`${OPENAI_BASE_URL}chat/completions`, {
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: mdl,
          messages: [{ role: 'system', content: sys }, ...getHist(chatJid).slice(-24)],
          max_tokens: 700,
          temperature: 0.9,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        state.lastLLMError = null;
        return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '...';
      }
      lastErr = new Error(`LLM ${mdl} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status !== 404 && res.status !== 429) break;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      lastErr = e;
      break;
    }
  }
  throw lastErr || new Error('LLM failed');
}

/* ---------- helpers ---------- */
function jidUser(jid) { return (jid || '').split('@')[0].split(':')[0]; }
function parseWhen(s) {
  s = (s || '').trim().toLowerCase();
  let m = s.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const u = m[2][0];
    const mult = u === 's' ? 1000 : u === 'm' ? 60000 : u === 'h' ? 3600000 : 86400000;
    return { at: Date.now() + n * mult, label: `${n}${u === 'd' ? ' din' : u} baad` };
  }
  m = s.match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?/);
  if (m) {
    let h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    const d = new Date();
    let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, 0);
    if (t.getTime() <= Date.now()) t = new Date(t.getTime() + 86400000);
    return { at: t.getTime(), label: t.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) };
  }
  return null;
}
function fmtList(items, fmt) { return items.map((x, i) => `${i + 1}. ${fmt(x)}`).join('\n'); }

const HELP = [
  '*Perisclaw-style commands*',
  '/claw - kisi bhi chat ya group me, wahi context le kar kaam',
  '/stop - chalu kaam rokne ke liye',
  '/ignore - jis message pe kaam nahi karna, usko reply karke likho',
  '/restart - main atak jaaun to dobara chalu karne ke liye',
  '',
  '*baaki commands*',
  '/help - ye list',
  '/ping - zinda hai?',
  '/clear - is chat ki memory saaf',
  '/todo add <kaam> | /todo list | /todo done <id> - kaam ki list',
  '/remind <5m | 2h | 17:30> <kya> - reminder',
  '/note <baat> | /notes - chhote notes',
  '/find <shabd> - notes, todos, reminders aur chats me dhoondo',
  '/claw label <naam> - jis chat me likha, uska label',
  '/labels - saare labels',
  '/digest 8 | /digest off - roz subah ka summary',
  'Baaki sab normal bhasha me bol do, command yaad karne ki zaroorat nahi.',
].join('\n');

/* ---------- commands ---------- */
async function handleCommand(sock, jid, text, msg) {
  const t = text.trim();
  if (/^\/help\b/i.test(t)) { await send(sock, jid, HELP); return true; }
  if (/^\/ping\b/i.test(t)) { await send(sock, jid, 'pong'); return true; }
  if (/^\/stop\b/i.test(t)) {
    const ctrl = abortMap.get(jid);
    if (ctrl) { ctrl.abort(); await send(sock, jid, 'Ruk gaya.'); }
    else await send(sock, jid, 'Kuch chal nahi raha tha.');
    return true;
  }
  if (/^\/ignore\b/i.test(t)) {
    const ctx = msg && msg.message && unwrapMsg(msg.message).extendedTextMessage && unwrapMsg(msg.message).extendedTextMessage.contextInfo;
    const qid = ctx && ctx.stanzaId;
    if (qid) {
      if (!data.ignoredIds.includes(qid)) {
        data.ignoredIds.push(qid);
        if (data.ignoredIds.length > 200) data.ignoredIds.shift();
      }
      saveData();
      await send(sock, jid, 'Theek hai, is message pe kaam nahi karunga.');
    } else {
      await send(sock, jid, 'Jis message pe kaam nahi karna, usko reply karke /ignore likho.');
    }
    return true;
  }
  if (/^\/restart\b/i.test(t)) {
    await send(sock, jid, 'Restart kar raha hoon, ek minute...');
    manualRestart = true;
    setTimeout(() => { try { if (sockRef) sockRef.end(new Error('manual restart')); } catch (e) {} }, 2000);
    return true;
  }
  if (/^\/clear\b/i.test(t)) { data.history[jid] = []; saveData(); await send(sock, jid, 'Memory clear. Naya start.'); return true; }
  let m;
  if ((m = t.match(/^\/todo\s+add\s+(.+)/i))) {
    const id = data.nextId++;
    data.todos.push({ id, text: m[1].trim(), done: false, ts: Date.now() });
    saveData(); await send(sock, jid, `Todo #${id} add: ${m[1].trim()}`);
    return true;
  }
  if ((m = t.match(/^\/todo\s+done\s+(\d+)/i))) {
    const id = parseInt(m[1], 10);
    const x = data.todos.find((y) => y.id === id);
    if (x) { x.done = true; saveData(); await send(sock, jid, `#${id} done ✔`); } else await send(sock, jid, `#${id} nahi mila`);
    return true;
  }
  if (/^\/todo/i.test(t)) {
    const open = data.todos.filter((x) => !x.done).slice(-20);
    await send(sock, jid, open.length ? 'Pending todos:\n' + fmtList(open, (x) => `#${x.id} ${x.text}`) : 'Koi pending todo nahi.');
    return true;
  }
  if ((m = t.match(/^\/remind\s+(.+)/i))) {
    const parts = m[1].trim().split(/\s+/);
    const when = parseWhen(parts[0]);
    const what = parts.slice(1).join(' ');
    if (!when || !what) { await send(sock, jid, 'Aise likho: /remind 10m chai, ya /remind 17:30 call mummy'); return true; }
    const id = data.nextId++;
    data.reminders.push({ id, text: what, at: when.at });
    saveData(); await send(sock, jid, `Reminder #${id} set: ${when.label} pe "${what}"`);
    return true;
  }
  if ((m = t.match(/^\/note\s+(.+)/i))) {
    const id = data.nextId++;
    data.notes.push({ id, text: m[1].trim(), ts: Date.now() });
    if (data.notes.length > 300) data.notes.shift();
    saveData(); await send(sock, jid, `Note #${id} save.`);
    return true;
  }
  if (/^\/notes\b/i.test(t)) {
    await send(sock, jid, data.notes.length ? fmtList(data.notes.slice(-20), (x) => `#${x.id} ${x.text}`) : 'Koi note nahi.');
    return true;
  }
  if ((m = t.match(/^\/find\s+(.+)/i))) {
    const q = m[1].trim().toLowerCase();
    const hits = [];
    for (const x of data.notes) if (x.text.toLowerCase().includes(q)) hits.push(`note: ${x.text}`);
    for (const x of data.todos) if (x.text.toLowerCase().includes(q)) hits.push(`todo${x.done ? ' (done)' : ''}: ${x.text}`);
    for (const x of data.reminders) if (x.text.toLowerCase().includes(q)) hits.push(`reminder: ${x.text}`);
    for (const [jid2, msgs] of Object.entries(data.history)) {
      for (const msg of msgs) if (msg.role === 'user' && msg.content.toLowerCase().includes(q)) {
        const who = jid2 === state.selfChatJid ? 'self' : (data.labels[jid2] || 'chat');
        hits.push(`${who}: ${msg.content.slice(0, 120)}`);
      }
    }
    await send(sock, jid, hits.length ? hits.slice(0, 8).join('\n') : `"${m[1].trim()}" kuch nahi mila.`);
    return true;
  }
  if (/^\/labels\b/i.test(t)) {
    const entries = Object.entries(data.labels);
    await send(sock, jid, entries.length ? entries.map(([j, n]) => `${n}: +${jidUser(j)}`).join('\n') : 'Koi label nahi.');
    return true;
  }
  if ((m = t.match(/^\/digest\s+(\d{1,2})/i))) {
    const h = Math.min(23, parseInt(m[1], 10));
    data.digestHour = h; saveData();
    await send(sock, jid, `Digest set: roz ${h}:00 baje.`);
    return true;
  }
  if (/^\/digest\s+off/i.test(t)) { data.digestHour = null; saveData(); await send(sock, jid, 'Digest off.'); return true; }
  return false;
}

/* ---------- WhatsApp ---------- */
async function send(sock, jid, text) {
  const s = String(text || '').trim();
  const chunks = [];
  if (s.length <= 3500) chunks.push(s);
  else for (let i = 0; i < s.length; i += 3500) chunks.push(s.slice(i, i + 3500));
  let last = null;
  for (const c of chunks) {
    lastReply = { jid, text: c, ts: Date.now() };
    last = await sock.sendMessage(jid, { text: c });
    if (last && last.key && last.key.id) sentIds.add(last.key.id);
  }
  return last;
}
async function startSock() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  state.hasSession = fs.existsSync(path.join(SESSION_DIR, 'creds.json'));
  const sock = makeWASocket({ auth, printQRInTerminal: false, logger: pino({ level: 'silent' }) });
  sockRef = sock;

  let pairTries = 0;
  sock.ev.on('creds.update', () => { saveCreds(); scheduleBackup(); });

  sock.ev.on('connection.update', async (u) => {
    if (u.qr && !WA_PHONE) { log.info('scan this QR (WhatsApp > Linked devices):'); qrcode.generate(u.qr, { small: true }); }
    if (u.qr && WA_PHONE && !sock.authState.creds.registered && !state.pairingCode) {
      try {
        const code = await sock.requestPairingCode(WA_PHONE);
        state.pairingCode = code;
        log.info(`PAIRING CODE for ${WA_PHONE}: ${code.slice(0, 4)}-${code.slice(4)} (WhatsApp > Linked devices > Link with phone number)`);
      } catch (e) { log.error({ err: e.message }, 'pairing code request failed'); }
    }
    if (u.connection === 'open') {
      state.connected = true;
      state.selfChatJid = `${jidUser(sock.user.id)}@s.whatsapp.net`;
      log.info({ user: sock.user && sock.user.id }, 'connected to WhatsApp');
      setTimeout(doBackup, 5000);
    }
    if (u.connection === 'close') {
      state.connected = false;
      state.pairingCode = null;
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) { log.error('logged out from WhatsApp. Wipe the session and re-pair.'); return; }
      pairTries++;
      const wait = manualRestart ? 3000 : Math.min(30_000 * pairTries, 300_000);
      manualRestart = false;
      log.warn({ code }, `reconnecting in ${wait / 1000}s`);
      setTimeout(() => { startSock().catch((e) => log.error({ err: e.message }, 'restart failed')); }, wait);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const isGroup = jid.endsWith('@g.us');
        if (data.ignoredIds && data.ignoredIds.includes(m.key.id)) continue;
        const msg = m.message || {};
        const text = extractText(msg);
        if (!text.trim()) continue;
        if (m.key.id && sentIds.has(m.key.id)) continue;
        if (m.key.fromMe && lastReply.jid === jid && lastReply.text === text && Date.now() - lastReply.ts < 120_000) continue;
        const selfChat = sock.user && jidUser(sock.user.id) === jidUser(jid);
        const clawMatch = /^\/claw\s+([\s\S]+)/i.exec(text);
        const plainCmd = /^(\/(stop|ignore|restart|help|ping|clear|todo|remind|note|notes|find|labels|digest)\b)/i.test(text);
        if (!selfChat && !m.key.fromMe) {
          // doosron ke messages: sirf context aur /find ke liye store, jawab nahi
          const name = isGroup ? (m.pushName || 'koi') : (data.labels[jid] || 'chat');
          pushHist(jid, 'user', `${name}: ${text.slice(0, 300)}`);
          const h = getHist(jid);
          while (h.length > 40) h.shift();
          continue;
        }
        if (!selfChat) {
          if (plainCmd) { await handleCommand(sock, jid, text, m); continue; }
          if (!clawMatch) continue;
        }

        // label a chat: type "/claw label <name>" inside that chat
        const lab = text.match(/^\/claw\s+label\s+(.+)/i);
        if (lab && !selfChat) {
          data.labels[jid] = lab[1].trim();
          saveData();
          await send(sock, jid, `Label set: ${lab[1].trim()}`);
          continue;
        }

        const isCmd = await handleCommand(sock, jid, text);
        if (isCmd) continue;

        // blue tick + typing indicator, phir LLM
        try { await sock.readMessages([m.key]); } catch (e) {}
        try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}

        const q = text.replace(/^\/claw\s+/i, '');
        const qText = quotedText(msg);
        const userText = qText && selfChat ? `Pehle ye message tha:\n"${qText.slice(0, 300)}"\n\nAb ye: ${q}` : q;

        pushHist(jid, 'user', userText);
        const ctrl = new AbortController();
        abortMap.set(jid, ctrl);
        try {
          const reply = await askLLM(jid, userText, ctrl.signal);
          pushHist(jid, 'assistant', reply);
          saveData();
          await sock.sendPresenceUpdate('paused', jid).catch(() => {});
          await send(sock, jid, reply);
        } catch (e) {
          if (e && e.name === 'AbortError') {
            log.info({ jid }, 'LLM call stopped by /stop');
          } else {
            state.lastLLMError = String(e.message || e).slice(0, 140);
            log.error({ err: e.message }, 'LLM failed');
            await send(sock, jid, 'oops, upar wala server thoda naraz hai. Thodi der baad phir bhejo.');
          }
        } finally {
          abortMap.delete(jid);
          try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
        }
      } catch (e) { log.error({ err: e.message }, 'message handling failed'); }
    }
  });
  return sock;
}
let sockRef = null;
let manualRestart = false;

/* ---------- reminders + daily digest ---------- */
function startTimers() {
  setInterval(async () => {
    try {
      const now = Date.now();
      const due = data.reminders.filter((r) => r.at <= now);
      if (due.length && state.connected && sockRef && state.selfChatJid) {
        for (const r of due) await send(sockRef, state.selfChatJid, `Reminder: ${r.text}`);
        data.reminders = data.reminders.filter((r) => r.at > now);
        saveData();
      }
      const d = new Date();
      const today = d.toDateString();
      if (state.connected && sockRef && state.selfChatJid && data.digestHour != null &&
          d.getHours() === data.digestHour && data.lastDigest !== today) {
        data.lastDigest = today;
        const open = data.todos.filter((x) => !x.done);
        const todayRem = data.reminders.filter((r) => new Date(r.at).toDateString() === today);
        let msg = 'Subah ka update:\n';
        msg += open.length ? fmtList(open.slice(-10), (x) => `todo #${x.id}: ${x.text}`) : '- koi pending todo nahi';
        msg += '\n' + (todayRem.length ? fmtList(todayRem, (x) => `reminder: ${x.text}`) : '- aaj koi reminder nahi');
        msg += `\n- ${data.notes.length} notes saved`;
        await send(sockRef, state.selfChatJid, msg);
        saveData();
      }
    } catch (e) { log.error({ err: e.message }, 'timer failed'); }
  }, 30_000);
}

/* ---------- HTTP (health for UptimeRobot) ---------- */
const app = express();
app.get('/health', (req, res) => res.json({
  ok: true, connected: state.connected, hasSession: state.hasSession,
  lastBackup: state.lastBackup, pairingCode: state.pairingCode,
  model: MODEL, lastLLMError: state.lastLLMError,
  todos: data.todos.filter((x) => !x.done).length, reminders: data.reminders.length,
}));
app.get('/', (req, res) => res.type('text/plain').send(`wa-agent\nconnected: ${state.connected}\nsession: ${state.hasSession}\npairing: ${state.pairingCode || 'none yet'}\nlastBackup: ${state.lastBackup || 'none yet'}\n`));

/* ---------- main ---------- */
if (require.main === module) {
  app.listen(PORT, () => log.info({ port: PORT }, 'http up'));
  (async () => {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    await restoreSession();
    loadData();
    await startSock().catch((e) => log.error({ err: e.message }, 'boot failed'));
    setInterval(() => { if (!state.connected && WA_PHONE) state.pairingCode = null; }, 60_000);
    startTimers();
  })();
  process.on('unhandledRejection', (e) => log.error({ err: String(e) }, 'unhandledRejection'));
}
module.exports = { parseWhen, handleCommand };
