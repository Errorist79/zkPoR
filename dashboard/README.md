# @zkpor/dashboard

The issuer dashboard for the zkPoR registry.

The dashboard is a local process on a machine the issuer controls. One command
starts it, and it serves the interface on the loopback address. It is not a
hosted service. No party operates a place that it could send anything to.

## What it does

The dashboard covers four things.

- The solvency result of one asset, at a point in time, in a form a reader can
  see.
- The proving run and the attestation, which run the pinned prover in this
  process.
- The customer inclusion check.
- The record of the earlier attestations, with the bound of the query.

## Start it

The dashboard loads the client library at run time, so the build of this package
alone does not produce a process that can start. Build both, from the root of
the repository:

```
npm run build
ZKPOR_NETWORK=testnet ZKPOR_RPC_URL=https://soroban-testnet.stellar.org \
  npx zkpor-dashboard
```

The root build covers every workspace in order. From this directory,
`npm run build` builds the dashboard only, and the process then fails to load
the library.

The command prints the address to open. It takes its network, its endpoint, and
its deployments file from the same environment variables as the `zkpor` command
line. It reads the circuits and the generator from the directory you start it
in.

| variable | content |
|----------|---------|
| `ZKPOR_DASHBOARD_PORT` | the port; the default is 7878, and 0 asks for any free port |

Every other variable belongs to the client library, and `sdk/README.md` records
it.

## Two properties, and how each one holds

### Nothing leaves the machine

Raw balances, salts, paths, witnesses, and the master secret stay on this
machine. The property is structural, and not a rule that a later change can
forget.

- The listener binds `127.0.0.1`. The host is a constant of this package and no
  setting overrides it, so there is no address to misconfigure. A test refuses a
  new setting whose name suggests a host.
- Every answer carries `default-src 'none'`, which is the fallback of the fetch
  directives. A page therefore cannot load a script, an image, a font, or a
  frame, and it cannot open a connection. The stylesheet comes from this
  process, under `style-src 'self'`.
- No page carries a script. Every page renders here, and a run page follows its
  progress with a pragma directive that reloads it. A test refuses a script tag
  and an event handler on every page.
- No page names a host. Every address in the markup is a path of this process, so
  a saved copy of a page reaches nothing.
- A request that names another authority stops with the status 421. A remote
  name can resolve to the loopback address, and a page under that name would
  otherwise be same-origin with this process.
- A form submission stops with the status 403 unless the request states that it
  came from a page of this process. The guard fails closed, so a request that
  states nothing about its origin stops as well. The cost is that a client which
  sends no `Sec-Fetch-Site` header cannot submit a form here, and such a client
  uses the `zkpor` command line instead.
- No form carries a key, a balance, or a file. The two forms take a path on this
  machine, and this process reads the file.

One outbound connection is inherent and stays. The process reads the registry
from the endpoint the issuer configured. That connection carries a contract call
and never a balance, a salt, a path, a witness, or a key.

### It holds no cryptographic definition of its own

Every hash, encoding, and serialization comes from the client library, which
mirrors the shared Rust crate and which the committed vectors pin. The dashboard
computes no root. The inclusion page calls the same function that the command
line calls, and it prints the lines that the library writes and the exit code
that the library assigns.

The dashboard makes one statement of its own, and it is arithmetic and not
cryptography. The registry records the reserve sum and the total liabilities and
it compares neither against the other, so the comparison belongs to the reader.
The page states it as the comparison of one attestation record, and it says so.

## The two reserve numbers

The registry produces two reserve numbers, and they never share a name, a row,
or a headline.

- **Reserves at the attestation, at ledger `e`.** The registry read the balances
  inside the attestation transaction. An accepted attestation covers this number
  and the liabilities beside it.
- **Reserves observed now.** A separate read at the ledger it names. No
  attestation covers it, and it enters no comparison on the page.

The two live in two sibling sections, each with its own name and its own ledger.
The headline states the result and carries neither number. A test renders the
case where the two numbers hold the same digits, which is the case a reader can
confuse, and it checks that each number appears inside its own section and
nowhere else.

The observation fails as a whole when one balance read fails, and it names no
address. The dashboard then reads each reserve balance on its own, which is the
one read that can name the address that the registry cannot read.

## A stale attestation

Inclusion and the currency of the solvency claim are different claims. A stale
attestation is its own outcome and never a failure. The page says that the claim
has lapsed, and it says that the attestation still stands for the ledger it
names. The window comes from the client library, so one constant governs the
registry, the command line, and this page.

## A run takes minutes

A proving run takes minutes, and three things follow.

A run is a resource with an identity. A submission starts the run and redirects
to that resource, so the page that shows progress is a plain read. A reload of it
repeats the read and starts nothing.

One process holds at most one open run. Two runs cannot proceed together for
three separate reasons: the prover needs more memory than two copies of it fit
in, the proving driver writes the witness files of a run at fixed paths that a
second run would overwrite, and two attestations of one asset race for the same
window. A second submission, from a second tab or from a second click, starts
nothing and joins the open run. The run page says so.

A process remembers a bounded number of runs and forgets the oldest one first. A
restart forgets every run. The record of an accepted attestation is the registry,
and not this process.

## The keys

The master secret and the authority key come from the environment of this
process, exactly as the command line reads them. No form carries either one, no
page shows either one, and the dashboard binds neither one to a name of its own:
it reads the master secret into the call that proves, in one expression. A run
that starts without a key it needs stops before the proof, so a missing key
costs no part of the window.

## The salts of a run, and what the sweep reaches

The prover inputs hold the identifier, the balance, and the salt of every
customer in the snapshot. The client library removes them, and it removes them
on every ending that lets the process run anything.

The sweep covers these endings:

- the run produces a proof;
- a step fails and throws;
- the process receives an interrupt, a termination, or a hang-up signal;
- the process exits for another reason, which covers an uncaught exception.

A sweep is worth nothing while a tool of the run is still writing, so the tools
stop first and the sweep runs second. Each tool leads a process group of its
own, which covers the work that a tool starts in turn, and the stop uses a
signal that a process cannot catch. An earlier form of this fix swept and left
the tools running, and the salts came back seconds later with nothing left to
remove them.

The sweep does not cover an ending that runs no code at all. A kill that cannot
be caught, a power loss, and a kernel that reclaims memory all stop the process
with the files still on disk. Nothing inside the process can act there.

That case is narrowed and not closed. Every run sweeps before it writes, so the
files of a run that died without warning do not outlive the next start. The
exposure lasts from the moment the process dies until a tool runs again, and it
stays open for as long as nobody starts one.

## One run for each working tree

A run writes its witness files at fixed paths in the repository. Those paths
belong to the machine and not to one process, so the rule that one run is open
at a time cannot be a rule that one process keeps for itself. The library takes
a lock file, `circuits/recursion/.run.lock`, which holds the identifier of the
process that owns it. The issuer script takes the same lock in the same format,
so the two tools refuse to run over each other.

A lock whose owner no longer runs is stale, and the next run clears it and
takes it. The check asks the operating system whether the owner is alive. An
operating system reuses a process identifier, so a lock whose owner died can
look alive when an unrelated process took its number. That failure refuses a run
rather than allowing a second one, which is the safe direction.

## The refusals of the library

The library refuses a toolchain that differs from the pins, and it refuses a run
whose salts anybody can recompute. The dashboard shows those refusals and never
bypasses one.

## An inclusion package reveals a balance

A package carries the balance of one customer in clear text. The customer shares
the file only with a party that may see that balance.
