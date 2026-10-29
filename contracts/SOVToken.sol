// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./SignedMintToken.sol";
contract SOVToken is SignedMintToken {
    constructor(uint256 cap_, address signer_) SignedMintToken("SOV Token", "SOV", cap_, signer_) {}
}
