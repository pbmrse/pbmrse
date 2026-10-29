// Browser EIP-1193 adapter for explicitly authorized PGR/SOV deployment.
// Import from a trusted, reviewed UI only. No automatic execution on import.
const ADDRESS=/^0x[0-9a-f]{40}$/i;
const TXHASH=/^0x[0-9a-f]{64}$/i;
const isNonzeroAddress=value=>typeof value==='string'&&ADDRESS.test(value)&&!/^0x0{40}$/i.test(value);
export async function inspectMainnetDeploymentWallet(provider,unsigned,asset){
 if(!provider||typeof provider.request!=='function')throw Error('EIP-1193 wallet required');
 if(unsigned?.chainId!==56||unsigned?.network!=='bsc-mainnet'||unsigned?.status!=='UNSIGNED_PREPARATION_ONLY'||unsigned?.broadcastAuthorized!==false)throw Error('Invalid unsigned manifest');
 if(!['pgr','sov'].includes(asset))throw Error('Unsupported token');
 const spec=unsigned.transactions?.[asset];
 if(!spec||spec.to!==null||spec.value!=='0'||typeof spec.data!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(spec.data))throw Error('Invalid contract creation payload');
 if(!isNonzeroAddress(unsigned.deployer)||!isNonzeroAddress(unsigned.mintSigner)||unsigned.deployer.toLowerCase()===unsigned.mintSigner.toLowerCase())throw Error('Invalid deployer or signer');
 const chain=await provider.request({method:'eth_chainId'});
 if(typeof chain!=='string'||BigInt(chain)!==56n)throw Error('Wallet must be on BSC mainnet (56)');
 const accounts=await provider.request({method:'eth_accounts'});
 if(!Array.isArray(accounts)||!accounts.some(account=>typeof account==='string'&&account.toLowerCase()===unsigned.deployer.toLowerCase()))throw Error('Expected deployer wallet not connected');
 return Object.freeze({asset,chainId:56,from:unsigned.deployer,data:spec.data,value:'0x0',to:null});
}
export async function submitMainnetDeployment(provider,unsigned,asset,{approved=false,expectedAccount=null,gasLimit=null}={}){
 if(approved!==true)throw Error('Explicit deployment confirmation required');
 const tx=await inspectMainnetDeploymentWallet(provider,unsigned,asset);
 if(!isNonzeroAddress(expectedAccount)||expectedAccount.toLowerCase()!==tx.from.toLowerCase())throw Error('User-approved deployer address mismatch');
 if(typeof gasLimit!=='string'||!/^0x[0-9a-f]+$/i.test(gasLimit)||BigInt(gasLimit)<=0n)throw Error('A successful, positive gas estimate is required');
 // Pass the already successful estimate (with a UI-computed safety margin) to avoid a second wallet-side estimation failure.
 // Deliberately omit to for contract creation. The wallet still requires explicit user confirmation.
 const hash=await provider.request({method:'eth_sendTransaction',params:[{from:tx.from,data:tx.data,value:'0x0',gas:gasLimit}]});
 if(typeof hash!=='string'||!TXHASH.test(hash))throw Error('Wallet returned invalid transaction hash; reconcile before retry');
 return {asset,transactionHash:hash,status:'SUBMITTED_UNVERIFIED',mustVerifyReceipt:true};
}
