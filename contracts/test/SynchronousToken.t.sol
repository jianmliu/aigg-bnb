// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./SynchronousVerification.t.sol";
import {TestToken} from "./MultiAssetTaskMarket.t.sol";

interface IRoyaltySync {
    function setTokenBeneficiaryAllowed(address, bool) external;
}

contract SyncRoyaltyRecipient {
    address public MARKET;
    bool public reject;

    constructor(address m) {
        MARKET = m;
    }

    function supportsTokenRoyalties() external pure returns (bool) {
        return true;
    }

    function setReject() external {
        reject = true;
    }

    function royaltyRecipients(bytes32) external view returns (address, address, uint16) {
        require(!reject);
        return (address(0xA11CE), address(0xBACE), 2000);
    }
}

contract SynchronousTokenTest is SynchronousVerificationTest {
    TestToken coin;

    function tokenSetup() internal {
        coin = new TestToken();
        coin.mint(address(this), 10000);
        coin.approve(address(market), type(uint256).max);
        SynchronousTaskMarket m = SynchronousTaskMarket(address(market));
        m.setTokenAllowed(address(coin), true);
        vm.prank(a);
        m.setAcceptedToken(address(coin), true);
        vm.prank(b);
        m.setAcceptedToken(address(coin), true);
    }

    function tokenPost() internal returns (bytes32) {
        return SynchronousTaskMarket(address(market)).postTokenTask(task(), address(coin), bytes32(0));
    }

    function agree(bytes32 id) internal {
        bytes32 r = keccak256("r");
        commit(id, a, 11, r, r);
        commit(id, b, 12, r, r);
        reveal(id, a, 11, r, r);
        reveal(id, b, 12, r, r);
    }

    function test_tokenAgreementAndRefundDenomination() public {
        tokenSetup();
        bytes32 id = tokenPost();
        agree(id);
        assertEq(market.credits(address(coin), a), 45);
        assertEq(market.credits(address(0), a), 0);
        assertEq(coin.balanceOf(address(market)), 101);
        vm.prank(a);
        SynchronousTaskMarket(address(market)).withdrawCredit(address(coin), payable(address(0xCAFE)));
        assertEq(coin.balanceOf(address(0xCAFE)), 45);
    }

    function test_tokenSilenceRefundNoRoyalty() public {
        tokenSetup();
        bytes32 id = tokenPost();
        (, uint64 end,,) = market.sessionState(id);
        vm.roll(end + 1);
        market.expire(id);
        assertEq(market.credits(address(coin), address(this)), 101);
        assertEq(SynchronousTaskMarket(address(market)).tokenRoyalties(mid, address(coin)), 0);
    }

    function configureRoyalty(bool reject) internal returns (SyncRoyaltyRecipient r) {
        r = new SyncRoyaltyRecipient(address(market));
        IRoyaltySync(address(market)).setTokenBeneficiaryAllowed(address(r), true);
        IMEPRegistry meps = SynchronousTaskMarket(address(market)).meps();
        vm.mockCall(address(meps), abi.encodeWithSelector(meps.termsOf.selector), abi.encode(address(r), uint16(1000)));
        if (reject) r.setReject();
    }

    function test_tokenRoyaltyHolderAndVendorPullCredits() public {
        tokenSetup();
        configureRoyalty(false);
        bytes32 id = tokenPost();
        agree(id);
        assertEq(market.credits(address(coin), address(0xA11CE)), 8);
        assertEq(market.credits(address(coin), address(0xBACE)), 2);
        assertEq(SynchronousTaskMarket(address(market)).tokenRoyalties(mid, address(coin)), 0);
    }

    function test_rejectingRoyaltyViewCannotBlockClosure() public {
        tokenSetup();
        configureRoyalty(true);
        bytes32 id = tokenPost();
        agree(id);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 4);
        assertEq(SynchronousTaskMarket(address(market)).tokenRoyalties(mid, address(coin)), 10);
    }

    function testFuzz_tokenAgreementConservesFee(uint96 fee) public {
        vm.assume(fee > 0);
        tokenSetup();
        coin.mint(address(this), fee);
        ITaskMarket.Task memory t = task();
        t.fee = fee;
        bytes32 id = SynchronousTaskMarket(address(market)).postTokenTask(t, address(coin), bytes32(0));
        agree(id);
        uint256 accounted = market.credits(address(coin), a) + market.credits(address(coin), b)
            + market.credits(address(coin), address(this))
            + SynchronousTaskMarket(address(market)).tokenRoyalties(mid, address(coin));
        assertEq(accounted, fee);
    }

    function test_unregisteredContractTokenBeneficiaryRejectedAtomically() public {
        tokenSetup();
        SyncRoyaltyRecipient recipient = new SyncRoyaltyRecipient(address(market));
        IMEPRegistry meps = SynchronousTaskMarket(address(market)).meps();
        vm.mockCall(
            address(meps), abi.encodeWithSelector(meps.termsOf.selector), abi.encode(address(recipient), uint16(1000))
        );
        vm.expectRevert();
        this.tryTokenPost();
        assertEq(coin.balanceOf(address(this)), 10000);
        assertTrue(market.ready(a));
    }

    function tryTokenPost() external {
        tokenPost();
    }
}
