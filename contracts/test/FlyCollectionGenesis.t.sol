// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";

/// The published genesis set against the contract that commits to it: flybnb/genesis/genesis-v1.json is read as a
/// stranger would read it, and its root, indices, hashes and proofs are what `mint` is called with.
contract FlyCollectionGenesisTest is Test {
    using stdJson for string;
    function test_the_published_founders_can_be_adopted_with_their_published_proofs_and_nothing_else_can() public {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/../flybnb/genesis/genesis-v1.json"));
        bytes32 root = j.readBytes32(".root"); uint32 size = uint32(j.readUint(".size")); bytes32 base = j.readBytes32(".baseModelId");
        MEPRegistry meps = new MEPRegistry(); address treasury = address(0x7EA); uint256 PRICE = 0.1 ether;
        FlyCollection c = new FlyCollection(base, bytes32(0), root, size, PRICE, 0, 0.05 ether, 0.001 ether, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), bytes32(0), bytes32(0), IRoyaltyMarket(address(0)), 0);
        address alice = address(0xA11CE); vm.deal(alice, 10 ether); vm.startPrank(alice);
        uint32[4] memory picks = [uint32(0), 57, 98, 99]; // the ends, the middle, and the odd node that is carried up the tree
        for (uint256 k = 0; k < picks.length; k++) {
            string memory at = string.concat(".individuals[", vm.toString(picks[k]), "]");
            bytes32 deltaHash = j.readBytes32(string.concat(at, ".deltaHash")); bytes32[] memory proof = j.readBytes32Array(string.concat(at, ".proof"));
            assertEq(deltaHash, keccak256(j.readBytes(string.concat(at, ".recipe"))), "deltaHash is the hash of the published recipe");
            uint256 id = c.mint{value: PRICE}(picks[k], 0, deltaHash, proof);
            (bytes32 b, bytes32 dh,,, uint8 sex,,,,,) = c.individuals(id); assertEq(b, base); assertEq(dh, deltaHash); assertEq(sex, 0);
        }
        bytes32[] memory p0 = j.readBytes32Array(".individuals[1].proof"); bytes32 d1 = j.readBytes32(".individuals[1].deltaHash");
        vm.expectRevert(bytes("not in the genesis set")); c.mint{value: PRICE}(1, 1, d1, p0);                       // the right fly, called male
        vm.expectRevert(bytes("not in the genesis set")); c.mint{value: PRICE}(2, 0, d1, p0);                       // under another index
        vm.expectRevert(bytes("index")); c.mint{value: PRICE}(size, 0, d1, p0);                                     // past the end
        c.mint{value: PRICE}(1, 0, d1, p0); vm.expectRevert(bytes("index")); c.mint{value: PRICE}(1, 0, d1, p0);    // and only once
        vm.stopPrank(); assertEq(c.totalSupply(), 5); assertEq(treasury.balance, 5 * PRICE);
    }
}
