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
 * Mistral OCR procesa tanto PDFs digitales como escaneos y devuelve markdown
 * por página. Para corpus académico es preferible a mezclar pdfjs + OCR porque
 * el output es uniforme (misma estructura, mismo tratamiento de headers).
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
