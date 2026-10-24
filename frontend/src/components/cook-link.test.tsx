import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: (props: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    search?: { servings?: number };
    'aria-label'?: string;
  }): React.ReactElement => {
    const path = props.to?.replace('$recipeId', props.params?.recipeId ?? '');
    const query =
      props.search?.servings === undefined
        ? ''
        : `?servings=${String(props.search.servings)}`;
    return (
      <a href={`${path ?? ''}${query}`} aria-label={props['aria-label']}>
        {props.children}
      </a>
    );
  },
}));

import { CookLink } from './cook-link.tsx';

function renderLink(prepared: number, isDeleted = false): void {
  render(
    <CookLink
      item={{ recipeId: 10, recipeName: 'Tomato pasta', isDeleted, prepared }}
    />,
  );
}

describe('CookLink', () => {
  it('opens a dish being cooked in cook mode at the portions prepared', () => {
    renderLink(6);
    expect(
      screen.getByRole('link', { name: 'Cook Tomato pasta' }),
    ).toHaveAttribute('href', '/recipes/10/cook?servings=6');
  });

  it('leaves out a portion count above what cook mode can show', () => {
    renderLink(51);
    expect(
      screen.getByRole('link', { name: 'Cook Tomato pasta' }),
    ).toHaveAttribute('href', '/recipes/10/cook');
  });

  it("renders nothing for a dish that's only eaten here", () => {
    renderLink(0);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing for a deleted recipe', () => {
    renderLink(4, true);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
