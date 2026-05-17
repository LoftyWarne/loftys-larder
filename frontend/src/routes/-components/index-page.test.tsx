import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    health: {
      ping: {
        useQuery: vi.fn(),
      },
    },
  },
}));

import { trpc } from '@/lib/trpc.ts';
import { IndexPage } from './index-page.tsx';

const useQueryMock = trpc.health.ping.useQuery as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  useQueryMock.mockReset();
});

describe('IndexPage', () => {
  it('renders the reqId from a successful health.ping query', () => {
    useQueryMock.mockReturnValue({
      data: { ok: true, reqId: 'abc-123' },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<IndexPage />);
    expect(screen.getByTestId('req-id')).toHaveTextContent('abc-123');
  });

  it('shows a loading state before the query resolves', () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    render(<IndexPage />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the shadcn Button without throwing', () => {
    useQueryMock.mockReturnValue({
      data: { ok: true, reqId: 'x' },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<IndexPage />);
    expect(
      screen.getByRole('button', { name: /re-ping/i }),
    ).toBeInTheDocument();
  });
});
