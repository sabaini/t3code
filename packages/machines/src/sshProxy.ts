// @effect-diagnostics nodeBuiltinImport:off - Runs before the Effect graph loads, like the other bin.ts fast paths.
import * as NodeNet from "node:net";

/**
 * ssh's ProxyCommand for machines: joins stdin and stdout to the machine's
 * relay socket. It runs once per `ssh`, so it stays out of the CLI's module graph.
 */
export function runMachineSshProxy(args: ReadonlyArray<string>): void {
  const socketPath = args[0];
  if (socketPath === undefined) {
    process.stderr.write("Usage: machine-ssh-proxy <socket>\n");
    process.exitCode = 2;
    return;
  }
  // ssh ends its input before it has read the whole reply, so each direction ends on its own.
  const socket = NodeNet.createConnection({ path: socketPath, allowHalfOpen: true });
  socket.on("error", (error) => {
    process.stderr.write(`T3 Code couldn't reach the machine: ${error.message}\n`);
    process.exit(255);
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("close", () => process.stdout.write("", () => process.exit(0)));
}
