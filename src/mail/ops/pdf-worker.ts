// Runs PDF text extraction off the main thread, so a slow or hostile PDF cannot block the server: the parent
// enforces a timeout and terminates this worker. Keep this file free of imports from the project (Node may load it
// directly as .ts in tests) and of non-erasable TypeScript syntax.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

export interface PdfJob {
  data: Uint8Array;
  maxPages: number;
  /** Stop reading further pages once this many characters were collected. */
  maxChars: number;
}

export interface PdfJobResult {
  text: string;
  totalPages: number;
  pagesRead: number;
}

/** Same whitespace normalization as unpdf's extractText({ mergePages: true }). */
function normalize(texts: string[]): string {
  return texts.join('\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
}

async function run(job: PdfJob): Promise<PdfJobResult> {
  const pdf = await getDocumentProxy(job.data, {
    // Text extraction needs no font loading or XFA forms; turn them off to shrink the attack surface.
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
  });
  try {
    const texts: string[] = [];
    let chars = 0;
    const last = Math.min(pdf.numPages, job.maxPages);
    let page = 1;
    // Pages are read one at a time (unpdf's extractText loads all of them at once).
    for (; page <= last && chars < job.maxChars; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('');
      texts.push(text);
      chars += text.length;
    }
    return { text: normalize(texts), totalPages: pdf.numPages, pagesRead: page - 1 };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

run(workerData as PdfJob).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (err: unknown) => parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
