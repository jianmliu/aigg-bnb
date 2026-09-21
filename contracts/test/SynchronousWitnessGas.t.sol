// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/SynchronousExecutionDisputes.sol";

/// Candidate-size storage experiment. Identical array assignment and packed element types to
/// production postRow/postRowLif, deliberately independent of its current8192 admission cap.
contract SynchronousWitnessStorageProbe {
    struct SignedRow {
        LifRowCheck.State state;
        int64[] sums;
        bool rowPosted;
    }

    struct UnsignedRow {
        uint32 act;
        uint64[] sums;
        bool rowPosted;
    }
    mapping(bytes32 => SignedRow) private signedRows;
    mapping(bytes32 => UnsignedRow) private unsignedRows;

    function storeLif(bytes32 id, int64[] calldata sums) external {
        SignedRow storage row = signedRows[id];
        row.state = LifRowCheck.State(1, 1, 1, 1, 1);
        row.sums = sums;
        row.rowPosted = true;
    }

    function storeSpmv(bytes32 id, uint64[] calldata sums) external {
        UnsignedRow storage row = unsignedRows[id];
        row.act = 1;
        row.sums = sums;
        row.rowPosted = true;
    }
}

contract SynchronousWitnessHarness is SynchronousExecutionDisputes, Test {
    constructor(SynchronousTaskMarket market_)
        SynchronousExecutionDisputes(IMEPRegistry(address(1)), InstanceRegistry(address(2)), market_, 5, 1)
    {}

    function prime(bytes32 id, address host, bool lif) external {
        disputes[id].exists = true;
        disputes[id].phase = Phase.Synapse;
        disputes[id].deadline = 1000;
        partyA[id] = host;
        lifs[id].lif = lif;
        parties[id][host].leaf =
            lif ? LifRowCheck.stateLeaf(0, LifRowCheck.State(1, 1, 1, 1, 1)) : keccak256(hex"0000000001000000");
    }
}

contract SynchronousWitnessGasTest is Test {
    function measure(uint256 n) internal {
        SynchronousWitnessStorageProbe probe = new SynchronousWitnessStorageProbe();
        int64[] memory lif = new int64[](n);
        uint64[] memory spmv = new uint64[](n);
        for (uint256 j; j < n; j++) {
            lif[j] = -int64(int256(j + 1));
            spmv[j] = uint64(j + 1);
        }
        uint256 before = gasleft();
        probe.storeLif(bytes32(uint256(n)), lif);
        uint256 lifGas = before - gasleft();
        before = gasleft();
        probe.storeSpmv(bytes32(uint256(n)), spmv);
        uint256 spmvGas = before - gasleft();
        emit log_named_uint("witness entries", n);
        emit log_named_uint("LIF fresh array storage execution gas", lifGas);
        emit log_named_uint("SpMV fresh array storage execution gas", spmvGas);
        emit log_named_uint("worst ABI calldata gas additional", (4 + 32 + 32 + 32 + n * 32) * 16);
    }

    function test_storageWitness8192Gas() public {
        measure(8192);
    }

    function test_storageWitness10167Gas() public {
        measure(10167);
    }

    function test_storageWitness16384Gas() public {
        measure(16384);
    }
}
