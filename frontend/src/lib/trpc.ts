import type { AppRouter } from '@loftys-larder/shared';
import { createTRPCReact } from '@trpc/react-query';

export const trpc = createTRPCReact<AppRouter>();
