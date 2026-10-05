-- Claim cleanup before touching R2 so a slow upload cannot commit a reference to
-- an object being deleted. Each attempt also uses a distinct private object key.
ALTER TABLE attachment_uploads ADD COLUMN state TEXT NOT NULL DEFAULT 'uploading'
  CHECK(state IN ('uploading','cleaning'));
