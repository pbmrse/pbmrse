// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Transfers and signed issuance only. Business accounting stays off-chain.
abstract contract SignedMintToken is ERC20, Ownable, EIP712 {
    uint256 public immutable cap;
    address public mintSigner;
    uint256 public signerEpoch = 1;
    mapping(bytes32 => bool) public usedClaims;
    bytes32 public constant MINT_TYPEHASH = keccak256("Mint(address recipient,uint256 amount,bytes32 claimId,uint256 deadline,uint256 signerEpoch)");
    event MintSignerUpdated(address indexed previousSigner, address indexed newSigner, uint256 epoch);
    event AuthorizedMint(address indexed recipient, bytes32 indexed claimId, uint256 amount);
    constructor(string memory name_, string memory symbol_, uint256 cap_, address signer_)
        ERC20(name_, symbol_) Ownable(msg.sender) EIP712(name_, "2") {
        require(cap_ > 0, "zero cap"); require(signer_ != address(0), "zero signer");
        cap = cap_; mintSigner = signer_;
    }
    function setMintSigner(address signer) external onlyOwner {
        require(signer != address(0), "zero signer");
        address previous = mintSigner; mintSigner = signer; signerEpoch += 1;
        emit MintSignerUpdated(previous, signer, signerEpoch);
    }
    function mintWithAuthorization(address recipient, uint256 amount, bytes32 claimId, uint256 deadline, uint256 epoch, bytes calldata signature) external {
        require(recipient != address(0) && amount > 0 && claimId != bytes32(0), "invalid mint");
        require(block.timestamp <= deadline, "authorization expired");
        require(epoch == signerEpoch, "signer epoch changed"); require(!usedClaims[claimId], "claim already used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(MINT_TYPEHASH, recipient, amount, claimId, deadline, epoch)));
        require(SignatureChecker.isValidSignatureNow(mintSigner, digest, signature), "invalid authorization");
        require(amount <= cap - totalSupply(), "cap exceeded");
        usedClaims[claimId] = true; _mint(recipient, amount);
        emit AuthorizedMint(recipient, claimId, amount);
    }
}
