import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import type { SmtpTls } from '@aisdlc/contracts';
import type { NotificationChannelPort, OutgoingNotification, SendOutcome } from '@aisdlc/ports';

// The email adapter behind `NotificationChannelPort` (PLAN M18): one message per SMTP session to a relay (RFC 5321),
// with implicit TLS, STARTTLS or, for a relay the deployment allows in plain text and only without a password, none.
// No dependency: the client speaks the handful of commands it needs (EHLO, STARTTLS, AUTH PLAIN, MAIL, RCPT, DATA,
// QUIT). The password is held only in this object and never appears in an answer: a failure is a code.
//
// The Message-ID is the delivery id, so every retry of one delivery carries the same id and a mailbox that dedupes on
// it shows the message once. A 4xx reply is transient (retry), a 5xx one permanent.

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: SmtpTls;
  readonly from: string;
  readonly auth: { readonly user: string; readonly pass: string } | null;
  /** The name this client gives in EHLO. */
  readonly helo?: string;
  readonly timeoutMs?: number;
  /** Extra TLS options (a test's CA). Certificates are always verified. */
  readonly tlsOptions?: Pick<ConnectionOptions, 'ca' | 'servername'>;
}

class SmtpFailure extends Error {
  constructor(
    readonly code: 'unreachable' | 'timeout' | 'rejected' | 'server_error',
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** Reads SMTP replies (multi-line `250-...` up to `250 ...`) from a socket. */
class ReplyReader {
  private buf = '';
  private readonly queue: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failed: Error | null = null;
  private lines: string[] = [];

  attach(s: Socket | TLSSocket): void {
    s.setEncoding('utf8');
    s.on('data', (d: string) => this.push(d));
    s.on('error', () => this.fail(new SmtpFailure('unreachable', true)));
    s.on('close', () => this.fail(new SmtpFailure('unreachable', true)));
  }

  detach(s: Socket | TLSSocket): void {
    s.removeAllListeners('data');
    s.removeAllListeners('error');
    s.removeAllListeners('close');
  }

  private push(d: string): void {
    this.buf += d;
    if (this.buf.length > 64 * 1024) {
      this.fail(new SmtpFailure('rejected', false));
      return;
    }
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) {
        this.fail(new SmtpFailure('rejected', false));
        return;
      }
      this.lines.push(m[3] ?? '');
      if (m[2] === ' ') {
        const r = { code: Number(m[1]), lines: this.lines };
        this.lines = [];
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w.resolve(r);
        } else this.queue.push(r);
      }
    }
  }

  private fail(e: Error): void {
    if (this.failed) return;
    this.failed = e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(e);
    }
  }

  next(): Promise<Reply> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

/** A header value with no line break (no header injection) and, when not ASCII, RFC 2047 encoded. */
function headerText(s: string): string {
  const flat = s.replace(/[\r\n]+/g, ' ').slice(0, 300);
  return /^[\x20-\x7e]*$/.test(flat)
    ? flat
    : `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

const ADDRESS = /^[^\s<>()[\]\\,;:"@]+@[A-Za-z0-9.-]+$/;

/** The message as sent after DATA: headers, a base64 body (so no line can be a lone dot), CRLF line ends. */
export function buildMessage(
  m: OutgoingNotification & { readonly to: { kind: 'email'; address: string } },
  from: string,
  date: Date,
): string {
  const body = Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64');
  const lines = [
    `From: ${from}`,
    `To: ${m.to.address}`,
    `Subject: ${headerText(m.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${m.idempotency_key}@notifier.aisdlc>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    ...(body.match(/.{1,76}/g) ?? []),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export class SmtpEmailChannel implements NotificationChannelPort {
  readonly kind = 'email_smtp' as const;
  readonly #o: SmtpOptions;

  constructor(o: SmtpOptions) {
    if (o.tls === 'none' && o.auth !== null) {
      throw new Error('a password is never sent without TLS');
    }
    this.#o = o;
  }

  /** Never shows the credentials. */
  toJSON(): object {
    return { kind: this.kind, host: this.#o.host, port: this.#o.port, tls: this.#o.tls };
  }

  async send(m: OutgoingNotification): Promise<SendOutcome> {
    if (m.to.kind !== 'email' || !ADDRESS.test(m.to.address) || !ADDRESS.test(this.#o.from)) {
      return { ok: false, code: 'rejected', retryable: false };
    }
    const to = m.to.address;
    try {
      await this.session({ ...m, to: { kind: 'email', address: to } });
      return { ok: true };
    } catch (e) {
      if (e instanceof SmtpFailure) return { ok: false, code: e.code, retryable: e.retryable };
      return { ok: false, code: 'unreachable', retryable: true };
    }
  }

  private async session(
    m: OutgoingNotification & { readonly to: { kind: 'email'; address: string } },
  ): Promise<void> {
    const o = this.#o;
    const timeoutMs = o.timeoutMs ?? 15_000;
    const tlsOpts = (socket?: Socket): ConnectionOptions => ({
      host: o.host,
      port: o.port,
      servername: o.tlsOptions?.servername ?? o.host,
      rejectUnauthorized: true,
      ...(o.tlsOptions?.ca === undefined ? {} : { ca: o.tlsOptions.ca }),
      ...(socket === undefined ? {} : { socket }),
    });
    let socket: Socket | TLSSocket = await new Promise((resolve, reject) => {
      const s: Socket | TLSSocket =
        o.tls === 'implicit'
          ? tlsConnect(tlsOpts(), () => resolve(s))
          : netConnect({ host: o.host, port: o.port }, () => resolve(s));
      s.once('error', () => reject(new SmtpFailure('unreachable', true)));
    });
    let timedOut = false;
    // the whole session, not only an idle socket, is bounded
    const timer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
    }, timeoutMs);
    timer.unref();
    let reader = new ReplyReader();
    reader.attach(socket);
    const expect = async (ok: (c: number) => boolean): Promise<Reply> => {
      let r: Reply;
      try {
        r = await reader.next();
      } catch (e) {
        if (timedOut) throw new SmtpFailure('timeout', true);
        throw e;
      }
      if (ok(r.code)) return r;
      if (r.code >= 400 && r.code < 500) throw new SmtpFailure('server_error', true);
      throw new SmtpFailure('rejected', false);
    };
    const write = (line: string) => socket.write(`${line}\r\n`);
    const helo = o.helo ?? 'notifier.aisdlc';
    try {
      await expect((c) => c === 220);
      write(`EHLO ${helo}`);
      let ehlo = await expect((c) => c === 250);
      if (o.tls === 'starttls') {
        if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
          // a relay that does not offer STARTTLS is never used in plain text instead
          throw new SmtpFailure('rejected', false);
        }
        write('STARTTLS');
        await expect((c) => c === 220);
        reader.detach(socket);
        const plain = socket;
        socket = await new Promise<TLSSocket>((resolve, reject) => {
          const t = tlsConnect(tlsOpts(plain), () => resolve(t));
          t.once('error', () => reject(new SmtpFailure('unreachable', true)));
        });
        reader = new ReplyReader();
        reader.attach(socket);
        write(`EHLO ${helo}`);
        ehlo = await expect((c) => c === 250);
      }
      if (o.auth !== null) {
        const token = Buffer.from(`\u0000${o.auth.user}\u0000${o.auth.pass}`, 'utf8').toString(
          'base64',
        );
        write(`AUTH PLAIN ${token}`);
        await expect((c) => c === 235);
      }
      write(`MAIL FROM:<${o.from}>`);
      await expect((c) => c === 250);
      write(`RCPT TO:<${m.to.address}>`);
      await expect((c) => c === 250 || c === 251);
      write('DATA');
      await expect((c) => c === 354);
      socket.write(`${buildMessage(m, o.from, new Date())}.\r\n`);
      await expect((c) => c === 250);
      write('QUIT');
      await reader.next().catch(() => undefined);
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
}
