import { parseAbi } from 'viem';
export const SIGNED_MINT_ABI = parseAbi([
 'function mintSigner() view returns (address)',
 'function signerEpoch() view returns (uint256)',
 'function usedClaims(bytes32) view returns (bool)',
 'function totalSupply() view returns (uint256)',
 'function cap() view returns (uint256)',
 'function mintWithAuthorization(address recipient,uint256 amount,bytes32 claimId,uint256 deadline,uint256 epoch,bytes signature)',
 'event AuthorizedMint(address indexed recipient,bytes32 indexed claimId,uint256 amount)',
]);
export const MINT_TYPES = {Mint:[
 {name:'recipient',type:'address'}, {name:'amount',type:'uint256'},
 {name:'claimId',type:'bytes32'}, {name:'deadline',type:'uint256'},
 {name:'signerEpoch',type:'uint256'},
]} as const;
