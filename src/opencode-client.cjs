// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// HTTP/SSE protocol pinned to anomalyco/opencode v1.18.34 (aec0b9a6).
// This client owns no process, model, network peer or installation authority.
const http = require('node:http');
const {EventEmitter} = require('node:events');
const {TextDecoder} = require('node:util');
const path = require('node:path');
const MAX_BODY = 1024 * 1024;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const bounded = (value, size) => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= size;
const failure = code => Error(`opencode_${code}`);

class OpenCodeClient extends EventEmitter {
  constructor({baseUrl, password, username = 'opencode', workspace = '/workspace', timeoutMs = 30000,
    version = '1.18.34', cooperative = false} = {}) {
    super();
    let url;
    try { url = new URL(baseUrl); } catch { throw failure('scope'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || !bounded(password, 256) || password.length < 16 ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(username) || !bounded(workspace, 4096) || !path.posix.isAbsolute(workspace) ||
        path.posix.normalize(workspace) !== workspace || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
        version !== '1.18.34' || typeof cooperative !== 'boolean') throw failure('scope');
    this.baseUrl = url.origin; this.workspace = workspace; this.timeoutMs = timeoutMs; this.version = version;
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    this.requests = new Set(); this.ready = false; this.closed = false; this.connecting = false;
    this.eventRequest = null; this.eventResponse = null;
    this.cooperative = cooperative;
  }
  url(route) {
    if (typeof route !== 'string' || !route.startsWith('/') || route.includes('?') || route.includes('#')) throw failure('route');
    const url = new URL(route, this.baseUrl);
    if (url.origin !== this.baseUrl || url.pathname !== route) throw failure('route');
    url.searchParams.set('directory', this.workspace);
    return url;
  }
  request(method, route, body, {timeoutMs = this.timeoutMs, signal} = {}) {
    if (this.closed || this.requests.size >= 16 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2400000) {
      return Promise.reject(failure('unavailable'));
    }
    let bytes;
    try { bytes = body === undefined ? null : Buffer.from(JSON.stringify(body)); }
    catch { return Promise.reject(failure('request')); }
    if (bytes?.length > MAX_BODY) return Promise.reject(failure('bound'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); this.requests.delete(req);
        signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result);
      };
      const req = http.request(this.url(route), {method, agent: false, headers: {
        Authorization: this.authorization, Accept: 'application/json', 'Cache-Control': 'no-store',
        ...(bytes ? {'Content-Type': 'application/json', 'Content-Length': bytes.length} : {}),
      }}, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BODY) { finish(failure('bound')); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('error', () => finish(failure('transport')));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) { finish(failure('rejected')); return; }
          if (res.statusCode === 204 && size === 0) { finish(null, null); return; }
          if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) {
            finish(failure('response')); return;
          }
          try { finish(null, JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)))); }
          catch { finish(failure('response')); }
        });
      });
      const timer = setTimeout(() => { finish(failure('timeout')); req.destroy(); }, timeoutMs);
      const abort = () => { finish(failure('cancelled')); req.destroy(); };
      this.requests.add(req); req.on('error', () => finish(failure('transport')));
      req.on('close', () => { if (!settled) finish(failure('transport')); });
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) { abort(); return; }
      req.end(bytes);
    });
  }
  async connect() {
    if (this.closed || this.ready || this.connecting) throw failure('connection');
    this.connecting = true;
    try {
      const health = await this.request('GET', '/global/health');
      if (health?.healthy !== true || health.version !== this.version) throw failure('version');
      await new Promise((resolve, reject) => {
        let connected = false, buffer = Buffer.alloc(0), data = [], eventBytes = 0;
        const timer = setTimeout(() => fail(failure('event_timeout')), this.timeoutMs);
        const fail = error => { clearTimeout(timer); if (!connected) reject(error); this.close(); };
        const dispatch = () => {
          if (!data.length) { eventBytes = 0; return; }
          let event;
          try { event = JSON.parse(data.join('\n')); } catch { throw failure('event_schema'); }
          data = []; eventBytes = 0;
          if (!event || typeof event !== 'object' || Array.isArray(event) || !bounded(event.type, 128) ||
              !event.properties || typeof event.properties !== 'object' || Array.isArray(event.properties)) throw failure('event_schema');
          if (!connected) {
            if (event.type !== 'server.connected') throw failure('event_connection');
            connected = true; this.ready = true; clearTimeout(timer); resolve();
          } else if (event.type === 'server.instance.disposed') fail(failure('event_disposed'));
          else this.emit('event', event);
        };
        const req = http.get(this.url('/event'), {agent: false, headers: {
          Authorization: this.authorization, Accept: 'text/event-stream', 'Cache-Control': 'no-store',
        }}, res => {
          this.eventResponse = res;
          if (res.statusCode !== 200 || !/^text\/event-stream(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) {
            fail(failure('event_response')); return;
          }
          res.on('data', chunk => {
            try {
              let start = 0;
              for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
                const partial = chunk.subarray(start, end); start = end + 1;
                if (buffer.length + partial.length > MAX_BODY) throw failure('event_bound');
                let line = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat([buffer, partial]));
                buffer = Buffer.alloc(0); if (line.endsWith('\r')) line = line.slice(0, -1);
                if (!line) dispatch();
                else if (line.startsWith('data:')) {
                  const item = line.slice(5).replace(/^ /, ''); eventBytes += Buffer.byteLength(item) + 1;
                  if (eventBytes > MAX_BODY) throw failure('event_bound'); data.push(item);
                } else if (!line.startsWith(':') && !/^(event|id|retry):/.test(line)) throw failure('event_schema');
              }
              const tail = chunk.subarray(start);
              if (buffer.length + tail.length > MAX_BODY) throw failure('event_bound');
              buffer = Buffer.concat([buffer, tail]);
            } catch { fail(failure('event_invalid')); }
          });
          res.on('end', () => fail(failure('event_closed'))); res.on('error', () => fail(failure('event_transport')));
        });
        this.eventRequest = req; req.on('error', () => fail(failure('event_transport')));
        req.on('close', () => { if (!connected) fail(failure('event_closed')); });
      });
      return health;
    } catch (error) { this.close(); throw error; }
    finally { this.connecting = false; }
  }
  scoped(id) { if (!this.ready || !validId(id) || !id.startsWith('ses')) throw failure('session'); return `/session/${id}`; }
  createSession({model, agent = 'build'} = {}) {
    if (!this.ready || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(model ?? '') || agent !== 'build') throw failure('model');
    return this.request('POST', '/session', {title: 'VOLPAROSSA coding task', agent,
      model: {id: model, providerID: 'volparossa'}, permission: [
        {permission: '*', pattern: '*', action: 'deny'},
        ...['read', 'glob', 'grep', 'list', 'task'].map(permission => ({permission, pattern: '*', action: 'allow'})),
        ...['bash', 'edit'].map(permission => ({permission, pattern: '*', action: 'ask'})),
        ...(this.cooperative ? [{permission: 'volparossa_delegate_public', pattern: '*', action: 'allow'}] : []),
      ]});
  }
  prompt(id, text, {model, agent = 'build', timeoutMs = 2400000, signal} = {}) {
    if (!bounded(text, 65536) || !text.trim() || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(model ?? '') || agent !== 'build') throw failure('prompt');
    return this.request('POST', `${this.scoped(id)}/message`, {
      model: {providerID: 'volparossa', modelID: model}, agent, parts: [{type: 'text', text}],
    }, {timeoutMs, signal});
  }
  getSession(id) { return this.request('GET', this.scoped(id)); }
  children(id) { return this.request('GET', `${this.scoped(id)}/children`); }
  abort(id) { return this.request('POST', `${this.scoped(id)}/abort`); }
  deleteSession(id) { return this.request('DELETE', this.scoped(id)); }
  replyPermission(id, accepted) {
    if (!this.ready || !validId(id) || !id.startsWith('per') || typeof accepted !== 'boolean') throw failure('permission');
    return this.request('POST', `/permission/${id}/reply`, {reply: accepted ? 'once' : 'reject'});
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.authorization = '';
    this.eventRequest?.destroy(); this.eventResponse?.destroy();
    for (const req of this.requests) req.destroy();
    this.emit('closed');
  }
}
module.exports = {OpenCodeClient, MAX_BODY, validId, bounded};
