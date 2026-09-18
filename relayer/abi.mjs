// Human-readable ABIs (viem parseAbi) for the mesh contracts the relayer and the frontend talk to.
import { parseAbi } from "viem";
export const InstanceRegistryAbi = parseAbi([
  "function bond(bytes32[] mepIds) payable",
  "function requestExit()",
  "function finalizeExit()",
  "function bonded(address) view returns (uint256)",
  "function exitAt(address) view returns (uint64)",
  "function weightOf(address) view returns (uint256)",
  "function bondFor(address instance, bytes32[] mepIds) payable", // a payer can only add to someone's bond
  "function isBondedFor(address inst, bytes32 mepId) view returns (bool)",
  "function isEligible(address inst, bytes32 mepId, uint64 epoch) view returns (bool)",
  "function claimValidityEpochs() view returns (uint64)", // a valid claim keeps its instance eligible for this many epochs
  "function eligibleVotes(bytes32 mepId, uint64 epoch) view returns (address[])",
  "function setSessionKey(address session, uint64 expiry)",
  "function delegateBySig(address instance, address session, uint64 expiry, bytes sig)",
  "function revokeSessionKey(address session)",
  "function resolve(address signer) view returns (address)",
  "function delegations(address) view returns (address instance, uint64 expiry)",
  "function UNIT() view returns (uint256)",
  "function EXIT_DELAY() view returns (uint64)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
export const ClaimManagerAbi = parseAbi([
  "struct Claim { bytes32 mepId; bytes32 partialsRoot; uint64 coverageBytes; bytes32 challenge; }",
  "struct ClaimLeaf { bytes32 mepId; address instance; bytes32 partialsRoot; uint64 coverageBytes; bytes signature; }",
  "function EPOCH_BLOCKS() view returns (uint64)",
  "function currentEpoch() view returns (uint64)",
  "function beacon(uint64) view returns (bytes32)",
  "function rollEpoch() returns (bytes32)",
  "function epochChallenge(uint64 epoch, bytes32 mepId) view returns (bytes32)",
  "function claimIdOf(address instance, bytes32 mepId, uint64 epoch) pure returns (bytes32)",
  "function hasValidClaim(address instance, bytes32 mepId, uint64 epoch) view returns (bool)",
  "function submitClaim(Claim c, bytes signature) returns (bytes32)",
  "function postEpochRoot(uint64 epoch, bytes32 root, uint64 count)", // one root per epoch over the claims of every MEP
  "function epochRoots(uint64, address) view returns (bytes32 root, uint64 count)",
  "function materializeClaim(uint64 epoch, address aggregator, uint64 index, ClaimLeaf l, bytes32[] proof) returns (bytes32)",
  "function claimRecord(bytes32 claimId) view returns (bytes32)",
  "function lastValidEpochPlus1(address instance, bytes32 mepId) view returns (uint64)", // (epoch + 1) of the most recent valid claim; 0 none / struck down // commitment to the claim's contents | valid
  "function challengeOpening(address instance, bytes32 mepId, uint64 epoch, bytes32 partialsRoot, uint64 coverageBytes, uint64 tileIdx) payable returns (bytes32)",
  "function claimLeafHash(ClaimLeaf l) pure returns (bytes32)",
  "function beaconProvider() view returns (address)",
  "event ClaimSubmitted(bytes32 indexed claimId, address indexed instance, bytes32 indexed mepId, uint64 epoch)",
  "event EpochRootPosted(uint64 indexed epoch, address indexed aggregator, bytes32 root, uint64 count)",
  "event ClaimData(bytes32 indexed claimId, bytes32 partialsRoot, uint64 coverageBytes)",
]);
export const TaskMarketAbi = parseAbi([
  "struct Task { bytes32 mepId; uint32 stimulusSeed; uint32 steps; uint32 commitStride; bytes32 initStateRoot; uint256 fee; uint64 deadline; uint8 redundancy; }",
  "struct Result { bytes32 execDigest; bytes32 execRoot; }",
  "function postTask(Task t, bytes32 nonce) payable returns (bytes32)",
  // one task, many runs of the same brain: t.initStateRoot is the root of the runs, t.stimulusSeed is 0. Results, settlement
  // and sponsorship are the single task's -- a batch result is still one (execDigest, execRoot) -- so nothing else changes
  "function postBatch(Task t, uint32 runs, bytes32 nonce) payable returns (bytes32)",
  "function batchRuns(bytes32 taskId) view returns (uint32)",
  "event BatchPosted(bytes32 indexed taskId, uint32 runs, bytes32 runsRoot)",
  "function executors(bytes32 taskId) view returns (address[])",
  "function submitResult(bytes32 taskId, Result r, bytes signature)",
  "function settle(bytes32 taskId)",
  "function resultOf(bytes32 taskId, address who) view returns (bytes32 execDigest, bytes32 execRoot)",
  "function taskInfo(bytes32 taskId) view returns (bytes32 mepId, uint32 stimulusSeed, address client, uint32 steps, uint32 commitStride)",
  "function submitted(bytes32, address) view returns (bool)",
  // standing for a replicator: a non-executor disputes a SETTLED result (challengeWindow 0 = the deployment left it off)
  "function challengeWindow() view returns (uint64)",
  "function challengeDepositWei() view returns (uint256)",
  "function requiredChallengeDeposit(bytes32 taskId) view returns (uint256)", // doubles with every challenge the task has thrown out
  "function challengeResult(bytes32 taskId, Result r) payable",
  "function settledRef(bytes32 taskId) view returns (address)",
  "event TaskPosted(bytes32 indexed taskId, bytes32 indexed mepId, uint8 redundancy)",
  // the digest a settled task endorses: a strict majority of its paid executors', or zero when they split (agreement is on
  // the execRoot; the digest is not bound to it). TaskSettled carries the same value, so it can be zero too
  "function settledDigest(bytes32 taskId) view returns (bytes32)",
  "event TaskSettled(bytes32 indexed taskId, bytes32 execDigest, address[] executors)",
]);
export const MEPRegistryAbi = parseAbi([
  "struct MEP { bytes32 modelId; bytes32 schemeDigest; bytes32 execKind; uint32 neurons; uint32 synapses; bytes32 synapseRoot; bytes weightsDA; }",
  "function registerMEP(MEP m) returns (bytes32)",
  "function getMEP(bytes32 id) view returns (MEP)",
  "function exists(bytes32) view returns (bool)",
]);
export const BeaconAbi = parseAbi([
  "function EPOCH_BLOCKS() view returns (uint64)", "function COMMIT_BLOCKS() view returns (uint64)", "function REVEAL_BLOCKS() view returns (uint64)", "function DEPOSIT() view returns (uint256)",
  "function commit(bytes32 h) payable", "function reveal(uint64 e, bytes32 secret)", "function beaconFor(uint64 e) view returns (bytes32)",
  "function commits(uint64, address) view returns (bytes32 hash, bool revealed, uint256 deposit)",
]);
export const RelayRegistryAbi = parseAbi([
  "function register(string url) payable", "function relays() view returns (address[] ops, string[] urls)", "function BOND() view returns (uint256)",
]);
// the collection, as far as the hatch keeper is concerned (relayer.mjs section 5)
export const FlyCollectionAbi = parseAbi([
  "function hatch(uint256 id) returns (bytes32)",
  "function HATCH_BOUNTY() view returns (uint256)",
  "event Bred(uint256 indexed id, uint256 indexed parentA, uint256 indexed parentB, uint64 seedBlock)",
  "event Rearmed(uint256 indexed id, uint64 seedBlock)",
  "event Hatched(uint256 indexed id, bytes32 seed, uint8 sex)",
  // who holds which individual, for the FlyBnB acknowledgments (relayer.mjs section 6)
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 id) view returns (address)",
  "function individuals(uint256 id) view returns (bytes32 baseModelId, bytes32 deltaHash, bytes32 modelId, bytes32 mepId, uint8 sex, uint32 generation, uint64 parentA, uint64 parentB, bytes32 seed, uint64 seedBlock)",
]);
