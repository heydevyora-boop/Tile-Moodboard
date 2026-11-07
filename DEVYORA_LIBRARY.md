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

#### A service account owns nothing, and that decides where the folder goes

The Google credential in use is a *service account*, and a service
account has **no Drive storage quota at all**. Drive does not refuse the
*permission*; it refuses to let that account **own** a file. Every file
has an owner, and in a My Drive the owner is whoever created it — so an
upload into a My Drive folder comes back:

```
Service Accounts do not have storage quota. Leverage shared drives ...,
or use OAuth delegation ... instead.
```

**Sharing the folder does not fix this.** Adding the service account as
an Editor — even as the owner's own folder, even at the Drive root — grants
it the right to write, and it still cannot own what it writes. Three
configurations work; Google's error names the first two:

| | What to do | Whose storage it uses | Needs |
|---|---|---|---|
| **Shared drive** | Put the folder on a shared drive and add the service account to *that drive* as a **Content manager**. | The shared drive's | Google Workspace, Business Standard or better |
| **Domain-wide delegation** | Set `GOOGLE_DRIVE_IMPERSONATE_USER` to a mailbox on the studio's Workspace domain and grant the service account domain-wide delegation for the Drive scope in the Admin console. | That person's | Google Workspace of any tier |
| **The owner's own OAuth** | The owner authorizes the application once from `/drive-connect.html`; it acts as them afterwards. | The owner's | Nothing but a Google account |

**This studio is on a personal Gmail**, so the third row is the one that
applies — and it is what the library now uses when it is connected. The
service account stays configured underneath it: `authMode()` prefers the
connected account and falls back, so nothing that worked before stops
working because OAuth was configured and not yet finished.

#### The owner's own Google account, end to end

The flow is an ordinary server-side Authorization Code exchange with
`access_type=offline`, in `googleOAuth.service.ts`:

1. The owner opens **`/drive-connect.html`** and presses *Connect*.
   `POST /api/v1/integrations/google/connect` returns Google's consent
   URL, with the owner's id **signed into `state`**.
2. Google sends the browser back to
   **`GET /api/v1/integrations/google/callback`** — the one route in
   `integrations.routes.ts` that is deliberately *outside*
   `authenticate()`, because a top-level navigation from Google carries
   no Authorization header. The signed `state` is what replaces the
   guard: forged or older than fifteen minutes and the callback refuses.
3. The code is exchanged server-side. The **refresh token is encrypted
   with AES-256-GCM and stored in the existing `api_keys` table** —
   no schema change, the same store and the same key the Gemini key
   already uses. `GOOGLE_OAUTH_REFRESH_TOKEN` is read as a fallback.
4. `google-auth-library` mints and renews access tokens underneath every
   Drive call. A revoked grant arrives as `invalid_grant` *during an
   upload*; it is translated into "connect the account again" rather
   than reported as a Drive permission error, and never retried.

**Nothing secret comes back out.** The status endpoint says whether a
token exists, never what it is; the client secret never leaves the
server; and the only token the browser ever sees is the short-lived
access token the Google Picker cannot run without, handed to the owner
alone.

#### Why there is a Picker step

With the default `drive.file` scope the application can only touch what
it created or what the owner explicitly handed it — which is the whole
reason that scope needs no Google verification and no security
assessment. The studio's "Reference Images" folder was made by hand, so
it has to be handed over once: the connect page opens the **Google
Picker**, the owner chooses that folder, and from then on the app can
create the Theme/Room folders inside it and upload. Everything it
creates afterwards is its own.

Setting `GOOGLE_OAUTH_SCOPE` to the full `https://www.googleapis.com/auth/drive`
removes the Picker step entirely. The price is that it is a **restricted**
scope: the consent screen warns that the app is unverified, and Google
may require a CASA security assessment before it will verify it. Either
way the OAuth app must be moved from *Testing* to **In production**, or
Google expires the refresh token after seven days.

**The flag that makes the first one work.** Every Drive request this
client sends now carries `supportsAllDrives: true` (and
`includeItemsFromAllDrives` when listing). Without it the API answers as
though shared drives did not exist — so a folder on one is not found, a
sub-folder is created in a My Drive instead, and the upload is refused
for want of quota *even when the configuration was right*. That one
missing flag is why putting the folder on a shared drive did not help on
its own.

**Said before the files are picked.** `describeLibraryFolder` reads the
folder's `driveId`. No `driveId` means it is in a My Drive; with no
delegated user configured, the library reports itself unusable with the
table above in words, rather than letting a hundred photographs be
chosen and then refused one at a time. Google's own quota refusal, if it
still arrives, is translated into the same sentence instead of being
reported as a permission error — which is what sent the studio back to
re-share a folder that was already shared correctly.

#### One folder, named by the studio

Every library picture is uploaded **directly into one folder**, whose
link or id is `GOOGLE_DRIVE_LIBRARY_FOLDER`:

```bash
# either form — this is what "Copy link" puts on the clipboard
GOOGLE_DRIVE_LIBRARY_FOLDER=https://drive.google.com/drive/folders/1AbCdEf...
GOOGLE_DRIVE_LIBRARY_FOLDER=1AbCdEf...
```

The studio creates that folder (they called it **Reference Images**) —
on a shared drive, or in a My Drive if `GOOGLE_DRIVE_IMPERSONATE_USER`
is set; see above, because sharing it as an Editor is *not* by itself
enough — and sets this. The
same value is also read from `GOOGLE_DRIVE_REFERENCE_IMAGES_FOLDER`, so
whichever of the two names is typed into the environment, the pictures
land in the right place.

This replaced finding-or-creating a `devyora-library` folder under the
Drive root. That was wrong twice over: it put the studio's pictures
somewhere the studio had not chosen, and on a service account it wrote
into a My Drive with no storage quota at all — which is most of why
uploads failed. **A folder the studio creates and shares is the
configuration that actually works**, and it is also the fix for the
quota blocker above when that folder lives on a shared drive.

**Unset is a refusal, not a fallback.** With no folder configured the
library will not upload at all, because uploading to the root is
precisely what this setting exists to prevent — and it would do it
silently. The message names the variable; so do the messages for a value
that is a folder *name* rather than a link, and for an id the credential
cannot open.

The folder is checked **once per process**, not once per picture: a
hundred uploads would otherwise each pay for the same lookup, and a
wrong id would surface a hundred identical failures with nothing to say
which setting was at fault.

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

## Theme → Room

The library is two levels, not one. A picture is filed under a **theme**
and a **room type**, and browsing follows the same shape:

```
De'vyora Library
├── British              ├── Bathroom          ← the pictures
│   ├── Bathroom         ├── Bedroom
│   ├── Bedroom          ├── Drawing Room
│   ├── Drawing Room     ├── Powder Room
│   ├── Powder Room      ├── Kitchen
│   ├── Kitchen          └── Balcony & Patio
│   └── Balcony & Patio
├── Roman Touch  …       (and the same six under every theme)
```

### The rooms are the system's own, not a new list

`shared/rooms.json` is the source of truth, read by
`backend/src/services/rooms.service.ts` — the same arrangement
`shared/themes.json` has, and for the same reason.

Every room carries two fields that tie it to the rest of the system:

| field | points at | why |
| --- | --- | --- |
| `wizard` | the mood-board wizard's own label | choosing a Kitchen reference pre-selects Kitchen on the board |
| `space` | the key Python's `describe_space` matches | the generator draws the room the reference actually shows |

If these drifted apart, a client could choose a Kitchen reference and
get a bathroom back — which is the one thing this hierarchy exists to
make impossible.

Six rooms, matching the six the wizard offers. **Balcony & Patio** is
the outdoor one, and `shared/rooms.json` marks it `outdoor: true` —
which changes two things and nothing else:

- the starter is **drawn** as a parapet with open sky above it and an
  outdoor floor, not as a box with a ceiling;
- its shipped reading says *"a chest-high parapet carrying …, open sky
  above it"* rather than *"… to dado height, plain above"*.

That second one is not cosmetic. The reading is what the tile-matching
step searches the catalog **with**, so a board told to answer "plain
above dado height" on a surface that has no above would pick a product
for a wall that is not there.

Python holds `balcony` and `patio` as two entries matched on substring,
balcony first; one room here covers both, as the wizard does, and
points at that first key.

### Backward compatibility, and why there is no `roomType` column

`LibraryReference.room` already existed and was already nullable. What
changed is what it **means**: it now holds a room id. No migration, no
backfill, no second column to keep in step — every row written before
the hierarchy has `NULL` there, because the upload form only ever sent
`themeId`.

A row that does carry free text ("Bathroom", "ensuite", "Kitchen &
Dining") is resolved by alias at read time. Anything unrecognised shows
under **Unsorted**, which appears only when it holds something.

> A picture the studio uploaded must never become invisible because a
> category was added after it.

That rule is why the room filter is applied **in code, not in SQL**.
`room = 'bathroom'` looks obvious and is wrong: it misses every older
row. The counts resolved aliases and the list did not, so a room card
said two pictures and opening it showed one. `resolveRoomId` is now the
single definition of "which room is this in", used by both.

### On Drive, the same shape

```
<the studio's Reference Images folder>
  └── British
        └── Bathroom
              └── the picture
```

Found or created under the configured folder, cached per theme-and-room
so a hundred-picture batch walks the tree once rather than two hundred
times.

### Uploading

Two dropdowns, both pre-set to wherever the studio is standing and both
editable — having walked into British › Kitchen, the commonest next
thing is a batch for British › Bathroom. Whatever they say when the
files are picked is what the whole batch is filed under, stated on the
button so it cannot be a surprise. A batch with no room is refused
rather than dropped into Unsorted, which is where *old* pictures live.

An unknown room is refused on the way **in** and tolerated on the way
**out**: strict where a mistake would make a picture unbrowsable, lenient
where it would make one disappear.

### Starters

One per theme per room — 9 × 6 = **54**, so no cell of the grid is
empty. Each ships its own reading, which names the room, so a board
built on the Kitchen reference reads as a kitchen brief.

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
| the Drive folder: links, ids, every way it can be misconfigured, and the Theme/Room tree | `backend/test-scripts/library_drive_folder_test.js` |
| the room types, their tie to the wizard and to Python, and older rows finding their room | `backend/test-scripts/library_rooms_test.js` |
| the page on a database with no library table | `backend/test-scripts/library_unmigrated_test.js` |
| connecting the owner's Google account: the signed state, the token at rest, which credential wins, a dead grant, the routes, and the self-test | `backend/test-scripts/google_oauth_test.js` |

## Still outstanding, and not code

- **The Drive folder.** `GOOGLE_DRIVE_LIBRARY_FOLDER` must hold the link
  or the id of the studio's "Reference Images" folder, shared with the
  service account as an Editor. Without it the library refuses to upload
  rather than putting pictures in the Drive root; see *One folder, named
  by the studio* above.
- **The Drive quota.** A plain service account owns no Drive storage, so
  uploads fail with Google's own words until that folder lives on a
  **Shared Drive** the service account belongs to, or the credential is
  changed to OAuth delegation. Nothing here hides that.
- **The migrations.** `prisma migrate deploy` is not run by this
  project's build (`vercel.json`'s `buildCommand` is `prisma generate`
  alone), so `20261103113735_add_devyora_library` and
  `20261103210000_add_library_visual_profile` have to be applied by hand.
  The feature degrades rather than breaking without the second one.
