export interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

export function decodePng(buffer: Buffer): DecodedPng;
