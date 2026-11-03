# De'vyora Library — architecture

A library of reference rooms the studio has chosen. A client browses it,
picks **one** picture, and that exact picture then does two jobs:

1. the catalog is searched for the tiles that match it, and
2. the final scene is generated **from that same picture**.

That rule governs every later chunk. The picture the client pointed at is
the one the generator is given — not a lookalike, not a theme's stock
photograph, not a re-pick.

This document is the foundation: the menu item, the shape of the feature
and the table behind it. **There is no upload here and no generation.**

---

## Where it sits

```
sidebar ─► frontend/devyora-library.html      the gallery (shell only today)
                │
                ▼  later chunks
        GET  /api/v1/library/references         browse, by theme
        POST /api/v1/library/references         add one      (staff only)
                │
                ▼
        LibraryReference  ──── themeId ───►  shared/themes.json
                │
                └── imageUrl / driveFileId ──►  Google Drive
```

Picking one, in the chunks after that:

```
chosen LibraryReference
   │
   ├─► tile matching     catalog tiles that match THIS picture
   │
   └─► scene generation  the same picture, as the visual reference
```

## Four decisions, and why

### 1. The theme is not a table

The nine themes live in `shared/themes.json`. Node reads them through
`themes.service.ts`, Python through `app/themes.py`, and the room prompt,
the tile-application prompt, the theme check and the tile ranking are all
written against that file.

A `themes` table would be a second source of truth for the same nine
rows, and the two would drift — the moment they disagree, a board is
generated against one and judged against the other.

So `LibraryReference.themeId` holds a theme's own id from that file
(`"british"`, `"roman_touch"`, …). It is validated against the file on
write rather than by a foreign key.

### 2. This is not the existing `reference_images` table

There is already a `ReferenceImage` model, a
`frontend/reference-image-library.html` page and an upload route. They
are a different thing with a similar name:

| | `reference_images` | `library_references` |
|---|---|---|
| who it is for | staff, internally | the client, in the gallery |
| what identifies it | `styleTag`, `style`, `room` | a `title` and a theme |
| what it is used for | seeding a theme's own photographs | one chosen picture drives matching **and** generation |
| storage | Vercel Blob, then Drive, then local disk | **Drive only** |
| published | n/a — everything uploaded is listed | `isActive` keeps a row out of the gallery |

Sharing one table would put every internal upload in front of a customer
and would force one storage rule onto both. They stay apart, and
**neither touches the other**: nothing in this feature changes the
existing table, its service, its routes or its page.

### 3. Google Drive is the only store

`driveFileId` is **required**. There is no local path column and no blob
key column in this table, so a row cannot exist for a picture kept
anywhere else. `imageUrl` is the browser-ready Drive link derived from
that id.

> **Known blocker for the upload chunk.** The Google credential in use is
> a *service account*, and a service account owns no Drive storage quota
> — an upload into its own My Drive is refused outright. This is already
> visible elsewhere in the system: every generated scene is recorded with
> `imageSource: "inline"`, which is the fallback used only when no Drive
> link came back.
>
> Before upload can work, one of these has to be true: the pictures live
> in a **Shared Drive** the service account is a member of, or the
> credential is changed to **OAuth delegation**. Storing links to files
> the studio put in Drive by hand sidesteps it; uploading through the app
> does not.

### 4. The schema

```prisma
model LibraryReference {
  id           String   @id @default(cuid())
  themeId      String   // a theme id from shared/themes.json
  title        String   // what the client sees it called
  imageUrl     String   // browser-ready Drive link
  driveFileId  String   @unique   // Drive is the only store there is
  room         String?  // when the reference is only right for one room
  description  String?
  isActive     Boolean  @default(true)   // unpublished without deleting
  sortOrder    Int      @default(0)
  uploadedById String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  uploadedBy   User?    @relation("LibraryReferenceUploadedBy", ...)

  @@index([themeId])
  @@index([themeId, isActive])
  @@index([room])
}
```

`room` is nullable on purpose. A reference is often right for a bathroom
and a powder room both, and the generator is already room-aware; pinning
every picture to exactly one room would be a restriction nobody asked
for.

Migration: `backend/prisma/migrations/20261103113735_add_devyora_library`.
**It has to be applied by hand** — Vercel's `buildCommand` is
`prisma generate` and does not migrate:

```bash
cd backend && npx prisma migrate deploy
```

## Adding pictures — "bulk" is many requests, not one

```
GET    /library/themes                 the nine themes, with their counts
GET    /library/references?themeId=    a theme's rooms
POST   /library/references             ONE picture (multipart)
DELETE /library/references/:id         removes the row AND the Drive file
```

One picture per request, four at a time from the browser. This deploys
to a serverless function with a sixty-second limit and a few megabytes
of request body — one POST could not carry fifty photographs and could
not finish if it did. The useful consequence is that one bad file fails
on its own and the other ninety-nine still land.

Progress is per file and per byte (`XMLHttpRequest.upload`, the only
thing that reports how much has actually gone up), with an overall bar,
a cancel while it runs, and the reason beside any file that failed.

**No fallback.** `referenceImages.service` tries Vercel Blob, then Drive,
then local disk, because that table serves an internal flow that must
keep working on a laptop. This one does not: a library picture that is
not in the studio's Drive is not in the library, and a Drive refusal is
reported in Google's own words rather than hidden behind a copy on a
disk that serverless throws away.

Permissions are the existing `reference_images:read` / `:write` rather
than new `library:*` ones. New permissions would have to be added to
every role that should hold them, and a role-seeding mistake locks the
owner out of their own feature.

## Browsing, and choosing the reference

Two views on one page, no router and no second page:

```
themes   every theme as a card: its own preview art, its palette,
         and how many reference rooms it holds
   │  click
   ▼
theme    that theme's rooms in a grid, loaded from their Drive links
   │  click a room
   ▼
chosen   stated at the top of BOTH views, with the room's name and the
         theme it came from, and a CLEAR beside it
```

The chosen reference is kept in `localStorage`, under
`casa_library_selection`, as the whole small record — id, theme, title,
room and the Drive link. **This is the carrier the generation chunk
reads.** It is not the URL, which is lost at the next click, and not a
database column, which nobody has specified yet; if the choice ever has
to outlive a browser, that is a column and a migration, and the shape
stored is already the shape it would take.

There is only ever one. Choosing another replaces it. Removing the room
that is currently chosen clears the choice with it, so a selection can
never point at something that no longer exists.

Adding and removing pictures is the studio's work, so the upload button
and REMOVE are shown only to a user holding `reference_images:write`.
The server refuses everyone else either way; this only decides what is
worth putting on the screen.

Waiting states are skeleton cards in the shape of the real ones, so the
grid does not jump when the pictures arrive.

## What the later chunks still have to decide

- **What "matching tiles" means**: by the theme's own palette and rules,
  by reading the picture with Gemini, or both.
- **Where the chosen reference enters generation**: the room step takes a
  theme's reference photographs today, and the chosen picture has to
  reach that call without displacing the theme's own.

Neither is settled here.
