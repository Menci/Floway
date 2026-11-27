export interface MultipartFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}
