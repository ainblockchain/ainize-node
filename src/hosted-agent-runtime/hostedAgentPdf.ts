/**
 * A PDF an agent opens, made into something a model can read.
 *
 * Until now a PDF was "not text and not a picture", so the model got its name and size and nothing else — and an
 * agent that offered to summarise a quote in `견적서.pdf` could not. Two kinds of PDF, two answers:
 *
 *   • a PDF with a text layer (most of them: anything exported from a word processor) → its text, page by page;
 *   • a scanned PDF — pages that are pictures of paper, with no text to extract → its first pages rendered as
 *     images, which a multimodal model (Qwen3.8-Flash-Next) reads the way it reads a photo.
 *
 * Rendering needs a canvas (`@napi-rs/canvas`, a prebuilt native module). It is imported only when a scanned PDF
 * needs it, and a runtime without it still reads text PDFs and says plainly that it cannot render the rest.
 *
 * Self-contained like the rest of this directory: its dependencies (`unpdf`, `@napi-rs/canvas`) are in the node's
 * package.json and in the container runtime's (hosted-agent-docker.ts).
 */

/** How much text the model is given, like any text attachment. */
const HOSTED_AGENT_PDF_TEXT_CHARS = 20_000;
/** Pages rendered for a scanned PDF: enough to answer about a receipt or a contract's first pages. */
const HOSTED_AGENT_PDF_RENDER_PAGES = 3;
/** Rendered width in pixels — legible text for a vision model, without megabytes per page. */
const HOSTED_AGENT_PDF_RENDER_WIDTH = 1400;
/** Below this many characters of text per page, the pages are treated as pictures (scans, a stray page number). */
const HOSTED_AGENT_PDF_MIN_CHARS_PER_PAGE = 40;

export const isHostedAgentPdf = (mime: string, name: string): boolean => /^application\/(x-)?pdf$/i.test(mime) || /\.pdf$/i.test(name);

export interface HostedAgentPdfReading {
  pages: number;
  text: string;
  truncated: boolean;
  /** `data:image/png;base64,…` — present only for a scanned PDF, the pages the model should look at */
  images: string[];
  note: string;
}

export async function hostedAgentReadPdf(bytes: Uint8Array): Promise<HostedAgentPdfReading> {
  const { extractText, getDocumentProxy, renderPageAsImage } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(/password/i.test(why) ? 'the PDF is password-protected' : `the PDF could not be opened (${why})`);
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((t) => t.trim());
  const joined = pages.map((t, i) => (t ? `[page ${i + 1}]\n${t}` : '')).filter(Boolean).join('\n\n');
  const truncated = joined.length > HOSTED_AGENT_PDF_TEXT_CHARS;
  const readable = joined.length >= HOSTED_AGENT_PDF_MIN_CHARS_PER_PAGE * Math.min(totalPages, 3);
  if (readable) {
    return {
      pages: totalPages, text: truncated ? joined.slice(0, HOSTED_AGENT_PDF_TEXT_CHARS) : joined, truncated, images: [],
      note: truncated ? `Text of a ${totalPages}-page PDF, cut to its first ${HOSTED_AGENT_PDF_TEXT_CHARS} characters.` : `Text of a ${totalPages}-page PDF.`,
    };
  }
  // A scan: no text worth the name. Show the first pages as pictures instead.
  const count = Math.min(totalPages, HOSTED_AGENT_PDF_RENDER_PAGES);
  const images: string[] = [];
  try {
    for (let n = 1; n <= count; n++) {
      const page = await pdf.getPage(n);
      const width = page.getViewport({ scale: 1 }).width || 600;
      const png = await renderPageAsImage(pdf, n, {
        canvasImport: () => import('@napi-rs/canvas'),
        scale: Math.min(3, HOSTED_AGENT_PDF_RENDER_WIDTH / width),
      });
      images.push(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    }
  } catch (e) {
    return {
      pages: totalPages, text: joined, truncated: false, images: [],
      note: `A ${totalPages}-page PDF with no text layer (a scan), and its pages could not be rendered here (${e instanceof Error ? e.message : String(e)}): describe it from its name and size.`,
    };
  }
  return {
    pages: totalPages, text: joined, truncated: false, images,
    note: `A scanned ${totalPages}-page PDF with no text layer: its first ${count} page(s) are shown to you as pictures in the next message — read them there.`,
  };
}
