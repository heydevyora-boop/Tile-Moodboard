# The gold set

A small set of images you have judged by hand, once, so that every later
change to the pipeline can be answered with a number instead of an
argument.

Nothing here decides what a good tile is. **You do**, by which folder you
drop a file into. `score_gold_set.py` only runs the shipping pipeline
over these files and counts where it disagrees with you.

---

## What goes where

```
gold/
  good/   images you would put on the website today
  bad/    images that came out wrong and must never come out again
  _cache/ model answers, created automatically -- do not edit, safe to delete
```

Put the pipeline's **output** images here (the ones that reached Drive),
not catalog pages.

### good/

Aim for about 15. One tile or one highlighter per image, whole, clean
background — the thing you would hand to the website without a second
thought.

Mix them up: plain tile, marble, ornate highlighter, mosaic, dark, light,
wide, narrow. Fifteen images of the same kind of tile only prove the
pipeline handles that one kind.

**Do not edit them.** No cropping, no resizing, no "tidying up" in an
image editor. The score is only true if these are exactly what the
pipeline produced. Renaming is fine.

### bad/

Aim for about 15, and **name each file after what is wrong with it**.
The prefix, before the first underscore, is what the score reads:

| prefix | what it means | example |
|---|---|---|
| `half_` | half a product, cut off | `half_tile_01.webp` |
| `two_` | two or more tiles in one image | `two_tiles_01.webp` |
| `border_` | a highlighter with its border cut away | `border_cut_01.webp` |
| `irregular_` | semicircle, arch, odd shape | `irregular_01.webp` |
| `ribbon_` | a long thin sliver | `ribbon_01.webp` |
| `furniture_` | sofa, window, room, a person | `furniture_01.webp` |
| `background_` | page background or printed text | `background_01.webp` |
| `notile_` | not a tile at all (logo, frame, moulding, landmark) | `notile_frame_01.webp` |

The prefix is what turns a bare `bad 11/15` into *"the border ones are
still leaking"*. A file with no recognised prefix is still scored, just
grouped as `unlabelled`.

---

## Running it

```bash
cd catalog_processor

# Pixel gates only -- shape and size. No API key needed, runs anywhere.
python score_gold_set.py --offline

# The real thing: the same gate the catalog run uses.
GEMINI_API_KEY=... python score_gold_set.py
```

What it prints:

```
GOOD (15)  -- these must survive
   kept     : 13
   LOST     : 2      <- over-filtering
      - ornate_highlighter_04.webp
        not a tile product (reads as artwork)

BAD (15)  -- these must be stopped
   caught   : 13
   LEAKED   : 2      <- these reach Drive

   border        2  caught 1, leaked 1   (a border cut off)
   furniture     3  caught 3, leaked 0   (furniture, a room or a person)
   ...

SCORE   good 13/15 kept      bad 13/15 caught
```

An image the chosen depth cannot judge is reported as **unjudged** and
counted in neither column. `--offline` cannot see furniture or a page
background, and says so rather than flattering the score.

Model answers are cached by the image's own hash, so scoring again after
a code change costs nothing and sends nothing. Delete `_cache/` to force
fresh answers.

---

## It runs by itself, too

Every catalog run prints one line before it starts:

```
==================================================
CATALOG EXTRACTION
==================================================
   [gold] good 11/11 kept, bad 2/3 caught   -- unchanged
```

and says so when something has broken:

```
   [gold] good 10/11 kept, bad 2/3 caught   !! 1 real product(s) that
          used to survive are now rejected -- something broke
   [gold] good 11/11 kept, bad 1/3 caught   !! 1 bad image(s) that used
          to be caught now get through
```

Losing a real product is reported first, because a tile that never
reaches Drive is invisible while a bad image at least announces itself.

It is **not a gate.** It judges no candidate and blocks nothing; it
reports whether this build still behaves the way it did when someone
last looked. Making it a gate was considered and measured instead:
nearest-neighbour over these same images agrees with the human label
12 times out of 22 -- a coin flip -- because the faults here are
structural (whole? one? edges inside the frame?) rather than a matter
of appearance. The closest-looking pair in the whole set is one good
image beside one bad one. A gate built on that would refuse about half
the real tiles.

It costs about a second, and if anything at all goes wrong -- no
images, no baseline, an unreadable file -- it says nothing and the
extraction proceeds untouched.

### How deep it goes, and what it costs

**It never calls the model. Not once, not ever.** It reads answers
already in the cache; a miss returns nothing and that image is reported
unjudged. So the cache is the switch:

| cache | what the line covers |
|---|---|
| empty | shape and size only -- it says so, and tells you the command |
| filled | the whole thing: furniture, page background, half a product, a landmark |

Filling it is one deliberate command, and the only thing that costs:

```bash
GEMINI_API_KEY=... python score_gold_set.py
```

That is 44 calls -- two per image, the classifier and the purity check.
Every run after it is **free**, because the gold images never change, so
the answers never change.

It is built this way on purpose. A pre-flight allowed to call out would
put a charge on every extraction anyone ever ran, and adding ten images
to the gold set would silently raise it. That is the kind of cost nobody
notices until the invoice.

### Baselines come in two depths

A baseline is only comparable to a score taken at the same depth: the
pixel rules judge 3 of the bad images, the model judges all 11.
Comparing one against the other would report a catastrophe -- "9 bad
images now get through" -- the moment the cache filled. So save each
separately, and a run compares against its own kind:

```bash
python score_gold_set.py --offline --save-baseline
GEMINI_API_KEY=... python score_gold_set.py --save-baseline
```

### The baseline

```bash
python score_gold_set.py --offline --save-baseline
```

That records the current offline score as the one future runs compare
against. It is **never** updated automatically: a baseline that moved
by itself would quietly ratify every regression, following the score
down and then reporting "unchanged" about a pipeline that had got
worse. Save it when you have looked at a score and accepted it.

---

## How this gets used

```
python score_gold_set.py     ->  good 13/15, bad 11/15
# a change is made
python score_gold_set.py     ->  good 15/15, bad 14/15   keep it
python score_gold_set.py     ->  good 11/15, bad 15/15   throw it away
```

That last line is the case this exists for. Catching more bad images by
losing good ones has happened in this pipeline more than once, and
without a score it looked like progress both times.

## Growing it

When a new kind of wrong image appears, drop it in `bad/` with the right
prefix. That is the whole job — thirty seconds — and that failure is
guarded from then on.

The ribbon of 16 October is the example. Had it been in this folder, its
real proportions would have been measured instead of estimated from a
screenshot, and the threshold chosen from the file itself.
