import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, type ChannelOpts } from './registry.js';
import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ---------------------------------------------------------------------------
// Signal CLI daemon management
// ---------------------------------------------------------------------------

interface DaemonHandle {
  stop: () => void;
  exited: Promise<void>;
  isExited: () => boolean;
}

function spawnSignalDaemon(
  cliPath: string,
  account: string,
  host: string,
  port: number,
): DaemonHandle {
  const args: string[] = [];
  if (account) args.push('-a', account);
  args.push('daemon', '--http', `${host}:${port}`, '--no-receive-stdout');
  args.push('--receive-mode', 'on-start');

  const child = spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;

  const exitedPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        logger.error({ reason }, 'signal-cli daemon exited');
      }
      resolve();
    });
    child.on('error', (err) => {
      exited = true;
      logger.error({ err }, 'signal-cli spawn error');
      resolve();
    });
  });

  // Log daemon output
  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (line.trim()) logger.debug({ src: 'signal-cli' }, line.trim());
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/\b(ERROR|WARN|FAILED|SEVERE)\b/i.test(line)) {
        logger.warn({ src: 'signal-cli' }, line.trim());
      } else {
        logger.debug({ src: 'signal-cli' }, line.trim());
      }
    }
  });

  return {
    stop: () => {
      if (!child.killed && !exited) child.kill('SIGTERM');
    },
    exited: exitedPromise,
    isExited: () => exited,
  };
}

// ---------------------------------------------------------------------------
// HTTP JSON-RPC client for signal-cli daemon
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 15_000;

async function signalRpc<T = unknown>(
  baseUrl: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const id = Math.random().toString(36).slice(2);
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (res.status === 201) return undefined as T;

    const text = await res.text();
    if (!text) throw new Error(`Signal RPC empty response (${res.status})`);

    const parsed = JSON.parse(text);
    if (parsed.error) {
      const msg = parsed.error.message ?? 'Signal RPC error';
      throw new Error(msg);
    }
    return parsed.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function signalCheck(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/check`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SSE client for inbound events
// ---------------------------------------------------------------------------

interface SseEvent {
  event?: string;
  data?: string;
}

async function streamSse(
  url: string,
  onEvent: (event: SseEvent) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: abortSignal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Signal SSE failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current: SseEvent = {};

  const flush = () => {
    if (current.data || current.event) {
      onEvent({ event: current.event, data: current.data });
      current = {};
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd = buffer.indexOf('\n');
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        flush();
      } else if (!line.startsWith(':')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const field = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trimStart();
          if (field === 'event') current.event = val;
          else if (field === 'data')
            current.data = current.data ? `${current.data}\n${val}` : val;
        }
      }

      lineEnd = buffer.indexOf('\n');
    }
  }
  flush();
}

// ---------------------------------------------------------------------------
// Echo cache
// ---------------------------------------------------------------------------

const ECHO_TTL_MS = 10_000;

class EchoCache {
  private entries = new Map<string, number>();

  remember(text: string) {
    const key = text.trim();
    if (!key) return;
    this.entries.set(key, Date.now());
    this.cleanup();
  }

  isEcho(text: string): boolean {
    const key = text.trim();
    if (!key) return false;
    const ts = this.entries.get(key);
    if (!ts) return false;
    if (Date.now() - ts > ECHO_TTL_MS) {
      this.entries.delete(key);
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts > ECHO_TTL_MS) this.entries.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Signal envelope types (from signal-cli SSE)
// ---------------------------------------------------------------------------

interface SignalQuote {
  id?: number;
  authorNumber?: string;
  authorUuid?: string;
  text?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: { groupId?: string; groupName?: string; type?: string };
  quote?: SignalQuote;
  attachments?: Array<{
    id?: string;
    contentType?: string;
    filename?: string;
    size?: number;
  }>;
}

interface SignalEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  dataMessage?: SignalDataMessage;
  syncMessage?: {
    sentMessage?: SignalDataMessage & {
      destination?: string;
      destinationNumber?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// SignalChannel
// ---------------------------------------------------------------------------

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const JID_PREFIX = 'signal:';

export class SignalChannel implements Channel {
  name = 'signal';

  private daemon: DaemonHandle | null = null;
  private sseAbort: AbortController | null = null;
  private connected = false;
  private echoCache = new EchoCache();
  private baseUrl: string;

  constructor(
    private cliPath: string,
    private account: string,
    private httpHost: string,
    private httpPort: number,
    private opts: SignalChannelOpts,
    private manageDaemon: boolean,
  ) {
    this.baseUrl = `http://${httpHost}:${httpPort}`;
  }

  async connect(): Promise<void> {
    // Start daemon if we're managing it
    if (this.manageDaemon) {
      this.daemon = spawnSignalDaemon(
        this.cliPath,
        this.account,
        this.httpHost,
        this.httpPort,
      );

      // Wait for the daemon to be ready
      const ready = await this.waitForDaemon();
      if (!ready) {
        this.daemon.stop();
        throw new Error(
          'Signal daemon failed to start. Is signal-cli installed and your account linked?',
        );
      }
    } else {
      // Verify externally managed daemon is reachable
      const ok = await signalCheck(this.baseUrl);
      if (!ok) {
        throw new Error(
          `Signal daemon not reachable at ${this.baseUrl}. Start it manually or set SIGNAL_MANAGE_DAEMON=true`,
        );
      }
    }

    // Ensure profile name is set (signal-cli warns and may reject sends without one)
    try {
      await signalRpc(this.baseUrl, 'updateProfile', {
        name: ASSISTANT_NAME,
        account: this.account,
      });
    } catch {
      logger.debug('Signal: could not set profile name');
    }

    // Start SSE event loop
    this.connected = true;
    this.sseAbort = new AbortController();
    this.runSseLoop(this.sseAbort.signal);

    logger.info(
      { account: this.account, url: this.baseUrl },
      'Signal channel connected',
    );
    console.log(`\n  Signal: connected (${this.account})`);
    console.log(
      `  Register chats with JID format: signal:<phone-or-uuid> or signal:group:<id>\n`,
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Signal: not connected, cannot send');
      return;
    }

    const target = jid.replace(/^signal:/, '');
    if (!target) {
      logger.warn({ jid }, 'Signal: empty target');
      return;
    }

    // Prefix with assistant name when sharing an account (Note to Self)
    const outText =
      !ASSISTANT_HAS_OWN_NUMBER && target === this.account
        ? `${ASSISTANT_NAME}: ${text}`
        : text;

    this.echoCache.remember(outText);

    // Split long messages
    const MAX_CHUNK = 4000;
    const chunks =
      outText.length <= MAX_CHUNK ? [outText] : chunkText(outText, MAX_CHUNK);

    for (const chunk of chunks) {
      try {
        const { text: plainText, textStyles } = parseSignalStyles(chunk);
        const params: Record<string, unknown> = { message: plainText };
        if (this.account) params.account = this.account;
        // signal-cli JSON-RPC uses "textStyle" (singular) with string format "start:length:STYLE"
        if (textStyles.length > 0) {
          params.textStyle = textStyles.map(
            (s) => `${s.start}:${s.length}:${s.style}`,
          );
        }

        if (target.startsWith('group:')) {
          params.groupId = target.slice('group:'.length);
        } else {
          params.recipient = [target];
        }

        try {
          await signalRpc(this.baseUrl, 'send', params);
        } catch (styledErr) {
          // Older signal-cli may not support textStyle — retry with original markup
          if (textStyles.length > 0) {
            logger.debug('Signal: textStyle rejected, retrying with markup');
            delete params.textStyle;
            params.message = chunk;
            await signalRpc(this.baseUrl, 'send', params);
          } else {
            throw styledErr;
          }
        }
      } catch (err) {
        logger.error({ jid, err }, 'Signal: send failed');
      }
    }

    logger.info({ jid, length: text.length }, 'Signal message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sseAbort?.abort();
    this.sseAbort = null;
    if (this.daemon && this.manageDaemon) {
      this.daemon.stop();
      await this.daemon.exited;
    }
    this.daemon = null;
    logger.info('Signal channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    const target = jid.replace(/^signal:/, '');
    if (!target || target.startsWith('group:')) return; // typing only for DMs

    try {
      const params: Record<string, unknown> = { recipient: [target] };
      if (this.account) params.account = this.account;
      if (!isTyping) params.stop = true;
      await signalRpc(this.baseUrl, 'sendTyping', params);
    } catch (err) {
      logger.debug({ jid, err }, 'Signal: typing indicator failed');
    }
  }

  // ---- private ----

  private async waitForDaemon(): Promise<boolean> {
    const maxWait = 30_000;
    const pollInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (this.daemon?.isExited()) return false;
      const ok = await signalCheck(this.baseUrl);
      if (ok) return true;
      await sleep(pollInterval);
    }
    return false;
  }

  private runSseLoop(abortSignal: AbortSignal) {
    const loop = async () => {
      let reconnectAttempts = 0;

      while (!abortSignal.aborted) {
        try {
          const url = this.account
            ? `${this.baseUrl}/api/v1/events?account=${encodeURIComponent(this.account)}`
            : `${this.baseUrl}/api/v1/events`;

          await streamSse(
            url,
            (event) => {
              reconnectAttempts = 0;
              this.handleSseEvent(event).catch((err) => {
                logger.error({ err }, 'Signal: error handling SSE event');
              });
            },
            abortSignal,
          );

          if (abortSignal.aborted) return;
          reconnectAttempts++;
          const delay = computeBackoff(reconnectAttempts);
          logger.debug({ delay }, 'Signal SSE stream ended, reconnecting...');
          await sleep(delay);
        } catch (err) {
          if (abortSignal.aborted) return;
          reconnectAttempts++;
          const delay = computeBackoff(reconnectAttempts);
          logger.warn({ err, delay }, 'Signal SSE error, reconnecting...');
          await sleep(delay);
        }
      }
    };

    loop().catch((err) => {
      if (!abortSignal.aborted) {
        logger.error({ err }, 'Signal SSE loop fatal error');
      }
    });
  }

  private async handleSseEvent(event: SseEvent): Promise<void> {
    if (!event.data) return;

    let envelope: SignalEnvelope;
    try {
      const parsed = JSON.parse(event.data);
      envelope = parsed.envelope ?? parsed;
    } catch {
      logger.debug({ data: event.data }, 'Signal: unparseable SSE event');
      return;
    }

    // Handle sync messages (messages we sent from another device)
    const syncSent = envelope.syncMessage?.sentMessage;
    if (syncSent) {
      const dest = (
        syncSent.destinationNumber ??
        syncSent.destination ??
        ''
      ).trim();
      // "Note to Self" — destination is our own account number
      if (dest === this.account) {
        const text = (syncSent.message ?? '').trim();
        if (!text) return;
        if (this.echoCache.isEcho(text)) return;
        const chatJid = `${JID_PREFIX}${this.account}`;
        const timestamp = syncSent.timestamp
          ? new Date(syncSent.timestamp).toISOString()
          : new Date().toISOString();
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          'Note to Self',
          'signal',
          false,
        );
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug({ chatJid }, 'Message from unregistered Signal chat');
          return;
        }

        let syncContent = text;
        if (syncSent.quote) {
          const q = syncSent.quote;
          const quoteAuthor = q.authorNumber ?? 'someone';
          const quoteText = q.text ?? '';
          if (quoteText) {
            syncContent = `> ${quoteAuthor}: ${quoteText}\n\n${syncContent}`;
          }
        }

        this.opts.onMessage(chatJid, {
          id: String(syncSent.timestamp ?? Date.now()),
          chat_jid: chatJid,
          sender: this.account,
          sender_name: 'Me',
          content: syncContent,
          timestamp,
          is_from_me: true,
        });
        return;
      }
      // Other sync messages are our outbound — skip
      return;
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    const text = (dataMessage.message ?? '').trim();
    if (!text) return;

    // Determine sender
    const sender = (envelope.sourceNumber ?? envelope.source ?? '').trim();
    if (!sender) return;

    // Skip echoed outbound
    if (text && this.echoCache.isEcho(text)) {
      logger.debug('Signal: skipping echo');
      return;
    }

    const senderName = (envelope.sourceName ?? sender).trim();
    const groupInfo = dataMessage.groupInfo;
    const isGroup = Boolean(groupInfo?.groupId);
    const groupId = groupInfo?.groupId;

    const chatJid = isGroup
      ? `${JID_PREFIX}group:${groupId}`
      : `${JID_PREFIX}${sender}`;

    const timestamp = dataMessage.timestamp
      ? new Date(dataMessage.timestamp).toISOString()
      : new Date().toISOString();

    const chatName =
      groupInfo?.groupName ??
      (isGroup ? `Group ${groupId?.slice(0, 8)}` : senderName);

    // Report metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    // Only deliver for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Signal chat',
      );
      return;
    }

    let content = text;

    // Prepend quote context so the agent sees what's being replied to
    if (dataMessage.quote) {
      const q = dataMessage.quote;
      const quoteAuthor = q.authorNumber ?? 'someone';
      const quoteText = q.text ?? '';
      if (quoteText) {
        content = `> ${quoteAuthor}: ${quoteText}\n\n${content}`;
      }
    }

    // Trigger detection for groups
    if (isGroup && !TRIGGER_PATTERN.test(content)) {
      const nameRegex = new RegExp(`\\b${escapeRegex(ASSISTANT_NAME)}\\b`, 'i');
      if (nameRegex.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    this.opts.onMessage(chatJid, {
      id: String(dataMessage.timestamp ?? Date.now()),
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'Signal message stored');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Signal text styles — convert Markdown to Signal's offset-based formatting
// ---------------------------------------------------------------------------

interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  start: number;
  length: number;
}

interface StyledText {
  text: string;
  textStyles: SignalTextStyle[];
}

/**
 * Parse Markdown-style formatting into Signal's native text styles.
 * Returns plain text (markup stripped) and an array of style ranges.
 * Offsets are in UTF-16 code units (JavaScript string indices).
 */
function parseSignalStyles(input: string): StyledText {
  const styles: SignalTextStyle[] = [];

  // Process code blocks first (``` ... ```) to prevent inner markup parsing
  // Then inline patterns: **bold**, *bold*, _italic_, ~~strike~~, `mono`
  const patterns: Array<{
    regex: RegExp;
    style: SignalTextStyle['style'];
  }> = [
    { regex: /```([\s\S]*?)```/g, style: 'MONOSPACE' },
    { regex: /`([^`]+)`/g, style: 'MONOSPACE' },
    { regex: /\*\*(.+?)\*\*/g, style: 'BOLD' },
    { regex: /\*(.+?)\*/g, style: 'BOLD' },
    { regex: /_(.+?)_/g, style: 'ITALIC' },
    { regex: /~~(.+?)~~/g, style: 'STRIKETHROUGH' },
  ];

  let text = input;

  for (const { regex, style } of patterns) {
    const nextText: string[] = [];
    let lastIndex = 0;
    let offset = 0;

    for (const match of text.matchAll(regex)) {
      const fullMatch = match[0];
      const innerText = match[1];
      const matchStart = match.index!;

      // Copy text before this match
      nextText.push(text.slice(lastIndex, matchStart));
      const plainStart = matchStart - offset;

      // Add the inner text (without markup)
      nextText.push(innerText);
      styles.push({ style, start: plainStart, length: innerText.length });

      const stripped = fullMatch.length - innerText.length;
      offset += stripped;
      lastIndex = matchStart + fullMatch.length;
    }

    nextText.push(text.slice(lastIndex));
    text = nextText.join('');
  }

  return { text, textStyles: styles };
}

function computeBackoff(attempt: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
  const jitter = base * 0.2 * (Math.random() - 0.5);
  return Math.max(500, base + jitter);
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 7583;

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SIGNAL_CLI_PATH',
    'SIGNAL_ACCOUNT',
    'SIGNAL_HTTP_HOST',
    'SIGNAL_HTTP_PORT',
    'SIGNAL_MANAGE_DAEMON',
    'SIGNAL_DATA_DIR',
  ]);

  const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
  if (!account) {
    logger.debug('Signal: SIGNAL_ACCOUNT not set, skipping channel');
    return null;
  }

  const cliPath =
    process.env.SIGNAL_CLI_PATH || envVars.SIGNAL_CLI_PATH || 'signal-cli';
  const httpHost =
    process.env.SIGNAL_HTTP_HOST ||
    envVars.SIGNAL_HTTP_HOST ||
    DEFAULT_HTTP_HOST;
  const httpPort = parseInt(
    process.env.SIGNAL_HTTP_PORT ||
      envVars.SIGNAL_HTTP_PORT ||
      String(DEFAULT_HTTP_PORT),
    10,
  );
  const manageDaemon =
    (process.env.SIGNAL_MANAGE_DAEMON ||
      envVars.SIGNAL_MANAGE_DAEMON ||
      'true') === 'true';

  // If managing daemon, verify signal-cli exists
  if (manageDaemon && cliPath === 'signal-cli') {
    try {
      execFileSync('which', ['signal-cli'], { stdio: 'ignore' });
    } catch {
      logger.debug('Signal: signal-cli binary not found, skipping channel');
      return null;
    }
  }

  return new SignalChannel(
    cliPath,
    account,
    httpHost,
    httpPort,
    opts,
    manageDaemon,
  );
});
