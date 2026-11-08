-- Outbox delivery limits (PLAN M5.4; follow-up from M2.1; RV §3.1 "poison row").
--
-- A message that keeps failing used to stay pending forever and was claimed again at once, so it
-- was retried in a tight loop and sat in front of its destination's queue. Now every failure
-- schedules the next attempt later (exponential backoff, `next_attempt_at`; NULL is "due now", so
-- a new row never depends on the database clock agreeing with the worker's) and, after the
-- maximum attempts (or one failure the handler declares permanent), the row is DEAD: `dead_at`
-- is set, it is never claimed again, and it is counted for the health alert. A dead row is never
-- dropped (the record of what was not delivered stays); an operator can requeue it.
--
-- `next_attempt_at`, `dead_at`, `attempts` and `last_error` are delivery bookkeeping, so the
-- existing guard (`record.guard_outbox`) already lets them change and still pins what is
-- delivered, where, and under which key.

ALTER TABLE record.outbox
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN dead_at         timestamptz,
  ADD CONSTRAINT outbox_dead_is_not_dispatched CHECK (dead_at IS NULL OR dispatched_at IS NULL);

-- What a claimer reads: pending and alive (due-ness is checked on the rows it finds).
CREATE INDEX outbox_due ON record.outbox (destination, next_attempt_at, id)
  WHERE dispatched_at IS NULL AND dead_at IS NULL;

-- What the health alert counts.
CREATE INDEX outbox_dead ON record.outbox (destination, id) WHERE dead_at IS NOT NULL;
