export const SIZES: number[];

export function encodePng(width: number, height: number, rgba: Buffer): Buffer;

export function downscaleBox(src: Buffer, srcSize: number, dstSize: number): Buffer;

export interface IcoImage {
  size: number;
  rgba: Buffer;
}

export function writeIco(images: IcoImage[]): Buffer;
