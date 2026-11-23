import { Router, type RequestHandler, type Response } from 'express';
import type { AppDeps } from '../app.js';
import { claimDownload, deleteDownloadLink, peekDownloadLink, refundDownload, type DownloadLink } from '../db/downloads.js';
import { findUserById } from '../db/users.js';
import { log } from '../log.js';
import { toMailError } from '../mail/errors.js';
import { downloadAttachment } from '../mail/ops/attachment.js';

/** randomToken(32) in base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const CHARSET_RE = /^[A-Za-z0-9._:-]{1,40}$/;

/** Filenames come from the sender, so path separators and control characters are replaced. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  return cleaned || 'attachment';
}

/**
 * An ASCII filename for old clients plus the exact UTF-8 name (RFC 6266/8187). Always sending both avoids a bare
 * Latin-1 filename, which many HTTP clients decode wrongly.
 */
export function contentDisposition(filename: string): string {
  const name = safeFilename(filename);
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function setFileHeaders(res: Response, link: DownloadLink, charset?: string): void {
  res.set('Content-Disposition', contentDisposition(link.filename));
  const type = MIME_RE.test(link.contentType) ? link.contentType : 'application/octet-stream';
  const withCharset = charset && type.startsWith('text/') && CHARSET_RE.test(charset);
  res.set('Content-Type', withCharset ? `${type}; charset=${charset}` : type);
}

function notFound(res: Response): void {
  res.status(404).type('text/plain').send('This download link is invalid, expired or used up. Ask for a new link.');
}

/**
 * Serves the files behind get_attachment_link URLs. The token in the path is the only credential, so this router
 * handles its own errors and never passes the path to the app's error logger.
 */
export function downloadRouter(deps: AppDeps): Router {
  const router = Router();

  const headers: RequestHandler = (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
      // The file is the sender's content served from this origin: never let a browser run it here.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    next();
  };

  // Express answers HEAD with the GET route; HEAD only checks the link and does not use up a download.
  router.get('/dl/:token', headers, async (req, res) => {
    const token = String(req.params.token);
    const now = Date.now();
    if (!TOKEN_RE.test(token)) return notFound(res);

    if (req.method === 'HEAD') {
      const link = peekDownloadLink(deps.db, token, now);
      if (!link) return notFound(res);
      setFileHeaders(res, link);
      res.status(200).end();
      return;
    }

    const link = claimDownload(deps.db, token, now);
    if (!link) return notFound(res);
    const user = findUserById(deps.db, link.userId);
    if (!user) return notFound(res);

    let part;
    try {
      part = await deps.pool.withImap(user, (client) => downloadAttachment(client, link));
    } catch (err) {
      const mailError = toMailError(err);
      if (mailError?.code === 'NOT_FOUND') {
        deleteDownloadLink(deps.db, link.tokenHash);
        return notFound(res);
      }
      refundDownload(deps.db, link.tokenHash);
      log('warn', 'download failed', {
        requestId: res.locals.requestId,
        userId: user.id,
        error: mailError?.code ?? (err instanceof Error ? err.message : String(err)),
      });
      res.status(502).type('text/plain').send('The mail server could not provide this file right now. Try again shortly.');
      return;
    }
    // The folder's uids were reassigned: the uid may now name a different message.
    if (!part) {
      deleteDownloadLink(deps.db, link.tokenHash);
      return notFound(res);
    }

    setFileHeaders(res, link, part.charset);
    res.set('Content-Length', String(part.data.length));
    res.status(200).end(part.data);
  });

  router.all('/dl/:token', headers, (_req, res) => {
    res.status(405).set('Allow', 'GET, HEAD').type('text/plain').send('Method not allowed');
  });

  return router;
}
