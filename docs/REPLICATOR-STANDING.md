# Standing for replicators: a deposit-backed challenge by a non-executor

Re-executing a settled task is already permissionless — every input is on-chain (`taskInfo`, `taskInput`,
`stimulusSeed`) and every output is published. What does not exist is a way to *act* on a disagreement found
that way. This is the design for giving a replicator that standing, so that **one** honest outsider is enough
(`docs/TOKENOMICS.md` §3b).

**Status: written, never compiled.** The contract side is on `feat/replicator-standing` in
`contracts/lib/aigg-porw` — `interfaces/PorwMesh.sol`, `mesh/TaskMarket.sol`, `mesh/ExecutionDisputes.sol`,
`test/ReplicatorStanding.t.sol` — plus the wiring call in `aigg-bnb`'s `contracts/script/DeployBNB.s.sol`. Foundry is not installable in this
environment (the egress proxy refuses the release download), so **none of it has been through a compiler and no
test has run**. Read the diff as a reviewed proposal, not as working code, and expect the first `forge build` to
find something. §5 is the test plan, including the one trick that makes most of it cheap.

The existing constructors are untouched on purpose: `CHALLENGE_DEPOSIT` and `CHALLENGE_WINDOW` arrive through a
one-shot `setChallengeParams`, like `setDisputes`, so the five existing `TaskMarket` construction sites (three
test `setUp`s and two deploy scripts) keep compiling unchanged. `challengeWindow == 0` means the feature is off,
so a deployment that forgets the call fails safe rather than accepting free challenges.

**Nothing is deployed, so nothing here has to be additive.** The design below is still shaped as an extension
rather than a rewrite, because the dispute state machine is the part of this system least worth disturbing — but
where a breaking change is cleaner it is taken, and two are worth taking on the way past:

- **`Task.inputCommit` should be renamed `initStateRoot`.** That is what it is (`ExecutionDisputes`: "the agreed
  root before step 1 is the task's inputCommit"), it is not an input in any other sense, and the name has
  already caused one misreading serious enough to be recorded in `docs/COLLECTIVE.md`. A field name is cheap to
  fix exactly once.
- **Resolution is one function, not two.** `onDisputeResolved` currently refuses a settled task, which is what
  would have forced a second entry point. §2(c) instead widens the existing one. It discriminates on
  `challenger[taskId] != address(0)` rather than on `st.settled`: who the parties are is the actual fact being
  branched on, and a flag can in principle be set by another path.

---

## 1. The four things in the code that block it today

1. **`ExecutionDisputes.open` is disabled.** `function open(bytes32, address, address) external payable { revert("use market"); }`
2. **`openDispute` is market-only**, and `TaskMarket` calls it from exactly one place: inside `settle`, between
   two sortitioned executors who both submitted and disagreed.
3. **A party must resolve to a bonded instance.** `_who()` is `instances.resolve(msg.sender)`, and
   `InstanceRegistry.resolve` returns the signer only if `bonded[signer] > 0`, else a delegating instance, else
   `address(0)`. An unbonded replicator is `address(0)` and cannot post a single round.
4. **A party must already have a result on record.** `openDispute` reads each side's `execRoot` from
   `market.resultOf(taskId, party)`. A replicator has never submitted one.

Two further constraints shape the fix rather than block it:

- **Settlement is final and pays inside `settle`.** `_pay` runs there, and `onDisputeResolved` requires
  `!st.settled`. A post-settlement path cannot re-route money that is already gone.
- **`slash` caps at the bond.** `instances.slash` takes `min(amount, bonded[inst])`, so slashing an unbonded
  loser silently does nothing. The challenger's punishment has to be their deposit.

---

## 2. The change, in three parts

### (a) `TaskMarket`: let a non-executor put a result on record, behind a deposit

```solidity
uint256 public immutable CHALLENGE_DEPOSIT;
uint64  public immutable CHALLENGE_WINDOW;   // blocks after settlement

mapping(bytes32 => address) public challenger;
mapping(bytes32 => uint256) public challengeDeposit;
mapping(bytes32 => bool)    public repudiated;
// StoredTask gains: uint64 settledAt;

event ResultChallenged(bytes32 indexed taskId, address indexed challenger, bytes32 execDigest);
event ResultRepudiated(bytes32 indexed taskId, address indexed executor, bytes32 correctDigest);

function challengeResult(bytes32 taskId, Result calldata result) external payable {
    StoredTask storage st = tasks[taskId];
    require(st.exists && st.settled && !st.disputed, "task");
    require(block.number <= st.settledAt + CHALLENGE_WINDOW, "window");
    require(challenger[taskId] == address(0), "challenged");
    require(msg.value >= CHALLENGE_DEPOSIT, "deposit");
    require(!submitted[taskId][msg.sender], "executor");          // an executor had its chance at settle
    address ref = _firstSubmitted(taskId, executors(taskId));
    require(results[taskId][ref].execDigest != result.execDigest
         || results[taskId][ref].execRoot   != result.execRoot, "agrees");
    results[taskId][msg.sender] = result;                          // NOT `submitted`: executors() is unchanged
    challenger[taskId] = msg.sender; challengeDeposit[taskId] = msg.value;
    st.disputed = true;
    emit ResultChallenged(taskId, msg.sender, result.execDigest);
    IDisputeOpener(disputes).openDispute(taskId, ref, msg.sender);
}
```

No signature: `msg.sender` *is* the challenger's identity. There is no instance to delegate from, which is the
point. `submitted` is deliberately left false so `executors()`, `_pay` and `_firstSubmitted` keep their current
meaning — only `resultOf` needs to see the challenger's result, and it does.

### (b) `ExecutionDisputes`: accept a party that is not an instance

```solidity
function _who(bytes32 taskId) internal view returns (address w) {
    if (msg.sender == partyA[taskId] || msg.sender == partyB[taskId]) return msg.sender;
    w = instances.resolve(msg.sender);
    require(w != address(0) && (w == partyA[taskId] || w == partyB[taskId]), "party");
}
```

The direct branch changes nothing for existing parties — a bonded instance already resolves to itself
(`bonded[signer] > 0 → signer`) — and it lets a challenger act as itself. The delegated session-key path is
untouched, so a tab still plays through its session key.

### (c) Resolution: branch on who the loser is

`_resolve` currently always slashes. It becomes:

| loser | punishment | to the winner | to the task |
|---|---|---|---|
| an executor | `slash(loser, SLASH_AMOUNT, challenger, "porw:exec-fraud")`, **and the same for every other executor whose recorded result equals the loser's** — they asserted the identical wrong digest | deposit refunded | `repudiated = true`, `ResultRepudiated(taskId, executor, correctDigest)` |
| the challenger | deposit forfeited | paid to the executor | unchanged |

`TaskMarket.onDisputeResolved` absorbs both endings rather than growing a sibling. The `!st.settled` guard
that exists today is what made a second function necessary; the unified version keeps the same guarantee
structurally — `_pay` is reachable only on the pre-settlement path:

```solidity
function onDisputeResolved(bytes32 taskId, address loser, address winner) external {
    require(msg.sender == disputes, "disputes");
    StoredTask storage st = tasks[taskId];
    require(st.exists && st.disputed, "task");
    submitted[taskId][loser] = false;                  // the loser's result no longer counts

    address c = challenger[taskId];
    if (c == address(0)) {                             // two executors disagreed at settle: as today
        require(!st.settled, "settled");
        _pay(taskId, executors(taskId), winner);
        return;
    }
    uint256 dep = challengeDeposit[taskId]; challengeDeposit[taskId] = 0;
    if (loser == c) { _send(winner, dep); }            // griefer pays the executor that defended
    else {
        st.repudiated = true;
        emit ResultRepudiated(taskId, loser, results[taskId][c].execDigest);
        _send(c, dep);                                 // deposit back; the slash already paid the challenger
    }
}
```

**The fan-out slash stays in `ExecutionDisputes`, not here.** Only the claim manager and the disputes contract
are slashers (`InstanceRegistry.setClaimManager` registers the first, `DeployBNB.s.sol` the second); the market
is not, deliberately. So `_resolve` is the place that iterates the task's executors, reads each one's result
through `market.resultOf`, and slashes those whose digest equals the loser's — they asserted the identical wrong
answer. Moving that loop into the market would mean granting the market slashing rights, which widens the
trusted set for no reason.

**What this does not do: it does not claw back the fee.** Settlement paid at `settle` and that transfer is gone.
The deterrent is the slash, which is why `SLASH_AMOUNT` (0.5 BNB) is already specified to exceed any single task
fee. Repudiation is a fact recorded on-chain about the result, not a refund — and for a scientific claim that
*is* the thing that matters: the digest stops being citable.

---

## 3. Parameters, and one coupling that has to be checked

| parameter | proposal | rationale |
|---|---|---|
| `CHALLENGE_DEPOSIT` | **measure first** | must exceed the gas an honest executor spends defending a full bisection. `OPENING_DEPOSIT` is 0.01 BNB for a *single* tile opening; an execution dispute is Step → (Refine) → Neuron → Row → Term, many rounds. Set it from `Gas.t.sol`, not from a guess |
| `CHALLENGE_WINDOW` | ≤ `EXIT_DELAY` | **the coupling.** `requestExit()` sets `exitAt = block + EXIT_DELAY` and `finalizeExit()` returns the whole bond. A window longer than the exit delay lets a liar settle, exit, and be challenged with nothing left to slash. `EXIT_DELAY` is not in `docs/DESIGN.md` §4's parameter table at all, which is its own gap |

A second-order note: `isBondedFor` requires `exitAt == 0`, so an exiting instance stops being eligible
immediately — but `slash` still works against a bond that has not been finalised. So the window does not need to
be shorter than the delay, only not longer.

---

## 4. Griefing, in both directions

- **Against the executor.** A challenger can force a full bisection for the cost of the deposit. The existing
  timeout rule (`ROUND_BLOCKS`, a party that does not post loses) already bounds the duration, and the deposit
  bounds the cost — that is the whole reason for sizing it in §3.
- **Against the challenger.** An executor can stall to the timeout, but that loses them the dispute, so it is
  self-defeating. The real asymmetry is that the challenger must be *resident* to play: the bisection needs
  per-step roots, the activation tree and CSR rows. That is not a weakness, it is the point — the party able to
  challenge is exactly the party that contributed compute.
- **One challenge per task.** `challenger[taskId] == address(0)` is deliberate: a second challenger adds nothing
  (the first one either proves the digest wrong or does not) and would complicate deposit accounting.

---

## 5. Tests (`contracts/evm/test/ReplicatorStanding.t.sol` — written, never run)

Twelve cases, of which the file covers eleven: the full-bisection win, the fee that is *not* clawed back, the
fan-out slash, the griefer, and seven guards. Two are deliberately left out and said so in the file's header
(the disabled-feature guard, which needs a second unwired market, and the `withdrawable` fallback, which needs a
recipient that refuses ether).

**The trick: most of this needs no bisection.** A challenge opens the dispute in `Phase.Step`, and
`disp.timeout` already resolves against whichever party failed to post. So reveal `FX.actRootsA()` /
`FX.actRootsB()` for one side, let the other stay silent, roll past `ROUND_BLOCKS`, and the full accounting
(slash, deposit, `repudiated`) is exercised in both directions without driving Neuron/Row/Term at all. Only
cases 1–2 below want the whole game, and `Mesh.t.sol`'s `runToRow` already drives it.

**The other constraint the fixtures impose.** In those fixtures **B is the liar** and results are pre-signed by
A's and B's session keys, so two executors can never be made to *agree* — they always disagree and `settle`
opens a dispute instead of settling. To get a *settled* task to challenge, use redundancy 1 with a
test-controlled instance (`vm.addr`/`vm.sign` over `PorwEIP712.digest(...)`, whose library functions are
`internal` and so callable from the test) asserting B's `execRoot`; then the challenger brings A's.

Mirroring `Mesh.t.sol` and `NegativeCases.t.sol`:

1. honest challenger with the correct digest → executor slashed, deposit refunded, `repudiated == true`
2. two agreeing executors, challenger wins → **both** executors slashed
3. dishonest challenger → deposit to the executor, no slash, `repudiated == false`
4. challenger times out mid-bisection → loses the deposit
5. executor times out defending → slashed, as today
6. challenge outside `CHALLENGE_WINDOW` reverts
7. challenge with a digest equal to the settled one reverts
8. challenge by an address that was a sortitioned executor reverts
9. second challenge on the same task reverts
10. `msg.value < CHALLENGE_DEPOSIT` reverts
11. challenge against an unsettled task reverts (that path is `settle`'s)
12. int-lif and int-spmv both, since the phases differ (`Refine` exists only for lif)

---

## 6. The surface this unlocks

A replicate-and-compare mode in the node page, which until now had no reason to exist: pick a settled `taskId`,
read `taskInfo` and `taskInput`, re-execute in the worker the node already runs, compare against the settled
digest, and on a mismatch offer to post the challenge. The tab is already holding the brain — that is what the
whole contribute-compute path was for. Without §2 that mode ends in a sentence; with it, it ends in a
transaction.
