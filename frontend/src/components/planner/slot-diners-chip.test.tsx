import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SlotDinersChip } from './slot-diners-chip.tsx';

describe('SlotDinersChip', () => {
  it('renders nothing when nobody is eating', () => {
    const { container } = render(
      <SlotDinersChip dinerNames={[]} guestCount={0} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists named members with the total headcount', () => {
    render(<SlotDinersChip dinerNames={['Conor', 'Sam']} guestCount={0} />);
    const chip = screen.getByTestId('slot-diners');
    expect(chip).toHaveTextContent('Conor, Sam');
    expect(chip).toHaveTextContent('(2)');
  });

  it('appends a +N for guests and counts them in the total', () => {
    render(<SlotDinersChip dinerNames={['Conor']} guestCount={2} />);
    const chip = screen.getByTestId('slot-diners');
    expect(chip).toHaveTextContent('Conor +2');
    expect(chip).toHaveTextContent('(3)');
  });

  it('shows a guest-only label when no members are named', () => {
    render(<SlotDinersChip dinerNames={[]} guestCount={3} />);
    const chip = screen.getByTestId('slot-diners');
    expect(chip).toHaveTextContent('3 guests');
    expect(chip).toHaveTextContent('(3)');
  });
});
