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
  // What the studio's eye read in this picture -- one Gemini vision
  // pass, kept because the picture never changes. See "Generating from
  // the chosen reference" below; nullable, and nothing fails without it.
  visualProfile Json?
  visualReadAt  DateTime?
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

Migrations: `20261103113735_add_devyora_library` (the table) and
`20261103210000_add_library_visual_profile` (the two reading columns).
**Both have to be applied by hand** — Vercel's `buildCommand` is
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

## Generating from the chosen reference

This is the part the whole feature exists for, and it is **two separate
claims**, not one. A build that only does the second is a handsome room
with the wrong tiles in it; a build that only does the first is the
right tiles in a room nobody asked for.

```
the client chooses a room in the Library
        │   casa_library_selection -> { id, ... }
        ▼
┌─ CLAIM 1: THE TILES ──────────────────────────────────────────┐
│  the picture is READ once         libraryMatch.service.ts     │
│     one Gemini vision pass -> a palette, materials, patterns, │
│     finishes, formats, mood, and what each surface carries    │
│                                                               │
│  its ground colour  ->  the ranking engine, as `colorTone`    │
│       so the eighty rows offered to the model are already     │
│       drawn towards the reference                             │
│                                                               │
│  the whole reading  ->  the combination prompt, ABOVE the     │
│       theme, stating that the reference outranks it           │
└───────────────────────────────────────────────────────────────┘
        │   the combination: base + highlight + accent
        ▼
┌─ CLAIM 2: THE IMAGE ──────────────────────────────────────────┐
│  the photograph ITSELF is the scene                           │
│     ai_visualization.routes.ts reads the row and sends that   │
│     Drive file as scene_image_url, mode "reference"           │
│                                                               │
│  Stage 1 -- the step that INVENTS a room -- does not run      │
│  Stage 2 installs the materials into the client's own picture │
└───────────────────────────────────────────────────────────────┘
```

### Why the picture is turned into words for the tile step

The tiles are **text** in that prompt — up to eighty catalog rows — and
they will stay text: eighty photographs will not fit in one request, let
alone inside the sixty seconds this deployment allows. So the match is
text against text whichever way round it is done, and the only question
is whether the picture is read once and kept, or re-sent on every
generation.

Once, kept. A library row's Drive file never changes, so the reading
cannot go stale; a client generating twice from the same room does not
pay for it twice; and the reading is something a person can read back
and check, which "we sent the model a JPEG" is not.

It is kept on the row, in `visualProfile` and `visualReadAt`. Both
nullable, both best-effort in each direction: **a database that has not
had the migration applied still generates correctly**, it simply re-reads
the picture each time, and `readVisualProfile` logs that once so the
cause is findable.

### Why the reading has to reach the pool, not just the prompt

The prompt can only choose between the rows the ranking engine returned.
A reference whose colour reached the prompt but not the ranking would be
matched against whatever the *theme* happened to surface — the right
instructions over the wrong shortlist.

So the reading's `dominantColour` is passed as `colorTone`, which
`tileRecommendation.service.ts` has always scored against (`scoreColor`,
exact match and colour family). The mood-board path simply never used
that door. **Nothing in the ranking engine changed.**

It stays a ranking and never becomes a filter: a tile that does not match
the reference's colour is still offered, just lower. A catalog with
nothing in that colour must still produce a board.

### Why the reference outranks the theme, out loud, twice

A client can choose a Moroccan reference that is cream and terracotta
while the Moroccan theme specification in the same prompt asks for blue
and green. That specification is several hundred words of mandatory
rules and prohibitions. A reference tucked in underneath it reads as a
footnote to the theme, and a model reconciling the two will pick the
theme — it is longer, more detailed and more emphatic.

So the precedence is stated in **both** prompts, and in both it is
placed above the theme rather than below it:

- the combination prompt (`libraryMatch.referenceBriefBlock`): *"Where
  the reference and the theme description disagree, THE REFERENCE WINS."*
- the image prompt (`tile_application_engine`, only when
  `requirements.reference_room` is set): *"Where this photograph and the
  theme description disagree, THIS PHOTOGRAPH WINS."*

The theme is not discarded. It still governs how the chosen materials
are **laid, cut and grouted** — the decisions this step actually makes —
and nothing about the room.

### The row is the authority, not the browser

Only the reference's **id** travels from the page. The URL that gets
fetched and the words that describe the room are both read from the
database server-side, exactly as each tile's image already is.

A page that could name its own `scene_image_url` would be pointing this
server's own fetcher at an address of its choosing, so a library
generation overrides whatever the page sent — including
`generate_random_scene`, which would otherwise let a page replace the
client's chosen room with an invented one.

### What happens when it goes wrong

| what failed | the tiles | the image | what the client is told |
| --- | --- | --- | --- |
| the picture cannot be fetched or read | from the theme alone | still built on the picture | the banner says **COULD NOT BE READ**, and that the image still uses the room |
| the reference was deleted since choosing it | from the theme alone | a generated room | a warning naming it, on the board |
| the reference was deleted, at image time | — | **refused, 404** | *"no longer in the De'vyora Library ... choose a reference again"* |

The failure mode this feature must never have is a board that **looks**
reference-matched and is not. So the response carries `matched` as its
own field, the banner reads from that rather than from the client's own
choice, and the history row keeps `libraryReferenceId` — which is what
lets "was this really built on the room I picked?" be answered months
later instead of guessed at.

### What costs what

One generation from a library reference costs:

- **one Gemini vision call**, the first time that picture is ever used,
  and never again
- **one Gemini text call** for the combination — unchanged
- **one Gemini image call** instead of two, because the room already
  exists and Stage 1 does not run

So a reference-built scene is **cheaper and faster** than a generated
one after its first use, not more expensive.

## Covered by

| what | where |
| --- | --- |
| the reading, the pool, the prompt, the route, the history | `backend/test-scripts/library_generation_test.js` |
| the choice surviving the trip from one page to the other | `backend/test-scripts/library_moodboard_test.js` |
| the image prompt's reference paragraph | `catalog_processor/app/test_library_reference_prompt.py` |
| browsing and choosing | `backend/test-scripts/library_browse_test.js` |
| bulk upload | `backend/test-scripts/library_upload_test.js` |
| the page, the menu, the schema | `backend/test-scripts/devyora_library_test.js` |

## Still outstanding, and not code

- **The Drive quota.** A plain service account owns no Drive storage, so
  uploads fail with Google's own words until a Shared Drive or OAuth
  delegation is configured. Nothing here hides that.
- **The migrations.** `prisma migrate deploy` is not run by this
  project's build (`vercel.json`'s `buildCommand` is `prisma generate`
  alone), so `20261103113735_add_devyora_library` and
  `20261103210000_add_library_visual_profile` have to be applied by hand.
  The feature degrades rather than breaking without the second one.
