// These statements are executed in one D1 batch (an atomic transaction).
export const RESERVE_POSITION = `UPDATE business_positions SET position_json=?,version=version+1,updated_at=?,last_operation_id=? WHERE wallet_address=? AND chain_id=97 AND version=? AND NOT EXISTS (SELECT 1 FROM reward_claims WHERE wallet_address=? AND chain_id=97 AND asset=? AND status='RESERVED')`;
export const RESERVE_CLAIM = `INSERT INTO reward_claims(claim_id,wallet_address,chain_id,asset,amount_atomic,status,created_at,creation_block) SELECT ?,wallet_address,97,?,?,'RESERVED',?,? FROM business_positions WHERE wallet_address=? AND chain_id=97 AND last_operation_id=?`;
export const RESERVE_OPERATION = `INSERT INTO business_operations(operation_id,wallet_address,chain_id,operation_type,amount_atomic,asset,status,created_at) SELECT claim_id,wallet_address,97,?,amount_atomic,asset,'RESERVED',created_at FROM reward_claims WHERE claim_id=?`;

export const RENEW_CLAIM_RECOVERY = `UPDATE reward_claims SET creation_block=?,tx_hash=NULL WHERE claim_id=? AND wallet_address=? AND status='RESERVED'`;
