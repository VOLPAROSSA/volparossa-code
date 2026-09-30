// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Independent NDJSON client for the pinned open Codex app-server protocol.
// This module accepts already-owned process streams. It never discovers/starts
// a runtime, reads Codex credentials or selects an OpenAI backend.
const {EventEmitter} = require('node:events');
const {TextDecoder} = require('node:util');
const MAX_LINE = 1024 * 1024;

class AppServer extends EventEmitter {
  #read; #write; #buffer = Buffer.alloc(0); #next = 0; #pending = new Map();
  #closed = false; #ready = false; #initializing = false; #timeout;
  constructor(readable, writable, {timeoutMs = 15000} = {}) {
    super();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('rpc_timeout');
    this.#read = readable; this.#write = writable; this.#timeout = timeoutMs;
    readable.on('data', chunk => this.#data(chunk));
    readable.on('end', () => this.close());
    readable.on('close', () => this.close());
    readable.on('error', () => this.close());
    writable.on('error', () => this.close());
    writable.on('close', () => this.close());
    if (readable.destroyed || writable.destroyed) this.close();
  }
  #send(value) {
    if (this.#closed) throw Error('rpc_closed');
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line) > MAX_LINE || this.#write.writableLength > MAX_LINE) throw Error('rpc_bound');
    this.#write.write(line + '\n');
  }
  request(method, params) {
    if (this.#closed || this.#pending.size >= 16) return Promise.reject(Error('rpc_unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => { this.close(); }, this.#timeout);
      this.#pending.set(id, {resolve, reject, timer});
      try { this.#send({id, method, params}); }
      catch { this.close(); }
    });
  }
  #data(chunk) {
    if (this.#closed) return;
    try {
      // Process complete lines without accepting an unbounded trailing frame.
      if (!Buffer.isBuffer(chunk)) throw Error('rpc_encoding');
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, end);
        if (this.#buffer.length + part.length > MAX_LINE) throw Error('rpc_bound');
        const line = Buffer.concat([this.#buffer, part]);
        this.#buffer = Buffer.alloc(0); start = end + 1;
        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(line));
        this.#message(value);
        if (this.#closed) return;
      }
      const tail = chunk.subarray(start);
      if (this.#buffer.length + tail.length > MAX_LINE) throw Error('rpc_bound');
      this.#buffer = Buffer.concat([this.#buffer, tail]);
    } catch { this.close(); }
  }
  #message(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('rpc_schema');
    if (typeof value.method === 'string') {
      if (Object.hasOwn(value, 'id')) {
        if (!(typeof value.id === 'string' && value.id.length <= 256) && !Number.isSafeInteger(value.id)) throw Error('rpc_id');
        // No automatic approval, tools, authentication or peer dispatch. A later
        // interactive approval adapter must explicitly replace this fail-closed behavior.
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(value.method)) {
          this.#send({id: value.id, result: {decision: 'decline'}});
        } else this.#send({id: value.id, error: {code: -32601, message: 'Client method not enabled'}});
      } else this.emit('notification', {method: value.method, params: value.params});
      return;
    }
    const pending = this.#pending.get(value.id);
    if (!pending || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) throw Error('rpc_correlation');
    clearTimeout(pending.timer); this.#pending.delete(value.id);
    if (Object.hasOwn(value, 'error')) pending.reject(Error('app_server_rejected'));
    else pending.resolve(value.result);
  }
  async initialize() {
    if (this.#ready || this.#initializing) throw Error('already_initialized');
    this.#initializing = true;
    const result = await this.request('initialize', {clientInfo: {
      name: 'volparossa_code', title: 'VOLPAROSSA Code', version: '0.1.0-dev.1'},
      capabilities: {experimentalApi: false}});
    this.#send({method: 'initialized', params: {}}); this.#ready = true;
    return result;
  }
  async startThread({model, cwd}) {
    if (!this.#ready || typeof model !== 'string' || !/^volparossa-[a-z0-9_-]{1,64}$/.test(model) ||
        typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) throw Error('thread_scope');
    return this.request('thread/start', {model, modelProvider: 'volparossa', cwd,
      sandbox: 'read-only', approvalPolicy: 'untrusted', ephemeral: true});
  }
  async startTurn(threadId, text) {
    if (!this.#ready || typeof threadId !== 'string' || !threadId || threadId.length > 256 ||
        typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536) throw Error('turn_scope');
    return this.request('turn/start', {threadId, input: [{type: 'text', text}]});
  }
  interrupt(threadId, turnId) {
    if (!this.#ready || ![threadId, turnId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
      return Promise.reject(Error('turn_scope'));
    }
    return this.request('turn/interrupt', {threadId, turnId});
  }
  close() {
    if (this.#closed) return;
    this.#closed = true; this.#buffer = Buffer.alloc(0);
    for (const {reject, timer} of this.#pending.values()) { clearTimeout(timer); reject(Error('rpc_closed')); }
    this.#pending.clear(); this.#read.destroy(); this.#write.destroy(); this.emit('closed');
  }
}
module.exports = {AppServer, MAX_LINE};
