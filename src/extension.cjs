// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {PrivateCompute} = require('./private-compute.cjs');
const {AppServer} = require('./app-server.cjs');
const {EditorTask, WORKSPACE, MODEL} = require('./editor-task.cjs');

const byteLength = text => Buffer.byteLength(text, 'utf8');
function selectionInput(editor) {
  if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') {
    throw Error('Select a small code excerpt in a local file first.');
  }
  const text = editor.document.getText(editor.selection);
  if (!text.trim() || text.includes('\0') || byteLength(text) > 4096) {
    throw Error('The current private compute service accepts at most 4096 UTF-8 bytes of selected code. Nothing was submitted.');
  }
  return text;
}

function register(vscode, context, Client = PrivateCompute, native = {}) {
  const active = new Set();
  let nativeActive;
  let disposed = false;
  let busy = false;
  const trusted = () => {
    if (disposed || !vscode.workspace.isTrusted || vscode.env.remoteName) {
      throw Error('This development integration requires a trusted local workspace.');
    }
  };
  const connect = async () => {
    trusted();
    // Machine-scoped configuration: a repository cannot replace the destination.
    const config = vscode.workspace.getConfiguration('volparossaCode').inspect('privateSocket');
    const socket = config?.globalValue ?? config?.defaultValue;
    if (typeof socket !== 'string' || !socket.startsWith('/')) {
      throw Error('Set the absolute volparossaCode.privateSocket in your user settings first.');
    }
    const client = new Client(socket);
    active.add(client);
    try { return {client, capabilities: await client.connect()}; }
    catch (error) { client.close(); active.delete(client); throw error; }
  };
  const close = client => { client.close(); active.delete(client); };
  const show = async content => {
    // Plaintext, untitled document: no HTML, executable Markdown, automatic file write or log.
    const document = await vscode.workspace.openTextDocument({language: 'plaintext', content});
    await vscode.window.showTextDocument(document, {preview: true});
  };
  const run = action => async () => {
    if (busy) return vscode.window.showInformationMessage('A VOLPAROSSA operation is already running.');
    busy = true;
    try { trusted(); await action(); }
    catch (error) {
      // Transport/server errors are not echoed: they may include submitted input or paths.
      const local = error?.message;
      const safe = ['Select a small code excerpt', 'The current private compute',
        'This development integration', 'Set the absolute', 'Configure the native runtime',
        'Open a local workspace'].some(prefix => local?.startsWith(prefix));
      await vscode.window.showErrorMessage(safe ? local : 'VOLPAROSSA could not complete this operation. No cloud or public-peer fallback was attempted.');
    } finally { busy = false; }
  };
  context.subscriptions.push(vscode.commands.registerCommand('volparossaCode.capabilities', run(async () => {
    const {client, capabilities} = await connect();
    try {
      await show(`VOLPAROSSA private compute\n\nScope: private, local only\nProfile: ${capabilities.model_profile}\n` +
        `Selected-code limit: ${capabilities.max_context_bytes} UTF-8 bytes\n` +
        'Public peer delegation: not enabled\nNative coding is a separate explicit command requiring a prepared runtime and conversation service.\n' +
        'Capability negotiation does not prove model quality or execution.\n');
    } finally { close(client); }
  })));
  context.subscriptions.push(vscode.commands.registerCommand('volparossaCode.reviewSelection', run(async () => {
    const code = selectionInput(vscode.window.activeTextEditor);
    const question = await vscode.window.showInputBox({title: 'Ask VOLPAROSSA about selected code',
      prompt: 'Only this question and your selected excerpt go to your local core. No filenames, repository scan or public sharing.',
      ignoreFocusOut: true, validateInput: text => !text.trim() || text.includes('\0') || byteLength(text) > 512
        ? 'Enter a question of 1–512 UTF-8 bytes.' : undefined});
    if (question === undefined) return;
    if (!question.trim() || question.includes('\0') || byteLength(question) > 512) return;
    const confirmed = await vscode.window.showInformationMessage(
      `Send ${byteLength(code)} bytes of selected code and your question to the local private service?`,
      {modal: true}, 'Send locally');
    if (confirmed !== 'Send locally') return;
    const {client} = await connect();
    try {
      const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: 'VOLPAROSSA private local compute', cancellable: true}, async (_progress, cancellation) => {
        const controller = new AbortController();
        const listener = cancellation.onCancellationRequested(() => controller.abort());
        if (cancellation.isCancellationRequested) controller.abort();
        try { return await client.ask({question, context: code, signal: controller.signal}); }
        finally { listener.dispose(); }
      });
      await show('VOLPAROSSA — generated, unverified code advice\n' +
        `Answer complete: ${result.answer_complete === true ? 'yes' : 'no (partial/truncated)'}\n` +
        'Local private inference; no Codex tool execution or distributed coding claim.\n\n' + result.output.text);
    } finally { close(client); }
  })));
  context.subscriptions.push(vscode.commands.registerCommand('volparossaCode.codingTask', run(async () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    if (!folders.length) throw Error('Open a local workspace folder before starting a coding task.');
    const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
      folders.map(item => ({label: item.name, description: item.uri.fsPath, folder: item})),
      {title: 'Choose the only workspace folder this coding task may access'}))?.folder;
    if (!folder) return;
    const config = vscode.workspace.getConfiguration('volparossaCode');
    const runtimeConfig = config.inspect('nativeRuntime')?.globalValue;
    const socket = config.inspect('privateSocket')?.globalValue;
    if (!runtimeConfig || typeof runtimeConfig !== 'object' || Array.isArray(runtimeConfig) || typeof socket !== 'string') {
      throw Error('Configure the native runtime and private socket in your user settings first.');
    }
    const prompt = await vscode.window.showInputBox({title: 'VOLPAROSSA native coding task',
      prompt: 'Describe the task. The native agent may read and modify the selected workspace using local VOLPAROSSA inference.',
      ignoreFocusOut: true, validateInput: text => !text.trim() || text.includes('\0') || byteLength(text) > 65536
        ? 'Enter a task of 1–65536 UTF-8 bytes.' : undefined});
    if (!prompt?.trim() || prompt.includes('\0') || byteLength(prompt) > 65536) return;
    const confirmed = await vscode.window.showInformationMessage(
      `Allow a native coding task in ${folder.uri.fsPath}?\n\n` +
      'The selected folder is writable. Its contents and tool results may be processed by your local VOLPAROSSA core. ' +
      'No public peers or Internet access are enabled. Requested command approvals are one-shot; changes are not automatically rolled back.',
      {modal: true}, 'Start local coding');
    if (confirmed !== 'Start local coding') return;
    trusted();
    const Runtime = native.Runtime ?? require('./editor-runtime.cjs').NativeRuntime;
    const Server = native.Server ?? AppServer, Task = native.Task ?? EditorTask;
    let runtime, server, task, result;
    try {
      runtime = await Runtime.start({...runtimeConfig, socketPath: socket}, {workspace: folder.uri.fsPath});
      trusted();
      server = new Server(runtime.readable, runtime.writable, {timeoutMs: 30000,
        allowedModels: [MODEL], writableRoot: WORKSPACE,
        commandApproval: params => task ? task.approve(params) : false});
      result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: 'VOLPAROSSA native coding — local, workspace-scoped', cancellable: true}, async (progress, cancellation) => {
        trusted();
        const controller = new AbortController();
        task = new Task(server, async proposal => {
          trusted();
          const decision = await vscode.window.showWarningMessage(
            `Run this command once in ${proposal.directory}?\n\n${proposal.command}\n\n` +
            'This permits only this request, not future commands or wider access.', {modal: true}, 'Run once');
          trusted();
          return decision === 'Run once';
        }, {onStatus: event => progress.report({message: `${event.commands} native command(s) observed; last ${event.status}.`})});
        nativeActive = {runtime, server, task};
        const listener = cancellation.onCancellationRequested(() => controller.abort());
        if (cancellation.isCancellationRequested) controller.abort();
        try { return await task.run(prompt, {signal: controller.signal}); }
        finally { listener.dispose(); }
      });
    } finally {
      server?.close();
      try { if (runtime) await runtime.close(); }
      finally { nativeActive = undefined; }
    }
    await show('VOLPAROSSA — native coding turn finished\n' +
      'Task correctness and tests are not independently verified by this frontend. Review your changes and tool results.\n' +
      `Native commands observed: ${result.commands}\nLocal private inference; no public-peer execution.\n\n${result.text}`);
  })));
  context.subscriptions.push({dispose() {
    disposed = true;
    for (const client of active) client.close(); active.clear();
    if (nativeActive) {
      void nativeActive.task.stop(); nativeActive.server.close();
      void nativeActive.runtime.close().catch(() => {});
    }
  }});
}

exports.activate = context => register(require('vscode'), context);
exports.register = register;
exports.selectionInput = selectionInput;
