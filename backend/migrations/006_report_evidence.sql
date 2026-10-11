-- Reports carry a snapshot of the relevant context (taken when the player reports) so moderators can act without browsing private data.
ALTER TABLE reports ADD COLUMN evidence jsonb;
