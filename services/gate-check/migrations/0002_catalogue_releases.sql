-- Portal v2: an item may be pinned to a settings release of the catalogue (`<base>+settings.<n>`), recorded on the
-- `catalogue:settings` stream when the factory settings that made it were published. gate-check reads the releases
-- (and only them) to find the route of an item pinned to one; unknown is pending, never passing.
CREATE POLICY record_event_gatecheck_catalogue_read ON record.record_event
  FOR SELECT TO aisdlc_gatecheck USING (stream = 'catalogue:settings' AND type = 'catalogue.released');
