// A signed upload credential from the backend (DEC-50). Recipe images and
// Recipe Import images each have their own preset.
export interface CloudinaryUploadCredentials {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  allowedFormats: readonly string[];
  maxFileSize: number;
  transformation: string;
}

export interface CloudinaryUploadResult {
  secureUrl: string;
  publicId: string;
}

interface CloudinaryUploadResponse {
  secure_url?: unknown;
  public_id?: unknown;
}

const CLOUDINARY_HOST = 'https://api.cloudinary.com';

export function fileSizeLimitMessage(maxFileSize: number): string {
  const mb = (maxFileSize / 1_048_576).toFixed(1);
  return `Image must be ${mb} MB or smaller`;
}

// Uploads straight from the browser to Cloudinary; image bytes never pass
// through the backend (DEC-50). Throws an Error whose message can be shown.
export async function uploadToCloudinary(
  file: File,
  creds: CloudinaryUploadCredentials,
): Promise<CloudinaryUploadResult> {
  // Enforce the file-size cap client-side. Cloudinary's `max_file_size`
  // upload param is Pro-plan-only; on lower plans it gets stripped before
  // signature verification, which produces a 401 if we include it in the
  // signed body. So the credential carries the cap and we check here.
  if (file.size > creds.maxFileSize) {
    throw new Error(fileSizeLimitMessage(creds.maxFileSize));
  }

  const url = `${CLOUDINARY_HOST}/v1_1/${creds.cloudName}/image/upload`;

  // Cloudinary's wire-side parameter names are snake_case (the signature
  // is computed over those exact names). Building the body in camelCase
  // would produce a signature mismatch and a 401 on every upload.
  const formData = new FormData();
  formData.append('file', file);
  formData.append('api_key', creds.apiKey);
  formData.append('timestamp', String(creds.timestamp));
  formData.append('signature', creds.signature);
  formData.append('folder', creds.folder);
  formData.append('allowed_formats', creds.allowedFormats.join(','));
  formData.append('eager', creds.transformation);

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    // Cloudinary surfaces the real cause (invalid signature, stale
    // timestamp, plan-restricted param, etc.) in the response body —
    // capture it so the user / logs see what failed instead of a bare
    // status code.
    const body = await response.text();
    throw new Error(`Cloudinary returned ${String(response.status)}: ${body}`);
  }
  const payload = (await response.json()) as CloudinaryUploadResponse;
  const { secure_url: secureUrl, public_id: publicId } = payload;
  if (typeof secureUrl !== 'string' || secureUrl.length === 0) {
    throw new Error('Cloudinary response missing secure_url');
  }
  if (typeof publicId !== 'string' || publicId.length === 0) {
    throw new Error('Cloudinary response missing public_id');
  }
  return { secureUrl, publicId };
}
