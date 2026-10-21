export type QrRenderOptions = {
  margin?: number;
};

export declare function encodeQrMatrix(text: string): boolean[][];
export declare function renderTerminalQr(text: string | boolean[][], options?: QrRenderOptions): string;
export declare function renderSvgQrDataUrl(text: string | boolean[][], options?: QrRenderOptions): string;
export declare function parseTerminalQrMatrix(rendered: string): boolean[][];
export declare function decodeQrMatrix(matrix: boolean[][]): string;
export declare function decodeTerminalQr(rendered: string): string;
