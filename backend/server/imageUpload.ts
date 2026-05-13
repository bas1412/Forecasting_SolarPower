import fs from "node:fs/promises";
import path from "node:path";
import { storagePut } from "./storage";
import { createSkyImage, createCloudDetection } from "./db";
import { mirrorImageRecord } from "./researchMirror";
import { nanoid } from "nanoid";

interface ImageUploadInput {
  imageData: string; // Base64 encoded image
  mimeType: string; // e.g., "image/jpeg"
  cloudCoveragePercent?: number;
  cloudVectorData?: string | null;
}

interface ImageUploadResult {
  success: boolean;
  imageId?: number;
  cloudDetectionId?: number;
  imageUrl?: string;
  fileKey?: string;
  error?: string;
}

const LOCAL_UPLOAD_ROOT = path.resolve(import.meta.dirname, "..", "uploaded-images");

/**
 * Convert base64 string to Buffer
 */
function base64ToBuffer(base64String: string): Buffer {
  // Remove data URI prefix if present (e.g., "data:image/jpeg;base64,")
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(base64Data, "base64");
}

/**
 * Get MIME type extension
 */
function getMimeTypeExtension(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return mimeToExt[mimeType] || "jpg";
}

async function saveImageLocally(fileKey: string, imageBuffer: Buffer) {
  const normalizedKey = fileKey.replace(/\\/g, "/");
  const destinationPath = path.join(LOCAL_UPLOAD_ROOT, normalizedKey);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, imageBuffer);

  return {
    key: normalizedKey,
    url: `/uploads/${normalizedKey}`,
  };
}

async function uploadOrFallbackToLocalFile(
  fileKey: string,
  imageBuffer: Buffer,
  mimeType: string,
  originalImageData: string
) {
  try {
    return await storagePut(fileKey, imageBuffer, mimeType);
  } catch (error) {
    console.warn(
      "[ImageUpload] Storage unavailable, falling back to local file storage:",
      error
    );

    try {
      return await saveImageLocally(fileKey, imageBuffer);
    } catch (localError) {
      console.warn(
        "[ImageUpload] Local file storage failed, falling back to in-memory data URL:",
        localError
      );

      const base64Data = originalImageData.replace(/^data:image\/\w+;base64,/, "");
      return {
        key: fileKey,
        url: `data:${mimeType};base64,${base64Data}`,
      };
    }
  }
}

/**
 * Upload image to S3 and save metadata to database
 */
export async function uploadImageAndSaveMetadata(
  input: ImageUploadInput
): Promise<ImageUploadResult> {
  try {
    // Validate input
    if (!input.imageData || input.imageData.length === 0) {
      return {
        success: false,
        error: "Image data is required",
      };
    }

    // Convert base64 to buffer
    const imageBuffer = base64ToBuffer(input.imageData);

    // Generate unique file key
    const extension = getMimeTypeExtension(input.mimeType);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const randomId = nanoid(8);
    const fileKey = `sky-images/${timestamp}-${randomId}.${extension}`;

    // Upload to S3
    const { url: imageUrl } = await uploadOrFallbackToLocalFile(
      fileKey,
      imageBuffer,
      input.mimeType,
      input.imageData
    );

    // Save image metadata to database
    const skyImageResult = await createSkyImage({
      fileKey,
      imageUrl,
      mimeType: input.mimeType,
      fileSizeBytes: imageBuffer.length,
      captureTime: new Date(),
    });

    // Get the inserted image ID
    const imageId = (skyImageResult as any).insertId;

    let cloudDetectionId: number | undefined;

    // If cloud detection data is provided, save it
    if (
      input.cloudCoveragePercent !== undefined ||
      input.cloudVectorData !== undefined
    ) {
      const cloudDetectionResult = await createCloudDetection({
        cloudCoveragePercent: input.cloudCoveragePercent || 0,
        cloudVectorData: input.cloudVectorData || null,
        imageId: imageId,
        detectionTime: new Date(),
      });

      cloudDetectionId = (cloudDetectionResult as any).insertId;
    }

    mirrorImageRecord({
      imageUrl,
      fileKey,
      mimeType: input.mimeType,
      fileSizeBytes: imageBuffer.length,
      cloudCoveragePercent: input.cloudCoveragePercent,
      cloudVectorData: input.cloudVectorData,
      imageId,
      cloudDetectionId,
    });

    return {
      success: true,
      imageId,
      cloudDetectionId,
      imageUrl,
      fileKey,
    };
  } catch (error) {
    console.error("[ImageUpload] Error uploading image:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * Validate image data before upload
 */
export function validateImageData(imageData: string, maxSizeMB: number = 5): {
  valid: boolean;
  error?: string;
} {
  if (!imageData || imageData.length === 0) {
    return { valid: false, error: "Image data is empty" };
  }

  // Rough estimate: base64 encoding increases size by ~33%
  const estimatedSizeBytes = (imageData.length * 3) / 4;
  const estimatedSizeMB = estimatedSizeBytes / (1024 * 1024);

  if (estimatedSizeMB > maxSizeMB) {
    return {
      valid: false,
      error: `Image size (${estimatedSizeMB.toFixed(2)}MB) exceeds maximum (${maxSizeMB}MB)`,
    };
  }

  return { valid: true };
}
