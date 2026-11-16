import { promises as dns } from 'node:dns';
import https from 'node:https';
import { isIPv4, type LookupFunction } from 'node:net';
import { isPublicAddress, type LookupAll } from '../guard.js';
import type { DiscoveryResult } from '../types.js';
import { isClientConfig, parseIspdb } from './ispdb.js';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

/** Fetches a URL over HTTPS and resolves with its body for a 200 answer, or null for anything else. */
export type FetchConfig = (url: URL, address: string | undefined) => Promise<string | null>;

export interface AutoconfigOptions {
  /** Skip the public-address check (ALLOW_PRIVATE_HOSTS), e.g. for a self-hosted test server. */
  allowPrivateHosts?: boolean;
  lookup?: LookupAll;
  fetchConfig?: FetchConfig;
}

const defaultLookup: LookupAll = (host) => dns.lookup(host, { all: true });

function pinnedLookup(address: string): LookupFunction {
  const family = isIPv4(address) ? 4 : 6;
  return (_host, opts, cb) => {
    if (opts?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

/**
 * GETs the URL with certificate validation against its hostname, connecting to `address` when given so the vetted
 * address is the one used (no second DNS answer). Redirects are not followed: a config must come from the domain's
 * own HTTPS endpoints, never from wherever a redirect points (possibly plain HTTP).
 */
const httpsFetchConfig: FetchConfig = (url, address) =>
  new Promise((resolve) => {
    const req = https.get(
      url,
      {
        timeout: TIMEOUT_MS,
        headers: { accept: 'application/xml, text/xml' },
        ...(address && { lookup: pinnedLookup(address) }),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });

/** Resolves the host and returns the address to connect to, or null when it does not resolve or is not public. */
async function vet(host: string, lookup: LookupAll): Promise<string | null> {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    return null;
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) return null;
  return (addresses.find((a) => isIPv4(a.address)) ?? addresses[0]).address;
}

/**
 * Looks for the configuration file the mail domain publishes itself, the way Thunderbird does:
 * https://autoconfig.<domain>/mail/config-v1.1.xml, then https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml.
 * HTTPS only, so the settings provably come from the domain's owner.
 *
 * Never reports an error: most domains host no such file, and the ways that shows (no autoconfig host, a wildcard
 * DNS entry pointing at a website, a refused or timed-out connection) cannot be told apart from an outage. The other
 * sources still run, and hand-entered settings stay limited to ALLOWED_IMAP_HOSTS either way.
 */
export async function fetchDomainAutoconfig(
  email: string,
  domain: string,
  { allowPrivateHosts = false, lookup = defaultLookup, fetchConfig = httpsFetchConfig }: AutoconfigOptions = {},
): Promise<DiscoveryResult> {
  const urls = [
    new URL(`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`),
    new URL(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`),
  ];
  for (const url of urls) {
    let address: string | undefined;
    if (!allowPrivateHosts) {
      const vetted = await vet(url.hostname, lookup);
      if (!vetted) continue;
      address = vetted;
    }
    let body: string | null;
    try {
      body = await fetchConfig(url, address);
    } catch {
      continue;
    }
    if (!body || !isClientConfig(body)) continue;
    const settings = parseIspdb(body, domain);
    if (settings) return { status: 'found', settings };
  }
  return { status: 'not_found' };
}
