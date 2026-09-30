export class PocketBase {
  constructor(env = process.env, fetcher = fetch) {
    this.host = (env.POCKETBASE_HOST || '').replace(/\/$/, '');
    this.username = env.POCKETBASE_USERNAME;
    this.password = env.POCKETBASE_PASSWORD;
    this.collection = env.POCKETBASE_COLLECTION || 'sneakyspeedtest';
    this.fetcher = fetcher;
    this.token = null;
    this.authPromise = null;
    this.tokenUntil = 0;
  }

  get configured() { return Boolean(this.host && this.username && this.password); }

  async authenticate() {
    if (!this.configured) throw new Error('PocketBase environment variables are missing.');
    if (this.token && Date.now() < this.tokenUntil) return;
    if (!this.authPromise) {
      this.authPromise = (async () => {
        const response = await this.fetcher(`${this.host}/api/collections/_superusers/auth-with-password`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: this.username, password: this.password }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`PocketBase authentication failed (${response.status}).`);
        const body = await response.json();
        if (!body.token) throw new Error('PocketBase did not return an authentication token.');
        this.token = body.token;
        this.tokenUntil = Date.now() + 6 * 60 * 60 * 1000;
      })().finally(() => { this.authPromise = null; });
    }
    await this.authPromise;
  }

  async request(path, options = {}, retry = true) {
    await this.authenticate();
    const response = await this.fetcher(`${this.host}/api${path}`, {
      ...options, headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: this.token },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 && retry) {
      this.token = null;
      return this.request(path, options, false);
    }
    if (!response.ok) throw new Error(`PocketBase request failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }

  async findSubmission(id) {
    const filter = encodeURIComponent(`submission_id = "${id}"`);
    const data = await this.request(`/collections/${encodeURIComponent(this.collection)}/records?filter=${filter}&perPage=1`);
    return data.items[0] || null;
  }

  async save(record) {
    const previous = await this.findSubmission(record.submission_id);
    if (previous) return previous;
    try {
      return await this.request(`/collections/${encodeURIComponent(this.collection)}/records`, { method: 'POST', body: JSON.stringify(record) });
    } catch (error) {
      // A unique index makes concurrent retries safe, including after a lost response.
      const duplicate = await this.findSubmission(record.submission_id);
      if (duplicate) return duplicate;
      throw error;
    }
  }
}
