import { describe, expect, it } from 'vitest';
import { extractPdfText, PdfExtractError, PdfTimeoutError } from '../../src/mail/ops/pdf.js';
import { tinyPdf } from '../helpers/pdf.js';

describe('extractPdfText', () => {
  it('extracts the text of every page in a worker thread', async () => {
    const result = await extractPdfText(tinyPdf(['First page', 'Second page']));
    expect(result).toMatchObject({ totalPages: 2, pagesRead: 2 });
    expect(result.text).toContain('First page');
    expect(result.text).toContain('Second page');
  });

  it('leaves the caller buffer intact (the worker gets a copy)', async () => {
    const buf = tinyPdf('Keep me');
    const before = Buffer.from(buf);
    await extractPdfText(buf);
    expect(buf.equals(before)).toBe(true);
  });

  it('stops after maxPages', async () => {
    const result = await extractPdfText(tinyPdf(['One', 'Two', 'Three']), { maxPages: 2 });
    expect(result).toMatchObject({ totalPages: 3, pagesRead: 2 });
    expect(result.text).toContain('Two');
    expect(result.text).not.toContain('Three');
  });

  it('stops reading pages once maxChars is reached', async () => {
    const result = await extractPdfText(tinyPdf(['Long enough page', 'Never read']), { maxChars: 5 });
    expect(result.pagesRead).toBe(1);
    expect(result.text).not.toContain('Never read');
  });

  it('terminates the worker and rejects when the time limit is exceeded', async () => {
    await expect(extractPdfText(tinyPdf('Slow'), { timeoutMs: 1 })).rejects.toBeInstanceOf(PdfTimeoutError);
  });

  it('rejects corrupt PDFs without affecting the caller', async () => {
    await expect(extractPdfText(Buffer.from('%PDF-1.4 garbage'))).rejects.toBeInstanceOf(PdfExtractError);
  });

  it('keeps working after timeouts (slots are released)', async () => {
    await Promise.all([1, 2, 3].map(() => extractPdfText(tinyPdf('x'), { timeoutMs: 1 }).catch(() => undefined)));
    await expect(extractPdfText(tinyPdf('Still fine'))).resolves.toMatchObject({ pagesRead: 1 });
  });
});
