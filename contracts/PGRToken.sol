// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./SignedMintToken.sol";
contract PGRToken is SignedMintToken {
    constructor(uint256 cap_, address signer_) SignedMintToken("PGR Token", "PGR", cap_, signer_) {}
}
