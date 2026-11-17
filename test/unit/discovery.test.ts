import { describe, expect, it, vi } from 'vitest';
import { DiscoveryUnavailableError, discoverSettings, type DiscoveryDeps } from '../../src/discovery/index.js';
import { fetchDomainAutoconfig, type FetchConfig } from '../../src/discovery/autoconfig.js';
import { fetchIspdb, parseIspdb } from '../../src/discovery/ispdb.js';
import { mxProviderDomain } from '../../src/discovery/mx.js';
import { resolveSrvSettings } from '../../src/discovery/srv.js';

const ISPDB_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    <incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port><socketType>STARTTLS</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
  </emailProvider>
</clientConfig>`;

describe('parseIspdb', () => {
  it('prefers SSL IMAP and maps socket types', () => {
    expect(parseIspdb(ISPDB_XML)).toEqual({
      imapHost: 'imap.example.org', imapPort: 993, imapSecurity: 'tls',
      smtpHost: 'smtp.example.org', smtpPort: 587, smtpSecurity: 'starttls',
      autoSavesSent: false,
    });
  });

  it('returns null when only plaintext servers exist', () => {
    const xml = ISPDB_XML.replace(/SSL|STARTTLS/g, 'plain');
    expect(parseIspdb(xml)).toBeNull();
  });

  it('returns null for invalid XML', () => {
    expect(parseIspdb('not xml')).toBeNull();
  });

  it('skips candidates with missing or non-numeric port', () => {
    const xml = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    <incomingServer type="imap"><hostname>imap.example.org</hostname><port></port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
  </emailProvider>
</clientConfig>`;
    expect(parseIspdb(xml)).toEqual({
      imapHost: 'imap.example.org', imapPort: 993, imapSecurity: 'tls',
      smtpHost: 'smtp.example.org', smtpPort: 587, smtpSecurity: 'starttls',
      autoSavesSent: false,
    });
  });

  it('substitutes %EMAILDOMAIN% placeholder when domain is provided', () => {
    const xml = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.%EMAILDOMAIN%</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
  </emailProvider>
</clientConfig>`;
    expect(parseIspdb(xml, 'example.org')).toEqual({
      imapHost: 'imap.example.org', imapPort: 993, imapSecurity: 'tls',
      smtpHost: 'smtp.example.org', smtpPort: 587, smtpSecurity: 'starttls',
      autoSavesSent: false,
    });
  });

  it('skips hostname with other placeholders', () => {
    const xml = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    <incomingServer type="imap"><hostname>%EMAILLOCALPART%.example.org</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
  </emailProvider>
</clientConfig>`;
    expect(parseIspdb(xml)).toEqual({
      imapHost: 'imap.example.org', imapPort: 993, imapSecurity: 'tls',
      smtpHost: 'smtp.example.org', smtpPort: 587, smtpSecurity: 'starttls',
      autoSavesSent: false,
    });
  });

  it('selects STARTTLS IMAP over plain IMAP when no SSL available', () => {
    const xml = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    <incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port><socketType>plain</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port><socketType>STARTTLS</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>SSL</socketType></outgoingServer>
  </emailProvider>
</clientConfig>`;
    expect(parseIspdb(xml)).toEqual({
      imapHost: 'imap.example.org', imapPort: 143, imapSecurity: 'starttls',
      smtpHost: 'smtp.example.org', smtpPort: 587, smtpSecurity: 'tls',
      autoSavesSent: false,
    });
  });

  it('returns null when only IMAP is plaintext but SMTP has security', () => {
    const xml = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    <incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port><socketType>plain</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
  </emailProvider>
</clientConfig>`;
    expect(parseIspdb(xml)).toBeNull();
  });
});

describe('fetchIspdb', () => {
  const respond = (body: string, status: number) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const failWith = (err: Error) => (async () => { throw err; }) as unknown as typeof fetch;

  it('fetches from the Thunderbird ISPDB', async () => {
    const fetchFn = vi.fn(async () => new Response(ISPDB_XML, { status: 200 }));
    const result = await fetchIspdb('example.org', fetchFn as unknown as typeof fetch);
    expect(result).toMatchObject({ status: 'found', settings: { imapHost: 'imap.example.org' } });
    expect(fetchFn).toHaveBeenCalledWith('https://autoconfig.thunderbird.net/v1.1/example.org', expect.anything());
  });

  it("fills %EMAILDOMAIN% with the user's domain when looking up a provider", async () => {
    const xml = ISPDB_XML.replaceAll('imap.example.org', 'imap.%EMAILDOMAIN%');
    const result = await fetchIspdb('provider.net', respond(xml, 200), 'customer.org');
    expect(result).toMatchObject({ status: 'found', settings: { imapHost: 'imap.customer.org' } });
  });

  it('reports not-found on 404', async () => {
    expect(await fetchIspdb('x.org', respond('', 404))).toEqual({ status: 'not_found' });
  });

  it('reports not-found for a valid document without usable IMAP and SMTP servers', async () => {
    expect(await fetchIspdb('x.org', respond(ISPDB_XML.replace(/SSL|STARTTLS/g, 'plain'), 200))).toEqual({ status: 'not_found' });
  });

  it('reports an error on other HTTP statuses', async () => {
    expect(await fetchIspdb('x.org', respond('', 500))).toEqual({ status: 'error' });
    expect(await fetchIspdb('x.org', respond('', 429))).toEqual({ status: 'error' });
    expect(await fetchIspdb('x.org', respond('', 403))).toEqual({ status: 'error' });
  });

  it('reports an error on timeout or network failure', async () => {
    expect(await fetchIspdb('x.org', failWith(new DOMException('The operation was aborted.', 'AbortError')))).toEqual({ status: 'error' });
    expect(await fetchIspdb('x.org', failWith(new DOMException('The operation timed out.', 'TimeoutError')))).toEqual({ status: 'error' });
    expect(await fetchIspdb('x.org', failWith(new TypeError('fetch failed')))).toEqual({ status: 'error' });
  });

  it('reports an error for an unparseable 2xx body', async () => {
    expect(await fetchIspdb('x.org', respond('<html><body>Service unavailable', 200))).toEqual({ status: 'error' });
    expect(await fetchIspdb('x.org', respond('not xml', 200))).toEqual({ status: 'error' });
    expect(await fetchIspdb('x.org', respond('<html><body>maintenance</body></html>', 200))).toEqual({ status: 'error' });
  });
});

function dnsError(code: string): Error {
  return Object.assign(new Error(`querySrv ${code}`), { code });
}

describe('resolveSrvSettings', () => {
  const records: Record<string, { name: string; port: number; priority: number; weight: number }[]> = {
    '_imaps._tcp.x.org': [{ name: 'mail.x.org.', port: 993, priority: 10, weight: 0 }],
    '_submission._tcp.x.org': [{ name: 'smtp.x.org', port: 587, priority: 5, weight: 0 }],
  };
  const resolver = (missing: string, failing: Record<string, string> = {}) => async (name: string) => {
    if (failing[name]) throw dnsError(failing[name]);
    if (!records[name]) throw dnsError(missing);
    return records[name];
  };

  it('uses _imaps and _submissions/_submission records', async () => {
    expect(await resolveSrvSettings('x.org', resolver('ENOTFOUND'))).toEqual({
      status: 'found',
      settings: {
        imapHost: 'mail.x.org', imapPort: 993, imapSecurity: 'tls',
        smtpHost: 'smtp.x.org', smtpPort: 587, smtpSecurity: 'starttls', autoSavesSent: false,
      },
    });
    expect(await resolveSrvSettings('x.org', resolver('ENODATA'))).toMatchObject({ status: 'found' });
  });

  it('reports not-found when the IMAPS record definitively does not exist', async () => {
    expect(await resolveSrvSettings('x.org', async () => { throw dnsError('ENOTFOUND'); })).toEqual({ status: 'not_found' });
    expect(await resolveSrvSettings('x.org', async () => { throw dnsError('ENODATA'); })).toEqual({ status: 'not_found' });
  });

  it('reports not-found when IMAPS exists but no submission record does', async () => {
    const resolve = async (name: string) => {
      if (name === '_imaps._tcp.x.org') return records[name];
      throw dnsError('ENOTFOUND');
    };
    expect(await resolveSrvSettings('x.org', resolve)).toEqual({ status: 'not_found' });
  });

  it('reports an error when a DNS lookup fails', async () => {
    expect(await resolveSrvSettings('x.org', async () => { throw dnsError('ESERVFAIL'); })).toEqual({ status: 'error' });
    expect(await resolveSrvSettings('x.org', async () => { throw dnsError('ETIMEOUT'); })).toEqual({ status: 'error' });
    expect(await resolveSrvSettings('x.org', async () => { throw dnsError('ECONNREFUSED'); })).toEqual({ status: 'error' });
    expect(await resolveSrvSettings('x.org', async () => { throw new Error('boom'); })).toEqual({ status: 'error' });
  });

  it('reports an error when IMAPS is found but a submission lookup fails', async () => {
    expect(await resolveSrvSettings('x.org', resolver('ENOTFOUND', { '_submissions._tcp.x.org': 'ESERVFAIL' }))).toEqual({ status: 'error' });
    expect(await resolveSrvSettings('x.org', resolver('ENOTFOUND', { '_submission._tcp.x.org': 'ETIMEOUT' }))).toEqual({ status: 'error' });
  });
});

describe('discoverSettings', () => {
  const none: DiscoveryDeps = {
    autoconfig: async () => ({ status: 'not_found' }),
    ispdb: async () => ({ status: 'not_found' }),
    srv: async () => ({ status: 'not_found' }),
    mx: async () => ({ status: 'not_found' }),
  };
  const failing: DiscoveryDeps = { ...none, ispdb: async () => ({ status: 'error' }), srv: async () => ({ status: 'error' }) };
  const hit = { imapHost: 'i', imapPort: 993, imapSecurity: 'tls', smtpHost: 's', smtpPort: 465, smtpSecurity: 'tls', autoSavesSent: false } as const;

  it('uses presets first (gmail auto-saves sent mail)', async () => {
    const s = await discoverSettings('Someone@Gmail.com', none);
    expect(s).toMatchObject({ imapHost: 'imap.gmail.com', imapPort: 993, autoSavesSent: true });
  });

  it('uses presets even when the other sources are failing', async () => {
    const ispdb = vi.fn(failing.ispdb);
    expect(await discoverSettings('a@gmail.com', { ...failing, ispdb })).toMatchObject({ imapHost: 'imap.gmail.com' });
    expect(ispdb).not.toHaveBeenCalled();
  });

  it("prefers the domain's own autoconfig file over ISPDB and SRV", async () => {
    const autoconfig = vi.fn(async () => ({ status: 'found', settings: hit }) as const);
    const ispdb = vi.fn(none.ispdb);
    expect(await discoverSettings('Me@X.org', { ...none, autoconfig, ispdb })).toEqual(hit);
    expect(autoconfig).toHaveBeenCalledWith('Me@X.org', 'x.org');
    expect(ispdb).not.toHaveBeenCalled();
  });

  it("uses the MX provider's settings last, when the domain itself publishes none", async () => {
    const mx = vi.fn(async () => ({ status: 'found', settings: hit }) as const);
    expect(await discoverSettings('a@x.org', { ...none, mx })).toEqual(hit);
    expect(mx).toHaveBeenCalledWith('a@x.org', 'x.org');
    const srvHit = { ...hit, imapHost: 'srv' };
    expect(await discoverSettings('a@x.org', { ...none, mx, srv: async () => ({ status: 'found', settings: srvHit }) })).toEqual(srvHit);
    await expect(discoverSettings('a@x.org', { ...none, mx: async () => ({ status: 'error' }) })).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('falls back to ISPDB then SRV', async () => {
    expect(await discoverSettings('a@x.org', { ...none, ispdb: async () => ({ status: 'found', settings: hit }) })).toEqual(hit);
    expect(await discoverSettings('a@x.org', { ...none, srv: async () => ({ status: 'found', settings: hit }) })).toEqual(hit);
  });

  it('returns null only when every source definitively found nothing', async () => {
    expect(await discoverSettings('a@x.org', none)).toBeNull();
    expect(await discoverSettings('no-at-sign', none)).toBeNull();
  });

  it('throws DiscoveryUnavailableError when a source fails and none finds settings', async () => {
    await expect(discoverSettings('a@x.org', { ...none, ispdb: async () => ({ status: 'error' }) })).rejects.toBeInstanceOf(DiscoveryUnavailableError);
    await expect(discoverSettings('a@x.org', { ...none, srv: async () => ({ status: 'error' }) })).rejects.toBeInstanceOf(DiscoveryUnavailableError);
    await expect(discoverSettings('a@x.org', failing)).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('treats a throwing source as failed', async () => {
    await expect(discoverSettings('a@x.org', { ...none, ispdb: async () => { throw new Error('x'); } })).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('returns settings when one source fails but another finds them', async () => {
    expect(await discoverSettings('a@x.org', { ...none, ispdb: async () => ({ status: 'error' }), srv: async () => ({ status: 'found', settings: hit }) })).toEqual(hit);
    expect(await discoverSettings('a@x.org', { ...none, ispdb: async () => { throw new Error('x'); }, srv: async () => ({ status: 'found', settings: hit }) })).toEqual(hit);
  });

  it('covers borrowed presets such as GMX and Posteo', async () => {
    expect(await discoverSettings('a@gmx.de', none)).toMatchObject({ imapHost: 'imap.gmx.net', smtpHost: 'mail.gmx.net', smtpPort: 587, smtpSecurity: 'starttls' });
    expect(await discoverSettings('a@posteo.net', none)).toMatchObject({ imapHost: 'posteo.de' });
  });

  it('protects against prototype pollution (constructor, __proto__)', async () => {
    expect(await discoverSettings('a@constructor', none)).toBeNull();
    expect(await discoverSettings('a@__proto__', none)).toBeNull();
  });

  it('returns copies of preset settings so callers cannot mutate the table', async () => {
    const result1 = await discoverSettings('Someone@Gmail.com', none);
    if (result1) result1.imapHost = 'mutated.example.org';
    const result2 = await discoverSettings('Someone@Gmail.com', none);
    expect(result2?.imapHost).toBe('imap.gmail.com');
  });
});

describe('mxProviderDomain', () => {
  const mx = (...records: [string, number][]) => async () => records.map(([exchange, priority]) => ({ exchange, priority }));

  it("returns the preferred MX host's parent domain", async () => {
    expect(await mxProviderDomain('customer.org', mx(['backup.other.net', 20], ['MX1.Provider.net.', 10]))).toEqual({ status: 'found', domain: 'provider.net' });
    expect(await mxProviderDomain('x.org', mx(['provider.net', 10]))).toEqual({ status: 'found', domain: 'provider.net' });
  });

  it('reports not-found when mail is handled by the domain itself or there is no usable MX', async () => {
    expect(await mxProviderDomain('x.org', mx(['mail.x.org', 10]))).toEqual({ status: 'not_found' });
    expect(await mxProviderDomain('x.org', mx(['.', 0]))).toEqual({ status: 'not_found' });
    expect(await mxProviderDomain('x.org', mx())).toEqual({ status: 'not_found' });
    expect(await mxProviderDomain('x.org', async () => { throw dnsError('ENOTFOUND'); })).toEqual({ status: 'not_found' });
    expect(await mxProviderDomain('x.org', async () => { throw dnsError('ENODATA'); })).toEqual({ status: 'not_found' });
  });

  it('reports an error when the DNS lookup fails', async () => {
    expect(await mxProviderDomain('x.org', async () => { throw dnsError('ESERVFAIL'); })).toEqual({ status: 'error' });
    expect(await mxProviderDomain('x.org', async () => { throw dnsError('ETIMEOUT'); })).toEqual({ status: 'error' });
  });
});

describe('fetchDomainAutoconfig', () => {
  const publicLookup = vi.fn(async () => [{ address: '195.201.81.10' }]);
  const served = (pages: Record<string, string>) =>
    vi.fn<FetchConfig>(async (url) => pages[url.origin + url.pathname] ?? null);
  const AUTOCONFIG = 'https://autoconfig.example.org/mail/config-v1.1.xml';
  const WELL_KNOWN = 'https://example.org/.well-known/autoconfig/mail/config-v1.1.xml';

  it('reads autoconfig.<domain> over HTTPS, passing the address and connecting to the vetted IP', async () => {
    const fetchConfig = served({ [AUTOCONFIG]: ISPDB_XML });
    const result = await fetchDomainAutoconfig('me@example.org', 'example.org', { lookup: publicLookup, fetchConfig });
    expect(result).toMatchObject({ status: 'found', settings: { imapHost: 'imap.example.org', imapPort: 993 } });
    const [url, address] = fetchConfig.mock.calls[0];
    expect(url.href).toBe(`${AUTOCONFIG}?emailaddress=me%40example.org`);
    expect(address).toBe('195.201.81.10');
  });

  it('falls back to the .well-known file on the domain', async () => {
    const fetchConfig = served({ [WELL_KNOWN]: ISPDB_XML });
    expect(await fetchDomainAutoconfig('me@example.org', 'example.org', { lookup: publicLookup, fetchConfig })).toMatchObject({ status: 'found' });
    expect(fetchConfig).toHaveBeenCalledTimes(2);
  });

  it('reports not-found (never an error) for missing files, HTML pages, unusable configs and failures', async () => {
    const opts = (fetchConfig: (url: URL) => Promise<string | null>) => ({ lookup: publicLookup, fetchConfig });
    expect(await fetchDomainAutoconfig('a@x.org', 'x.org', opts(async () => null))).toEqual({ status: 'not_found' });
    expect(await fetchDomainAutoconfig('a@x.org', 'x.org', opts(async () => '<html><body>404</body></html>'))).toEqual({ status: 'not_found' });
    expect(await fetchDomainAutoconfig('a@x.org', 'x.org', opts(async () => ISPDB_XML.replace(/SSL|STARTTLS/g, 'plain')))).toEqual({ status: 'not_found' });
    expect(await fetchDomainAutoconfig('a@x.org', 'x.org', opts(async () => { throw new Error('boom'); }))).toEqual({ status: 'not_found' });
    const unresolvable = async () => { throw dnsError('ENOTFOUND'); };
    expect(await fetchDomainAutoconfig('a@x.org', 'x.org', { lookup: unresolvable, fetchConfig: async () => ISPDB_XML })).toEqual({ status: 'not_found' });
  });

  it('does not contact hosts that resolve to private addresses', async () => {
    const fetchConfig = vi.fn(async () => ISPDB_XML);
    for (const address of ['127.0.0.1', '10.0.0.5', '::1', '169.254.169.254']) {
      const lookup = async () => [{ address: '195.201.81.10' }, { address }];
      expect(await fetchDomainAutoconfig('a@x.org', 'x.org', { lookup, fetchConfig })).toEqual({ status: 'not_found' });
    }
    expect(fetchConfig).not.toHaveBeenCalled();
  });

  it("fills %EMAILDOMAIN% with the user's domain when reading a provider's file", async () => {
    const xml = ISPDB_XML.replaceAll('imap.example.org', 'imap.%EMAILDOMAIN%');
    const fetchConfig = served({ ['https://autoconfig.provider.net/mail/config-v1.1.xml']: xml });
    const result = await fetchDomainAutoconfig('me@customer.org', 'provider.net', { lookup: publicLookup, fetchConfig });
    expect(result).toMatchObject({ status: 'found', settings: { imapHost: 'imap.customer.org' } });
  });

  it('skips the address check when private hosts are allowed', async () => {
    const lookup = vi.fn(async () => [{ address: '10.0.0.5' }]);
    const fetchConfig = vi.fn(async () => ISPDB_XML);
    const result = await fetchDomainAutoconfig('a@x.org', 'x.org', { allowPrivateHosts: true, lookup, fetchConfig });
    expect(result).toMatchObject({ status: 'found' });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchConfig).toHaveBeenCalledWith(expect.any(URL), undefined);
  });
});
