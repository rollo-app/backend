/** Makes the URLs the phone uses to talk straight to the bucket (so files never go through the Worker). */
export interface Presigner {
  /** URL for a PUT. With a `size` it only accepts a body of exactly that many bytes; without it the size is not limited. */
  putUrl(key: string, opts: { origin: string; size: number | null; expiresIn: number }): Promise<string>;
  getUrl(key: string, expiresIn: number): Promise<string>;
}
