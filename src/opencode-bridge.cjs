// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {TextDecoder} = require('node:util');
const LIMIT = 524288;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function writeFrame(stream, value) {
  const encoded = Buffer.from(JSON.stringify(value) + '\n');
  if (encoded.length > LIMIT || stream.destroyed || stream.writableEnded ||
      !Number.isSafeInteger(stream.writableLength) || stream.writableLength + encoded.length > LIMIT) {
    throw Error('opencode_bridge_closed');
  }
  stream.write(encoded);
}
function readFrames(stream, receive, fail) {
  let pending = Buffer.alloc(0), failed = false;
  const bad = () => { if (!failed) { failed = true; fail(); } };
  const data = chunk => {
    if (failed) return;
    try {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        if (pending.length + end - start >= LIMIT) throw Error('bound');
        const raw = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat([pending, chunk.subarray(start, end)]));
        start = end + 1; pending = Buffer.alloc(0);
        const value = JSON.parse(raw);
        if (!record(value) || typeof value.type !== 'string') throw Error('frame');
        receive(value);
        if (failed) return;
      }
      pending = Buffer.concat([pending, chunk.subarray(start)]);
      if (pending.length >= LIMIT) throw Error('bound');
    } catch { bad(); }
  };
  const end = () => { if (pending.length) bad(); };
  stream.on('data', data); stream.on('error', bad); stream.on('end', end);
  return () => { stream.off('data', data); stream.off('error', bad); stream.off('end', end); pending = Buffer.alloc(0); };
}
module.exports = {readFrames, writeFrame, record};
