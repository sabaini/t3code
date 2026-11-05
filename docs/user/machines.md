# Test machines

Some work shouldn't run on your own computer: installing system packages, running services,
reproducing a bug on a clean system, or testing across several hosts. **Machines** lets agents
create disposable virtual machines and containers on LXD servers of yours for that. An agent
creates one when it needs it, runs commands on it over `ssh`, and releases it when it's done.
Machines belong to a project, so the project's other threads can use them too.

You set this up once per environment:

1. Set up an LXD server and connect it in **Settings → Devices → Machines**.
2. Add machine profiles there, for all projects or one.
3. Turn on **Agent machine access** for the projects that should use them.

## Set up an LXD server

Machines run on a server with LXD 6.9 or later and OVN. T3 Code gets a project of its own there,
and its certificate can't reach anything outside that project. The T3 Code server must reach the
LXD server on port 8443. Virtual machines need hardware virtualization on the LXD server, which
shows up as `/dev/kvm`; without it, only containers work.

On a fresh Ubuntu server, one command sets everything up and prints a trust token:

```sh
curl -fsSL https://raw.githubusercontent.com/sabaini/t3code/main/scripts/machines/setup-lxd-host.sh | sudo bash
```

It installs LXD 6 and MicroOVN, then makes a ZFS storage pool called `local` in a file that takes
half the free space on the root disk, a NAT bridge called `t3-uplink` that machines reach the
internet through, and the `t3-machines` project. To put machines on a disk of their own, add
`-s -- --disk /dev/nvme1n1` after `sudo bash`. **Everything on that disk is erased.** Or set the
file's size with `--size 200GiB`. Running it again is safe: it keeps what's there and prints a
new token.

On a [MicroCloud](https://canonical.com/microcloud), or another server that already has LXD and
OVN, run these instead, with your OVN uplink network in place of `UPLINK` and your storage pool in
place of `local`. The last command prints the trust token.

```sh
lxc project create t3-machines \
  -c features.images=true -c features.profiles=true -c features.networks=true \
  -c restricted=true -c restricted.snapshots=allow \
  -c restricted.networks.uplinks=UPLINK
lxc profile device add default root disk path=/ pool=local --project t3-machines
lxc config trust add --name t3-machines --restricted --projects t3-machines
```

To cap what agents can use in total, set limits on the project, for example
`lxc project set t3-machines limits.instances=10`.

## Connect the server

In **Settings → Devices → Machines**, select **Connect server** and paste the token. Settings
then shows the server's LXD version, whether it can run virtual machines, and anything about the
project that stops T3 Code from creating machines there, with the commands that fix it.

Servers belong to one environment, and only agents on that environment can use them. With several
environments selected, each gets a line with its own **Connect server**. A trust token works once,
so make a new one for each environment you connect.

**Disconnect** forgets the server and removes T3 Code's certificate there. Machines on it stay.
Connect the same server and project again to use or release them.

With more than one server, a project's first machine goes to the server with the fewest machines
among those that can take it. The project's later machines go to the same server, because a
project's machines share a network that lives on one server.

## Machine profiles

A profile describes one kind of machine agents may create. Set profiles for all projects, or
select a project to give it its own.

| Setting                  | What it does                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                 | What agents ask for, like `node`. Machines are named after it, `node-1` and so on, unless the agent picks a name.                |
| **Type**                 | A **virtual machine** has its own kernel and can have extra disks. A **container** starts faster and shares the server's kernel. |
| **Image**                | `ubuntu:24.04` by default. `ubuntu-daily:` images work too, and so does the alias of an image already on the LXD server.         |
| **CPUs**, **Memory**     | 2 CPUs and 2 GiB unless you change them.                                                                                         |
| **Extra disks (GiB)**    | Empty block devices for virtual machines, one per size: `20, 20` gives two.                                                      |
| **Delete after (hours)** | How long a machine lasts: 24 hours by default, up to 30 days.                                                                    |
| **LXD profiles**         | The profiles on the LXD server that machines are made with, `default` to start with. The root disk comes from them.              |

Changes apply to machines created afterwards. An LXD profile that adds another network device is
refused, since it could connect machines to more than their project's network.

## Let agents use machines

Turn on **Agent machine access** for all projects or for one. It's off by default, and it applies
when a thread's agent session next starts. Then ask in plain words, like "Make two Ubuntu VMs and
test the cluster setup on them". The agent lists the profiles, creates machines, and runs commands
with the `ssh -F …` command T3 Code gives it. Machines log in as `ubuntu`, with passwordless sudo.

A project has at most 5 machines, whichever threads made them. The first virtual machine from an
image takes a few minutes while the LXD server downloads it.

An agent can use a machine another thread of the project made, for example a test cluster you had
one thread set up. Agents are told to release the machines they made once they're done, unless you
want to keep them, and to leave another thread's machines alone unless you ask.

Codex outside **Full access** runs `ssh` in a sandbox that can't reach machines. It reruns `ssh`
outside the sandbox where its permission mode allows that, or asks you to switch the thread to
Full access. Cursor needs Full access to reach machines. See
[permission modes](./permission-modes.md).

## See a project's machines

On web and desktop, every thread's details panel shows its project's machines under **Machines**,
with their state and how long they have left. From there you can open a terminal on one, copy its
`ssh` command, or **Release** it. On mobile, a server button above the composer opens the same
list, where you can release them.

## What machines can reach

A project's machines share a network where they reach each other and the public internet, and
nothing else: not your local network, the T3 Code server, or other projects' machines. They know
each other by a longer name than the one you `ssh` to, like `node-1-3f9a2c1b.lxd`. Threads of one
project aren't kept apart: any of them can use or release the project's machines.

## When machines stop and go away

- **They stop** after 4 hours without an `ssh` connection or an agent checking on them. The next
  `ssh` starts them again.
- **They're deleted**, with their disks, when their profile's lifetime is up, when an agent or you
  release them, or when their project is deleted. Archiving or deleting a thread leaves them.

If a project is gone but its machines aren't, for example after this environment's data was reset,
Settings lists them under **Machines without a project**. T3 Code never deletes those by itself;
select **Delete** for each one you don't need.

## When something's wrong

- **"None of the connected LXD servers can take this machine."** The message gives each server's
  reason. Fix one, or connect another server.
- **"The LXD project … isn't set up to keep machines apart from the rest of the network."** Run the
  commands Settings shows for that server. Some settings can only change while the project is
  empty; if LXD refuses, disconnect, set up a project with another name, and connect that one.
- **A machine "didn't finish booting".** Its image probably lacks cloud-init. Use an Ubuntu image.
- **A machine is "Gone from its LXD server".** Someone deleted it there. Release it to clear it.
