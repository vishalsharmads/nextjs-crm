/** An image ready to send with a question: base64 without the `data:` prefix, plus a preview URL. */
export interface Attachment {
  id: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
  preview: string;
  name: string;
}

export const MAX_ATTACHMENTS = 3;
/** Longest side sent to the model: enough to read a screenshot, small enough to stay cheap. */
const MAX_SIDE = 1568;
/** Base64 characters per image the server accepts (the request as a whole is limited to 1 MB). */
const MAX_BASE64 = 700_000;
const KEEP_AS_IS = ['image/png', 'image/jpeg', 'image/webp'];

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.readAsDataURL(blob);
  });

function encode(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The image could not be read.'))),
      'image/jpeg',
      quality,
    ),
  );
}

/**
 * Shrinks an image so its longest side is at most 1568 px and it fits the size limit. A small
 * PNG, JPEG or WebP that already fits is sent as it is (screenshots stay sharp); anything else
 * becomes a JPEG, lowering quality until it fits.
 */
export async function prepareImage(file: File): Promise<Attachment> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} could not be opened as an image.`);
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = file.name || 'Screenshot';

  if (scale === 1 && KEEP_AS_IS.includes(file.type)) {
    const url = await toDataUrl(file);
    const data = url.slice(url.indexOf(',') + 1);
    if (data.length <= MAX_BASE64) {
      bitmap.close();
      return { id, mediaType: file.type as Attachment['mediaType'], data, preview: url, name };
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot prepare images.');
  // JPEG has no transparency: paint white behind it so transparent screenshots stay readable.
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.88, 0.75, 0.6, 0.45]) {
    const url = await toDataUrl(await encode(canvas, quality));
    const data = url.slice(url.indexOf(',') + 1);
    if (data.length <= MAX_BASE64) return { id, mediaType: 'image/jpeg', data, preview: url, name };
  }
  throw new Error(`${name} is too large, even after shrinking it.`);
}

/** Image files in a paste or a drop. */
export const imageFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
