// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Owner-only file authority. Neither paths nor handles enter the public dataset.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomBytes} = require('node:crypto');
const {workspaceDirectory} = require('./workspace-verifier.cjs');
const {text} = require('./private-conversation.cjs');
const sources = new WeakMap();
const identity = info => `${info.dev}:${info.ino}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const check = value => { if (!value) throw Error('public_code_file_scope'); };
const owner = info => info.uid === process.getuid() && !(info.mode & 0o022);

// Walk beneath the canonical workspace through pinned directory descriptors;
// intermediate links and a switched workspace cannot redirect the final open.
function parentDirectory(source) {
  const descriptors = [];
  try {
    const root = fs.openSync(source.workspace, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    descriptors.push(root);
    check(identity(fs.fstatSync(root)) === source.workspaceIdentity && owner(fs.fstatSync(root)));
    let directory = root;
    for (const component of source.parts.slice(0, -1)) {
      directory = fs.openSync(`/proc/self/fd/${directory}/${component}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      descriptors.push(directory); check(owner(fs.fstatSync(directory)));
    }
    return {directory, descriptors, target: `/proc/self/fd/${directory}/${source.parts.at(-1)}`};
  } catch (error) { for (const fd of descriptors.reverse()) fs.closeSync(fd); throw error; }
}
function readSource(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    check(info.isFile() && owner(info) && info.nlink === 1 && info.size > 0 && info.size <= 4096 && !(info.mode & 0o7000));
    const bytes = Buffer.alloc(info.size + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    check(count === info.size && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs);
    const context = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, count));
    text(context, 4096);
    return {context, sourceSha256: sha(bytes.subarray(0, count)), identity: identity(info), mode: info.mode & 0o777};
  } finally { fs.closeSync(fd); }
}

function capturePublicCodeFile({workspace, file}) {
  check(process.platform === 'linux' && process.getuid() > 0);
  text(file, 4096);
  const captured = workspaceDirectory(workspace);
  check(workspace === captured.directory && path.isAbsolute(file) && path.normalize(file) === file);
  const relative = path.relative(workspace, file), parts = relative.split(path.sep);
  check(relative && !path.isAbsolute(relative) && parts.every(part => part && part !== '.' && part !== '..'));
  const source = {workspace, workspaceIdentity: captured.identity, parts, file, used: false};
  const opened = parentDirectory(source);
  try {
    const current = readSource(opened.target);
    Object.assign(source, current, {parentIdentity: identity(fs.fstatSync(opened.directory))});
    const token = Object.freeze({context: current.context, sourceSha256: current.sourceSha256, relativePath: relative});
    sources.set(token, source);
    return token;
  } finally { for (const fd of opened.descriptors.reverse()) fs.closeSync(fd); }
}

async function applyPublicCodeFile(sourceToken, snapshot, response, {approve, signal} = {}) {
  const source = sources.get(sourceToken);
  check(source && !source.used && typeof approve === 'function' && (signal === undefined || signal instanceof AbortSignal));
  // Only a result validated by the actual owner transport for this exact opaque
  // snapshot can become a write proposal. A copied/model-invented receipt cannot.
  const proposal = require('./cooperative-delegation.cjs').validatedCodeProposal(snapshot, response);
  check(proposal.sourceSha256 === source.sourceSha256);
  if (!proposal.complete || signal?.aborted) return {applied: false};
  text(proposal.text, 65536);
  source.used = true;
  const decision = Object.freeze({type: 'public_code_edit', file: source.file, relativePath: sourceToken.relativePath,
    sourceSha256: source.sourceSha256, replacementSha256: sha(proposal.text), replacement: proposal.text,
    coreTaskId: proposal.coreTaskId, toolCallId: proposal.toolCallId});
  if (await approve(decision) !== true || signal?.aborted) return {applied: false};
  const opened = parentDirectory(source);
  let temporary, fd;
  try {
    check(identity(fs.fstatSync(opened.directory)) === source.parentIdentity);
    const original = readSource(opened.target);
    check(original.identity === source.identity && original.sourceSha256 === source.sourceSha256);
    temporary = `/proc/self/fd/${opened.directory}/.volparossa-proposal-${randomBytes(16).toString('hex')}`;
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, proposal.text, {encoding: 'utf8'});
    fs.fchmodSync(fd, source.mode); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    // Approval and preparation may have taken time. Never overwrite a changed
    // base, follow a link, or write through an existing hard-linked inode.
    const current = readSource(opened.target);
    check(current.identity === source.identity && current.sourceSha256 === source.sourceSha256 && !signal?.aborted);
    check(fs.realpathSync(source.file) === source.file && identity(fs.statSync(path.dirname(source.file))) === source.parentIdentity);
    fs.renameSync(temporary, opened.target); temporary = undefined;
    fs.fsyncSync(opened.directory);
    return {applied: true, sourceSha256: source.sourceSha256, replacementSha256: decision.replacementSha256,
      coreTaskId: proposal.coreTaskId, toolCallId: proposal.toolCallId};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (temporary !== undefined) fs.unlinkSync(temporary);
    for (const descriptor of opened.descriptors.reverse()) fs.closeSync(descriptor);
  }
}

module.exports = {capturePublicCodeFile, applyPublicCodeFile};
