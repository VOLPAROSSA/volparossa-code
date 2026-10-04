// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// User configuration only, captured before the model or its tools can run.
function verificationSettings(value) {
  if (value === undefined) return null;
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (object && Object.keys(value).length === 0) return null;
  const keys = ['executable', 'args', 'timeoutMs', 'maxRounds'];
  const text = arg => typeof arg === 'string' && !arg.includes('\0') && Buffer.byteLength(arg) <= 4096;
  if (!object || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
      !text(value.executable) || !/^\/usr\/bin\/[^/]+$/.test(value.executable) ||
      !Array.isArray(value.args) || value.args.length > 128 || !value.args.every(text) ||
      value.args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 16384 ||
      !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60000 ||
      !Number.isSafeInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > 16) {
    throw Error('Configure the owner verification command in your user settings: executable, args, timeoutMs and maxRounds.');
  }
  return Object.freeze({...value, args: Object.freeze([...value.args])});
}
module.exports = {verificationSettings};
