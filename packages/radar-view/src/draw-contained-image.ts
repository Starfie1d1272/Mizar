export interface ContainedImageBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function drawContainedImage(
  context: Pick<CanvasRenderingContext2D, 'drawImage'>,
  image: HTMLImageElement,
  centerX: number,
  centerY: number,
  boxWidth: number,
  boxHeight: number,
): ContainedImageBounds | null {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0)
    return null;

  const scale = Math.min(boxWidth / image.naturalWidth, boxHeight / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const bounds = {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height);
  return bounds;
}
