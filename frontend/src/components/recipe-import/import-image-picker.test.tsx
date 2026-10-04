import { RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE } from '@loftys-larder/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ImportImagePicker } from './import-image-picker.tsx';

function Harness(): React.ReactElement {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <ImportImagePicker
      files={files}
      onFilesChange={setFiles}
      disabled={false}
    />
  );
}

function image(name: string, type = 'image/jpeg'): File {
  return new File(['x'], name, { type });
}

function chosenNames(): string[] {
  const list = screen.queryByRole('list', { name: 'Chosen images' });
  if (!list) return [];
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelector('p')?.textContent ?? '');
}

// `user.upload` drops files that don't match `accept`; these tests check the
// picker's own checks, which also cover browsers that ignore it.
function setup() {
  return userEvent.setup({ applyAccept: false });
}

describe('ImportImagePicker', () => {
  it('takes images in the order chosen, numbered as pages', async () => {
    const user = setup();
    render(<Harness />);

    await user.upload(screen.getByLabelText('Choose images to import'), [
      image('first.jpg'),
      image('second.png', 'image/png'),
    ]);
    await user.upload(screen.getByLabelText('Choose images to import'), [
      image('third.webp', 'image/webp'),
    ]);

    expect(chosenNames()).toEqual(['first.jpg', 'second.png', 'third.webp']);
    expect(screen.getByText(/^Page 3 ·/)).toBeInTheDocument();
  });

  it('takes an iPhone HEIC photo, even without a MIME type', async () => {
    const user = setup();
    render(<Harness />);

    await user.upload(screen.getByLabelText('Choose images to import'), [
      image('IMG_0001.HEIC', ''),
    ]);

    expect(chosenNames()).toEqual(['IMG_0001.HEIC']);
  });

  it('refuses a ninth image', async () => {
    const user = setup();
    render(<Harness />);

    await user.upload(
      screen.getByLabelText('Choose images to import'),
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) =>
        image(`${n}.jpg`),
      ),
    );

    expect(chosenNames()).toEqual([
      '1.jpg',
      '2.jpg',
      '3.jpg',
      '4.jpg',
      '5.jpg',
      '6.jpg',
      '7.jpg',
      '8.jpg',
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Up to 8 images can be imported at once, so not all of them were added.',
    );
    expect(
      screen.getByRole('button', { name: 'Add another image' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Choose images to import')).toBeDisabled();
    expect(
      screen.getByText('That’s the most for one import.'),
    ).toBeInTheDocument();
  });

  it('refuses a file that isn’t a JPG, PNG, WebP or HEIC image', async () => {
    const user = setup();
    render(<Harness />);

    await user.upload(screen.getByLabelText('Choose images to import'), [
      image('recipe.pdf', 'application/pdf'),
      image('ok.jpg'),
    ]);

    expect(chosenNames()).toEqual(['ok.jpg']);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'recipe.pdf isn’t a JPG, PNG, WebP or HEIC image.',
    );
  });

  it('refuses an image over the size limit', async () => {
    const user = setup();
    render(<Harness />);
    const big = image('huge.jpg');
    Object.defineProperty(big, 'size', {
      value: RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE + 1,
    });

    await user.upload(screen.getByLabelText('Choose images to import'), [big]);

    expect(chosenNames()).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'huge.jpg: Image must be 10.0 MB or smaller.',
    );
  });

  it('removes an image, and the rest move up a page', async () => {
    const user = setup();
    render(<Harness />);
    await user.upload(screen.getByLabelText('Choose images to import'), [
      image('first.jpg'),
      image('second.jpg'),
    ]);

    await user.click(screen.getByRole('button', { name: 'Remove first.jpg' }));

    expect(chosenNames()).toEqual(['second.jpg']);
    expect(screen.getByText(/^Page 1 ·/)).toBeInTheDocument();
  });
});
