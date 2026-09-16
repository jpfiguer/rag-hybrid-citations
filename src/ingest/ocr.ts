import { Mistral } from "@mistralai/mistralai";

export type OcrPage = {
  index: number;      // 0-based
  pageNumber: number; // 1-based
  markdown: string;
};

export type OcrResult = {
  pages: OcrPage[];
  pageCount: number;
};

let client: Mistral | null = null;
function getClient() {
  if (!client) client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
  return client;
}

/**
 * Mistral OCR handles both digital PDFs and scans, returning markdown per page.
 * For an academic corpus it beats mixing pdfjs + a separate OCR pass because the
 * output is uniform — same structure, same header treatment — which is what the
 * chunker's sectionPath detection depends on.
 */
export async function runOcr(documentUrl: string): Promise<OcrResult> {
  const mistral = getClient();
  const response = await mistral.ocr.process({
    model: "mistral-ocr-latest",
    document: { type: "document_url", documentUrl },
    includeImageBase64: false,
  });

  const pages: OcrPage[] = (response.pages ?? []).map((p) => ({
    index: p.index,
    pageNumber: p.index + 1,
    markdown: (p.markdown ?? "").trim(),
  }));

  return { pages, pageCount: pages.length };
}
