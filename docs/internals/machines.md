# Machines

Agents get disposable LXD virtual machines and containers, owned by a project and reached over
`ssh`. Everything an agent puts on a machine is untrusted, so the design is about what a machine
can't reach, and how the agent still reaches it.

## Why projects own machines

Every agent runs as the server's OS user. Any of them can read any project's `ssh_config`, connect
to its relay sockets, use the environment's one SSH key, and read the LXD client key from the
secret store. Ownership by thread or project keeps nothing from an agent; it only decides which
machines an agent sees by default and when they go away. What scope does enforce is the network:
which machines can reach each other. Projects are where trust actually changes (a client's repo, an
open-source one that runs strangers' code), and threads of one project share its code and secrets,
so machines are kept apart per project and shared across its threads. The environment is the outer
boundary: one LXD project and one certificate.

## The sandbox is the LXD project

T3 Code only creates machines in a restricted LXD project whose certificate can make OVN networks
on exactly one uplink but can't hand out the host: no host devices, no idmaps, no privileged
containers. [`projectSandbox`](../../packages/machines/src/MachineSandbox.ts) lists what a
project is missing or allows that it shouldn't, and placement refuses a host until both lists are
empty. A token that trusts the certificate for more than one project, or none, is refused when
connecting.

Each T3 project gets its own OVN network, so its machines reach each other and nothing of another
project's. One shared ACL allows the network's own machines and public IPv4 ranges and rejects the
rest, which covers the LAN, tailnets, cloud metadata, and the T3 Code host. OVN evaluates reject
rules before allow rules, so the ACL can't list private ranges to reject: machines would lose each
other too. It lists what's allowed, and the network's default rejects everything else. IPv6 is off
because nothing filters it. A network lives on one LXD server, so all of a project's machines do
too.

A machine's own `eth0` replaces any its LXD profiles give it; a profile that adds a second NIC is
refused, since that NIC wouldn't be on the project's network.

## SSH goes through LXD, not the network

The ACL also keeps the T3 Code host from reaching machines, and the host may not route to the OVN
network anyway. So `ssh` never connects to a machine's address. Each machine gets a Unix socket in
the project's state directory; the project's `ssh_config` points `ProxyCommand` at
[`t3 machine-ssh-proxy`](../../packages/machines/src/sshProxy.ts), which joins that socket to
an `nc` the server runs on the machine through LXD's exec API. Host keys are read through LXD's
file API once cloud-init finishes, and pinned in the project's `known_hosts`, so the first
connection never trusts an unknown key.

The socket is why agent sandboxes matter. Codex's Linux sandbox blocks `connect()` on Unix sockets
unless the network is open, and T3 Code sends its sandbox policy every turn, so machine tools tell
sandboxed Codex and Cursor sessions to run `ssh` outside the sandbox or ask for Full access instead
of failing later.

## Leases, tags, and what is never deleted

A lease in the server's database is the record that a project owns a machine, and which thread's
agent made it. Thread changes never touch leases; a sweep every five minutes releases those whose
lifetime is up or whose project is gone. Instances are also tagged with the environment, project,
and lease, so two environments can share an LXD project without touching each other's machines.

An instance tagged with this environment but without a lease is listed in Settings for manual
deletion and never deleted automatically: a development server started on a copy of real state has
the same environment id, and would otherwise delete the real server's machines. For the same
reason `migrate-dev-db` never copies leases.

MCP tool calls wait at most 40 seconds for a machine to boot, because Codex gives an MCP call 60
by default. Longer boots continue in the background and the agent calls `machine_wait`.

## Outside T3 Code

The core lives in `packages/machines` and gets everything T3-specific through
[`MachinePlatform`](../../packages/machines/src/MachinePlatform.ts): settings, the environment id,
whether a project exists, the state directory, and running `ssh-keygen` and `openssl`. That keeps
it hostable by something other than T3 Code's server, such as a standalone MCP server. Such a host
forks `MachineService.run` itself, and its binary must answer `machine-ssh-proxy`, because the
`ssh_config` it writes calls the running binary with that subcommand.
