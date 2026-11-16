import { Worker } from 'node:worker_threads';
import type { PdfJob, PdfJobResult } from './pdf-worker.js';

export interface PdfLimits {
  /** Wall-clock limit for one extraction; the worker is terminated when it is exceeded. */
  timeoutMs: number;
  maxPages: number;
  maxChars: number;
  /** V8 heap limit for the worker; exceeding it kills the worker, not the server. */
  maxHeapMb: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = { timeoutMs: 15_000, maxPages: 200, maxChars: 500_000, maxHeapMb: 256 };

/** How many PDFs may be parsed at the same time across all users; further requests wait for a free slot. */
const MAX_CONCURRENT = 2;

export class PdfTimeoutError extends Error {
  override name = 'PdfTimeoutError';
}

export class PdfExtractError extends Error {
  override name = 'PdfExtractError';
}

export type PdfText = PdfJobResult;

// In tests the sources run as .ts; in production the compiled .js sits next to this file.
const WORKER_URL = new URL(`./pdf-worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);

let running = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<() => void> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  return () => {
    running--;
    waiting.shift()?.();
  };
}

function runWorker(data: Uint8Array, limits: PdfLimits): Promise<PdfText> {
  return new Promise((resolve, reject) => {
    const job: PdfJob = { data, maxPages: limits.maxPages, maxChars: limits.maxChars };
    const worker = new Worker(WORKER_URL, {
      workerData: job,
      transferList: [data.buffer as ArrayBuffer],
      resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb },
      // Do not inherit the parent's Node flags (e.g. --input-type, inspector or loader flags) into the worker.
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new PdfTimeoutError(`PDF extraction exceeded ${limits.timeoutMs} ms`))),
      limits.timeoutMs,
    );
    worker.on('message', (msg: { ok: true; result: PdfText } | { ok: false; error: string }) =>
      finish(() => (msg.ok ? resolve(msg.result) : reject(new PdfExtractError(msg.error)))),
    );
    worker.on('error', (err) => finish(() => reject(new PdfExtractError(err.message))));
    worker.on('exit', (code) => finish(() => reject(new PdfExtractError(`PDF worker exited with code ${code}`))));
  });
}

/**
 * Extracts the text of a PDF in a separate worker thread with a timeout, a page and character cap and a heap limit,
 * so a malformed or hostile PDF cannot block or crash the server.
 */
export async function extractPdfText(buf: Buffer, limits: Partial<PdfLimits> = {}): Promise<PdfText> {
  const effective = { ...DEFAULT_PDF_LIMITS, ...limits };
  // Copy into a standalone buffer so it can be transferred to the worker without touching the caller's memory.
  const data = new Uint8Array(buf.byteLength);
  data.set(buf);
  const release = await acquireSlot();
  try {
    return await runWorker(data, effective);
  } finally {
    release();
  }
}
