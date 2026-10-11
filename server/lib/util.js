// Shared error type + input validators. Everything that reaches the database
// goes through one of these so bad input fails early with a friendly message.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const MAX_CENTS = 1_000_000; // $10,000 per single money movement

export const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐯', '🐙', '🦁', '🐧', '🐨', '🐶', '🐱', '🦖', '🚀', '⚽', '🎨', '🎮'];
export const COLORS = ['violet', 'blue', 'teal', 'green', 'amber', 'orange', 'pink', 'red'];
export const CATEGORIES = ['food', 'games', 'toys', 'books', 'fun', 'gifts', 'other'];
export const FREQUENCIES = ['weekly', 'biweekly', 'monthly'];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function text(value, { field, min = 1, max = 100, optional = false }) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw new HttpError(400, 'invalid', `${field} is required.`);
  }
  if (typeof value !== 'string') throw new HttpError(400, 'invalid', `${field} must be text.`);
  const s = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!s) {
    if (optional) return null;
    throw new HttpError(400, 'invalid', `${field} is required.`);
  }
  if (s.length < min) throw new HttpError(400, 'invalid', `${field} must be at least ${min} characters.`);
  if (s.length > max) throw new HttpError(400, 'invalid', `${field} must be ${max} characters or fewer.`);
  return s;
}

export function cents(value, { field = 'Amount', min = 1, max = MAX_CENTS, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new HttpError(400, 'invalid', `${field} is required.`);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HttpError(400, 'invalid', `${field} must be a whole number of cents.`);
  }
  if (value < min) throw new HttpError(400, 'invalid', `${field} is too small.`);
  if (value > max) {
    throw new HttpError(400, 'invalid', `${field} can't be more than ${money(max)}.`);
  }
  return value;
}

export function oneOf(value, list, { field }) {
  if (!list.includes(value)) throw new HttpError(400, 'invalid', `${field} isn't valid.`);
  return value;
}

export function password(value, { min, field = 'Password' }) {
  if (typeof value !== 'string' || value.length < min) {
    throw new HttpError(400, 'weak_password', `${field} must be at least ${min} characters.`);
  }
  if (value.length > 200) throw new HttpError(400, 'invalid', `${field} is too long.`);
  return value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function email(value) {
  const s = text(value, { field: 'Email', max: 254 }).toLowerCase();
  if (!EMAIL.test(s)) throw new HttpError(400, 'invalid', 'Enter a valid email address.');
  return s;
}

const USERNAME = /^[a-z0-9_]{3,20}$/;
export function username(value) {
  const s = text(value, { field: 'Username', max: 20 }).toLowerCase();
  if (!USERNAME.test(s)) {
    throw new HttpError(400, 'invalid', 'Usernames use 3–20 letters, numbers or underscores.');
  }
  return s;
}

export function id(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'not_found', 'Not found.');
  return n;
}

export function timezone(value) {
  if (typeof value !== 'string' || !value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

export function money(c) {
  return (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
