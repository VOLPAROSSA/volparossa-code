// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const path = require('node:path');

const WORKSPACE = '/workspace';
const MODEL = 'qwen3-0.6b-v1';
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const bounded = (value, size) => typeof value === 'string' && !value.includes('\0') &&
  Buffer.byteLength(value) <= size;

// The editor owns intent and one-shot approvals; the native runtime owns tools,
// and VOLPAROSSA owns inference. There is no fixture command list or fake result.
class EditorTask {
  constructor(client, approve, {onStatus = () => {}} = {}) {
    this.client = client; this.approval = approve; this.onStatus = onStatus;
    this.thread = null; this.turn = null; this.active = false; this.stopped = false;
    this.text = ''; this.commands = 0; this.terminal = null; this.finish = () => {};
    this.notify = value => this.notification(value);
    this.closed = () => { this.stopped = true; this.finish(); };
    client.on('notification', this.notify); client.on('closed', this.closed);
  }
  async approve(params) {
    const eligible = () => this.active && !this.stopped && !this.terminal && this.turn &&
      params?.threadId === this.thread && params.turnId === this.turn;
    if (!eligible() || params.kind !== 'command' || !id(params.itemId) ||
        !bounded(params.command, 8192) || !params.command.trim() ||
        !bounded(params.cwd, 4096) || path.posix.normalize(params.cwd) !== params.cwd ||
        !(params.cwd === WORKSPACE || params.cwd.startsWith(WORKSPACE + '/')) ||
        params.networkApprovalContext || params.additionalPermissions || params.proposedNetworkPolicyAmendments) return false;
    // No session approval, escalation, network authorization or persisted policy.
    const accepted = await this.approval({command: params.command,
      directory: '.' + params.cwd.slice(WORKSPACE.length)});
    return eligible() && accepted === true;
  }
  notification({method, params}) {
    if (!this.active || this.stopped || this.terminal || params?.threadId !== this.thread) return;
    if (method === 'turn/started') {
      if (!id(params.turn?.id) || this.turn && this.turn !== params.turn.id) {
        void this.stop(); return;
      }
      this.turn = params.turn.id;
    }
    if (method === 'item/agentMessage/delta' && params.turnId === this.turn) {
      if (!bounded(params.delta, 65536) || Buffer.byteLength(this.text) + Buffer.byteLength(params.delta) > 65536) {
        void this.stop(); return;
      }
      this.text += params.delta;
    }
    if (method === 'item/completed' && params.turnId === this.turn && params.item?.type === 'commandExecution') {
      this.commands++;
      this.onStatus({commands: this.commands, status: params.item.status === 'completed' ? 'completed' : 'failed'});
    }
    if (method === 'turn/completed' && this.turn && params.turn?.id === this.turn) {
      this.terminal = params.turn; this.finish();
    }
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true; this.finish();
    if (this.active && this.thread && this.turn) {
      try { await this.client.interrupt(this.thread, this.turn); } catch {}
    }
  }
  async run(prompt, {signal, timeoutMs = 2400000} = {}) {
    if (this.thread || !bounded(prompt, 65536) || !prompt.trim() ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2400000) throw Error('editor_task_scope');
    const abort = () => { void this.stop(); };
    const deadline = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      if (signal?.aborted || this.stopped) throw Error('editor_task_cancelled');
      await this.client.initialize();
      if (this.stopped) throw Error('editor_task_cancelled');
      const started = await this.client.startThread({model: MODEL, cwd: WORKSPACE});
      if (!id(started?.thread?.id) || started.model !== MODEL || started.cwd !== WORKSPACE ||
          started.thread.modelProvider !== 'volparossa' || started.thread.ephemeral !== true) throw Error('editor_thread_scope');
      this.thread = started.thread.id;
      if (this.stopped) throw Error('editor_task_cancelled');
      const done = new Promise(resolve => { this.finish = resolve; });
      this.active = true;
      const admitted = await this.client.startTurn(this.thread, prompt);
      if (!id(admitted?.turn?.id) || this.turn && this.turn !== admitted.turn.id) throw Error('editor_turn_scope');
      this.turn = admitted.turn.id;
      if (this.stopped) {
        // A cancellation before start's response still cancels the admitted turn.
        try { await this.client.interrupt(this.thread, this.turn); } catch {}
      } else await done;
      this.active = false;
      if (this.stopped) throw Error('editor_task_cancelled');
      if (this.terminal?.status !== 'completed' || this.terminal.error) throw Error('editor_turn_incomplete');
      const result = await this.client.request('thread/unsubscribe', {threadId: this.thread});
      if (result?.status !== 'unsubscribed') throw Error('editor_unsubscribe_unconfirmed');
      // Native turn completion is not proof the user's task or tests succeeded.
      return {text: this.text, commands: this.commands, nativeTurnCompleted: true, taskVerified: false};
    } finally {
      clearTimeout(deadline); signal?.removeEventListener('abort', abort);
      if (this.active) await this.stop();
      this.active = false;
      this.client.off('notification', this.notify); this.client.off('closed', this.closed);
    }
  }
}
module.exports = {EditorTask, WORKSPACE, MODEL};
