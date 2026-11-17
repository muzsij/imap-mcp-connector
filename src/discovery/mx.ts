import { promises as dns, NODATA, NOTFOUND, type MxRecord } from 'node:dns';

type Resolver = (name: string) => Promise<MxRecord[]>;
export type MxProvider = { status: 'found'; domain: string } | { status: 'not_found' } | { status: 'error' };

// Only these answers mean the domain definitively has no MX record; anything else is a failed lookup.
const DEFINITIVE = new Set<unknown>([NOTFOUND, NODATA]);

/**
 * The domain of the mail provider a domain's mail goes to, taken from its preferred MX host: the host's parent
 * domain (mx1.provider.net -> provider.net), or the host itself when it has only two labels. Domains that use a
 * hosting provider usually publish nothing themselves, while the provider publishes its settings, so the provider
 * domain is looked up instead (as Thunderbird does). Not found when the provider is the domain itself.
 */
export async function mxProviderDomain(domain: string, resolve: Resolver = (n) => dns.resolveMx(n)): Promise<MxProvider> {
  let records: MxRecord[];
  try {
    records = await resolve(domain);
  } catch (err) {
    return DEFINITIVE.has((err as { code?: unknown } | null)?.code) ? { status: 'not_found' } : { status: 'error' };
  }
  const best = records
    .map((r) => ({ priority: r.priority, host: r.exchange.replace(/\.$/, '').toLowerCase() }))
    .filter((r) => r.host.includes('.'))
    .sort((a, b) => a.priority - b.priority)[0];
  if (!best) return { status: 'not_found' };
  const labels = best.host.split('.');
  const provider = (labels.length > 2 ? labels.slice(1) : labels).join('.');
  return provider === domain ? { status: 'not_found' } : { status: 'found', domain: provider };
}
