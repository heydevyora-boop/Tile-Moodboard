"""Scores the real pipeline against a human-labelled set of images.

WHY THIS EXISTS
---------------
Every fix in this pipeline so far has been argued, not measured. A bad
image arrives as a screenshot, the code is read, a cause is proposed, a
change is merged -- and nobody, including the person who made the
change, can say whether the catalog got better or worse. The same
complaint has come back four times in different words.

A score ends that. It is not a cleverer gate; it is a ruler. You label
a set of images once ("this one I would put on the website; this one is
the ribbon that embarrassed us"), and from then on any change -- a
prompt, a threshold, a new rule -- is answered with two numbers instead
of an opinion.

WHAT IS AND IS NOT JUDGED HERE
------------------------------
Nothing in this file decides whether an image is good. YOU decided that,
once, by putting the file in gold/good or gold/bad. This only runs the
SHIPPING pipeline over those files and counts where it disagrees with
you. That distinction is the whole reliability of the thing: a scorer
with an opinion of its own is just a second model to be wrong.

In particular it must never become "ask the model whether the model was
right". The model that approved the ribbon would score the ribbon as
fine, and the run would report 100% beside a Drive folder full of
rubbish.

TWO DEPTHS
----------
--offline  runs only the gates that are pure pixels (shape, size). It
           needs no API key, so it runs anywhere, and it is the half
           that catches ribbons, slivers and unusably small crops.

default    runs the real validate_and_correct_tile_image, the same
           function the catalog run calls, which needs GEMINI_API_KEY.
           This is the half that catches furniture, a page background,
           a printed graphic, a landmark.

An image the chosen depth cannot judge is reported as UNJUDGED. It is
never quietly counted as a pass: a score that flatters itself is worse
than no score.

MODEL ANSWERS ARE CACHED
------------------------
Keyed by the image's own sha256 in gold/_cache. Re-scoring after a code
change costs nothing and sends nothing, so the loop "score, change,
score" stays free after the first run. Delete the cache directory to
force fresh answers.

USAGE
-----
    python score_gold_set.py              # full depth
    python score_gold_set.py --offline    # pixels only, no key needed
    python score_gold_set.py --verbose    # every image, not just failures
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# THE KEY USUALLY LIVES IN .env, NOT IN THE SHELL.
#
# Every module in this package that talks to Gemini calls load_dotenv()
# at import, and the pipeline reads catalog_processor/.env. This file
# checks for GEMINI_API_KEY BEFORE any of those modules is imported, so
# without this it would announce "GEMINI_API_KEY is not set" to someone
# whose key was sitting right there in the file beside it -- and send
# them off to the offline score for no reason.
try:
    from dotenv import load_dotenv

    load_dotenv(dotenv_path=str(HERE / ".env"))
except Exception:  # noqa: BLE001 -- an absent .env is normal, not an error
    pass

GOLD = HERE / "gold"
GOOD_DIR = GOLD / "good"
BAD_DIR = GOLD / "bad"
CACHE_DIR = GOLD / "_cache"

# The last score someone deliberately accepted. The pre-flight compares
# against this, so a run can say "the same as before" or "something
# broke" rather than printing a number nobody can interpret.
#
# It is updated ONLY by --save-baseline, never automatically. A baseline
# that moved by itself would quietly ratify every regression: the score
# would drop, the file would follow it down, and the next run would
# report "the same as before" about a pipeline that had got worse.
BASELINE = GOLD / "baseline.json"


def load_baselines():
    """{"offline": {...}, "deep": {...}} -- whichever have been saved.

    A baseline is only comparable to a score taken at the SAME depth.
    The pixel rules judge 3 of the bad images; the model judges all 11.
    Comparing one against the other reports a catastrophe every time
    the cache fills -- "9 bad images now get through" -- about a
    pipeline that just started looking harder. So the depth is part of
    the record, and a score is only ever measured against its own kind.

    A file written before this existed is a flat set of counts from the
    offline score; it is read as such rather than thrown away.
    """
    try:
        stored = json.loads(BASELINE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(stored, dict):
        return {}
    if "offline" in stored or "deep" in stored:
        return stored
    return {"offline": stored}  # legacy flat file


def save_baseline_counts(counts, depth):
    """Records one depth's score, leaving the other depth's alone."""
    baselines = load_baselines()
    baselines[depth] = counts
    BASELINE.parent.mkdir(parents=True, exist_ok=True)
    BASELINE.write_text(json.dumps(baselines, indent=2), encoding="utf-8")

IMAGE_SUFFIXES = (".webp", ".png", ".jpg", ".jpeg")

# The prefixes gold/README.md asks for on every bad image. The prefix is
# the only thing that says WHICH failure a file is an example of, which
# is what turns "bad 11/15" into "the border ones are still leaking".
# A file whose prefix is not here is still scored -- it is just grouped
# under "unlabelled", and the README asks you to rename it.
BAD_PREFIXES = {
    "half": "half a product",
    "two": "two products in one image",
    "border": "a border cut off",
    "irregular": "an irregular or part shape",
    "ribbon": "a sliver/ribbon",
    "furniture": "furniture, a room or a person",
    "background": "page background or text",
    "notile": "not a tile at all",
}

# Which failures the pixel-only pass can actually speak to. The rest
# need the model, and saying so is the point -- see UNJUDGED above.
OFFLINE_CAPABLE = {"half", "irregular", "ribbon"}


def discover(directory):
    """Every image in a gold folder, sorted, ignoring dotfiles."""
    if not directory.is_dir():
        return []
    return sorted(
        path for path in directory.iterdir()
        if path.suffix.lower() in IMAGE_SUFFIXES and not path.name.startswith(".")
    )


def label_of(path):
    """The failure a bad file is an example of, from its name prefix."""
    head = path.name.split("_", 1)[0].lower()
    return head if head in BAD_PREFIXES else "unlabelled"


def shape_verdict(path):
    """The pixel-only gates: is this the right shape and size at all?

    Deliberately NOT a reimplementation -- it imports the shipping
    constant and the shipping size rule, so a threshold changed in the
    pipeline changes this too and the score cannot drift away from the
    code it is scoring.
    """
    from PIL import Image

    import main_step6_complete as pipeline
    from app.tile_region_extractor import REGION_MAX_ASPECT_RATIO

    try:
        with Image.open(path) as opened:
            width, height = opened.size
    except Exception as exc:  # noqa: BLE001 -- an unreadable file is a result
        return "REJECTED", f"could not be opened ({exc})"

    if width <= 0 or height <= 0:
        return "REJECTED", f"{width}x{height}px is not an image"

    aspect = max(width, height) / min(width, height)
    if aspect > REGION_MAX_ASPECT_RATIO:
        return "REJECTED", (
            f"{width}x{height}px is an extreme {aspect:.1f}:1 sliver, "
            f"not a whole product"
        )

    if pipeline.is_too_small_for_a_product(width, height):
        return "REJECTED", f"{width}x{height}px is too small to be a product"

    return "APPROVED", f"{width}x{height}px, {aspect:.1f}:1"


# WHICH GOLD FILE IS BEING JUDGED RIGHT NOW.
#
# The cache cannot key on the file the model is handed, because the
# gate REWRITES that file halfway through: it crops to the product bbox
# and saves, so the classifier sees the original bytes and the purity
# check sees re-encoded ones. Keying on those meant every purity answer
# was filed under a hash that depended on the classifier's answer and
# on WEBP encoding being byte-identical forever.
#
# The gold file is the thing that is actually stable, so it is the key.
_CURRENT_GOLD = {"path": None}

# The model functions as they were before anything here touched them.
# See install_cached_model for why this is remembered rather than read
# fresh each time.
_ORIGINALS = {"verify": None, "classify": None}


def _cache_path(kind, image_path):
    source = _CURRENT_GOLD["path"] or image_path
    digest = hashlib.sha256(Path(source).read_bytes()).hexdigest()
    return CACHE_DIR / f"{kind}-{digest}.json", digest


def install_cached_model(cache_only=False):
    """Points BOTH of the pipeline's model calls at a cache on disk.

    Two calls decide a gold image, not one: analyze_product_image
    classifies it and verify_tile_only judges its purity. Only the
    second was cached at first, so every full score quietly re-billed
    the first -- twenty-two classifier calls a run, for answers that
    could not change, because the images never change.

    cache_only=True makes this spend NOTHING, ever. A miss returns None
    rather than calling out, and the pipeline already reads None as "no
    verdict was reached" (both call sites defer rather than reject), so
    the image is reported UNJUDGED. That is what lets a catalog run
    carry the full score for free: the run reads what is already known
    and never starts a bill of its own.

    Filling the cache stays a deliberate act -- one `python
    score_gold_set.py` with a key. Otherwise adding ten images to the
    gold set would silently put ten calls on every extraction from then
    on, which is exactly the kind of cost nobody notices until the
    invoice.
    """
    import dataclasses

    import app.gemini_service as gemini_service

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Install from the ORIGINALS, every time.
    #
    # Installing twice in one process used to stack a wrapper on a
    # wrapper, so the inner one became "the real model" -- and if the
    # inner one was a cache_only pass, the outer one could never reach
    # the API at all and every image came back unjudged, with the run
    # reporting a catastrophe it had invented. One process legitimately
    # does this: a pre-flight runs, and then something asks for a full
    # score.
    if _ORIGINALS["verify"] is None:
        _ORIGINALS["verify"] = gemini_service.verify_tile_only
        _ORIGINALS["classify"] = gemini_service.analyze_product_image
    real_verify = _ORIGINALS["verify"]
    real_classify = _ORIGINALS["classify"]
    stats = {"hits": 0, "calls": 0, "misses": 0}

    def _read(path, digest):
        # The purity cache predates the kind- prefix; an existing one is
        # still good, and re-fetching it would be a bill for nothing.
        for candidate in (path, CACHE_DIR / f"{digest}.json"):
            if candidate.exists():
                try:
                    return json.loads(candidate.read_text(encoding="utf-8"))
                except (ValueError, OSError):
                    pass  # a corrupt entry is just a miss
        return None

    def _write(path, payload):
        try:
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except OSError:
            pass  # scoring must not fail because a cache write did

    def cached_verify(image_path):
        path, digest = _cache_path("purity", image_path)
        stored = _read(path, digest)
        if stored is not None:
            stats["hits"] += 1
            return stored
        if cache_only:
            stats["misses"] += 1
            return None
        stats["calls"] += 1
        observation = real_verify(image_path)
        if observation is not None:
            _write(path, observation)
        return observation

    def cached_classify(image_path, page_text=""):
        path, digest = _cache_path("classify", image_path)
        stored = _read(path, digest)
        if stored is not None:
            stats["hits"] += 1
            try:
                return gemini_service.ProductAnalysis(**stored)
            except TypeError:
                pass  # the dataclass changed shape; treat as a miss
        if cache_only:
            stats["misses"] += 1
            return None
        stats["calls"] += 1
        result = real_classify(image_path, page_text=page_text)
        if dataclasses.is_dataclass(result):
            _write(path, dataclasses.asdict(result))
        return result

    gemini_service.verify_tile_only = cached_verify
    gemini_service.analyze_product_image = cached_classify
    return stats


def full_verdict(path, workdir):
    """The real gate, on a COPY of the gold file.

    validate_and_correct_tile_image corrects the image in place -- it
    crops to the product bbox and rewrites the file. Running it on the
    gold file itself would edit the very thing being measured, a little
    more on every run, until the set no longer meant anything. So each
    image is copied first and the copy is what gets judged and
    rewritten.

    purity_is_authoritative=True because that is the posture the mined
    regions take (see mine_tile_regions), and gold images are finished
    crops of exactly that kind.
    """
    import main_step6_complete as pipeline

    semantic_validator = pipeline.load_semantic_tile_validator()
    if semantic_validator is None:
        return "UNJUDGED", "the classifier could not be loaded"

    scratch = workdir / path.name
    shutil.copy2(path, scratch)
    _CURRENT_GOLD["path"] = path

    try:
        status, reason, _metadata = pipeline.validate_and_correct_tile_image(
            scratch,
            None,            # no page rect: a gold file has no page around it
            [],              # and therefore no nearby text
            semantic_validator,
            purity_is_authoritative=True,
        )
    except Exception as exc:  # noqa: BLE001 -- report, never crash the score
        return "UNJUDGED", f"the gate raised {type(exc).__name__}: {exc}"
    finally:
        _CURRENT_GOLD["path"] = None

    if status == pipeline.VALIDATION_APPROVED:
        return "APPROVED", reason or "approved"
    if status == pipeline.VALIDATION_DEFERRED:
        # No verdict was reached -- quota, a missing key, an API error.
        # Not a pass and not a fail; the run simply did not look.
        return "UNJUDGED", reason or "no verdict (deferred)"
    if status == pipeline.VALIDATION_IMPURE:
        # A real tile in a bad frame. The catalog run would go and cut
        # the tile out; as a finished image it is not publishable.
        return "REJECTED", reason or "needs isolation"
    return "REJECTED", reason or "rejected"


def collect(offline, cache_only=False):
    """Runs the set and returns its rows, or None when there is nothing.

    Separated from the printing so the pre-flight inside a catalog run
    can reuse the exact same scoring path. Two ways of working out the
    score would eventually disagree, and the one nobody watches would be
    the one that was wrong.
    """
    good = discover(GOOD_DIR)
    bad = discover(BAD_DIR)
    if not good and not bad:
        return None, None

    stats = (install_cached_model(cache_only=cache_only)
             if not offline else None)

    workdir = Path(tempfile.mkdtemp(prefix="gold-score-"))
    rows = []
    try:
        for path in good:
            verdict, reason = (
                shape_verdict(path) if offline
                else full_verdict(path, workdir)
            )
            rows.append(("good", "good", path, verdict, reason))

        for path in bad:
            label = label_of(path)
            if offline and label not in OFFLINE_CAPABLE:
                rows.append(("bad", label, path, "UNJUDGED",
                             "needs the model; --offline cannot see this"))
                continue
            verdict, reason = (
                shape_verdict(path) if offline
                else full_verdict(path, workdir)
            )
            rows.append(("bad", label, path, verdict, reason))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    return rows, stats


def tally(rows):
    """The four numbers the pre-flight and the baseline both speak in."""
    good = [row for row in rows if row[0] == "good"]
    bad = [row for row in rows if row[0] == "bad"]
    return {
        "good_kept": sum(1 for r in good if r[3] == "APPROVED"),
        "good_judged": sum(1 for r in good if r[3] in ("APPROVED", "REJECTED")),
        "bad_caught": sum(1 for r in bad if r[3] == "REJECTED"),
        "bad_judged": sum(1 for r in bad if r[3] in ("APPROVED", "REJECTED")),
    }


def score(offline, verbose, save_baseline=False):
    if not offline and not os.getenv("GEMINI_API_KEY", "").strip():
        print("GEMINI_API_KEY is not set, so the model half cannot run.")
        print("Re-run with --offline for the pixel-only score, or set "
              "the key for the full one.")
        return 2

    rows, stats = collect(offline)
    if rows is None:
        print(f"No images found in {GOOD_DIR} or {BAD_DIR}.")
        print("See gold/README.md for what to put there.")
        return 2

    outcome = report(rows, offline, verbose, stats)

    if save_baseline:
        depth = "offline" if offline else "deep"
        try:
            save_baseline_counts(tally(rows), depth)
            print(f"Baseline saved ({depth}) to {BASELINE}. Runs compare "
                  f"against the baseline taken at their own depth.")
        except OSError as exc:
            print(f"Could not save the baseline: {exc}")
    return outcome


def report(rows, offline, verbose, stats):
    """The two numbers, and enough detail to act on them."""
    depth = "PIXELS ONLY (no model)" if offline else "FULL PIPELINE"
    print("")
    print("=" * 66)
    print(f"GOLD SET SCORE -- {depth}")
    print("=" * 66)

    good_rows = [row for row in rows if row[0] == "good"]
    bad_rows = [row for row in rows if row[0] == "bad"]

    # GOOD: anything but APPROVED is a product this pipeline would lose.
    good_pass = [r for r in good_rows if r[3] == "APPROVED"]
    good_fail = [r for r in good_rows if r[3] == "REJECTED"]
    good_unjudged = [r for r in good_rows if r[3] == "UNJUDGED"]

    print(f"\nGOOD ({len(good_rows)})  -- these must survive")
    print(f"   kept     : {len(good_pass)}")
    print(f"   LOST     : {len(good_fail)}      <- over-filtering")
    if good_unjudged:
        print(f"   unjudged : {len(good_unjudged)}")
    for _k, _l, path, _v, reason in good_fail:
        print(f"      - {path.name}")
        print(f"        {reason}")
    if verbose:
        for _k, _l, path, _v, reason in good_pass:
            print(f"      ok {path.name}  ({reason})")

    # BAD: anything APPROVED is an image that would reach Drive.
    bad_caught = [r for r in bad_rows if r[3] == "REJECTED"]
    bad_leaked = [r for r in bad_rows if r[3] == "APPROVED"]
    bad_unjudged = [r for r in bad_rows if r[3] == "UNJUDGED"]

    print(f"\nBAD ({len(bad_rows)})  -- these must be stopped")
    print(f"   caught   : {len(bad_caught)}")
    print(f"   LEAKED   : {len(bad_leaked)}      <- these reach Drive")
    if bad_unjudged:
        print(f"   unjudged : {len(bad_unjudged)}")

    by_label = {}
    for kind, label, path, verdict, reason in bad_rows:
        bucket = by_label.setdefault(label, {"caught": 0, "leaked": 0,
                                             "unjudged": 0})
        if verdict == "REJECTED":
            bucket["caught"] += 1
        elif verdict == "APPROVED":
            bucket["leaked"] += 1
        else:
            bucket["unjudged"] += 1

    if by_label:
        print("")
        for label in sorted(by_label):
            counts = by_label[label]
            description = BAD_PREFIXES.get(label, "unlabelled -- rename it")
            total = sum(counts.values())
            print(f"   {label:<12} {total:>2}  "
                  f"caught {counts['caught']}, leaked {counts['leaked']}"
                  + (f", unjudged {counts['unjudged']}"
                     if counts["unjudged"] else "")
                  + f"   ({description})")

    for _k, _l, path, _v, reason in bad_leaked:
        print(f"      - {path.name}")
        print(f"        approved as: {reason}")

    judged_good = len(good_pass) + len(good_fail)
    judged_bad = len(bad_caught) + len(bad_leaked)

    print("")
    print("-" * 66)
    print(f"SCORE   good {len(good_pass)}/{judged_good} kept"
          f"      bad {len(bad_caught)}/{judged_bad} caught")
    if good_unjudged or bad_unjudged:
        print(f"        ({len(good_unjudged) + len(bad_unjudged)} image(s) "
              f"not judged at this depth, and not counted either way)")
    if stats:
        print(f"        model: {stats['calls']} call(s), "
              f"{stats['hits']} from cache")
    print("-" * 66)
    print("")

    # A non-zero exit when something is wrong, so this can be wired into
    # a pre-merge check later without changing anything here.
    return 1 if (good_fail or bad_leaked) else 0


def preflight():
    """One line for a catalog run to print before it starts, or None.

    THIS IS NOT A GATE. It judges no candidate and blocks nothing; it
    runs the labelled set through the pixel rules and says whether the
    pipeline still behaves the way it did when someone last looked.
    Turning the gold set into a gate was considered and measured
    instead: nearest-neighbour over these same 22 images agrees with
    the human label 12 times out of 22, which is a coin flip, because
    the faults here are structural (whole? one? edges inside?) and not
    a matter of appearance. The closest pair in the whole set is one
    good image and one bad one. A gate built on that would refuse about
    half of the real tiles.

    Silent and harmless by construction: no images, no baseline, a
    missing folder, an unreadable file, anything at all -- it returns
    None and the catalog runs exactly as it would have. An extraction
    must never fail because a measuring tool did.
    """
    try:
        # DEPTH IS CHOSEN BY WHAT IS ALREADY PAID FOR, NOT BY WHAT IS
        # AVAILABLE.
        #
        # With a key and a filled cache this reports the FULL score --
        # furniture, a page background, half a product, a landmark --
        # the half the pixel rules are blind to. It still costs nothing,
        # because cache_only=True never calls out: a miss returns None,
        # the pipeline defers, and the image is reported UNJUDGED.
        #
        # So the cache is the switch. One deliberate
        # `python score_gold_set.py` fills it, and every run after that
        # carries the full score for free. Without a key, or with an
        # empty cache, this falls back to the pixel rules rather than
        # starting a bill nobody asked for.
        deep = bool(os.getenv("GEMINI_API_KEY", "").strip())
        rows, stats = collect(offline=not deep, cache_only=True)
        if not rows:
            return None

        # A deep pass that knew almost nothing is worse than an honest
        # shallow one: it would report a handful of judged images as if
        # that were the score. Fall back and say why.
        unfilled = (stats or {}).get("misses", 0)
        if deep and unfilled > len(rows) // 2:
            rows, stats = collect(offline=True)
            now = tally(rows)
            return (f"[gold] good {now['good_kept']}/{now['good_judged']} kept, "
                    f"bad {now['bad_caught']}/{now['bad_judged']} caught "
                    f"-- pixel rules only; run "
                    f"`python score_gold_set.py` once to fill the model "
                    f"cache and get the full check free from then on")

        now = tally(rows)

        depth = "deep" if deep else "offline"
        was = load_baselines().get(depth)
        if not was:
            flag = "" if deep else "--offline "
            return (f"[gold] good {now['good_kept']}/{now['good_judged']} kept, "
                    f"bad {now['bad_caught']}/{now['bad_judged']} caught "
                    f"-- no baseline yet at this depth (python "
                    f"score_gold_set.py {flag}--save-baseline)")

        line = (f"[gold] good {now['good_kept']}/{now['good_judged']} kept, "
                f"bad {now['bad_caught']}/{now['bad_judged']} caught")
        if deep and unfilled:
            line += f" ({unfilled} image(s) not in the model cache)"

        lost = was.get("good_kept", 0) - now["good_kept"]
        missed = was.get("bad_caught", 0) - now["bad_caught"]

        # Losing real products is the louder of the two, and always has
        # been: a tile that never reaches Drive is invisible, while a bad
        # image at least announces itself.
        if lost > 0:
            return (f"{line}   !! {lost} real product(s) that used to "
                    f"survive are now rejected -- something broke")
        if missed > 0:
            return (f"{line}   !! {missed} bad image(s) that used to be "
                    f"caught now get through")
        if (now["good_kept"] > was.get("good_kept", 0)
                or now["bad_caught"] > was.get("bad_caught", 0)):
            return f"{line}   (better than the saved baseline)"
        return f"{line}   -- unchanged"
    except Exception:  # noqa: BLE001 -- see the docstring
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--offline", action="store_true",
        help="run only the pixel gates; no API key needed",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="list every image, not only the failures",
    )
    parser.add_argument(
        "--save-baseline", action="store_true",
        help="record this offline score as the one catalog runs compare against",
    )
    args = parser.parse_args()
    return score(args.offline, args.verbose, args.save_baseline)


if __name__ == "__main__":
    sys.exit(main())
