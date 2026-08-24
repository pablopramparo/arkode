import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/** Hashes bytes as they pass through, so downloading and checksumming cost one read, not two. */
export class HashingProgressTransform extends Transform {
  private readonly hash = createHash('sha256');
  bytesTransferred = 0;

  constructor(
    private readonly total: number,
    private readonly onProgress?: (transferred: number, total: number) => void
  ) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.bytesTransferred += chunk.length;
    this.onProgress?.(this.bytesTransferred, this.total);
    callback(null, chunk);
  }

  digestHex(): string {
    return this.hash.digest('hex');
  }
}
