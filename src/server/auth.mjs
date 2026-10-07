import crypto from 'node:crypto';
import { HttpError } from './store.mjs';

const COOKIE = 'medora_senior';
const YEAR = 365 * 24 * 60 * 60;

const passcode = () => (process.env.SENIOR_PASSCODE || '').trim();
export const loginRequired = () => !!passcode();

function secret() {
  return process.env.SESSION_SECRET ||
    crypto.createHash('sha256').update(`medora:${passcode()}`).digest('hex');
}

const sign = (value) =>
  crypto.createHmac('sha256', secret()).update(value).digest('base64url');

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) out[name] = decodeURIComponent(rest.join('='));
  }
  return out;
}

export function isSenior(req) {
  if (!loginRequired()) return true;
  const value = cookies(req)[COOKIE];
  return !!value && same(value, sign('senior-v1'));
}

export function requireSenior(req) {
  if (!isSenior(req)) {
    throw new HttpError(401, 'senior_login', 'Please sign in on this device first.');
  }
}

export function checkPasscode(given) {
  return loginRequired() && same((given || '').trim(), passcode());
}

export function sessionCookie(req) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${sign('senior-v1')}; Path=/; Max-Age=${YEAR}; HttpOnly; SameSite=Lax${secure}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

export const newToken = () => crypto.randomBytes(18).toString('base64url');
