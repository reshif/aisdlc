import type { ConfigReader } from '@aisdlc/config';
import {
  DEFAULT_SANDBOX_CAPS,
  SANDBOX_CAPS_KEY,
  sandboxCapsFor,
  type SandboxCaps,
} from '@aisdlc/contracts';

// The caps in force on this runner host (ADR-0003 §7): `sandbox.caps` from the published config (factory layer,
// M1-gated), the host's own row if it has one. FAIL CLOSED and never higher than the defaults when it cannot be
// read: no reader, a published value that no longer fits its schema, or a last reload that failed (the reader keeps
// its last good snapshot, which could be above the defaults: then the lower of the two applies until a reload works).

export interface CapsNow {
  readonly caps: SandboxCaps;
  /** `config`: a published revision set them. `default`: nothing published, or unreadable (the fallback). */
  readonly source: 'config' | 'default';
}

export interface CapsReader {
  current(): CapsNow;
  /** Reads the published config again. Resolves when done; a failure leaves the fallback in force. */
  reload(): Promise<void>;
}

const lower = (a: SandboxCaps, b: SandboxCaps): SandboxCaps => {
  const total = Math.min(a.total, b.total);
  return { total, coding: Math.min(a.coding, b.coding, total) };
};

/** Fixed caps (tests, or a deployment that gives the controller no config reader). */
export class StaticCaps implements CapsReader {
  constructor(public caps: SandboxCaps = DEFAULT_SANDBOX_CAPS) {}
  current(): CapsNow {
    return { caps: this.caps, source: 'default' };
  }
  async reload(): Promise<void> {}
}

export class ConfigCaps implements CapsReader {
  /** The last reload failed: the published caps are "unknown" until one succeeds. */
  private stale = false;

  constructor(
    private readonly reader: ConfigReader,
    private readonly hostId: string,
    private readonly onError: (e: unknown) => void = () => undefined,
  ) {}

  current(): CapsNow {
    const c = this.reader.current();
    if (c.rejected.includes(SANDBOX_CAPS_KEY))
      return { caps: DEFAULT_SANDBOX_CAPS, source: 'default' };
    const caps = sandboxCapsFor(c.get(SANDBOX_CAPS_KEY), this.hostId);
    if (this.stale) return { caps: lower(caps, DEFAULT_SANDBOX_CAPS), source: 'default' };
    return { caps, source: c.revisions.factory === null ? 'default' : 'config' };
  }

  async reload(): Promise<void> {
    try {
      await this.reader.refresh();
      this.stale = false;
    } catch (e) {
      this.stale = true;
      this.onError(e);
    }
  }
}
