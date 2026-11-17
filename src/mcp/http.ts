import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import type { AppDeps } from '../app.js';
import { MCP_LABEL_RE, mcpUrl } from '../config.js';
import { findUserById } from '../db/users.js';
import { buildMcpServer } from './server.js';

const RESOURCE_NAME = 'IMAP Connector';

export function mcpRouter(deps: AppDeps): Router {
  const router = Router();

  // The challenge points each URL at its own metadata, so /mcp/<label> advertises itself as the resource.
  const authFor = (label?: string): RequestHandler =>
    requireBearerAuth({
      verifier: deps.provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl(deps.config, label)),
    });
  const auth = authFor();
  const labelled: RequestHandler = (req, res, next) => {
    const label = String(req.params.label);
    if (!MCP_LABEL_RE.test(label)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    authFor(label)(req, res, next);
  };

  const handle = async (req: Request, res: Response) => {
    const userId = Number(req.auth?.extra?.userId);
    const user = findUserById(deps.db, userId);
    if (!user) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Account no longer exists' });
      return;
    }
    const server = buildMcpServer(
      { db: deps.db, config: deps.config, pool: deps.pool, smtpFactory: deps.smtpFactory, mailGuard: deps.mailGuard, userId },
      user.permissionLevel,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  const notAllowed: RequestHandler = (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
  };

  // The SDK serves the metadata for /mcp itself; this covers /mcp/<label> (RFC 9728 path-specific metadata).
  router.all('/.well-known/oauth-protected-resource/mcp/:label', (req, res, next) => {
    const label = String(req.params.label);
    if (!MCP_LABEL_RE.test(label)) return next();
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS').set('Access-Control-Allow-Headers', '*').status(204).end();
      return;
    }
    if (req.method !== 'GET') {
      res.status(405).set('Allow', 'GET, OPTIONS').json({ error: 'Method not allowed' });
      return;
    }
    res.json({
      resource: mcpUrl(deps.config, label).href,
      authorization_servers: [new URL(deps.config.publicUrl.origin).href],
      resource_name: RESOURCE_NAME,
    });
  });

  const body = express.json({ limit: '1mb' });
  router.post('/mcp', auth, body, handle);
  router.all('/mcp', auth, notAllowed);
  router.post('/mcp/:label', labelled, body, handle);
  router.all('/mcp/:label', labelled, notAllowed);

  return router;
}
