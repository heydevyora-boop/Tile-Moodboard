-- De'vyora Library: what the studio's eye read in a reference picture.
--
-- One Gemini vision pass per picture, kept on the row. The picture never
-- changes, so neither does the reading -- and the tile-matching step runs
-- on every generation, which is why it must not re-read it every time.
--
-- Both columns are nullable, so every existing row is already valid and
-- this migration needs no backfill: NULL means "not read yet", and the
-- matcher reads it on first use.
ALTER TABLE "LibraryReference" ADD COLUMN "visualProfile" JSONB;
ALTER TABLE "LibraryReference" ADD COLUMN "visualReadAt" TIMESTAMP(3);
