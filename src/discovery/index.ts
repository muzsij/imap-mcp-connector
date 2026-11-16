import type { DiscoveryResult, MailServerSettings } from '../types.js';
import { fetchDomainAutoconfig } from './autoconfig.js';
import { fetchIspdb } from './ispdb.js';
import { PRESETS } from './presets.js';
import { resolveSrvSettings } from './srv.js';

export interface DiscoveryDeps {
  /** The config file the mail domain hosts itself (autoconfig.<domain>, .well-known). */
  autoconfig(email: string, domain: string): Promise<DiscoveryResult>;
  ispdb(domain: string): Promise<DiscoveryResult>;
  srv(domain: string): Promise<DiscoveryResult>;
}

/** A lookup failed (timeout, outage, DNS error), so we cannot tell whether the domain publishes settings. */
export class DiscoveryUnavailableError extends Error {
  constructor() {
    super('Mail server settings lookup failed');
    this.name = 'DiscoveryUnavailableError';
  }
}

export function createDiscoveryDeps(options: { allowPrivateHosts?: boolean } = {}): DiscoveryDeps {
  return {
    autoconfig: (email, domain) => fetchDomainAutoconfig(email, domain, options),
    ispdb: (d) => fetchIspdb(d),
    srv: (d) => resolveSrvSettings(d),
  };
}

const defaultDeps = createDiscoveryDeps();

/**
 * Returns the domain's published settings, or null when every source definitively has none.
 * Throws DiscoveryUnavailableError when nothing was found but some source failed, so callers never
 * mistake a failed lookup for "nothing published" (and e.g. fall back to user-supplied settings).
 */
export async function discoverSettings(
  email: string,
  deps: DiscoveryDeps = defaultDeps,
): Promise<MailServerSettings | null> {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return null;
  if (Object.hasOwn(PRESETS, domain)) return { ...PRESETS[domain] };
  let failed = false;
  // The domain's own file first, as Thunderbird does: it is authoritative and the ISPDB lacks most small domains.
  const lookups = [(d: string) => deps.autoconfig(email, d), deps.ispdb, deps.srv];
  for (const lookup of lookups) {
    let result: DiscoveryResult;
    try {
      result = await lookup(domain);
    } catch {
      failed = true;
      continue;
    }
    if (result.status === 'found') return result.settings;
    if (result.status === 'error') failed = true;
  }
  if (failed) throw new DiscoveryUnavailableError();
  return null;
}
