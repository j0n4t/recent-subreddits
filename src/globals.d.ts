// Globals the userscript relies on that Tampermonkey injects at runtime.
// Declared for the type checker only — esbuild strips nothing here.
declare function GM_getValue(key: string, fallback?: any): any;
declare function GM_setValue(key: string, value: any): void;
declare function GM_xmlhttpRequest(details: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  onload?: (response: { responseText: string; status: number }) => void;
  onerror?: () => void;
}): void;
