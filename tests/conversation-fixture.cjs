// SPDX-License-Identifier: GPL-3.0-only
// Synthetic local protocol fixtures. No model or native Codex process is run here.
'use strict';
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PrivateConversation, expectedLimits, requestLimit } = require('../src/private-conversation.cjs');

function caps(model = 'smollm2-360m-v1') {
  return { ...expectedLimits(model), execution_slots: 1, max_seconds: 600,
    max_request_bytes: requestLimit(model), max_response_bytes: 65536, quarantined: false };
}
function input(tools = []) {
  return { version: 1, visibility: 'private_local', instructions: 'Reply with a truthful bounded proposal.',
    history: [{ type: 'message', role: 'user', text: 'Synthetic test input.' }], tools };
}
function result(output = { type: 'assistant', text: 'Synthetic response; no inference claim.' }, model = 'smollm2-360m-v1') {
  return { version: 1, operation: 'compute_private_conversation', model_profile: model, execution_complete: true,
    turn_complete: output.type !== 'incomplete', output, prompt_tokens: 10, generated_tokens: 20,
    limits: expectedLimits(model), local_only: true, private_data_supported: true, tool_execution: false,
    distributed_execution_claimed: false, private_training_claimed: false, model_answer_correctness_proven: false,
    cleanup: { complete: true, retained_input: false, retained_report: false } };
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function reply(socket, request, event, extra = {}) {
  socket.write(frame({ version: 1, id: request.id, event, ...extra }));
}
async function fixture(t, handler, capabilities = caps()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-conversation-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'core.sock');
  const requests = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= 4 + data.readUInt32BE()) {
        const length = data.readUInt32BE();
        const request = JSON.parse(data.subarray(4, 4 + length));
        data = data.subarray(4 + length);
        requests.push(request);
        if (request.operation.type === 'conversation_capabilities') {
          reply(socket, request, 'conversation_capabilities', { capabilities });
        } else handler(socket, request);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  const client = new PrivateConversation(socketPath);
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true });
  });
  return { client, directory, socketPath, requests };
}
module.exports = { caps, input, result, frame, reply, fixture };
