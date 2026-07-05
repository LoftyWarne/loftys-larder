import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DateInput } from './date-input.tsx';

// jsdom does not implement showPicker, so each test installs/removes it on the
// prototype to model both supported and unsupported browsers.
interface PickerProto {
  showPicker?: () => void;
}

afterEach(() => {
  delete (HTMLInputElement.prototype as PickerProto).showPicker;
  vi.restoreAllMocks();
});

describe('DateInput', () => {
  it('opens the native picker when the field is clicked', async () => {
    const showPicker = vi.fn();
    (HTMLInputElement.prototype as PickerProto).showPicker = showPicker;

    render(<DateInput aria-label="date" />);
    await userEvent.click(screen.getByLabelText('date'));

    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it('still forwards a caller-supplied onClick', async () => {
    const showPicker = vi.fn();
    (HTMLInputElement.prototype as PickerProto).showPicker = showPicker;
    const onClick = vi.fn();

    render(<DateInput aria-label="date" onClick={onClick} />);
    await userEvent.click(screen.getByLabelText('date'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it('does not open the picker when the caller prevents default', async () => {
    const showPicker = vi.fn();
    (HTMLInputElement.prototype as PickerProto).showPicker = showPicker;

    render(
      <DateInput
        aria-label="date"
        onClick={(event) => {
          event.preventDefault();
        }}
      />,
    );
    await userEvent.click(screen.getByLabelText('date'));

    expect(showPicker).not.toHaveBeenCalled();
  });

  it('does not throw on browsers without showPicker', async () => {
    render(<DateInput aria-label="date" />);

    await expect(
      userEvent.click(screen.getByLabelText('date')),
    ).resolves.not.toThrow();
  });

  it('swallows a showPicker that throws', async () => {
    const showPicker = vi.fn(() => {
      throw new Error('not user-activated');
    });
    (HTMLInputElement.prototype as PickerProto).showPicker = showPicker;

    render(<DateInput aria-label="date" />);

    await expect(
      userEvent.click(screen.getByLabelText('date')),
    ).resolves.not.toThrow();
    expect(showPicker).toHaveBeenCalledTimes(1);
  });
});
