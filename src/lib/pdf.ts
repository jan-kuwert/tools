import type { PDFDocument } from '@cantoo/pdf-lib';
import { sniff, UserError } from './tool';

export interface LoadedPdf {
  doc: PDFDocument;
  hasSignature: boolean;
}

export async function loadPdf(file: Blob & { name?: string }): Promise<LoadedPdf> {
  const label = file.name ? `“${file.name}”` : 'This file';
  if ((await sniff(file)) !== 'pdf') throw new UserError(`${label} is not a PDF.`);
  // Dynamic: pdf-lib is ~500 KB; keep first paint instant.
  const { PDFDocument, PDFName, PDFNumber, PDFDict, PDFSignature } = await import('@cantoo/pdf-lib');
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  } catch {
    throw new UserError(`${label} could not be read. It may be damaged.`);
  }
  if (doc.isEncrypted) throw new UserError('This PDF is password-protected or encrypted. Remove the protection first.');

  let hasSignature = false;
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acro) {
    const flags = acro.lookupMaybe(PDFName.of('SigFlags'), PDFNumber);
    hasSignature = (flags?.asNumber() ?? 0) > 0;
    if (!hasSignature) {
      try {
        hasSignature = doc.getForm().getFields().some((f) => f instanceof PDFSignature);
      } catch {
        // Malformed form: ignore, signature detection is advisory only.
      }
    }
  }
  return { doc, hasSignature };
}

/** "1-3, 5, 8-" → [[0,1,2],[4],[7..last]] (0-based). */
export function parseRanges(input: string, pageCount: number): number[][] {
  const parts = input.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new UserError('Enter at least one page or range, e.g. 1-3, 5.');
  return parts.map((part) => {
    const m = /^(\d*)\s*(?:(-)\s*(\d*))?$/.exec(part);
    if (!m) throw new UserError(`“${part}” is not a valid page or range.`);
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? (m[3] ? Number(m[3]) : pageCount) : start;
    if (start < 1 || end > pageCount || start > pageCount)
      throw new UserError(`“${part}” is outside the document (pages 1–${pageCount}).`);
    if (start > end) throw new UserError(`“${part}” runs backwards; write it as ${end}-${start}.`);
    return Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
  });
}

export const pdfBlob = (bytes: Uint8Array): Blob => new Blob([bytes as BlobPart], { type: 'application/pdf' });

export const SIGNATURE_NOTE = 'The original contained digital signatures; they are not valid in this copy.';
