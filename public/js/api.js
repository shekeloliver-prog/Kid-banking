export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// A reply that isn't one of Nestly's own JSON errors came from the hosting platform (or an older deployment).
function describeUnexpected(status) {
  if (status === 404) return "Nestly's server isn't answering at this address (error 404). If you just deployed, make sure the latest version is live.";
  if (status >= 500) return `The server hit an error (${status}). If you just deployed, check the deployment logs and that the database settings are in place.`;
  return `Something unexpected happened (error ${status}). Please try again.`;
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', "Can't reach Nestly right now. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/register')) {
      window.dispatchEvent(new Event('nestly:signed-out'));
    }
    const { code, message, ...details } = e;
    const shown = message ?? describeUnexpected(res.status);
    throw new ApiError(res.status, code ?? 'error', res.status >= 500 && details.detail ? `${shown} (${details.detail})` : shown, details);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p, b = {}) => request('DELETE', p, b),
};
