import WebSocket from 'ws';

export class Client {
  msgs: any[] = []; closed: number | null = null; ws!: WebSocket;
  static async open(url: string, headers: Record<string, string> = {}): Promise<Client | { status: number }> {
    const c = new Client();
    return new Promise((resolve) => {
      c.ws = new WebSocket(url, { headers });
      c.ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
      c.ws.on('close', (code) => { c.closed = code; });
      c.ws.on('open', () => resolve(c));
      c.ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
      c.ws.on('error', () => {});
    });
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  of(t: string) { return this.msgs.filter((m) => m.t === t); }
  last(t: string) { return this.of(t).at(-1); }
  async until(fn: () => boolean, ms = 3000) {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout; got: ' + JSON.stringify(this.msgs.map((m) => m.t + (m.kind ? ':' + m.text : '')))); await new Promise((r) => setTimeout(r, 10)); }
  }
  close() { this.ws.close(); }
}
