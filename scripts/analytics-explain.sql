-- Run after: npx prisma migrate deploy
-- Replace :consumerId and :network with real values.

EXPLAIN (ANALYZE, BUFFERS)
SELECT
  CASE WHEN asset IS NULL OR asset = 'native' THEN 'XLM' ELSE asset END AS asset,
  COALESCE(SUM(amount::numeric), 0)::text AS amount,
  COUNT(*)::int AS count
FROM payment_intent
WHERE "consumerId" = 'YOUR_CONSUMER_ID'
  AND network = 'testnet'
  AND status = 'SUCCEEDED'
GROUP BY 1
ORDER BY 1;

-- Expected plan fragment (with migration 20260825210000_analytics_indexes applied):
--   -> Index Scan using payment_intent_consumerId_network_createdAt_idx on payment_intent
-- NOT:
--   -> Seq Scan on payment_intent
