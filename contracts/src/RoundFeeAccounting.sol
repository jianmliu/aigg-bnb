// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "./RoundVrfAdmission.sol";

/// @notice Settle the prepaid round admission cap once a task reaches a terminal state.
library RoundFeeAccounting {
    function settle(
        mapping(address => mapping(address => uint256)) storage credits,
        RoundVrfAdmission admission,
        bytes32 id,
        address token,
        address client
    ) external {
        uint256 prepaid = admission.admissionFee(token);
        uint256 charged = admission.admissionCharge(id, token);
        credits[token][admission.feeRecipient()] += charged;
        credits[token][client] += prepaid - charged;
    }
}
