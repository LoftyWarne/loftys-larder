import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Colima on macOS exposes the Docker socket at
// `~/.colima/<profile>/docker.sock` on the host. Inside the Colima VM the
// real socket lives at `/var/run/docker.sock`. Testcontainers boots a "ryuk"
// reaper container with the host docker socket bind-mounted into it; that
// mount fails because virtiofs can't create a socket node at the host-Mac
// path inside the VM. The fix is to tell testcontainers what the in-VM
// socket path is, so the ryuk bind mount targets a path that actually
// exists in the guest filesystem.
//
// Linux CI doesn't need this — the docker socket lives at `/var/run/docker.sock`
// in both host and guest contexts. The detection guard is "Mac + Colima
// socket present"; everything else is a no-op.
if (process.platform === 'darwin') {
  const colimaSocket = path.join(os.homedir(), '.colima/default/docker.sock');
  if (existsSync(colimaSocket)) {
    process.env.DOCKER_HOST ??= `unix://${colimaSocket}`;
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??=
      '/var/run/docker.sock';
    process.env.TESTCONTAINERS_HOST_OVERRIDE ??= '127.0.0.1';
  }
}
