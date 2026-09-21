// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./SynchronousWitnessGas.t.sol";

interface IChunkRows {
    function postRowChunk(bytes32, uint32, uint32, uint32, uint64[] calldata) external;
    function postRowLifChunk(bytes32, uint32, uint32, int32, int32, uint16, uint16, uint32, int64[] calldata) external;
    function rowTotal(bytes32, address) external view returns (uint32);
}

contract SynchronousChunksTest is Test {
    SynchronousWitnessHarness h;
    IChunkRows chunks;
    bytes32 id = bytes32(uint256(1));

    function setUp() public {
        SynchronousTaskMarket m = SynchronousTaskMarket(address(0x1234));
        vm.mockCall(address(m), abi.encodeWithSignature("disputeActive(bytes32)"), abi.encode(true));
        vm.mockCall(address(m), abi.encodeWithSignature("totalDeadline(bytes32)"), abi.encode(uint64(1000)));
        h = new SynchronousWitnessHarness(m);
        h.prime(id, address(this), true);
        chunks = IChunkRows(address(h));
    }

    function data() internal pure returns (int64[] memory a) {
        a = new int64[](1024);
        for (uint256 j; j < 1024; j++) {
            a[j] = -int64(int256(j + 1));
        }
    }

    function test_lif16384UploadedInBoundedChunks() public {
        int64[] memory values = data();
        uint256 high;
        for (uint32 offset; offset < 16384; offset += 1024) {
            uint256 before = gasleft();
            chunks.postRowLifChunk(id, offset, 16384, 1, 1, 1, 1, 1, values);
            uint256 used = before - gasleft();
            if (used > high) high = used;
            SynchronousExecutionDisputes.LifParty memory p = h.lifPartyState(id, address(this));
            assertEq(p.sums.length, offset + 1024);
            assertEq(p.rowPosted, offset == 15360);
        }
        assertEq(chunks.rowTotal(id, address(this)), 16384);
        assertLt(high + 600000, 16777216);
        emit log_named_uint("max1024 LIF chunk execution gas", high);
    }

    function test_chunkRejectsSkipsRepeatChangedStateAndTotal() public {
        int64[] memory values = data();
        chunks.postRowLifChunk(id, 0, 2048, 1, 1, 1, 1, 1, values);
        vm.expectRevert();
        chunks.postRowLifChunk(id, 0, 2048, 1, 1, 1, 1, 1, values);
        vm.expectRevert();
        chunks.postRowLifChunk(id, 1025, 2048, 1, 1, 1, 1, 1, values);
        vm.expectRevert();
        chunks.postRowLifChunk(id, 1024, 3072, 1, 1, 1, 1, 1, values);
        vm.expectRevert();
        chunks.postRowLifChunk(id, 1024, 2048, 2, 1, 1, 1, 1, values);
        vm.roll(1001);
        vm.expectRevert();
        chunks.postRowLifChunk(id, 1024, 2048, 1, 1, 1, 1, 1, values);
    }

    function test_spmvChunksAndLegacyOversize() public {
        h.prime(id, address(this), false);
        uint64[] memory values = new uint64[](1024);
        for (uint256 j; j < 1024; j++) {
            values[j] = uint64(j + 1);
        }
        chunks.postRowChunk(id, 0, 2048, 1, values);
        assertFalse(h.partyState(id, address(this)).rowPosted);
        chunks.postRowChunk(id, 1024, 2048, 1, values);
        assertTrue(h.partyState(id, address(this)).rowPosted);
        bytes32 other = bytes32(uint256(2));
        h.prime(other, address(this), false);
        uint64[] memory large = new uint64[](1025);
        vm.expectRevert();
        h.postRow(other, 1, large);
    }

    function test_sponsoredMaximumChunkBelowTransactionGasCap() public {
        address host = vm.addr(11);
        h.prime(id, host, true);
        vm.mockCall(address(2), abi.encodeWithSignature("resolve(address)", host), abi.encode(host));
        bytes memory move = abi.encodeCall(chunks.postRowLifChunk, (id, 0, 16384, 1, 1, 1, 1, 1, data()));
        bytes32 digest = h.moveDigest(id, host, 3, 0, 0, 10, keccak256(move));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(11, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        uint256 before = gasleft();
        h.forwardMove(id, host, 3, 0, 0, 10, move, signature);
        uint256 used = before - gasleft();
        assertLt(used + 600000, 16777216);
        emit log_named_uint("sponsored1024LIFchunk execution gas", used);
        assertEq(h.moveNonce(id, host), 1);
    }
}
