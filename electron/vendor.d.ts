declare module 'word-extractor' {
  export default class WordExtractor {
    extract(file: string | Buffer): Promise<{ getBody(): string; getHeaders(): string; getFootnotes(): string; getEndnotes(): string }>
  }
}
