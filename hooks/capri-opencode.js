// Capri <-> OpenCode bridge.
//
// Capri's tray app listens on 127.0.0.1:47823 and expects POSTs on /event with a
// hook event (that is the wire format her "brain" already speaks). This plugin
// watches OpenCode and translates it into that same vocabulary, so nothing in her
// animation/line code had to change.
//
// Capri's tray menu copies this file to ~/.config/opencode/plugins/capri.js,
// where OpenCode loads it automatically (no config edit needed).
//
// Troubleshooting: create the file %TEMP%\capri-debug (and restart/reload OpenCode)
// to log events to %TEMP%\capri-opencode-events.log; delete it to go quiet again.

const PORT = Number(process.env.CAPRI_PORT) || 47823;
const ENDPOINT = `http://127.0.0.1:${PORT}/event`;

import fs from 'node:fs';

// Silent unless you ask for it: export CAPRI_DEBUG=1, or create the marker file
// %TEMP%\capri-debug (delete it again to go quiet). Writes %TEMP%\capri-opencode-events.log.
let debugFs = null;
try {
  const marker = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/capri-debug`;
  if (process.env.CAPRI_DEBUG || fs.existsSync(marker)) debugFs = fs;
} catch { debugFs = null; }

function log(line) {
  if (!debugFs) return;
  try {
    const file = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/capri-opencode-events.log`;
    if (fs.existsSync(file) && fs.statSync(file).size > 4 * 1024 * 1024) return;
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* never let logging break OpenCode */ }
}

// Only what her display needs: tool names, paths, commands, the prompt, the last
// answer. File contents and tool output never leave the machine.
function trim(value, depth = 0) {
  if (typeof value === 'string') return value.length > 280 ? value.slice(0, 280) + '…' : value;
  if (Array.isArray(value)) return depth > 2 ? undefined : value.slice(0, 8).map((v) => trim(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 2) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // contents of writes/edits: only their size goes through
      if (['content', 'old_string', 'new_string', 'old', 'new', 'file_text', 'edits', 'stdin'].includes(k)) {
        out[k + '_len'] = typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : 0;
        continue;
      }
      out[k] = trim(v, depth + 1);
    }
    return out;
  }
  return value;
}

function send(evt) {
  const body = JSON.stringify(evt);
  log(`bridge -> ${evt.hook_event_name}`);
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(1500),
  }).then((res) => {
    log(`bridge <- ${res.status}`);
    return res;
  }).catch((err) => {
    log(`bridge !! ${err && err.message}`);
    return null;
  });
}

function sessionInfo(ctx, sessionID) {
  // best effort: her "project" label comes from this.
  // session.get() doesn't always expose a directory, so fall back to the folder
  // OpenCode was launched in (ctx.location.directory) — that's the project name.
  const here = ctx?.location?.directory;
  const fill = (s) => ({
    cwd: s?.directory || s?.worktree || s?.cwd || here || undefined,
    session_title: s?.title || undefined,
  });
  if (!ctx?.session?.get || !sessionID) return Promise.resolve(fill(null));
  return ctx.session.get({ sessionID }).then(fill).catch(() => fill(null));
}

function base(ctx, sessionID) {
  return sessionInfo(ctx, sessionID).then((b) => ({ session_id: sessionID || 'default', ...b }));
}

export default {
  id: 'capri',
  async setup(ctx) {
    log(`--- plugin loaded for ${ctx.location?.directory || '?'} ---`);

    // 1. you sent a prompt -> her "new mission" beat
    await ctx.session.hook('prompt', (event) => {
      log(`hook:prompt ${String(event.prompt?.text || '').slice(0, 120)}`);
      base(ctx, event.sessionID).then((b) => send({
        ...b,
        hook_event_name: 'UserPromptSubmit',
        prompt: String(event.prompt?.text || ''),
      }));
    });

    // 2. a tool is about to run -> the ticker over her head
    await ctx.tool.hook('execute.before', (event) => {
      base(ctx, event.sessionID).then((b) => send({
        ...b,
        hook_event_name: 'PreToolUse',
        tool_name: event.tool,
        tool_input: trim(event.input),
        tool_use_id: event.id,
      }));
    });

    // 3. a tool failed -> she gets knocked back
    await ctx.tool.hook('execute.after', (event) => {
      if (event.status !== 'error') return;
      base(ctx, event.sessionID).then((b) => send({
        ...b,
        hook_event_name: 'PostToolUseFailure',
        tool_name: event.tool,
        tool_input: trim(event.input),
        error: String(event.error?.message || event.error || ''),
      }));
    });

    // 4. OpenCode wants your permission -> she teleports to your mouse and waits
    await ctx.permission.hook('evaluate', (event) => {
      if (event.effect !== 'ask') return;
      base(ctx, event.sessionID).then((b) => send({
        ...b,
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: [event.action, ...(event.resources || [])].filter(Boolean).join(' '),
      }));
    });

    // 5. the public event stream: session start/end and "the answer is finished"
    const lastText = new Map();   // sessionID -> what she last said
    const started = new Set();    // sessions we already announced

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = String(event?.type || 'unknown');
          const props = event?.properties ?? event?.data ?? event;
          log(`event ${type}`);
          handleEvent(ctx, type, props, { lastText, started });
        }
      } catch (err) {
        log(`event stream ended: ${err && err.message}`);
      }
    })();

    return () => controller.abort();
  },
};

function handleEvent(ctx, type, props, state) {
  if (type === 'session.step.ended') log(`step.ended finish=${props?.finish}`);

  const session = props?.session || props?.info || props;
  const id = session?.id || props?.sessionID || session?.sessionID;
  const parentID = session?.parentID || props?.parentID;

  if (type === 'session.created' || type === 'session.updated') {
    if (!id || state.started.has(id)) return;
    state.started.add(id);
    base(ctx, id).then((b) => send(parentID
      ? { ...b, hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'agent' }
      : { ...b, hook_event_name: 'SessionStart' }));
    return;
  }

  if (type === 'session.deleted' || type === 'session.removed') {
    if (!id) return;
    state.started.delete(id);
    state.lastText.delete(id);
    base(ctx, id).then((b) => send(parentID
      ? { ...b, hook_event_name: 'SubagentStop', agent_id: id }
      : { ...b, hook_event_name: 'SessionEnd' }));
    return;
  }

  // the assistant's words, kept for the moment it's done talking
  if (type === 'session.text.ended') {
    if (id && typeof props?.text === 'string') state.lastText.set(id, props.text);
    return;
  }

  // a finished turn: anything but "it wants to run more tools" is the end of the job
  if (type === 'session.step.ended' && props?.finish && props.finish !== 'tool-calls') {
    base(ctx, id).then((b) => send({
      ...b,
      hook_event_name: 'Stop',
      last_assistant_message: state.lastText.get(id) || '',
    }));
  }
}
