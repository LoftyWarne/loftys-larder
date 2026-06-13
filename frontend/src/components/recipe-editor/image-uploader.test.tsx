import {
  RECIPE_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMAGE_EAGER_TRANSFORMATION,
  RECIPE_IMAGE_FOLDER,
  RECIPE_IMAGE_MAX_FILE_SIZE,
  type RecipeImageUploadCredentials,
} from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageUploader } from './image-uploader.tsx';

function fakeCredentials(): RecipeImageUploadCredentials {
  return {
    cloudName: 'test-cloud',
    apiKey: 'test-key',
    timestamp: 1700000000,
    signature: '0123456789abcdef0123456789abcdef01234567',
    folder: RECIPE_IMAGE_FOLDER,
    allowedFormats: [...RECIPE_IMAGE_ALLOWED_FORMATS],
    maxFileSize: RECIPE_IMAGE_MAX_FILE_SIZE,
    transformation: RECIPE_IMAGE_EAGER_TRANSFORMATION,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ImageUploader', () => {
  it('uploads with snake_case multipart field names and calls onUploaded with secure_url', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ secure_url: 'https://cdn/img.jpg' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const onUploaded = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <ImageUploader
        imageUrl={null}
        getCredentials={() => Promise.resolve(fakeCredentials())}
        onUploaded={onUploaded}
      />,
    );

    const file = new File(['fake'], 'photo.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Upload recipe image'), file);

    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith('https://cdn/img.jpg');
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('no fetch call');
    const url = call[0] as string;
    const init = call[1];
    expect(url).toBe('https://api.cloudinary.com/v1_1/test-cloud/image/upload');
    expect(init?.method).toBe('POST');
    const body = init?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('api_key')).toBe('test-key');
    expect(body.get('timestamp')).toBe('1700000000');
    expect(body.get('signature')).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
    expect(body.get('folder')).toBe(RECIPE_IMAGE_FOLDER);
    expect(body.get('allowed_formats')).toBe(
      RECIPE_IMAGE_ALLOWED_FORMATS.join(','),
    );
    expect(body.get('eager')).toBe(RECIPE_IMAGE_EAGER_TRANSFORMATION);
    // `max_file_size` MUST NOT appear in the body — it's a Pro-plan-only
    // Cloudinary param. Lower plans strip it before signature verification,
    // which produces a 401 if the server signed with it. The cap is enforced
    // client-side instead (separate test below).
    expect(body.get('max_file_size')).toBeNull();
    // camelCase aliases must NOT appear — they would mismatch the signature.
    expect(body.get('apiKey')).toBeNull();
    expect(body.get('allowedFormats')).toBeNull();
  });

  it('rejects a file larger than maxFileSize without calling Cloudinary', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onUploaded = vi.fn();
    const user = userEvent.setup();

    render(
      <ImageUploader
        imageUrl={null}
        getCredentials={() => Promise.resolve(fakeCredentials())}
        onUploaded={onUploaded}
      />,
    );

    // Build a file whose `size` exceeds the cap by stubbing the property —
    // jsdom won't actually allocate the bytes.
    const oversized = new File(['stub'], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(oversized, 'size', {
      value: RECIPE_IMAGE_MAX_FILE_SIZE + 1,
    });

    await user.upload(screen.getByLabelText('Upload recipe image'), oversized);

    expect(
      await screen.findByText(/Image must be .* MB or smaller/),
    ).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('surfaces an error and does not call onUploaded when Cloudinary fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    );
    const onUploaded = vi.fn();
    const user = userEvent.setup();

    render(
      <ImageUploader
        imageUrl={null}
        getCredentials={() => Promise.resolve(fakeCredentials())}
        onUploaded={onUploaded}
      />,
    );

    const file = new File(['fake'], 'photo.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Upload recipe image'), file);

    expect(await screen.findByText(/Cloudinary returned 401/)).toBeVisible();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('calls onUploaded(null) when the user removes the image', async () => {
    const onUploaded = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <ImageUploader
        imageUrl="https://cdn/existing.jpg"
        getCredentials={() => Promise.resolve(fakeCredentials())}
        onUploaded={onUploaded}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove image' }));
    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith(null);
    });
  });
});
