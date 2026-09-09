/**
 * vendor.d.ts — 无类型声明包的本地 ambient 声明（仅覆盖本引擎用到的面）。
 * pdf-parse 官方无 types 且必须走子路径入口（主入口 import 时会读测试文件）。
 */

declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfTextItem {
    str?: string;
    transform?: number[];
  }

  interface PdfPageData {
    getTextContent(opts: {
      normalizeWhitespace: boolean;
      disableCombineTextItems: boolean;
    }): Promise<{ items: PdfTextItem[] }>;
  }

  interface PdfParseOptions {
    pagerender?: (pageData: PdfPageData) => Promise<string>;
  }

  interface PdfParseResult {
    text?: string;
    numpages?: number;
    numrender?: number;
    info?: unknown;
    metadata?: unknown;
  }

  function pdfParse(data: Uint8Array, options?: PdfParseOptions): Promise<PdfParseResult>;

  export default pdfParse;
}

declare module 'ppt-to-text' {
  export interface PptPresentation {
    slides?: unknown[];
    docs?: unknown[];
  }

  export interface PptToTextUtils {
    to_text(pres: PptPresentation): string[];
    toTextString(pres: PptPresentation, separator?: string): string;
  }

  export interface PptToTextModule {
    extractText(input: string | Buffer, options?: { separator?: string }): string;
    readBuffer(buffer: Buffer, opts?: Record<string, unknown>): PptPresentation;
    utils: PptToTextUtils;
  }

  const pptToText: PptToTextModule;
  export default pptToText;
}

declare module 'word-extractor' {
  export interface WordExtractorDocument {
    getBody(): string;
    getHeaders(): string;
    getFooters(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getAnnotations(): string;
    getTextboxes(): string;
  }

  export default class WordExtractor {
    extract(input: string | Buffer): Promise<WordExtractorDocument>;
  }
}

declare module '@gutenye/ocr-node' {
  export interface OcrLine {
    text?: string;
    mean?: number;
    box?: number[][];
  }

  export interface OcrInstance {
    detect(input: string | Buffer): Promise<OcrLine[]>;
  }

  export interface OcrModelPaths {
    detectionPath: string;
    recognitionPath: string;
    dictionaryPath: string;
  }

  const Ocr: {
    create(options: { models: OcrModelPaths }): Promise<OcrInstance>;
  };

  export default Ocr;
}
