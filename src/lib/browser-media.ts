const ACCEPTED_CHAT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp4", "application/pdf",
]);

const MAX_CHAT_FILE_BYTES = 50 * 1024 * 1024;

function isHeic(file: File) {
  return /\.(heic|heif)$/i.test(file.name) || /image\/(heic|heif)/i.test(file.type);
}

async function convertHeicToJpeg(file: File) {
  try {
    const heic2any = (await import("heic2any")).default;
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    const jpeg = Array.isArray(converted) ? converted[0] : converted;
    if (!(jpeg instanceof Blob)) throw new Error("The HEIC converter returned no image.");
    if (jpeg.size > MAX_CHAT_FILE_BYTES) throw new Error("The converted photo is over 50 MB. Choose a smaller image.");
    const filename = file.name.replace(/\.(heic|heif)$/i, "") || "photo";
    return new File([jpeg], `${filename}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  } catch (error) {
    if (error instanceof Error && error.message.includes("over 50 MB")) throw error;
  }

  let bitmap: ImageBitmap | null = null;
  let image: HTMLImageElement | null = null;
  let objectUrl: string | null = null;
  try {
    if (typeof createImageBitmap === "function") {
      try { bitmap = await createImageBitmap(file); } catch { /* Safari can decode through HTMLImageElement instead. */ }
    }
    if (!bitmap) {
      objectUrl = URL.createObjectURL(file);
      image = new Image();
      image.src = objectUrl;
      await image.decode();
    }
    const source = bitmap ?? image;
    if (!source) throw new Error("The image decoder was unavailable.");
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the image.");
    context.drawImage(source, 0, 0);
    const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The image could not be converted.")), "image/jpeg", 0.9));
    if (jpeg.size > MAX_CHAT_FILE_BYTES) throw new Error("The converted photo is over 50 MB. Choose a smaller image.");
    const filename = file.name.replace(/\.(heic|heif)$/i, "") || "photo";
    return new File([jpeg], `${filename}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    throw new Error("This photo format could not be opened. Choose a JPG, PNG, or WebP image, or export the iPhone photo as JPEG and attach it again.");
  } finally {
    bitmap?.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export async function prepareChatFile(file: File) {
  if (file.size > MAX_CHAT_FILE_BYTES) throw new Error("Each chat attachment must be 50 MB or smaller.");
  const prepared = isHeic(file) ? await convertHeicToJpeg(file) : file;
  const normalizedType = prepared.type || "application/octet-stream";
  if (!ACCEPTED_CHAT_TYPES.has(normalizedType)) {
    throw new Error("This photo format could not be opened. Choose a JPG, PNG, or WebP image. Chat also accepts GIF, MP4, WebM, QuickTime video, MP3, M4A, and PDF.");
  }
  return prepared;
}

export function fileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("This file could not be read. Try choosing it again."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("This file could not be read."));
    reader.readAsDataURL(file);
  });
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
