import { hashToken, randomToken } from '../crypto.js';
import type { Db } from './index.js';

/** How long a download link works, and how many times it can be fetched (enough for a retry, not for sharing). */
export const DOWNLOAD_LINK_TTL_MS = 15 * 60 * 1000;
export const DOWNLOAD_LINK_MAX_USES = 3;

export interface NewDownloadLink {
  userId: number;
  folder: string;
  uid: number;
  uidValidity: string;
  partId: string;
  filename: string;
  contentType: string;
  maxDownloads: number;
  createdAt: number;
  expiresAt: number;
}

export interface DownloadLink {
  tokenHash: string;
  userId: number;
  folder: string;
  uid: number;
  uidValidity: string;
  partId: string;
  filename: string;
  contentType: string;
  downloadsLeft: number;
  expiresAt: number;
}

interface Row {
  token_hash: string;
  user_id: number;
  folder: string;
  uid: number;
  uid_validity: string;
  part_id: string;
  filename: string;
  content_type: string;
  downloads_left: number;
  expires_at: number;
}

function fromRow(row: Row): DownloadLink {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    folder: row.folder,
    uid: row.uid,
    uidValidity: row.uid_validity,
    partId: row.part_id,
    filename: row.filename,
    contentType: row.content_type,
    downloadsLeft: row.downloads_left,
    expiresAt: row.expires_at,
  };
}

/** Stores a new link and returns its token; only the token's hash is kept. */
export function createDownloadLink(db: Db, link: NewDownloadLink): string {
  const token = randomToken();
  db.prepare(
    `INSERT INTO download_links
       (token_hash, user_id, folder, uid, uid_validity, part_id, filename, content_type, downloads_left, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token), link.userId, link.folder, link.uid, link.uidValidity, link.partId, link.filename,
    link.contentType, link.maxDownloads, link.createdAt, link.expiresAt,
  );
  return token;
}

/** A link that is still valid, without using up a download. */
export function peekDownloadLink(db: Db, token: string, now: number): DownloadLink | null {
  const row = db
    .prepare('SELECT * FROM download_links WHERE token_hash = ? AND expires_at > ? AND downloads_left > 0')
    .get(hashToken(token), now) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Atomically uses up one download of a valid link; null when the link is unknown, expired or used up. */
export function claimDownload(db: Db, token: string, now: number): DownloadLink | null {
  const row = db
    .prepare(
      `UPDATE download_links SET downloads_left = downloads_left - 1
       WHERE token_hash = ? AND expires_at > ? AND downloads_left > 0
       RETURNING *`,
    )
    .get(hashToken(token), now) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Gives a download back when it failed before any byte was sent. */
export function refundDownload(db: Db, tokenHash: string): void {
  db.prepare('UPDATE download_links SET downloads_left = downloads_left + 1 WHERE token_hash = ?').run(tokenHash);
}

/** Ends a link early, e.g. when the message it points at is gone. */
export function deleteDownloadLink(db: Db, tokenHash: string): void {
  db.prepare('DELETE FROM download_links WHERE token_hash = ?').run(tokenHash);
}
