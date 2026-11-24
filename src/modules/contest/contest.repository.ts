/** Drops every finalist the organizers chose for the event (the contest was turned off). */
export function deleteFinalists(db: D1Database, tripId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM contest_finalists WHERE trip_id = ?").bind(tripId);
}
