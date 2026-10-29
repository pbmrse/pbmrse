import { isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { serverDB } from './server-db';

export type WalletProof = { walletAddress?: string; nonce?: string; signature?: Hex };
export async function authenticateWallet(proof: WalletProof, purpose: string): Promise<Address> {
  const wallet = proof.walletAddress?.trim().toLowerCase();
  if (!wallet || !isAddress(wallet) || !proof.nonce || !proof.signature) throw new Error('Wallet signature is required');
  const db = serverDB();
  const row = await db.prepare('SELECT message,expires_at,used_at FROM wallet_auth_challenges WHERE nonce=? AND wallet_address=? AND purpose=? LIMIT 1')
    .bind(proof.nonce, wallet, purpose).first<{ message: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at !== null || row.expires_at <= Date.now()) throw new Error('Wallet challenge expired or already used');
  if (!await verifyMessage({ address: wallet, message: row.message, signature: proof.signature })) throw new Error('Invalid wallet signature');
  const consumed = await db.prepare('UPDATE wallet_auth_challenges SET used_at=? WHERE nonce=? AND used_at IS NULL AND expires_at>? RETURNING nonce')
    .bind(Date.now(), proof.nonce, Date.now()).first<{ nonce: string }>();
  if (!consumed) throw new Error('Wallet challenge expired or already used');
  return wallet;
}
