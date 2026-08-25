-- Composite indexes for analytics dashboard queries (consumer + network + time)
-- and API request logs (consumer + createdAt).
CREATE INDEX "payment_intent_consumerId_network_createdAt_idx" ON "payment_intent"("consumerId", "network", "createdAt");

CREATE INDEX "request_log_consumer_createdAt_idx" ON "request_log"("consumer", "createdAt");
