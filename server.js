// server.js —— 零依赖 Node 服务：静态托管 + AI 接口代理
// 运行：node server.js   （Node 18+，无需 npm install）
//
// 环境变量（可选，不配也能跑，会自动进入 Mock 模式）：
//   DEEPSEEK_API_KEY  DeepSeek 密钥（配了它，下面的 base/model 都有默认值）
//   AI_BASE_URL       默认 https://api.deepseek.com
//   AI_API_KEY        其他厂商的密钥（优先于 DEEPSEEK_API_KEY）
//   AI_MODEL          默认 deepseek-flash
//   AI_VISION_MODEL   默认 deepseek-flash（DeepSeek 里唯一接受图片的模型）
//   AI_THINKING       设为 1 才开深度思考；估算场景默认关闭
//   PORT              端口，默认 3000

import http from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAuth, parseCookies, sessionCookie, clearCookie } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

// ---------- DeepSeek Flash 配置 ----------
// 密钥从 .env / 环境变量读取，不再写死在源码里；没配就自动进 Mock 模式。
const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_AI_MODEL = 'deepseek-flash';
const DEFAULT_AI_VISION_MODEL = 'deepseek-flash'; // DeepSeek 里只有它接受图片输入
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 60000);

function aiConfig() {
  const dsk = process.env.DEEPSEEK_API_KEY || '';
  const base = (process.env.AI_BASE_URL || (dsk ? DEFAULT_AI_BASE_URL : ''))
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '');
  const key = process.env.AI_API_KEY || dsk;
  const model = process.env.AI_MODEL || (dsk ? DEFAULT_AI_MODEL : '');
  return {
    base,
    key,
    model,
    visionModel: process.env.AI_VISION_MODEL || (dsk ? DEFAULT_AI_VISION_MODEL : ''),
    ready: Boolean(base && key && model),
    thinking: /^(1|on|true|yes)$/i.test(String(process.env.AI_THINKING || '')),
  };
}

const isDeepSeek = (cfg) => /deepseek\.com/i.test(cfg.base) || /^deepseek/i.test(cfg.model);

// ---------- 极简 .env 读取（有就用，没有就跳过） ----------
async function loadDotEnv() {
  try {
    const raw = await readFile(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const auth = createAuth({ dir: DATA_DIR });
const secureCookie = Boolean(process.env.COOKIE_SECURE || process.env.VERCEL);

/** 这些接口不需要登录 */
const AUTH_FREE = new Set([
  '/api/health',
  '/api/version',
  '/api/ping',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
]);

/** 从请求里取会话 id：优先 Authorization，其次 Cookie（代理层可能丢 Set-Cookie） */
function sessionIdFrom(req) {
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return parseCookies(req.headers.cookie || '').sid;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function send(res, code, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limitBytes = 15 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('图片太大，请压缩后再上传');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// ---------- 模型调用 ----------
const DISH_SCHEMA = `输出格式：{"dishes":[{"name":"菜名","grams":估计克数,"kcal":热量千卡,"protein":蛋白质克,"fat":脂肪克,"carb":碳水克,"category":"staple|protein|veg|soup|drink|fruit","confidence":0到1}]}`;

const SYSTEM_PROMPT = `你是校园食堂的营养估算助手。用户会发一张餐盘或菜单照片，你只输出 JSON，不要任何解释文字。
${DISH_SCHEMA}
要求：
1. 只列照片里真正看得见的食物；看不清就不要编。照片里没有食物时输出 {"dishes":[]}。
2. 按中式食堂常见做法估算，用盘子、餐盒、筷子勺子做大小参照（一份米饭约 150–200 g，一份炒菜约 100–150 g）。
3. 每道菜单独列出，同一道菜不要重复，最多 6 道。
4. category 只能取 staple、protein、veg、soup、drink、fruit 之一。
5. 数值用整数；没把握的项给保守估计，并在 confidence 里体现（0–1）。
6. 只输出 JSON，不要 markdown 代码块，不要在 JSON 前后加任何文字。`;

const TEXT_PROMPT = `你是校园食堂的营养估算助手。用户会给你一串菜名，你只输出 JSON，不要任何解释文字。
${DISH_SCHEMA}
要求：
1. 只估算用户列出的菜，不要自己加菜；没列出的不要出现。
2. 按"一人一份"的中式食堂常见份量估算（一份米饭 150–200 g，一份炒菜 100–150 g，一份汤 250–300 g）。
3. 每道菜单独列出，最多 6 道；同一道菜重复出现就合并成一条。
4. category 只能取 staple、protein、veg、soup、drink、fruit 之一。
5. 数值用整数；没把握的项给保守估计，并在 confidence 里体现（0–1）。
6. 只输出 JSON，不要 markdown 代码块，不要在 JSON 前后加任何文字。`;

function parseJsonLoose(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const body = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(body);
      } catch (e2) {
        try {
          return JSON.parse(repairJson(body));
        } catch (e3) {
          throw new Error('模型返回的 JSON 不完整：' + cleaned.slice(0, 160).replace(/\s+/g, ' '));
        }
      }
    }
    throw new Error('模型没有返回合法 JSON：' + cleaned.slice(0, 160).replace(/\s+/g, ' '));
  }
}

async function callModel(messages, opts = {}) {
  const cfg = aiConfig();
  if (!cfg.ready) return null;
  const model = opts.model || cfg.model;

  const payload = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 2048,
  };
  // 估算/识别不需要长推理：DeepSeek 默认开着思考模式，这里显式关掉（AI_THINKING=1 可打开）
  if (isDeepSeek(cfg)) payload.thinking = { type: cfg.thinking ? 'enabled' : 'disabled' };
  if (!cfg.thinking) payload.temperature = opts.temperature ?? 0.3;
  if (opts.jsonMode) payload.response_format = { type: 'json_object' };

  const request = (body) =>
    fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

  const started = Date.now();
  let resp;
  try {
    resp = await request(payload);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`模型 ${Math.round(AI_TIMEOUT_MS / 1000)} 秒没有响应，请重试`);
    }
    throw new Error(`连不上模型接口 ${cfg.base}：${e.message}`);
  }

  // 个别兼容接口不认 response_format：只在确实是这个原因时才去掉重试
  if (!resp.ok && opts.jsonMode) {
    const detail = await resp.text().catch(() => '');
    if (resp.status === 400 && /response_format|json_object/i.test(detail)) {
      delete payload.response_format;
      resp = await request(payload);
    } else {
      throw httpError(resp.status, detail);
    }
  }
  if (!resp.ok) throw httpError(resp.status, await resp.text().catch(() => ''));

  const data = await resp.json();
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('模型输出被截断，请重试或减少菜品数量');
  const content = choice?.message?.content ?? '';
  const usage = data?.usage || {};
  console.log(`[ai] ${model} ${Date.now() - started}ms tokens=${usage.total_tokens ?? '?'} json=${Boolean(opts.jsonMode)}`);
  return content;
}

/** 把上游 HTTP 错误翻译成用户看得懂的中文 */
function httpError(status, detail) {
  const hint =
    {
      400: '模型不接受这次请求',
      401: 'API 密钥无效',
      402: 'DeepSeek 账户余额不足',
      403: '这个密钥没有调用该模型的权限',
      404: '接口地址或模型名不对',
      422: '请求参数不被支持',
      429: '请求太频繁或额度已用完',
      500: '模型服务内部错误',
      503: '模型服务繁忙，请稍后再试',
    }[status] || '模型接口出错';

  const raw = String(detail || '');
  let msg = raw;
  try {
    const j = JSON.parse(raw);
    msg = j?.error?.message || j?.message || raw;
  } catch {}
  if (status === 402) {
    return new Error('DeepSeek 账户余额不足，请到 platform.deepseek.com 充值后再试（不用改代码）');
  }
  if (status === 400 && /image|vision|modalit/i.test(raw + msg)) {
    return new Error('当前模型不支持图片输入，请把 AI_VISION_MODEL 设为 deepseek-flash');
  }
  return new Error(`${hint}（HTTP ${status}）${msg ? '：' + String(msg).slice(0, 200) : ''}`);
}

/** 解析失败时先做一次"修 JSON"，再抛错 */
function repairJson(text) {
  return String(text)
    .replace(/[\u0000-\u001F]+/g, ' ')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/^[^\[{]*/, '')
    .trim();
}

/** 调模型并拿到对象；失败自动重试一次（次数少、成本低） */
async function callModelJson(messages, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await callModel(messages, { ...opts, jsonMode: true });
    if (content === null) return null;
    try {
      // JSON 模式下模型偶尔返回空串或纯空格（见 DeepSeek 文档），当成失败重试
      if (!String(content).trim()) throw new Error('模型这次没返回内容，请重试');
      return parseJsonLoose(content);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

function normalizeDishes(list) {
  const clamp = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));

  return (Array.isArray(list) ? list : [])
    .map((d, i) => {
      const protein = clamp(d.protein, 200);
      const fat = clamp(d.fat, 200);
      const carb = clamp(d.carb, 300);
      let kcal = clamp(d.kcal, 5000);
      // 模型漏填热量时，用 Atwater 系数（蛋白/碳水 4、脂肪 9）兜底
      if (!kcal) kcal = Math.round(protein * 4 + fat * 9 + carb * 4);

      return {
        id: `ai-${Date.now()}-${i}`,
        name: String(d.name || '未识别菜品').slice(0, 20),
        category: ['staple', 'protein', 'veg', 'soup', 'drink', 'fruit'].includes(d.category) ? d.category : 'protein',
        kcal,
        protein,
        fat,
        carb,
        grams: clamp(d.grams, 2000),
        confidence: Math.min(1, Math.max(0, Number(d.confidence) || 0.6)),
        source: 'ai',
      };
    })
    .filter((d) => d.kcal > 0);
}

// ---------- 路由 ----------
async function apiAuth(req, res, url) {
  const sid = sessionIdFrom(req);

  if (url === '/api/auth/me') {
    const user = await auth.sessionUser(sid);
    return user ? send(res, 200, { ok: true, user }) : send(res, 401, { ok: false, error: '未登录' });
  }

  if (url === '/api/auth/logout') {
    await auth.destroySession(sid);
    return send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'Set-Cookie': clearCookie() });
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method Not Allowed' });

  const body = await readBody(req);
  try {
    if (url === '/api/auth/register') {
      const user = await auth.register(body.username, body.password);
      const newSid = await auth.createSession(user.id);
      return send(res, 200, { ok: true, user, token: newSid }, 'application/json; charset=utf-8', {
        'Set-Cookie': sessionCookie(newSid, { secure: secureCookie }),
      });
    }
    if (url === '/api/auth/login') {
      const user = await auth.verify(body.username, body.password);
      if (!user) return send(res, 401, { ok: false, error: '用户名或密码不对' });
      const newSid = await auth.createSession(user.id);
      return send(res, 200, { ok: true, user, token: newSid }, 'application/json; charset=utf-8', {
        'Set-Cookie': sessionCookie(newSid, { secure: secureCookie }),
      });
    }
    return send(res, 404, { ok: false, error: 'Not Found' });
  } catch (e) {
    return send(res, 400, { ok: false, error: String(e.message || e) });
  }
}

async function apiVision(req, res) {
  const body = await readBody(req);
  if (!body.image || !String(body.image).startsWith('data:image/')) {
    return send(res, 400, { ok: false, error: '缺少图片数据（data:image/...）' });
  }
  // base64 约膨胀 1/3，6MB 原图已经足够
  if (String(body.image).length > 8 * 1024 * 1024) {
    return send(res, 413, { ok: false, error: '图片太大，请压缩后再上传' });
  }

  const cfg = aiConfig();
  const started = Date.now();
  try {
    const parsed = await callModelJson(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请识别这份食堂餐食，估算每道菜的热量与三大营养素。' },
            { type: 'image_url', image_url: { url: body.image } },
          ],
        },
      ],
      { maxTokens: 1200, temperature: 0.2, model: cfg.visionModel }
    );

    if (parsed === null) {
      return send(res, 200, {
        ok: false,
        error: '还没有配置 AI 密钥：把 .env.example 复制成 .env，填入 DEEPSEEK_API_KEY 后重启',
      });
    }
    const dishes = normalizeDishes(parsed.dishes);
    if (!dishes.length) throw new Error('照片里没认出食物，换一张更清晰、光线更好的图试试');
    send(res, 200, {
      ok: true,
      mock: false,
      dishes,
      model: cfg.visionModel,
      ms: Date.now() - started,
      note: `由 ${cfg.visionModel} 识别（${((Date.now() - started) / 1000).toFixed(1)} 秒）· 数字是估算值，请按实际份量改`,
    });
  } catch (e) {
    // 关键：识别失败就如实报错，绝不拿示例菜冒充识别结果
    console.error('[vision]', e.message);
    send(res, 200, { ok: false, error: String(e.message || e) });
  }
}

async function apiExtract(req, res) {
  const body = await readBody(req);
  const text = String(body.text || '').trim();
  if (!text) return send(res, 400, { ok: false, error: '缺少菜品文字' });

  const cfg = aiConfig();
  const started = Date.now();
  try {
    const parsed = await callModelJson(
      [
        { role: 'system', content: TEXT_PROMPT },
        { role: 'user', content: `这是我今天食堂能买到的菜：${text}\n请按每份（一人量）估算，输出 JSON。` },
      ],
      { maxTokens: 1200, temperature: 0.2, model: cfg.model }
    );
    if (parsed === null) {
      return send(res, 200, {
        ok: false,
        error: '还没有配置 AI 密钥：把 .env.example 复制成 .env，填入 DEEPSEEK_API_KEY 后重启',
      });
    }
    send(res, 200, {
      ok: true,
      mock: false,
      dishes: normalizeDishes(parsed.dishes),
      model: cfg.model,
      ms: Date.now() - started,
      note: `由 ${cfg.model} 估算（${((Date.now() - started) / 1000).toFixed(1)} 秒）· 可以逐项修改`,
    });
  } catch (e) {
    console.error('[extract]', e.message);
    send(res, 200, { ok: false, error: String(e.message || e) });
  }
}

const COACH_PROMPT = `你是"轻宿"里的减脂教练，用户是中国的大学生，住宿舍、吃食堂。
说话要求：
1. 像一个靠谱的学长/学姐，短句，最多 3 句，不说教、不喊口号、不用"亲"。
2. 先接住用户的情绪或处境，再给一个今天就能做的具体动作。
3. 不承诺减重数字，不推荐代餐、药、断食；用户提到极端做法时要明确劝止并建议校医院。
4. 只输出 JSON，不要 markdown。

输出格式：
{"items":[{"name":"食物名","kcal":数字,"protein":数字,"fat":数字}],
 "reply":"两三句话的回应",
 "advice":["一条今天就能做的具体建议"],
 "risk":false}
items 只填用户真正吃了的东西；没提到吃的东西就留空数组。risk 表示用户是否出现暴食、催吐、过度节食等需要提醒的信号。`;

async function apiCoach(req, res) {
  const body = await readBody(req);
  const text = String(body.text || '').trim();
  const ctx = body.context || {};
  if (!text) return send(res, 400, { ok: false, error: '说点什么吧' });

  const contextLine = [
    ctx.targetKcal ? `今天目标 ${ctx.targetKcal} kcal，已记录 ${ctx.eatenKcal || 0} kcal，蛋白 ${ctx.eatenProtein || 0}g / 目标 ${ctx.protein || 0}g` : '用户还没填档案',
    ctx.state ? `今天状态：${ctx.state}` : '',
    ctx.training ? `今日训练安排：${ctx.training}` : '',
  ]
    .filter(Boolean)
    .join('；');

  try {
    const parsed = await callModelJson(
      [
        { role: 'system', content: COACH_PROMPT },
        { role: 'user', content: `【今天的背景】${contextLine}\n【用户说】${text}` },
      ],
      { maxTokens: 1200, temperature: 0.6 }
    );

    if (parsed === null) {
      const items = mockParseFood(text);
      const kcal = items.reduce((a, d) => a + d.kcal, 0);
      return send(res, 200, {
        ok: true,
        mock: true,
        items,
        reply: kcal
          ? `记下了，这一顿大约 ${kcal} kcal。${ctx.targetKcal ? `离今天的目标还剩 ${Math.max(0, ctx.targetKcal - (ctx.eatenKcal || 0) - kcal)} kcal。` : ''}`
          : '听到了。今天不用追求完美，先把下一顿吃对就行。',
        advice: ['下一顿先拿一份蛋白质（鸡蛋/鸡胸/豆腐），再决定主食吃多少。'],
        risk: false,
        note: 'AI 暂不可用，返回示例回复',
      });
    }

    send(res, 200, {
      ok: true,
      mock: false,
      items: normalizeDishes(parsed.items || []).map(({ grams, confidence, source, ...rest }) => rest),
      reply: String(parsed.reply || '').slice(0, 200),
      advice: (Array.isArray(parsed.advice) ? parsed.advice : []).slice(0, 3).map((s) => String(s).slice(0, 80)),
      risk: Boolean(parsed.risk),
    });
  } catch (e) {
    send(res, 200, { ok: false, error: String(e.message || e) });
  }
}

/** Mock 模式下用关键词粗估，只为了演示流程能走通 */
function mockParseFood(text) {
  const dict = [
    [/炸鸡|鸡腿/, '炸鸡腿', 320, 22, 20],
    [/奶茶/, '奶茶（中杯）', 350, 4, 12],
    [/泡面|方便面/, '泡面', 450, 9, 20],
    [/米饭|饭/, '米饭', 230, 4, 1],
    [/鸡蛋|蛋/, '鸡蛋', 70, 6, 5],
    [/鸡胸/, '鸡胸肉', 180, 30, 6],
    [/牛奶/, '牛奶', 160, 8, 8],
    [/面包/, '面包', 260, 8, 6],
    [/水果|苹果|香蕉/, '水果', 95, 1, 0],
    [/烧烤|串/, '烧烤', 500, 25, 35],
    [/火锅/, '火锅', 800, 35, 50],
    [/酒|啤酒/, '啤酒', 150, 1, 0],
  ];
  const out = [];
  for (const [re, name, kcal, protein, fat] of dict) {
    if (re.test(text)) out.push({ name, kcal, protein, fat });
  }
  return out.slice(0, 5);
}


const PLAN_PROMPT = `你是"轻宿"的宿舍减脂训练教练，服务对象是住宿舍、吃食堂的中国大学生。
根据用户今天的身体状态、可用时间和限制，排一套**今天就能在宿舍做**的训练。

硬约束（必须遵守）：
1. 全部动作无需器械，只用身体自重；空间 2 平方米内可完成。
2. 默认不能扰邻：避免跳跃、落地重的动作（除非用户明确说不怕吵）。
3. 结构必须是 热身 → 主训练 → 拉伸 三段，每段 1–5 个动作。
4. 强度要匹配用户状态：熬夜困倦要降档，疲惫不适只做恢复。
5. 总时长贴近用户给的可训练分钟数，允许 ±20%。
6. 动作写清组数与次数/时长，例如"深蹲 15 次 × 3 组""平板支撑 40 秒 × 3 组"。
7. 必须结合【今日已摄入热量】和【剩余可摄入热量】调整：摄入较高或剩余很少时，在状态允许和时长范围内适当增加低冲击消耗；摄入较低或剩余较多时，不额外加练，保留恢复和基础训练。不要用运动惩罚进食。

只输出 JSON，不要 markdown：
{"level":"低|中|中高|恢复","totalMinutes":数字,
 "blocks":[{"title":"热身","items":["..."]},{"title":"主训练","items":["..."]},{"title":"拉伸","items":["..."]}],
 "why":"一句话说明为什么这样排，要提到用户的状态"} `;

async function apiPlan(req, res) {
  const body = await readBody(req);
  const p = body.profile || {};
  const state = String(body.state || 'normal');
  const minutes = Number(body.minutes) || 30;
  const extra = String(body.extra || '').slice(0, 120);
  const intake = body.intake || {};
  const intakeKcal = Math.max(0, Number(intake.kcal) || 0);
  const intakeProtein = Math.max(0, Number(intake.protein) || 0);
  const intakeFat = Math.max(0, Number(intake.fat) || 0);
  const targetKcal = Math.max(0, Number(body.targetKcal) || 0);
  const remainKcal = targetKcal ? Math.round(targetKcal - intakeKcal) : null;

  const stateText = { normal: '正常', tired: '熬夜困倦', unwell: '疲惫不适' }[state] || '正常';
  const userLine = `【用户】${p.sex === 'male' ? '男' : '女'}，${p.age || '?'} 岁，${p.weightKg || '?'} kg。
【今天状态】${stateText}
【可训练时长】${minutes} 分钟
【今日已摄入】${intakeKcal} kcal（蛋白 ${intakeProtein}g，脂肪 ${intakeFat}g）
【今日目标】${targetKcal || '未提供'} kcal
【剩余可摄入】${remainKcal == null ? '未提供' : remainKcal + ' kcal'}
【额外说明】${extra || '无'}`;

  try {
    const parsed = await callModelJson(
      [
        { role: 'system', content: PLAN_PROMPT },
        { role: 'user', content: userLine },
      ],
      { maxTokens: 3000, temperature: 0.4 }
    );

    if (parsed === null) {
      return send(res, 200, { ok: true, mock: true, note: 'AI 暂不可用，前端使用本地规则方案' });
    }
    send(res, 200, { ok: true, mock: false, plan: parsed });
  } catch (e) {
    send(res, 200, { ok: true, mock: true, note: 'AI 暂不可用，已保留本地规则方案', error: String(e.message || e) });
  }
}


const MEAL_PROMPT = `你是"轻宿"的配餐师。用户是住宿舍、吃食堂的中国大学生，只能在给定菜品里选。

规则：
1. 只能用列表里出现的菜，菜名必须原样照抄，不许新增或改名。
2. 每餐 2–4 道菜，搭配上要有一份主食、一份蛋白质、一份蔬菜。
3. 用 portion 表示份量倍数：0.5 = 半份，1 = 一份，1.5 = 一份半。
4. 合计热量必须达到目标的 90%–110%。如果不够，先把份量加到 1.5，再不够就再加一道菜；宁可多一份主食，也不要差 300 大卡。
5. 蛋白质至少要达到目标的 85%。
6. 考虑用户今天的状态：熬夜困倦就选清爽好消化的，疲惫不适避开油腻。

只输出 JSON，不要 markdown：
{"meals":{"breakfast":[{"name":"菜名","portion":1}],"lunch":[...],"dinner":[...]},
 "why":"一两句话说明这套搭配的取舍",
 "tips":["一条今天能做到的建议"]}`;

/** 粗算一份配餐方案的热量，只用于判断要不要重试 */
function sumPlanKcal(plan, dishes) {
  const byName = new Map(dishes.map((d) => [String(d.name).trim(), d]));
  let total = 0;
  for (const key of ['breakfast', 'lunch', 'dinner']) {
    const list = Array.isArray(plan?.meals?.[key]) ? plan.meals[key] : [];
    for (const it of list) {
      const d = byName.get(String(it?.name || '').trim());
      if (!d) continue;
      const portion = Math.min(2, Math.max(0.5, Number(it?.portion) || 1));
      total += Number(d.kcal) * portion;
    }
  }
  return total;
}

async function apiMeals(req, res) {
  const body = await readBody(req);
  const dishes = Array.isArray(body.dishes) ? body.dishes.slice(0, 40) : [];
  const target = body.target || {};
  if (!dishes.length) return send(res, 400, { ok: false, error: '菜单是空的' });

  const list = dishes
    .map((d) => `${d.name}（${Math.round(d.kcal)}kcal / 蛋白${Math.round(d.protein)}g / 脂肪${Math.round(d.fat)}g）`)
    .join('\n');

  try {
    const parsed = await callModelJson(
      [
        { role: 'system', content: MEAL_PROMPT },
        {
          role: 'user',
          content: `【目标】热量 ${Math.round(target.kcal)} kcal，蛋白 ${Math.round(target.protein)} g，脂肪 ${Math.round(target.fat)} g
【今日状态】${{ normal: '正常', tired: '熬夜困倦', unwell: '疲惫不适' }[body.state] || '正常'}
【可选菜品】
${list}`,
        },
      ],
      { maxTokens: 1500, temperature: 0.4 }
    );
    if (parsed === null) return send(res, 200, { ok: true, mock: true, note: 'AI 暂不可用' });

    // 热量没咬住目标时，带着差额再问一次（一次自我修正）
    const want = Number(target.kcal) || 0;
    const got = sumPlanKcal(parsed, dishes);
    if (want > 0 && got > 0 && (got < want * 0.88 || got > want * 1.12)) {
      const retry = await callModelJson(
        [
          { role: 'system', content: MEAL_PROMPT },
          {
            role: 'user',
            content: `【目标】热量 ${Math.round(want)} kcal，蛋白 ${Math.round(target.protein)} g
【今日状态】${{ normal: '正常', tired: '熬夜困倦', unwell: '疲惫不适' }[body.state] || '正常'}
【可选菜品】
${list}

【上一版的问题】你上一版合计只有约 ${Math.round(got)} kcal，比目标少 ${Math.round(want - got)} kcal。
请加大份量（portion 可到 1.5 或 2）或增加菜品，让合计落在 ${Math.round(want * 0.92)}–${Math.round(want * 1.08)} kcal。`,
          },
        ],
        { maxTokens: 1500, temperature: 0.3 }
      );
      if (retry) return send(res, 200, { ok: true, mock: false, plan: retry });
    }
    send(res, 200, { ok: true, mock: false, plan: parsed });
  } catch (e) {
    send(res, 200, { ok: false, error: String(e.message || e) });
  }
}

const DISCLAIMER = '本内容仅为膳食、运动科普参考，不能替代医生、营养师、康复师方案，患有基础疾病请遵从医嘱，本工具不提供诊疗服务。';

const SPORT_PROMPT = `你是“轻宿”的减脂运动 AI 助手，角色是专业的运动减脂教练。
服务对象是中国大学生，住在宿舍，通常没有器械，空间约 2 平方米。

你的任务：
1. 根据用户档案（身高、体重、BMI、目标体重、活动量、目标日期）和今天的可用时间，给出宿舍可执行的无器械运动方案。
2. 明确运动类型、时长、频次、强度（RPE 或“能说话但不能唱歌”之类的体感描述）和注意事项。
3. 结合用户当天状态调整：熬夜、疲惫、时间紧时主动降量，不鼓励硬撑。
4. 只做运动和生活方式科普，不做医疗判断，不替代医生或康复师；出现疼痛、眩晕、胸闷、关节肿胀等情况，先建议停止运动并咨询专业人员。
5. 不推荐极端节食、断食、来路不明的补剂或高风险动作。

固定免责声明：${DISCLAIMER}
输出纯文本，3–6 句或短列表，不要 markdown 代码块。`;

const DIET_PROMPT = `你是“轻宿”的膳食健康 AI 助手，角色是膳食营养师，服务对象是中国大学生。
你会收到用户当前病种、身体信息、今日三餐记录、热量摄入和可能的食物照片。

你的任务：
1. 结合当前病种的饮食禁忌、推荐食材和三餐记录，给出具体、可执行的膳食建议。
2. 如果用户上传食物照片，先识别可见食物并估算一人份热量；不确定时说明“仅凭照片难以精确判断”，不要编造。
3. 核查禁忌食物、推荐食材覆盖、热量是否接近参考区间；优先给出下一餐能做的调整。
4. 只做膳食营养科普，不做医疗判断，不调整药物，不替代医生、营养师或康复师方案。
5. 不推荐保健品、偏方、断食、极端节食或来源不明的产品。

固定免责声明：${DISCLAIMER}
输出纯文本，3–6 句或短列表，不要 markdown 代码块。`;

const MEDICAL_WORD_MAP = [
  ['\u6cbb\u7597', '膳食管理'],
  ['\u6cbb\u6108', '改善'],
  ['\u6297\u764c', '营养支持'],
  ['\u964d\u7cd6', '平稳血糖'],
  ['\u7597\u6548', '效果'],
  ['\u5904\u65b9', '方案'],
  ['\u8bca\u65ad', '判断'],
];

function sanitizeMedicalWords(text) {
  let out = String(text || '');
  for (const [word, replacement] of MEDICAL_WORD_MAP) out = out.split(word).join(replacement);
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sseWrite(res, payload) {
  if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function mockDietReply(body) {
  const name = String(body.conditionName || '当前状况').slice(0, 30);
  const meals = Array.isArray(body.meals) ? body.meals : [];
  const target = Number(body.target) || 0;
  const intake = meals.reduce((s, m) => s + (Number(m.kcal) || 0), 0);
  const imageLine = body.image ? '照片我收到了；仅凭照片很难准确判断油、盐和实际份量，我先结合病种和记录来说。' : '';
  const last = meals.slice(-1)[0];
  if (!meals.length) {
    return `${imageLine}你当前是「${name}」，今天还没有三餐记录。先按病种食谱记一餐，再结合热量和推荐食材看下一餐怎么调整；具体方案以医护或营养师建议为准。`;
  }
  const remain = target - intake;
  const direction = remain < 0 ? `今天已比参考值多约 ${Math.abs(remain)} kcal，下一餐优先清淡、少油和蔬菜。` : `今天距离参考值还有约 ${remain} kcal，可以按需补一份主食或优质蛋白。`;
  return `${imageLine}你当前是「${name}」，今天已记录 ${meals.length} 餐，摄入约 ${intake} kcal。${direction}${last?.text ? `最近一餐是「${last.text}」，` : ''}优先核对禁食清单和推荐食材，具体方案以医护或营养师建议为准。`;
}

function mockSportReply(body) {
  const p = body.profile || {};
  const bmi = Number(p.bmi) || 0;
  const minutes = Number(body.plan?.minutes) || 20;
  const goal = String(body.message || body.question || '');
  const caution = /疼|痛|不适|头晕|胸闷|膝盖|腰/.test(goal)
    ? '你提到不适，先暂停相关动作，必要时咨询医生或康复师，不要硬练。'
    : '训练前先热身 3–5 分钟，出现疼痛、眩晕或胸闷立即停止。';
  return `按你的档案（BMI ${bmi || '未填'}，目标 ${p.targetWeightKg || '未填'} kg），今天建议做 ${Math.min(minutes, 30)} 分钟低到中等强度循环：深蹲、跪姿俯卧撑、臀桥、死虫式各 2–3 组，组间休息 45–60 秒。每周 3–4 次，强度以 RPE 11–13（能说话但不能唱歌）为宜，熬夜或疲惫时减半。${caution} 具体方案以康复师或医生建议为准。`;
}

function buildDietContext(body) {
  const p = body.profile || {};
  const meals = Array.isArray(body.meals) ? body.meals.slice(-6) : [];
  const mealLines = meals.length
    ? meals.map((m) => `- ${m.name || m.meal || '一餐'}：${String(m.text || '').slice(0, 120)}（${Number(m.kcal) || 0} kcal，评分 ${Number(m.score) || 0}）`).join('\n')
    : '- 暂无';
  const intake = meals.reduce((s, m) => s + (Number(m.kcal) || 0), 0);
  return [
    `【当前病种】${String(body.conditionName || '未提供').slice(0, 30)}`,
    `【身体信息】${p.sex === 'male' ? '男' : '女'}，${Number(p.age) || '?'} 岁，${Number(p.heightCm) || '?'} cm，${Number(p.weightKg) || '?'} kg，活动量：${p.activity || '未提供'}`,
    `【今日三餐】\n${mealLines}`,
    `【热量】已摄入约 ${intake} kcal，参考 ${Number(body.target) || '?'} kcal`,
    `【用户问题】${String(body.message || '请结合我的情况给饮食建议').slice(0, 500)}`,
  ].join('\n');
}

function buildSportContext(body) {
  const p = body.profile || {};
  const plan = body.plan || {};
  return [
    `【身体档案】性别：${p.sex === 'male' ? '男' : '女'}；年龄：${Number(p.age) || '?'}；身高：${Number(p.heightCm) || '?'} cm；体重：${Number(p.weightKg) || '?'} kg；BMI：${Number(p.bmi) || '?'}；目标体重：${Number(p.targetWeightKg) || '?'} kg；日常活动量：${p.activity || '未提供'}；目标日期：${p.targetDate || '未提供'}`,
    `【今日安排】可用时间：${Number(plan.minutes) || '?'} 分钟；连续训练天数：${Number(plan.streak) || 0}；状态：${plan.state || '正常'}；当前训练：${plan.training || '未生成'}`,
    `【用户问题】${String(body.message || '请给我今天的宿舍运动方案').slice(0, 500)}`,
  ].join('\n');
}

async function streamDeepSeek(req, res, { system, userContent, fallback, model, history, maxTokens = 900, temperature = 0.6 }) {
  const cfg = aiConfig();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);

  let full = '';
  const write = (text) => {
    const safe = sanitizeMedicalWords(text);
    if (!safe) return;
    full += safe;
    sseWrite(res, { t: safe });
  };

  try {
    if (!cfg.key) throw new Error('missing key');
    const messages = [
      { role: 'system', content: system },
      ...(Array.isArray(history) ? history : []).slice(-8).map((m) => ({
        role: m.role === 'ai' ? 'assistant' : 'user',
        content: String(m.text || '').slice(0, 500),
      })).filter((m) => m.content),
      { role: 'user', content: userContent },
    ];
    const upstream = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: model || cfg.model,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
        ...(isDeepSeek(cfg) && !cfg.thinking ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      throw new Error(`upstream ${upstream.status}: ${detail.slice(0, 200)}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const piece = await reader.read();
      if (piece.done) break;
      buffer += decoder.decode(piece.value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) write(delta);
          if (json.choices?.[0]?.finish_reason) done = true;
        }
      }
    }
    if (!full.trim()) throw new Error('empty response');
    sseWrite(res, { done: true, mock: false });
    res.end();
  } catch (e) {
    if (res.writableEnded || res.destroyed) return;
    if (!full.trim()) {
      const text = sanitizeMedicalWords(fallback());
      for (let i = 0; i < text.length; i += 12) {
        if (res.writableEnded || res.destroyed) return;
        const chunk = text.slice(i, i + 12);
        full += chunk;
        sseWrite(res, { t: chunk });
        await sleep(18);
      }
    }
    sseWrite(res, { done: true, mock: true, error: String(e.message || e).slice(0, 160) });
    res.end();
  } finally {
    res.off('close', onClose);
  }
}

async function apiDietRecognize(req, res, body) {
  const image = String(body.image || '');
  if (!image.startsWith('data:image/')) return send(res, 400, { ok: false, error: '缺少图片数据' });
  try {
    const parsed = await callModelJson(
      [
        { role: 'system', content: '你是膳食营养师。识别图片里的食物，按一人份估算总热量。只输出 JSON：{"foods":[{"name":"食物名","kcal":数字}],"totalKcal":数字,"note":"简短说明"}。不确定的食物要说明，不要编造。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请识别这张食物照片，估算每种食物和总热量。只输出 JSON。' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      { maxTokens: 700, temperature: 0.2, model: aiConfig().visionModel }
    );
    if (parsed === null) return send(res, 200, { ok: false, error: 'AI 暂不可用' });
    const foods = (Array.isArray(parsed.foods) ? parsed.foods : [])
      .map((f) => ({ name: String(f.name || '').slice(0, 20), kcal: Math.max(0, Math.round(Number(f.kcal) || 0)) }))
      .filter((f) => f.name && f.kcal > 0)
      .slice(0, 8);
    if (!foods.length) return send(res, 200, { ok: false, error: '未识别出食物' });
    const totalKcal = Math.max(0, Math.round(Number(parsed.totalKcal) || foods.reduce((s, f) => s + f.kcal, 0)));
    send(res, 200, { ok: true, foods, totalKcal, note: String(parsed.note || '').slice(0, 120) });
  } catch (e) {
    send(res, 200, { ok: false, error: String(e.message || e) });
  }
}

async function apiChatDiet(req, res) {
  const body = await readBody(req);
  if (body.mode === 'recognize') return await apiDietRecognize(req, res, body);
  const message = String(body.message || '').trim();
  const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : '';
  if (!message && !image) return send(res, 400, { ok: false, error: '说点什么，或上传一张食物照片' });
  const context = buildDietContext(body);
  const content = image
    ? [
        { type: 'text', text: context },
        { type: 'image_url', image_url: { url: image } },
      ]
    : context;
  await streamDeepSeek(req, res, {
    system: DIET_PROMPT,
    userContent: content,
    fallback: () => mockDietReply(body),
    model: image ? aiConfig().visionModel : aiConfig().model,
    history: body.history,
    maxTokens: 1000,
    temperature: 0.5,
  });
}

async function apiChatSport(req, res) {
  const body = await readBody(req);
  const message = String(body.message || '').trim();
  if (!message) return send(res, 400, { ok: false, error: '先说一下今天想怎么练' });
  const context = buildSportContext(body);
  await streamDeepSeek(req, res, {
    system: SPORT_PROMPT,
    userContent: context,
    fallback: () => mockSportReply(body),
    model: aiConfig().model,
    history: body.history,
    maxTokens: 900,
    temperature: 0.6,
  });
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);

  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error('is dir');
    const buf = await readFile(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // 云托管默认域名前面有 CDN，必须明确禁止缓存，否则改了前端也看不到
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-App-Version': '1.9-dual-ai',
    });
    res.end(buf);
  } catch {
    send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  }
}

async function handleRequest(req, res) {
  const url = (req.url || '/').split('?')[0];
  try {
    // 登录相关
    if (url.startsWith('/api/auth/')) return await apiAuth(req, res, url);

    // 其余接口一律要登录，防止公开链接被刷额度
    if (url.startsWith('/api/') && !AUTH_FREE.has(url)) {
      const user = await auth.sessionUser(sessionIdFrom(req));
      if (!user) return send(res, 401, { ok: false, error: '请先登录' });
    }

    if (req.method === 'POST' && url === '/api/vision') return await apiVision(req, res);
    if (req.method === 'POST' && url === '/api/extract') return await apiExtract(req, res);
    if (req.method === 'POST' && url === '/api/coach') return await apiCoach(req, res);
    if (req.method === 'POST' && url === '/api/chat-diet') return await apiChatDiet(req, res);
    if (req.method === 'POST' && url === '/api/chat-sport') return await apiChatSport(req, res);
    if (req.method === 'POST' && url === '/api/plan') return await apiPlan(req, res);
    if (req.method === 'POST' && url === '/api/meals') return await apiMeals(req, res);
    if (url === '/api/ping' && req.method === 'POST') {
      let bodyLen = 0;
      try {
        const b = await readBody(req);
        bodyLen = JSON.stringify(b).length;
      } catch (e) {
        return send(res, 200, { ok: true, note: 'body 读取失败', error: String(e.message) });
      }
      return send(res, 200, { ok: true, ts: Date.now(), bodyLen, node: process.version });
    }
    if (url === '/api/version') {
      return send(res, 200, {
        ok: true,
        version: '1.3-token',
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
      });
    }
    if (url === '/api/health') {
      const cfg = aiConfig();
      return send(res, 200, {
        ok: true,
        ai: cfg.ready,
        provider: !cfg.base ? null : /deepseek\.com/i.test(cfg.base) ? 'DeepSeek' : 'OpenAI 兼容接口',
        model: cfg.model || null,
        visionModel: cfg.visionModel || null,
        vision: cfg.ready && /flash|vision/i.test(cfg.visionModel || ''),
      });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    send(res, 405, { ok: false, error: 'Method Not Allowed' });
  } catch (e) {
    console.error('[error]', e);
    send(res, 500, { ok: false, error: String(e.message || e) });
  }
}

const server = http.createServer(handleRequest);

function lanUrls(port) {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, url: `http://${a.address}:${port}` });
    }
  }
  return out;
}

await loadDotEnv();
if (!process.env.VERCEL) {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`  端口 ${PORT} 已经被占用：可能已经开着一个了，直接打开 http://localhost:${PORT} 即可。`);
      process.exit(0);
    }
    throw e;
  });
  server.listen(PORT, '0.0.0.0', () => {
    const cfg = aiConfig();
    console.log('');
    console.log('  轻宿已启动');
    console.log(`  电脑访问：http://localhost:${PORT}`);
    const lan = lanUrls(PORT);
    if (lan.length) {
      console.log('  手机访问（需连同一个 Wi-Fi）：');
      for (const it of lan) console.log(`    ${it.url}   ← ${it.name}`);
    } else {
      console.log('  没检测到局域网地址，手机请用内网穿透或热点');
    }
    console.log(
      cfg.ready
        ? `  AI 已接入：${cfg.model}（拍照识别用 ${cfg.visionModel}）`
        : '  AI 未配置，拍照/解析会提示先填 .env 里的密钥'
    );
    console.log('');
  });
}

export { handleRequest };
