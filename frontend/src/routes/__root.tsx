import { Outlet, createRootRoute } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout(): React.ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="container mx-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
