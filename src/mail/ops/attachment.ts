import type { ImapFlow } from 'imapflow';
import { MailError } from '../errors.js';
import { htmlToText, truncateUtf8 } from '../format.js';
import { resolveFolder } from './folders.js';
import { downloadPart, scanStructure, type AttachmentInfo, type DownloadedPart } from './message.js';
import { extractPdfText, PdfTimeoutError } from './pdf.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Download links hand over the original bytes without parsing them, so they allow larger files. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export interface AttachmentContent {
  filename: string;
  contentType: string;
  size: number;
  text: string | null;
  truncated: boolean;
  note?: string;
}

type TextKind = 'text' | 'html' | 'pdf';

function textKind(contentType: string, filename: string): TextKind | null {
  const type = contentType.toLowerCase();
  if (type === 'text/html') return 'html';
  if (type.startsWith('text/') || ['application/json', 'application/xml', 'application/csv'].includes(type)) return 'text';
  if (type === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) return 'pdf';
  return null;
}

/** Decodes bytes with the declared charset, falling back to UTF-8 for missing or unsupported labels. */
function decodeText(buf: Buffer, charset?: string): string {
  try {
    return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

/** Looks up one attachment of a message; the folder must already be selected (caller holds the mailbox lock). */
async function findAttachment(client: ImapFlow, folder: string, uid: number, partId: string): Promise<AttachmentInfo> {
  const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
  if (!msg || !msg.bodyStructure) throw new MailError('NOT_FOUND', `Message ${uid} was not found in ${folder}.`);
  const info = scanStructure(msg.bodyStructure).attachments.find((a) => a.partId === partId);
  if (!info) throw new MailError('NOT_FOUND', `Attachment part ${partId} was not found. Use get_message to list attachments.`);
  return info;
}

function currentUidValidity(client: ImapFlow): string {
  return client.mailbox ? String(client.mailbox.uidValidity) : '';
}

/** Where an attachment lives, pinned to the mailbox's UIDVALIDITY so a later download cannot hit a different message. */
export interface AttachmentRef {
  folder: string;
  uid: number;
  uidValidity: string;
  partId: string;
  filename: string;
  contentType: string;
  size: number;
}

/** Checks that an attachment exists and is small enough to download, and returns a stable reference to it. */
export async function locateAttachment(
  client: ImapFlow,
  folderInput: string,
  uid: number,
  partId: string,
): Promise<AttachmentRef> {
  const folder = await resolveFolder(client, folderInput);
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const info = await findAttachment(client, folder, uid, partId);
    if (info.size > MAX_DOWNLOAD_BYTES) {
      throw new MailError('TOO_LARGE', `Attachment is larger than the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB download limit.`);
    }
    return {
      folder, uid, uidValidity: currentUidValidity(client), partId,
      filename: info.filename, contentType: info.contentType, size: info.size,
    };
  } finally {
    lock.release();
  }
}

/**
 * Downloads an attachment's decoded bytes. Returns null when the folder's uids were reassigned since the reference
 * was made (UIDVALIDITY changed); throws NOT_FOUND when the message or part is gone.
 */
export async function downloadAttachment(
  client: ImapFlow,
  ref: Pick<AttachmentRef, 'folder' | 'uid' | 'uidValidity' | 'partId'>,
): Promise<DownloadedPart | null> {
  const lock = await client.getMailboxLock(ref.folder, { readOnly: true });
  try {
    if (currentUidValidity(client) !== ref.uidValidity) return null;
    await findAttachment(client, ref.folder, ref.uid, ref.partId);
    return await downloadPart(client, ref.uid, ref.partId, MAX_DOWNLOAD_BYTES);
  } finally {
    lock.release();
  }
}

export async function getAttachment(
  client: ImapFlow,
  folderInput: string,
  uid: number,
  partId: string,
): Promise<AttachmentContent> {
  const folder = await resolveFolder(client, folderInput);
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const info = await findAttachment(client, folder, uid, partId);
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new MailError('TOO_LARGE', `Attachment is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`);
    }
    const base = { filename: info.filename, contentType: info.contentType, size: info.size };
    const kind = textKind(info.contentType, info.filename);
    if (!kind) return { ...base, text: null, truncated: false, note: 'Binary attachment; content not extracted.' };

    const { data, charset } = await downloadPart(client, uid, partId, MAX_ATTACHMENT_BYTES);
    let raw: string;
    let note: string | undefined;
    if (kind === 'pdf') {
      try {
        const pdf = await extractPdfText(data);
        raw = pdf.text;
        if (pdf.pagesRead < pdf.totalPages) note = `Only the first ${pdf.pagesRead} of ${pdf.totalPages} pages were read.`;
      } catch (err) {
        const reason =
          err instanceof PdfTimeoutError ? 'took too long to read' : 'could not be read (corrupt or password-protected)';
        return { ...base, text: null, truncated: false, note: `PDF ${reason}.` };
      }
    } else {
      // Use the charset imapflow reports for the downloaded bytes, not the declared one: imapflow has already
      // converted inline text parts to UTF-8 (and then reports 'utf-8'); attachments keep their declared charset.
      const decoded = decodeText(data, charset);
      raw = kind === 'html' ? htmlToText(decoded) : decoded;
    }
    const { text, truncated } = truncateUtf8(raw);
    return { ...base, text, truncated, ...(note ? { note } : {}) };
  } finally {
    lock.release();
  }
}
