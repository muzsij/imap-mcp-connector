import pkceChallenge from 'pkce-challenge';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { expectedEmailOf, mcpLabelOf } from '../../src/config.js';
import { createUser } from '../../src/db/users.js';
import { csrfFrom, signIn, testApp } from '../helpers/app.js';
import { testConfig } from '../helpers/config.js';
import { issueAccessToken } from '../helpers/oauth.js';

const REDIRECT = 'http://localhost:9999/callback';

describe('connector URL labels', () => {
  it('parses /mcp/<label> resources on this server only', () => {
    const config = testConfig();
    expect(mcpLabelOf(config, 'http://localhost:3000/mcp/work')).toBe('work');
    expect(mcpLabelOf(config, 'http://localhost:3000/mcp/Bob%40X.org')).toBe('Bob@X.org');
    expect(expectedEmailOf(config, 'http://localhost:3000/mcp/Bob@X.org')).toBe('bob@x.org');
    expect(expectedEmailOf(config, 'http://localhost:3000/mcp/work')).toBeNull();
    expect(mcpLabelOf(config, 'http://localhost:3000/mcp')).toBeNull();
    expect(mcpLabelOf(config, 'https://evil.example/mcp/work')).toBeNull();
    expect(mcpLabelOf(config, 'http://localhost:3000/mcp/a/b')).toBeNull();
    expect(mcpLabelOf(config, 'not a url')).toBeNull();
    expect(mcpLabelOf(config, null)).toBeNull();
  });

  it('publishes protected-resource metadata for a labelled URL', async () => {
    const { app } = testApp();
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp/bob@x.org');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body).toMatchObject({
      resource: 'http://localhost:3000/mcp/bob@x.org',
      authorization_servers: ['http://localhost:3000/'],
    });
    const plain = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(plain.body.resource).toBe('http://localhost:3000/mcp');
  });

  it('challenges an unauthenticated labelled request with its own metadata URL', async () => {
    const { app } = testApp();
    const res = await request(app).post('/mcp/work').send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp/work"',
    );
  });

  it('rejects labels with unexpected characters', async () => {
    const { app } = testApp();
    expect((await request(app).post('/mcp/a%20b').send({})).status).toBe(404);
  });

  it('serves MCP on a labelled URL with the token holder\'s account', async () => {
    const { app, deps } = testApp();
    const user = createUser(deps.db, {
      email: 'alice@x.org', imapHost: 'imap.x.org', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.x.org',
      smtpPort: 465, smtpSecurity: 'tls', smtpUsername: 'alice@x.org', imapPasswordEnc: 'x', settingsSource: 'discovered', autoSavesSent: false,
    });
    const token = await issueAccessToken(deps.provider, user.id);
    const res = await request(app)
      .post('/mcp/alice@x.org')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo).toBeDefined();
    expect((await request(app).get('/mcp/alice@x.org').set('Authorization', `Bearer ${token}`)).status).toBe(405);
  });

  async function authorizeFor(resource: string) {
    const { app } = testApp();
    const agent = request.agent(app);
    const reg = await agent.post('/register').send({ redirect_uris: [REDIRECT], client_name: 'Test AI', token_endpoint_auth_method: 'none' });
    const { code_challenge } = await pkceChallenge();
    const authorize = await agent.get('/authorize').query({
      response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT,
      code_challenge, code_challenge_method: 'S256', state: 's1', resource,
    });
    const consentUrl: string = authorize.headers.location;
    expect(consentUrl).toMatch(/^\/consent\?req=/);
    const reqId = new URL(consentUrl, 'http://x').searchParams.get('req')!;
    return { agent, consentUrl, reqId };
  }

  it('pre-fills the login form with the mailbox from the connector URL', async () => {
    const { agent, consentUrl } = await authorizeFor('http://localhost:3000/mcp/bob@x.org');
    const bounce = await agent.get(consentUrl);
    const login = await agent.get(bounce.headers.location);
    expect(login.text).toContain('value="bob@x.org"');
  });

  it('refuses to approve a /mcp/<email> connector for another signed-in account and lets the user switch', async () => {
    const { agent, consentUrl, reqId } = await authorizeFor('http://localhost:3000/mcp/bob@x.org');
    await signIn(agent, 'alice@x.org');

    const consent = await agent.get(consentUrl);
    expect(consent.status).toBe(200);
    expect(consent.text).toContain('set up for <strong>bob@x.org</strong>');
    expect(consent.text).not.toContain('value="approve"');

    const forced = await agent.post('/consent').type('form').send({ _csrf: csrfFrom(consent.text), req: reqId, decision: 'approve' });
    expect(forced.status).toBe(409);

    const page = await agent.get(consentUrl);
    const out = await agent.post('/logout').type('form').send({ _csrf: csrfFrom(page.text), next: consentUrl, email: 'bob@x.org' });
    expect(out.headers.location).toBe(`/login?${new URLSearchParams({ next: consentUrl, email: 'bob@x.org' })}`);
    const login = await agent.get(out.headers.location);
    expect(login.text).toContain('value="bob@x.org"');

    const signedIn = await signIn(agent, 'bob@x.org', consentUrl);
    expect(signedIn.headers.location).toBe(consentUrl);
    const bobConsent = await agent.get(consentUrl);
    expect(bobConsent.text).toContain('wants to access <strong>bob@x.org</strong>');
    const approved = await agent.post('/consent').type('form').send({ _csrf: csrfFrom(bobConsent.text), req: reqId, decision: 'approve' });
    expect(new URL(approved.headers.location).searchParams.get('code')).toBeTruthy();
  });

  it('offers a different account on a plain consent page', async () => {
    const { agent, consentUrl } = await authorizeFor('http://localhost:3000/mcp');
    await signIn(agent, 'alice@x.org');
    const consent = await agent.get(consentUrl);
    expect(consent.text).toContain('value="approve"');
    expect(consent.text).toContain('Use a different account');
  });
});
