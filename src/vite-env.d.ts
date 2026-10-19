/// <reference types="vite/client" />

/**
 * Vite's `?inline` suffix returns an asset's contents as a string rather than a URL. The shared Agent
 * Debugger sources use it for their empty-state artwork, and `vite/client` declares the bare `*.png`
 * form only, so without this the import has no type.
 */
declare module '*.png?inline' {
  const src: string;
  export default src;
}
