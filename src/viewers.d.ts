/// <reference types="vite/client" />
declare module 'utif' {
  const UTIF: { decode(data: ArrayBuffer): any[]; decodeImage(data: ArrayBuffer, page: any): void; toRGBA8(page: any): Uint8Array }
  export default UTIF
}
