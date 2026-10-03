import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: (props: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    search?: { servings?: number };
  }): React.ReactElement => {
    const path = props.to?.replace('$recipeId', props.params?.recipeId ?? '');
    const query =
      props.search?.servings === undefined
        ? ''
        : `?servings=${String(props.search.servings)}`;
    return <a href={`${path ?? ''}${query}`}>{props.children}</a>;
  },
}));

import { RecipeNameLink } from './recipe-name-link.tsx';

function renderLink(prepared: number, isDeleted = false): void {
  render(
    <RecipeNameLink
      item={{ recipeId: 10, recipeName: 'Tomato pasta', isDeleted, prepared }}
    />,
  );
}

describe('RecipeNameLink', () => {
  it('opens a dish being cooked at the portions prepared', () => {
    renderLink(6);
    expect(screen.getByRole('link', { name: 'Tomato pasta' })).toHaveAttribute(
      'href',
      '/recipes/10?servings=6',
    );
  });

  it("opens a dish that's only eaten here at the recipe's own servings", () => {
    renderLink(0);
    expect(screen.getByRole('link', { name: 'Tomato pasta' })).toHaveAttribute(
      'href',
      '/recipes/10',
    );
  });

  it('leaves out a portion count above what the recipe page can show', () => {
    renderLink(51);
    expect(screen.getByRole('link', { name: 'Tomato pasta' })).toHaveAttribute(
      'href',
      '/recipes/10',
    );
  });

  it('does not link a deleted recipe', () => {
    renderLink(4, true);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('(deleted)')).toBeInTheDocument();
  });
});
