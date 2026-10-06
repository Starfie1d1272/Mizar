export interface ContainedImageBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function drawContainedImage(
  context: Pick<CanvasRenderingContext2D, 'drawImage'>,
  image: HTMLImageElement | HTMLCanvasElement,
  centerX: number,
  centerY: number,
  boxWidth: number,
  boxHeight: number,
): ContainedImageBounds | null {
  const naturalWidth = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const naturalHeight = 'naturalHeight' in image ? image.naturalHeight : image.height;
  if (naturalWidth <= 0 || naturalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) return null;

  const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  const bounds = {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height);
  return bounds;
}
