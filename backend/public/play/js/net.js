// Talking to the backend (REST for accounts) and the game server (WebSocket for everything live).

async function call(method, path, body, token) {
  const res = await fetch(path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.message || json.error || `Error ${res.status}`); e.code = json.error; e.status = res.status; throw e; }
  return json;
}

export const api = {
  world: () => call('GET', '/v1/world'),
  register: (email, password, birthDate) => call('POST', '/v1/auth/register', { email, password, birthDate }),
  me: (t) => call('GET', '/v1/me', null, t),
  setBirthDate: (t, birthDate) => call('POST', '/v1/me/birthdate', { birthDate }, t),
  login: (email, password) => call('POST', '/v1/auth/login', { email, password }),
  characters: (t) => call('GET', '/v1/characters', null, t),
  createCharacter: (t, displayName, appearance) => call('POST', '/v1/characters', { displayName, appearance }, t),
  ticket: (t, id) => call('POST', `/v1/characters/${id}/join-ticket`, {}, t),
};

export function friendlyError(e) {
  const map = {
    email_taken: 'That email can\'t be used. Try signing in instead.', invalid_credentials: 'Wrong email or password.',
    display_name_taken: 'That name is taken. Try another.', display_name_reserved: 'That name isn\'t allowed.', account_banned: 'This account has been banned.', too_young: 'You must be 13 or older to play.', invalid_birth_date: 'Please check the date of birth.', birth_date_already_set: 'Your date of birth is already set.',
    account_suspended: 'This account is suspended right now.', validation_error: 'Please check what you typed (password needs 10+ characters).',
  };
  return map[e.code] ?? e.message ?? 'Something went wrong.';
}

/** Game connection with automatic ticket refresh + reconnect. */
export class Connection {
  constructor({ getTicket, onMessage, onStatus }) { Object.assign(this, { getTicket, onMessage, onStatus }); this.tries = 0; this.closed = false; }
  async open() {
    this.onStatus(this.tries ? 'reconnecting' : 'connecting');
    let ticket;
    try { ticket = await this.getTicket(); } catch (e) { return this.retry(e); }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = this.ws = new WebSocket(`${proto}://${location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
    ws.onopen = () => { this.tries = 0; this.onStatus('online'); };
    ws.onmessage = (ev) => { try { this.onMessage(JSON.parse(ev.data)); } catch { /* ignore garbage */ } };
    ws.onclose = (ev) => {
      if (this.closed) return;
      if (ev.code === 4000) { this.onStatus('replaced'); return; }
      if (ev.code === 4008 || ev.code === 4009) { this.onStatus('kicked'); return; }
      this.retry();
    };
    ws.onerror = () => {};
  }
  retry() {
    this.tries++;
    if (this.tries > 8) { this.onStatus('failed'); return; }
    this.onStatus('reconnecting');
    setTimeout(() => !this.closed && this.open(), Math.min(1000 * 2 ** (this.tries - 1), 8000));
  }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  close() { this.closed = true; this.ws?.close(); }
}
