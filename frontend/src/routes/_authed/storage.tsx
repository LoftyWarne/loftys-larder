import { storageSearchSchema } from '@loftys-larder/shared';
import { createFileRoute } from '@tanstack/react-router';

import { StoragePage } from '../-components/storage-page.tsx';

export const Route = createFileRoute('/_authed/storage')({
  validateSearch: storageSearchSchema,
  component: StoragePage,
});
