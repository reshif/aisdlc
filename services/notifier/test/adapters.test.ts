import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import type { FakeChannelReceipt } from '@aisdlc/ports';
import { notificationChannelContract } from '@aisdlc/ports/testing';
import { describe, expect, it } from 'vitest';
import { boundedChannelFactory } from '../src/channels.js';
import { renderNotification, renderingSecrets, allowedClass } from '../src/render.js';
import { SlackWebhookChannel } from '../src/slack.js';
import { SmtpEmailChannel, buildMessage } from '../src/smtp.js';
import { EMAIL_ROW, SLACK_ROW } from './fixture.js';

// PLAN M18: the Slack (incoming webhook) and SMTP adapters pass the channel contract against local sinks on
// 127.0.0.1 (no external network), never answer with their credential, and are built only inside the deployment's
// bounds (key files, egress hosts, plain-text hosts).

const WEBHOOK_SECRET = ['T0AAA', 'B0BBB', 'sEcReTwEbHoOkPaTh123'].join('/');

async function slackSink() {
  const got: Array<{ path: string; body: { text: string } }> = [];
  const fail: number[] = [];
  const server = createHttpServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const status = fail.shift();
      if (status !== undefined) {
        res.writeHead(status).end('no_service');
        return;
      }
      got.push({ path: req.url ?? '', body: JSON.parse(raw) as { text: string } });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/services/${WEBHOOK_SECRET}`,
    got,
    fail,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A local SMTP sink: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT; scripted refusals of the next RCPT. */
async function smtpSink(o: { auth?: { user: string; pass: string } } = {}) {
  const got: Array<{ from: string; to: string; data: string; authed: boolean }> = [];
  const failRcpt: string[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.setEncoding('utf8');
    let buf = '';
    let inData = false;
    let data = '';
    let from = '';
    let to = '';
    let authed = false;
    s.write('220 sink ESMTP\r\n');
    s.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            got.push({ from, to, data, authed });
            s.write('250 queued\r\n');
          } else data += `${line}\r\n`;
          continue;
        }
        if (/^EHLO /.test(line)) s.write('250-sink\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN /.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64')
            .toString('utf8')
            .split('\u0000');
          authed = o.auth !== undefined && user === o.auth.user && pass === o.auth.pass;
          s.write(authed ? '235 ok\r\n' : '535 bad credentials\r\n');
        } else if (/^MAIL FROM:/.test(line)) {
          if (o.auth && !authed) s.write('530 auth required\r\n');
          else {
            from = line.slice(10);
            s.write('250 ok\r\n');
          }
        } else if (/^RCPT TO:/.test(line)) {
          const f = failRcpt.shift();
          if (f) s.write(`${f}\r\n`);
          else {
            to = line.slice(8);
            s.write('250 ok\r\n');
          }
        } else if (line === 'DATA') {
          inData = true;
          data = '';
          s.write('354 go\r\n');
        } else if (line === 'QUIT') s.end('221 bye\r\n');
        else s.write('502 no\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    got,
    failRcpt,
    stop: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const b64Body = (data: string): string => {
  const [, body] = data.split('\r\n\r\n');
  return Buffer.from((body ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
};
const messageId = (data: string): string => /Message-ID: <([^@]+)@/.exec(data)?.[1] ?? 'none';

notificationChannelContract('SlackWebhookChannel (local sink)', async () => {
  const sink = await slackSink();
  return {
    port: new SlackWebhookChannel({ url: sink.url }),
    to: { kind: 'slack', mention: null },
    // a webhook has no key: the sink records the text, and the contract posts each key once per success
    received: async (): Promise<FakeChannelReceipt[]> =>
      sink.got.map((g, i) => ({
        idempotency_key: [
          '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a7b',
          '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a7c',
        ][g.body.text.includes('waits for you') ? 0 : 1] as string,
        to: { kind: 'slack', mention: null },
        subject: String(i),
        text: g.body.text,
      })),
    failNextTransient: () => void sink.fail.push(503),
    failNextPermanent: () => void sink.fail.push(404),
    secrets: [WEBHOOK_SECRET, sink.url],
    stop: sink.stop,
  };
});

notificationChannelContract('SmtpEmailChannel (local sink)', async () => {
  const sink = await smtpSink();
  return {
    // a plain session is what a deployment allows only for a local relay, and only without a password (implicit TLS
    // and STARTTLS need a certificate the sink does not have)
    port: new SmtpEmailChannel({
      host: '127.0.0.1',
      port: sink.port,
      tls: 'none',
      from: 'factory@example.com',
      auth: null,
    }),
    to: { kind: 'email', address: 'dana@example.com' },
    received: async () =>
      sink.got.map((g) => ({
        idempotency_key: messageId(g.data),
        to: { kind: 'email', address: g.to.replace(/[<>]/g, '') },
        subject: /Subject: (.*)\r\n/.exec(g.data)?.[1] ?? '',
        text: b64Body(g.data),
      })),
    failNextTransient: () => void sink.failRcpt.push('451 try later'),
    failNextPermanent: () => void sink.failRcpt.push('550 no such user'),
    secrets: [],
    stop: sink.stop,
  };
});

describe('the adapters', () => {
  it('Slack: escapes control characters and mentions the person; a timeout is retryable', async () => {
    const sink = await slackSink();
    try {
      const c = new SlackWebhookChannel({ url: sink.url });
      expect(
        await c.send({
          idempotency_key: 'k',
          to: { kind: 'slack', mention: 'U0DANA1' },
          subject: 'a <b> & c',
          text: 'x',
        }),
      ).toEqual({ ok: true });
      expect(sink.got[0]?.body.text).toBe('<@U0DANA1> *a &lt;b&gt; &amp; c*\nx');
      expect(JSON.stringify(c)).not.toContain(WEBHOOK_SECRET);
      const slow = new SlackWebhookChannel({
        url: sink.url,
        timeoutMs: 1,
        fetchImpl: (() =>
          new Promise((_r, rej) =>
            setTimeout(() => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })), 5),
          )) as unknown as typeof fetch,
      });
      expect(
        await slow.send({
          idempotency_key: 'k',
          to: { kind: 'slack', mention: null },
          subject: 's',
          text: 't',
        }),
      ).toEqual({ ok: false, code: 'timeout', retryable: true });
    } finally {
      await sink.stop();
    }
  });

  it('SMTP: never sends a password in plain text, and a server that is not there is unreachable', async () => {
    expect(
      () =>
        new SmtpEmailChannel({
          host: '127.0.0.1',
          port: 1,
          tls: 'none',
          from: 'f@example.com',
          auth: { user: 'u', pass: 'p' },
        }),
    ).toThrow(/never sent without TLS/);
    const sink = await smtpSink();
    const port = sink.port;
    await sink.stop();
    const c = new SmtpEmailChannel({
      host: '127.0.0.1',
      port,
      tls: 'none',
      from: 'f@example.com',
      auth: null,
    });
    expect(
      await c.send({
        idempotency_key: 'k',
        to: { kind: 'email', address: 'a@example.com' },
        subject: 's',
        text: 't',
      }),
    ).toEqual({ ok: false, code: 'unreachable', retryable: true });
    // a header cannot be injected through an address or a subject
    expect(
      await c.send({
        idempotency_key: 'k',
        to: { kind: 'email', address: 'a@example.com\r\nBcc: x@evil.example' },
        subject: 's',
        text: 't',
      }),
    ).toEqual({ ok: false, code: 'rejected', retryable: false });
    const msg = buildMessage(
      {
        idempotency_key: 'k',
        to: { kind: 'email', address: 'a@example.com' },
        subject: 'a\r\nBcc: x',
        text: 't',
      },
      'f@example.com',
      new Date(0),
    );
    expect(msg).not.toMatch(/\r\nBcc:/);
  });

  it('a STARTTLS relay that does not offer STARTTLS is never used in plain text', async () => {
    const sink = await smtpSink();
    try {
      const c = new SmtpEmailChannel({
        host: '127.0.0.1',
        port: sink.port,
        tls: 'starttls',
        from: 'f@example.com',
        auth: null,
      });
      expect(
        await c.send({
          idempotency_key: 'k',
          to: { kind: 'email', address: 'a@example.com' },
          subject: 's',
          text: 't',
        }),
      ).toEqual({ ok: false, code: 'rejected', retryable: false });
      expect(sink.got).toEqual([]);
    } finally {
      await sink.stop();
    }
  });

  it('builds a row only inside the deployment bounds', () => {
    const files: Record<string, string> = {
      '/run/secrets/slack-team': 'https://hooks.slack.com/services/T/B/x',
      '/run/secrets/slack-evil': 'https://evil.example/services/T/B/x',
      '/run/secrets/slack-plain': 'http://hooks.slack.com/services/T/B/x',
    };
    const f = boundedChannelFactory({
      secretRefs: new Set([
        'file:/run/secrets/slack-team',
        'file:/run/secrets/slack-evil',
        'file:/run/secrets/slack-plain',
      ]),
      egressHosts: new Set(['hooks.slack.com', 'smtp.example.com']),
      plainHosts: new Set(),
      readFile: (p) => {
        const v = files[p];
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
    });
    expect(f(SLACK_ROW).ok).toBe(true);
    // a key file the deployment did not list, a host it did not allow, plain http to a TLS host
    expect(f({ ...SLACK_ROW, webhook_ref: 'file:/etc/passwd' })).toEqual({
      ok: false,
      code: 'secret_unavailable',
    });
    expect(f({ ...SLACK_ROW, webhook_ref: 'file:/run/secrets/slack-evil' })).toEqual({
      ok: false,
      code: 'egress_refused',
    });
    expect(f({ ...SLACK_ROW, webhook_ref: 'file:/run/secrets/slack-plain' })).toEqual({
      ok: false,
      code: 'egress_refused',
    });
    expect(f(EMAIL_ROW).ok).toBe(true);
    expect(f({ ...EMAIL_ROW, host: 'smtp.evil.example' })).toEqual({
      ok: false,
      code: 'egress_refused',
    });
    expect(f({ ...EMAIL_ROW, tls: 'none' })).toEqual({ ok: false, code: 'egress_refused' });
    expect(
      f({ ...EMAIL_ROW, username_ref: 'file:/run/secrets/u', password_ref: 'file:/run/secrets/p' }),
    ).toEqual({ ok: false, code: 'secret_unavailable' });
  });
});

describe('rendering', () => {
  const content = {
    kind: 'gate_waiting' as const,
    project_id: 'acme' as never,
    gate_id: 'G4' as const,
    gate_instance_id: null,
    card_id: null,
    kill_id: null,
    due_at: '2026-11-13T10:00:00.000Z',
    link_path: '/inbox',
  };

  it('caps the class at the lower of the channel and the person', () => {
    expect(allowedClass('D1', 'D2')).toBe('D1');
    expect(allowedClass('D1', 'D0')).toBe('D0');
    expect(allowedClass('D0', 'D2')).toBe('D0');
  });

  it('names the project and gate at D1 only, and the secret ruleset finds nothing in either', () => {
    const d1 = renderNotification(content, 'D1', 'https://factory.example/');
    expect(d1.text).toContain('Gate G4 (');
    expect(d1.text).toContain('Due: 2026-11-13T10:00:00.000Z');
    expect(d1.text).toContain('https://factory.example/inbox');
    const d0 = renderNotification(
      { ...content, link_path: '/items/x' },
      'D0',
      'https://factory.example',
    );
    expect(d0.rendered_class).toBe('D0');
    expect(`${d0.subject}${d0.text}`).not.toMatch(/acme|G4|items/);
    expect(renderingSecrets(d1)).toEqual([]);
    expect(renderingSecrets(d0)).toEqual([]);
    const planted = {
      ...d1,
      text: `${d1.text}\n${['xo', 'xb-', '1234567890-', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('')}`,
    };
    expect(renderingSecrets(planted)).toEqual(['slack-token']);
  });
});
