import {serverDB} from './server-db';
import type {Address} from 'viem';
export async function confirmReferrer(wallet:Address,requested:Address|null){
 const db=serverDB();const current=await db.prepare('SELECT parent_wallet FROM wallet_referrals WHERE wallet_address=?').bind(wallet).first<{parent_wallet:Address|null}>();
 if(current?.parent_wallet){if(requested&&current.parent_wallet!==requested)throw new Error('Your confirmed referrer cannot be changed');return current.parent_wallet;}
 if(requested===wallet)throw new Error('Self-referral is not allowed');
 const now=Date.now();
 if(!requested){await db.prepare('INSERT OR IGNORE INTO wallet_referrals(wallet_address,parent_wallet,confirmed_at) VALUES (?,NULL,?)').bind(wallet,now).first();return null;}
 await db.prepare(`INSERT INTO wallet_referrals(wallet_address,parent_wallet,confirmed_at)
 SELECT ?,?,? WHERE (SELECT COUNT(*) FROM wallet_referrals WHERE parent_wallet=?)<10
 AND NOT EXISTS(WITH RECURSIVE ancestors(wallet,parent) AS (
 SELECT wallet_address,parent_wallet FROM wallet_referrals WHERE wallet_address=?
 UNION ALL SELECT r.wallet_address,r.parent_wallet FROM wallet_referrals r JOIN ancestors a ON a.parent=r.wallet_address
 ) SELECT 1 FROM ancestors WHERE wallet=?)
 ON CONFLICT(wallet_address) DO UPDATE SET parent_wallet=excluded.parent_wallet,confirmed_at=excluded.confirmed_at WHERE wallet_referrals.parent_wallet IS NULL`)
 .bind(wallet,requested,now,requested,requested,wallet).first();
 const confirmed=await db.prepare('SELECT parent_wallet FROM wallet_referrals WHERE wallet_address=?').bind(wallet).first<{parent_wallet:Address|null}>();
 if(confirmed?.parent_wallet!==requested)throw new Error('Referral limit reached or referral cycle rejected');
 return requested;
}
