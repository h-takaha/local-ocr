export const MAX_LONG_EDGE = 3000;
export const HIGH_ACCURACY_MIN_LONG_EDGE = 1800;
export const HIGH_ACCURACY_MAX_UPSCALE = 3;

function assertDimensions(width, height) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError("画像サイズが不正です。");
  }
}

export function calculateOutputSize(sourceWidth, sourceHeight, highAccuracy = false) {
  assertDimensions(sourceWidth, sourceHeight);
  const longEdge = Math.max(sourceWidth, sourceHeight);
  let scale = Math.min(1, MAX_LONG_EDGE / longEdge);

  if (highAccuracy && longEdge < HIGH_ACCURACY_MIN_LONG_EDGE) {
    scale = Math.min(
      HIGH_ACCURACY_MAX_UPSCALE,
      HIGH_ACCURACY_MIN_LONG_EDGE / longEdge,
      MAX_LONG_EDGE / longEdge,
    );
  }

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function findContrastRange(histogram, pixelCount) {
  const trimCount = Math.floor(pixelCount * 0.01);
  let cumulative = 0;
  let low = 0;
  for (; low < 255; low += 1) {
    cumulative += histogram[low];
    if (cumulative > trimCount) break;
  }

  cumulative = 0;
  const highTarget = pixelCount - trimCount;
  let high = 255;
  for (let value = 0; value <= 255; value += 1) {
    cumulative += histogram[value];
    if (cumulative >= highTarget) {
      high = value;
      break;
    }
  }

  if (high - low < 16) {
    return { low: 0, high: 255 };
  }
  return { low, high };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function enhanceRgbaForOcr(rgba, width, height) {
  assertDimensions(width, height);
  const pixelCount = Math.round(width) * Math.round(height);
  if (!(rgba instanceof Uint8ClampedArray) || rgba.length !== pixelCount * 4) {
    throw new TypeError("RGBA画像データが不正です。");
  }

  const grayscale = new Uint8ClampedArray(pixelCount);
  const histogram = new Uint32Array(256);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const value = (77 * rgba[offset] + 150 * rgba[offset + 1] + 29 * rgba[offset + 2]) >> 8;
    grayscale[pixel] = value;
    histogram[value] += 1;
  }

  const { low, high } = findContrastRange(histogram, pixelCount);
  const contrastScale = 255 / (high - low);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    grayscale[pixel] = clampByte((grayscale[pixel] - low) * contrastScale);
  }

  const imageWidth = Math.round(width);
  const imageHeight = Math.round(height);
  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const pixel = y * imageWidth + x;
      const center = grayscale[pixel];
      const left = x > 0 ? grayscale[pixel - 1] : center;
      const right = x + 1 < imageWidth ? grayscale[pixel + 1] : center;
      const up = y > 0 ? grayscale[pixel - imageWidth] : center;
      const down = y + 1 < imageHeight ? grayscale[pixel + imageWidth] : center;
      const sharpened = 1.6 * center - 0.15 * (left + right + up + down);
      const output = clampByte(sharpened);
      const offset = pixel * 4;
      rgba[offset] = output;
      rgba[offset + 1] = output;
      rgba[offset + 2] = output;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}
