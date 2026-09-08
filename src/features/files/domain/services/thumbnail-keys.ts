type ThumbnailCandidatesInput = {
  fileId: string;
  version: number;
  size: number;
  thumbnailKey: string | null;
};

export function versionedThumbnailKey(
  fileId: string,
  version: number,
  size: number,
): string {
  return `thumbnails/${fileId}/v${version}/${size}.webp`;
}

export function thumbnailCandidates(input: ThumbnailCandidatesInput): string[] {
  const keys = [versionedThumbnailKey(input.fileId, input.version, input.size)];
  if (input.thumbnailKey && !keys.includes(input.thumbnailKey)) {
    keys.push(input.thumbnailKey);
  }
  keys.push(`thumbnails/${input.fileId}_${input.size}.webp`);
  keys.push(`thumbnails/${input.fileId}.jpg`);
  return [...new Set(keys)];
}
