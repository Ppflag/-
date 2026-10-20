// auth.js —— 账号与会话（零依赖）
// 密码用 PBKDF2-SHA256 加盐哈希；会话存在内存里，重启需重新登录。
// 用户表写 JSON 文件，部署到无持久盘的容器时，重启会丢账号（见 deploy.md）。

import crypto from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ITERATIONS = 120000;
const KEY_LEN = 32;
const DIGEST = 'sha256';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 天

const hashPassword = (password, saltHex) =>
  crypto.pbkdf2Sync(String(password), Buffer.from(saltHex, 'hex'), ITERATIONS, KEY_LEN, DIGEST).toString('hex');

export function createAuth({ dir = './data' } = {}) {
  const usersFile = path.join(dir, 'users.json');
  const sessions = new Map(); // sid -> { userId, exp }
  let users = [];
  let loaded = false;

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(usersFile, 'utf8');
      const parsed = JSON.parse(raw);
      users = Array.isArray(parsed.users) ? parsed.users : [];
    } catch {
      users = [];
    }
  }

  async function persist() {
    await mkdir(dir, { recursive: true });
    const tmp = usersFile + '.tmp';
    await writeFile(tmp, JSON.stringify({ users }, null, 2), 'utf8');
    await rename(tmp, usersFile); // 原子替换，避免写一半断电
  }

  const publicUser = (u) => ({ id: u.id, username: u.username, createdAt: u.createdAt });

  async function register(username, password) {
    await loadOnce();
    const name = String(username || '').trim();
    if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(name)) throw new Error('用户名 2–20 位，可以是中文、字母、数字、下划线');
    if (String(password || '').length < 6) throw new Error('密码至少 6 位');
    if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) throw new Error('这个用户名已经被用了');

    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      username: name,
      salt,
      hash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    try {
      await persist();
    } catch (e) {
      // 容器文件系统可能只读/不可写：不阻断注册，仅记录日志
      console.error('[auth] 用户写入失败（重启后会丢失）:', e.message);
    }
    return publicUser(user);
  }

  async function verify(username, password) {
    await loadOnce();
    const name = String(username || '').trim().toLowerCase();
    const user = users.find((u) => u.username.toLowerCase() === name);
    if (!user) return null;
    const hash = hashPassword(password, user.salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(user.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return publicUser(user);
  }

  function createSession(userId) {
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { userId, exp: Date.now() + SESSION_TTL });
    return sid;
  }

  function sessionUser(sid) {
    const s = sid && sessions.get(sid);
    if (!s) return null;
    if (s.exp < Date.now()) {
      sessions.delete(sid);
      return null;
    }
    const u = users.find((x) => x.id === s.userId);
    return u ? publicUser(u) : null;
  }

  function destroySession(sid) {
    if (sid) sessions.delete(sid);
  }

  return { register, verify, createSession, sessionUser, destroySession, publicUser };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(sid, { secure = false, maxAge = SESSION_TTL / 1000 } = {}) {
  const parts = [
    `sid=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}
