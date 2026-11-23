import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../../src/crypto.js';
import {
  claimDownload, createDownloadLink, deleteDownloadLink, peekDownloadLink, refundDownload, type NewDownloadLink,
} from '../../src/db/downloads.js';
import { purgeExpired } from '../../src/db/purge.js';
import { deleteUser } from '../../src/db/users.js';
import { contentDisposition } from '../../src/web/download.js';
import { testApp } from '../helpers/app.js';
import { createTestUser, testDb } from '../helpers/db.js';

function link(userId: number, overrides: Partial<NewDownloadLink> = {}): NewDownloadLink {
  return {
    userId, folder: 'INBOX', uid: 7, uidValidity: '123', partId: '2', filename: 'a.pdf', contentType: 'application/pdf',
    maxDownloads: 2, createdAt: 100, expiresAt: 1000, ...overrides,
  };
}

const count = (db: ReturnType<typeof testDb>) =>
  (db.prepare('SELECT COUNT(*) AS n FROM download_links').get() as { n: number }).n;

describe('download links', () => {
  it('stores only the hash and allows the set number of downloads', () => {
    const db = testDb();
    const u = createTestUser(db);
    const token = createDownloadLink(db, link(u.id));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.prepare('SELECT token_hash FROM download_links').get()).toEqual({ token_hash: hashToken(token) });

    expect(peekDownloadLink(db, token, 500)?.downloadsLeft).toBe(2);
    expect(claimDownload(db, token, 500)).toMatchObject({ folder: 'INBOX', uid: 7, partId: '2', downloadsLeft: 1 });
    expect(claimDownload(db, token, 500)?.downloadsLeft).toBe(0);
    expect(claimDownload(db, token, 500)).toBeNull();
    expect(peekDownloadLink(db, token, 500)).toBeNull();

    refundDownload(db, hashToken(token));
    expect(claimDownload(db, token, 500)?.downloadsLeft).toBe(0);
  });

  it('rejects expired, unknown and deleted links', () => {
    const db = testDb();
    const u = createTestUser(db);
    const token = createDownloadLink(db, link(u.id));
    expect(claimDownload(db, token, 1000)).toBeNull();
    expect(claimDownload(db, 'x'.repeat(43), 500)).toBeNull();
    deleteDownloadLink(db, hashToken(token));
    expect(claimDownload(db, token, 500)).toBeNull();
  });

  it('is purged when expired and deleted with its user', () => {
    const db = testDb();
    const u = createTestUser(db);
    createDownloadLink(db, link(u.id, { expiresAt: 10 }));
    createDownloadLink(db, link(u.id, { expiresAt: 10_000 }));
    purgeExpired(db, 5000);
    expect(count(db)).toBe(1);
    deleteUser(db, u.id);
    expect(count(db)).toBe(0);
  });
});

describe('contentDisposition', () => {
  it('neutralises quotes, separators and control characters', () => {
    expect(contentDisposition('a"b\\c/d\r\n.txt')).toBe(`attachment; filename="a_b_c_d__.txt"; filename*=UTF-8''a%22b_c_d__.txt`);
    expect(contentDisposition('  ')).toBe(`attachment; filename="attachment"; filename*=UTF-8''attachment`);
  });
});

describe('GET /dl/:token', () => {
  it('answers 404 for malformed, unknown and expired tokens without touching the mail server', async () => {
    const { app, deps } = testApp();
    const u = createTestUser(deps.db);
    const expired = createDownloadLink(deps.db, link(u.id, { expiresAt: Date.now() - 1 }));
    for (const path of ['/dl/short', `/dl/${'a'.repeat(43)}`, `/dl/${expired}`]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toMatch(/expired or used up/);
    }
  });

  it('answers HEAD from the link alone, without using up a download', async () => {
    const { app, deps } = testApp();
    const u = createTestUser(deps.db);
    const token = createDownloadLink(deps.db, link(u.id, { filename: 'Számla 1/2.pdf', expiresAt: Date.now() + 60_000 }));
    const res = await request(app).head(`/dl/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="Sz_mla 1_2.pdf"; filename*=UTF-8''Sz%C3%A1mla%201_2.pdf`);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(peekDownloadLink(deps.db, token, Date.now())?.downloadsLeft).toBe(2);
  });

  it('refuses other methods', async () => {
    const { app } = testApp();
    const res = await request(app).post(`/dl/${'a'.repeat(43)}`);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });
});
