// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Outside the tool namespace. Only this owner can reach the public core socket.
// The namespace receives one pre-enrolled task capability, never arbitrary export.
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {readFrames, writeFrame} = require('./opencode-bridge.cjs');
const {validId} = require('./opencode-client.cjs');

async function startCooperativeTool({socketPath, snapshot}, hooks = {}) {
  const Delegate = hooks.Delegate ?? require('./cooperative-delegation.cjs').CooperativeDelegation;
  const delegate = new Delegate(socketPath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-code-coop-'));
  await fs.chmod(directory, 0o700);
  const endpoint = path.join(directory, 'task.sock');
  const sockets = new Set(), controller = new AbortController();
  let used = false, active, cleanupError, closing, closed = false, terminal = false;
  const observations = {submitted: 0, completed: 0, cleanup_confirmed: false};
  const cancel = () => { if (!terminal) controller.abort(); };
  const server = net.createServer(socket => {
    if (closed || sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    let requested = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    const send = value => {
      try { writeFrame(socket, value); socket.end(); } catch { socket.destroy(); }
    };
    const unbind = readFrames(socket, request => {
      clearTimeout(timer);
      if (requested || used || closed || request.type !== 'execute' ||
          Object.keys(request).length !== 2 || !validId(request.call_id)) {
        socket.destroy(); return;
      }
      requested = true; used = true;
      active = (async () => {
        try {
          if (controller.signal.aborted) throw Error('cancelled');
          await delegate.connect();
          if (controller.signal.aborted) throw Error('cancelled');
          observations.submitted++;
          const value = await delegate.execute({tool_call_id: request.call_id, snapshot, signal: controller.signal});
          // Delegate validates the original result and awaits terminal execution cleanup.
          observations.completed++; terminal = true;
          send({type: 'result', value});
        } catch (error) {
          if (error?.code === 'cleanup_unconfirmed' || /cleanup_unconfirmed/.test(error?.message ?? '')) {
            cleanupError = Error('cooperation_cleanup_unconfirmed');
          }
          terminal = true;
          send({type: 'error', code: cleanupError ? 'cleanup_unconfirmed' : 'cooperation_failed'});
        }
      })();
    }, () => socket.destroy());
    socket.once('end', () => { if (requested) cancel(); });
    socket.once('close', () => {
      clearTimeout(timer); unbind(); sockets.delete(socket); if (requested) cancel();
    });
    socket.on('error', () => {});
  });
  const close = () => {
    closing ??= (async () => {
      closed = true; cancel();
      for (const socket of sockets) socket.destroy();
      try {
        if (active) await active;
        await delegate.close();
        observations.cleanup_confirmed = !cleanupError;
      } catch { cleanupError = Error('cooperation_cleanup_unconfirmed'); }
      finally {
        await new Promise(resolve => server.close(resolve));
        // Exact owned mkdtemp, never a selected project or service state directory.
        await fs.rm(directory, {recursive: true, force: false});
      }
      if (cleanupError) throw cleanupError;
    })();
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(endpoint, resolve);
    });
    await fs.chmod(endpoint, 0o600);
    return {socketPath: endpoint, observations, close};
  } catch (error) { await close().catch(() => {}); throw error; }
}

module.exports = {startCooperativeTool};
