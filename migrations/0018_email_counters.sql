-- Emails sent per kind per UTC day ('login', 'support'): global daily caps that keep room in Resend's free quota.
CREATE TABLE email_counters (
  kind  TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (kind, day)
);
