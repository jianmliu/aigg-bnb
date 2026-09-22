// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
contract SubscriptionCoordinator {
    event SubscriptionCreated(uint256 indexed subId, address owner);
    uint256 public count;
    mapping(uint256 => address) public owners;
    mapping(uint256 => uint96) public balances;
    mapping(uint256 => address[]) internal consumers;
    function createSubscription() external returns (uint256 id) {
        id = ++count; owners[id] = msg.sender; emit SubscriptionCreated(id, msg.sender);
    }
    function fundSubscriptionWithNative(uint256 id) external payable {
        require(owners[id] != address(0)); balances[id] += uint96(msg.value);
    }
    function addConsumer(uint256 id, address consumer) external {
        require(msg.sender == owners[id]); consumers[id].push(consumer);
    }
    function getSubscription(uint256 id) external view returns (uint96,uint96,uint64,address,address[] memory) {
        require(owners[id] != address(0)); return (0,balances[id],0,owners[id],consumers[id]);
    }
}
