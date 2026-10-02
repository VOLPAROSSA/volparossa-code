// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const {readFrames, writeFrame, record} = require('./opencode-bridge.cjs');
const SOCKET = '/opt/core/cooperative.sock';
const failure = code => Error(['cooperation_failed', 'cleanup_unconfirmed'].includes(code) ? code : 'cooperation_failed');
const callId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);

async function verifySocket(socketPath) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0') ||
      Buffer.byteLength(socketPath) > 107 || await fs.realpath(socketPath) !== socketPath) throw failure();
  const stat = await fs.lstat(socketPath), parent = await fs.lstat(path.dirname(socketPath));
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 ||
      !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o7777) !== 0o700) throw failure();
}

// socketPath is a constructor seam for focused Unix transport tests; the
// production custom tool always uses the fixed, explicitly mounted proxy.
class CooperativeToolClient {
  constructor(socketPath = SOCKET, {timeoutMs = 2400000} = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2400000) throw failure();
    this.socketPath = socketPath; this.timeoutMs = timeoutMs; this.used = false;
  }
  async execute(toolCallId, {signal} = {}) {
    if (this.used || !callId(toolCallId) || signal?.aborted) throw failure();
    this.used = true;
    await verifySocket(this.socketPath);
    if (signal?.aborted) throw failure();
    return new Promise((resolve, reject) => {
      let terminal, seen = false, done = false, unbind = () => {};
      const socket = net.createConnection({path: this.socketPath});
      const finish = (error, value) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        unbind(); socket.destroy(); error ? reject(error) : resolve(value);
      };
      const abort = () => finish(failure('cleanup_unconfirmed'));
      const timer = setTimeout(abort, this.timeoutMs);
      unbind = readFrames(socket, frame => {
        if (seen || !record(frame)) { finish(failure()); return; }
        seen = true;
        if (frame.type === 'error' && Object.keys(frame).length === 2 &&
            ['cooperation_failed', 'cleanup_unconfirmed'].includes(frame.code)) {
          terminal = {error: failure(frame.code)}; return;
        }
        const value = frame.value;
        if (frame.type !== 'result' || Object.keys(frame).length !== 2 || !record(value) ||
            Object.keys(value).length !== 4 || value.tool_call_id !== toolCallId ||
            typeof value.core_task_id !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(value.core_task_id) ||
            value.visibility !== 'public_cooperative' || !record(value.result)) {
          finish(failure()); return;
        }
        // Preserve the full core result; no local rewrite, synthesis or verdict.
        terminal = {value};
      }, () => finish(failure()));
      socket.once('connect', () => {
        if (done) return;
        try { writeFrame(socket, {type: 'execute', call_id: toolCallId}); }
        catch { finish(failure()); }
      });
      socket.once('end', () => {
        if (!terminal) finish(failure('cleanup_unconfirmed'));
        else finish(terminal.error, terminal.value);
      });
      socket.once('error', () => finish(failure()));
      socket.once('close', () => { if (!done) finish(failure('cleanup_unconfirmed')); });
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
    });
  }
}
function executeEnrolledSnapshot(toolCallId, options) {
  return new CooperativeToolClient().execute(toolCallId, options);
}
module.exports = {CooperativeToolClient, executeEnrolledSnapshot, SOCKET};
