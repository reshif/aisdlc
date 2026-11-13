-- RC-HAI-2, RC-NOT-1, RC-NOT-3: the notifier reads more of the record, and still writes only its own streams.
--
--   item:<id>        every event of an item's stream: the notifier folds the item with the work engine's pure
--                    interpreter (`@aisdlc/work`) to see what the item now waits for (questions, Ready, G6, PARK, a
--                    handoff) and whether it ended. Nothing of an event's text reaches a notification: the content
--                    schema (`NotificationContent`) holds ids, enums and times only.
--   control:<id>     `control.applied` (a halt)
--   breaker:<p>:<l>  `breaker.tripped` (R3)
--   drift:<repo>     `drift.suspended`
--   gaterelay:<id>   `gaterelay.release_refused`, `gaterelay.deploy_unhealthy` (B16)
--   alert:<subject>  `ops.alert_raised` (core-worker's health loop)
DROP POLICY record_event_notifier_read ON record.record_event;
CREATE POLICY record_event_notifier_read ON record.record_event
  FOR SELECT TO aisdlc_notifier USING (
    stream LIKE 'notifier:%' OR stream LIKE 'notifier-pref:%'
    OR (stream LIKE 'gate:%' AND type IN ('gate.opened', 'gate.closed', 'gate.superseded', 'gate.expired'))
    OR (stream LIKE 'card:%' AND type IN ('card.opened', 'card.escalated'))
    OR (stream = 'kill:observed' AND type = 'kill.observed')
    OR (stream LIKE 'item:%' AND type LIKE 'item.%')
    OR (stream LIKE 'control:%' AND type = 'control.applied')
    OR (stream LIKE 'breaker:%' AND type = 'breaker.tripped')
    OR (stream LIKE 'drift:%' AND type = 'drift.suspended')
    OR (stream LIKE 'gaterelay:%' AND type IN ('gaterelay.release_refused', 'gaterelay.deploy_unhealthy'))
    OR (stream LIKE 'alert:%' AND type = 'ops.alert_raised')
  );
