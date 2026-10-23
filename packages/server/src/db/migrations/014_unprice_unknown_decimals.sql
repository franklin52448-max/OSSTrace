-- Fix: a fungible-token transfer stored without decimals (token_decimals NULL) has `amount` equal to
-- the unscaled base-unit integer, but sync's pricing pass still multiplied it by the token's USD price,
-- so its usd came out 10^decimals too large (seen on BNB Chain: a ~$12.7 MYX swap stored as $1.27e19,
-- which then dominated every counterparty total it touched). Sync now leaves such rows unpriced (see
-- SyncService.priceAddress); this clears the usd already stored on any of them. They stay checked, so
-- they aren't re-priced: with no decimals there's nothing honest to price them by.
UPDATE transfers
SET usd = NULL, price_source = NULL
WHERE token_decimals IS NULL
  AND token_standard IN ('erc20', 'spl')
  AND usd IS NOT NULL;
