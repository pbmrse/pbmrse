CREATE TABLE address_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_no INTEGER NOT NULL UNIQUE,
  evm_address TEXT,
  solana_address TEXT,
  wallet_address TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','assigned')),
  assigned_at INTEGER
);
CREATE TABLE sqlite_sequence(name,seq);
CREATE UNIQUE INDEX idx_address_pool_evm ON address_pool(evm_address) WHERE evm_address IS NOT NULL;
CREATE UNIQUE INDEX idx_address_pool_solana ON address_pool(solana_address) WHERE solana_address IS NOT NULL;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  referrer_wallet TEXT,
  direct_referrals INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_users_referrer ON users(referrer_wallet);
CREATE TABLE referral_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_wallet TEXT NOT NULL,
  referred_wallet TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_referral_edges_referrer ON referral_edges(referrer_wallet);
CREATE TABLE admin_sessions (
  session_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE admin_login_attempts (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'BSC',
  asset TEXT NOT NULL DEFAULT 'USDT',
  amount TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  block_number INTEGER,
  status TEXT NOT NULL DEFAULT 'CONFIRMED',
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);
CREATE INDEX idx_deposits_wallet ON deposits(wallet_address);
CREATE INDEX idx_deposits_deposit_address ON deposits(deposit_address);
CREATE TABLE withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'BSC',
  asset TEXT NOT NULL DEFAULT 'USDT',
  amount TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  request_message TEXT NOT NULL,
  request_signature TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  tx_hash TEXT UNIQUE,
  failure_reason TEXT
);
CREATE INDEX idx_withdrawals_wallet ON withdrawals(wallet_address);
CREATE INDEX idx_withdrawals_status ON withdrawals(status);
CREATE TABLE wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK(chain_id=56),
  asset TEXT NOT NULL CHECK(asset IN ('USDT','PGR','SOV')),
  amount_atomic TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_wallet_ledger_account ON wallet_ledger(wallet_address,chain_id,asset);
CREATE TABLE wallet_auth_challenges (
  nonce TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  purpose TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_wallet_auth_expiry ON wallet_auth_challenges(expires_at);
CREATE TABLE business_positions (
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK(chain_id=56),
  version INTEGER NOT NULL DEFAULT 0,
  position_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL, last_operation_id TEXT,
  PRIMARY KEY(wallet_address,chain_id)
);
CREATE TABLE business_operations (
  operation_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK(chain_id=56),
  operation_type TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  asset TEXT NOT NULL CHECK(asset IN ('USDT','PGR','SOV')),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tx_hash TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_business_operations_wallet ON business_operations(wallet_address,chain_id,created_at);
CREATE TABLE reward_claims (
 claim_id TEXT PRIMARY KEY,
 wallet_address TEXT NOT NULL,
 chain_id INTEGER NOT NULL CHECK(chain_id=56),
 asset TEXT NOT NULL CHECK(asset IN ('PGR','SOV')),
 amount_atomic TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('RESERVED','MINTED')),
 created_at INTEGER NOT NULL,
 creation_block INTEGER NOT NULL,
 tx_hash TEXT,
 confirmed_at INTEGER
);
CREATE UNIQUE INDEX idx_reward_claim_active ON reward_claims(wallet_address,chain_id,asset) WHERE status='RESERVED';
CREATE UNIQUE INDEX idx_reward_claim_tx_casefold_unique ON reward_claims(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE INDEX idx_reward_claim_wallet ON reward_claims(wallet_address,chain_id,created_at);
CREATE TABLE wallet_custody_addresses (
 wallet_address TEXT NOT NULL,
 chain_id INTEGER NOT NULL CHECK(chain_id=56),
 deposit_address TEXT NOT NULL UNIQUE,
 root_fingerprint TEXT NOT NULL,
 scan_block INTEGER NOT NULL,
 created_at INTEGER NOT NULL, derivation_version TEXT NOT NULL DEFAULT 'LEGACY_UNSPECIFIED'
  CHECK(derivation_version IN ('LEGACY_UNSPECIFIED','PBMRESERVES_HMAC_SHA256_V1')), derivation_index INTEGER NOT NULL DEFAULT -1
  CHECK(derivation_index BETWEEN -1 AND 9),
 PRIMARY KEY(wallet_address,chain_id)
);
CREATE TABLE wallet_referrals (
 wallet_address TEXT PRIMARY KEY,
 parent_wallet TEXT,
 confirmed_at INTEGER NOT NULL
);
CREATE INDEX idx_wallet_referrals_parent ON wallet_referrals(parent_wallet);
CREATE TABLE bank_transaction_queue (
 job_id TEXT PRIMARY KEY,
 operation_id TEXT,
 owner_wallet TEXT NOT NULL,
 sender_kind TEXT NOT NULL CHECK(sender_kind IN ('TREASURY','CUSTODY')),
 sender_wallet TEXT,
 sender_address TEXT NOT NULL,
 recipient_address TEXT NOT NULL,
 chain_id INTEGER NOT NULL CHECK(chain_id=56),
 asset TEXT NOT NULL CHECK(asset IN ('USDT','BNB','PGR')),
 amount_atomic TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','PREPARING','SIGNED','SENT','CONFIRMED','FAILED','REJECTED','HELD')),
 created_at INTEGER NOT NULL,
 nonce INTEGER,
 raw_transaction TEXT,
 tx_hash TEXT,
 confirmed_at INTEGER,
 last_error TEXT, job_fingerprint TEXT, lease_token TEXT, lease_expires_at INTEGER, fencing_token INTEGER NOT NULL DEFAULT 0, signing_expires_at INTEGER, treasury_day TEXT,
 UNIQUE(chain_id,sender_address,nonce)
);
CREATE UNIQUE INDEX idx_bank_queue_tx_casefold_unique ON bank_transaction_queue(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE INDEX idx_bank_queue_status ON bank_transaction_queue(status,created_at);
CREATE TABLE bank_transaction_attempts (
 tx_hash TEXT PRIMARY KEY,
 job_id TEXT NOT NULL,
 sender_address TEXT NOT NULL,
 nonce INTEGER NOT NULL,
 raw_transaction TEXT NOT NULL,
 gas_price_atomic TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_bank_attempt_sender ON bank_transaction_attempts(sender_address,nonce);
CREATE TABLE bank_deposits (
 wallet_address TEXT NOT NULL,
 chain_id INTEGER NOT NULL CHECK(chain_id=56),
 tx_hash TEXT NOT NULL,
 deposit_address TEXT NOT NULL,
 amount_atomic TEXT NOT NULL,
 block_number INTEGER NOT NULL,
 confirmed_at INTEGER NOT NULL,
 PRIMARY KEY(wallet_address,chain_id,tx_hash)
);
CREATE TABLE bank_scan_cursor (
 cursor_key TEXT PRIMARY KEY,
 next_block INTEGER NOT NULL
);
CREATE UNIQUE INDEX bank_one_active_collection ON bank_transaction_queue(sender_wallet,asset) WHERE sender_kind='CUSTODY' AND status IN ('PENDING','PREPARING','SIGNED','SENT');
CREATE TABLE bank_settings (setting_key TEXT PRIMARY KEY,setting_value TEXT NOT NULL);
CREATE TABLE bank_admin_audit (action_id TEXT PRIMARY KEY,admin_wallet TEXT NOT NULL,action_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX bank_one_active_gas_topup ON bank_transaction_queue(recipient_address) WHERE asset='BNB' AND status IN ('PENDING','PREPARING','SIGNED','SENT');
CREATE TABLE mining_registry(wallet_address TEXT PRIMARY KEY,registered_at INTEGER NOT NULL);
CREATE TABLE mining_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
CREATE TRIGGER mining_referral_insert AFTER INSERT ON wallet_referrals BEGIN UPDATE mining_state SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER mining_referral_update AFTER UPDATE ON wallet_referrals BEGIN UPDATE mining_state SET revision=revision+1 WHERE singleton=1; END;
CREATE TABLE mining_purchase_intents (
 intent_id TEXT PRIMARY KEY,wallet_address TEXT NOT NULL,amount_atomic TEXT NOT NULL,
 recipient_address TEXT NOT NULL,created_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PREPARED','CONFIRMED')),tx_hash TEXT UNIQUE,confirmed_at INTEGER
, referral_wallet TEXT);
CREATE UNIQUE INDEX mining_payment_hash_casefold_unique ON mining_purchase_intents(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE UNIQUE INDEX mining_one_open_intent ON mining_purchase_intents(wallet_address) WHERE status='PREPARED';
CREATE TABLE mining_settlement_batches (
 batch_id TEXT PRIMARY KEY,source_wallet TEXT NOT NULL,from_at INTEGER NOT NULL,to_at INTEGER NOT NULL,
 guard_ok INTEGER NOT NULL CHECK(guard_ok=1),UNIQUE(source_wallet,from_at,to_at)
);
CREATE TABLE business_rewards (
 reward_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES mining_settlement_batches(batch_id),
 wallet_address TEXT NOT NULL,source_wallet TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('MINING','DOWNLINE','UPPER','SMALL_AREA')),
 generation INTEGER NOT NULL,rate_bps INTEGER NOT NULL,requested_atomic TEXT NOT NULL,amount_atomic TEXT NOT NULL,
 from_at INTEGER NOT NULL,to_at INTEGER NOT NULL,created_at INTEGER NOT NULL
);
CREATE INDEX business_rewards_wallet ON business_rewards(wallet_address,created_at);
CREATE INDEX mining_registry_time ON mining_registry(registered_at,wallet_address);
CREATE INDEX idx_mining_queue_next
ON business_positions(
  chain_id,
  json_extract(position_json,'$.miningCapped'),
  COALESCE(json_extract(position_json,'$.miningUpdatedAt'),updated_at),
  wallet_address,
  ltrim(json_extract(position_json,'$.miningPgr'),'0')
);
CREATE TABLE mining_reward_remainders(source_wallet TEXT NOT NULL,recipient_wallet TEXT NOT NULL,kind TEXT NOT NULL,remainder_atomic TEXT NOT NULL,PRIMARY KEY(source_wallet,recipient_wallet,kind));
CREATE TABLE site_swap_intents (
 intent_id TEXT PRIMARY KEY,wallet_address TEXT NOT NULL,asset TEXT NOT NULL CHECK(asset IN ('PGR','SOV')),
 amount_atomic TEXT NOT NULL,gross_usdt_atomic TEXT NOT NULL,fee_usdt_atomic TEXT NOT NULL,net_usdt_atomic TEXT NOT NULL,
 recipient_address TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('PREPARED','CONFIRMED')),
 tx_hash TEXT UNIQUE,confirmed_at INTEGER,confirmation_key TEXT,
 payout_mode TEXT NOT NULL DEFAULT 'WALLET' CHECK(payout_mode IN ('LEDGER','WALLET'))
);
CREATE INDEX site_swap_wallet_time ON site_swap_intents(wallet_address,created_at);
CREATE INDEX site_swap_pending_wallet_time ON site_swap_intents(wallet_address,created_at) WHERE status='PREPARED';
CREATE INDEX site_swap_recovery_cursor ON site_swap_intents(intent_id) WHERE status='PREPARED' AND tx_hash IS NOT NULL;
CREATE TABLE admin_wallet_notes (
 wallet_address TEXT PRIMARY KEY,
 chain_id INTEGER NOT NULL DEFAULT 56 CHECK(chain_id=56),
 note TEXT NOT NULL CHECK(length(note)<=200),
 updated_by TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE site_swap_payouts (
  intent_id TEXT PRIMARY KEY REFERENCES site_swap_intents(intent_id),
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK(chain_id=56),
  usdt_token_address TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY'
    CHECK(status IN ('READY','PREPARING','SIGNED','SENT','CONFIRMED','HELD')),
  tx_hash TEXT UNIQUE,
  raw_transaction TEXT,
  nonce INTEGER,
  confirmed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(amount_atomic <> '0'),
  CHECK(status <> 'CONFIRMED' OR (tx_hash IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK(status <> 'SIGNED' OR (tx_hash IS NOT NULL AND raw_transaction IS NOT NULL))
);
CREATE UNIQUE INDEX site_swap_payout_tx_casefold_unique ON site_swap_payouts(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE INDEX site_swap_payouts_work ON site_swap_payouts(status,created_at);
CREATE INDEX site_swap_payouts_wallet ON site_swap_payouts(wallet_address,created_at);
CREATE TABLE mainnet_stake_intents (
  intent_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 56 CHECK(chain_id=56),
  custody_address TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic <> '0'),
  principal_atomic TEXT,
  referral_wallet TEXT,
  referral_pgr_atomic TEXT,
  payment_tx_hash TEXT UNIQUE,
  payment_block INTEGER,
  status TEXT NOT NULL CHECK(status IN ('PREPARED','CONFIRMED','CANCEL_REQUESTED','REFUND_PENDING','REFUNDED','HELD')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  CHECK(status <> 'CONFIRMED' OR (payment_tx_hash IS NOT NULL AND payment_block IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX mainnet_stake_payment_hash_ci ON mainnet_stake_intents(lower(payment_tx_hash)) WHERE payment_tx_hash IS NOT NULL;
CREATE INDEX mainnet_stake_wallet_status ON mainnet_stake_intents(wallet_address,status,created_at);
CREATE TABLE mainnet_stake_refunds (
  refund_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES mainnet_stake_intents(intent_id),
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 56 CHECK(chain_id=56),
  recipient_address TEXT NOT NULL CHECK(lower(recipient_address)=lower(wallet_address)),
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic <> '0'),
  status TEXT NOT NULL CHECK(status IN ('READY','PREPARING','SIGNED','SENT','CONFIRMED','HELD')),
  sender_address TEXT NOT NULL,
  nonce INTEGER,
  raw_transaction TEXT,
  tx_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  last_error TEXT,
  CHECK(status <> 'CONFIRMED' OR (tx_hash IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK(status <> 'SIGNED' OR (tx_hash IS NOT NULL AND raw_transaction IS NOT NULL))
);
CREATE UNIQUE INDEX mainnet_stake_refund_sender_nonce ON mainnet_stake_refunds(lower(sender_address),nonce) WHERE nonce IS NOT NULL;
CREATE UNIQUE INDEX mainnet_stake_refund_tx_ci ON mainnet_stake_refunds(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE INDEX mainnet_stake_refund_work ON mainnet_stake_refunds(status,created_at);
CREATE TABLE mainnet_token_deployment_runs (
  asset TEXT PRIMARY KEY CHECK(asset IN ('PGR','SOV')),
  chain_id INTEGER NOT NULL CHECK(chain_id=56),
  deployer_address TEXT NOT NULL,
  mint_signer_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PREPARED','SIGNING','SUBMITTED','PENDING','FAILED_RECONCILIATION','DEPLOYED_UNVERIFIED','VERIFIED')),
  transaction_hash TEXT UNIQUE,
  contract_address TEXT UNIQUE,
  deployment_block INTEGER,
  bytecode_hash TEXT NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(lower(deployer_address) <> lower(mint_signer_address))
);
CREATE TRIGGER mainnet_refund_requires_credited_stake
BEFORE INSERT ON mainnet_stake_refunds
BEGIN
 SELECT RAISE(ABORT,'REFUND_STAKE_NOT_CREDITED')
 WHERE NOT EXISTS (
   SELECT 1 FROM mainnet_stake_intents s
   WHERE s.intent_id=NEW.intent_id
     AND s.chain_id=56
     AND s.status IN ('CANCEL_REQUESTED','REFUND_PENDING')
     AND s.payment_tx_hash IS NOT NULL
     AND s.principal_atomic IS NOT NULL
     AND s.principal_atomic NOT GLOB '*[^0-9]*'
     AND length(s.principal_atomic)>0
     AND ltrim(s.principal_atomic,'0')<>''
     AND ltrim(s.principal_atomic,'0')=ltrim(s.amount_atomic,'0')
     AND (length(ltrim(NEW.amount_atomic,'0')) < length(ltrim(s.amount_atomic,'0')) OR (length(ltrim(NEW.amount_atomic,'0')) = length(ltrim(s.amount_atomic,'0')) AND ltrim(NEW.amount_atomic,'0') <= ltrim(s.amount_atomic,'0')))
     AND (length(ltrim(NEW.amount_atomic,'0')) < length(ltrim(s.principal_atomic,'0')) OR (length(ltrim(NEW.amount_atomic,'0')) = length(ltrim(s.principal_atomic,'0')) AND ltrim(NEW.amount_atomic,'0') <= ltrim(s.principal_atomic,'0')))
     AND lower(s.wallet_address)=lower(NEW.wallet_address)
     AND lower(NEW.recipient_address)=lower(s.wallet_address)
 );
END;
CREATE TRIGGER mainnet_refund_update_credit_guard
BEFORE UPDATE OF intent_id,wallet_address,chain_id,recipient_address,amount_atomic ON mainnet_stake_refunds
BEGIN
 SELECT RAISE(ABORT,'REFUND_STAKE_NOT_CREDITED')
 WHERE NOT EXISTS (
   SELECT 1 FROM mainnet_stake_intents s
   WHERE s.intent_id=NEW.intent_id
     AND s.chain_id=56
     AND s.status IN ('CANCEL_REQUESTED','REFUND_PENDING')
     AND s.payment_tx_hash IS NOT NULL
     AND s.principal_atomic IS NOT NULL
     AND s.principal_atomic NOT GLOB '*[^0-9]*'
     AND length(s.principal_atomic)>0
     AND ltrim(s.principal_atomic,'0')<>''
     AND ltrim(s.principal_atomic,'0')=ltrim(s.amount_atomic,'0')
     AND (length(ltrim(NEW.amount_atomic,'0')) < length(ltrim(s.amount_atomic,'0')) OR (length(ltrim(NEW.amount_atomic,'0')) = length(ltrim(s.amount_atomic,'0')) AND ltrim(NEW.amount_atomic,'0') <= ltrim(s.amount_atomic,'0')))
     AND (length(ltrim(NEW.amount_atomic,'0')) < length(ltrim(s.principal_atomic,'0')) OR (length(ltrim(NEW.amount_atomic,'0')) = length(ltrim(s.principal_atomic,'0')) AND ltrim(NEW.amount_atomic,'0') <= ltrim(s.principal_atomic,'0')))
     AND lower(s.wallet_address)=lower(NEW.wallet_address)
     AND lower(NEW.recipient_address)=lower(s.wallet_address)
 );
END;
CREATE UNIQUE INDEX site_swap_payment_hash_casefold_unique
ON site_swap_intents(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE TABLE mainnet_stake_cancellations (
  cancellation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 56 CHECK(chain_id=56),
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic <> '0'),
  fee_atomic TEXT NOT NULL CHECK(length(fee_atomic)>0 AND fee_atomic NOT GLOB '*[^0-9]*'),
  refund_atomic TEXT NOT NULL CHECK(length(refund_atomic)>0 AND refund_atomic NOT GLOB '*[^0-9]*' AND refund_atomic <> '0'),
  remaining_principal_atomic TEXT NOT NULL CHECK(length(remaining_principal_atomic)>0 AND remaining_principal_atomic NOT GLOB '*[^0-9]*'),
  status TEXT NOT NULL DEFAULT 'READY' CHECK(status IN ('HELD','READY','PREPARING','SIGNED','SENT','CONFIRMED')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  tx_hash TEXT,
  last_error TEXT, failure_count INTEGER NOT NULL DEFAULT 0, reserved_day TEXT,
  UNIQUE(wallet_address,request_id),
  CHECK(status <> 'CONFIRMED' OR (tx_hash IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX mainnet_stake_cancellation_tx_ci
ON mainnet_stake_cancellations(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE INDEX mainnet_stake_cancellation_wallet_time
ON mainnet_stake_cancellations(wallet_address,created_at);
CREATE INDEX mainnet_stake_cancellation_work
ON mainnet_stake_cancellations(status,created_at);
CREATE TABLE mainnet_stake_refund_days (
  day_utc TEXT PRIMARY KEY,
  reserved_atomic TEXT NOT NULL CHECK(length(reserved_atomic)>0 AND reserved_atomic NOT GLOB '*[^0-9]*'),
  confirmed_atomic TEXT NOT NULL CHECK(length(confirmed_atomic)>0 AND confirmed_atomic NOT GLOB '*[^0-9]*'),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
, auto_reserved_atomic TEXT NOT NULL DEFAULT '0'
CHECK(length(auto_reserved_atomic)>0 AND auto_reserved_atomic NOT GLOB '*[^0-9]*'));
CREATE TABLE mainnet_stake_refund_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  circuit_open INTEGER NOT NULL DEFAULT 1 CHECK(circuit_open IN (0,1)),
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mainnet_treasury_sender_nonce
ON bank_transaction_queue(lower(sender_address),nonce) WHERE chain_id=56 AND nonce IS NOT NULL;
CREATE UNIQUE INDEX mainnet_treasury_active_lease
ON bank_transaction_queue(lower(sender_address))
WHERE chain_id=56 AND status='PREPARING' AND lease_token IS NOT NULL;
CREATE TABLE treasury_execution_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  circuit_open INTEGER NOT NULL DEFAULT 1 CHECK(circuit_open IN (0,1)),
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE treasury_execution_days (
  day_utc TEXT PRIMARY KEY,
  reserved_atomic TEXT NOT NULL CHECK(length(reserved_atomic)>0 AND reserved_atomic NOT GLOB '*[^0-9]*'),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE treasury_payout_approvals (
  job_id TEXT NOT NULL REFERENCES bank_transaction_queue(job_id),
  approver_id TEXT NOT NULL,
  job_fingerprint TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY(job_id,approver_id),
  CHECK(expires_at>approved_at)
);
CREATE INDEX treasury_approval_expiry ON treasury_payout_approvals(job_id,expires_at);
CREATE TABLE treasury_execution_audit (
  audit_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES bank_transaction_queue(job_id),
  fencing_token INTEGER NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('SIGNED','REJECTED','BROADCAST','CONFIRMED','HELD')),
  job_fingerprint TEXT NOT NULL,
  tx_hash TEXT,
  nonce INTEGER,
  created_at INTEGER NOT NULL,
  details_json TEXT NOT NULL,
  UNIQUE(job_id,fencing_token,event)
);
CREATE INDEX treasury_audit_job_time ON treasury_execution_audit(job_id,created_at);
CREATE TABLE mainnet_stake_refund_wallet_days (
  day_utc TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  auto_reserved_atomic TEXT NOT NULL
    CHECK(length(auto_reserved_atomic)>0 AND auto_reserved_atomic NOT GLOB '*[^0-9]*'),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(day_utc,wallet_address)
);
CREATE TABLE treasury_job_authorizations (
  job_id TEXT PRIMARY KEY REFERENCES bank_transaction_queue(job_id),
  job_fingerprint TEXT NOT NULL,
  authorization_mode TEXT NOT NULL CHECK(authorization_mode IN ('AUTO','MANUAL')),
  authorization_status TEXT NOT NULL CHECK(authorization_status IN ('PENDING','APPROVED','BLOCKED')),
  risk_code TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK(policy_version='stake-refund-v1'),
  authorized_by TEXT,
  authorized_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK((authorization_status='APPROVED' AND authorized_by IS NOT NULL AND authorized_at IS NOT NULL)
     OR authorization_status<>'APPROVED'),
  CHECK(authorization_mode<>'AUTO' OR (risk_code='NORMAL' AND authorization_status='APPROVED' AND authorized_by='SYSTEM')),
  CHECK(expires_at>created_at)
);
CREATE INDEX treasury_authorization_status
ON treasury_job_authorizations(authorization_mode,authorization_status,expires_at);
CREATE TABLE treasury_authorized_approvers (
  approver_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE TRIGGER treasury_approval_requires_authorized_admin
BEFORE INSERT ON treasury_payout_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM treasury_authorized_approvers
  WHERE approver_id=NEW.approver_id AND active=1
)
BEGIN
  SELECT RAISE(ABORT,'TREASURY_APPROVER_NOT_AUTHORIZED');
END;
CREATE TRIGGER treasury_approval_requires_manual_job
BEFORE INSERT ON treasury_payout_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM treasury_job_authorizations
  WHERE job_id=NEW.job_id
    AND lower(job_fingerprint)=lower(NEW.job_fingerprint)
    AND authorization_mode='MANUAL'
    AND authorization_status='PENDING'
    AND expires_at>=NEW.approved_at
)
BEGIN
  SELECT RAISE(ABORT,'TREASURY_JOB_NOT_PENDING_MANUAL_APPROVAL');
END;
CREATE TABLE mainnet_stake_credits (
  intent_id TEXT PRIMARY KEY REFERENCES mainnet_stake_intents(intent_id),
  payment_tx_hash TEXT NOT NULL UNIQUE,
  wallet_address TEXT NOT NULL,
  principal_atomic TEXT NOT NULL
    CHECK(length(principal_atomic)>0 AND principal_atomic NOT GLOB '*[^0-9]*' AND principal_atomic<>'0'),
  referrer_wallet TEXT,
  referral_pgr_atomic TEXT NOT NULL
    CHECK(length(referral_pgr_atomic)>0 AND referral_pgr_atomic NOT GLOB '*[^0-9]*'),
  principal_source_key TEXT NOT NULL UNIQUE,
  referral_source_key TEXT UNIQUE,
  credited_at INTEGER NOT NULL,
  CHECK((referrer_wallet IS NULL AND referral_pgr_atomic='0' AND referral_source_key IS NULL)
     OR (referrer_wallet IS NOT NULL AND referral_pgr_atomic<>'0' AND referral_source_key IS NOT NULL)),
  CHECK(referrer_wallet IS NULL OR lower(referrer_wallet)<>lower(wallet_address))
);
CREATE UNIQUE INDEX mainnet_stake_credit_payment_ci
ON mainnet_stake_credits(lower(payment_tx_hash));
CREATE INDEX mainnet_stake_credit_wallet_time
ON mainnet_stake_credits(wallet_address,credited_at);
CREATE TABLE mainnet_claim_ledger_sources (
  claim_id TEXT NOT NULL REFERENCES reward_claims(claim_id),
  source_key TEXT NOT NULL UNIQUE REFERENCES wallet_ledger(source_key),
  wallet_address TEXT NOT NULL,
  asset TEXT NOT NULL CHECK(asset='PGR'),
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*'),
  reserved_at INTEGER NOT NULL,
  PRIMARY KEY(claim_id,source_key)
);
CREATE INDEX mainnet_claim_ledger_claim ON mainnet_claim_ledger_sources(claim_id);
CREATE TABLE reward_signing_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  circuit_open INTEGER NOT NULL DEFAULT 1 CHECK(circuit_open IN (0,1)),
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE reward_signing_totals (
  asset TEXT PRIMARY KEY CHECK(asset IN ('PGR','SOV')),
  reserved_atomic TEXT NOT NULL DEFAULT '0'
    CHECK(length(reserved_atomic)>0 AND reserved_atomic NOT GLOB '*[^0-9]*'),
  version INTEGER NOT NULL DEFAULT 0,
  last_claim_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE reward_signing_authorizations (
  claim_id TEXT PRIMARY KEY REFERENCES reward_claims(claim_id),
  wallet_address TEXT NOT NULL,
  asset TEXT NOT NULL CHECK(asset IN ('PGR','SOV')),
  token_address TEXT NOT NULL,
  amount_atomic TEXT NOT NULL
    CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*'),
  signer_epoch TEXT NOT NULL
    CHECK(length(signer_epoch)>0 AND signer_epoch NOT GLOB '*[^0-9]*'),
  deadline INTEGER NOT NULL,
  authorization_version INTEGER NOT NULL DEFAULT 1 CHECK(authorization_version>0),
  status TEXT NOT NULL CHECK(status IN ('PREPARING','SIGNED','HELD')),
  signature TEXT,
  signature_hash TEXT,
  reserved_at INTEGER NOT NULL,
  signed_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK((status='SIGNED' AND signature IS NOT NULL AND signature_hash IS NOT NULL AND signed_at IS NOT NULL)
     OR (status<>'SIGNED' AND signature IS NULL AND signature_hash IS NULL))
);
CREATE INDEX reward_signing_status ON reward_signing_authorizations(status,updated_at);
CREATE TABLE reward_signing_audit (
  audit_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES reward_signing_authorizations(claim_id),
  authorization_version INTEGER NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('RESERVED','RENEWED','SIGNED','HELD')),
  signature_hash TEXT,
  created_at INTEGER NOT NULL,
  details_json TEXT NOT NULL,
  UNIQUE(claim_id,authorization_version,event)
);
CREATE INDEX reward_signing_audit_claim ON reward_signing_audit(claim_id,created_at);
CREATE TABLE custody_collection_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  circuit_open INTEGER NOT NULL DEFAULT 1 CHECK(circuit_open IN (0,1)),
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE custody_asset_receipts (
  receipt_id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  custody_address TEXT NOT NULL,
  source_wallet TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 56 CHECK(chain_id=56),
  asset_kind TEXT NOT NULL CHECK(asset_kind IN
    ('STAKE_USDT','PLATFORM_GAS','MISTAKEN_BNB','MISTAKEN_SUPPORTED_TOKEN','UNSUPPORTED_TOKEN')),
  token_address TEXT,
  asset_symbol TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic<>'0'),
  deposit_tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK(log_index>=-1),
  block_number INTEGER NOT NULL CHECK(block_number>=0),
  stake_intent_id TEXT REFERENCES mainnet_stake_intents(intent_id),
  status TEXT NOT NULL CHECK(status IN
    ('DETECTED','GAS_PENDING','READY_TO_COLLECT','COLLECTING','COLLECTED','MANUAL_REVIEW','REFUND_RECORDED','REFUNDED','HELD')),
  collection_tx_hash TEXT,
  detected_at INTEGER NOT NULL,
  collected_at INTEGER,
  last_error TEXT, deposit_block_hash TEXT,
  CHECK((asset_kind='STAKE_USDT' AND stake_intent_id IS NOT NULL AND token_address IS NOT NULL)
     OR (asset_kind<>'STAKE_USDT' AND stake_intent_id IS NULL)),
  CHECK((status='COLLECTED' AND collection_tx_hash IS NOT NULL AND collected_at IS NOT NULL)
     OR status<>'COLLECTED')
);
CREATE UNIQUE INDEX custody_receipt_chain_event_unique
  ON custody_asset_receipts(lower(deposit_tx_hash),log_index);
CREATE INDEX custody_receipt_owner ON custody_asset_receipts(owner_wallet,status,detected_at);
CREATE INDEX custody_receipt_address ON custody_asset_receipts(custody_address,status,detected_at);
CREATE TABLE custody_collection_jobs (
  job_id TEXT PRIMARY KEY,
  receipt_id TEXT REFERENCES custody_asset_receipts(receipt_id),
  owner_wallet TEXT NOT NULL,
  custody_address TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN
    ('GAS_TOPUP','USDT_TO_TREASURY','MISTAKEN_BNB_TO_RECOVERY','MISTAKEN_TOKEN_TO_RECOVERY','PLATFORM_GAS_RETURN')),
  signer_kind TEXT NOT NULL CHECK(signer_kind IN ('GAS_WALLET','CUSTODY')),
  sender_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 56 CHECK(chain_id=56),
  asset TEXT NOT NULL CHECK(asset IN ('BNB','ERC20')),
  token_address TEXT,
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic<>'0'),
  status TEXT NOT NULL CHECK(status IN ('PENDING','PREPARING','SIGNED','SENT','CONFIRMED','HELD','FAILED')),
  nonce INTEGER,
  raw_transaction TEXT,
  tx_hash TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  signing_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  last_error TEXT,
  UNIQUE(chain_id,sender_address,nonce),
  CHECK((asset='ERC20' AND token_address IS NOT NULL) OR (asset='BNB' AND token_address IS NULL)),
  CHECK((status='CONFIRMED' AND tx_hash IS NOT NULL AND confirmed_at IS NOT NULL) OR status<>'CONFIRMED')
);
CREATE UNIQUE INDEX custody_collection_tx_unique
  ON custody_collection_jobs(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE UNIQUE INDEX custody_one_active_purpose
  ON custody_collection_jobs(custody_address,purpose,COALESCE(receipt_id,''))
  WHERE status IN ('PENDING','PREPARING','SIGNED','SENT');
CREATE INDEX custody_collection_status ON custody_collection_jobs(status,created_at);
CREATE TABLE custody_collection_days (
  day_utc TEXT PRIMARY KEY,
  gas_topup_reserved_atomic TEXT NOT NULL DEFAULT '0',
  collection_reserved_atomic TEXT NOT NULL DEFAULT '0',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE custody_sender_state (
  sender_address TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL DEFAULT 56 CHECK(chain_id=56),
  next_nonce INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE custody_signing_audit (
  audit_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES custody_collection_jobs(job_id),
  fencing_token INTEGER NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('ADDRESS_DERIVED','SIGNED','REJECTED','SENT','CONFIRMED','FAILED')),
  tx_hash TEXT,
  nonce INTEGER,
  created_at INTEGER NOT NULL,
  details_json TEXT NOT NULL
);
CREATE INDEX custody_signing_audit_job ON custody_signing_audit(job_id,created_at);
CREATE TABLE custody_signer_requests (
  request_id TEXT PRIMARY KEY,
  pathname TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX custody_signer_requests_expiry ON custody_signer_requests(expires_at);
CREATE TABLE custody_gas_ledger (
  event_id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  custody_address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN
    ('PLATFORM_TOPUP','CHAIN_GAS_SPENT','PLATFORM_GAS_RETURN','USER_BNB_DEPOSIT','USER_BNB_COLLECTION')),
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic<>'0'),
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL CHECK(block_number>=0),
  related_job_id TEXT REFERENCES custody_collection_jobs(job_id),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX custody_gas_chain_event_unique ON custody_gas_ledger(kind,lower(tx_hash),event_id);
CREATE INDEX custody_gas_account ON custody_gas_ledger(custody_address,created_at);
CREATE TABLE custody_manual_refunds (
  refund_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES custody_asset_receipts(receipt_id),
  original_sender TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  token_address TEXT,
  amount_atomic TEXT NOT NULL CHECK(length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*' AND amount_atomic<>'0'),
  status TEXT NOT NULL CHECK(status IN ('RECORDED','APPROVED','PAID','REJECTED')),
  contacted_at INTEGER,
  verified_by TEXT,
  approved_by TEXT,
  tx_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(status<>'PAID' OR tx_hash IS NOT NULL)
);
CREATE UNIQUE INDEX custody_one_manual_refund_per_receipt ON custody_manual_refunds(receipt_id);
CREATE TABLE custody_scan_state (
  custody_address TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 56 CHECK(chain_id=56),
  next_block INTEGER NOT NULL CHECK(next_block>=0),
  last_scanned_block INTEGER,
  last_scanned_block_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','HELD')),
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0), retry_after INTEGER,
  FOREIGN KEY(owner_wallet,chain_id) REFERENCES wallet_custody_addresses(wallet_address,chain_id),
  CHECK((last_scanned_block IS NULL AND last_scanned_block_hash IS NULL)
     OR (last_scanned_block IS NOT NULL AND last_scanned_block_hash IS NOT NULL))
);
CREATE INDEX custody_scan_next_block
  ON custody_scan_state(status,next_block,updated_at);
CREATE INDEX custody_receipt_block
  ON custody_asset_receipts(block_number,deposit_block_hash,status);
CREATE TABLE custody_daily_budgets (
  day_utc TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('USDT_COLLECTION','GAS_TOPUP','GAS_RETURN','OTHER_COLLECTION')),
  limit_atomic INTEGER NOT NULL CHECK(limit_atomic>0),
  reserved_atomic INTEGER NOT NULL DEFAULT 0 CHECK(reserved_atomic>=0),
  settled_atomic INTEGER NOT NULL DEFAULT 0 CHECK(settled_atomic>=0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(day_utc,bucket),
  CHECK(reserved_atomic<=limit_atomic-settled_atomic)
);
CREATE TABLE custody_daily_reservations (
  job_id TEXT PRIMARY KEY REFERENCES custody_collection_jobs(job_id),
  day_utc TEXT NOT NULL,
  bucket TEXT NOT NULL,
  amount_atomic INTEGER NOT NULL CHECK(amount_atomic>0),
  limit_atomic INTEGER NOT NULL CHECK(limit_atomic>0),
  state TEXT NOT NULL DEFAULT 'RESERVED' CHECK(state IN ('RESERVED','SETTLED','RELEASED')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  released_at INTEGER,
  FOREIGN KEY(day_utc,bucket) REFERENCES custody_daily_budgets(day_utc,bucket),
  CHECK((state='SETTLED' AND settled_at IS NOT NULL AND released_at IS NULL)
     OR (state='RELEASED' AND released_at IS NOT NULL AND settled_at IS NULL)
     OR (state='RESERVED' AND settled_at IS NULL AND released_at IS NULL))
);
CREATE INDEX custody_daily_reservation_state
  ON custody_daily_reservations(day_utc,bucket,state);
CREATE TRIGGER custody_daily_reserve_guard
BEFORE INSERT ON custody_daily_reservations
BEGIN
  SELECT CASE
    WHEN NOT EXISTS(
      SELECT 1 FROM custody_daily_budgets
      WHERE day_utc=NEW.day_utc AND bucket=NEW.bucket AND limit_atomic=NEW.limit_atomic
    ) THEN RAISE(ABORT,'CUSTODY_DAILY_BUDGET_MISSING_OR_CHANGED')
    WHEN NEW.amount_atomic > (
      SELECT limit_atomic-reserved_atomic-settled_atomic
      FROM custody_daily_budgets WHERE day_utc=NEW.day_utc AND bucket=NEW.bucket
    ) THEN RAISE(ABORT,'CUSTODY_DAILY_LIMIT_EXCEEDED')
  END;
END;
CREATE TRIGGER custody_daily_reserve_apply
AFTER INSERT ON custody_daily_reservations
BEGIN
  UPDATE custody_daily_budgets
  SET reserved_atomic=reserved_atomic+NEW.amount_atomic,updated_at=NEW.created_at
  WHERE day_utc=NEW.day_utc AND bucket=NEW.bucket;
END;
CREATE TRIGGER custody_daily_settle_apply
AFTER UPDATE OF state ON custody_daily_reservations
WHEN OLD.state='RESERVED' AND NEW.state='SETTLED'
BEGIN
  UPDATE custody_daily_budgets
  SET reserved_atomic=reserved_atomic-NEW.amount_atomic,
      settled_atomic=settled_atomic+NEW.amount_atomic,
      updated_at=NEW.settled_at
  WHERE day_utc=NEW.day_utc AND bucket=NEW.bucket;
END;
CREATE TRIGGER custody_daily_release_apply
AFTER UPDATE OF state ON custody_daily_reservations
WHEN OLD.state='RESERVED' AND NEW.state='RELEASED'
BEGIN
  UPDATE custody_daily_budgets
  SET reserved_atomic=reserved_atomic-NEW.amount_atomic,updated_at=NEW.released_at
  WHERE day_utc=NEW.day_utc AND bucket=NEW.bucket;
END;
CREATE INDEX custody_scan_retry
  ON custody_scan_state(status,retry_after,next_block,updated_at);
CREATE TRIGGER custody_derivation_metadata_insert_guard
BEFORE INSERT ON wallet_custody_addresses
BEGIN
  SELECT CASE WHEN
    (NEW.derivation_version='PBMRESERVES_HMAC_SHA256_V1' AND NEW.derivation_index BETWEEN 0 AND 9)
    OR (NEW.derivation_version='LEGACY_UNSPECIFIED' AND NEW.derivation_index=-1)
  THEN NULL ELSE RAISE(ABORT,'CUSTODY_DERIVATION_METADATA_INVALID') END;
END;
CREATE TRIGGER custody_derivation_metadata_update_guard
BEFORE UPDATE OF derivation_version,derivation_index ON wallet_custody_addresses
BEGIN
  SELECT CASE WHEN
    (NEW.derivation_version='PBMRESERVES_HMAC_SHA256_V1' AND NEW.derivation_index BETWEEN 0 AND 9)
    OR (NEW.derivation_version='LEGACY_UNSPECIFIED' AND NEW.derivation_index=-1)
  THEN NULL ELSE RAISE(ABORT,'CUSTODY_DERIVATION_METADATA_INVALID') END;
END;
CREATE INDEX custody_derivation_recovery_lookup
  ON wallet_custody_addresses(chain_id,derivation_version,root_fingerprint,wallet_address);
CREATE TABLE site_swap_intent_lifecycle (
  intent_id TEXT PRIMARY KEY REFERENCES site_swap_intents(intent_id),
  state TEXT NOT NULL CHECK(state IN ('AWAITING_PAYMENT','PAYMENT_DETECTED','EXPIRED','CONFIRMED')),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX site_swap_lifecycle_expiry
ON site_swap_intent_lifecycle(state,expires_at);
CREATE TABLE site_swap_scan_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  next_block INTEGER NOT NULL DEFAULT 0,
  last_scanned_block INTEGER,
  last_scanned_block_hash TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
